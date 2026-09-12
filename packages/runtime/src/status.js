import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
export async function runtimeStatus(runtimeDir) {
  let current = null; try { current = JSON.parse(await readFile(path.join(runtimeDir, 'current.json'), 'utf8')); } catch {}
  let power = []; try { power = await Promise.all((await readdir(path.join(runtimeDir, 'status'))).filter((f) => f.startsWith('keep-awake-')).map(async (f) => JSON.parse(await readFile(path.join(runtimeDir, 'status', f), 'utf8')))); } catch {}
  return { snapshot: current ? { ...current, ageMs: Date.now() - new Date(current.publishedAt).getTime() } : null, keepAwake: power };
}
