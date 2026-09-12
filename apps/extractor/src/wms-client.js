const MAX_PAGE_SIZE = 3000;
export const baseProjectCode = (code) => String(code).replace(/_D\d+$/i, "");

export function buildPagingParams({
  sourceType,
  page,
  pageSize,
  employeeNo,
  countryCode,
}) {
  const lock = sourceType === "lock";
  const grid = lock ? "DataGrid" : "dgInventoryDetail";
  const params = {
    CommandName: "Paging",
    PageNum: String(page),
    PageSize: String(pageSize),
    GridID: grid,
    CustomData: "",
    CommandControl: "btnQuery",
    CommandEvent: "click",
    DataGridId: grid,
    PageSourceID: "",
    EmployeeNo: "null",
    LanguageID: "1033",
    SystemName: "null",
    EmployeeToken: "null",
    EmployeeCnName: "null",
    EmployeeEnName: "null",
  };
  if (lock) {
    params.URL = "/SCM/WMS/WMS_CN809/InventoryLock/InventoryLockQuery.aspx";
    params.Code = countryCode;
  } else params.CardNo = employeeNo;
  return params;
}

export async function fetchDataset({
  project,
  sourceType,
  pageSize = MAX_PAGE_SIZE,
  requestPage,
  now = () => new Date().toISOString(),
}) {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE)
    throw new Error("pageSize must be 1..3000");
  let page = 1;
  let expectedTotal;
  const rows = [];
  do {
    const payload = await requestPage({
      project: baseProjectCode(project),
      sourceType,
      page,
      pageSize,
    });
    if (!payload?.Succeed || !payload.Data || !Array.isArray(payload.Data.rows))
      throw Object.assign(
        new Error(
          `WMS ${sourceType} page ${page} returned an invalid response`,
        ),
        { code: "WMS_RESPONSE_INVALID" },
      );
    const total = Number(payload.Data.total ?? 0);
    if (!Number.isInteger(total) || total < 0)
      throw Object.assign(new Error("WMS total is invalid"), {
        code: "WMS_RESPONSE_INVALID",
      });
    if (expectedTotal === undefined) expectedTotal = total;
    if (total !== expectedTotal)
      throw Object.assign(
        new Error(
          `WMS total changed during paging: ${expectedTotal} -> ${total}`,
        ),
        { code: "TOTAL_CHANGED" },
      );
    if (expectedTotal > rows.length && payload.Data.rows.length === 0)
      throw Object.assign(
        new Error(
          `${sourceType} page ${page} returned no rows before total was reached`,
        ),
        { code: "EMPTY_PAGE" },
      );
    rows.push(...payload.Data.rows);
    page += 1;
  } while (rows.length < expectedTotal);
  if (rows.length !== expectedTotal)
    throw Object.assign(
      new Error(
        `Fetched ${rows.length} rows but WMS reported ${expectedTotal}`,
      ),
      { code: "TOTAL_MISMATCH" },
    );
  return {
    project,
    query_project: baseProjectCode(project),
    export: sourceType,
    total: expectedTotal,
    fetched_rows: rows.length,
    pages: Math.max(1, page - 1),
    page_size: pageSize,
    fetched_at: now(),
    rows,
  };
}

export async function runExtraction({
  projects,
  sourceTypes,
  requestPage,
  writeDataset,
  runId,
}) {
  const cache = new Map();
  const results = [];
  const extractedAt = new Date().toISOString();
  for (const project of projects)
    for (const sourceType of sourceTypes) {
      const key = `${baseProjectCode(project)}:${sourceType}`;
      const cacheHit = cache.has(key);
      try {
        const base = cacheHit
          ? cache.get(key)
          : await fetchDataset({
              project,
              sourceType,
              requestPage,
              now: () => extractedAt,
            });
        if (!cacheHit) cache.set(key, base);
        const dataset = { ...base, project, cache_hit: cacheHit };
        const file = await writeDataset({
          project,
          sourceType,
          dataset,
          cacheHit,
          runId,
        });
        results.push({
          project,
          query_project: baseProjectCode(project),
          export: sourceType,
          status: "ok",
          file,
        });
      } catch (error) {
        results.push({
          project,
          query_project: baseProjectCode(project),
          export: sourceType,
          status: "failed",
          error: error.message,
        });
      }
    }
  return {
    run_id: runId,
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    summary: {
      total: results.length,
      ok: results.filter((r) => r.status === "ok").length,
      failed: results.filter((r) => r.status === "failed").length,
      skipped: 0,
    },
    results,
  };
}
