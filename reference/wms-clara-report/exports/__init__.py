"""Registry of available exports. Add a new module + one line here to extend."""

from ._base import ExportConfig, run_export, step1_generate, step2_download
from .inventory import CONFIG as inventory
from .transfer import CONFIG as transfer
from .lock import CONFIG as lock

# Order = default pipeline order when no names are passed on the CLI.
EXPORTS: dict[str, ExportConfig] = {
    inventory.name: inventory,
    transfer.name:  transfer,
    lock.name:      lock,
}

__all__ = ["EXPORTS", "ExportConfig", "run_export", "step1_generate", "step2_download"]
