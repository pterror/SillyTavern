import { addOpeningAlternatives, appendMessages, labelNode, mergeChatMetadataKeys, ownerDescriptorOf, selectDefaultChild } from './message-tree-db.js';
import { setCharacterActiveChat } from './character-metadata-db.js';
import { readGroupFile } from './endpoints/groups.js';
import { recordStored, sentUserMessageOf } from './stored-messages.js';

/**
 * @typedef {object} PageMessages Messages on the page that no action has stored, each with the ref the page gave it.
 * @property {string[]} refs
 * @property {object[]} messages
 */

/**
 * @typedef {object} PageMetadata Chat metadata keys the page changed since it last had the chat's metadata from
 * the server.
 * @property {string} ref
 * @property {string|null} [target] The node id or label the chat's metadata is on; null when the chat has no
 * stored message yet (then it goes on the opening this request stores).
 * @property {Record<string, unknown>} [set]
 * @property {string[]} [unset]
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
 * it: the chat's opening greetings when none is stored yet (`opening`), the messages after the last stored one that
 * no action stored (`page_messages`, e.g. one an extension added), and the chat metadata keys the page changed
 * (`page_metadata`). Each is recorded under its ref for the answer's `stored`.
 *
 * When something can't be stored, answers the request with an error itself and returns null, so nothing is
 * generated on a chat the server doesn't have.
 * @param {import('express').Response} response
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {object} params
 * @param {string} params.ownerId
 * @param {string} [params.avatar] The character, for a character's chat.
 * @param {string} [params.groupId] The group, for a group's chat.
 * @param {any} params.body The request body.
 * @returns {Promise<{ nodeId: string|null|undefined }|null>} The node to generate from: the request's `node_id`,
 * or the last message this stored when it stored any.
 */
export async function applyPageWrites(response, directories, { ownerId, avatar, groupId, body }) {
    /** @type {string|null|undefined} */
    let nodeId = body?.node_id;
    const fail = (/** @type {string} */ reason) => {
        console.error('Could not store the chat\'s changes before generating:', reason);
        response.status(409).send({ error: { message: `This chat's changes couldn't be saved (${reason}), so nothing was generated.` }, page_changes_not_saved: true });
        return null;
    };

    /** @type {string|null} */
    let openingId = null;
    /** @type {string|null} The name a group chat's new opening was labeled with. */
    let groupOpeningName = null;
    const opening = pageMessagesOf(body?.opening);
    if (opening && (nodeId === null || nodeId === undefined)) {
        const isGroup = groupId != null && groupId !== '';
        const chatName = isGroup ? readGroupFile(directories, groupId)?.chat_id : null;
        if (isGroup && (typeof chatName !== 'string' || chatName === '')) return fail('the group has no chat');
        const made = await addOpeningAlternatives(directories, ownerId, [opening.messages[0]], ownerDescriptorOf({ groupId, avatar }));
        const firstId = made.ok ? made.node_ids[0] : null;
        if (!firstId) return fail('the opening could not be stored');
        await selectDefaultChild(directories, firstId);
        recordStored(response, { ref: opening.refs[0], node_id: firstId });
        nodeId = firstId;
        if (opening.messages.length > 1) {
            const rest = await appendMessages(directories, ownerId, firstId, opening.messages.slice(1));
            if (!rest.ok || rest.node_ids.length !== opening.messages.length - 1) return fail(rest.reason ?? 'the opening could not be stored');
            rest.node_ids.forEach((id, i) => recordStored(response, { ref: opening.refs[i + 1], node_id: id }));
            nodeId = rest.node_ids[rest.node_ids.length - 1];
        }
        if (isGroup) {
            const labeled = await labelNode(directories, firstId, /** @type {string} */ (chatName), { ownerId });
            if (!labeled.ok) return fail('the chat could not be named');
            groupOpeningName = /** @type {string} */ (chatName);
        } else if (avatar) {
            await setCharacterActiveChat(directories, avatar, firstId);
        }
        openingId = firstId;
    }

    const pushed = pageMessagesOf(body?.page_messages);
    if (pushed) {
        if (typeof nodeId !== 'string' || nodeId === '') return fail('there is no stored message for them to follow');
        const appended = await appendMessages(directories, ownerId, nodeId, pushed.messages, { sendKeys: pushed.refs.map(ref => ref || null) });
        if (!appended.ok || appended.node_ids.length !== pushed.messages.length) return fail(appended.reason ?? 'the messages could not be stored');
        appended.node_ids.forEach((id, i) => recordStored(response, { ref: pushed.refs[i], node_id: id }));
        nodeId = appended.node_ids[appended.node_ids.length - 1];
    }

    /** @type {PageMetadata} */
    const metadata = body?.page_metadata && typeof body.page_metadata === 'object' ? body.page_metadata : { ref: '' };
    if (body?.page_metadata || groupOpeningName !== null) {
        const target = typeof metadata.target === 'string' && metadata.target !== '' ? metadata.target : (groupOpeningName ?? openingId);
        const set = metadata.set && typeof metadata.set === 'object' && !Array.isArray(metadata.set) ? { ...metadata.set } : {};
        if (groupOpeningName !== null) set.__is_group = true;
        const unset = Array.isArray(metadata.unset) ? metadata.unset : [];
        // With no stored message there is nothing to put the keys on yet; the page keeps them as changed.
        if (target !== null) {
            const merged = await mergeChatMetadataKeys(directories, ownerId, target, set, unset);
            if (!merged.ok || !merged.node_id) return fail(merged.reason ?? 'the chat metadata could not be saved');
            recordStored(response, { ref: metadata.ref, node_id: merged.node_id, integrity: merged.integrity ?? null });
        }
    }

    return { nodeId };
}

/**
 * What a raw-action generate request generates from: stores what it carries from the page (applyPageWrites()) and
 * reads the user message it sends.
 * @param {import('express').Response} response
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {{ ownerId: string, avatar?: string, groupId?: string, body: any }} params See applyPageWrites().
 * @returns {Promise<{ nodeId: string|null|undefined, userMessageText: string|undefined, userMessageExtra: object, userMessage: Record<string, any>|null }|null>}
 * Null when the request has been answered with a failure.
 */
export async function generateTurnOf(response, directories, params) {
    const written = await applyPageWrites(response, directories, params);
    if (!written) return null;
    const sent = sentUserMessageOf(params.body);
    return {
        nodeId: written.nodeId,
        userMessageText: sent?.text,
        userMessageExtra: sent?.extra ?? {},
        userMessage: sent?.content ?? null,
    };
}
