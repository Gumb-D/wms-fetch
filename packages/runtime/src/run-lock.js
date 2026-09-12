import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import path from "node:path";

const processIsRunning = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

export async function acquireRunLock(
  runtimeDir,
  {
    isProcessRunning = processIsRunning,
    malformedGraceMs = 30_000,
    now = Date.now,
  } = {},
) {
  await mkdir(runtimeDir, { recursive: true });
  const lockPath = path.join(runtimeDir, "refresh.lock");
  let handle;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      handle = await open(lockPath, "wx");
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let owner;
      try {
        owner = JSON.parse(await readFile(lockPath, "utf8"));
      } catch {}
      const malformed = !Number.isInteger(owner?.pid);
      const oldMalformed =
        malformed && now() - (await stat(lockPath)).mtimeMs >= malformedGraceMs;
      if (
        attempt === 0 &&
        (oldMalformed ||
          (Number.isInteger(owner?.pid) && !isProcessRunning(owner.pid)))
      ) {
        await unlink(lockPath).catch((unlinkError) => {
          if (unlinkError.code !== "ENOENT") throw unlinkError;
        });
        continue;
      }
      throw Object.assign(new Error("Another refresh is already running"), {
        code: "REFRESH_IN_PROGRESS",
      });
    }
  }
  await handle.writeFile(
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
  );
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      await handle.close();
      await unlink(lockPath).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    },
  };
}
