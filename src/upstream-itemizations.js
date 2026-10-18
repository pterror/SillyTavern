import { bookmarkIdOf } from './chat-engine.js';
import { TYPE } from './library-engine.js';
import { importedChatBookmarks } from './upstream-import.js';

/**
 * Upstream's itemized prompts, which a browser kept per chat (the `SillyTavern_Prompts` IndexedDB store, keyed by
 * the chat id `getCurrentChatId()` gave, each a list of entries whose `mesId` is the message's position in the chat),
 * go onto the messages they belong to. A chat id names the bookmark the upstream import made for that chat file
 * (`upstream-import.json`); without one, a character's chat named so: upstream names a character's chat
 * `<name> - <date>`, so the characters named by what comes before a ` - ` in the id are looked at for a bookmark
 * labelled with the whole id. A chat id naming no chat, or more than one, is left out whole, with why.
 */

/** Characters looked at per name a chat id could start with. */
const NAMED_CAP = 20;

/**
 * @typedef {object} UpstreamItemizationResult
 * @property {string} chat_id
 * @property {'stored' | 'not-found' | 'ambiguous'} status `stored`: the chat was found and every entry that could be
 * placed is stored (or was already); the others leave every entry out.
 * @property {number} stored
 * @property {number} unchanged
 * @property {{ entry: number, mesId: unknown, why: string }[]} unmatched The entries left out of a found chat (`entry`
 * its index in the chat's `entries`), with why.
 * @property {string} [why] Why a chat that isn't `stored` was left out.
 */

/**
 * Stores each chat's entries on its messages.
 * @param {import('./user-stores.js').UserStore} store
 * @param {string} root The user directory.
 * @param {{ chat_id: string, entries: Record<string, unknown>[] }[]} chats
 * @returns {Promise<UpstreamItemizationResult[]>}
 */
export async function importUpstreamItemizations(store, root, chats) {
    const mapped = importedChatBookmarks(root);
    /** @type {UpstreamItemizationResult[]} */
    const out = [];
    for (const { chat_id: chatId, entries } of chats) {
        const base = { chat_id: chatId, stored: 0, unchanged: 0, unmatched: [] };
        const found = await chatOf(store, mapped, chatId);
        if ('why' in found) {
            out.push({ ...base, status: found.status, why: found.why });
            continue;
        }
        const done = await store.chats.importItemizations({ tree: found.tree, at: found.at, entries });
        if (done === null) {
            out.push({ ...base, status: 'not-found', why: 'its chat\'s messages are gone' });
            continue;
        }
        out.push({ ...base, status: 'stored', ...done });
    }
    return out;
}

/**
 * The chat an upstream chat id names: its tree and its bookmark's message.
 * @param {import('./user-stores.js').UserStore} store
 * @param {Map<string, string[]>} mapped {@link importedChatBookmarks}
 * @param {string} chatId
 * @returns {Promise<{ tree: bigint, at: string | null } | { status: 'not-found' | 'ambiguous', why: string }>}
 */
async function chatOf(store, mapped, chatId) {
    const { chats } = store;
    const bookmarks = mapped.get(chatId) ?? [];
    if (bookmarks.length > 1) return { status: 'ambiguous', why: `${bookmarks.length} imported chat files are named "${chatId}"` };
    /** @type {{ tree: bigint, bookmark: bigint }[]} */
    let candidates = [];
    if (bookmarks.length === 1) {
        const id = bookmarkIdOf(bookmarks[0]);
        const tree = id === null ? null : await chats.treeOfChatId(bookmarks[0]);
        if (id === null || tree === null) return { status: 'not-found', why: `the chat imported from "${chatId}" is gone` };
        candidates = [{ tree, bookmark: BigInt(id) }];
    } else {
        candidates = await labelled(store, chatId);
        if (candidates.length > 1) return { status: 'ambiguous', why: `${candidates.length} chats are named "${chatId}"` };
        if (!candidates.length) return { status: 'not-found', why: `no chat is named "${chatId}"` };
    }
    const [{ tree, bookmark }] = candidates;
    const [b] = await chats.store.chatRead('bookmarks', { ids: [bookmark] });
    if (!b) return { status: 'not-found', why: `the chat named "${chatId}" is gone` };
    return { tree, at: b.at === null ? null : (await chats.externalIds([b.at]))[0] };
}

/**
 * The bookmarks labelled `chatId` in the trees of the characters named by what comes before a ` - ` in it.
 * @param {import('./user-stores.js').UserStore} store
 * @param {string} chatId
 * @returns {Promise<{ tree: bigint, bookmark: bigint }[]>}
 */
async function labelled(store, chatId) {
    const names = new Set();
    for (let at = chatId.indexOf(' - '); at > 0; at = chatId.indexOf(' - ', at + 1)) names.add(chatId.slice(0, at));
    /** @type {Map<bigint, bigint[]>} */
    const found = new Map();
    for (const name of names) {
        const rows = await store.lib.store.chatRead('libraryNamed', { type: TYPE.character, name, limit: NAMED_CAP });
        if (!rows.length) continue;
        const keys = (await store.lib.store.libraryKeys(rows.map((/** @type {any} */ r) => r.id))).filter(Boolean);
        const trees = await store.people.trees(keys.map((/** @type {any} */ k) => ({ avatar: k.key })));
        for (const tree of trees) {
            if (tree === null || tree === undefined || found.has(tree)) continue;
            found.set(tree, await store.lib.store.chatRead('bookmarksNamed', { tree, name: chatId }));
        }
    }
    return [...found].flatMap(([tree, ids]) => ids.map(bookmark => ({ tree, bookmark: BigInt(bookmark) })));
}
