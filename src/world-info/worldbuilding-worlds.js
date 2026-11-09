import fs from 'node:fs';
import path from 'node:path';

import { TYPE } from '../library-codes.js';
import { compareBookKeys, namesOfferShown } from '../world-info-engine.js';
import { bookKey } from '../world-info-keys.js';
import { CHOICE, chooseRecord } from '../settings-model/book-choices.js';
import { EMBEDDED_WORLD_NAME } from './candidate-resolution.js';
import { worldFromFile } from './world-files.js';

const PAGE = 1000;

export const NAME_REFUSAL = 'A world\'s name can\'t have / \\ ? < > : * | " or control characters in it, or be a name Windows keeps for itself (like CON).';
export const LENGTH_REFUSAL = 'A world\'s name can be at most 250 bytes long.';
const MAX_NAME_BYTES = 250;
export const EMBEDDED_NAME_REFUSAL = `"${EMBEDDED_WORLD_NAME}" is kept for the lorebooks embedded in characters.`;
const CARD_COPY_REFUSAL = 'This is a copy of a character\'s embedded lorebook; the character keeps its own.';

/**
 * @param {string} name
 * @returns {string | null}
 */
export function worldNameRefusal(name) {
    if (name === EMBEDDED_WORLD_NAME) return EMBEDDED_NAME_REFUSAL;
    if (Buffer.byteLength(name) > MAX_NAME_BYTES) return LENGTH_REFUSAL;
    return bookKey(name) === name ? null : NAME_REFUSAL;
}

const takenRefusal = (/** @type {string} */ name) => `A world named "${name}" already exists.`;

/**
 * @typedef {import('../settings-documents.js').BookChooser} BookChooser
 * @typedef {<T extends { choosers: BookChooser[] }>(user: import('@st/server-ui').User, change: () => Promise<T>) => Promise<T>} BooksChanged
 */

/**
 * @typedef {object} WorldPortsWiring
 * @property {(user: import('@st/server-ui').User) => Promise<import('../library-engine.js').LibraryEngine>} libOf
 * @property {BooksChanged} booksChanged
 */

/**
 * @param {import('../library-engine.js').LibraryEngine} lib
 * @returns {Promise<{ id: bigint, key: string }[]>}
 */
async function worldsOf(lib) {
    /** @type {{ id: bigint, key: string }[]} */
    const books = [];
    let after;
    for (;;) {
        const page = await lib.store.worldRead('books', { after, limit: PAGE });
        books.push(...page.books);
        if (!page.more) break;
        after = books[books.length - 1].key;
    }
    return books.sort((a, b) => compareBookKeys(a.key, b.key));
}

/**
 * @param {import('../library-engine.js').LibraryEngine} lib
 * @param {bigint} book
 * @returns {Promise<string | null>}
 */
async function worldKey(lib, book) {
    const [found] = await lib.store.worldRead('resolved', { ids: [book] });
    return found && found.id === book && found.defined && typeof found.key === 'string' ? found.key : null;
}

/**
 * @param {import('../library-engine.js').LibraryEngine} lib
 * @param {bigint | null} holder
 * @param {number} slot
 * @returns {Promise<{ id: bigint, key: string }[]>}
 */
async function chosen(lib, holder, slot) {
    if (holder === null) return [];
    /** @type {{ slot: number, books: { id: bigint, key: string | null }[] }[][]} */
    const [slots] = await lib.store.worldRead('choices', { holders: [holder] });
    const books = slots.find(s => s.slot === slot)?.books ?? [];
    return /** @type {{ id: bigint, key: string }[]} */ (books.filter(b => typeof b.key === 'string'));
}

/**
 * @param {import('../library-engine.js').LibraryEngine} lib
 * @param {bigint} book
 * @returns {Promise<number>}
 */
async function entryCount(lib, book) {
    return (await lib.store.worldRead('bookStats', { book, entries: [] })).entries;
}

/**
 * @param {import('../world-info-engine.js').NamesOfferRead} read
 * @returns {import('@st/worldbuilding/protocol').NamesOffer | null}
 */
function namesOfferOf(read) {
    const running = read.state === 'marking' || read.state === 'undoing' ? read.state : null;
    if (running === null && !namesOfferShown(read)) return null;
    return { entries: read.offeredEntries, example: read.example, running, marked: read.marks };
}

/**
 * @param {import('../library-engine.js').LibraryEngine} lib
 * @param {string} handle
 * @returns {Promise<bigint | null>}
 */
async function holderOf(lib, handle) {
    const [id] = await lib.ids(TYPE.user, [handle]);
    return id;
}

/**
 * @param {import('../library-engine.js').LibraryEngine} lib
 * @param {string} wanted
 * @returns {Promise<string>}
 */
export async function freeWorldName(lib, wanted) {
    if (!(await lib.books.exists(wanted))) return wanted;
    const stem = wanted.replace(/\s*\(\d+\)$/, '');
    for (let n = 1; ; n++) {
        const name = `${stem} (${n})`;
        if (!(await lib.books.exists(name))) return name;
    }
}

/**
 * The world actions and the worlds views of the worldbuilding area, over the store.
 * @param {WorldPortsWiring} wiring
 * @returns {Pick<import('@st/worldbuilding/server').Ports, 'readWorlds' | 'readWorld' | 'openWorld' | 'createWorld' | 'renameWorld' | 'duplicateWorld' | 'deleteWorld' | 'importWorld' | 'exportWorld' | 'setUsedInEveryChat' | 'markTitleKeysAsNames' | 'declineNamesOffer' | 'undoMarkTitleKeysAsNames'>}
 */
export function worldbuildingWorldPorts({ libOf, booksChanged }) {
    const actorOf = (/** @type {import('@st/worldbuilding/server').Who} */ who) => ({ user: who.user.handle, session: who.session });

    /**
     * @param {import('@st/worldbuilding/server').Who} who
     * @param {string} wanted
     * @param {Record<string, unknown>} data
     * @returns {Promise<import('@st/worldbuilding/server').NewWorld>}
     */
    const writeNew = async (who, wanted, data) => {
        const lib = await libOf(who.user);
        for (;;) {
            const name = await freeWorldName(lib, wanted);
            const refusal = worldNameRefusal(name);
            if (refusal) return { refused: refusal };
            const written = await lib.books.create(name, data, actorOf(who));
            if (written === 'card copy') return { refused: CARD_COPY_REFUSAL };
            if (written !== 'taken') return { book: String(written.book) };
        }
    };

    /**
     * @param {import('@st/server-ui').User} user
     * @param {bigint} book
     */
    const usedInEveryChat = async (user, book) => {
        const lib = await libOf(user);
        return (await chosen(lib, await holderOf(lib, user.handle), CHOICE.selected)).some(b => b.id === book);
    };

    return {
        async readWorlds(user) {
            const lib = await libOf(user);
            const used = new Set((await chosen(lib, await holderOf(lib, user.handle), CHOICE.selected)).map(b => b.id));
            const worlds = await worldsOf(lib);
            return Promise.all(worlds.map(async ({ id, key }) => ({ id: String(id), name: key, entries: await entryCount(lib, id), usedInEveryChat: used.has(id) })));
        },
        async readWorld(user, book) {
            const lib = await libOf(user);
            const id = BigInt(book);
            const key = await worldKey(lib, id);
            if (key === null) return null;
            return { id: book, name: key, entries: await entryCount(lib, id), usedInEveryChat: await usedInEveryChat(user, id), namesOffer: namesOfferOf(await lib.books.namesOffer(id)) };
        },
        async openWorld({ user }, book) {
            const lib = await libOf(user);
            const holder = await holderOf(lib, user.handle);
            const [last] = await chosen(lib, holder, CHOICE.lastOpened);
            /** @type {{ id: bigint, key: string } | null} */
            let opened = null;
            if (book !== null) {
                const key = await worldKey(lib, BigInt(book));
                opened = key === null ? null : { id: BigInt(book), key };
            } else {
                opened = last ?? (await worldsOf(lib))[0] ?? null;
            }
            if (opened === null) return null;
            if (holder !== null && last?.id !== opened.id) await lib.store.commit([chooseRecord(holder, CHOICE.lastOpened, [opened.key])]);
            return String(opened.id);
        },
        async createWorld(who, name) {
            const refusal = worldNameRefusal(name);
            if (refusal) return { refused: refusal };
            const written = await (await libOf(who.user)).books.create(name, { entries: {} }, actorOf(who));
            if (written === 'taken') return { refused: takenRefusal(name) };
            if (written === 'card copy') return { refused: CARD_COPY_REFUSAL };
            return { book: String(written.book) };
        },
        async renameWorld(who, book, name) {
            const refusal = worldNameRefusal(name);
            if (refusal) return { refused: refusal };
            const lib = await libOf(who.user);
            const id = BigInt(book);
            const key = await worldKey(lib, id);
            if (key === null) return 'missing';
            const { renamed } = await booksChanged(who.user, async () => {
                const done = await lib.books.rename(key, name, { relink: true });
                return { renamed: done, choosers: done === 'ok' ? await lib.books.choosers(id) : [] };
            });
            if (renamed === 'taken') return { refused: takenRefusal(name) };
            return renamed;
        },
        async duplicateWorld(who, book) {
            const lib = await libOf(who.user);
            const key = await worldKey(lib, BigInt(book));
            const data = key === null ? null : await lib.books.read(key);
            if (key === null || data === null) return 'missing';
            return writeNew(who, key, data);
        },
        async deleteWorld({ user }, book) {
            const lib = await libOf(user);
            const key = await worldKey(lib, BigInt(book));
            if (key === null) return 'missing';
            const { deleted } = await booksChanged(user, async () => {
                const gone = await lib.books.delete(key);
                return { deleted: gone !== null, choosers: gone?.choosers ?? [] };
            });
            return deleted ? 'ok' : 'missing';
        },
        async importWorld(who, file) {
            const read = worldFromFile(await fs.promises.readFile(file.path));
            if ('refused' in read) return read;
            const name = path.parse(file.name).name.trim();
            if (name === '') return { refused: 'The file needs a name for the world to take.' };
            return writeNew(who, name, read.world);
        },
        async exportWorld(user, book) {
            const lib = await libOf(user);
            const key = await worldKey(lib, BigInt(book));
            const data = key === null ? null : await lib.books.read(key);
            if (key === null || data === null) return null;
            return { fileName: `${key}.json`, json: JSON.stringify(data) };
        },
        async markTitleKeysAsNames({ user }, book) {
            return (await libOf(user)).books.markTitleKeysAsNames(BigInt(book));
        },
        async declineNamesOffer({ user }, book) {
            return (await libOf(user)).books.declineNamesOffer(BigInt(book));
        },
        async undoMarkTitleKeysAsNames({ user }, book) {
            return (await libOf(user)).books.undoMarkTitleKeysAsNames(BigInt(book));
        },
        async setUsedInEveryChat({ user }, book, used) {
            const lib = await libOf(user);
            const id = BigInt(book);
            const key = await worldKey(lib, id);
            const holder = await holderOf(lib, user.handle);
            if (key === null) return 'missing';
            if (holder === null) throw new Error(`${user.handle} has no settings to choose worlds in`);
            await booksChanged(user, async () => {
                const before = await chosen(lib, holder, CHOICE.selected);
                if (before.some(b => b.id === id) === used) return { choosers: [] };
                const keys = used ? [...before.map(b => b.key), key] : before.filter(b => b.id !== id).map(b => b.key);
                await lib.store.commit([chooseRecord(holder, CHOICE.selected, keys)]);
                return { choosers: [{ holder, slot: CHOICE.selected, type: TYPE.user, key: user.handle }] };
            });
            return 'ok';
        },
    };
}
