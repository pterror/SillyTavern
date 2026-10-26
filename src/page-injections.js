import { extension_prompt_roles, extension_prompt_types } from './extension-prompt-table.js';

/**
 * What the page's extensions and scripts inject into a prompt (`/inject`, an extension's setExtensionPrompt()), sent
 * with a generation the server builds (`extension_prompts`): they run in the page, the prompt is built here.
 */

/** The most injections one generation takes, and the longest one. */
const MAX_INJECTIONS = 500;
const MAX_INJECTION_LENGTH = 1_000_000;

const POSITIONS = new Set(Object.values(extension_prompt_types));
const ROLES = new Set(Object.values(extension_prompt_roles));

/**
 * Reads the injections the page sent, keeping only what has the right shape.
 * @param {unknown} body
 * @returns {import('./extension-prompt-table.js').ExtensionPromptTable}
 */
export function readPageInjections(body) {
    /** @type {import('./extension-prompt-table.js').ExtensionPromptTable} */
    const out = {};
    if (!body || typeof body !== 'object' || Array.isArray(body)) return out;
    for (const [key, entry] of Object.entries(body).slice(0, MAX_INJECTIONS)) {
        if (!entry || typeof entry !== 'object') continue;
        const { value, position, depth, scan, role } = /** @type {Record<string, unknown>} */ (entry);
        if (typeof value !== 'string' || value.length > MAX_INJECTION_LENGTH) continue;
        if (typeof position !== 'number' || !POSITIONS.has(position)) continue;
        // Only a place in the chat has a depth. The page stores a missing one as NaN (null here): in the chat, the
        // page's own build never places it; elsewhere it doesn't matter.
        const hasDepth = Number.isInteger(depth) && /** @type {number} */ (depth) >= 0;
        if (!hasDepth && position === extension_prompt_types.IN_CHAT) continue;
        out[key] = {
            value,
            position,
            depth: hasDepth ? /** @type {number} */ (depth) : 0,
            scan: scan === true,
            role: typeof role === 'number' && ROLES.has(role) ? role : extension_prompt_roles.SYSTEM,
        };
    }
    return out;
}
