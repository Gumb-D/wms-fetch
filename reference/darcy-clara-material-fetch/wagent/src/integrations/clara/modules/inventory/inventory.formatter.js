const REGION_ALIASES = {
    kl: 'Kuala Lumpur',
    'k.l': 'Kuala Lumpur',
    kuala: 'Kuala Lumpur',
    'kuala lumpur': 'Kuala Lumpur',
    sabah: 'Sabah',
    sarawak: 'Sarawak'
};

export const normalizeClaraText = (value = '') => String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export const splitClaraList = (value = '') => String(value)
    .split(/\s*(?:,|\/|\band\b|\&|\+)\s*/i)
    .map(item => item.trim())
    .filter(Boolean);

export const normalizeClaraRegion = (value = '') => {
    const normalized = normalizeClaraText(value);
    return REGION_ALIASES[normalized] || value.trim();
};

export const normalizeClaraRegions = (regions = []) => {
    const values = Array.isArray(regions) ? regions : splitClaraList(regions);
    return values.map(normalizeClaraRegion).filter(Boolean);
};

export const normalizeClaraProducts = (products = []) => {
    const values = Array.isArray(products) ? products : splitClaraList(products);
    return values
        .map(item => item.replace(/\b(products?|items?|materials?)\b/gi, '').trim())
        .filter(Boolean);
};

const formatItemCode = (row = {}) => row['Item Code'] || row.ItemCode || row.itemCode || '-';

const rowText = (row) => [
    `Region: ${row.Region || '-'}`,
    `Item Code: ${formatItemCode(row)}`,
    `Alias: ${row.Alias || '-'}`,
    `Product: ${row.Product || '-'}`,
    `Qty: ${Number(row.Quantity || 0)}`
].join(' | ');

export function formatClaraAvailableReply({ rows, products, regions }) {
    const regionLabel = regions.length ? regions.join(', ') : 'all regions';
    const productLabel = products.join(', ');

    if (!rows.length) {
        return `No available ${productLabel} found in ${regionLabel}.`;
    }

    const lines = [...rows]
        .sort((a, b) => String(a.Region).localeCompare(String(b.Region)) || String(a.Product).localeCompare(String(b.Product)))
        .slice(0, 25)
        .map((row, index) => `${index + 1}. ${rowText(row)}`);
    const extra = rows.length > lines.length ? `\n\nShowing ${lines.length} of ${rows.length} matches.` : '';

    return `Available ${productLabel} in ${regionLabel}: ${rows.length} match${rows.length === 1 ? '' : 'es'}\n\n${lines.join('\n')}${extra}`;
}

export function formatClaraTotalReply({ rows, products, regions }) {
    const regionLabel = regions.length ? regions.join(', ') : 'all regions';
    const productLabel = products.join(', ');

    if (!rows.length) {
        return `Total ${productLabel} in ${regionLabel}: 0`;
    }

    const groups = new Map();
    let grandTotal = 0;
    for (const row of rows) {
        const region = row.Region || 'Unknown';
        const itemCode = formatItemCode(row);
        const product = row.Product || 'Unknown';
        const key = `${region}||${itemCode}||${product}`;
        const quantity = Number(row.Quantity || 0);
        grandTotal += quantity;
        groups.set(key, (groups.get(key) || 0) + quantity);
    }

    const lines = [...groups.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([key, quantity]) => {
            const [region, itemCode, product] = key.split('||');
            return `- Region: ${region} | Item Code: ${itemCode} | Product: ${product} | Qty: ${quantity}`;
        });

    return `Total ${productLabel} in ${regionLabel}\n${lines.join('\n')}\n\nGrand total: ${grandTotal}`;
}

export function formatClaraHealthReply(health = {}) {
    return health.ok
        ? [
            'Clara native parquet is healthy.',
            `Source: ${health.source || '-'}`,
            `Parquet exists: ${health.parquet_exists ? 'Yes' : 'No'}`,
            `Readable: ${health.parquet_readable ? 'Yes' : 'No'}`,
            `Rows: ${health.row_count ?? '-'}`,
            `Columns: ${health.column_count ?? '-'}`
        ].join('\n')
        : [
            'Clara native parquet health check failed.',
            `Parquet exists: ${health.parquet_exists ? 'Yes' : 'No'}`,
            `Readable: ${health.parquet_readable ? 'Yes' : 'No'}`,
            health.error ? `Error: ${health.error}` : ''
        ].filter(Boolean).join('\n');
}

export function formatClaraColumnsReply(columns = {}) {
    const names = (columns.columns || []).map(column => column.name).filter(Boolean);
    return [
        'Clara columns:',
        names.length ? names.join(', ') : '-',
        `Rows: ${columns.row_count ?? '-'}`
    ].join('\n');
}

export function formatClaraDataReply(data = {}) {
    const rows = Array.isArray(data.rows) ? data.rows : [];
    if (!rows.length) return 'Clara data returned no rows.';
    const lines = rows.slice(0, 10).map((row, index) => `${index + 1}. ${rowText(row)}`);
    const extra = rows.length > lines.length ? `\nShowing ${lines.length} of ${rows.length} returned rows.` : '';
    return `Clara data sample:\n${lines.join('\n')}${extra}`;
}
