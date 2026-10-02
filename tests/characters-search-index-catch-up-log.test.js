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
/** @type {typeof import('../src/endpoints/search-index-coordinator.js')} */
let searchCoordinator;

let tempDir;
let charactersDir;
/** @type {import('../src/users.js').UserDirectoryList} */
let directories;
let maintainer;

/** @param {string} name */
async function writeCard(name) {
    const baseImage = await fs.promises.readFile(path.join(process.cwd(), '..', 'public', 'img', 'ai4.png'));
    const card = {
        name,
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name,
            description: '', personality: '', scenario: '', first_mes: '', mes_example: '',
            tags: [], creator: '', character_version: '', creator_notes: '',
            extensions: { fav: false, world: '' },
        },
    };
    await fs.promises.writeFile(path.join(charactersDir, `${name}.png`), cardParser.write(baseImage, JSON.stringify(card)));
}

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    searchIndex = await import('../src/endpoints/characters-search-index.js');
    metadataDb = await import('../src/character-metadata-db.js');
    cardParser = await import('../src/character-card-parser.js');
    tantivyEngine = await import('../src/endpoints/tantivy-engine.js');
    searchCoordinator = await import('../src/endpoints/search-index-coordinator.js');
});

beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-search-catch-up-log-test-'));
    charactersDir = path.join(tempDir, 'characters');
    directories = {
        root: tempDir,
        characters: charactersDir,
        chats: path.join(tempDir, 'chats'),
        groups: path.join(tempDir, 'groups'),
        groupChats: path.join(tempDir, 'groupChats'),
    };
    for (const dir of [charactersDir, directories.chats, directories.groups, directories.groupChats]) {
        fs.mkdirSync(dir, { recursive: true });
    }
    maintainer = null;
});

afterEach(async () => {
    maintainer?.close();
    await searchCoordinator.disposeSearchWorkers();
    metadataDb.disposeMetadataStores();
    fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('characters-search-index.js: catch-up log line', () => {
    test('a tick reports its seq range, writer mix, backlog and per-phase times', async () => {
        const tantivy = await tantivyEngine.getTantivyModule();
        if (!tantivy) {
            return;
        }

        await writeCard('FavChar');
        await writeCard('PlainChar');
        await metadataDb.bootstrapIfNeeded(directories);

        maintainer = searchIndex.createCharacterIndexMaintainer(directories, tantivy);
        expect(await maintainer.rebuild()).not.toBeNull();
        const seqBefore = maintainer.seq();

        await metadataDb.setCharacterFav(directories, 'FavChar.png', true);

        const result = await maintainer.tick();
        expect(result).not.toBeNull();
        expect(result).not.toHaveProperty('swapped');
        const r = /** @type {import('../src/endpoints/characters-search-index.js').TickResult} */ (result);

        expect(r.changed).toBe(true);
        expect(r.seqFrom).toBe(seqBefore);
        expect(r.seq).toBeGreaterThan(seqBefore);
        expect(r.backlog).toBe(0);
        expect(r.writers).toEqual({ fav: 1 });
        expect(r.upserts).toBe(1);
        expect(r.tagRenames).toBe(0);
        expect(r.tagNameSeq).toBe(r.tagNameSeqFrom);
        expect(Object.keys(r.phases).sort()).toEqual(['add', 'build', 'commit', 'deletes', 'load', 'persist', 'read', 'tags']);
        expect(r.lockWaitMs).toBe(0);

        const line = searchIndex.formatCatchUpLine(r);
        expect(line).toMatch(new RegExp(`^\\[search\\] catch-up: seq=${seqBefore}\\.\\.${r.seq} backlog=0 writers=fav:1 tagrenames=0 deletes=0 upserts=1 total_ms=\\d+ read_ms=\\d+ deletes_ms=\\d+ tags_ms=\\d+ load_ms=\\d+ build_ms=\\d+ add_ms=\\d+ commit_ms=\\d+ persist_ms=\\d+ lockwait_ms=0$`));
        expect(line).not.toContain('\n');
    }, 20000);

    test('the line names the tag-rename cursor only when it moved, and counts an id under each of its fields', () => {
        const phases = { read: 1, deletes: 2, tags: 3, load: 4, build: 5, add: 6, commit: 7, persist: 8 };
        const base = {
            changed: true, deletes: 0, upserts: 3, ms: 40, seq: 20, seqFrom: 10, tagNameSeqFrom: 5, tagNameSeq: 5,
            backlog: 4, writers: { fav: 2, tag_ids: 1, null: 1 }, tagRenames: 0, phases, lockWaitMs: 9,
        };
        expect(searchIndex.formatCatchUpLine(base)).toBe(
            '[search] catch-up: seq=10..20 backlog=4 writers=fav:2,tag_ids:1,whole-record:1 tagrenames=0 deletes=0 upserts=3 total_ms=40'
            + ' read_ms=1 deletes_ms=2 tags_ms=3 load_ms=4 build_ms=5 add_ms=6 commit_ms=7 persist_ms=8 lockwait_ms=9');
        expect(searchIndex.formatCatchUpLine({ ...base, tagNameSeq: 7, tagRenames: 2 }))
            .toContain('seq=10..20 tagseq=5..7 backlog=4 writers=fav:2,tag_ids:1,whole-record:1 tagrenames=2 ');
    });

    test('a full rebuild batch logs its own progress line, naming failures only when there are some', () => {
        expect(searchIndex.formatRebuildBatchLine({ batch: 3, cards: 500, failed: 0, doneSoFar: 1500, ms: 42 }))
            .toBe('[search] full rebuild: batch 3, 500 cards, 1500 done so far, 42 ms');
        expect(searchIndex.formatRebuildBatchLine({ batch: 1, cards: 7, failed: 2, doneSoFar: 7, ms: 3 }))
            .toBe('[search] full rebuild: batch 1, 7 cards (2 failed), 7 done so far, 3 ms');
    });

    test('a single update logs nothing; several changes, renames, a backlog, a failure or a skipped persist log', () => {
        const single = {
            changed: true, deletes: 0, upserts: 1, ms: 5, seq: 11, seqFrom: 10, tagNameSeqFrom: 5, tagNameSeq: 5,
            retrySeq: 0, retried: 0, failed: 0, backlog: 0, writers: { fav: 1 }, tagRenames: 0, phases: {}, lockWaitMs: 0,
        };
        expect(searchIndex.isBatchCatchUp(single)).toBe(false);
        expect(searchIndex.isBatchCatchUp({ ...single, upserts: 0, deletes: 1 })).toBe(false);
        expect(searchIndex.isBatchCatchUp({ ...single, upserts: 2 })).toBe(true);
        expect(searchIndex.isBatchCatchUp({ ...single, deletes: 1 })).toBe(true);
        expect(searchIndex.isBatchCatchUp({ ...single, tagRenames: 1 })).toBe(true);
        expect(searchIndex.isBatchCatchUp({ ...single, backlog: 3 })).toBe(true);
        expect(searchIndex.isBatchCatchUp({ ...single, retried: 1 })).toBe(false);
        expect(searchIndex.isBatchCatchUp({ ...single, failed: 1 })).toBe(true);
        expect(searchIndex.isBatchCatchUp({ ...single, persistSkipped: true })).toBe(true);
    });

    test('a tick whose persist was skipped says so right after persist_ms; one that persisted is unchanged', () => {
        const phases = { read: 1, deletes: 2, tags: 3, load: 4, build: 5, add: 6, commit: 7, persist: 8 };
        const base = {
            changed: true, deletes: 0, upserts: 3, ms: 40, seq: 10, seqFrom: 10, tagNameSeqFrom: 5, tagNameSeq: 5,
            backlog: 14, writers: { fav: 3 }, tagRenames: 0, phases, lockWaitMs: 0,
        };
        expect(searchIndex.formatCatchUpLine({ ...base, persistSkipped: true })).toBe(
            '[search] catch-up: seq=10..10 backlog=14 writers=fav:3 tagrenames=0 deletes=0 upserts=3 total_ms=40'
            + ' read_ms=1 deletes_ms=2 tags_ms=3 load_ms=4 build_ms=5 add_ms=6 commit_ms=7 persist_ms=8 persist=skipped lockwait_ms=0');
        expect(searchIndex.formatCatchUpLine({ ...base, persistSkipped: false })).toBe(searchIndex.formatCatchUpLine(base));
        expect(searchIndex.formatCatchUpLine(base)).not.toContain('persist=skipped');
    });
});

describe('characters-search-index.js: persisting the cursors while the database is locked', () => {
    const metadataDbPath = () => path.join(tempDir, 'character-metadata.sqlite');
    const SEQ_META_KEY = 'tantivy_char_index_seq';

    test('a tick skips the persist without waiting, keeps its cursors, and the next tick redoes its work', async () => {
        const tantivy = await tantivyEngine.getTantivyModule();
        if (!tantivy) {
            return;
        }

        await writeCard('FavChar');
        await metadataDb.bootstrapIfNeeded(directories);
        maintainer = searchIndex.createCharacterIndexMaintainer(directories, tantivy);
        expect(await maintainer.rebuild()).not.toBeNull();
        const seqBefore = maintainer.seq();
        const persistedBefore = await metadataDb.getMetaValue(directories, SEQ_META_KEY);

        await metadataDb.setCharacterFav(directories, 'FavChar.png', true);

        const blocker = new Database(metadataDbPath());
        let result;
        try {
            blocker.exec('BEGIN IMMEDIATE');
            result = await maintainer.tick();
        } finally {
            blocker.exec('ROLLBACK');
            blocker.close();
        }
        const skipped = /** @type {import('../src/endpoints/characters-search-index.js').TickResult} */ (result);
        expect(skipped.persistSkipped).toBe(true);
        expect(skipped.upserts).toBe(1);
        expect(skipped.seq).toBe(seqBefore);
        expect(maintainer.seq()).toBe(seqBefore);
        expect(skipped.lockWaitMs).toBe(0);
        expect(await metadataDb.getMetaValue(directories, SEQ_META_KEY)).toBe(persistedBefore);
        expect(searchIndex.formatCatchUpLine(skipped)).toMatch(/ persist_ms=\d+ persist=skipped lockwait_ms=0$/);

        const redone = /** @type {import('../src/endpoints/characters-search-index.js').TickResult} */ (await maintainer.tick());
        expect(redone.persistSkipped).toBe(false);
        expect(redone.seqFrom).toBe(seqBefore);
        expect(redone.upserts).toBe(1);
        expect(redone.seq).toBeGreaterThan(seqBefore);
        expect(Number(await metadataDb.getMetaValue(directories, SEQ_META_KEY))).toBe(redone.seq);
        expect(searchIndex.formatCatchUpLine(redone)).not.toContain('persist=skipped');
    }, 20000);

    test('a rebuild retries its persist until it lands', async () => {
        const tantivy = await tantivyEngine.getTantivyModule();
        if (!tantivy) {
            return;
        }

        await writeCard('PlainChar');
        await metadataDb.bootstrapIfNeeded(directories);
        maintainer = searchIndex.createCharacterIndexMaintainer(directories, tantivy);

        const blocker = new Database(metadataDbPath());
        blocker.exec('BEGIN IMMEDIATE');
        let blocked = true;
        const release = () => {
            if (!blocked) return;
            blocked = false;
            blocker.exec('ROLLBACK');
            blocker.close();
        };
        // The lock is released when the rebuild schedules its first retry, so that retry is what lands.
        const realSetTimeout = globalThis.setTimeout;
        let retries = 0;
        const setTimeoutSpy = jest.spyOn(globalThis, 'setTimeout').mockImplementation(/** @type {any} */ ((fn, ms, ...args) => {
            if (ms === 100) {
                retries++;
                release();
            }
            return realSetTimeout(fn, ms, ...args);
        }));
        try {
            expect(await maintainer.rebuild()).not.toBeNull();
        } finally {
            setTimeoutSpy.mockRestore();
            release();
        }
        expect(retries).toBe(1);
        expect(Number(await metadataDb.getMetaValue(directories, SEQ_META_KEY))).toBe(maintainer.seq());
    }, 20000);
});
