"""Token-protected HTTP API for CLARA inventory parquet data."""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import query_data

HOST = os.getenv("CLARA_API_HOST", "0.0.0.0")
PORT = int(os.getenv("CLARA_API_PORT", "8010"))
API_TOKEN = os.getenv("CLARA_API_TOKEN") or os.getenv("API_TOKEN")
HERE = Path(__file__).parent
UI_FILE = HERE / "public" / "index.html"
MAX_DATA_REQUESTS = int(os.getenv("CLARA_MAX_DATA_REQUESTS", "4"))
DATA_REQUEST_WAIT_SECONDS = float(os.getenv("CLARA_DATA_REQUEST_WAIT", "1"))
CLIENT_SOCKET_TIMEOUT_SECONDS = float(os.getenv("CLARA_CLIENT_TIMEOUT", "30"))
DATA_REQUEST_SLOTS = threading.BoundedSemaphore(MAX_DATA_REQUESTS)


class ClaraApiHandler(BaseHTTPRequestHandler):
    server_version = "ClaraAPI/1.0"

    def log_message(self, format: str, *args) -> None:
        print("%s - %s" % (self.address_string(), format % args))

    def setup(self) -> None:
        super().setup()
        self.connection.settimeout(CLIENT_SOCKET_TIMEOUT_SECONDS)

    def send_json(self, status: HTTPStatus, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")
        self.send_response(status.value)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_html_file(self, path: Path) -> None:
        if not path.exists():
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "UI file not found"})
            return

        body = path.read_bytes()
        self.send_response(HTTPStatus.OK.value)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def token_from_request(self) -> str:
        auth = self.headers.get("Authorization", "")
        if auth.lower().startswith("bearer "):
            return auth[7:].strip()
        return self.headers.get("x-api-token", "").strip()

    def is_authorized(self) -> bool:
        return bool(API_TOKEN) and self.token_from_request() == API_TOKEN

    def require_auth(self) -> bool:
        if self.is_authorized():
            return True
        self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "Unauthorized"})
        return False

    def do_GET(self) -> None:
        parsed = urlparse(self.path)

        if parsed.path in ("/", "/ui", "/index.html"):
            self.send_html_file(UI_FILE)
            return

        if parsed.path == "/health":
            try:
                status = query_data.get_status()
                http_status = HTTPStatus.OK if status["ok"] else HTTPStatus.SERVICE_UNAVAILABLE
                self.send_json(http_status, status)
            except Exception as exc:
                self.send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "error": str(exc)})
            return

        if parsed.path not in ("/api/data", "/api/columns", "/api/ui-data"):
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "Not found"})
            return

        if parsed.path != "/api/ui-data" and not self.require_auth():
            return

        if not DATA_REQUEST_SLOTS.acquire(timeout=DATA_REQUEST_WAIT_SECONDS):
            self.send_json(HTTPStatus.SERVICE_UNAVAILABLE, {
                "error": "Inventory data is busy; retry shortly."
            })
            return

        try:
            try:
                if parsed.path == "/api/columns":
                    self.send_json(HTTPStatus.OK, query_data.get_columns())
                    return

                params = parse_qs(parsed.query)
                limit = int(params.get("limit", [query_data.DEFAULT_LIMIT])[0])
                offset = int(params.get("offset", [0])[0])
                self.send_json(HTTPStatus.OK, query_data.get_rows(limit=limit, offset=offset))
            except ValueError:
                self.send_json(HTTPStatus.BAD_REQUEST, {"error": "limit and offset must be numbers"})
            except Exception as exc:
                self.send_json(HTTPStatus.SERVICE_UNAVAILABLE, {
                    "error": str(exc),
                    "source": os.getenv("PARQUET_PATH", ""),
                })
        finally:
            DATA_REQUEST_SLOTS.release()


def main() -> None:
    if not API_TOKEN:
        raise SystemExit("Set CLARA_API_TOKEN or API_TOKEN in .env before starting the API.")

    server = ThreadingHTTPServer((HOST, PORT), ClaraApiHandler)
    print(f"CLARA API listening on http://{HOST}:{PORT}")
    print("Endpoints: GET /, GET /health, GET /api/columns, GET /api/data?limit=100&offset=0")
    server.serve_forever()


if __name__ == "__main__":
    main()
