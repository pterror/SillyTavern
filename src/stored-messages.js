import { appendMessages, sanitizeUserMessageExtra } from './message-tree-db.js';

/**
 * @typedef {{ ref: string, node_id: string, integrity?: string | null }} StoredMessage Something the server stored
 * for a request under the ref the page sent for it: a message at `node_id`, or (with `integrity`) chat metadata
 * keys on the node `node_id`, whose integrity slug is then `integrity`.
 */

/**
 * The user message a raw-action generate request carries (`user_message`): the message as the page has it once
 * sent, stored as it is.
 * @param {any} body The request body.
 * @returns {{ text: string, extra: object, content: Record<string, any> } | null} Its text and attachments (for the
 * prompt) and the message to store; null when the request carries none.
 */
export function sentUserMessageOf(body) {
    const message = body?.user_message;
    if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.mes !== 'string') return null;
    const content = { ...message };
    delete content.node_id;
    return { text: message.mes, extra: sanitizeUserMessageExtra(message.extra), content };
}

/**
 * Records something this request stored under a page ref, for the request's answer (see storedMessagesOf()).
 * @param {import('express').Response} response
 * @param {StoredMessage} stored
 */
export function recordStored(response, stored) {
    if (typeof stored.ref !== 'string' || stored.ref === '') return;
    response.locals.storedMessages ??= [];
    response.locals.storedMessages.push(stored);
    reportStoredOnErrorAnswers(response);
}

/**
 * Stores the user message a raw-action generate request carries, as a child of `anchorNodeId`, and
 * records it under the page's `ref` for this request's answer (see storedMessagesOf()). The ref is the
 * send's key: a send already stored under it is answered with that node, not stored again.
 *
 * When it can't be stored, answers the request with an error itself and returns null: the caller then
 * returns without generating, so nothing is generated onto a message the chat doesn't have.
 * @param {import('express').Response} response The generate request's response.
 * @param {object} params
 * @param {import('./users.js').UserDirectoryList} params.directories
 * @param {string} params.ownerId
 * @param {string} params.anchorNodeId
 * @param {object} params.message The message content to store.
 * @param {unknown} params.ref The request's `user_message_ref`; nothing is recorded unless it is a non-empty string.
 * @returns {Promise<string|null>} The stored message's node id; null when the request has been answered with the failure.
 */
export async function storeUserMessage(response, { directories, ownerId, anchorNodeId, message, ref }) {
    const appendResult = await appendMessages(directories, ownerId, anchorNodeId, [message], { sendKeys: [ref] });
    const nodeId = appendResult.ok ? appendResult.node_ids?.[appendResult.node_ids.length - 1] ?? null : null;
    if (!nodeId) {
        const reason = appendResult.reason ?? 'no node was stored';
        console.error('Could not store the user\'s message:', reason);
        response.status(500).send({ error: { message: `Your message couldn't be saved (${reason}), so nothing was generated.` }, user_message_not_saved: true });
        return null;
    }
    if (typeof ref === 'string') recordStored(response, { ref, node_id: nodeId });
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
