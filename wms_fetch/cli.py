"""
Single entry point. Bailey (or Task Scheduler) calls exactly this:

    python -m wms_fetch.cli

Exit codes:
    0 = every export succeeded
    1 = partial success (some exports failed; good files still written)
    2 = could not start (bad config, missing/invalid cookies)
"""

from __future__ import annotations

import argparse
import sys
from datetime import datetime
from pathlib import Path

from . import auth, config, exports
from .projects import load_project_set
from .runner import build_manifest, print_summary, run_batch, write_manifest


def parse_args(argv=None):
    p = argparse.ArgumentParser(
        prog="wms-fetch",
        description="Fetch WMS inventory/transfer/lock exports per project.",
    )
    p.add_argument(
        "--projects-file", default=str(config.PROJECTS_FILE),
        help="JSON file listing the customer's project numbers.",
    )
    p.add_argument(
        "--project", action="append", dest="projects", metavar="NO",
        help="Run only this project number (repeatable). Overrides the file list.",
    )
    p.add_argument(
        "--exports", nargs="+", choices=sorted(exports.BUILDERS), metavar="NAME",
        help="Limit to these export types. Default: whatever the project file lists.",
    )
    p.add_argument(
        "--out-dir", default=None,
        help=f"Where to write files. Default: {config.OUTPUT_DIR}",
    )
    p.add_argument(
        "--transport", choices=("requests", "chrome"), default="requests",
        help="HTTP transport. chrome uses the logged-in WMS tab through CDP.",
    )
    p.add_argument(
        "--cdp-port", type=int, default=19222,
        help="Chrome DevTools port used by --transport chrome (default: 19222).",
    )
    p.add_argument(
        "--cdp-target", default=None,
        help="URL/title fragment of an authenticated same-origin WMS page.",
    )
    p.add_argument(
        "--skip-auth-check", action="store_true",
        help="Trust cookies.txt as-is and skip the validity probe.",
    )
    p.add_argument(
        "--dry-run", action="store_true",
        help="Print the request each export would send, then exit. No network.",
    )
    p.add_argument("--list", action="store_true", help="List projects and exit.")
    return p.parse_args(argv)


def do_dry_run(project_set, projects, export_names) -> int:
    from .exports._base import encode_body, merge_filters, step1_params

    for project in projects:
        for name in export_names:
            cfg = exports.build(name, project, project_set.country_code)
            body = merge_filters(cfg)
            print("-" * 72)
            print(f"{project}  /  {name}")
            print(f"  POST {config.WMS_BASE}{cfg.endpoint_path}")
            print(f"  query  : {step1_params(cfg)}")
            print(f"  project fields: {cfg.project_fields}")
            print(f"  body[{len(body)} keys] encoded {len(encode_body(body))} chars")
    return 0


def _force_utf8_console() -> None:
    """Let logs carry WMS's Chinese server messages on a cp1252 console."""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="backslashreplace")
        except (AttributeError, ValueError):
            pass


def main(argv=None) -> int:
    _force_utf8_console()
    args = parse_args(argv)

    try:
        project_set = load_project_set(args.projects_file)
    except (FileNotFoundError, ValueError) as exc:
        print(f"[config] {exc}", file=sys.stderr)
        return 2

    projects = args.projects or project_set.projects
    export_names = args.exports or project_set.exports

    if args.list:
        print(f"customer : {project_set.customer}")
        print(f"exports  : {', '.join(export_names)}")
        print("projects :")
        for p in projects:
            print(f"  {p}")
        return 0

    print(f"Customer : {project_set.customer}")
    print(f"Projects : {len(projects)}  ({', '.join(projects)})")
    print(f"Exports  : {', '.join(export_names)}")
    print(f"Planned  : {len(projects) * len(export_names)} downloads")

    try:
        config.require_emp_no()
    except RuntimeError as exc:
        print(f"[config] {exc}", file=sys.stderr)
        return 2

    if args.dry_run:
        return do_dry_run(project_set, projects, export_names)

    if args.transport == "chrome":
        try:
            from .chrome_session import ChromeSession
            session = ChromeSession(port=args.cdp_port, target=args.cdp_target)
        except (FileNotFoundError, RuntimeError, ValueError) as exc:
            print(f"[chrome] {exc}", file=sys.stderr)
            return 2
    else:
        try:
            cookie_header = auth.load_cookie_header()
        except (FileNotFoundError, ValueError) as exc:
            print(f"[auth] {exc}", file=sys.stderr)
            return 2
        session = auth.build_session(cookie_header)

    if not args.skip_auth_check:
        print("Checking cookies...")
        if not auth.cookies_are_valid(session):
            print(
                "[auth] WMS session is expired or invalid.\n"
                "       For requests transport, refresh cookies.txt. For Chrome "
                "transport, log in and open Inventory Query in its own tab.",
                file=sys.stderr,
            )
            return 2
        print("Cookies OK.")

    out_dir = Path(args.out_dir) if args.out_dir else config.OUTPUT_DIR
    run_ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    started = datetime.now().isoformat(timespec="seconds")

    results = run_batch(
        session=session,
        projects=projects,
        export_names=export_names,
        out_dir=out_dir,
        country_code=project_set.country_code,
        run_ts=run_ts,
    )

    print_summary(results)
    manifest = build_manifest(results, project_set.customer, run_ts, started)
    path = write_manifest(manifest, out_dir)
    print(f"  manifest -> {path}")

    return 0 if manifest["summary"]["failed"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())