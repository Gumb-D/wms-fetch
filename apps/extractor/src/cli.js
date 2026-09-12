import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildSnapshot,
  publishSnapshot,
} from "@wms/inventory/snapshot-builder";
import { acquireRunLock } from "@wms/runtime/run-lock";
import { runtimeStatus } from "@wms/runtime/status";
import { createCdpRequester } from "./cdp.js";
import { buildPagingParams, runExtraction } from "./wms-client.js";

try {
  process.loadEnvFile();
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const runtime = path.resolve(process.env.WMS_RUNTIME_DIR ?? "runtime");
const output = path.join(runtime, "raw");
const projectConfig = JSON.parse(
  await readFile(
    path.resolve(process.env.WMS_PROJECTS_FILE ?? "projects/celcomdigi.json"),
    "utf8",
  ),
);
const stamp = () =>
  new Date()
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14);
const inventoryFilters = {
  ckbProductType: "1",
  dddeliverCountry: projectConfig.country_code,
  ddckWarehouseName: "",
  cbStock: "",
  cbBin: "",
  taProjectName: "",
  taCostomerName: "",
  taInContractNo: "",
  taContractDeli: "",
  taTaskNo: "",
  taBoxNo: "",
  taMaterialCode: "",
  taSN: "",
  taProjectNo: "",
  taPONumber: "",
  taDeviceDescription: "",
  taProductBigClass: "",
  taProductSmallClass: "",
  taPalletNo: "",
  taDeliveryBatch: "",
  taMaterialName: "",
  ckbFocusField:
    "1000,1100,1200,1210,1220,1230,1240,1250,1300,1310,1400,1500,1600,1700,1900,2000,2200,2300,2400,2500,2510,2520,2530,2540,2550,2600",
  ckbMaterialType: "1,2",
  IsolatedReason: "",
  IsolatedRemark: "",
  taDeviceDescriptionMulti: "",
  taInContractNoMulti: "",
  taTaskNoMulti: "",
  taBoxNoMulti: "",
  taMaterialCodeMulti: "",
  taSNMulti: "",
  taProjectNoMulti: "",
  taPONumberMulti: "",
  taProductBigClassMulti: "",
  taProductSmallClassMulti: "",
  taPalletNoMulti: "",
  taDeliveryBatchMulti: "",
};
const configs = {
  inventory: {
    endpoint:
      "/scm/WMS/WMS_CN809/InventoryManagement/JsonService/InventoryQueryJsonService.ashx",
    grid: "dgInventoryDetail",
    warehouse: "10,40,60",
  },
  transfer: {
    endpoint:
      "/scm/WMS/WMS_CN809/InventoryManagement/JsonService/InventoryQueryJsonService.ashx",
    grid: "dgInventoryDetail",
    warehouse: "50",
  },
  lock: {
    endpoint:
      "/scm/WMS/WMS_CN809/InventoryLock/JsonService/InventoryLockQueryJsonService.ashx",
    grid: "DataGrid",
    referer: "/SCM/WMS/WMS_CN809/InventoryLock/InventoryLockQuery.aspx",
  },
};

async function extract() {
  const runId = stamp();
  const dir = path.join(output, runId);
  await mkdir(dir, { recursive: true });
  const cdp = createCdpRequester();
  const requestPage = ({ project, sourceType, page, pageSize }) => {
    const c = configs[sourceType];
    const filters =
      sourceType === "lock"
        ? {
            ItemType: "2",
            Warehouse: "",
            ckDeliverCountry: projectConfig.country_code,
            ItemNo: "",
            PalletNumber: "",
            BoxNumber: "",
            ItemNum: project,
            Barcode: "",
          }
        : {
            ...inventoryFilters,
            taPreSalesProjNo: project,
            taPreSalesProjNoMulti: project,
            ckbWarehouseType: c.warehouse,
          };
    const params = buildPagingParams({
      sourceType,
      page,
      pageSize,
      employeeNo: process.env.WMS_EMP_NO,
      countryCode: projectConfig.country_code,
    });
    return cdp({
      url: `https://scm.zte.com.cn${c.endpoint}`,
      params,
      body: encodeURIComponent(JSON.stringify(filters)),
    });
  };
  const manifest = await runExtraction({
    projects: projectConfig.projects,
    sourceTypes: projectConfig.exports,
    requestPage,
    runId,
    writeDataset: async ({ project, sourceType, dataset }) => {
      const file = path.join(dir, `${project}_${sourceType}_${runId}.json`);
      await writeFile(file, JSON.stringify(dataset));
      return file;
    },
  });
  await writeFile(
    path.join(dir, `manifest_${runId}.json`),
    JSON.stringify(manifest, null, 2),
  );
  if (manifest.summary.failed)
    throw new Error(
      `Extraction failed for ${manifest.summary.failed} dataset(s)`,
    );
  return dir;
}
async function refresh() {
  const lock = await acquireRunLock(runtime);
  try {
    const dir = await extract();
    return publishSnapshot(await buildSnapshot(dir), runtime);
  } finally {
    await lock.release();
  }
}
const command = process.argv[2];
if (command === "extract") console.log(await extract());
else if (command === "build-snapshot") {
  const dir = process.argv[3];
  if (!dir)
    throw new Error("Usage: npm run build-snapshot -- <batch-directory>");
  console.log(
    await publishSnapshot(await buildSnapshot(path.resolve(dir)), runtime),
  );
} else if (command === "refresh") console.log(await refresh());
else if (command === "status")
  console.log(JSON.stringify(await runtimeStatus(runtime), null, 2));
else
  throw new Error(
    "Command must be extract, build-snapshot, refresh, or status",
  );
