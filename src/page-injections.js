import { extension_prompt_roles, extension_prompt_types } from './prompt/injections.js';

const MAX_INJECTIONS = 500;
const MAX_INJECTION_LENGTH = 1_000_000;

const POSITIONS = new Set(Object.values(extension_prompt_types));
const ROLES = new Set(Object.values(extension_prompt_roles));

/**
 * @param {unknown} body
 * @returns {import('./prompt/injections.js').PageInjections}
 */
export function readPageInjections(body) {
    /** @type {import('./prompt/injections.js').PageInjections} */
    const out = {};
    if (!body || typeof body !== 'object' || Array.isArray(body)) return out;
    for (const [key, entry] of Object.entries(body).slice(0, MAX_INJECTIONS)) {
        if (!entry || typeof entry !== 'object') continue;
        const { value, position, depth, scan, role } = /** @type {Record<string, unknown>} */ (entry);
        if (typeof value !== 'string' || value.length > MAX_INJECTION_LENGTH) continue;
        if (typeof position !== 'number' || !POSITIONS.has(position)) continue;
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
