import { describe, test, expect, beforeAll, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';

/** @type {typeof import('../src/endpoints/characters-search-index.js')} */
let searchIndex;
/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {typeof import('../src/character-card-parser.js')} */
let cardParser;
/** @type {typeof import('../src/endpoints/tantivy-engine.js')} */
let tantivyEngine;
/** @type {typeof import('../src/endpoints/tantivy-search.js')} */
let tantivySearch;
/** @type {typeof import('../src/endpoints/search-index-coordinator.js')} */
let searchCoordinator;

let tempDir;
let charactersDir;
/** @type {import('../src/users.js').UserDirectoryList} */
let directories;
let maintainer;
let tantivy;
/** The fake clock every tick reads through Date.now(). */
let now;
/** Every console.error / console.warn call, joined into one line each. */
let logged;
/** Every warning the maintainer handed to its onIndexFailure. */
let warnings;

const SEQ_META_KEY = 'tantivy_char_index_seq';
const TAG_NAME_SEQ_META_KEY = 'tantivy_char_index_tag_name_change_seq';
const RETRY_SEQ_META_KEY = 'tantivy_char_index_retry_seq';
const FLAKY = 'Flaky.png';
const MAX_DELAY_MS = 5 * 60 * 1000;

const dbPath = () => path.join(tempDir, 'character-metadata.sqlite');

/**
 * @param {string} name
 * @param {string} description
 */
function cardJson(name, description) {
    return JSON.stringify({
        name,
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name,
            description, personality: '', scenario: '', first_mes: '', mes_example: '',
            tags: [], creator: '', character_version: '', creator_notes: '',
            extensions: { fav: false, world: '' },
        },
    });
}

/**
 * @param {string} name
 * @param {string} description
 */
async function writeCard(name, description) {
    const baseImage = await fs.promises.readFile(path.join(process.cwd(), '..', 'public', 'img', 'ai4.png'));
    await fs.promises.writeFile(path.join(charactersDir, `${name}.png`), cardParser.write(baseImage, cardJson(name, description)));
}

/**
 * Sets a row's card_json straight in the db, as another connection would, optionally with a change row for it.
 * @param {string} id
 * @param {string} json
 * @param {{ change: boolean }} options
 */
function setCardJson(id, json, { change }) {
    const db = new Database(dbPath());
    try {
        db.prepare('UPDATE characters SET card_json = ? WHERE id = ?').run(json, id);
        if (change) {
            db.prepare('INSERT INTO changes (id, op, fields) VALUES (?, \'upsert\', NULL)').run(id);
        }
    } finally {
        db.close();
    }
}

/** @returns {{ id: string, next_attempt_at: number, delay_ms: number, last_error: string }[]} */
function retryMarks() {
    const db = new Database(dbPath(), { readonly: true });
    try {
        return db.prepare('SELECT id, next_attempt_at, delay_ms, last_error FROM character_index_retries ORDER BY id').all();
    } finally {
        db.close();
    }
}

/** What processCharacter() throws for card_json `json`, as the retry mark records it. */
function parseError(json) {
    try {
        JSON.parse(json);
    } catch (err) {
        return String(err);
    }
    throw new Error(`${json} parses`);
}

/**
 * How many docs the persisted index holds for `id`, optionally only those whose description matches `word`.
 * @param {string} id
 * @param {string} [word]
 */
function docCount(id, word) {
    const index = tantivy.Index.open(path.join(tempDir, 'search-index', 'characters-tantivy'));
    const schema = index.schema;
    let query = tantivy.Query.termSetQuery(schema, tantivySearch.DATA_FIELD, [id]);
    if (word) {
        query = tantivy.Query.booleanQuery([
            { occur: tantivy.Occur.Must, query },
            { occur: tantivy.Occur.Must, query: tantivy.Query.regexQuery(schema, 'description', `${word}.*`) },
        ]);
    }
    return tantivySearch.runSearch(index, query, 100).total;
}

/** @returns {Promise<import('../src/endpoints/characters-search-index.js').TickResult>} */
async function tick() {
    const result = await maintainer.tick();
    expect(result).not.toBeNull();
    expect(result).not.toHaveProperty('swapped');
    return /** @type {any} */ (result);
}

/** Logged lines that name `id`. */
function logsAbout(id) {
    return logged.filter(line => line.includes(id));
}

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    searchIndex = await import('../src/endpoints/characters-search-index.js');
    metadataDb = await import('../src/character-metadata-db.js');
    cardParser = await import('../src/character-card-parser.js');
    tantivyEngine = await import('../src/endpoints/tantivy-engine.js');
    tantivySearch = await import('../src/endpoints/tantivy-search.js');
    searchCoordinator = await import('../src/endpoints/search-index-coordinator.js');
});

beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-search-index-retry-test-'));
    charactersDir = path.join(tempDir, 'characters');
    directories = /** @type {any} */ ({
        root: tempDir,
        characters: charactersDir,
        chats: path.join(tempDir, 'chats'),
        groups: path.join(tempDir, 'groups'),
        groupChats: path.join(tempDir, 'groupChats'),
    });
    for (const dir of [charactersDir, directories.chats, directories.groups, directories.groupChats]) {
        fs.mkdirSync(dir, { recursive: true });
    }
    maintainer = null;
    now = 1_000_000;
    logged = [];
    warnings = [];
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const record = (...args) => { logged.push(args.map(String).join(' ')); };
    jest.spyOn(console, 'error').mockImplementation(record);
    jest.spyOn(console, 'warn').mockImplementation(record);
});

afterEach(async () => {
    jest.restoreAllMocks();
    maintainer?.close();
    await searchCoordinator.disposeSearchWorkers();
    metadataDb.disposeMetadataStores();
    fs.rmSync(tempDir, { recursive: true, force: true });
});

/**
 * Builds an index over Good (description "steadyword") and Flaky (description "flakyword").
 * @returns {Promise<boolean>} false when tantivy isn't available here.
 */
async function setUp() {
    tantivy = await tantivyEngine.getTantivyModule();
    if (!tantivy) return false;
    await writeCard('Good', 'steadyword');
    await writeCard('Flaky', 'flakyword');
    await metadataDb.bootstrapIfNeeded(directories);
    maintainer = searchIndex.createCharacterIndexMaintainer(directories, tantivy, { onIndexFailure: warning => warnings.push(warning) });
    expect(await maintainer.rebuild()).not.toBeNull();
    expect(docCount(FLAKY, 'flakyword')).toBe(1);
    return true;
}

describe('characters-search-index.js: a card that fails to re-index keeps its doc and is retried', () => {
    test('the failing card keeps its old doc, and a retry mark due in 1s lands with the cursors', async () => {
        if (!await setUp()) return;
        const seqBefore = maintainer.seq();

        setCardJson(FLAKY, 'not json', { change: true });
        const r = await tick();

        expect(docCount(FLAKY)).toBe(1);
        expect(docCount(FLAKY, 'flakyword')).toBe(1);
        expect(retryMarks()).toEqual([{ id: FLAKY, next_attempt_at: now + 1000, delay_ms: 1000, last_error: parseError('not json') }]);
        expect(r.seq).toBeGreaterThan(seqBefore);
        expect(Number(await metadataDb.getMetaValue(directories, SEQ_META_KEY))).toBe(r.seq);
        expect(logsAbout(FLAKY)).toHaveLength(1);
        expect(logsAbout(FLAKY)[0]).toContain(parseError('not json'));
    }, 20000);

    test('a changed id with no row is still deleted, and clears its mark', async () => {
        if (!await setUp()) return;
        setCardJson(FLAKY, 'not json', { change: true });
        await tick();
        expect(retryMarks()).toHaveLength(1);

        await metadataDb.deleteCharacterRow(directories, FLAKY);
        await tick();

        expect(docCount(FLAKY)).toBe(0);
        expect(retryMarks()).toEqual([]);
    }, 20000);

    test('a card indexed through a change clears its mark', async () => {
        if (!await setUp()) return;
        setCardJson(FLAKY, 'not json', { change: true });
        await tick();

        setCardJson(FLAKY, cardJson('Flaky', 'mendedword'), { change: true });
        await tick();

        expect(retryMarks()).toEqual([]);
        expect(docCount(FLAKY)).toBe(1);
        expect(docCount(FLAKY, 'mendedword')).toBe(1);
    }, 20000);

    test('a due retry re-indexes the card without moving either cursor, and saves a bumped retry counter', async () => {
        if (!await setUp()) return;
        setCardJson(FLAKY, 'not json', { change: true });
        const failed = await tick();
        const retrySeqBefore = maintainer.retrySeq();
        expect(Number(await metadataDb.getMetaValue(directories, RETRY_SEQ_META_KEY))).toBe(retrySeqBefore);
        const failedAt = now;

        // Mended without a change row, so only the retry picks it up.
        setCardJson(FLAKY, cardJson('Flaky', 'mendedword'), { change: false });

        now = failedAt + 999;
        const early = await tick();
        expect(docCount(FLAKY, 'mendedword')).toBe(0);
        expect(retryMarks()).toHaveLength(1);
        expect(early.retrySeq).toBe(retrySeqBefore);

        now = failedAt + 1000;
        const retried = await tick();
        expect(docCount(FLAKY)).toBe(1);
        expect(docCount(FLAKY, 'mendedword')).toBe(1);
        expect(retryMarks()).toEqual([]);
        expect(retried.changed).toBe(true);
        expect(retried.seq).toBe(failed.seq);
        expect(retried.seqFrom).toBe(failed.seq);
        expect(retried.tagNameSeq).toBe(retried.tagNameSeqFrom);
        expect(retried.retrySeq).toBe(retrySeqBefore + 1);
        expect(maintainer.retrySeq()).toBe(retrySeqBefore + 1);
        expect(Number(await metadataDb.getMetaValue(directories, RETRY_SEQ_META_KEY))).toBe(retrySeqBefore + 1);
        expect(Number(await metadataDb.getMetaValue(directories, SEQ_META_KEY))).toBe(failed.seq);
        expect(Number(await metadataDb.getMetaValue(directories, TAG_NAME_SEQ_META_KEY))).toBe(retried.tagNameSeq);
    }, 20000);

    test('the saved retry counter is read back when the persisted index is reopened', async () => {
        if (!await setUp()) return;
        setCardJson(FLAKY, 'not json', { change: true });
        await tick();
        setCardJson(FLAKY, cardJson('Flaky', 'mendedword'), { change: false });
        now += 1000;
        await tick();
        const retrySeq = maintainer.retrySeq();
        expect(retrySeq).toBeGreaterThan(0);
        maintainer.close();

        maintainer = searchIndex.createCharacterIndexMaintainer(directories, tantivy);
        expect(await maintainer.openPersisted()).not.toBeNull();
        expect(maintainer.retrySeq()).toBe(retrySeq);
    }, 20000);

    test('every failed attempt doubles the delay, capped at 5 minutes', async () => {
        if (!await setUp()) return;
        setCardJson(FLAKY, 'not json', { change: true });
        await tick();
        expect(retryMarks()[0].delay_ms).toBe(1000);

        const delays = [];
        for (let i = 0; i < 11; i++) {
            now = retryMarks()[0].next_attempt_at;
            const r = await tick();
            expect(r.seq).toBe(r.seqFrom);
            const [mark] = retryMarks();
            expect(mark.next_attempt_at).toBe(now + mark.delay_ms);
            delays.push(mark.delay_ms);
        }
        expect(delays).toEqual([2000, 4000, 8000, 16000, 32000, 64000, 128000, 256000, MAX_DELAY_MS, MAX_DELAY_MS, MAX_DELAY_MS]);
        expect(docCount(FLAKY, 'flakyword')).toBe(1);
    }, 30000);

    test('a failing change to a marked card doubles its delay too', async () => {
        if (!await setUp()) return;
        setCardJson(FLAKY, 'not json', { change: true });
        await tick();

        now += 10;
        setCardJson(FLAKY, 'still not json', { change: true });
        await tick();
        expect(retryMarks()).toEqual([{ id: FLAKY, next_attempt_at: now + 2000, delay_ms: 2000, last_error: parseError('still not json') }]);
    }, 20000);

    test('a failed retry that changes nothing in the index keeps the retry counter', async () => {
        if (!await setUp()) return;
        setCardJson(FLAKY, 'not json', { change: true });
        await tick();
        const retrySeqBefore = maintainer.retrySeq();
        now = retryMarks()[0].next_attempt_at;
        const r = await tick();
        expect(r.retrySeq).toBe(retrySeqBefore);
        expect(retryMarks()[0].delay_ms).toBe(2000);
    }, 20000);

    test('a failure is logged only when its error differs from the last one logged for that card', async () => {
        if (!await setUp()) return;
        setCardJson(FLAKY, 'not json', { change: true });
        await tick();
        expect(logsAbout(FLAKY)).toHaveLength(1);

        now = retryMarks()[0].next_attempt_at;
        await tick();
        now = retryMarks()[0].next_attempt_at;
        await tick();
        expect(logsAbout(FLAKY)).toHaveLength(1);

        setCardJson(FLAKY, '{', { change: false });
        now = retryMarks()[0].next_attempt_at;
        await tick();
        expect(logsAbout(FLAKY)).toHaveLength(2);
        expect(logsAbout(FLAKY)[1]).toContain(parseError('{'));
        expect(retryMarks()[0].last_error).toBe(parseError('{'));

        now = retryMarks()[0].next_attempt_at;
        await tick();
        expect(logsAbout(FLAKY)).toHaveLength(2);
    }, 20000);

    test('a retry of a card whose row is gone deletes its doc and clears the mark', async () => {
        if (!await setUp()) return;
        setCardJson(FLAKY, 'not json', { change: true });
        await tick();
        const retrySeqBefore = maintainer.retrySeq();

        // Deleted without a change row, so only the retry sees it.
        const db = new Database(dbPath());
        try {
            db.prepare('DELETE FROM characters WHERE id = ?').run(FLAKY);
        } finally {
            db.close();
        }
        now = retryMarks()[0].next_attempt_at;
        const r = await tick();
        expect(docCount(FLAKY)).toBe(0);
        expect(retryMarks()).toEqual([]);
        expect(r.retrySeq).toBe(retrySeqBefore + 1);
    }, 20000);

    test('each tick retries at most CHARACTER_INDEX_RETRY_BATCH_SIZE due cards', async () => {
        if (!await setUp()) return;
        const batch = searchIndex.CHARACTER_INDEX_RETRY_BATCH_SIZE;
        expect(Number.isInteger(batch) && batch > 0).toBe(true);
        const extra = 5;
        const db = new Database(dbPath());
        try {
            const insert = db.prepare('INSERT INTO character_index_retries (id, next_attempt_at, delay_ms, last_error) VALUES (?, ?, 1000, \'x\')');
            for (let i = 0; i < batch + extra; i++) insert.run(`Ghost${String(i).padStart(5, '0')}.png`, now);
        } finally {
            db.close();
        }
        await tick();
        expect(retryMarks()).toHaveLength(extra);
        await tick();
        expect(retryMarks()).toEqual([]);
    }, 30000);

    test('under a lock neither the mark nor the cursors land and nothing is logged; the next tick writes and logs both', async () => {
        if (!await setUp()) return;
        const persistedBefore = await metadataDb.getMetaValue(directories, SEQ_META_KEY);
        setCardJson(FLAKY, 'not json', { change: true });

        const blocker = new Database(dbPath());
        let skipped;
        try {
            blocker.exec('BEGIN IMMEDIATE');
            skipped = await tick();
        } finally {
            blocker.exec('ROLLBACK');
            blocker.close();
        }
        expect(skipped.persistSkipped).toBe(true);
        expect(retryMarks()).toEqual([]);
        expect(await metadataDb.getMetaValue(directories, SEQ_META_KEY)).toBe(persistedBefore);
        expect(logsAbout(FLAKY)).toHaveLength(0);

        const redone = await tick();
        expect(redone.persistSkipped).toBe(false);
        expect(retryMarks()).toHaveLength(1);
        expect(Number(await metadataDb.getMetaValue(directories, SEQ_META_KEY))).toBe(redone.seq);
        expect(logsAbout(FLAKY)).toHaveLength(1);
        expect(docCount(FLAKY, 'flakyword')).toBe(1);
    }, 20000);
});

describe('characters-search-index.js: a card that fails to re-index is warned about', () => {
    test('a failure hands one warning naming the card to onIndexFailure', async () => {
        if (!await setUp()) return;
        setCardJson(FLAKY, 'not json', { change: true });
        await tick();

        expect(warnings).toEqual([{ id: FLAKY, name: 'Flaky', error: parseError('not json'), retryInMs: 1000, keptEntry: true }]);
    }, 20000);

    test('a failure is warned about only when its error differs from the last one for that card', async () => {
        if (!await setUp()) return;
        setCardJson(FLAKY, 'not json', { change: true });
        await tick();
        now = retryMarks()[0].next_attempt_at;
        await tick();
        now = retryMarks()[0].next_attempt_at;
        await tick();
        expect(warnings).toHaveLength(1);

        setCardJson(FLAKY, '{', { change: false });
        now = retryMarks()[0].next_attempt_at;
        await tick();
        expect(warnings).toHaveLength(2);
        expect(warnings[1]).toEqual({ id: FLAKY, name: 'Flaky', error: parseError('{'), retryInMs: 8000, keptEntry: true });

        now = retryMarks()[0].next_attempt_at;
        await tick();
        expect(warnings).toHaveLength(2);
    }, 20000);

    test('under a lock nothing is warned about; the tick that lands the mark warns', async () => {
        if (!await setUp()) return;
        setCardJson(FLAKY, 'not json', { change: true });

        const blocker = new Database(dbPath());
        try {
            blocker.exec('BEGIN IMMEDIATE');
            expect((await tick()).persistSkipped).toBe(true);
        } finally {
            blocker.exec('ROLLBACK');
            blocker.close();
        }
        expect(warnings).toEqual([]);

        await tick();
        expect(warnings).toHaveLength(1);
        expect(warnings[0].id).toBe(FLAKY);
    }, 20000);
});
