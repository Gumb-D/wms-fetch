# wms-fetch

Pulls ZTE SCM WMS exports (inventory / transfer / lock) per project number and
writes them with a manifest. Built for the CelcomDigi extraction; other
customers are just another file in `projects/`.

The repository now also contains the Node.js WhatsApp inventory MVP. Python is
retained temporarily as the verified extraction reference while JavaScript
fixture-parity coverage is completed. The runtime uses Express, Baileys and
node-cron as separate processes; WhatsApp never touches WMS credentials.

## WhatsApp inventory MVP

```bash
npm install
npm test
npm run refresh
npm run start:api
npm run start:whatsapp
npm run start:scheduler
npm run status
```

See `docs/deployment-windows.md` for Windows setup and recovery. Runtime data
belongs outside the repository and failed refreshes retain the last good
verified snapshot.

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

### Chrome transport

The current WMS portal binds API access to browser state; exporting its Cookie
header alone can still return `login expired`. The recommended live mode runs
`fetch()` through an authenticated same-origin Inventory Query tab over CDP:

```
python -m wms_fetch.cli --transport chrome --cdp-port 19222
```

Open WMS from the SCM portal first, then open Inventory Query in its own tab.
The default target fragment is that page. Override it with `--cdp-target` when
needed. Chrome must have remote debugging enabled and the repository CDP client
must exist at `C:\dev\aida-chrome\cdp\cdp.mjs` (or set `WMS_CDP_SCRIPT`).

## Usage

```
python -m wms_fetch.cli --transport chrome   # legacy XLS export via logged-in Chrome
python -m wms_fetch.cli --transport chrome --mode api  # direct JSON API (recommended)
python -m wms_fetch.cli                      # copied-cookie requests transport
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
  P202211283695_D002_inventory_20260911_150000.xls   # --mode excel
  P202211283695_D002_inventory_20260911_150000.json  # --mode api
  P202211283695_D002_transfer_20260911_150000.json
  P202211283695_D002_lock_20260911_150000.json
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

| Export    | Endpoint page      | WHtype   | Project number field                                      |
| --------- | ------------------ | -------- | --------------------------------------------------------- |
| inventory | InventoryQuery     | 10,40,60 | base code in `taPreSalesProjNo` + `taPreSalesProjNoMulti` |
| transfer  | InventoryQuery     | 50       | base code in `taPreSalesProjNo` + `taPreSalesProjNoMulti` |
| lock      | InventoryLockQuery | n/a      | `ItemNum`                                                 |

Lock also uses `Code=` rather than `CountryCode=`, adds a `URL=` param, sends
no `CardNo`, and triggers `btnExport` instead of `btnExportDetail`.

> **Verified against the live WMS JSON query API:** the CelcomDigi codes are
> delivery-designated values. WMS matches the base values
> `P202211283695`, `P202202168750`, and `20130426020000` in
> `taPreSalesProjNo` / `taPreSalesProjNoMulti`; including `_D001`/`_D002`/`_D006`
> returns zero rows. `taProjectNo` returns zero rows for these values. The
> extractor therefore strips the final `_Dnnn` suffix before sending the WMS
> filter, while retaining the full code in output filenames and manifests.

### Direct API mode

The recommended live mode calls the same authenticated JSON paging endpoints
used by the WMS Query buttons, instead of waiting for Excel generation. It is
still server-bound for large datasets: a 36,910-row inventory query took about
4.5 minutes on the live WMS instance, but it avoids the extra Excel build and
file-download stage:

```
python -m wms_fetch.cli --transport chrome --mode api \
  --cdp-target "MessagerID=..."
```

It writes JSON datasets containing the full delivery code, the normalized
`query_project`, row totals, paging metadata and `rows`. The `_Dnnn` suffix is
kept in filenames/manifests but removed from the WMS filter because the live
API returns zero rows when that suffix is sent. Duplicate base-code queries are
cached and copied to each requested delivery-code output.

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
