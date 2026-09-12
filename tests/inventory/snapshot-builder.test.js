import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  buildSnapshot,
  publishSnapshot,
} from "../../packages/inventory/src/snapshot-builder.js";

const fixture = path.resolve("tests/fixtures/inventory-batch");

describe("verified inventory snapshots", () => {
  test("deduplicates delivery variants and derives available as on-hand minus locked", async () => {
    const snapshot = await buildSnapshot(fixture);
    const rru = snapshot.records.filter((row) => row.itemCode === "RRU-001");
    expect(snapshot.baseProjects).toEqual(["P1"]);
    expect(rru).toHaveLength(3);
    expect(
      rru.find((r) => r.sourceType === "inventory").requestedDeliveryCodes,
    ).toEqual(["P1_D001", "P1_D002"]);
  });

  test("deduplicates base-project casing variants before reading datasets", async () => {
    const manifest = JSON.parse(
      await readFile(
        path.join(fixture, "manifest_20260911_150000.json"),
        "utf8",
      ),
    );
    for (const result of manifest.results.filter(
      (row) => row.project === "P1_D002",
    ))
      result.query_project = "p1";
    const snapshot = await buildSnapshot(fixture, { manifest });
    expect(snapshot.baseProjects).toEqual(["P1"]);
    expect(
      snapshot.records.filter((row) => row.itemCode === "RRU-001"),
    ).toHaveLength(3);
  });

  test("rejects incomplete manifests before reading data", async () => {
    await expect(
      buildSnapshot(fixture, {
        manifest: {
          run_id: "failed-run",
          started_at: "2026-09-11T15:00:00+08:00",
          finished_at: "2026-09-11T15:05:00+08:00",
          summary: { total: 6, ok: 5, failed: 1, skipped: 0 },
          results: [
            {
              project: "P1_D001",
              query_project: "P1",
              export: "inventory",
              status: "failed",
            },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: "INVALID_BATCH" });
  });

  test("atomically publishes current pointer and immutable snapshot", async () => {
    const runtime = await mkdtemp(path.join(tmpdir(), "wms-snapshot-"));
    const snapshot = await buildSnapshot(fixture);
    await publishSnapshot(snapshot, runtime);
    const current = JSON.parse(
      await readFile(path.join(runtime, "current.json"), "utf8"),
    );
    expect(current.snapshotId).toBe(snapshot.snapshotId);
    expect(current.path).toContain(snapshot.snapshotId);
  });
});
