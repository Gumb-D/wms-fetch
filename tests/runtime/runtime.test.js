import { mkdtemp } from 'node:fs/promises';
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
