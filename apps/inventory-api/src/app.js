import express from "express";
import { inventoryRequestSchema } from "@wms/contracts";
import { queryInventory } from "@wms/inventory";

const apiResult = (result, warnings) => ({
  term: result.term,
  snapshot_id: result.snapshotId,
  snapshot_time: result.snapshotTime,
  matched_item_codes: result.matchedItemCodes,
  available_now: result.availableNow,
  locked: result.locked,
  in_transfer: result.inTransfer,
  warnings,
  by_base_project: result.byBaseProject.map((p) => ({
    base_project_code: p.baseProjectCode,
    requested_delivery_codes: p.requestedDeliveryCodes,
    available_now: p.availableNow,
    locked: p.locked,
    in_transfer: p.inTransfer,
  })),
});

export function createApp({ loadSnapshot, staleAfterMs = 36e5 } = {}) {
  if (!loadSnapshot) throw new Error("loadSnapshot is required");
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "16kb" }));
  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  app.get("/v1/snapshot", async (_req, res) => {
    try {
      const s = await loadSnapshot();
      res.json({
        snapshot_id: s.snapshotId,
        snapshot_time: s.snapshotTime,
        base_projects: s.baseProjects,
      });
    } catch {
      res.status(503).json({
        error: {
          code: "NO_VALID_SNAPSHOT",
          message: "Inventory data is temporarily unavailable",
        },
      });
    }
  });
  app.post("/v1/inventory/query", async (req, res) => {
    const parsed = inventoryRequestSchema.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({
        error: {
          code: "INVALID_REQUEST",
          message: "Invalid inventory query",
        },
      });
    try {
      const snapshot = await loadSnapshot();
      const age = Date.now() - new Date(snapshot.snapshotTime).getTime();
      const warnings =
        Number.isFinite(age) && age > staleAfterMs ? ["STALE_SNAPSHOT"] : [];
      return res.json(
        apiResult(
          queryInventory(
            {
              term: parsed.data.term,
              projectCodes: parsed.data.project_codes,
              region: parsed.data.region,
            },
            snapshot,
          ),
          warnings,
        ),
      );
    } catch (error) {
      if (error.code === "AMBIGUOUS_TERM") {
        return res.status(409).json({
          error: {
            code: error.code,
            message: "Inventory term is ambiguous",
            candidates: error.candidates,
          },
        });
      }
      const code = ["NO_VALID_SNAPSHOT", "SCHEMA_MISMATCH"].includes(error.code)
        ? error.code
        : "NO_VALID_SNAPSHOT";
      return res.status(code === "SCHEMA_MISMATCH" ? 500 : 503).json({
        error: {
          code,
          message:
            code === "SCHEMA_MISMATCH"
              ? "Inventory snapshot schema mismatch"
              : "Inventory data is temporarily unavailable",
        },
      });
    }
  });
  app.use((_err, _req, res, next) => {
    void next;
    res.status(400).json({
      error: { code: "INVALID_REQUEST", message: "Invalid JSON request" },
    });
  });
  return app;
}
