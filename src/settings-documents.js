import path from 'node:path';

/**
 * @typedef {object} OpenSettingsDocument
 * @property {Record<string, any>} settings
 * @property {(next: Record<string, any>) => Promise<void>} replace
 * @property {() => Promise<void>} reset
 * @property {() => import('./settings-model/settings-compat.js').UserModel} model
 * @property {(context: { avatar?: string | null, groupId?: string | null }) => Record<string, any>} settingsFor
 * @property {(context: { avatar?: string | null, groupId?: string | null }, range?: { from: string, to: string }) => { settings: Record<string, any>, sources: Record<string, string> }} view
 * @property {(context: { avatar?: string | null, groupId?: string | null }, range: { from: string, to: string }, saved: Record<string, any>) => Promise<void>} saveIn
 * @property {(context: { avatar?: string | null, groupId?: string | null }, range: { from: string, to: string }, path: string, value: unknown) => Promise<void>} writeAt
 * @property {(context: { avatar?: string | null, groupId?: string | null }, range: { from: string, to: string }, entries: [string, unknown][]) => Promise<void>} writeAll
 * @property {(holder: string, change: { bundles?: Record<string, string | null>, set?: Record<string, unknown>, delete?: string[] }) => Promise<void>} writeLevel
 * @property {<T extends { choosers: BookChooser[] }>(change: () => Promise<T>) => Promise<T & { settings: Record<string, unknown> }>} booksChanged
 */

/**
 * @typedef {{ holder: bigint, slot: number, type: number | null, key: string | null }} BookChooser
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
