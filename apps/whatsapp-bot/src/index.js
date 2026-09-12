import { mkdir } from "node:fs/promises";
import path from "node:path";
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import { createMessageHandler, handleUpsert } from "./adapter.js";
import { createInventoryClient } from "./inventory-client.js";
import { acquireKeepAwake } from "@wms/runtime/keep-awake";
import { retryConnection } from "./reconnect.js";

try {
  process.loadEnvFile();
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const runtime = path.resolve(process.env.WMS_RUNTIME_DIR ?? "runtime");
const authDir = path.resolve(
  process.env.WHATSAPP_AUTH_DIR ?? path.join(runtime, "auth", "whatsapp"),
);
const rules = {
  senders: (process.env.WHATSAPP_ALLOWED_SENDERS ?? "")
    .split(",")
    .filter(Boolean),
  groups: (process.env.WHATSAPP_ALLOWED_GROUPS ?? "")
    .split(",")
    .filter(Boolean),
};
await mkdir(authDir, { recursive: true });
const power = await acquireKeepAwake({
  enabled: process.env.BOT_PREVENT_SLEEP !== "false",
  display: process.env.KEEP_DISPLAY_ON === "true",
  runtimeDir: runtime,
  owner: "whatsapp",
});
let stopped = false;

async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const socket = makeWASocket({ auth: state, printQRInTerminal: true });
  const handler = createMessageHandler({
    rules,
    query: createInventoryClient({ baseUrl: process.env.INVENTORY_API_URL }),
  });
  socket.ev.on("creds.update", saveCreds);
  socket.ev.on("messages.upsert", (upsert) => {
    void handleUpsert(upsert, {
      handler,
      sendText: (destination, text) =>
        socket.sendMessage(destination, { text }),
    }).catch((error) => console.error("WhatsApp upsert failed", error));
  });
  socket.ev.on("connection.update", ({ connection, lastDisconnect }) => {
    if (
      connection === "close" &&
      !stopped &&
      lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
    )
      void retryConnection(connect, {
        initialDelay: 1000,
        isStopped: () => stopped,
      });
  });
}
const shutdown = async () => {
  stopped = true;
  await power.release();
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
await retryConnection(connect, { isStopped: () => stopped });
