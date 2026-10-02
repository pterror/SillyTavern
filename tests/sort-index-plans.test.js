import { describe, test, expect, jest, beforeAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import * as realSqliteEngine from '../src/endpoints/sqlite-engine.js';

/** @type {{ sql: string, params: any, handle: import('../src/endpoints/sqlite-engine.js').SqliteEngineHandle }[]} */
const recorded = [];

async function getRecordingSqliteEngine() {
    const engine = await realSqliteEngine.getSqliteEngine();
    if (!engine) return engine;
    return {
        ...engine,
        openDatabase: (dbPath, options) => {
            const handle = engine.openDatabase(dbPath, options);
            for (const method of /** @type {const} */ (['get', 'all', 'iterate', 'readBounded'])) {
                const real = /** @type {any} */ (handle[method]);
                handle[method] = /** @type {any} */ ((sql, params, ...rest) => {
                    recorded.push({ sql, params, handle });
                    return real(sql, params, ...rest);
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
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-sort-index-plans-test-'));
    directories = /** @type {any} */ ({
        root: tempDir,
        characters: path.join(tempDir, 'characters'),
        chats: path.join(tempDir, 'chats'),
        groups: path.join(tempDir, 'groups'),
        groupChats: path.join(tempDir, 'groupChats'),
    });
    for (const dir of [directories.characters, directories.chats, directories.groups, directories.groupChats]) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

afterEach(() => {
    metadataDb.disposeMetadataStores();
    fs.rmSync(directories.root, { recursive: true, force: true });
});

async function seed() {
    for (let i = 0; i < 6; i++) {
        const name = `Char ${i % 3}`;
        const cardJson = JSON.stringify({ name, data: { name, tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: i % 2 === 0, world: '' } } });
        await metadataDb.upsertCharacterFromWrite(directories, `c${i}.png`, cardJson);
    }
    for (let i = 0; i < 3; i++) {
        const group = { id: `g${i}`, name: `Group ${i}`, members: [], chats: [], fav: i === 0 };
        fs.writeFileSync(path.join(directories.groups, `g${i}.json`), JSON.stringify(group));
        await metadataDb.upsertGroupRow(directories, `g${i}`, group.name, { fav: group.fav, group });
    }
    await metadataDb.buildEntitySortIndexesIfNeeded(directories);
}

/** @param {{ sql: string, params: any, handle: any }} call */
function planOf({ sql, params, handle }) {
    return Array.from(handle.iterate(`EXPLAIN QUERY PLAN ${sql}`, params), row => /** @type {{ detail: string }} */ (row).detail);
}

describe('the sort indexes are the only indexes on a sort key', () => {
    test('characters and groups have one (fav, key, tie) index per sort key and no other index on one', async () => {
        await seed();
        recorded.length = 0;
        await metadataDb.queryEntities(directories, { sortField: 'name', sortOrder: 'asc', offset: 0, limit: 1, wantTotal: false });
        const { handle } = recorded[0];
        const indexes = Array.from(handle.iterate('SELECT name, tbl_name, sql FROM sqlite_master WHERE type = \'index\' AND tbl_name IN (\'characters\', \'groups\') AND sql IS NOT NULL ORDER BY name'), row => /** @type {{ name: string }} */ (row).name);
        expect(indexes).toEqual([
            'idx_characters_avatar_identity_hash',
            'idx_characters_content_hash',
            'idx_characters_content_identity_hash',
            ...['chat_size', 'create_date', 'data_size', 'date_added', 'date_last_chat', 'name_fold'].map(key => `idx_characters_sort_fav_${key}_asc`),
            'idx_characters_world',
            ...['chat_size', 'date_added', 'date_last_chat'].map(key => `idx_groups_sort_fav_${key}_asc`),
            'idx_groups_sort_fav_key',
            'idx_groups_sort_fav_name_fold_asc',
        ].sort());
    });

    test('the tag sort tables have one index per sort key, the entity index, and a tie-order index where a sort has no key', async () => {
        await seed();
        recorded.length = 0;
        await metadataDb.queryEntities(directories, { sortField: 'name', sortOrder: 'asc', offset: 0, limit: 1, wantTotal: false });
        const { handle } = recorded[0];
        const indexes = Array.from(handle.iterate('SELECT name FROM sqlite_master WHERE type = \'index\' AND tbl_name IN (\'character_tag_sort\', \'group_tag_sort\') AND sql IS NOT NULL ORDER BY name'), row => /** @type {{ name: string }} */ (row).name);
        expect(indexes).toEqual([
            ...['chat_size', 'create_date', 'data_size', 'date_added', 'date_last_chat', 'name_fold'].map(key => `idx_character_tag_sort_${key}_asc`),
            'idx_character_tag_sort_entity',
            ...['chat_size', 'date_added', 'date_last_chat'].map(key => `idx_group_tag_sort_${key}_asc`),
            'idx_group_tag_sort_entity', 'idx_group_tag_sort_key', 'idx_group_tag_sort_name_fold_asc',
        ].sort());
    });

    const RANGE_FIELDS = ['create_date', 'date_last_chat', 'chat_size', 'data_size'];

    test.each(RANGE_FIELDS)('a %s range, counted and paged, reads the fav-first sort index for it', async (field) => {
        await seed();
        recorded.length = 0;
        for (const sortField of ['name', undefined]) {
            await metadataDb.queryEntities(directories, { ranges: { [field]: { min: 1, max: 2 ** 40 } }, sortField, sortOrder: 'asc', offset: 0, limit: 2, wantTotal: true });
            await metadataDb.queryCharacters(directories, { ranges: { [field]: { min: 1, max: 2 ** 40 } }, sortField, sortOrder: 'asc', offset: 0, limit: 2, wantTotal: true });
        }
        // A group has no data_size, so its side of that range is the constant-false `AND 0` and reads nothing.
        const ranged = recorded.filter(call => new RegExp(`\\b(${field}|date_added) [<>]= \\?`).test(call.sql) && !/json_each|\bAND 0\b/.test(call.sql));
        expect(ranged.length).toBeGreaterThan(0);
        for (const call of ranged) {
            const plan = planOf(call);
            const tableReads = plan.filter(detail => /\b(SCAN|SEARCH) (characters|groups)\b/.test(detail));
            expect({ sql: call.sql, tableReads }).toEqual({ sql: call.sql, tableReads: tableReads.map(() => expect.stringMatching(/^SEARCH (characters|groups) USING (COVERING )?INDEX idx_(characters|groups)_sort_fav_\w+ \(fav=\?/)) });
        }
    });

    test.each([
        ['every entity', {}],
        ['a tag', { tags: { include: ['t1'], mode: 'and' } }],
    ])('a descending page of %s reads the ascending sort index backwards, with no sort of its own', async (_name, filter) => {
        await seed();
        for (const id of ['c0.png', 'c1.png', 'c3.png']) await metadataDb.assignEntityTag(directories, id, 't1');
        await metadataDb.assignEntityTag(directories, 'g1', 't1');
        await metadataDb.fillTagSortTablesIfNeeded(directories);
        for (const sortField of ['name', 'date_added', 'date_last_chat', 'chat_size', 'create_date', 'data_size']) {
            recorded.length = 0;
            const first = await metadataDb.queryEntities(directories, { ...filter, sortField, sortOrder: 'desc', offset: 0, limit: 1, wantTotal: false });
            await metadataDb.queryEntities(directories, { ...filter, sortField, sortOrder: 'desc', offset: 0, limit: 1, wantTotal: false, cursor: first.cursor });
            const streamReads = recorded.filter(call => /\bAS k\b/.test(call.sql));
            expect(streamReads.length).toBeGreaterThan(0);
            for (const call of streamReads) {
                const plan = planOf(call);
                expect({ sortField, sql: call.sql, plan }).toEqual({
                    sortField, sql: call.sql,
                    plan: [expect.stringMatching(/^SEARCH (characters|groups|s) USING (COVERING )?INDEX idx_\w+_(asc|key) \(/)],
                });
            }
        }
    });

    test('find by name reads the fav-first name index, for characters and for groups', async () => {
        await seed();
        recorded.length = 0;
        expect((await metadataDb.findCharacterMatches(directories, { name: 'char 1' })).ids).toEqual(['c1.png', 'c4.png']);
        expect(await metadataDb.findGroupMatches(directories, 'GROUP 2')).toEqual(['g2']);
        const lookups = recorded.filter(call => /\bname_fold = \?/.test(call.sql));
        expect(lookups.map(call => planOf(call).filter(detail => /\b(SCAN|SEARCH) (characters|groups)\b/.test(detail)))).toEqual([
            [expect.stringMatching(/^SEARCH characters USING (COVERING )?INDEX idx_characters_sort_fav_name_fold_\w+ \(fav=\? AND name_fold=\?\)/)],
            [expect.stringMatching(/^SEARCH groups USING (COVERING )?INDEX idx_groups_sort_fav_name_fold_\w+ \(fav=\? AND name_fold=\?\)/)],
        ]);
    });
});
