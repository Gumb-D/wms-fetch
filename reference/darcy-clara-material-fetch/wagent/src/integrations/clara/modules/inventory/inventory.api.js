import fs from 'fs';
import { asyncBufferFromFile, parquetMetadataAsync, parquetReadObjects, parquetSchema } from 'hyparquet';
import { getClaraConfig } from '../../core/claraConfig.js';

const CLARA_COLUMNS = ['Region', 'Item Code', 'Alias', 'Product', 'Quantity', 'Stock Category', 'Available Qty'];

let cache = {
    path: '',
    mtimeMs: 0,
    size: 0,
    metadata: null,
    columns: [],
    rows: null
};

const normalizeText = (value = '') => String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const safeValue = (value) => {
    if (typeof value === 'bigint') return Number(value);
    if (value instanceof Date) return value.toISOString();
    return value ?? '';
};

const normalizeRow = (row = {}) => ({
    Region: safeValue(row.Region),
    'Item Code': safeValue(row['Item Code']),
    Alias: safeValue(row.Alias),
    Product: safeValue(row.Product),
    Quantity: Number(row.Quantity ?? row['Available Qty'] ?? row['Inventory Qty'] ?? 0) || 0,
    'Stock Category': safeValue(row['Stock Category']),
    'Available Qty': Number(row['Available Qty'] ?? row.Quantity ?? 0) || 0
});

const isAvailableRow = (row = {}) => {
    const stockCategory = normalizeText(row['Stock Category']);
    if (stockCategory) return stockCategory === 'available';
    if (row['Available Material'] !== undefined) return Boolean(row['Available Material']);
    return true;
};

const rowMatchesSearch = (row = {}, search = '') => {
    const needle = normalizeText(search);
    if (!needle) return true;
    return ['Region', 'Item Code', 'Alias', 'Product'].some(key => normalizeText(row[key]).includes(needle));
};

async function readMetadata(parquetPath) {
    const file = await asyncBufferFromFile(parquetPath);
    const metadata = await parquetMetadataAsync(file);
    const schema = parquetSchema(metadata);
    return {
        file,
        metadata,
        columns: (schema.children || []).map(child => child.element?.name).filter(Boolean)
    };
}

async function ensureMetadata() {
    const config = getClaraConfig();
    const parquetPath = config.parquetPath;
    const stat = fs.statSync(parquetPath);
    if (cache.path === parquetPath && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size && cache.metadata) {
        return cache;
    }

    const { metadata, columns } = await readMetadata(parquetPath);
    cache = {
        path: parquetPath,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        metadata,
        columns,
        rows: null
    };
    return cache;
}

async function readAvailableRows() {
    const current = await ensureMetadata();
    if (current.rows) return current.rows;

    const file = await asyncBufferFromFile(current.path);
    const columns = CLARA_COLUMNS.filter(column => current.columns.includes(column));
    const rows = await parquetReadObjects({ file, columns });
    current.rows = rows
        .filter(isAvailableRow)
        .map(normalizeRow);
    return current.rows;
}

function applyDataFilters(rows = [], { limit, offset = 0, search = '', filter = '' } = {}) {
    const query = search || filter;
    const matched = rows.filter(row => rowMatchesSearch(row, query));
    const start = Math.max(0, Number(offset || 0) || 0);
    const size = Math.max(0, Number(limit || 0) || 0);
    return {
        total: rows.length,
        filtered: matched.length,
        rows: size ? matched.slice(start, start + size) : matched.slice(start)
    };
}

export async function fetchClaraHealth() {
    const config = getClaraConfig();
    const parquetPath = config.parquetPath;
    let stat;
    try {
        stat = fs.statSync(parquetPath);
        fs.accessSync(parquetPath, fs.constants.R_OK);
        const current = await ensureMetadata();
        return {
            ok: true,
            source: 'native-parquet',
            parquet_exists: true,
            parquet_readable: true,
            row_count: Number(current.metadata.num_rows || 0),
            column_count: current.columns.length,
            size_bytes: stat.size,
            mtime: stat.mtime.toISOString()
        };
    } catch (error) {
        return {
            ok: false,
            source: 'native-parquet',
            parquet_exists: fs.existsSync(parquetPath),
            parquet_readable: false,
            error: error.message
        };
    }
}

export async function fetchClaraColumns() {
    const current = await ensureMetadata();
    return {
        columns: current.columns.map(name => ({ name })),
        row_count: Number(current.metadata.num_rows || 0),
        source: 'native-parquet'
    };
}

export async function fetchClaraInventoryRows({ limit } = {}) {
    const config = getClaraConfig();
    const rows = await readAvailableRows();
    const size = Math.max(0, Number(limit || config.limit || 0) || 0);
    return size ? rows.slice(0, size) : rows;
}

export async function fetchClaraInventoryData({ limit, offset = 0, search = '', filter = '' } = {}) {
    const config = getClaraConfig();
    const rows = await readAvailableRows();
    const result = applyDataFilters(rows, {
        limit: limit || config.limit,
        offset,
        search,
        filter
    });
    return {
        source: 'native-parquet',
        total: result.total,
        filtered: result.filtered,
        rows: result.rows
    };
}
