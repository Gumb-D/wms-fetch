r"""Direct parquet reader for CLARA inventory data.

The source parquet path is configured by `.env`:

    PARQUET_PATH=\\server\share\latest_merged_data.parquet
    PARQUET_PATH=http://server/path/latest_merged_data.parquet

HTTP sources are downloaded with bounded timeouts and retained as a
last-known-good local cache. This module returns JSON-safe rows.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse
from urllib.request import Request, urlopen

import pandas as pd

HERE = Path(__file__).parent
ENV_FILE = HERE / ".env"
DEFAULT_LIMIT = 100
MAX_LIMIT = 10000
CACHE_DIR = HERE / ".cache"
CACHE_FILE = CACHE_DIR / "latest_merged_data.parquet"
RETURN_COLUMNS = ["Region", "Item Code", "Alias", "Product", "Quantity", "Available Material"]
STOCK_CATEGORY_COLUMN = "Stock Category"
AVAILABLE_STOCK_CATEGORY = "Available"


def load_env(path: Path = ENV_FILE) -> None:
    """Load simple KEY=VALUE pairs from .env without requiring python-dotenv."""
    if not path.exists():
        return

    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


load_env()

SOURCE_TIMEOUT_SECONDS = float(os.getenv("CLARA_SOURCE_TIMEOUT", "10"))
DOWNLOAD_MAX_SECONDS = float(os.getenv("CLARA_DOWNLOAD_MAX_TIME", "60"))
CACHE_TTL_SECONDS = float(os.getenv("CLARA_CACHE_TTL", "300"))
ERROR_RETRY_SECONDS = float(os.getenv("CLARA_ERROR_RETRY", "30"))


_cache_lock = threading.Lock()
_cached_dataframe: pd.DataFrame | None = None
_cached_source = ""
_next_refresh_at = 0.0
_last_success: str | None = None
_last_error: str | None = None


def get_source() -> str:
    source = os.getenv("PARQUET_PATH", "").strip()
    if not source:
        raise FileNotFoundError("PARQUET_PATH is not configured in .env.")

    parsed = urlparse(source)
    if parsed.scheme in ("http", "https"):
        return source

    path = Path(source)
    if not path.exists():
        raise FileNotFoundError(f"Parquet source not found: {path}")
    return str(path)


def get_source_path() -> Path:
    """Return local/UNC source as Path. HTTP sources should use get_source()."""
    source = get_source()
    parsed = urlparse(source)
    if parsed.scheme in ("http", "https"):
        raise ValueError("PARQUET_PATH is a URL, not a filesystem path.")
    return Path(source)


def _read_parquet(path: str | Path) -> pd.DataFrame:
    return pd.read_parquet(
        path,
        filters=[(STOCK_CATEGORY_COLUMN, "==", AVAILABLE_STOCK_CATEGORY)],
    )


def _download_http_source(source: str) -> tuple[Path, pd.DataFrame]:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    request = Request(source, headers={"User-Agent": "ClaraAPI/1.1"})
    temporary_path: Path | None = None

    try:
        started_at = time.monotonic()
        with urlopen(request, timeout=SOURCE_TIMEOUT_SECONDS) as response:
            with tempfile.NamedTemporaryFile(
                mode="wb", suffix=".parquet", dir=CACHE_DIR, delete=False
            ) as temporary:
                temporary_path = Path(temporary.name)
                while True:
                    if time.monotonic() - started_at >= DOWNLOAD_MAX_SECONDS:
                        raise TimeoutError(
                            f"Parquet download exceeded {DOWNLOAD_MAX_SECONDS:g} seconds"
                        )
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    temporary.write(chunk)

        # Validate the complete file before making it the last-known-good copy.
        dataframe = _read_parquet(temporary_path)
        os.replace(temporary_path, CACHE_FILE)
        return CACHE_FILE, dataframe
    except Exception:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)
        raise


def read_dataframe() -> pd.DataFrame:
    """Return cached inventory rows, refreshing the source at a bounded rate."""
    global _cached_dataframe, _cached_source, _next_refresh_at
    global _last_success, _last_error

    source = get_source()
    now = time.monotonic()
    if _cached_dataframe is not None and source == _cached_source and now < _next_refresh_at:
        return _cached_dataframe

    with _cache_lock:
        now = time.monotonic()
        if _cached_dataframe is not None and source == _cached_source and now < _next_refresh_at:
            return _cached_dataframe

        parsed = urlparse(source)
        try:
            if parsed.scheme in ("http", "https"):
                _, dataframe = _download_http_source(source)
            else:
                dataframe = _read_parquet(Path(source))
        except Exception as exc:
            _last_error = f"{type(exc).__name__}: {exc}"
            _next_refresh_at = now + ERROR_RETRY_SECONDS
            if _cached_dataframe is not None and source == _cached_source:
                return _cached_dataframe
            if parsed.scheme in ("http", "https") and CACHE_FILE.exists():
                dataframe = _read_parquet(CACHE_FILE)
            else:
                raise
        else:
            _last_success = datetime.now(timezone.utc).isoformat()
            _last_error = None
            _next_refresh_at = now + CACHE_TTL_SECONDS

        _cached_dataframe = dataframe
        _cached_source = source
        return dataframe


def get_status() -> dict:
    """Return readiness and refresh details without starting a remote read."""
    source = get_source()
    parsed = urlparse(source)
    is_http = parsed.scheme in ("http", "https")
    cache_exists = CACHE_FILE.exists() if is_http else Path(source).exists()
    cache_age_seconds = None
    if is_http and cache_exists:
        cache_age_seconds = max(0, int(time.time() - CACHE_FILE.stat().st_mtime))

    return {
        "ok": cache_exists or (_cached_dataframe is not None and source == _cached_source),
        "source": source,
        "source_type": "http" if is_http else "file",
        "cache_available": cache_exists,
        "cache_age_seconds": cache_age_seconds,
        "last_success": _last_success,
        "last_error": _last_error,
    }


def select_return_columns(df: pd.DataFrame) -> pd.DataFrame:
    missing = [column for column in RETURN_COLUMNS if column not in df.columns]
    if missing:
        raise KeyError(f"Configured return columns missing from source: {', '.join(missing)}")
    return df[RETURN_COLUMNS]


def json_safe(value: Any) -> Any:
    return json.loads(json.dumps(value, default=str))


def get_columns() -> dict:
    df = select_return_columns(read_dataframe())
    return {
        "source": get_source(),
        "row_count": len(df),
        "columns": [
            {"name": column, "type": str(dtype)}
            for column, dtype in df.dtypes.items()
        ],
    }


def get_rows(limit: int = DEFAULT_LIMIT, offset: int = 0) -> dict:
    df = select_return_columns(read_dataframe())
    safe_limit = max(1, min(int(limit), MAX_LIMIT))
    safe_offset = max(0, int(offset))
    page = df.iloc[safe_offset:safe_offset + safe_limit]

    return json_safe({
        "source": get_source(),
        "row_count": len(df),
        "limit": safe_limit,
        "offset": safe_offset,
        "rows": page.to_dict(orient="records"),
    })


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    print(json.dumps(get_rows(), indent=2, ensure_ascii=False))
