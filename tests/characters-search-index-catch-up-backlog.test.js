import { describe, test, expect, jest, beforeAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// tick() calls getTagDefinitions() between its start read of the change log and its first upsert page read,
// so an armed write lands there.
/** @type {(() => Promise<unknown>) | null} */
let injectWrite = null;

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

    const actualMetadataDb = await import('../src/character-metadata-db.js');
    jest.unstable_mockModule('../src/character-metadata-db.js', () => ({
        ...actualMetadataDb,
        getTagDefinitions: jest.fn(async (...args) => {
            const write = injectWrite;
            injectWrite = null;
            await write?.();
            return actualMetadataDb.getTagDefinitions(...args);
        }),
    }));

    searchIndex = await import('../src/endpoints/characters-search-index.js');
    metadataDb = await import('../src/character-metadata-db.js');
    cardParser = await import('../src/character-card-parser.js');
    tantivyEngine = await import('../src/endpoints/tantivy-engine.js');
    searchCoordinator = await import('../src/endpoints/search-index-coordinator.js');
});

beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-search-catch-up-backlog-test-'));
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
    injectWrite = null;
});

afterEach(async () => {
    injectWrite = null;
    maintainer?.close();
    await searchCoordinator.disposeSearchWorkers();
    metadataDb.disposeMetadataStores();
    fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('characters-search-index.js: catch-up backlog', () => {
    test('a change written during the tick, after its start read, leaves the backlog non-negative', async () => {
        const tantivy = await tantivyEngine.getTantivyModule();
        if (!tantivy) {
            return;
        }

        await writeCard('FavChar');
        await metadataDb.bootstrapIfNeeded(directories);

        maintainer = searchIndex.createCharacterIndexMaintainer(directories, tantivy);
        expect(await maintainer.rebuild()).not.toBeNull();
        const seqAtTickStart = await metadataDb.getCurrentSeq(directories);

        injectWrite = () => metadataDb.setCharacterFav(directories, 'FavChar.png', true);
        const result = await maintainer.tick();
        expect(injectWrite).toBeNull();
        expect(result).not.toBeNull();
        expect(result).not.toHaveProperty('swapped');
        const r = /** @type {import('../src/endpoints/characters-search-index.js').TickResult} */ (result);

        // The tick applied a change its start read didn't see.
        expect(r.seq).toBeGreaterThan(/** @type {number} */ (seqAtTickStart));
        expect(r.backlog).toBeGreaterThanOrEqual(0);
        expect(searchIndex.formatCatchUpLine(r)).toContain(` backlog=${r.backlog} `);
    }, 20000);
});
