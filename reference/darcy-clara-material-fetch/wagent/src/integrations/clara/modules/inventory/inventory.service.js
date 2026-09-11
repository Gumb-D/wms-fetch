import {
    fetchClaraColumns,
    fetchClaraHealth,
    fetchClaraInventoryData,
    fetchClaraInventoryRows
} from './inventory.api.js';
import { getClaraConfigDiagnostics } from '../../core/claraConfig.js';
import {
    formatClaraAvailableReply,
    formatClaraColumnsReply,
    formatClaraDataReply,
    formatClaraHealthReply,
    formatClaraTotalReply,
    normalizeClaraProducts,
    normalizeClaraRegions,
    normalizeClaraText
} from './inventory.formatter.js';

const matchesProduct = (row, product) => {
    const needle = normalizeClaraText(product);
    return [row.Product, row.Alias, row['Item Code']]
        .map(normalizeClaraText)
        .some(value => value.includes(needle));
};

const matchesRegion = (row, region) => normalizeClaraText(row.Region) === normalizeClaraText(region);

const filterRows = (rows, products, regions) => rows.filter(row => {
    const productMatched = products.some(product => matchesProduct(row, product));
    const regionMatched = !regions.length || regions.some(region => matchesRegion(row, region));
    return productMatched && regionMatched;
});

export async function lookupClaraInventory({ mode = 'available', products = [], regions = [], limit } = {}) {
    console.log('[CLARA_SERVICE_ENTER]');
    const normalizedProducts = normalizeClaraProducts(products);
    const normalizedRegions = normalizeClaraRegions(regions);
    const normalizedMode = mode === 'total' ? 'total' : 'available';

    if (!normalizedProducts.length) {
        console.log('[CLARA_SERVICE_EXIT] rows=0');
        return {
            success: false,
            code: 'CLARA_PRODUCT_REQUIRED',
            message: 'What product/item should I check in CLARA inventory?',
            data: null
        };
    }

    const rows = await fetchClaraInventoryRows({ limit });
    const matchedRows = filterRows(rows, normalizedProducts, normalizedRegions);
    const payload = {
        rows: matchedRows,
        products: normalizedProducts,
        regions: normalizedRegions
    };
    const message = normalizedMode === 'total'
        ? formatClaraTotalReply(payload)
        : formatClaraAvailableReply(payload);

    console.log(`[CLARA_SERVICE_EXIT] rows=${matchedRows.length}`);
    return {
        success: true,
        code: 'CLARA_INVENTORY_LOOKUP',
        message,
        data: {
            mode: normalizedMode,
            products: normalizedProducts,
            regions: normalizedRegions,
            rows: matchedRows,
            count: matchedRows.length
        }
    };
}

export async function getClaraHealth() {
    const health = await fetchClaraHealth();
    return {
        success: Boolean(health.ok),
        code: health.ok ? 'CLARA_HEALTH_OK' : 'CLARA_HEALTH_FAILED',
        message: formatClaraHealthReply(health),
        data: { health }
    };
}

export async function getClaraColumns() {
    const columns = await fetchClaraColumns();
    return {
        success: true,
        code: 'CLARA_COLUMNS',
        message: formatClaraColumnsReply(columns),
        data: { columns }
    };
}

export async function getClaraData({ limit = 10, offset = 0 } = {}) {
    const data = await fetchClaraInventoryData({ limit, offset });
    return {
        success: true,
        code: 'CLARA_DATA',
        message: formatClaraDataReply(data),
        data
    };
}

export async function getClaraConfigStatus() {
    const diagnostics = getClaraConfigDiagnostics();
    return {
        success: true,
        code: 'CLARA_CONFIG',
        message: [
            `process.cwd(): ${diagnostics.cwd}`,
            `resolved claraApiDir: ${diagnostics.claraApiDir}`,
            `claraApiDir exists: ${diagnostics.claraApiDirExists}`,
            `api.py exists: ${diagnostics.apiPyExists}`,
            `.env loaded: ${diagnostics.envLoaded}`,
            `CLARA_PARQUET_PATH set: ${diagnostics.CLARA_PARQUET_PATH_set}`,
            `PARQUET_PATH set: ${diagnostics.PARQUET_PATH_set}`,
            `Parquet path exists: ${diagnostics.parquetPathExists}`
        ].join('\n'),
        data: diagnostics
    };
}
