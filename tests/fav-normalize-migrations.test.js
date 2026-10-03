import { describe, test, expect, jest, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { groupDigestFavHash } from '../public/scripts/hash-utils.js';

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

    test('a group whose file cannot be read is left alone and listed in a warning, and the flag stays unset', async () => {
        await seedStaleGroups();
        fs.writeFileSync(path.join(directories.groups, 'gfalse.json'), '{ not json');
        fs.rmSync(path.join(directories.groups, 'gyes.json'));
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

        try {
            await metadataDb.normalizeGroupFavIfNeeded(directories);
            const warnings = warn.mock.calls.map(args => args.join(' '));
            expect(warnings.some(w => w.includes('gfalse') && w.includes('gyes'))).toBe(true);
        } finally {
            warn.mockRestore();
        }

        const rows = Object.fromEntries(readGroupRows().map(r => [r.id, r]));
        expect(rows.gfalse).toEqual({ id: 'gfalse', fav: 1, digest_fav: groupDigestFavHash({ fav: true }) });
        expect(rows.gyes).toEqual({ id: 'gyes', fav: 1, digest_fav: groupDigestFavHash({ fav: true }) });
        expect(rows.gzero.fav).toBe(0);
        expect(await metadataDb.getMetaValue(directories, GROUP_FLAG)).toBeNull();
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
