import { claraInventoryTools } from '../modules/inventory/inventory.tools.js';

export const claraToolRegistry = {
    ...claraInventoryTools
};

export function listClaraTools() {
    return Object.keys(claraToolRegistry);
}
