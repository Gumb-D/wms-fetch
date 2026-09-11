import {
    getClaraColumns,
    getClaraConfigStatus,
    getClaraData,
    getClaraHealth,
    lookupClaraInventory
} from './inventory.service.js';
import { normalizeClaraProducts, normalizeClaraRegions } from './inventory.formatter.js';

const validateClaraInventoryArgs = (args = {}) => {
    const products = normalizeClaraProducts(
        args.products
        || args.product
        || args.materialCode
        || args.itemCode
        || args.materialName
        || args.itemName
        || args.query
        || args.keyword
        || []
    );
    const regions = normalizeClaraRegions(args.regions || args.region || []);
    if (!products.length) {
        return {
            ok: false,
            error: 'clara.inventory.lookup requires products.'
        };
    }
    return {
        ok: true,
        value: {
            mode: args.mode === 'total' ? 'total' : 'available',
            products,
            regions,
            limit: args.limit
        }
    };
};

export const claraInventoryTools = {
    'clara.config': {
        intent: 'clara.config',
        description: 'Read redacted Clara configuration diagnostics.',
        readOnly: true,
        validate() {
            return { ok: true, value: {} };
        },
        async execute() {
            return getClaraConfigStatus();
        }
    },

    'clara.health': {
        intent: 'clara.health',
        description: 'Read Clara API health status.',
        readOnly: true,
        validate() {
            return { ok: true, value: {} };
        },
        async execute() {
            return getClaraHealth();
        }
    },

    'clara.inventory.columns': {
        intent: 'clara.inventory.columns',
        description: 'Read Clara inventory column metadata.',
        readOnly: true,
        validate() {
            return { ok: true, value: {} };
        },
        async execute() {
            return getClaraColumns();
        }
    },

    'clara.inventory.data': {
        intent: 'clara.inventory.data',
        description: 'Read a small Clara inventory data sample.',
        readOnly: true,
        validate(args = {}) {
            return {
                ok: true,
                value: {
                    limit: Number(args.limit || 10) || 10,
                    offset: Number(args.offset || 0) || 0,
                    search: (args.search || args.filter || args.query || '').toString().trim(),
                    filter: (args.filter || args.search || args.query || '').toString().trim()
                }
            };
        },
        async execute(args = {}) {
            return getClaraData(args);
        }
    },

    'clara.inventory.lookup': {
        intent: 'clara.inventory.lookup',
        description: 'Read available or total CLARA inventory by product and optional region.',
        readOnly: true,
        validate: validateClaraInventoryArgs,
        async execute(args = {}) {
            console.log(`[CLARA_TOOL_ENTER] products=${(args.products || []).join(',')} regions=${(args.regions || []).join(',')}`);
            const result = await lookupClaraInventory(args);
            console.log(`[CLARA_TOOL_EXIT] rows=${result.data?.count ?? 0}`);
            return result;
        }
    }
};
