import { describe, test, expect, jest, beforeAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import * as realSqliteEngine from '../src/endpoints/sqlite-engine.js';

// Wraps whichever engine this install resolves to (native or wasm) instead of pinning one, since the two can plan
// the same SQL differently.
/** @type {{ sql: string, handle: import('../src/endpoints/sqlite-engine.js').SqliteEngineHandle }[]} */
const recordedGets = [];

async function getRecordingSqliteEngine() {
    const engine = await realSqliteEngine.getSqliteEngine();
    if (!engine) {
        return engine;
    }
    return {
        ...engine,
        openDatabase: (dbPath, options) => {
            const handle = engine.openDatabase(dbPath, options);
            const realGet = handle.get;
            handle.get = (sql, params) => {
                recordedGets.push({ sql, handle });
                return realGet(sql, params);
            };
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
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-character-metadata-db-seq-bounds-plan-test-'));
    const charactersDir = path.join(tempDir, 'characters');
    const chatsDir = path.join(tempDir, 'chats');
    fs.mkdirSync(charactersDir, { recursive: true });
    fs.mkdirSync(chatsDir, { recursive: true });
    directories = { root: tempDir, characters: charactersDir, chats: chatsDir };
});

afterEach(() => {
    metadataDb.disposeMetadataStores();
});

function planOfTheOnlyRecordedGet() {
    expect(recordedGets.map(r => r.sql)).toHaveLength(1);
    const [{ sql, handle }] = recordedGets;
    return Array.from(handle.iterate(`EXPLAIN QUERY PLAN ${sql}`), row => row.detail);
}

describe('change-log seq bounds read without scanning the log', () => {
    test('getChangesSince() reads MIN/MAX(seq) of changes without a SCAN of changes', async () => {
        await metadataDb.ensureSchemaMigrated(directories);
        recordedGets.length = 0;

        await metadataDb.getChangesSince(directories, 0, { limit: 1 });

        const details = planOfTheOnlyRecordedGet();
        expect(details).not.toContainEqual(expect.stringMatching(/\bSCAN changes\b/));
        expect(details).toContainEqual(expect.stringMatching(/\bSEARCH changes\b/));
    });

    test('getTagNameChangesSince() reads MIN/MAX(seq) of tag_name_changes without a SCAN of tag_name_changes', async () => {
        await metadataDb.ensureSchemaMigrated(directories);
        recordedGets.length = 0;

        await metadataDb.getTagNameChangesSince(directories, 0, { limit: 1 });

        const details = planOfTheOnlyRecordedGet();
        expect(details).not.toContainEqual(expect.stringMatching(/\bSCAN tag_name_changes\b/));
        expect(details).toContainEqual(expect.stringMatching(/\bSEARCH tag_name_changes\b/));
    });
});
