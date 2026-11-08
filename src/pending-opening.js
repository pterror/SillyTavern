import { storedForm } from './chat-engine.js';
import { openingState } from './opening-state.js';

/**
 * @typedef {object} PendingOpening
 * @property {string[]} refs
 * @property {Record<string, any>[]} messages
 * @property {{ set?: Record<string, unknown>, unset?: string[] } | null} variables the chat variables the prompt's macros changed, stored on the opening
 * @property {(stored: Record<string, unknown>) => void} record
 */

/**
 * @param {{ set?: Record<string, unknown>, unset?: string[] } | null} variables
 * @param {Map<string, string>} state
 * @returns {import('./chat-engine.js').StateOp[]}
 */
function variableOps(variables, state) {
    if (!variables) return [];
    const set = Object.entries(variables.set ?? {}).filter(([, v]) => v !== undefined);
    const ops = set.map(([key, value]) => ({ key, variable: true, value }));
    for (const key of variables.unset ?? []) ops.push({ key, variable: true, value: undefined });
    if (set.length > 0 && !state.has('k\u0000variables')) ops.unshift({ key: 'variables', value: {} });
    return ops;
}

/**
 * @param {import('./chat-request.js').ChatContext} chat
 * @param {object} p
 * @param {Record<string, any>[]} p.contents
 * @param {(string | null)[]} [p.sendKeys]
 * @param {(import('./chat-engine.js').StateOp[] | null | undefined)[]} [p.changes]
 * @param {boolean} [p.regenerated]
 * @param {Record<string, any> | null} [p.opening] the opening's content in place of the one sent
 * @returns {Promise<{ ok: boolean, reason?: string, node_ids: string[] }>} the ids of the contents, the opening's left out
 */
export async function appendUnderStart(chat, { contents, sendKeys = [], changes = [], regenerated = false, opening: replaced = null }) {
    const { store, tree, treeSpeaker, session } = chat;
    const pending = chat.opening;
    if (!pending) {
        return store.chats.appendMessages({ tree, treeSpeaker, after: null, contents, sendKeys, changes, regenerated, actor: session.actor() });
    }
    const openingContents = replaced ? [...pending.messages.slice(0, -1), storedForm(replaced)] : pending.messages;
    const state = await store.chats.stateMap(tree, null);
    const openingChanges = openingContents.map((_, i) => (i === openingContents.length - 1 ? variableOps(pending.variables, state) : null));
    const made = await store.chats.appendMessages({
        tree, treeSpeaker, after: null,
        contents: [...openingContents, ...contents],
        sendKeys: [...openingContents.map(() => null), ...contents.map((_, i) => sendKeys[i] ?? null)],
        changes: [...openingChanges, ...contents.map((_, i) => changes[i] ?? null)],
        regenerated,
        actor: session.actor(),
    });
    if (!made.ok) return made;
    chat.opening = null;
    const openingIds = made.node_ids.slice(0, openingContents.length);
    chat.openedAt = openingIds[openingIds.length - 1];
    openingIds.forEach((id, i) => pending.record({ ref: pending.refs[i], node_id: id }));
    if (pending.variables) pending.record({ ref: 'macro-variables', node_id: openingIds[openingIds.length - 1], variables: pending.variables });
    if (chat.avatar !== null) {
        const openings = await openingState({ store, tree, actor: session.reader(), avatar: chat.avatar });
        pending.record({ ref: 'openings', node_id: '', avatar: chat.avatar, openings });
    }
    return { ...made, node_ids: made.node_ids.slice(openingContents.length) };
}
