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
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-cmdb-limit-bounded-reads-test-'));
    directories = {
        root: tempDir,
        characters: path.join(tempDir, 'characters'),
        chats: path.join(tempDir, 'chats'),
        groups: path.join(tempDir, 'groups'),
        groupChats: path.join(tempDir, 'groupChats'),
    };
    for (const dir of [directories.characters, directories.chats, directories.groups, directories.groupChats]) {
        fs.mkdirSync(dir, { recursive: true });
    }
    calls.length = 0;
});

afterEach(() => {
    metadataDb.disposeMetadataStores();
    fs.rmSync(directories.root, { recursive: true, force: true });
});

/** @param {string} avatar @param {boolean} [fav] */
async function seedCharacter(avatar, fav = false) {
    const name = avatar.replace(/\.png$/, '');
    const cardJson = JSON.stringify({
        name,
        data: { name, tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav, world: '' } },
    });
    await metadataDb.upsertCharacterFromWrite(directories, avatar, cardJson);
}

/** @param {{ sql: string }} call */
const oneLine = (call) => call.sql.replace(/\s+/g, ' ').trim();

/** @param {RegExp} pattern */
const callsMatching = (pattern) => calls.filter(c => pattern.test(oneLine(c)));

describe('getLocalImportMtimeSourcePathsAfter() reads its page with readBounded(), bounded by its limit', () => {
    const PAGE_READ = /^SELECT source_path FROM local_import_mtimes WHERE source_path > @after ORDER BY source_path LIMIT @limit$/;

    test('pages through every path in order, each read bounded by the same limit the SQL binds', async () => {
        const sourcePaths = ['/src/a.png', '/src/b.png', '/src/c.png', '/src/d.png', '/src/e.png'];
        for (const sourcePath of sourcePaths) {
            await metadataDb.setLocalImportMtime(directories, sourcePath, 1000);
        }

        calls.length = 0;
        const pages = [];
        let cursor = '';
        for (;;) {
            const page = await metadataDb.getLocalImportMtimeSourcePathsAfter(directories, cursor, 2);
            if (page.length === 0) break;
            pages.push(page);
            cursor = page[page.length - 1];
        }

        expect(pages).toEqual([['/src/a.png', '/src/b.png'], ['/src/c.png', '/src/d.png'], ['/src/e.png']]);
        const reads = callsMatching(PAGE_READ);
        expect(reads.map(c => c.method)).toEqual(['readBounded', 'readBounded', 'readBounded', 'readBounded']);
        for (const read of reads) {
            const [params, max] = read.args;
            expect(max).toBe(2);
            expect(params.limit).toBe(max);
        }
    });

    test('a limit of 0 returns no paths', async () => {
        await metadataDb.setLocalImportMtime(directories, '/src/a.png', 1000);
        expect(await metadataDb.getLocalImportMtimeSourcePathsAfter(directories, '', 0)).toEqual([]);
    });
});

describe('queryCharacters() reads a non-search page with readBounded(), bounded by the page limit', () => {
    const PAGE_READ = /\bLIMIT \? OFFSET \?$/;

    test('rows and hash rows come back for the requested page, each read bounded by the same limit the SQL binds', async () => {
        const ids = ['Ann.png', 'Bea.png', 'Cal.png', 'Dan.png', 'Eve.png'];
        for (const id of ids) await seedCharacter(id, id === 'Cal.png');

        const params = { sortField: 'name', sortOrder: /** @type {'asc'} */ ('asc'), offset: 1, limit: 3, wantTotal: false };

        calls.length = 0;
        const rowsResult = await metadataDb.queryCharacters(directories, { ...params, wantRows: true, wantHashes: false });
        const hashResult = await metadataDb.queryCharacters(directories, { ...params, wantRows: false, wantHashes: true });

        expect(rowsResult?.rows?.map(r => r.avatar)).toEqual(['Bea.png', 'Cal.png', 'Dan.png']);
        expect(hashResult?.hashRows?.map(r => r.id)).toEqual(['Bea.png', 'Cal.png', 'Dan.png']);

        const reads = callsMatching(PAGE_READ);
        expect(reads.map(c => c.method)).toEqual(['readBounded', 'readBounded']);
        for (const read of reads) {
            const [params_, max] = read.args;
            expect(max).toBe(3);
            expect(params_.slice(-2)).toEqual([max, 1]);
        }
    });

    test('an omitted limit is bounded by the default page limit', async () => {
        await seedCharacter('Ann.png');

        calls.length = 0;
        const result = await metadataDb.queryCharacters(directories, { wantRows: true, wantTotal: false });

        expect(result?.rows?.map(r => r.avatar)).toEqual(['Ann.png']);
        const [read] = callsMatching(PAGE_READ);
        expect(read.method).toBe('readBounded');
        const [params_, max] = read.args;
        expect(max).toBe(500);
        expect(params_.slice(-2)).toEqual([max, 0]);
    });
});

