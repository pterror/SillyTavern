import { describe, test, expect, jest, beforeAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import * as realSqliteEngine from '../src/endpoints/sqlite-engine.js';
import { groupDigestFavHash, groupDigestTagIdsHash, groupDigestContentHash } from '../public/scripts/hash-utils.js';

// Wraps whichever engine this install resolves to (native or wasm), recording every call's method and SQL.
/** @type {{ method: string, sql: string, params: any }[]} */
const calls = [];

async function getRecordingSqliteEngine() {
    const engine = await realSqliteEngine.getSqliteEngine();
    if (!engine) {
        return engine;
    }
    return {
        ...engine,
        openDatabase: (dbPath, options) => {
            const handle = engine.openDatabase(dbPath, options);
            for (const method of ['all', 'get', 'iterate', 'run']) {
                const real = handle[method];
                handle[method] = (sql, params) => {
                    calls.push({ method, sql, params });
                    return real(sql, params);
                };
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
/** @type {typeof import('../src/group-id.js')} */
let groupId;
/** @type {typeof import('better-sqlite3')} */
let Database;

/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    metadataDb = await import('../src/character-metadata-db.js');
    groupId = await import('../src/group-id.js');
    Database = (await import('better-sqlite3')).default;
});

beforeEach(() => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-query-entities-bounded-reads-test-'));
    directories = {
        root: tempDir,
        characters: path.join(tempDir, 'characters'),
        chats: path.join(tempDir, 'chats'),
        groups: path.join(tempDir, 'groups'),
        groupChats: path.join(tempDir, 'groupChats'),
    };
    for (const dir of [directories.characters, directories.chats, directories.groups, directories.groupChats]) {
        fs.mkdirSync(dir, { recursive: true });
    }
    calls.length = 0;
});

afterEach(() => {
    metadataDb.disposeMetadataStores();
    fs.rmSync(directories.root, { recursive: true, force: true });
});

/** @param {string} avatar */
async function seedCharacter(avatar) {
    const name = avatar.replace(/\.png$/, '');
    const cardJson = JSON.stringify({
        name,
        data: { name, tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } },
    });
    await metadataDb.upsertCharacterFromWrite(directories, avatar, cardJson);
}

/** A group's file and row. @param {string} id */
async function seedGroup(id) {
    const group = { id, name: `Group ${id}`, members: [], chats: [], fav: false };
    fs.writeFileSync(path.join(directories.groups, `${id}.json`), JSON.stringify(group));
    await metadataDb.upsertGroupRow(directories, id, group.name, { fav: false, group });
}

/** @param {string} sql @param {unknown[]} [params] */
function runSql(sql, params = []) {
    const db = new Database(path.join(directories.root, 'character-metadata.sqlite'));
    try {
        return db.prepare(sql).run(...params);
    } finally {
        db.close();
    }
}

/** @param {{ sql: string }} call */
const oneLine = (call) => call.sql.replace(/\s+/g, ' ').trim();

const GROUP_TAGS_READ = /^SELECT tag_id FROM group_tags WHERE group_id = @id ORDER BY tag_id$/;

/**
 * @param {{ method: string, sql: string, params: any }[]} recorded
 * @param {RegExp} pattern
 */
const methodsOf = (recorded, pattern) => recorded.filter(c => pattern.test(oneLine(c))).map(c => [c.method, c.params]);

describe('queryEntities() random page: reads bounded by the page or one group', () => {
    test('reads the page\'s characters, its groups and a NULL-digest group\'s tags with iterate(), never all(), with the same rows and hash rows', async () => {
        const SEED = 12345;
        const characterIds = ['Ann.png', 'Bea.png', 'Cal.png', 'Alice.png'];
        for (const id of characterIds) await seedCharacter(id);
        // Legacy data: a group row that shares a character's id. The group row wins the page slot.
        const groupIds = ['g1', 'g2', 'Alice.png'];
        for (const id of groupIds) await seedGroup(id);
        expect(await metadataDb.assignEntityTag(directories, 'g2', 't-zeta')).toBe('ok');
        expect(await metadataDb.assignEntityTag(directories, 'g2', 't-alpha')).toBe('ok');
        runSql('UPDATE groups SET digest_fav = NULL, digest_tag_ids = NULL, digest_content = NULL WHERE id = \'g2\'');

        const params = { sortField: 'random', sortOrder: /** @type {'asc'} */ ('asc'), seed: SEED, offset: 0, limit: 50, wantTotal: true, handle: path.basename(directories.root) };

        calls.length = 0;
        const hashResult = await metadataDb.queryEntities(directories, { ...params, wantRows: false, wantHashes: true });
        const hashCalls = calls.splice(0);
        const rowsResult = await metadataDb.queryEntities(directories, { ...params, wantRows: true, wantHashes: false });
        const rowsCalls = calls.splice(0);

        // Before the random ranks are filled the order runs over rowids: every read takes a bounded id or rowid list and
        // streams it, nothing reads a whole table.
        for (const call of [...hashCalls, ...rowsCalls]) {
            const sql = oneLine(call);
            if (!/\bFROM (characters|groups)\b/.test(sql) || /COUNT\(\*\)|MAX\(rowid\)/.test(sql)) continue;
            expect({ sql, method: call.method }).toEqual({ sql, method: 'iterate' });
            expect(sql).toMatch(/\b(rowid|id) IN \(SELECT value FROM json_each\(\?\)\)|@id/);
        }
        // g1's row never had digest_tag_ids written, so it falls back too; Alice.png's id isn't a group id, so its
        // fallback reads no tags.
        expect(methodsOf(hashCalls, GROUP_TAGS_READ).sort((a, b) => a[1].id.localeCompare(b[1].id))).toEqual([['iterate', { id: 'g1' }], ['iterate', { id: 'g2' }]]);
        expect(methodsOf(rowsCalls, GROUP_TAGS_READ)).toEqual([]);

        // Each row once, characters and groups typed by their own table (the shared id is one of each), and the same
        // order on both reads and on a repeat.
        const order = rowsResult.rows.map(r => `${r.type}:${r.id}`);
        expect([...order].sort()).toEqual([...characterIds.map(id => `character:${id}`), ...groupIds.map(id => `group:${id}`)].sort());
        expect(hashResult.hashRows.map(r => `${r.isGroup ? 'group' : 'character'}:${r.id}`)).toEqual(order);
        const again = await metadataDb.queryEntities(directories, { ...params, wantRows: true, wantHashes: false });
        expect(again.rows.map(r => `${r.type}:${r.id}`)).toEqual(order);
        const expectedEntities = rowsResult.rows.map(r => ({ type: r.type, id: r.id }));
        const expectedHashRows = (await metadataDb.getEntityRowsByIds(directories, expectedEntities, { wantRows: false, wantHashes: true })).hashRows;
        const expectedRows = (await metadataDb.getEntityRowsByIds(directories, expectedEntities, { wantRows: true, wantHashes: false })).rows;
        expect(hashResult.hashRows).toEqual(expectedHashRows);
        expect(rowsResult.rows).toEqual(expectedRows);

        // The NULL-digest groups' hashes come from their files and their group_tags rows.
        for (const [id, tagIds] of /** @type {[string, string[]][]} */ ([['g1', []], ['g2', ['t-alpha', 't-zeta']]])) {
            const file = groupId.normalizeGroupRecord(JSON.parse(fs.readFileSync(path.join(directories.groups, `${id}.json`), 'utf8')));
            const source = { ...file, tag_ids: tagIds };
            expect(hashResult.hashRows.find(r => r.id === id)).toMatchObject({
                isGroup: true,
                favHash: groupDigestFavHash(source) >>> 0,
                tagIdsHash: groupDigestTagIdsHash(source) >>> 0,
                contentHash: groupDigestContentHash(source) >>> 0,
            });
        }
    });
});
