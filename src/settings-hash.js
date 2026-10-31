import { FIELDS, SERVER_FAMILIES } from '@st/settings/protocol';
import { getAtPath, getStringHash, setAtPath } from '../public/scripts/hash-utils.js';

export const SERVER_OWNED_PATHS = ['background', ...FIELDS.filter(field => SERVER_FAMILIES.includes(field.family)).map(field => field.path)];

/**
 * @param {Record<string, any>} settings
 * @param {string} path
 */
function deleteAtPath(settings, path) {
    const keys = path.split('.');
    const parents = [settings];
    for (const key of keys.slice(0, -1)) {
        const next = parents.at(-1)?.[key];
        if (next === null || typeof next !== 'object') return;
        parents.push(next);
    }
    delete parents.at(-1)[keys.at(-1)];
}

/**
 * @param {string} path
 * @param {unknown} value
 * @param {Record<string, unknown>} current
 * @returns {{ value: unknown } | null}
 */
export function pageWrite(path, value, current) {
    if (SERVER_OWNED_PATHS.some(owned => path === owned || path.startsWith(`${owned}.`))) return null;
    const under = SERVER_OWNED_PATHS.filter(owned => owned.startsWith(`${path}.`));
    if (under.length === 0 || value === null || typeof value !== 'object') return { value };
    const out = structuredClone(value);
    for (const owned of under) {
        const rest = owned.slice(path.length + 1);
        const kept = getAtPath(current, owned);
        if (kept === undefined) deleteAtPath(/** @type {Record<string, any>} */ (out), rest);
        else setAtPath(out, rest, structuredClone(kept));
    }
    return { value: out };
}

/**
 * @param {Record<string, unknown>} saved
 * @param {Record<string, unknown>} current
 */
export function withServerOwned(saved, current) {
    const out = structuredClone(saved);
    for (const owned of SERVER_OWNED_PATHS) {
        const kept = getAtPath(current, owned);
        if (kept === undefined) deleteAtPath(out, owned);
        else setAtPath(out, owned, structuredClone(kept));
    }
    return out;
}

/**
 * @param {Record<string, unknown>} settings
 */
export function pageSettingsHash(settings) {
    return getStringHash(JSON.stringify(pageSettings(settings), null, 4));
}

/**
 * @param {Record<string, unknown>} settings
 */
export function pageSettings(settings) {
    const page = structuredClone(settings);
    for (const owned of SERVER_OWNED_PATHS) deleteAtPath(page, owned);
    return page;
}
