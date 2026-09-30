import { appendMessages } from './message-tree-db.js';

/**
 * @typedef {{ ref: string, node_id: string }} StoredMessage A message the server stored for a generate
 * request, under the ref the page sent for it.
 */

/**
 * Stores the user message a raw-action generate request carries, as a child of `anchorNodeId`, and
 * records it under the page's `ref` for this request's answer (see storedMessagesOf()).
 * @param {import('express').Response} response The generate request's response.
 * @param {object} params
 * @param {import('./users.js').UserDirectoryList} params.directories
 * @param {string} params.ownerId
 * @param {string} params.anchorNodeId
 * @param {object} params.message The message content to store.
 * @param {unknown} params.ref The request's `user_message_ref`; nothing is recorded unless it is a non-empty string.
 * @returns {Promise<string|null>} The stored message's node id, or null when the write failed.
 */
export async function storeUserMessage(response, { directories, ownerId, anchorNodeId, message, ref }) {
    const appendResult = await appendMessages(directories, ownerId, anchorNodeId, [message]);
    if (!appendResult.ok) {
        console.error('Failed to persist user message onto the tree:', appendResult.reason);
        return null;
    }
    const nodeId = appendResult.node_ids?.[appendResult.node_ids.length - 1] ?? null;
    if (nodeId && typeof ref === 'string' && ref !== '') {
        response.locals.storedMessages ??= [];
        response.locals.storedMessages.push({ ref, node_id: nodeId });
    }
    return nodeId;
}

/**
 * @param {import('express').Response} response
 * @returns {StoredMessage[]|null} What this request stored under a page ref, or null when nothing.
 */
export function storedMessagesOf(response) {
    const stored = response.locals?.storedMessages;
    return Array.isArray(stored) && stored.length ? stored : null;
}

/**
 * Sets `stored` on a non-streaming answer body when this request stored anything under a page ref.
 * @template T
 * @param {T} body
 * @param {import('express').Response} response
 * @returns {T}
 */
export function withStoredMessages(body, response) {
    const stored = storedMessagesOf(response);
    if (stored && body !== null && typeof body === 'object') {
        /** @type {any} */ (body).stored = stored;
    }
    return body;
}
