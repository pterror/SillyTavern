import { newUi } from './new-ui.js';

// Upstream's backgrounds module, kept for extensions that import it: the backgrounds are the new page's now
// (packages/ui/src/areas/backgrounds). Each name reads the new page's, which the server keeps current.

const compat = () => newUi().backgrounds;

/** Upstream's settings object: reads the server's view; a write is sent as the action it means. */
export const background_settings = new Proxy(/** @type {Record<string, unknown>} */ ({}), {
    get: (_target, key) => Reflect.get(compat().background_settings, key),
    set: (_target, key, value) => Reflect.set(compat().background_settings, key, value),
    has: (_target, key) => key in compat().background_settings,
    ownKeys: () => Reflect.ownKeys(compat().background_settings),
    getOwnPropertyDescriptor: (_target, key) => ({ ...Reflect.getOwnPropertyDescriptor(compat().background_settings, key), configurable: true }),
});

export async function getBackgrounds() {
    await compat().getBackgrounds();
}

export function initBackgrounds() {
    compat().initBackgrounds();
}

/** @param {unknown} settings */
export function loadBackgroundSettings(settings) {
    compat().loadBackgroundSettings(settings);
}

/** @param {string} fileUrl */
export function getBackgroundPath(fileUrl) {
    return compat().getBackgroundPath(fileUrl);
}

/** @param {string} fileUrl */
export function isCustomBackgroundUrl(fileUrl) {
    return compat().isCustomBackgroundUrl(fileUrl);
}

export function getActiveBackgroundTab() {
    return compat().getActiveBackgroundTab();
}

// Not upstream's: for the old page's own /bg and its suggestions, which read the backgrounds from the new page.

/** @returns {{ file: string, chat: boolean }[]} Every background there is to pick: the system's, then the chat's. */
export function listBackgroundFiles() {
    return compat().listBackgroundFiles();
}

/**
 * Picks a background as a click on it would.
 * @param {string} file
 * @param {boolean} chat Whether it's one of the open chat's.
 * @returns {Promise<string | null>} Why nothing was picked, or null.
 */
export function selectBackground(file, chat) {
    return compat().selectBackground(file, chat);
}
