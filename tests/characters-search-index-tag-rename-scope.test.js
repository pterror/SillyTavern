import { describe, test, expect, beforeAll, beforeEach, afterEach } from '@jest/globals';
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
/** @type {typeof import('../src/endpoints/search-engine.js')} */
let searchEngine;
/** @type {typeof import('../src/endpoints/search-index-coordinator.js')} */
let searchCoordinator;

let tempDir;
let charactersDir;
/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

/**
 * A minimal valid Spec V2 card - see characters-search-index-cold-start.test.js's identical helper for why this
 * shape and this base image specifically.
 * @param {string} name
 * @returns {Promise<void>}
 */
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
    const buffer = cardParser.write(baseImage, JSON.stringify(card));
    await fs.promises.writeFile(path.join(charactersDir, `${name}.png`), buffer);
}

/**
 * Polls `searchCharacterIds(handle, directories, term)` until `predicate` is satisfied or 5 s pass: the search
 * index worker catches up on its own tick (about once a second), and no request waits for it.
 * @param {string} handle
 * @param {string} term
 * @param {(ids: string[]) => boolean} predicate
 * @returns {Promise<string[]>}
 */
async function pollSearch(handle, term, predicate) {
    let ids = [];
    const deadline = Date.now() + 5000;
    do {
        ids = (await searchIndex.searchCharacterIds(handle, directories, term)).ids;
        if (predicate(ids)) break;
        await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    return ids;
}

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    searchIndex = await import('../src/endpoints/characters-search-index.js');
    metadataDb = await import('../src/character-metadata-db.js');
    cardParser = await import('../src/character-card-parser.js');
    searchEngine = await import('../src/endpoints/search-engine.js');
    searchCoordinator = await import('../src/endpoints/search-index-coordinator.js');
});

beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-search-tag-rename-scope-test-'));
    charactersDir = path.join(tempDir, 'characters');
    fs.mkdirSync(charactersDir, { recursive: true });
    directories = {
        root: tempDir,
        characters: charactersDir,
        chats: path.join(tempDir, 'chats'),
        groups: path.join(tempDir, 'groups'),
        groupChats: path.join(tempDir, 'groupChats'),
    };
    fs.mkdirSync(directories.chats, { recursive: true });
    fs.mkdirSync(directories.groups, { recursive: true });
    fs.mkdirSync(directories.groupChats, { recursive: true });
});

afterEach(async () => {
    await searchCoordinator.disposeSearchWorkers();
    metadataDb.disposeMetadataStores();
});

/**
 * Regression coverage for the search index worker's catch-up (createCharacterIndexMaintainer()'s tick()) scoping a tag-definition
 * rename to only the characters actually carrying the renamed tag id, instead of every tagged character in the
 * library - the previous behavior re-indexed the entire tagged population on ANY tag-definition-table write,
 * including one that only added a brand-new tag id (exactly what a bulk import does constantly), never renamed
 * anything already indexed.
 */
describe('characters-search-index.js: tag-rename incremental catch-up is scoped to the renamed tag(s)', () => {
    test('renaming one tag catches up the characters carrying it without touching characters carrying an unrelated tag', async () => {
        const engine = await searchEngine.resolveSearchEngine();
        if (engine.tier !== 'tantivy') {
            return;
        }

        await writeCard('TouchedChar');
        await writeCard('UntouchedChar');
        await metadataDb.bootstrapIfNeeded(directories);

        await metadataDb.saveTagDefinitions(directories, [
            { id: 'tag-alpha', name: 'Alpha' },
            { id: 'tag-bravo', name: 'Bravo' },
        ]);
        expect(await metadataDb.assignEntityTag(directories, 'TouchedChar.png', 'tag-alpha')).toBe('ok');
        expect(await metadataDb.assignEntityTag(directories, 'UntouchedChar.png', 'tag-bravo')).toBe('ok');

        const handle = 'tag-rename-scope-handle';
        const buildResult = await searchIndex.rebuildCharacterSearchIndex(handle, directories);
        expect(buildResult).toEqual({ ok: true, backend: 'tantivy' });

        expect((await searchIndex.searchCharacterIds(handle, directories, 'TouchedChar')).ids).toEqual(['TouchedChar.png']);
        expect((await searchIndex.searchCharacterIds(handle, directories, 'UntouchedChar')).ids).toEqual(['UntouchedChar.png']);

        // UntouchedChar's stored card is now one the index can't process (a V2 card whose `data` is null), written
        // straight to the db with no change row, so only a tag rename that wrongly swept it in would re-read it. That
        // re-read would fail, and a card that fails to re-index keeps its old doc and gets a retry mark (see
        // addCharacterBatch() and tick()), so the mark is what shows whether it was swept in.
        const db = new Database(path.join(tempDir, 'character-metadata.sqlite'));
        defineCharacterStoreFunctions({ defineFunction: (name, fn) => db.function(name, { deterministic: true }, fn) });
        try {
            const id = 'UntouchedChar.png';
            const parts = splitCard({ name: 'UntouchedChar', spec: 'chara_card_v2', data: null });
            const { columns } = parts;
            for (const table of ['cards', 'card_greetings', 'card_tags', 'card_extensions', 'card_extra']) {
                db.prepare(`DELETE FROM ${table} WHERE character_id = ?`).run(id);
            }
            db.prepare('UPDATE characters SET name = ?, creator = ?, character_version = ?, world = ?, create_date_raw = ? WHERE id = ?')
                .run(columns.name ?? null, columns.creator ?? null, columns.character_version ?? null, columns.world ?? null, columns.create_date ?? null, id);
            for (const x of parts.extra) {
                db.prepare('INSERT INTO card_extra VALUES (?, ?, ?)').run(id, x.path, x.value);
            }
        } finally {
            db.close();
        }

        // Only tag-alpha (TouchedChar's tag) is renamed - tag-bravo (UntouchedChar's tag) is resaved unchanged.
        await metadataDb.saveTagDefinitions(directories, [
            { id: 'tag-alpha', name: 'AlphaRenamed' },
            { id: 'tag-bravo', name: 'Bravo' },
        ]);

        // Wait for the background incremental catch-up this tag-definition write triggers to actually land -
        // proven by the renamed text becoming searchable, not by a fixed sleep.
        const renamedHit = await pollSearch(handle, 'AlphaRenamed', ids => ids.length > 0);
        expect(renamedHit).toEqual(['TouchedChar.png']);

        // The rename's retry marks are persisted in the same transaction as the tag-rename cursor, which can land
        // after its commit is searchable, so wait for the cursor to cover the rename.
        const renameSeq = await metadataDb.getCurrentTagNameChangeSeq(directories);
        const deadline = Date.now() + 5000;
        while (Number(await metadataDb.getMetaValue(directories, searchCoordinator.CHARACTERS_INDEX_TAG_NAME_CHANGE_SEQ_META_KEY)) < renameSeq
            && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        expect(Number(await metadataDb.getMetaValue(directories, searchCoordinator.CHARACTERS_INDEX_TAG_NAME_CHANGE_SEQ_META_KEY))).toBeGreaterThanOrEqual(renameSeq);

        // The rename's catch-up never tried to re-read UntouchedChar: it has no retry mark.
        expect([...await metadataDb.getCharacterIndexRetryMarksByIds(directories, ['UntouchedChar.png'])]).toEqual([]);
        expect((await searchIndex.searchCharacterIds(handle, directories, 'UntouchedChar')).ids).toEqual(['UntouchedChar.png']);
    }, 20000);
});
