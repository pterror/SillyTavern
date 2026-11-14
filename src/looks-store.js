import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { FONT_BYTES_AT_MOST, IMAGE_BYTES_AT_MOST } from '@st/looks/protocol';
import { isEmptyLook, lookImageUrl, storedLook } from '@st/looks/look';
import { FIELD, LOOK_FIELD, TYPE } from './library-codes.js';
import { thumbnailsOf } from './thumbnail-urls.js';
import { historyWrites } from './entity-values.js';
import { BOOKMARK_LOOK } from './bookmark-looks.js';
import { FONT_FIELD, SHARED_LOOK_FIELD, WORLD_PICTURE_FIELD } from './world-info-engine.js';

export const FONTS_DIRECTORY = 'fonts';
export const LOOK_IMAGES_DIRECTORY = 'look-images';
export const USER_LOOKS = 'user';
const THEME_FIELD = 'theme';
const MARK_FIELD = 'mark';
const USER_SHARED_FIELD = 'shared:';
const BOOKMARK_THING = 'bookmark-';

const KINDS = new Map([[TYPE.entry, 'entry'], [TYPE.book, 'world'], [TYPE.character, 'character'], [TYPE.persona, 'persona']]);
const HISTORY_KEPT = new Set([TYPE.entry, TYPE.persona]);

/**
 * @typedef {import('./library-engine.js').LibraryEngine} LibraryEngine
 * @typedef {import('./entity-values.js').StoredEntity} StoredEntity
 * @typedef {import('@st/looks/server').Ports} Ports
 * @typedef {import('@st/looks/server').Who} Who
 * @typedef {import('@st/looks/protocol').SharedLookRef} SharedLookRef
 */

/**
 * @param {StoredEntity | null | undefined} entity
 * @param {string | number} field
 * @returns {unknown}
 */
function jsonOf(entity, field) {
    const v = entity?.values.find(x => x.field === field);
    if (!v) return undefined;
    return v.json !== undefined ? JSON.parse(v.json) : v.text;
}

/**
 * @param {Buffer} bytes
 * @returns {'woff2' | 'woff' | 'ttf' | 'otf' | null}
 */
export function fontFormatOf(bytes) {
    const head = bytes.subarray(0, 4).toString('latin1');
    if (head === 'wOF2') return 'woff2';
    if (head === 'wOFF') return 'woff';
    if (head === 'OTTO') return 'otf';
    if (head === '\x00\x01\x00\x00' || head === 'true') return 'ttf';
    return null;
}

/**
 * @param {Buffer} bytes
 * @returns {'png' | 'jpg' | 'webp' | 'gif' | null}
 */
export function imageFormatOf(bytes) {
    if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
    if (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
    if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('latin1'))) return 'gif';
    return null;
}

/**
 * @param {string} root the user's data directory
 */
export const fontsDirectory = root => path.join(root, FONTS_DIRECTORY);

/**
 * @param {string} root the user's data directory
 */
export const lookImagesDirectory = root => path.join(root, LOOK_IMAGES_DIRECTORY);

/**
 * @param {string} root
 * @param {Buffer} bytes
 * @returns {Promise<string | null>} the font's id, null when it isn't a font
 */
export function putFont(root, bytes) {
    const format = fontFormatOf(bytes);
    return format === null ? Promise.resolve(null) : putByHash(fontsDirectory(root), bytes, format);
}

/**
 * Stored once by its bytes, under their hash, so an id never names other bytes.
 * @param {string} dir
 * @param {Buffer} bytes
 * @param {string} format
 * @returns {Promise<string>} its id
 */
async function putByHash(dir, bytes, format) {
    const id = `${crypto.createHash('sha256').update(bytes).digest('hex')}.${format}`;
    const file = path.join(dir, id);
    if (fs.existsSync(file)) return id;
    await fs.promises.mkdir(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.promises.writeFile(tmp, bytes);
    await fs.promises.rename(tmp, file);
    return id;
}

/**
 * Keeps an uploaded image in the user's image store, by its content's hash.
 * @param {string} root the user's folder
 * @param {import('@st/server-ui').Upload} file
 * @returns {Promise<{ id: string } | { refused: string }>}
 */
export async function storeImage(root, file) {
    if (file.size > IMAGE_BYTES_AT_MOST) return { refused: `An image is at most ${IMAGE_BYTES_AT_MOST / 1024 / 1024} MB.` };
    const bytes = await fs.promises.readFile(file.path);
    const format = imageFormatOf(bytes);
    if (format === null) return { refused: 'That file is no image: send a PNG, JPEG, WebP or GIF.' };
    return { id: await putByHash(lookImagesDirectory(root), bytes, format) };
}

/**
 * @param {StoredEntity | null} book
 * @returns {{ id: string, name: string }[]}
 */
export function fontsOfBook(book) {
    return (book?.values ?? []).flatMap(v => (typeof v.field === 'string' && v.field.startsWith(FONT_FIELD) && v.text !== undefined
        ? [{ id: v.field.slice(FONT_FIELD.length), name: v.text }]
        : []));
}

/**
 * @param {LibraryEngine} lib
 * @param {string} root
 * @param {bigint} book
 * @returns {Promise<{ id: string, name: string, data: string }[]>}
 */
export async function worldFontsForFile(lib, root, book) {
    const [entity] = await lib.entities([book]);
    const out = [];
    for (const font of fontsOfBook(entity)) {
        const bytes = await fs.promises.readFile(path.join(fontsDirectory(root), font.id)).catch(() => null);
        if (bytes) out.push({ ...font, data: bytes.toString('base64') });
    }
    return out;
}

/**
 * Leaves out what isn't a font.
 * @param {string} root
 * @param {unknown} fonts
 * @returns {Promise<{ id: string, name: string }[]>}
 */
export async function putFontsOfFile(root, fonts) {
    if (!Array.isArray(fonts)) return [];
    const out = [];
    for (const font of fonts) {
        if (typeof font?.data !== 'string' || typeof font?.name !== 'string') continue;
        const bytes = Buffer.from(font.data, 'base64');
        if (bytes.length > FONT_BYTES_AT_MOST) continue;
        const id = await putFont(root, bytes);
        if (id !== null) out.push({ id, name: font.name.slice(0, 100) });
    }
    return out;
}

/**
 * @param {bigint} book
 * @param {{ id: string, name: string }[]} fonts
 */
export const fontRecords = (book, fonts) => fonts.map(f => ({ kind: 'textValue', entity: book, field: FONT_FIELD + f.id, text: f.name }));

/**
 * @param {LibraryEngine} lib
 * @param {string} key
 * @param {(string | number)[]} [fields]
 */
async function lookEntity(lib, key, fields) {
    const [id] = await lib.ids(TYPE.look, [key]);
    if (id === null) return { id: null, entity: null };
    const [entity] = await lib.entities([id], fields ? { fields, lists: [] } : undefined);
    return { id, entity };
}

/**
 * @param {LibraryEngine} lib
 * @param {bigint | null} id
 * @param {string} key
 * @param {object[]} records
 */
function created(lib, id, key, records) {
    if (id !== null) return id;
    const made = lib.nextId++;
    records.push({ kind: 'entityCreate', entity: made, type: TYPE.look, key, added: Date.now() });
    return made;
}

/**
 * @param {bigint} entity
 * @param {string | number} field
 * @param {unknown} before
 * @param {unknown} value undefined deletes it
 * @param {ReturnType<typeof historyWrites> | null} writes
 */
function fieldRecords(entity, field, before, value, writes) {
    const was = before === undefined ? undefined : JSON.stringify(before);
    const json = value === undefined ? undefined : JSON.stringify(value);
    if (was === json) return [];
    if (json === undefined) return writes ? writes.delete(entity, field) : [{ kind: 'valueDelete', entity, field }];
    return writes ? writes.json(entity, field, json, was) : [{ kind: 'jsonValue', entity, field, json }];
}

/**
 * @param {{ libOf: (user: import('@st/server-ui').User) => Promise<LibraryEngine> }} wiring
 * @returns {Ports}
 */
export function looksPorts({ libOf }) {
    const actorOf = (/** @type {Who} */ who) => ({ user: who.user.handle, session: who.session });
    const sharedField = (/** @type {string | null} */ world, /** @type {string} */ id) => (world === null ? USER_SHARED_FIELD + id : SHARED_LOOK_FIELD + id);

    /**
     * @template T
     * @param {LibraryEngine} lib
     * @param {string | null} world
     * @param {(holder: bigint | null, records: object[], commit: (records: object[]) => Promise<unknown>) => Promise<T>} write
     * @returns {Promise<T | 'missing'>}
     */
    const inHolder = (lib, world, write) => (world === null
        ? lib.serialized(TYPE.look, USER_LOOKS, async () => {
            const records = [];
            const { id } = await lookEntity(lib, USER_LOOKS, []);
            return write(id, records, written => lib.store.commit(written));
        })
        : lib.books.inWorld(BigInt(world), (form, commit) => write(BigInt(world), [], commit)));

    /**
     * @param {LibraryEngine} lib
     * @param {string | null} world
     * @param {string[]} ids
     */
    const sharedIn = async (lib, world, ids) => {
        const fields = ids.map(id => sharedField(world, id));
        if (world === null) {
            const { entity } = await lookEntity(lib, USER_LOOKS, fields);
            return fields.map(f => jsonOf(entity, f));
        }
        const [book] = await lib.entities([BigInt(world)], { fields, lists: [] });
        return fields.map(f => (book?.type === TYPE.book ? jsonOf(book, f) : undefined));
    };

    /**
     * A field of the user's looks; an empty value clears it.
     * @param {LibraryEngine} lib
     * @param {string} field
     * @param {(current: unknown) => object | { refused: string }} edit
     * @returns {Promise<import('@st/looks/server').Written>}
     */
    const editUserField = (lib, field, edit) => lib.serialized(TYPE.look, USER_LOOKS, async () => {
        const records = [];
        const { id, entity } = await lookEntity(lib, USER_LOOKS, [field]);
        const before = jsonOf(entity, field);
        const next = edit(before);
        if ('refused' in next) return /** @type {{ refused: string }} */ (next);
        const holder = created(lib, id, USER_LOOKS, records);
        records.push(...fieldRecords(holder, field, before, Object.keys(next).length === 0 ? undefined : next, null));
        if (records.length > 0) await lib.store.commit(records);
        return 'ok';
    });

    /** @type {Ports['editLook']} */
    async function editLook(who, level, edit) {
        const lib = await libOf(who.user);
        const actor = actorOf(who);
        if ('theme' in level) return editUserField(lib, THEME_FIELD, edit);
        if ('shared' in level) {
            const { id: look, world } = level.shared;
            const field = sharedField(world, look);
            const done = await inHolder(lib, world, async (holder, records, commit) => {
                if (holder === null) return 'missing';
                const [entity] = await lib.entities([holder], { fields: [field], lists: [] });
                const before = /** @type {{ name: string, look: unknown } | undefined} */ (jsonOf(entity, field));
                if (!before) return 'missing';
                const next = edit(before.look);
                if ('refused' in next) return next;
                records.push(...fieldRecords(holder, field, before, { name: before.name, look: next }, null));
                if (records.length > 0) await commit(records);
                return 'ok';
            });
            return done;
        }
        const thing = level.thing;
        if (thing.startsWith(BOOKMARK_THING)) {
            const bookmark = thing.slice(BOOKMARK_THING.length);
            const key = BOOKMARK_LOOK + bookmark;
            const [found] = await lib.store.chatRead('bookmarks', { ids: [BigInt(bookmark)] });
            if (!isBookmark(found)) return 'missing';
            return lib.serialized(TYPE.look, key, async () => {
                const records = [];
                const { id, entity } = await lookEntity(lib, key, [LOOK_FIELD]);
                const before = jsonOf(entity, LOOK_FIELD);
                const next = edit(before);
                if ('refused' in next) return next;
                if (isEmptyLook(next)) {
                    if (id !== null) records.push({ kind: 'entityDelete', entity: id });
                } else {
                    records.push(...fieldRecords(created(lib, id, key, records), LOOK_FIELD, before, next, null));
                }
                if (records.length > 0) await lib.store.commit(records);
                return 'ok';
            });
        }
        const [entity] = await lib.entities([BigInt(thing)], { fields: [], lists: [] });
        if (!entity) return 'missing';
        if (entity.type === TYPE.entry) {
            const book = BigInt(entity.key.slice(0, entity.key.indexOf(':')));
            /** @type {{ refused: string } | null} */
            let refused = null;
            const done = await lib.books.editEntryById(book, entity.id, current => {
                const extensions = typeof current.extensions === 'object' && current.extensions !== null && !Array.isArray(current.extensions)
                    ? /** @type {Record<string, unknown>} */ (current.extensions)
                    : {};
                const next = edit(extensions.look);
                if ('refused' in next) {
                    refused = next;
                    return next;
                }
                const rest = { ...extensions };
                delete rest.look;
                return { ...current, extensions: isEmptyLook(next) ? rest : { ...rest, look: next } };
            }, actor);
            if (refused) return refused;
            return done === 'ok' ? 'ok' : typeof done === 'object' ? done : 'missing';
        }
        if (!KINDS.has(entity.type)) return 'missing';
        const write = async (/** @type {(records: object[]) => Promise<unknown>} */ commit) => {
            const records = [];
            const [stored] = await lib.entities([entity.id], { fields: [LOOK_FIELD], lists: [] });
            if (!stored) return 'missing';
            const before = jsonOf(stored, LOOK_FIELD);
            const next = edit(before);
            if ('refused' in next) return next;
            const writes = HISTORY_KEPT.has(entity.type) ? historyWrites(await lib.stamper(actor, records)) : null;
            records.push(...fieldRecords(entity.id, LOOK_FIELD, before, isEmptyLook(next) ? undefined : next, writes));
            if (records.length > 0) await commit(records);
            return /** @type {const} */ ('ok');
        };
        if (entity.type === TYPE.book) return lib.books.inWorld(entity.id, (form, commit) => write(commit));
        return lib.serialized(entity.type, entity.key, () => write(records => lib.store.commit(records)));
    }

    return {
        async readThings(user, things) {
            const lib = await libOf(user);
            const ids = things.map(t => (t.startsWith(BOOKMARK_THING) ? null : BigInt(t)));
            const entities = await lib.entities(ids, { fields: [LOOK_FIELD], lists: [] });
            const bookmarks = things.flatMap(t => (t.startsWith(BOOKMARK_THING) ? [t.slice(BOOKMARK_THING.length)] : []));
            /** @type {Map<string, unknown>} */
            const bookmarkLooks = new Map();
            if (bookmarks.length > 0) {
                const found = await lib.store.chatRead('bookmarks', { ids: bookmarks.map(BigInt) });
                const live = bookmarks.filter((_, i) => isBookmark(found[i]));
                const lookIds = await lib.ids(TYPE.look, live.map(b => BOOKMARK_LOOK + b));
                const looks = await lib.entities(lookIds, { fields: [LOOK_FIELD], lists: [] });
                live.forEach((b, i) => bookmarkLooks.set(b, jsonOf(looks[i], LOOK_FIELD)));
            }
            return things.map((thing, i) => {
                if (thing.startsWith(BOOKMARK_THING)) {
                    const b = thing.slice(BOOKMARK_THING.length);
                    return bookmarkLooks.has(b) ? { kind: 'bookmark', world: null, look: bookmarkLooks.get(b) } : null;
                }
                const e = entities[i];
                const kind = e ? KINDS.get(e.type) : undefined;
                if (!e || kind === undefined) return null;
                const world = e.type === TYPE.entry ? e.key.slice(0, e.key.indexOf(':')) : e.type === TYPE.book ? thing : null;
                return { kind: /** @type {import('@st/looks/protocol').ThingKind} */ (kind), world, look: jsonOf(e, LOOK_FIELD) };
            });
        },
        async describe(user, thing, kind) {
            const lib = await libOf(user);
            /** @param {string} text */
            const named = text => ({ thing, text, shownAs: /** @type {const} */ ('name') });
            if (kind === 'bookmark') {
                const [row] = await lib.store.chatRead('bookmarks', { ids: [BigInt(thing.slice(BOOKMARK_THING.length))] });
                return isBookmark(row) ? { named: named(String(row.name ?? '')), picture: null } : null;
            }
            const [entity] = await lib.entities([BigInt(thing)]);
            if (!entity) return null;
            if (entity.type === TYPE.entry) {
                const book = BigInt(entity.key.slice(0, entity.key.indexOf(':')));
                const [label] = await lib.store.worldRead('worldbuildingLabels', { book, entities: [entity.id] });
                if (!label) return null;
                /** @type {(string | null)[]} */
                const [picture] = await lib.store.worldRead('worldbuildingPictures', { book, entities: [entity.id] });
                return { named: label, picture: picture ? lookImageUrl(picture) : null };
            }
            if (entity.type === TYPE.book) {
                const name = entity.values.find(v => v.field === 'name')?.text;
                const picture = entity.values.find(v => v.field === WORLD_PICTURE_FIELD)?.text;
                return { named: named(typeof name === 'string' && name ? name : entity.key), picture: picture ? lookImageUrl(picture) : null };
            }
            /** @param {StoredEntity | null | undefined} holder */
            const pictureOf = holder => {
                if (!holder) return null;
                const shown = thumbnailsOf(holder, 'avatar');
                return shown.thumbnail_still ?? shown.thumbnail;
            };
            if (entity.type === TYPE.character) {
                const name = jsonOf(entity, FIELD.name);
                return { named: named(typeof name === 'string' ? name : ''), picture: pictureOf(entity) };
            }
            if (entity.type === TYPE.persona) {
                const name = jsonOf(entity, 'name');
                const [image] = await lib.entities(await lib.ids(TYPE.personaImage, [entity.key]));
                return { named: named(typeof name === 'string' ? name : ''), picture: pictureOf(image) };
            }
            return null;
        },
        async storeImage(who, file) {
            return storeImage(who.user.directories.root, file);
        },
        async readTheme(user) {
            const { entity } = await lookEntity(await libOf(user), USER_LOOKS, [THEME_FIELD, MARK_FIELD]);
            return { look: jsonOf(entity, THEME_FIELD), mark: jsonOf(entity, MARK_FIELD) };
        },
        async editMark(who, edit) {
            return editUserField(await libOf(who.user), MARK_FIELD, edit);
        },
        async readShared(user, world, ids) {
            const lib = await libOf(user);
            const inWorld = world === null ? ids.map(() => undefined) : await sharedIn(lib, world, ids);
            const missing = ids.filter((_, i) => inWorld[i] === undefined);
            const inUser = missing.length > 0 ? await sharedIn(lib, null, missing) : [];
            return ids.map((id, i) => {
                const own = /** @type {{ name: string, look: unknown } | undefined} */ (inWorld[i]);
                if (own) return { id, world, name: own.name, look: own.look };
                const user = /** @type {{ name: string, look: unknown } | undefined} */ (inUser[missing.indexOf(id)]);
                return user ? { id, world: null, name: user.name, look: user.look } : null;
            });
        },
        async listShared(user, world) {
            const lib = await libOf(user);
            const { entity } = await lookEntity(lib, USER_LOOKS);
            const of = (/** @type {StoredEntity | null | undefined} */ holder, /** @type {string} */ prefix, /** @type {string | null} */ at) => (holder?.values ?? []).flatMap(v => {
                if (typeof v.field !== 'string' || !v.field.startsWith(prefix) || v.json === undefined) return [];
                return [{ id: v.field.slice(prefix.length), world: at, name: /** @type {string} */ (JSON.parse(v.json).name) }];
            });
            const [book] = world === null ? [null] : await lib.entities([BigInt(world)]);
            const items = [...of(book?.type === TYPE.book ? book : null, SHARED_LOOK_FIELD, world), ...of(entity, USER_SHARED_FIELD, null)];
            return items.sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));
        },
        async worldFonts(user, world) {
            const [book] = await (await libOf(user)).entities([BigInt(world)]);
            return book?.type === TYPE.book ? fontsOfBook(book) : [];
        },
        editLook,
        async makeShared(who, { id, world }, name) {
            const lib = await libOf(who.user);
            return inHolder(lib, world, async (holder, records, commit) => {
                const at = holder ?? created(lib, null, USER_LOOKS, records);
                records.push({ kind: 'jsonValue', entity: at, field: sharedField(world, id), json: JSON.stringify({ name, look: {} }) });
                await commit(records);
                return /** @type {const} */ ('ok');
            });
        },
        async renameShared(who, { id, world }, name) {
            const lib = await libOf(who.user);
            const field = sharedField(world, id);
            return inHolder(lib, world, async (holder, records, commit) => {
                if (holder === null) return 'missing';
                const [entity] = await lib.entities([holder], { fields: [field], lists: [] });
                const before = /** @type {{ name: string, look: unknown } | undefined} */ (jsonOf(entity, field));
                if (!before) return 'missing';
                records.push(...fieldRecords(holder, field, before, { ...before, name }, null));
                if (records.length > 0) await commit(records);
                return 'ok';
            });
        },
        async deleteShared(who, { id, world }) {
            const lib = await libOf(who.user);
            const field = sharedField(world, id);
            return inHolder(lib, world, async (holder, records, commit) => {
                if (holder === null) return 'missing';
                const [entity] = await lib.entities([holder], { fields: [field], lists: [] });
                if (jsonOf(entity, field) === undefined) return 'missing';
                await commit([{ kind: 'valueDelete', entity: holder, field }]);
                return 'ok';
            });
        },
        async moveShared(who, { id, world }, to) {
            const lib = await libOf(who.user);
            const book = world ?? to;
            if (book === null) return 'ok';
            const from = sharedField(world, id);
            const into = sharedField(to, id);
            return lib.books.inWorld(BigInt(book), (form, commit) => lib.serialized(TYPE.look, USER_LOOKS, async () => {
                const records = [];
                const { id: userLooks } = await lookEntity(lib, USER_LOOKS, []);
                const fromHolder = world === null ? userLooks : BigInt(world);
                if (fromHolder === null) return 'missing';
                const [source] = await lib.entities([fromHolder], { fields: [from], lists: [] });
                const shared = /** @type {{ name: string, look: unknown } | undefined} */ (jsonOf(source, from));
                if (!shared) return 'missing';
                const intoHolder = to === null ? created(lib, userLooks, USER_LOOKS, records) : BigInt(to);
                const [target] = await lib.entities([intoHolder], { fields: [into], lists: [] });
                if (jsonOf(target, into) !== undefined) return { refused: 'A shared look of that name is there already.' };
                const fonts = to === null ? new Set() : new Set(fontsOfBook((await lib.entities([intoHolder]))[0]).map(f => f.id));
                const look = storedLook(shared.look, fonts).look ?? {};
                records.push({ kind: 'valueDelete', entity: fromHolder, field: from });
                records.push({ kind: 'jsonValue', entity: intoHolder, field: into, json: JSON.stringify({ name: shared.name, look }) });
                await commit(records);
                return 'ok';
            }));
        },
        async uploadFont(who, world, file, name) {
            const lib = await libOf(who.user);
            if (file.size > FONT_BYTES_AT_MOST) return { refused: `A font is at most ${FONT_BYTES_AT_MOST / 1024 / 1024} MB.` };
            const id = await putFont(who.user.directories.root, await fs.promises.readFile(file.path));
            if (id === null) return { refused: 'That file is no font: send a WOFF2, WOFF, TTF or OTF file.' };
            const done = await lib.books.inWorld(BigInt(world), async (form, commit) => {
                await commit(fontRecords(BigInt(world), [{ id, name }]));
                return 'ok';
            });
            return done === 'ok' ? { id } : 'missing';
        },
    };
}

/**
 * @param {any} found a row of the store's `bookmarks` read
 */
const isBookmark = found => found !== null && found !== undefined && (found.at !== null || found.root !== null);
