import fs from 'node:fs';
import path from 'node:path';

import { lookImageUrl } from '@st/looks/look';
import { FIELD, TYPE } from '../library-codes.js';
import { SLOT, WORLD_PICTURE_FIELD, characterOfBook, compareBookKeys, namesOfferShown } from '../world-info-engine.js';
import { bookKey } from '../world-info-keys.js';
import { CHOICE, chooseRecord } from '../settings-model/book-choices.js';
import { EMBEDDED_WORLD_NAME } from './candidate-resolution.js';
import { worldFromFile } from './world-files.js';
import { fontRecords, fontsOfBook, putFontsOfFile, storeImage, worldFontsForFile } from '../looks-store.js';

const PAGE = 1000;

export const NAME_REFUSAL = 'A world\'s name can\'t have / \\ ? < > : * | " or control characters in it, or be a name Windows keeps for itself (like CON).';
export const LENGTH_REFUSAL = 'A world\'s name can be at most 250 bytes long.';
const MAX_NAME_BYTES = 250;
export const EMBEDDED_NAME_REFUSAL = `"${EMBEDDED_WORLD_NAME}" is kept for the lorebooks embedded in characters.`;
const CARD_COPY_REFUSAL = 'This is a copy of a character\'s embedded lorebook; the character keeps its own.';
export const CARD_BOOK_REFUSAL = 'A character\'s own lorebook stays with its character: it isn\'t renamed, copied, exported or used in every chat.';
// The world's description: a field of the book, carried by a world file and by a card's book as `description`.
const DESCRIPTION_FIELD = 'description';

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
 * The character whose own book `book` is, with its name and the book's, else null.
 * @param {import('../library-engine.js').LibraryEngine} lib
 * @param {import('../entity-values.js').StoredEntity | null} entity the book
 * @returns {Promise<{ character: bigint, characterName: string, bookName: string } | null>}
 */
async function cardBookOf(lib, entity) {
    const character = entity ? characterOfBook(entity) : null;
    if (!entity || character === null) return null;
    const [owner] = await lib.entities([character]);
    if (!owner || owner.type !== TYPE.character) return null;
    const characterName = owner.values.find(v => v.field === FIELD.name)?.text ?? owner.key;
    const bookName = entity.values.find(v => v.field === 'name')?.text ?? '';
    return { character, characterName, bookName };
}

/**
 * @param {import('../entity-values.js').StoredEntity | null | undefined} book
 * @returns {string | null}
 */
function pictureOf(book) {
    const id = book?.values.find(v => v.field === WORLD_PICTURE_FIELD)?.text;
    return id ? lookImageUrl(id) : null;
}

/**
 * @param {import('../entity-values.js').StoredEntity | null | undefined} book
 * @returns {string}
 */
function descriptionOf(book) {
    return book?.values.find(v => v.field === DESCRIPTION_FIELD)?.text ?? '';
}

/**
 * A world file's entries without their pictures: an image's id names it only in this user's image store.
 * @param {Record<string, unknown>} world
 * @returns {Record<string, unknown>}
 */
function withoutPictures(world) {
    const entries = world.entries;
    if (typeof entries !== 'object' || entries === null) return world;
    const out = Array.isArray(entries) ? [] : {};
    for (const [key, entry] of Object.entries(entries)) {
        const extensions = /** @type {any} */ (entry)?.extensions;
        if (typeof extensions === 'object' && extensions !== null && !Array.isArray(extensions) && 'picture' in extensions) {
            const rest = { ...extensions };
            delete rest.picture;
            /** @type {any} */ (out)[key] = { ...entry, extensions: rest };
        } else {
            /** @type {any} */ (out)[key] = entry;
        }
    }
    return { ...world, entries: out };
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
 * @param {import('../library-engine.js').LibraryEngine} lib
 * @param {bigint} book
 * @param {{ id: string, name: string }[]} fonts
 */
async function withFonts(lib, book, fonts) {
    if (fonts.length > 0) await lib.books.inWorld(book, (form, commit) => commit(fontRecords(book, fonts)));
}

/**
 * The world actions and the worlds views of the worldbuilding area, over the store.
 * @param {WorldPortsWiring} wiring
 * @returns {Pick<import('@st/worldbuilding/server').Ports, 'readWorlds' | 'readWorld' | 'characterBook' | 'worldNamed' | 'entryOfUid' | 'setWorldDescription' | 'setPicture' | 'openWorld' | 'createWorld' | 'renameWorld' | 'duplicateWorld' | 'deleteWorld' | 'importWorld' | 'exportWorld' | 'setUsedInEveryChat' | 'markTitleKeysAsNames' | 'declineNamesOffer' | 'undoMarkTitleKeysAsNames'>}
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
            const entities = await lib.entities(worlds.map(({ id }) => id));
            return Promise.all(worlds.map(async ({ id, key }, at) => ({ id: String(id), name: key, entries: await entryCount(lib, id), usedInEveryChat: used.has(id), picture: pictureOf(entities[at]) })));
        },
        async readWorld(user, book) {
            const lib = await libOf(user);
            const id = BigInt(book);
            const [entity] = await lib.entities([id]);
            const card = await cardBookOf(lib, entity);
            const shown = { picture: pictureOf(entity), description: descriptionOf(entity) };
            if (card !== null) {
                const cameWith = { thing: String(card.character), text: card.characterName, shownAs: /** @type {const} */ ('name') };
                return { id: book, name: card.bookName || card.characterName, entries: await entryCount(lib, id), usedInEveryChat: false, namesOffer: namesOfferOf(await lib.books.namesOffer(id)), ...shown, cameWith };
            }
            const key = await worldKey(lib, id);
            if (key === null) return null;
            return { id: book, name: key, entries: await entryCount(lib, id), usedInEveryChat: await usedInEveryChat(user, id), namesOffer: namesOfferOf(await lib.books.namesOffer(id)), ...shown, cameWith: null };
        },
        async characterBook(user, character) {
            const lib = await libOf(user);
            const [book] = await lib.ids(TYPE.ownedBook, [`${character}:${SLOT.characterBook}`]);
            if (book === null) return null;
            const [entity] = await lib.entities([book]);
            return (await cardBookOf(lib, entity)) !== null ? String(book) : null;
        },
        async worldNamed(user, name) {
            const found = await (await libOf(user)).books.find(name);
            return found?.defined ? String(found.id) : null;
        },
        async entryOfUid(user, book, uid) {
            const lib = await libOf(user);
            const [id] = await lib.ids(TYPE.entry, [`${book}:${uid}`]);
            return id === null || !(await lib.books.entryIn(BigInt(book), id)) ? null : String(id);
        },
        async setWorldDescription({ user }, book, description) {
            const lib = await libOf(user);
            const id = BigInt(book);
            const done = await lib.books.inWorld(id, (form, commit) => commit([description === ''
                ? { kind: 'valueDelete', entity: id, field: DESCRIPTION_FIELD }
                : { kind: 'textValue', entity: id, field: DESCRIPTION_FIELD, text: description }]));
            return done === 'missing' ? 'missing' : 'ok';
        },
        async setPicture(who, book, entry, file) {
            const lib = await libOf(who.user);
            const id = BigInt(book);
            /** @type {string | null} */
            let picture = null;
            if (file !== null) {
                const stored = await storeImage(who.user.directories.root, file);
                if ('refused' in stored) return stored;
                picture = stored.id;
            }
            if (entry === null) {
                const done = await lib.books.inWorld(id, (form, commit) => commit([picture === null
                    ? { kind: 'valueDelete', entity: id, field: WORLD_PICTURE_FIELD }
                    : { kind: 'textValue', entity: id, field: WORLD_PICTURE_FIELD, text: picture }]));
                return done === 'missing' ? 'missing' : 'ok';
            }
            return lib.books.editEntryById(id, BigInt(entry), current => {
                const extensions = { ...(typeof current.extensions === 'object' && current.extensions !== null ? /** @type {Record<string, unknown>} */ (current.extensions) : {}) };
                if (picture === null) delete extensions.picture;
                else extensions.picture = picture;
                return { ...current, extensions };
            }, actorOf(who));
        },
        async openWorld({ user }, book) {
            const lib = await libOf(user);
            if (book !== null && (await lib.books.bookForm(BigInt(book)))?.form === 'card') return book;
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
            if ((await lib.books.bookForm(id))?.form === 'card') return { refused: CARD_BOOK_REFUSAL };
            const key = await worldKey(lib, id);
            if (key === null) return 'missing';
            const { renamed } = await booksChanged(who.user, async () => {
                const done = await lib.books.rename(key, name);
                return { renamed: done, choosers: done === 'ok' ? await lib.books.choosers(id) : [] };
            });
            if (renamed === 'taken') return { refused: takenRefusal(name) };
            return renamed;
        },
        async duplicateWorld(who, book) {
            const lib = await libOf(who.user);
            if ((await lib.books.bookForm(BigInt(book)))?.form === 'card') return { refused: CARD_BOOK_REFUSAL };
            const key = await worldKey(lib, BigInt(book));
            const data = key === null ? null : await lib.books.read(key);
            if (key === null || data === null) return 'missing';
            const made = await writeNew(who, key, data);
            if ('book' in made) {
                const [original] = await lib.entities([BigInt(book)]);
                const copy = BigInt(made.book);
                await withFonts(lib, copy, fontsOfBook(original));
                const picture = original?.values.find(v => v.field === WORLD_PICTURE_FIELD)?.text;
                if (picture) await lib.books.inWorld(copy, (form, commit) => commit([{ kind: 'textValue', entity: copy, field: WORLD_PICTURE_FIELD, text: picture }]));
            }
            return made;
        },
        async deleteWorld({ user }, book) {
            const lib = await libOf(user);
            const worlds = await worldsOf(lib);
            const [entity] = await lib.entities([BigInt(book)]);
            const owner = entity ? characterOfBook(entity) : null;
            if (owner !== null) {
                const removed = await lib.removeCharacterBook(owner);
                return removed === 'ok' ? { next: worlds[0] === undefined ? null : String(worlds[0].id) } : 'missing';
            }
            const key = await worldKey(lib, BigInt(book));
            if (key === null) return 'missing';
            const at = worlds.findIndex(w => w.key === key);
            const next = worlds[at + 1] ?? worlds[at - 1] ?? null;
            const { deleted } = await booksChanged(user, async () => {
                const gone = await lib.books.delete(key);
                return { deleted: gone !== null, choosers: gone?.choosers ?? [] };
            });
            return deleted ? { next: next === null ? null : String(next.id) } : 'missing';
        },
        async importWorld(who, file) {
            const read = worldFromFile(await fs.promises.readFile(file.path));
            if ('refused' in read) return read;
            const name = path.parse(file.name).name.trim();
            if (name === '') return { refused: 'The file needs a name for the world to take.' };
            const { fonts, ...world } = withoutPictures(read.world);
            const kept = await putFontsOfFile(who.user.directories.root, fonts);
            const made = await writeNew(who, name, world);
            if ('book' in made) await withFonts(await libOf(who.user), BigInt(made.book), kept);
            return made;
        },
        async exportWorld(user, book) {
            const lib = await libOf(user);
            if ((await lib.books.bookForm(BigInt(book)))?.form === 'card') return { refused: CARD_BOOK_REFUSAL };
            const key = await worldKey(lib, BigInt(book));
            const read = key === null ? null : await lib.books.read(key);
            if (key === null || read === null) return null;
            const data = withoutPictures(read);
            const fonts = await worldFontsForFile(lib, user.directories.root, BigInt(book));
            return { fileName: `${key}.json`, json: JSON.stringify(fonts.length > 0 ? { ...data, fonts } : data) };
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
        async setUsedInEveryChat({ user }, changes) {
            const lib = await libOf(user);
            /** @type {Map<bigint, { key: string, used: boolean }>} */
            const wanted = new Map();
            for (const { book, used } of changes) {
                const id = BigInt(book);
                if ((await lib.books.bookForm(id))?.form === 'card') return { refused: CARD_BOOK_REFUSAL };
                const key = await worldKey(lib, id);
                if (key === null) return 'missing';
                wanted.set(id, { key, used });
            }
            const holder = await holderOf(lib, user.handle);
            if (holder === null) throw new Error(`${user.handle} has no settings to choose worlds in`);
            await booksChanged(user, async () => {
                const before = await chosen(lib, holder, CHOICE.selected);
                const kept = before.filter(b => wanted.get(b.id)?.used !== false).map(b => b.key);
                const added = [...wanted.entries()].filter(([id, w]) => w.used && !before.some(b => b.id === id)).map(([, w]) => w.key);
                if (kept.length === before.length && added.length === 0) return { choosers: [] };
                await lib.store.commit([chooseRecord(holder, CHOICE.selected, [...kept, ...added])]);
                return { choosers: [{ holder, slot: CHOICE.selected, type: TYPE.user, key: user.handle }] };
            });
            return 'ok';
        },
    };
}
