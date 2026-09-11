import { normalizeCommand } from './commandNormalizer.js';

export const DEFAULT_INTENT_CONFIDENCE_THRESHOLD = 0.75;
export const PENDING_MCP_INTENT_TTL_MS = 5 * 60 * 1000;

export const mcpReadToolMetadata = [
    {
        intent: 'order.list',
        aliases: ['orders', 'work orders', 'order list'],
        keywords: ['show', 'list', 'check', 'what', 'pending', 'active', 'open', 'completed', 'overdue'],
        requiredArgs: [],
        examples: ['show active orders', 'what orders are pending', 'list orders'],
        clarification: 'Which order list should I show? For example: active, pending, completed, or overdue.'
    },
    {
        intent: 'order.detail',
        aliases: ['order', 'work order', 'wo status', 'order status'],
        keywords: ['status', 'detail', 'show', 'check', 'how'],
        requiredArgs: ['orderRef'],
        examples: ['status WO-000001', 'how is WO-000001'],
        clarification: 'Which work order ID should I check? Example: WO-000004'
    },
    {
        intent: 'iepms.mos.lookup',
        aliases: ['mos', 'rollout', 'progress', 'iepms progress'],
        keywords: ['mos', 'rollout', 'progress', 'progressing', 'iepms'],
        requiredArgs: ['site'],
        examples: ['check mos progress for NOSO', 'how is NOSO progressing'],
        clarification: 'Sure, which site/area should I check MOS for?'
    },
    {
        intent: 'iepms.doDn.material.check',
        aliases: ['do material', 'dn material', 'do dn', 'released material'],
        keywords: ['do', 'dn', 'dodn', 'released', 'release', 'outbound', 'delivery'],
        requiredArgs: [],
        examples: [
            'how many R8894E released in Sabah',
            'how many RRU released in Sarawak',
            'total BBU V9200 released for site ABC001'
        ],
        clarification: 'Which material do you want me to check? Example: R8894E, RRU, BBU V9200.'
    },
    {
        intent: 'clara.inventory.lookup',
        aliases: ['clara', 'inventory', 'stock', 'available', 'quantity', 'parquet', 'latest_merged_data'],
        keywords: ['clara', 'inventory', 'stock', 'available', 'material', 'parquet', 'latest_merged_data', 'total', 'qty', 'quantity'],
        requiredArgs: ['products'],
        examples: ['check available RRU in Sabah', 'do we have battery in Sarawak'],
        clarification: 'What product/item should I check in CLARA inventory?'
    }
];

const statusFromText = (normalized) => {
    if (/\b(?:active|open|still\s+open)\b/i.test(normalized.text)) return 'active';
    if (/\bpending\b/i.test(normalized.text)) return 'pending';
    if (/\bcompleted?\b/i.test(normalized.text)) return 'completed';
    if (/\boverdue\b/i.test(normalized.text)) return 'overdue';
    return '';
};

const latestSiteCandidate = (normalized) => normalized.siteCandidates.at(-1) || '';

const locationPattern = '(sabah|sarawak|central|northern|southern|eastern|klang\\s+valley|kv|east\\s+malaysia|west\\s+malaysia|kl|k\\.l|kuala\\s+lumpur|all\\s+regions?)';
const regionPattern = locationPattern;

const cleanProductText = (value = '') => value
    .replace(/\b(?:clara|inventory|stock|available|total|qty|quantity|product|products|item|items|material|materials|parquet|latest_merged_data)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const cleanDoDnMaterialText = (value = '') => value
    .replace(/\b(?:iepms|released|release|outbound|do|dn|dodn|delivery|material|materials|item|items|qty|quantity|total|check|show|get|how\s+many|how\s+much|available|for|at|in|site)\b/gi, ' ')
    .replace(/[,:;?]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const stripTrailingLocation = (value = '') => value
    .replace(new RegExp(`\\s+(?:in|at|for)\\s+${locationPattern}\\s*$`, 'i'), ' ')
    .replace(/\s+/g, ' ')
    .trim();

const looksLikeAmbiguousSiteOrItem = (value = '') => /^[A-Z]{2,}\d{2,}$/i.test(value.trim());
const looksLikeAmbiguousShortMaterial = (value = '') => /^[A-Z]{3}$/i.test(value.trim()) && !['RRU', 'BBU'].includes(value.trim().toUpperCase());

const parseClaraInventoryArgs = (normalized) => {
    const text = normalized.text;
    const patterns = [
        /\b(?:parquet|latest_merged_data)\s+(?:inventory\s+)?(.+?)\s*$/i,
        new RegExp(`\\b(?:inventory|stock|parquet|latest_merged_data)\\s+(?:available\\s+)?(?:for\\s+)?(.+?)\\s+in\\s+${regionPattern}\\s*$`, 'i'),
        new RegExp(`\\b(?:material|item)\\s+available\\s+(.+?)\\s+in\\s+${regionPattern}\\s*$`, 'i'),
        new RegExp(`\\b(?:is|any|available)\\s+(.+?)\\s+(?:available|in\\s+stock)\\s+in\\s+${regionPattern}\\s*$`, 'i'),
        new RegExp(`\\bcheck\\s+(available|total)\\s+(.+?)\\s+in\\s+${regionPattern}\\s*$`, 'i'),
        new RegExp(`\\b(available|total)\\s+(.+?)\\s+in\\s+${regionPattern}\\s*$`, 'i'),
        new RegExp(`\\b(?:do\\s+we\\s+have|any|check|show)\\s+(.+?)\\s+in\\s+${regionPattern}\\s*$`, 'i'),
        new RegExp(`\\bclara\\s+(?:inventory\\s+)?(.+?)\\s+in\\s+${regionPattern}\\s*$`, 'i'),
        /\b(?:check|show)\s+clara\s+(?:inventory\s+)?(.+?)\s*$/i
    ];

    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (!match) continue;
        const hasMode = /available|total/i.test(match[1]);
        const mode = hasMode ? match[1].toLowerCase() : (/\btotal|qty|quantity\b/i.test(text) ? 'total' : 'available');
        const productText = cleanProductText(hasMode ? match[2] : match[1]);
        const regionText = hasMode ? match[3] : match[2];
        const regions = regionText && !/\ball\s+regions?\b/i.test(regionText) ? [regionText] : [];
        return {
            mode,
            products: productText ? [productText] : [],
            regions
        };
    }

    if (/\b(?:clara|inventory|stock|parquet|latest_merged_data)\b/i.test(text) && /\b(?:check|show|available|total|qty|quantity|material|item)\b/i.test(text)) {
        return {
            mode: /\btotal|qty|quantity\b/i.test(text) ? 'total' : 'available',
            products: [cleanProductText(text)].filter(Boolean),
            regions: []
        };
    }

    return null;
};

const parseDoDnMaterialArgs = (normalized) => {
    const text = normalized.text;
    const isDoDnLike = /\b(?:released|release|outbound|delivery\s+order|delivery\s+note|\bdo\b|\bdn\b|dodn)\b/i.test(text)
        && /\b(?:how\s+many|how\s+much|total|qty|quantity|check|show|get|material|item)\b/i.test(text);
    if (!isDoDnLike) {
        return null;
    }

    const siteMatch = text.match(/\b(?:for|at|in)\s+site\s+([a-z0-9_-]+)\b/i)
        || text.match(/\bsite\s+([a-z0-9_-]+)\b/i);
    const locationMatch = text.match(new RegExp(`\\b(?:in|at|for)\\s+${locationPattern}\\b`, 'i'));
    const location = locationMatch && !/\ball\s+regions?\b/i.test(locationMatch[1])
        ? locationMatch[1].replace(/\s+/g, ' ').trim()
        : '';

    const siteOnly = text.match(/^check\s+material\s+released\s+for\s+site\s+([a-z0-9_-]+)\s*$/i)
        || text.match(/^material\s+released\s+for\s+site\s+([a-z0-9_-]+)\s*$/i);
    if (siteOnly) {
        return {
            itemKeyword: '',
            location: '',
            siteCode: siteOnly[1].toUpperCase(),
            matchMode: 'contains',
            confidence: 0.95
        };
    }

    const patterns = [
        /\b(?:how\s+many|how\s+much|total|qty|quantity)\s+(.+?)\s+(?:released|release|outbound)(?:\s+(?:in|at|for)\s+.+?)?[?.!]*\s*$/i,
        /\b(?:check|show|get)\s+(.+?)\s+(?:released|release|outbound)(?:\s+(?:in|at|for)\s+.+?)?[?.!]*\s*$/i,
        /\b(?:check|show|get|total|how\s+many|how\s+much)\s+(?:released\s+)?(?:do|dn|dodn)\s+(?:material|item|qty|quantity)\s+(.+?)(?:\s+(?:at|in|for)\s+.+?)?[?.!]*\s*$/i,
        /\b(?:do|dn|dodn)\s+(?:material|item|qty|quantity)\s+(.+?)(?:\s+(?:at|in|for)\s+.+?)?[?.!]*\s*$/i,
        /\b(?:material|item)\s+(.+?)\s+(?:do|dn|dodn)\s+(?:qty|quantity|total)(?:\s+(?:at|in|for)\s+.+?)?[?.!]*\s*$/i
    ];

    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (!match) continue;
        const material = cleanDoDnMaterialText(stripTrailingLocation(match[1]));
        const siteCode = siteMatch ? siteMatch[1].toUpperCase() : '';
        if (!material) {
            return {
                itemKeyword: '',
                location,
                siteCode,
                matchMode: 'contains',
                needsClarification: true,
                clarification: location
                    ? `Which material do you want me to check in ${location}? Example: R8894E, RRU, BBU V9200.`
                    : 'Which material do you want me to check? Example: R8894E, RRU, BBU V9200.'
            };
        }

        if (looksLikeAmbiguousSiteOrItem(material) && !location && !siteCode) {
            return {
                itemKeyword: material,
                location: '',
                siteCode: '',
                matchMode: 'contains',
                needsClarification: true,
                verificationKind: 'site_or_material',
                clarification: `I need to confirm: is "${material}" a site code or material keyword?\nReply:\n1. Site code\n2. Material keyword`
            };
        }

        if (!location && !siteCode) {
            return {
                itemKeyword: material,
                location: '',
                siteCode: '',
                matchMode: 'contains',
                needsClarification: true,
                verificationKind: 'missing_location',
                clarification: `Do you want me to check ${material} across all regions, or only for a specific region/site?\nExample: Sabah, Sarawak, or site ABC001.`
            };
        }

        if (looksLikeAmbiguousSiteOrItem(material) && !siteCode) {
            return {
                itemKeyword: material,
                location,
                siteCode: '',
                matchMode: 'contains',
                needsClarification: true,
                verificationKind: 'site_or_material',
                clarification: `I need to confirm: is "${material}" a site code or material keyword?\nReply:\n1. Site code\n2. Material keyword`
            };
        }

        if (looksLikeAmbiguousShortMaterial(material)) {
            return {
                itemKeyword: material,
                location,
                siteCode,
                matchMode: 'contains',
                needsClarification: true,
                verificationKind: 'confirm_keyword',
                clarification: `Do you mean material keyword "${material}"${location ? ` released in ${location}` : ''}?\nReply yes to continue, or send the correct material keyword.`
            };
        }

        return {
            itemKeyword: material,
            location,
            siteCode,
            matchMode: 'contains',
            confidence: 0.95
        };
    }

    return {
        itemKeyword: '',
        location,
        siteCode: siteMatch ? siteMatch[1].toUpperCase() : '',
        matchMode: 'contains',
        needsClarification: true,
        clarification: location
            ? `Which material do you want me to check in ${location}? Example: R8894E, RRU, BBU V9200.`
            : 'Which material do you want me to check? Example: R8894E, RRU, BBU V9200.'
    };
};

const completeDecision = (decision) => {
    const metadata = mcpReadToolMetadata.find(tool => tool.intent === decision.intent);
    const missingArgs = (metadata?.requiredArgs || []).filter(arg => {
        const value = decision.args?.[arg];
        if (Array.isArray(value)) return value.length === 0;
        return !value;
    });
    return {
        ...decision,
        metadata,
        missingArgs,
        needsClarification: Boolean(decision.needsClarification || missingArgs.length),
        clarification: decision.clarification || metadata?.clarification || ''
    };
};

export function detectReadOnlyIntent(input = '', options = {}) {
    const normalized = normalizeCommand(input, options);
    const { text, lowerText, orderRef } = normalized;

    if (orderRef && /\b(?:status|detail|show|check|how\s+is)\b[\s\S]*\bWO-\d{6}\b/i.test(text)) {
        return completeDecision({
            matched: true,
            intent: 'order.detail',
            args: { orderRef },
            confidence: 0.94,
            source: 'metadata_rules',
            normalized
        });
    }

    if (!orderRef && /\b(?:show|check|get)\b[\s\S]*\border\s+status\b/i.test(text)) {
        return completeDecision({
            matched: true,
            intent: 'order.detail',
            args: {},
            confidence: 0.86,
            source: 'metadata_rules',
            normalized
        });
    }

    if (/\border(?:s)?\b/i.test(text) && /\b(?:show|list|check|what|open|pending|active|completed|overdue|still)\b/i.test(text)) {
        return completeDecision({
            matched: true,
            intent: 'order.list',
            args: { statusFilter: statusFromText(normalized) },
            confidence: 0.9,
            source: 'metadata_rules',
            normalized
        });
    }

    const site = latestSiteCandidate(normalized);
    const mosLike = /\b(?:mos|iepms|rollout)\b/i.test(text)
        || /\bprogress(?:ing)?\b/i.test(text);
    const explicitMos = /\b(?:mos|iepms\s+progress|mos\s+progress)\b/i.test(text);

    if (mosLike && site && (explicitMos || /\bhow\s+is\b[\s\S]*\bprogress(?:ing)?\b/i.test(text))) {
        return completeDecision({
            matched: true,
            intent: 'iepms.mos.lookup',
            args: { site },
            confidence: explicitMos ? 0.93 : 0.82,
            source: 'metadata_rules',
            normalized
        });
    }

    if (explicitMos && !site) {
        return completeDecision({
            matched: true,
            intent: 'iepms.mos.lookup',
            args: {},
            confidence: 0.86,
            source: 'metadata_rules',
            normalized
        });
    }

    const explicitDoDnArgs = /\b(?:released|release|outbound|delivery\s+order|delivery\s+note|\bdo\b|\bdn\b|dodn)\b/i.test(text)
        ? parseDoDnMaterialArgs(normalized)
        : null;
    if (explicitDoDnArgs) {
        console.log('[IEPMS_DODN_PARSE]', explicitDoDnArgs);
        if (explicitDoDnArgs.needsClarification) console.log('[IEPMS_DODN_VERIFY_REQUIRED]', explicitDoDnArgs);
        const { confidence, needsClarification, clarification, ...args } = explicitDoDnArgs;
        return completeDecision({
            matched: true,
            intent: 'iepms.doDn.material.check',
            args,
            needsClarification: Boolean(needsClarification),
            clarification,
            confidence: confidence || 0.84,
            source: 'metadata_rules',
            normalized
        });
    }

    const claraArgs = parseClaraInventoryArgs(normalized);
    if (claraArgs) {
        return completeDecision({
            matched: true,
            intent: 'clara.inventory.lookup',
            args: claraArgs,
            confidence: claraArgs.products.length ? 0.9 : 0.84,
            source: 'metadata_rules',
            normalized
        });
    }

    const doDnArgs = parseDoDnMaterialArgs(normalized);
    if (doDnArgs) {
        console.log('[IEPMS_DODN_PARSE]', doDnArgs);
        if (doDnArgs.needsClarification) console.log('[IEPMS_DODN_VERIFY_REQUIRED]', doDnArgs);
        const { confidence, needsClarification, clarification, ...args } = doDnArgs;
        return completeDecision({
            matched: true,
            intent: 'iepms.doDn.material.check',
            args,
            needsClarification: Boolean(needsClarification),
            clarification,
            confidence: confidence || 0.84,
            source: 'metadata_rules',
            normalized
        });
    }

    if (/^\s*show\s+progress\s*$/i.test(text) || /^\s*progress\s*$/i.test(text)) {
        return {
            matched: true,
            intent: 'clarify.progress',
            args: {},
            confidence: 0.65,
            source: 'metadata_rules',
            normalized,
            missingArgs: [],
            needsClarification: true,
            clarification: 'Do you mean iEPMS MOS progress or work order progress?'
        };
    }

    return {
        matched: false,
        intent: '',
        args: {},
        confidence: 0,
        source: 'metadata_rules',
        normalized,
        missingArgs: [],
        needsClarification: false,
        clarification: ''
    };
}

export function fillPendingIntentArgs(pending, input = '', options = {}) {
    const normalized = normalizeCommand(input, options);
    if (pending.intent === 'iepms.mos.lookup') {
        const site = latestSiteCandidate(normalized);
        return site
            ? { ready: true, intent: pending.intent, args: { ...pending.partialArgs, site }, normalized }
            : { ready: false, question: pending.clarificationQuestion, normalized };
    }
    if (pending.intent === 'order.detail') {
        return normalized.orderRef
            ? { ready: true, intent: pending.intent, args: { ...pending.partialArgs, orderRef: normalized.orderRef }, normalized }
            : { ready: false, question: pending.clarificationQuestion, normalized };
    }
    if (pending.intent === 'clara.inventory.lookup') {
        const claraArgs = parseClaraInventoryArgs(normalized);
        if (claraArgs?.products?.length) {
            return {
                ready: true,
                intent: pending.intent,
                args: {
                    ...pending.partialArgs,
                    ...claraArgs,
                    regions: claraArgs.regions.length ? claraArgs.regions : pending.partialArgs.regions
                },
                normalized
            };
        }
        const productRegion = normalized.text.match(new RegExp(`^(.+?)\\s+in\\s+${regionPattern}\\s*$`, 'i'));
        if (productRegion) {
            const regionText = productRegion[2] || '';
            return {
                ready: true,
                intent: pending.intent,
                args: {
                    ...pending.partialArgs,
                    products: [cleanProductText(productRegion[1])],
                    regions: /\ball\s+regions?\b/i.test(regionText) ? [] : [regionText]
                },
                normalized
            };
        }
        const product = cleanProductText(normalized.text);
        return product
            ? { ready: true, intent: pending.intent, args: { ...pending.partialArgs, products: [product] }, normalized }
            : { ready: false, question: pending.clarificationQuestion, normalized };
    }
    if (pending.intent === 'iepms.doDn.material.check') {
        const text = normalized.text.trim();
        if (/^(?:yes|y|confirm|proceed|continue)$/i.test(text)
            && ['confirm_keyword', 'missing_location'].includes(pending.partialArgs?.verificationKind)) {
            return {
                ready: true,
                intent: pending.intent,
                args: {
                    ...pending.partialArgs,
                    verificationKind: undefined,
                    needsClarification: undefined,
                    clarification: undefined
                },
                normalized
            };
        }
        if (pending.partialArgs?.verificationKind === 'missing_location') {
            const locationOnly = text.match(new RegExp(`^${locationPattern}$`, 'i'));
            const siteOnly = text.match(/^site\s+([a-z0-9_-]+)$/i);
            if (/^(?:all|all\s+regions?)$/i.test(text)) {
                return {
                    ready: true,
                    intent: pending.intent,
                    args: { ...pending.partialArgs, location: '', siteCode: '', verificationKind: undefined },
                    normalized
                };
            }
            if (locationOnly || siteOnly) {
                return {
                    ready: true,
                    intent: pending.intent,
                    args: {
                        ...pending.partialArgs,
                        location: locationOnly ? locationOnly[0] : '',
                        siteCode: siteOnly ? siteOnly[1].toUpperCase() : '',
                        verificationKind: undefined
                    },
                    normalized
                };
            }
        }
        if (pending.partialArgs?.verificationKind === 'site_or_material') {
            if (/^(?:1|site|site\s+code)$/i.test(text)) {
                return {
                    ready: true,
                    intent: pending.intent,
                    args: {
                        itemKeyword: '',
                        siteCode: pending.partialArgs.itemKeyword.toUpperCase(),
                        location: '',
                        matchMode: 'contains'
                    },
                    normalized
                };
            }
            if (/^(?:2|material|material\s+keyword|item|item\s+code)$/i.test(text)) {
                return {
                    ready: true,
                    intent: pending.intent,
                    args: {
                        ...pending.partialArgs,
                        verificationKind: undefined
                    },
                    normalized
                };
            }
        }
        const doDnArgs = parseDoDnMaterialArgs(normalized);
        if (doDnArgs && (doDnArgs.itemKeyword || doDnArgs.itemCode || doDnArgs.itemName || doDnArgs.siteCode) && !doDnArgs.needsClarification) {
            return {
                ready: true,
                intent: pending.intent,
                args: {
                    ...pending.partialArgs,
                    ...doDnArgs,
                    siteCode: doDnArgs.siteCode || pending.partialArgs.siteCode,
                    location: doDnArgs.location || pending.partialArgs.location
                },
                normalized
            };
        }
        const material = cleanDoDnMaterialText(normalized.text);
        return material
            ? {
                ready: true,
                intent: pending.intent,
                args: { ...pending.partialArgs, itemKeyword: material, matchMode: 'contains' },
                normalized
            }
            : { ready: false, question: pending.clarificationQuestion, normalized };
    }
    if (pending.intent === 'clarify.progress') {
        if (/\b(?:mos|iepms)\b/i.test(normalized.text)) {
            const site = latestSiteCandidate(normalized);
            return site
                ? { ready: true, intent: 'iepms.mos.lookup', args: { site }, normalized }
                : { ready: false, intent: 'iepms.mos.lookup', question: 'Sure, which site/area should I check MOS for?', normalized };
        }
        if (/\border|work\s+order|wo-\d{6}\b/i.test(normalized.text)) {
            return normalized.orderRef
                ? { ready: true, intent: 'order.detail', args: { orderRef: normalized.orderRef }, normalized }
                : { ready: false, intent: 'order.detail', question: 'Which work order ID should I check? Example: WO-000004', normalized };
        }
    }
    return { ready: false, question: pending.clarificationQuestion, normalized };
}
