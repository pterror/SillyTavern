import { describe, test, expect, beforeAll, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';

import { splitCard } from '../src/character-card-storage.js';
import { defineCharacterStoreFunctions } from '../src/character-store-schema.js';

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
/** @type {typeof import('../src/character-card-normalize.js')} */
let cardNormalize;
/** @type {typeof import('../src/character-shallow.js')} */
let characterShallow;

let tempDir;
let charactersDir;
/** @type {import('../src/users.js').UserDirectoryList} */
let directories;
let maintainer;
let tantivy;
/** The fake clock every build and tick reads through Date.now(). */
let now;
/** Every console.error / console.warn call, joined into one line each. */
let logged;
/** Every warning the maintainer handed to its onIndexFailure. */
let warnings;

const SCHEMA_VERSION_META_KEY = 'tantivy_char_index_schema_version';
const GOOD = 'Good.png';
const FLAKY = 'Flaky.png';
const THIRD = 'Third.png';

const dbPath = () => path.join(tempDir, 'character-metadata.sqlite');
const searchIndexDir = () => path.join(tempDir, 'search-index');
const indexDir = () => path.join(searchIndexDir(), 'characters-tantivy');

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

/** A card the index can't process: a V2 card whose `data` is null. */
const BROKEN = { name: 'Flaky', spec: 'chara_card_v2', data: null };

/**
 * A raw connection to the store, with the functions its indexes and triggers call.
 * @param {import('better-sqlite3').Options} [options]
 */
function openDb(options) {
    const db = new Database(dbPath(), options);
    defineCharacterStoreFunctions({ defineFunction: (name, fn) => db.function(name, { deterministic: true }, fn) });
    return db;
}

/** @param {(db: import('better-sqlite3').Database) => void} fn */
function withDb(fn) {
    const db = openDb();
    try {
        fn(db);
    } finally {
        db.close();
    }
}

/**
 * Stores `card` as a row's card straight in the db (its card table rows and its row's card values), optionally with
 * a change row for it.
 * @param {string} id
 * @param {unknown} card
 * @param {{ change: boolean }} options
 */
function setCard(id, card, { change }) {
    withDb((db) => {
        const parts = splitCard(card);
        const { columns } = parts;
        for (const table of ['cards', 'card_greetings', 'card_tags', 'card_extensions', 'card_extra']) {
            db.prepare(`DELETE FROM ${table} WHERE character_id = ?`).run(id);
        }
        db.prepare('UPDATE characters SET name = ?, creator = ?, character_version = ?, world = ?, create_date_raw = ? WHERE id = ?')
            .run(columns.name ?? null, columns.creator ?? null, columns.character_version ?? null, columns.world ?? null, columns.create_date ?? null, id);
        const cardColumns = Object.keys(parts.card);
        db.prepare(`INSERT INTO cards (character_id${cardColumns.map(c => `, ${c}`).join('')}) VALUES (?${cardColumns.map(() => ', ?').join('')})`).run(id, ...cardColumns.map(c => parts.card[c]));
        for (const g of parts.greetings) db.prepare('INSERT INTO card_greetings VALUES (?, ?, ?, ?)').run(id, g.list, g.position, g.text);
        for (const t of parts.tags) db.prepare('INSERT INTO card_tags VALUES (?, ?, ?)').run(id, t.position, t.name);
        for (const e of parts.extensions) db.prepare('INSERT INTO card_extensions VALUES (?, ?, ?)').run(id, e.key, e.value);
        for (const x of parts.extra) db.prepare('INSERT INTO card_extra VALUES (?, ?, ?)').run(id, x.path, x.value);
        if (change) {
            db.prepare('INSERT INTO changes (id, op, fields) VALUES (?, \'upsert\', NULL)').run(id);
        }
    });
}

/** Deletes a row with no change row, so only a full rebuild can notice it's gone. */
function deleteRowSilently(id) {
    withDb(db => db.prepare('DELETE FROM characters WHERE id = ?').run(id));
}

/** @returns {{ id: string, next_attempt_at: number, delay_ms: number, last_error: string }[]} */
function retryMarks() {
    const db = openDb({ readonly: true });
    try {
        return Array.from(db.prepare('SELECT id, next_attempt_at, delay_ms, last_error FROM character_index_retries ORDER BY id').iterate());
    } finally {
        db.close();
    }
}

/** What processCharacter() throws for `card`, as the retry mark records it. */
function processingError(card) {
    try {
        characterShallow.calculateDataSize(cardNormalize.getCharaCardV2(structuredClone(card), directories, false).data);
    } catch (err) {
        return String(err);
    }
    throw new Error(`${JSON.stringify(card)} is processed`);
}

/**
 * How many docs the persisted index holds for `id`, optionally only those whose description matches `word`.
 * @param {string} id
 * @param {string} [word]
 */
function docCount(id, word) {
    const index = tantivy.Index.open(indexDir());
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

/** Leftover rebuild or old-aside dirs next to the index. */
function strayDirs() {
    return fs.readdirSync(searchIndexDir()).filter(entry => entry !== 'characters-tantivy' && entry.startsWith('characters-tantivy'));
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
    cardNormalize = await import('../src/character-card-normalize.js');
    characterShallow = await import('../src/character-shallow.js');
});

beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-search-index-rebuild-keep-test-'));
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
 * Builds an index over Good ("steadyword"), Flaky ("flakyword") and Third ("thirdword").
 * @returns {Promise<boolean>} false when tantivy isn't available here.
 */
async function setUp() {
    tantivy = await tantivyEngine.getTantivyModule();
    if (!tantivy) return false;
    await writeCard('Good', 'steadyword');
    await writeCard('Flaky', 'flakyword');
    await writeCard('Third', 'thirdword');
    await metadataDb.bootstrapIfNeeded(directories);
    maintainer = searchIndex.createCharacterIndexMaintainer(directories, tantivy, { onIndexFailure: warning => warnings.push(warning) });
    expect(await maintainer.rebuild()).not.toBeNull();
    expect(docCount(FLAKY, 'flakyword')).toBe(1);
    return true;
}

describe('characters-search-index.js: a full rebuild keeps the old doc of a card that fails', () => {
    test('a card that fails during a rebuild keeps its old doc, is marked for retry and is logged', async () => {
        if (!await setUp()) return;
        setCard(FLAKY, BROKEN, { change: false });

        expect(await maintainer.rebuild()).not.toBeNull();

        expect(docCount(FLAKY)).toBe(1);
        expect(docCount(FLAKY, 'flakyword')).toBe(1);
        expect(retryMarks()).toEqual([{ id: FLAKY, next_attempt_at: now + 1000, delay_ms: 1000, last_error: processingError(BROKEN) }]);
        expect(logsAbout(FLAKY)).toHaveLength(1);
        expect(logsAbout(FLAKY)[0]).toContain(processingError(BROKEN));
        expect(strayDirs()).toEqual([]);
    }, 20000);

    test('every other card gets exactly one doc, built from its current row', async () => {
        if (!await setUp()) return;
        setCard(GOOD, JSON.parse(cardJson('Good', 'mendedword')), { change: false });
        setCard(FLAKY, BROKEN, { change: false });

        await maintainer.rebuild();

        expect(docCount(GOOD)).toBe(1);
        expect(docCount(GOOD, 'mendedword')).toBe(1);
        expect(docCount(THIRD)).toBe(1);
        expect(docCount(FLAKY)).toBe(1);
    }, 20000);

    test('a doc whose row is gone is removed, whichever segment it is in, and its mark is cleared', async () => {
        if (!await setUp()) return;
        // Re-indexed by a tick, so its doc sits in a later segment than the build's.
        setCard(THIRD, JSON.parse(cardJson('Third', 'retickedword')), { change: true });
        await tick();
        withDb(db => db.prepare('INSERT INTO character_index_retries (id, next_attempt_at, delay_ms, last_error) VALUES (?, ?, 1000, \'x\')').run(GOOD, now + 1000));
        deleteRowSilently(GOOD);
        deleteRowSilently(THIRD);

        await maintainer.rebuild();

        expect(docCount(GOOD)).toBe(0);
        expect(docCount(THIRD)).toBe(0);
        expect(docCount(FLAKY)).toBe(1);
        expect(retryMarks()).toEqual([]);
    }, 20000);

    test('a rebuild clears the mark of a card it indexes', async () => {
        if (!await setUp()) return;
        setCard(FLAKY, BROKEN, { change: true });
        await tick();
        expect(retryMarks()).toHaveLength(1);
        setCard(FLAKY, JSON.parse(cardJson('Flaky', 'mendedword')), { change: false });

        await maintainer.rebuild();

        expect(retryMarks()).toEqual([]);
        expect(docCount(FLAKY)).toBe(1);
        expect(docCount(FLAKY, 'mendedword')).toBe(1);
    }, 20000);

    test('a card already marked with the same error isn\'t logged again, and its delay doubles', async () => {
        if (!await setUp()) return;
        setCard(FLAKY, BROKEN, { change: true });
        await tick();
        expect(logsAbout(FLAKY)).toHaveLength(1);

        await maintainer.rebuild();

        expect(logsAbout(FLAKY)).toHaveLength(1);
        expect(retryMarks()).toEqual([{ id: FLAKY, next_attempt_at: now + 2000, delay_ms: 2000, last_error: processingError(BROKEN) }]);
        expect(docCount(FLAKY, 'flakyword')).toBe(1);
    }, 20000);

    test('the marks are written batch by batch, so they land even when the swap fails', async () => {
        if (!await setUp()) return;
        setCard(FLAKY, BROKEN, { change: false });
        const renameSync = fs.renameSync;
        jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
            if (String(from) === indexDir()) throw new Error('swap failed');
            return renameSync(from, to);
        });

        await expect(maintainer.rebuild()).rejects.toThrow('swap failed');

        expect(retryMarks()).toEqual([{ id: FLAKY, next_attempt_at: now + 1000, delay_ms: 1000, last_error: processingError(BROKEN) }]);
    }, 20000);

    test('the old index is hard-linked into the rebuild, never copied, apart from its small json files', async () => {
        if (!await setUp()) return;
        const linkSync = jest.spyOn(fs, 'linkSync');
        const copyFileSync = jest.spyOn(fs, 'copyFileSync');

        await maintainer.rebuild();

        expect(linkSync).toHaveBeenCalled();
        for (const [from] of linkSync.mock.calls) {
            expect(path.dirname(String(from))).toBe(indexDir());
        }
        for (const [from] of copyFileSync.mock.calls) {
            expect(String(from).endsWith('.json')).toBe(true);
        }
    }, 20000);

    test('when the filesystem can\'t hard-link, the rebuild starts empty, logs that once, and still marks the failing card', async () => {
        if (!await setUp()) return;
        setCard(FLAKY, BROKEN, { change: false });
        jest.spyOn(fs, 'linkSync').mockImplementation(() => {
            throw Object.assign(new Error('EPERM: operation not permitted, link'), { code: 'EPERM' });
        });

        expect(await maintainer.rebuild()).not.toBeNull();

        expect(logged.filter(line => line.includes('hard-link'))).toHaveLength(1);
        expect(docCount(FLAKY)).toBe(0);
        expect(docCount(GOOD)).toBe(1);
        expect(retryMarks()).toEqual([{ id: FLAKY, next_attempt_at: now + 1000, delay_ms: 1000, last_error: processingError(BROKEN) }]);
        expect(logsAbout(FLAKY)).toHaveLength(1);
        expect(strayDirs()).toEqual([]);
    }, 20000);

    test('when the persisted schema version doesn\'t match, the rebuild starts empty and still marks the failing card', async () => {
        if (!await setUp()) return;
        setCard(FLAKY, BROKEN, { change: false });
        await metadataDb.setMetaValue(directories, SCHEMA_VERSION_META_KEY, '999');
        const linkSync = jest.spyOn(fs, 'linkSync');

        expect(await maintainer.rebuild()).not.toBeNull();

        expect(linkSync).not.toHaveBeenCalled();
        expect(docCount(FLAKY)).toBe(0);
        expect(docCount(GOOD)).toBe(1);
        expect(retryMarks()).toEqual([{ id: FLAKY, next_attempt_at: now + 1000, delay_ms: 1000, last_error: processingError(BROKEN) }]);
        expect(await metadataDb.getMetaValue(directories, SCHEMA_VERSION_META_KEY)).not.toBe('999');
    }, 20000);
});

describe('characters-search-index.js: a card that fails during a full rebuild is warned about', () => {
    test('a failure hands one warning naming the card to onIndexFailure, saying it keeps its old entry', async () => {
        if (!await setUp()) return;
        setCard(FLAKY, BROKEN, { change: false });

        await maintainer.rebuild();

        expect(warnings).toEqual([{ id: FLAKY, name: 'Flaky', error: processingError(BROKEN), retryInMs: 1000, keptEntry: true }]);
    }, 20000);

    test('a card already marked with the same error isn\'t warned about again', async () => {
        if (!await setUp()) return;
        setCard(FLAKY, BROKEN, { change: true });
        await tick();
        expect(warnings).toHaveLength(1);

        await maintainer.rebuild();

        expect(warnings).toHaveLength(1);
    }, 20000);

    test('when the rebuild starts empty, the warning says the card has no entry', async () => {
        if (!await setUp()) return;
        setCard(FLAKY, BROKEN, { change: false });
        jest.spyOn(fs, 'linkSync').mockImplementation(() => {
            throw Object.assign(new Error('EPERM: operation not permitted, link'), { code: 'EPERM' });
        });

        await maintainer.rebuild();

        expect(warnings).toEqual([{ id: FLAKY, name: 'Flaky', error: processingError(BROKEN), retryInMs: 1000, keptEntry: false }]);
    }, 20000);
});
