import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { groupDigestContentHash } from '../public/scripts/hash-utils.js';

// A new group id is all digits; a legacy group file stores it as a number. Legacy files can also hold numeric
// chat_id/chats entries, which read as their string form.

/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {typeof import('../src/endpoints/groups.js')} */
let groupsModule;
/** @type {typeof import('../src/character-shallow.js')} */
let characterShallow;
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
    characterShallow = await import('../src/character-shallow.js');
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
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-group-id-validation-test-'));
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

/** @returns {Promise<{ status: number, body: any }>} */
async function post(urlPath, body) {
    const response = await fetch(`${baseUrl}${urlPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const text = await response.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, body: parsed };
}

/** @param {string} name @param {object} group */
function writeRawFile(name, group) {
    fs.writeFileSync(path.join(directories.groups, name), JSON.stringify(group));
}

/** @param {string} name */
function readRawFile(name) {
    return JSON.parse(fs.readFileSync(path.join(directories.groups, name), 'utf8'));
}

/** @param {string} id */
function readRow(id) {
    const dbPath = path.join(directories.root, 'character-metadata.sqlite');
    if (!fs.existsSync(dbPath)) return undefined;
    const db = new Database(dbPath, { readonly: true });
    try {
        return db.prepare('SELECT id, name, fav, date_added, digest_content FROM groups WHERE id = ?').get(id);
    } finally {
        db.close();
    }
}

/** @param {string} key */
function readMeta(key) {
    const db = new Database(path.join(directories.root, 'character-metadata.sqlite'), { readonly: true });
    try {
        return db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    } finally {
        db.close();
    }
}

/** A legacy group file: id, chat_id and chats stored as numbers. */
function writeLegacyGroup(id = 777, extra = {}) {
    const group = { id, name: `Legacy ${id}`, members: [], disabled_members: [], chat_id: 5, chats: [5, 'Named chat'], fav: false, ...extra };
    writeRawFile(`${id}.json`, group);
    return group;
}

/** A group created the current way, so its file and row both exist. */
async function createGroup() {
    const { status, body } = await post('/api/groups/create', { name: 'Group', members: [] });
    expect(status).toBe(200);
    return body;
}

// Can't name any group: not a string or an integer, or a string that could escape the groups directory.
const UNUSABLE_IDS = [
    ['an empty string', ''],
    ['a string with a slash', 'a/b'],
    ['a string with a NUL', 'a\u0000b'],
    ['a non-integer number', 1.5],
    ['a negative integer', -1],
    ['an unsafe integer', 2 ** 60],
    ['an array', ['1']],
    ['an object', { id: '1' }],
    ['a boolean', true],
];

// Name a group that may exist, but aren't valid ids for creating one.
const NON_DIGIT_IDS = [
    ['a non-digit string', 'g1'],
    ['a character avatar name', 'Alice.png'],
    ['a digit string with a suffix', '12a'],
    ['a decimal string', '1.5'],
    ['a digit string with whitespace', ' 1'],
    ['a negative number string', '-1'],
];

/** A group whose file and row exist under a non-digit id, as older data can hold. */
async function writeExistingNonDigitGroup(id = 'legacy-group') {
    const group = { id, name: 'Existing', members: [], chats: ['c1'], chat_id: 'c1', fav: false };
    writeRawFile(`${id}.json`, group);
    await metadataDb.upsertGroupRow(directories, id, group.name, { fav: false, group });
    return group;
}

describe('a group route answers 400 for an id that can\'t name a group', () => {
    for (const route of ['/api/groups/edit', '/api/groups/save-partial', '/api/groups/new-chat', '/api/groups/delete']) {
        test.each(UNUSABLE_IDS)(`${route} rejects %s`, async (_label, id) => {
            const created = await createGroup();
            const before = readRawFile(`${created.id}.json`);
            const { status } = await post(route, { ...before, id, props: { name: 'Changed' } });
            expect(status).toBe(400);
            expect(readRawFile(`${created.id}.json`)).toEqual(before);
            expect(fs.readdirSync(directories.groups)).toEqual([`${created.id}.json`]);
        });
    }
});

describe('creating a group through /api/groups/edit needs a digit id', () => {
    test.each(NON_DIGIT_IDS)('rejects %s when no group has it', async (_label, id) => {
        const { status } = await post('/api/groups/edit', { id, name: 'New', members: [], chats: [] });
        expect(status).toBe(400);
        expect(fs.readdirSync(directories.groups)).toEqual([]);
        expect(readRow(id)).toBeUndefined();
    });
});

describe('an existing group keeps working whatever its id', () => {
    test('/api/groups/edit, /save-partial, /new-chat, /batch and /delete on a non-digit group', async () => {
        await writeExistingNonDigitGroup('legacy-group');

        expect((await post('/api/groups/edit', { ...readRawFile('legacy-group.json'), name: 'Edited' })).status).toBe(200);
        expect(readRawFile('legacy-group.json').name).toBe('Edited');

        expect((await post('/api/groups/save-partial', { id: 'legacy-group', props: { name: 'Renamed' } })).status).toBe(200);
        expect(readRawFile('legacy-group.json').name).toBe('Renamed');

        const newChat = await post('/api/groups/new-chat', { id: 'legacy-group' });
        expect(newChat.status).toBe(200);
        expect(readRawFile('legacy-group.json').chats).toContain(newChat.body.chat_id);

        const batch = await post('/api/groups/batch', { ids: ['legacy-group'] });
        expect(batch.status).toBe(200);
        expect(batch.body.map(g => g.id)).toEqual(['legacy-group']);

        expect((await post('/api/groups/delete', { id: 'legacy-group' })).status).toBe(200);
        expect(fs.existsSync(path.join(directories.groups, 'legacy-group.json'))).toBe(false);
        expect(readRow('legacy-group')).toBeUndefined();
    });

    test('/api/groups/edit on a group with only a file', async () => {
        writeRawFile('file-only.json', { id: 'file-only', name: 'File only', members: [], chats: [] });
        expect((await post('/api/groups/edit', { id: 'file-only', name: 'Edited', members: [], chats: [] })).status).toBe(200);
        expect(readRawFile('file-only.json').name).toBe('Edited');
        expect(readRow('file-only')).toMatchObject({ name: 'Edited' });
    });

    test('/api/groups/edit on a group with only a row', async () => {
        await metadataDb.upsertGroupRow(directories, 'row-only', 'Row only', { fav: false, group: {} });
        expect((await post('/api/groups/edit', { id: 'row-only', name: 'Edited', members: [], chats: [] })).status).toBe(200);
        expect(readRawFile('row-only.json').name).toBe('Edited');
    });
});

describe('/api/groups/batch skips an id it can\'t serve instead of failing the batch', () => {
    test.each([...UNUSABLE_IDS, ['an unknown non-digit id', 'no-such-group'], ['an unknown digit id', '424242']])('skips %s', async (_label, id) => {
        const created = await createGroup();
        await writeExistingNonDigitGroup('legacy-group');
        const { status, body } = await post('/api/groups/batch', { ids: [created.id, id, 'legacy-group'] });
        expect(status).toBe(200);
        expect(body.map(g => g.id)).toEqual([created.id, 'legacy-group']);
    });
});

describe('every group route accepts a digit string and an integer number', () => {
    test.each([['a digit string', '123'], ['an integer number', 123]])('/api/groups/edit with %s writes <id>.json and its row under the string id', async (_label, id) => {
        const { status } = await post('/api/groups/edit', { id, name: 'Edited', members: [], chat_id: 4, chats: [4], fav: false });
        expect(status).toBe(200);
        expect(readRawFile('123.json')).toMatchObject({ id: '123', chat_id: '4', chats: ['4'] });
        const row = readRow('123');
        expect(row?.id).toBe('123');
        expect(row.digest_content >>> 0).toBe(groupDigestContentHash(readRawFile('123.json')) >>> 0);
    });

    test.each([['a digit string', String], ['an integer number', Number]])('/api/groups/save-partial, /new-chat, /batch and /delete with %s', async (_label, as) => {
        const created = await createGroup();
        const id = as(created.id);

        expect((await post('/api/groups/save-partial', { id, props: { name: 'Renamed' } })).status).toBe(200);
        expect(readRawFile(`${created.id}.json`)).toMatchObject({ id: created.id, name: 'Renamed' });

        const newChat = await post('/api/groups/new-chat', { id });
        expect(newChat.status).toBe(200);
        expect(readRawFile(`${created.id}.json`).chats).toContain(newChat.body.chat_id);

        const batch = await post('/api/groups/batch', { ids: [id] });
        expect(batch.status).toBe(200);
        expect(batch.body.map(g => g.id)).toEqual([created.id]);

        expect((await post('/api/groups/delete', { id })).status).toBe(200);
        expect(fs.existsSync(path.join(directories.groups, `${created.id}.json`))).toBe(false);
        expect(readRow(created.id)).toBeUndefined();
    });
});

describe('the groups bootstrap scan', () => {
    test('inserts a row for a legacy numeric-id group, under the string id, without rewriting its file', async () => {
        const legacy = writeLegacyGroup(777);
        await metadataDb.bootstrapGroupsIfNeeded(directories);

        const row = readRow('777');
        expect(row).toMatchObject({ id: '777', name: 'Legacy 777' });
        expect(readRawFile('777.json')).toEqual(legacy);
    });

    test('its digest_content matches the group /api/groups/batch serves', async () => {
        writeLegacyGroup(777);
        await metadataDb.bootstrapGroupsIfNeeded(directories);

        const { status, body } = await post('/api/groups/batch', { ids: ['777'] });
        expect(status).toBe(200);
        expect(body).toHaveLength(1);
        expect(body[0]).toMatchObject({ id: '777', chat_id: '5', chats: ['5', 'Named chat'] });
        expect(readRow('777').digest_content >>> 0).toBe(groupDigestContentHash(body[0]) >>> 0);
    });

    test('still inserts rows for a non-digit id and for a file not named after its id', async () => {
        writeRawFile('g1.json', { id: 'g1', name: 'Non-digit id', members: [], chats: [] });
        writeRawFile('stray.json', { id: '888', name: 'Stray', members: [], chats: [] });
        await metadataDb.bootstrapGroupsIfNeeded(directories);

        expect(readRow('g1')).toMatchObject({ name: 'Non-digit id' });
        expect(readRow('888')).toMatchObject({ name: 'Stray' });
    });
});

describe('the numeric-id group recovery pass', () => {
    /** A store whose bootstrap already ran and skipped legacy numeric-id groups. */
    async function bootstrappedStore() {
        await metadataDb.bootstrapGroupsIfNeeded(directories);
        expect(readMeta('groups_bootstrap_completed')).toBeDefined();
    }

    test('inserts a missing row for a legacy numeric-id group, without rewriting its file', async () => {
        await bootstrappedStore();
        const legacy = writeLegacyGroup(777);

        await metadataDb.recoverNumericIdGroupsIfNeeded(directories);

        expect(readRow('777')).toMatchObject({ id: '777', name: 'Legacy 777' });
        expect(readRow('777').digest_content >>> 0).toBe(groupDigestContentHash({ ...legacy, id: '777', chat_id: '5', chats: ['5', 'Named chat'] }) >>> 0);
        expect(readRawFile('777.json')).toEqual(legacy);
    });

    test('never touches an existing row', async () => {
        await bootstrappedStore();
        writeLegacyGroup(777);
        await metadataDb.upsertGroupRow(directories, '777', 'Row name', { fav: true, group: { name: 'Row name' } });
        const before = readRow('777');

        await metadataDb.recoverNumericIdGroupsIfNeeded(directories);

        expect(readRow('777')).toEqual(before);
    });

    test('inserts only what the bootstrap skipped: a numeric id, in whichever file holds it', async () => {
        await bootstrappedStore();
        writeRawFile('999.json', { id: '999', name: 'String id', members: [], chats: [] });
        writeRawFile('stray.json', { id: 888, name: 'Stray', members: [], chats: [] });

        await metadataDb.recoverNumericIdGroupsIfNeeded(directories);

        expect(readRow('999')).toBeUndefined();
        expect(readRow('888')).toMatchObject({ name: 'Stray' });
    });

    test('runs once, under its own flag', async () => {
        await bootstrappedStore();
        writeLegacyGroup(777);
        await metadataDb.recoverNumericIdGroupsIfNeeded(directories);
        expect(readMeta(metadataDb.GROUP_NUMERIC_ID_RECOVERY_FLAG)).toBeDefined();

        writeLegacyGroup(778);
        await metadataDb.recoverNumericIdGroupsIfNeeded(directories);

        expect(readRow('777')).toBeDefined();
        expect(readRow('778')).toBeUndefined();
    });

    test('runs in the store\'s migration worker, after its boot chain', async () => {
        await bootstrappedStore();
        writeLegacyGroup(777);
        metadataDb.disposeMetadataStores();

        await Promise.all(await metadataDb.initializeMetadataStores([directories]));
        expect(readRow('777')).toBeUndefined();

        const { createMetadataMigrationCoordinator } = await import('../src/metadata-migration-coordinator.js');
        await createMetadataMigrationCoordinator().start(directories);

        expect(readRow('777')).toMatchObject({ id: '777' });
    });
});

describe('each group file read returns the id, chat_id and chats as strings', () => {
    const NORMALIZED = { id: '777', chat_id: '5', chats: ['5', 'Named chat'] };

    test('readGroupFile()', () => {
        writeLegacyGroup(777);
        expect(groupsModule.readGroupFile(directories, '777')).toMatchObject(NORMALIZED);
    });

    test('resolveGroupOwner() by chat id', () => {
        writeLegacyGroup(777);
        expect(characterShallow.resolveGroupOwner(directories.groups, { chatId: '5' })).toEqual({ id: '777', chats: ['5', 'Named chat'] });
    });

    test('resolveGroupOwner() by a numeric group id', () => {
        writeLegacyGroup(777);
        expect(characterShallow.resolveGroupOwner(directories.groups, { groupId: 777 })).toEqual({ id: '777', chats: ['5', 'Named chat'] });
    });

    test('getGroupsData() and /api/groups/all', async () => {
        writeLegacyGroup(777);
        expect(groupsModule.getGroupsData(directories).find(g => g.name === 'Legacy 777')).toMatchObject(NORMALIZED);
        const { status, body } = await post('/api/groups/all', {});
        expect(status).toBe(200);
        expect(body.find(g => g.name === 'Legacy 777')).toMatchObject(NORMALIZED);
    });

    test('getGroupsByIds()', () => {
        writeLegacyGroup(777);
        expect(groupsModule.getGroupsByIds(directories, ['777'])['777']).toMatchObject(NORMALIZED);
    });

    test('migrateCharacterIds() group member sweep writes the group back normalized', async () => {
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
        const legacy = writeLegacyGroup(777, { members: ['Grace.png'] });
        await metadataDb.upsertGroupRow(directories, '777', legacy.name, { fav: false, group: legacy });

        const result = await migration.migrateCharacterIds(directories, { rebuildSearchIndex: false, log: () => {} });
        expect(result.migrated).toBe(1);

        const file = readRawFile('777.json');
        expect(file.members).not.toContain('Grace.png');
        expect(file).toMatchObject(NORMALIZED);
        expect(readRow('777').digest_content >>> 0).toBe(groupDigestContentHash(file) >>> 0);
    });
});

describe('each existing write of a legacy group stores chat_id and chats as strings', () => {
    const NORMALIZED = { id: '777', chat_id: '5', chats: ['5', 'Named chat'] };

    test('/api/groups/save-partial', async () => {
        writeLegacyGroup(777);
        expect((await post('/api/groups/save-partial', { id: '777', props: { name: 'Renamed' } })).status).toBe(200);
        expect(readRawFile('777.json')).toMatchObject({ ...NORMALIZED, name: 'Renamed' });
    });

    test('/api/groups/save-partial with numeric chat_id and chats in props', async () => {
        const created = await createGroup();
        expect((await post('/api/groups/save-partial', { id: created.id, props: { chat_id: 9, chats: [9, 10] } })).status).toBe(200);
        expect(readRawFile(`${created.id}.json`)).toMatchObject({ chat_id: '9', chats: ['9', '10'] });
    });

    test('/api/groups/new-chat', async () => {
        writeLegacyGroup(777);
        const { status, body } = await post('/api/groups/new-chat', { id: '777' });
        expect(status).toBe(200);
        expect(readRawFile('777.json')).toMatchObject({ id: '777', chat_id: body.chat_id, chats: ['5', 'Named chat', body.chat_id] });
    });

    test('/api/chats/group/save registering a new chat id', async () => {
        writeLegacyGroup(777);
        const { status } = await post('/api/chats/group/save', {
            id: 'Brand New Chat',
            group_id: '777',
            chat: [
                { chat_metadata: {}, user_name: 'unused', character_name: 'unused' },
                { name: 'User', is_user: true, is_system: false, mes: 'hi', send_date: 'x', extra: {} },
            ],
        });
        expect(status).toBe(200);
        expect(readRawFile('777.json')).toMatchObject({ ...NORMALIZED, chats: ['5', 'Named chat', 'Brand New Chat'] });
    });

    test('/api/chats/group/save for a chat already listed only as a number does not add it again', async () => {
        writeLegacyGroup(777);
        const before = readRawFile('777.json');
        const { status } = await post('/api/chats/group/save', {
            id: '5',
            group_id: '777',
            chat: [
                { chat_metadata: {}, user_name: 'unused', character_name: 'unused' },
                { name: 'User', is_user: true, is_system: false, mes: 'hi', send_date: 'x', extra: {} },
            ],
        });
        expect(status).toBe(200);
        expect(readRawFile('777.json')).toEqual(before);
    });

    test('migrateGroupChatsMetadataFormat()', async () => {
        writeLegacyGroup(777, { chat_metadata: {} });
        await groupsModule.migrateGroupChatsMetadataFormat([directories]);
        const file = readRawFile('777.json');
        expect(file.chat_metadata).toBeUndefined();
        expect(file).toMatchObject(NORMALIZED);
    });
});
