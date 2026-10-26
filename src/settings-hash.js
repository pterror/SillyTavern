import { getStringHash } from '../public/scripts/hash-utils.js';

/** Settings keys the server owns now (the new page's): the page neither saves them nor counts them in its hash. */
export const SERVER_OWNED_SETTINGS = new Set(['background']);

/**
 * The settings' hash as the page knows them: without the keys the server owns, which the page neither keeps current
 * nor saves, so a change to one of them is never a conflict for the page's save. Every route that answers the page a
 * settings hash answers this one.
 * @param {Record<string, unknown>} settings
 */
export function pageSettingsHash(settings) {
    const page = Object.fromEntries(Object.entries(settings).filter(([key]) => !SERVER_OWNED_SETTINGS.has(key)));
    return getStringHash(JSON.stringify(page, null, 4));
}
