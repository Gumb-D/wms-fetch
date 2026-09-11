import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { fileURLToPath } from 'url';
import { generateContent } from './llm_provider.js';
import { addMessageToDB, getHistorySince, getRecentHistory } from './db.js';
import { claraInventoryTask } from '../tasks/claraInventory.js';
import { mosScanTask } from '../tasks/mosScan.js';
import { sendDueOrderReminders } from '../tasks/orderReminder.js';
import { taskRegistry } from '../tasks/index.js';
import { executeMcpTool } from '../src/mcp/executor.js';
import { getTool, listTools } from '../src/mcp/registry.js';
import { extractDoDnCache, getDoDnCachePaths, getDoDnCacheStatus, readDoDnFlatCache } from '../src/integrations/iepms/modules/doDn/doDn.cache.service.js';
import { getMissingDoDetailPayloadFields, pickSafeHeaderFields, resolveDoDetailPayloadFields } from '../src/integrations/iepms/modules/doDn/doDn.api.js';
import {
    answerBusinessMemoryQuestion,
    answerKnownButUnavailableMemoryQuestion,
    getBusinessMemoryContext
} from './businessMemory.js';
import {
    DEFAULT_INTENT_CONFIDENCE_THRESHOLD,
    PENDING_MCP_INTENT_TTL_MS,
    detectReadOnlyIntent,
    fillPendingIntentArgs
} from '../src/router/intentRouter.js';
import { isOrderIntent, routeOrderActionConfirmation, routeOrderConversation, routeOrderRequest } from './orders/orderRouter.js';
import { enforceSafeOperationalReply } from './orders/orderEscalation.js';

const LOCAL_TIME_ZONE = 'Asia/Kuala_Lumpur';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const SERVER_ROOT = path.resolve(PROJECT_ROOT, process.env.SERVER_ROOT || '..');
const resolveServerPath = (configuredPath, fallbackRelativePath) => {
    return path.resolve(SERVER_ROOT, configuredPath || fallbackRelativePath);
};
const GOOGLE_GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';
const GOOGLE_WEATHER_URL = 'https://weather.googleapis.com/v1/currentConditions:lookup';
const OPEN_METEO_GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const OPEN_METEO_FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
let isTaskEnabled = () => true;
const pendingMcpIntents = new Map();

const parseJidList = (value = '') => String(value || '')
    .split(/[,\s;]+/)
    .map(item => item.trim())
    .filter(Boolean);

const normalizeAccessJid = (value = '') => String(value || '').trim().toLowerCase().replace(/:\d+(?=@)/, '');

const normalizeAccessUser = (value = '') => normalizeAccessJid(value).split('@')[0];

const getOwnerAdminAccessConfig = () => {
    const ownerJids = parseJidList(process.env.OWNER_JID || '');
    const adminJids = parseJidList(process.env.ADMIN_JIDS || '');
    const allowlist = [...ownerJids, ...adminJids];

    return {
        ownerConfigured: ownerJids.length > 0,
        adminCount: adminJids.length,
        allowlistJids: new Set(allowlist.map(normalizeAccessJid).filter(Boolean)),
        allowlistUsers: new Set(allowlist.map(normalizeAccessUser).filter(Boolean))
    };
};

const getOwnerAdminSenderCandidates = (options = {}) => {
    const candidates = [
        ...(Array.isArray(options.sender_jid_candidates) ? options.sender_jid_candidates : []),
        ...(Array.isArray(options.senderJidCandidates) ? options.senderJidCandidates : []),
        options.senderJid,
        options.sender_jid,
        options.userJid,
        options.user_jid,
        options.participant,
        options.participantJid,
        options.participant_jid,
        options.jid,
        options.remoteJid,
        options.remote_jid
    ];

    return [...new Set(candidates.map(normalizeAccessJid).filter(Boolean))];
};

const getOwnerAdminAccessDiagnostics = (options = {}) => {
    const config = getOwnerAdminAccessConfig();
    const candidates = getOwnerAdminSenderCandidates(options);
    const allowed = candidates.some(candidate => {
        return config.allowlistJids.has(candidate) || config.allowlistUsers.has(normalizeAccessUser(candidate));
    });

    return {
        ownerConfigured: config.ownerConfigured,
        adminCount: config.adminCount,
        candidateCount: candidates.length,
        allowlistConfigured: config.allowlistJids.size > 0 || config.allowlistUsers.size > 0,
        allowed
    };
};

const isOwnerOrAdmin = (options = {}) => {
    const diagnostics = getOwnerAdminAccessDiagnostics(options);
    console.log('[DODN_CACHE_ACCESS_CHECK]', diagnostics);
    return diagnostics.allowed;
};

export const configureTaskControls = (controls = {}) => {
    isTaskEnabled = typeof controls.isTaskEnabled === 'function'
        ? controls.isTaskEnabled
        : () => true;
};

const disabledTaskReply = (taskId, taskName) => {
    if (isTaskEnabled(taskId)) return null;
    return {
        reply: `${taskName} is disabled. Enable the task in the CRON tab to use it again.`,
        category: 'execute_task',
        task: { type: 'task_disabled', taskId, disabled: true }
    };
};

const isMcpDebugSourceEnabled = () => /^(?:1|true|yes|on)$/i.test((process.env.MCP_DEBUG_SOURCE || '').trim());

const withSourceMarker = (reply = '', source = '') => {
    if (!isMcpDebugSourceEnabled() || !reply || !source) return reply;
    if (/^\[(?:MCP|OLD)\]\s/.test(reply)) return reply;
    return `[${source}] ${reply}`;
};

const markResponseSource = (response, source) => {
    if (!response?.reply) return response;
    return {
        ...response,
        reply: withSourceMarker(response.reply, source)
    };
};

const stripDarcyPrefix = (input = '') => {
    return input.trim().replace(/^(?:@?darcy|!darcy)\s*[,:\-]?\s+/i, '').trim();
};

const stripRequestPrefix = (input = '') => {
    return input
        .trim()
        .replace(/^(?:please|pls|tolong|can\s+you|could\s+you|help(?:\s+me)?(?:\s+to)?)\s+/i, '')
        .trim();
};

const isRuntimeDebugCommand = (input = '') => {
    return /^debug\s+runtime\s+path\s*$/i.test(stripDarcyPrefix(input));
};

const isMcpListToolsCommand = (input = '') => {
    return /^mcp\s+(?:list\s+tools|tools)\s*$/i.test(stripDarcyPrefix(input));
};

const isMcpCommand = (input = '') => {
    return /^mcp(?:\s|$)/i.test(stripDarcyPrefix(input));
};

const parseMcpToolInfoCommand = (input = '') => {
    return stripDarcyPrefix(input).match(/^mcp\s+tool\s+info\s+([a-z0-9._-]+)\s*$/i);
};

const formatMcpToolInfo = (intent) => {
    const tool = getTool(intent);
    if (!tool) return '[MCP] Unknown MCP command';

    return [
        `[MCP] Tool: ${tool.intent}`,
        `description: ${tool.description || '-'}`,
        `readOnly: ${Boolean(tool.readOnly)}`
    ].join('\n');
};

const formatRuntimeDebugReply = () => {
    return [
        '[DEBUG_RUNTIME]',
        `process.cwd(): ${process.cwd()}`,
        `router import.meta.url: ${import.meta.url}`,
        `MCP_DEBUG_SOURCE: ${process.env.MCP_DEBUG_SOURCE || ''}`,
        `DM_ACCESS_CONTROL: ${process.env.DM_ACCESS_CONTROL || ''}`,
        `CLARA_PARQUET_PATH set: ${Boolean(process.env.CLARA_PARQUET_PATH)}`,
        `PARQUET_PATH set: ${Boolean(process.env.PARQUET_PATH)}`,
        `OWNER_JID set: ${Boolean(process.env.OWNER_JID)}`
    ].join('\n');
};

const formatDoDnCacheAge = (ageMs) => {
    if (!Number.isFinite(ageMs)) return '-';
    const hours = Math.floor(ageMs / (60 * 60 * 1000));
    const minutes = Math.round((ageMs % (60 * 60 * 1000)) / (60 * 1000));
    if (hours <= 0) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
    return `${hours} hour${hours === 1 ? '' : 's'}${minutes ? ` ${minutes} minute${minutes === 1 ? '' : 's'}` : ''}`;
};

const formatDoDnCacheTimestamp = (value) => value
    ? new Intl.DateTimeFormat('en-MY', {
        timeZone: LOCAL_TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    }).format(new Date(value)).replace(',', '')
    : '-';

const normalizeDoDnDebugText = (value = '') => String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const formatDoDnDebugQty = (record = {}) => `${record.itemQty ?? 0}${record.itemUnit ? ` ${record.itemUnit}` : ''}`;

const routeDoDnCacheCommand = async (userInput = '', options = {}) => {
    const text = stripDarcyPrefix(userInput);
    if (/^debug\s+dodn\s+cache\s*$/i.test(text)) {
        const status = getDoDnCacheStatus();
        return {
            reply: [
                'DO/DN Cache Status',
                '',
                `Status: ${status.ok ? 'Available' : 'Missing'}`,
                `Last Updated: ${formatDoDnCacheTimestamp(status.generatedAt)}`,
                `Age: ${formatDoDnCacheAge(status.ageMs)}`,
                `Total Lines: ${status.totalLines ?? 0}`,
                `File: ${status.paths?.flatJson || ''}`
            ].join('\n'),
            category: 'mcp_do_dn_cache',
            task: {
                type: 'dodn_cache_status',
                success: status.ok,
                code: status.ok ? 'IEPMS_DODN_CACHE_AVAILABLE' : 'IEPMS_DODN_CACHE_MISSING'
            }
        };
    }

    const headerDebugMatch = text.match(/^debug\s+dodn\s+header\s+([a-z0-9_-]+)\s*$/i);
    if (headerDebugMatch) {
        const doCode = headerDebugMatch[1].trim();
        const paths = getDoDnCachePaths();
        if (!fs.existsSync(paths.headers)) {
            return {
                reply: 'DO/DN header cache is not available yet.\n\nPlease run OPS Automation:\niEPMS DO/DN Cache Extract',
                category: 'mcp_do_dn_cache',
                task: {
                    type: 'dodn_header_debug',
                    success: false,
                    code: 'IEPMS_DODN_HEADER_CACHE_MISSING'
                }
            };
        }

        const headerCache = JSON.parse(fs.readFileSync(paths.headers, 'utf8'));
        const records = Array.isArray(headerCache.records) ? headerCache.records : [];
        const header = records.find(record => {
            const resolved = resolveDoDetailPayloadFields(record);
            return String(resolved.doCode || '').trim().toUpperCase() === doCode.toUpperCase();
        });

        if (!header) {
            return {
                reply: [
                    'DO/DN Header Debug',
                    '',
                    `DO: ${doCode}`,
                    '',
                    'Header not found in local cache. Run DO/DN cache extraction first, then retry.'
                ].join('\n'),
                category: 'mcp_do_dn_cache',
                task: {
                    type: 'dodn_header_debug',
                    success: false,
                    code: 'IEPMS_DODN_HEADER_NOT_FOUND'
                }
            };
        }

        const resolved = resolveDoDetailPayloadFields(header);
        const missing = getMissingDoDetailPayloadFields(header);
        console.log('[IEPMS_DODN_HEADER_DEBUG]', {
            doCode,
            headerKeys: Object.keys(header || {}),
            safeHeaderSample: pickSafeHeaderFields(header),
            rawHeader: header
        });

        return {
            reply: [
                'DO/DN Header Debug',
                '',
                `DO: ${doCode}`,
                '',
                'Resolved detail payload:',
                `- doCode: ${resolved.doCode || '-'}`,
                `- doSourceType: ${resolved.doSourceType || '-'}`,
                `- doStatus: ${resolved.doStatus || '-'}`,
                `- siteBomId: ${resolved.siteBomId || '-'}`,
                `- warehouseType: ${resolved.warehouseType || '-'}`,
                '',
                `Missing: ${missing.length ? missing.join(', ') : 'none'}`,
                `Header Keys: ${Object.keys(header || {}).join(', ') || '-'}`
            ].join('\n'),
            category: 'mcp_do_dn_cache',
            task: {
                type: 'dodn_header_debug',
                success: missing.length === 0,
                code: missing.length ? 'IEPMS_DODN_HEADER_FIELDS_MISSING' : 'IEPMS_DODN_HEADER_FIELDS_RESOLVED'
            }
        };
    }

    if (/^debug\s+dodn\s+cache\s+sample\s*$/i.test(text)) {
        const cache = readDoDnFlatCache();
        if (!cache.ok) {
            return {
                reply: cache.message,
                category: 'mcp_do_dn_cache',
                task: {
                    type: 'dodn_cache_sample',
                    success: false,
                    code: 'IEPMS_DODN_CACHE_MISSING'
                }
            };
        }
        const sample = cache.records.find(record => record.itemCode || record.itemName || record.itemQty !== undefined)
            || cache.records[0]
            || {};
        return {
            reply: [
                'DO/DN Cache Sample',
                '',
                `Total Lines: ${cache.totalLines ?? 0}`,
                'Sample:',
                `DO: ${sample.doCode || '-'}`,
                `Site: ${sample.siteCode || '-'}`,
                `Item Code: ${sample.itemCode || '-'}`,
                `Item Name: ${sample.itemName || '-'}`,
                `Qty: ${formatDoDnDebugQty(sample)}`
            ].join('\n'),
            category: 'mcp_do_dn_cache',
            task: {
                type: 'dodn_cache_sample',
                success: true,
                code: 'IEPMS_DODN_CACHE_SAMPLE'
            }
        };
    }

    const findMatch = text.match(/^debug\s+dodn\s+find\s+(.+?)\s*$/i);
    if (findMatch) {
        const keyword = findMatch[1].trim();
        const normalizedKeyword = normalizeDoDnDebugText(keyword);
        const cache = readDoDnFlatCache();
        if (!cache.ok) {
            return {
                reply: cache.message,
                category: 'mcp_do_dn_cache',
                task: {
                    type: 'dodn_cache_find',
                    success: false,
                    code: 'IEPMS_DODN_CACHE_MISSING'
                }
            };
        }

        const matches = cache.records.filter(record => {
            const itemCode = normalizeDoDnDebugText(record.itemCode);
            const itemName = normalizeDoDnDebugText(record.itemName);
            return itemCode.includes(normalizedKeyword) || itemName.includes(normalizedKeyword);
        });
        const shown = matches.slice(0, 10);
        return {
            reply: [
                'DO/DN Cache Find',
                '',
                `Keyword: ${keyword}`,
                `Matched Lines: ${matches.length}`,
                'Sample:',
                ...(shown.length
                    ? shown.map((record, index) => `${index + 1}. ${record.doCode || '-'} | ${record.siteCode || '-'} | ${record.itemCode || '-'} | ${record.itemName || '-'} | Qty ${formatDoDnDebugQty(record)}`)
                    : ['No matching material lines found.'])
            ].join('\n'),
            category: 'mcp_do_dn_cache',
            task: {
                type: 'dodn_cache_find',
                success: true,
                code: 'IEPMS_DODN_CACHE_FIND'
            }
        };
    }

    if (/^debug\s+dodn\s+access\s*$/i.test(text)) {
        const diagnostics = getOwnerAdminAccessDiagnostics(options);
        return {
            reply: [
                'DO/DN Cache Access',
                '',
                `Owner configured: ${diagnostics.ownerConfigured ? 'Yes' : 'No'}`,
                `Admin count: ${diagnostics.adminCount}`,
                `Sender candidates: ${diagnostics.candidateCount}`,
                `Allowed: ${diagnostics.allowed ? 'Yes' : 'No'}`
            ].join('\n'),
            category: 'mcp_do_dn_cache',
            task: {
                type: 'dodn_cache_access',
                success: diagnostics.allowed,
                code: diagnostics.allowed ? 'ACCESS_ALLOWED' : 'ACCESS_DENIED'
            }
        };
    }

    if (/^run\s+dodn\s+cache\s+extract\s*$/i.test(text)) {
        if (!isOwnerOrAdmin(options)) {
            const diagnostics = getOwnerAdminAccessDiagnostics(options);
            return {
                reply: diagnostics.allowlistConfigured
                    ? 'Only owner/admin can run DO/DN cache extraction from WhatsApp. Check OWNER_JID / ADMIN_JIDS in .env and restart Darcy.'
                    : [
                        'DO/DN cache extraction is restricted, but OWNER_JID / ADMIN_JIDS is not configured.',
                        'Add OWNER_JID=60123456789@s.whatsapp.net and ADMIN_JIDS=60123456789@s.whatsapp.net,60198765432@s.whatsapp.net in .env, then restart Darcy.'
                    ].join('\n'),
                category: 'mcp_do_dn_cache',
                task: {
                    type: 'dodn_cache_extract',
                    success: false,
                    code: 'ACCESS_DENIED'
                }
            };
        }

        const meta = await extractDoDnCache();
        return {
            reply: [
                'iEPMS DO/DN Cache Extract',
                '',
                `Status: ${meta.ok ? 'Success' : 'Failed'}`,
                `Headers extracted: ${meta.totalHeaders ?? 0}`,
                `Detail lines extracted: ${meta.totalDetailLines ?? 0}`,
                `Failed DO: ${meta.failedDoCount ?? 0}`,
                `Duration: ${Math.round((meta.durationMs || 0) / 1000)}s`,
                `Output folder: ${meta.outputDir || ''}`
            ].join('\n'),
            category: 'mcp_do_dn_cache',
            task: {
                type: 'dodn_cache_extract',
                success: Boolean(meta.ok),
                code: meta.ok ? 'IEPMS_DODN_CACHE_EXTRACTED' : 'IEPMS_DODN_CACHE_EXTRACT_FAILED'
            }
        };
    }

    return null;
};

const routeTopLevelDebugCommand = async (userInput = '', options = {}) => {
    if (isRuntimeDebugCommand(userInput)) {
        return {
            reply: formatRuntimeDebugReply(),
            category: 'debug_runtime',
            task: {
                type: 'debug_runtime',
                success: true,
                code: 'DEBUG_RUNTIME_PATH'
            }
        };
    }

    if (!isMcpCommand(userInput)) return null;

    console.log('[MCP_COMMAND_PRIORITY_MATCHED]');

    if (isMcpListToolsCommand(userInput)) {
        return {
            reply: listTools().map(tool => tool.intent).join('\n') || 'No MCP tools registered.',
            category: 'mcp_debug',
            task: {
                type: 'mcp_debug',
                intent: 'mcp.listTools',
                success: true,
                code: 'MCP_TOOLS_LISTED'
            }
        };
    }

    const toolInfo = parseMcpToolInfoCommand(userInput);
    if (toolInfo) {
        return {
            reply: formatMcpToolInfo(toolInfo[1]),
            category: 'mcp_debug',
            task: {
                type: 'mcp_debug',
                intent: 'mcp.toolInfo',
                success: Boolean(getTool(toolInfo[1])),
                code: getTool(toolInfo[1]) ? 'MCP_TOOL_INFO' : 'MCP_UNKNOWN_COMMAND'
            }
        };
    }

    const mcpDebug = await routeMcpDebugCommand(userInput, options);
    if (mcpDebug) return mcpDebug;

    return {
        reply: '[MCP] Unknown MCP command',
        category: 'mcp_debug',
        task: {
            type: 'mcp_debug',
            intent: 'mcp.unknown',
            success: false,
            code: 'MCP_UNKNOWN_COMMAND'
        }
    };
};

const formatLocalDateTime = (value = new Date()) => {
    const date = value instanceof Date ? value : new Date(value);
    return new Intl.DateTimeFormat('en-MY', {
        timeZone: LOCAL_TIME_ZONE,
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
        timeZoneName: 'short'
    }).format(date);
};

const loadSkill = (fileName, fallback) => {
    const skillPath = path.join(process.cwd(), 'skills', fileName);

    try {
        const rawSkill = fs.readFileSync(skillPath, 'utf8');
        return rawSkill.replace(/User:\s*\{\{input\}\}[\s\S]*$/m, '').trim();
    } catch (e) {
        return fallback;
    }
};

const isSummarizeRequest = (input) => {
    if (/\b(summarize|summarized|summarise|summary|recap|ringkas|rumuskan)\b/i.test(input)) {
        console.log('[OLD_SUMMARY_SKILL_DISABLED]', { input });
    }
    return false;
};

const isWeatherRequest = (input) => {
    return /\b(weather|forecast|rain|raining|temperature|cuaca|hujan|panas)\b/i.test(input);
};

const isExecuteTaskRequest = (input) => {
    return /\b(send|post|tell|message|msg|forward|share|copy)\b/i.test(input)
        && /\b(group|chatgroup|to|into|tag|mention)\b/i.test(input);
};

const isIvantiTTSummaryRequest = (input) => {
    return /\b(ivanti|tt|ticket|active list|task team|zte)\b/i.test(input)
        && /\b(summarize|summarise|summary|list|show|check|current|active)\b/i.test(input);
};

const INTENT_CATEGORIES = new Set([
    'troubleshoot',
    'reasoning',
    'execute_task',
    'conversation'
]);

const normalizeIntentCategory = (value = '') => {
    const category = value.toString().toLowerCase().replace(/[^a-z_]/g, '').trim();
    return INTENT_CATEGORIES.has(category) ? category : 'conversation';
};

const extractCheckTTSite = (input = '') => {
    const match = input.trim().match(/(?:^|\s)check\s+tt\s+([a-z0-9_-]+)\s*$/i);
    return match ? match[1].toUpperCase() : '';
};

const extractListTTRegion = (input = '') => {
    const match = input.trim().match(/(?:^|\s)list(?:\s+down)?\s+tt(?:\s+(sabah|sarawak))?\s*$/i);
    if (!match) return null;
    return {
        region: match[1] ? match[1].slice(0, 1).toUpperCase() + match[1].slice(1).toLowerCase() : ''
    };
};

const isSnapTTSummaryRequest = (input = '') => {
    return /(?:^|\s)snap\s+tt\s+summary\s*$/i.test(input.trim());
};

const ACK_ONLY_PATTERN = /^(?:ok(?:ay)?|noted|thanks?|thank\s+you|terima\s+kasih|baik|done|roger|received|understood|alright|sure)\s*(?:darcy)?[.!]*$/i;
const CASUAL_REFERENCE_PATTERNS = [
    /\bdarcy\s+already\s+(?:told|said|checked|answered|mentioned|shared)\b/i,
    /\balready\s+(?:asked|checked\s+with)\s+darcy\b/i,
    /\buse\s+darcy\s+later\b/i,
    /\bmaybe\s+darcy\s+can\s+help\s+later\b/i,
    /\bdon'?t\s+ask\s+darcy\b/i,
    /\bdo\s+not\s+ask\s+darcy\b/i,
    /\bno\s+need\s+(?:to\s+)?ask\s+darcy\b/i
];
const DIRECT_REQUEST_PATTERN = /\b(?:please|pls|tolong|can\s+you|could\s+you|help\s+(?:me\s+)?(?:to\s+)?|check|show|list|summari[sz]e|snap|snapshot|take|book|reserve|buy|purchase|pay|create|new|assign|cancel|update|reopen|remind|pause|resume|send|post|tell|message|forward|share|copy|debug|extend)\b/i;
const QUESTION_PATTERN = /\?\s*$|\b(?:what|when|where|who|why|how|which|can|could|should|would|is|are|do|does|did)\b/i;

export function shouldDarcyRespond(text = '', context = {}) {
    const stripped = stripDarcyPrefix(text);
    const isGroup = Boolean(context.isGroup);

    if (!isGroup) {
        return { shouldRespond: true, reason: 'dm_always_reply', confidence: 1, mode: 'reply' };
    }
    if (context.linkedOrder) {
        return { shouldRespond: true, reason: 'linked_order_reply', confidence: 1, mode: 'reply' };
    }
    if (isMcpCommand(text)) {
        return { shouldRespond: true, reason: 'mcp_command', confidence: 1, mode: 'reply' };
    }
    if (isOrderIntent(stripped) || isWeatherRequest(stripped) || isExecuteTaskRequest(stripped)) {
        return { shouldRespond: true, reason: 'deterministic_command', confidence: 0.98, mode: 'reply' };
    }
    if (/^(?:yes|y|confirm|proceed|go\s+ahead|do\s+it|assign|escalate|remind|close|complete)\b/i.test(stripped)) {
        return { shouldRespond: true, reason: 'possible_pending_action_confirmation', confidence: 0.9, mode: 'reply' };
    }
    if (/^(?:check|show|get)\s+(?:this|that|it)\s*$/i.test(stripped)) {
        return { shouldRespond: true, reason: 'ambiguous_check_target', confidence: 0.86, mode: 'clarify' };
    }
    if (ACK_ONLY_PATTERN.test(stripped)) {
        return { shouldRespond: false, reason: 'acknowledgement_only', confidence: 0.95, mode: 'silent' };
    }
    if (CASUAL_REFERENCE_PATTERNS.some(pattern => pattern.test(text))) {
        return { shouldRespond: false, reason: 'casual_reference_only', confidence: 0.9, mode: 'silent' };
    }
    if (DIRECT_REQUEST_PATTERN.test(stripped)) {
        return { shouldRespond: true, reason: 'direct_request', confidence: 0.88, mode: 'reply' };
    }
    if (QUESTION_PATTERN.test(stripped)) {
        return { shouldRespond: true, reason: 'direct_question', confidence: 0.82, mode: 'reply' };
    }

    return { shouldRespond: false, reason: 'group_mention_without_request', confidence: 0.7, mode: 'silent' };
}

const logReplyDecision = (decision) => {
    console.log(`[DARCY_REPLY_DECISION] shouldRespond=${decision.shouldRespond} reason=${decision.reason} confidence=${decision.confidence} mode=${decision.mode}`);
    if (!decision.shouldRespond) {
        console.log(`[DARCY_SILENT] reason=${decision.reason}`);
    }
};

const getCapabilityRegistry = () => ({
    mcpIntents: listTools().map(tool => tool.intent),
    taskCommands: Object.keys(taskRegistry),
    domains: [
        'orders',
        'reminders',
        'TT/Ivanti',
        'iEPMS',
        'Clara inventory',
        'weather',
        'configured reports',
        'group messaging'
    ]
});

const OPERATIONAL_ACTION_PATTERN = /\b(?:book|reserve|buy|purchase|pay|submit|approve|reject|update|modify|delete|remove|upload|download|sync|create|schedule|send|post|message|forward|assign|cancel|close|complete|reopen|restart|deploy|provision|configure|change|extend|grant|revoke|check|lookup|fetch|get|pull|run|execute)\b/i;
const ADVICE_OR_DRAFT_PATTERN = /\b(?:explain|what\s+is|how\s+(?:do|does|to|can)|why|advise|advice|brainstorm|suggest|recommend|draft|write|compose|reword|rewrite|summari[sz]e\s+this|help\s+me\s+understand)\b/i;
const UNSUPPORTED_CONNECTED_SYSTEM_PATTERN = /\b(?:sap|flight|airline|hotel|bank|payment|invoice|jira|servicenow|salesforce|github|gitlab|azure|aws|gcp|database|db)\b/i;

export function detectUnsupportedAction(text = '', context = {}) {
    const stripped = stripDarcyPrefix(text);
    const registry = getCapabilityRegistry();

    if (!OPERATIONAL_ACTION_PATTERN.test(stripped)) {
        console.log('[CAPABILITY_GUARD_ALLOWED]', { reason: 'not_operational_action' });
        return { unsupported: false, reason: 'not_operational_action', registry };
    }
    if (ADVICE_OR_DRAFT_PATTERN.test(stripped) && !UNSUPPORTED_CONNECTED_SYSTEM_PATTERN.test(stripped)) {
        console.log('[CAPABILITY_GUARD_ALLOWED]', { reason: 'advice_or_drafting' });
        return { unsupported: false, reason: 'advice_or_drafting', registry };
    }

    const supportedDomain = /\b(?:order|orders|work\s+order|wo-\d{6}|remind|reminder|tt|ivanti|mos|iepms|permission|site\s+access|clara|inventory|stock|weather|forecast)\b/i.test(stripped);
    if (supportedDomain) {
        console.log('[CAPABILITY_GUARD_ALLOWED]', { reason: 'supported_operational_domain' });
        return { unsupported: false, reason: 'supported_operational_domain', registry };
    }

    const reason = UNSUPPORTED_CONNECTED_SYSTEM_PATTERN.test(stripped)
        ? 'unsupported_connected_system'
        : 'unsupported_operational_action';
    console.log('[UNSUPPORTED_ACTION_DETECTED]', { reason, text: stripped });
    console.log('[CAPABILITY_GUARD_BLOCKED]', { reason });
    return {
        unsupported: true,
        reason,
        message: reason === 'unsupported_connected_system' && /\bsap\b/i.test(stripped)
            ? "I can't update SAP yet because that tool is not connected."
            : "I can't do that yet. I don't have that tool connected.",
        registry
    };
}

const IVANTI_CURRENT_JSON = resolveServerPath(
    process.env.IVANTI_CURRENT_JSON,
    path.join('ivanti', 'exports', 'ivanti-current.json')
);
const IVANTI_SUMMARY_SNAPSHOT = resolveServerPath(
    process.env.IVANTI_SUMMARY_SNAPSHOT,
    path.join('ivanti', 'exports', 'tt-summary-current.png')
);
console.log('[OLD_IVANTI_ROUTE_DISABLED]', { jsonPath: IVANTI_CURRENT_JSON });
const shouldForwardGroupReplyHere = (input) => {
    return /\bforward\b[\s\S]*\brepl(?:y|ies)\b[\s\S]*\bhere\b/i.test(input)
        || /\brepl(?:y|ies)\b[\s\S]*\b(?:back|return|send)\b[\s\S]*\b(?:here|me|dm)\b/i.test(input);
};

const extractWeatherLocation = (input = '') => {
    const cleaned = input
        .replace(/\b(?:darcy|please|pls|tolong|check|show|get|what'?s|what is|macam mana|how is)\b/gi, ' ')
        .replace(/\b(?:weather|forecast|temperature|cuaca)\b/gi, ' ')
        .replace(/\b(?:today|now|right now|currently|sekarang|hari ini)\b/gi, ' ')
        .replace(/\b(?:in|at|for|near|di|kat|dekat|untuk)\b/gi, ' ')
        .replace(/[?.!,]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    return cleaned;
};

const makeBar = (percent = 0, width = 10) => {
    const value = Math.max(0, Math.min(100, Number(percent) || 0));
    const filled = Math.round((value / 100) * width);
    return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
};

const extractNumber = (value = '') => {
    const match = value.match(/-?\d+(?:\.\d+)?/);
    return match ? Number(match[0]) : null;
};

const getGoogleWeatherApiKey = () => {
    return process.env.GOOGLE_WEATHER_API_KEY
        || process.env.GOOGLE_MAPS_API_KEY
        || '';
};

const formatDegrees = (temperature) => {
    if (typeof temperature?.degrees !== 'number') return '';
    return Math.round(temperature.degrees).toString();
};

const formatWind = (wind) => {
    const speed = wind?.speed;
    if (typeof speed?.value !== 'number') return '';

    const unit = speed.unit === 'MILES_PER_HOUR' ? 'mph' : 'km/h';
    const direction = wind?.direction?.cardinal
        ? wind.direction.cardinal.toLowerCase().replace(/_/g, ' ')
        : '';

    return `${Math.round(speed.value)} ${unit}${direction ? ` ${direction}` : ''}`;
};

async function fetchJson(url, errorLabel) {
    const response = await fetch(url);
    const body = await response.text();
    let data = null;

    try {
        data = body ? JSON.parse(body) : null;
    } catch {
        throw new Error(`${errorLabel} returned non-JSON response.`);
    }

    if (!response.ok) {
        const message = data?.error?.message || `${errorLabel} returned HTTP ${response.status}`;
        throw new Error(message);
    }

    return data;
}

const WEATHER_CODE_INFO = {
    0: { icon: '☀️', label: 'Clear sky' },
    1: { icon: '🌤️', label: 'Mainly clear' },
    2: { icon: '⛅', label: 'Partly cloudy' },
    3: { icon: '☁️', label: 'Overcast' },
    45: { icon: '🌫️', label: 'Fog' },
    48: { icon: '🌫️', label: 'Depositing rime fog' },
    51: { icon: '🌦️', label: 'Light drizzle' },
    53: { icon: '🌦️', label: 'Moderate drizzle' },
    55: { icon: '🌧️', label: 'Dense drizzle' },
    56: { icon: '🌧️', label: 'Light freezing drizzle' },
    57: { icon: '🌧️', label: 'Dense freezing drizzle' },
    61: { icon: '🌧️', label: 'Slight rain' },
    63: { icon: '🌧️', label: 'Moderate rain' },
    65: { icon: '🌧️', label: 'Heavy rain' },
    66: { icon: '🌧️', label: 'Light freezing rain' },
    67: { icon: '🌧️', label: 'Heavy freezing rain' },
    71: { icon: '🌨️', label: 'Slight snow' },
    73: { icon: '🌨️', label: 'Moderate snow' },
    75: { icon: '🌨️', label: 'Heavy snow' },
    77: { icon: '🌨️', label: 'Snow grains' },
    80: { icon: '🌦️', label: 'Slight rain showers' },
    81: { icon: '🌧️', label: 'Moderate rain showers' },
    82: { icon: '⛈️', label: 'Violent rain showers' },
    85: { icon: '🌨️', label: 'Slight snow showers' },
    86: { icon: '🌨️', label: 'Heavy snow showers' },
    95: { icon: '⛈️', label: 'Thunderstorm' },
    96: { icon: '⛈️', label: 'Thunderstorm with hail' },
    99: { icon: '⛈️', label: 'Heavy thunderstorm with hail' }
};

const getWeatherCodeInfo = (code) => {
    return WEATHER_CODE_INFO[Number(code)] || { icon: '🌡️', label: 'Weather update' };
};

const formatWindDirection = (degrees) => {
    if (typeof degrees !== 'number') return '';
    const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    return directions[Math.round(degrees / 45) % directions.length];
};

const getNearestHourlyValue = (hourly, key, currentTime) => {
    const times = hourly?.time || [];
    const values = hourly?.[key] || [];
    if (!times.length || !values.length) return null;

    const current = new Date(currentTime).getTime();
    let bestIndex = 0;
    let bestDistance = Infinity;

    times.forEach((time, index) => {
        const distance = Math.abs(new Date(time).getTime() - current);
        if (distance < bestDistance) {
            bestDistance = distance;
            bestIndex = index;
        }
    });

    return values[bestIndex] ?? null;
};

const WEATHER_LOCATION_ALIASES = {
    sabah: {
        name: 'Kota Kinabalu, Sabah, Malaysia',
        latitude: 5.9804,
        longitude: 116.0735
    },
    sarawak: {
        name: 'Kuching, Sarawak, Malaysia',
        latitude: 1.5533,
        longitude: 110.3592
    }
};

const getWeatherLocationAlias = (location = '') => {
    return WEATHER_LOCATION_ALIASES[location.trim().toLowerCase()] || null;
};

async function fetchOpenMeteoWeather(location) {
    let matchedPlace = getWeatherLocationAlias(location);
    if (!matchedPlace) {
        const geocodeParams = new URLSearchParams({
            name: location,
            count: '1',
            language: 'en',
            format: 'json',
            countryCode: 'MY'
        });
        const geocode = await fetchJson(`${OPEN_METEO_GEOCODE_URL}?${geocodeParams.toString()}`, 'Open-Meteo geocoding');
        matchedPlace = geocode.results?.[0];

        if (!matchedPlace) {
            throw new Error(`Open-Meteo could not resolve "${location}".`);
        }
    }

    const forecastParams = new URLSearchParams({
        latitude: matchedPlace.latitude.toString(),
        longitude: matchedPlace.longitude.toString(),
        current: [
            'temperature_2m',
            'relative_humidity_2m',
            'apparent_temperature',
            'precipitation',
            'weather_code',
            'cloud_cover',
            'wind_speed_10m',
            'wind_direction_10m'
        ].join(','),
        hourly: 'precipitation_probability',
        timezone: 'Asia/Kuala_Lumpur',
        forecast_days: '1'
    });
    const forecast = await fetchJson(`${OPEN_METEO_FORECAST_URL}?${forecastParams.toString()}`, 'Open-Meteo forecast');
    const current = forecast.current || {};
    const codeInfo = getWeatherCodeInfo(current.weather_code);
    const rainChance = getNearestHourlyValue(forecast.hourly, 'precipitation_probability', current.time);
    const windDirection = formatWindDirection(current.wind_direction_10m);
    const resolvedLocation = [
        matchedPlace.name,
        matchedPlace.admin1,
        matchedPlace.country
    ].filter(Boolean).join(', ');

    return {
        location: resolvedLocation || location,
        temperature: Math.round(current.temperature_2m).toString(),
        feelsLike: Math.round(current.apparent_temperature).toString(),
        condition: codeInfo.label,
        icon: codeInfo.icon,
        precipitation: `${rainChance ?? 0}%`,
        humidity: `${Math.round(current.relative_humidity_2m || 0)}%`,
        wind: `${Math.round(current.wind_speed_10m || 0)} km/h${windDirection ? ` ${windDirection}` : ''}`,
        cloudCover: typeof current.cloud_cover === 'number' ? `${Math.round(current.cloud_cover)}%` : '',
        sourceLabel: 'Open-Meteo'
    };
}

const getWeatherInsight = (weather) => {
    const condition = weather.condition.toLowerCase();
    const rain = extractNumber(weather.precipitation);
    const temp = extractNumber(weather.temperature);
    const humidity = extractNumber(weather.humidity);

    if (/storm|thunder|heavy rain/i.test(condition) || rain >= 60) {
        return 'High rain risk. Bring rain cover and expect slower travel or outdoor work.';
    }
    if (/rain|shower|drizzle/i.test(condition) || rain >= 35) {
        return 'Some rain risk. Keep a light umbrella or jacket nearby.';
    }
    if (temp >= 33 || humidity >= 80) {
        return 'Feels hot and humid. Hydrate well and avoid long direct-sun exposure.';
    }
    if (/clear|sunny/i.test(condition)) {
        return 'Good window for outdoor plans, but keep sun protection in mind.';
    }
    return 'Looks manageable. Check again before outdoor work if the sky changes.';
};

const formatWeatherReply = (weather) => {
    const rainPercent = extractNumber(weather.precipitation) ?? 0;
    const humidityPercent = extractNumber(weather.humidity) ?? 0;
    const temp = weather.temperature ? `${weather.temperature} C` : 'N/A';
    const sourceLabel = weather.sourceLabel || 'Weather';
    const icon = weather.icon || '🌡️';

    return [
        `${sourceLabel}: ${weather.location}`,
        '',
        `${icon}  ${weather.condition || 'N/A'}`,
        `🌡️ Temp      ${temp}${weather.feelsLike ? ` | Feels ${weather.feelsLike} C` : ''}`,
        `🌧️ Rain      ${weather.precipitation || 'N/A'} | ${makeBar(rainPercent)}`,
        `💧 Humidity  ${weather.humidity || 'N/A'} | ${makeBar(humidityPercent)}`,
        `💨 Wind      ${weather.wind || 'N/A'}`,
        weather.cloudCover ? `☁️ Cloud     ${weather.cloudCover}` : '',
        '',
        `Insight: ${getWeatherInsight(weather)}`
    ].filter(line => line !== '').join('\n');
};

async function fetchGoogleWeather(location) {
    const key = getGoogleWeatherApiKey();
    if (!key) {
        return fetchOpenMeteoWeather(location);
    }

    const geocodeParams = new URLSearchParams({
        address: location,
        key
    });
    const geocode = await fetchJson(`${GOOGLE_GEOCODE_URL}?${geocodeParams.toString()}`, 'Google Geocoding');
    const matchedPlace = geocode.results?.[0];

    if (geocode.status !== 'OK' || !matchedPlace?.geometry?.location) {
        throw new Error(geocode.error_message || `Google Geocoding could not resolve "${location}".`);
    }

    const { lat, lng } = matchedPlace.geometry.location;
    const weatherParams = new URLSearchParams({
        key,
        'location.latitude': lat.toString(),
        'location.longitude': lng.toString(),
        unitsSystem: 'METRIC',
        languageCode: 'en'
    });
    const current = await fetchJson(`${GOOGLE_WEATHER_URL}?${weatherParams.toString()}`, 'Google Weather');

    return {
        location: matchedPlace.formatted_address || location,
        temperature: formatDegrees(current.temperature),
        condition: current.weatherCondition?.description?.text || current.weatherCondition?.type || '',
        precipitation: `${current.precipitation?.probability?.percent ?? 0}%`,
        humidity: typeof current.relativeHumidity === 'number' ? `${current.relativeHumidity}%` : '',
        wind: formatWind(current.wind),
        uvIndex: typeof current.uvIndex === 'number' ? current.uvIndex : null,
        cloudCover: typeof current.cloudCover === 'number' ? current.cloudCover : null,
        sourceLabel: 'Google Weather'
    };
}

async function handleWeatherRequest(userInput) {
    const skillContext = loadSkill('weather.md', 'Fetch Open-Meteo weather and return a compact infographic with one useful insight.');
    const location = extractWeatherLocation(userInput);

    if (!location) {
        return {
            reply: 'Which location should I check weather for?',
            category: 'weather',
            task: { type: 'weather_lookup', skillContext }
        };
    }

    try {
        const weather = await fetchOpenMeteoWeather(location);
        return {
            reply: formatWeatherReply(weather),
            category: 'weather',
            task: {
                type: 'weather_lookup',
                source: 'open_meteo',
                location,
                skillContext
            }
        };
    } catch (error) {
        console.error('Open-Meteo weather fetch failed:', error.message);
        return {
            reply: `I couldn't fetch weather for ${location} right now. Try again in a minute?`,
            category: 'weather',
            task: {
                type: 'weather_lookup',
                source: 'open_meteo',
                location,
                error: error.message,
                skillContext
            }
        };
    }
}

const extractPermissionDate = (input) => {
    const match = input.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
    return match ? match[1] : '';
};

const normalizeSearchText = (value = "") => {
    return value
        .toString()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
};

const getSearchWords = (value) => {
    const ignoredWords = new Set([
        "darcy", "please", "pls", "summarize", "summarise", "summary", "recap",
        "ringkas", "rumuskan", "group", "chat", "discussion", "dm", "for", "of",
        "the", "this", "that", "past", "last", "previous", "day", "days", "today",
        "yesterday", "ni", "ini", "tu", "itu"
    ]);

    return normalizeSearchText(value)
        .split(/\s+/)
        .filter(word => word.length >= 3 && !ignoredWords.has(word) && !/^\d{1,3}$/.test(word));
};

const findRequestedGroup = (input, groups = []) => {
    const normalizedInput = normalizeSearchText(input);
    const requestWords = getSearchWords(input);

    const scoredGroups = groups
        .map(group => {
            const groupName = normalizeSearchText(group.name);
            const groupId = normalizeSearchText(group.id);
            const groupWords = getSearchWords(group.name);
            let score = 0;

            if (groupName && normalizedInput.includes(groupName)) score += 100;
            if (groupId && normalizedInput.includes(groupId)) score += 100;
            for (const word of requestWords) {
                if (groupWords.includes(word)) score += 10;
                else if (groupName.includes(word)) score += 5;
            }

            return { group, score };
        })
        .filter(result => result.score > 0)
        .sort((left, right) => right.score - left.score);

    if (!scoredGroups.length) return null;
    if (scoredGroups.length > 1 && scoredGroups[0].score === scoredGroups[1].score) return null;

    return scoredGroups[0].group;
};

const escapeRegExp = (value) => {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
};

const extractGroupMessage = (input, group) => {
    const quotedMatch = input.match(/["“']([^"”']{1,2000})["”']/);
    if (quotedMatch) return quotedMatch[1].trim();

    const colonIndex = input.indexOf(":");
    if (colonIndex >= 0) {
        const afterColon = input.slice(colonIndex + 1).trim();
        if (afterColon) return afterColon;
    }

    const cueMatch = input.match(/\b(?:saying|say|message|msg|text)\b\s+([\s\S]+)$/i);
    if (cueMatch) {
        const message = cueMatch[1].trim();
        if (message) return message;
    }

    if (group?.name) {
        const groupNamePattern = escapeRegExp(group.name);
        const afterGroupMatch = input.match(new RegExp(`${groupNamePattern}\\s+([\\s\\S]+)$`, "i"));
        if (afterGroupMatch) {
            const message = afterGroupMatch[1]
                .replace(/^\b(?:saying|say|message|msg|text|that)\b\s+/i, "")
                .trim();
            if (message) return message;
        }
    }

    return "";
};

const isCommandOnlyMessage = (value, group) => {
    const normalized = normalizeSearchText(value);
    if (!normalized) return true;
    if (/^(this|reply|replied message|quoted message|it)$/i.test(value.trim())) return true;
    if (/^(to|into|in|at)?\s*(the\s+)?(group|chatgroup|discussion|chat)\b/i.test(value.trim())) return true;

    const groupName = normalizeSearchText(group?.name);
    if (groupName && (normalized === groupName || normalized === `group ${groupName}` || normalized === `to group ${groupName}`)) {
        return true;
    }

    return false;
};

const removeQuotedText = (input) => {
    return input.replace(/["“'][^"”']{1,2000}["”']/g, " ");
};

const cleanRecipientName = (value) => {
    return value
        .replace(/\b(?:and\s+)?(?:tag|mention)\b.*$/i, "")
        .replace(/\b(?:at|in|into|to)\s+(?:the\s+)?(?:group|chatgroup|discussion|chat)\b.*$/i, "")
        .replace(/\b(?:the|person|user|member|saying|say|message|msg|text)\b.*$/i, "")
        .replace(/\b(?:at|in|into|to|for)\s*$/i, "")
        .replace(/^[\s@,.:;-]+|[\s@,.:;-]+$/g, "")
        .trim();
};

const extractRecipientName = (input, group) => {
    const withoutMessage = removeQuotedText(input);
    const patterns = [
        /\b(?:tag|mention)\s+@?([\w .'-]{2,80}?)(?=\s+(?:at|in|into|to)\s+(?:the\s+)?(?:group|chatgroup|discussion|chat)\b|$)/i,
        /\b(?:to|for)\s+@?([\w .'-]{2,80})(?:\s*,?\s*(?:and\s+)?(?:tag|mention)\b)/i,
        /\b(?:to|for)\s+@?([\w .'-]{2,80})\s*$/i
    ];

    for (const pattern of patterns) {
        const match = withoutMessage.match(pattern);
        if (!match) continue;

        const recipient = cleanRecipientName(match[1]);
        if (recipient && (!group?.name || normalizeSearchText(recipient) !== normalizeSearchText(group.name))) {
            return recipient;
        }
    }

    return "";
};

async function executeTask(userInput, options) {
    const skillContext = loadSkill('execute_task.md', 'Execute clear operational tasks and ask for missing details.');

    if (isIvantiTTSummaryRequest(userInput)) {
        return disabledOldIvantiRouteResponse(userInput);
    }

    if (!/\b(send|post|tell|message|msg|forward|share|copy)\b/i.test(userInput)) {
        return {
            reply: "I can help, but what task should I execute?",
            category: "execute_task"
        };
    }

    const requestedGroup = findRequestedGroup(userInput, options.groups)
        || (options.isGroup ? { id: options.jid, name: "this group" } : null);
    if (!requestedGroup) {
        return {
            reply: "Which group should I send it to? Mention part of the group name.",
            category: "execute_task"
        };
    }

    const explicitMessage = extractGroupMessage(userInput, requestedGroup);
    const repliedMessage = options.repliedMessageText?.trim() || "";
    const message = explicitMessage && !isCommandOnlyMessage(explicitMessage, requestedGroup)
        ? explicitMessage
        : repliedMessage;
    const usedRepliedMessage = Boolean(message && repliedMessage && message === repliedMessage);
    const recipientName = extractRecipientName(userInput, requestedGroup);
    const recipientMentionJids = options.recipientMentionJids || [];
    const forwardReplyToJid = shouldForwardGroupReplyHere(userInput) ? options.jid : "";
    if (!message) {
        return {
            reply: `What message should I send to ${requestedGroup.name}?`,
            category: "execute_task"
        };
    }

    return {
        reply: `✅ Task ready: sending to ${requestedGroup.name}.`,
        category: "execute_task",
        task: {
            type: "send_message_to_group",
            targetGroupId: requestedGroup.id,
            targetGroupName: requestedGroup.name,
            message,
            usedRepliedMessage,
            forwardReplyToJid,
            recipientName,
            recipientMentionJids,
            skillContext
        }
    };
}

const extractTaskTeamKeyword = (input) => {
    const patterns = [
        /\b(?:task team|team)\s+(?:relate(?:d)?\s+to|related|like|contains|under|for)?\s*["']?([a-z0-9 _()/-]{2,40})["']?/i,
        /\b(?:relate(?:d)?\s+to|contains|under|for)\s+["']?([a-z0-9 _()/-]{2,40})["']?/i,
        /\b(ZTE|Huawei|Ericsson|Nokia|NFCP\d*|SOC)\b/i
    ];

    for (const pattern of patterns) {
        const match = input.match(pattern);
        if (!match) continue;
        const keyword = match[1]
            .replace(/\b(?:current|active|tt|list|summary|summarize|summarise)\b.*$/i, '')
            .trim();
        if (keyword) return keyword;
    }

    return '';
};

const getRecordValues = (record) => record?.values || {};

const getAgeHours = (createdTime) => {
    const created = new Date(createdTime);
    if (Number.isNaN(created.getTime())) return null;
    return Math.max(0, (Date.now() - created.getTime()) / 36e5);
};

const getAgeLabel = (createdTime) => {
    const hours = getAgeHours(createdTime);
    if (hours === null) return 'Unknown';
    if (hours < 4) return '<4h';
    if (hours < 8) return '4-8h';
    if (hours < 24) return '8-24h';
    if (hours < 48) return '1-2d';
    if (hours < 72) return '2-3d';
    return '>3d';
};

const formatShortDate = (value) => {
    if (!value) return '-';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat('en-MY', {
        timeZone: LOCAL_TIME_ZONE,
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    }).format(date);
};

const increment = (map, key) => {
    map.set(key, (map.get(key) || 0) + 1);
};

const formatCountMap = (map) => {
    return [...map.entries()]
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
        .map(([key, count]) => `${key}: ${count}`)
        .join(', ');
};

const addGroupedTT = (groups, key, ttId) => {
    const groupKey = key || 'Blank';
    if (!groups.has(groupKey)) {
        groups.set(groupKey, []);
    }
    groups.get(groupKey).push(ttId || '-');
};

const formatGroupedTT = (groups) => {
    return [...groups.entries()]
        .sort((left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0]))
        .map(([key, ttIds]) => `${key} ${ttIds.length}<${ttIds.join(', ')}>`);
};

const formatRegionTTSummary = (records) => {
    const regions = new Map();

    for (const record of records) {
        const values = getRecordValues(record);
        const region = values.Region || 'Blank';
        if (!regions.has(region)) {
            regions.set(region, {
                pic: new Map(),
                impact: new Map(),
                aging: new Map()
            });
        }

        const regionGroups = regions.get(region);
        const ttId = values['TT ID'] || '-';
        addGroupedTT(regionGroups.pic, values['PIC Group'], ttId);
        addGroupedTT(regionGroups.impact, values.Impact, ttId);
        addGroupedTT(regionGroups.aging, getAgeLabel(values['TT Created Time']), ttId);
    }

    return [...regions.entries()]
        .sort((left, right) => left[0].localeCompare(right[0]))
        .map(([region, groups]) => [
            `${region}:`,
            ...formatGroupedTT(groups.pic),
            ...formatGroupedTT(groups.impact),
            ...formatGroupedTT(groups.aging)
        ].join('\n'))
        .join('\n\n');
};

const isZtePicGroup = (value = '') => {
    return value
        .toString()
        .split(',')
        .map(item => item.trim().toLowerCase())
        .includes('zte');
};

const filterZtePicRecords = (records = []) => {
    return records.filter(record => isZtePicGroup(getRecordValues(record)['PIC Group']));
};

const formatZtePicTTSummary = (records) => {
    const regions = new Map();

    for (const record of records) {
        const values = getRecordValues(record);
        const region = values.Region || 'Blank';
        if (!regions.has(region)) {
            regions.set(region, {
                total: 0,
                impact: new Map(),
                aging: new Map()
            });
        }

        const regionGroups = regions.get(region);
        regionGroups.total += 1;
        increment(regionGroups.impact, values.Impact || 'Blank');
        increment(regionGroups.aging, getAgeLabel(values['TT Created Time']));
    }

    return [...regions.entries()]
        .sort((left, right) => left[0].localeCompare(right[0]))
        .map(([region, groups]) => [
            `${region} ${groups.total}:`,
            ...[...groups.impact.entries()]
                .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
                .map(([impact, count]) => `${impact} ${count}`),
            ...[...groups.aging.entries()]
                .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
                .map(([aging, count]) => `${aging} ${count}`)
        ].join('\n'))
        .join('\n\n');
};

const escapeXml = (value = '') => {
    return value
        .toString()
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
};

const buildSummaryPivot = (records) => {
    const regionImpacts = [...new Set(records.map((record) => {
        const values = getRecordValues(record);
        const region = values.Region || 'Blank';
        const impact = values.Impact || 'Blank';
        return `${region}\u0000${impact}`;
    }))].map((key) => {
        const [region, impact] = key.split('\u0000');
        return { key, region, impact };
    }).sort((left, right) => left.region.localeCompare(right.region) || left.impact.localeCompare(right.impact));

    const rows = new Map();
    for (const record of records) {
        const values = getRecordValues(record);
        const aging = getAgeLabel(values['TT Created Time']);
        const picGroup = values['PIC Group'] || 'Blank';
        const regionImpactKey = `${values.Region || 'Blank'}\u0000${values.Impact || 'Blank'}`;
        const rowKey = `${aging}\u0000${picGroup}`;
        if (!rows.has(rowKey)) {
            const row = { Aging: aging, 'PIC Group': picGroup, Total: 0 };
            for (const item of regionImpacts) row[item.key] = 0;
            rows.set(rowKey, row);
        }
        rows.get(rowKey)[regionImpactKey] += 1;
        rows.get(rowKey).Total += 1;
    }

    const childRows = [...rows.values()].sort((left, right) => {
        const ageOrder = ['<4h', '4-8h', '8-24h', '1-2d', '2-3d', '>3d', 'Unknown'];
        return ageOrder.indexOf(left.Aging) - ageOrder.indexOf(right.Aging)
            || left['PIC Group'].localeCompare(right['PIC Group']);
    });

    const groups = new Map();
    const totalRow = { Aging: 'Total', 'PIC Group': '', Total: 0 };
    for (const item of regionImpacts) totalRow[item.key] = 0;
    for (const row of childRows) {
        if (!groups.has(row.Aging)) {
            const summary = { Aging: row.Aging, 'PIC Group': '', Total: 0 };
            for (const item of regionImpacts) summary[item.key] = 0;
            groups.set(row.Aging, { summary, children: [] });
        }
        const group = groups.get(row.Aging);
        group.children.push(row);
        group.summary.Total += row.Total;
        for (const item of regionImpacts) {
            group.summary[item.key] += row[item.key] || 0;
            totalRow[item.key] += row[item.key] || 0;
        }
        totalRow.Total += row.Total;
    }

    return { regionImpacts, groups: [...groups.values()], totalRow };
};

const buildSummarySnapshotSvg = (snapshot) => {
    const records = filterZtePicRecords(Array.isArray(snapshot.records) ? snapshot.records : []);
    const pivot = buildSummaryPivot(records);
    const columns = ['Aging', 'PIC Group', ...pivot.regionImpacts.map((item) => item.key), 'Total'];
    const colWidths = [82, 190, ...pivot.regionImpacts.map(() => 82), 82];
    const rowHeight = 34;
    const titleHeight = 86;
    const headerHeight = 68;
    const rows = [];
    for (const group of pivot.groups) {
        rows.push({ type: 'group', row: group.summary });
        for (const child of group.children) rows.push({ type: 'child', row: child });
    }
    rows.push({ type: 'total', row: pivot.totalRow });
    const width = colWidths.reduce((sum, value) => sum + value, 0);
    const height = titleHeight + headerHeight + rows.length * rowHeight + 24;
    const xPositions = colWidths.reduce((acc, value, index) => {
        acc.push(index === 0 ? 0 : acc[index - 1] + colWidths[index - 1]);
        return acc;
    }, []);
    const generated = snapshot.generatedAt ? formatLocalDateTime(snapshot.generatedAt) : 'unknown time';
    const rect = (x, y, w, h, fill, stroke = '#d8dee6') => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" stroke="${stroke}"/>`;
    const label = (value, x, y, size = 14, weight = 600, fill = '#17202a', anchor = 'middle') =>
        `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}" font-family="Arial, Helvetica, sans-serif">${escapeXml(value)}</text>`;

    const regionCells = [];
    let regionStart = 2;
    while (regionStart < 2 + pivot.regionImpacts.length) {
        const region = pivot.regionImpacts[regionStart - 2].region;
        let span = 1;
        while (pivot.regionImpacts[regionStart - 2 + span]?.region === region) span += 1;
        const x = xPositions[regionStart];
        const w = colWidths.slice(regionStart, regionStart + span).reduce((sum, value) => sum + value, 0);
        regionCells.push(rect(x, titleHeight, w, 34, '#16415f', '#8fb6d9'));
        regionCells.push(label(region, x + w / 2, titleHeight + 22, 14, 800, '#ffffff'));
        regionStart += span;
    }

    const fixedHeader = [
        { text: 'Aging', col: 0 },
        { text: 'PIC Group', col: 1 },
        { text: 'Total', col: columns.length - 1 },
    ].map((item) => {
        const x = xPositions[item.col];
        return `${rect(x, titleHeight, colWidths[item.col], headerHeight, '#1f527a', '#8fb6d9')}${label(item.text, x + colWidths[item.col] / 2, titleHeight + 40, 14, 800, '#ffffff')}`;
    }).join('');
    const impactHeader = pivot.regionImpacts.map((item, index) => {
        const col = index + 2;
        const x = xPositions[col];
        return `${rect(x, titleHeight + 34, colWidths[col], 34, '#1f527a', '#8fb6d9')}${label(item.impact, x + colWidths[col] / 2, titleHeight + 56, 13, 800, '#ffffff')}`;
    }).join('');
    const rowSvg = rows.map((entry, rowIndex) => {
        const y = titleHeight + headerHeight + rowIndex * rowHeight;
        const fill = entry.type === 'total'
            ? '#dde7f1'
            : entry.type === 'group'
            ? entry.row.Aging === '>3d' ? '#f7c2ca' : ['1-2d', '2-3d'].includes(entry.row.Aging) ? '#ffec9f' : '#d8f0dc'
            : '#f3f3f3';
        return columns.map((column, colIndex) => {
            const x = xPositions[colIndex];
            const raw = colIndex === 1 && entry.type === 'child' ? `> ${entry.row[column]}` : entry.row[column];
            const value = colIndex === 1 && entry.type === 'group' ? '' : raw;
            const anchor = colIndex < 2 ? 'start' : 'middle';
            const textX = anchor === 'start' ? x + 10 : x + colWidths[colIndex] / 2;
            const weight = ['group', 'total'].includes(entry.type) ? 800 : 500;
            return `${rect(x, y, colWidths[colIndex], rowHeight, fill)}${label(value ?? '', textX, y + 22, 13, weight, entry.type === 'child' ? '#555' : '#17202a', anchor)}`;
        }).join('');
    }).join('');

    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<rect width="100%" height="100%" fill="#ffffff"/>
${label('Ivanti Active TT Summary - ZTE PIC Group', 18, 30, 22, 800, '#17202a', 'start')}
${label(`Snapshot: ${generated} | Rows: ${records.length}`, 18, 56, 14, 500, '#657184', 'start')}
${fixedHeader}${regionCells.join('')}${impactHeader}${rowSvg}
</svg>`;
};

// Deprecated: old Ivanti JSON route retained temporarily for reference only.
// Natural Ivanti/TT commands now route through the Excel-backed tool layer.
async function snapTTSummary(skillContext = '') {
    if (!fs.existsSync(IVANTI_CURRENT_JSON)) {
        return {
            reply: `I cannot find the snapshot yet. Please fetch from UI first: ${IVANTI_CURRENT_JSON}`,
            category: "execute_task",
            task: {
                type: "snap_tt_summary",
                jsonPath: IVANTI_CURRENT_JSON,
                skillContext
            }
        };
    }

    const snapshot = JSON.parse(fs.readFileSync(IVANTI_CURRENT_JSON, 'utf8'));
    const svg = buildSummarySnapshotSvg(snapshot);
    await sharp(Buffer.from(svg)).png().toFile(IVANTI_SUMMARY_SNAPSHOT);
    return {
        reply: 'TT summary snapshot ready.',
        category: "execute_task",
        task: {
            type: "send_image",
            filePath: IVANTI_SUMMARY_SNAPSHOT,
            fileName: 'tt-summary-current.png',
            mimetype: 'image/png',
            caption: 'TT summary snapshot',
            skillContext
        }
    };
}

const formatTTListRow = (record, index) => {
    const values = getRecordValues(record);
    return `${index + 1}. ${values['TT ID'] || '-'} | ${values.NE || '-'} | ${values.Subject || '-'} | ${values.Impact || '-'} | ${getAgeLabel(values['TT Created Time'])} | ${values['Task Team'] || '-'}`;
};

const formatZteTTList = (records, regionFilter = '') => {
    const byRegion = new Map();

    for (const record of records) {
        const values = getRecordValues(record);
        const region = values.Region || 'Blank';
        if (regionFilter && region.toLowerCase() !== regionFilter.toLowerCase()) {
            continue;
        }
        if (!byRegion.has(region)) {
            byRegion.set(region, []);
        }
        byRegion.get(region).push(record);
    }

    return [...byRegion.entries()]
        .sort((left, right) => left[0].localeCompare(right[0]))
        .map(([region, regionRecords]) => {
            const rows = regionRecords.map(formatTTListRow);
            return `${region} (${regionRecords.length}):\n${rows.join('\n')}`;
        })
        .join('\n\n');
};

// Deprecated: old Ivanti JSON route retained temporarily for reference only.
// Natural Ivanti/TT commands now route through the Excel-backed tool layer.
async function listZteTTByRegion(region = '', skillContext = '') {
    if (!fs.existsSync(IVANTI_CURRENT_JSON)) {
        return {
            reply: `I cannot find the snapshot yet. Please fetch from UI first: ${IVANTI_CURRENT_JSON}`,
            category: "execute_task",
            task: {
                type: "list_zte_tt",
                jsonPath: IVANTI_CURRENT_JSON,
                filter: { picGroup: 'ZTE', region: region || null },
                skillContext
            }
        };
    }

    const snapshot = JSON.parse(fs.readFileSync(IVANTI_CURRENT_JSON, 'utf8'));
    const records = Array.isArray(snapshot.records) ? snapshot.records : [];
    const zteRecords = records.filter(record => isZtePicGroup(getRecordValues(record)['PIC Group']));
    const list = formatZteTTList(zteRecords, region);
    const matched = region
        ? zteRecords.filter(record => (getRecordValues(record).Region || '').toLowerCase() === region.toLowerCase()).length
        : zteRecords.length;

    if (!matched) {
        return {
            reply: `No active TT found under ZTE PIC Group${region ? ` for ${region}` : ''}.`,
            category: "execute_task",
            task: {
                type: "list_zte_tt",
                jsonPath: IVANTI_CURRENT_JSON,
                filter: { picGroup: 'ZTE', region: region || null },
                matched: 0,
                skillContext
            }
        };
    }

    const generated = snapshot.generatedAt ? formatLocalDateTime(snapshot.generatedAt) : 'unknown time';
    return {
        reply: `Active TT under ZTE PIC Group${region ? ` for ${region}` : ''}: ${matched} TT found.\nSnapshot: ${generated}\n\n${list}`,
        category: "execute_task",
        task: {
            type: "list_zte_tt",
            jsonPath: IVANTI_CURRENT_JSON,
            filter: { picGroup: 'ZTE', region: region || null },
            matched,
            skillContext
        }
    };
}

// Deprecated: old Ivanti JSON route retained temporarily for reference only.
// Natural Ivanti/TT commands now route through the Excel-backed tool layer.
async function checkIvantiTTBySite(site, skillContext = '') {
    if (!fs.existsSync(IVANTI_CURRENT_JSON)) {
        return {
            reply: `I cannot find the snapshot yet. Please fetch from UI first: ${IVANTI_CURRENT_JSON}`,
            category: "execute_task",
            task: {
                type: "check_ivanti_tt_by_site",
                jsonPath: IVANTI_CURRENT_JSON,
                filter: { site },
                skillContext
            }
        };
    }

    const snapshot = JSON.parse(fs.readFileSync(IVANTI_CURRENT_JSON, 'utf8'));
    const records = Array.isArray(snapshot.records) ? snapshot.records : [];
    const filtered = records.filter(record => {
        const ne = getRecordValues(record).NE || '';
        return ne.toString().trim().toUpperCase() === site;
    });

    if (!filtered.length) {
        return {
            reply: `No active TT found for site ${site} in ivanti-current.json.`,
            category: "execute_task",
            task: {
                type: "check_ivanti_tt_by_site",
                jsonPath: IVANTI_CURRENT_JSON,
                filter: { site },
                matched: 0,
                skillContext
            }
        };
    }

    const generated = snapshot.generatedAt ? formatLocalDateTime(snapshot.generatedAt) : 'unknown time';
    const rows = filtered.map((record, index) => {
        const values = getRecordValues(record);
        return `${index + 1}. ${values['TT ID'] || '-'} | ${values.NE || '-'} | ${values.Subject || '-'} | ${values.Status || '-'} | L${values['TT Level'] || '-'} | ${values.Impact || '-'} | ${formatShortDate(values['TT Created Time'])} | Aging ${getAgeLabel(values['TT Created Time'])} | PIC ${values['PIC Group'] || '-'} | ${values['Task Team'] || '-'}`;
    });

    return {
        reply: `Active TT for site ${site}: ${filtered.length} found.\nSnapshot: ${generated}\n\n${rows.join('\n')}`,
        category: "execute_task",
        task: {
            type: "check_ivanti_tt_by_site",
            jsonPath: IVANTI_CURRENT_JSON,
            filter: { site },
            matched: filtered.length,
            skillContext
        }
    };
}

// Deprecated: old Ivanti JSON route retained temporarily for reference only.
// Natural Ivanti/TT commands now route through the Excel-backed tool layer.
async function summarizeIvantiTTJson(userInput, skillContext = '') {
    if (!fs.existsSync(IVANTI_CURRENT_JSON)) {
        return {
            reply: `I cannot find the snapshot yet. Please fetch from UI first: ${IVANTI_CURRENT_JSON}`,
            category: "execute_task",
            task: {
                type: "summarize_ivanti_tt_json",
                jsonPath: IVANTI_CURRENT_JSON,
                skillContext
            }
        };
    }

    const keyword = extractTaskTeamKeyword(userInput);
    const snapshot = JSON.parse(fs.readFileSync(IVANTI_CURRENT_JSON, 'utf8'));
    const records = Array.isArray(snapshot.records) ? snapshot.records : [];
    const filtered = records.filter(record => isZtePicGroup(getRecordValues(record)['PIC Group']));

    if (!filtered.length) {
        return {
            reply: 'No active TT found under ZTE PIC Group in ivanti-current.json.',
            category: "execute_task",
            task: {
                type: "summarize_ivanti_tt_json",
                jsonPath: IVANTI_CURRENT_JSON,
                filter: { picGroup: 'ZTE' },
                matched: 0,
                skillContext
            }
        };
    }

    const generated = snapshot.generatedAt ? formatLocalDateTime(snapshot.generatedAt) : 'unknown time';
    const groupedSummary = formatZtePicTTSummary(filtered);

    return {
        reply: `Current active TT under ZTE PIC Group: ${filtered.length} TT found.\nSnapshot: ${generated}\n\n${groupedSummary}`,
        category: "execute_task",
        task: {
            type: "summarize_ivanti_tt_json",
            jsonPath: IVANTI_CURRENT_JSON,
            filter: { picGroup: 'ZTE' },
            matched: filtered.length,
            skillContext
        }
    };
}

const getSummaryRangeDays = (input) => {
    const normalized = input.toLowerCase();
    const daysMatch = normalized.match(/\b(?:past|last|previous)\s+(\d{1,3})\s+days?\b/);
    if (daysMatch) return Number(daysMatch[1]);

    const genericDaysMatch = normalized.match(/\b(\d{1,3})\s+days?\b/);
    if (genericDaysMatch) return Number(genericDaysMatch[1]);

    if (/\byesterday\b/i.test(input)) return 1;
    if (/\btoday\b/i.test(input)) return 1;

    return 2;
};

const getSinceTimestamp = (days) => {
    const since = new Date();
    since.setDate(since.getDate() - days);
    return since.toISOString();
};

const buildHistoryText = (rows) => {
    return rows.length
        ? rows.map(row => `[${formatLocalDateTime(row.timestamp)}] ${row.sender}: ${row.message}`).join('\n')
        : "";
};

const formatSummaryReply = (reply) => {
    return reply
        .replace(/\s+Key points:\s*/i, '\n\nKey points:\n')
        .replace(/\s+Need attention:\s*/i, '\n\nNeed attention: ')
        .replace(/\s+-\s+/g, '\n- ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
};

async function summarizeChat(userInput, options, jid, currentLocalTime) {
    const skillContext = loadSkill('summarize.md', 'Summarize the provided chat history clearly and briefly.');
    const requestedGroup = !options.isGroup ? findRequestedGroup(userInput, options.groups) : null;
    const targetJid = requestedGroup?.id || jid;
    const targetLabel = requestedGroup?.name || (options.isGroup ? 'current group chat' : 'current DM/dashboard');

    if (!options.isGroup && /\b(group|chatgroup|discussion)\b/i.test(userInput) && !requestedGroup) {
        return {
            reply: "Which group should I summarize? Mention part of the group name and I’ll pull it from the chat history.",
            category: "summarize"
        };
    }

    const rangeDays = getSummaryRangeDays(userInput);
    const sinceTimestamp = getSinceTimestamp(rangeDays);
    const summaryHistory = await getHistorySince(targetJid, sinceTimestamp, 800);
    const historyText = buildHistoryText(summaryHistory);

    if (!historyText) {
        return {
            reply: `No chat history found for ${targetLabel} in the past ${rangeDays} day${rangeDays === 1 ? '' : 's'}.`,
            category: "summarize"
        };
    }

    const systemPrompt = `You are Darcy, a friendly WhatsApp assistant.
${skillContext}

Important:
- Current local date/time: ${currentLocalTime}.
- The chat history below comes from database.sqlite for ${targetLabel}.
- Summarize only the supplied chat history.
- Ignore the user's summarize request itself if it appears in the history.
- If no exact days were requested, the selected range is past 2 days.
- Use this exact layout with real line breaks:
Summary: one short natural sentence.

Key points:
- short point
- short point

Need attention: short follow-up note, only if needed.
- Put each bullet on its own line.
- Keep each bullet short, specific, and WhatsApp-friendly.
- Add "Need attention:" only when there is something to follow up.
- Only return the final summary.`;

    const userPrompt = `User request: ${userInput}
Target chat: ${targetLabel}
Selected range: past ${rangeDays} day${rangeDays === 1 ? '' : 's'}

Chat history:
${historyText}

Darcy summary:`;

    const reply = await generateContent(systemPrompt, userPrompt, "speed", { maxOutputTokens: 450 });

    return {
        reply: formatSummaryReply(reply),
        category: "summarize"
    };
}

async function detectIntent(userInput, historyText = '', businessMemoryContext = '') {
    const intentSkill = loadSkill(
        'detect_intent.md',
        'Classify the user input as exactly one of: troubleshoot, reasoning, execute_task, conversation.'
    );

    const systemPrompt = `You are Darcy's intent router.
${intentSkill}

Important:
- Return only one category name.
- If unsure, return conversation.`;

    const userPrompt = `${businessMemoryContext ? `${businessMemoryContext}\n\n` : ''}Recent conversation:
${historyText || '(none)'}

User input:
${userInput}

Category:`;

    const rawCategory = await generateContent(systemPrompt, userPrompt, "speed", { maxOutputTokens: 20 });
    return normalizeIntentCategory(rawCategory);
}

async function respondWithSkill(category, userInput, historyText, currentLocalTime, businessMemoryContext = '') {
    const skillContext = loadSkill(`${category}.md`, 'Be a helpful 5G project assistant.');
    const tier = (category === 'reasoning' || category === 'troubleshoot') ? 'pro' : 'speed';

    const systemPrompt = `You are Darcy, a friendly WhatsApp assistant.
${skillContext}

Important:
- Current local date/time: ${currentLocalTime}.
- Treat that current local date/time as the source of truth for today, tomorrow, yesterday, and now.
- Use the recent conversation only as context, not as something to summarize unless the user asks.
- Respond directly to the user's request.
- Do not explain or repeat the instructions.
- Do not restate the skill text.
- Do not show your reasoning or internal options.
- Keep the answer concise, practical, and WhatsApp-friendly.
- Fallback replies may only do conversation, explanation, advice, brainstorming, or drafting text.
- Never claim an operational action was completed unless a backend/tool result already confirmed it.
- Do not say "Done", "I have sent", "I updated", "I scheduled", or "I checked" for operational actions.
- Use Business Memory Context only when it is directly relevant to the user's request.
- Do not infer or invent business memory that is not provided in the context.
- Only return Darcy's final reply.`;

    const userPrompt = `${businessMemoryContext ? `${businessMemoryContext}\n\n` : ''}Recent conversation:
${historyText || '(none)'}

User: ${userInput}
Darcy:`;

    const reply = enforceSafeOperationalReply(
        await generateContent(systemPrompt, userPrompt, tier, { maxOutputTokens: 350 })
    );

    return {
        reply,
        category,
        decision: {
            category,
            tier,
            source: 'detect_intent'
        }
    };
}

const isDebugReminderWorkerRequest = (input = '') => {
    return /\bdarcy\b[\s\S]*\bdebug\s+run\s+reminder\s+worker\b/i.test(input)
        || /^\s*debug\s+run\s+reminder\s+worker\s*$/i.test(input);
};

const formatReminderWorkerSummary = (summary = {}) => [
    'Reminder worker debug',
    `scanned: ${summary.scanned ?? 0}`,
    `due: ${summary.due ?? 0}`,
    `sent: ${summary.sent ?? 0}`,
    `skipped: ${summary.skipped ?? 0}`,
    `failed: ${summary.failed ?? 0}`,
    `next_remind_at_myt = ${summary.next_remind_at_myt || '-'}`,
    `reason: ${summary.reason || 'ok'}`
].join('\n');

const createReminderWorkerContext = (options = {}) => {
    const wrappedSock = typeof options.sendMessage === 'function'
        ? { sendMessage: options.sendMessage }
        : null;
    const sock = wrappedSock || options.sock || null;

    return {
        getSock: () => sock,
        getIsConnected: () => Boolean(sock),
        addMessageToDB: wrappedSock
            ? async () => {}
            : addMessageToDB
    };
};

async function routeDebugReminderWorker(userInput, options = {}) {
    if (!isDebugReminderWorkerRequest(userInput)) return null;

    console.log('[ORDER_REMINDER_WORKER_STARTED]', {
        taskId: 'order_reminder_followup',
        source: 'whatsapp_debug_command',
        jid: options.jid || ''
    });

    try {
        const summary = await sendDueOrderReminders(createReminderWorkerContext(options));
        return {
            reply: formatReminderWorkerSummary(summary),
            category: 'order_debug',
            task: {
                type: 'order_reminder_worker_debug',
                summary
            }
        };
    } catch (error) {
        console.error('[ORDER_REMINDER_ERROR]', {
            source: 'whatsapp_debug_command',
            error: error.message
        });
        return {
            reply: formatReminderWorkerSummary({
                scanned: 1,
                due: 0,
                sent: 0,
                skipped: 0,
                failed: 1,
                reason: error.message
            }),
            category: 'order_debug'
        };
    }
}

const parseMcpDebugCommand = (input = '') => {
    const trimmed = input.trim();
    const mcpText = trimmed.replace(/^(?:@?darcy|!darcy)\s*[,:\-]?\s+/i, '');
    const genericTest = mcpText.match(/^mcp\s+test\s+([a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+)(?:\s+([\s\S]+))?\s*$/i);
    if (genericTest && getTool(genericTest[1])) {
        let args = {};
        const rawArgs = (genericTest[2] || '').trim();
        if (rawArgs) {
            try {
                args = JSON.parse(rawArgs);
            } catch {
                args = { query: rawArgs };
            }
        }
        return {
            intent: genericTest[1],
            args
        };
    }

    if (/^mcp\s+(?:list\s+tools|tools)\s*$/i.test(mcpText)) {
        return {
            intent: 'mcp.listTools',
            args: {}
        };
    }

    if (/^mcp\s+test\s+order\s+list\s*$/i.test(mcpText)) {
        return {
            intent: 'order.list',
            args: {}
        };
    }

    const detail = mcpText.match(/^mcp\s+test\s+order\s+detail\s+(WO-\d{6})\s*$/i);
    if (detail) {
        return {
            intent: 'order.detail',
            args: { orderRef: detail[1].toUpperCase() }
        };
    }

    const mos = mcpText.match(/^mcp\s+test\s+iepms\s+mos\s+([a-z0-9_-]+)\s*$/i);
    if (mos) {
        console.log(`[MCP_TEST_MOS_RECEIVED] site=${mos[1].toUpperCase()}`);
        return {
            intent: 'iepms.mos.lookup',
            args: { site: mos[1].toUpperCase() }
        };
    }

    if (/^mcp\s+test\s+iepms\s+projects?\s+sync\s*$/i.test(mcpText)) {
        return {
            intent: 'iepms.projects.sync',
            args: {}
        };
    }

    const doDnMaterial = mcpText.match(/^mcp\s+test\s+iepms\s+(?:do|dn|dodn)\s+material\s+(.+?)(?:\s+(?:at|in|for)\s+([a-z0-9_-]+))?\s*$/i);
    if (doDnMaterial) {
        const material = doDnMaterial[1].trim();
        return {
            intent: 'iepms.doDn.material.check',
            args: {
                itemKeyword: material,
                siteCode: doDnMaterial[2] ? doDnMaterial[2].toUpperCase() : '',
                matchMode: 'contains'
            }
        };
    }

    if (/^mcp\s+test\s+ivanti\s+source\s*$/i.test(mcpText)) {
        return {
            intent: 'ivanti.ticket.summary',
            args: { sourceOnly: true }
        };
    }

    const ivantiLookup = mcpText.match(/^mcp\s+test\s+ivanti\s+ticket\s+lookup\s+([a-z0-9_-]+)\s*$/i);
    if (ivantiLookup) {
        return {
            intent: 'ivanti.ticket.lookup',
            args: { site: ivantiLookup[1].toUpperCase() }
        };
    }

    const ivantiList = mcpText.match(/^mcp\s+test\s+ivanti\s+ticket\s+list(?:\s+(sabah|sarawak))?\s*$/i);
    if (ivantiList) {
        return {
            intent: 'ivanti.ticket.list',
            args: {
                region: ivantiList[1] ? ivantiList[1].slice(0, 1).toUpperCase() + ivantiList[1].slice(1).toLowerCase() : ''
            }
        };
    }

    if (/^mcp\s+test\s+ivanti\s+ticket\s+summary\s*$/i.test(mcpText)) {
        return {
            intent: 'ivanti.ticket.summary',
            args: {}
        };
    }

    if (/^mcp\s+test\s+ivanti\s+ticket\s+snapshot\s*$/i.test(mcpText)) {
        return {
            intent: 'ivanti.ticket.snapshot',
            args: {}
        };
    }

    const permissionCheck = mcpText.match(/^mcp\s+test\s+iepms\s+permission\s+check\s+(.+?)\s*$/i);
    if (permissionCheck) {
        return {
            intent: 'iepms.permission.check',
            args: { identifier: permissionCheck[1].trim() }
        };
    }

    const permissionExtend = mcpText.match(/^mcp\s+test\s+iepms\s+permission\s+extend\s+(.+?)\s*$/i);
    if (permissionExtend) {
        const value = permissionExtend[1].trim();
        const date = extractPermissionDate(value);
        console.log('[MCP_PERMISSION_EXTEND_MATCHED]');
        return {
            intent: 'iepms.permission.extend',
            args: {
                target: date ? value.replace(date, '').trim() : value,
                extendUntil: date
            }
        };
    }

    const clara = mcpText.match(/^mcp\s+test\s+clara\s+(available|total)?\s*(?:inventory\s+)?(.+?)(?:\s+in\s+(.+?))?\s*$/i);
    if (/^mcp\s+test\s+clara\s+config\s*$/i.test(mcpText)) {
        return {
            intent: 'clara.config',
            args: {}
        };
    }

    if (/^mcp\s+test\s+clara\s+health\s*$/i.test(mcpText)) {
        return {
            intent: 'clara.health',
            args: {}
        };
    }

    if (/^mcp\s+test\s+clara\s+columns\s*$/i.test(mcpText)) {
        return {
            intent: 'clara.inventory.columns',
            args: {}
        };
    }

    if (/^mcp\s+test\s+clara\s+data\s*$/i.test(mcpText)) {
        return {
            intent: 'clara.inventory.data',
            args: { limit: 10, offset: 0 }
        };
    }

    if (clara) {
        return {
            intent: 'clara.inventory.lookup',
            args: {
                mode: clara[1]?.toLowerCase() === 'total' ? 'total' : 'available',
                products: [clara[2].trim()],
                regions: clara[3] ? [clara[3].trim()] : []
            }
        };
    }

    return null;
};

async function routeMcpDebugCommand(userInput, options = {}) {
    const command = parseMcpDebugCommand(userInput);
    if (!command) return null;

    if (command.intent === 'mcp.listTools') {
        return {
            reply: listTools().map(tool => tool.intent).join('\n') || 'No MCP tools registered.',
            category: 'mcp_debug',
            task: {
                type: 'mcp_debug',
                intent: command.intent,
                success: true,
                code: 'MCP_TOOLS_LISTED'
            }
        };
    }

    const result = await executeMcpTool(command.intent, command.args, {
        ...options,
        requireReadOnly: !['iepms.permission.extend', 'iepms.projects.sync'].includes(command.intent)
    });

    return {
        reply: command.intent === 'order.detail'
            || command.intent === 'order.list'
            || command.intent === 'iepms.mos.lookup'
            || command.intent === 'iepms.doDn.material.check'
            || command.intent.startsWith('iepms.permission.')
            || command.intent.startsWith('ivanti.ticket.')
                ? withSourceMarker(result.success
                    ? result.message
                    : formatMcpToolFailure(command.intent, result.message), 'MCP')
                : result.success
                    ? result.message
                    : formatMcpToolFailure(command.intent, result.message),
        category: 'mcp_debug',
        task: {
            type: 'mcp_debug',
            intent: command.intent,
            success: result.success,
            code: result.code
        }
    };
}

const parseMcpOrderReadCommand = (input = '') => {
    const text = stripRequestPrefix(stripDarcyPrefix(input));

    if (/^(?:check|list)\s+all\s+(?:work\s+)?orders?\s*$/i.test(text)) {
        return {
            intent: 'order.list',
            args: {}
        };
    }

    const listMatch = text.match(/^(?:show|check|list)\s+(active|pending|completed|overdue)\s+(?:work\s+)?orders?\s*$/i);
    if (listMatch) {
        return {
            intent: 'order.list',
            args: { statusFilter: listMatch[1].toLowerCase() }
        };
    }

    const detailMatch = text.match(/^(?:check\s+order|status|detail|show)\s+(WO-\d{6})\s*$/i)
        || text.match(/^(?:what\s+is|what'?s|how\s+is)\s+(WO-\d{6})\s+(?:status|doing)\??\s*$/i);
    if (detailMatch) {
        return {
            intent: 'order.detail',
            args: { orderRef: detailMatch[1].toUpperCase() }
        };
    }

    return null;
};

const isOldOrderReadMigrationCommand = (input = '') => {
    const text = stripDarcyPrefix(input);
    return /^(?:check\s+order|status|detail|show)\s+(WO-\d{6})\s*$/i.test(text)
        || /^(?:check|list)\s+(?:all\s+)?(?:work\s+)?orders?\s*$/i.test(text)
        || /^(?:show|check|list)\s+(active|pending|completed|overdue)\s+(?:work\s+)?orders?\s*$/i.test(text);
};

const markOldOrderReadResponse = (userInput, response) => {
    if (!isOldOrderReadMigrationCommand(userInput)) return response;
    return markResponseSource(response, 'OLD');
};

const parseMcpMosReadCommand = (input = '') => {
    const text = stripDarcyPrefix(input);
    const patterns = [
        /^check\s+mos\s+([a-z0-9_-]+)\s*$/i,
        /^mos\s+([a-z0-9_-]+)\s*$/i,
        /^check\s+iepms\s+mos\s+([a-z0-9_-]+)\s*$/i,
        /^check\s+mos\s+for\s+([a-z0-9_-]+)\s*$/i,
        /^show\s+mos\s+([a-z0-9_-]+)\s*$/i
    ];

    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match) {
            return {
                intent: 'iepms.mos.lookup',
                args: { site: match[1].toUpperCase() }
            };
        }
    }

    return null;
};

const parseIepmsProjectSyncCommand = (input = '') => {
    const text = stripDarcyPrefix(input);
    if (
        /^(?:sync|refresh|update)\s+iepms\s+projects?\s*$/i.test(text)
        || /^sync\s+projects?\s+from\s+iepms\s*$/i.test(text)
    ) {
        return { intent: 'iepms.projects.sync', args: {} };
    }
    return null;
};

const parseMcpScanRangeCommand = (input = '') => {
    const text = stripDarcyPrefix(input);
    const patterns = [
        /^check\s+scan\s+range\s+([a-z0-9_-]+)\s*$/i,
        /^help\s+to\s+check\s+scan\s+range\s+([a-z0-9_-]+)\s*$/i
    ];

    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match) {
            return {
                intent: 'iepms.scan.range.check',
                args: { site: match[1].toUpperCase() }
            };
        }
    }

    return null;
};

const parseMcpDoDnMaterialCommand = (input = '') => {
    const text = stripDarcyPrefix(input);
    const patterns = [
        /^check\s+(?:do|dn|dodn)\s+material\s+(.+?)(?:\s+(?:at|in|for)\s+(site\s+)?([a-z0-9_-]+))?\s*$/i,
        /^(?:do|dn|dodn)\s+material\s+(.+?)(?:\s+(?:at|in|for)\s+(site\s+)?([a-z0-9_-]+))?\s*$/i,
        /^total\s+(?:do|dn|dodn)\s+(?:qty|quantity)\s+(.+?)(?:\s+(?:at|in|for)\s+(site\s+)?([a-z0-9_-]+))?\s*$/i
    ];

    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (!match) continue;
        const material = match[1].trim();
        return {
            intent: 'iepms.doDn.material.check',
            args: {
                itemKeyword: material,
                siteCode: match[2] ? (match[3] || '').toUpperCase() : '',
                location: match[2] ? '' : (match[3] || ''),
                matchMode: 'contains'
            }
        };
    }

    return null;
};

const KNOWN_DODN_LOCATIONS = new Set([
    'SABAH',
    'SARAWAK',
    'CENTRAL',
    'NORTHERN',
    'SOUTHERN',
    'EASTERN',
    'KLANG VALLEY',
    'KV',
    'EAST MALAYSIA',
    'WEST MALAYSIA'
]);

const DODN_OPERATIONAL_WORD_PATTERN = /\b(?:released?|delivery\s+order|delivery\s+note|\bdo\b|\bdn\b|dodn|outbound)\b/i;
const DODN_COMMON_CASUAL_ITEMS = new Set([
    'PEOPLE',
    'PERSON',
    'PERSONS',
    'TIME',
    'TIMES',
    'DAY',
    'DAYS',
    'HOUR',
    'HOURS',
    'MINUTE',
    'MINUTES',
    'LUNCH',
    'DINNER',
    'FOOD',
    'MONEY'
]);

const DODN_QUERY_PATTERNS = [
    /^\s*(?:darcy\s+)?how\s+many\s+(.+?)\s+(?:released\s+)?(?:in|at|for)\s+(.+?)\s*\??\s*$/i,
    /^\s*(?:darcy\s+)?(?:total|qty|quantity)\s+(.+?)\s+(?:released\s+)?(?:in|at|for)\s+(.+?)\s*\??\s*$/i,
    /^\s*(?:darcy\s+)?check\s+(.+?)\s+(?:released\s+)?(?:in|at|for)\s+(.+?)\s*\??\s*$/i,
    /^(?!\s*(?:darcy\s+)?(?:how\s+many|total|qty|quantity|check)\b)\s*(?:darcy\s+)?(.+?)\s+(?:released\s+)?(?:in|at|for)\s+(.+?)\s*\??\s*$/i
];

function cleanDoDnQueryPart(value = '') {
    return String(value || '')
        .replace(/\?+$/g, '')
        .replace(/\b(?:material|materials|released|release|outbound|delivery)\b/ig, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function cleanDoDnTarget(value = '') {
    return cleanDoDnQueryPart(value)
        .replace(/^site\s+/i, '')
        .trim();
}

function looksLikeSiteCode(value = '') {
    const text = String(value || '').trim().toUpperCase();
    return /^[A-Z]{2,6}\d{3,}$/i.test(text);
}

function isKnownDoDnLocation(value = '') {
    return KNOWN_DODN_LOCATIONS.has(String(value || '').trim().replace(/\s+/g, ' ').toUpperCase());
}

function isProbablyDoDnItemKeyword(value = '') {
    const text = String(value || '').trim();
    if (!text || text.length < 2) return false;
    const normalized = text.replace(/\s+/g, ' ').toUpperCase();
    if (DODN_COMMON_CASUAL_ITEMS.has(normalized)) return false;
    return /[A-Z]/i.test(text) && /[A-Z0-9]/i.test(text);
}

export function parseDoDnNaturalQuery(text = '') {
    const raw = String(text || '').trim();
    if (!raw) return null;
    if (/\b(?:clara|inventory|stock|parquet|latest_merged_data|do\s+we\s+have)\b/i.test(raw)) return null;

    console.log('[DODN_NATURAL_QUERY_CHECK]', { text: raw });

    for (const pattern of DODN_QUERY_PATTERNS) {
        const match = raw.match(pattern);
        if (!match) continue;

        const itemKeyword = cleanDoDnQueryPart(match[1]);
        const target = cleanDoDnTarget(match[2]);
        if (!itemKeyword || !target || !isProbablyDoDnItemKeyword(itemKeyword)) continue;

        const isSite = /\bsite\b/i.test(raw) || looksLikeSiteCode(target);
        const isKnownLocation = isKnownDoDnLocation(target);
        const hasOperationalWord = DODN_OPERATIONAL_WORD_PATTERN.test(raw);
        if (!hasOperationalWord) continue;
        if (!isSite && !isKnownLocation) continue;

        const args = {
            itemKeyword,
            ...(isSite ? { siteCode: target.toUpperCase() } : { location: target }),
            matchMode: 'contains'
        };
        return {
            tool: 'iepms.doDn.material.check',
            intent: 'iepms.doDn.material.check',
            confidence: 0.95,
            args
        };
    }

    return null;
}

const formatRouteDebugReply = (input = '', parsed = null) => {
    const lines = [
        'Route Debug',
        '',
        `Input: ${input}`,
        `Matched: ${parsed ? 'yes' : 'no'}`
    ];

    if (!parsed) {
        lines.push('Fallback: conversation');
        return lines.join('\n');
    }

    lines.push(`Tool: ${parsed.tool}`);
    lines.push('Args:');
    for (const [key, value] of Object.entries(parsed.args || {})) {
        lines.push(`- ${key}: ${value}`);
    }
    return lines.join('\n');
};

const parseRouteDebugCommand = (input = '') => {
    const text = stripDarcyPrefix(input);
    const match = text.match(/^debug\s+route\s+([\s\S]+?)\s*$/i);
    return match ? match[1].trim() : '';
};

const parseMcpIvantiCommand = (input = '') => {
    const text = stripRequestPrefix(stripDarcyPrefix(input));

    if (/^(?:snap|snapshot)\s+tt\s+summary\s*$/i.test(text)
        || /^take\s+tt\s+snapshot\s*$/i.test(text)) {
        return {
            intent: 'ivanti.ticket.snapshot',
            args: {}
        };
    }

    if (/^(?:ivanti\s+summary|tt\s+summary|active\s+tt\s+summary|summari[sz]e\s+tt|summari[sz]e\s+active\s+tt|current\s+tt\s+summary|show\s+active\s+tt\s+summary|summari[sz]e\s+current\s+tt\s+active\s+list\s+under\s+task\s+team\s+relate\s+to\s+zte)\s*$/i.test(text)) {
        return {
            intent: 'ivanti.ticket.summary',
            args: {}
        };
    }

    const listTt = text.match(/^(?:list(?:\s+down)?|show(?:\s+(?:active|down|all))?)\s+tt(?:\s+(?:in\s+)?(sabah|sarawak))?\s*$/i);
    if (listTt) {
        return {
            intent: 'ivanti.ticket.list',
            args: {
                region: listTt[1] ? listTt[1].slice(0, 1).toUpperCase() + listTt[1].slice(1).toLowerCase() : ''
            }
        };
    }

    const lookupPatterns = [
        /^check\s+tt\s+([a-z0-9_-]+)\s*$/i,
        /^tt\s+([a-z0-9_-]+)\s*$/i,
        /^check\s+ivanti\s+([a-z0-9_-]+)\s*$/i,
        /^any\s+active\s+tt\s+for\s+([a-z0-9_-]+)\s*$/i,
        /^show\s+tt\s+for\s+([a-z0-9_-]+)\s*$/i
    ];

    for (const pattern of lookupPatterns) {
        const match = text.match(pattern);
        if (match) {
            return {
                intent: 'ivanti.ticket.lookup',
                args: { site: match[1].toUpperCase() }
            };
        }
    }

    return null;
};

const isIvantiTtCommandFamily = (input = '') => {
    const text = stripDarcyPrefix(input);
    return /\bivanti\b/i.test(text)
        || /\btt\b/i.test(text)
        || /\bticket\b/i.test(text);
};

const disabledOldIvantiRouteResponse = (userInput = '') => {
    console.log('[OLD_IVANTI_ROUTE_DISABLED]', { input: stripDarcyPrefix(userInput) });
    return {
        reply: 'Ivanti command not understood. Try: check TT <site>, list TT, TT summary, or snap TT summary.',
        category: 'mcp_ivanti',
        task: {
            type: 'old_ivanti_route_disabled',
            success: false,
            code: 'OLD_IVANTI_ROUTE_DISABLED'
        }
    };
};

const cleanPermissionIdentifier = (value = '') => value
    .replace(/\b(?:to|until|expiry|expire|expires|date|on)\b/gi, ' ')
    .replace(/[,:;]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const parseMcpPermissionCommand = (input = '') => {
    const text = stripDarcyPrefix(input);
    const patterns = [
        {
            intent: 'iepms.permission.check',
            match: text.match(/^check\s+permission\s+(.+?)\s*$/i)
        },
        {
            intent: 'iepms.permission.check',
            match: text.match(/^permission\s+check\s+(.+?)\s*$/i)
        },
        {
            intent: 'iepms.permission.check',
            match: text.match(/^check\s+site\s+access\s+(.+?)\s*$/i)
        },
        {
            intent: 'iepms.permission.check',
            match: text.match(/^site\s+access\s+(.+?)\s*$/i)
        },
        {
            intent: 'iepms.permission.extend',
            match: text.match(/^extend\s+permission\s+(.+?)\s*$/i)
        },
        {
            intent: 'iepms.permission.extend',
            match: text.match(/^permission\s+extend\s+(.+?)\s*$/i)
        },
        {
            intent: 'iepms.permission.extend',
            match: text.match(/^extend\s+site\s+access\s+(.+?)\s*$/i)
        },
        {
            intent: 'iepms.permission.check',
            match: text.match(/^permission\s+(.+?)\s*$/i)
        }
    ];

    for (const item of patterns) {
        if (!item.match) continue;
        const rawValue = item.match[1].trim();
        if (/\biepms\.permission\.[a-z0-9._-]+\b/i.test(rawValue)) return null;
        const date = extractPermissionDate(rawValue);
        const identifier = cleanPermissionIdentifier(date ? rawValue.replace(date, ' ') : rawValue);
        if (item.intent === 'iepms.permission.extend') {
            console.log('[MCP_PERMISSION_EXTEND_MATCHED]');
        }
        return {
            intent: item.intent,
            args: item.intent === 'iepms.permission.extend'
                ? { target: identifier, extendUntil: date }
                : { identifier }
        };
    }

    return null;
};

const isPermissionCommandFamily = (input = '') => {
    const text = stripDarcyPrefix(input);
    return /\bpermission\b/i.test(text) || /\bsite\s+access\b/i.test(text);
};

const permissionHelpResponse = () => {
    console.log('[MCP_PERMISSION_HELP_RETURNED]');
    return {
        reply: withSourceMarker([
            'Permission command not understood.',
            'Examples:',
            '- permission 6237001067',
            '- extend permission 6237001067 2026-06-30'
        ].join('\n'), 'MCP'),
        category: 'mcp_permission',
        task: {
            type: 'mcp_permission',
            intent: 'iepms.permission.help',
            success: false,
            code: 'MCP_PERMISSION_COMMAND_NOT_UNDERSTOOD'
        }
    };
};

const formatMcpToolFailure = (intent, message = '') => {
    return message.startsWith('[MCP]')
        ? message
        : `MCP ${intent} failed: ${message}`;
};

const getMcpReadTaskType = (intent = '') => {
    if (intent.startsWith('iepms.projects.')) return 'mcp_iepms_projects';
    if (intent.startsWith('iepms.mos.')) return 'mcp_mos';
    if (intent.startsWith('iepms.scan.')) return 'mcp_scan_range';
    if (intent.startsWith('iepms.doDn.')) return 'mcp_do_dn';
    if (intent.startsWith('ivanti.ticket.')) return 'mcp_ivanti';
    return 'mcp_order';
};

async function routeIepmsProjectSyncCommand(userInput, options = {}) {
    const command = parseIepmsProjectSyncCommand(userInput);
    if (!command) return null;
    console.log('[IEPMS_PROJECT_SYNC_COMMAND_MATCHED]');
    const result = await executeMcpTool(command.intent, command.args, {
        ...options,
        requireReadOnly: false
    });
    return {
        reply: withSourceMarker(result.success ? result.message : formatMcpToolFailure(command.intent, result.message), 'MCP'),
        category: 'mcp_iepms_projects',
        task: {
            type: 'mcp_iepms_projects',
            intent: command.intent,
            success: result.success,
            code: result.code
        }
    };
}

async function executeMcpReadCommand(command, options = {}) {
    console.log(`[MCP_EXECUTE] intent=${command.intent}`);
    console.log(`[MCP] ${command.intent}`);
    const result = await executeMcpTool(command.intent, command.args, {
        ...options,
        requireReadOnly: true
    });
    console.log(`[MCP_RESULT] intent=${command.intent} success=${result.success} code=${result.code}`);
    const reply = result.success
        ? result.message
        : options.skipMcpSourceMarker || command.intent.startsWith('ivanti.ticket.')
            ? result.message
        : formatMcpToolFailure(command.intent, result.message);

    return {
        reply: options.skipMcpSourceMarker ? reply : withSourceMarker(reply, 'MCP'),
        category: getMcpReadTaskType(command.intent),
        task: {
            type: getMcpReadTaskType(command.intent),
            intent: command.intent,
            success: result.success,
            code: result.code
        },
        order: result.data?.order,
        orders: result.data?.orders
    };
}

async function executeMcpPermissionCommand(command, options = {}) {
    console.log(`[MCP_PERMISSION_NATURAL_EXECUTE] intent=${command.intent}`);
    const result = await executeMcpTool(command.intent, command.args, {
        ...options,
        requireReadOnly: command.intent !== 'iepms.permission.extend'
    });
    console.log(`[MCP_PERMISSION_NATURAL_RESULT] intent=${command.intent} success=${result.success} code=${result.code}`);

    return {
        reply: withSourceMarker(result.success
            ? result.message
            : formatMcpToolFailure(command.intent, result.message), 'MCP'),
        category: 'mcp_permission',
        task: {
            type: 'mcp_permission',
            intent: command.intent,
            success: result.success,
            code: result.code
        }
    };
}

async function routeMcpOrderReadCommand(userInput, options = {}) {
    const command = parseMcpOrderReadCommand(userInput);
    if (!command) return null;

    console.log(`[MCP_ORDER_COMMAND_MATCHED] intent=${command.intent}`);
    const response = await executeMcpReadCommand(command, { ...options, skipMcpSourceMarker: true });
    console.log(`[MCP_FALLBACK_SKIPPED] intent=${command.intent}`);
    return response;
}

async function routeMcpMosReadCommand(userInput, options = {}) {
    const command = parseMcpMosReadCommand(userInput);
    if (!command) return null;

    console.log(`[MCP_MOS_COMMAND_MATCHED] intent=${command.intent} site=${command.args.site}`);
    const response = await executeMcpReadCommand(command, { ...options, skipMcpSourceMarker: true });
    console.log(`[MCP_FALLBACK_SKIPPED] intent=${command.intent}`);
    return response;
}

async function routeMcpScanRangeCommand(userInput, options = {}) {
    const command = parseMcpScanRangeCommand(userInput);
    if (!command) return null;

    console.log(`[MCP_SCAN_RANGE_COMMAND_MATCHED] intent=${command.intent} site=${command.args.site}`);
    return executeMcpReadCommand(command, { ...options, skipMcpSourceMarker: true });
}

async function routeMcpDoDnMaterialCommand(userInput, options = {}) {
    const command = parseMcpDoDnMaterialCommand(userInput);
    if (!command) return null;

    console.log('[MCP_DO_DN_COMMAND_MATCHED]', command.args);
    return executeMcpReadCommand(command, { ...options, skipMcpSourceMarker: true });
}

async function routeDoDnNaturalQuery(userInput, options = {}) {
    const parsed = parseDoDnNaturalQuery(userInput);
    if (!parsed) return null;

    console.log('[DODN_NATURAL_QUERY_MATCH]', {
        tool: parsed.tool,
        args: parsed.args,
        confidence: parsed.confidence
    });
    return executeMcpReadCommand({
        intent: parsed.tool,
        args: parsed.args
    }, { ...options, skipMcpSourceMarker: true });
}

const routeDebugRouteCommand = (userInput = '') => {
    const input = parseRouteDebugCommand(userInput);
    if (!input) return null;
    const parsed = parseDoDnNaturalQuery(input);
    return {
        reply: formatRouteDebugReply(input, parsed),
        category: 'debug_route',
        task: {
            type: 'debug_route',
            success: true,
            code: parsed ? 'DODN_ROUTE_MATCHED' : 'ROUTE_NOT_MATCHED',
            intent: parsed?.tool || null,
            args: parsed?.args || null
        }
    };
};

async function routeMcpIvantiCommand(userInput, options = {}) {
    const command = parseMcpIvantiCommand(userInput);
    if (!command) return null;

    console.log(`[MCP_IVANTI_COMMAND_MATCHED] intent=${command.intent}`);
    return executeMcpReadCommand(command, { ...options, skipMcpSourceMarker: true });
}

async function routeMcpPermissionCommand(userInput, options = {}) {
    const command = parseMcpPermissionCommand(userInput);
    if (!command) {
        return isPermissionCommandFamily(userInput) ? permissionHelpResponse() : null;
    }

    console.log(`[MCP_PERMISSION_PERMANENT_MATCHED] intent=${command.intent}`);
    return executeMcpPermissionCommand(command, options);
}

const normalizePendingJid = (value = '') => value.toString().trim().toLowerCase().replace(/:\d+(?=@)/, '');

const getPendingMcpKey = (options = {}) => {
    const requester = normalizePendingJid(options.senderJid || options.sender_jid || options.jid || 'dashboard');
    const source = normalizePendingJid(options.jid || 'dashboard');
    return `${requester}|${source}`;
};

const getPendingMcpIntent = (options = {}) => {
    const key = getPendingMcpKey(options);
    const pending = pendingMcpIntents.get(key);
    if (!pending) return null;
    if (new Date(pending.expiresAt).getTime() <= Date.now()) {
        pendingMcpIntents.delete(key);
        return null;
    }
    return pending;
};

const storePendingMcpIntent = ({ decision, question, options = {} }) => {
    const key = getPendingMcpKey(options);
    const expiresAt = new Date(Date.now() + PENDING_MCP_INTENT_TTL_MS).toISOString();
    const pending = {
        requesterJid: normalizePendingJid(options.senderJid || options.sender_jid || options.jid || 'dashboard'),
        sourceJid: normalizePendingJid(options.jid || 'dashboard'),
        intent: decision.intent,
        partialArgs: decision.args || {},
        clarificationQuestion: question,
        expiresAt
    };
    pendingMcpIntents.set(key, pending);
    return pending;
};

const executeUniversalMcpIntent = async ({ intent, args, confidence, options = {} }) => {
    console.log(`[MCP_INTENT_EXECUTE] intent=${intent}`);
    console.log(`[MCP] ${intent}`);
    const result = await executeMcpTool(intent, args, {
        ...options,
        requireReadOnly: true
    });
    console.log(`[MCP_RESULT] intent=${intent} success=${result.success} code=${result.code}`);

    const category = intent.startsWith('iepms.mos.')
        ? 'mcp_mos'
        : intent.startsWith('iepms.doDn.')
            ? 'mcp_do_dn'
        : intent.startsWith('clara.')
            ? 'mcp_clara'
            : 'mcp_order';
    return {
        reply: result.success
            ? result.message
            : formatMcpToolFailure(intent, result.message),
        category,
        task: {
            type: 'universal_mcp_intent',
            intent,
            confidence,
            success: result.success,
            code: result.code
        },
        order: result.data?.order,
        orders: result.data?.orders
    };
};

async function routeDeterministicReadOnlyIntent(userInput, options = {}) {
    const pending = getPendingMcpIntent(options);
    if (pending) {
        const filled = fillPendingIntentArgs(pending, userInput, options);
        if (filled.ready) {
            pendingMcpIntents.delete(getPendingMcpKey(options));
            console.log(`[MCP_INTENT_CONFIRMED] intent=${filled.intent}`);
            return executeUniversalMcpIntent({
                intent: filled.intent,
                args: filled.args,
                confidence: 1,
                options
            });
        }

        if (filled.intent && filled.intent !== pending.intent) {
            const nextDecision = {
                intent: filled.intent,
                args: pending.partialArgs || {}
            };
            storePendingMcpIntent({
                decision: nextDecision,
                question: filled.question,
                options
            });
            console.log(`[MCP_INTENT_CLARIFY] intent=${filled.intent}`);
            return {
                reply: filled.question,
                category: 'mcp_clarification',
                task: {
                    type: 'mcp_clarification',
                    intent: filled.intent,
                    success: false,
                    code: 'MCP_INTENT_CLARIFY'
                }
            };
        }

        console.log(`[MCP_INTENT_CLARIFY] intent=${pending.intent}`);
        return {
            reply: filled.question || pending.clarificationQuestion,
            category: 'mcp_clarification',
            task: {
                type: 'mcp_clarification',
                intent: pending.intent,
                success: false,
                code: 'MCP_INTENT_STILL_MISSING_ARGS'
            }
        };
    }

    const decision = detectReadOnlyIntent(userInput, options);
    if (!decision.matched) return null;

    console.log(`[MCP_INTENT_DETECTED] intent=${decision.intent}`);
    console.log(`[INTENT_CONFIDENCE] intent=${decision.intent} confidence=${decision.confidence}`);

    if (decision.needsClarification) {
        console.log(`[MCP_INTENT_MISSING_ARGS] intent=${decision.intent} missing=${decision.missingArgs.join(',')}`);
        const pendingIntent = storePendingMcpIntent({
            decision,
            question: decision.clarification,
            options
        });
        console.log(`[MCP_INTENT_CLARIFY] intent=${decision.intent} expires_at=${pendingIntent.expiresAt}`);
        return {
            reply: decision.clarification,
            category: 'mcp_clarification',
            task: {
                type: 'mcp_clarification',
                intent: decision.intent,
                confidence: decision.confidence,
                success: false,
                code: 'MCP_INTENT_MISSING_ARGS'
            }
        };
    }

    if (decision.confidence < DEFAULT_INTENT_CONFIDENCE_THRESHOLD) {
        if (decision.clarification) {
            const pendingIntent = storePendingMcpIntent({
                decision,
                question: decision.clarification,
                options
            });
            console.log(`[MCP_INTENT_CLARIFY] intent=${decision.intent} expires_at=${pendingIntent.expiresAt}`);
            return {
                reply: decision.clarification,
                category: 'mcp_clarification',
                task: {
                    type: 'mcp_clarification',
                    intent: decision.intent,
                    confidence: decision.confidence,
                    success: false,
                    code: 'MCP_INTENT_LOW_CONFIDENCE'
                }
            };
        }
        console.log(`[MCP_INTENT_FALLBACK] intent=${decision.intent} confidence=${decision.confidence}`);
        return null;
    }

    return executeUniversalMcpIntent({
        intent: decision.intent,
        args: decision.args,
        confidence: decision.confidence,
        options
    });
}

export async function darcyRouter(userInput, options = {}) {
    const jid = options.jid?.toString().trim().toLowerCase() || 'dashboard';
    const currentLocalTime = formatLocalDateTime();
    const topLevelDebug = await routeTopLevelDebugCommand(userInput, options);
    if (topLevelDebug) return topLevelDebug;

    const doDnCacheCommand = await routeDoDnCacheCommand(userInput, options);
    if (doDnCacheCommand) return doDnCacheCommand;

    const mcpDebug = await routeMcpDebugCommand(userInput, options);
    if (mcpDebug) return mcpDebug;

    const projectSync = await routeIepmsProjectSyncCommand(userInput, options);
    if (projectSync) return projectSync;

    const routeDebug = routeDebugRouteCommand(userInput);
    if (routeDebug) return routeDebug;

    const memoryAnswer = await answerBusinessMemoryQuestion(userInput);
    if (memoryAnswer) return memoryAnswer;
    const unavailableMemoryAnswer = await answerKnownButUnavailableMemoryQuestion(userInput);
    if (unavailableMemoryAnswer) return unavailableMemoryAnswer;

    const memory = await getBusinessMemoryContext(userInput);
    if (memory.context) {
        options = {
            ...options,
            businessMemoryContext: memory.context,
            businessMemoryEntries: memory.entries
        };
    }

    if (claraInventoryTask.canHandle(userInput)) {
        console.log('[CLARA_OLD_ROUTE_USED]');
        const disabled = disabledTaskReply('clara_inventory_lookup', 'CLARA Inventory Lookup');
        if (disabled) return disabled;
        return claraInventoryTask.handle(userInput);
    }

    const mcpPermission = await routeMcpPermissionCommand(userInput, options);
    if (mcpPermission) return mcpPermission;

    const mcpScanRange = await routeMcpScanRangeCommand(userInput, options);
    if (mcpScanRange) return mcpScanRange;

    const mcpDoDnMaterial = await routeMcpDoDnMaterialCommand(userInput, options);
    if (mcpDoDnMaterial) return mcpDoDnMaterial;

    const mcpIvanti = await routeMcpIvantiCommand(userInput, options);
    if (mcpIvanti) return mcpIvanti;
    if (isIvantiTtCommandFamily(userInput)) {
        return disabledOldIvantiRouteResponse(userInput);
    }

    const deterministicIntent = await routeDeterministicReadOnlyIntent(userInput, options);
    if (deterministicIntent) return deterministicIntent;

    const doDnNaturalQuery = await routeDoDnNaturalQuery(userInput, options);
    if (doDnNaturalQuery) return doDnNaturalQuery;

    const mcpOrderRead = await routeMcpOrderReadCommand(userInput, options);
    if (mcpOrderRead) return mcpOrderRead;

    const mcpMosRead = await routeMcpMosReadCommand(userInput, options);
    if (mcpMosRead) return mcpMosRead;

    const debugReminderWorker = await routeDebugReminderWorker(userInput, options);
    if (debugReminderWorker) return debugReminderWorker;

    if (mosScanTask.canHandle(userInput)) {
        return markResponseSource(await mosScanTask.handle(userInput), 'OLD');
    }

    const pendingAction = await routeOrderActionConfirmation(userInput, options);
    if (pendingAction) return pendingAction;
    if (isOrderIntent(userInput)) {
        return markOldOrderReadResponse(userInput, await routeOrderRequest(userInput, options));
    }

    const orderConversation = await routeOrderConversation(userInput, options);
    if (orderConversation) return orderConversation;

    const responseDecision = shouldDarcyRespond(userInput, options);
    logReplyDecision(responseDecision);
    if (responseDecision.mode === 'silent') {
        return {
            reply: '',
            category: 'silent',
            silent: true,
            decision: responseDecision
        };
    }
    if (responseDecision.mode === 'clarify') {
        return {
            reply: 'Sure, what should I check?',
            category: 'clarify',
            decision: responseDecision
        };
    }

    const checkTTSite = extractCheckTTSite(userInput);
    if (checkTTSite) {
        return disabledOldIvantiRouteResponse(userInput);
    }

    const listTT = extractListTTRegion(userInput);
    if (listTT) {
        return disabledOldIvantiRouteResponse(userInput);
    }

    if (isSnapTTSummaryRequest(userInput)) {
        return disabledOldIvantiRouteResponse(userInput);
    }

    if (isIvantiTTSummaryRequest(userInput)) {
        return disabledOldIvantiRouteResponse(userInput);
    }

    if (isWeatherRequest(userInput)) {
        const disabled = disabledTaskReply('weather_check', 'Automate weather checking');
        if (disabled) return disabled;
        return handleWeatherRequest(userInput);
    }

    if (isExecuteTaskRequest(userInput)) {
        const disabled = disabledTaskReply('send_message_to_group', 'Send Message');
        if (disabled) return disabled;
        return executeTask(userInput, options);
    }

    if (isSummarizeRequest(userInput)) {
        return summarizeChat(userInput, options, jid, currentLocalTime);
    }

    const unsupportedAction = detectUnsupportedAction(userInput, options);
    if (unsupportedAction.unsupported) {
        return {
            reply: unsupportedAction.message,
            category: 'capability_guard',
            task: {
                type: 'capability_guard',
                success: false,
                code: 'CAPABILITY_GUARD_BLOCKED',
                reason: unsupportedAction.reason
            },
            capabilityRegistry: unsupportedAction.registry
        };
    }

    const recentHistory = await getRecentHistory(jid, 25);
    const historyText = buildHistoryText(recentHistory);
    const detectedCategory = await detectIntent(userInput, historyText, memory.context);

    return respondWithSkill(detectedCategory, userInput, historyText, currentLocalTime, memory.context);
}
