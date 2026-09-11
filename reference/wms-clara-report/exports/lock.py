"""Inventory lock export.

Lives at a different ASP.NET page and JSON service from inventory/transfer,
and uses a totally different filter body. Same isbackground=true two-step
download flow, just different URL & body schema.
"""

from pathlib import Path

from ._base import ExportConfig

_LOCK_BODY = {
    "ItemType": "2",
    "Warehouse": "",
    "ckDeliverCountry": "MY",
    "ItemNo": "",
    "PalletNumber": "",
    "BoxNumber": "",
    "ItemNum": "P202002297117",   # project number lives here in this schema
    "Barcode": "",
}

CONFIG = ExportConfig(
    name="lock",
    endpoint_path="/scm/WMS/WMS_CN809/InventoryLock/JsonService/InventoryLockQueryJsonService.ashx",
    referer_path="/SCM/WMS/WMS_CN809/InventoryLock/InventoryLockQuery.aspx",
    command_control="btnExport",
    extra_query={
        # No CardNo on this endpoint. Uses Code= (not CountryCode=) and a URL= param.
        "URL": "/SCM/WMS/WMS_CN809/InventoryLock/InventoryLockQuery.aspx",
        "Code": "MY",
    },
    body=_LOCK_BODY,
    filters_file=Path(__file__).resolve().parent.parent / "filters_lock.json",
)
