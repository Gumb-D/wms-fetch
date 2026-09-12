export async function runRefresh({ acquireLock, extract, build, publish }) {
  const lock = await acquireLock();
  try {
    const batch = await extract();
    const snapshot = await build(batch);
    return await publish(snapshot);
  } finally {
    await lock.release();
  }
}
