import path from 'node:path';

/**
 * The users' open settings documents (settings-document.js), by user root: what settings-store.js reads and writes
 * once a user's settings are the model's. A leaf, so settings-store.js reaches the documents without importing the
 * store.
 */

/**
 * @typedef {object} OpenSettingsDocument
 * @property {Record<string, any>} settings The settings, upstream-shaped, as the model gives them now.
 * @property {(next: Record<string, any>) => Promise<void>} replace Makes `next` the settings: shown at once, durable
 *   when the promise settles.
 * @property {() => Promise<void>} reset Back to a new user's settings.
 * @property {() => import('./settings-model/settings-compat.js').UserModel} model The model as last written.
 */

/** @type {Map<string, OpenSettingsDocument>} */
const documents = new Map();

/**
 * @param {{ root: string }} directories
 */
function keyOf(directories) {
    return path.resolve(directories.root);
}

/**
 * @param {{ root: string }} directories
 * @returns {OpenSettingsDocument | undefined}
 */
export function settingsDocumentOf(directories) {
    // Directories without a root (a route test's few folders) are no user's: their files.
    return typeof directories?.root === 'string' ? documents.get(keyOf(directories)) : undefined;
}

/**
 * @param {{ root: string }} directories
 * @param {OpenSettingsDocument | undefined} document
 */
export function setSettingsDocument(directories, document) {
    if (document) documents.set(keyOf(directories), document);
    else documents.delete(keyOf(directories));
}
