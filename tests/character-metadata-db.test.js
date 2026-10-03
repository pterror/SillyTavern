import { describe, test, expect, beforeAll, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { storedTagDefinitions, storedTagUsageRows } from './tag-store-reads.js';

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
 * characters.js's writeCharacterData()) would - so bootstrap/reconcile, which read arbitrary PNGs straight
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

/**
 * The list row the store serves for `id` (what /query sends).
 * @param {string} id
 */
async function listRow(id) {
    return /** @type {any} */ ((await metadataDb.getShallowByIds(directories, [id]))[id]);
}

/**
 * cardJson() in the shape the app stores in card_json (see /create): a spec'd V2 card whose top-level fields
 * mirror `data.*`, with no fav.
 * @param {object} overrides As for cardJson()
 * @returns {string}
 */
function storedCardJson(overrides = {}) {
    const card = JSON.parse(cardJson(overrides));
    delete card.fav;
    delete card.data.extensions.fav;
    const data = { description: '', personality: '', scenario: '', first_mes: '', mes_example: '', ...card.data };
    return JSON.stringify({
        ...card,
        name: data.name,
        description: data.description,
        personality: data.personality,
        scenario: data.scenario,
        first_mes: data.first_mes,
        mes_example: data.mes_example,
        tags: data.tags,
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data,
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
    // Closes every open db handle this test's calls opened - each test uses a fresh tempDir
    // (a fresh cache key), so this never affects another test's state, it just keeps native SQLite handles from
    // accumulating across the whole suite.
    metadataDb.disposeMetadataStores();
});

describe('upsertCharacterFromWrite', () => {
    test('creates a row with the given date_added on first insert', async () => {
        const before = Date.now();
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', storedCardJson());
        const row = await metadataDb.getCharacterMetadataRow(directories, 'Bob.png');

        expect(row).toBeDefined();
        expect(row.name).toBe('Bob');
        expect(row.name_fold).toBe('bob');
        expect(row.creator).toBe('tester');
        expect(row.date_added).toBeGreaterThanOrEqual(before);
        expect((await listRow('Bob.png')).name).toBe('Bob');
    });

    test('never recomputes date_added on a later write to the same avatar', async () => {
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', storedCardJson());
        const firstRow = await metadataDb.getCharacterMetadataRow(directories, 'Bob.png');

        await new Promise(resolve => setTimeout(resolve, 5));
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', storedCardJson({ data: { name: 'Bob', tags: ['x'], creator: 'tester', character_version: '1.0', creator_notes: '', extensions: { fav: false, world: '' } } }));
        const secondRow = await metadataDb.getCharacterMetadataRow(directories, 'Bob.png');

        expect(secondRow.date_added).toBe(firstRow.date_added);
        expect((await listRow('Bob.png')).data.tags).toEqual(['x']);
    });
});

describe('deleteCharacterRow', () => {
    test('removes the row and logs a delete change', async () => {
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson());
        await metadataDb.deleteCharacterRow(directories, 'Bob.png');
        const row = await metadataDb.getCharacterMetadataRow(directories, 'Bob.png');
        expect(row).toBeUndefined();
    });
});

describe('renameCharacterRow', () => {
    test('carries date_added over from the old id to the new one', async () => {
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson());
        const oldRow = await metadataDb.getCharacterMetadataRow(directories, 'Bob.png');

        await new Promise(resolve => setTimeout(resolve, 5));
        // Simulates writeCharacterData()'s own embedded hook, which by the time characters.js's /rename route
        // calls renameCharacterRow() has already generically upserted a row for the new filename (see that
        // function's doc comment for why renameCharacterRow() only needs to correct date_added afterward).
        await metadataDb.upsertCharacterFromWrite(directories, 'Robert.png', cardJson({ name: 'Robert', data: { name: 'Robert', tags: [], creator: 'tester', character_version: '1.0', creator_notes: '', extensions: { fav: false, world: '' } } }));
        await metadataDb.renameCharacterRow(directories, 'Bob.png', 'Robert.png');

        const oldAfter = await metadataDb.getCharacterMetadataRow(directories, 'Bob.png');
        const newRow = await metadataDb.getCharacterMetadataRow(directories, 'Robert.png');

        expect(oldAfter).toBeUndefined();
        expect(newRow).toBeDefined();
        expect(newRow.name).toBe('Robert');
        expect(newRow.date_added).toBe(oldRow.date_added);
    });

    test('also carries date_added into the list row /query serves, not just the column', async () => {
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson());
        const oldRow = await metadataDb.getCharacterMetadataRow(directories, 'Bob.png');

        await new Promise(resolve => setTimeout(resolve, 5));
        await metadataDb.upsertCharacterFromWrite(directories, 'Robert.png', cardJson({ name: 'Robert', data: { name: 'Robert', tags: [], creator: 'tester', character_version: '1.0', creator_notes: '', extensions: { fav: false, world: '' } } }));
        await metadataDb.renameCharacterRow(directories, 'Bob.png', 'Robert.png');

        expect((await listRow('Robert.png')).date_added).toBe(oldRow.date_added);
    });
});

describe('setCharacterDateAdded', () => {
    test('overwrites date_added on an existing row, in the column and the list row', async () => {
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson());

        await metadataDb.setCharacterDateAdded(directories, 'Bob.png', 5000);

        const row = await metadataDb.getCharacterMetadataRow(directories, 'Bob.png');
        expect(row.date_added).toBe(5000);
        expect((await listRow('Bob.png')).date_added).toBe(5000);
    });

    test('is a no-op for an id with no row', async () => {
        await expect(metadataDb.setCharacterDateAdded(directories, 'Nobody.png', 5000)).resolves.toBeUndefined();
        expect(await metadataDb.getCharacterMetadataRow(directories, 'Nobody.png')).toBeUndefined();
    });

    test('patches a row still sitting in the batch-import pending buffer, not yet flushed to the table', async () => {
        await metadataDb.beginBatchImport(directories);
        await metadataDb.upsertCharacterFromWrite(directories, 'Carol.png', cardJson({ name: 'Carol', data: { name: 'Carol', tags: [], creator: 'tester', character_version: '1.0', creator_notes: '', extensions: { fav: false, world: '' } } }), null, null, { fromImport: true });

        await metadataDb.setCharacterDateAdded(directories, 'Carol.png', 7000);
        await metadataDb.endBatchImport(directories);

        const row = await metadataDb.getCharacterMetadataRow(directories, 'Carol.png');
        expect(row.date_added).toBe(7000);
        expect((await listRow('Carol.png')).date_added).toBe(7000);
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
    // exactly the seq-vs-character-count mismatch observed on a real, large, in-progress bootstrap. Sequencing
    // them (what the fix makes the periodic interval actually do) does not. A write that changes nothing writes
    // nothing, so the overlap doesn't inflate the change log either.
    test('running reconcile() concurrently with an in-flight bootstrapIfNeeded() logs one change per character (a duplicate write of the same card writes nothing)', async () => {
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

        const currentSeq = await metadataDb.getCurrentSeq(directories);
        const result = await metadataDb.queryCharacters(directories, { wantRows: false, wantTotal: true });
        // Both passes may still parse the same file, but the second one's write changes nothing, so it writes
        // nothing: the change log holds one entry per character either way.
        expect(currentSeq).toBe(result.total);
    });

    test('sequencing reconcile() after bootstrapIfNeeded() resolves (what the fixed periodic interval does) does not duplicate upserts', async () => {
        for (let i = 0; i < 150; i++) {
            await writeCardFile(`Card${i}.png`, { name: `Card${i}`, data: { name: `Card${i}`, description: '', personality: '', scenario: '', first_mes: '', mes_example: '', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });
        }

        await metadataDb.bootstrapIfNeeded(directories);
        await metadataDb.reconcile(directories);

        const currentSeq = await metadataDb.getCurrentSeq(directories);
        const result = await metadataDb.queryCharacters(directories, { wantRows: false, wantTotal: true });
        expect(currentSeq).toBe(result.total);
    });
});

describe('reconcile', () => {
    test('discovers a file written directly to disk (no write-path hook) with date_added = now, not ctimeMs', async () => {
        await metadataDb.bootstrapIfNeeded(directories); // establishes the "already bootstrapped" baseline

        const filePath = await writeCardFile('DroppedIn.png');
        const stat = await fs.promises.stat(filePath);
        // A real gap before capturing `before`/calling reconcile() - without it, ctimeMs and reconcile()'s own
        // Date.now() land within sub-millisecond of each other on a fast local filesystem (confirmed: ctimeMs
        // carries a fractional-ms component, and this whole sequence - write, stat, reconcile, read - routinely
        // completes in under 1ms), so `Math.round(ctimeMs)` and `date_added` collide often enough to flake this
        // assertion depending on incidental timing elsewhere in the suite. The test's actual intent (date_added
        // is a fresh "now" timestamp, not the file's ctime) needs genuine separation between the two instants to
        // check for real.
        await new Promise(resolve => setTimeout(resolve, 5));
        const before = Date.now();

        await metadataDb.reconcile(directories);
        const row = await metadataDb.getCharacterMetadataRow(directories, 'DroppedIn.png');

        expect(row).toBeDefined();
        expect(row.date_added).toBeGreaterThanOrEqual(before);
        // The whole point of the steady-state rule: date_added must NOT equal the file's own ctimeMs here.
        expect(row.date_added).not.toBe(Math.round(stat.ctimeMs));
    });

    test('keeps the row and card_json when the PNG is missing', async () => {
        await writeCardFile('Alice.png');
        await metadataDb.bootstrapIfNeeded(directories);
        const before = await metadataDb.getCharacterCardJson(directories, 'Alice.png');
        expect(before).not.toBeNull();

        fs.unlinkSync(path.join(charactersDir, 'Alice.png'));
        await metadataDb.reconcile(directories);

        expect(await metadataDb.getCharacterMetadataRow(directories, 'Alice.png')).toBeDefined();
        expect(await metadataDb.getCharacterCardJson(directories, 'Alice.png')).toBe(before);
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

    // Regression coverage for the chunked/mapWithConcurrency rewrite (2026-08-24: the previous shape was a
    // plain sequential `for (const file of files) { await fsPromises.stat(...) }`, one stat in flight at a
    // time - correct, but it meant reconcile()'s unconditional every-boot cost never shrank the way
    // bootstrapIfNeeded()/the backfills do, and measured out to a ~10-minute silent stall at the owner's real
    // ~286,715-card library). Concurrency only changes how many stat()/parse() calls are in flight at once; it
    // must not change which rows end up changed vs. left alone.
    test('under concurrent processing, new files are discovered while existing ones keep their original date_added', async () => {
        const existingNames = Array.from({ length: 10 }, (_, i) => `Existing${i}.png`);
        for (const name of existingNames) {
            await writeCardFile(name, { name });
        }
        await metadataDb.bootstrapIfNeeded(directories);

        const before = await Promise.all(existingNames.map(name => metadataDb.getCharacterMetadataRow(directories, name)));

        // Add genuinely new files (not yet in the DB) - these should be discovered by reconcile.
        const newNames = Array.from({ length: 10 }, (_, i) => `New${i}.png`);
        for (const name of newNames) {
            await writeCardFile(name, { name });
        }

        await metadataDb.reconcile(directories);

        // Existing files: untouched (no re-stat, no re-parse).
        for (let i = 0; i < existingNames.length; i++) {
            const row = await metadataDb.getCharacterMetadataRow(directories, existingNames[i]);
            expect(row.date_added).toBe(before[i].date_added);
        }
        // New files: discovered and inserted.
        for (const name of newNames) {
            expect(await metadataDb.getCharacterMetadataRow(directories, name)).toBeDefined();
        }
    });

    test('a quiet pass over an already-settled library logs nothing; a pass that discovers a new file logs a completion summary', async () => {
        await writeCardFile('Alice.png');
        await metadataDb.bootstrapIfNeeded(directories);

        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
        try {
            await metadataDb.reconcile(directories); // nothing changed since bootstrap
            const quietCalls = logSpy.mock.calls.filter(args => String(args[0]).includes('[character-metadata] adding new card files'));
            expect(quietCalls).toHaveLength(0);

            logSpy.mockClear();
            await new Promise(resolve => setTimeout(resolve, 5));
            await writeCardFile('NewCard.png', { name: 'NewCard', data: { name: 'NewCard', description: 'brand new', personality: '', scenario: '', first_mes: '', mes_example: '', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });
            await metadataDb.reconcile(directories);
            // One new file is a single update, which logs nothing.
            const summaryCalls = logSpy.mock.calls.filter(args => String(args[0]).includes('[character-metadata] adding new card files'));
            expect(summaryCalls).toHaveLength(0);
            expect(await metadataDb.getCharacterMetadataRow(directories, 'NewCard.png')).toBeDefined();
        } finally {
            logSpy.mockRestore();
        }
    });
});

describe('batch import mode', () => {
    test('buffers writes until endBatchImport flushes them', async () => {
        await writeCardFile('Bob.png', { name: 'Bob', data: { name: 'Bob', description: '', personality: '', scenario: '', first_mes: '', mes_example: '', tags: [], creator: 'tester', character_version: '1.0', creator_notes: '', extensions: { fav: false, world: '' } } });

        await metadataDb.beginBatchImport(directories);
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson(), null, null, { fromImport: true });

        // Not written yet - still buffered.
        expect(await metadataDb.getCharacterMetadataRow(directories, 'Bob.png')).toBeUndefined();

        await metadataDb.endBatchImport(directories);
        expect(await metadataDb.getCharacterMetadataRow(directories, 'Bob.png')).toBeDefined();
    });

    // Regression: a restart mid-pass must only lose the still-open buffer, not the whole pass. flushBatch()
    // is supposed to commit automatically once entry.batch.pending reaches BATCH_IMPORT_FLUSH_SIZE (500 as of
    // writing), well before endBatchImport() ever runs - so pushing past that threshold without ever calling
    // endBatchImport() should already make the earliest rows readable.
    test('flushes automatically mid-pass, before endBatchImport, once the pending buffer fills', async () => {
        await metadataDb.beginBatchImport(directories);

        const total = 520;
        for (let i = 0; i < total; i++) {
            await metadataDb.upsertCharacterFromWrite(directories, `Bulk${i}.png`, cardJson({ name: `Bulk${i}`, data: { name: `Bulk${i}`, tags: [], creator: 'tester', character_version: '1.0', creator_notes: '', extensions: { fav: false, world: '' } } }), null, null, { fromImport: true });
        }

        // Never called endBatchImport() yet - if flushing only ever happened there, none of this would be
        // visible. The first row pushed should have already been committed once the buffer first filled.
        expect(await metadataDb.getCharacterMetadataRow(directories, 'Bulk0.png')).toBeDefined();

        // The tail end, still under the next flush threshold, should still be sitting unflushed.
        expect(await metadataDb.getCharacterMetadataRow(directories, `Bulk${total - 1}.png`)).toBeUndefined();

        await metadataDb.endBatchImport(directories);
        expect(await metadataDb.getCharacterMetadataRow(directories, `Bulk${total - 1}.png`)).toBeDefined();
    });

    // Regression: the real client fires POST /api/tags/assign for a card's auto-imported tags immediately after
    // /api/characters/import responds - with no wait for a flush. During a multi-file drop (useBatchImportMode),
    // that import's own metadata row can still be sitting unflushed in the pending buffer at that exact moment,
    // and assignEntityTag()/unassignEntityTag() used to only ever check the `characters` SQL table, never the
    // buffer - so the assign silently 404'd (fire-and-forget on the client, never retried) and the tag never made
    // it into the row once it did flush. Confirmed against this install's real data: a spot check across the most
    // recently imported 20 characters found roughly half missing every one of their tags despite having them
    // embedded in the card itself - this is what reproduced that live.
    test('assignEntityTag/unassignEntityTag reach a row still sitting in the batch-import pending buffer', async () => {
        await writeCardFile('Bob.png', { name: 'Bob', data: { name: 'Bob', description: '', personality: '', scenario: '', first_mes: '', mes_example: '', tags: [], creator: 'tester', character_version: '1.0', creator_notes: '', extensions: { fav: false, world: '' } } });

        await metadataDb.beginBatchImport(directories);
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson(), null, null, { fromImport: true });

        // Still buffered, not in the table yet - the exact moment the client's post-import tag assign lands.
        expect(await metadataDb.getCharacterMetadataRow(directories, 'Bob.png')).toBeUndefined();
        expect(await metadataDb.assignEntityTag(directories, 'Bob.png', 'tag1')).toBe('ok');
        expect(await metadataDb.assignEntityTag(directories, 'Bob.png', 'tag2')).toBe('ok');
        // Re-assigning while still pending is a no-op, not a duplicate - matches the flushed-row behavior.
        expect(await metadataDb.assignEntityTag(directories, 'Bob.png', 'tag1')).toBe('ok');
        expect(await metadataDb.unassignEntityTag(directories, 'Bob.png', 'tag2')).toBe('ok');

        await metadataDb.endBatchImport(directories);

        const row = await metadataDb.getCharacterMetadataRow(directories, 'Bob.png');
        expect(row).toBeDefined();
        expect(await metadataDb.getCharacterTagIds(directories, 'Bob.png')).toEqual(['tag1']);
        // The list row (what /query actually serves) has to carry it too, not just the character_tags table -
        // that's the field the client's getTagsList()/entityTagIds fallback reads.
        expect((await listRow('Bob.png')).tag_ids).toEqual(['tag1']);
    });

    // Regression: a re-import of a character that already has a row is buffered too, and at flush writeRowSync() keeps
    // the table's tags for an existing row, so a tag change made into the buffer was dropped after returning 'ok'.
    describe('a tag change on a character that already has a row lands, with its buffered edit', () => {
        const editedCardJson = (/** @type {string} */ name, /** @type {string[]} */ tags = []) => storedCardJson({ name, data: { name, tags, creator: 'tester', character_version: '1.0', creator_notes: '', extensions: { fav: false, world: '' } } });

        /**
         * Both the tag change and the buffered edit are in the table before the batch ends and after it.
         * @param {string} avatar
         * @param {string} name The buffered edit's name.
         * @param {string[]} tagIds
         */
        async function expectLanded(avatar, name, tagIds) {
            for (const end of [false, true]) {
                if (end) await metadataDb.endBatchImport(directories);
                const row = await metadataDb.getCharacterMetadataRow(directories, avatar);
                expect(row.name).toBe(name);
                expect((await metadataDb.getCharacterTagIds(directories, avatar)).sort()).toEqual(tagIds);
                expect((await listRow(avatar)).tag_ids).toEqual(tagIds);
            }
        }

        test('assignEntityTag', async () => {
            await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson());
            await metadataDb.assignEntityTag(directories, 'Bob.png', 'keep');
            await metadataDb.beginBatchImport(directories);
            await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', editedCardJson('Bobby'), null, null, { fromImport: true });

            expect(await metadataDb.assignEntityTag(directories, 'Bob.png', 'tag1')).toBe('ok');

            await expectLanded('Bob.png', 'Bobby', ['keep', 'tag1']);
        });

        test('unassignEntityTag', async () => {
            await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson());
            await metadataDb.assignEntityTag(directories, 'Bob.png', 'keep');
            await metadataDb.assignEntityTag(directories, 'Bob.png', 'tag1');
            await metadataDb.beginBatchImport(directories);
            await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', editedCardJson('Bobby'), null, null, { fromImport: true });

            expect(await metadataDb.unassignEntityTag(directories, 'Bob.png', 'tag1')).toBe('ok');

            await expectLanded('Bob.png', 'Bobby', ['keep']);
        });

        test('seedCardTagsForSingleCharacter', async () => {
            await metadataDb.saveTagDefinitions(directories, [{ id: 'elan', name: 'Élan' }]);
            await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson());
            await metadataDb.assignEntityTag(directories, 'Bob.png', 'keep');
            await metadataDb.beginBatchImport(directories);
            await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', editedCardJson('Bobby', ['elan']), null, null, { fromImport: true });

            const { tagIds } = await metadataDb.seedCardTagsForSingleCharacter(directories, 'Bob.png');
            expect(tagIds).toEqual(['elan']);

            await expectLanded('Bob.png', 'Bobby', ['elan', 'keep']);
        });

        test('renameCharacterRow\'s tag copy', async () => {
            await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson());
            await metadataDb.assignEntityTag(directories, 'Bob.png', 'tag1');
            await metadataDb.upsertCharacterFromWrite(directories, 'Robert.png', editedCardJson('Robert'));
            await metadataDb.assignEntityTag(directories, 'Robert.png', 'keep');
            await metadataDb.beginBatchImport(directories);
            await metadataDb.upsertCharacterFromWrite(directories, 'Robert.png', editedCardJson('Rob'), null, null, { fromImport: true });

            await metadataDb.renameCharacterRow(directories, 'Bob.png', 'Robert.png');

            await expectLanded('Robert.png', 'Rob', ['keep', 'tag1']);
            expect(await metadataDb.getCharacterMetadataRow(directories, 'Bob.png')).toBeUndefined();
            expect(await metadataDb.getCharacterTagIds(directories, 'Bob.png')).toEqual([]);
        });
    });
});

describe('a user write during an open batch import lands in the table right away, with the character\'s buffered import', () => {
    const named = (/** @type {string} */ name, /** @type {string[]} */ tags = []) => storedCardJson({ name, data: { name, tags, creator: 'tester', character_version: '1.0', creator_notes: '', extensions: { fav: false, world: '' } } });

    /**
     * Opens a batch import and buffers an import of `avatar`, with date_added 7000 and `tags` assigned the way the
     * import path assigns a card's own tags.
     * @param {string} avatar
     * @param {string} name
     * @param {string[]} [tags] Tag ids, each defined with its id as its name.
     */
    async function bufferImport(avatar, name, tags = []) {
        if (tags.length > 0) await metadataDb.saveTagDefinitions(directories, tags.map(id => ({ id, name: id })));
        await metadataDb.beginBatchImport(directories);
        await metadataDb.upsertCharacterFromWrite(directories, avatar, named(name, tags), null, null, { fromImport: true });
        await metadataDb.setCharacterDateAdded(directories, avatar, 7000);
        if (tags.length > 0) expect((await metadataDb.seedCardTagsForSingleCharacter(directories, avatar)).tagIds.sort()).toEqual(tags);
        expect(await metadataDb.getCharacterMetadataRow(directories, avatar)).toBeUndefined();
    }

    /**
     * `check` holds before the batch import ends and after it.
     * @param {() => Promise<void>} check
     */
    async function expectBeforeAndAfterEnd(check) {
        await check();
        await metadataDb.endBatchImport(directories);
        await check();
    }

    test('upsertCharacterFromWrite', async () => {
        await bufferImport('Bob.png', 'Bob');

        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', named('Bobby'));

        await expectBeforeAndAfterEnd(async () => {
            const row = await metadataDb.getCharacterMetadataRow(directories, 'Bob.png');
            expect(row.name).toBe('Bobby');
            expect(row.date_added).toBe(7000);
        });
    });

    test('upsertCharacterFromWrite keeps the buffered import\'s tags', async () => {
        await bufferImport('Bob.png', 'Bob', ['tag1']);

        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', named('Bobby'));

        await expectBeforeAndAfterEnd(async () => {
            const row = await metadataDb.getCharacterMetadataRow(directories, 'Bob.png');
            expect(row.name).toBe('Bobby');
            expect(await metadataDb.getCharacterTagIds(directories, 'Bob.png')).toEqual(['tag1']);
            expect((await listRow('Bob.png')).tag_ids).toEqual(['tag1']);
        });
    });

    test('upsertCharacterFromWrite on a character with no buffered import', async () => {
        await metadataDb.beginBatchImport(directories);

        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', named('Bob'));

        await expectBeforeAndAfterEnd(async () => {
            expect((await metadataDb.getCharacterMetadataRow(directories, 'Bob.png')).name).toBe('Bob');
        });
    });

    test('setCharacterFav', async () => {
        await bufferImport('Bob.png', 'Bob');

        expect(await metadataDb.setCharacterFav(directories, 'Bob.png', true)).toBe(true);

        await expectBeforeAndAfterEnd(async () => {
            const row = await metadataDb.getCharacterMetadataRow(directories, 'Bob.png');
            expect(row.fav).toBe(1);
            expect(row.date_added).toBe(7000);
        });
    });

    test('setCharacterAllowGlobalStyles', async () => {
        await bufferImport('Bob.png', 'Bob');

        expect(await metadataDb.setCharacterAllowGlobalStyles(directories, 'Bob.png', true)).toBe(true);

        await expectBeforeAndAfterEnd(async () => {
            const row = await metadataDb.getCharacterMetadataRow(directories, 'Bob.png');
            expect(row.allow_global_styles).toBe(1);
            expect(row.date_added).toBe(7000);
        });
    });

    test('setCharacterActiveChat', async () => {
        await bufferImport('Bob.png', 'Bob');

        expect(await metadataDb.setCharacterActiveChat(directories, 'Bob.png', 'node-1')).toBe(true);

        await expectBeforeAndAfterEnd(async () => {
            const row = await metadataDb.getCharacterMetadataRow(directories, 'Bob.png');
            expect(row.active_chat).toBe('node-1');
            expect(row.date_added).toBe(7000);
        });
    });

    test('applyCharacterChatStats', async () => {
        await bufferImport('Bob.png', 'Bob');
        const before = Date.now();

        await metadataDb.applyCharacterChatStats(directories, 'Bob.png', { sizeChange: 10, addedCreatedAt: before, readLastCreatedAt: null });

        await expectBeforeAndAfterEnd(async () => {
            const row = await metadataDb.getCharacterMetadataRow(directories, 'Bob.png');
            expect(row.date_last_chat).toBeGreaterThanOrEqual(before);
            expect(row.date_added).toBe(7000);
        });
    });

    test.each([
        ['assignEntityTag', () => metadataDb.assignEntityTag(directories, 'Bob.png', 'tag3'), ['tag1', 'tag2', 'tag3']],
        ['unassignEntityTag', () => metadataDb.unassignEntityTag(directories, 'Bob.png', 'tag1'), ['tag2']],
    ])('%s', async (_label, write, expected) => {
        await bufferImport('Bob.png', 'Bob', ['tag1', 'tag2']);

        await write();

        await expectBeforeAndAfterEnd(async () => {
            const row = await metadataDb.getCharacterMetadataRow(directories, 'Bob.png');
            expect(row.date_added).toBe(7000);
            expect((await metadataDb.getCharacterTagIds(directories, 'Bob.png')).sort()).toEqual(expected);
            expect([...(await listRow('Bob.png')).tag_ids].sort()).toEqual(expected);
        });
    });

    test('renameCharacterRow to a buffered-only new id', async () => {
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', named('Bob'));
        await metadataDb.setCharacterDateAdded(directories, 'Bob.png', 5000);
        await metadataDb.assignEntityTag(directories, 'Bob.png', 'tag1');
        await metadataDb.beginBatchImport(directories);
        await metadataDb.upsertCharacterFromWrite(directories, 'Robert.png', named('Robert'), null, null, { fromImport: true });

        await metadataDb.renameCharacterRow(directories, 'Bob.png', 'Robert.png');

        await expectBeforeAndAfterEnd(async () => {
            const row = await metadataDb.getCharacterMetadataRow(directories, 'Robert.png');
            expect(row.name).toBe('Robert');
            expect(row.date_added).toBe(5000);
            expect((await listRow('Robert.png')).date_added).toBe(5000);
            expect(await metadataDb.getCharacterTagIds(directories, 'Robert.png')).toEqual(['tag1']);
            expect(await metadataDb.getCharacterMetadataRow(directories, 'Bob.png')).toBeUndefined();
        });
    });

    test('renameCharacterRow from a buffered-only old id carries its date_added and tags, and it doesn\'t come back', async () => {
        await bufferImport('Bob.png', 'Bob', ['tag1']);
        await metadataDb.upsertCharacterFromWrite(directories, 'Robert.png', named('Robert'));

        const result = await metadataDb.renameCharacterRow(directories, 'Bob.png', 'Robert.png');

        expect(result).toEqual({ copiedOrphanTagIds: [] });
        await expectBeforeAndAfterEnd(async () => {
            const row = await metadataDb.getCharacterMetadataRow(directories, 'Robert.png');
            expect(row.date_added).toBe(7000);
            expect(await metadataDb.getCharacterTagIds(directories, 'Robert.png')).toEqual(['tag1']);
            expect(await metadataDb.getCharacterMetadataRow(directories, 'Bob.png')).toBeUndefined();
        });
    });
});

describe('content_hash / findCharacterIdByContentHash (bulk-import exact-duplicate dedup)', () => {
    test('a write with no contentHash leaves content_hash NULL', async () => {
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson());
        const row = await metadataDb.getCharacterMetadataRow(directories, 'Bob.png');
        expect(row.content_hash).toBeNull();
    });

    test('a write with a contentHash records it, and findCharacterIdByContentHash finds it', async () => {
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson(), 'deadbeef');
        const row = await metadataDb.getCharacterMetadataRow(directories, 'Bob.png');
        expect(row.content_hash).toBe('deadbeef');

        const found = await metadataDb.findCharacterIdByContentHash(directories, 'deadbeef');
        expect(found).toBe('Bob.png');
    });

    test('an unknown hash resolves to null', async () => {
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson(), 'deadbeef');
        const found = await metadataDb.findCharacterIdByContentHash(directories, 'not-a-real-hash');
        expect(found).toBeNull();
    });

    test('a later ordinary write (no contentHash) does not clobber a previously-recorded hash', async () => {
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson(), 'deadbeef');
        // Simulates an unrelated edit (e.g. /edit, /rename's generic hook) that has no source-file hash to offer.
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson({ name: 'Bob Renamed', data: { name: 'Bob Renamed', tags: [], creator: 'tester', character_version: '1.0', creator_notes: '', extensions: { fav: false, world: '' } } }));

        const row = await metadataDb.getCharacterMetadataRow(directories, 'Bob.png');
        expect(row.name).toBe('Bob Renamed');
        expect(row.content_hash).toBe('deadbeef');
    });

    test('a write that reuses an id with a fresh hash (preserved-name replace) overwrites the old hash', async () => {
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson(), 'deadbeef');
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson(), 'cafef00d');

        const row = await metadataDb.getCharacterMetadataRow(directories, 'Bob.png');
        expect(row.content_hash).toBe('cafef00d');
        expect(await metadataDb.findCharacterIdByContentHash(directories, 'deadbeef')).toBeNull();
        expect(await metadataDb.findCharacterIdByContentHash(directories, 'cafef00d')).toBe('Bob.png');
    });

    test('finds a hash still sitting in the batch-import pending buffer, not yet flushed to the table (in-batch dedup)', async () => {
        await writeCardFile('Bob.png', { name: 'Bob', data: { name: 'Bob', description: '', personality: '', scenario: '', first_mes: '', mes_example: '', tags: [], creator: 'tester', character_version: '1.0', creator_notes: '', extensions: { fav: false, world: '' } } });

        await metadataDb.beginBatchImport(directories);
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson(), 'deadbeef', null, { fromImport: true });

        // Not flushed to the SQL table yet - a lookup that only checked `characters` would miss this.
        expect(await metadataDb.getCharacterMetadataRow(directories, 'Bob.png')).toBeUndefined();

        const found = await metadataDb.findCharacterIdByContentHash(directories, 'deadbeef');
        expect(found).toBe('Bob.png');

        await metadataDb.endBatchImport(directories);
        // Still findable after the flush moves it into the real table.
        expect(await metadataDb.findCharacterIdByContentHash(directories, 'deadbeef')).toBe('Bob.png');
    });

    test('an empty/falsy hash never matches anything', async () => {
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson(), null);
        expect(await metadataDb.findCharacterIdByContentHash(directories, '')).toBeNull();
    });

});

describe('avatar_identity_hash / findCharacterIdByIdentityHashes (avatar-aware identity dedup)', () => {
    test('a write with an avatarIdentityHash records it', async () => {
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson(), null, 'avatarhash1');
        const row = await metadataDb.getCharacterMetadataRow(directories, 'Bob.png');
        expect(row.avatar_identity_hash).toBe('avatarhash1');
    });

    test('a write with no avatarIdentityHash leaves avatar_identity_hash NULL', async () => {
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson());
        const row = await metadataDb.getCharacterMetadataRow(directories, 'Bob.png');
        expect(row.avatar_identity_hash).toBeNull();
    });

    test('a later ordinary write (no avatarIdentityHash) does not clobber a previously-recorded value - same COALESCE posture as content_hash', async () => {
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson(), null, 'avatarhash1');
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson({ name: 'Bob Renamed', data: { name: 'Bob Renamed', tags: [], creator: 'tester', character_version: '1.0', creator_notes: '', extensions: { fav: false, world: '' } } }));

        const row = await metadataDb.getCharacterMetadataRow(directories, 'Bob.png');
        expect(row.name).toBe('Bob Renamed');
        expect(row.avatar_identity_hash).toBe('avatarhash1');
    });

    test('findCharacterIdByIdentityHashes requires BOTH hashes to agree - a content-only match is not enough', async () => {
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson(), null, 'avatarhash1');
        const contentHash = (await metadataDb.getCharacterMetadataRow(directories, 'Bob.png')).content_identity_hash;

        // Same content_identity_hash, DIFFERENT avatar_identity_hash - a real "same text, different portrait"
        // shape, not a genuine duplicate for this check's purposes.
        expect(await metadataDb.findCharacterIdByIdentityHashes(directories, contentHash, 'a-different-avatar-hash')).toBeNull();
        // Both agree - a real match.
        expect(await metadataDb.findCharacterIdByIdentityHashes(directories, contentHash, 'avatarhash1')).toBe('Bob.png');
    });

    test('findCharacterIdByIdentityHashes fails open (null) when the candidate avatar hash is unknown, never falls back to a content-only match', async () => {
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson(), null, 'avatarhash1');
        const contentHash = (await metadataDb.getCharacterMetadataRow(directories, 'Bob.png')).content_identity_hash;

        expect(await metadataDb.findCharacterIdByIdentityHashes(directories, contentHash, null)).toBeNull();
    });

    test('when the MATCHING ROW has NULL avatar_identity_hash (never backfilled), a real duplicate is still found via byte-level fallback, not silently missed (2026-08 incident regression)', async () => {
        // A real PNG on disk whose row was written WITHOUT an avatarIdentityHash (e.g. bootstrap/reconcile on an
        // install predating this column) - avatar_identity_hash stays NULL exactly like an unbackfilled row.
        const filePath = await writeCardFile('Bob.png');
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson());
        const row = await metadataDb.getCharacterMetadataRow(directories, 'Bob.png');
        expect(row.avatar_identity_hash).toBeNull();

        // The candidate's own avatar hash, computed fresh the same way the real import pipeline would - matches
        // Bob.png's actual on-disk avatar bytes since writeCardFile() wrote it from the same base image.
        const buffer = await fs.promises.readFile(filePath);
        const extract = (await import('png-chunks-extract')).default;
        const candidateAvatarHash = cardParser.computeAvatarIdentityHashFromChunks(extract(new Uint8Array(buffer)));

        const match = await metadataDb.findCharacterIdByIdentityHashes(directories, row.content_identity_hash, candidateAvatarHash);
        expect(match).toBe('Bob.png');

        // Opportunistic self-heal: the fallback's own read should have backfilled the row so it never needs
        // this slow path again.
        const rowAfter = await metadataDb.getCharacterMetadataRow(directories, 'Bob.png');
        expect(rowAfter.avatar_identity_hash).toBe(candidateAvatarHash);
    });

    test('when the MATCHING ROW has NULL avatar_identity_hash but the candidate is genuinely a DIFFERENT portrait, the fallback does not falsely merge them', async () => {
        await writeCardFile('Bob.png');
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson());
        const row = await metadataDb.getCharacterMetadataRow(directories, 'Bob.png');
        expect(row.avatar_identity_hash).toBeNull();

        const match = await metadataDb.findCharacterIdByIdentityHashes(directories, row.content_identity_hash, 'a-genuinely-different-avatar-hash');
        expect(match).toBeNull();

        // Still opportunistically backfilled with Bob.png's REAL hash (not the candidate's), even though this
        // particular candidate didn't match it.
        const rowAfter = await metadataDb.getCharacterMetadataRow(directories, 'Bob.png');
        expect(rowAfter.avatar_identity_hash).toEqual(expect.any(String));
        expect(rowAfter.avatar_identity_hash).not.toBe('a-genuinely-different-avatar-hash');
    });

});

describe('content_identity_hash / import_poisoned (unfuck-the-import: cheap dedup groundwork)', () => {
    test('upsertCharacterFromWrite always computes a content_identity_hash and clears import_poisoned', async () => {
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson());
        const row = await metadataDb.getCharacterMetadataRow(directories, 'Bob.png');
        expect(row.content_identity_hash).toEqual(expect.any(String));
        expect(row.content_identity_hash.length).toBe(64); // sha256 hex digest
        expect(row.import_poisoned).toBe(0);
    });

    test('two writes of semantically-identical content (fav/chat/create_date differ) hash the same', async () => {
        await metadataDb.upsertCharacterFromWrite(directories, 'Alice.png', cardJson({ fav: true, create_date: '2020-01-01T00:00:00.000Z' }));
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson({ fav: false, chat: 'some-other-chat', create_date: '2024-06-01T00:00:00.000Z' }));

        const alice = await metadataDb.getCharacterMetadataRow(directories, 'Alice.png');
        const bob = await metadataDb.getCharacterMetadataRow(directories, 'Bob.png');
        expect(alice.content_identity_hash).toBe(bob.content_identity_hash);
    });

    test('a genuinely different character hashes differently', async () => {
        await metadataDb.upsertCharacterFromWrite(directories, 'Alice.png', cardJson({ name: 'Alice' }));
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson({ name: 'Bob' }));

        const alice = await metadataDb.getCharacterMetadataRow(directories, 'Alice.png');
        const bob = await metadataDb.getCharacterMetadataRow(directories, 'Bob.png');
        expect(alice.content_identity_hash).not.toBe(bob.content_identity_hash);
    });

    test('a row discovered by reconcile/bootstrap (never written through this module) starts poisoned, hashed from its file', async () => {
        await writeCardFile('Discovered.png');
        await metadataDb.reconcile(directories);

        const row = await metadataDb.getCharacterMetadataRow(directories, 'Discovered.png');
        expect(row.import_poisoned).toBe(1);
        expect(row.content_identity_hash).toMatch(/^[0-9a-f]{64}$/);
    });

    test('reconcile re-observing an already-written row leaves import_poisoned/content_identity_hash untouched', async () => {
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson());
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

        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson());
        const row = await metadataDb.getCharacterMetadataRow(directories, 'Bob.png');
        expect(row.import_poisoned).toBe(0);
        expect(row.content_identity_hash).toEqual(expect.any(String));
    });

});

describe('content_identity_hash of a poisoned row', () => {
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

    test('reconcile hashes a poisoned row from the pristine chara chunk', async () => {
        const pristine = pristineCard();
        await writeOldStylePoisonedCard('Poisoned.png', pristine);
        await metadataDb.reconcile(directories);
        const atInsert = (await metadataDb.getCharacterMetadataRow(directories, 'Poisoned.png')).content_identity_hash;

        expect(atInsert).toMatch(/^[0-9a-f]{64}$/);
        expect(atInsert).toBe(metadataDb.computeContentIdentityHash(cardNormalize.getCharaCardV2(JSON.parse(JSON.stringify(pristine)), directories, false)));
    });
});

describe('phase 3: character_tags as source of truth (not a tags.json mirror)', () => {
    test('assignEntityTag/unassignEntityTag are single-row writes reflected by getCharacterTagIds and tag_usage', async () => {
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson());

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
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson());
        await metadataDb.upsertCharacterFromWrite(directories, 'Alice.png', cardJson({ name: 'Alice' }));
        await metadataDb.assignEntityTag(directories, 'Bob.png', 'tag1');
        await metadataDb.assignEntityTag(directories, 'Bob.png', 'tag2');

        const result = await metadataDb.getEntityTagIdsForMany(directories, ['Bob.png', 'Alice.png', 'Ghost.png']);
        expect(result['Bob.png'].sort()).toEqual(['tag1', 'tag2']);
        expect(result['Alice.png']).toEqual([]);
        expect(result['Ghost.png']).toEqual([]);
    });

    test('tag_usage counts each tag\'s assignments, kept by triggers', async () => {
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson());
        await metadataDb.upsertCharacterFromWrite(directories, 'Alice.png', cardJson({ name: 'Alice' }));
        await metadataDb.assignEntityTag(directories, 'Bob.png', 'tag1');
        await metadataDb.assignEntityTag(directories, 'Alice.png', 'tag1');
        await metadataDb.assignEntityTag(directories, 'Alice.png', 'tag2');

        expect(await storedTagUsageRows(directories)).toEqual({ tag1: 2, tag2: 1 });
    });

    test('an ordinary metadata write (upsertCharacterFromWrite on an existing row) does not touch existing direct tag assignments', async () => {
        // This is the regression the phase-3 fix in writeRowSync() targets: before the fix, character_tags was
        // treated as a read-only mirror of tags.json and every ordinary write unconditionally deleted+reinserted
        // a character's tag rows from tags.json's (now-stale, since assignments no longer write there) tag_map -
        // silently reverting any direct assignment.
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson());
        await metadataDb.assignEntityTag(directories, 'Bob.png', 'tag1');
        expect(await metadataDb.getCharacterTagIds(directories, 'Bob.png')).toEqual(['tag1']);

        // Simulate an ordinary edit (fav toggled, name unchanged) - tags.json has no entry for Bob.png at all,
        // which is the expected post-phase-3 steady state (assignments never get written there anymore).
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson({ fav: true }));

        expect(await metadataDb.getCharacterTagIds(directories, 'Bob.png')).toEqual(['tag1']);
    });

    test('reconcile() leaves an existing character\'s row and direct tag assignments untouched when its file changes', async () => {
        await writeCardFile('Alice.png');
        await metadataDb.bootstrapIfNeeded(directories);
        await metadataDb.assignEntityTag(directories, 'Alice.png', 'tag1');

        // tags.json disagrees with the db - no tag1 for Alice.
        fs.writeFileSync(path.join(tempDir, 'tags.json'), JSON.stringify({ tags: [], tag_map: {} }));

        const rowBefore = await metadataDb.getCharacterMetadataRow(directories, 'Alice.png');
        const tagsBefore = await metadataDb.getCharacterTagIds(directories, 'Alice.png');

        const filePath = await writeCardFile('Alice.png', { name: 'Changed', data: { name: 'Changed', description: 'changed on disk', personality: '', scenario: '', first_mes: '', mes_example: '', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: true, world: '' } } });
        const future = new Date(Date.now() + 60_000);
        fs.utimesSync(filePath, future, future);
        await metadataDb.reconcile(directories);

        expect(await metadataDb.getCharacterMetadataRow(directories, 'Alice.png')).toEqual(rowBefore);
        expect(await metadataDb.getCharacterTagIds(directories, 'Alice.png')).toEqual(tagsBefore);
    });

    test('renameCharacterRow carries tag assignments over from the old id to the new one', async () => {
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson());
        await metadataDb.assignEntityTag(directories, 'Bob.png', 'tag1');
        await metadataDb.assignEntityTag(directories, 'Bob.png', 'tag2');

        // Same shape the real /rename route hits: writeCharacterData()'s embedded hook already generically
        // upserted a (tagless) row for the new filename before renameCharacterRow() runs.
        await metadataDb.upsertCharacterFromWrite(directories, 'Robert.png', cardJson({ name: 'Robert' }));
        expect(await metadataDb.getCharacterTagIds(directories, 'Robert.png')).toEqual([]);

        await metadataDb.renameCharacterRow(directories, 'Bob.png', 'Robert.png');

        expect(await metadataDb.getCharacterTagIds(directories, 'Bob.png')).toEqual([]);
        expect((await metadataDb.getCharacterTagIds(directories, 'Robert.png')).sort()).toEqual(['tag1', 'tag2']);
    });

    test('renameCharacterRow unions carried-forward tags with anything the new id was already seeded with', async () => {
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson());
        await metadataDb.assignEntityTag(directories, 'Bob.png', 'tag1');

        // The new-id row happens to have already picked up a tag of its own (e.g. a legacy tags.json entry
        // keyed by the new name, or a race with a direct /assign call) before the rename hook runs.
        await metadataDb.upsertCharacterFromWrite(directories, 'Robert.png', cardJson({ name: 'Robert' }));
        await metadataDb.assignEntityTag(directories, 'Robert.png', 'tag2');

        await metadataDb.renameCharacterRow(directories, 'Bob.png', 'Robert.png');

        expect((await metadataDb.getCharacterTagIds(directories, 'Robert.png')).sort()).toEqual(['tag1', 'tag2']);
    });

    test('renameCharacterRow throws naming both ids and changes nothing when the new id has no row', async () => {
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson());
        await metadataDb.assignEntityTag(directories, 'Bob.png', 'tag1');
        const before = await metadataDb.getCharacterMetadataRow(directories, 'Bob.png');

        const error = await metadataDb.renameCharacterRow(directories, 'Bob.png', 'Robert.png').catch(err => err);

        expect(error).toBeInstanceOf(Error);
        expect(error.message).toContain('Bob.png');
        expect(error.message).toContain('Robert.png');
        expect(await metadataDb.getCharacterMetadataRow(directories, 'Bob.png')).toEqual(before);
        expect(await metadataDb.getCharacterTagIds(directories, 'Bob.png')).toEqual(['tag1']);
        expect(await metadataDb.getCharacterMetadataRow(directories, 'Robert.png')).toBeUndefined();
        expect(await metadataDb.getCharacterTagIds(directories, 'Robert.png')).toEqual([]);
    });
});

describe('assignEntityTag/unassignEntityTag commit the tag row and its write-back together', () => {
    /**
     * Makes every later write to `column` of `table` fail, from another connection.
     * @param {string} table
     * @param {string} column
     */
    async function failWritesTo(table, column) {
        metadataDb.disposeMetadataStores();
        const { default: Database } = await import('better-sqlite3');
        const rawDb = new Database(path.join(tempDir, 'character-metadata.sqlite'));
        rawDb.exec(`CREATE TRIGGER test_fail_write_back BEFORE UPDATE OF ${column} ON ${table} BEGIN SELECT RAISE(ABORT, 'write-back failed'); END`);
        rawDb.close();
    }

    test('a character\'s tag row rolls back when its version write fails', async () => {
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson());
        await metadataDb.assignEntityTag(directories, 'Bob.png', 'keep');
        const before = await metadataDb.getCharacterMetadataRow(directories, 'Bob.png');
        await failWritesTo('characters', 'version');

        await expect(metadataDb.assignEntityTag(directories, 'Bob.png', 'tag1')).rejects.toThrow('write-back failed');
        await expect(metadataDb.unassignEntityTag(directories, 'Bob.png', 'keep')).rejects.toThrow('write-back failed');

        expect(await metadataDb.getCharacterTagIds(directories, 'Bob.png')).toEqual(['keep']);
        expect(await metadataDb.getCharacterMetadataRow(directories, 'Bob.png')).toEqual(before);
        expect(await metadataDb.getTagUsageCount(directories, 'tag1')).toBe(0);
        expect(await metadataDb.getTagUsageCount(directories, 'keep')).toBe(1);
    });

    test('a group\'s tag row rolls back when its digest_tag_ids write fails', async () => {
        await metadataDb.upsertGroupRow(directories, 'group1', 'My Group');
        await metadataDb.assignEntityTag(directories, 'group1', 'keep');
        await failWritesTo('groups', 'digest_tag_ids');

        await expect(metadataDb.assignEntityTag(directories, 'group1', 'tag1')).rejects.toThrow('write-back failed');
        await expect(metadataDb.unassignEntityTag(directories, 'group1', 'keep')).rejects.toThrow('write-back failed');

        expect(await metadataDb.getGroupTagIds(directories, 'group1')).toEqual(['keep']);
        expect(await metadataDb.getTagUsageCount(directories, 'tag1')).toBe(0);
        expect(await metadataDb.getTagUsageCount(directories, 'keep')).toBe(1);
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
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson());
        await metadataDb.upsertGroupRow(directories, 'group1', 'My Group');
        await metadataDb.assignEntityTag(directories, 'Bob.png', 'tag1');
        await metadataDb.assignEntityTag(directories, 'group1', 'tag2');

        const result = await metadataDb.getEntityTagIdsForMany(directories, ['Bob.png', 'group1', 'Ghost.png']);
        expect(result).toEqual({ 'Bob.png': ['tag1'], group1: ['tag2'], 'Ghost.png': [] });
    });

    test('tag_usage counts characters and groups together for the same tag', async () => {
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson());
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
        expect(await storedTagDefinitions(metadataDb, directories)).toEqual(tagsArray);
    });

    test('saveTagDefinitions is a full replace, not additive', async () => {
        await metadataDb.saveTagDefinitions(directories, [{ id: 'tag1', name: 'Funny' }]);
        await metadataDb.saveTagDefinitions(directories, [{ id: 'tag2', name: 'Serious' }]);
        expect(await storedTagDefinitions(metadataDb, directories)).toEqual([{ id: 'tag2', name: 'Serious' }]);
    });

    test('the tag change log advances on a definitions write, but not on assign/unassign', async () => {
        const before = await metadataDb.getTagChangesSeq(directories);

        await metadataDb.createTagDefinition(directories, { id: 'tag1', name: 'Funny' });
        const afterSave = await metadataDb.getTagChangesSeq(directories);
        expect(afterSave).toBeGreaterThan(/** @type {number} */ (before));

        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson());
        await metadataDb.assignEntityTag(directories, 'Bob.png', 'tag1');
        expect(await metadataDb.getTagChangesSeq(directories)).toBe(afterSave);

        await metadataDb.unassignEntityTag(directories, 'Bob.png', 'tag1');
        expect(await metadataDb.getTagChangesSeq(directories)).toBe(afterSave);
    });

    test('a seed after a rename finds the tag by its new name', async () => {
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson({ data: { name: 'Bob', tags: ['Shared'], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } }));
        const first = await metadataDb.seedCardTagsForSingleCharacter(directories, 'Bob.png');
        const mintedId = first.tagIds[0];

        await metadataDb.editTagDefinition(directories, mintedId, { name: 'Renamed' });

        await metadataDb.upsertCharacterFromWrite(directories, 'Alice.png', cardJson({ name: 'Alice', data: { name: 'Alice', tags: ['Renamed'], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } }));
        const second = await metadataDb.seedCardTagsForSingleCharacter(directories, 'Alice.png');

        expect(second.tagIds).toEqual([mintedId]);
    });

    test('seedCardTagsForSingleCharacter writes a change entry and moves the version only when tag_ids change', async () => {
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson({ tags: ['Shared'] }));
        const { default: Database } = await import('better-sqlite3');
        const rawDb = new Database(path.join(directories.root, 'character-metadata.sqlite'));
        try {
            rawDb.prepare('DELETE FROM character_tags WHERE character_id = ?').run('Bob.png');
            const snapshot = async () => ({
                changes: rawDb.prepare('SELECT COUNT(*) AS n FROM changes WHERE id = ?').get('Bob.png').n,
                version: rawDb.prepare('SELECT version FROM characters WHERE id = ?').get('Bob.png').version,
                tagIds: (await listRow('Bob.png')).tag_ids,
            });

            const before = await snapshot();
            const first = await metadataDb.seedCardTagsForSingleCharacter(directories, 'Bob.png');
            const afterChange = await snapshot();
            expect(first.tagIds).toHaveLength(1);
            expect(afterChange.tagIds).toEqual(first.tagIds);
            expect(afterChange.changes).toBe(before.changes + 1);
            expect(afterChange.version).toBeGreaterThan(before.version);

            await metadataDb.seedCardTagsForSingleCharacter(directories, 'Bob.png');
            expect(await snapshot()).toEqual(afterChange);
        } finally {
            rawDb.close();
        }
    });

    test('getTagDefinitionsByIds skips a tag row that will not parse with a warning naming it, and still returns the other requested tags', async () => {
        await metadataDb.saveTagDefinitions(directories, [{ id: 'tag1', name: 'Funny' }, { id: 'tag2', name: 'Broken' }, { id: 'tag3', name: 'Serious' }]);
        const { default: Database } = await import('better-sqlite3');
        const rawDb = new Database(path.join(directories.root, 'character-metadata.sqlite'));
        rawDb.prepare('UPDATE tags SET data = ? WHERE id = ?').run('{not json', 'tag2');
        rawDb.close();

        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const result = await metadataDb.getTagDefinitionsByIds(directories, ['tag1', 'tag2', 'tag3']);
            expect(result).toHaveLength(2);
            expect(result).toEqual(expect.arrayContaining([{ id: 'tag1', name: 'Funny' }, { id: 'tag3', name: 'Serious' }]));
            expect(warnSpy).toHaveBeenCalledTimes(1);
            expect(warnSpy.mock.calls[0][0]).toContain('[character-metadata]');
            expect(warnSpy.mock.calls[0][0]).toContain('tag2');
        } finally {
            warnSpy.mockRestore();
        }
    });
});

describe('tag_usage', () => {
    test('is maintained by trigger as tags are assigned and unassigned', async () => {
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson());
        await metadataDb.upsertCharacterFromWrite(directories, 'Alice.png', cardJson({ name: 'Alice', data: { name: 'Alice', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } }));
        expect(await metadataDb.assignEntityTag(directories, 'Bob.png', 'tag1')).toBe('ok');
        expect(await metadataDb.assignEntityTag(directories, 'Alice.png', 'tag1')).toBe('ok');

        expect(await metadataDb.getCharacterTagIds(directories, 'Bob.png')).toEqual(['tag1']);
        expect(await metadataDb.getCharacterTagIds(directories, 'Alice.png')).toEqual(['tag1']);
        expect(await metadataDb.getTagUsageCount(directories, 'tag1')).toBe(2);

        // Untagging one character: the trigger-maintained count follows removals, not just additions.
        expect(await metadataDb.unassignEntityTag(directories, 'Alice.png', 'tag1')).toBe('ok');

        expect(await metadataDb.getCharacterTagIds(directories, 'Alice.png')).toEqual([]);
        expect(await metadataDb.getTagUsageCount(directories, 'tag1')).toBe(1);
    });
});

describe('tags.json tag_map values: a repeated id is stored once, a non-array is read as no tags with a warning', () => {
    /** @param {Record<string, unknown>} tagMap */
    function writeTagMap(tagMap) {
        fs.writeFileSync(path.join(tempDir, 'tags.json'), JSON.stringify({ tags: [], tag_map: tagMap }));
    }

    async function storedTagIds(/** @type {string} */ avatar) {
        return { table: (await metadataDb.getCharacterTagIds(directories, avatar)).sort(), shallow: (await listRow(avatar)).tag_ids };
    }

    /**
     * Runs fn with console.warn captured, and expects one warning naming `key` and showing `value`.
     * @param {string} key
     * @param {unknown} value
     * @param {() => Promise<unknown>} fn
     */
    async function expectWarnsAbout(key, value, fn) {
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            await fn();
            const messages = warnSpy.mock.calls.map(([message]) => String(message));
            expect(messages.filter(m => m.includes(key) && m.includes(JSON.stringify(value)))).toHaveLength(1);
        } finally {
            warnSpy.mockRestore();
        }
    }

    test('a repeated id, through upsertCharacterFromWrite', async () => {
        writeTagMap({ 'Bob.png': ['t1', 't2', 't1'] });
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson());
        expect(await storedTagIds('Bob.png')).toEqual({ table: ['t1', 't2'], shallow: ['t1', 't2'] });
    });

    test('a repeated id, through bootstrapIfNeeded', async () => {
        await writeCardFile('Alice.png');
        writeTagMap({ 'Alice.png': ['t1', 't1'] });
        await metadataDb.bootstrapIfNeeded(directories);
        expect(await storedTagIds('Alice.png')).toEqual({ table: ['t1'], shallow: ['t1'] });
    });

    test('a repeated id, through reconcile', async () => {
        await writeCardFile('Alice.png');
        writeTagMap({ 'Alice.png': ['t1', 't1'] });
        await metadataDb.reconcile(directories);
        expect(await storedTagIds('Alice.png')).toEqual({ table: ['t1'], shallow: ['t1'] });
    });

    test('a string, through upsertCharacterFromWrite', async () => {
        writeTagMap({ 'Bob.png': 'ab' });
        await expectWarnsAbout('Bob.png', 'ab', () => metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson()));
        expect(await storedTagIds('Bob.png')).toEqual({ table: [], shallow: [] });
    });

    test('a number and an object, through bootstrapIfNeeded, write their rows and throw nothing', async () => {
        await writeCardFile('Alice.png');
        await writeCardFile('Carol.png', { name: 'Carol' });
        writeTagMap({ 'Alice.png': 5, 'Carol.png': { t1: true } });
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            await metadataDb.bootstrapIfNeeded(directories);
            const messages = warnSpy.mock.calls.map(([message]) => String(message));
            expect(messages.some(m => m.includes('Alice.png') && m.includes('5'))).toBe(true);
            expect(messages.some(m => m.includes('Carol.png') && m.includes(JSON.stringify({ t1: true })))).toBe(true);
        } finally {
            warnSpy.mockRestore();
        }
        expect(await storedTagIds('Alice.png')).toEqual({ table: [], shallow: [] });
        expect(await storedTagIds('Carol.png')).toEqual({ table: [], shallow: [] });
    });
});

describe('groups schema extension (owner decision - fav/date_added/date_last_chat/chat_size/name_fold)', () => {
    function writeGroupFile(id, overrides = {}) {
        fs.writeFileSync(path.join(groupsDir, `${id}.json`), JSON.stringify({ id, name: id, members: [], chats: [], ...overrides }));
    }

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

    test('upsertGroupRow does not reset date_last_chat/chat_size set by applyGroupChatStats', async () => {
        writeGroupFile('g1', { name: 'G1', chats: ['c1'] });
        await metadataDb.upsertGroupRow(directories, 'g1', 'G1');
        await metadataDb.applyGroupChatStats(directories, 'g1', { sizeChange: 42, addedCreatedAt: 1000, readLastCreatedAt: null });

        // A plain /edit-shaped call (rename) must not clobber the stats just applied.
        await metadataDb.upsertGroupRow(directories, 'g1', 'G1 Renamed');
        await metadataDb.foldAllActivity(directories);

        const { default: Database } = await import('better-sqlite3');
        const db = new Database(path.join(tempDir, 'character-metadata.sqlite'));
        const row = db.prepare('SELECT chat_size, date_last_chat, name FROM groups WHERE id = ?').get('g1');
        db.close();

        expect(row.chat_size).toBe(42);
        expect(row.date_last_chat).toBe(1000);
        expect(row.name).toBe('G1 Renamed');
    });

    test('applyGroupChatStats adds each size change to its own group\'s row only, and keeps the newest date', async () => {
        writeGroupFile('g1', { name: 'G1', chats: ['c1', 'c2'] });
        writeGroupFile('g2', { name: 'G2', chats: ['c3'] });
        await metadataDb.upsertGroupRow(directories, 'g1', 'G1');
        await metadataDb.upsertGroupRow(directories, 'g2', 'G2');

        await metadataDb.applyGroupChatStats(directories, 'g1', { sizeChange: 10, addedCreatedAt: 2000, readLastCreatedAt: null });
        await metadataDb.applyGroupChatStats(directories, 'g1', { sizeChange: 20, addedCreatedAt: 1000, readLastCreatedAt: null });
        // Queued until read: a read through the store sees it at once, the row once the queue is written out.
        expect((await metadataDb.getGroupChatStatsByIds(directories, ['g1'])).get('g1')).toEqual({ chatSize: 30, dateLastChat: 2000 });
        expect(await metadataDb.foldAllActivity(directories)).toBe(1);

        const { default: Database } = await import('better-sqlite3');
        const db = new Database(path.join(tempDir, 'character-metadata.sqlite'));
        const g1 = db.prepare('SELECT chat_size, date_last_chat FROM groups WHERE id = ?').get('g1');
        const g2 = db.prepare('SELECT chat_size, date_last_chat FROM groups WHERE id = ?').get('g2');
        db.close();

        expect(g1).toEqual({ chat_size: 30, date_last_chat: 2000 });
        expect(g2).toEqual({ chat_size: 0, date_last_chat: 0 });
    });

    test('applyGroupChatStats on a group with no row warns and writes nothing', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        await metadataDb.upsertGroupRow(directories, 'g1', 'G1');
        await expect(metadataDb.applyGroupChatStats(directories, 'no-such-group', { sizeChange: 5, addedCreatedAt: 1, readLastCreatedAt: null })).resolves.toBeUndefined();
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });

    test('bootstrapGroupsIfNeeded seeds fav/date_added/name_fold from disk and queues the chat stats, once', async () => {
        writeGroupFile('g1', { name: 'Alpha Group', fav: true, chats: ['c1'] });
        fs.writeFileSync(path.join(groupChatsDir, 'c1.jsonl'), 'x'.repeat(7));

        await metadataDb.bootstrapGroupsIfNeeded(directories);

        const { default: Database } = await import('better-sqlite3');
        const db = new Database(path.join(tempDir, 'character-metadata.sqlite'));
        const row = db.prepare('SELECT * FROM groups WHERE id = ?').get('g1');
        const queued = Array.from(db.prepare('SELECT kind, id FROM chat_stats_pending').iterate());
        db.close();

        expect(row.fav).toBe(1);
        expect(row.name_fold).toBe('alpha group');
        // Counted from the group's messages by the chat stats queue, not from its chat files.
        expect(row.chat_size).toBe(0);
        expect(row.date_last_chat).toBe(0);
        expect(queued).toEqual([{ kind: 'group', id: 'g1' }]);
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
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson({ fav: true }));
        let row = await metadataDb.getCharacterMetadataRow(directories, 'Bob.png');
        expect(row.fav).toBe(1);

        // A later write for the SAME avatar carries a different embedded fav (e.g. a stale reconcile pass, or
        // an /edit save whose card - post omitFavField() - never should have carried fav at all in the first
        // place). Either way, this must not clobber the db's own value.
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson({ fav: false }));
        row = await metadataDb.getCharacterMetadataRow(directories, 'Bob.png');
        expect(row.fav).toBe(1);
    });

    test('setCharacterFav() is the only thing that can change fav after a row exists, and the list row shows it', async () => {
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson({ fav: false }));

        const updated = await metadataDb.setCharacterFav(directories, 'Bob.png', true);
        expect(updated).toBe(true);

        const row = await metadataDb.getCharacterMetadataRow(directories, 'Bob.png');
        expect(row.fav).toBe(1);

        // A caller reading through queryCharacters() must see the same fav the row itself reports, not the card's.
        const queried = await metadataDb.queryCharacters(directories, { ids: ['Bob.png'] });
        expect(queried.rows[0].fav).toBe(true);

        // And a subsequent ordinary card write still must not revert it (same guarantee as the test above,
        // now exercised after a genuine setCharacterFav() toggle rather than only after the initial insert).
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson({ fav: false }));
        const rowAfter = await metadataDb.getCharacterMetadataRow(directories, 'Bob.png');
        expect(rowAfter.fav).toBe(1);
    });

    test('setCharacterFav() is a no-op (returns false) for an avatar with no tracked row yet', async () => {
        const updated = await metadataDb.setCharacterFav(directories, 'Ghost.png', true);
        expect(updated).toBe(false);
    });

    test('getCharacterFavsByIds() bulk-reads fav for a known set of ids, omitting untracked ones', async () => {
        await metadataDb.upsertCharacterFromWrite(directories, 'Alice.png', cardJson({ name: 'Alice', fav: true, data: { name: 'Alice', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: true, world: '' } } }));
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson({ fav: false }));

        const favs = await metadataDb.getCharacterFavsByIds(directories, ['Alice.png', 'Bob.png', 'Ghost.png']);
        expect(favs).toEqual({ 'Alice.png': true, 'Bob.png': false });
    });

    test('getCharacterFavsByIds() does not throw "too many SQL variables" for an id list past the single-query bound-parameter limit (regression: real-world crash on a 326k-character library - see FAV_LOOKUP_BATCH_SIZE doc comment, character-metadata-db.js)', async () => {
        const ids = [];
        for (let i = 0; i < 1500; i++) {
            const id = `Char${i}.png`;
            ids.push(id);
            await metadataDb.upsertCharacterFromWrite(directories, id, cardJson({ fav: i % 2 === 0 }));
        }

        const favs = await metadataDb.getCharacterFavsByIds(directories, ids);
        expect(Object.keys(favs)).toHaveLength(1500);
        expect(favs['Char0.png']).toBe(true);
        expect(favs['Char1.png']).toBe(false);
        expect(favs['Char1499.png']).toBe(false);
    });

    test('reconcile() leaves an existing character\'s row, including a setCharacterFav() toggle, untouched when its file changes', async () => {
        await writeCardFile('Alice.png', { name: 'Alice', fav: false, data: { name: 'Alice', description: '', personality: '', scenario: '', first_mes: '', mes_example: '', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });
        await metadataDb.bootstrapIfNeeded(directories);
        await metadataDb.setCharacterFav(directories, 'Alice.png', true);

        const rowBefore = await metadataDb.getCharacterMetadataRow(directories, 'Alice.png');
        const tagsBefore = await metadataDb.getCharacterTagIds(directories, 'Alice.png');

        const filePath = await writeCardFile('Alice.png', { name: 'Changed', fav: false, data: { name: 'Changed', description: 'changed on disk', personality: '', scenario: '', first_mes: '', mes_example: '', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });
        const future = new Date(Date.now() + 60_000);
        fs.utimesSync(filePath, future, future);
        await metadataDb.reconcile(directories);

        expect(await metadataDb.getCharacterMetadataRow(directories, 'Alice.png')).toEqual(rowBefore);
        expect(await metadataDb.getCharacterTagIds(directories, 'Alice.png')).toEqual(tagsBefore);
    });
});

describe('active_chat is db-authoritative once a character row exists (2026-08 chat-pointer db migration - see writeRowSync()/setCharacterActiveChat() doc comments)', () => {
    test('setCharacterActiveChat() is a no-op (returns false) for an avatar with no tracked row yet, and does not insert one', async () => {
        const updated = await metadataDb.setCharacterActiveChat(directories, 'Ghost.png', 'Some Chat File');
        expect(updated).toBe(false);

        const row = await metadataDb.getCharacterMetadataRow(directories, 'Ghost.png');
        expect(row).toBeUndefined();
    });

    test('setCharacterActiveChat() updates active_chat, shows it as the list row\'s chat, and moves the version for a tracked row', async () => {
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson());
        const before = await metadataDb.getCharacterMetadataRow(directories, 'Bob.png');

        const updated = await metadataDb.setCharacterActiveChat(directories, 'Bob.png', 'Bob - New Chat');
        expect(updated).toBe(true);

        const after = await metadataDb.getCharacterMetadataRow(directories, 'Bob.png');
        expect(after.active_chat).toBe('Bob - New Chat');
        expect(after.version).toBeGreaterThan(before.version);

        const shallow = await listRow('Bob.png');
        expect(shallow.chat).toBe('Bob - New Chat');

        // A caller reading through queryCharacters() must see the same chat pointer the row itself reports.
        const queried = await metadataDb.queryCharacters(directories, { ids: ['Bob.png'] });
        expect(queried.rows[0].chat).toBe('Bob - New Chat');
    });

    test('writeRowSync(): a NULL existing active_chat is seeded from this write\'s own card-derived value (row predates the column, or the backfill/first-touch hasn\'t reached it yet)', async () => {
        // Insert a row the old-fashioned way, WITHOUT ever giving it a chat (simulates a row that predates
        // active_chat, or one first-touched before the column had any value) - upsertCharacterFromWrite() with a
        // card carrying no `chat` field at all leaves active_chat NULL on insert (buildRow(): character.chat ??
        // null).
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson());
        const inserted = await metadataDb.getCharacterMetadataRow(directories, 'Bob.png');
        expect(inserted.active_chat).toBeNull();

        // A later write for the same avatar DOES carry a chat - this must be allowed to seed the still-NULL
        // column, exactly like a genuine first INSERT would.
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson({ chat: 'Bob - First Real Chat' }));
        const seeded = await metadataDb.getCharacterMetadataRow(directories, 'Bob.png');
        expect(seeded.active_chat).toBe('Bob - First Real Chat');
        expect((await listRow('Bob.png')).chat).toBe('Bob - First Real Chat');
    });

    test('writeRowSync(): a NON-NULL existing active_chat is preserved even when a later write\'s card carries a different value (db wins, matching fav exactly)', async () => {
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson({ chat: 'Bob - Original Chat' }));
        const inserted = await metadataDb.getCharacterMetadataRow(directories, 'Bob.png');
        expect(inserted.active_chat).toBe('Bob - Original Chat');

        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson({ chat: 'Some Stale Value' }));
        const after = await metadataDb.getCharacterMetadataRow(directories, 'Bob.png');
        expect(after.active_chat).toBe('Bob - Original Chat');
        expect((await listRow('Bob.png')).chat).toBe('Bob - Original Chat');
    });

    test('getCharacterActiveChatsByIds() bulk-reads active_chat for a known set of ids, omitting both untracked ids and tracked-but-NULL ids', async () => {
        await metadataDb.upsertCharacterFromWrite(directories, 'Alice.png', cardJson({ name: 'Alice', chat: 'Alice - Chat', data: { name: 'Alice', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } }));
        // Bob is tracked but has never had a chat pointer at all (active_chat stays NULL).
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson());

        const chats = await metadataDb.getCharacterActiveChatsByIds(directories, ['Alice.png', 'Bob.png', 'Ghost.png']);
        expect(chats).toEqual({ 'Alice.png': 'Alice - Chat' });
    });

});

describe('getChangesSince / getTagNameChangesSince with { limit }', () => {
    test('pages the change log by seq: each page reads at most `limit` rows and `seq` resumes the next one', async () => {
        for (const name of ['A', 'B', 'C', 'D', 'E']) {
            await metadataDb.upsertCharacterFromWrite(directories, `${name}.png`, cardJson({ name, data: { name, tags: [], creator: 'tester', character_version: '1.0', creator_notes: '', extensions: { fav: false, world: '' } } }));
        }

        const seen = [];
        const pageSizes = [];
        let since = 0;
        for (;;) {
            const page = await metadataDb.getChangesSince(directories, since, { limit: 2 });
            expect(page.truncated).toBe(false);
            pageSizes.push(page.changes.length);
            seen.push(...page.changes.map(c => c.id));
            since = page.seq;
            if (!page.hasMore) break;
        }
        expect(pageSizes).toEqual([2, 2, 1]);
        expect(seen.sort()).toEqual(['A.png', 'B.png', 'C.png', 'D.png', 'E.png']);
        expect(since).toBe(await metadataDb.getCurrentSeq(directories));

        // No limit: rejected, so no caller can reach an unbounded read.
        await expect(metadataDb.getChangesSince(directories, 0)).rejects.toThrow(TypeError);
    });

    test('collapses per page, so an id changed in two pages shows up in both', async () => {
        // A's whole-record row (its insert) stays where it is; its later field change is a row of its own.
        await metadataDb.upsertCharacterFromWrite(directories, 'A.png', cardJson({ name: 'A' }));
        await metadataDb.upsertCharacterFromWrite(directories, 'B.png', cardJson({ name: 'B' }));
        expect(await metadataDb.setCharacterFav(directories, 'A.png', true)).toBe(true);

        const first = await metadataDb.getChangesSince(directories, 0, { limit: 2 });
        expect(first.changes).toEqual([{ id: 'A.png', op: 'upsert', fields: null }, { id: 'B.png', op: 'upsert', fields: null }]);
        expect(first.hasMore).toBe(true);

        const second = await metadataDb.getChangesSince(directories, first.seq, { limit: 2 });
        expect(second.changes).toEqual([{ id: 'A.png', op: 'upsert', fields: ['fav'] }]);
        expect(second.hasMore).toBe(false);
    });

    test('pages tag name changes by seq', async () => {
        for (const id of ['t1', 't2', 't3']) {
            await metadataDb.createTagDefinition(directories, { id, name: `${id}-old` });
            await metadataDb.editTagDefinition(directories, id, { name: `${id}-new` });
        }

        const first = await metadataDb.getTagNameChangesSince(directories, 0, { limit: 2 });
        expect(first.tagIds).toEqual(['t1', 't2']);
        expect(first.hasMore).toBe(true);

        const second = await metadataDb.getTagNameChangesSince(directories, first.seq, { limit: 2 });
        expect(second.tagIds).toEqual(['t3']);
        expect(second.hasMore).toBe(false);
    });
});

describe('streamCharacterCardJsonBatches / streamCharacterIdsForTagIds', () => {
    const collect = async (gen) => {
        const batches = [];
        for await (const batch of gen) batches.push(batch);
        return batches;
    };

    test('streamCharacterCardJsonBatches yields every character once, in id order, with its card_json', async () => {
        for (const name of ['C', 'A', 'B']) {
            await metadataDb.upsertCharacterFromWrite(directories, `${name}.png`, cardJson({ name }));
        }
        const batches = await collect(metadataDb.streamCharacterCardJsonBatches(directories));
        const rows = batches.flat();
        expect(rows.map(row => row.id)).toEqual(['A.png', 'B.png', 'C.png']);
        for (const row of rows) {
            expect(row.card_json).toBe(await metadataDb.getCharacterCardJson(directories, row.id));
        }
        expect(batches.every(batch => batch.length > 0)).toBe(true);
    });

    test('streamCharacterIdsForTagIds yields each carrier once, even one carrying several of the tags', async () => {
        for (const name of ['A', 'B', 'C']) {
            await metadataDb.upsertCharacterFromWrite(directories, `${name}.png`, cardJson({ name }));
        }
        await metadataDb.assignEntityTag(directories, 'A.png', 't1');
        await metadataDb.assignEntityTag(directories, 'A.png', 't2');
        await metadataDb.assignEntityTag(directories, 'C.png', 't2');
        await metadataDb.assignEntityTag(directories, 'B.png', 't3');

        const batches = await collect(metadataDb.streamCharacterIdsForTagIds(directories, ['t1', 't2']));
        expect(batches.flat()).toEqual(['A.png', 'C.png']);
        expect(await collect(metadataDb.streamCharacterIdsForTagIds(directories, []))).toEqual([]);
    });
});

describe('card tables', () => {
    test('a card\'s \'\' world is stored as itself', async () => {
        await metadataDb.upsertCharacterFromWrite(directories, 'NoWorld.png', storedCardJson({ name: 'NoWorld' }));
        expect((await metadataDb.getCharacterMetadataRow(directories, 'NoWorld.png')).world).toBe('');
    });
});
