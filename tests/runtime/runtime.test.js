import { mkdir, mkdtemp, utimes } from "node:fs/promises";
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

test("reclaims a refresh lock after its heartbeat becomes stale", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "wms-stale-lock-"));
  const lockPath = path.join(root, "refresh.lock");
  await mkdir(lockPath);
  const old = new Date(Date.now() - 5_000);
  await utimes(lockPath, old, old);
  const lock = await acquireRunLock(root, { staleMs: 2_000, updateMs: 1_000 });
  expect(lock).toBeDefined();
  await lock.release();
});

test("does not reclaim a fresh orphan lock", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "wms-fresh-lock-"));
  const lockPath = path.join(root, "refresh.lock");
  await mkdir(lockPath);
  await expect(
    acquireRunLock(root, { staleMs: 2_000, updateMs: 1_000 }),
  ).rejects.toMatchObject({ code: "REFRESH_IN_PROGRESS" });
});

test("concurrent stale-lock reclaim still grants exactly one lock", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "wms-race-lock-"));
  const lockPath = path.join(root, "refresh.lock");
  await mkdir(lockPath);
  const old = new Date(Date.now() - 5_000);
  await utimes(lockPath, old, old);
  const attempts = await Promise.allSettled([
    acquireRunLock(root, { staleMs: 2_000, updateMs: 1_000 }),
    acquireRunLock(root, { staleMs: 2_000, updateMs: 1_000 }),
  ]);
  const acquired = attempts.filter((result) => result.status === "fulfilled");
  expect(acquired).toHaveLength(1);
  await acquired[0].value.release();
});
