"""
Batch runner: for each project, run each requested export.

Deliberately sequential and independent - one project/export failing must not
stop the rest, and every outcome lands in the manifest so the caller can tell
partial success from total failure without parsing logs.
"""

from __future__ import annotations

import json
import time
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

from . import exports
from .exports._base import SessionExpired


@dataclass
class Result:
    project: str
    export: str
    status: str           # "ok" | "failed" | "skipped"
    file: str | None = None
    bytes: int | None = None
    duration_s: float | None = None
    query_project: str | None = None
    error: str | None = None


def run_batch(
    session,
    projects: list[str],
    export_names: list[str],
    out_dir: Path,
    country_code: str | None = None,
    log: Callable[[str], None] = print,
    run_ts: str | None = None,
) -> list[Result]:
    ts = run_ts or datetime.now().strftime("%Y%m%d_%H%M%S")
    results: list[Result] = []

    for project in projects:
        log("")
        log("=" * 72)
        log(f"  PROJECT {project}")
        log("=" * 72)
        for name in export_names:
            t0 = time.monotonic()
            try:
                cfg = exports.build(name, project, country_code)
                path = exports.run_export(session, cfg, out_dir=out_dir, ts=ts, log=log)
                results.append(Result(
                    project=project,
                    export=name,
                    status="ok",
                    file=str(path),
                    bytes=path.stat().st_size,
                    duration_s=round(time.monotonic() - t0, 1),
                ))
            except SessionExpired:
                # Fatal: every remaining export would fail the same way, each
                # after a 240s poll. Abort now and report what is left undone.
                log(f"  [ABORT] {project}/{name}: session expired")
                results.append(Result(
                    project=project, export=name, status="failed",
                    duration_s=round(time.monotonic() - t0, 1),
                    error="session expired",
                ))
                for rp in projects[projects.index(project):]:
                    for rn in export_names:
                        if rp == project and export_names.index(rn) <= export_names.index(name):
                            continue
                        results.append(Result(
                            project=rp, export=rn, status="skipped",
                            error="aborted: session expired",
                        ))
                return results
            except Exception as exc:  # noqa: BLE001 - per-item isolation is the point
                log(f"  [FAIL] {project}/{name}: {exc}")
                results.append(Result(
                    project=project,
                    export=name,
                    status="failed",
                    duration_s=round(time.monotonic() - t0, 1),
                    error=str(exc),
                ))
    return results


def build_manifest(
    results: list[Result],
    customer: str,
    run_ts: str,
    started: str,
) -> dict[str, Any]:
    ok = sum(1 for r in results if r.status == "ok")
    failed = sum(1 for r in results if r.status == "failed")
    skipped = sum(1 for r in results if r.status == "skipped")
    return {
        "run_id": run_ts,
        "customer": customer,
        "started_at": started,
        "finished_at": datetime.now().isoformat(timespec="seconds"),
        "summary": {
            "total": len(results),
            "ok": ok,
            "failed": failed,
            "skipped": skipped,
        },
        "results": [asdict(r) for r in results],
    }


def write_manifest(manifest: dict[str, Any], out_dir: Path) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"manifest_{manifest['run_id']}.json"
    path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return path


def print_summary(results: list[Result], log: Callable[[str], None] = print) -> None:
    log("")
    log("=" * 72)
    log("  SUMMARY")
    log("=" * 72)
    for r in results:
        if r.status == "ok":
            log(f"  [OK]   {r.project:22s} {r.export:10s} {Path(r.file).name}")
        elif r.status == "skipped":
            log(f"  [SKIP] {r.project:22s} {r.export:10s} {r.error}")
        else:
            log(f"  [FAIL] {r.project:22s} {r.export:10s} {r.error}")
    ok = sum(1 for r in results if r.status == "ok")
    failed = sum(1 for r in results if r.status == "failed")
    skipped = sum(1 for r in results if r.status == "skipped")
    log("")
    log(f"  {ok} ok, {failed} failed, {skipped} skipped, {len(results)} total")