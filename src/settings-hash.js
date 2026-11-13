import { FIELDS, SERVER_FAMILIES } from '@st/settings/protocol';
import { getAtPath, getStringHash, setAtPath } from '../public/scripts/hash-utils.js';

export const SERVER_OWNED_PATHS = ['background', ...FIELDS.filter(field => SERVER_FAMILIES.includes(field.family)).map(field => field.path)];

// Settings only the server's own actions change, never a save from the page: the worlds used in every chat.
const SERVER_WRITTEN_PATHS = ['world_info_settings.world_info'];
const NOT_THE_PAGES = [...SERVER_OWNED_PATHS, ...SERVER_WRITTEN_PATHS];

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
    if (NOT_THE_PAGES.some(owned => path === owned || path.startsWith(`${owned}.`))) return null;
    const under = NOT_THE_PAGES.filter(owned => owned.startsWith(`${path}.`));
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
    for (const owned of NOT_THE_PAGES) {
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
    for (const owned of NOT_THE_PAGES) deleteAtPath(page, owned);
    return page;
}
