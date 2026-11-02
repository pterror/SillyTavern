import fs from 'node:fs';
import path from 'node:path';

import { HASH, TYPE } from './library-codes.js';
import { imageFacts } from './image-identity.js';
import { animatedOf, thumbnailOf } from './thumbnail-urls.js';
import { getImages } from './util.js';
import { storedFolderIds } from './background-folders.js';

const PAGE = 500;

export const BACKGROUND_FIELD = Object.freeze({ aspect: 'aspect', color: 'color', added: 'added', folders: 'folders' });

/**
 * @typedef {import('./library-engine.js').LibraryEngine} LibraryEngine
 * @typedef {import('./entity-values.js').StoredEntity} StoredEntity
 * @typedef {import('./image-identity.js').ImageFacts} ImageFacts
 */

/**
 * @param {bigint} id
 * @param {StoredEntity | null} stored
 * @param {{ still: string, animated: string | null }} facts
 */
function hashRecords(id, stored, facts) {
    const records = [];
    for (const [which, hex] of /** @type {[number, string | null][]} */ ([[HASH.avatarIdentity, facts.still], [HASH.animated, facts.animated]])) {
        const had = stored?.hashes.find(h => h.which === which);
        if ((had ? Buffer.from(had.hash).toString('hex') : null) === hex) continue;
        records.push(hex === null ? { kind: 'cardHash', entity: id, which } : { kind: 'cardHash', entity: id, which, hash: Buffer.from(hex, 'hex') });
    }
    return records;
}

/**
 * @param {StoredEntity | null} stored
 * @param {string} field
 */
function jsonOf(stored, field) {
    const v = stored?.values.find(x => x.field === field);
    if (!v) return undefined;
    return v.json !== undefined ? JSON.parse(v.json) : v.text;
}

/**
 * @param {bigint} id
 * @param {StoredEntity | null} stored
 * @param {Record<string, unknown>} values
 */
function valueRecords(id, stored, values) {
    const records = [];
    for (const [field, value] of Object.entries(values)) {
        if (value === undefined) continue;
        if (JSON.stringify(jsonOf(stored, field)) === JSON.stringify(value)) continue;
        records.push(typeof value === 'string' ? { kind: 'textValue', entity: id, field, text: value } : { kind: 'jsonValue', entity: id, field, json: JSON.stringify(value) });
    }
    return records;
}

/**
 * @param {LibraryEngine} lib
 * @param {number} type
 * @param {string} key
 * @param {StoredEntity | null} stored
 * @param {{ still: string, animated: string | null }} facts
 * @param {Record<string, unknown>} values
 * @param {number} added
 * @returns {object[]}
 */
function imageRecords(lib, type, key, stored, facts, values, added) {
    const records = [];
    const id = stored ? stored.id : lib.nextId++;
    if (!stored) records.push({ kind: 'entityCreate', entity: id, type, key, added });
    records.push(...hashRecords(id, stored, facts), ...valueRecords(id, stored, values));
    return records;
}

/**
 * @param {LibraryEngine} lib
 * @param {string} file
 * @param {Buffer} image
 * @param {{ added?: number, folders?: string[] }} [options]
 */
export async function writeBackground(lib, file, image, { added = Date.now(), folders } = {}) {
    const facts = await imageFacts(image);
    return lib.serialized(TYPE.background, file, async () => {
        const stored = await lib.entity(TYPE.background, file);
        const records = imageRecords(lib, TYPE.background, file, stored, facts, {
            [BACKGROUND_FIELD.aspect]: facts.aspect,
            [BACKGROUND_FIELD.color]: facts.color,
            [BACKGROUND_FIELD.added]: stored ? undefined : added,
            [BACKGROUND_FIELD.folders]: folders ?? (stored ? undefined : []),
        }, added);
        if (records.length) await lib.store.commit(records);
        return facts;
    });
}

/**
 * @param {LibraryEngine} lib
 * @param {string} file
 * @param {Buffer} image
 */
export async function writePersonaImage(lib, file, image) {
    const facts = await imageFacts(image, { color: false });
    return lib.serialized(TYPE.personaImage, file, async () => {
        const stored = await lib.entity(TYPE.personaImage, file);
        const records = imageRecords(lib, TYPE.personaImage, file, stored, facts, {}, Date.now());
        if (records.length) await lib.store.commit(records);
        return facts;
    });
}

/**
 * @param {LibraryEngine} lib
 * @param {number} type
 * @param {string} key
 */
export function removeImage(lib, type, key) {
    return lib.serialized(type, key, async () => {
        const [id] = await lib.ids(type, [key]);
        if (id === null) return false;
        await lib.store.commit([{ kind: 'entityDelete', entity: id }]);
        return true;
    });
}

/**
 * @param {LibraryEngine} lib
 * @param {number} type
 * @param {string} from
 * @param {string} to
 */
export function renameImage(lib, type, from, to) {
    return lib.serialized(type, from, () => lib.serialized(type, to, async () => {
        const [stored, taken] = await Promise.all([lib.entity(type, from), lib.entity(type, to)]);
        if (!stored || taken) return false;
        const id = lib.nextId++;
        const records = [
            { kind: 'entityDelete', entity: stored.id },
            { kind: 'entityCreate', entity: id, type, key: to, added: stored.added },
            ...stored.hashes.map(h => ({ kind: 'cardHash', entity: id, which: h.which, hash: Buffer.from(h.hash) })),
            ...stored.values.map(v => (v.json !== undefined ? { kind: 'jsonValue', entity: id, field: v.field, json: v.json } : { kind: 'textValue', entity: id, field: v.field, text: v.text })),
        ];
        await lib.store.commit(records);
        return true;
    }));
}

/**
 * @param {LibraryEngine} lib
 * @param {number} type
 * @returns {Promise<StoredEntity[]>}
 */
export async function imagesOf(lib, type) {
    /** @type {StoredEntity[]} */
    const out = [];
    /** @type {string | null} */
    let after = null;
    for (;;) {
        const { entities, more } = await lib.store.libraryOfType(type, after, PAGE);
        const stored = await lib.entities(entities.map((/** @type {{ id: bigint }} */ e) => e.id));
        for (const e of stored) if (e) out.push(e);
        if (!more || entities.length === 0) break;
        after = entities[entities.length - 1].key;
    }
    return out;
}

/**
 * @param {StoredEntity} e
 */
export function backgroundOf(e) {
    const folders = jsonOf(e, BACKGROUND_FIELD.folders);
    const aspect = jsonOf(e, BACKGROUND_FIELD.aspect);
    const added = jsonOf(e, BACKGROUND_FIELD.added);
    const color = jsonOf(e, BACKGROUND_FIELD.color);
    return {
        file: e.key,
        animated: animatedOf(e) !== null,
        color: typeof color === 'string' ? color : null,
        aspect: typeof aspect === 'number' ? aspect : null,
        added: typeof added === 'number' ? added : e.added,
        folders: Array.isArray(folders) ? folders.filter(f => typeof f === 'string') : [],
        thumbnail: thumbnailOf(e, 'bg'),
        original: animatedOf(e),
    };
}

/**
 * @param {LibraryEngine} lib
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<{ backgrounds: number, personas: number, failed: { file: string, why: string }[] }>}
 */
export async function importImageFiles(lib, directories) {
    const report = { backgrounds: 0, personas: 0, failed: /** @type {{ file: string, why: string }[]} */ ([]) };
    const folderIds = storedFolderIds(directories.root);
    const kinds = /** @type {const} */ ([
        [directories.backgrounds, TYPE.background, 'backgrounds'],
        [directories.avatars, TYPE.personaImage, 'personas'],
    ]);
    for (const [dir, type, counted] of kinds) {
        const files = fs.existsSync(dir) ? getImages(dir) : [];
        const present = await lib.ids(type, files);
        for (const [i, file] of files.entries()) {
            if (present[i] !== null) continue;
            const where = path.join(dir, file);
            try {
                const image = await fs.promises.readFile(where);
                if (type === TYPE.background) {
                    const stat = await fs.promises.stat(where);
                    await writeBackground(lib, file, image, { added: Math.floor(stat.birthtimeMs || stat.mtimeMs), folders: folderIds.get(file) ?? [] });
                } else {
                    await writePersonaImage(lib, file, image);
                }
                report[counted]++;
            } catch (error) {
                report.failed.push({ file: path.relative(directories.root, where), why: error instanceof Error ? error.message : String(error) });
            }
        }
    }
    return report;
}

/**
 * @param {LibraryEngine} lib
 * @param {string} file
 * @param {(folders: string[]) => string[]} change
 */
export function changeBackgroundFolders(lib, file, change) {
    return lib.serialized(TYPE.background, file, async () => {
        const stored = await lib.entity(TYPE.background, file);
        if (!stored) return false;
        const before = backgroundOf(stored).folders;
        const after = [...new Set(change(before))];
        const records = valueRecords(stored.id, stored, { [BACKGROUND_FIELD.folders]: after });
        if (records.length) await lib.store.commit(records);
        return true;
    });
}
