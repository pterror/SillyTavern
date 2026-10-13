import { storedForm } from './chat-engine.js';
import { recordStored, sentUserMessageOf } from './stored-messages.js';

/**
 * @typedef {object} PageMessages Messages on the page that no action has stored, each with the ref the page gave it.
 * @property {string[]} refs
 * @property {object[]} messages
 */

/**
 * @typedef {object} PageMetadata Chat metadata keys (and chat variables) the page changed since it last had the
 * chat's metadata from the server.
 * @property {string} ref
 * @property {Record<string, unknown>} [set]
 * @property {string[]} [unset]
 * @property {{ set?: Record<string, unknown>, unset?: string[] }} [variables]
 */

/**
 * @param {unknown} value
 * @returns {PageMessages|null}
 */
function pageMessagesOf(value) {
    const given = /** @type {any} */ (value);
    if (!given || !Array.isArray(given.messages) || given.messages.length === 0) return null;
    const messages = given.messages.filter((/** @type {unknown} */ m) => m && typeof m === 'object' && !Array.isArray(m));
    if (messages.length !== given.messages.length) return null;
    const refs = Array.isArray(given.refs) ? given.refs : [];
    return { refs: messages.map((/** @type {unknown} */ _, /** @type {number} */ i) => typeof refs[i] === 'string' ? refs[i] : ''), messages };
}

/**
 * Stores what a generate request carries from the page before anything is generated, so the prompt is built from
 * it, each through the request's session (it moves to what is stored): the chat's opening greetings when none is
 * stored yet (`opening`), the messages after the last stored one that no action stored (`page_messages`, e.g. one an
 * extension added), and the chat metadata keys and variables the page changed (`page_metadata`), as state changes
 * at the message the generation goes on from. Each is recorded under its ref for the answer's `stored`.
 *
 * When something can't be stored, answers the request with an error itself and returns null, so nothing is
 * generated on a chat the server doesn't have.
 * @param {import('express').Response} response
 * @param {import('./chat-request.js').ChatContext} chat
 * @param {any} body The request body.
 * @returns {Promise<{ nodeId: string|null|undefined }|null>} The message to generate from: the request's `node_id`,
 * or the last message this stored when it stored any.
 */
export async function applyPageWrites(response, chat, body) {
    const { store, tree, treeSpeaker, session } = chat;
    /** @type {string|null|undefined} */
    let nodeId = body?.node_id;
    const fail = (/** @type {string} */ reason) => {
        console.error('Could not store the chat\'s changes before generating:', reason);
        response.status(409).send({ error: { message: `This chat's changes couldn't be saved (${reason}), so nothing was generated.` }, page_changes_not_saved: true });
        return null;
    };

    const opening = pageMessagesOf(body?.opening);
    if (opening && (nodeId === null || nodeId === undefined)) {
        const made = await store.chats.appendMessages({ tree, treeSpeaker, after: null, contents: opening.messages.map(storedForm), actor: session.actor() });
        if (!made.ok || made.node_ids.length !== opening.messages.length) return fail(made.reason ?? 'the opening could not be stored');
        made.node_ids.forEach((id, i) => recordStored(response, { ref: opening.refs[i], node_id: id }));
        nodeId = made.node_ids[made.node_ids.length - 1];
    }

    const pushed = pageMessagesOf(body?.page_messages);
    if (pushed) {
        if (typeof nodeId !== 'string' || nodeId === '') return fail('there is no stored message for them to follow');
        const appended = await store.chats.appendMessages({
            tree, treeSpeaker, after: nodeId, contents: pushed.messages.map(storedForm), sendKeys: pushed.refs.map(ref => ref || null), actor: session.actor(),
        });
        if (!appended.ok || appended.node_ids.length !== pushed.messages.length) return fail(appended.reason ?? 'the messages could not be stored');
        appended.node_ids.forEach((id, i) => recordStored(response, { ref: pushed.refs[i], node_id: id }));
        nodeId = appended.node_ids[appended.node_ids.length - 1];
    }

    if (body?.page_metadata && typeof body.page_metadata === 'object') {
        /** @type {PageMetadata} */
        const metadata = body.page_metadata;
        const at = typeof nodeId === 'string' && nodeId !== '' ? nodeId : null;
        const set = metadata.set && typeof metadata.set === 'object' && !Array.isArray(metadata.set) ? metadata.set : {};
        const unset = Array.isArray(metadata.unset) ? metadata.unset : [];
        const variables = metadata.variables && typeof metadata.variables === 'object' && !Array.isArray(metadata.variables) ? metadata.variables : undefined;
        const actor = session.actor();
        const merged = await store.chats.mergeMetadata({ tree, at, set, unset, variables, actor });
        if (!merged.ok) {
            recordStored(response, { ref: metadata.ref, node_id: at ?? '', metadata_not_saved: true });
            return fail(merged.reason ?? 'the chat metadata could not be saved');
        }
        recordStored(response, { ref: metadata.ref, node_id: at ?? '', integrity: actor.session });
    }

    return { nodeId };
}

/**
 * What a raw-action generate request generates from: stores what it carries from the page (applyPageWrites()) and
 * reads the user message it sends.
 * @param {import('express').Response} response
 * @param {import('./chat-request.js').ChatContext} chat
 * @param {any} body The request body.
 * @returns {Promise<{ nodeId: string|null|undefined, userMessageText: string|undefined, userMessageExtra: object, userMessage: Record<string, any>|null }|null>}
 * Null when the request has been answered with a failure.
 */
export async function generateTurnOf(response, chat, body) {
    const written = await applyPageWrites(response, chat, body);
    if (!written) return null;
    const sent = sentUserMessageOf(body);
    return {
        nodeId: written.nodeId,
        userMessageText: sent?.text,
        userMessageExtra: sent?.extra ?? {},
        userMessage: sent?.content ?? null,
    };
}
