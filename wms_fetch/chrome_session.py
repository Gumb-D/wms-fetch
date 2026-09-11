"""requests-like transport that runs WMS HTTP calls inside logged-in Chrome.

The WMS backend redirects every API request through a signed URL and ties the
session to browser state. Copying the Cookie header into ``requests`` is not
sufficient for the current portal: Chrome succeeds while the same cookies from
Python receive "login expired". This adapter keeps the extraction pipeline in
Python but executes fetch() in an authenticated, same-origin WMS page via CDP.

A fetch job is started without awaiting it (CDP eval has a 20 second cap), then
polled. Response bytes remain in the page and are copied back in bounded base64
chunks, so large Excel files do not overflow one CDP result.
"""

from __future__ import annotations

import base64
import json
import os
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator
from urllib.parse import urlencode
from uuid import uuid4

DEFAULT_CDP_SCRIPT = Path(r"C:\dev\aida-chrome\cdp\cdp.mjs")
DEFAULT_TARGET = "scm.zte.com.cn/SCM/WMS/WMS_CN809/InventoryManagement/InventoryQuery.aspx"
_FORBIDDEN_FETCH_HEADERS = {
    "accept-encoding", "connection", "content-length", "cookie", "host",
    "origin", "referer", "sec-fetch-dest", "sec-fetch-mode",
    "sec-fetch-site", "upgrade-insecure-requests", "user-agent",
}


@dataclass
class ChromeResponse:
    status_code: int
    headers: dict[str, str]
    content: bytes
    url: str

    @property
    def text(self) -> str:
        encoding = "utf-8"
        ctype = self.headers.get("content-type", "")
        if "charset=" in ctype:
            encoding = ctype.rsplit("charset=", 1)[1].split(";", 1)[0].strip()
        return self.content.decode(encoding, "replace")

    def json(self) -> Any:
        return json.loads(self.text)

    def iter_content(self, chunk_size: int = 64 * 1024) -> Iterator[bytes]:
        for start in range(0, len(self.content), chunk_size):
            yield self.content[start:start + chunk_size]


class ChromeSession:
    """Small subset of requests.Session consumed by exports/_base.py."""

    def __init__(
        self,
        *,
        port: int | None = None,
        target: str | None = None,
        cdp_script: str | Path | None = None,
        node: str | None = None,
        poll_interval: float = 1.0,
        transfer_chunk: int = 384 * 1024,
    ) -> None:
        self.port = int(port or os.environ.get("WMS_CDP_PORT", "19222"))
        self.target = target or os.environ.get("WMS_CDP_TARGET", DEFAULT_TARGET)
        self.cdp_script = Path(
            cdp_script or os.environ.get("WMS_CDP_SCRIPT", str(DEFAULT_CDP_SCRIPT))
        )
        self.node = node or os.environ.get("WMS_NODE", "node")
        self.poll_interval = poll_interval
        self.transfer_chunk = transfer_chunk
        if not self.cdp_script.exists():
            raise FileNotFoundError(
                f"CDP client not found: {self.cdp_script}. Set WMS_CDP_SCRIPT."
            )

    def _eval(self, expression: str) -> Any:
        command = [
            self.node, str(self.cdp_script), "eval", self.target, expression,
            "--port", str(self.port),
        ]
        try:
            result = subprocess.run(
                command, capture_output=True, text=True, encoding="utf-8",
                errors="replace", timeout=35,
            )
        except FileNotFoundError as exc:
            raise RuntimeError(f"Node.js executable not found: {self.node}") from exc
        except subprocess.TimeoutExpired as exc:
            raise RuntimeError("CDP evaluation command timed out") from exc
        if result.returncode != 0:
            detail = (result.stderr or result.stdout).strip()
            raise RuntimeError(f"CDP evaluation failed: {detail[:800]}")
        try:
            return json.loads(result.stdout)
        except json.JSONDecodeError as exc:
            raise RuntimeError(
                f"CDP returned invalid JSON: {result.stdout[:500]!r}"
            ) from exc

    @staticmethod
    def _url_with_params(url: str, params: dict[str, Any] | None) -> str:
        if not params:
            return url
        separator = "&" if "?" in url else "?"
        return url + separator + urlencode(params)

    @staticmethod
    def _timeout_seconds(timeout: Any) -> float:
        if isinstance(timeout, (tuple, list)):
            return float(timeout[-1])
        if timeout is None:
            return 900.0
        return float(timeout)

    def request(
        self,
        method: str,
        url: str,
        *,
        params: dict[str, Any] | None = None,
        data: str | bytes | None = None,
        headers: dict[str, str] | None = None,
        timeout: Any = None,
        stream: bool = False,
        **_ignored: Any,
    ) -> ChromeResponse:
        del stream  # response is buffered in Chrome, then transferred in chunks
        job_id = "wms_" + uuid4().hex
        request_url = self._url_with_params(url, params)
        allowed_headers = {
            str(k): str(v) for k, v in (headers or {}).items()
            if str(k).lower() not in _FORBIDDEN_FETCH_HEADERS
        }
        if isinstance(data, bytes):
            data = data.decode("utf-8")
        spec = {
            "id": job_id,
            "method": method.upper(),
            "url": request_url,
            "headers": allowed_headers,
            "body": data if method.upper() not in ("GET", "HEAD") else None,
        }
        spec_js = json.dumps(spec, ensure_ascii=True)
        started = self._eval(
            "(()=>{"
            f"const q={spec_js};"
            "window.__wmsFetchJobs=window.__wmsFetchJobs||{};"
            "const j=window.__wmsFetchJobs[q.id]={state:'pending',started:Date.now()};"
            "const o={method:q.method,headers:q.headers,credentials:'include',redirect:'follow'};"
            "if(q.body!==null)o.body=q.body;"
            "fetch(q.url,o).then(async r=>{"
            "j.status=r.status;j.url=r.url;"
            "j.headers=Object.fromEntries(r.headers.entries());"
            "j.body=await r.arrayBuffer();j.state='done';"
            "}).catch(e=>{j.state='error';j.error=String(e)});"
            "return {started:q.id};"
            "})()"
        )
        if started.get("started") != job_id:
            raise RuntimeError(f"Chrome fetch did not start: {started!r}")

        deadline = time.monotonic() + self._timeout_seconds(timeout)
        meta: dict[str, Any]
        while True:
            meta = self._eval(
                "(()=>{"
                f"const j=(window.__wmsFetchJobs||{{}})[{json.dumps(job_id)}];"
                "if(!j)return {state:'missing'};"
                "return {state:j.state,status:j.status,url:j.url,headers:j.headers,"
                "size:j.body?j.body.byteLength:0,error:j.error};"
                "})()"
            )
            if meta.get("state") == "done":
                break
            if meta.get("state") in ("error", "missing"):
                self._cleanup(job_id)
                raise RuntimeError(f"Chrome fetch failed: {meta.get('error') or meta['state']}")
            if time.monotonic() >= deadline:
                self._cleanup(job_id)
                raise TimeoutError(f"Chrome fetch timed out after {self._timeout_seconds(timeout):.0f}s")
            time.sleep(self.poll_interval)

        size = int(meta.get("size", 0))
        output = bytearray()
        try:
            for start in range(0, size, self.transfer_chunk):
                count = min(self.transfer_chunk, size - start)
                encoded = self._eval(
                    "(()=>{"
                    f"const j=window.__wmsFetchJobs[{json.dumps(job_id)}];"
                    f"const a=new Uint8Array(j.body,{start},{count});let s='';"
                    "for(let i=0;i<a.length;i+=32768)"
                    "s+=String.fromCharCode(...a.subarray(i,Math.min(i+32768,a.length)));"
                    "return btoa(s);"
                    "})()"
                )
                output.extend(base64.b64decode(encoded))
        finally:
            self._cleanup(job_id)

        return ChromeResponse(
            status_code=int(meta["status"]),
            headers={str(k).lower(): str(v) for k, v in (meta.get("headers") or {}).items()},
            content=bytes(output),
            url=str(meta.get("url") or request_url),
        )

    def _cleanup(self, job_id: str) -> None:
        try:
            self._eval(
                f"(()=>{{delete (window.__wmsFetchJobs||{{}})[{json.dumps(job_id)}];"
                "return 'cleaned';})()"
            )
        except Exception:
            pass

    def get(self, url: str, **kwargs: Any) -> ChromeResponse:
        return self.request("GET", url, **kwargs)

    def post(self, url: str, **kwargs: Any) -> ChromeResponse:
        return self.request("POST", url, **kwargs)
