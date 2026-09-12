import { mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { acquireRunLock } from "../../packages/runtime/src/run-lock.js";

test("scheduled and manual refresh cannot overlap", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "wms-lock-"));
  const first = await acquireRunLock(root);
  await expect(acquireRunLock(root)).rejects.toMatchObject({
    code: "REFRESH_IN_PROGRESS",
  });
  await first.release();
  const second = await acquireRunLock(root);
  await second.release();
});

test("reclaims a refresh lock whose owner process no longer exists", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "wms-stale-lock-"));
  await writeFile(
    path.join(root, "refresh.lock"),
    JSON.stringify({ pid: 99999999 }),
  );
  const lock = await acquireRunLock(root, { isProcessRunning: () => false });
  expect(lock).toBeDefined();
  await lock.release();
});

test("reclaims malformed lock data only after the creation grace period", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "wms-malformed-lock-"));
  const lockPath = path.join(root, "refresh.lock");
  await writeFile(lockPath, "{");
  await expect(
    acquireRunLock(root, { malformedGraceMs: 30_000 }),
  ).rejects.toMatchObject({ code: "REFRESH_IN_PROGRESS" });
  const old = new Date(Date.now() - 31_000);
  await utimes(lockPath, old, old);
  const lock = await acquireRunLock(root, { malformedGraceMs: 30_000 });
  await lock.release();
});

test("concurrent stale-lock reclaim still grants exactly one lock", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "wms-race-lock-"));
  const lockPath = path.join(root, "refresh.lock");
  await writeFile(lockPath, "{");
  const old = new Date(Date.now() - 31_000);
  await utimes(lockPath, old, old);
  const attempts = await Promise.allSettled([
    acquireRunLock(root, { malformedGraceMs: 30_000 }),
    acquireRunLock(root, { malformedGraceMs: 30_000 }),
  ]);
  const acquired = attempts.filter((result) => result.status === "fulfilled");
  expect(acquired).toHaveLength(1);
  await acquired[0].value.release();
});
