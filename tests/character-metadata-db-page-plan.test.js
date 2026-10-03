import { describe, test, expect, jest, beforeAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import * as realSqliteEngine from '../src/endpoints/sqlite-engine.js';

// Wraps whichever engine this install resolves to (native or wasm) instead of pinning one, since the two can plan
// the same SQL differently. Records iterate() rather than taking the SQL from the source, so a test plans the later
// page the helper's own loop ran.
/** @type {{ sql: string, params: any, handle: import('../src/endpoints/sqlite-engine.js').SqliteEngineHandle }[]} */
const recordedIterates = [];

async function getRecordingSqliteEngine() {
    const engine = await realSqliteEngine.getSqliteEngine();
    if (!engine) {
        return engine;
    }
    return {
        ...engine,
        openDatabase: (dbPath, options) => {
            const handle = engine.openDatabase(dbPath, options);
            const realIterate = handle.iterate;
            handle.iterate = (sql, params) => {
                recordedIterates.push({ sql, params, handle });
                return realIterate(sql, params);
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
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-character-metadata-db-page-plan-test-'));
    for (const dir of ['characters', 'chats', 'groups']) {
        fs.mkdirSync(path.join(tempDir, dir), { recursive: true });
    }
    directories = { root: tempDir, characters: path.join(tempDir, 'characters'), chats: path.join(tempDir, 'chats'), groups: path.join(tempDir, 'groups') };
    recordedIterates.length = 0;
});

afterEach(() => {
    metadataDb.disposeMetadataStores();
});

/** More than one page of the metadata store's keyset streams, whose pages hold 1000 rows, so a first page comes back full. */
const MORE_THAN_ONE_PAGE = 1001;

const pad = (i) => String(i).padStart(4, '0');

/** A character that lives only in the metadata store (no PNG), linking `world`. */
async function addCharacter(avatar, world) {
    const name = avatar.replace(/\.png$/, '');
    const card = {
        name, description: '', personality: '', scenario: '', first_mes: '', mes_example: '',
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name, description: '', personality: '', scenario: '', first_mes: '', mes_example: '',
            creator_notes: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [],
            tags: [], creator: '', character_version: '',
            extensions: { fav: false, world, talkativeness: '0.5', depth_prompt: { prompt: '', depth: 4, role: 'system' } },
        },
    };
    await metadataDb.upsertCharacterFromWrite(directories, avatar, JSON.stringify(card), null, null);
}

/** @param {(i: number) => string} worldOf */
async function addCharacters(worldOf) {
    const avatars = [];
    for (let i = 0; i < MORE_THAN_ONE_PAGE; i++) {
        avatars.push(`Char${pad(i)}.png`);
        await addCharacter(avatars[i], worldOf(i));
    }
    return avatars;
}

/** @param {AsyncIterable<unknown>} stream */
async function collect(stream) {
    const batches = [];
    for await (const batch of stream) batches.push(batch);
    return batches;
}

/** The later page the caller just ran: its SQL is the caller's nextPageSql, whose key condition is `> @after`. */
function recordedLaterPage() {
    const laterPage = recordedIterates.find(call => call.sql.includes('> @after'));
    expect(laterPage).toBeDefined();
    return laterPage;
}

function planOf({ sql, params, handle }) {
    return Array.from(handle.iterate(`EXPLAIN QUERY PLAN ${sql}`, params), row => row.detail);
}

describe('a keyset stream\'s later page seeks on its key instead of re-reading from the start', () => {
    test('streamCharacterIdsForTagIds() SEARCHes character_tags on character_id>?', async () => {
        const avatars = await addCharacters(() => '');
        for (const avatar of avatars) {
            expect(await metadataDb.assignEntityTag(directories, avatar, 't1')).toBe('ok');
        }
        recordedIterates.length = 0;

        await collect(metadataDb.streamCharacterIdsForTagIds(directories, ['t1']));

        const plan = planOf(recordedLaterPage());
        expect(plan).toContainEqual(expect.stringMatching(/\bSEARCH character_tags\b.*character_id>\?/));
        expect(plan).not.toContainEqual(expect.stringMatching(/\bSCAN character_tags\b/));
    }, 60000);

    test('streamCharacterCardJsonBatches() SEARCHes characters on (id>?)', async () => {
        await addCharacters(() => '');
        recordedIterates.length = 0;

        await collect(metadataDb.streamCharacterCardJsonBatches(directories));

        const plan = planOf(recordedLaterPage());
        expect(plan).toContainEqual(expect.stringMatching(/\bSEARCH characters\b.*\(id>\?\)/));
        expect(plan).not.toContainEqual(expect.stringMatching(/\bSCAN characters\b/));
    }, 60000);

    test('streamDeletedIdsBetween() bounds a later page\'s seq below by @after, without a SCAN of changes', async () => {
        const avatars = await addCharacters(() => '');
        for (const avatar of avatars) {
            await metadataDb.deleteCharacterRow(directories, avatar);
        }
        const uptoSeq = await metadataDb.getCurrentSeq(directories);
        recordedIterates.length = 0;

        await collect(metadataDb.streamDeletedIdsBetween(directories, 0, uptoSeq));

        // The plan reads seq through the INTEGER PRIMARY KEY either way and can't show which bound it seeks to, so the
        // later page's SQL is checked for its lower bound.
        const laterPage = recordedLaterPage();
        expect(planOf(laterPage)).not.toContainEqual(expect.stringMatching(/\bSCAN changes\b/));
        expect(laterPage.sql).toContain('seq > @after');
        expect(laterPage.sql).not.toContain('seq > @lo');
    }, 60000);
});
