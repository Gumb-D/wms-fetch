export function createInventoryClient({
  baseUrl = "http://127.0.0.1:3000",
  timeoutMs = 3000,
  fetchImpl = fetch,
} = {}) {
  return async function query(body) {
    let lastError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetchImpl(`${baseUrl}/v1/inventory/query`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const data = await response.json();
        if (!response.ok)
          throw Object.assign(
            new Error(data.error?.message ?? "Inventory API failed"),
            { code: data.error?.code },
          );
        return data;
      } catch (error) {
        lastError = error;
        if (attempt === 0)
          await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }
    throw Object.assign(new Error("Inventory service unavailable"), {
      code: lastError?.code ?? "API_UNAVAILABLE",
    });
  };
}
