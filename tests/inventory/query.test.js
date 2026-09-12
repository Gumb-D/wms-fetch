import path from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { buildSnapshot } from "../../packages/inventory/src/snapshot-builder.js";
import { queryInventory } from "../../packages/inventory/src/query.js";

let snapshot;
beforeAll(async () => {
  snapshot = await buildSnapshot(
    path.resolve("tests/fixtures/inventory-batch"),
  );
});

describe("inventory queries", () => {
  test("RRU has deterministic decimal-safe totals without delivery double count", () => {
    const result = queryInventory(
      { term: "RRU", projectCodes: [], region: null },
      snapshot,
    );
    expect(result.availableNow).toBe("88");
    expect(result.locked).toBe("12");
    expect(result.inTransfer).toBe("18");
    expect(result.byBaseProject).toEqual([
      {
        baseProjectCode: "P1",
        requestedDeliveryCodes: ["P1_D001", "P1_D002"],
        availableNow: "88",
        locked: "12",
        inTransfer: "18",
      },
    ]);
  });

  test("filters by delivery code and region but aggregates the base project once", () => {
    const result = queryInventory(
      { term: "rru", projectCodes: ["P1_D002"], region: "sabah" },
      snapshot,
    );
    expect(result.availableNow).toBe("88");
  });

  test("matches lowercase project filters against uppercase snapshot codes", () => {
    const result = queryInventory(
      { term: "RRU", projectCodes: ["p1_d002"] },
      snapshot,
    );
    expect(result.availableNow).toBe("88");
  });

  test("groups snapshot project casing variants under one normalized base code", () => {
    const casingVariant = structuredClone(snapshot);
    for (const row of casingVariant.records.filter(
      (row) => row.sourceType === "transfer",
    )) {
      row.baseProjectCode = row.baseProjectCode.toLowerCase();
    }
    const result = queryInventory({ term: "RRU" }, casingVariant);
    expect(result.byBaseProject).toHaveLength(1);
    expect(result.byBaseProject[0].baseProjectCode).toBe("P1");
    expect(result.inTransfer).toBe("18");
  });

  test("healthy no-match is a genuine zero result", () => {
    expect(queryInventory({ term: "NOT-THERE" }, snapshot)).toMatchObject({
      availableNow: "0",
      matchedItemCodes: [],
    });
  });

  test("uses an authoritative available quantity without subtracting lock twice", () => {
    const authoritative = structuredClone(snapshot);
    for (const row of authoritative.records) {
      if (row.sourceType === "inventory" && row.itemCode === "RRU-001")
        row.availableQuantity = "91";
    }
    expect(queryInventory({ term: "RRU" }, authoritative).availableNow).toBe(
      "91",
    );
  });

  test("clamps derived availability per item before summing a family", () => {
    const perItem = structuredClone(snapshot);
    const template = perItem.records.find(
      (row) => row.sourceType === "inventory",
    );
    perItem.records = [
      {
        ...template,
        sourceType: "inventory",
        itemCode: "RRU-A",
        quantity: "5",
        availableQuantity: null,
      },
      {
        ...template,
        sourceType: "lock",
        itemCode: "RRU-A",
        quantity: "10",
        availableQuantity: null,
      },
      {
        ...template,
        sourceType: "inventory",
        itemCode: "RRU-B",
        quantity: "10",
        availableQuantity: null,
      },
    ];
    expect(queryInventory({ term: "RRU" }, perItem).availableNow).toBe("10");
  });

  test("joins lock and transfer quantities by matched item code", () => {
    const labelVariant = structuredClone(snapshot);
    for (const row of labelVariant.records.filter(
      (row) => row.sourceType !== "inventory",
    )) {
      row.product = "Legacy system label";
      row.alias = null;
    }
    const result = queryInventory({ term: "Radio Remote" }, labelVariant);
    expect(result.availableNow).toBe("88");
    expect(result.locked).toBe("12");
    expect(result.inTransfer).toBe("18");
  });

  test("returns ambiguity instead of adding materially different product families", () => {
    const ambiguous = structuredClone(snapshot);
    ambiguous.records.push({
      ...ambiguous.records[0],
      itemCode: "RADIO-002",
      product: "Radio Cabinet",
      alias: "cabinet",
      quantity: "4",
    });
    expect(() => queryInventory({ term: "radio" }, ambiguous)).toThrowError(
      expect.objectContaining({ code: "AMBIGUOUS_TERM" }),
    );
  });
});
