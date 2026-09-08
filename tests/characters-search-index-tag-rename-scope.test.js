import { describe, test, expect, beforeAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** @type {typeof import('../src/endpoints/characters-search-index.js')} */
let searchIndex;
/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {typeof import('../src/character-card-parser.js')} */
let cardParser;
/** @type {typeof import('../src/endpoints/search-engine.js')} */
let searchEngine;

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
 * Polls `searchCharacterIds(handle, directories, term)` until `predicate` is satisfied or the attempt budget
 * runs out - the same idiom characters-query.test.js's fav-toggle catch-up test and
 * chat-content-search-index.test.js's pollUntil() use, since search-index-coordinator.js deliberately serves a
 * stale-but-present index immediately and runs incremental catch-up in the background rather than blocking the
 * request that first observes a new freshness signature.
 * @param {string} handle
 * @param {string} term
 * @param {(ids: string[]) => boolean} predicate
 * @returns {Promise<string[]>}
 */
async function pollSearch(handle, term, predicate) {
    let ids = [];
    for (let attempt = 0; attempt < 40; attempt++) {
        ids = (await searchIndex.searchCharacterIds(handle, directories, term)).ids;
        if (predicate(ids)) break;
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    return ids;
}

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    searchIndex = await import('../src/endpoints/characters-search-index.js');
    metadataDb = await import('../src/character-metadata-db.js');
    cardParser = await import('../src/character-card-parser.js');
    searchEngine = await import('../src/endpoints/search-engine.js');
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

afterEach(() => {
    metadataDb.disposeMetadataStores();
});

/**
 * Regression coverage for applyIncrementalTantivyChanges() (characters-search-index.js) scoping a tag-definition
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

        // UntouchedChar's own card file is now gone. A character that genuinely needs re-indexing tolerates
        // this (processCharacter() throwing is caught and treated as "leave it deleted" - see
        // applyIncrementalTantivyChanges()'s own comment on that), so if the scoped rename below wrongly swept
        // UntouchedChar in anyway, it would vanish from the index; if it's correctly left untouched, deleting a
        // file nothing is about to re-read has no effect on it at all.
        fs.unlinkSync(path.join(charactersDir, 'UntouchedChar.png'));

        // Only tag-alpha (TouchedChar's tag) is renamed - tag-bravo (UntouchedChar's tag) is resaved unchanged.
        await metadataDb.saveTagDefinitions(directories, [
            { id: 'tag-alpha', name: 'AlphaRenamed' },
            { id: 'tag-bravo', name: 'Bravo' },
        ]);

        // Wait for the background incremental catch-up this tag-definition write triggers to actually land -
        // proven by the renamed text becoming searchable, not by a fixed sleep.
        const renamedHit = await pollSearch(handle, 'AlphaRenamed', ids => ids.length > 0);
        expect(renamedHit).toEqual(['TouchedChar.png']);

        // UntouchedChar is still fully searchable by name even though its own card file no longer exists on
        // disk - proof the rename's catch-up never tried to re-read it.
        expect((await searchIndex.searchCharacterIds(handle, directories, 'UntouchedChar')).ids).toEqual(['UntouchedChar.png']);
    }, 20000);
});
