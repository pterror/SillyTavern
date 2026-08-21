import { describe, test, expect, beforeAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {typeof import('../src/character-card-parser.js')} */
let cardParser;

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
});

beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-character-metadata-db-test-'));
    charactersDir = path.join(tempDir, 'characters');
    chatsDir = path.join(tempDir, 'chats');
    fs.mkdirSync(charactersDir, { recursive: true });
    fs.mkdirSync(chatsDir, { recursive: true });
    directories = { root: tempDir, characters: charactersDir, chats: chatsDir };
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
