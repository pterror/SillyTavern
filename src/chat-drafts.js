import { TYPE } from './library-codes.js';
import { cardGreetingsOf } from './opening-state.js';

/**
 * What a draft follows, as the engine keys it: a stored message, a chat's root (its tree), or a card's greeting (the
 * card entity and the greeting's id)
 * @typedef {import('./chat-engine.js').DraftOwner} DraftOwner
 */

/**
 * The message a draft responds to, as the page names it
 * @typedef {{ message: string } | { greeting: number, avatar: string } | { root: true }} WireDraftOwner
 */

/**
 * A draft as an answer carries it: the end of the chat the answer leaves the page at, the text written after it, and
 * its version (`ChatEngine.draftOf`)
 * @typedef {{ owner: WireDraftOwner, text: string, version: string }} DraftAnswer
 */

/**
 * @param {import('./chat-request.js').ChatContext} chat
 * @param {string} avatar
 * @returns {Promise<boolean>} whether the card's greetings can open this chat: the chat's own card, or a member's
 */
async function opensChat(chat, avatar) {
    if (chat.avatar !== null) return avatar === chat.avatar;
    if (chat.groupId === null) return false;
    const [group] = await chat.store.lib.groups([chat.groupId]);
    return Array.isArray(group?.members) && group.members.includes(avatar);
}

/**
 * The engine's key for a draft the page names in this chat; null when it names nothing the chat can end at
 * @param {import('./chat-request.js').ChatContext} chat
 * @param {unknown} wire
 * @returns {Promise<DraftOwner | null>}
 */
export async function draftOwnerOf(chat, wire) {
    const given = /** @type {Record<string, unknown> | null} */ (wire && typeof wire === 'object' && !Array.isArray(wire) ? wire : null);
    if (given === null) return null;
    if (typeof given.message === 'string' && given.message !== '') {
        const s = await chat.store.chats.messageOf(chat.tree, given.message);
        return s ? { message: s.id } : null;
    }
    if (given.root === true) return { tree: chat.tree };
    if (Number.isInteger(given.greeting) && typeof given.avatar === 'string' && given.avatar !== '') {
        const greeting = /** @type {number} */ (given.greeting);
        if (!await opensChat(chat, given.avatar)) return null;
        const { ids } = await cardGreetingsOf(chat.store, given.avatar);
        if (!ids.includes(greeting)) return null;
        const [card] = await chat.store.lib.ids(TYPE.character, [given.avatar]);
        return card === null || card === undefined ? null : { tree: card, greeting };
    }
    return null;
}

/**
 * The page's name for a draft's owner
 * @param {import('./user-stores.js').UserStore} store
 * @param {DraftOwner} owner
 * @returns {Promise<WireDraftOwner | null>}
 */
export async function wireOwnerOf(store, owner) {
    if ('message' in owner) {
        const [id] = await store.chats.externalIds([owner.message]);
        return id ? { message: id } : null;
    }
    if (owner.greeting === undefined) return { root: true };
    const [key] = await store.lib.store.libraryKeys([owner.tree]);
    return key ? { greeting: owner.greeting, avatar: key.key } : null;
}

/**
 * The draft at the end of the chat the session is at (`ChatEngine.endOwner`)
 * @param {import('./chat-request.js').ChatContext} chat
 * @returns {Promise<DraftAnswer | undefined>}
 */
export async function endDraft(chat) {
    const owner = await chat.store.chats.endOwner({ tree: chat.tree, actor: chat.session.reader() });
    const wire = await wireOwnerOf(chat.store, owner);
    return wire === null ? undefined : { owner: wire, ...await chat.store.chats.draftOf(owner) };
}

/**
 * A frame for each tab of another session: the draft each committed draft record wrote, as it is now
 * @param {import('./user-stores.js').UserStore} store
 * @param {Record<string, any>[]} records
 * @param {bigint | null} session the tab's session; its own drafts aren't told back to it
 * @returns {Promise<{ type: 'draft', tree: { avatar: string } | { group: string }, owner: WireDraftOwner, text: string, version: string }[]>}
 */
export async function draftFrames(store, records, session) {
    /** @type {Map<string, DraftOwner>} */
    const owners = new Map();
    for (const r of records) {
        if ((r.kind !== 'draftValue' && r.kind !== 'draftEdit') || (session !== null && r.session === session)) continue;
        /** @type {DraftOwner} */
        const owner = r.message !== undefined
            ? { message: r.message }
            : { tree: r.tree, ...(r.greeting === undefined ? {} : { greeting: r.greeting }) };
        owners.set('message' in owner ? `m${owner.message}` : `t${owner.tree}:${/** @type {any} */ (owner).greeting ?? ''}`, owner);
    }
    const frames = [];
    for (const owner of owners.values()) {
        const wire = await wireOwnerOf(store, owner);
        const treeId = 'message' in owner ? (await store.chats.stored([owner.message])).get(owner.message)?.owner : owner.tree;
        const [key] = wire === null || treeId === undefined ? [null] : await store.lib.store.libraryKeys([treeId]);
        if (wire === null || !key) continue;
        frames.push({ type: /** @type {const} */ ('draft'), tree: key.type === TYPE.group ? { group: key.key } : { avatar: key.key }, owner: wire, ...await store.chats.draftOf(owner) });
    }
    return frames;
}
