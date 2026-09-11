"""
Loader for the customer project list.

The reference hardcoded a single project number in three separate places
(inventory body, transfer body, lock body) which meant adding a project
required editing Python. Project numbers now live in projects/*.json.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

VALID_EXPORTS = ("inventory", "transfer", "lock")


@dataclass
class ProjectSet:
    customer: str
    country_code: str
    exports: list[str]
    projects: list[str] = field(default_factory=list)


def load_project_set(path: str | Path) -> ProjectSet:
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(f"project file not found: {p}")

    raw = json.loads(p.read_text(encoding="utf-8"))

    projects: list[str] = []
    for entry in raw.get("projects", []):
        # Accept both "Pxxxx" and {"no": "Pxxxx", ...} so the file can grow
        # per-project metadata later without breaking this loader.
        no = entry if isinstance(entry, str) else entry.get("no", "")
        no = no.strip()
        if no:
            projects.append(no)

    if not projects:
        raise ValueError(f"no project numbers listed in {p}")

    dupes = {n for n in projects if projects.count(n) > 1}
    if dupes:
        raise ValueError(f"duplicate project numbers in {p}: {sorted(dupes)}")

    exports = [e.strip().lower() for e in raw.get("exports", VALID_EXPORTS)]
    bad = [e for e in exports if e not in VALID_EXPORTS]
    if bad:
        raise ValueError(f"unknown export type(s) {bad}; valid: {list(VALID_EXPORTS)}")

    return ProjectSet(
        customer=raw.get("customer", p.stem),
        country_code=raw.get("country_code", "MY"),
        exports=exports,
        projects=projects,
    )