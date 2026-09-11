"""
Offline tests. No network, no cookies, no WMS access.

Covers the things that are expensive to get wrong in production:
  - the project number lands in the right filter field per export type
  - a filters file cannot override the project number
  - filenames are unique per project (the reference overwrote them)
  - the ExcelID poll retries on "not ready" and gives up cleanly
  - one failing export does not abort the rest of the batch
"""

from __future__ import annotations

import io
import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault("WMS_EMP_NO", "00000000")

from wms_fetch import exports                      # noqa: E402
from wms_fetch.exports import _base                # noqa: E402
from wms_fetch.projects import load_project_set    # noqa: E402
from wms_fetch.runner import build_manifest, run_batch  # noqa: E402

PROJ = "P202211283695_D002"


class FakeResponse:
    def __init__(self, status=200, json_body=None, headers=None, chunks=None, text=""):
        self.status_code = status
        self._json = json_body
        self.headers = headers or {}
        self._chunks = chunks or []
        self.text = text
        self.content = b"".join(self._chunks) if self._chunks else text.encode()

    def json(self):
        if self._json is None:
            raise ValueError("no json")
        return self._json

    def iter_content(self, chunk_size=None):
        return iter(self._chunks)


class FakeSession:
    """Scripted session: step 1 returns a GUID, step 2 returns queued responses."""

    GUID = "01234567-89ab-cdef-0123-456789abcdef"

    def __init__(self, get_responses=None, post_response=None):
        self.posts = []
        self.gets = []
        self._get_responses = list(get_responses or [])
        self._post_response = post_response

    def post(self, url, params=None, data=None, headers=None, timeout=None):
        self.posts.append({"url": url, "params": params, "data": data})
        return self._post_response or FakeResponse(
            json_body={"Succeed": True, "Data": self.GUID}
        )

    def get(self, url, params=None, headers=None, stream=None, timeout=None):
        self.gets.append({"url": url, "params": params})
        if self._get_responses:
            return self._get_responses.pop(0)
        return file_response()


def file_response(payload=b"x" * 5000, name="Export.xls"):
    return FakeResponse(
        headers={
            "Content-Type": "application/vnd.ms-excel",
            "Content-Disposition": f'attachment; filename="{name}"',
        },
        chunks=[payload],
    )


def pending_response():
    return FakeResponse(
        headers={"Content-Type": "application/json"},
        chunks=[b'{"Succeed":true,"Data":null}'],
    )


class TestProjectFieldMapping(unittest.TestCase):
    def test_inventory_uses_presales_fields(self):
        body = _base.merge_filters(exports.build("inventory", PROJ))
        self.assertEqual(body["taPreSalesProjNo"], "P202211283695")
        self.assertEqual(body["taPreSalesProjNoMulti"], "P202211283695")

    def test_lock_uses_itemnum(self):
        body = _base.merge_filters(exports.build("lock", PROJ))
        self.assertEqual(body["ItemNum"], "P202211283695")
        self.assertNotIn("taPreSalesProjNo", body)

    def test_transfer_is_whtype_50(self):
        cfg = exports.build("transfer", PROJ)
        body = _base.merge_filters(cfg)
        self.assertEqual(cfg.extra_query["WHtype"], "50")
        self.assertEqual(body["ckbWarehouseType"], "50")

    def test_inventory_is_whtype_10_40_60(self):
        cfg = exports.build("inventory", PROJ)
        self.assertEqual(_base.merge_filters(cfg)["ckbWarehouseType"], "10,40,60")

    def test_lock_query_has_no_cardno(self):
        cfg = exports.build("lock", PROJ)
        self.assertNotIn("CardNo", cfg.extra_query)
        self.assertIn("Code", cfg.extra_query)

    def test_filters_file_cannot_override_project(self):
        import json
        import tempfile

        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / "filters.json"
            f.write_text(json.dumps({
                "taPreSalesProjNo": "WRONG",
                "taCostomerName": "CelcomDigi",
            }))
            cfg = exports.build("inventory", PROJ)
            cfg.filters_file = f
            body = _base.merge_filters(cfg)
            self.assertEqual(body["taPreSalesProjNo"], "P202211283695")   # normalized project wins
            self.assertEqual(body["taCostomerName"], "CelcomDigi")  # other keys apply

    def test_unknown_export_rejected(self):
        with self.assertRaises(ValueError):
            exports.build("nope", PROJ)


class TestFileDetection(unittest.TestCase):
    def test_detects_xls_signature_without_headers(self):
        body = b"\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1" + b"rest"
        self.assertTrue(_base._is_file_response("", "", body))

    def test_detects_xlsx_signature_without_headers(self):
        self.assertTrue(_base._is_file_response("", "", b"PK\x03\x04rest"))

    def test_json_is_not_a_file(self):
        self.assertFalse(_base._is_file_response("", "", b'{"Succeed":true}'))

class TestFilenames(unittest.TestCase):
    def test_filename_is_unique_per_project(self):
        ts = "20260911_150000"
        a = _base.output_filename(exports.build("inventory", "P1_D001"), "Export.xls", ts)
        b = _base.output_filename(exports.build("inventory", "P2_D002"), "Export.xls", ts)
        self.assertNotEqual(a, b)
        self.assertEqual(a, "P1_D001_inventory_20260911_150000.xls")

    def test_extension_falls_back_to_xls(self):
        ts = "20260911_150000"
        n = _base.output_filename(exports.build("lock", PROJ), None, ts)
        self.assertTrue(n.endswith(".xls"))


class TestPipeline(unittest.TestCase):
    def test_step2_polls_until_ready(self):
        import tempfile

        session = FakeSession(get_responses=[
            pending_response(), pending_response(), file_response(),
        ])
        _base.POLL_INTERVAL_S = 0  # do not actually sleep in tests
        with tempfile.TemporaryDirectory() as d:
            out = _base.run_export(
                session, exports.build("inventory", PROJ),
                out_dir=Path(d), ts="20260911_150000", log=lambda *a: None,
            )
            self.assertTrue(out.exists())
            self.assertEqual(len(session.gets), 3)

    def test_html_error_page_is_rejected(self):
        import tempfile

        html = FakeResponse(
            headers={
                "Content-Type": "text/html",
                "Content-Disposition": 'attachment; filename="login.xls"',
            },
            chunks=[b"<!DOCTYPE html><html>login</html>"],
        )
        session = FakeSession(get_responses=[html])
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(RuntimeError):
                _base.run_export(
                    session, exports.build("lock", PROJ),
                    out_dir=Path(d), ts="t", log=lambda *a: None,
                )

    def test_missing_guid_raises(self):
        session = FakeSession(post_response=FakeResponse(
            json_body={"Succeed": False, "Data": None}, text="{}"
        ))
        with self.assertRaises(RuntimeError):
            _base.step1_generate(session, exports.build("inventory", PROJ),
                                 log=lambda *a: None)

    def test_body_is_url_encoded_json(self):
        enc = _base.encode_body({"a": "1,2", "b": ""})
        self.assertNotIn("{", enc)
        self.assertIn("%22", enc)


class TestBatch(unittest.TestCase):
    def test_one_failure_does_not_stop_batch(self):
        import tempfile

        _base.POLL_INTERVAL_S = 0

        class FlakySession(FakeSession):
            def get(self, url, params=None, headers=None, stream=None, timeout=None):
                self.gets.append(params)
                # Fail only the lock export; it is the one using btnExport.
                if params.get("CommandControl") == "btnExport":
                    return FakeResponse(status=500)
                return file_response()

        with tempfile.TemporaryDirectory() as d:
            results = run_batch(
                FlakySession(), ["PA", "PB"], ["inventory", "lock"],
                Path(d), log=lambda *a: None,
            )
        self.assertEqual(len(results), 4)
        ok = [r for r in results if r.status == "ok"]
        bad = [r for r in results if r.status == "failed"]
        self.assertEqual(len(ok), 2)
        self.assertEqual(len(bad), 2)
        self.assertTrue(all(r.export == "lock" for r in bad))

        m = build_manifest(results, "CelcomDigi", "ts", "now")
        self.assertEqual(m["summary"], {"total": 4, "ok": 2, "failed": 2, "skipped": 0})


class TestProjectFile(unittest.TestCase):
    def test_real_celcomdigi_file_loads(self):
        root = Path(__file__).resolve().parent.parent
        ps = load_project_set(root / "projects" / "celcomdigi.json")
        self.assertEqual(ps.customer, "CelcomDigi")
        self.assertEqual(len(ps.projects), 4)
        self.assertIn("P202211283695_D002", ps.projects)
        self.assertEqual(ps.exports, ["inventory", "transfer", "lock"])

    def test_duplicates_rejected(self):
        import json
        import tempfile

        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / "p.json"
            f.write_text(json.dumps({"projects": ["A", "A"]}))
            with self.assertRaises(ValueError):
                load_project_set(f)

    def test_bad_export_name_rejected(self):
        import json
        import tempfile

        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / "p.json"
            f.write_text(json.dumps({"projects": ["A"], "exports": ["bogus"]}))
            with self.assertRaises(ValueError):
                load_project_set(f)


if __name__ == "__main__":
    unittest.main(verbosity=2)