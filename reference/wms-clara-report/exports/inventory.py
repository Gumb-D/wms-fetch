"""Regular inventory warehouses (WHtype = 10,40,60)."""

from pathlib import Path

from ._base import ExportConfig

# Default body for the InventoryQuery page. The user can override any of these
# fields by editing filters.json next to this project root.
_INVENTORY_BODY = {
    "ckbProductType": "1",
    "ckbWarehouseType": "10,40,60",
    "dddeliverCountry": "MY",
    "ddckWarehouseName": "",
    "cbStock": "",
    "cbBin": "",
    "taPreSalesProjNo": "P202002297117",
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
    "ckbFocusField": "1000,1100,1200,1210,1220,1230,1240,1250,1300,1310,1400,1500,1600,1700,1900,2000,2200,2300,2400,2500,2510,2520,2530,2540,2550,2600",
    "ckbMaterialType": "1,2",
    "IsolatedReason": "",
    "IsolatedRemark": "",
    "taDeviceDescriptionMulti": "",
    "taPreSalesProjNoMulti": "P202002297117",
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

CONFIG = ExportConfig(
    name="inventory",
    endpoint_path="/scm/WMS/WMS_CN809/InventoryManagement/JsonService/InventoryQueryJsonService.ashx",
    referer_path="/SCM/WMS/WMS_CN809/InventoryManagement/InventoryQuery.aspx",
    command_control="btnExportDetail",
    extra_query={
        "CardNo": "80045983",
        "CountryCode": "MY",
        "WHtype": "10,40,60",
    },
    body=_INVENTORY_BODY,
    filters_file=Path(__file__).resolve().parent.parent / "filters.json",
)
