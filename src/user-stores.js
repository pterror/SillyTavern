import fs from 'node:fs';
import path from 'node:path';

import { LibraryEngine } from './library-engine.js';
import { ChatEngine } from './chat-engine.js';
import { libraryPeople } from './chat-people.js';
import { TokenCache } from './token-cache-engine.js';
import { getBetterSqlite3 } from './endpoints/native-sqlite.js';

/**
 * Each user's engine store, `<user>/store/`: the library (characters, groups, tags, world info, search), the chats
 * and the token-count cache. Opened on first use (an open returns before replay; reads wait for it), closed on exit.
 */

export const STORE_DIR = 'store';
const OLD_LIBRARY = 'character-metadata.sqlite';
const OLD_CHATS = 'message-tree.sqlite';
/** The one table `character-metadata.sqlite` keeps after the conversion (until stage 6). */
const KEPT_TABLES = new Set(['saved_views']);

export class OldFormatError extends Error {}

/**
 * @typedef {object} UserStore
 * @property {LibraryEngine} lib
 * @property {ChatEngine} chats
 * @property {ReturnType<typeof libraryPeople>} people
 * @property {TokenCache} tokens
 * @property {string} handle
 */

/** @type {Map<string, Promise<UserStore>>} By the user's root directory. */
const open = new Map();
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
 * The tables of an SQLite file other than SQLite's own, read without leaving anything behind: a read-only open of a
 * WAL database makes its `-wal` and `-shm` files, which are removed when they weren't there before.
 * @param {string} file
 * @returns {Promise<string[]>}
 */
async function tablesOf(file) {
    const Database = await getBetterSqlite3();
    const sidecars = ['-wal', '-shm'].map(x => file + x).filter(f => !fs.existsSync(f));
    const db = new Database(file, { readonly: true, fileMustExist: true });
    try {
        const names = [];
        for (const r of /** @type {Iterable<{ name: string }>} */ (db.prepare('SELECT name FROM sqlite_master WHERE type = \'table\' AND name NOT LIKE \'sqlite_%\' LIMIT 1000').iterate())) names.push(r.name);
        return names;
    } finally {
        db.close();
        for (const f of sidecars) fs.rmSync(f, { force: true });
    }
}

/**
 * The line a user directory still in the format before the engine stops the server with, or null when it can be
 * served. Unconverted: the old library or chat store is there and `store/` isn't. A `character-metadata.sqlite` that
 * holds only saved views is the stores' leftover (stage 6 moves them), not an old library.
 * @param {{ root: string }} directories
 * @returns {Promise<string | null>}
 */
export async function oldFormatLine(directories) {
    if (fs.existsSync(path.join(directories.root, STORE_DIR))) return null;
    const old = [];
    const library = path.join(directories.root, OLD_LIBRARY);
    if (fs.existsSync(library) && (await tablesOf(library)).some(t => !KEPT_TABLES.has(t))) old.push(OLD_LIBRARY);
    if (fs.existsSync(path.join(directories.root, OLD_CHATS))) old.push(OLD_CHATS);
    if (!old.length) return null;
    return `${directories.root} holds data in the format before the engine (${old.join(', ')}) and no ${STORE_DIR}/: stop the server and run "node src/migrations/convert-to-engine.js --dry-run", then "--apply --server-stopped"`;
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
    const made = !fs.existsSync(dir);
    const lib = await LibraryEngine.open(engineOf(), dir);
    try {
        if (made) await lib.tags.markSeedPending();
        const people = libraryPeople(lib);
        const chats = await ChatEngine.open(lib.store, people);
        return { lib, chats, people, tokens: new TokenCache(lib.store), handle };
    } catch (err) {
        await lib.close();
        throw err;
    }
}

/**
 * After the server listens: each user's store opened, and the work a stop may have left resumed (a tag reorder
 * pass, the pair postings' build or delete). Not awaited by the caller; each runs in small batches.
 * @param {{ root: string }[]} directoriesList
 */
export async function resumeStoreWork(directoriesList) {
    for (const d of directoriesList) {
        try {
            const { lib } = await userStore(d);
            lib.tags.startPass();
            lib.runPairPostings();
        } catch (err) {
            console.error(`[user-stores] Resuming the store work of ${d.root} failed:`, err);
        }
    }
}

/** Closes every open store. */
export async function closeUserStores() {
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
