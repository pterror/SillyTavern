import { newUi } from './new-ui-page.js';

const compat = () => newUi().backgrounds;

export const background_settings = new Proxy(/** @type {Record<string, unknown>} */ ({}), {
    get: (_target, key) => Reflect.get(compat().background_settings, key),
    set: (_target, key, value) => Reflect.set(compat().background_settings, key, value),
    has: (_target, key) => key in compat().background_settings,
    ownKeys: () => Reflect.ownKeys(compat().background_settings),
    getOwnPropertyDescriptor: (_target, key) => ({ ...Reflect.getOwnPropertyDescriptor(compat().background_settings, key), configurable: true }),
});

/** @param {string} fileUrl */
export function getBackgroundPath(fileUrl) {
    return compat().getBackgroundPath(fileUrl);
}

/** @param {string} fileUrl */
export function isCustomBackgroundUrl(fileUrl) {
    return compat().isCustomBackgroundUrl(fileUrl);
}

/** @returns {{ file: string, chat: boolean }[]} */
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
