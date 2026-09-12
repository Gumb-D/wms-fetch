import { describe, expect, test } from "vitest";
import {
  baseProjectCode,
  buildPagingParams,
  fetchDataset,
  runExtraction,
} from "../../apps/extractor/src/wms-client.js";
import { readCdpResponse } from "../../apps/extractor/src/cdp.js";

describe("JavaScript extraction parity", () => {
  test("normalizes only delivery suffixes", () => {
    expect(baseProjectCode("P202211283695_D002")).toBe("P202211283695");
    expect(baseProjectCode("P202002297117")).toBe("P202002297117");
  });

  test("paginates and verifies the WMS reported total", async () => {
    const pages = [
      { Succeed: true, Data: { total: 3, rows: [{ id: 1 }, { id: 2 }] } },
      { Succeed: true, Data: { total: 3, rows: [{ id: 3 }] } },
    ];
    const dataset = await fetchDataset({
      project: "P1_D001",
      sourceType: "inventory",
      pageSize: 2,
      requestPage: async () => pages.shift(),
      now: () => "2026-09-11T15:00:00+08:00",
    });
    expect(dataset).toMatchObject({
      query_project: "P1",
      total: 3,
      fetched_rows: 3,
      pages: 2,
    });
  });

  test("includes every context parameter required by WMS paging", () => {
    expect(
      buildPagingParams({
        sourceType: "inventory",
        page: 1,
        pageSize: 3000,
        employeeNo: "123",
        countryCode: "MY",
      }),
    ).toMatchObject({
      CustomData: "",
      PageSourceID: "",
      EmployeeToken: "null",
      EmployeeCnName: "null",
      EmployeeEnName: "null",
    });
  });

  test("aborts when a positive-total page makes no progress", async () => {
    const pages = [
      { Succeed: true, Data: { total: 3, rows: [{ id: 1 }, { id: 2 }] } },
      { Succeed: true, Data: { total: 3, rows: [] } },
    ];
    await expect(
      fetchDataset({
        project: "P1",
        sourceType: "inventory",
        pageSize: 2,
        requestPage: async () => pages.shift(),
      }),
    ).rejects.toMatchObject({ code: "EMPTY_PAGE" });
  });

  test("reuses identical base-project datasets and preserves delivery outputs", async () => {
    let calls = 0;
    const result = await runExtraction({
      projects: ["P1_D001", "P1_D002"],
      sourceTypes: ["inventory"],
      requestPage: async () => {
        calls += 1;
        return { Succeed: true, Data: { total: 1, rows: [{ id: 1 }] } };
      },
      writeDataset: async ({ project, cacheHit }) =>
        `${project}-${cacheHit}.json`,
      runId: "run",
    });
    expect(calls).toBe(1);
    expect(result.results.map((r) => r.file)).toEqual([
      "P1_D001-false.json",
      "P1_D002-true.json",
    ]);
  });

  test("reads large CDP response bodies in bounded chunks", async () => {
    const body = "x".repeat(11 * 1024 * 1024);
    const evaluate = async (expression) => {
      const match = expression.match(/slice\((\d+),(\d+)\)/);
      return match ? body.slice(Number(match[1]), Number(match[2])) : null;
    };
    const result = await readCdpResponse(
      evaluate,
      "job",
      body.length,
      256 * 1024,
    );
    expect(result).toHaveLength(body.length);
    expect(result).toBe(body);
  });
});
