import { describe, test, expect, beforeAll, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { tagCounts } from './tag-store-reads.js';

/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {typeof import('../public/scripts/hash-utils.js')} */
let hashUtils;
/** @type {typeof import('better-sqlite3')} */
let Database;
/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

/** While armed, the transaction call with this 1-based number throws instead of running. */
let crashAtTransaction = 0;
let transactionCalls = 0;
let runCalls = 0;
/** @type {((handle: any) => void) | null} Called after each transaction commits. */
let afterCommit = null;

/** @param {any} handle */
function instrumentedHandle(handle) {
    const wrapped = { ...handle };
    wrapped.transaction = (fn) => {
        transactionCalls++;
        if (crashAtTransaction && transactionCalls === crashAtTransaction) {
            throw new Error('simulated stop');
        }
        const result = handle.transaction(fn);
        afterCommit?.(handle);
        return result;
    };
    wrapped.run = (sql, params) => {
        runCalls++;
        return handle.run(sql, params);
    };
    return wrapped;
}

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    const sqliteEngine = await import('../src/endpoints/sqlite-engine.js');
    const engine = await sqliteEngine.getSqliteEngine();
    const openDatabase = engine.openDatabase;
    engine.openDatabase = (dbPath, options) => instrumentedHandle(openDatabase(dbPath, options));

    metadataDb = await import('../src/character-metadata-db.js');
    hashUtils = await import('../public/scripts/hash-utils.js');
    Database = (await import('better-sqlite3')).default;
});

beforeEach(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-tags-delete-finish-test-'));
    directories = /** @type {any} */ ({
        root,
        characters: path.join(root, 'characters'),
        chats: path.join(root, 'chats'),
        groups: path.join(root, 'groups'),
        groupChats: path.join(root, 'groupChats'),
    });
    for (const dir of [directories.characters, directories.chats, directories.groups, directories.groupChats]) {
        fs.mkdirSync(dir, { recursive: true });
    }
    crashAtTransaction = 0;
    transactionCalls = 0;
    runCalls = 0;
    afterCommit = null;
});

afterEach(() => {
    jest.restoreAllMocks();
    metadataDb.disposeMetadataStores();
    fs.rmSync(directories.root, { recursive: true, force: true });
});

/** @template T @param {(db: import('better-sqlite3').Database) => T} fn @returns {T} */
function withRawDb(fn) {
    const db = new Database(path.join(directories.root, 'character-metadata.sqlite'));
    try {
        return fn(db);
    } finally {
        db.close();
    }
}

/** @param {string} name */
function card(name) {
    return JSON.stringify({ name, spec: 'chara_card_v2', spec_version: '2.0', data: { name, tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });
}

async function seedCharacter(id) {
    await metadataDb.upsertCharacterFromWrite(directories, id, card(id.replace(/\.png$/, '')));
}

async function seedGroup(id) {
    const group = { id, name: id, members: [], chats: [], fav: false };
    fs.writeFileSync(path.join(directories.groups, `${id}.json`), JSON.stringify(group));
    await metadataDb.upsertGroupRow(directories, id, id, { fav: false, group });
}

/** @param {string[]} ids */
async function saveTags(ids) {
    expect(await metadataDb.saveTagDefinitions(directories, ids.map(id => ({ id, name: `name-${id}` })))).toBe('ok');
}

async function assign(id, tagId) {
    expect(await metadataDb.assignEntityTag(directories, id, tagId)).toBe('ok');
}

/** Every tag_usage row next to the counts the tag rows give, for rows whose counts differ. */
function tagUsageMismatches(db) {
    return Array.from(db.prepare(`
        WITH actual AS (
            SELECT tag_id, COUNT(*) AS n FROM (SELECT tag_id FROM character_tags UNION ALL SELECT tag_id FROM group_tags) GROUP BY tag_id
        )
        SELECT u.tag_id, u.count, COALESCE(a.n, 0) AS actual FROM tag_usage u LEFT JOIN actual a ON a.tag_id = u.tag_id WHERE u.count <> COALESCE(a.n, 0)
        UNION ALL
        SELECT a.tag_id, NULL, a.n FROM actual a WHERE a.tag_id NOT IN (SELECT tag_id FROM tag_usage)
    `).iterate());
}

/** Characters whose shallow_json.tag_ids differ from their character_tags rows. */
function characterCopiesOutOfSync(db) {
    const rows = Array.from(db.prepare('SELECT id, shallow_json FROM characters').iterate());
    const tagsOf = db.prepare('SELECT tag_id FROM character_tags WHERE character_id = ?').pluck();
    return rows.filter(r => JSON.stringify(JSON.parse(r.shallow_json).tag_ids) !== JSON.stringify(hashUtils.normalizeTagIds(Array.from(tagsOf.iterate(r.id))))).map(r => r.id);
}

/** Groups whose digest_tag_ids differ from their group_tags rows. NULL means not yet backfilled, which is no copy to compare. */
function groupCopiesOutOfSync(db) {
    const rows = Array.from(db.prepare('SELECT id, digest_tag_ids FROM groups WHERE digest_tag_ids IS NOT NULL').iterate());
    const tagsOf = db.prepare('SELECT tag_id FROM group_tags WHERE group_id = ? ORDER BY tag_id').pluck();
    return rows.filter(r => Number(r.digest_tag_ids) !== hashUtils.groupDigestTagIdsHash({ tag_ids: Array.from(tagsOf.iterate(r.id)) })).map(r => r.id);
}

function rawTagsOf(table, column, id) {
    return withRawDb(db => Array.from(db.prepare(`SELECT tag_id FROM ${table} WHERE ${column} = ? ORDER BY tag_id`).pluck().iterate(id)));
}

function markOf(tagId) {
    return withRawDb(db => db.prepare('SELECT merge_into FROM tag_deletions WHERE tag_id = ?').get(tagId));
}

function tagsRowExists(tagId) {
    return withRawDb(db => !!db.prepare('SELECT 1 FROM tags WHERE id = ?').get(tagId));
}

function usageRowOf(tagId) {
    return withRawDb(db => db.prepare('SELECT count FROM tag_usage WHERE tag_id = ?').get(tagId));
}

function changeFieldsFor(id) {
    return withRawDb(db => Array.from(db.prepare('SELECT fields FROM changes WHERE id = ? ORDER BY seq').pluck().iterate(id)));
}

describe('finishDeletedTags', () => {
    test('with nothing marked it writes nothing and runs no transaction', async () => {
        await saveTags(['x']);
        await seedCharacter('c1.png');
        await assign('c1.png', 'x');
        transactionCalls = 0;
        runCalls = 0;

        const result = await metadataDb.finishDeletedTags(directories);

        expect(result).toEqual({ batches: 0, rowsChanged: 0 });
        expect(transactionCalls).toBe(0);
        expect(runCalls).toBe(0);
        expect(rawTagsOf('character_tags', 'character_id', 'c1.png')).toEqual(['x']);
    });

    test('merges X onto Y for every character and group, including ones that already have Y, then removes X', async () => {
        await saveTags(['x', 'y', 'z']);
        for (const id of ['c1.png', 'c2.png', 'c3.png']) await seedCharacter(id);
        for (const id of ['g1', 'g2', 'g3']) await seedGroup(id);
        await assign('c1.png', 'x');
        await assign('c2.png', 'x');
        await assign('c2.png', 'y');
        await assign('c3.png', 'z');
        await assign('g1', 'x');
        await assign('g2', 'x');
        await assign('g2', 'y');
        await assign('g3', 'z');
        expect(await metadataDb.deleteTagDefinition(directories, 'x', 'y')).toMatchObject({ refused: [] });
        expect((await tagCounts(metadataDb, directories, ['x', 'y', 'z'])).approximate).toEqual(['y']);
        const changesBefore = { c1: changeFieldsFor('c1.png').length, c2: changeFieldsFor('c2.png').length, c3: changeFieldsFor('c3.png').length };

        const result = await metadataDb.finishDeletedTags(directories);

        expect(rawTagsOf('character_tags', 'character_id', 'c1.png')).toEqual(['y']);
        expect(rawTagsOf('character_tags', 'character_id', 'c2.png')).toEqual(['y']);
        expect(rawTagsOf('character_tags', 'character_id', 'c3.png')).toEqual(['z']);
        expect(rawTagsOf('group_tags', 'group_id', 'g1')).toEqual(['y']);
        expect(rawTagsOf('group_tags', 'group_id', 'g2')).toEqual(['y']);
        expect(rawTagsOf('group_tags', 'group_id', 'g3')).toEqual(['z']);
        expect(withRawDb(db => [characterCopiesOutOfSync(db), groupCopiesOutOfSync(db), tagUsageMismatches(db)])).toEqual([[], [], []]);

        // A character whose tags changed gets one ['tag_ids'] change entry; one whose tags didn't gets none.
        expect(changeFieldsFor('c1.png').slice(changesBefore.c1)).toEqual([JSON.stringify(['tag_ids'])]);
        expect(changeFieldsFor('c2.png').slice(changesBefore.c2)).toEqual([JSON.stringify(['tag_ids'])]);
        expect(changeFieldsFor('c3.png').length).toBe(changesBefore.c3);

        // Finished: the tags row, X's tag_usage row and the mark are gone, and the flag has cleared.
        expect(tagsRowExists('x')).toBe(false);
        expect(usageRowOf('x')).toBeUndefined();
        expect(markOf('x')).toBeUndefined();
        const usage = await tagCounts(metadataDb, directories, ['x', 'y', 'z']);
        expect(usage.approximate).toEqual([]);
        expect(usage.counts).toEqual({ y: 4, z: 2 });
        expect(result).toEqual({ batches: 2, rowsChanged: 4 });
        expect(tagsRowExists('y')).toBe(true);
    });

    test('a tag deleted with no merge target loses its rows and gets nothing in their place', async () => {
        await saveTags(['x', 'y']);
        await seedCharacter('c1.png');
        await seedGroup('g1');
        await assign('c1.png', 'x');
        await assign('c1.png', 'y');
        await assign('g1', 'x');
        expect(await metadataDb.deleteTagDefinition(directories, 'x', null)).toMatchObject({ refused: [] });

        await metadataDb.finishDeletedTags(directories);

        expect(rawTagsOf('character_tags', 'character_id', 'c1.png')).toEqual(['y']);
        expect(rawTagsOf('group_tags', 'group_id', 'g1')).toEqual([]);
        expect(withRawDb(db => [characterCopiesOutOfSync(db), groupCopiesOutOfSync(db), tagUsageMismatches(db)])).toEqual([[], [], []]);
        expect(tagsRowExists('x')).toBe(false);
        expect(usageRowOf('x')).toBeUndefined();
        expect(markOf('x')).toBeUndefined();
    });

    test('orphan rows carrying X are removed with no merge and listed in a warning', async () => {
        await saveTags(['x', 'y']);
        await seedCharacter('c1.png');
        await assign('c1.png', 'x');
        withRawDb(db => {
            db.prepare('INSERT INTO character_tags (character_id, tag_id) VALUES (?, ?)').run('ghost.png', 'x');
            db.prepare('INSERT INTO group_tags (group_id, tag_id) VALUES (?, ?)').run('ghostgroup', 'x');
        });
        expect(await metadataDb.deleteTagDefinition(directories, 'x', 'y')).toMatchObject({ refused: [] });
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

        await metadataDb.finishDeletedTags(directories);

        expect(rawTagsOf('character_tags', 'character_id', 'ghost.png')).toEqual([]);
        expect(rawTagsOf('group_tags', 'group_id', 'ghostgroup')).toEqual([]);
        expect(rawTagsOf('character_tags', 'character_id', 'c1.png')).toEqual(['y']);
        const warned = warn.mock.calls.map(args => String(args[0])).join('\n');
        expect(warned).toMatch(/ghost\.png: name-x/);
        expect(warned).toMatch(/ghostgroup: name-x/);
        expect(warned).not.toMatch(/c1\.png/);
        expect(withRawDb(db => tagUsageMismatches(db))).toEqual([]);
        expect(markOf('x')).toBeUndefined();
    });

    test('a group_tags row ending in .png is a group\'s row like any other: merged if its group exists, removed as an orphan if not', async () => {
        await saveTags(['x', 'y']);
        await seedCharacter('c1.png');
        await seedGroup('legacy.png');
        await assign('c1.png', 'x');
        withRawDb(db => {
            const insert = db.prepare('INSERT INTO group_tags (group_id, tag_id) VALUES (?, ?)');
            insert.run('legacy.png', 'x');
            insert.run('ghost.png', 'x');
        });
        expect(await metadataDb.deleteTagDefinition(directories, 'x', 'y')).toMatchObject({ refused: [] });
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

        await metadataDb.finishDeletedTags(directories);

        expect(rawTagsOf('group_tags', 'group_id', 'legacy.png')).toEqual(['y']);
        expect(rawTagsOf('group_tags', 'group_id', 'ghost.png')).toEqual([]);
        expect(rawTagsOf('character_tags', 'character_id', 'c1.png')).toEqual(['y']);
        const warned = warn.mock.calls.map(args => String(args[0])).join('\n');
        expect(warned).toMatch(/ghost\.png: name-x/);
        expect(warned).not.toMatch(/legacy\.png/);
        expect(withRawDb(db => [characterCopiesOutOfSync(db), groupCopiesOutOfSync(db), tagUsageMismatches(db)])).toEqual([[], [], []]);
        expect(markOf('x')).toBeUndefined();
        expect(tagsRowExists('x')).toBe(false);
        expect(usageRowOf('x')).toBeUndefined();
    });

    test('re-reads the mark every batch: a target marked mid-pass sends the rest of X onto the new target', async () => {
        await saveTags(['x', 'y', 'w']);
        await seedCharacter('c1.png');
        await seedGroup('g1');
        await assign('c1.png', 'x');
        await assign('g1', 'x');
        expect(await metadataDb.deleteTagDefinition(directories, 'x', 'y')).toMatchObject({ refused: [] });

        // After the character batch commits, y is deleted into w, which moves x's mark onto w.
        let marked = false;
        afterCommit = (handle) => {
            if (marked) return;
            if (handle.get('SELECT 1 FROM character_tags WHERE tag_id = \'x\'')) return;
            marked = true;
            handle.run('UPDATE tag_deletions SET merge_into = \'w\' WHERE merge_into = \'y\'');
            handle.run('INSERT INTO tag_deletions (tag_id, merge_into) VALUES (\'y\', \'w\')');
        };

        await metadataDb.finishDeletedTags(directories);
        afterCommit = null;

        expect(marked).toBe(true);
        // g1 went straight to w; c1 went to y, which the same run then finished onto w.
        expect(rawTagsOf('group_tags', 'group_id', 'g1')).toEqual(['w']);
        expect(rawTagsOf('character_tags', 'character_id', 'c1.png')).toEqual(['w']);
        expect(markOf('x')).toBeUndefined();
        expect(markOf('y')).toBeUndefined();
        expect(withRawDb(db => [characterCopiesOutOfSync(db), groupCopiesOutOfSync(db), tagUsageMismatches(db)])).toEqual([[], [], []]);
    });
});

/** Writes 'seed.png' through the store, then `count` raw copies c00000.png, c00001.png, ... carrying `tagIdsOf(i)`. */
async function seedCharacterCopies(count, tagIdsOf) {
    await seedCharacter('seed.png');
    withRawDb(db => {
        const columns = Array.from(db.prepare('SELECT name FROM pragma_table_info(\'characters\')').pluck().iterate()).filter(c => c !== 'id');
        db.prepare(`
            WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i + 1 < ?)
            INSERT INTO characters (id, ${columns.join(', ')})
            SELECT printf('c%05d.png', n.i), ${columns.map(c => `s.${c}`).join(', ')} FROM n, characters s WHERE s.id = 'seed.png'
        `).run(count);
        const insertTag = db.prepare('INSERT INTO character_tags (character_id, tag_id) VALUES (?, ?)');
        const setTagIds = db.prepare('UPDATE characters SET shallow_json = json_set(shallow_json, \'$.tag_ids\', json(?)), digest_tag_ids = ? WHERE id = ?');
        db.transaction(() => {
            for (let i = 0; i < count; i++) {
                const id = `c${String(i).padStart(5, '0')}.png`;
                const tagIds = hashUtils.normalizeTagIds(tagIdsOf(i));
                for (const tagId of tagIds) insertTag.run(id, tagId);
                setTagIds.run(JSON.stringify(tagIds), hashUtils.characterDigestTagIdsHash({ tag_ids: tagIds }), id);
            }
        })();
    });
}

/** Group rows g00000, g00001, ... carrying `tagIdsOf(i)`. */
async function seedGroupCopies(count, tagIdsOf) {
    await seedGroup('seedg');
    withRawDb(db => {
        const columns = Array.from(db.prepare('SELECT name FROM pragma_table_info(\'groups\')').pluck().iterate()).filter(c => c !== 'id');
        db.prepare(`
            WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i + 1 < ?)
            INSERT INTO groups (id, ${columns.join(', ')})
            SELECT printf('g%05d', n.i), ${columns.map(c => `s.${c}`).join(', ')} FROM n, groups s WHERE s.id = 'seedg'
        `).run(count);
        const insertTag = db.prepare('INSERT INTO group_tags (group_id, tag_id) VALUES (?, ?)');
        const setDigest = db.prepare('UPDATE groups SET digest_tag_ids = ? WHERE id = ?');
        db.transaction(() => {
            for (let i = 0; i < count; i++) {
                const id = `g${String(i).padStart(5, '0')}`;
                const tagIds = [...tagIdsOf(i)].sort();
                for (const tagId of tagIds) insertTag.run(id, tagId);
                setDigest.run(hashUtils.groupDigestTagIdsHash({ tag_ids: tagIds }), id);
            }
        })();
    });
}

describe('finishDeletedTags over many batches', () => {
    const CHARACTERS = 2500;
    const GROUPS = 1500;
    const tagsOf = (/** @type {number} */ i) => (i % 3 === 0 ? ['x', 'y'] : ['x']);

    test('tag_usage and the stored copies are exact at every batch boundary, and .png orphan rows between groups are removed', async () => {
        await saveTags(['x', 'y']);
        await seedCharacterCopies(CHARACTERS, tagsOf);
        await seedGroupCopies(GROUPS, tagsOf);
        withRawDb(db => {
            const insert = db.prepare('INSERT INTO group_tags (group_id, tag_id) VALUES (?, ?)');
            for (const id of ['g00500.png', 'g01200.png']) insert.run(id, 'x');
        });
        expect(await metadataDb.deleteTagDefinition(directories, 'x', 'y')).toMatchObject({ refused: [] });
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

        /** @type {any[]} */
        const boundaries = [];
        afterCommit = (handle) => {
            const db = new Database(path.join(directories.root, 'character-metadata.sqlite'), { readonly: true });
            try {
                boundaries.push([tagUsageMismatches(db), characterCopiesOutOfSync(db), groupCopiesOutOfSync(db)]);
            } finally {
                db.close();
            }
        };
        const result = await metadataDb.finishDeletedTags(directories);
        afterCommit = null;

        expect(boundaries.length).toBeGreaterThanOrEqual(5);
        for (const boundary of boundaries) expect(boundary).toEqual([[], [], []]);
        expect(withRawDb(db => db.prepare('SELECT COUNT(*) FROM character_tags WHERE tag_id = \'x\'').pluck().get())).toBe(0);
        expect(withRawDb(db => db.prepare('SELECT COUNT(*) FROM group_tags WHERE tag_id = \'x\'').pluck().get())).toBe(0);
        expect(withRawDb(db => db.prepare('SELECT COUNT(*) FROM character_tags WHERE tag_id = \'y\'').pluck().get())).toBe(CHARACTERS);
        expect(withRawDb(db => db.prepare('SELECT COUNT(*) FROM group_tags WHERE tag_id = \'y\'').pluck().get())).toBe(GROUPS);
        expect(result).toEqual({ batches: 5, rowsChanged: CHARACTERS + GROUPS + 2 });
        const warned = warn.mock.calls.map(args => String(args[0])).join('\n');
        expect(warned).toMatch(/g00500\.png: name-x/);
        expect(warned).toMatch(/g01200\.png: name-x/);
        expect(markOf('x')).toBeUndefined();
    }, 60000);

    test('a pass stopped mid-way resumes from the rows still left and finishes the tag', async () => {
        await saveTags(['x', 'y']);
        await seedCharacterCopies(CHARACTERS, tagsOf);
        await seedGroupCopies(GROUPS, tagsOf);
        expect(await metadataDb.deleteTagDefinition(directories, 'x', 'y')).toMatchObject({ refused: [] });

        transactionCalls = 0;
        crashAtTransaction = 2;
        await expect(metadataDb.finishDeletedTags(directories)).rejects.toThrow('simulated stop');
        crashAtTransaction = 0;

        expect(withRawDb(db => db.prepare('SELECT COUNT(*) FROM character_tags WHERE tag_id = \'x\'').pluck().get())).toBe(CHARACTERS - 1000);
        expect(withRawDb(db => [characterCopiesOutOfSync(db), groupCopiesOutOfSync(db), tagUsageMismatches(db)])).toEqual([[], [], []]);
        expect(markOf('x')).toEqual({ merge_into: 'y' });

        metadataDb.disposeMetadataStores();
        const result = await metadataDb.finishDeletedTags(directories);

        expect(result).toEqual({ batches: 4, rowsChanged: CHARACTERS - 1000 + GROUPS });
        expect(withRawDb(db => db.prepare('SELECT COUNT(*) FROM character_tags WHERE tag_id = \'y\'').pluck().get())).toBe(CHARACTERS);
        expect(withRawDb(db => db.prepare('SELECT COUNT(*) FROM group_tags WHERE tag_id = \'y\'').pluck().get())).toBe(GROUPS);
        expect(withRawDb(db => [characterCopiesOutOfSync(db), groupCopiesOutOfSync(db), tagUsageMismatches(db)])).toEqual([[], [], []]);
        expect(tagsRowExists('x')).toBe(false);
        expect(usageRowOf('x')).toBeUndefined();
        expect(markOf('x')).toBeUndefined();
        expect((await tagCounts(metadataDb, directories, ['x', 'y', 'z'])).approximate).toEqual([]);
    }, 60000);
});
