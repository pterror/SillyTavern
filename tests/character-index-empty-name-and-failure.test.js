import { describe, test, expect, beforeAll, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** @type {typeof import('../src/endpoints/characters.js')} */
let characters;
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

const SHARED_WORD = 'zebrafish';

/** @param {string} name */
function cardJson(name) {
    return JSON.stringify({
        name,
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name,
            description: SHARED_WORD, personality: '', scenario: '', first_mes: '', mes_example: '',
            tags: [], creator: '', character_version: '', creator_notes: '',
            extensions: { fav: false, world: '' },
        },
    });
}

/**
 * @param {string} file File name, independent of the card's name.
 * @param {string} name
 */
async function writeCard(file, name) {
    const baseImage = await fs.promises.readFile(path.join(process.cwd(), '..', 'public', 'img', 'ai4.png'));
    await fs.promises.writeFile(path.join(charactersDir, file), cardParser.write(baseImage, cardJson(name)));
}

async function tantivyAvailable() {
    return (await searchEngine.resolveSearchEngine()).tier === 'tantivy';
}

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    characters = await import('../src/endpoints/characters.js');
    searchIndex = await import('../src/endpoints/characters-search-index.js');
    metadataDb = await import('../src/character-metadata-db.js');
    cardParser = await import('../src/character-card-parser.js');
    searchEngine = await import('../src/endpoints/search-engine.js');
    searchCoordinator = await import('../src/endpoints/search-index-coordinator.js');
});

beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-index-empty-name-test-'));
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
});

afterEach(async () => {
    jest.restoreAllMocks();
    await searchCoordinator.disposeSearchWorkers();
    metadataDb.disposeMetadataStores();
    fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('processCharacter failures', () => {
    test('throws for a character with no metadata row, and logs nothing itself', async () => {
        await metadataDb.bootstrapIfNeeded(directories);
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

        await expect(characters.processCharacter('Missing.png', directories, { shallow: false })).rejects.toThrow();
        expect(errorSpy).not.toHaveBeenCalled();
    });

    test('throws a SyntaxError for card_json that is not valid JSON, and logs nothing itself', async () => {
        await writeCard('Broken.png', 'Broken');
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

        await expect(characters.processCharacter('Broken.png', directories, {
            shallow: false,
            cardJson: 'not json',
            chatStats: { chatSize: 0, dateLastChat: 0 },
        })).rejects.toThrow(SyntaxError);
        expect(errorSpy).not.toHaveBeenCalled();
    });

    test('processCharacterOrPlaceholder logs and returns the upstream placeholder on failure', async () => {
        await metadataDb.bootstrapIfNeeded(directories);
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

        const result = await characters.processCharacterOrPlaceholder('Missing.png', directories, { shallow: false });
        expect(result).toEqual({ date_added: 0, date_last_chat: 0, chat_size: 0 });
        expect(errorSpy.mock.calls.some(args => String(args[0]).includes('Missing.png'))).toBe(true);
    });

    test('processCharacterOrPlaceholder returns the same character processCharacter does on success', async () => {
        await writeCard('Alpha.png', 'Alpha');
        await metadataDb.bootstrapIfNeeded(directories);

        const direct = await characters.processCharacter('Alpha.png', directories, { shallow: false });
        const wrapped = await characters.processCharacterOrPlaceholder('Alpha.png', directories, { shallow: false });
        // `chat` is a fresh timestamped name on every call.
        expect(wrapped).toEqual({ ...direct, chat: wrapped.chat });
        expect(wrapped.name).toBe('Alpha');
    });
});

describe('a card with an empty name is indexed', () => {
    test('a full rebuild indexes it under its id, and searchCharacters() keeps its hit', async () => {
        if (!await tantivyAvailable()) return;
        await writeCard('Alpha.png', 'Alpha');
        await writeCard('Nameless.png', '');
        await metadataDb.bootstrapIfNeeded(directories);
        expect(await metadataDb.characterRowExists(directories, 'Nameless.png')).toBe(true);

        const handle = 'empty-name-rebuild';
        expect(await searchIndex.rebuildCharacterSearchIndex(handle, directories)).toEqual({ ok: true, backend: 'tantivy' });

        const ids = (await searchIndex.searchCharacterIds(handle, directories, SHARED_WORD)).ids;
        expect([...ids].sort()).toEqual(['Alpha.png', 'Nameless.png']);

        const { results } = await searchIndex.searchCharacters(handle, directories, SHARED_WORD, 10, false);
        const byId = new Map(results.map(r => [r.item.avatar, r.item]));
        expect([...byId.keys()].sort()).toEqual(['Alpha.png', 'Nameless.png']);
        expect(byId.get('Nameless.png').name).toBe('');
    }, 20000);

    test('the incremental catch-up indexes an empty-name card written after the build', async () => {
        if (!await tantivyAvailable()) return;
        await writeCard('Alpha.png', 'Alpha');
        await metadataDb.bootstrapIfNeeded(directories);

        const handle = 'empty-name-incremental';
        expect(await searchIndex.rebuildCharacterSearchIndex(handle, directories)).toEqual({ ok: true, backend: 'tantivy' });

        await writeCard('Nameless.png', '');
        await metadataDb.upsertCharacterFromWrite(directories, 'Nameless.png', cardJson(''));

        let ids = [];
        const deadline = Date.now() + 5000;
        do {
            ids = (await searchIndex.searchCharacterIds(handle, directories, SHARED_WORD)).ids;
            if (ids.length > 1) break;
            await new Promise(resolve => setTimeout(resolve, 50));
        } while (Date.now() < deadline);
        expect([...ids].sort()).toEqual(['Alpha.png', 'Nameless.png']);
    }, 20000);

    test('the index sorts it by name the same way the SQL path does', async () => {
        if (!await tantivyAvailable()) return;
        await writeCard('Bravo.png', 'Bravo');
        await writeCard('Nameless.png', '');
        await writeCard('Alpha.png', 'Alpha');
        await metadataDb.bootstrapIfNeeded(directories);
        // The index sorts by name only from the stored name order (3a662e99d); /query walks SQL order until then.
        expect(await searchIndex.indexCanSort(directories, null, 'name')).toBe(false);
        await metadataDb.fillNameOrderIfNeeded(directories);

        const handle = 'empty-name-sort';
        expect(await searchIndex.rebuildCharacterSearchIndex(handle, directories)).toEqual({ ok: true, backend: 'tantivy' });

        for (const sortOrder of /** @type {const} */ (['asc', 'desc'])) {
            const sql = await metadataDb.queryCharacters(directories, { sortField: 'name', sortOrder, offset: 0, limit: 10 });
            const sqlIds = sql.rows.map(row => row.avatar);
            const indexed = await searchIndex.searchCharacterIdsSorted(handle, directories, SHARED_WORD, 'name', sortOrder, 0, 10);
            const indexIds = indexed.hits.map(hit => hit.id);
            expect(sqlIds).toHaveLength(3);
            expect(indexIds).toEqual(sqlIds);
        }
    }, 20000);
});
