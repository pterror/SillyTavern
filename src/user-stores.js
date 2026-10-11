import fs from 'node:fs';
import path from 'node:path';

import { LibraryEngine } from './library-engine.js';
import { ChatEngine } from './chat-engine.js';
import { libraryPeople } from './chat-people.js';
import { TokenCache } from './token-cache-engine.js';

/**
 * Each user's engine store, `<user>/store/`: the library (characters, groups, tags, world info, search), the chats
 * and the token-count cache. Opened on first use (an open returns before replay; reads wait for it), closed on exit.
 */

export const STORE_DIR = 'store';
/** Files only a store in the format before the engine has; `convert-to-engine.js` reads them into `store/`. */
const OLD_FORMAT_FILES = ['character-metadata.sqlite', 'message-tree.sqlite'];

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
 * The line a user directory in the format before the engine stops the server with, or null when it can be served:
 * its store exists, or it holds none of the old stores' files (a new store is made).
 * @param {{ root: string }} directories
 * @returns {string | null}
 */
export function oldFormatLine(directories) {
    if (fs.existsSync(path.join(directories.root, STORE_DIR))) return null;
    const old = OLD_FORMAT_FILES.filter(f => fs.existsSync(path.join(directories.root, f)));
    if (!old.length) return null;
    return `${directories.root} holds data in the format before the engine (${old.join(', ')}) and no ${STORE_DIR}/: stop the server and run "node src/migrations/convert-to-engine.js --dry-run", then "--apply --server-stopped"`;
}

/**
 * Refuses to go on when any user's data is in the format before the engine.
 * @param {{ root: string }[]} directoriesList
 */
export function assertConverted(directoriesList) {
    for (const d of directoriesList) {
        const line = oldFormatLine(d);
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
    const line = oldFormatLine({ root });
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
