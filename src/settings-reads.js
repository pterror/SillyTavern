import { readSettingsAtPaths, valuesAtPaths } from './settings-store.js';
import { settingsDocumentOf } from './settings-documents.js';

/**
 * @typedef {object} SettingsContext
 * @property {string | null} [avatar]
 * @property {string | null} [groupId]
 * @property {string | null} [tree]
 * @property {string | null} [nodeId]
 */

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {SettingsContext} context
 * @param {string[]} paths
 * @returns {Record<string, any>}
 */
export function readSettingsFor(directories, context, paths) {
    const document = settingsDocumentOf(directories);
    if (!document) return readSettingsAtPaths(directories, paths);
    return valuesAtPaths(document.settingsFor({ avatar: context.avatar, groupId: context.groupId }), paths);
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string[]} paths
 * @returns {Record<string, any>}
 */
export function readUserSettings(directories, paths) {
    const document = settingsDocumentOf(directories);
    if (!document) return readSettingsAtPaths(directories, paths);
    return valuesAtPaths(document.settingsFor({}), paths);
}

/**
 * @param {{ avatar?: string | null, groupId?: string | null, chat?: { tree: bigint } | null, nodeId?: string | null }} names
 * @returns {SettingsContext}
 */
export function settingsContextOf({ avatar = null, groupId = null, chat = null, nodeId = null }) {
    return { avatar: avatar || null, groupId: groupId || null, tree: chat ? String(chat.tree) : null, nodeId: nodeId ?? null };
}
