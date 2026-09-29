import { describe, test, expect, jest, beforeAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Buffer } from 'node:buffer';

import * as realSqliteEngine from '../src/endpoints/sqlite-engine.js';
import { groupDigestTagIdsHash } from '../public/scripts/hash-utils.js';

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
/** @type {typeof import('../src/util.js').parseCreateDateToEpochMs} */
let parseCreateDateToEpochMs;
/** @type {typeof import('better-sqlite3')} */
let Database;
/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

beforeAll(async () => {
    const util = await import('../src/util.js');
    util.setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    parseCreateDateToEpochMs = util.parseCreateDateToEpochMs;

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

describe('migrateCreateDateColumn reads the rows to convert in keyset chunks', () => {
    test('2001 parseable, one unparseable and one NULL create_date: three bounded chunk reads, every row converted', async () => {
        /** @type {Map<string, string | null>} */
        const seeded = new Map();
        for (let i = 0; i < 2001; i++) {
            const id = `char-${String(i).padStart(5, '0')}.png`;
            // Every other row uses the ST "humanized" format, the rest ISO 8601.
            seeded.set(id, i % 2 === 0
                ? new Date(Date.UTC(2024, 0, 1) + i * 1000).toISOString()
                : `2024-6-5 @14h ${Math.floor(i / 60) % 60}m ${i % 60}s 682ms`);
        }
        seeded.set('char-01000-garbage.png', 'not a date at all');
        seeded.set('char-01500-missing.png', null);

        // The table as it was before create_date became INTEGER.
        withRawDb(db => {
            db.exec(`
                CREATE TABLE characters (
                    id             TEXT PRIMARY KEY,
                    name           TEXT NOT NULL,
                    name_fold      TEXT NOT NULL,
                    fav            INTEGER NOT NULL,
                    date_added     INTEGER NOT NULL,
                    create_date    TEXT,
                    date_last_chat INTEGER NOT NULL,
                    chat_size      INTEGER NOT NULL,
                    data_size      INTEGER NOT NULL,
                    file_mtime     INTEGER NOT NULL,
                    world          TEXT,
                    creator        TEXT,
                    version        TEXT,
                    creator_notes  TEXT,
                    shallow_json   TEXT NOT NULL,
                    change_seq     INTEGER NOT NULL
                );
                CREATE INDEX idx_characters_create_date ON characters(create_date);
            `);
            const insert = db.prepare(`
                INSERT INTO characters (id, name, name_fold, fav, date_added, create_date, date_last_chat, chat_size, data_size, file_mtime, world, creator, version, creator_notes, shallow_json, change_seq)
                VALUES (@id, @id, @id, 0, 500, @createDate, 0, 0, 0, 500, NULL, NULL, NULL, NULL, '{}', 1)
            `);
            db.transaction(() => {
                for (const [id, createDate] of seeded) insert.run({ id, createDate });
            })();
        });

        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

        // Any exported call opens the store, which runs migrateCreateDateColumn().
        await metadataDb.getCharacterMetadataRow(directories, 'char-00000.png');

        const chunkSql = 'SELECT id, create_date FROM characters WHERE create_date IS NOT NULL AND id > ? ORDER BY id LIMIT ?';
        const chunkReads = calls.filter(c => oneLine(c) === chunkSql);
        expect(chunkReads.map(c => c.method)).toEqual(['readBounded', 'readBounded', 'readBounded']);
        for (const read of chunkReads) {
            expect(read.args[1]).toBe(1000);
            expect(read.args[0][1]).toBe(1000);
        }
        expect(calls.filter(c => c.method === 'all' && /\bcreate_date\b/.test(c.sql))).toEqual([]);

        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('1 of 2002 row(s)'));
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('not a date at all'));

        withRawDb(db => {
            const column = Array.from(db.prepare('PRAGMA table_info(characters)').iterate()).find(c => c.name === 'create_date');
            expect(column.type).toBe('INTEGER');

            const migrated = new Map(Array.from(db.prepare('SELECT id, create_date FROM characters').iterate(), r => [r.id, r.create_date]));
            expect(migrated.size).toBe(seeded.size);
            const expected = new Map(Array.from(seeded, ([id, createDate]) => [id, createDate === null ? null : parseCreateDateToEpochMs(createDate)]));
            expect(Array.from(expected.values()).filter(v => v !== null)).toHaveLength(2001);
            expect(migrated).toEqual(expected);
            expect(migrated.get('char-01000-garbage.png')).toBeNull();
            expect(migrated.get('char-01500-missing.png')).toBeNull();
            expect(migrated.get('char-00000.png')).toBe(Date.UTC(2024, 0, 1));
        });
    });
});

describe('migrateGroupsColumns reads the group ids to backfill in keyset chunks', () => {
    test('2001 groups in a pre-columns table: three bounded chunk reads, every row backfilled from its file and queued', async () => {
        /** @type {string[]} */
        const ids = [];
        for (let i = 0; i < 2001; i++) {
            const id = `group-${String(i).padStart(5, '0')}`;
            ids.push(id);
            fs.writeFileSync(path.join(directories.groups, `${id}.json`), JSON.stringify({ id, name: `Group ${i}`, fav: i % 3 === 0, members: [], chats: [] }));
        }

        // The id/name-only table an install that already ran bootstrapGroupsIfNeeded() has.
        withRawDb(db => {
            // The digest columns are already there so migrateGroupDigestColumns() returns early and only this migration reads the ids.
            db.exec('CREATE TABLE groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, digest_fav INTEGER, digest_tag_ids INTEGER, digest_content INTEGER);');
            db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT); INSERT INTO meta (key, value) VALUES (\'groups_bootstrap_completed\', \'1\');');
            const insert = db.prepare('INSERT INTO groups (id, name) VALUES (@id, \'old\')');
            db.transaction(() => {
                for (const id of ids) insert.run({ id });
            })();
        });

        // bootstrapGroupsIfNeeded() is a no-op (its meta flag is set); getGroupTagIds() opens the store, which runs migrateGroupsColumns().
        await metadataDb.bootstrapGroupsIfNeeded(directories);
        expect(await metadataDb.getGroupTagIds(directories, 'group-00000')).toEqual([]);

        const chunkSql = 'SELECT id FROM groups WHERE id > ? ORDER BY id LIMIT ?';
        const chunkReads = calls.filter(c => oneLine(c) === chunkSql);
        expect(chunkReads.map(c => c.method)).toEqual(['readBounded', 'readBounded', 'readBounded']);
        for (const read of chunkReads) {
            expect(read.args[1]).toBe(1000);
            expect(read.args[0][1]).toBe(1000);
        }
        expect(calls.filter(c => c.method === 'all' && oneLine(c) === 'SELECT id FROM groups')).toEqual([]);

        withRawDb(db => {
            const rows = new Map(Array.from(db.prepare('SELECT id, name, name_fold, fav, date_added FROM groups').iterate(), r => [r.id, r]));
            expect(rows.size).toBe(2001);
            ids.forEach((id, i) => {
                const birthtimeMs = Math.round(fs.statSync(path.join(directories.groups, `${id}.json`)).birthtimeMs);
                expect(rows.get(id)).toEqual({ id, name: `Group ${i}`, name_fold: `group ${i}`, fav: i % 3 === 0 ? 1 : 0, date_added: birthtimeMs });
            });
            expect(Array.from(rows.values()).filter(r => r.fav === 1)).toHaveLength(667);

            const queued = Array.from(db.prepare('SELECT kind, id FROM chat_stats_pending ORDER BY id').iterate());
            expect(queued).toEqual(ids.map(id => ({ kind: 'group', id })));
        });
    });
});

describe('migrateGroupDigestColumns reads the group ids to backfill in keyset chunks', () => {
    test('2001 groups missing the digest columns: three bounded chunk reads, every digest backfilled to the values a write produces', async () => {
        expect(await metadataDb.saveTagDefinitions(directories, [{ id: 'x', name: 'name-x' }, { id: 'y', name: 'name-y' }])).toBe('ok');
        /** @type {string[]} */
        const ids = [];
        /** @type {Set<string>} */
        const tagged = new Set();
        /** @type {string[]} */
        const assignResults = [];
        for (let i = 0; i < 2001; i++) {
            const id = `group-${String(i).padStart(5, '0')}`;
            ids.push(id);
            const group = { id, name: id, members: [], chats: [], fav: i % 3 === 0 };
            fs.writeFileSync(path.join(directories.groups, `${id}.json`), JSON.stringify(group));
            await metadataDb.upsertGroupRow(directories, id, id, { fav: group.fav, group });
            if (i % 5 === 0) assignResults.push(await metadataDb.assignEntityTag(directories, id, 'x'));
            if (i % 7 === 0) assignResults.push(await metadataDb.assignEntityTag(directories, id, 'y'));
            if (i % 5 === 0 || i % 7 === 0) tagged.add(id);
        }
        expect(assignResults.filter(r => r !== 'ok')).toEqual([]);
        expect(assignResults).toHaveLength(401 + 286);
        metadataDb.disposeMetadataStores();

        const readDigests = () => withRawDb(db => Array.from(db.prepare('SELECT id, digest_fav, digest_tag_ids, digest_content FROM groups ORDER BY id').iterate()));
        const written = readDigests();
        expect(written.map(r => r.id)).toEqual(ids);
        expect(written.filter(r => tagged.has(r.id) && r.digest_tag_ids === null)).toEqual([]);
        withRawDb(db => {
            db.exec('ALTER TABLE groups DROP COLUMN digest_fav');
            db.exec('ALTER TABLE groups DROP COLUMN digest_tag_ids');
            db.exec('ALTER TABLE groups DROP COLUMN digest_content');
        });

        calls.length = 0;
        await metadataDb.ensureSchemaMigrated(directories);
        metadataDb.disposeMetadataStores();

        const chunkSql = 'SELECT id FROM groups WHERE id > ? ORDER BY id LIMIT ?';
        const chunkReads = calls.filter(c => oneLine(c) === chunkSql);
        expect(chunkReads.map(c => c.method)).toEqual(['readBounded', 'readBounded', 'readBounded']);
        for (const read of chunkReads) {
            expect(read.args[1]).toBe(1000);
            expect(read.args[0][1]).toBe(1000);
        }
        expect(calls.filter(c => c.method === 'all' && oneLine(c) === 'SELECT id FROM groups')).toEqual([]);

        // A write leaves an untagged group's digest_tag_ids NULL; the backfill sets it to the empty tag list's hash.
        const emptyTagIdsHash = groupDigestTagIdsHash({ tag_ids: [] });
        expect(readDigests()).toEqual(written.map(row => tagged.has(row.id) ? row : { ...row, digest_tag_ids: emptyTagIdsHash }));
    });
});

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

describe('migrateCardJsonColumn reads the ids to backfill in keyset chunks', () => {
    // A minimal valid 1x1 transparent PNG, so character-card-parser.js's write() can attach a `chara` chunk to it.
    const BLANK_PNG = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64',
    );

    /** @param {string} name */
    const card = (name) => JSON.stringify({ name, spec: 'chara_card_v2', spec_version: '2.0', data: { name, tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });

    test('2001 NULL rows with a readable PNG and one without: three bounded chunk reads, the 2001 backfilled from their PNG, the column left nullable', async () => {
        const { write: writeCard, read: readCard } = await import('../src/character-card-parser.js');

        /** @type {string[]} */
        const ids = [];
        for (let i = 0; i < 2002; i++) {
            const id = `char-${String(i).padStart(5, '0')}.png`;
            ids.push(id);
            await metadataDb.upsertCharacterFromWrite(directories, id, card(id.replace(/\.png$/, '')), null, null, {});
        }
        const unresolvedId = ids[2001];
        /** @type {Map<string, string>} */
        const expected = new Map();
        for (const id of ids.slice(0, 2001)) {
            const filePath = path.join(directories.characters, id);
            fs.writeFileSync(filePath, writeCard(BLANK_PNG, card(`png ${id}`)));
            expected.set(id, readCard(fs.readFileSync(filePath)));
        }
        metadataDb.disposeMetadataStores();

        // A store whose card_json is still nullable, with every row's card_json NULL.
        withRawDb(db => {
            const columns = Array.from(db.prepare('PRAGMA table_info(characters)').iterate());
            db.pragma('legacy_alter_table = ON');
            db.exec('CREATE TABLE characters_old (' + columns.map(c => `${c.name} ${c.type}${c.name !== 'card_json' && c.notnull ? ' NOT NULL' : ''}${c.pk ? ' PRIMARY KEY' : ''}`).join(', ') + ')');
            db.exec('INSERT INTO characters_old SELECT * FROM characters');
            db.exec('DROP TABLE characters');
            db.exec('ALTER TABLE characters_old RENAME TO characters');
            expect(db.prepare('UPDATE characters SET card_json = NULL').run().changes).toBe(2002);
        });

        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

        calls.length = 0;
        await metadataDb.ensureSchemaMigrated(directories);
        metadataDb.disposeMetadataStores();

        const chunkSql = 'SELECT id FROM characters WHERE card_json IS NULL AND id > ? ORDER BY id LIMIT ?';
        const chunkReads = calls.filter(c => oneLine(c) === chunkSql);
        expect(chunkReads.map(c => c.method)).toEqual(['readBounded', 'readBounded', 'readBounded']);
        for (const read of chunkReads) {
            expect(read.args[1]).toBe(1000);
            expect(read.args[0][1]).toBe(1000);
        }
        expect(calls.filter(c => c.method === 'all' && /card_json IS NULL/.test(oneLine(c)))).toEqual([]);

        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('backfilled 2001/2002'));
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(unresolvedId));

        withRawDb(db => {
            const rows = new Map(Array.from(db.prepare('SELECT id, card_json FROM characters').iterate(), r => [r.id, r.card_json]));
            expect(rows).toEqual(new Map([...expected, [unresolvedId, null]]));
            expect(db.prepare('SELECT "notnull" FROM pragma_table_info(\'characters\') WHERE name = \'card_json\'').get().notnull).toBe(0);
        });
    });
});
