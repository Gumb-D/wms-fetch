# WMS-to-WhatsApp inventory assistant

The application uses three independent Node.js processes: a loopback-only Express inventory API, a Baileys WhatsApp adapter, and a node-cron refresh scheduler. The WhatsApp process cannot import the extractor and receives quantities only from the API.

Refreshes query Inventory, Transfer, and Inventory Lock through the authenticated Chrome CDP session. A batch is publishable only when every manifest entry succeeds and every fetched row count equals the WMS total. Delivery variants are queried once per base project. Immutable snapshot directories are written before `current.json` is atomically replaced, so a failed refresh leaves the previous snapshot queryable.

Stock rules are deterministic: use an authoritative available field only after it is verified in sanitized fixtures; otherwise `available_now = max(on_hand - locked, 0)`. Transfer stock is shown separately and is never available-now.

Runtime credentials, WMS data, snapshots, logs, QR material, and Baileys authentication are outside Git. Numeric API fields are decimal strings. Every numeric WhatsApp reply includes the source timestamp.
