"""
Scheduled-task wrapper for download_export.py.

Task Scheduler fires this via pythonw.exe (no console). Plain print() output
would vanish — so before handing off to the real script we:

  1. Open a timestamped logs/run_<YYYYMMDD_HHMMSS>.log
  2. Redirect sys.stdout / sys.stderr to it (line-buffered so a hung run still
     leaves a tail-able partial log)
  3. Hand off to download_export.py in-process via runpy, so the script's
     argparse + sys.exit() codes reach Task Scheduler unchanged
  4. Prune logs older than LOG_RETENTION_DAYS

Forwarded args become download_export.py's argv:
    pythonw _scheduled_run.py                    # full pipeline
    pythonw _scheduled_run.py inventory transfer # subset
    pythonw _scheduled_run.py --skip-auth        # flags work too
"""

from __future__ import annotations

import runpy
import sys
import traceback
from datetime import datetime, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
LOG_DIR = HERE / "logs"
DOWNLOAD_SCRIPT = HERE / "download_export.py"
LOG_RETENTION_DAYS = 30


def _prune_old_logs(now: datetime) -> None:
    """Best-effort delete of run_*.log files older than LOG_RETENTION_DAYS.

    Swallows OSErrors — a stuck/locked log shouldn't fail the run itself.
    """
    cutoff = now - timedelta(days=LOG_RETENTION_DAYS)
    try:
        candidates = list(LOG_DIR.glob("run_*.log"))
    except OSError:
        return
    for f in candidates:
        try:
            if datetime.fromtimestamp(f.stat().st_mtime) < cutoff:
                f.unlink(missing_ok=True)
        except OSError:
            pass


def main() -> None:
    LOG_DIR.mkdir(exist_ok=True)
    now = datetime.now()
    log_path = LOG_DIR / f"run_{now:%Y%m%d_%H%M%S}.log"

    # buffering=1 = line-buffered, so a long-running step leaves a partial log
    # you can tail. errors='replace' so a stray byte doesn't crash logging.
    log = open(log_path, "w", encoding="utf-8", buffering=1, errors="replace")
    sys.stdout = log
    sys.stderr = log

    forwarded = sys.argv[1:]
    header = f"=== scheduled run @ {now:%Y-%m-%d %H:%M:%S}  args={forwarded or '(all)'} ==="
    print(header)
    print("=" * len(header))

    # download_export.py's argparse reads sys.argv — fake it so the script
    # behaves identically to a direct CLI call.
    sys.argv = [str(DOWNLOAD_SCRIPT), *forwarded]

    exit_code = 0
    try:
        runpy.run_path(str(DOWNLOAD_SCRIPT), run_name="__main__")
    except SystemExit as e:
        # download_export.py uses sys.exit(0/1/2) — propagate that code.
        exit_code = int(e.code) if isinstance(e.code, int) else (0 if e.code is None else 1)
    except BaseException:  # noqa: BLE001 — last-chance logger
        print("\n[wrapper] unhandled exception:")
        traceback.print_exc()
        exit_code = 99

    log.flush()
    _prune_old_logs(now)
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
