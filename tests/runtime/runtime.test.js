import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { acquireRunLock } from '../../packages/runtime/src/run-lock.js';

test('scheduled and manual refresh cannot overlap', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wms-lock-'));
  const first = await acquireRunLock(root);
  await expect(acquireRunLock(root)).rejects.toMatchObject({ code: 'REFRESH_IN_PROGRESS' });
  await first.release();
  const second = await acquireRunLock(root);
  await second.release();
});

test('reclaims a refresh lock whose owner process no longer exists', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wms-stale-lock-'));
  await writeFile(path.join(root, 'refresh.lock'), JSON.stringify({ pid: 99999999 }));
  const lock = await acquireRunLock(root, { isProcessRunning: () => false });
  expect(lock).toBeDefined();
  await lock.release();
});
