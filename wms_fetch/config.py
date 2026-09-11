"""
Environment-driven config.

Nothing secret or machine-specific is hardcoded here: the reference project
baked in an employee number and an absolute Windows desktop path, making it
non-portable and unsafe to publish. Everything now comes from .env / env vars.
"""

from __future__ import annotations

import os
from pathlib import Path

try:
    from dotenv import load_dotenv
except ImportError:  # dotenv is optional; plain env vars work fine
    def load_dotenv(*_a, **_k):
        return False

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")


def _path(env_name: str, default: Path) -> Path:
    raw = os.environ.get(env_name, "").strip()
    return Path(raw) if raw else default


# --- account ---------------------------------------------------------------
EMP_NO = os.environ.get("WMS_EMP_NO", "").strip()

# --- endpoints -------------------------------------------------------------
WMS_BASE = os.environ.get("WMS_BASE", "https://scm.zte.com.cn").rstrip("/")
COUNTRY_CODE = os.environ.get("WMS_COUNTRY_CODE", "MY").strip()

# --- paths -----------------------------------------------------------------
DOWNLOAD_DIR = _path("WMS_DOWNLOAD_DIR", ROOT / "downloads")
OUTPUT_DIR = _path("WMS_OUTPUT_DIR", ROOT / "output")
COOKIES_FILE = _path("WMS_COOKIES_FILE", ROOT / "cookies.txt")
PROJECTS_FILE = _path("WMS_PROJECTS_FILE", ROOT / "projects" / "celcomdigi.json")

LANGUAGE_ID = "1033"  # en-US
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/109.0.0.0 Safari/537.36"
)


def require_emp_no() -> str:
    if not EMP_NO:
        raise RuntimeError(
            "WMS_EMP_NO is not set. Copy .env.example to .env and fill it in."
        )
    return EMP_NO