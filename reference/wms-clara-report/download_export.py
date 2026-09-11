"""
WMS direct-download pipeline.

Each export lives in its own module under exports/ — the runner here just:
  1. Loads cookies from cookies.txt
  2. For each requested export, calls run_export() (POST -> ExcelID -> GET file)
  3. Prints a summary

Usage:
  python download_export.py                       # all exports, in registry order
  python download_export.py inventory             # one
  python download_export.py inventory transfer    # several, in given order
  python download_export.py lock                  # the inventory-lock export
  python download_export.py --list                # show what's available

The server can't generate two of these in parallel for the same session, so
the runs are sequential by design. Each step prints its own progress.
"""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

import requests

import config
from auth import ensure_valid_cookies
from exports import EXPORTS, run_export

HERE = Path(__file__).resolve().parent


def move_to_output_dir(files: list[Path], target_dir: Path) -> list[Path]:
    """Move every file in `files` to `target_dir`. All-at-once batch, not 1-by-1.

    Pre-validates the target so we don't half-move; collisions are overwritten
    (server gives each file a unique timestamped name anyway).
    """
    target_dir.mkdir(parents=True, exist_ok=True)

    # Pre-flight: ensure every source still exists before touching anything.
    for src in files:
        if not src.exists():
            raise FileNotFoundError(f"source missing: {src}")

    moved: list[Path] = []
    for src in files:
        dst = target_dir / src.name
        if dst.exists():
            dst.unlink()
        shutil.move(str(src), str(dst))
        moved.append(dst)
    return moved


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Run the WMS export pipeline (direct download, no email).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument(
        "names",
        nargs="*",
        choices=list(EXPORTS),
        metavar="EXPORT",
        help=f"one or more export names (default: all = {' '.join(EXPORTS)})",
    )
    p.add_argument("--list", action="store_true", help="list registered exports and exit")
    p.add_argument(
        "--skip-auth",
        action="store_true",
        help="trust cookies.txt as-is, skip the validity check + refresh",
    )
    return p.parse_args()


def main() -> None:
    args = parse_args()

    if args.list:
        for name, cfg in EXPORTS.items():
            print(f"  {name:10s}  endpoint={cfg.endpoint_path}")
        return

    targets = args.names or list(EXPORTS)
    print(f"Pipeline: {' -> '.join(targets)}")

    if args.skip_auth:
        cookie_header = (HERE / "cookies.txt").read_text(encoding="utf-8").strip()
        if not cookie_header:
            sys.exit("cookies.txt is empty and --skip-auth was passed.")
    else:
        cookie_header = ensure_valid_cookies()

    session = requests.Session()
    session.headers.update({"cookie": cookie_header})

    results: list[tuple[str, Path | None, str]] = []
    for name in targets:
        try:
            out = run_export(session, EXPORTS[name])
            results.append((name, out, ""))
        except Exception as exc:
            print(f"  [FAIL] {name}: {exc}")
            results.append((name, None, str(exc)))

    # Summary -------------------------------------------------------------
    print("\n" + "=" * 72)
    print("  SUMMARY")
    print("=" * 72)
    ok = fail = 0
    for name, out, err in results:
        if out is not None:
            print(f"  [OK]   {name:10s}  -> {out}")
            ok += 1
        else:
            print(f"  [FAIL] {name:10s}  {err}")
            fail += 1
    print(f"\n  {ok} ok, {fail} failed")

    # Move stage ----------------------------------------------------------
    # Relocate every export that succeeded, even if others failed. A partial
    # run still delivers its good files to the output folder; the failed ones
    # simply aren't there to move (rerun those names to fill the gap).
    downloaded = [out for _, out, _ in results if out]
    if downloaded:
        target = Path(config.OUTPUT_MOVE_TO)
        print("\n" + "=" * 72)
        print(f"  MOVE -> {target}")
        if fail:
            print(f"  (moving {len(downloaded)} succeeded file(s); {fail} export(s) failed)")
        print("=" * 72)
        try:
            moved = move_to_output_dir(downloaded, target)
            for m in moved:
                print(f"  [OK]   {m}")
            print(f"\n  moved {len(moved)} file(s)")
        except Exception as exc:
            print(f"  [FAIL] {exc}")
            print("  Files left in ./downloads/ — fix the destination and rerun.")
            sys.exit(2)
    else:
        print("\n  Move skipped: no exports succeeded; nothing to move.")

    sys.exit(0 if fail == 0 else 1)


if __name__ == "__main__":
    main()
