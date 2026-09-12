import {
  buildSnapshot,
  publishSnapshot,
} from "@wms/inventory/snapshot-builder";
import { acquireRunLock } from "@wms/runtime/run-lock";

export async function publishSnapshotWithLock({
  runtimeDir,
  batchDir,
  acquireLock = acquireRunLock,
  build = buildSnapshot,
  publish = publishSnapshot,
}) {
  const lock = await acquireLock(runtimeDir);
  try {
    return await publish(await build(batchDir), runtimeDir);
  } finally {
    await lock.release();
  }
}
