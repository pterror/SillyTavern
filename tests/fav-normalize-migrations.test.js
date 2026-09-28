import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { groupDigestFavHash, characterDigestFavHash } from '../public/scripts/hash-utils.js';

/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {typeof import('../src/endpoints/search-index-coordinator.js')} */
let searchCoordinator;
/** @type {typeof import('better-sqlite3')} */
let Database;
/** @type {import('node:http').Server} */
let server;
let baseUrl;

/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

const GROUP_FLAG = 'group_fav_normalized_v1';
const CHARACTER_FLAG = 'character_fav_normalized_v1';

/**
 * Every call made on the metadata store's db handles (and their read connections) while `recording` is on.
 * @type {{ method: string, sql: string, params: any }[]}
 */
let calls = [];
let recording = false;

/**
 * Wraps a db handle so its reads and transactions are recorded - the metadata store's handle is opened through the
 * shared engine object, so patching engine.openDatabase covers every store opened after beforeAll.
 * @param {any} handle
 */
function recordingHandle(handle) {
    const record = (method, sql, params) => {
        if (recording) calls.push({ method, sql: String(sql ?? ''), params });
    };
    const wrapped = { ...handle };
    for (const method of ['all', 'query', 'iterate', 'get']) {
        wrapped[method] = (sql, params) => {
            record(method, sql, params);
            return handle[method](sql, params);
        };
    }
    wrapped.transaction = (fn) => {
        record('transaction', '', null);
        return handle.transaction(fn);
    };
    return wrapped;
}

/** @param {() => Promise<unknown>} fn */
async function recordCalls(fn) {
    calls = [];
    recording = true;
    try {
        await fn();
    } finally {
        recording = false;
    }
    return calls;
}

/**
 * Bounded streaming: no unbounded read (`all`/`query`) and every streamed read binds a LIMIT, with rows written in
 * more than one transaction once the table holds more rows than one batch.
 * @param {{ method: string, sql: string, params: any }[]} recorded
 * @param {string} table
 * @param {number} minTransactions
 */
function expectBoundedStreaming(recorded, table, minTransactions) {
    expect(recorded.filter(c => c.method === 'all' || c.method === 'query')).toEqual([]);
    const streamed = recorded.filter(c => c.method === 'iterate' && new RegExp(`FROM ${table}\\b`).test(c.sql));
    expect(streamed.length).toBeGreaterThan(0);
    for (const call of streamed) {
        expect(call.sql).toMatch(/LIMIT @limit/);
        expect(Number.isInteger(call.params?.limit)).toBe(true);
        expect(call.params.limit).toBeGreaterThan(0);
    }
    expect(recorded.filter(c => c.method === 'transaction').length).toBeGreaterThanOrEqual(minTransactions);
}

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    const sqliteEngine = await import('../src/endpoints/sqlite-engine.js');
    const engine = await sqliteEngine.getSqliteEngine();
    const openDatabase = engine.openDatabase;
    engine.openDatabase = (dbPath) => recordingHandle(openDatabase(dbPath));

    metadataDb = await import('../src/character-metadata-db.js');
    searchCoordinator = await import('../src/endpoints/search-index-coordinator.js');
    Database = (await import('better-sqlite3')).default;
    const { router: groupsRouter } = await import('../src/endpoints/groups.js');
    const { router: charactersRouter } = await import('../src/endpoints/characters.js');

    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        // Search index workers are keyed by handle, so each test's fresh directories get their own handle.
        req.user = { directories, profile: { handle: `test-user-${path.basename(directories.root)}` } };
        next();
    });
    app.use('/api/groups', groupsRouter);
    app.use('/api/characters', charactersRouter);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise(resolve => server.close(resolve)));

beforeEach(() => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-fav-normalize-migrations-test-'));
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
});

afterEach(async () => {
    recording = false;
    await searchCoordinator.disposeSearchWorkers();
    metadataDb.disposeMetadataStores();
    fs.rmSync(directories.root, { recursive: true, force: true });
});

async function postJson(urlPath, body) {
    return fetch(`${baseUrl}${urlPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

/** @template T @param {(db: import('better-sqlite3').Database) => T} fn @returns {T} */
function withRawDb(fn) {
    const db = new Database(path.join(directories.root, 'character-metadata.sqlite'));
    try {
        return fn(db);
    } finally {
        db.close();
    }
}

/**
 * Decodes `/query`'s binary hash-mode body (layout: serializeQueryHashesBinary() in src/endpoints/characters.js).
 * @param {ArrayBuffer} buffer
 * @returns {{ id: string, isGroup: boolean, favHash: number }[]}
 */
function decodeHashRows(buffer) {
    const view = new DataView(buffer);
    const decoder = new TextDecoder();
    let offset = 1 + 1 + 8 + 8;
    const rowCount = view.getUint16(offset, true); offset += 2;
    const rows = [];
    for (let i = 0; i < rowCount; i++) {
        const flags = view.getUint8(offset); offset += 1;
        const idLen = view.getUint16(offset, true); offset += 2;
        const id = decoder.decode(new Uint8Array(buffer, offset, idLen)); offset += idLen;
        const favHash = view.getUint32(offset, true); offset += 4;
        offset += 4 + 4 + 8 * 5;
        const chatLen = view.getUint16(offset, true); offset += 2 + chatLen;
        rows.push({ id, isGroup: (flags & 0b1) !== 0, favHash });
    }
    return rows;
}

describe('group fav migration (normalizeGroupFavIfNeeded)', () => {
    // [id, file value, stale column left by an older truthiness writer, normalized value]
    const GROUPS = [
        ['gfalse', 'false', 1, false],
        ['gyes', 'yes', 1, false],
        ['gzero', 0, 1, false],
        ['gtruestr', 'true', 0, true],
        ['gone', 1, 0, true],
        ['gtrue', true, 1, true],
    ];

    /** Group files holding raw fav values, with rows whose fav column and digest_fav carry the stale value. */
    async function seedStaleGroups() {
        for (const [id, fileFav] of GROUPS) {
            const group = { id, name: `Zorkmid ${id}`, members: [], chats: [], fav: fileFav };
            fs.writeFileSync(path.join(directories.groups, `${id}.json`), JSON.stringify(group));
            await metadataDb.upsertGroupRow(directories, id, group.name, { fav: fileFav, group });
        }
        withRawDb(db => {
            for (const [id, , staleColumn] of GROUPS) {
                db.prepare('UPDATE groups SET fav = ?, digest_fav = ? WHERE id = ?').run(staleColumn, groupDigestFavHash({ fav: !!staleColumn }), id);
            }
        });
    }

    function readGroupRows() {
        const rows = withRawDb(db => [...db.prepare('SELECT id, fav, digest_fav FROM groups LIMIT ?').iterate(GROUPS.length + 1)]);
        expect(rows.length).toBe(GROUPS.length);
        return rows;
    }

    /** @param {(items: any[]) => boolean} check */
    async function pollGroupSearch(check, extra = {}) {
        let items;
        const deadline = Date.now() + 15000;
        do {
            const response = await postJson('/api/characters/all', { search: 'zorkmid', includeGroups: true, ...extra });
            expect(response.status).toBe(200);
            items = (await response.json()).items.filter(r => r.type === 'group').map(r => r.item);
            if (check(items)) break;
            await new Promise(resolve => setTimeout(resolve, 100));
        } while (Date.now() < deadline);
        return items;
    }

    test('re-derives the fav column and digest_fav from the normalized file value, and /all, /batch, query rows, hash mode and the search index agree', async () => {
        await seedStaleGroups();
        const filesBefore = Object.fromEntries(GROUPS.map(([id]) => [id, fs.readFileSync(path.join(directories.groups, `${id}.json`), 'utf8')]));

        // The search index is built (from the stale columns) before the migration runs.
        const staleSearch = await pollGroupSearch(items => items.length === GROUPS.length);
        expect(Object.fromEntries(staleSearch.map(g => [g.id, g.fav]))).toEqual(Object.fromEntries(GROUPS.map(([id, , stale]) => [id, !!stale])));

        await metadataDb.normalizeGroupFavIfNeeded(directories);

        const expected = Object.fromEntries(GROUPS.map(([id, , , normalized]) => [id, normalized]));
        const expectedDigests = Object.fromEntries(GROUPS.map(([id, , , normalized]) => [id, groupDigestFavHash({ fav: normalized })]));

        const rows = readGroupRows();
        expect(Object.fromEntries(rows.map(r => [r.id, r.fav]))).toEqual(Object.fromEntries(GROUPS.map(([id, , , n]) => [id, n ? 1 : 0])));
        expect(Object.fromEntries(rows.map(r => [r.id, r.digest_fav]))).toEqual(expectedDigests);

        const all = await (await postJson('/api/groups/all', {})).json();
        expect(Object.fromEntries(all.map(g => [g.id, g.fav]))).toEqual(expected);

        const batch = await (await postJson('/api/groups/batch', { ids: GROUPS.map(([id]) => id) })).json();
        expect(Object.fromEntries(batch.map(g => [g.id, g.fav]))).toEqual(expected);
        expect(Object.fromEntries(batch.map(g => [g.id, groupDigestFavHash(g)]))).toEqual(expectedDigests);

        const query = await (await postJson('/api/characters/query', { filter: { includeGroups: true }, sort: { field: 'name', order: 'asc' }, page: 1, pageSize: 50 })).json();
        expect(Object.fromEntries(query.rows.map(r => [r.item.id, r.item.fav]))).toEqual(expected);

        const hashResponse = await postJson('/api/characters/query', { filter: { includeGroups: true }, sort: { field: 'name', order: 'asc' }, page: 1, pageSize: 50, want: ['hashes', 'total'] });
        const hashRows = decodeHashRows(await hashResponse.arrayBuffer());
        expect(Object.fromEntries(hashRows.map(r => [r.id, r.favHash]))).toEqual(expectedDigests);

        const searched = await pollGroupSearch(items => items.every(g => g.fav === expected[g.id]));
        expect(Object.fromEntries(searched.map(g => [g.id, g.fav]))).toEqual(expected);
        const favOnly = await pollGroupSearch(() => true, { fav: true });
        expect(favOnly.map(g => g.id).sort()).toEqual(GROUPS.filter(([, , , n]) => n).map(([id]) => id).sort());

        // The migration fixes the db only; group files are not rewritten.
        for (const [id] of GROUPS) {
            expect(fs.readFileSync(path.join(directories.groups, `${id}.json`), 'utf8')).toBe(filesBefore[id]);
        }
    }, 60000);

    test('runs once: sets its meta flag, and a second call leaves a later-drifted column alone', async () => {
        await seedStaleGroups();
        await metadataDb.normalizeGroupFavIfNeeded(directories);
        expect(await metadataDb.getMetaValue(directories, GROUP_FLAG)).not.toBeNull();

        withRawDb(db => db.prepare('UPDATE groups SET fav = 1 WHERE id = ?').run('gfalse'));
        await metadataDb.normalizeGroupFavIfNeeded(directories);
        expect(withRawDb(db => db.prepare('SELECT fav FROM groups WHERE id = ?').get('gfalse')).fav).toBe(1);
    });

    test('a group whose file cannot be read is left alone, and the flag is still set', async () => {
        await seedStaleGroups();
        fs.writeFileSync(path.join(directories.groups, 'gfalse.json'), '{ not json');
        fs.rmSync(path.join(directories.groups, 'gyes.json'));

        await metadataDb.normalizeGroupFavIfNeeded(directories);

        const rows = Object.fromEntries(readGroupRows().map(r => [r.id, r]));
        expect(rows.gfalse).toEqual({ id: 'gfalse', fav: 1, digest_fav: groupDigestFavHash({ fav: true }) });
        expect(rows.gyes).toEqual({ id: 'gyes', fav: 1, digest_fav: groupDigestFavHash({ fav: true }) });
        expect(rows.gzero.fav).toBe(0);
        expect(await metadataDb.getMetaValue(directories, GROUP_FLAG)).not.toBeNull();
    });

    test('streams the groups table in bounded batches, never an unbounded read', async () => {
        const count = 1001;
        for (let i = 0; i < count; i++) {
            const id = `g${String(i).padStart(5, '0')}`;
            const group = { id, name: id, members: [], chats: [], fav: 'false' };
            fs.writeFileSync(path.join(directories.groups, `${id}.json`), JSON.stringify(group));
            await metadataDb.upsertGroupRow(directories, id, id, { fav: false, group });
        }
        withRawDb(db => db.prepare('UPDATE groups SET fav = 1, digest_fav = ?').run(groupDigestFavHash({ fav: true })));

        const recorded = await recordCalls(() => metadataDb.normalizeGroupFavIfNeeded(directories));

        expectBoundedStreaming(recorded, 'groups', 2);
        const remaining = withRawDb(db => db.prepare('SELECT COUNT(*) AS n FROM groups WHERE fav != 0 OR digest_fav != ?').get(groupDigestFavHash({ fav: false })));
        expect(remaining.n).toBe(0);
    }, 60000);
});

describe('character fav migration (normalizeCharacterFavIfNeeded)', () => {
    /** @param {boolean} fav */
    function expectedDigest(fav) {
        return characterDigestFavHash({ fav, data: { extensions: { fav } } }) % 4294967296;
    }

    /** @param {string} name */
    function card(name) {
        return JSON.stringify({ name, data: { name, tags: [], creator: '', character_version: '', creator_notes: '', extensions: { world: '' } } });
    }

    // [id, fav column, shallow_json fav fields to plant (MISSING_FIELD = absent), plant a stale digest_fav]
    const MISSING_FIELD = Symbol('missing');
    const CHARACTERS = [
        ['A.png', 1, 'false', MISSING_FIELD, false],
        ['B.png', 0, 'true', 'yes', false],
        ['C.png', 1, true, true, true],
        ['D.png', 0, false, false, false],
        ['E.png', 1, true, MISSING_FIELD, false],
    ];
    const CHANGED = ['A.png', 'B.png', 'E.png'];

    async function seedCharacters() {
        for (const [id, column] of CHARACTERS) {
            await metadataDb.upsertCharacterFromWrite(directories, id, card(id));
            if (column) await metadataDb.setCharacterFav(directories, id, true);
        }
        withRawDb(db => {
            for (const [id, , topFav, extFav, staleDigest] of CHARACTERS) {
                const shallow = JSON.parse(db.prepare('SELECT shallow_json FROM characters WHERE id = ?').get(id).shallow_json);
                shallow.fav = topFav;
                shallow.data = shallow.data ?? {};
                shallow.data.extensions = shallow.data.extensions ?? {};
                if (extFav === MISSING_FIELD) delete shallow.data.extensions.fav;
                else shallow.data.extensions.fav = extFav;
                db.prepare('UPDATE characters SET shallow_json = ?, digest_fav = ? WHERE id = ?').run(JSON.stringify(shallow), staleDigest ? 12345 : characterDigestFavHash(shallow) % 4294967296, id);
            }
        });
    }

    function readCharacterRows() {
        const rows = withRawDb(db => [...db.prepare('SELECT id, fav, shallow_json, digest_fav, change_seq, card_json FROM characters LIMIT ?').iterate(CHARACTERS.length + 1)]);
        expect(rows.length).toBe(CHARACTERS.length);
        return Object.fromEntries(rows.map(r => [r.id, r]));
    }

    function maxChangeSeq() {
        return withRawDb(db => db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM changes').get().seq);
    }

    /** @param {number} afterSeq @param {number} expectedCount */
    function changesSince(afterSeq, expectedCount) {
        const rows = withRawDb(db => [...db.prepare('SELECT seq, id, op, fields FROM changes WHERE seq > ? ORDER BY seq LIMIT ?').iterate(afterSeq, expectedCount + 1)]);
        expect(rows.length).toBe(expectedCount);
        return rows;
    }

    test('re-derives digest_fav and both shallow_json fav fields from the fav column, never touching the column', async () => {
        await seedCharacters();
        const before = readCharacterRows();

        await metadataDb.normalizeCharacterFavIfNeeded(directories);

        const after = readCharacterRows();
        for (const [id, column] of CHARACTERS) {
            const row = after[id];
            const shallow = JSON.parse(row.shallow_json);
            expect([id, row.fav]).toEqual([id, column]);
            expect([id, shallow.fav, shallow.data.extensions.fav]).toEqual([id, !!column, !!column]);
            expect([id, row.digest_fav]).toEqual([id, expectedDigest(!!column)]);
            expect([id, row.card_json]).toEqual([id, before[id].card_json]);
        }
    });

    test('adds a ["fav"] change-log entry and bumps change_seq only for rows whose stored value changed', async () => {
        await seedCharacters();
        const before = readCharacterRows();
        const seqBefore = maxChangeSeq();

        await metadataDb.normalizeCharacterFavIfNeeded(directories);

        const after = readCharacterRows();
        const newChanges = changesSince(seqBefore, CHANGED.length);
        expect(newChanges.map(c => [c.id, c.op, c.fields]).sort()).toEqual(CHANGED.map(id => [id, 'upsert', JSON.stringify(['fav'])]).sort());
        const expectedSeqs = Object.fromEntries(CHARACTERS.map(([id]) => [id, CHANGED.includes(id) ? newChanges.find(c => c.id === id)?.seq : before[id].change_seq]));
        expect(Object.fromEntries(CHARACTERS.map(([id]) => [id, after[id].change_seq]))).toEqual(expectedSeqs);
    });

    test('runs once: sets its meta flag, and a second call leaves later-drifted rows alone', async () => {
        await seedCharacters();
        await metadataDb.normalizeCharacterFavIfNeeded(directories);
        expect(await metadataDb.getMetaValue(directories, CHARACTER_FLAG)).not.toBeNull();

        withRawDb(db => db.prepare('UPDATE characters SET digest_fav = 12345 WHERE id = ?').run('D.png'));
        const seqBefore = maxChangeSeq();
        await metadataDb.normalizeCharacterFavIfNeeded(directories);
        const after = readCharacterRows();
        expect(after['D.png'].digest_fav).toBe(12345);
        changesSince(seqBefore, 0);
    });

    test('streams the characters table in bounded batches, never an unbounded read', async () => {
        const count = 1001;
        await metadataDb.beginBatchImport(directories);
        for (let i = 0; i < count; i++) {
            await metadataDb.upsertCharacterFromWrite(directories, `c${String(i).padStart(5, '0')}.png`, card(`c${i}`));
        }
        await metadataDb.endBatchImport(directories);
        withRawDb(db => db.prepare('UPDATE characters SET digest_fav = 12345').run());

        const recorded = await recordCalls(() => metadataDb.normalizeCharacterFavIfNeeded(directories));

        expectBoundedStreaming(recorded, 'characters', 2);
        const remaining = withRawDb(db => db.prepare('SELECT COUNT(*) AS n FROM characters WHERE digest_fav != ?').get(expectedDigest(false)));
        expect(remaining.n).toBe(0);
    }, 60000);
});
