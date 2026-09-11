"""Transfer / in-transit warehouse (WHtype = 50).

Same endpoint and body schema as inventory; only the warehouse-type filter
changes. We import the inventory body and override the two WHtype-related
fields so the two configs stay in sync if filters.json is edited.
"""

from pathlib import Path

from ._base import ExportConfig
from .inventory import _INVENTORY_BODY

_TRANSFER_BODY = dict(_INVENTORY_BODY)
_TRANSFER_BODY["ckbWarehouseType"] = "50"

CONFIG = ExportConfig(
    name="transfer",
    endpoint_path="/scm/WMS/WMS_CN809/InventoryManagement/JsonService/InventoryQueryJsonService.ashx",
    referer_path="/SCM/WMS/WMS_CN809/InventoryManagement/InventoryQuery.aspx",
    command_control="btnExportDetail",
    extra_query={
        "CardNo": "80045983",
        "CountryCode": "MY",
        "WHtype": "50",
    },
    body=_TRANSFER_BODY,
    filters_file=Path(__file__).resolve().parent.parent / "filters.json",
)
