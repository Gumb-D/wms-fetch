# wms-fetch

Pulls ZTE SCM WMS exports (inventory / transfer / lock) per project number and
writes them with a manifest. Built for the CelcomDigi extraction; other
customers are just another file in `projects/`.

Phase 1 scope is the extraction core only. No wagent, Darcy, Bailey, ePMS or
Parquet integration - Bailey will later shell out to the CLI below and never
touch WMS internals.

## How it works

Each export is the same two-step WMS flow:

1. `POST <endpoint>?isbackground=true` with a URL-encoded JSON filter body.
   The server builds an Excel and returns `{"Succeed":true,"Data":"<GUID>"}`.
2. `GET <endpoint>?isbackground=true&ExcelID=<GUID>` streams the file.

Step 2 is racy: the GUID comes back before the file is flushed, so the GET
polls every 4s (240s cap) while the server answers `{"Succeed":true,"Data":null}`.

Projects run one at a time. WMS multi-value syntax for the project fields is
unverified, so batching several projects into one request risks silently mixing
or dropping data.

## Setup

```
pip install -r requirements.txt
copy .env.example .env        # then fill in WMS_EMP_NO
```

Log into WMS in a browser, copy the `Cookie` request header, and save it as a
single line in `cookies.txt` (gitignored).

## Usage

```
python -m wms_fetch.cli                      # all projects, all exports
python -m wms_fetch.cli --list               # show what would run
python -m wms_fetch.cli --dry-run            # print requests, no network
python -m wms_fetch.cli --project P..._D002  # one project
python -m wms_fetch.cli --exports lock       # one export type
```

Exit codes: `0` all succeeded, `1` partial (good files still written),
`2` could not start (bad config or invalid cookies).

## Output

```
output/
  P202211283695_D002_inventory_20260911_150000.xls
  P202211283695_D002_transfer_20260911_150000.xls
  P202211283695_D002_lock_20260911_150000.xls
  ...
  manifest_20260911_150000.json
```

Filenames embed project + export + run timestamp. WMS returns the same
filename for every project, so without this each project would overwrite the
previous one.

`manifest.json` records every project x export with status, size, duration and
error, so a caller can distinguish partial from total failure without parsing
logs.

## Project config

`projects/celcomdigi.json`:

```json
{
  "customer": "CelcomDigi",
  "country_code": "MY",
  "exports": ["inventory", "transfer", "lock"],
  "projects": ["P202211283695_D002", "..."]
}
```

## Filter field mapping

| Export    | Endpoint page       | WHtype   | Project number field |
|-----------|---------------------|----------|----------------------|
| inventory | InventoryQuery      | 10,40,60 | `taPreSalesProjNo` + `taPreSalesProjNoMulti` |
| transfer  | InventoryQuery      | 50       | `taPreSalesProjNo` + `taPreSalesProjNoMulti` |
| lock      | InventoryLockQuery  | n/a      | `ItemNum` |

Lock also uses `Code=` rather than `CountryCode=`, adds a `URL=` param, sends
no `CardNo`, and triggers `btnExport` instead of `btnExportDetail`.

> **Unverified:** the reference project filtered on `taPreSalesProjNo` using a
> bare `P############` value. The CelcomDigi numbers carry `_D00n` suffixes and
> one (`20130426020000_D006`) has no `P` prefix, so they may belong in
> `taProjectNo` / `taProjectNoMulti` instead. A wrong field yields an empty
> export rather than an error. Confirm against one project before trusting a
> full run; switching is a one-line change to `project_fields`.

## Tests

```
python -m unittest discover -s tests -v
```

Fully offline with a scripted fake session. Covers field mapping per export,
filename uniqueness, poll-until-ready, HTML-login-page detection, and batch
isolation when one export fails.

## Notes

- `reference/` is the original inspection bundle. It is gitignored: it contains
  live session cookies and a hardcoded employee number.
- Cookie auto-refresh (Playwright) from the reference is not ported; it needed a
  ShadowBot/Chrome profile that is not present here. Invalid cookies fail with
  instructions instead.