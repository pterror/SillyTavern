import { describe, test, expect, jest, beforeAll, afterAll } from '@jest/globals';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The real Worker, counting every one constructed, so the read-only tests can show none was spawned.
/** @type {string[]} */
const spawnedWorkers = [];
const actualWorkerThreads = /** @type {typeof import('node:worker_threads')} */ (jest.requireActual('node:worker_threads'));
class CountingWorker extends actualWorkerThreads.Worker {
    /** @param {ConstructorParameters<typeof actualWorkerThreads.Worker>} args */
    constructor(...args) {
        super(...args);
        spawnedWorkers.push(String(args[0]));
    }
}
jest.unstable_mockModule('node:worker_threads', () => ({
    ...actualWorkerThreads,
    default: { ...actualWorkerThreads, Worker: CountingWorker },
    Worker: CountingWorker,
}));

/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {typeof import('../src/endpoints/search-index-coordinator.js')} */
let searchCoordinator;
/** @type {typeof import('../src/read-only-mode.js')} */
let readOnlyMode;
/** @type {import('node:http').Server} */
let server;
let baseUrl;
/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

const DB_FILE = 'character-metadata.sqlite';
const INDEX_DIRS = ['search-index/characters-tantivy', 'search-index/groups-tantivy'];

const NO_SEARCH_QUERY = { filter: { includeGroups: true }, sort: { field: 'name', order: 'asc' }, page: 1, pageSize: 10 };
const SEARCH_QUERY = { filter: { includeGroups: true, search: 'vampire' }, sort: { field: 'name', order: 'asc' }, page: 1, pageSize: 10 };

async function postQuery(body) {
    const response = await fetch(`${baseUrl}/api/characters/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
}

/** @param {{ rows: { type: string, item: { name: string } }[] }} body */
function typedNames(body) {
    return body.rows.map(row => [row.type, row.item.name]);
}

/**
 * Every file under `dir`, by path relative to it: size, mtime and content hash.
 * @param {string} dir
 * @returns {Record<string, { size: number, mtimeMs: number, sha256: string }>}
 */
function snapshotDir(dir) {
    /** @type {Record<string, { size: number, mtimeMs: number, sha256: string }>} */
    const files = {};
    for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const filePath = path.join(entry.parentPath, entry.name);
        files[path.relative(dir, filePath)] = snapshotFile(filePath);
    }
    return files;
}

/** @param {string} filePath */
function snapshotFile(filePath) {
    const stat = fs.statSync(filePath);
    return { size: stat.size, mtimeMs: stat.mtimeMs, sha256: crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex') };
}

/**
 * @param {string} avatar
 * @param {string} description
 */
async function seedCharacter(avatar, description) {
    const cardParser = await import('../src/character-card-parser.js');
    const baseImage = await fs.promises.readFile(path.join(process.cwd(), '..', 'public', 'img', 'ai4.png'));
    const name = avatar.replace(/\.png$/, '');
    const card = {
        name,
        fav: false,
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name,
            description, personality: '', scenario: '', first_mes: '', mes_example: '',
            tags: [], creator: '', character_version: '', creator_notes: '',
            extensions: { fav: false, world: '' },
        },
    };
    const buffer = cardParser.write(baseImage, JSON.stringify(card));
    await fs.promises.writeFile(path.join(directories.characters, avatar), buffer);
    await metadataDb.upsertCharacterFromWrite(directories, avatar, JSON.stringify(card));
}

/**
 * @param {string} id
 * @param {string} name
 * @param {string[]} members
 */
async function seedGroup(id, name, members) {
    const group = { id, name, members, chats: [], fav: false };
    fs.writeFileSync(path.join(directories.groups, `${id}.json`), JSON.stringify(group));
    await metadataDb.upsertGroupRow(directories, id, name, { fav: false });
}

/**
 * The normal (not read-only) code builds a data dir: a metadata db with two characters and a group, and both
 * search indexes, built by a search index worker on the first search. Then everything is closed, and read-only
 * mode is turned on.
 */
beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    const { router } = await import('../src/endpoints/characters.js');
    metadataDb = await import('../src/character-metadata-db.js');
    searchCoordinator = await import('../src/endpoints/search-index-coordinator.js');
    readOnlyMode = await import('../src/read-only-mode.js');

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-read-only-mode-test-'));
    directories = /** @type {any} */ ({
        root,
        characters: path.join(root, 'characters'),
        chats: path.join(root, 'chats'),
        groups: path.join(root, 'groups'),
        groupChats: path.join(root, 'groupChats'),
    });
    for (const dir of [directories.characters, directories.chats, directories.groups, directories.groupChats]) {
        fs.mkdirSync(dir, { recursive: true });
    }

    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.user = { directories, profile: { handle: 'read-only-test-user' } };
        next();
    });
    app.use('/api/characters', router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;

    await seedCharacter('Alice.png', 'a quiet librarian');
    await seedCharacter('Vlad.png', 'an old vampire');
    await seedGroup('g1', 'Vampire Coven', ['Vlad.png']);

    // The first search spawns the handle's search index worker, which builds both indexes.
    const built = await postQuery(SEARCH_QUERY);
    if (built.status !== 200 || JSON.stringify(typedNames(built.body)) !== JSON.stringify([['group', 'Vampire Coven'], ['character', 'Vlad']])) {
        throw new Error(`setup: the normal code's search answered ${built.status} ${JSON.stringify(built.body)}`);
    }
    if (spawnedWorkers.length === 0) {
        throw new Error('setup: the normal code spawned no search index worker');
    }

    await searchCoordinator.disposeSearchWorkers();
    metadataDb.disposeMetadataStores();
    for (const dir of INDEX_DIRS) {
        if (!fs.existsSync(path.join(directories.root, dir, 'meta.json'))) {
            throw new Error(`setup: the normal code built no index at ${dir}`);
        }
    }

    readOnlyMode.enableReadOnlyMode();
}, 30000);

afterAll(async () => {
    await searchCoordinator.disposeSearchWorkers();
    metadataDb.disposeMetadataStores();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(directories.root, { recursive: true, force: true });
});

describe('read-only mode: POST /api/characters/query against an existing library', () => {
    /** @type {ReturnType<typeof snapshotFile>} */
    let dbBefore;
    /** @type {Record<string, ReturnType<typeof snapshotDir>>} */
    let indexesBefore;
    let workersBefore = 0;
    /** @type {{ status: number, body: any }} */
    let noSearch;
    /** @type {{ status: number, body: any }} */
    let withSearch;

    beforeAll(async () => {
        dbBefore = snapshotFile(path.join(directories.root, DB_FILE));
        indexesBefore = Object.fromEntries(INDEX_DIRS.map(dir => [dir, snapshotDir(path.join(directories.root, dir))]));
        workersBefore = spawnedWorkers.length;

        noSearch = await postQuery(NO_SEARCH_QUERY);
        withSearch = await postQuery(SEARCH_QUERY);
    }, 30000);

    test('a query with no search term returns the expected rows', () => {
        expect(noSearch.status).toBe(200);
        expect(noSearch.body.total).toBe(3);
        expect(typedNames(noSearch.body)).toEqual([['character', 'Alice'], ['group', 'Vampire Coven'], ['character', 'Vlad']]);
    });

    test('a query with a search term reads both search indexes and returns the expected rows', () => {
        expect(withSearch.status).toBe(200);
        expect(withSearch.body.searchBackend).toBe('tantivy');
        expect(withSearch.body.total).toBe(2);
        expect(typedNames(withSearch.body)).toEqual([['group', 'Vampire Coven'], ['character', 'Vlad']]);
    });

    // A write still in -wal shows up there, and a checkpointed one in the main file. -shm isn't checked: a
    // read-only connection still keeps its read locks there.
    test('the db file is unchanged and its -wal is empty', () => {
        expect(snapshotFile(path.join(directories.root, DB_FILE))).toEqual(dbBefore);
        expect(fs.statSync(path.join(directories.root, `${DB_FILE}-wal`)).size).toBe(0);
    });

    test('both search index dirs are unchanged', () => {
        for (const dir of INDEX_DIRS) {
            expect(snapshotDir(path.join(directories.root, dir))).toEqual(indexesBefore[dir]);
        }
    });

    test('no worker was spawned', () => {
        expect(spawnedWorkers.slice(workersBefore)).toEqual([]);
    });

    // The boot chain is reported finished, so start() would spawn the worker if read-only mode didn't stop it.
    test('the metadata migration coordinator starts no migration worker', async () => {
        const { createMetadataMigrationCoordinator } = await import('../src/metadata-migration-coordinator.js');
        const spawnWorker = jest.fn();
        const coordinator = createMetadataMigrationCoordinator({ spawnWorker, waitForBootChain: async () => true });
        await coordinator.start(directories);
        expect(spawnWorker).not.toHaveBeenCalled();
    });

    test('a write through the metadata store fails with SQLite\'s read-only error', async () => {
        await expect(metadataDb.setMetaValue(directories, 'read-only-mode-test', 'x')).rejects.toMatchObject({ code: 'SQLITE_READONLY' });
    });

    test('trySetMetaValues() throws SQLite\'s read-only error', async () => {
        await expect(metadataDb.trySetMetaValues(directories, { 'read-only-mode-test': 'x' })).rejects.toMatchObject({ code: 'SQLITE_READONLY' });
    });

    test('initializeMetadataStores() starts no boot chain and writes nothing', async () => {
        expect(await metadataDb.initializeMetadataStores([directories])).toEqual([]);
        expect(await metadataDb.waitForMetadataBootChain(directories)).toBe(false);
        expect(snapshotFile(path.join(directories.root, DB_FILE))).toEqual(dbBefore);
        expect(fs.statSync(path.join(directories.root, `${DB_FILE}-wal`)).size).toBe(0);
    });

    test('a characters-only search has a token, from the index\'s persisted cursors, that a repeat answers unchanged', async () => {
        const request = { ...SEARCH_QUERY, filter: { search: 'vampire' } };
        const first = await postQuery(request);
        expect(first.status).toBe(200);
        expect(first.body.rows.map(row => row.name)).toEqual(['Vlad']);
        expect(typeof first.body.token).toBe('string');
        const again = await postQuery({ ...request, ifToken: first.body.token });
        expect(again.body).toEqual({ seq: first.body.seq, token: first.body.token, unchanged: true });
    });

    test.each([['no search', NO_SEARCH_QUERY], ['a search', SEARCH_QUERY]])('a query with groups and %s has a token that a repeat answers unchanged', async (_, request) => {
        const first = await postQuery(request);
        expect(first.status).toBe(200);
        expect(typeof first.body.token).toBe('string');
        const again = await postQuery({ ...request, ifToken: first.body.token });
        expect(again.body).toEqual({ seq: first.body.seq, token: first.body.token, unchanged: true });
    });

    test('the characters reader\'s position is the cursors and retry counter the normal code persisted for the index', async () => {
        const seq = await metadataDb.getMetaValue(directories, 'tantivy_char_index_seq');
        const tagNameSeq = await metadataDb.getMetaValue(directories, 'tantivy_char_index_tag_name_change_seq');
        const retrySeq = await metadataDb.getMetaValue(directories, 'tantivy_char_index_retry_seq');
        expect(retrySeq).not.toBeNull();
        const reader = await searchCoordinator.getSearchIndex('read-only-test-user', directories, 'characters');
        expect(reader.position).toEqual({ seq: Number(seq), tagNameSeq: Number(tagNameSeq), retrySeq: Number(retrySeq) });
    });

    test('the groups reader\'s position is the groups version the normal code persisted for the index', async () => {
        const version = await metadataDb.getMetaValue(directories, 'tantivy_group_index_version');
        expect(Number(version)).toBeGreaterThan(0);
        expect(Number(version)).toBe(await metadataDb.getGroupsVersion(directories));
        const reader = await searchCoordinator.getSearchIndex('read-only-test-user', directories, 'groups');
        expect(reader.position).toEqual({ version: Number(version) });
    });

    // A group file that fails to parse leaves the pass's done flag unwritten, so the pass writes nothing and
    // reaches its closing checkpoint. Another connection's write sits in the -wal, which a read-only connection
    // can't checkpoint (SQLITE_IOERR_WRITE). Last in this block: that write changes the db.
    test('a migration pass that writes nothing skips its checkpoint', async () => {
        const { getBetterSqlite3 } = await import('../src/endpoints/native-sqlite.js');
        const DatabaseCtor = await getBetterSqlite3();
        const writer = new DatabaseCtor(path.join(directories.root, DB_FILE));
        const brokenGroupFile = path.join(directories.groups, 'broken.json');
        try {
            writer.prepare('INSERT INTO meta (key, value) VALUES (\'read-only-mode-test\', \'x\')').run();
            const dbWritten = snapshotFile(path.join(directories.root, DB_FILE));
            const walWritten = snapshotFile(path.join(directories.root, `${DB_FILE}-wal`));
            expect(walWritten.size).toBeGreaterThan(0);
            fs.writeFileSync(brokenGroupFile, '{');

            await expect(metadataDb.recoverNumericIdGroupsIfNeeded(directories)).resolves.toEqual({ batches: 1, rowsChanged: 0 });
            expect(snapshotFile(path.join(directories.root, DB_FILE))).toEqual(dbWritten);
            expect(snapshotFile(path.join(directories.root, `${DB_FILE}-wal`))).toEqual(walWritten);
        } finally {
            fs.rmSync(brokenGroupFile, { force: true });
            writer.close();
        }
    });
});
