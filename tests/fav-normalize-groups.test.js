import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { groupDigestFavHash } from '../public/scripts/hash-utils.js';

/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {typeof import('../src/endpoints/groups.js')} */
let groupsModule;
/** @type {typeof import('../src/endpoints/search-index-coordinator.js')} */
let searchCoordinator;
/** @type {typeof import('better-sqlite3')} */
let Database;
/** @type {import('node:http').Server} */
let server;
let baseUrl;

/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

const MISSING = Symbol('missing');

const FAV_CASES = [
    ['true', true, true],
    ['false', false, false],
    ['"true"', 'true', true],
    ['"false"', 'false', false],
    ['1', 1, true],
    ['0', 0, false],
    ['null', null, false],
    ['missing', MISSING, false],
    ['"yes"', 'yes', false],
];

/** @param {object} target @param {unknown} value @returns {object} */
function withFav(target, value) {
    if (value !== MISSING) target.fav = value;
    return target;
}

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    metadataDb = await import('../src/character-metadata-db.js');
    groupsModule = await import('../src/endpoints/groups.js');
    searchCoordinator = await import('../src/endpoints/search-index-coordinator.js');
    Database = (await import('better-sqlite3')).default;
    const { router: charactersRouter } = await import('../src/endpoints/characters.js');

    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        // Search index workers are keyed by handle, so each test's fresh directories get their own handle.
        req.user = { directories, profile: { handle: `test-user-${path.basename(directories.root)}` } };
        next();
    });
    app.use('/api/groups', groupsModule.router);
    app.use('/api/characters', charactersRouter);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise(resolve => server.close(resolve)));

beforeEach(() => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-fav-normalize-groups-test-'));
    directories = {
        root: tempDir,
        characters: path.join(tempDir, 'characters'),
        chats: path.join(tempDir, 'chats'),
        groups: path.join(tempDir, 'groups'),
        groupChats: path.join(tempDir, 'groupChats'),
        backups: path.join(tempDir, 'backups'),
    };
    for (const dir of [directories.characters, directories.chats, directories.groups, directories.groupChats, directories.backups]) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

afterEach(async () => {
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

function dbPath() {
    return path.join(directories.root, 'character-metadata.sqlite');
}

/** @param {string} id @returns {{ fav: number, digest_fav: number | null }} */
function readGroupRow(id) {
    const db = new Database(dbPath(), { readonly: true });
    try {
        return db.prepare('SELECT fav, digest_fav FROM groups WHERE id = ?').get(id);
    } finally {
        db.close();
    }
}

/** @param {string} sql @param {object} params */
function runRaw(sql, params = {}) {
    const db = new Database(dbPath());
    try {
        db.prepare(sql).run(params);
    } finally {
        db.close();
    }
}

/** @param {string} id @returns {object} */
function readGroupJson(id) {
    return JSON.parse(fs.readFileSync(path.join(directories.groups, `${id}.json`), 'utf8'));
}

/** @param {object} group */
function writeRawGroupFile(group) {
    fs.writeFileSync(path.join(directories.groups, `${group.id}.json`), JSON.stringify(group));
}

/** @param {string} id */
function columnAndDigest(id) {
    const row = readGroupRow(id);
    return { fav: row.fav, digestFav: row.digest_fav };
}

/** @param {boolean} expected @returns {ReturnType<typeof columnAndDigest>} */
function columnAndDigestFor(expected) {
    return { fav: expected ? 1 : 0, digestFav: groupDigestFavHash({ fav: expected }) };
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

/** @returns {Promise<Map<string, number>>} group id -> favHash from hash-mode /query */
async function hashModeGroupFavHashes() {
    const response = await postJson('/api/characters/query', {
        filter: { includeGroups: true }, sort: { field: 'name', order: 'asc' }, page: 1, pageSize: 50, want: ['hashes', 'total'],
    });
    expect(response.status).toBe(200);
    const rows = decodeHashRows(await response.arrayBuffer());
    return new Map(rows.filter(r => r.isGroup).map(r => [r.id, r.favHash]));
}

/**
 * The groups search index is maintained by a worker that rebuilds on its own tick; polls until `check` passes.
 * @param {object} body /api/characters/all request body
 * @param {(body: any) => boolean} check
 */
async function pollSearch(body, check) {
    let result;
    const deadline = Date.now() + 10000;
    do {
        const response = await postJson('/api/characters/all', body);
        expect(response.status).toBe(200);
        result = await response.json();
        if (check(result)) break;
        await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    return result;
}

describe('group column writers store the normalized fav (column + digest_fav) and write it to the file', () => {
    test.each(FAV_CASES)('upsertGroupRow: %s', async (_label, value, expected) => {
        const group = withFav({ id: 'g1', name: 'G', members: [] }, value);
        await metadataDb.upsertGroupRow(directories, 'g1', 'G', { fav: group.fav, group });
        expect(columnAndDigest('g1')).toEqual(columnAndDigestFor(expected));
    });

    test.each(FAV_CASES)('writeGroupFile: %s', async (_label, value, expected) => {
        await groupsModule.writeGroupFile(directories, withFav({ id: 'g1', name: 'G', members: [] }, value));
        expect(columnAndDigest('g1')).toEqual(columnAndDigestFor(expected));
        expect(readGroupJson('g1').fav).toBe(expected);
    });

    test.each(FAV_CASES)('POST /api/groups/create: %s', async (_label, value, expected) => {
        const response = await postJson('/api/groups/create', withFav({ name: 'Created' }, value));
        expect(response.status).toBe(200);
        const created = await response.json();
        expect(created.fav).toBe(expected);
        expect(columnAndDigest(created.id)).toEqual(columnAndDigestFor(expected));
        expect(readGroupJson(created.id).fav).toBe(expected);
    });

    test.each(FAV_CASES)('POST /api/groups/edit: %s', async (_label, value, expected) => {
        const created = await (await postJson('/api/groups/create', { name: 'Edited', fav: !expected })).json();
        const response = await postJson('/api/groups/edit', withFav({ id: created.id, name: 'Edited', members: [], chats: [] }, value));
        expect(response.status).toBe(200);
        expect(columnAndDigest(created.id)).toEqual(columnAndDigestFor(expected));
        expect(readGroupJson(created.id).fav).toBe(expected);
    });

    test.each(FAV_CASES)('POST /api/groups/save-partial: %s', async (_label, value, expected) => {
        const created = await (await postJson('/api/groups/create', { name: 'Partial', fav: !expected })).json();
        const props = value === MISSING ? { name: 'Partial 2' } : { fav: value };
        if (value === MISSING) {
            // Only a file that has no fav at all can be "missing": drop it from the stored file first.
            const stored = readGroupJson(created.id);
            delete stored.fav;
            writeRawGroupFile(stored);
        }
        const response = await postJson('/api/groups/save-partial', { id: created.id, props });
        expect(response.status).toBe(200);
        expect(columnAndDigest(created.id)).toEqual(columnAndDigestFor(expected));
        expect(readGroupJson(created.id).fav).toBe(expected);
    });

    test.each(FAV_CASES)('bootstrapGroupsIfNeeded: %s (column and digest from the normalized file value; file left as is)', async (_label, value, expected) => {
        writeRawGroupFile(withFav({ id: 'g1', name: 'G', members: [], chats: [] }, value));
        const before = fs.readFileSync(path.join(directories.groups, 'g1.json'), 'utf8');
        await metadataDb.bootstrapGroupsIfNeeded(directories);
        expect(columnAndDigest('g1')).toEqual(columnAndDigestFor(expected));
        expect(fs.readFileSync(path.join(directories.groups, 'g1.json'), 'utf8')).toBe(before);
    });

    test.each(FAV_CASES)('migrateGroupChatsMetadataFormat writes the normalized fav: %s', async (_label, value, expected) => {
        writeRawGroupFile(withFav({ id: 'g1', name: 'G', members: [], chats: [], chat_id: 'c1', chat_metadata: {} }, value));
        await groupsModule.migrateGroupChatsMetadataFormat([directories]);
        const group = readGroupJson('g1');
        expect(group.chat_metadata).toBeUndefined();
        expect(group.fav).toBe(expected);
    });
});

describe('group routes send the normalized boolean, and the client hash of what they send equals the server digest', () => {
    test.each(FAV_CASES)('%s', async (_label, value, expected) => {
        // A pre-normalization file: the raw value on disk, row written through the server's column writer.
        const group = withFav({ id: 'g1', name: 'Zorkmid', members: [], chats: [] }, value);
        writeRawGroupFile(group);
        await metadataDb.upsertGroupRow(directories, 'g1', group.name, { fav: group.fav, group });
        const { digest_fav: digestFav } = readGroupRow('g1');
        expect(digestFav).toBe(groupDigestFavHash({ fav: expected }));

        /** @type {[string, any][]} */
        const sent = [];

        const all = await (await postJson('/api/groups/all', {})).json();
        sent.push(['/api/groups/all', all.find(g => g.id === 'g1')]);

        const batch = await (await postJson('/api/groups/batch', { ids: ['g1'] })).json();
        sent.push(['/api/groups/batch', batch[0]]);

        const batchFields = await (await postJson('/api/groups/batch', { ids: ['g1'], fields: ['fav'] })).json();
        sent.push(['/api/groups/batch fields', batchFields[0]]);

        const query = await (await postJson('/api/characters/query', { filter: { includeGroups: true }, sort: { field: 'name', order: 'asc' }, page: 1, pageSize: 10 })).json();
        sent.push(['/api/characters/query rows', query.rows.find(r => r.type === 'group').item]);

        const search = await pollSearch({ search: 'zorkmid', includeGroups: true }, body => body.items?.length > 0);
        sent.push(['/api/characters/all search', search.items.find(r => r.type === 'group').item]);

        for (const [route, record] of sent) {
            expect([route, record.fav]).toEqual([route, expected]);
            expect([route, groupDigestFavHash(record)]).toEqual([route, digestFav]);
        }

        const hashes = await hashModeGroupFavHashes();
        expect(hashes.get('g1')).toBe(digestFav);
    }, 30000);
});

describe('hash-mode NULL-digest file fallback hashes the normalized file value', () => {
    test.each(FAV_CASES)('%s', async (_label, value, expected) => {
        const group = withFav({ id: 'g1', name: 'G', members: [], chats: [] }, value);
        writeRawGroupFile(group);
        await metadataDb.upsertGroupRow(directories, 'g1', 'G', { fav: group.fav, group });
        runRaw('UPDATE groups SET digest_fav = NULL, digest_tag_ids = NULL, digest_content = NULL WHERE id = \'g1\'');

        const hashes = await hashModeGroupFavHashes();
        expect(hashes.get('g1')).toBe(groupDigestFavHash({ fav: expected }));
    });
});

describe('groups search index takes fav from the column', () => {
    test('a group whose column says not-favourite is not a favourite in search, whatever its file says', async () => {
        writeRawGroupFile({ id: 'g1', name: 'Zorkmid', members: [], chats: [], fav: true });
        await metadataDb.upsertGroupRow(directories, 'g1', 'Zorkmid', { fav: true, group: readGroupJson('g1') });
        runRaw('UPDATE groups SET fav = 0 WHERE id = \'g1\'');

        const all = await pollSearch({ search: 'zorkmid', includeGroups: true }, body => body.items?.length > 0);
        expect(all.items.find(r => r.type === 'group').item.fav).toBe(false);

        const favOnly = await (await postJson('/api/characters/all', { search: 'zorkmid', includeGroups: true, fav: true })).json();
        expect(favOnly.items).toEqual([]);
    }, 30000);
});
