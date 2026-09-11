import { getClaraConfig } from '../src/integrations/clara/core/claraConfig.js';

const DEFAULT_CLARA_API_URL = 'http://localhost:8010';
const DEFAULT_LIMIT = 10000;
const REGION_ALIASES = {
    kl: 'Kuala Lumpur',
    'k.l': 'Kuala Lumpur',
    kuala: 'Kuala Lumpur',
    'kuala lumpur': 'Kuala Lumpur',
    sabah: 'Sabah',
    sarawak: 'Sarawak'
};

const normalize = (value = '') => String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const splitList = (value = '') => String(value)
    .split(/\s*(?:,|\/|\band\b|\&|\+)\s*/i)
    .map(item => item.trim())
    .filter(Boolean);

const normalizeRegion = (value = '') => {
    const normalized = normalize(value);
    return REGION_ALIASES[normalized] || value.trim();
};

const title = (value = '') => value
    .toString()
    .trim()
    .replace(/\w\S*/g, word => word[0].toUpperCase() + word.slice(1).toLowerCase());

const parseInventoryCommand = (input = '') => {
    const match = input.trim().match(/\bcheck\s+(available|total)\s+(.+?)\s+in\s+(.+?)\s*$/i);
    if (!match) return null;

    const mode = match[1].toLowerCase();
    const products = splitList(match[2])
        .map(item => item.replace(/\b(products?|items?|materials?)\b/gi, '').trim())
        .filter(Boolean);
    const rawRegions = match[3].trim();
    const regions = /\b(all|any|every)\s+regions?\b/i.test(rawRegions)
        ? []
        : splitList(rawRegions).map(normalizeRegion).filter(Boolean);

    if (!products.length) return null;

    return { mode, products, regions };
};

const formatItemCode = (row = {}) => row['Item Code'] || row.ItemCode || row.itemCode || '-';

const rowText = (row) => [
    `Region: ${row.Region || '-'}`,
    `Item Code: ${formatItemCode(row)}`,
    `Alias: ${row.Alias || '-'}`,
    `Product: ${row.Product || '-'}`,
    `Qty: ${Number(row.Quantity || 0)}`
].join(' | ');

const matchesProduct = (row, product) => {
    const needle = normalize(product);
    return [row.Product, row.Alias, row['Item Code']]
        .map(normalize)
        .some(value => value.includes(needle));
};

const matchesRegion = (row, region) => normalize(row.Region) === normalize(region);

async function fetchClaraRows() {
    const config = getClaraConfig();
    const baseUrl = (config.baseUrl || DEFAULT_CLARA_API_URL).replace(/\/+$/, '');
    const token = config.token || '';
    if (!token) {
        throw new Error('CLARA_API_TOKEN is not configured in Darcy .env.');
    }

    const url = `${baseUrl}/api/data?limit=${DEFAULT_LIMIT}&offset=0`;
    let response;
    try {
        response = await fetch(url, {
            headers: { Authorization: `Bearer ${token}` }
        });
    } catch (error) {
        throw new Error(`CLARA API is not reachable at ${baseUrl}. Start clara-api with: python api.py`);
    }

    const data = await response.json().catch(() => null);

    if (!response.ok) {
        throw new Error(data?.error || `CLARA API returned HTTP ${response.status}`);
    }

    return Array.isArray(data?.rows) ? data.rows : [];
}

const filterRows = (rows, products, regions) => rows.filter(row => {
    const productMatched = products.some(product => matchesProduct(row, product));
    const regionMatched = !regions.length || regions.some(region => matchesRegion(row, region));
    return productMatched && regionMatched;
});

const formatAvailableReply = ({ rows, products, regions }) => {
    const regionLabel = regions.length ? regions.join(', ') : 'all regions';
    const productLabel = products.join(', ');

    if (!rows.length) {
        return `No available ${productLabel} found in ${regionLabel}.`;
    }

    const lines = rows
        .sort((a, b) => String(a.Region).localeCompare(String(b.Region)) || String(a.Product).localeCompare(String(b.Product)))
        .slice(0, 25)
        .map((row, index) => `${index + 1}. ${rowText(row)}`);
    const extra = rows.length > lines.length ? `\n\nShowing ${lines.length} of ${rows.length} matches.` : '';

    return `Available ${productLabel} in ${regionLabel}: ${rows.length} match${rows.length === 1 ? '' : 'es'}\n\n${lines.join('\n')}${extra}`;
};

const formatTotalReply = ({ rows, products, regions }) => {
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
};

export async function lookupClaraInventory(settings) {
    const products = Array.isArray(settings.products) ? settings.products : splitList(settings.products);
    const regions = Array.isArray(settings.regions)
        ? settings.regions.map(normalizeRegion).filter(Boolean)
        : splitList(settings.regions).map(normalizeRegion).filter(Boolean);
    const mode = settings.mode === 'total' ? 'total' : 'available';

    if (!products.length) throw new Error('Please provide product name, alias, or item code.');

    const rows = await fetchClaraRows();
    const matchedRows = filterRows(rows, products, regions);
    const payload = { rows: matchedRows, products, regions };
    return mode === 'total' ? formatTotalReply(payload) : formatAvailableReply(payload);
}

export const claraInventoryTask = {
    id: 'clara_inventory_lookup',
    name: 'CLARA Inventory Lookup',
    defaultCron: '0 9 * * *',
    defaultEnabled: false,
    defaultSettings: {
        targetGroup: '',
        mode: 'available',
        products: '',
        regions: ''
    },
    fields: {
        targetGroup: { label: 'Target group', type: 'group', required: true },
        mode: {
            label: 'Mode',
            type: 'select',
            required: true,
            options: [
                { value: 'available', label: 'Available' },
                { value: 'total', label: 'Total' }
            ]
        },
        products: { label: 'Products', type: 'text', required: true, placeholder: 'RRU, battery' },
        regions: { label: 'Regions', type: 'text', required: false, placeholder: 'Sabah, Sarawak, KL' }
    },
    canHandle(input) {
        return Boolean(parseInventoryCommand(input));
    },
    parse(input) {
        return parseInventoryCommand(input);
    },
    async handle(input) {
        const parsed = parseInventoryCommand(input);
        if (!parsed) {
            return {
                reply: 'Use: check available <product> in <region> or check total <product> in <region>.',
                category: 'clara_inventory'
            };
        }

        try {
            return {
                reply: await lookupClaraInventory(parsed),
                category: 'clara_inventory',
                task: {
                    type: 'clara_inventory_lookup',
                    ...parsed
                }
            };
        } catch (error) {
            return {
                reply: `I couldn't check CLARA inventory right now. ${error.message}`,
                category: 'clara_inventory',
                task: {
                    type: 'clara_inventory_lookup',
                    ...parsed,
                    error: error.message
                }
            };
        }
    },
    async execute(context, settings) {
        const reply = await lookupClaraInventory(settings);
        if (settings.targetGroup) {
            const { sendTextToGroup } = await import('./taskUtils.js');
            await sendTextToGroup(context, settings.targetGroup, reply);
        }
        return reply;
    }
};
