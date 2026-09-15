import path from "node:path";
import request from "supertest";
import { beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../../apps/inventory-api/src/app.js";
import { buildSnapshot } from "../../packages/inventory/src/snapshot-builder.js";

let snapshot;
beforeAll(async () => {
  snapshot = await buildSnapshot(
    path.resolve("tests/fixtures/inventory-batch"),
  );
});

describe("inventory API", () => {
  test("returns engine totals through structured endpoint", async () => {
    const response = await request(
      createApp({ loadSnapshot: async () => snapshot, staleAfterMs: 86400000 }),
    )
      .post("/v1/inventory/query")
      .send({ term: "RRU", project_codes: [], region: null });
    expect(response.status).toBe(200);
    expect(response.body.available_now).toBe("88");
  });

  test("reports unavailable snapshot without false zero", async () => {
    const response = await request(
      createApp({
        loadSnapshot: async () => {
          throw Object.assign(new Error("missing"), {
            code: "NO_VALID_SNAPSHOT",
          });
        },
      }),
    )
      .post("/v1/inventory/query")
      .send({ term: "RRU" });
    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      error: {
        code: "NO_VALID_SNAPSHOT",
        message: "Inventory data is temporarily unavailable",
      },
    });
  });

  test("rejects invalid request shape", async () => {
    const response = await request(
      createApp({ loadSnapshot: async () => snapshot }),
    )
      .post("/v1/inventory/query")
      .send({ term: "" });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("INVALID_REQUEST");
  });

  test("returns a clarification response for an ambiguous term", async () => {
    const ambiguous = structuredClone(snapshot);
    ambiguous.records.push({
      ...ambiguous.records[0],
      itemCode: "RADIO-002",
      product: "Radio Cabinet",
      alias: "cabinet",
    });
    const response = await request(
      createApp({ loadSnapshot: async () => ambiguous }),
    )
      .post("/v1/inventory/query")
      .send({ term: "radio" });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("AMBIGUOUS_TERM");
  });
});
