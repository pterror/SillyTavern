import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

import { LibraryEngine } from './library-engine.js';
import { ChatEngine } from './chat-engine.js';
import { libraryPeople } from './chat-people.js';
import { TokenCache } from './token-cache-engine.js';
import { markUpstreamImportPending } from './upstream-import.js';

/**
 * Each user's engine store, `<user>/store/`: the library (characters, groups, tags, world info, search), the chats
 * and the token-count cache. Opened on first use (an open returns before replay; reads wait for it), closed on exit.
 */

export const STORE_DIR = 'store';
const OLD_LIBRARY = 'character-metadata.sqlite';
const OLD_CHATS = 'message-tree.sqlite';

export class OldFormatError extends Error {}

/**
 * @typedef {object} UserStore
 * @property {LibraryEngine} lib
 * @property {ChatEngine} chats
 * @property {ReturnType<typeof libraryPeople>} people
 * @property {TokenCache} tokens
 * @property {string} handle
 * @property {EventEmitter} events `commit` (records) after each commit to the store.
 */

/** @type {Map<string, Promise<UserStore>>} By the user's root directory. */
const open = new Map();
/**
 * By the user's root directory: the engine store a read on this thread opened (`openSync`: the same store `open`
 * gives for the directory, one per user).
 * @type {Map<string, any>}
 */
const openedHere = new Map();
/** The roots whose store a read on this thread made (`store/` wasn't there), until `userStore()` opens it. */
const madeHere = new Set();
/** @type {() => any} */
let engineOf = () => {
    throw new Error('user-stores: no engine set');
};

/**
 * @param {() => any} getBinding The engine binding, when a store is first opened.
 */
export function setStoreEngine(getBinding) {
    engineOf = getBinding;
}

/**
 * The line a user directory still in the format before the engine stops the server with, or null when it can be
 * served: unconverted when the old library or chat store is there and `store/` isn't.
 * @param {{ root: string }} directories
 * @returns {Promise<string | null>}
 */
export async function oldFormatLine(directories) {
    return oldFormatLineHere(directories);
}

/**
 * `oldFormatLine()` on this thread.
 * @param {{ root: string }} directories
 * @returns {string | null}
 */
function oldFormatLineHere(directories) {
    if (fs.existsSync(path.join(directories.root, STORE_DIR))) return null;
    const old = [OLD_LIBRARY, OLD_CHATS].filter(f => fs.existsSync(path.join(directories.root, f)));
    if (!old.length) return null;
    return `${directories.root} holds data in the format before the engine (${old.join(', ')}) and no ${STORE_DIR}/: this version can't open it`;
}

/**
 * Refuses to go on when any user's data is in the format before the engine.
 * @param {{ root: string }[]} directoriesList
 */
export async function assertConverted(directoriesList) {
    for (const d of directoriesList) {
        const line = await oldFormatLine(d);
        if (line) throw new OldFormatError(line);
    }
}

/**
 * The user's store, opened on first use. A store made here is marked so its first settings tags import decides the
 * default tags.
 * @param {{ root: string }} directories
 * @param {string} [handle] The user's handle (default: the root's last part).
 * @returns {Promise<UserStore>}
 */
export function userStore(directories, handle = path.basename(directories.root)) {
    const key = path.resolve(directories.root);
    let found = open.get(key);
    if (!found) {
        found = openStore(key, handle);
        open.set(key, found);
        found.catch(() => {
            if (open.get(key) === found) open.delete(key);
        });
    }
    return found;
}

/**
 * @param {string} root
 * @param {string} handle
 * @returns {Promise<UserStore>}
 */
async function openStore(root, handle) {
    const line = await oldFormatLine({ root });
    if (line) throw new OldFormatError(line);
    const dir = path.join(root, STORE_DIR);
    const made = madeHere.delete(root) || !fs.existsSync(dir);
    const lib = await LibraryEngine.open(engineOf(), dir);
    try {
        // Until src/migrations/convert-derived.js has run (deleted with it): reads here don't know the old forms.
        if (await lib.store.convertDerivedPending()) {
            throw new OldFormatError(`${dir} holds derived entries in their old form: stop the server and run node src/migrations/convert-derived.js --apply`);
        }
        if (made) {
            await lib.tags.markSeedPending();
            // A user directory a store is made for may be upstream's: its groups, books and chats go in once.
            await markUpstreamImportPending(lib);
        }
        const events = new EventEmitter();
        events.setMaxListeners(0);
        const commit = lib.store.commit.bind(lib.store);
        lib.store.commit = async (/** @type {object[]} */ records) => {
            const done = await commit(records);
            events.emit('commit', records);
            return done;
        };
        const people = libraryPeople(lib);
        const chats = await ChatEngine.open(lib.store, people, await lib.nextIds());
        return { lib, chats, people, tokens: new TokenCache(lib.store), handle, events };
    } catch (err) {
        await lib.close();
        throw err;
    }
}

/**
 * After the server listens: each user's store opened, the work a stop may have left resumed (a tag reorder pass, the
 * pair postings' build or delete), the settings tags imported while any source is left, and `also` run on it. Not
 * awaited by the caller; each runs in small batches.
 * @param {{ root: string }[]} directoriesList
 * @param {(store: UserStore, directories: { root: string }) => Promise<void>} [also]
 */
export async function resumeStoreWork(directoriesList, also) {
    for (const d of directoriesList) {
        try {
            const store = await userStore(d);
            const { lib } = store;
            lib.tags.startPass();
            lib.runPairPostings();
            await lib.tags.importSettingsTags(d);
            if (also) await also(store, d);
        } catch (err) {
            console.error(`[user-stores] Resuming the store work of ${d.root} failed:`, err);
        }
    }
}

/**
 * The user's engine store, on this thread: the one open for the user, else opened now (`openSync`, the same store
 * `userStore()` gives). For a read that can't wait (`readWorldInfoFile()`, upstream's synchronous export); a read
 * of derived data on it waits for replay on this thread.
 * @param {{ root: string }} directories
 * @returns {any} The binding's `Store`
 */
export function engineStoreHere(directories) {
    const key = path.resolve(directories.root);
    const found = openedHere.get(key);
    if (found) return found;
    const dir = path.join(key, STORE_DIR);
    if (!open.has(key)) {
        const line = oldFormatLineHere({ root: key });
        if (line) throw new OldFormatError(line);
        if (!fs.existsSync(dir)) madeHere.add(key);
    }
    const store = engineOf().Store.openSync(dir);
    openedHere.set(key, store);
    return store;
}

/** Closes every open store. */
export async function closeUserStores() {
    const here = [...openedHere.values()];
    openedHere.clear();
    madeHere.clear();
    const all = [...open.values()];
    open.clear();
    for (const p of all) {
        try {
            const s = await p;
            await s.tokens.idle?.();
            await s.lib.close();
        } catch {
            // A store that failed to open has nothing to close.
        }
    }
    // The same stores as `open`'s, or ones only a read on this thread opened: closing one closed is nothing.
    for (const store of here) await store.close();
}

/**
 * The requesting user's store.
 * @param {{ user: { directories: { root: string }, profile: { handle: string } } }} request
 */
export function requestStore(request) {
    return userStore(request.user.directories, request.user.profile.handle);
}

/**
 * The tree a request names by `avatar_url` (a character) or `group_id`, or null when it names none that exists.
 * @param {UserStore} store
 * @param {{ avatar_url?: unknown, group_id?: unknown }} body
 * @returns {Promise<bigint | null>}
 */
export async function treeOf(store, body) {
    const owner = typeof body?.avatar_url === 'string' ? { avatar: body.avatar_url } : typeof body?.group_id === 'string' ? { group: body.group_id } : null;
    if (owner === null) return null;
    const [tree] = await store.people.trees([owner]);
    return tree ?? null;
}

/**
 * An async route handler whose failure is logged and answered 500 (express 4 doesn't catch a rejected handler).
 * @param {string} what What the route does, for the log.
 * @param {(request: any, response: any) => Promise<unknown>} handler
 */
export function storeRoute(what, handler) {
    return async (/** @type {any} */ request, /** @type {any} */ response) => {
        try {
            await handler(request, response);
        } catch (error) {
            console.error(`Error ${what}:`, error);
            if (!response.headersSent) response.status(500).send({ error: true });
        }
    };
}
