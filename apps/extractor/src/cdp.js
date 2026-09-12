import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
const exec = promisify(execFile);

export async function readCdpResponse(
  evaluate,
  id,
  size,
  chunkSize = 256 * 1024,
) {
  const chunks = [];
  for (let start = 0; start < size; start += chunkSize) {
    const end = Math.min(start + chunkSize, size);
    chunks.push(
      await evaluate(
        `window.__wmsJobs[${JSON.stringify(id)}].data.slice(${start},${end})`,
      ),
    );
  }
  return chunks.join("");
}

export function createCdpRequester({
  script = process.env.WMS_CDP_SCRIPT ?? "C:\\dev\\aida-chrome\\cdp\\cdp.mjs",
  port = Number(process.env.WMS_CDP_PORT ?? 19222),
  target = process.env.WMS_CDP_TARGET ?? "InventoryQuery.aspx",
} = {}) {
  const evaluate = async (expression) =>
    JSON.parse(
      (
        await exec(
          process.execPath,
          [script, "eval", target, expression, "--port", String(port)],
          { timeout: 35000, windowsHide: true, maxBuffer: 10 * 1024 * 1024 },
        )
      ).stdout,
    );
  return async ({ url, params, body }) => {
    const id = `wms_${randomUUID().replaceAll("-", "")}`;
    const requestUrl = `${url}?${new URLSearchParams(params)}`;
    await evaluate(
      `(()=>{const id=${JSON.stringify(id)};window.__wmsJobs=window.__wmsJobs||{};const j=window.__wmsJobs[id]={state:'pending'};fetch(${JSON.stringify(requestUrl)},{method:'POST',credentials:'include',headers:{'content-type':'application/x-www-form-urlencoded; charset=UTF-8','x-requested-with':'XMLHttpRequest'},body:${JSON.stringify(body)}}).then(async r=>{j.status=r.status;j.data=await r.text();j.state='done'}).catch(e=>{j.error=String(e);j.state='error'});return id})()`,
    );
    for (let i = 0; i < 900; i += 1) {
      const result = await evaluate(
        `(()=>{const j=window.__wmsJobs[${JSON.stringify(id)}];if(!j)return {state:'missing'};return {state:j.state,status:j.status,size:j.data?.length,error:j.error}})()`,
      );
      if (result.state === "done") {
        try {
          if (result.status !== 200)
            throw new Error(`WMS HTTP ${result.status}`);
          const data = await readCdpResponse(evaluate, id, result.size);
          return JSON.parse(data);
        } finally {
          await evaluate(
            `delete window.__wmsJobs[${JSON.stringify(id)}]`,
          ).catch(() => {});
        }
      }
      if (result.state === "error" || result.state === "missing") {
        await evaluate(`delete window.__wmsJobs[${JSON.stringify(id)}]`).catch(
          () => {},
        );
        throw new Error(
          `Chrome WMS request failed: ${result.error ?? result.state}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    await evaluate(`delete window.__wmsJobs[${JSON.stringify(id)}]`).catch(
      () => {},
    );
    throw new Error("Chrome WMS request timed out");
  };
}
