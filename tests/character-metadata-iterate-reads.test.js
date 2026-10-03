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
/** @type {typeof import('better-sqlite3')} */
let Database;
/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    metadataDb = await import('../src/character-metadata-db.js');
    Database = (await import('better-sqlite3')).default;
});

beforeEach(() => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-cmdb-iterate-reads-test-'));
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

/** @param {string} avatar @param {boolean} [fav] */
async function seedCharacter(avatar, fav = false) {
    const name = avatar.replace(/\.png$/, '');
    const cardJson = JSON.stringify({
        name,
        data: { name, tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav, world: '' } },
    });
    await metadataDb.upsertCharacterFromWrite(directories, avatar, cardJson);
}

/** @param {string} id @param {boolean} [fav] */
async function seedGroup(id, fav = false) {
    const group = { id, name: id, members: [], chats: [], fav };
    fs.writeFileSync(path.join(directories.groups, `${id}.json`), JSON.stringify(group));
    await metadataDb.upsertGroupRow(directories, id, id, { fav, group });
}

/** @param {string[]} ids */
async function saveTags(ids) {
    expect(await metadataDb.saveTagDefinitions(directories, ids.map(id => ({ id, name: `name-${id}` })))).toBe('ok');
}

/** @param {string} id @param {string} tagId */
async function assign(id, tagId) {
    expect(await metadataDb.assignEntityTag(directories, id, tagId)).toBe('ok');
}

/** @template T @param {(db: import('better-sqlite3').Database) => T} fn @returns {T} */
function withRawDb(fn) {
    const db = new Database(path.join(directories.root, 'character-metadata.sqlite'));
    try {
        return fn(db);
    } finally {
        db.close();
    }
}

/** @param {{ sql: string }} call */
const oneLine = (call) => call.sql.replace(/\s+/g, ' ').trim();

/**
 * Asserts the recorder saw `sql` (exact text, whitespace collapsed; or a pattern) at least once, every time through
 * iterate(), and never through all().
 * @param {string | RegExp} sql
 */
function expectReadThroughIterate(sql) {
    const matches = calls.filter(c => typeof sql === 'string' ? oneLine(c) === sql : sql.test(oneLine(c)));
    expect({ sql: String(sql), methods: [...new Set(matches.map(c => c.method))] }).toEqual({ sql: String(sql), methods: ['iterate'] });
}

describe('one entity\'s tags are read through iterate()', () => {
    const CHARACTER_TAGS = 'SELECT tag_id FROM character_tags WHERE character_id = @id';
    const GROUP_TAGS = 'SELECT tag_id FROM group_tags WHERE group_id = @id ORDER BY tag_id';

    /** The tag ids the character's list row shows. @param {string} id */
    const storedTagIds = async (id) => /** @type {any} */ ((await metadataDb.getShallowByIds(directories, [id]))[id]).tag_ids;

    test('rewriting an existing character keeps its tags from character_tags', async () => {
        await saveTags(['x', 'y']);
        await seedCharacter('Ann.png');
        await assign('Ann.png', 'y');
        await assign('Ann.png', 'x');

        await seedCharacter('Ann.png', true);

        expect(await storedTagIds('Ann.png')).toEqual(['x', 'y']);
    });

    test('renaming a character carries its tags to the new avatar', async () => {
        await saveTags(['x', 'y']);
        await seedCharacter('Old.png');
        await seedCharacter('New.png');
        await assign('Old.png', 'x');
        await assign('Old.png', 'y');

        calls.length = 0;
        expect(await metadataDb.renameCharacterRow(directories, 'Old.png', 'New.png')).toEqual({ copiedOrphanTagIds: [] });

        expectReadThroughIterate(CHARACTER_TAGS);
        expect(await metadataDb.getCharacterTagIds(directories, 'New.png')).toEqual(['x', 'y']);
        expect(await storedTagIds('New.png')).toEqual(['x', 'y']);
    });

    test('getCharacterTagIds() and getGroupTagIds() return the entity\'s tags', async () => {
        await saveTags(['x', 'y']);
        await seedCharacter('Ann.png');
        await seedGroup('g1');
        await assign('Ann.png', 'y');
        await assign('g1', 'x');
        await assign('g1', 'y');

        calls.length = 0;
        expect(await metadataDb.getCharacterTagIds(directories, 'Ann.png')).toEqual(['y']);
        expect(await metadataDb.getGroupTagIds(directories, 'g1')).toEqual(['x', 'y']);

        expectReadThroughIterate(CHARACTER_TAGS);
        expectReadThroughIterate(GROUP_TAGS);
    });

    test('assigning and unassigning a tag leave the stored tag list and the group digest matching the tag rows', async () => {
        await saveTags(['x', 'y']);
        await seedCharacter('Ann.png');
        await seedGroup('g1');
        await seedGroup('g2');
        await assign('g2', 'x');
        const digestOf = (/** @type {string} */ id) => withRawDb(db => db.prepare('SELECT digest_tag_ids FROM groups WHERE id = ?').pluck().get(id));
        const g2DigestWithX = digestOf('g2');

        calls.length = 0;
        await assign('Ann.png', 'x');
        await assign('Ann.png', 'y');
        await assign('g1', 'x');
        expectReadThroughIterate(GROUP_TAGS);
        expect((await storedTagIds('Ann.png')).slice().sort()).toEqual(['x', 'y']);
        expect(digestOf('g1')).toBe(g2DigestWithX);

        await assign('g1', 'y');
        calls.length = 0;
        expect(await metadataDb.unassignEntityTag(directories, 'Ann.png', 'x')).toBe('ok');
        expect(await metadataDb.unassignEntityTag(directories, 'g1', 'y')).toBe('ok');
        expectReadThroughIterate(GROUP_TAGS);
        expect(await storedTagIds('Ann.png')).toEqual(['y']);
        expect(digestOf('g1')).toBe(g2DigestWithX);
    });
});

describe('lookups over a caller\'s id batch read through iterate()', () => {
    test('the by-ids lookups return the seeded values for tracked ids and leave out the rest', async () => {
        await saveTags(['x', 'y']);
        await seedCharacter('Ann.png', true);
        await seedCharacter('Bea.png');
        await seedCharacter('Cal.png');
        await seedGroup('g1', true);
        await seedGroup('g2');
        await assign('Ann.png', 'y');
        await assign('Ann.png', 'x');
        expect(await metadataDb.setCharacterAllowGlobalStyles(directories, 'Bea.png', true)).toBe(true);
        expect(await metadataDb.setCharacterAllowGlobalStyles(directories, 'Cal.png', false)).toBe(true);
        expect(await metadataDb.setCharacterActiveChat(directories, 'Bea.png', 'chat-b')).toBe(true);
        const ids = ['Ann.png', 'Bea.png', 'Cal.png', 'None.png'];

        calls.length = 0;
        expect(await metadataDb.getCharacterFavsByIds(directories, ids)).toEqual({ 'Ann.png': true, 'Bea.png': false, 'Cal.png': false });
        expect(await metadataDb.getGroupFavsByIds(directories, ['g1', 'g2', 'g3'])).toEqual({ g1: true, g2: false });
        expect(await metadataDb.getCharacterAllowGlobalStylesByIds(directories, ids)).toEqual({ 'Bea.png': true, 'Cal.png': false });
        expect(await metadataDb.getCharacterTagIdsByIds(directories, ids)).toEqual({ 'Ann.png': ['x', 'y'], 'Bea.png': [], 'Cal.png': [] });
        expect(await metadataDb.getCharacterActiveChatsByIds(directories, ids)).toEqual({ 'Bea.png': 'chat-b' });
        const shallow = await metadataDb.getShallowByIds(directories, ids);
        expect(Object.keys(shallow).sort()).toEqual(['Ann.png', 'Bea.png', 'Cal.png']);
        expect(Object.fromEntries(Object.entries(shallow).map(([id, s]) => [id, /** @type {any} */ (s).avatar]))).toEqual({ 'Ann.png': 'Ann.png', 'Bea.png': 'Bea.png', 'Cal.png': 'Cal.png' });

        expectReadThroughIterate('SELECT id, fav FROM characters WHERE id IN (?,?,?,?)');
        expectReadThroughIterate('SELECT id, fav FROM groups WHERE id IN (?,?,?)');
        expectReadThroughIterate('SELECT id, allow_global_styles FROM characters WHERE id IN (?,?,?,?)');
        expectReadThroughIterate('SELECT id FROM characters WHERE id IN (?,?,?,?)');
        expectReadThroughIterate('SELECT character_id, tag_id FROM character_tags WHERE character_id IN (?,?,?,?)');
        expectReadThroughIterate('SELECT id, active_chat FROM characters WHERE id IN (?,?,?,?) AND active_chat IS NOT NULL');
        expectReadThroughIterate(/^SELECT id, name, creator, character_version, world, create_date_raw, fav, date_added, .* FROM characters WHERE id IN \(SELECT value FROM json_each\(\?\)\)$/);
    });

    test('getLocalImportMtimesForPaths() returns the recorded mtime of each known path', async () => {
        await metadataDb.setLocalImportMtime(directories, '/src/a.png', 1000);
        await metadataDb.setLocalImportMtime(directories, '/src/b.png', 2000);

        calls.length = 0;
        const result = await metadataDb.getLocalImportMtimesForPaths(directories, ['/src/a.png', '/src/b.png', '/src/c.png']);

        expect(result).toEqual(new Map([['/src/a.png', 1000], ['/src/b.png', 2000]]));
        expectReadThroughIterate('SELECT source_path, mtime_ms FROM local_import_mtimes WHERE source_path IN (?,?,?)');
    });

    test('queryCharacters() in search order reads the page\'s rows and hash rows through iterate(), in the given order', async () => {
        for (const id of ['Ann.png', 'Bea.png', 'Cal.png', 'Dan.png']) await seedCharacter(id);
        const params = { sortField: 'search', idOrder: ['Dan.png', 'Missing.png', 'Ann.png', 'Cal.png', 'Bea.png'], offset: 0, limit: 4, wantTotal: false };

        calls.length = 0;
        const rowsResult = await metadataDb.queryCharacters(directories, { ...params, wantRows: true, wantHashes: false });
        const hashResult = await metadataDb.queryCharacters(directories, { ...params, wantRows: false, wantHashes: true });

        expect(rowsResult?.rows?.map(r => r.avatar)).toEqual(['Dan.png', 'Ann.png', 'Cal.png']);
        expect(hashResult?.hashRows?.map(r => r.id)).toEqual(['Dan.png', 'Ann.png', 'Cal.png']);
        const pageReads = calls.filter(c => /\bFROM characters WHERE id IN \(SELECT value FROM json_each\(\?\)\)$/.test(oneLine(c)));
        expect([...new Set(pageReads.map(c => c.method))]).toEqual(['iterate']);
        // The rows' page read, their list rows' read and the hash rows' read, each by the page's ids.
        expect(pageReads.map(c => oneLine(c))).toEqual([
            expect.stringMatching(/^SELECT id FROM characters WHERE /),
            expect.stringMatching(/^SELECT id, name, creator, /),
            expect.stringMatching(/^SELECT id, active_chat, .*\bversion FROM characters WHERE /),
        ]);
    });
});
