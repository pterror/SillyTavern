import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

import { LibraryEngine } from './library-engine.js';
import { ChatEngine } from './chat-engine.js';
import { libraryPeople } from './chat-people.js';
import { TokenCache } from './token-cache-engine.js';
import { markUpstreamImportPending } from './upstream-import.js';

export const STORE_DIR = 'store';
const OLD_LIBRARY = 'character-metadata.sqlite';
const OLD_CHATS = 'message-tree.sqlite';
export const NAMED_THUMBNAILS = Object.freeze(['bg', 'avatar', 'persona'].map(d => path.join('thumbnails', d)));

export class OldFormatError extends Error {}

/**
 * @typedef {object} UserStore
 * @property {LibraryEngine} lib
 * @property {ChatEngine} chats
 * @property {ReturnType<typeof libraryPeople>} people
 * @property {TokenCache} tokens
 * @property {string} handle
 * @property {EventEmitter} events
 */

/** @type {Map<string, Promise<UserStore>>} */
const open = new Map();
/** @type {Map<string, any>} */
const openedHere = new Map();
const madeHere = new Set();
/** @type {() => any} */
let engineOf = () => {
    throw new Error('user-stores: no engine set');
};

/**
 * @param {() => any} getBinding
 */
export function setStoreEngine(getBinding) {
    engineOf = getBinding;
}

/**
 * @param {{ root: string }} directories
 * @returns {Promise<string | null>}
 */
export async function oldFormatLine(directories) {
    return oldFormatLineHere(directories);
}

/**
 * @param {{ root: string }} directories
 * @returns {string | null}
 */
function oldFormatLineHere(directories) {
    if (fs.existsSync(path.join(directories.root, STORE_DIR))) {
        const thumbnails = NAMED_THUMBNAILS.filter(d => fs.existsSync(path.join(directories.root, d)));
        if (!thumbnails.length) return null;
        return `${directories.root} keeps thumbnails by file name (${thumbnails.join(', ')}): stop the server and run node src/migrations/image-entities.js --apply`;
    }
    const old = [OLD_LIBRARY, OLD_CHATS].filter(f => fs.existsSync(path.join(directories.root, f)));
    if (!old.length) return null;
    return `${directories.root} holds data in the format before the engine (${old.join(', ')}) and no ${STORE_DIR}/: this version can't open it`;
}

/**
 * @param {string} root
 */
function dropNamedThumbnails(root) {
    for (const d of NAMED_THUMBNAILS) fs.rmSync(path.join(root, d), { recursive: true, force: true });
}

/**
 * @param {{ root: string }[]} directoriesList
 */
export async function assertConverted(directoriesList) {
    for (const d of directoriesList) {
        const line = await oldFormatLine(d);
        if (line) throw new OldFormatError(line);
    }
}

/**
 * @param {{ root: string }} directories
 * @param {string} [handle]
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
    const dir = path.join(root, STORE_DIR);
    if (!fs.existsSync(dir)) dropNamedThumbnails(root);
    const line = await oldFormatLine({ root });
    if (line) throw new OldFormatError(line);
    const made = madeHere.delete(root) || !fs.existsSync(dir);
    const lib = await LibraryEngine.open(engineOf(), dir);
    try {
        if (made) {
            await lib.tags.markSeedPending();
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
 * @param {{ root: string }[]} directoriesList
 * @param {(store: UserStore, directories: { root: string }) => Promise<void>} [also]
 */
export async function resumeStoreWork(directoriesList, also) {
    for (const d of directoriesList) {
        try {
            const store = await userStore(d);
            const { lib } = store;
            lib.tags.startPass();
            void lib.buildPairs();
            await lib.tags.importSettingsTags(d);
            if (also) await also(store, d);
        } catch (err) {
            console.error(`[user-stores] Resuming the store work of ${d.root} failed:`, err);
        }
    }
}

/**
 * @param {{ root: string }} directories
 * @returns {any}
 */
export function engineStoreHere(directories) {
    const key = path.resolve(directories.root);
    const found = openedHere.get(key);
    if (found) return found;
    const dir = path.join(key, STORE_DIR);
    if (!open.has(key)) {
        if (!fs.existsSync(dir)) dropNamedThumbnails(key);
        const line = oldFormatLineHere({ root: key });
        if (line) throw new OldFormatError(line);
        if (!fs.existsSync(dir)) madeHere.add(key);
    }
    const store = engineOf().Store.openSync(dir);
    openedHere.set(key, store);
    return store;
}

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
    for (const store of here) await store.close();
}

/**
 * @param {{ user: { directories: { root: string }, profile: { handle: string } } }} request
 */
export function requestStore(request) {
    return userStore(request.user.directories, request.user.profile.handle);
}

/**
 * @param {string} what
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
