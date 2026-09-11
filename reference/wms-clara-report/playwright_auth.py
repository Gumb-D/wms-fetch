"""
Cookie refresh via headed Chrome with a persistent user profile.

Mirrors DR Query's `playwright_auth.py`. Relies on the Chrome profile already
being signed into WMS — Playwright just navigates there, lets SSO settle, and
extracts the resulting cookies.
"""

import os
from datetime import datetime, timezone

from playwright.sync_api import sync_playwright

from auth import sanitize_cookie_value
from config import CHROME_EXECUTABLE, CHROME_USER_DATA, WMS_PORTAL_URL, WMS_INVENTORY_URL

HERE = os.path.dirname(os.path.abspath(__file__))
COOKIES_FILE = os.path.join(HERE, "cookies.txt")
COOKIES_META_FILE = os.path.join(HERE, "cookies_meta.txt")


def refresh_cookies_via_playwright(emp_no: str) -> str | None:
    """Launch Chrome, navigate to WMS, write fresh cookies.txt. Return cookie header string."""
    print("  ->Launching Chrome to extract fresh WMS cookies...")

    with sync_playwright() as p:
        try:
            context = p.chromium.launch_persistent_context(
                user_data_dir=CHROME_USER_DATA,
                executable_path=CHROME_EXECUTABLE,
                headless=False,  # Chrome's user data dir doesn't work well headless
                args=["--disable-blink-features=AutomationControlled"],
            )
        except Exception as e:
            print(f"  [x]Could not launch Chrome: {e}")
            print("    Is Chrome already running with this profile? Close it fully and retry.")
            return None

        page = context.new_page()

        # 1) hit the portal so SCMPortal_* cookies refresh
        # 2) then navigate to InventoryQuery so ASP.NET_SessionId is bound
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
        print("  [x]No cookies found — is the Chrome profile signed in to scm.zte.com.cn?")
        return None

    cookie_str = "; ".join(
        f"{c['name']}={sanitize_cookie_value(c['value'])}" for c in cookies
    )

    # Sanity: WMS always has these. Their absence means SSO didn't complete.
    required = {"ASP.NET_SessionId", "ZTEDPGSSOCookie"}
    have = {c["name"] for c in cookies}
    missing = required - have
    if missing:
        print(f"  [x]Missing required cookies: {sorted(missing)} — session probably expired in Chrome.")
        return None

    with open(COOKIES_FILE, "w", encoding="utf-8") as f:
        f.write(cookie_str + "\n")
    with open(COOKIES_META_FILE, "w", encoding="utf-8") as f:
        f.write(f"emp_no={emp_no}\nextracted_at={datetime.now(timezone.utc).isoformat()}\n")

    print("  [ok]Fresh cookies saved to cookies.txt")
    return cookie_str
