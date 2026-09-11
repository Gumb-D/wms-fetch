"""
Shared pipeline for any WMS export that follows the two-step
isbackground=true flow:

  step 1: POST  <endpoint>?...&isbackground=true   body = URL-encoded filter JSON
          -> blocks while server builds the Excel
          -> returns {"Succeed":true,"Data":"<ExcelID GUID>"}
  step 2: GET   <endpoint>?...&isbackground=true&ExcelID=<guid>
          -> server streams the file (Content-Disposition: attachment)

Each concrete export lives in its own module (inventory.py, transfer.py,
lock.py) and provides an ExportConfig describing endpoint, referer, query
extras, and the filter body. The pipeline in this file does the rest.
"""

from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import quote, unquote

import requests

BASE = "https://scm.zte.com.cn"
DOWNLOAD_DIR = Path(__file__).resolve().parent.parent / "downloads"

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/109.0.0.0 Safari/537.36"
)
LANGUAGE_ID = "1033"  # 1033 = en-US

GUID_RE = re.compile(
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
)

# The step-2 GET is racy: the step-1 POST returns the ExcelID *before* the
# server has finished flushing the generated file to its retrieval store. A
# small export (e.g. lock) is usually ready by the first GET; a big one
# (inventory/transfer can be 25+ MB) often isn't, and the server answers with
# {"Succeed":true,"Data":null} until it is. So step2 polls the GET until a real
# file comes back, or until POLL_TIMEOUT_S elapses.
POLL_INTERVAL_S = 4.0
POLL_TIMEOUT_S = 240.0


@dataclass
class ExportConfig:
    """Everything that differs between exports."""

    name: str                          # short label, also CLI name + filename prefix
    endpoint_path: str                 # /scm/.../SomeJsonService.ashx
    referer_path: str                  # /SCM/.../SomeQuery.aspx
    command_control: str               # "btnExportDetail" or "btnExport"
    extra_query: dict[str, str]        # CardNo / CountryCode / WHtype / URL=... / Code=...
    body: dict[str, Any]               # the filter JSON object POSTed (URL-encoded)
    # If non-empty, override fields in `body` at runtime from this JSON file
    # (lets the user tweak filters without editing Python).
    filters_file: Path | None = None


# ---------------------------------------------------------------- helpers


def _step1_params(cfg: ExportConfig) -> dict[str, str]:
    """Query string used for the POST that triggers Excel generation."""
    p: dict[str, str] = {
        "CommandName": "ADD",
        "SourceID": "",
        "DataGridId": "",
        "CustomData": "",
        "CommandControl": cfg.command_control,
        "CommandEvent": "click",
        "isbackground": "true",
        "EmployeeNo": "null",
        "LanguageID": LANGUAGE_ID,
        "SystemName": "null",
        "EmployeeToken": "null",
        "EmployeeCnName": "null",
        "EmployeeEnName": "null",
    }
    p.update(cfg.extra_query)
    return p


def _step2_params(cfg: ExportConfig, excel_id: str) -> dict[str, str]:
    """Query string for the GET that downloads the generated file.

    Browser only sends the trimmed param set here (no EmployeeNo/etc) — match it.
    """
    p: dict[str, str] = {
        "CommandName": "ADD",
        "SourceID": "",
        "DataGridId": "",
        "CustomData": "",
        "CommandControl": cfg.command_control,
        "CommandEvent": "click",
        "isbackground": "true",
        "ExcelID": excel_id,
    }
    p.update(cfg.extra_query)
    return p


def _merge_filters(cfg: ExportConfig) -> dict[str, Any]:
    """Start from the inline body, then layer overrides from the JSON file (if any).

    For exports whose body has `ckbWarehouseType`, force it to match the
    `WHtype` query param so a shared filters.json can't desync the two
    (inventory and transfer share one filters file but want different WHtypes).
    """
    body = dict(cfg.body)
    if cfg.filters_file and cfg.filters_file.exists():
        overrides = json.loads(cfg.filters_file.read_text(encoding="utf-8"))
        body.update(overrides)
    wh = cfg.extra_query.get("WHtype")
    if wh and "ckbWarehouseType" in body:
        body["ckbWarehouseType"] = wh
    return body


def _extract_guid(resp: requests.Response) -> str | None:
    try:
        data = resp.json()
        d = data.get("Data")
        if isinstance(d, str) and GUID_RE.fullmatch(d):
            return d
        if isinstance(d, dict):
            for k in ("ExcelID", "ExcelId", "Id", "FileId"):
                v = d.get(k)
                if isinstance(v, str) and GUID_RE.fullmatch(v):
                    return v
    except ValueError:
        pass
    m = GUID_RE.search(resp.text)
    return m.group(0) if m else None


def _is_file_response(content_type: str, content_disposition: str) -> bool:
    """True when a step-2 GET response carries the actual export file (not the
    'still generating' JSON). The server streams the file as an Excel/binary
    content-type and/or with a filename in Content-Disposition."""
    if "filename" in content_disposition.lower():
        return True
    ct = content_type.lower()
    return any(t in ct for t in ("excel", "spreadsheet", "octet-stream"))


def _is_pending_json(body: bytes) -> bool:
    """True for the server's 'not ready yet' answer: a small JSON envelope that
    succeeded but carries no file id/payload ({"Succeed":true,"Data":null})."""
    try:
        data = json.loads(body.decode("utf-8", "replace"))
    except ValueError:
        return False
    return data.get("Succeed") is True and data.get("Data") in (None, "", [])


def _parse_filename(content_disposition: str) -> str | None:
    if not content_disposition:
        return None
    m = re.search(r"filename\*=UTF-8''([^;]+)", content_disposition)
    if m:
        return unquote(m.group(1)).strip().strip('"')
    m = re.search(r'filename="?([^";]+)"?', content_disposition)
    if m:
        return m.group(1).strip()
    return None


# ---------------------------------------------------------------- pipeline steps


def step1_generate(session: requests.Session, cfg: ExportConfig) -> str:
    body_obj = _merge_filters(cfg)
    body_str = quote(json.dumps(body_obj, separators=(",", ":")), safe="")
    headers = {
        "accept": "application/json, text/javascript, */*; q=0.01",
        "accept-language": "zh-CN,zh;q=0.9",
        "content-type": "application/x-www-form-urlencoded",
        "x-requested-with": "XMLHttpRequest",
        "user-agent": USER_AGENT,
        "referer": BASE + cfg.referer_path,
        "origin": BASE,
    }
    url = BASE + cfg.endpoint_path
    print(f"  [1/2] POST {url}")

    t0 = time.monotonic()
    resp = session.post(
        url, params=_step1_params(cfg), data=body_str, headers=headers, timeout=(30, 900)
    )
    elapsed = time.monotonic() - t0
    print(f"        status={resp.status_code}  bytes={len(resp.content)}  elapsed={elapsed:.1f}s")
    print(f"        body: {resp.text[:300]}")

    if resp.status_code != 200:
        raise RuntimeError(f"step1: HTTP {resp.status_code}")

    excel_id = _extract_guid(resp)
    if not excel_id:
        raise RuntimeError("step1: no ExcelID GUID in response (see body above)")
    print(f"        ExcelID = {excel_id}")
    return excel_id


def step2_download(session: requests.Session, cfg: ExportConfig, excel_id: str) -> Path:
    headers = {
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "zh-CN,zh;q=0.9",
        "user-agent": USER_AGENT,
        "referer": BASE + cfg.referer_path,
        "upgrade-insecure-requests": "1",
    }
    url = BASE + cfg.endpoint_path
    print(f"  [2/2] GET  {url}  ExcelID={excel_id}")

    # Poll until the file is ready (see POLL_* notes above). `resp` is left
    # holding the file-bearing response when the loop breaks.
    deadline = time.monotonic() + POLL_TIMEOUT_S
    attempt = 0
    while True:
        attempt += 1
        resp = session.get(
            url,
            params=_step2_params(cfg, excel_id),
            headers=headers,
            stream=True,
            timeout=(30, 900),
        )
        ct = resp.headers.get("Content-Type", "")
        cd = resp.headers.get("Content-Disposition", "")

        if resp.status_code != 200:
            raise RuntimeError(f"step2: HTTP {resp.status_code}")

        if _is_file_response(ct, cd):
            print(f"        status=200  content-type={ct}  (ready on attempt {attempt})")
            print(f"        cd={cd}")
            break

        # Not a file: read the small JSON envelope and decide retry vs. fail.
        body = resp.content
        if _is_pending_json(body):
            if time.monotonic() >= deadline:
                raise RuntimeError(
                    f"step2: export still not ready after {POLL_TIMEOUT_S:.0f}s "
                    f"({attempt} attempts); last response: {body[:80]!r}"
                )
            print(
                f"        attempt {attempt}: not ready yet ({body.decode('utf-8', 'replace').strip()}); "
                f"retrying in {POLL_INTERVAL_S:.0f}s"
            )
            time.sleep(POLL_INTERVAL_S)
            continue

        # Anything else (Succeed:false, a login HTML page, ...) is a hard error.
        raise RuntimeError(
            f"step2: unexpected non-file response (ct={ct!r}): {body[:200]!r}"
        )

    filename = _parse_filename(cd) or f"export_{excel_id}.xlsx"
    if not filename.lower().startswith(cfg.name.lower()):
        filename = f"{cfg.name}_{filename}"

    DOWNLOAD_DIR.mkdir(exist_ok=True)
    out = DOWNLOAD_DIR / filename

    total = 0
    with out.open("wb") as fh:
        for chunk in resp.iter_content(chunk_size=64 * 1024):
            if chunk:
                fh.write(chunk)
                total += len(chunk)
    print(f"        saved -> {out}  ({total:,} bytes)")

    # Sanity check: tiny HTML response usually means the server returned an
    # error page (stale cookies / expired ExcelID / data issue).
    if total < 4096:
        head = out.read_bytes()[:32].lower()
        if b"<html" in head or b"<!doctype" in head or "text/html" in ct.lower():
            print("  [!] Server returned an HTML page, not a file. Inspect the saved file.")

    return out


def run_export(session: requests.Session, cfg: ExportConfig) -> Path:
    """Full pipeline for one export."""
    print("\n" + "=" * 72)
    print(f"  EXPORT: {cfg.name}")
    print("=" * 72)
    excel_id = step1_generate(session, cfg)
    return step2_download(session, cfg, excel_id)
