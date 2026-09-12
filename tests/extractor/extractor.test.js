import { describe, expect, test } from "vitest";
import {
  baseProjectCode,
  fetchDataset,
  runExtraction,
} from "../../apps/extractor/src/wms-client.js";

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
});
