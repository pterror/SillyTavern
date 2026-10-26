import { readSettingsAtPaths, valuesAtPaths } from './settings-store.js';
import { settingsDocumentOf } from './settings-documents.js';

/**
 * Where the server reads settings (the settings model, step 6). A reader asks for upstream-shaped values at dotted
 * paths and gets what the cascade resolves for its context: a generation for its chat and speaker, anything else
 * for the user alone, both from the user's settings document (settings-document.js) once the model holds them.
 */

/**
 * @typedef {object} SettingsContext Whose settings a generation reads: its chat and the character speaking.
 * @property {string | null} [avatar] The speaking character's avatar.
 * @property {string | null} [groupId] The group, in a group chat.
 * @property {string | null} [tree] The chat's tree.
 * @property {string | null} [nodeId] The position in it.
 */

/**
 * Settings as a generation in this context reads them.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {SettingsContext} context
 * @param {string[]} paths
 * @returns {Record<string, any>}
 */
export function readSettingsFor(directories, context, paths) {
    const document = settingsDocumentOf(directories);
    // The settings files state nothing at a chat or a character: there every context reads the user's.
    if (!document) return readSettingsAtPaths(directories, paths);
    return valuesAtPaths(document.settingsFor({ avatar: context.avatar, groupId: context.groupId }), paths);
}

/**
 * The user's own settings, no chat or character's (preferences, catalogs, the library's options), each limited value
 * within what its model allows, as a generation's are.
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
 * A generation's settings context from what its request names.
 * @param {{ avatar?: string | null, groupId?: string | null, chat?: { tree: bigint } | null, nodeId?: string | null }} names
 * @returns {SettingsContext}
 */
export function settingsContextOf({ avatar = null, groupId = null, chat = null, nodeId = null }) {
    return { avatar: avatar || null, groupId: groupId || null, tree: chat ? String(chat.tree) : null, nodeId: nodeId ?? null };
}
