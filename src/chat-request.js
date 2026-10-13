import { requestStore } from './user-stores.js';
import { requestSession } from './request-session.js';
import { bookmarkCompatId } from './chat-engine.js';
import { FIELD } from './library-codes.js';

/**
 * @typedef {object} ChatContext The chat a request acts in.
 * @property {import('./user-stores.js').UserStore} store The user's store.
 * @property {bigint} tree The character's or group's tree.
 * @property {import('./chat-codec.js').Speaker | null} treeSpeaker The tree's character (null for a group).
 * @property {import('./request-session.js').RequestSession} session The request's session in the tree.
 * @property {import('./chat-engine.js').StateOp[]} [replyChanges] The state changes the page made while producing the
 * reply the request generates (`reply_changes`), stored with the reply.
 */

/**
 * The chat a request acts in: a group's (by `group`) when it names one, else a character's (by `avatar`); null when
 * it names none that exists. A group's generation names its responding member too, so the group goes first.
 * @param {any} request
 * @param {{ avatar?: unknown, group?: unknown }} owner
 * @returns {Promise<ChatContext | null>}
 */
export async function chatContext(request, { avatar, group }) {
    const store = await requestStore(request);
    const groupId = typeof group === 'string' && group !== '' ? group : null;
    const name = typeof avatar === 'string' && avatar !== '' ? avatar : null;
    if (groupId === null && name === null) return null;
    const [tree] = await store.people.trees([groupId !== null ? { group: groupId } : { avatar: /** @type {string} */ (name) }]);
    if (tree === null || tree === undefined) return null;
    const treeSpeaker = groupId !== null || name === null ? null : (await store.people.byAvatar([name])).get(name) ?? null;
    const session = await requestSession(store.chats, request, tree);
    const replyChanges = request.body?.reply_changes;
    return { store, tree, treeSpeaker, session, ...(Array.isArray(replyChanges) ? { replyChanges } : {}) };
}

/**
 * The request's session's compat chat id in its chat's tree (`getCurrentChatId()`): its current chat's `b<id>`, else
 * `s<UUID>.<tree>`.
 * @param {ChatContext} chat
 */
export function compatChatIdOf(chat) {
    return chat.store.chats.compatChatId(chat.session.reader().session, chat.session.identifier, chat.tree);
}

/**
 * Whether a resolved chat name is the request's own conversation in the tree: its current chat's bookmark, or its own
 * `s<UUID>.<tree>`.
 * @param {ChatContext} chat
 * @param {{ bookmark: bigint } | { session: string, derived?: true }} found
 */
export async function isOwnChat(chat, found) {
    // A read with no request (a caller's own context) has no conversation of its own.
    if (!chat.session) return false;
    if ('bookmark' in found) return await chat.store.chats.currentChat(chat.session.reader().session, chat.tree) === found.bookmark;
    return found.derived === true && found.session === chat.session.identifier;
}

/**
 * Where a chat name upstream's routes take is in the chat's tree: the request's own conversation (its current chat's
 * `b<id>`, its own `s<UUID>.<tree>`) where its session is (it lands); another bookmark of that name its message;
 * another `s<UUID>.<tree>` that session's position there (where it lands, while it has none); a session with that name
 * or UUID its position in the tree; `undefined` when it names nothing there.
 * @param {ChatContext} chat
 * @param {string} name
 * @returns {Promise<string | null | undefined>} The message's outside id (null: the tree's root).
 */
export async function chatNamePosition(chat, name) {
    const { chats } = chat.store;
    const found = await chats.resolveChatName({ tree: chat.tree, name });
    if (found !== null && await isOwnChat(chat, found)) return chats.landingOf(chat.tree, chat.session.reader());
    if (found !== null && 'derived' in found) return chats.landingOf(chat.tree, { user: chat.session?.user ?? '', session: found.session });
    if (found !== null && 'bookmark' in found) {
        const [b] = await chats.store.chatRead('bookmarks', { ids: [found.bookmark] });
        if (!b) return undefined;
        return b.at === null ? null : (await chats.externalIds([b.at]))[0];
    }
    const sid = await chats.sessionId(found?.session ?? name);
    if (sid === null) return undefined;
    const where = await chats.store.chatRead('sessionInTree', { session: sid, tree: chat.tree });
    if (!where) return undefined;
    return where.at === null ? null : (await chats.externalIds([where.at]))[0];
}

/**
 * Whether a generation that names no message may go on from the tree's root: only when the tree has no message yet,
 * or the request's session is at the root (a new chat). Otherwise the caller is behind and must name the message.
 * @param {ChatContext} chat
 */
async function rootIsCurrent(chat) {
    const { chats } = chat.store;
    const [opening] = await chats.store.chatRead('children', { tree: chat.tree, limit: 1 }).then(page => page.ids);
    if (opening === undefined) return true;
    const sid = await chats.sessionId(chat.session.reader().session ?? undefined);
    if (sid === null) return false;
    const where = await chats.store.chatRead('sessionInTree', { session: sid, tree: chat.tree });
    return where !== null && where.at === null;
}

/**
 * A generation's chat history: the path from the tree's root down to the position it goes on from, and the state
 * there as `chat_metadata`. The position is the chat `branchName` names when it names one, else `nodeId` (a message
 * of the tree), else the tree's root when that is current (`rootIsCurrent()`); `ambiguous` when it isn't.
 * @param {ChatContext | null | undefined} chat
 * @param {{ branchName?: string, nodeId?: string | null }} at
 * @returns {Promise<{ chat: any[], metadata: Record<string, any>, resolvedNodeId: string | null, ambiguous?: true }>}
 */
export async function loadChatHistory(chat, { branchName, nodeId }) {
    const none = { chat: [], metadata: {}, resolvedNodeId: null };
    if (!chat) return none;
    const { chats } = chat.store;
    /** @type {string | null | undefined} */
    let at;
    if (branchName != null) at = await chatNamePosition(chat, branchName);
    if (at === undefined && nodeId != null) {
        if (!await chats.messageOf(chat.tree, nodeId)) return none;
        at = nodeId;
    }
    if (at === undefined && !await rootIsCurrent(chat)) return { ...none, ambiguous: true };
    const loaded = await chats.load({ tree: chat.tree, at: at ?? null });
    if (!loaded) return none;
    return { chat: loaded.messages, metadata: loaded.metadata, resolvedNodeId: loaded.node_id };
}

/**
 * Tells the tab of its session on the answer, whatever sends it: the headers are set as they go out, so a session
 * made by any write before then is in them. A write after (a streamed reply's) has to make it before streaming.
 * @param {import('express').Response} response
 * @param {import('./request-session.js').RequestSession} session
 */
export function answerSessionOnHeaders(response, session) {
    const writeHead = response.writeHead;
    response.writeHead = /** @type {any} */ (function (/** @type {any[]} */ ...args) {
        if (!response.headersSent) session.answer(response);
        return writeHead.apply(this, args);
    });
}

/**
 * Upstream's compat chat id of each tree for a request (`characters[].chat`, `group.chat_id`): the conversation the
 * request's session has there, its current chat's `b<id>`, else `s<UUID>.<tree>` (each tree's its own).
 * @param {import('./user-stores.js').UserStore} store
 * @param {any} request
 * @param {bigint[]} trees
 * @returns {Promise<Map<bigint, string>>}
 */
export async function compatChatIds(store, request, trees) {
    /** @type {Map<bigint, string>} */
    const out = new Map();
    for (const tree of trees) {
        const session = await requestSession(store.chats, request, tree);
        out.set(tree, await store.chats.compatChatId(session.reader().session, session.identifier, tree));
    }
    return out;
}

/**
 * What a chat's names start from (the base of a suggested bookmark or branch label): the label of the session's
 * current chat, else the session's own label, else the character's or group's name; never an id.
 * @param {ChatContext} chat
 * @returns {Promise<string>}
 */
export async function labelBaseOf(chat) {
    const { chats } = chat.store;
    const current = await chats.currentChat(chat.session.reader().session, chat.tree);
    if (current !== null) {
        const [b] = await chats.store.chatRead('bookmarks', { ids: [current] });
        if (b?.name) return b.name;
    }
    const sid = await chats.sessionId(chat.session.reader().session ?? undefined);
    if (sid !== null) {
        const [s] = await chats.store.chatRead('sessions', { ids: [sid] });
        if (s?.name) return s.name;
    }
    // A character's and a group's name are both field 1 (`FIELD.name`, `GROUP_FIELD.name`).
    const [entity] = await chat.store.lib.entities([chat.tree], { fields: [FIELD.name], lists: [] });
    const v = entity?.values.find(x => x.field === FIELD.name);
    const name = v === undefined ? '' : v.text !== undefined ? v.text : JSON.parse(/** @type {string} */ (v.json));
    return typeof name === 'string' ? name : '';
}

/**
 * Switches the requesting tab to the chat a name names in a character's or group's tree (answer 2 of the cut: a write
 * of "the current chat"; `openChatNamed()`); '' or null starts a new chat (no current chat). One naming nothing
 * changes nothing.
 * @param {import('express').Request} request
 * @param {import('express').Response} response
 * @param {{ avatar?: string, group?: string }} owner
 * @param {unknown} chat
 * @returns {Promise<ChatContext | null>} The chat it acted in (its session as it acted), null when the tree doesn't
 * exist.
 */
export async function moveToChatNamed(request, response, owner, chat) {
    const store = await requestStore(request);
    const [tree] = await store.people.trees([owner]);
    if (tree === null || tree === undefined) return null;
    const session = await requestSession(store.chats, request, tree);
    const context = { store, tree, treeSpeaker: null, session };
    if (chat === null || chat === '') {
        await store.chats.newChat({ tree, actor: session.actor(), group: owner.group !== undefined });
        await store.chats.setCurrentChat({ tree, bookmark: null, actor: session.actor() });
        session.answer(response, { moved: true });
        return context;
    }
    if (typeof chat !== 'string') return context;
    await openChatNamed(context, chat);
    session.answer(response, { moved: true });
    return context;
}

/**
 * Opens a chat by name as upstream switched chat files (the current chat changes; moving inside a conversation never
 * does): the tab's own conversation (its current chat's `b<id>`, its own `s<UUID>.<tree>`) stays where it is, its own
 * `s<UUID>.<tree>` leaving its current chat for none; another bookmark moves the session to its message and becomes
 * the current chat; another session's (`s<UUID>.<tree>`, or a session's UUID or label) moves the session to where
 * that one is in the tree, no current chat (a tab never takes over another's session). A name naming nothing changes
 * nothing.
 * @param {ChatContext} chat
 * @param {string} name
 * @returns {Promise<boolean>} Whether it named a chat.
 */
export async function openChatNamed(chat, name) {
    const { chats } = chat.store;
    const found = await chats.resolveChatName({ tree: chat.tree, name });
    if (found === null) return false;
    const actor = chat.session.actor();
    const own = await isOwnChat(chat, found);
    if (!own) {
        const at = await chatNamePosition(chat, name);
        if (at === undefined) return false;
        await chats.goTo({ tree: chat.tree, node_id: at, actor });
    }
    await chats.setCurrentChat({ tree: chat.tree, bookmark: 'bookmark' in found ? found.bookmark : null, actor });
    return true;
}

/**
 * The compat chat ids of a tree's bookmarks (upstream's chats of a character or group): each bookmark's `b<id>`.
 * @param {import('../user-stores.js').UserStore} store
 * @param {bigint} tree
 * @returns {Promise<string[]>}
 */
export async function chatNamesOf(store, tree) {
    const names = [];
    /** @type {string | undefined} */
    let after;
    for (;;) {
        const page = await store.chats.bookmarks({ tree, after, limit: 500 });
        for (const b of page.rows) names.push(bookmarkCompatId(b.id));
        if (!page.more) return names;
        after = page.rows[page.rows.length - 1].id;
    }
}

/**
 * The drops a tree edit answered (bookmarks and state changes that went), or null when nothing went.
 * @param {{ drops?: { bookmarks: unknown[], changes: unknown[] } }} answer
 */
export function droppedOf(answer) {
    const d = answer.drops;
    return d && (d.bookmarks.length || d.changes.length) ? d : null;
}
