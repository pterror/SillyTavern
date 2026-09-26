import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { groupDigestContentHash, groupDigestFavHash } from '../public/scripts/hash-utils.js';

// Every path that writes a group file must leave the group's row (name, fav, digest_fav, digest_content) equal to
// what the file now holds - a stale digest_content is a client cache hit on content that changed.

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

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    metadataDb = await import('../src/character-metadata-db.js');
    groupsModule = await import('../src/endpoints/groups.js');
    searchCoordinator = await import('../src/endpoints/search-index-coordinator.js');
    Database = (await import('better-sqlite3')).default;
    const { router: chatsRouter } = await import('../src/endpoints/chats.js');

    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.user = { directories, profile: { handle: `test-user-${path.basename(directories.root)}` } };
        next();
    });
    app.use('/api/groups', groupsModule.router);
    app.use('/api/chats', chatsRouter);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise(resolve => server.close(resolve)));

beforeEach(() => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-group-file-writers-digest-test-'));
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
    const response = await fetch(`${baseUrl}${urlPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    return response.json();
}

/** @param {string} id @returns {object} */
function readGroupFile(id) {
    return JSON.parse(fs.readFileSync(path.join(directories.groups, `${id}.json`), 'utf8'));
}

/** @param {string} name @param {object} group */
function writeRawFile(name, group) {
    fs.writeFileSync(path.join(directories.groups, name), JSON.stringify(group));
}

/** @param {string} id */
function readRow(id) {
    const dbPath = path.join(directories.root, 'character-metadata.sqlite');
    if (!fs.existsSync(dbPath)) return undefined;
    const db = new Database(dbPath, { readonly: true });
    try {
        return db.prepare('SELECT name, fav, date_added, digest_fav, digest_content FROM groups WHERE id = ?').get(id);
    } finally {
        db.close();
    }
}

/** @param {string} id */
function expectRowMatchesFile(id) {
    const file = readGroupFile(id);
    const row = readRow(id);
    expect(row).toBeDefined();
    expect({
        name: row.name,
        fav: row.fav,
        digestFav: row.digest_fav >>> 0,
        digestContent: row.digest_content >>> 0,
    }).toEqual({
        name: file.name,
        fav: file.fav === true ? 1 : 0,
        digestFav: groupDigestFavHash(file) >>> 0,
        digestContent: groupDigestContentHash(file) >>> 0,
    });
}

/** A group file plus its row, as a /create would leave them. */
async function createGroup(body = {}) {
    return postJson('/api/groups/create', { name: 'Group', members: ['a.png'], ...body });
}

describe('each group file writer updates the row and digests from the file it wrote', () => {
    test('POST /api/groups/create', async () => {
        const created = await createGroup({ fav: 'true' });
        expect(readGroupFile(created.id).fav).toBe(true);
        expectRowMatchesFile(created.id);
    });

    test('POST /api/groups/edit', async () => {
        const created = await createGroup();
        const file = readGroupFile(created.id);
        await postJson('/api/groups/edit', { ...file, name: 'Renamed', members: ['a.png', 'b.png'], fav: 1 });
        expect(readGroupFile(created.id)).toMatchObject({ name: 'Renamed', members: ['a.png', 'b.png'], fav: true });
        expectRowMatchesFile(created.id);
    });

    test('POST /api/groups/save-partial', async () => {
        const created = await createGroup();
        await postJson('/api/groups/save-partial', { id: created.id, props: { members: ['c.png'], fav: true } });
        expect(readGroupFile(created.id)).toMatchObject({ members: ['c.png'], fav: true });
        expectRowMatchesFile(created.id);
    });

    test('POST /api/groups/new-chat', async () => {
        const created = await createGroup();
        const { chat_id: chatId } = await postJson('/api/groups/new-chat', { id: created.id });
        expect(readGroupFile(created.id).chats).toContain(chatId);
        expectRowMatchesFile(created.id);
    });

    test('writeGroupFile()', async () => {
        const created = await createGroup();
        await groupsModule.writeGroupFile(directories, { ...readGroupFile(created.id), members: ['a.png', undefined], fav: 'false' });
        expect(readGroupFile(created.id)).toMatchObject({ members: ['a.png', null], fav: false });
        expectRowMatchesFile(created.id);
    });

    test('POST /api/chats/group/save registering a new chat id on the group', async () => {
        const created = await createGroup();
        await postJson('/api/chats/group/save', {
            id: 'Brand New Chat',
            group_id: created.id,
            chat: [
                { chat_metadata: {}, user_name: 'unused', character_name: 'unused' },
                { name: 'User', is_user: true, is_system: false, mes: 'hi', send_date: 'x', extra: {} },
            ],
        });
        expect(readGroupFile(created.id).chats).toContain('Brand New Chat');
        expectRowMatchesFile(created.id);
    });

    test('migrateGroupChatsMetadataFormat()', async () => {
        const created = await createGroup();
        const legacy = { ...readGroupFile(created.id), chat_metadata: { note: 'x' }, fav: 'true' };
        writeRawFile(`${created.id}.json`, legacy);
        await metadataDb.upsertGroupRow(directories, created.id, legacy.name, { fav: legacy.fav, group: legacy });
        const dateAdded = readRow(created.id).date_added;

        await groupsModule.migrateGroupChatsMetadataFormat([directories]);

        expect(readGroupFile(created.id).chat_metadata).toBeUndefined();
        expect(readGroupFile(created.id).fav).toBe(true);
        expectRowMatchesFile(created.id);
        expect(readRow(created.id).date_added).toBe(dateAdded);
    });

    test('migrateCharacterIds() group member sweep', async () => {
        const cardParser = await import('../src/character-card-parser.js');
        const migration = await import('../src/migrations/migrate-character-ids.js');
        const baseImage = await fs.promises.readFile(path.join(process.cwd(), '..', 'public', 'img', 'ai4.png'));
        const card = {
            name: 'Grace', spec: 'chara_card_v2', spec_version: '2.0',
            data: {
                name: 'Grace', description: '', personality: '', scenario: '', first_mes: '', mes_example: '',
                tags: [], creator: '', character_version: '', creator_notes: '', extensions: { world: '' },
            },
        };
        await fs.promises.writeFile(path.join(directories.characters, 'Grace.png'), cardParser.write(baseImage, JSON.stringify(card)));
        const created = await createGroup({ members: ['Grace.png'], disabled_members: ['Grace.png'] });
        const dateAdded = readRow(created.id).date_added;

        const result = await migration.migrateCharacterIds(directories, { rebuildSearchIndex: false, log: () => {} });
        expect(result.migrated).toBe(1);

        expect(readGroupFile(created.id).members).not.toContain('Grace.png');
        expectRowMatchesFile(created.id);
        expect(readRow(created.id).date_added).toBe(dateAdded);
    });
});

describe('migration writers never create rows or touch a row the file does not back', () => {
    test('migrateGroupChatsMetadataFormat() on a group with no row leaves it rowless (the bootstrap inserts it)', async () => {
        writeRawFile('g1.json', { id: 'g1', name: 'G', members: [], chats: [], chat_metadata: { note: 'x' } });
        await groupsModule.migrateGroupChatsMetadataFormat([directories]);
        expect(readGroupFile('g1').chat_metadata).toBeUndefined();
        expect(readRow('g1')).toBeUndefined();
    });

    test('migrateGroupChatsMetadataFormat() on a file not named after its id rewrites that file and leaves the id\'s row alone', async () => {
        const created = await createGroup();
        const rowBefore = readRow(created.id);
        writeRawFile('stray.json', { ...readGroupFile(created.id), name: 'Stray copy', chat_metadata: { note: 'x' } });

        await groupsModule.migrateGroupChatsMetadataFormat([directories]);

        const stray = JSON.parse(fs.readFileSync(path.join(directories.groups, 'stray.json'), 'utf8'));
        expect(stray.chat_metadata).toBeUndefined();
        expect(stray.name).toBe('Stray copy');
        expect(readRow(created.id)).toEqual(rowBefore);
        expectRowMatchesFile(created.id);
    });
});

describe('a route whose group file write fails answers 500 with a message, and the file is unchanged', () => {
    const FAIL_CLEAR_TRIGGER = 'CREATE TRIGGER inject_failure BEFORE UPDATE OF digest_content ON groups WHEN NEW.digest_content IS NULL BEGIN SELECT RAISE(ABORT, \'injected\'); END;';

    /** @param {string} sql */
    function runRawSql(sql) {
        const db = new Database(path.join(directories.root, 'character-metadata.sqlite'));
        try {
            db.exec(sql);
        } finally {
            db.close();
        }
    }

    async function postRaw(urlPath, body) {
        const response = await fetch(`${baseUrl}${urlPath}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(5000),
        });
        return { status: response.status, body: await response.json().catch(() => null) };
    }

    const ROUTES = [
        ['/api/groups/edit', (id, file) => ({ ...file, name: 'Changed' })],
        ['/api/groups/save-partial', (id) => ({ id, props: { name: 'Changed' } })],
        ['/api/groups/new-chat', (id) => ({ id })],
        ['/api/chats/group/save', (id) => ({
            id: 'Brand New Chat',
            group_id: id,
            chat: [
                { chat_metadata: {}, user_name: 'unused', character_name: 'unused' },
                { name: 'User', is_user: true, is_system: false, mes: 'hi', send_date: 'x', extra: {} },
            ],
        })],
    ];

    test.each(ROUTES)('%s', async (route, makeBody) => {
        const created = await createGroup();
        const before = fs.readFileSync(path.join(directories.groups, `${created.id}.json`), 'utf8');
        runRawSql(FAIL_CLEAR_TRIGGER);

        const result = await postRaw(route, makeBody(created.id, JSON.parse(before)));

        expect(result.status).toBe(500);
        expect(typeof result.body?.error).toBe('string');
        expect(fs.readFileSync(path.join(directories.groups, `${created.id}.json`), 'utf8')).toBe(before);
    }, 30000);

    test('/api/groups/create', async () => {
        fs.chmodSync(directories.groups, 0o555);
        try {
            const result = await postRaw('/api/groups/create', { name: 'New' });
            expect(result.status).toBe(500);
            expect(typeof result.body?.error).toBe('string');
        } finally {
            fs.chmodSync(directories.groups, 0o755);
        }
        expect(fs.readdirSync(directories.groups)).toEqual([]);
    });
});
