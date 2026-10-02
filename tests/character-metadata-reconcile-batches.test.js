import { describe, test, expect, jest, beforeAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import * as realSqliteEngine from '../src/endpoints/sqlite-engine.js';

// Wraps whichever engine this install resolves to (native or wasm), recording every call's method, SQL and arguments.
/** @type {{ method: string, sql: string, args: any[] }[]} */
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
            for (const method of ['all', 'get', 'iterate', 'run', 'readBounded']) {
                const real = handle[method];
                handle[method] = (sql, ...args) => {
                    calls.push({ method, sql, args });
                    return real(sql, ...args);
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

const EXISTS_SQL_PREFIX = 'SELECT id FROM characters WHERE id IN (';

/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {typeof import('../src/character-card-parser.js')} */
let cardParser;
/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    metadataDb = await import('../src/character-metadata-db.js');
    cardParser = await import('../src/character-card-parser.js');
});

beforeEach(() => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-cmdb-reconcile-batches-test-'));
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
    jest.restoreAllMocks();
    metadataDb.disposeMetadataStores();
    fs.rmSync(directories.root, { recursive: true, force: true });
});

/** @param {string} avatar */
async function writeCardFile(avatar) {
    const name = avatar.replace(/\.png$/, '');
    const baseImage = await fs.promises.readFile(path.join(process.cwd(), '..', 'public', 'img', 'ai4.png'));
    const card = {
        name,
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name, description: '', personality: '', scenario: '', first_mes: '', mes_example: '', tags: [],
            creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' },
        },
    };
    await fs.promises.writeFile(path.join(directories.characters, avatar), cardParser.write(baseImage, JSON.stringify(card)));
}

/**
 * A row in the store plus a file on disk that isn't a card, so reconcile() would log a failure if it ever read it.
 * @param {string} avatar
 */
async function seedKnownCharacter(avatar) {
    const name = avatar.replace(/\.png$/, '');
    const cardJson = JSON.stringify({
        name,
        data: { name, tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } },
    });
    await metadataDb.upsertCharacterFromWrite(directories, avatar, cardJson);
    fs.writeFileSync(path.join(directories.characters, avatar), 'not a png');
}

describe('reconcile reads the characters folder in batches', () => {
    test('checks each batch of at most 500 names with one IN read, never all(), and parses only the new files', async () => {
        const knownNames = Array.from({ length: 600 }, (_, i) => `Known${String(i).padStart(3, '0')}.png`);
        for (const name of knownNames) {
            await seedKnownCharacter(name);
        }
        const before = new Map();
        for (const name of knownNames) {
            before.set(name, await metadataDb.getCharacterMetadataRow(directories, name));
        }
        const newNames = ['NewA.png', 'NewB.png', 'NewC.png'];
        for (const name of newNames) {
            await writeCardFile(name);
        }
        fs.writeFileSync(path.join(directories.characters, 'notes.txt'), 'not a card');

        const errorSpy = jest.spyOn(console, 'error');
        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
        calls.length = 0;
        await metadataDb.reconcile(directories);

        expect(calls.filter(c => c.method === 'all')).toEqual([]);

        const existsReads = calls.filter(c => c.sql.startsWith(EXISTS_SQL_PREFIX));
        expect(existsReads.map(c => c.method)).toEqual(['iterate', 'iterate']);
        const batchSizes = existsReads.map(c => c.args[0].length);
        expect(batchSizes.every(n => n <= 500)).toBe(true);
        expect(batchSizes.reduce((a, b) => a + b, 0)).toBe(603);
        const checkedIds = existsReads.flatMap(c => c.args[0]);
        expect(new Set(checkedIds)).toEqual(new Set([...knownNames, ...newNames]));
        for (const read of existsReads) {
            expect(read.sql).toBe(`${EXISTS_SQL_PREFIX}${read.args[0].map(() => '?').join(', ')})`);
        }

        // The known rows' files aren't cards, so reading any of them would have logged a failure.
        expect(errorSpy.mock.calls.filter(args => String(args[0]).includes('Reconcile failed'))).toEqual([]);
        for (const name of knownNames) {
            expect(await metadataDb.getCharacterMetadataRow(directories, name)).toEqual(before.get(name));
        }
        for (const name of newNames) {
            const row = await metadataDb.getCharacterMetadataRow(directories, name);
            expect(row).toBeDefined();
            expect(row.name).toBe(name.replace(/\.png$/, ''));
        }
        expect(await metadataDb.getCharacterMetadataRow(directories, 'notes.txt')).toBeUndefined();

        const summary = logSpy.mock.calls.map(args => String(args[0])).filter(line => line.includes('adding new card files'));
        expect(summary).toHaveLength(1);
        expect(summary[0]).toMatch(/adding new card files found in the characters folder: done, 3 in \d+ s/);
    });

    test('an empty folder makes no IN read and logs nothing', async () => {
        await seedKnownCharacter('Known.png');
        fs.unlinkSync(path.join(directories.characters, 'Known.png'));
        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
        calls.length = 0;

        await metadataDb.reconcile(directories);

        expect(calls.filter(c => c.sql.startsWith(EXISTS_SQL_PREFIX))).toEqual([]);
        expect(calls.filter(c => c.method === 'all')).toEqual([]);
        expect(logSpy.mock.calls.filter(args => String(args[0]).includes('adding new card files'))).toEqual([]);
    });

    test('the progress line gives the count so far, with no total or ETA, and no batch numbers', async () => {
        await seedKnownCharacter('Known.png');
        await writeCardFile('NewA.png');
        await writeCardFile('NewB.png');

        // Every clock read moves 11s on, past the 10s progress interval.
        let now = Date.now();
        jest.spyOn(Date, 'now').mockImplementation(() => (now += 11000));
        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

        await metadataDb.reconcile(directories);

        // eslint-disable-next-line no-control-regex
        const lines = logSpy.mock.calls.map(args => String(args[0]).replace(/\u001b\[[0-9;]*m/g, ''));
        const progress = lines.filter(line => line.includes('so far'));
        expect(progress).toHaveLength(1);
        expect(progress[0]).toBe('[character-metadata] adding new card files found in the characters folder: 2 so far');
        expect(lines.filter(line => line.includes(': done, 2 in'))).toHaveLength(1);
        for (const line of lines) expect(line).not.toMatch(/batch/i);
    });
});
