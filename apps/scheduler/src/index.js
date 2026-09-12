import { spawn } from "node:child_process";
import path from "node:path";
import cron from "node-cron";
import { acquireKeepAwake } from "@wms/runtime/keep-awake";

try {
  process.loadEnvFile();
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const expression = process.env.REFRESH_CRON ?? "*/30 * * * *";
const timezone = process.env.REFRESH_TIMEZONE ?? "Asia/Kuala_Lumpur";
if (!cron.validate(expression)) throw new Error("Invalid REFRESH_CRON");
const runtime = path.resolve(process.env.WMS_RUNTIME_DIR ?? "runtime");
const power = await acquireKeepAwake({
  enabled: process.env.SCHEDULER_PREVENT_SLEEP !== "false",
  display: process.env.KEEP_DISPLAY_ON === "true",
  runtimeDir: runtime,
  owner: "scheduler",
});
let running = false;
const refresh = () => {
  if (running) return;
  running = true;
  const child = spawn(
    process.execPath,
    [path.resolve("apps/extractor/src/cli.js"), "refresh"],
    { stdio: "inherit", env: process.env, windowsHide: true },
  );
  child.once("exit", () => {
    running = false;
  });
};
cron.schedule(expression, refresh, { timezone, noOverlap: true });
const shutdown = async () => {
  await power.release();
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
console.log(
  JSON.stringify({ event: "scheduler_started", expression, timezone }),
);
