import { toolSchemaFields, toolSchemas } from './schemas.js';
import { orderTools } from './tools/order.tools.js';
import { iepmsToolRegistry } from '../integrations/iepms/registry/iepmsRegistry.js';
import { claraToolRegistry } from '../integrations/clara/registry/claraRegistry.js';
import { ivantiToolRegistry } from '../integrations/ivanti/registry/ivantiRegistry.js';

function mergeToolRegistries(...registries) {
    return registries.reduce((merged, registry = {}) => {
        for (const [intent, tool] of Object.entries(registry)) {
            if (merged[intent]) {
                console.warn(`[MCP_TOOL_DUPLICATE] tool=${intent} action=overwrite`);
            }
            merged[intent] = tool;
        }
        return merged;
    }, {});
}

const registeredTools = mergeToolRegistries(
    orderTools,
    iepmsToolRegistry,
    claraToolRegistry,
    ivantiToolRegistry
);

for (const toolName of Object.keys(registeredTools)) {
    console.log(`[MCP_TOOL_REGISTERED] tool=${toolName}`);
}

export function getTool(intent) {
    return registeredTools[intent] || null;
}

export function listTools() {
    return Object.values(registeredTools).map(tool => ({
        intent: tool.intent,
        description: tool.description,
        readOnly: Boolean(tool.readOnly),
        schema: {
            fields: toolSchemaFields[tool.intent] || []
        }
    }));
}

export function getSchema(intent) {
    return toolSchemas[intent] || null;
}

export function isRegisteredIntent(intent) {
    return Boolean(getTool(intent));
}
