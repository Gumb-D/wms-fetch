"""Transfer / in-transit warehouse (WHtype = 50).

Same endpoint and body schema as inventory; only the warehouse-type filter
differs, so the inventory body is reused to keep the two in sync.
"""

from __future__ import annotations

from .. import config
from ._base import ExportConfig
from .inventory import BASE_BODY, ENDPOINT, REFERER

WHTYPE = "50"


def build_config(project_no: str, country_code: str | None = None) -> ExportConfig:
    country = country_code or config.COUNTRY_CODE
    body = dict(BASE_BODY)
    body["dddeliverCountry"] = country
    body["ckbWarehouseType"] = WHTYPE
    return ExportConfig(
        name="transfer",
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