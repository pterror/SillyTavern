import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { characterDigestFavHash } from '../public/scripts/hash-utils.js';

// writeCharacterData()'s and the JSON importer's DEFAULT_AVATAR_PATH ('./public/img/...') is repo-root-relative.
const originalCwd = process.cwd();

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
const PRESENT_FAV_CASES = FAV_CASES.filter(([, value]) => value !== MISSING);

/** @param {object} target @param {unknown} value @returns {object} */
function withFav(target, value) {
    if (value !== MISSING) target.fav = value;
    return target;
}

/** @param {boolean} fav */
function expectedDigest(fav) {
    return characterDigestFavHash({ fav, data: { extensions: { fav } } }) % 4294967296;
}

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(originalCwd, '..', 'default', 'config.yaml'));

    metadataDb = await import('../src/character-metadata-db.js');
    searchCoordinator = await import('../src/endpoints/search-index-coordinator.js');
    Database = (await import('better-sqlite3')).default;
    const { router } = await import('../src/endpoints/characters.js');

    process.chdir(path.resolve(originalCwd, '..'));

    const express = (await import('express')).default;
    const multer = (await import('multer')).default;
    const app = express();
    const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-fav-normalize-characters-uploads-'));
    app.use(multer({ dest: uploadsDir }).single('avatar'));
    app.use(express.json());
    app.use((req, res, next) => {
        // Search index workers are keyed by handle, so each test's fresh directories get their own handle.
        req.user = { directories, profile: { handle: `test-user-${path.basename(directories.root)}` } };
        next();
    });
    app.use('/api/characters', router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
    process.chdir(originalCwd);
});

beforeEach(() => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-fav-normalize-characters-test-'));
    directories = {
        root: tempDir,
        characters: path.join(tempDir, 'characters'),
        chats: path.join(tempDir, 'chats'),
        groups: path.join(tempDir, 'groups'),
        groupChats: path.join(tempDir, 'groupChats'),
        thumbnailsAvatar: path.join(tempDir, 'thumbnails', 'avatar'),
    };
    for (const dir of [directories.characters, directories.chats, directories.groups, directories.groupChats, directories.thumbnailsAvatar]) {
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

/** @param {string} id @returns {{ fav: number, shallow: any, digest_fav: number, card: any }} */
function readCharacterRow(id) {
    const db = new Database(path.join(directories.root, 'character-metadata.sqlite'), { readonly: true });
    try {
        const row = db.prepare('SELECT fav, shallow_json, digest_fav, card_json FROM characters WHERE id = ?').get(id);
        return { fav: row.fav, shallow: JSON.parse(row.shallow_json), digest_fav: row.digest_fav, card: JSON.parse(row.card_json) };
    } finally {
        db.close();
    }
}

/** @param {string} id */
function storedFav(id) {
    const row = readCharacterRow(id);
    return { fav: row.fav, shallowFav: row.shallow.fav, shallowExtensionsFav: row.shallow.data.extensions.fav, digestFav: row.digest_fav };
}

/** @param {boolean} expected @returns {ReturnType<typeof storedFav>} */
function storedFavFor(expected) {
    return { fav: expected ? 1 : 0, shallowFav: expected, shallowExtensionsFav: expected, digestFav: expectedDigest(expected) };
}

/** @param {string} id */
function cardJsonFavKeys(id) {
    const { card } = readCharacterRow(id);
    return {
        topLevel: Object.prototype.hasOwnProperty.call(card, 'fav'),
        extensions: Object.prototype.hasOwnProperty.call(card.data?.extensions ?? {}, 'fav'),
    };
}

/** @param {object} overrides */
function cardJson(overrides = {}) {
    return JSON.stringify({
        name: 'Bob',
        create_date: '2024-01-01T00:00:00.000Z',
        data: { name: 'Bob', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { world: '' } },
        ...overrides,
    });
}

/** @param {unknown} value */
function cardWithFav(value) {
    const card = JSON.parse(cardJson());
    if (value !== MISSING) {
        card.fav = value;
        card.data.extensions.fav = value;
    }
    return JSON.stringify(card);
}

/** @param {unknown} value @returns {Promise<string>} the created avatar */
async function createCharacter(value) {
    const response = await postJson('/api/characters/create', withFav({ ch_name: 'Zorkmid', file_name: 'Zorkmid', description: 'd' }, value));
    expect(response.status).toBe(200);
    return 'Zorkmid.png';
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

describe('character column writers store the normalized fav in the column, both shallow_json fav fields and digest_fav', () => {
    test.each(FAV_CASES)('upsertCharacterFromWrite, new row: %s', async (_label, value, expected) => {
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardWithFav(value));
        expect(storedFav('Bob.png')).toEqual(storedFavFor(expected));
    });

    test.each([[true, 'false'], [false, 'true']])('upsertCharacterFromWrite, existing row keeps its column (%p) over the card (%p), in both shallow fields', async (existing, cardValue) => {
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardWithFav(existing));
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardWithFav(cardValue));
        expect(storedFav('Bob.png')).toEqual(storedFavFor(existing));
    });

    test.each(FAV_CASES)('setCharacterFav: %s', async (_label, value, expected) => {
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardWithFav(!expected));
        expect(await metadataDb.setCharacterFav(directories, 'Bob.png', value === MISSING ? undefined : value)).toBe(true);
        expect(storedFav('Bob.png')).toEqual(storedFavFor(expected));
    });

    test.each(FAV_CASES)('POST /fav: %s', async (_label, value, expected) => {
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardWithFav(!expected));
        const response = await postJson('/api/characters/fav', withFav({ avatar: 'Bob.png' }, value));
        expect(response.status).toBe(204);
        expect(storedFav('Bob.png')).toEqual(storedFavFor(expected));
    });

    test.each(FAV_CASES)('POST /fav bulk: %s', async (_label, value, expected) => {
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardWithFav(!expected));
        const response = await postJson('/api/characters/fav', { bulk: [withFav({ avatar: 'Bob.png' }, value)] });
        expect(response.status).toBe(200);
        expect((await response.json()).results).toEqual([{ avatar: 'Bob.png', ok: true }]);
        expect(storedFav('Bob.png')).toEqual(storedFavFor(expected));
    });

    test.each(FAV_CASES)('POST /create: %s', async (_label, value, expected) => {
        const avatar = await createCharacter(value);
        expect(storedFav(avatar)).toEqual(storedFavFor(expected));
    });

    test.each(PRESENT_FAV_CASES)('POST /merge-attributes: %s', async (_label, value, expected) => {
        const avatar = await createCharacter(!expected);
        const response = await postJson('/api/characters/merge-attributes', { avatar, fav: value });
        expect(response.status).toBe(200);
        expect(storedFav(avatar)).toEqual(storedFavFor(expected));
    });

    test('POST /create with a batch import open: the row and its fav are in the table before the import ends', async () => {
        expect((await postJson('/api/characters/metadata/batch-import/begin', {})).status).toBe(204);
        try {
            const avatar = await createCharacter(true);
            expect(storedFav(avatar)).toEqual(storedFavFor(true));
        } finally {
            await postJson('/api/characters/metadata/batch-import/end', {});
        }
        expect(storedFav('Zorkmid.png')).toEqual(storedFavFor(true));
    });
});

describe('card_json never gains fav', () => {
    test.each(FAV_CASES)('POST /create: %s', async (_label, value) => {
        const avatar = await createCharacter(value);
        expect(cardJsonFavKeys(avatar)).toEqual({ topLevel: false, extensions: false });
    });

    test.each(FAV_CASES)('POST /edit: %s', async (_label, value) => {
        const avatar = await createCharacter(true);
        const response = await postJson('/api/characters/edit', withFav({ avatar_url: avatar, ch_name: 'Zorkmid', description: 'edited' }, value));
        expect(response.status).toBe(200);
        expect(readCharacterRow(avatar).card.description ?? readCharacterRow(avatar).card.data.description).toBe('edited');
        expect(cardJsonFavKeys(avatar)).toEqual({ topLevel: false, extensions: false });
    });

    test.each(PRESENT_FAV_CASES)('POST /merge-attributes: %s', async (_label, value) => {
        const avatar = await createCharacter(false);
        const response = await postJson('/api/characters/merge-attributes', { avatar, fav: value, data: { extensions: { fav: value } } });
        expect(response.status).toBe(200);
        expect(cardJsonFavKeys(avatar)).toEqual({ topLevel: false, extensions: false });
    });

    test.each(FAV_CASES)('POST /fav: %s', async (_label, value) => {
        const avatar = await createCharacter(false);
        const response = await postJson('/api/characters/fav', withFav({ avatar }, value));
        expect(response.status).toBe(204);
        expect(cardJsonFavKeys(avatar)).toEqual({ topLevel: false, extensions: false });
    });
});

describe('every card-sending route sends both fav fields as the column boolean, and the client hash of each record equals digest_fav', () => {
    test.each(FAV_CASES)('created with fav %s', async (_label, value, expected) => {
        const avatar = await createCharacter(value);
        const { digest_fav: digestFav } = readCharacterRow(avatar);

        /** @type {[string, any][]} */
        const sent = [];

        const allResponse = await postJson('/api/characters/all', {});
        sent.push(['/all', (await allResponse.json()).find(c => c.avatar === avatar)]);

        let searched;
        const deadline = Date.now() + 10000;
        do {
            searched = await (await postJson('/api/characters/all', { search: 'zorkmid' })).json();
            if (searched.items?.length > 0) break;
            await new Promise(resolve => setTimeout(resolve, 100));
        } while (Date.now() < deadline);
        sent.push(['/all search', searched.items.find(c => c.avatar === avatar)]);

        sent.push(['/batch', (await (await postJson('/api/characters/batch', { avatars: [avatar] })).json())[0]]);
        sent.push(['/batch fields', (await (await postJson('/api/characters/batch', { avatars: [avatar], fields: ['fav', 'data'] })).json())[0]]);
        sent.push(['/get', await (await postJson('/api/characters/get', { avatar_url: avatar })).json()]);

        const query = await (await postJson('/api/characters/query', { page: 1, pageSize: 10 })).json();
        sent.push(['/query rows', query.rows.find(c => c.avatar === avatar)]);

        const entityQuery = await (await postJson('/api/characters/query', { filter: { includeGroups: true }, sort: { field: 'name', order: 'asc' }, page: 1, pageSize: 10 })).json();
        sent.push(['/query rows with groups', entityQuery.rows.find(r => r.type === 'character').item]);

        // A replace-import of the same character keeps its db-authoritative fav.
        const formData = new FormData();
        formData.append('avatar', new Blob([JSON.stringify({ name: 'Zorkmid', description: 'reimported' })], { type: 'application/json' }), 'zorkmid.json');
        formData.append('file_type', 'json');
        formData.append('preserved_name', avatar);
        const imported = await (await fetch(`${baseUrl}/api/characters/import`, { method: 'POST', body: formData })).json();
        sent.push(['/import', imported.character]);

        const hashResponse = await postJson('/api/characters/query', { page: 1, pageSize: 10, want: ['hashes', 'total'] });
        const hashRow = decodeHashRows(await hashResponse.arrayBuffer()).find(r => r.id === avatar);

        expect(sent.map(([route, record]) => [route, characterDigestFavHash(record) % 4294967296]))
            .toEqual(sent.map(([route]) => [route, digestFav]));
        expect(hashRow.favHash).toBe(digestFav);
        expect(sent.map(([route, record]) => [route, record?.fav, record?.data?.extensions?.fav]))
            .toEqual(sent.map(([route]) => [route, expected, expected]));
        expect(digestFav).toBe(expectedDigest(expected));
    }, 30000);
});

describe('a write that stores shallow_json read back re-derives its fav fields from the column when they disagree', () => {
    /** @param {string} id @param {boolean} shallowFav */
    function setShallowFavFields(id, shallowFav) {
        const db = new Database(path.join(directories.root, 'character-metadata.sqlite'));
        try {
            const { shallow_json } = db.prepare('SELECT shallow_json FROM characters WHERE id = ?').get(id);
            const shallow = JSON.parse(shallow_json);
            shallow.fav = shallowFav;
            shallow.data.extensions.fav = shallowFav;
            db.prepare('UPDATE characters SET shallow_json = ? WHERE id = ?').run(JSON.stringify(shallow), id);
        } finally {
            db.close();
        }
    }

    /** @param {string} id @returns {string[] | null} */
    function lastChangeFields(id) {
        const db = new Database(path.join(directories.root, 'character-metadata.sqlite'), { readonly: true });
        try {
            return JSON.parse(db.prepare('SELECT fields FROM changes WHERE id = ? ORDER BY seq DESC LIMIT 1').get(id).fields);
        } finally {
            db.close();
        }
    }

    const WRITERS = [
        ['setCharacterAllowGlobalStyles', ['allow_global_styles'], () => metadataDb.setCharacterAllowGlobalStyles(directories, 'Bob.png', true)],
        ['setCharacterDateAdded', ['date_added'], () => metadataDb.setCharacterDateAdded(directories, 'Bob.png', 1700000000000)],
        ['setCharacterActiveChat', ['active_chat'], () => metadataDb.setCharacterActiveChat(directories, 'Bob.png', 'chat-1')],
    ];

    test.each(WRITERS.flatMap(([name, fields, write]) => [true, false].map(column => [name, column, fields, write])))('%s, column %p: shallow fav fields and digest_fav match the column, and the change entry lists fav', async (_name, column, fields, write) => {
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardWithFav(column));
        setShallowFavFields('Bob.png', !column);
        await write();
        expect(storedFav('Bob.png')).toEqual(storedFavFor(column));
        expect(lastChangeFields('Bob.png')).toEqual([...fields, 'fav']);
    });

    test.each(WRITERS)('%s: shallow fav fields that already match leave fav out of the change entry', async (_name, fields, write) => {
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardWithFav(true));
        await write();
        expect(storedFav('Bob.png')).toEqual(storedFavFor(true));
        expect(lastChangeFields('Bob.png')).toEqual(fields);
    });

    test.each([true, false])('setCharacterFav(%p) on a row whose shallow fav fields disagree with the column stores the new value', async (value) => {
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardWithFav(!value));
        setShallowFavFields('Bob.png', value);
        expect(await metadataDb.setCharacterFav(directories, 'Bob.png', value)).toBe(true);
        expect(storedFav('Bob.png')).toEqual(storedFavFor(value));
        expect(lastChangeFields('Bob.png')).toEqual(['fav']);
    });
});
