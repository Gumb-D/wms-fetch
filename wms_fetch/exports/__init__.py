"""Export registry. Add a module with build_config() and one line here."""

from __future__ import annotations

from . import inventory, lock, transfer
from ._base import ExportConfig, run_export

BUILDERS = {
    "inventory": inventory.build_config,
    "transfer": transfer.build_config,
    "lock": lock.build_config,
}


def build(name: str, project_no: str, country_code: str | None = None) -> ExportConfig:
    try:
        builder = BUILDERS[name]
    except KeyError:
        raise ValueError(
            f"unknown export {name!r}; valid: {sorted(BUILDERS)}"
        ) from None
    return builder(project_no, country_code)


__all__ = ["BUILDERS", "ExportConfig", "build", "run_export"]