import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import Decimal from "decimal.js";
import { datasetSchema, manifestSchema } from "@wms/contracts";

const fail = (code, message) => Object.assign(new Error(message), { code });
const hash = (value) => createHash("sha256").update(value).digest("hex");

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw fail(
      "SCHEMA_MISMATCH",
      `Invalid JSON: ${path.basename(file)} (${error.message})`,
    );
  }
}

export async function buildSnapshot(batchDir, options = {}) {
  let rawManifest = options.manifest;
  let manifestPath;
  if (!rawManifest) {
    const { readdir } = await import("node:fs/promises");
    const names = (await readdir(batchDir))
      .filter((name) => /^manifest_.*\.json$/.test(name))
      .sort();
    if (names.length !== 1)
      throw fail("INVALID_BATCH", "Batch must contain exactly one manifest");
    manifestPath = path.join(batchDir, names[0]);
    rawManifest = await readJson(manifestPath);
  }
  const parsedManifest = manifestSchema.safeParse(rawManifest);
  if (!parsedManifest.success)
    throw fail("SCHEMA_MISMATCH", "Extraction manifest schema mismatch");
  const manifest = parsedManifest.data;
  if (
    manifest.summary.failed ||
    manifest.summary.skipped ||
    manifest.summary.ok !== manifest.summary.total ||
    manifest.results.some((r) => r.status !== "ok")
  ) {
    throw fail(
      "INVALID_BATCH",
      "Only a complete successful extraction batch can be published",
    );
  }

  const required = new Map();
  for (const result of manifest.results) {
    const key = `${result.query_project}:${result.export}`;
    const entry = required.get(key) ?? { result, deliveryCodes: [] };
    entry.deliveryCodes.push(result.project);
    required.set(key, entry);
  }
  const bases = [...new Set(manifest.results.map((r) => r.query_project))];
  for (const base of bases)
    for (const source of ["inventory", "lock", "transfer"]) {
      if (!required.has(`${base}:${source}`))
        throw fail("INVALID_BATCH", `Missing ${source} dataset for ${base}`);
    }

  const records = [];
  const sourceFiles = [];
  const timestamps = new Set();
  for (const { result, deliveryCodes } of required.values()) {
    const file = path.join(batchDir, path.basename(result.file));
    const bytes = await readFile(file);
    const parsed = datasetSchema.safeParse(JSON.parse(bytes.toString("utf8")));
    if (!parsed.success)
      throw fail(
        "SCHEMA_MISMATCH",
        `Dataset schema mismatch: ${path.basename(file)}`,
      );
    const dataset = parsed.data;
    if (
      dataset.total !== dataset.fetched_rows ||
      dataset.rows.length !== dataset.total
    )
      throw fail(
        "TOTAL_MISMATCH",
        `Dataset row count mismatch: ${path.basename(file)}`,
      );
    if (
      dataset.query_project !== result.query_project ||
      dataset.export !== result.export
    )
      throw fail(
        "CONFLICTING_DATASET",
        `Dataset identity mismatch: ${path.basename(file)}`,
      );
    timestamps.add(dataset.fetched_at);
    sourceFiles.push({
      file: path.basename(file),
      sha256: hash(bytes),
      rows: dataset.rows.length,
    });
    const codes = [...new Set(deliveryCodes)].sort();
    for (const row of dataset.rows) {
      try {
        new Decimal(row.Quantity);
      } catch {
        throw fail(
          "SCHEMA_MISMATCH",
          `Invalid quantity in ${path.basename(file)}`,
        );
      }
      records.push({
        snapshotId: manifest.run_id,
        sourceType: dataset.export,
        baseProjectCode: dataset.query_project,
        requestedDeliveryCodes: codes,
        itemCode: row.ItemCode.trim(),
        product: row.Product.trim(),
        alias: row.Alias?.trim() || null,
        region: row.Region?.trim() || null,
        warehouse: row.Warehouse?.trim() || null,
        quantity: new Decimal(row.Quantity).toString(),
        availableQuantity:
          dataset.export === "inventory" && row.AvailableQuantity !== undefined
            ? new Decimal(row.AvailableQuantity).toString()
            : null,
      });
    }
  }
  if (timestamps.size !== 1)
    throw fail(
      "MIXED_TIMESTAMPS",
      "Datasets do not share one source timestamp",
    );
  return {
    schemaVersion: 1,
    snapshotId: manifest.run_id || randomUUID(),
    snapshotTime: [...timestamps][0],
    publishedAt: new Date().toISOString(),
    baseProjects: bases.sort(),
    records,
    manifest: {
      status: "verified",
      sourceFiles,
      requestedDeliveryCodes: [
        ...new Set(manifest.results.map((r) => r.project)),
      ].sort(),
    },
  };
}

export async function publishSnapshot(snapshot, runtimeDir) {
  const immutableDir = path.join(runtimeDir, "snapshots", snapshot.snapshotId);
  await mkdir(immutableDir, { recursive: true });
  const dataPath = path.join(immutableDir, "inventory.json");
  const manifestPath = path.join(immutableDir, "manifest.json");
  await writeFile(`${dataPath}.tmp`, `${JSON.stringify(snapshot)}\n`, {
    flag: "wx",
  });
  await rename(`${dataPath}.tmp`, dataPath);
  await writeFile(
    manifestPath,
    `${JSON.stringify(snapshot.manifest, null, 2)}\n`,
    { flag: "wx" },
  );
  const pointer = {
    snapshotId: snapshot.snapshotId,
    path: dataPath,
    publishedAt: snapshot.publishedAt,
  };
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(
    path.join(runtimeDir, "current.json.tmp"),
    `${JSON.stringify(pointer)}\n`,
  );
  await rename(
    path.join(runtimeDir, "current.json.tmp"),
    path.join(runtimeDir, "current.json"),
  );
  return pointer;
}

export async function loadCurrentSnapshot(runtimeDir) {
  try {
    const pointer = await readJson(path.join(runtimeDir, "current.json"));
    return await readJson(pointer.path);
  } catch (error) {
    if (error.code === "SCHEMA_MISMATCH") throw error;
    throw fail("NO_VALID_SNAPSHOT", "No valid inventory snapshot");
  }
}
