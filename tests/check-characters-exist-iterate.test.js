import { describe, test, expect, jest, beforeAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import * as realSqliteEngine from '../src/endpoints/sqlite-engine.js';

// Wraps whichever engine this install resolves to (native or wasm), recording every call's method and SQL.
/** @type {{ method: string, sql: string, params: any }[]} */
const calls = [];

async function getRecordingSqliteEngine() {
    const engine = await realSqliteEngine.getSqliteEngine();
    if (!engine) {
        return engine;
    }
    return {
        ...engine,
        openDatabase: (dbPath, options) => {
            const handle = engine.openDatabase(dbPath, options);
            for (const method of ['all', 'get', 'iterate', 'run']) {
                const real = handle[method];
                handle[method] = (sql, params) => {
                    calls.push({ method, sql, params });
                    return real(sql, params);
                };
            }
            return handle;
        },
    };
}

jest.unstable_mockModule('../src/endpoints/sqlite-engine.js', () => ({
    ...realSqliteEngine,
    getSqliteEngine: getRecordingSqliteEngine,
}));

/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;

/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    metadataDb = await import('../src/character-metadata-db.js');
});

beforeEach(() => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-check-characters-exist-iterate-test-'));
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
    calls.length = 0;
});

afterEach(() => {
    metadataDb.disposeMetadataStores();
    fs.rmSync(directories.root, { recursive: true, force: true });
});

/** @param {string} avatar */
async function seedCharacter(avatar) {
    const name = avatar.replace(/\.png$/, '');
    const cardJson = JSON.stringify({
        name,
        data: { name, tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } },
    });
    await metadataDb.upsertCharacterFromWrite(directories, avatar, cardJson);
}

/** @param {{ sql: string }} call */
const oneLine = (call) => call.sql.replace(/\s+/g, ' ').trim();

const EXISTENCE_READ = /^SELECT id FROM characters WHERE id IN \([?, ]+\)$/;

describe('checkCharactersExist()', () => {
    test('reads each chunk with iterate(), never all(), and still maps every requested id to true or false', async () => {
        await seedCharacter('Ann.png');
        await seedCharacter('Bea.png');

        // More ids than one 500-id chunk, so the read runs twice; the present ids sit in different chunks.
        const missing = Array.from({ length: 600 }, (_, i) => `missing-${i}.png`);
        const ids = ['Ann.png', ...missing.slice(0, 550), 'Bea.png', '', ...missing.slice(550), 'Ann.png'];

        calls.length = 0;
        const result = await metadataDb.checkCharactersExist(directories, ids);
        const reads = calls.filter(c => EXISTENCE_READ.test(oneLine(c)));

        expect(reads.map(c => c.method)).toEqual(['iterate', 'iterate']);
        expect(calls.filter(c => c.method === 'all')).toEqual([]);

        /** @type {Record<string, boolean>} */
        const expected = { 'Ann.png': true, 'Bea.png': true, '': false };
        for (const id of missing) expected[id] = false;
        expect(result).toEqual(expected);
    });

    test('an empty id list reads nothing and returns an empty map', async () => {
        await seedCharacter('Ann.png');
        calls.length = 0;
        expect(await metadataDb.checkCharactersExist(directories, [])).toEqual({});
        expect(calls.filter(c => EXISTENCE_READ.test(oneLine(c)))).toEqual([]);
    });
});
