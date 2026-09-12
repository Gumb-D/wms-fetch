import { mkdir, open, unlink } from 'node:fs/promises';
import path from 'node:path';

export async function acquireRunLock(runtimeDir) {
  await mkdir(runtimeDir, { recursive: true });
  const lockPath = path.join(runtimeDir, 'refresh.lock');
  let handle;
  try { handle = await open(lockPath, 'wx'); }
  catch (error) {
    if (error.code === 'EEXIST') throw Object.assign(new Error('Another refresh is already running'), { code: 'REFRESH_IN_PROGRESS' });
    throw error;
  }
  await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  let released = false;
  return { async release() { if (released) return; released = true; await handle.close(); await unlink(lockPath).catch((e) => { if (e.code !== 'ENOENT') throw e; }); } };
}
