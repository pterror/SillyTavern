import { describe, test, expect, beforeAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineCharacterStoreFunctions } from '../src/character-store-schema.js';

/**
 * better-sqlite3 with the store's SQL functions registered on every connection, as the store's own connections have
 * them (character-store-schema.js).
 * @param {typeof import('better-sqlite3')} Base
 * @returns {typeof import('better-sqlite3')}
 */
function withStoreFunctions(Base) {
    return /** @type {any} */ (class extends /** @type {any} */ (Base) {
        constructor(/** @type {any[]} */ ...args) {
            super(...args);
            defineCharacterStoreFunctions({ defineFunction: (name, fn) => this.function(name, { deterministic: true }, fn) });
        }
    });
}

/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {typeof import('../public/scripts/hash-utils.js').tagNameKey} */
let tagNameKey;
/** @type {typeof import('better-sqlite3')} */
let Database;

/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    metadataDb = await import('../src/character-metadata-db.js');
    ({ tagNameKey } = await import('../public/scripts/hash-utils.js'));
    Database = withStoreFunctions((await import('better-sqlite3')).default);
});

beforeEach(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-tag-name-keys-test-'));
    directories = /** @type {any} */ ({
        root,
        characters: path.join(root, 'characters'),
        chats: path.join(root, 'chats'),
        groups: path.join(root, 'groups'),
        groupChats: path.join(root, 'groupChats'),
    });
    for (const dir of [directories.characters, directories.chats, directories.groups, directories.groupChats]) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

afterEach(() => {
    metadataDb.disposeMetadataStores();
    fs.rmSync(directories.root, { recursive: true, force: true });
});

/**
 * @param {string} avatar
 * @param {string[]} tags
 * @param {{ fromImport?: boolean }} [options] As for upsertCharacterFromWrite().
 */
async function writeCharacter(avatar, tags, options = {}) {
    const name = path.parse(avatar).name;
    const card = { name, spec: 'chara_card_v2', spec_version: '2.0', data: { name, tags, creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } };
    await metadataDb.upsertCharacterFromWrite(directories, avatar, JSON.stringify(card), null, null, options);
}

/**
 * Runs fn against a second connection to the store, as another thread's writes would arrive.
 * @template T
 * @param {(db: import('better-sqlite3').Database) => T} fn
 * @returns {T}
 */
function withRawDb(fn) {
    const db = new Database(path.join(directories.root, 'character-metadata.sqlite'));
    try {
        return fn(db);
    } finally {
        db.close();
    }
}

/** @returns {{ id: string, name: string, name_key: string | null }[]} */
function tagRows() {
    return withRawDb(db => Array.from(db.prepare('SELECT id, json_extract(data, \'$.name\') AS name, name_key FROM tags ORDER BY rowid').iterate()));
}

describe('tagNameKey()', () => {
    test('matches names the way upstream\'s getTag() does: ignoring case and accents', () => {
        expect(tagNameKey('Élan')).toBe(tagNameKey('elan'));
        expect(tagNameKey('ÉLAN')).toBe(tagNameKey('élan'));
        expect(tagNameKey('Fantasy')).toBe(tagNameKey('fantasy'));
        expect(tagNameKey('Straße')).not.toBe(tagNameKey('strasse'));
        expect(tagNameKey('Elan')).not.toBe(tagNameKey('Elan '));
    });
});

describe('name_key on every tags write', () => {
    test('saveTagDefinitions, createTagDefinition, editTagDefinition (a rename) and card tag creation set it', async () => {
        await metadataDb.saveTagDefinitions(directories, [{ id: 'a', name: 'Élan' }, { id: 'b' }]);
        await metadataDb.createTagDefinition(directories, { id: 'c', name: 'Noir' });
        await metadataDb.editTagDefinition(directories, 'a', { name: 'Renamed' });
        await writeCharacter('Bob.png', ['Brand New']);
        await metadataDb.seedCardTagsForSingleCharacter(directories, 'Bob.png');

        const keys = Object.fromEntries(tagRows().map(r => [r.name ?? r.id, r.name_key]));
        expect(keys).toEqual({ Renamed: 'renamed', b: '', Noir: 'noir', 'Brand New': 'brand new' });
    });
});

describe('resolving card tag names', () => {
    test('a name matches an existing tag ignoring case and accents', async () => {
        await metadataDb.saveTagDefinitions(directories, [{ id: 'elan', name: 'Élan' }]);
        await writeCharacter('Bob.png', ['elan']);

        const { tagIds } = await metadataDb.seedCardTagsForSingleCharacter(directories, 'Bob.png');

        expect(tagIds).toEqual(['elan']);
        expect(tagRows()).toHaveLength(1);
    });

    test('where names already collide, the first tag by rowid wins', async () => {
        await metadataDb.saveTagDefinitions(directories, [{ id: 'z-first', name: 'Dup' }, { id: 'a-second', name: 'dup' }]);
        await writeCharacter('Bob.png', ['DUP']);

        expect((await metadataDb.seedCardTagsForSingleCharacter(directories, 'Bob.png')).tagIds).toEqual(['z-first']);
    });

    test('a tag another connection created is found, not created again', async () => {
        await writeCharacter('Alice.png', ['Other']);
        await metadataDb.seedCardTagsForSingleCharacter(directories, 'Alice.png');
        withRawDb(db => db.prepare('INSERT INTO tags (id, data, name_key) VALUES (?, ?, ?)').run('worker-made', JSON.stringify({ id: 'worker-made', name: 'Beta' }), 'beta'));
        await writeCharacter('Bob.png', ['beta']);

        const { tagIds, tagDefinitions } = await metadataDb.seedCardTagsForSingleCharacter(directories, 'Bob.png');

        expect(tagIds).toEqual(['worker-made']);
        expect(tagDefinitions).toEqual([{ id: 'worker-made', name: 'Beta' }]);
        expect(tagRows().filter(r => r.name_key === 'beta')).toHaveLength(1);
    });

    test('only-existing mode never creates a tag', async () => {
        await writeCharacter('Bob.png', ['Nowhere']);
        const { tagIds } = await metadataDb.seedCardTagsForSingleCharacter(directories, 'Bob.png', { onlyExisting: true });
        expect(tagIds).toEqual([]);
        expect(tagRows()).toEqual([]);
    });
});
