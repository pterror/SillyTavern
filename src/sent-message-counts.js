import { readSettingsFor, settingsContextOf } from './settings-reads.js';
import { countWithConnection } from './connection-counts.js';
import { countInto, openingAlternatives } from './message-counts.js';
import { openingState } from './opening-state.js';

/** @typedef {import('./message-counts.js').CountSources} CountSources */

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {import('./settings-reads.js').SettingsContext} settingsContext
 */
export function messageCountsShown(directories, settingsContext) {
    try {
        return readSettingsFor(directories, settingsContext, ['power_user']).power_user?.message_token_count_enabled === true;
    } catch (error) {
        console.warn('Could not read whether message counts are shown:', error);
        return false;
    }
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {{ avatar?: string | null, groupId?: string | null }} owner
 * @param {CountSources} sources
 * @returns {Promise<Record<string, number>>}
 */
async function countFor(directories, owner, sources) {
    const context = settingsContextOf({ avatar: owner.avatar ?? null, groupId: owner.groupId ?? null });
    if (!messageCountsShown(directories, context)) return {};
    return countInto(sources, async texts => (await countWithConnection(directories, context, texts))?.counts ?? null);
}

/**
 * @param {import('express').Request} request
 * @param {{ avatar?: string | null, groupId?: string | null }} owner
 * @param {CountSources} sources
 * @returns {Promise<Record<string, number>>}
 */
export function countSent(request, owner, sources) {
    return countFor(request.user.directories, owner, sources);
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {Parameters<typeof openingState>[0]} p
 */
export async function countedOpeningState(directories, p) {
    const state = await openingState(p);
    await countFor(directories, { avatar: p.avatar }, { alternatives: openingAlternatives(state) });
    return state;
}

/**
 * @param {import('express').Request} request
 * @param {import('./chat-request.js').ChatContext} chat
 * @param {unknown[]} nodeIds
 * @returns {Promise<Record<string, number> | undefined>}
 */
export async function storedMessageCounts(request, chat, nodeIds) {
    const ids = [...new Set(nodeIds.filter(id => typeof id === 'string' && id !== ''))];
    if (!ids.length) return undefined;
    const directories = request.user.directories;
    const context = settingsContextOf({ avatar: chat.avatar, groupId: chat.groupId });
    if (!messageCountsShown(directories, context)) return undefined;
    const shown = await Promise.all(ids.map(id => chat.store.chats.shownMessage(chat.tree, /** @type {string} */ (id))));
    const messages = shown.flatMap((message, i) => (message ? [{ ...message, node_id: ids[i] }] : []));
    const counts = await countInto({ messages }, async texts => (await countWithConnection(directories, context, texts))?.counts ?? null);
    return Object.keys(counts).length ? counts : undefined;
}
