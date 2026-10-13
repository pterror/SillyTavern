import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import path from 'node:path';
import { groupDigestFavHash } from '../public/scripts/hash-utils.js';

/** @type {Awaited<ReturnType<typeof import('./converted-user.fixture.js').emptyUser>>} */
let user;
/** @type {typeof import('./converted-user.fixture.js')} */
let fixture;
/** @type {typeof import('../src/endpoints/groups.js')} */
let groupsModule;
let TYPE;
/** @type {import('node:http').Server} */
let server;
let baseUrl;

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

    fixture = await import('./converted-user.fixture.js');
    ({ TYPE } = await import('../src/library-codes.js'));
    groupsModule = await import('../src/endpoints/groups.js');
    const { router: charactersRouter } = await import('../src/endpoints/characters.js');

    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.user = user.user;
        next();
    });
    app.use('/api/groups', groupsModule.router);
    app.use('/api/characters', charactersRouter);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise(resolve => server.close(resolve)));

beforeEach(async () => {
    user = await fixture.emptyUser('st-fav-normalize-groups-test-');
    globalThis.DATA_ROOT = user.dataRoot;
});

afterEach(() => user.close());

async function postJson(urlPath, body) {
    return fetch(`${baseUrl}${urlPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

/** @param {string} id @returns {Promise<Record<string, any>>} The group as stored. */
async function readGroupJson(id) {
    return /** @type {any} */ ((await user.store.lib.groups([id]))[0]);
}

/** The group's fav and the digest of it the list rows carry (over the group as the routes send it). */
async function columnAndDigest(id) {
    const group = await readGroupJson(id);
    return { fav: (await user.store.lib.entity(TYPE.group, id))?.fav ? 1 : 0, digestFav: groupDigestFavHash(group) };
}

/** @param {boolean} expected @returns {{ fav: number, digestFav: number }} */
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

describe('group writers store the normalized fav, and the digest of it is the same', () => {
    test.each(FAV_CASES)('writeGroup: %s', async (_label, value, expected) => {
        await user.store.lib.writeGroup(withFav({ id: 'g1', name: 'G', members: [] }, value));
        expect(await columnAndDigest('g1')).toEqual(columnAndDigestFor(expected));
        expect((await readGroupJson('g1')).fav).toBe(expected);
    });

    test.each(FAV_CASES)('POST /api/groups/create: %s', async (_label, value, expected) => {
        const response = await postJson('/api/groups/create', withFav({ name: 'Created' }, value));
        expect(response.status).toBe(200);
        const created = await response.json();
        expect(created.fav).toBe(expected);
        expect(await columnAndDigest(created.id)).toEqual(columnAndDigestFor(expected));
        expect((await readGroupJson(created.id)).fav).toBe(expected);
    });

    test.each(FAV_CASES)('POST /api/groups/edit: %s', async (_label, value, expected) => {
        const created = await (await postJson('/api/groups/create', { name: 'Edited', fav: !expected })).json();
        const response = await postJson('/api/groups/edit', withFav({ id: created.id, name: 'Edited', members: [], chats: [] }, value));
        expect(response.status).toBe(200);
        expect(await columnAndDigest(created.id)).toEqual(columnAndDigestFor(expected));
        expect((await readGroupJson(created.id)).fav).toBe(expected);
    });

    test.each(FAV_CASES)('POST /api/groups/save-partial: %s', async (_label, value, expected) => {
        // A save naming no fav leaves the stored one: it starts at what the case expects.
        const created = await (await postJson('/api/groups/create', { name: 'Partial', fav: value === MISSING ? expected : !expected })).json();
        const props = value === MISSING ? { name: 'Partial 2' } : { fav: value };
        const response = await postJson('/api/groups/save-partial', { id: created.id, props });
        expect(response.status).toBe(200);
        expect(await columnAndDigest(created.id)).toEqual(columnAndDigestFor(expected));
        expect((await readGroupJson(created.id)).fav).toBe(expected);
    });
});

describe('group routes send the normalized boolean, and the client hash of what they send equals the server digest', () => {
    test.each(FAV_CASES)('%s', async (_label, value, expected) => {
        const group = withFav({ id: 'g1', name: 'Zorkmid', members: [], chats: [] }, value);
        await user.store.lib.writeGroup(group);
        const { digestFav } = await columnAndDigest('g1');
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
