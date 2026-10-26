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
 * @property {(context: { avatar?: string | null, groupId?: string | null }) => Record<string, any>} settingsFor The
 *   settings in a context: the speaking character's and its group's statements over the user's.
 * @property {(context: { avatar?: string | null, groupId?: string | null }, range?: { from: string, to: string }) => { settings: Record<string, any>, sources: Record<string, string> }} view
 *   The settings in a context over a range of levels (settings-document.js LEVEL_POSITIONS), and the level each bundle
 *   field's value comes from.
 * @property {(context: { avatar?: string | null, groupId?: string | null }, range: { from: string, to: string }, saved: Record<string, any>) => Promise<void>} saveIn
 *   A save of settings shown by view(): each change written to the range's top level (a bundle's field or selection)
 *   or the user's.
 * @property {(holder: string, change: { bundles?: Record<string, string | null>, set?: Record<string, unknown>, delete?: string[] }) => Promise<void>} writeLevel
 *   Changes a character's (`character:<avatar>`) or group's (`group:<id>`) statements: bundles stated (null: none),
 *   overrides set and deleted.
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
