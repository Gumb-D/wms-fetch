const sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay));

export async function retryConnection(
  connect,
  {
    initialDelay = 0,
    maxDelay = 30_000,
    wait = sleep,
    onError = console.error,
    isStopped = () => false,
  } = {},
) {
  let delay = initialDelay;
  while (!isStopped()) {
    if (delay) await wait(delay);
    if (isStopped()) return;
    try {
      await connect();
      return;
    } catch (error) {
      onError("WhatsApp connection failed", error);
      delay = Math.min(delay ? delay * 2 : 1000, maxDelay);
    }
  }
}
