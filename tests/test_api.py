"""Offline tests for the direct WMS JSON paging mode."""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault("WMS_EMP_NO", "00000000")

from wms_fetch import api, exports  # noqa: E402
from wms_fetch.exports import _base  # noqa: E402


class Response:
    def __init__(self, payload, status=200):
        self.status_code = status
        self.headers = {"content-type": "text/plain; charset=utf-8"}
        self.content = json.dumps(payload).encode("utf-8")
        self.text = self.content.decode("utf-8")

    def json(self):
        return json.loads(self.text)


class ApiSession:
    def __init__(self, payloads):
        self.payloads = list(payloads)
        self.calls = []

    def post(self, url, params=None, data=None, headers=None, timeout=None):
        self.calls.append({"url": url, "params": params, "data": data})
        return Response(self.payloads.pop(0))


def page(total, rows):
    return {"Succeed": True, "ErrMsg": "", "Data": {"total": total, "rows": rows}}


class TestApiHelpers(unittest.TestCase):
    def test_delivery_suffix_is_normalized(self):
        self.assertEqual(_base.wms_project_no("P202211283695_D002"), "P202211283695")
        self.assertEqual(_base.wms_project_no("20130426020000_D006"), "20130426020000")
        self.assertEqual(_base.wms_project_no("P202002297117"), "P202002297117")

    def test_inventory_and_lock_use_base_code(self):
        self.assertEqual(
            api.query_project_no(exports.build("inventory", "P202211283695_D002")),
            "P202211283695",
        )
        self.assertEqual(
            api.query_project_no(exports.build("lock", "P202211283695_D002")),
            "P202211283695",
        )

    def test_paging_params_match_query_button_shape(self):
        inventory = api.paging_params(
            exports.build("inventory", "P202211283695_D002"), 2, 3000
        )
        self.assertEqual(inventory["CommandName"], "Paging")
        self.assertEqual(inventory["PageNum"], "2")
        self.assertEqual(inventory["PageSize"], "3000")
        self.assertEqual(inventory["GridID"], "dgInventoryDetail")
        self.assertEqual(inventory["CardNo"], "00000000")
        self.assertEqual(inventory["EmployeeNo"], "null")
        self.assertEqual(inventory["LanguageID"], "1033")

        lock = api.paging_params(
            exports.build("lock", "P202211283695_D002"), 1, 3000
        )
        self.assertEqual(lock["GridID"], "DataGrid")
        self.assertEqual(lock["URL"], "/SCM/WMS/WMS_CN809/InventoryLock/InventoryLockQuery.aspx")
        self.assertEqual(lock["Code"], "MY")
        self.assertNotIn("CardNo", lock)
        self.assertEqual(lock["EmployeeNo"], "null")


class TestApiPaging(unittest.TestCase):
    def test_fetch_dataset_paginates(self):
        session = ApiSession([
            page(5, [{"id": 1}, {"id": 2}, {"id": 3}]),
            page(5, [{"id": 4}, {"id": 5}]),
        ])
        dataset = api.fetch_dataset(
            session,
            exports.build("inventory", "P202211283695_D002"),
            page_size=3,
            log=lambda *_: None,
        )
        self.assertEqual(dataset.total, 5)
        self.assertEqual(dataset.pages, 2)
        self.assertEqual([r["id"] for r in dataset.rows], [1, 2, 3, 4, 5])
        self.assertEqual([c["params"]["PageNum"] for c in session.calls], ["1", "2"])
        self.assertTrue(session.calls[0]["data"].startswith("%7B"))

    def test_run_api_batch_caches_same_base_code(self):
        session = ApiSession([page(1, [{"id": 1}])])
        with tempfile.TemporaryDirectory() as directory:
            results = api.run_api_batch(
                session,
                ["P202211283695_D001", "P202211283695_D002"],
                ["inventory"],
                Path(directory),
                page_size=3000,
                run_ts="20260911_170000",
                log=lambda *_: None,
            )
            self.assertEqual(len(session.calls), 1)
            self.assertEqual([r.status for r in results], ["ok", "ok"])
            files = sorted(Path(directory).glob("*.json"))
            self.assertEqual(len(files), 2)
            second = json.loads(files[1].read_text(encoding="utf-8"))
            self.assertTrue(second["cache_hit"])
            self.assertEqual(second["query_project"], "P202211283695")


if __name__ == "__main__":
    unittest.main(verbosity=2)
