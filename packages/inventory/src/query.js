import Decimal from "decimal.js";
import { matchesTerm, normalizeTerm } from "./catalog.js";

const sum = (rows) =>
  rows.reduce((total, row) => total.plus(row.quantity), new Decimal(0));
const baseCode = (code) =>
  String(code)
    .replace(/_D\d+$/i, "")
    .toUpperCase();

export function queryInventory(query, snapshot, options = {}) {
  const projects = new Set(
    (query.projectCodes ?? query.project_codes ?? []).map(baseCode),
  );
  const region = query.region ? normalizeTerm(query.region) : null;
  const matching = snapshot.records.filter(
    (row) =>
      (!projects.size || projects.has(baseCode(row.baseProjectCode))) &&
      (!region || normalizeTerm(row.region ?? "") === region) &&
      matchesTerm(row, query.term, options.aliases),
  );
  const families = new Map();
  const aliasByItem = new Map(
    matching
      .filter((row) => row.alias)
      .map((row) => [row.itemCode, normalizeTerm(row.alias)]),
  );
  for (const row of matching) {
    const family = aliasByItem.get(row.itemCode) || normalizeTerm(row.product);
    if (!families.has(family)) families.set(family, row.product);
  }
  if (families.size > 1) {
    throw Object.assign(
      new Error("Inventory term matches multiple product families"),
      {
        code: "AMBIGUOUS_TERM",
        candidates: [...families.values()].sort().slice(0, 5),
      },
    );
  }
  const itemCodes = [...new Set(matching.map((r) => r.itemCode))].sort();
  const summaries = [];
  for (const base of [
    ...new Set(matching.map((r) => baseCode(r.baseProjectCode))),
  ].sort()) {
    const rows = matching.filter((r) => baseCode(r.baseProjectCode) === base);
    const inventoryRows = rows.filter((r) => r.sourceType === "inventory");
    const onHand = sum(inventoryRows);
    const locked = sum(rows.filter((r) => r.sourceType === "lock"));
    const transfer = sum(rows.filter((r) => r.sourceType === "transfer"));
    summaries.push({
      baseProjectCode: base,
      requestedDeliveryCodes: [
        ...new Set(rows.flatMap((r) => r.requestedDeliveryCodes)),
      ].sort(),
      availableNow:
        inventoryRows.length > 0 &&
        inventoryRows.every(
          (r) =>
            r.availableQuantity !== null && r.availableQuantity !== undefined,
        )
          ? sum(
              inventoryRows.map((r) => ({ quantity: r.availableQuantity })),
            ).toString()
          : Decimal.max(onHand.minus(locked), 0).toString(),
      locked: locked.toString(),
      inTransfer: transfer.toString(),
    });
  }
  return {
    term: query.term,
    snapshotId: snapshot.snapshotId,
    snapshotTime: snapshot.snapshotTime,
    matchedItemCodes: itemCodes,
    availableNow: sum(
      summaries.map((r) => ({ quantity: r.availableNow })),
    ).toString(),
    locked: sum(summaries.map((r) => ({ quantity: r.locked }))).toString(),
    inTransfer: sum(
      summaries.map((r) => ({ quantity: r.inTransfer })),
    ).toString(),
    byBaseProject: summaries,
    warnings: [],
  };
}
