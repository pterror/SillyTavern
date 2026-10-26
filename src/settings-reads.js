import { readSettingsAtPaths } from './settings-store.js';

/**
 * Where the server reads settings (the settings model, step 6). A reader asks for upstream-shaped values at dotted
 * paths and gets what the cascade resolves for its context: a generation for its chat and speaker, anything else
 * for the user alone. Until the model holds settings (its step 10) both read the settings file, where nothing is
 * stated at a chat or a character; then these two are what changes.
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
    // The file states nothing at a chat or a character: every context reads the user's.
    void context;
    return readSettingsAtPaths(directories, paths);
}

/**
 * The user's own settings, no chat or character's (preferences, catalogs, the library's options).
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string[]} paths
 * @returns {Record<string, any>}
 */
export function readUserSettings(directories, paths) {
    return readSettingsAtPaths(directories, paths);
}

/**
 * A generation's settings context from what its request names.
 * @param {{ avatar?: string | null, groupId?: string | null, chat?: { tree: bigint } | null, nodeId?: string | null }} names
 * @returns {SettingsContext}
 */
export function settingsContextOf({ avatar = null, groupId = null, chat = null, nodeId = null }) {
    return { avatar: avatar || null, groupId: groupId || null, tree: chat ? String(chat.tree) : null, nodeId: nodeId ?? null };
}
