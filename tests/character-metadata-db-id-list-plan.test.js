import { describe, test, expect, jest, beforeAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import * as realSqliteEngine from '../src/endpoints/sqlite-engine.js';

// Wraps whichever engine this install resolves to (native or wasm) instead of pinning one, since the two can plan
// the same SQL differently.
/** @type {{ sql: string, params: any, handle: import('../src/endpoints/sqlite-engine.js').SqliteEngineHandle }[]} */
const recorded = [];

async function getRecordingSqliteEngine() {
    const engine = await realSqliteEngine.getSqliteEngine();
    if (!engine) {
        return engine;
    }
    return {
        ...engine,
        openDatabase: (dbPath, options) => {
            const handle = engine.openDatabase(dbPath, options);
            for (const method of /** @type {const} */ (['get', 'all', 'iterate'])) {
                const real = handle[method];
                handle[method] = /** @type {any} */ ((sql, params) => {
                    recorded.push({ sql, params, handle });
                    return real(sql, params);
                });
            }
            return handle;
        },
    };
}

jest.unstable_mockModule('../src/endpoints/sqlite-engine.js', () => ({
    ...realSqliteEngine,
    getSqliteEngine: getRecordingSqliteEngine,
}));

/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;

/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    metadataDb = await import('../src/character-metadata-db.js');
});

beforeEach(() => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-character-metadata-db-id-list-plan-test-'));
    const charactersDir = path.join(tempDir, 'characters');
    const chatsDir = path.join(tempDir, 'chats');
    const groupsDir = path.join(tempDir, 'groups');
    const groupChatsDir = path.join(tempDir, 'groupChats');
    for (const dir of [charactersDir, chatsDir, groupsDir, groupChatsDir]) {
        fs.mkdirSync(dir, { recursive: true });
    }
    directories = /** @type {any} */ ({ root: tempDir, characters: charactersDir, chats: chatsDir, groups: groupsDir, groupChats: groupChatsDir });
});

afterEach(() => {
    metadataDb.disposeMetadataStores();
});

// A search's hits: a character id and a group id, as handleQuery() passes them to queryEntities().
const HIT_IDS = ['Hit.png', '1700000000000'];
const HIT_IDS_JSON = JSON.stringify(HIT_IDS);

// The filters that have an index of their own on characters or groups. Without statistics SQLite guessed each one
// narrows more than the hit list, and started from that index.
const FILTERS = [
    ['fav: false', { fav: false }],
    ['fav: true', { fav: true }],
    ['world', { world: 'Some Lorebook' }],
    ['fav: false and world', { fav: false, world: 'Some Lorebook' }],
];

/** @type {[string, (filter: object) => Promise<unknown>][]} */
const CALLS = [
    ['queryCharacters() total', filter => metadataDb.queryCharacters(directories, { ...filter, ids: HIT_IDS, wantRows: false, wantTotal: true })],
    ['queryCharacters() relevance page', filter => metadataDb.queryCharacters(directories, { ...filter, ids: HIT_IDS, idOrder: HIT_IDS, sortField: 'search', wantTotal: false })],
    ['queryCharacters() relevance page of hashes', filter => metadataDb.queryCharacters(directories, { ...filter, ids: HIT_IDS, idOrder: HIT_IDS, sortField: 'search', wantRows: false, wantHashes: true, wantTotal: false })],
    ['queryCharacters() name-sorted page', filter => metadataDb.queryCharacters(directories, { ...filter, ids: HIT_IDS, sortField: 'name', wantTotal: false })],
    ['queryCharacters() name-sorted page of hashes', filter => metadataDb.queryCharacters(directories, { ...filter, ids: HIT_IDS, sortField: 'name', wantRows: false, wantHashes: true, wantTotal: false })],
    ['queryCharacters() random page', filter => metadataDb.queryCharacters(directories, { ...filter, ids: HIT_IDS, sortField: 'random', seed: 7, wantTotal: false })],
    ['queryEntities() total', filter => metadataDb.queryEntities(directories, { ...filter, ids: HIT_IDS, wantRows: false, wantTotal: true })],
    ['queryEntities() relevance page (id order)', filter => metadataDb.queryEntities(directories, { ...filter, ids: HIT_IDS, offset: 0, limit: HIT_IDS.length, wantTotal: false })],
    ['queryEntities() relevance page of hashes (id order)', filter => metadataDb.queryEntities(directories, { ...filter, ids: HIT_IDS, offset: 0, limit: HIT_IDS.length, wantRows: false, wantHashes: true, wantTotal: false })],
    ['queryEntities() date-sorted page', filter => metadataDb.queryEntities(directories, { ...filter, ids: HIT_IDS, sortField: 'date_added', sortOrder: 'desc', wantTotal: false })],
    ['queryEntities() random page', filter => metadataDb.queryEntities(directories, { ...filter, ids: HIT_IDS, sortField: 'random', seed: 7, handle: 'test', wantTotal: false })],
];

const CASES = CALLS.flatMap(([callName, call]) => FILTERS.map(([filterName, filter]) => /** @type {const} */ ([`${callName}, ${filterName}`, call, filter])));

/**
 * Every plan line that reads the characters or groups table itself (not character_tags / group_tags).
 * @param {string[]} details
 */
function tableReads(details) {
    return details.filter(detail => /\b(characters|groups)\b/.test(detail));
}

describe('a query narrowed to a hit list starts from the hits and looks each one up by id', () => {
    test.each(CASES)('%s', async (_name, call, filter) => {
        await metadataDb.ensureSchemaMigrated(directories);
        recorded.length = 0;

        await call(filter);

        // The statements that take the hit list; the rest (the change-log seq, the random order's own id list) don't.
        const narrowed = recorded.filter(r => Array.isArray(r.params) && r.params.includes(HIT_IDS_JSON));
        expect(narrowed.length).toBeGreaterThan(0);
        for (const { sql, params, handle } of narrowed) {
            const details = handle.all(`EXPLAIN QUERY PLAN ${sql}`, params).map(row => /** @type {{ detail: string }} */ (row).detail);
            const reads = tableReads(details);
            expect({ sql, reads }).toEqual({ sql, reads: expect.arrayContaining([expect.any(String)]) });
            for (const read of reads) {
                expect({ sql, read }).toEqual({ sql, read: expect.stringMatching(/^SEARCH (characters|groups) USING (COVERING )?INDEX sqlite_autoindex_(characters|groups)_1 \(id=\?\)$/) });
            }
            expect({ sql, sorted: details.includes('USE TEMP B-TREE FOR GROUP BY'), inSearchOrder: details.includes('USE TEMP B-TREE FOR DISTINCT') })
                .toEqual({ sql, sorted: true, inSearchOrder: false });
        }
    });
});

describe('a query narrowed to a hit list reads the rows in id order and search order is put back in JS', () => {
    test('queryCharacters() relevance page keeps idOrder, whatever order the ids sort in', async () => {
        for (const avatar of ['A.png', 'B.png', 'C.png']) {
            await seedCharacter(avatar);
        }
        const idOrder = ['C.png', 'A.png', 'B.png'];

        const result = await metadataDb.queryCharacters(directories, { ids: idOrder, idOrder, fav: false, sortField: 'search' });
        expect(result?.rows?.map(r => /** @type {any} */ (r).avatar)).toEqual(idOrder);

        const hashes = await metadataDb.queryCharacters(directories, { ids: idOrder, idOrder, fav: false, sortField: 'search', wantRows: false, wantHashes: true });
        expect(hashes?.hashRows?.map(r => r.id)).toEqual(idOrder);
    });
});

/**
 * @param {string} avatar
 * @param {{ fav?: boolean, world?: string }} [options]
 */
async function seedCharacter(avatar, { fav = false, world = '' } = {}) {
    const name = avatar.replace(/\.png$/, '');
    const data = {
        name, description: '', personality: '', scenario: '', first_mes: '', mes_example: '',
        tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav, world },
    };
    const card = { name, fav, description: '', personality: '', scenario: '', first_mes: '', mes_example: '', tags: [], spec: 'chara_card_v2', spec_version: '2.0', data };
    await metadataDb.upsertCharacterFromWrite(directories, avatar, JSON.stringify(card));
}

describe('a query narrowed to a hit list returns what the hit list names, once each', () => {
    test('a repeated id is counted and returned once, by queryCharacters() and queryEntities()', async () => {
        await seedCharacter('A.png');
        await seedCharacter('B.png');
        await metadataDb.upsertGroupRow(directories, '1700000000001', 'G', { fav: false });
        const ids = ['A.png', 'A.png', '1700000000001', '1700000000001', 'A.png'];

        const characters = await metadataDb.queryCharacters(directories, { ids, fav: false, sortField: 'name' });
        expect(characters?.total).toBe(1);
        expect(characters?.rows?.map(r => /** @type {any} */ (r).avatar)).toEqual(['A.png']);

        const entities = await metadataDb.queryEntities(directories, { ids, fav: false, sortField: 'name' });
        expect(entities?.total).toBe(2);
        expect(entities?.rows?.map(r => r.id).sort()).toEqual(['1700000000001', 'A.png']);
    });

    test('queryEntities() random order with only a hit list keeps to the hits', async () => {
        await seedCharacter('A.png');
        await seedCharacter('B.png');
        await seedCharacter('C.png');
        await metadataDb.upsertGroupRow(directories, '1700000000001', 'G1', { fav: false });
        await metadataDb.upsertGroupRow(directories, '1700000000002', 'G2', { fav: false });

        const result = await metadataDb.queryEntities(directories, { ids: ['B.png', '1700000000002'], sortField: 'random', seed: 3, handle: 'test' });
        expect(result?.total).toBe(2);
        expect(result?.rows?.map(r => r.id).sort()).toEqual(['1700000000002', 'B.png']);
    });

    test('queryEntities() random order without a handle throws', async () => {
        await seedCharacter('A.png');
        await metadataDb.upsertGroupRow(directories, '1700000000001', 'G1', { fav: false });

        await expect(metadataDb.queryEntities(directories, { sortField: 'random', seed: 3 })).rejects.toThrow(/handle/);
        await expect(metadataDb.queryEntities(directories, { sortField: 'random', seed: 3, wantRows: false, wantHashes: true })).rejects.toThrow(/handle/);
        await expect(metadataDb.queryEntities(directories, { sortField: 'random', seed: 3, handle: '' })).rejects.toThrow(/handle/);
        await expect(metadataDb.queryEntities(directories, { sortField: 'random', seed: 3, handle: '', wantRows: false, wantHashes: true })).rejects.toThrow(/handle/);
    });

    test('the other filters still apply to the hits', async () => {
        await seedCharacter('Fav.png', { fav: true });
        await seedCharacter('Plain.png');
        await seedCharacter('Linked.png', { world: 'Some Lorebook' });
        await metadataDb.upsertGroupRow(directories, '1700000000001', 'FavGroup', { fav: true });
        await metadataDb.upsertGroupRow(directories, '1700000000002', 'PlainGroup', { fav: false });
        const ids = ['Fav.png', 'Plain.png', 'Linked.png', '1700000000001', '1700000000002', 'Missing.png'];

        const notFav = await metadataDb.queryEntities(directories, { ids, fav: false, sortField: 'name' });
        expect(notFav?.total).toBe(3);
        expect(notFav?.rows?.map(r => r.id)).toEqual(['Linked.png', 'Plain.png', '1700000000002']);

        const linked = await metadataDb.queryCharacters(directories, { ids, world: 'Some Lorebook', sortField: 'name' });
        expect(linked?.total).toBe(1);
        expect(linked?.rows?.map(r => /** @type {any} */ (r).avatar)).toEqual(['Linked.png']);
    });
});

const INCLUDED_TAGS = [
    ['one included tag, "and"', { include: ['tag1'], mode: 'and' }],
    ['one included tag, "or"', { include: ['tag1'], mode: 'or' }],
    ['three included tags, "and"', { include: ['tag1', 'tag2', 'tag3'], mode: 'and' }],
    ['three included tags, "or"', { include: ['tag1', 'tag2', 'tag3'], mode: 'or' }],
];

const TAG_CASES = CALLS.flatMap(([callName, call]) => INCLUDED_TAGS.map(([tagsName, tags]) => /** @type {const} */ ([`${callName}, ${tagsName}`, call, { tags }])));

describe('a query narrowed to a hit list checks each hit\'s included tags by its own primary key', () => {
    test.each(TAG_CASES)('%s', async (_name, call, filter) => {
        await metadataDb.ensureSchemaMigrated(directories);
        recorded.length = 0;

        await call(filter);

        const narrowed = recorded.filter(r => Array.isArray(r.params) && r.params.includes(HIT_IDS_JSON));
        expect(narrowed.length).toBeGreaterThan(0);
        for (const { sql, params, handle } of narrowed) {
            const details = handle.all(`EXPLAIN QUERY PLAN ${sql}`, params).map(row => /** @type {{ detail: string }} */ (row).detail);
            // Newer SQLite (the wasm build) plans the EXISTS as a semi-join: `SEARCH character_tags EXISTS USING ...`.
            const tagReads = details.filter(detail => /\b(character_tags|group_tags)\b/.test(detail));
            expect({ sql, tagReads }).toEqual({ sql, tagReads: expect.arrayContaining([expect.any(String)]) });
            for (const read of tagReads) {
                expect({ sql, read }).toEqual({ sql, read: expect.stringMatching(/^SEARCH (character_tags( EXISTS)? USING (COVERING )?INDEX sqlite_autoindex_character_tags_1 \(character_id=\? AND tag_id=\?\)|group_tags( EXISTS)? USING (COVERING )?INDEX sqlite_autoindex_group_tags_1 \(group_id=\? AND tag_id=\?\))$/) });
            }
        }
    });
});

describe('a query narrowed to a hit list keeps the included-tag results it had', () => {
    // A: tag1+tag2, B: tag1, C: none, D: tag2; G1: tag1+tag2, G2: tag1. Missing ones are in the list but not the db.
    const IDS = ['A.png', 'B.png', 'C.png', 'D.png', 'Missing.png', '1700000000001', '1700000000002', '1700000000009'];
    const INPUTS = [
        ['one tag, "and"', { include: ['tag1'], mode: 'and' }, ['A.png', 'B.png'], ['1700000000001', '1700000000002']],
        ['one tag, "or"', { include: ['tag1'], mode: 'or' }, ['A.png', 'B.png'], ['1700000000001', '1700000000002']],
        ['two tags, "and"', { include: ['tag1', 'tag2'], mode: 'and' }, ['A.png'], ['1700000000001']],
        ['two tags, "or"', { include: ['tag1', 'tag2'], mode: 'or' }, ['A.png', 'B.png', 'D.png'], ['1700000000001', '1700000000002']],
        ['a repeated tag, "and"', { include: ['tag1', 'tag1'], mode: 'and' }, [], []],
        ['a repeated tag, "or"', { include: ['tag1', 'tag1'], mode: 'or' }, ['A.png', 'B.png'], ['1700000000001', '1700000000002']],
        ['an empty string beside a tag', { include: ['', 'tag2', ''], mode: 'and' }, ['A.png', 'D.png'], ['1700000000001']],
        ['only empty strings', { include: ['', ''], mode: 'and' }, ['A.png', 'B.png', 'C.png', 'D.png'], ['1700000000001', '1700000000002']],
        ['a tag nobody has', { include: ['tag9'], mode: 'or' }, [], []],
        ['no mode given', { include: ['tag1', 'tag2'] }, ['A.png'], ['1700000000001']],
    ];

    test.each(INPUTS)('%s', async (_name, tags, characters, groups) => {
        for (const avatar of ['A.png', 'B.png', 'C.png', 'D.png']) {
            await seedCharacter(avatar);
        }
        await metadataDb.upsertGroupRow(directories, '1700000000001', 'G1', { fav: false });
        await metadataDb.upsertGroupRow(directories, '1700000000002', 'G2', { fav: false });
        for (const [id, tagId] of [['A.png', 'tag1'], ['A.png', 'tag2'], ['B.png', 'tag1'], ['D.png', 'tag2'], ['1700000000001', 'tag1'], ['1700000000001', 'tag2'], ['1700000000002', 'tag1']]) {
            expect(await metadataDb.assignEntityTag(directories, id, tagId)).toBe('ok');
        }

        const characterResult = await metadataDb.queryCharacters(directories, { ids: IDS, tags, sortField: 'name' });
        expect(characterResult?.total).toBe(characters.length);
        expect(characterResult?.rows?.map(r => /** @type {any} */ (r).avatar)).toEqual(characters);

        const entityResult = await metadataDb.queryEntities(directories, { ids: IDS, tags, sortField: 'name' });
        expect(entityResult?.total).toBe(characters.length + groups.length);
        expect(entityResult?.rows?.map(r => r.id)).toEqual([...characters, ...groups]);
    });
});
