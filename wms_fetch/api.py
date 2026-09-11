"""Direct JSON paging API for WMS inventory, transfer and lock data.

The Excel endpoint is intentionally kept as the legacy/export mode.  The WMS
pages also expose a paging JSON endpoint used by their Query buttons.  This
module uses that endpoint through the authenticated Chrome transport and saves
complete response datasets as JSON, avoiding Excel generation and polling.
"""

from __future__ import annotations

import json
import math
import re
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

from . import config, exports
from .exports._base import (
    SessionExpired,
    _looks_expired,
    encode_body,
    merge_filters,
    wms_project_no,
)
from .runner import Result

DEFAULT_PAGE_SIZE = 3000
MAX_PAGE_SIZE = 3000
_SAFE_RE = re.compile(r"[^A-Za-z0-9._-]+")


@dataclass
class ApiDataset:
    query_project: str
    total: int
    rows: list[dict[str, Any]]
    pages: int
    fetched_at: str


def query_project_no(cfg) -> str:
    """Return the value WMS actually indexes for this customer project."""
    return wms_project_no(cfg.project_no)


def paging_params(cfg, page: int, page_size: int) -> dict[str, str]:
    """Build the same query-string parameters as the WMS Query button."""
    params: dict[str, str] = {
        "CommandName": "Paging",
        "PageNum": str(page),
        "PageSize": str(page_size),
        "GridID": "DataGrid" if cfg.name == "lock" else "dgInventoryDetail",
        "CustomData": "",
        "CommandControl": "btnQuery",
        "CommandEvent": "click",
        "DataGridId": "DataGrid" if cfg.name == "lock" else "dgInventoryDetail",
        "PageSourceID": "",
    }
    # FormatAjaxURL on the WMS page appends these common context parameters
    # before jQuery sends the request.  They look redundant, but omitting them
    # makes the legacy SQL-backed endpoint fail with a syntax error.
    params.update({
        "EmployeeNo": "null",
        "LanguageID": config.LANGUAGE_ID,
        "SystemName": "null",
        "EmployeeToken": "null",
        "EmployeeCnName": "null",
        "EmployeeEnName": "null",
    })
    if cfg.name == "lock":
        # InventoryLock's pageAttr.JsonServerURL carries URL= and its browser
        # request also includes Code=MY.
        params = {"URL": cfg.referer_path, "Code": cfg.extra_query.get("Code", config.COUNTRY_CODE), **params}
    else:
        # InventoryQuery's pageAttr.JsonServerURL carries CardNo=.
        params = {"CardNo": config.require_emp_no(), **params}
    return params


def paging_headers(cfg) -> dict[str, str]:
    """Headers sent by $.ZTECore.Ajax.CallAjaxPostData on the WMS pages."""
    return {
        "accept": "application/json, text/javascript, */*; q=0.01",
        "accept-language": "en-US,en;q=0.9",
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "x-requested-with": "XMLHttpRequest",
        "user-agent": config.USER_AGENT,
        "referer": config.WMS_BASE + cfg.referer_path,
    }


def _header(response, name: str) -> str:
    wanted = name.lower()
    for key, value in response.headers.items():
        if str(key).lower() == wanted:
            return str(value)
    return ""


def _response_error(response) -> str:
    try:
        payload = response.json()
    except ValueError:
        text = response.content.decode("utf-8", "replace")
        return text[:300].encode("ascii", "backslashreplace").decode("ascii")
    if isinstance(payload, dict):
        return str(payload.get("ErrMsg") or payload.get("error") or payload)[:300]
    return str(payload)[:300]


def query_page(session, cfg, page: int, page_size: int) -> tuple[int, list[dict[str, Any]]]:
    """Fetch one JSON page and return ``(server_total, rows)``."""
    body = merge_filters(cfg)
    url = config.WMS_BASE + cfg.endpoint_path
    response = session.post(
        url,
        params=paging_params(cfg, page, page_size),
        # CallAjaxPostData URL-encodes the JSON string once before jQuery's
        # application/x-www-form-urlencoded request is sent.
        data=encode_body(body),
        headers=paging_headers(cfg),
        timeout=(30, 900),
    )

    if response.status_code != 200:
        raise RuntimeError(f"api {cfg.name} page {page}: HTTP {response.status_code}")
    if _looks_expired(response.content, _header(response, "content-type")):
        raise SessionExpired("WMS session expired or token rejected")

    try:
        payload = response.json()
    except ValueError as exc:
        raise RuntimeError(
            f"api {cfg.name} page {page}: non-JSON response: {_response_error(response)}"
        ) from exc

    if not isinstance(payload, dict) or not payload.get("Succeed"):
        raise RuntimeError(f"api {cfg.name} page {page}: WMS error {_response_error(response)}")

    data = payload.get("Data") or {}
    if not isinstance(data, dict):
        return 0, []
    try:
        total = int(data.get("total") or 0)
    except (TypeError, ValueError):
        total = 0
    rows = data.get("rows") or []
    if not isinstance(rows, list):
        rows = []
    return total, [row for row in rows if isinstance(row, dict)]


def fetch_dataset(
    session,
    cfg,
    page_size: int = DEFAULT_PAGE_SIZE,
    log: Callable[[str], None] = print,
) -> ApiDataset:
    """Fetch all pages for one export/project filter."""
    if not 1 <= page_size <= MAX_PAGE_SIZE:
        raise ValueError(f"api page size must be between 1 and {MAX_PAGE_SIZE}")

    query_project = query_project_no(cfg)
    started = time.monotonic()
    total, rows = query_page(session, cfg, 1, page_size)
    pages = max(1, math.ceil(total / page_size)) if total else 1
    log(
        f"        API total={total:,}; page size={page_size:,}; "
        f"pages={pages} (page 1: {len(rows):,} rows)"
    )

    for page in range(2, pages + 1):
        page_total, page_rows = query_page(session, cfg, page, page_size)
        if page_total != total:
            log(f"        warning: total changed {total:,} -> {page_total:,}")
            total = page_total
        if not page_rows:
            raise RuntimeError(
                f"api {cfg.name}: page {page} returned no rows before total was reached"
            )
        rows.extend(page_rows)
        log(f"        page {page}/{pages}: {len(rows):,}/{total:,} rows")

    if len(rows) < total:
        raise RuntimeError(
            f"api {cfg.name}: incomplete response ({len(rows):,}/{total:,} rows)"
        )
    if len(rows) > total:
        rows = rows[:total]

    elapsed = time.monotonic() - started
    log(f"        API complete in {elapsed:.1f}s ({len(rows):,} rows)")
    return ApiDataset(
        query_project=query_project,
        total=total,
        rows=rows,
        pages=pages,
        fetched_at=datetime.now().isoformat(timespec="seconds"),
    )


def _output_path(out_dir: Path, project: str, export_name: str, ts: str) -> Path:
    safe_project = _SAFE_RE.sub("-", project)
    return out_dir / f"{safe_project}_{export_name}_{ts}.json"


def write_dataset(
    out_dir: Path,
    cfg,
    dataset: ApiDataset,
    ts: str,
    cache_hit: bool,
    page_size: int,
    country_code: str,
) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    path = _output_path(out_dir, cfg.project_no, cfg.name, ts)
    payload = {
        "project": cfg.project_no,
        "query_project": dataset.query_project,
        "export": cfg.name,
        "endpoint": cfg.endpoint_path,
        "country_code": country_code,
        "total": dataset.total,
        "fetched_rows": len(dataset.rows),
        "pages": dataset.pages,
        "page_size": page_size,
        "fetched_at": dataset.fetched_at,
        "cache_hit": cache_hit,
        "rows": dataset.rows,
    }
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def run_api_batch(
    session,
    projects: list[str],
    export_names: list[str],
    out_dir: Path,
    country_code: str | None = None,
    page_size: int = DEFAULT_PAGE_SIZE,
    log: Callable[[str], None] = print,
    run_ts: str | None = None,
) -> list[Result]:
    """Run API datasets, caching identical base-code queries."""
    if not 1 <= page_size <= MAX_PAGE_SIZE:
        raise ValueError(f"api page size must be between 1 and {MAX_PAGE_SIZE}")

    ts = run_ts or datetime.now().strftime("%Y%m%d_%H%M%S")
    results: list[Result] = []
    cache: dict[tuple[str, str, str], ApiDataset] = {}

    for project_index, project in enumerate(projects):
        log("")
        log("=" * 72)
        log(f"  PROJECT {project}")
        log("=" * 72)
        for export_index, name in enumerate(export_names):
            t0 = time.monotonic()
            try:
                cfg = exports.build(name, project, country_code)
                query_project = query_project_no(cfg)
                key = (name, query_project, country_code or config.COUNTRY_CODE)
                cache_hit = key in cache
                if cache_hit:
                    log(f"  [API] {name}: reuse query for {query_project}")
                    dataset = cache[key]
                else:
                    log(f"  [API] {name}: query {query_project}")
                    dataset = fetch_dataset(session, cfg, page_size=page_size, log=log)
                    cache[key] = dataset
                path = write_dataset(
                    out_dir, cfg, dataset, ts, cache_hit, page_size,
                    country_code or config.COUNTRY_CODE,
                )
                results.append(Result(
                    project=project,
                    export=name,
                    status="ok",
                    file=str(path),
                    bytes=path.stat().st_size,
                    duration_s=round(time.monotonic() - t0, 1),
                    query_project=query_project,
                ))
                log(f"        saved -> {path.name} ({path.stat().st_size:,} bytes)")
            except SessionExpired:
                log(f"  [ABORT] {project}/{name}: session expired")
                results.append(Result(
                    project=project, export=name, status="failed",
                    duration_s=round(time.monotonic() - t0, 1),
                    error="session expired",
                    query_project=query_project_no(cfg) if "cfg" in locals() else None,
                ))
                for remaining_project in projects[project_index:]:
                    start_export = export_index + 1 if remaining_project == project else 0
                    for remaining_name in export_names[start_export:]:
                        results.append(Result(
                            project=remaining_project,
                            export=remaining_name,
                            status="skipped",
                            error="aborted: session expired",
                        ))
                return results
            except Exception as exc:  # noqa: BLE001 - isolate each dataset
                log(f"  [FAIL] {project}/{name}: {exc}")
                results.append(Result(
                    project=project,
                    export=name,
                    status="failed",
                    duration_s=round(time.monotonic() - t0, 1),
                    error=str(exc),
                    query_project=query_project_no(cfg) if "cfg" in locals() else None,
                ))
    return results