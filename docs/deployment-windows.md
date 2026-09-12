# Windows deployment

## Prerequisites

- Node.js 24 LTS and npm.
- Chrome started with remote debugging on port 19222 and an authenticated WMS Inventory Query tab.
- A dedicated non-production WhatsApp number for pairing and soak testing.
- A writable runtime directory outside the repository, for example `C:\dev\wms-fetch-runtime`.

Copy `.env.example` to `.env`, configure the allowlists and employee number, then run `npm install` and `npm test`. Start the three processes under a Windows process supervisor using `npm run start:api`, `npm run start:whatsapp`, and `npm run start:scheduler`. Manual operations are `npm run extract -- --all`, `npm run build-snapshot -- <batch-directory>`, `npm run refresh`, and `npm run status`.

The Node extractor supports the direct JSON paging mode used by the MVP. The optional legacy Excel extraction remains in the preserved Python reference and is explicitly deferred; it is not used by snapshot refresh or WhatsApp queries.

The API binds to `127.0.0.1` unless both `API_HOST` is changed and `ALLOW_EXTERNAL_API=true` is explicitly set. Do not expose port 3000 through a firewall or port forward.

## Recovery

- Expired WMS login: sign in again in the same Windows user session and reopen Inventory Query.
- CDP failure: confirm Chrome remote debugging and `WMS_CDP_SCRIPT`; a failed refresh does not replace the last good snapshot.
- Schema drift or count mismatch: retain raw batch evidence, update sanitized fixtures and contract mapping, then rerun all tests before refreshing.
- Stale snapshot: inspect `npm run status`, restore WMS access, then run one manual refresh.
- Baileys re-pairing: stop the bot, archive the auth directory, pair the dedicated account again, and restart.
- Power-helper failure: verify PowerShell execution and inspect runtime status. The helper exits when its parent exits.

Validate direct and group queries, unauthorized senders, duplicate events, stale data, API downtime, and Chrome extraction while Windows is locked before business use. Use the official Meta WhatsApp Cloud API as the migration path if Baileys compatibility or account policy becomes unacceptable.
