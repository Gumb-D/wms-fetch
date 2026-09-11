"""
Cookie refresh via ShadowBotBrowser (headless-capable Chromium fork).

Same flow as playwright_auth.py — just a different binary + persistent profile.
Used on the hosting PC where headless is required.
"""

import os
from datetime import datetime, timezone

from playwright.sync_api import sync_playwright

from auth import sanitize_cookie_value
from config import SB_EXECUTABLE, SB_USER_DATA, WMS_PORTAL_URL, WMS_INVENTORY_URL

HERE = os.path.dirname(os.path.abspath(__file__))
COOKIES_FILE = os.path.join(HERE, "cookies.txt")
COOKIES_META_FILE = os.path.join(HERE, "cookies_meta.txt")


def refresh_cookies_via_playwright(emp_no: str) -> str | None:
    print("  ->Launching ShadowBotBrowser to extract fresh WMS cookies...")

    with sync_playwright() as p:
        try:
            context = p.chromium.launch_persistent_context(
                user_data_dir=SB_USER_DATA,
                executable_path=SB_EXECUTABLE,
                headless=True,
                args=["--disable-blink-features=AutomationControlled"],
            )
        except Exception as e:
            print(f"  [x]Could not launch ShadowBotBrowser: {e}")
            print("    Is ShadowBotBrowser already running? Close it and retry.")
            return None

        page = context.new_page()

        try:
            page.goto(WMS_PORTAL_URL, timeout=20000)
            page.wait_for_load_state("networkidle", timeout=20000)
        except Exception as e:
            print(f"  [!]portal load warning (continuing): {e}")

        try:
            page.goto(WMS_INVENTORY_URL, timeout=20000)
            page.wait_for_load_state("networkidle", timeout=20000)
        except Exception as e:
            print(f"  [!]inventory page load warning (continuing): {e}")

        cookies = context.cookies(["https://scm.zte.com.cn"])
        context.close()

    if not cookies:
        print("  [x]No cookies found — is SB Browser signed in to scm.zte.com.cn?")
        return None

    cookie_str = "; ".join(
        f"{c['name']}={sanitize_cookie_value(c['value'])}" for c in cookies
    )

    required = {"ASP.NET_SessionId", "ZTEDPGSSOCookie"}
    have = {c["name"] for c in cookies}
    missing = required - have
    if missing:
        print(f"  [x]Missing required cookies: {sorted(missing)} — session probably expired in SB Browser.")
        return None

    with open(COOKIES_FILE, "w", encoding="utf-8") as f:
        f.write(cookie_str + "\n")
    with open(COOKIES_META_FILE, "w", encoding="utf-8") as f:
        f.write(f"emp_no={emp_no}\nextracted_at={datetime.now(timezone.utc).isoformat()}\n")

    print("  [ok]Fresh cookies saved to cookies.txt")
    return cookie_str
