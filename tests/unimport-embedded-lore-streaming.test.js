import { describe, test, expect, jest, beforeAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import * as realSqliteEngine from '../src/endpoints/sqlite-engine.js';

// Wraps whichever engine this install resolves to (native or wasm) instead of pinning one, since the two can plan
// the same SQL differently. Records every call in order, so a test can see which reads and writes interleave.
/** @type {{ method: string, sql: string, params: any, handle: import('../src/endpoints/sqlite-engine.js').SqliteEngineHandle }[]} */
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
                    calls.push({ method, sql, params, handle });
                    return real(sql, params);
                };
            }
            const realTransaction = handle.transaction;
            handle.transaction = (fn) => {
                calls.push({ method: 'transaction', sql: '', params: undefined, handle });
                return realTransaction(fn);
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
/** @type {typeof import('../src/migrations/unimport-embedded-lore.js')} */
let migration;

let worldsDir;
/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    metadataDb = await import('../src/character-metadata-db.js');
    migration = await import('../src/migrations/unimport-embedded-lore.js');
});

beforeEach(() => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-unimport-embedded-lore-streaming-test-'));
    worldsDir = path.join(tempDir, 'worlds');
    for (const dir of ['characters', 'worlds', 'chats', 'groups']) {
        fs.mkdirSync(path.join(tempDir, dir), { recursive: true });
    }
    directories = { root: tempDir, characters: path.join(tempDir, 'characters'), worlds: worldsDir, chats: path.join(tempDir, 'chats'), groups: path.join(tempDir, 'groups') };
    calls.length = 0;
});

afterEach(() => {
    metadataDb.disposeMetadataStores();
});

/** More than one page of the metadata store's keyset streams, whose pages hold 1000 rows. */
const MORE_THAN_ONE_PAGE = 1001;

function makeBook(content = 'Some lore about the character.') {
    return {
        name: 'Lorebook',
        entries: [
            { id: 0, keys: ['test'], secondary_keys: [], comment: '', content, constant: false, selective: false, insertion_order: 100, enabled: true, position: 'after_char', extensions: {} },
        ],
    };
}

/** What convertCharacterBook()+saveWorldInfo() persist for an auto-imported character_book. */
function writeAutoImportedWorld(name, characterBook) {
    const entries = {};
    characterBook.entries.forEach((entry, i) => {
        entries[entry.id ?? i] = { uid: entry.id ?? i, key: entry.keys, content: entry.content, disable: !entry.enabled };
    });
    fs.writeFileSync(path.join(worldsDir, `${name}.json`), JSON.stringify({ entries, originalData: characterBook }));
}

/** A character that lives only in the metadata store (no PNG), linking `world` and embedding `characterBook`. */
async function addCharacter(avatar, world, characterBook) {
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
            character_book: characterBook,
        },
    };
    await metadataDb.upsertCharacterFromWrite(directories, avatar, JSON.stringify(card), null, null);
}

async function linkedWorldOf(avatar) {
    return JSON.parse(await metadataDb.getCharacterCardJson(directories, avatar)).data.extensions.world;
}

const pad = (i) => String(i).padStart(4, '0');

describe('unimport-embedded-lore - streamed linked-world reads', () => {
    test('reads linked Worlds only through idx_characters_world in LIMIT pages, never with .all() or a SCAN of characters', async () => {
        const book = makeBook();
        writeAutoImportedWorld('Sole', book);
        await addCharacter('Sole.png', 'Sole', book);
        writeAutoImportedWorld('Shared', book);
        await addCharacter('SharedA.png', 'Shared', book);
        await addCharacter('SharedB.png', 'Shared', book);
        fs.writeFileSync(path.join(worldsDir, 'Hand.json'), JSON.stringify({ entries: {} }));
        await addCharacter('Hand.png', 'Hand', book);
        calls.length = 0;

        const result = await migration.run(directories, { apply: true, log: () => {} });
        expect(result).toMatchObject({ safe: 1, migrated: 1, failed: 0, ambiguous: 2, orphanedWorlds: 1 });

        const worldReads = calls.filter(c => c.method !== 'run' && /^\s*SELECT\b/i.test(c.sql) && /\bworld\b/.test(c.sql));
        expect(worldReads.map(c => c.method)).toEqual(expect.arrayContaining(['iterate', 'get']));
        for (const { method, sql, params, handle } of worldReads) {
            expect(method).not.toBe('all');
            expect(sql).toMatch(/\bLIMIT\b/);
            const plan = Array.from(handle.iterate(`EXPLAIN QUERY PLAN ${sql}`, params), row => row.detail);
            expect(plan).not.toContainEqual(expect.stringMatching(/\bSCAN characters\b/));
            expect(plan).toContainEqual(expect.stringMatching(/\bidx_characters_world\b/));
        }

        // One World's linkers are read by seeking to that World in idx_characters_world. A later page's seek past the
        // last rowid read needs more than one page of linkers; character-metadata-db-page-plan.test.js checks it.
        const linkerPage = worldReads.find(c => /\browid\b/.test(c.sql));
        expect(linkerPage).toBeDefined();
        expect(Array.from(linkerPage.handle.iterate(`EXPLAIN QUERY PLAN ${linkerPage.sql}`, linkerPage.params), row => row.detail))
            .toContainEqual(expect.stringMatching(/\bSEARCH characters\b.*\bidx_characters_world \(world=\?\)/));
    });

    test('a world list longer than one page is handled in full, with the unlinks written between its pages', async () => {
        const book = makeBook();
        for (let i = 0; i < MORE_THAN_ONE_PAGE; i++) {
            writeAutoImportedWorld(`World${pad(i)}`, book);
            await addCharacter(`Char${pad(i)}.png`, `World${pad(i)}`, book);
        }
        calls.length = 0;

        /** @type {string[]} */
        const lines = [];
        const result = await migration.run(directories, { apply: true, log: line => lines.push(line) });
        expect(result).toMatchObject({ safe: MORE_THAN_ONE_PAGE, migrated: MORE_THAN_ONE_PAGE, failed: 0, ambiguous: 0, orphanedWorlds: MORE_THAN_ONE_PAGE });

        for (let i = 0; i < MORE_THAN_ONE_PAGE; i++) {
            expect(await linkedWorldOf(`Char${pad(i)}.png`)).toBeFalsy();
        }

        // Every World left without a linker is named exactly once, over several bounded lines.
        const orphanLines = lines.map(line => /(\d+) World file\(s\) came from an embedded-lore import .*?: (.*?)(\u001b\[\d+m)?$/.exec(line)).filter(Boolean);
        expect(orphanLines.length).toBeGreaterThan(1);
        const orphanNames = orphanLines.flatMap(([, count, names]) => {
            const listed = names.split(', ');
            expect(listed).toHaveLength(Number(count));
            return listed;
        });
        expect(orphanNames.sort()).toEqual(Array.from({ length: MORE_THAN_ONE_PAGE }, (_, i) => `World${pad(i)}`));

        // Streamed, not gathered first: the world list's second page is read after the first unlink was written.
        const worldListPages = calls.map((c, i) => ({ ...c, i })).filter(c => c.method === 'iterate' && /GROUP BY world/.test(c.sql));
        expect(worldListPages.length).toBeGreaterThan(1);
        const firstWriteAfterFirstPage = calls.findIndex((c, i) => i > worldListPages[0].i && (c.method === 'transaction' || c.method === 'run'));
        expect(firstWriteAfterFirstPage).toBeGreaterThan(-1);
        expect(firstWriteAfterFirstPage).toBeLessThan(worldListPages[1].i);
    });

    test('a shared World whose linkers run past one page has every linker reported and none touched', async () => {
        const book = makeBook();
        writeAutoImportedWorld('Crowd', book);
        const avatars = [];
        for (let i = 0; i < MORE_THAN_ONE_PAGE; i++) {
            avatars.push(`Char${pad(i)}.png`);
            await addCharacter(avatars[i], 'Crowd', book);
        }

        let yields = 0;
        for await (const findings of migration.findCandidates(directories, () => {})) {
            expect(findings.safe).toEqual([]);
            yields++;
        }
        expect(yields).toBeGreaterThan(1);

        /** @type {string[]} */
        const lines = [];
        const result = await migration.run(directories, { apply: true, log: line => lines.push(line) });
        expect(result).toMatchObject({ safe: 0, migrated: 0, failed: 0, ambiguous: MORE_THAN_ONE_PAGE });

        const reported = lines.map(line => /AMBIGUOUS, not touched: (\S+) \(linked to "Crowd"\)/.exec(line)?.[1]).filter(Boolean);
        expect(reported.sort()).toEqual(avatars);
        for (const avatar of avatars) {
            expect(await linkedWorldOf(avatar)).toBe('Crowd');
        }
    });
});
