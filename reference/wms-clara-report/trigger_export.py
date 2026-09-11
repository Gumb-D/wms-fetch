"""
Trigger WMS Inventory Query export -> file is delivered to the logged-in user's
mailbox by the server (this script does NOT receive the file directly).

Phase 1 - manual cookies:
  1. Open WMS in a browser, log in, open InventoryQuery.aspx.
  2. DevTools -> Network -> copy the value of the "Cookie:" request header.
  3. Paste it (overwrite) into cookies.txt next to this script.
  4. Adjust filters.json (at minimum taPreSalesProjNo / taPreSalesProjNoMulti).
  5. python trigger_export.py
"""

import json
import sys
from pathlib import Path
from urllib.parse import quote

import requests

BASE = "https://scm.zte.com.cn"
EXPORT_PATH = "/scm/WMS/WMS_CN809/InventoryManagement/JsonService/InventoryQueryJsonService.ashx"

CARD_NO = "80045983"      # employee no
COUNTRY = "MY"
WH_TYPE = "10,40,60"
LANGUAGE_ID = "1033"      # en-US

HERE = Path(__file__).parent
COOKIES_FILE = HERE / "cookies.txt"
FILTERS_FILE = HERE / "filters.json"


def load_cookie_header() -> str:
    if not COOKIES_FILE.exists():
        sys.exit(f"Missing {COOKIES_FILE}. Paste the raw Cookie header into it.")
    raw = COOKIES_FILE.read_text(encoding="utf-8").strip()
    if not raw:
        sys.exit(f"{COOKIES_FILE} is empty.")
    return raw


def load_filters() -> dict:
    return json.loads(FILTERS_FILE.read_text(encoding="utf-8"))


def trigger_export() -> None:
    cookie_header = load_cookie_header()
    filters = load_filters()

    params = {
        "CardNo": CARD_NO,
        "CommandName": "ADD",
        "SourceID": "",
        "DataGridId": "",
        "CountryCode": COUNTRY,
        "WHtype": WH_TYPE,
        "CustomData": "",
        "CommandControl": "btnExportDetail",
        "CommandEvent": "click",
        "isbackground": "false",
        "EmployeeNo": "null",
        "LanguageID": LANGUAGE_ID,
        "SystemName": "null",
        "EmployeeToken": "null",
        "EmployeeCnName": "null",
        "EmployeeEnName": "null",
    }

    # The site posts the JSON filter object as a single URL-encoded string
    # (no key=value, just the encoded JSON as the body).
    body = quote(json.dumps(filters, separators=(",", ":")), safe="")

    headers = {
        "accept": "application/json, text/javascript, */*; q=0.01",
        "accept-language": "zh-CN,zh;q=0.9",
        "content-type": "application/x-www-form-urlencoded",
        "x-requested-with": "XMLHttpRequest",
        "user-agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/109.0.0.0 Safari/537.36"
        ),
        "referer": (
            f"{BASE}/SCM/WMS/WMS_CN809/InventoryManagement/InventoryQuery.aspx"
            f"?employeeNum={CARD_NO}&language=en-US&systemName=SCMPortal"
        ),
        "origin": BASE,
        "cookie": cookie_header,
    }

    url = BASE + EXPORT_PATH
    print(f"POST {url}")
    print(f"  project: {filters.get('taPreSalesProjNo')}  country: {COUNTRY}  wh: {WH_TYPE}")

    resp = requests.post(url, params=params, data=body, headers=headers, timeout=60)

    print(f"\nStatus: {resp.status_code}")
    print("Response headers:")
    for k, v in resp.headers.items():
        print(f"  {k}: {v}")
    print("\nResponse body (first 2000 chars):")
    print(resp.text[:2000])

    ok = False
    try:
        data = resp.json()
        ok = bool(data.get("Succeed"))
    except ValueError:
        pass

    if resp.status_code == 200 and ok:
        print("\n[OK] Export queued. Check the mailbox bound to this employee account.")
    else:
        print("\n[!] Unexpected response. If you see a login HTML page, cookies are stale.")


if __name__ == "__main__":
    trigger_export()
