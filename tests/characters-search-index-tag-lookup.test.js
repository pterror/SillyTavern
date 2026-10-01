import { describe, test, expect, jest, beforeAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { storedTagDefinitions } from './tag-store-reads.js';

/** @type {typeof import('../src/character-metadata-db.js')} */
let actualMetadataDb;
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

/** @type {import('@jest/globals').jest.Mock} */
let getTagDefinitionsByIdsSpy;

let tempDir;
let charactersDir;
/** @type {import('../src/users.js').UserDirectoryList} */
let directories;
let maintainer;
/** @type {Record<string, unknown>[]} */
let indexedDocs;

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

async function setUpLibrary() {
    await writeCard('Ann');
    await writeCard('Ben');
    await metadataDb.bootstrapIfNeeded(directories);
    await metadataDb.saveTagDefinitions(directories, [
        { id: 'tag-alpha', name: 'Alpha' },
        { id: 'tag-bravo', name: 'Bravo' },
        { id: 'tag-charlie', name: 'Charlie' },
    ]);
    expect(await metadataDb.assignEntityTag(directories, 'Ann.png', 'tag-alpha')).toBe('ok');
    expect(await metadataDb.assignEntityTag(directories, 'Ann.png', 'tag-bravo')).toBe('ok');
    expect(await metadataDb.assignEntityTag(directories, 'Ben.png', 'tag-charlie')).toBe('ok');
}

/**
 * The rebuild looks up tags and builds docs too; clearing after it leaves a test only what its tick does.
 * @param {any} tantivy
 */
async function rebuiltMaintainer(tantivy) {
    const recordingTantivy = {
        ...tantivy,
        Document: {
            fromDict(dict, schema) {
                indexedDocs.push(dict);
                return tantivy.Document.fromDict(dict, schema);
            },
        },
    };
    maintainer = searchIndex.createCharacterIndexMaintainer(directories, recordingTantivy);
    expect(await maintainer.rebuild()).not.toBeNull();
    getTagDefinitionsByIdsSpy.mockClear();
    indexedDocs = [];
    return maintainer;
}

/** @returns {string[]} */
function requestedTagIds() {
    return getTagDefinitionsByIdsSpy.mock.calls.flatMap(([, ids]) => /** @type {string[]} */ (ids));
}

/** @param {string} avatar */
function indexedDocFor(avatar) {
    return indexedDocs.find(dict => dict[tantivySearch.DATA_FIELD] === avatar);
}

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    actualMetadataDb = await import('../src/character-metadata-db.js');
    getTagDefinitionsByIdsSpy = jest.fn((...args) => actualMetadataDb.getTagDefinitionsByIds(...args));
    jest.unstable_mockModule('../src/character-metadata-db.js', () => ({
        ...actualMetadataDb,
        getTagDefinitionsByIds: getTagDefinitionsByIdsSpy,
    }));

    searchIndex = await import('../src/endpoints/characters-search-index.js');
    metadataDb = await import('../src/character-metadata-db.js');
    cardParser = await import('../src/character-card-parser.js');
    tantivyEngine = await import('../src/endpoints/tantivy-engine.js');
    tantivySearch = await import('../src/endpoints/tantivy-search.js');
    searchCoordinator = await import('../src/endpoints/search-index-coordinator.js');
});

beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-search-tag-lookup-test-'));
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
    indexedDocs = [];
    getTagDefinitionsByIdsSpy.mockClear();
});

afterEach(async () => {
    maintainer?.close();
    await searchCoordinator.disposeSearchWorkers();
    metadataDb.disposeMetadataStores();
    fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('characters-search-index.js: a catch-up tick looks up only its batches\' tags', () => {
    test('an idle tick reads no tags', async () => {
        const tantivy = await tantivyEngine.getTantivyModule();
        if (!tantivy) {
            return;
        }

        await setUpLibrary();
        await rebuiltMaintainer(tantivy);

        const result = /** @type {import('../src/endpoints/characters-search-index.js').TickResult} */ (await maintainer.tick());
        expect(result).not.toBeNull();
        expect(result).not.toHaveProperty('swapped');
        expect(result.upserts).toBe(0);
        expect(result.deletes).toBe(0);

        expect(requestedTagIds()).toEqual([]);
    }, 20000);

    test('a tick reads only the tags of the characters in its batch', async () => {
        const tantivy = await tantivyEngine.getTantivyModule();
        if (!tantivy) {
            return;
        }

        await setUpLibrary();
        await rebuiltMaintainer(tantivy);

        expect(await metadataDb.setCharacterFav(directories, 'Ann.png', true)).toBe(true);
        const result = /** @type {import('../src/endpoints/characters-search-index.js').TickResult} */ (await maintainer.tick());
        expect(result).not.toBeNull();
        expect(result).not.toHaveProperty('swapped');
        expect(result.upserts).toBe(1);

        // Not Ben's tag-charlie.
        expect(requestedTagIds().sort()).toEqual(['tag-alpha', 'tag-bravo']);
    }, 20000);

    test('a tick indexes the same tag names that resolving against every tag definition gives', async () => {
        const tantivy = await tantivyEngine.getTantivyModule();
        if (!tantivy) {
            return;
        }

        await setUpLibrary();
        await rebuiltMaintainer(tantivy);

        const everyTagById = new Map((await storedTagDefinitions(actualMetadataDb, directories)).map(tag => [tag.id, tag]));
        const assignments = await actualMetadataDb.getEntityTagIdsForMany(directories, ['Ann.png'], { type: 'character' });
        const namesBefore = (assignments?.['Ann.png'] ?? []).map(id => everyTagById.get(id)?.name).filter(Boolean).join(' ');
        expect(namesBefore).toBe('Alpha Bravo');

        expect(await metadataDb.setCharacterFav(directories, 'Ann.png', true)).toBe(true);
        const result = /** @type {import('../src/endpoints/characters-search-index.js').TickResult} */ (await maintainer.tick());
        expect(result).not.toBeNull();
        expect(result.upserts).toBe(1);

        const annDoc = indexedDocFor('Ann.png');
        expect(annDoc).toBeDefined();
        expect(annDoc?.resolved_tags).toBe(namesBefore);
    }, 20000);

    test('a tag row that will not parse is skipped with a warning naming its id, and the tick still indexes the character', async () => {
        const tantivy = await tantivyEngine.getTantivyModule();
        if (!tantivy) {
            return;
        }

        await setUpLibrary();
        expect(await metadataDb.createTagDefinition(directories, { id: 'tag-broken', name: 'Broken' })).toEqual({ refused: [], tag: expect.objectContaining({ id: 'tag-broken', name: 'Broken' }) });
        expect(await metadataDb.assignEntityTag(directories, 'Ann.png', 'tag-broken')).toBe('ok');
        await rebuiltMaintainer(tantivy);

        const corruptData = '{not json';
        let parseMessage = '';
        try {
            JSON.parse(corruptData);
        } catch (err) {
            parseMessage = /** @type {Error} */ (err).message;
        }
        const { default: Database } = await import('better-sqlite3');
        const rawDb = new Database(path.join(directories.root, 'character-metadata.sqlite'));
        try {
            rawDb.prepare('UPDATE tags SET data = ? WHERE id = ?').run(corruptData, 'tag-broken');
        } finally {
            rawDb.close();
        }

        expect(await metadataDb.setCharacterFav(directories, 'Ann.png', true)).toBe(true);
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const result = /** @type {import('../src/endpoints/characters-search-index.js').TickResult} */ (await maintainer.tick());
            expect(result).not.toBeNull();
            expect(result).not.toHaveProperty('swapped');
            expect(result.upserts).toBe(1);

            const warning = warnSpy.mock.calls.map(call => String(call[0])).find(message => message.includes('tag-broken'));
            expect(warning).toBeDefined();
            expect(warning).toContain('[character-metadata]');
            expect(warning).toContain(parseMessage);
        } finally {
            warnSpy.mockRestore();
        }

        expect(requestedTagIds().sort()).toEqual(['tag-alpha', 'tag-bravo', 'tag-broken']);
        const annDoc = indexedDocFor('Ann.png');
        expect(annDoc).toBeDefined();
        expect(annDoc?.resolved_tags).toBe('Alpha Bravo');
    }, 20000);
});
