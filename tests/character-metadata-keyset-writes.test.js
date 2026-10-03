import { describe, test, expect, jest, beforeAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import * as realSqliteEngine from '../src/endpoints/sqlite-engine.js';

// Wraps whichever engine this install resolves to (native or wasm), recording every call's method, SQL and arguments.
/** @type {{ method: string, sql: string, args: any[] }[]} */
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
            for (const method of ['all', 'get', 'iterate', 'run', 'readBounded']) {
                const real = handle[method];
                handle[method] = (sql, ...args) => {
                    calls.push({ method, sql, args });
                    return real(sql, ...args);
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
/** @type {typeof import('better-sqlite3')} */
let Database;
/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

beforeAll(async () => {
    const util = await import('../src/util.js');
    util.setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    metadataDb = await import('../src/character-metadata-db.js');
    Database = (await import('better-sqlite3')).default;
});

beforeEach(() => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-cmdb-keyset-writes-test-'));
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
    calls.length = 0;
});

afterEach(() => {
    jest.restoreAllMocks();
    metadataDb.disposeMetadataStores();
    fs.rmSync(directories.root, { recursive: true, force: true });
});

/** @template T @param {(db: import('better-sqlite3').Database) => T} fn @returns {T} */
function withRawDb(fn) {
    const db = new Database(path.join(directories.root, 'character-metadata.sqlite'));
    try {
        return fn(db);
    } finally {
        db.close();
    }
}

/** @param {{ sql: string }} call */
const oneLine = (call) => call.sql.replace(/\s+/g, ' ').trim();

describe('saveTagDefinitions looks up old names only for the ids it saves, in bounded chunks', () => {
    test('2002 tags, then 2000 of them (every tenth renamed), the marked one renamed and one new: three bounded lookups, one rename row per renamed saved id', async () => {
        const ids = Array.from({ length: 2002 }, (_, i) => `tag-${String(i).padStart(5, '0')}`);
        expect(await metadataDb.saveTagDefinitions(directories, ids.map(id => ({ id, name: `name-${id}` })))).toBe('ok');

        const markedId = ids[2000];
        const leftOutId = ids[2001];
        const keptIds = ids.slice(0, 2000);
        await metadataDb.deleteTagDefinition(directories, markedId, null);

        calls.length = 0;
        const seqBefore = withRawDb(db => db.prepare('SELECT COALESCE(MAX(seq), 0) FROM tag_name_changes').pluck().get());
        const versionBefore = withRawDb(db => db.prepare('SELECT COALESCE(MAX(version), 0) FROM group_changes').pluck().get());

        const renamedIds = keptIds.filter((_, i) => i % 10 === 0);
        const renamed = new Set(renamedIds);
        const newTag = { id: 'tag-new', name: 'name-tag-new' };
        const keptTags = keptIds.map(id => ({ id, name: renamed.has(id) ? `renamed-${id}` : `name-${id}` }));
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        expect(await metadataDb.saveTagDefinitions(directories, [...keptTags, { id: markedId, name: `renamed-${markedId}` }, newTag])).toBe('ok');
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(markedId));

        const lookupSql = 'SELECT id, data FROM tags WHERE id IN (SELECT value FROM json_each(?))';
        const lookups = calls.filter(c => oneLine(c) === lookupSql);
        expect(lookups.map(c => c.method)).toEqual(['readBounded', 'readBounded', 'readBounded']);
        expect(lookups.map(c => c.args[1])).toEqual([1000, 1000, 1]);
        expect(lookups.map(c => JSON.parse(c.args[0][0]))).toEqual([keptIds.slice(0, 1000), keptIds.slice(1000, 2000), [newTag.id]]);
        expect(calls.filter(c => c.method === 'all' && oneLine(c) === 'SELECT id, data FROM tags')).toEqual([]);

        withRawDb(db => {
            const nameChanges = Array.from(db.prepare('SELECT tag_id FROM tag_name_changes WHERE seq > ? ORDER BY seq').pluck().iterate(seqBefore));
            expect(nameChanges).toEqual(renamedIds);
            expect(renamedIds).toHaveLength(200);
            expect(nameChanges).not.toContain(markedId);
            expect(nameChanges).not.toContain(newTag.id);
            expect(nameChanges).not.toContain(leftOutId);

            const groupChanges = Array.from(db.prepare('SELECT group_id FROM group_changes WHERE version > ? ORDER BY version').pluck().iterate(versionBefore));
            expect(groupChanges).toEqual([]);

            const stored = Array.from(db.prepare('SELECT id, data FROM tags ORDER BY id').iterate(), r => ({ id: r.id, name: JSON.parse(r.data).name }));
            expect(stored).toEqual([...keptTags, newTag].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
        });
    });
});

