import { z } from "zod";

export const sourceRowSchema = z.preprocess(
  (value) =>
    value && typeof value === "object"
      ? {
          ...value,
          ItemCode: value.ItemCode ?? value["Item Code"] ?? value.MaterialCode,
          Product:
            value.Product ?? value.MaterialName ?? value["Material Name"],
          Warehouse: value.Warehouse ?? value["Warehouse Name"],
          Quantity:
            value.Quantity ??
            value["Inventory Qty"] ??
            value["Lock Qty"] ??
            value["Transfer Qty"],
          AvailableQuantity: value.AvailableQuantity ?? value["Available Qty"],
        }
      : value,
  z
    .object({
      ItemCode: z.union([z.string(), z.number()]).transform(String),
      Product: z.union([z.string(), z.number()]).transform(String),
      Alias: z.union([z.string(), z.number()]).transform(String).optional(),
      Region: z.union([z.string(), z.number()]).transform(String).optional(),
      Warehouse: z.union([z.string(), z.number()]).transform(String).optional(),
      Quantity: z.union([z.string(), z.number()]).transform(String),
      AvailableQuantity: z
        .union([z.string(), z.number()])
        .transform(String)
        .optional(),
    })
    .passthrough(),
);

export const datasetSchema = z
  .object({
    project: z.string().min(1),
    query_project: z.string().min(1),
    export: z.enum(["inventory", "transfer", "lock"]),
    total: z.number().int().nonnegative(),
    fetched_rows: z.number().int().nonnegative(),
    fetched_at: z.string().min(1),
    cache_hit: z.boolean().optional(),
    rows: z.array(sourceRowSchema),
  })
  .passthrough();

export const manifestSchema = z
  .object({
    run_id: z.string().min(1),
    started_at: z.string().min(1),
    finished_at: z.string().min(1),
    summary: z.object({
      total: z.number().int(),
      ok: z.number().int(),
      failed: z.number().int(),
      skipped: z.number().int(),
    }),
    results: z.array(
      z
        .object({
          project: z.string(),
          query_project: z.string(),
          export: z.enum(["inventory", "transfer", "lock"]),
          status: z.enum(["ok", "failed", "skipped"]),
          file: z.string().optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export const inventoryRequestSchema = z
  .object({
    term: z.string().trim().min(1).max(100),
    project_codes: z.array(z.string().trim().min(1)).max(20).default([]),
    region: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .nullable()
      .optional()
      .default(null),
  })
  .strict();
