"""
Cookie validity check + auto-refresh for WMS.

Mirrors DR Query's auth.py. Behavior:
  1. Load cookies.txt.
  2. Hit a cheap auth-required WMS endpoint to verify they still work.
  3. If they don't, dispatch to the right Playwright backend (Chrome or
     ShadowBot) to refresh, then re-test once. Exit if still failing.
"""

import os
import sys
from datetime import datetime, timezone
from urllib.parse import quote

import requests

import config

HERE = os.path.dirname(os.path.abspath(__file__))
COOKIES_FILE = os.path.join(HERE, "cookies.txt")
COOKIES_META_FILE = os.path.join(HERE, "cookies_meta.txt")
COOKIES_MAX_AGE_HOURS = 12

# Cheap auth-checked GET; no side effects. Populates the warehouse-name dropdown.
WMS_TEST_URL = (
    f"{config.WMS_BASE}"
    "/scm/WMS/WMS_CN809/InventoryManagement/JsonService/InventoryQueryJsonService.ashx"
    f"?CardNo={config.EMP_NO}&CommandName=GETCONTROLDATA&ControlID=ddckWarehouseName"
    "&CountryCode=MY&WHtype=10,40&CustomData=&EmployeeNo=null&LanguageID=1033"
    "&SystemName=null&EmployeeToken=null&EmployeeCnName=null&EmployeeEnName=null"
)


# ───────────────────────────────────────────── cookie sanitization
#
# requests sends HTTP headers as latin-1; any cookie value containing chars
# outside U+00FF (e.g. the user's Chinese display name in SCMUILoader) will
# raise "'latin-1' codec can't encode" at send time. Percent-encoding those
# values keeps every cookie ASCII while preserving the original bytes.


def sanitize_cookie_value(v: str) -> str:
    try:
        v.encode("latin-1")
        return v
    except UnicodeEncodeError:
        return quote(v, safe="")


def sanitize_cookie_header(header: str) -> str:
    parts: list[str] = []
    for piece in header.split(";"):
        piece = piece.strip()
        if not piece:
            continue
        if "=" not in piece:
            parts.append(piece)
            continue
        k, _, v = piece.partition("=")
        parts.append(f"{k}={sanitize_cookie_value(v)}")
    return "; ".join(parts)


# ───────────────────────────────────────────── cookie file


def _load_cookie_header() -> str | None:
    if not os.path.exists(COOKIES_FILE):
        return None
    raw = open(COOKIES_FILE, "r", encoding="utf-8").read().strip()
    if not raw:
        return None
    return sanitize_cookie_header(raw)


def _read_age_hours() -> float | None:
    if not os.path.exists(COOKIES_META_FILE):
        return None
    try:
        for line in open(COOKIES_META_FILE, "r", encoding="utf-8"):
            if line.startswith("extracted_at="):
                ts = line.split("=", 1)[1].strip()
                age = datetime.now(timezone.utc) - datetime.fromisoformat(ts)
                return age.total_seconds() / 3600
    except Exception:
        return None
    return None


# ───────────────────────────────────────────── live test


def test_wms_cookies(cookie_header: str) -> bool:
    """Returns True if the cookie header still authenticates against WMS."""
    headers = {
        "accept": "application/json, text/javascript, */*; q=0.01",
        "x-requested-with": "XMLHttpRequest",
        "user-agent": "Mozilla/5.0",
        "cookie": cookie_header,
        "referer": (
            f"{config.WMS_BASE}/SCM/WMS/WMS_CN809/InventoryManagement/InventoryQuery.aspx"
        ),
    }
    try:
        resp = requests.get(WMS_TEST_URL, headers=headers, timeout=15)
    except Exception as e:
        print(f"  [!]test request error: {e}")
        return False
    if resp.status_code != 200:
        return False
    body = resp.text
    # Two known failure shapes: server-rendered text, or HTML login page.
    if "登录过期" in body or "Token认证失败" in body or "重新登录" in body:
        return False
    if "<html" in body.lower() and "login" in body.lower():
        return False
    # Anything else returning JSON-ish data we accept.
    return True


# ───────────────────────────────────────────── public entry point


def ensure_valid_cookies() -> str:
    """Return a valid cookie header string, refreshing via Playwright if needed."""
    print("Checking WMS cookies...")

    cookie = _load_cookie_header()
    if cookie:
        age = _read_age_hours()
        if age is not None and age > COOKIES_MAX_AGE_HOURS:
            print(f"  [!]cookies are {age:.1f}h old — may be stale")
        if test_wms_cookies(cookie):
            print("  [ok]Cookies valid")
            return cookie
        print("  [x]Cookies expired.")
    else:
        print("  [x]No cookies.txt yet.")

    backend = config.BROWSER_BACKEND
    if backend == "shadowbot":
        print("  ->refreshing via ShadowBotBrowser...")
        from playwright_auth_sb import refresh_cookies_via_playwright
        fail_hint = "Ensure ShadowBotBrowser is signed in to scm.zte.com.cn and not running."
    else:
        print("  ->refreshing via Chrome...")
        from playwright_auth import refresh_cookies_via_playwright
        fail_hint = "Ensure Chrome is fully closed and signed in to scm.zte.com.cn."

    cookie = refresh_cookies_via_playwright(config.EMP_NO)
    if not cookie:
        print(f"  [x]Refresh failed. {fail_hint}")
        sys.exit(1)

    # Verify the freshly-extracted cookies actually authenticate.
    if not test_wms_cookies(cookie):
        print("  [x]Refreshed cookies still fail the auth test.")
        print("    Open Chrome/SB manually, log into scm.zte.com.cn, then retry.")
        sys.exit(1)

    print("  [ok]Cookies refreshed & verified")
    return cookie


if __name__ == "__main__":
    # Allow `python auth.py` to refresh + verify standalone.
    ensure_valid_cookies()
