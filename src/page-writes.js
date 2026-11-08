import { storedForm } from './chat-engine.js';
import { recordStored, sentUserMessageOf } from './stored-messages.js';
import { readPageMacroFacts } from './macro-facts.js';
import { readPageInjections } from './page-injections.js';

/**
 * @typedef {object} PageMessages
 * @property {string[]} refs
 * @property {object[]} messages
 */

/**
 * @typedef {object} PageMetadata
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
 * @param {import('express').Response} response
 * @param {import('./chat-request.js').ChatContext} chat
 * @param {any} body
 * @param {{ waitForReply?: boolean }} [options] waitForReply: an opening with nothing sent under it is stored with the reply
 * @returns {Promise<{ nodeId: string|null|undefined, pushedIds: string[] }|null>}
 */
export async function applyPageWrites(response, chat, body, { waitForReply = false } = {}) {
    const { store, tree, treeSpeaker, session } = chat;
    /** @type {string|null|undefined} */
    let nodeId = body?.node_id;
    const fail = (/** @type {string} */ reason) => {
        console.error('Could not store the chat\'s changes before generating:', reason);
        response.status(409).send({ error: { message: `This chat's changes couldn't be saved (${reason}), so nothing was generated.` }, page_changes_not_saved: true });
        return null;
    };

    const opening = pageMessagesOf(body?.opening);
    let pushed = pageMessagesOf(body?.page_messages);
    /** @type {string[]} */
    let pushedIds = [];
    if (opening && (nodeId === null || nodeId === undefined)) {
        const contents = [...opening.messages, ...(pushed?.messages ?? [])].map(storedForm);
        const refs = [...opening.refs, ...(pushed?.refs ?? [])];
        if (!pushed && waitForReply) {
            const metadata = body?.page_metadata && typeof body.page_metadata === 'object' ? body.page_metadata : null;
            chat.opening = { refs: opening.refs, messages: contents, variables: null, metadata, record: stored => recordStored(response, stored) };
            nodeId = null;
        } else {
            const made = await store.chats.appendMessages({
                tree, treeSpeaker, after: null, contents,
                sendKeys: [...opening.refs.map(() => null), ...(pushed?.refs ?? []).map(ref => ref || null)], actor: session.actor(),
            });
            if (!made.ok || made.node_ids.length !== contents.length) return fail(made.reason ?? 'the opening could not be stored');
            made.node_ids.forEach((id, i) => recordStored(response, { ref: refs[i], node_id: id }));
            nodeId = made.node_ids[made.node_ids.length - 1];
            pushedIds = made.node_ids.slice(opening.messages.length);
            pushed = null;
        }
    }

    if (pushed) {
        if (typeof nodeId !== 'string' || nodeId === '') return fail('there is no stored message for them to follow');
        const appended = await store.chats.appendMessages({
            tree, treeSpeaker, after: nodeId, contents: pushed.messages.map(storedForm), sendKeys: pushed.refs.map(ref => ref || null), actor: session.actor(),
        });
        if (!appended.ok || appended.node_ids.length !== pushed.messages.length) return fail(appended.reason ?? 'the messages could not be stored');
        appended.node_ids.forEach((id, i) => recordStored(response, { ref: pushed.refs[i], node_id: id }));
        nodeId = appended.node_ids[appended.node_ids.length - 1];
        pushedIds = appended.node_ids;
    }

    if (body?.page_metadata && typeof body.page_metadata === 'object' && !chat.opening) {
        /** @type {PageMetadata} */
        const metadata = body.page_metadata;
        const at = typeof nodeId === 'string' && nodeId !== '' ? nodeId : null;
        const set = metadata.set && typeof metadata.set === 'object' && !Array.isArray(metadata.set) ? metadata.set : {};
        const unset = Array.isArray(metadata.unset) ? metadata.unset : [];
        const variables = metadata.variables && typeof metadata.variables === 'object' && !Array.isArray(metadata.variables) ? metadata.variables : undefined;
        const actor = session.actor();
        const merged = await store.chats.mergeMetadata({ tree, at, set, unset, variables, actor });
        if (!merged.ok) {
            const read = await store.chats.stateAt({ tree, at, session: actor.session });
            const state = read !== null && 'state' in read ? read.state : undefined;
            recordStored(response, { ref: metadata.ref, node_id: at ?? '', metadata_not_saved: true, ...(state ? { state } : {}) });
            return fail(merged.reason ?? 'the chat metadata could not be saved');
        }
        recordStored(response, { ref: metadata.ref, node_id: at ?? '', integrity: actor.session });
    }

    return { nodeId, pushedIds };
}

/**
 * @typedef {{ quietPrompt?: string, quietToLoud?: boolean, quietName?: string, quietImage?: string }} QuietPrompt
 * @param {any} body
 * @returns {QuietPrompt}
 */
export function quietOf(body) {
    const text = (/** @type {unknown} */ v) => (typeof v === 'string' && v !== '' ? v : undefined);
    return {
        quietPrompt: text(body?.quiet_prompt),
        quietToLoud: body?.quiet_to_loud === true ? true : undefined,
        quietName: text(body?.quiet_name),
        quietImage: text(body?.quiet_image),
    };
}

/**
 * @param {any} body
 * @returns {number | undefined}
 */
export function responseLengthOf(body) {
    const length = body?.response_length;
    return Number.isInteger(length) && length > 0 ? length : undefined;
}

/**
 * @param {import('express').Response} response
 * @param {import('./chat-request.js').ChatContext} chat
 * @param {any} body
 * @returns {Promise<{ nodeId: string|null|undefined, userMessageText: string|undefined, userMessageExtra: object, userMessage: Record<string, any>|null, quiet: QuietPrompt, responseLength: number|undefined, pageFacts: import('./macro-facts.js').PageMacroFacts, pageInjections: import('./prompt/injections.js').PageInjections, skipWorldInfoAndNote: boolean, forceName2: boolean }|null>}
 */
export async function generateTurnOf(response, chat, body) {
    const written = await applyPageWrites(response, chat, body, { waitForReply: true });
    if (!written) return null;
    const sent = sentUserMessageOf(body);
    return {
        nodeId: written.nodeId,
        userMessageText: sent?.text,
        userMessageExtra: sent?.extra ?? {},
        userMessage: sent?.content ?? null,
        quiet: quietOf(body),
        responseLength: responseLengthOf(body),
        pageFacts: readPageMacroFacts(body?.macro_facts),
        pageInjections: readPageInjections(body?.extension_prompts),
        skipWorldInfoAndNote: body?.skip_wian === true,
        forceName2: body?.force_name2 === true,
    };
}

/**
 * @param {QuietPrompt} quiet
 * @returns {Record<string, any>}
 */
export function textCompletionQuietInput(quiet) {
    if (!quiet.quietPrompt) return {};
    return { quiet_prompt: quiet.quietPrompt, quietToLoud: quiet.quietToLoud ?? false, quietName: quiet.quietName };
}
