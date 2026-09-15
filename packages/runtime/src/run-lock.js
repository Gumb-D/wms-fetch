import { mkdir } from "node:fs/promises";
import path from "node:path";
import lockfile from "proper-lockfile";

export async function acquireRunLock(
  runtimeDir,
  { staleMs = 30_000, updateMs = 10_000 } = {},
) {
  await mkdir(runtimeDir, { recursive: true });
  const lockPath = path.join(runtimeDir, "refresh.lock");
  let unlock;
  try {
    unlock = await lockfile.lock(runtimeDir, {
      lockfilePath: lockPath,
      realpath: false,
      retries: 0,
      stale: staleMs,
      update: updateMs,
    });
  } catch (error) {
    if (error.code !== "ELOCKED") throw error;
    throw Object.assign(new Error("Another refresh is already running"), {
      code: "REFRESH_IN_PROGRESS",
      cause: error,
    });
  }

  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      await unlock();
    },
  };
}
