"""
Project config — paths & backend selection for cookie auto-refresh.

Mirrors the DR Query project's layout so the two stay consistent. Edit when
moving to a new machine (or set the matching env var in .env).
"""

import os as _os

try:
    from dotenv import load_dotenv as _load_dotenv
    _load_dotenv()
except ImportError:
    pass

# ── Account ─────────────────────────────────────────────────────────────────
EMP_NO = "80045983"

# ── Final destination for the exported files ────────────────────────────────
# Files land in ./downloads/ first; once every export in the pipeline
# succeeds, the runner moves them here as a single batch.
OUTPUT_MOVE_TO = _os.environ.get(
    "WMS_OUTPUT_DIR", r"C:\Users\ZTE\Desktop\Logistic\input_files"
)

# ── WMS endpoints we care about ─────────────────────────────────────────────
WMS_BASE = "https://scm.zte.com.cn"
WMS_PORTAL_URL = "https://scm.zte.com.cn:8500/"     # SCM portal entry (sets SCMPortal_* cookies)
WMS_INVENTORY_URL = (
    f"{WMS_BASE}/SCM/WMS/WMS_CN809/InventoryManagement/InventoryQuery.aspx"
    f"?1=1&employeeNum={EMP_NO}&language=en-US&systemName=SCMPortal"
)

# ── Browser backend for cookie refresh: "chrome" or "shadowbot" ─────────────
BROWSER_BACKEND = _os.environ.get("BROWSER_BACKEND", "shadowbot").lower()

# ── Chrome (own device, headed — Chrome's user data dir doesn't run headless)
CHROME_EXECUTABLE = r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
CHROME_USER_DATA  = _os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\User Data\Profile 7")

# ── ShadowBotBrowser (hosting PC, headless-capable) ─────────────────────────
SB_EXECUTABLE = r"C:\Program Files\ShadowBot\ShadowBot Browser\Application\ShadowBotBrowser.exe"
SB_USER_DATA  = r"C:\Users\ZTE\AppData\Local\ShadowBotBrowser\User Data"
