import { describe, test, expect, jest, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import * as realSqliteEngine from '../src/endpoints/sqlite-engine.js';

// Wraps whichever engine this install resolves to (native or wasm), recording every call's method, SQL and arguments.
/** @type {{ method: string, sql: string, args: any[] }[]} */
const calls = [];
/** When set, an `iterate` whose SQL it matches throws instead of reading. @type {((sql: string) => boolean) | null} */
let failIterate = null;
let engineUnavailable = false;

async function getRecordingSqliteEngine() {
    if (engineUnavailable) {
        return null;
    }
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
                    if (method === 'iterate' && failIterate?.(sql)) {
                        throw new Error('injected read failure');
                    }
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

/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {import('node:http').Server} */
let server;
let baseUrl;
/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    metadataDb = await import('../src/character-metadata-db.js');
    const { router } = await import('../src/endpoints/tags.js');
    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = { directories };
        next();
    });
    app.use('/api/tags', router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
});

afterAll(() => new Promise(resolve => server.close(resolve)));

beforeEach(() => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-tags-definitions-stream-test-'));
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
    failIterate = null;
    engineUnavailable = false;
});

afterEach(() => {
    jest.restoreAllMocks();
    metadataDb.disposeMetadataStores();
    fs.rmSync(directories.root, { recursive: true, force: true });
});

/** Ids that don't sort in insertion order, so id order and rowid order differ. */
function makeTags(count) {
    return Array.from({ length: count }, (_, i) => ({ id: `t${String(count - i).padStart(5, '0')}`, name: `Tag ${i}` }));
}

const postGet = () => fetch(`${baseUrl}/api/tags/get`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });

const tagReads = () => calls.filter(c => /\bFROM tags\b/.test(c.sql) && /\bdata\b/.test(c.sql) && !/\bid IN\b|json_each/.test(c.sql));

describe('getTagDefinitions', () => {
    test('reads through iterate, never all, and returns every unmarked definition in insertion order', async () => {
        const tags = makeTags(5);
        await metadataDb.saveTagDefinitions(directories, tags);
        await metadataDb.deleteTagDefinition(directories, tags[2].id);
        calls.length = 0;

        const result = await metadataDb.getTagDefinitions(directories);

        expect(result).toEqual(tags.filter((_, i) => i !== 2));
        expect(calls.some(c => c.method === 'all')).toBe(false);
        expect(tagReads().map(c => c.method)).toEqual(['iterate']);
    });
});

describe('POST /api/tags/get', () => {
    test('streams every unmarked definition in keyset pages of 1000, in the same order getTagDefinitions returns', async () => {
        const tags = makeTags(2500);
        await metadataDb.saveTagDefinitions(directories, tags);
        await metadataDb.deleteTagDefinition(directories, tags[1234].id);
        const expected = await metadataDb.getTagDefinitions(directories);
        calls.length = 0;

        const response = await postGet();

        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toMatch(/^application\/json/);
        expect(await response.json()).toEqual({ tags: expected });
        expect(expected).toHaveLength(2499);
        expect(calls.some(c => c.method === 'all')).toBe(false);
        const reads = tagReads();
        expect(reads.map(c => c.method)).toEqual(['iterate', 'iterate', 'iterate']);
        expect(reads.map(c => c.args[0].limit)).toEqual([1000, 1000, 1000]);
        expect(reads[0].args[0].after).toBeUndefined();
        expect(reads.slice(1).every(c => typeof c.args[0].after === 'number')).toBe(true);
    });

    test('answers an empty list when there are no definitions', async () => {
        await metadataDb.saveTagDefinitions(directories, []);

        expect(await (await postGet()).json()).toEqual({ tags: [] });
    });

    test('answers { tags: null } when the store is unavailable', async () => {
        engineUnavailable = true;
        jest.spyOn(console, 'error').mockImplementation(() => {});

        const response = await postGet();

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ tags: null });
    });

    test('a failure reading the first page still answers 500', async () => {
        await metadataDb.saveTagDefinitions(directories, makeTags(3));
        failIterate = sql => /\bFROM tags\b/.test(sql) && /ORDER BY rowid/.test(sql);
        jest.spyOn(console, 'error').mockImplementation(() => {});

        const response = await postGet();

        expect(response.status).toBe(500);
    });

    test('a failure after the first write logs and ends the connection, leaving the body incomplete', async () => {
        await metadataDb.saveTagDefinitions(directories, makeTags(1500));
        failIterate = sql => /\bFROM tags\b/.test(sql) && /rowid > @after/.test(sql);
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

        const response = await postGet();
        expect(response.status).toBe(200);
        const text = await response.text().catch(() => '');

        expect(() => JSON.parse(text)).toThrow();
        expect(errorSpy.mock.calls.some(args => String(args[0]).includes('[tags/get]'))).toBe(true);
    });
});
