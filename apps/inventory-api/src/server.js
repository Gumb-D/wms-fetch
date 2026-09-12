import path from "node:path";
import { createApp } from "./app.js";
import { loadCurrentSnapshot } from "@wms/inventory/snapshot-builder";

try {
  process.loadEnvFile();
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const host = process.env.API_HOST ?? "127.0.0.1";
const port = Number(process.env.API_PORT ?? 3000);
if (host !== "127.0.0.1" && process.env.ALLOW_EXTERNAL_API !== "true")
  throw new Error("External API binding requires ALLOW_EXTERNAL_API=true");
const runtime = path.resolve(process.env.WMS_RUNTIME_DIR ?? "runtime");
createApp({
  loadSnapshot: () => loadCurrentSnapshot(runtime),
  staleAfterMs: Number(process.env.SNAPSHOT_STALE_MS ?? 36e5),
}).listen(port, host, () =>
  console.log(JSON.stringify({ event: "api_started", host, port })),
);
