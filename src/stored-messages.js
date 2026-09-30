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
        reportStoredOnErrorAnswers(response);
    }
    return nodeId;
}

/** Response header carrying `stored` (JSON) on an error answer, whose body and status stay as they are. */
export const STORED_HEADER = 'X-ST-Stored';

/**
 * Makes every error answer this response sends from now on report what the request stored: an error
 * status (a backend's error passed on as it came, or one of the route's own) gets the `X-ST-Stored`
 * header, and an error body the route builds itself (`{ error, ... }`) also gets a `stored` field.
 * @param {import('express').Response} response
 */
function reportStoredOnErrorAnswers(response) {
    if (response.locals.reportsStoredOnErrors) return;
    response.locals.reportsStoredOnErrors = true;

    const setStoredHeader = () => {
        const stored = storedMessagesOf(response);
        if (stored && !response.headersSent) {
            // Header values must be ASCII; \u escapes keep it the same JSON.
            response.setHeader(STORED_HEADER, JSON.stringify(stored).replace(/[\u007f-\uffff]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`));
        }
    };
    const withStoredError = (body) => {
        const isObject = body !== null && typeof body === 'object' && !Array.isArray(body) && !Buffer.isBuffer(body);
        if ((isObject && body.error) || response.statusCode >= 400) {
            setStoredHeader();
            if (isObject) body.stored ??= storedMessagesOf(response);
        }
        return body;
    };

    const writeHead = response.writeHead;
    response.writeHead = function (statusCode, ...rest) {
        if (statusCode >= 400) setStoredHeader();
        return writeHead.call(this, statusCode, ...rest);
    };
    const json = response.json;
    response.json = function (body) {
        return json.call(this, withStoredError(body));
    };
    const send = response.send;
    response.send = function (body) {
        return send.call(this, withStoredError(body));
    };
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
