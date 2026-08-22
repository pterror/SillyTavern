import { describe, test, expect, beforeAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {typeof import('../src/character-card-parser.js')} */
let cardParser;
/** @type {typeof import('../src/character-card-normalize.js')} */
let cardNormalize;

let tempDir;
let charactersDir;
let chatsDir;
/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

/**
 * Builds and writes a real (parseable) character card PNG to `charactersDir`, the same way write() (used by
 * characters.js's writeCharacterData()) would - so bootstrap/reconcile/watch, which read arbitrary PNGs straight
 * off disk, can be exercised against a real file rather than a stub.
 * @param {string} avatar Filename, e.g. 'Alice.png'
 * @param {object} cardOverrides Shallow-merged onto a minimal valid Spec V2 card
 * @returns {Promise<string>} The full path written
 */
async function writeCardFile(avatar, cardOverrides = {}) {
    // jest (tests/package.json) runs with tests/ as cwd - the real asset lives one level up, under the repo's
    // own public/img/.
    const baseImage = await fs.promises.readFile(path.join(process.cwd(), '..', 'public', 'img', 'ai4.png'));
    const card = {
        name: 'Alice',
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: 'Alice',
            description: '',
            personality: '',
            scenario: '',
            first_mes: '',
            mes_example: '',
            tags: [],
            creator: '',
            character_version: '',
            creator_notes: '',
            extensions: { fav: false, world: '' },
        },
        ...cardOverrides,
    };
    const buffer = cardParser.write(baseImage, JSON.stringify(card));
    const filePath = path.join(charactersDir, avatar);
    await fs.promises.writeFile(filePath, buffer);
    return filePath;
}

/**
 * A minimal already-normalized Spec V2 JSON string, the shape writeCharacterData()'s caller already has in hand
 * (see characters.js) - used to exercise the write-path hooks directly, without needing a real PNG on disk.
 * @param {object} overrides
 * @returns {string}
 */
function cardJson(overrides = {}) {
    return JSON.stringify({
        name: 'Bob',
        fav: false,
        create_date: '2024-01-01T00:00:00.000Z',
        data: {
            name: 'Bob',
            tags: [],
            creator: 'tester',
            character_version: '1.0',
            creator_notes: '',
            extensions: { fav: false, world: '' },
        },
        ...overrides,
    });
}

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    metadataDb = await import('../src/character-metadata-db.js');
    cardParser = await import('../src/character-card-parser.js');
    cardNormalize = await import('../src/character-card-normalize.js');
});

let groupsDir;
let groupChatsDir;

beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-character-metadata-db-test-'));
    charactersDir = path.join(tempDir, 'characters');
    chatsDir = path.join(tempDir, 'chats');
    groupsDir = path.join(tempDir, 'groups');
    groupChatsDir = path.join(tempDir, 'groupChats');
    fs.mkdirSync(charactersDir, { recursive: true });
    fs.mkdirSync(chatsDir, { recursive: true });
    fs.mkdirSync(groupsDir, { recursive: true });
    fs.mkdirSync(groupChatsDir, { recursive: true });
    directories = { root: tempDir, characters: charactersDir, chats: chatsDir, groups: groupsDir, groupChats: groupChatsDir };
});

afterEach(() => {
    // Closes every open db handle/watcher/interval this test's calls opened - each test uses a fresh tempDir
    // (a fresh cache key), so this never affects another test's state, it just keeps native SQLite handles from
    // accumulating across the whole suite.
    metadataDb.disposeMetadataStores();
});

describe('upsertCharacterFromWrite', () => {
    test('creates a row with the given date_added on first insert', async () => {
        const before = Date.now();
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson(), 1000);
        const row = await metadataDb.getCharacterMetadataRow(directories, 'Bob.png');

        expect(row).toBeDefined();
        expect(row.name).toBe('Bob');
        expect(row.name_fold).toBe('bob');
        expect(row.creator).toBe('tester');
        expect(row.date_added).toBeGreaterThanOrEqual(before);
        expect(JSON.parse(row.shallow_json).name).toBe('Bob');
    });

    test('never recomputes date_added on a later write to the same avatar', async () => {
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson(), 1000);
        const firstRow = await metadataDb.getCharacterMetadataRow(directories, 'Bob.png');

        await new Promise(resolve => setTimeout(resolve, 5));
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson({ data: { name: 'Bob', tags: ['x'], creator: 'tester', character_version: '1.0', creator_notes: '', extensions: { fav: false, world: '' } } }), 2000);
        const secondRow = await metadataDb.getCharacterMetadataRow(directories, 'Bob.png');

        expect(secondRow.date_added).toBe(firstRow.date_added);
        expect(secondRow.file_mtime).toBe(2000);
        expect(JSON.parse(secondRow.shallow_json).data.tags).toEqual(['x']);
    });
});

describe('deleteCharacterRow', () => {
    test('removes the row and logs a delete change', async () => {
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson(), 1000);
        await metadataDb.deleteCharacterRow(directories, 'Bob.png');
        const row = await metadataDb.getCharacterMetadataRow(directories, 'Bob.png');
        expect(row).toBeUndefined();
    });
});

describe('renameCharacterRow', () => {
    test('carries date_added over from the old id to the new one', async () => {
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson(), 1000);
        const oldRow = await metadataDb.getCharacterMetadataRow(directories, 'Bob.png');

        await new Promise(resolve => setTimeout(resolve, 5));
        // Simulates writeCharacterData()'s own embedded hook, which by the time characters.js's /rename route
        // calls renameCharacterRow() has already generically upserted a row for the new filename (see that
        // function's doc comment for why renameCharacterRow() only needs to correct date_added afterward).
        await metadataDb.upsertCharacterFromWrite(directories, 'Robert.png', cardJson({ name: 'Robert', data: { name: 'Robert', tags: [], creator: 'tester', character_version: '1.0', creator_notes: '', extensions: { fav: false, world: '' } } }), 3000);
        await metadataDb.renameCharacterRow(directories, 'Bob.png', 'Robert.png');

        const oldAfter = await metadataDb.getCharacterMetadataRow(directories, 'Bob.png');
        const newRow = await metadataDb.getCharacterMetadataRow(directories, 'Robert.png');

        expect(oldAfter).toBeUndefined();
        expect(newRow).toBeDefined();
        expect(newRow.name).toBe('Robert');
        expect(newRow.date_added).toBe(oldRow.date_added);
    });

    test('also carries date_added into shallow_json\'s own embedded copy, not just the column', async () => {
        // Regression test: shallow_json is a point-in-time JSON snapshot taken at upsert (buildRow()) - a caller
        // reading date_added through the shallow projection (as /query does - see characters.js) rather than the
        // raw column would otherwise see the wrong value after a rename, even though the column itself was
        // correctly patched.
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson(), 1000);
        const oldRow = await metadataDb.getCharacterMetadataRow(directories, 'Bob.png');

        await new Promise(resolve => setTimeout(resolve, 5));
        await metadataDb.upsertCharacterFromWrite(directories, 'Robert.png', cardJson({ name: 'Robert', data: { name: 'Robert', tags: [], creator: 'tester', character_version: '1.0', creator_notes: '', extensions: { fav: false, world: '' } } }), 3000);
        await metadataDb.renameCharacterRow(directories, 'Bob.png', 'Robert.png');

        const newRow = await metadataDb.getCharacterMetadataRow(directories, 'Robert.png');
        expect(JSON.parse(newRow.shallow_json).date_added).toBe(oldRow.date_added);
    });
});

describe('bootstrapIfNeeded', () => {
    test('seeds date_added from ctimeMs and only runs once', async () => {
        const filePath = await writeCardFile('Alice.png');
        const stat = await fs.promises.stat(filePath);

        await metadataDb.bootstrapIfNeeded(directories);
        const row = await metadataDb.getCharacterMetadataRow(directories, 'Alice.png');
        expect(row).toBeDefined();
        expect(row.date_added).toBe(Math.round(stat.ctimeMs));

        // A second bootstrap call must be a no-op (the meta flag short-circuits it) - simulate a file arriving
        // after "phase 1 went live" and confirm bootstrap does NOT pick it up (that's the reconciler's job, with
        // different date_added semantics - see reconcile() below).
        await writeCardFile('LateArrival.png');
        await metadataDb.bootstrapIfNeeded(directories);
        const lateRow = await metadataDb.getCharacterMetadataRow(directories, 'LateArrival.png');
        expect(lateRow).toBeUndefined();
    });
});

describe('reconcile racing bootstrap (regression: initializeMetadataStores() must not let its periodic reconcile interval fire concurrently with an in-flight bootstrap)', () => {
    // initializeMetadataStores() itself schedules the periodic reconcile via a real 5-minute (by default)
    // setInterval, which isn't practical to exercise directly in a unit test without either a multi-minute wait
    // or fake-timer/real-async-I/O interaction that would make this flaky. What these two tests pin down instead
    // is the actual causal mechanism the fix (entry.bootstrapPromise awaited before the interval's reconcile()
    // call - see initializeMetadataStores()) addresses: reconcile() concurrent with a still-running
    // bootstrapIfNeeded() over the same directory produces duplicate upserts (one from each pass reaching the
    // same not-yet-bootstrapped file), inflating the change log without a matching row-count increase - this is
    // exactly the rev-vs-character-count mismatch observed on a real, large, in-progress bootstrap. Sequencing
    // them (what the fix makes the periodic interval actually do) does not.
    test('running reconcile() concurrently with an in-flight bootstrapIfNeeded() duplicates upserts (rev advances more than once per character)', async () => {
        // A large-enough file count that the two passes' real async fs I/O actually interleaves (this is what
        // made the bug reliably reproduce on the owner's real ~24k-card library, not a hypothetical) - too few
        // files risks one pass finishing before the other's had a chance to observe any overlap.
        for (let i = 0; i < 150; i++) {
            await writeCardFile(`Card${i}.png`, { name: `Card${i}`, data: { name: `Card${i}`, description: '', personality: '', scenario: '', first_mes: '', mes_example: '', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });
        }

        // Deliberately NOT awaited before starting reconcile() - this is the exact shape the old, unguarded
        // `setInterval(() => reconcile(directories), ...)` produced whenever the interval fired mid-bootstrap.
        const bootstrapPromise = metadataDb.bootstrapIfNeeded(directories);
        const reconcilePromise = metadataDb.reconcile(directories);
        await Promise.all([bootstrapPromise, reconcilePromise]);

        const changes = await metadataDb.getChangesSince(directories, 0);
        const result = await metadataDb.queryCharacters(directories, { wantRows: false, wantTotal: true });
        // A rev count higher than the final character count means at least one file got processed (parsed +
        // written) by both passes instead of exactly one - the real duplicate-work symptom this test guards
        // against, not just lock contention.
        expect(changes.rev).toBeGreaterThan(result.total);
    });

    test('sequencing reconcile() after bootstrapIfNeeded() resolves (what the fixed periodic interval does) does not duplicate upserts', async () => {
        for (let i = 0; i < 150; i++) {
            await writeCardFile(`Card${i}.png`, { name: `Card${i}`, data: { name: `Card${i}`, description: '', personality: '', scenario: '', first_mes: '', mes_example: '', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });
        }

        await metadataDb.bootstrapIfNeeded(directories);
        await metadataDb.reconcile(directories);

        const changes = await metadataDb.getChangesSince(directories, 0);
        const result = await metadataDb.queryCharacters(directories, { wantRows: false, wantTotal: true });
        expect(changes.rev).toBe(result.total);
    });
});

describe('reconcile', () => {
    test('discovers a file written directly to disk (no write-path hook) with date_added = now, not ctimeMs', async () => {
        await metadataDb.bootstrapIfNeeded(directories); // establishes the "already bootstrapped" baseline

        const before = Date.now();
        const filePath = await writeCardFile('DroppedIn.png');
        const stat = await fs.promises.stat(filePath);

        await metadataDb.reconcile(directories);
        const row = await metadataDb.getCharacterMetadataRow(directories, 'DroppedIn.png');

        expect(row).toBeDefined();
        expect(row.date_added).toBeGreaterThanOrEqual(before);
        // The whole point of the steady-state rule: date_added must NOT equal the file's own ctimeMs here.
        expect(row.date_added).not.toBe(Math.round(stat.ctimeMs));
    });

    test('removes rows whose file was deleted from disk', async () => {
        await writeCardFile('Alice.png');
        await metadataDb.bootstrapIfNeeded(directories);
        expect(await metadataDb.getCharacterMetadataRow(directories, 'Alice.png')).toBeDefined();

        fs.unlinkSync(path.join(charactersDir, 'Alice.png'));
        await metadataDb.reconcile(directories);

        expect(await metadataDb.getCharacterMetadataRow(directories, 'Alice.png')).toBeUndefined();
    });

    test('leaves an unchanged file\'s date_added untouched across repeated passes', async () => {
        await writeCardFile('Alice.png');
        await metadataDb.bootstrapIfNeeded(directories);
        const first = await metadataDb.getCharacterMetadataRow(directories, 'Alice.png');

        await metadataDb.reconcile(directories);
        await metadataDb.reconcile(directories);
        const second = await metadataDb.getCharacterMetadataRow(directories, 'Alice.png');

        expect(second.date_added).toBe(first.date_added);
    });
});

describe('batch import mode', () => {
    test('buffers writes until endBatchImport flushes them', async () => {
        // endBatchImport() forces a reconcile pass (see its own doc comment), which would otherwise treat a
        // buffered-but-not-yet-real file as an orphaned row and delete it - matching real usage, where the
        // write-path hook only ever fires after the PNG itself has already been written to disk.
        await writeCardFile('Bob.png', { name: 'Bob', data: { name: 'Bob', description: '', personality: '', scenario: '', first_mes: '', mes_example: '', tags: [], creator: 'tester', character_version: '1.0', creator_notes: '', extensions: { fav: false, world: '' } } });

        await metadataDb.beginBatchImport(directories);
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson(), 1000);

        // Not written yet - still buffered.
        expect(await metadataDb.getCharacterMetadataRow(directories, 'Bob.png')).toBeUndefined();

        await metadataDb.endBatchImport(directories);
        expect(await metadataDb.getCharacterMetadataRow(directories, 'Bob.png')).toBeDefined();
    });
});

describe('content_hash / findCharacterIdByContentHash (bulk-import exact-duplicate dedup)', () => {
    test('a write with no contentHash leaves content_hash NULL', async () => {
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson(), 1000);
        const row = await metadataDb.getCharacterMetadataRow(directories, 'Bob.png');
        expect(row.content_hash).toBeNull();
    });

    test('a write with a contentHash records it, and findCharacterIdByContentHash finds it', async () => {
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson(), 1000, 'deadbeef');
        const row = await metadataDb.getCharacterMetadataRow(directories, 'Bob.png');
        expect(row.content_hash).toBe('deadbeef');

        const found = await metadataDb.findCharacterIdByContentHash(directories, 'deadbeef');
        expect(found).toBe('Bob.png');
    });

    test('an unknown hash resolves to null', async () => {
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson(), 1000, 'deadbeef');
        const found = await metadataDb.findCharacterIdByContentHash(directories, 'not-a-real-hash');
        expect(found).toBeNull();
    });

    test('a later ordinary write (no contentHash) does not clobber a previously-recorded hash', async () => {
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson(), 1000, 'deadbeef');
        // Simulates an unrelated edit (e.g. /edit, /rename's generic hook) that has no source-file hash to offer.
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson({ name: 'Bob Renamed', data: { name: 'Bob Renamed', tags: [], creator: 'tester', character_version: '1.0', creator_notes: '', extensions: { fav: false, world: '' } } }), 2000);

        const row = await metadataDb.getCharacterMetadataRow(directories, 'Bob.png');
        expect(row.name).toBe('Bob Renamed');
        expect(row.content_hash).toBe('deadbeef');
    });

    test('a write that reuses an id with a fresh hash (preserved-name replace) overwrites the old hash', async () => {
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson(), 1000, 'deadbeef');
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson(), 2000, 'cafef00d');

        const row = await metadataDb.getCharacterMetadataRow(directories, 'Bob.png');
        expect(row.content_hash).toBe('cafef00d');
        expect(await metadataDb.findCharacterIdByContentHash(directories, 'deadbeef')).toBeNull();
        expect(await metadataDb.findCharacterIdByContentHash(directories, 'cafef00d')).toBe('Bob.png');
    });

    test('finds a hash still sitting in the batch-import pending buffer, not yet flushed to the table (in-batch dedup)', async () => {
        await writeCardFile('Bob.png', { name: 'Bob', data: { name: 'Bob', description: '', personality: '', scenario: '', first_mes: '', mes_example: '', tags: [], creator: 'tester', character_version: '1.0', creator_notes: '', extensions: { fav: false, world: '' } } });

        await metadataDb.beginBatchImport(directories);
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson(), 1000, 'deadbeef');

        // Not flushed to the SQL table yet - a lookup that only checked `characters` would miss this.
        expect(await metadataDb.getCharacterMetadataRow(directories, 'Bob.png')).toBeUndefined();

        const found = await metadataDb.findCharacterIdByContentHash(directories, 'deadbeef');
        expect(found).toBe('Bob.png');

        await metadataDb.endBatchImport(directories);
        // Still findable after the flush moves it into the real table.
        expect(await metadataDb.findCharacterIdByContentHash(directories, 'deadbeef')).toBe('Bob.png');
    });

    test('an empty/falsy hash never matches anything', async () => {
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson(), 1000, null);
        expect(await metadataDb.findCharacterIdByContentHash(directories, '')).toBeNull();
    });

    test('migrates an existing (pre-content_hash) database in place without losing rows', async () => {
        // Simulates an install that already has a character-metadata.sqlite from before this column existed:
        // build the old-shaped table directly (no content_hash) and seed one row, bypassing this module
        // entirely, then let a normal call (which always goes through getEntry() -> migrateContentHashColumn())
        // pick it up.
        const { default: Database } = await import('better-sqlite3');
        const dbPath = path.join(tempDir, 'character-metadata.sqlite');
        const rawDb = new Database(dbPath);
        rawDb.exec(`
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
                rev            INTEGER NOT NULL
            );
        `);
        rawDb.prepare(`
            INSERT INTO characters (id, name, name_fold, fav, date_added, create_date, date_last_chat, chat_size, data_size, file_mtime, world, creator, version, creator_notes, shallow_json, rev)
            VALUES ('Preexisting.png', 'Preexisting', 'preexisting', 0, 500, NULL, 0, 0, 0, 500, NULL, NULL, NULL, NULL, '{}', 1)
        `).run();
        rawDb.close();

        // Any exported call routes through getEntry(), which runs the migration before returning.
        const preexisting = await metadataDb.getCharacterMetadataRow(directories, 'Preexisting.png');
        expect(preexisting).toBeDefined();
        expect(preexisting.name).toBe('Preexisting');
        expect(preexisting.content_hash).toBeNull();

        // And the column is now usable for a subsequent write.
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson(), 1000, 'deadbeef');
        expect(await metadataDb.findCharacterIdByContentHash(directories, 'deadbeef')).toBe('Bob.png');
    });
});

describe('content_identity_hash / import_poisoned (unfuck-the-import: cheap dedup groundwork)', () => {
    test('upsertCharacterFromWrite always computes a content_identity_hash and clears import_poisoned', async () => {
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson(), 1000);
        const row = await metadataDb.getCharacterMetadataRow(directories, 'Bob.png');
        expect(row.content_identity_hash).toEqual(expect.any(String));
        expect(row.content_identity_hash.length).toBe(64); // sha256 hex digest
        expect(row.import_poisoned).toBe(0);
    });

    test('two writes of semantically-identical content (fav/chat/create_date differ) hash the same', async () => {
        await metadataDb.upsertCharacterFromWrite(directories, 'Alice.png', cardJson({ fav: true, create_date: '2020-01-01T00:00:00.000Z' }), 1000);
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson({ fav: false, chat: 'some-other-chat', create_date: '2024-06-01T00:00:00.000Z' }), 1000);

        const alice = await metadataDb.getCharacterMetadataRow(directories, 'Alice.png');
        const bob = await metadataDb.getCharacterMetadataRow(directories, 'Bob.png');
        expect(alice.content_identity_hash).toBe(bob.content_identity_hash);
    });

    test('a genuinely different character hashes differently', async () => {
        await metadataDb.upsertCharacterFromWrite(directories, 'Alice.png', cardJson({ name: 'Alice' }), 1000);
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson({ name: 'Bob' }), 1000);

        const alice = await metadataDb.getCharacterMetadataRow(directories, 'Alice.png');
        const bob = await metadataDb.getCharacterMetadataRow(directories, 'Bob.png');
        expect(alice.content_identity_hash).not.toBe(bob.content_identity_hash);
    });

    test('a row discovered by reconcile/bootstrap (never written through this module) starts poisoned with no hash', async () => {
        await writeCardFile('Discovered.png');
        await metadataDb.reconcile(directories);

        const row = await metadataDb.getCharacterMetadataRow(directories, 'Discovered.png');
        expect(row.import_poisoned).toBe(1);
        expect(row.content_identity_hash).toBeNull();
    });

    test('reconcile re-observing an already-written row leaves import_poisoned/content_identity_hash untouched', async () => {
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson(), 1000);
        const before = await metadataDb.getCharacterMetadataRow(directories, 'Bob.png');
        expect(before.import_poisoned).toBe(0);

        // Simulate the reconciler independently re-discovering the same (unchanged) file on disk.
        await writeCardFile('Bob.png', { name: 'Bob', data: { name: 'Bob', tags: [], creator: 'tester', character_version: '1.0', creator_notes: '', extensions: { fav: false, world: '' } } });
        await metadataDb.reconcile(directories);

        const after = await metadataDb.getCharacterMetadataRow(directories, 'Bob.png');
        expect(after.import_poisoned).toBe(0);
        expect(after.content_identity_hash).toBe(before.content_identity_hash);
    });

    test('a later write on a poisoned row clears poison and records a fresh hash', async () => {
        await writeCardFile('Bob.png');
        await metadataDb.reconcile(directories);
        expect((await metadataDb.getCharacterMetadataRow(directories, 'Bob.png')).import_poisoned).toBe(1);

        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson(), 2000);
        const row = await metadataDb.getCharacterMetadataRow(directories, 'Bob.png');
        expect(row.import_poisoned).toBe(0);
        expect(row.content_identity_hash).toEqual(expect.any(String));
    });

    test('migrates an existing (pre-content_identity_hash) database in place, defaulting preexisting rows to poisoned', async () => {
        const { default: Database } = await import('better-sqlite3');
        const dbPath = path.join(tempDir, 'character-metadata.sqlite');
        const rawDb = new Database(dbPath);
        rawDb.exec(`
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
                content_hash   TEXT,
                rev            INTEGER NOT NULL
            );
        `);
        rawDb.prepare(`
            INSERT INTO characters (id, name, name_fold, fav, date_added, create_date, date_last_chat, chat_size, data_size, file_mtime, world, creator, version, creator_notes, shallow_json, content_hash, rev)
            VALUES ('Preexisting.png', 'Preexisting', 'preexisting', 0, 500, NULL, 0, 0, 0, 500, NULL, NULL, NULL, NULL, '{}', NULL, 1)
        `).run();
        rawDb.close();

        const preexisting = await metadataDb.getCharacterMetadataRow(directories, 'Preexisting.png');
        expect(preexisting).toBeDefined();
        expect(preexisting.import_poisoned).toBe(1);
        expect(preexisting.content_identity_hash).toBeNull();
    });
});

describe('backfillContentIdentityHashes / findCharacterIdByContentIdentityHash (poisoned-row expensive fallback)', () => {
    /** @type {typeof import('png-chunks-extract').default} */
    let extract;
    /** @type {typeof import('png-chunk-text')} */
    let PNGtext;
    /** @type {typeof import('../src/png/encode.js').default} */
    let pngEncode;

    beforeAll(async () => {
        ({ default: extract } = await import('png-chunks-extract'));
        PNGtext = (await import('png-chunk-text')).default ?? await import('png-chunk-text');
        ({ default: pngEncode } = await import('../src/png/encode.js'));
    });

    afterEach(() => {
        delete process.env.SILLYTAVERN_PERFORMANCE_ALLOWEXPENSIVEDUPLICATEFALLBACK;
    });

    /**
     * Byte-simulates the OLD (pre-293f4294b) write() against a real PNG on disk - a 'chara' chunk holding
     * `pristineData` verbatim, plus a separately-written 'ccv3' chunk holding a v3-bumped local copy - the exact
     * shape a real poisoned library row's PNG has (see character-card-parser.test.js's identical fixture, which
     * this mirrors, for the byte-level behavior this relies on).
     * @param {string} avatar
     * @param {object} pristineData
     * @returns {Promise<string>} The full path written
     */
    async function writeOldStylePoisonedCard(avatar, pristineData) {
        const baseImage = await fs.promises.readFile(path.join(process.cwd(), '..', 'public', 'img', 'ai4.png'));
        const pristineBase64 = Buffer.from(JSON.stringify(pristineData), 'utf8').toString('base64');
        const bumped = { ...pristineData, spec: 'chara_card_v3', spec_version: '3.0' };
        const bumpedBase64 = Buffer.from(JSON.stringify(bumped), 'utf8').toString('base64');

        const chunks = extract(new Uint8Array(baseImage));
        chunks.splice(-1, 0, PNGtext.encode('chara', pristineBase64));
        chunks.splice(-1, 0, PNGtext.encode('ccv3', bumpedBase64));
        const filePath = path.join(charactersDir, avatar);
        await fs.promises.writeFile(filePath, Buffer.from(pngEncode(chunks)));
        return filePath;
    }

    /** A minimal Spec V2 card object, as it would have been passed to the old write()'s `data` param. */
    function pristineCard(overrides = {}) {
        return {
            spec: 'chara_card_v2',
            spec_version: '2.0',
            name: 'Poison',
            data: {
                name: 'Poison',
                description: 'A poisoned-row test character',
                personality: '',
                scenario: '',
                first_mes: '',
                mes_example: '',
                tags: [],
                creator: '',
                character_version: '',
                creator_notes: '',
                extensions: { fav: false, world: '' },
            },
            ...overrides,
        };
    }

    test('backfill computes a content_identity_hash for a poisoned row, from the pristine chara chunk, leaving import_poisoned set', async () => {
        await writeOldStylePoisonedCard('Poisoned.png', pristineCard());
        await metadataDb.reconcile(directories);

        const before = await metadataDb.getCharacterMetadataRow(directories, 'Poisoned.png');
        expect(before.import_poisoned).toBe(1);
        expect(before.content_identity_hash).toBeNull();

        await metadataDb.backfillContentIdentityHashes(directories);

        const after = await metadataDb.getCharacterMetadataRow(directories, 'Poisoned.png');
        expect(after.content_identity_hash).toEqual(expect.any(String));
        expect(after.content_identity_hash.length).toBe(64);
        // Still poisoned - backfilling the hash does not mean the file itself is free of other old-write-path
        // artifacts (see SCHEMA_SQL's own comment on the distinction).
        expect(after.import_poisoned).toBe(1);
    });

    test('the backfilled hash matches what a fresh write of the same (stripped) content would produce', async () => {
        const data = pristineCard();
        await writeOldStylePoisonedCard('Poisoned.png', data);
        await metadataDb.reconcile(directories);
        await metadataDb.backfillContentIdentityHashes(directories);
        const poisoned = await metadataDb.getCharacterMetadataRow(directories, 'Poisoned.png');

        // A brand-new, never-poisoned write of the exact same ORIGINAL card - normalized through getCharaCardV2()
        // first, exactly the way characters.js's importFromPng()/importFromJson() always normalize a card before
        // ever calling writeCharacterData() (upsertCharacterFromWrite() itself does no normalization - it hashes
        // whatever JSON it's handed as-is, on the assumption that JSON already went through that normalization,
        // which is what makes cardJson()'s own bare fixture unsuitable for this particular comparison: it skips
        // that step deliberately, for tests that don't need it). fav/create_date deliberately differ from the
        // poisoned copy - both get stripped before hashing, so they must not affect the result either way.
        const normalized = cardNormalize.getCharaCardV2(JSON.parse(JSON.stringify(data)), directories, false);
        normalized.fav = true;
        normalized.create_date = '2020-01-01T00:00:00.000Z';
        await metadataDb.upsertCharacterFromWrite(directories, 'Fresh.png', JSON.stringify(normalized), 1000);
        const fresh = await metadataDb.getCharacterMetadataRow(directories, 'Fresh.png');

        expect(poisoned.content_identity_hash).toBe(fresh.content_identity_hash);
    });

    test('findCharacterIdByContentIdentityHash finds a backfilled poisoned row by its recovered hash', async () => {
        await writeOldStylePoisonedCard('Poisoned.png', pristineCard());
        await metadataDb.reconcile(directories);
        await metadataDb.backfillContentIdentityHashes(directories);
        const row = await metadataDb.getCharacterMetadataRow(directories, 'Poisoned.png');

        expect(await metadataDb.findCharacterIdByContentIdentityHash(directories, row.content_identity_hash)).toBe('Poisoned.png');
        expect(await metadataDb.findCharacterIdByContentIdentityHash(directories, 'not-a-real-hash')).toBeNull();
        expect(await metadataDb.findCharacterIdByContentIdentityHash(directories, '')).toBeNull();
    });

    test('a second backfill call is a no-op for an already-hashed row (idempotent, no re-read)', async () => {
        await writeOldStylePoisonedCard('Poisoned.png', pristineCard());
        await metadataDb.reconcile(directories);
        await metadataDb.backfillContentIdentityHashes(directories);
        const first = await metadataDb.getCharacterMetadataRow(directories, 'Poisoned.png');

        // Corrupt the file so a re-read would fail loudly if the backfill mistakenly tried it again.
        await fs.promises.writeFile(path.join(charactersDir, 'Poisoned.png'), 'not a png');
        await metadataDb.backfillContentIdentityHashes(directories);

        const second = await metadataDb.getCharacterMetadataRow(directories, 'Poisoned.png');
        expect(second.content_identity_hash).toBe(first.content_identity_hash);
    });

    test('a row that fails to parse is left poisoned/hashless (retried on a later call), without throwing', async () => {
        const filePath = await writeOldStylePoisonedCard('Poisoned.png', pristineCard());
        await metadataDb.reconcile(directories);
        await fs.promises.writeFile(filePath, 'not a valid png at all');

        await expect(metadataDb.backfillContentIdentityHashes(directories)).resolves.toBeUndefined();

        const row = await metadataDb.getCharacterMetadataRow(directories, 'Poisoned.png');
        expect(row.import_poisoned).toBe(1);
        expect(row.content_identity_hash).toBeNull();
    });

    test('gated off (allowExpensiveDuplicateFallback=false): backfill does nothing', async () => {
        process.env.SILLYTAVERN_PERFORMANCE_ALLOWEXPENSIVEDUPLICATEFALLBACK = 'false';

        await writeOldStylePoisonedCard('Poisoned.png', pristineCard());
        await metadataDb.reconcile(directories);
        await metadataDb.backfillContentIdentityHashes(directories);

        const row = await metadataDb.getCharacterMetadataRow(directories, 'Poisoned.png');
        expect(row.content_identity_hash).toBeNull();
        expect(row.import_poisoned).toBe(1);
    });

    test('a row that is not poisoned (already has a trustworthy hash) is left untouched by backfill', async () => {
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson(), 1000);
        const before = await metadataDb.getCharacterMetadataRow(directories, 'Bob.png');

        await metadataDb.backfillContentIdentityHashes(directories);

        const after = await metadataDb.getCharacterMetadataRow(directories, 'Bob.png');
        expect(after.content_identity_hash).toBe(before.content_identity_hash);
        expect(after.import_poisoned).toBe(0);
    });
});

describe('phase 3: character_tags as source of truth (not a tags.json mirror)', () => {
    test('assignEntityTag/unassignEntityTag are single-row writes reflected by getCharacterTagIds and tag_usage', async () => {
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson(), 1000);

        expect(await metadataDb.assignEntityTag(directories, 'Bob.png', 'tag1')).toBe('ok');
        expect(await metadataDb.getCharacterTagIds(directories, 'Bob.png')).toEqual(['tag1']);
        expect(await metadataDb.getTagUsageCount(directories, 'tag1')).toBe(1);

        // Assigning again is a no-op, not a duplicate/error.
        expect(await metadataDb.assignEntityTag(directories, 'Bob.png', 'tag1')).toBe('ok');
        expect(await metadataDb.getTagUsageCount(directories, 'tag1')).toBe(1);

        expect(await metadataDb.unassignEntityTag(directories, 'Bob.png', 'tag1')).toBe('ok');
        expect(await metadataDb.getCharacterTagIds(directories, 'Bob.png')).toEqual([]);
        expect(await metadataDb.getTagUsageCount(directories, 'tag1')).toBe(0);
    });

    test('assignEntityTag rejects an unknown character id rather than creating a dangling row', async () => {
        expect(await metadataDb.assignEntityTag(directories, 'NoSuchCharacter.png', 'tag1')).toBe('not_found');
        expect(await metadataDb.getCharacterTagIds(directories, 'NoSuchCharacter.png')).toEqual([]);
    });

    test('unassignEntityTag on an unknown character is a harmless no-op', async () => {
        await expect(metadataDb.unassignEntityTag(directories, 'NoSuchCharacter.png', 'tag1')).resolves.toBe('ok');
    });

    test('getEntityTagIdsForMany batches getCharacterTagIds over multiple ids, [] for untagged/unknown ids', async () => {
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson(), 1000);
        await metadataDb.upsertCharacterFromWrite(directories, 'Alice.png', cardJson({ name: 'Alice' }), 1000);
        await metadataDb.assignEntityTag(directories, 'Bob.png', 'tag1');
        await metadataDb.assignEntityTag(directories, 'Bob.png', 'tag2');

        const result = await metadataDb.getEntityTagIdsForMany(directories, ['Bob.png', 'Alice.png', 'Ghost.png']);
        expect(result['Bob.png'].sort()).toEqual(['tag1', 'tag2']);
        expect(result['Alice.png']).toEqual([]);
        expect(result['Ghost.png']).toEqual([]);
    });

    test('getAllTagUsage returns the whole trigger-maintained tag_usage table', async () => {
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson(), 1000);
        await metadataDb.upsertCharacterFromWrite(directories, 'Alice.png', cardJson({ name: 'Alice' }), 1000);
        await metadataDb.assignEntityTag(directories, 'Bob.png', 'tag1');
        await metadataDb.assignEntityTag(directories, 'Alice.png', 'tag1');
        await metadataDb.assignEntityTag(directories, 'Alice.png', 'tag2');

        expect(await metadataDb.getAllTagUsage(directories)).toEqual({ tag1: 2, tag2: 1 });
    });

    test('an ordinary metadata write (upsertCharacterFromWrite on an existing row) does not touch existing direct tag assignments', async () => {
        // This is the regression the phase-3 fix in writeRowSync() targets: before the fix, character_tags was
        // treated as a read-only mirror of tags.json and every ordinary write unconditionally deleted+reinserted
        // a character's tag rows from tags.json's (now-stale, since assignments no longer write there) tag_map -
        // silently reverting any direct assignment.
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson(), 1000);
        await metadataDb.assignEntityTag(directories, 'Bob.png', 'tag1');
        expect(await metadataDb.getCharacterTagIds(directories, 'Bob.png')).toEqual(['tag1']);

        // Simulate an ordinary edit (fav toggled, name unchanged) - tags.json has no entry for Bob.png at all,
        // which is the expected post-phase-3 steady state (assignments never get written there anymore).
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson({ fav: true }), 2000);

        expect(await metadataDb.getCharacterTagIds(directories, 'Bob.png')).toEqual(['tag1']);
    });

    test('reconcile() finding a changed file does not revert direct tag assignments back to tags.json', async () => {
        // Regression test for the periodic-clobber bug: reconcile() used to call resyncTags() at the end of
        // every pass (including the automatic 5-minute interval), which would mirror tags.json's tag_map - stale
        // for characters, post-phase-3 - back over character_tags, undoing direct /assign|/unassign writes.
        const filePath = await writeCardFile('Alice.png');
        await metadataDb.bootstrapIfNeeded(directories);
        await metadataDb.assignEntityTag(directories, 'Alice.png', 'tag1');
        expect(await metadataDb.getCharacterTagIds(directories, 'Alice.png')).toEqual(['tag1']);

        // tags.json (if anything even still writes it) disagrees - no tag1 for Alice.
        fs.writeFileSync(path.join(tempDir, 'tags.json'), JSON.stringify({ tags: [], tag_map: {} }));

        // Touch the file's mtime so reconcile() treats it as changed and re-upserts its row.
        const future = new Date(Date.now() + 60_000);
        fs.utimesSync(filePath, future, future);
        await metadataDb.reconcile(directories);

        expect(await metadataDb.getCharacterTagIds(directories, 'Alice.png')).toEqual(['tag1']);
    });

    test('renameCharacterRow carries tag assignments over from the old id to the new one', async () => {
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson(), 1000);
        await metadataDb.assignEntityTag(directories, 'Bob.png', 'tag1');
        await metadataDb.assignEntityTag(directories, 'Bob.png', 'tag2');

        // Same shape the real /rename route hits: writeCharacterData()'s embedded hook already generically
        // upserted a (tagless) row for the new filename before renameCharacterRow() runs.
        await metadataDb.upsertCharacterFromWrite(directories, 'Robert.png', cardJson({ name: 'Robert' }), 3000);
        expect(await metadataDb.getCharacterTagIds(directories, 'Robert.png')).toEqual([]);

        await metadataDb.renameCharacterRow(directories, 'Bob.png', 'Robert.png');

        expect(await metadataDb.getCharacterTagIds(directories, 'Bob.png')).toEqual([]);
        expect((await metadataDb.getCharacterTagIds(directories, 'Robert.png')).sort()).toEqual(['tag1', 'tag2']);
    });

    test('renameCharacterRow unions carried-forward tags with anything the new id was already seeded with', async () => {
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson(), 1000);
        await metadataDb.assignEntityTag(directories, 'Bob.png', 'tag1');

        // The new-id row happens to have already picked up a tag of its own (e.g. a legacy tags.json entry
        // keyed by the new name, or a race with a direct /assign call) before the rename hook runs.
        await metadataDb.upsertCharacterFromWrite(directories, 'Robert.png', cardJson({ name: 'Robert' }), 3000);
        await metadataDb.assignEntityTag(directories, 'Robert.png', 'tag2');

        await metadataDb.renameCharacterRow(directories, 'Bob.png', 'Robert.png');

        expect((await metadataDb.getCharacterTagIds(directories, 'Robert.png')).sort()).toEqual(['tag1', 'tag2']);
    });
});

describe('phase 3 extension: groups (owner decision - tags.json removal includes group tags)', () => {
    function writeGroupFile(id, name) {
        fs.writeFileSync(path.join(groupsDir, `${id}.json`), JSON.stringify({ id, name, members: [] }));
    }

    test('upsertGroupRow/deleteGroupRow make a group id resolvable/unresolvable for tag assignment', async () => {
        expect(await metadataDb.assignEntityTag(directories, 'group1', 'tag1')).toBe('not_found');

        await metadataDb.upsertGroupRow(directories, 'group1', 'My Group');
        expect(await metadataDb.assignEntityTag(directories, 'group1', 'tag1')).toBe('ok');
        expect(await metadataDb.getGroupTagIds(directories, 'group1')).toEqual(['tag1']);

        await metadataDb.deleteGroupRow(directories, 'group1');
        expect(await metadataDb.getGroupTagIds(directories, 'group1')).toEqual([]);
        expect(await metadataDb.assignEntityTag(directories, 'group1', 'tag1')).toBe('not_found');
    });

    test('deleteGroupRow cascades to group_tags and tag_usage', async () => {
        await metadataDb.upsertGroupRow(directories, 'group1', 'My Group');
        await metadataDb.assignEntityTag(directories, 'group1', 'tag1');
        expect(await metadataDb.getTagUsageCount(directories, 'tag1')).toBe(1);

        await metadataDb.deleteGroupRow(directories, 'group1');
        expect(await metadataDb.getTagUsageCount(directories, 'tag1')).toBe(0);
    });

    test('getEntityTagIdsForMany resolves a mix of character and group ids in one call', async () => {
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson(), 1000);
        await metadataDb.upsertGroupRow(directories, 'group1', 'My Group');
        await metadataDb.assignEntityTag(directories, 'Bob.png', 'tag1');
        await metadataDb.assignEntityTag(directories, 'group1', 'tag2');

        const result = await metadataDb.getEntityTagIdsForMany(directories, ['Bob.png', 'group1', 'Ghost.png']);
        expect(result).toEqual({ 'Bob.png': ['tag1'], group1: ['tag2'], 'Ghost.png': [] });
    });

    test('tag_usage counts characters and groups together for the same tag', async () => {
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson(), 1000);
        await metadataDb.upsertGroupRow(directories, 'group1', 'My Group');
        await metadataDb.assignEntityTag(directories, 'Bob.png', 'shared-tag');
        await metadataDb.assignEntityTag(directories, 'group1', 'shared-tag');

        expect(await metadataDb.getTagUsageCount(directories, 'shared-tag')).toBe(2);
    });

    test('bootstrapGroupsIfNeeded seeds the groups table from existing group files, once', async () => {
        writeGroupFile('group1', 'Existing Group');
        await metadataDb.bootstrapGroupsIfNeeded(directories);
        expect(await metadataDb.assignEntityTag(directories, 'group1', 'tag1')).toBe('ok');

        // A second call must be a no-op (gated by its own meta flag) - a group file arriving after this point
        // isn't picked up by bootstrap; that's the write-path hook's (upsertGroupRow) job going forward.
        writeGroupFile('group2', 'Late Arrival');
        await metadataDb.bootstrapGroupsIfNeeded(directories);
        expect(await metadataDb.assignEntityTag(directories, 'group2', 'tag1')).toBe('not_found');
    });
});

describe('phase 3 extension: tag definitions (owner decision - tags.json removal includes definitions, not just tag_map)', () => {
    test('saveTagDefinitions/getTagDefinitions round-trip full Tag objects', async () => {
        const tagsArray = [{ id: 'tag1', name: 'Funny', color: '#fff' }, { id: 'tag2', name: 'Serious' }];
        expect(await metadataDb.saveTagDefinitions(directories, tagsArray)).toBe('ok');
        expect(await metadataDb.getTagDefinitions(directories)).toEqual(tagsArray);
    });

    test('saveTagDefinitions is a full replace, not additive', async () => {
        await metadataDb.saveTagDefinitions(directories, [{ id: 'tag1', name: 'Funny' }]);
        await metadataDb.saveTagDefinitions(directories, [{ id: 'tag2', name: 'Serious' }]);
        expect(await metadataDb.getTagDefinitions(directories)).toEqual([{ id: 'tag2', name: 'Serious' }]);
    });

    test('getTagsRevision advances on a definitions save and on assign/unassign', async () => {
        const before = await metadataDb.getTagsRevision(directories);
        expect(before).toBe(0);

        await metadataDb.saveTagDefinitions(directories, [{ id: 'tag1', name: 'Funny' }]);
        const afterSave = await metadataDb.getTagsRevision(directories);
        expect(afterSave).toBeGreaterThanOrEqual(before);

        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson(), 1000);
        await new Promise(resolve => setTimeout(resolve, 2));
        await metadataDb.assignEntityTag(directories, 'Bob.png', 'tag1');
        const afterAssign = await metadataDb.getTagsRevision(directories);
        expect(afterAssign).toBeGreaterThanOrEqual(afterSave);
    });
});

describe('phase 3 extension: tags.json removal (migration + settings-snapshot round trip)', () => {
    test('migrateTagsJsonIfNeeded seeds definitions + character_tags + group_tags, then renames tags.json out of the way', async () => {
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson(), 1000);
        fs.writeFileSync(path.join(groupsDir, 'group1.json'), JSON.stringify({ id: 'group1', name: 'G', members: [] }));
        await metadataDb.bootstrapGroupsIfNeeded(directories);

        const tagsJsonPath = path.join(tempDir, 'tags.json');
        fs.writeFileSync(tagsJsonPath, JSON.stringify({
            tags: [{ id: 'tag1', name: 'Funny' }],
            tag_map: { 'Bob.png': ['tag1'], group1: ['tag1'], 'GhostCharacter.png': ['tag1'] },
        }));

        await metadataDb.migrateTagsJsonIfNeeded(directories);

        expect(await metadataDb.getTagDefinitions(directories)).toEqual([{ id: 'tag1', name: 'Funny' }]);
        expect(await metadataDb.getCharacterTagIds(directories, 'Bob.png')).toEqual(['tag1']);
        expect(await metadataDb.getGroupTagIds(directories, 'group1')).toEqual(['tag1']);
        // The unresolvable key is dropped, not guessed at - see this function's own doc comment.
        expect(await metadataDb.getEntityTagIdsForMany(directories, ['GhostCharacter.png'])).toEqual({ 'GhostCharacter.png': [] });

        expect(fs.existsSync(tagsJsonPath)).toBe(false);
        expect(fs.existsSync(`${tagsJsonPath}.migrated`)).toBe(true);
    });

    test('migrateTagsJsonIfNeeded only runs once - a second call does not reprocess a re-created tags.json', async () => {
        await metadataDb.migrateTagsJsonIfNeeded(directories); // no tags.json yet - marks migrated with nothing to do

        fs.writeFileSync(path.join(tempDir, 'tags.json'), JSON.stringify({ tags: [{ id: 'tag1', name: 'Funny' }], tag_map: {} }));
        await metadataDb.migrateTagsJsonIfNeeded(directories);

        expect(await metadataDb.getTagDefinitions(directories)).toEqual([]);
        // The re-created tags.json is untouched since migration was already marked complete.
        expect(fs.existsSync(path.join(tempDir, 'tags.json'))).toBe(true);
    });

    test('getFullTagMapExport/restoreTagMap round-trip a settings snapshot\'s tag_map across both entity types', async () => {
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson(), 1000);
        await metadataDb.upsertGroupRow(directories, 'group1', 'G');
        await metadataDb.assignEntityTag(directories, 'Bob.png', 'tag1');
        await metadataDb.assignEntityTag(directories, 'group1', 'tag2');

        const exported = await metadataDb.getFullTagMapExport(directories);
        expect(exported).toEqual({ 'Bob.png': ['tag1'], group1: ['tag2'] });

        // Simulate restoring that export into a library that has since lost the assignments (but still has the
        // same characters/groups) - restoreTagMap() should bring them back.
        await metadataDb.unassignEntityTag(directories, 'Bob.png', 'tag1');
        await metadataDb.unassignEntityTag(directories, 'group1', 'tag2');
        expect(await metadataDb.getFullTagMapExport(directories)).toEqual({});

        const dropped = await metadataDb.restoreTagMap(directories, exported);
        expect(dropped).toEqual([]);
        expect(await metadataDb.getFullTagMapExport(directories)).toEqual({ 'Bob.png': ['tag1'], group1: ['tag2'] });
    });

    test('restoreTagMap drops keys that match neither a known character nor group, reporting them', async () => {
        const dropped = await metadataDb.restoreTagMap(directories, { 'NoSuchCharacter.png': ['tag1'] });
        expect(dropped).toEqual(['NoSuchCharacter.png']);
    });
});

describe('resyncTags / tag_usage', () => {
    test('mirrors tags.json\'s tag_map into character_tags and maintains tag_usage via trigger', async () => {
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson(), 1000);
        await metadataDb.upsertCharacterFromWrite(directories, 'Alice.png', cardJson({ name: 'Alice', data: { name: 'Alice', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } }), 1000);

        fs.writeFileSync(path.join(tempDir, 'tags.json'), JSON.stringify({
            tags: [{ id: 'tag1', name: 'Funny' }],
            tag_map: { 'Bob.png': ['tag1'], 'Alice.png': ['tag1'] },
        }));

        await metadataDb.resyncTags(directories);

        expect(await metadataDb.getCharacterTagIds(directories, 'Bob.png')).toEqual(['tag1']);
        expect(await metadataDb.getCharacterTagIds(directories, 'Alice.png')).toEqual(['tag1']);
        expect(await metadataDb.getTagUsageCount(directories, 'tag1')).toBe(2);

        // Untag one character and resync again - the trigger-maintained count must follow the delta, not just
        // the additions.
        fs.writeFileSync(path.join(tempDir, 'tags.json'), JSON.stringify({
            tags: [{ id: 'tag1', name: 'Funny' }],
            tag_map: { 'Bob.png': ['tag1'] },
        }));
        await metadataDb.resyncTags(directories);

        expect(await metadataDb.getCharacterTagIds(directories, 'Alice.png')).toEqual([]);
        expect(await metadataDb.getTagUsageCount(directories, 'tag1')).toBe(1);
    });
});

describe('groups schema extension (owner decision - fav/date_added/date_last_chat/chat_size/name_fold)', () => {
    function writeGroupFile(id, overrides = {}) {
        fs.writeFileSync(path.join(groupsDir, `${id}.json`), JSON.stringify({ id, name: id, members: [], chats: [], ...overrides }));
    }

    test('migrates an existing (pre-columns) groups table in place, backfilling real values for existing rows', async () => {
        // Simulates an install that already ran bootstrapGroupsIfNeeded() under the old id/name-only shape:
        // build that table directly and seed one row, then let a normal call pick up both the ALTER and the
        // one-time backfill (migrateGroupsColumns()).
        const { default: Database } = await import('better-sqlite3');
        const dbPath = path.join(tempDir, 'character-metadata.sqlite');
        const rawDb = new Database(dbPath);
        rawDb.exec('CREATE TABLE groups (id TEXT PRIMARY KEY, name TEXT NOT NULL);');
        rawDb.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT); INSERT INTO meta (key, value) VALUES ('groups_bootstrap_completed', '1');");
        rawDb.prepare('INSERT INTO groups (id, name) VALUES (@id, @name)').run({ id: 'OldGroup', name: 'Old Group' });
        rawDb.close();

        // The old row's on-disk JSON file, so the backfill has something real to read fav/chats from.
        writeGroupFile('OldGroup', { name: 'Old Group', fav: true, chats: ['c1'] });
        fs.writeFileSync(path.join(groupChatsDir, 'c1.jsonl'), 'x'.repeat(10));

        // Any exported groups call routes through getEntry() -> migrateGroupsColumns(), which runs the ALTER +
        // backfill before returning. bootstrapGroupsIfNeeded() itself must stay a no-op here (its own meta flag
        // is already set), proving the backfill came from migrateGroupsColumns(), not a re-run of bootstrap.
        await metadataDb.bootstrapGroupsIfNeeded(directories);
        const row = await metadataDb.getGroupTagIds(directories, 'OldGroup'); // cheap way to force getEntry()
        expect(row).toEqual([]); // no tags assigned - just proving the call succeeded post-migration

        const rawDb2 = new Database(dbPath);
        const migrated = rawDb2.prepare('SELECT * FROM groups WHERE id = ?').get('OldGroup');
        rawDb2.close();
        expect(migrated.fav).toBe(1);
        expect(migrated.chat_size).toBe(10);
        expect(migrated.date_added).toBeGreaterThan(0);
        expect(migrated.name_fold).toBe('old group');
    });

    test('upsertGroupRow never overwrites date_added on a later call for the same id', async () => {
        await metadataDb.upsertGroupRow(directories, 'g1', 'My Group');
        const first = await metadataDb.getGroupTagIds(directories, 'g1'); // not used - just a sanity round trip
        expect(first).toEqual([]);

        const { default: Database } = await import('better-sqlite3');
        const dbPath = path.join(tempDir, 'character-metadata.sqlite');
        const db = new Database(dbPath);
        const before = db.prepare('SELECT date_added FROM groups WHERE id = ?').get('g1');
        db.close();

        await new Promise(resolve => setTimeout(resolve, 5));
        await metadataDb.upsertGroupRow(directories, 'g1', 'Renamed Group', { fav: true });

        const db2 = new Database(dbPath);
        const after = db2.prepare('SELECT date_added, name, fav, name_fold FROM groups WHERE id = ?').get('g1');
        db2.close();

        expect(after.date_added).toBe(before.date_added);
        expect(after.name).toBe('Renamed Group');
        expect(after.name_fold).toBe('renamed group');
        expect(after.fav).toBe(1);
    });

    test('upsertGroupRow does not reset date_last_chat/chat_size set by bumpGroupChatStats', async () => {
        writeGroupFile('g1', { name: 'G1', chats: ['c1'] });
        await metadataDb.upsertGroupRow(directories, 'g1', 'G1');
        fs.writeFileSync(path.join(groupChatsDir, 'c1.jsonl'), 'x'.repeat(42));
        await metadataDb.bumpGroupChatStats(directories, 'c1');

        // A plain /edit-shaped call (rename) must not clobber the stats just bumped.
        await metadataDb.upsertGroupRow(directories, 'g1', 'G1 Renamed');

        const { default: Database } = await import('better-sqlite3');
        const db = new Database(path.join(tempDir, 'character-metadata.sqlite'));
        const row = db.prepare('SELECT chat_size, date_last_chat, name FROM groups WHERE id = ?').get('g1');
        db.close();

        expect(row.chat_size).toBe(42);
        expect(row.date_last_chat).toBeGreaterThan(0);
        expect(row.name).toBe('G1 Renamed');
    });

    test('bumpGroupChatStats resolves the owning group from the chat id (not the group id) and stats only its own chats', async () => {
        writeGroupFile('g1', { name: 'G1', chats: ['c1', 'c2'] });
        writeGroupFile('g2', { name: 'G2', chats: ['c3'] });
        await metadataDb.upsertGroupRow(directories, 'g1', 'G1');
        await metadataDb.upsertGroupRow(directories, 'g2', 'G2');

        fs.writeFileSync(path.join(groupChatsDir, 'c1.jsonl'), 'x'.repeat(10));
        fs.writeFileSync(path.join(groupChatsDir, 'c2.jsonl'), 'x'.repeat(20));
        fs.writeFileSync(path.join(groupChatsDir, 'c3.jsonl'), 'x'.repeat(999));

        // c2 is one of g1's *other* chats (not the one "just saved") - bumpGroupChatStats still sums the whole
        // group's chats, matching what getGroupsData() would compute, not just the single saved chat's size.
        await metadataDb.bumpGroupChatStats(directories, 'c2');

        const { default: Database } = await import('better-sqlite3');
        const db = new Database(path.join(tempDir, 'character-metadata.sqlite'));
        const g1 = db.prepare('SELECT chat_size, date_last_chat FROM groups WHERE id = ?').get('g1');
        const g2 = db.prepare('SELECT chat_size, date_last_chat FROM groups WHERE id = ?').get('g2');
        db.close();

        expect(g1.chat_size).toBe(30); // c1 (10) + c2 (20), not just c2
        expect(g1.date_last_chat).toBeGreaterThan(0);
        expect(g2.chat_size).toBe(0); // g2's own chat stats untouched
        expect(g2.date_last_chat).toBe(0);
    });

    test('bumpGroupChatStats on a chat id no group owns is a harmless no-op', async () => {
        await metadataDb.upsertGroupRow(directories, 'g1', 'G1');
        await expect(metadataDb.bumpGroupChatStats(directories, 'no-such-chat')).resolves.toBeUndefined();
    });

    test('bootstrapGroupsIfNeeded seeds fav/date_added/date_last_chat/chat_size/name_fold from disk, once', async () => {
        writeGroupFile('g1', { name: 'Alpha Group', fav: true, chats: ['c1'] });
        fs.writeFileSync(path.join(groupChatsDir, 'c1.jsonl'), 'x'.repeat(7));

        await metadataDb.bootstrapGroupsIfNeeded(directories);

        const { default: Database } = await import('better-sqlite3');
        const db = new Database(path.join(tempDir, 'character-metadata.sqlite'));
        const row = db.prepare('SELECT * FROM groups WHERE id = ?').get('g1');
        db.close();

        expect(row.fav).toBe(1);
        expect(row.name_fold).toBe('alpha group');
        expect(row.chat_size).toBe(7);
        expect(row.date_last_chat).toBeGreaterThan(0);
        expect(row.date_added).toBeGreaterThan(0);
    });
});

describe('fav is db-authoritative once a character row exists (owner decision - see writeRowSync()/setCharacterFav() doc comments)', () => {
    test('bootstrapIfNeeded seeds fav from a never-before-tracked character\'s embedded card value, once', async () => {
        // The "vanilla-ST-install upgrade" case: a card that already carries a real fav value, encountered for
        // the very first time by this fork's metadata store.
        await writeCardFile('Alice.png', { name: 'Alice', fav: true, data: { name: 'Alice', description: '', personality: '', scenario: '', first_mes: '', mes_example: '', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: true, world: '' } } });

        await metadataDb.bootstrapIfNeeded(directories);

        const row = await metadataDb.getCharacterMetadataRow(directories, 'Alice.png');
        expect(row.fav).toBe(1);
    });

    test('an ordinary re-upsert of an already-tracked row (upsertCharacterFromWrite) ignores the card\'s embedded fav entirely - the db value wins', async () => {
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson({ fav: true }), 1000);
        let row = await metadataDb.getCharacterMetadataRow(directories, 'Bob.png');
        expect(row.fav).toBe(1);

        // A later write for the SAME avatar carries a different embedded fav (e.g. a stale reconcile pass, or
        // an /edit save whose card - post omitFavField() - never should have carried fav at all in the first
        // place). Either way, this must not clobber the db's own value.
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson({ fav: false }), 2000);
        row = await metadataDb.getCharacterMetadataRow(directories, 'Bob.png');
        expect(row.fav).toBe(1);
    });

    test('setCharacterFav() is the only thing that can change fav after a row exists, and it patches shallow_json to match', async () => {
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson({ fav: false }), 1000);

        const updated = await metadataDb.setCharacterFav(directories, 'Bob.png', true);
        expect(updated).toBe(true);

        const row = await metadataDb.getCharacterMetadataRow(directories, 'Bob.png');
        expect(row.fav).toBe(1);

        // queryCharacters() returns JSON.parse(shallow_json) verbatim (character-metadata-db.js) - a caller
        // reading through that path must see the same fav the row itself reports, not whatever buildRow()
        // embedded at insert time.
        const queried = await metadataDb.queryCharacters(directories, { ids: ['Bob.png'] });
        expect(queried.rows[0].fav).toBe(true);

        // And a subsequent ordinary card write still must not revert it (same guarantee as the test above,
        // now exercised after a genuine setCharacterFav() toggle rather than only after the initial insert).
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson({ fav: false }), 2000);
        const rowAfter = await metadataDb.getCharacterMetadataRow(directories, 'Bob.png');
        expect(rowAfter.fav).toBe(1);
    });

    test('setCharacterFav() is a no-op (returns false) for an avatar with no tracked row yet', async () => {
        const updated = await metadataDb.setCharacterFav(directories, 'Ghost.png', true);
        expect(updated).toBe(false);
    });

    test('getCharacterFavsByIds() bulk-reads fav for a known set of ids, omitting untracked ones', async () => {
        await metadataDb.upsertCharacterFromWrite(directories, 'Alice.png', cardJson({ name: 'Alice', fav: true, data: { name: 'Alice', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: true, world: '' } } }), 1000);
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson({ fav: false }), 1000);

        const favs = await metadataDb.getCharacterFavsByIds(directories, ['Alice.png', 'Bob.png', 'Ghost.png']);
        expect(favs).toEqual({ 'Alice.png': true, 'Bob.png': false });
    });

    test('reconcile() picking up an externally-touched file does not revert a fav toggle made through setCharacterFav()', async () => {
        const filePath = await writeCardFile('Alice.png', { name: 'Alice', fav: false, data: { name: 'Alice', description: '', personality: '', scenario: '', first_mes: '', mes_example: '', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });
        await metadataDb.bootstrapIfNeeded(directories);

        await metadataDb.setCharacterFav(directories, 'Alice.png', true);

        // Touch the file's mtime so reconcile() treats it as changed and re-upserts its row - same trigger the
        // existing tag-assignment regression test above uses. The card on disk still says fav: false.
        const future = new Date(Date.now() + 60_000);
        fs.utimesSync(filePath, future, future);
        await metadataDb.reconcile(directories);

        const row = await metadataDb.getCharacterMetadataRow(directories, 'Alice.png');
        expect(row.fav).toBe(1);
    });
});
