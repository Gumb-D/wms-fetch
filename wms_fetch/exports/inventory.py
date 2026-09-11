"""Regular inventory warehouses (WHtype = 10,40,60)."""

from __future__ import annotations

from .. import config
from ._base import ExportConfig

ENDPOINT = "/scm/WMS/WMS_CN809/InventoryManagement/JsonService/InventoryQueryJsonService.ashx"
REFERER = "/SCM/WMS/WMS_CN809/InventoryManagement/InventoryQuery.aspx"

# Focus-field list copied verbatim from a captured browser request; it selects
# which columns the server puts in the Excel.
FOCUS_FIELDS = (
    "1000,1100,1200,1210,1220,1230,1240,1250,1300,1310,1400,1500,1600,1700,"
    "1900,2000,2200,2300,2400,2500,2510,2520,2530,2540,2550,2600"
)

BASE_BODY = {
    "ckbProductType": "1",
    "ckbWarehouseType": "10,40,60",
    "dddeliverCountry": "MY",
    "ddckWarehouseName": "",
    "cbStock": "",
    "cbBin": "",
    "taPreSalesProjNo": "",
    "taProjectName": "",
    "taCostomerName": "",
    "taInContractNo": "",
    "taContractDeli": "",
    "taTaskNo": "",
    "taBoxNo": "",
    "taMaterialCode": "",
    "taSN": "",
    "taProjectNo": "",
    "taPONumber": "",
    "taDeviceDescription": "",
    "taProductBigClass": "",
    "taProductSmallClass": "",
    "taPalletNo": "",
    "taDeliveryBatch": "",
    "taMaterialName": "",
    "ckbFocusField": FOCUS_FIELDS,
    "ckbMaterialType": "1,2",
    "IsolatedReason": "",
    "IsolatedRemark": "",
    "taDeviceDescriptionMulti": "",
    "taPreSalesProjNoMulti": "",
    "taInContractNoMulti": "",
    "taTaskNoMulti": "",
    "taBoxNoMulti": "",
    "taMaterialCodeMulti": "",
    "taSNMulti": "",
    "taProjectNoMulti": "",
    "taPONumberMulti": "",
    "taProductBigClassMulti": "",
    "taProductSmallClassMulti": "",
    "taPalletNoMulti": "",
    "taDeliveryBatchMulti": "",
}

WHTYPE = "10,40,60"


def build_config(project_no: str, country_code: str | None = None) -> ExportConfig:
    country = country_code or config.COUNTRY_CODE
    body = dict(BASE_BODY)
    body["dddeliverCountry"] = country
    return ExportConfig(
        name="inventory",
        project_no=project_no,
        endpoint_path=ENDPOINT,
        referer_path=REFERER,
        command_control="btnExportDetail",
        extra_query={
            "CardNo": config.require_emp_no(),
            "CountryCode": country,
            "WHtype": WHTYPE,
        },
        body=body,
        project_fields={
            "taPreSalesProjNo": project_no,
            "taPreSalesProjNoMulti": project_no,
        },
    )