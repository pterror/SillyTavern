import { describe, test, expect, jest, beforeAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import NodeSqlite3Wasm from 'node-sqlite3-wasm';
import { isBusyError, openWasmDatabase, streamRows } from '../src/endpoints/sqlite-engine.js';

const { Database: WasmDatabase } = NodeSqlite3Wasm;

jest.unstable_mockModule('../src/endpoints/sqlite-engine.js', () => ({
    getSqliteEngine: jest.fn(async () => ({
        kind: 'wasm',
        openDatabase: (dbPath, options) => openWasmDatabase(WasmDatabase, dbPath, options),
    })),
    openWasmDatabase,
    openNativeDatabase: jest.fn(),
    streamRows,
    isBusyError,
}));

/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {typeof import('../src/character-card-parser.js')} */
let cardParser;

let tempDir;
/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    metadataDb = await import('../src/character-metadata-db.js');
    cardParser = await import('../src/character-card-parser.js');
});

beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-character-metadata-boot-wasm-'));
    directories = /** @type {any} */ ({
        root: tempDir,
        characters: path.join(tempDir, 'characters'),
        chats: path.join(tempDir, 'chats'),
        groups: path.join(tempDir, 'groups'),
        groupChats: path.join(tempDir, 'groupChats'),
    });
    for (const dir of [directories.characters, directories.chats, directories.groups, directories.groupChats]) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

afterEach(() => {
    metadataDb.disposeMetadataStores();
    fs.rmSync(tempDir, { recursive: true, force: true });
});

/**
 * @param {string} avatar
 * @param {string} name
 */
async function writeCardFile(avatar, name) {
    // jest runs with tests/ as cwd.
    const baseImage = await fs.promises.readFile(path.join(process.cwd(), '..', 'public', 'img', 'ai4.png'));
    const card = {
        name,
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name,
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
    };
    await fs.promises.writeFile(path.join(directories.characters, avatar), cardParser.write(baseImage, JSON.stringify(card)));
}

describe('initializeMetadataStores() on the wasm engine', () => {
    test('boots an empty data root', async () => {
        const chains = await metadataDb.initializeMetadataStores([directories]);

        expect(chains).toHaveLength(1);
        await Promise.all(chains);
    });

    test('boots a populated data root', async () => {
        await writeCardFile('Alice.png', 'Alice');
        await writeCardFile('Bob.png', 'Bob');

        const chains = await metadataDb.initializeMetadataStores([directories]);

        expect(chains).toHaveLength(1);
        await Promise.all(chains);
        expect(await metadataDb.characterRowExists(directories, 'Alice.png')).toBe(true);
        expect(await metadataDb.characterRowExists(directories, 'Bob.png')).toBe(true);
    });
});
