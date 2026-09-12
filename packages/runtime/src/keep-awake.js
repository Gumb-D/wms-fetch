import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

export async function acquireKeepAwake({ enabled = true, display = false, runtimeDir = 'runtime', owner = 'process' } = {}) {
  if (!enabled || process.platform !== 'win32') return { active: false, async release() {} };
  await mkdir(path.join(runtimeDir, 'status'), { recursive: true });
  const helper = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.resolve('scripts/windows/keep-awake.ps1'), '-ParentPid', String(process.pid), ...(display ? ['-DisplayOn'] : [])], { stdio: 'ignore', windowsHide: true });
  const status = path.join(runtimeDir, 'status', `keep-awake-${owner}.json`);
  await writeFile(status, JSON.stringify({ owner, pid: helper.pid, active: true, startedAt: new Date().toISOString() }));
  let released = false;
  return { active: true, async release() { if (released) return; released = true; helper.kill(); await writeFile(status, JSON.stringify({ owner, active: false, stoppedAt: new Date().toISOString() })); } };
}
