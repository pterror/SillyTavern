import { TYPE } from './library-engine.js';
import { importedChatBookmarks } from './upstream-import.js';

const NAMED_CAP = 20;

/**
 * @typedef {object} UpstreamItemizationResult
 * @property {string} chat_id
 * @property {'stored' | 'not-found' | 'ambiguous'} status
 * @property {number} stored
 * @property {number} unchanged
 * @property {{ entry: number, mesId: unknown, why: string }[]} unmatched
 * @property {string} [why]
 */

/**
 * @param {import('./user-stores.js').UserStore} store
 * @param {string} root
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
 * @param {string} entry
 * @returns {bigint | null}
 */
function importedBookmarkOf(entry) {
    const m = /^b(0|[1-9][0-9]*)$/.exec(entry);
    return m ? BigInt(m[1]) : null;
}

/**
 * @param {import('./user-stores.js').UserStore} store
 * @param {Map<string, string[]>} mapped
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
        const id = importedBookmarkOf(bookmarks[0]);
        const [b] = id === null ? [] : await chats.store.chatRead('bookmarks', { ids: [id] });
        const tree = !b ? null : b.at === null ? b.root : (await chats.stored([b.at])).get(b.at)?.owner ?? null;
        if (id === null || tree === null) return { status: 'not-found', why: `the chat imported from "${chatId}" is gone` };
        candidates = [{ tree, bookmark: id }];
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
