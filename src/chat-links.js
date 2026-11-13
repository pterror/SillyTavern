import { CHAT_TEXT_LINK_READS_PER_ANSWER } from '@st/worldbuilding/protocol';

import { getStringHash } from '../public/scripts/hash-utils.js';
import { character_world_link } from '../public/scripts/character-world-link.js';
import { worldInfoGlobalsOf } from '../public/scripts/world-info-globals.js';
import { CHAT_LINKS_LOOKS } from '../public/scripts/name-holders.js';
import { TYPE } from './library-codes.js';
import { readSettingsFor } from './settings-reads.js';
import { onUserStoreOpened, userStore } from './user-stores.js';
import { getCharacterWorldLink } from './world-info-files.js';
import { matchDefaultsOf } from './world-info/key-matching.js';
import { characterOfBook } from './world-info-engine.js';
import { References, linksAmong } from './world-info/references.js';

const WORLD_INFO_METADATA_KEY = 'world_info';

const HELD_MESSAGES_AT_MOST = 256;
const HELD_SESSIONS_AT_MOST = 256;

/**
 * @typedef {{ of: number, links: [number, number, string][], complete: boolean }} MessageLinks
 * @typedef {{ messages: Record<string, MessageLinks>, entries: Record<string, { book: string, uid: number }>, looks: import('@st/protocol/looks').Looks }} ChatLinks
 * @typedef {{ nodeId: string, text: string }} LinkedText
 * @typedef {{ directories: import('./users.js').UserDirectoryList, handle: string, tree: bigint, held: string[] }} HeldLinks
 */

/**
 * The worlds a reply in the chat reads, as generation chooses them (`resolveWorldInfoCandidates`): the ones used in
 * every chat, the character's own world (unless its card's book stands in for it) and its extra books, the chat's and
 * the persona's. A group's chat reads its members'. A card's own book is not among them: none of its entries can be
 * opened on the worldbuilding page, so none is linked.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {import('./user-stores.js').UserStore} store
 * @param {bigint} tree
 * @param {Record<string, unknown>} metadata the chat's, where it is shown
 * @returns {Promise<bigint[]>}
 */
export async function chatWorlds(directories, store, tree, metadata) {
    const taking = await chatMembers(store, tree);
    if (!taking) return [];
    const { group, members } = taking;
    const settings = readSettingsFor(directories, { avatar: group === null ? members[0] : null, groupId: group, tree: String(tree), nodeId: null }, ['power_user', 'world_info_settings', 'user_avatar']);
    const persona = settings.power_user?.persona_data?.[settings.user_avatar]?.lorebook;
    /** @type {Set<string>} */
    const names = new Set(settings.world_info_settings?.world_info?.globalSelect ?? []);
    const cards = members.length ? await store.lib.cards(members) : [];
    for (const [i, avatar] of members.entries()) {
        const card = cards[i];
        const own = card?.data?.extensions?.world;
        if (typeof own === 'string' && own && getCharacterWorldLink(directories, card) !== character_world_link.EMBEDDED) names.add(own);
        for (const extra of await store.lib.extraBookNames(avatar)) names.add(extra);
    }
    const chatWorld = metadata?.[WORLD_INFO_METADATA_KEY];
    if (typeof chatWorld === 'string' && chatWorld) names.add(chatWorld);
    if (typeof persona === 'string' && persona) names.add(persona);
    /** @type {bigint[]} */
    const books = [];
    for (const name of names) {
        if (typeof name !== 'string' || !name) continue;
        const found = await store.lib.books.find(name);
        if (found?.defined && !books.includes(found.id)) books.push(found.id);
    }
    return books;
}

/**
 * The characters taking part in the chat (their avatars) and its group's id, null for a character's chat; null when the
 * chat has no owner.
 * @param {import('./user-stores.js').UserStore} store
 * @param {bigint} tree
 * @returns {Promise<{ group: string | null, members: string[] } | null>}
 */
async function chatMembers(store, tree) {
    const [owner] = await store.lib.store.libraryKeys([tree]);
    if (!owner) return null;
    const group = owner.type === TYPE.group ? owner.key : null;
    const members = group === null
        ? [owner.key]
        : (await store.lib.groups([group]))[0]?.members?.filter((/** @type {unknown} */ m) => typeof m === 'string') ?? [];
    return { group, members };
}

/**
 * Whether a reply in the chat reads `book`: one of `chatWorlds`, or the own book of a character taking part in it whose
 * card names no world that stands in for it (`getCharacterLore`).
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {import('./user-stores.js').UserStore} store
 * @param {bigint} tree
 * @param {{ user: string, session: string | null }} actor whose place in the chat it is read at
 * @param {bigint} book
 * @returns {Promise<boolean>}
 */
export async function chatReadsBook(directories, store, tree, actor, book) {
    const [entity] = await store.lib.entities([book]);
    const character = entity ? characterOfBook(entity) : null;
    if (character !== null) {
        const [owner] = await store.lib.entities([character]);
        if (!owner || !((await chatMembers(store, tree))?.members.includes(owner.key) ?? false)) return false;
        const [card] = await store.lib.cards([owner.key]);
        return getCharacterWorldLink(directories, card) !== character_world_link.FILE;
    }
    return (await chatWorlds(directories, store, tree, await landingMetadata(store, tree, actor))).includes(book);
}

/**
 * Where each text writes a name of an entry of `books`, newest first: the texts share `readsAtMost` reads. A text that
 * the reads left can't look through whole is answered only when it is the first, which had them all (`complete`
 * false: the links found are right, a later word may be a name it didn't reach); the rest are not answered, so the
 * page asks for them again when it shows them. Every name is matched as the entry's world matches it.
 * @param {References} references
 * @param {bigint[]} books
 * @param {LinkedText[]} texts
 * @param {number} [readsAtMost]
 * @returns {Promise<{ messages: Record<string, MessageLinks>, things: string[] }>}
 */
export async function linksOfTexts(references, books, texts, readsAtMost = CHAT_TEXT_LINK_READS_PER_ANSWER) {
    /** @type {Record<string, MessageLinks>} */
    const messages = {};
    /** @type {Set<string>} */
    const things = new Set();
    let left = readsAtMost;
    for (const [i, { nodeId, text }] of texts.entries()) {
        /** @type {import('./world-info/references.js').Link[]} */
        const spans = [];
        let complete = true;
        for (const book of books) {
            const found = await references.spans(book, 0n, text, { readsAtMost: left });
            if (found === null) continue;
            left -= found.reads;
            spans.push(...found.spans);
            if (!found.complete) {
                complete = false;
                break;
            }
        }
        if (!complete && i > 0) break;
        const links = linksAmong(spans).map(/** @returns {[number, number, string]} */ link => [link.from, link.to, String(link.entry)]);
        links.forEach(([, , thing]) => things.add(thing));
        messages[nodeId] = { of: getStringHash(text), links, complete };
        if (!complete) break;
    }
    return { messages, things: [...things] };
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {import('./user-stores.js').UserStore} store
 */
function referencesOf(directories, store) {
    const globals = worldInfoGlobalsOf(readSettingsFor(directories, { avatar: null, groupId: null, tree: null, nodeId: null }, ['world_info_settings']).world_info_settings);
    return new References(store.lib, { defaults: matchDefaultsOf(globals) });
}

/** @type {Map<string, HeldLinks>} */
const heldBySession = new Map();

/** @typedef {(context: import('@st/server-ui').ViewContext, holder: string, things: string[], o: { adding: boolean }) => Promise<import('@st/protocol/looks').Looks>} LooksOf */

/** @type {LooksOf} */
let looksOf = async () => ({ styles: {}, things: {} });

/**
 * The looks area's resolution, which the server's wiring hands in.
 * @param {LooksOf} resolve
 */
export function resolveChatLinkLooks(resolve) {
    looksOf = resolve;
}

/**
 * @param {string} session
 * @param {HeldLinks} held
 */
function hold(session, held) {
    heldBySession.delete(session);
    heldBySession.set(session, held);
    for (const old of heldBySession.keys()) {
        if (heldBySession.size <= HELD_SESSIONS_AT_MOST) break;
        heldBySession.delete(old);
    }
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {import('./user-stores.js').UserStore} store
 * @param {{ session: string, tree: bigint, metadata: Record<string, unknown> }} chat
 * @param {LinkedText[]} texts newest first
 * @param {{ adding: boolean, handle: string }} o
 * @returns {Promise<ChatLinks>}
 */
async function linksFor(directories, store, chat, texts, { adding, handle }) {
    const books = await chatWorlds(directories, store, chat.tree, chat.metadata);
    const found = books.length && texts.length
        ? await linksOfTexts(referencesOf(directories, store), books, texts)
        : { messages: Object.fromEntries(texts.map(({ nodeId, text }) => [nodeId, { of: getStringHash(text), links: [], complete: true }])), things: [] };
    const answered = Object.keys(found.messages);
    const before = heldBySession.get(chat.session);
    const kept = adding && before?.tree === chat.tree ? before.held.filter(id => !answered.includes(id)) : [];
    hold(chat.session, { directories, handle, tree: chat.tree, held: [...answered, ...kept].slice(0, HELD_MESSAGES_AT_MOST) });
    const drawn = await looksOf({ user: { handle, directories: /** @type {any} */ (directories) }, session: chat.session, chat: null }, CHAT_LINKS_LOOKS, found.things, { adding });
    return { messages: found.messages, entries: await openersOf(store, found.things), looks: drawn };
}

/**
 * Where each linked entry opens on the worldbuilding page: its world's name and its uid.
 * @param {import('./user-stores.js').UserStore} store
 * @param {string[]} things
 * @returns {Promise<Record<string, { book: string, uid: number }>>}
 */
async function openersOf(store, things) {
    if (!things.length) return {};
    const described = await store.lib.books.describeEntries(things.map(BigInt));
    return Object.fromEntries(things.flatMap((thing, i) => {
        const entry = described[i];
        const uid = Number(entry?.uid);
        return entry && Number.isFinite(uid) ? [[thing, { book: entry.book, uid }]] : [];
    }));
}

/**
 * @param {Record<string, any> | null | undefined} message
 * @returns {string | null}
 */
const shownText = message => (message && typeof message.mes === 'string' ? message.mes : null);

/**
 * The links an old answer carries for the messages it carries (`messages`, newest last, as a chat's path is), kept as
 * what the tab's chat draws, so a change of a name pushes them again. A request with no tab gets none.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {import('./chat-request.js').ChatContext} chat
 * @param {(Record<string, any> | null | undefined)[]} messages
 * @param {{ adding?: boolean, metadata?: Record<string, unknown> }} [o] adding: more of what the tab shows, kept with
 * what it held; metadata: the chat's where it is shown, when the answer has it
 * @returns {Promise<ChatLinks | undefined>}
 */
export async function chatLinks(directories, chat, messages, { adding = true, metadata } = {}) {
    const session = chat.session.header;
    if (!session || session === 'none') return undefined;
    const texts = [...messages].reverse().flatMap(message => {
        const text = shownText(message);
        return typeof message?.node_id === 'string' && message.node_id !== '' && text !== null ? [{ nodeId: message.node_id, text }] : [];
    });
    const shown = metadata ?? await landingMetadata(chat.store, chat.tree, chat.session.reader());
    return linksFor(directories, chat.store, { session, tree: chat.tree, metadata: shown }, texts, { adding, handle: chat.session.user });
}

/**
 * The links of stored messages by their ids, read as the chat shows them.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {import('./chat-request.js').ChatContext} chat
 * @param {unknown[]} nodeIds newest last
 * @returns {Promise<ChatLinks | undefined>}
 */
export async function storedChatLinks(directories, chat, nodeIds) {
    return chatLinks(directories, chat, await shownMessages(chat.store, chat.tree, nodeIds));
}

/**
 * @param {import('./user-stores.js').UserStore} store
 * @param {bigint} tree
 * @param {unknown[]} nodeIds
 */
async function shownMessages(store, tree, nodeIds) {
    const ids = [...new Set(nodeIds.filter(id => typeof id === 'string' && id !== ''))].map(String);
    const shown = await Promise.all(ids.map(id => store.chats.shownMessage(tree, id)));
    return shown.flatMap((message, i) => (message ? [{ ...message, node_id: ids[i] }] : []));
}

/**
 * @param {import('./user-stores.js').UserStore} store
 * @param {bigint} tree
 * @param {{ user: string, session: string | null }} actor
 * @returns {Promise<Record<string, unknown>>}
 */
async function landingMetadata(store, tree, actor) {
    const at = await store.chats.landingOf(tree, actor);
    const [atId] = at === null ? [null] : await store.chats.messageIds([at]);
    return (await store.chats.metadata(tree, atId ?? null, null)) ?? {};
}

export const CHAT_LINKS_EVENT = 'chat-links';

// The records that can change which words are an entry's name or which worlds a chat reads.
const KINDS_OF_ENTITIES = new Set(['textValue', 'jsonValue', 'valueDelete', 'itemPlace', 'itemDelete', 'histSet', 'histDelete', 'histEdit']);
const KINDS_ALWAYS = new Set(['entityDelete', 'histEntityDelete', 'histRestore', 'histRevert', 'namesOfferMark', 'bookChoose', 'stateUnset']);
const NAMED_TYPES = new Set([TYPE.entry, TYPE.book, TYPE.character]);
const ENTITIES_CHECKED_AT_MOST = 64;

/**
 * @param {import('./user-stores.js').UserStore['lib']} lib
 * @param {any[]} records
 */
async function touchesNames(lib, records) {
    if (records.some(r => KINDS_ALWAYS.has(r?.kind)
        || ((r?.kind === 'entityCreate' || r?.kind === 'entityUpdate') && (r.type === TYPE.entry || r.type === TYPE.book))
        || (r?.kind === 'stateChange' && r.key === WORLD_INFO_METADATA_KEY))) return true;
    const ids = [...new Set(records.filter(r => KINDS_OF_ENTITIES.has(r?.kind) && typeof r.entity === 'bigint').map(r => r.entity))];
    if (ids.length > ENTITIES_CHECKED_AT_MOST) return true;
    if (!ids.length) return false;
    return (await lib.entities(ids)).some(e => e && NAMED_TYPES.has(e.type));
}

/**
 * @param {string} session
 * @param {HeldLinks} held
 * @param {import('./user-stores.js').UserStore} store
 */
async function relink(session, held, store) {
    const messages = await shownMessages(store, held.tree, [...held.held].reverse());
    const texts = [...messages].reverse().flatMap(m => (typeof m.mes === 'string' ? [{ nodeId: m.node_id, text: m.mes }] : []));
    const metadata = await landingMetadata(store, held.tree, { user: held.handle, session });
    const links = await linksFor(held.directories, store, { session, tree: held.tree, metadata }, texts, { adding: false, handle: held.handle });
    store.events.emit(CHAT_LINKS_EVENT, { session, links });
}

onUserStoreOpened(({ events, lib, root }) => {
    let pending = /** @type {any[] | null} */ (null);
    events.on('commit', (/** @type {any[]} */ records) => {
        if (![...heldBySession.values()].some(h => h.directories.root === root)) return;
        if (pending) {
            pending.push(...records);
            return;
        }
        pending = [...records];
        setImmediate(() => {
            const seen = /** @type {any[]} */ (pending);
            pending = null;
            void (async () => {
                if (!await touchesNames(lib, seen)) return;
                for (const [session, held] of [...heldBySession]) {
                    if (held.directories.root !== root) continue;
                    await relink(session, held, await userStore(held.directories, held.handle));
                }
            })().catch(error => console.error('[chat links] not pushed:', error));
        });
    });
});
