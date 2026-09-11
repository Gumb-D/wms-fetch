"""
Shared pipeline for any WMS export using the two-step isbackground=true flow:

  step 1: POST <endpoint>?...&isbackground=true   body = URL-encoded filter JSON
          -> returns {"Succeed":true,"Data":"<ExcelID GUID>"}
  step 2: GET  <endpoint>?...&isbackground=true&ExcelID=<guid>
          -> streams the file (Content-Disposition: attachment)

Ported from the reference project. Two behavioural changes:

  * ExportConfig is now built per project number (see build_config in each
    export module) instead of carrying one hardcoded project.
  * Downloads are named "{project}_{export}_{timestamp}{ext}" rather than
    reusing the server filename. The server returns the same filename for
    every project, so the reference would have silently overwritten each
    project's file with the next one.
"""

from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import quote, unquote

import requests

from .. import config

GUID_RE = re.compile(
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
)

# The step-2 GET is racy: step 1 returns the ExcelID *before* the server has
# finished flushing the file. Small exports are ready on the first GET; a
# 25MB inventory pull often is not, and the server answers
# {"Succeed":true,"Data":null} until it is.
POLL_INTERVAL_S = 4.0
POLL_TIMEOUT_S = 240.0


@dataclass
class ExportConfig:
    """Everything that differs between exports, bound to one project number."""

    name: str
    project_no: str
    endpoint_path: str
    referer_path: str
    command_control: str
    extra_query: dict[str, str]
    body: dict[str, Any]
    # Fields carrying the project number. Applied last so a filters file can
    # never accidentally override the thing we are iterating over.
    project_fields: dict[str, str] = field(default_factory=dict)
    filters_file: Path | None = None


# ---------------------------------------------------------------- helpers


def _common_params(cfg: ExportConfig) -> dict[str, str]:
    return {
        "CommandName": "ADD",
        "SourceID": "",
        "DataGridId": "",
        "CustomData": "",
        "CommandControl": cfg.command_control,
        "CommandEvent": "click",
        "isbackground": "true",
    }


def step1_params(cfg: ExportConfig) -> dict[str, str]:
    p = _common_params(cfg)
    p.update({
        "EmployeeNo": "null",
        "LanguageID": config.LANGUAGE_ID,
        "SystemName": "null",
        "EmployeeToken": "null",
        "EmployeeCnName": "null",
        "EmployeeEnName": "null",
    })
    p.update(cfg.extra_query)
    return p


def step2_params(cfg: ExportConfig, excel_id: str) -> dict[str, str]:
    """The browser sends a trimmed param set on the download GET - match it."""
    p = _common_params(cfg)
    p["ExcelID"] = excel_id
    p.update(cfg.extra_query)
    return p


def merge_filters(cfg: ExportConfig) -> dict[str, Any]:
    body = dict(cfg.body)
    if cfg.filters_file and cfg.filters_file.exists():
        body.update(json.loads(cfg.filters_file.read_text(encoding="utf-8")))
    # Project fields win over both inline body and filters file.
    body.update(cfg.project_fields)
    wh = cfg.extra_query.get("WHtype")
    if wh and "ckbWarehouseType" in body:
        body["ckbWarehouseType"] = wh
    return body


def encode_body(body: dict[str, Any]) -> str:
    return quote(json.dumps(body, separators=(",", ":")), safe="")


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
    if "filename" in content_disposition.lower():
        return True
    ct = content_type.lower()
    return any(t in ct for t in ("excel", "spreadsheet", "octet-stream"))


def _is_pending_json(body: bytes) -> bool:
    """True for the server's 'not ready yet' envelope."""
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


_SAFE_RE = re.compile(r"[^A-Za-z0-9._-]+")


def output_filename(cfg: ExportConfig, server_name: str | None, ts: str) -> str:
    """{project}_{export}_{timestamp}{ext} - unique per project and per run."""
    ext = ""
    if server_name and "." in server_name:
        ext = "." + server_name.rsplit(".", 1)[1].lower()
    if ext not in (".xls", ".xlsx", ".csv", ".zip"):
        ext = ".xls"
    proj = _SAFE_RE.sub("-", cfg.project_no)
    return f"{proj}_{cfg.name}_{ts}{ext}"


# ---------------------------------------------------------------- pipeline


def step1_generate(session: requests.Session, cfg: ExportConfig, log=print) -> str:
    body_str = encode_body(merge_filters(cfg))
    headers = {
        "accept": "application/json, text/javascript, */*; q=0.01",
        "accept-language": "en-US,en;q=0.9",
        "content-type": "application/x-www-form-urlencoded",
        "x-requested-with": "XMLHttpRequest",
        "user-agent": config.USER_AGENT,
        "referer": config.WMS_BASE + cfg.referer_path,
        "origin": config.WMS_BASE,
    }
    url = config.WMS_BASE + cfg.endpoint_path
    log(f"  [1/2] POST {cfg.name} for {cfg.project_no}")

    t0 = time.monotonic()
    resp = session.post(
        url, params=step1_params(cfg), data=body_str, headers=headers,
        timeout=(30, 900),
    )
    log(f"        status={resp.status_code} elapsed={time.monotonic() - t0:.1f}s")

    if resp.status_code != 200:
        raise RuntimeError(f"step1: HTTP {resp.status_code}")

    excel_id = _extract_guid(resp)
    if not excel_id:
        raise RuntimeError(f"step1: no ExcelID in response: {resp.text[:200]!r}")
    log(f"        ExcelID = {excel_id}")
    return excel_id


def step2_download(
    session: requests.Session,
    cfg: ExportConfig,
    excel_id: str,
    out_dir: Path,
    ts: str,
    log=print,
) -> Path:
    headers = {
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
        "user-agent": config.USER_AGENT,
        "referer": config.WMS_BASE + cfg.referer_path,
        "upgrade-insecure-requests": "1",
    }
    url = config.WMS_BASE + cfg.endpoint_path
    log(f"  [2/2] GET  ExcelID={excel_id}")

    deadline = time.monotonic() + POLL_TIMEOUT_S
    attempt = 0
    while True:
        attempt += 1
        resp = session.get(
            url, params=step2_params(cfg, excel_id), headers=headers,
            stream=True, timeout=(30, 900),
        )
        ct = resp.headers.get("Content-Type", "")
        cd = resp.headers.get("Content-Disposition", "")

        if resp.status_code != 200:
            raise RuntimeError(f"step2: HTTP {resp.status_code}")
        if _is_file_response(ct, cd):
            log(f"        ready on attempt {attempt} ({ct})")
            break

        body = resp.content
        if _is_pending_json(body):
            if time.monotonic() >= deadline:
                raise RuntimeError(
                    f"step2: not ready after {POLL_TIMEOUT_S:.0f}s "
                    f"({attempt} attempts)"
                )
            log(f"        attempt {attempt}: not ready, retry in {POLL_INTERVAL_S:.0f}s")
            time.sleep(POLL_INTERVAL_S)
            continue

        raise RuntimeError(f"step2: unexpected response (ct={ct!r}): {body[:200]!r}")

    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / output_filename(cfg, _parse_filename(cd), ts)

    total = 0
    with out.open("wb") as fh:
        for chunk in resp.iter_content(chunk_size=64 * 1024):
            if chunk:
                fh.write(chunk)
                total += len(chunk)
    log(f"        saved -> {out.name} ({total:,} bytes)")

    if total < 4096:
        head = out.read_bytes()[:32].lower()
        if b"<html" in head or b"<!doctype" in head:
            raise RuntimeError(
                f"step2: server returned an HTML page, not a file "
                f"(saved {out.name}); cookies may be stale"
            )
    return out


def run_export(
    session: requests.Session,
    cfg: ExportConfig,
    out_dir: Path | None = None,
    ts: str | None = None,
    log=print,
) -> Path:
    out_dir = out_dir or config.DOWNLOAD_DIR
    ts = ts or datetime.now().strftime("%Y%m%d_%H%M%S")
    excel_id = step1_generate(session, cfg, log=log)
    return step2_download(session, cfg, excel_id, out_dir, ts, log=log)