"""
Cookie loading, sanitization and a cheap validity probe.

Ported from the reference auth.py, minus the Playwright auto-refresh: that
depended on a ShadowBot/Chrome install and a hardcoded profile path that do
not exist on every machine. Here an invalid cookie fails loudly with
instructions instead of silently launching a browser.
"""

from __future__ import annotations

from pathlib import Path

import requests

from . import config


def sanitize_cookie_header(raw: str) -> str:
    """Drop cookie pairs that requests cannot send.

    HTTP headers go out as latin-1; a cookie value holding e.g. a Chinese
    employee name raises UnicodeEncodeError deep inside urllib3. Those pairs
    are not needed for auth, so drop them rather than crash.
    """
    kept = []
    for pair in raw.strip().split(";"):
        pair = pair.strip()
        if not pair or "=" not in pair:
            continue
        try:
            pair.encode("latin-1")
        except UnicodeEncodeError:
            continue
        kept.append(pair)
    return "; ".join(kept)


def load_cookie_header(path: str | Path | None = None) -> str:
    p = Path(path) if path else config.COOKIES_FILE
    if not p.exists():
        raise FileNotFoundError(
            f"cookie file not found: {p}\n"
            "Log into WMS in a browser, copy the request Cookie header, "
            "and save it as one line in that file."
        )
    header = sanitize_cookie_header(p.read_text(encoding="utf-8"))
    if not header:
        raise ValueError(f"cookie file is empty after sanitization: {p}")
    return header


def build_test_url() -> str:
    """Cheap auth-checked GET with no side effects (populates a dropdown)."""
    return (
        f"{config.WMS_BASE}"
        "/scm/WMS/WMS_CN809/InventoryManagement/JsonService/InventoryQueryJsonService.ashx"
        f"?CardNo={config.require_emp_no()}&CommandName=GETCONTROLDATA"
        "&ControlID=ddckWarehouseName"
        f"&CountryCode={config.COUNTRY_CODE}&WHtype=10,40&CustomData=&EmployeeNo=null"
        "&LanguageID=1033&SystemName=null&EmployeeToken=null"
        "&EmployeeCnName=null&EmployeeEnName=null"
    )


def cookies_are_valid(session: requests.Session) -> bool:
    try:
        r = session.get(build_test_url(), timeout=(15, 60))
    except requests.RequestException:
        return False
    if r.status_code != 200:
        return False
    # An expired session returns the SSO login page (HTML) with status 200,
    # so status alone is not enough - require parseable JSON.
    ctype = r.headers.get("Content-Type", "").lower()
    if "html" in ctype:
        return False
    try:
        r.json()
    except ValueError:
        return False
    return True


def build_session(cookie_header: str) -> requests.Session:
    s = requests.Session()
    s.headers.update({"cookie": cookie_header, "user-agent": config.USER_AGENT})
    return s