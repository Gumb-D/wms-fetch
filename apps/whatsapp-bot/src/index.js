import { mkdir } from "node:fs/promises";
import path from "node:path";
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import { createMessageHandler } from "./adapter.js";
import { createInventoryClient } from "./inventory-client.js";
import { acquireKeepAwake } from "@wms/runtime/keep-awake";

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

async function connect(delay = 0) {
  if (delay) await new Promise((r) => setTimeout(r, delay));
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const socket = makeWASocket({ auth: state, printQRInTerminal: true });
  const handler = createMessageHandler({
    rules,
    query: createInventoryClient({ baseUrl: process.env.INVENTORY_API_URL }),
  });
  socket.ev.on("creds.update", saveCreds);
  socket.ev.on("messages.upsert", async ({ messages }) => {
    for (const raw of messages) {
      const chatId = raw.key.remoteJid;
      const senderId = raw.key.participant ?? chatId;
      const text =
        raw.message?.conversation ?? raw.message?.extendedTextMessage?.text;
      const reply = await handler({
        id: raw.key.id,
        chatId,
        senderId,
        text,
        fromMe: raw.key.fromMe,
      });
      if (reply) await socket.sendMessage(chatId, { text: reply });
    }
  });
  socket.ev.on("connection.update", ({ connection, lastDisconnect }) => {
    if (
      connection === "close" &&
      !stopped &&
      lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
    )
      void connect(Math.min(delay ? delay * 2 : 1000, 30000));
  });
}
const shutdown = async () => {
  stopped = true;
  await power.release();
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
await connect();
