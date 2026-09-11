"""Inventory lock export.

Different ASP.NET page, different JSON service and a completely different
filter schema from inventory/transfer. Notably the project number lives in
ItemNum here, and the query string uses Code= (not CountryCode=) plus a URL=
parameter, and there is no CardNo.
"""

from __future__ import annotations

from .. import config
from ._base import ExportConfig, wms_project_no

ENDPOINT = "/scm/WMS/WMS_CN809/InventoryLock/JsonService/InventoryLockQueryJsonService.ashx"
REFERER = "/SCM/WMS/WMS_CN809/InventoryLock/InventoryLockQuery.aspx"

BASE_BODY = {
    "ItemType": "2",
    "Warehouse": "",
    "ckDeliverCountry": "MY",
    "ItemNo": "",
    "PalletNumber": "",
    "BoxNumber": "",
    "ItemNum": "",
    "Barcode": "",
}


def build_config(project_no: str, country_code: str | None = None) -> ExportConfig:
    country = country_code or config.COUNTRY_CODE
    body = dict(BASE_BODY)
    body["ckDeliverCountry"] = country
    return ExportConfig(
        name="lock",
        project_no=project_no,
        endpoint_path=ENDPOINT,
        referer_path=REFERER,
        command_control="btnExport",
        extra_query={
            "URL": REFERER,
            "Code": country,
        },
        body=body,
        project_fields={"ItemNum": wms_project_no(project_no)},
    )