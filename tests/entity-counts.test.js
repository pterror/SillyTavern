import { describe, test, expect, beforeAll, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Each test sets the fill frontier (entity_count_fill) by hand on an empty store, so the counters start exact for the
// filled range, then checks every counter against a direct COUNT of that range after each write.

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
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-entity-counts-test-'));
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
function card(name, fav = false) {
    return JSON.stringify({ name, spec: 'chara_card_v2', spec_version: '2.0', data: { name, tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav, world: '' } } });
}

/**
 * @param {string} id
 * @param {boolean} [fav]
 * @param {{ fromImport?: boolean }} [options] As for upsertCharacterFromWrite().
 */
async function seedCharacter(id, fav = false, options = {}) {
    await metadataDb.upsertCharacterFromWrite(directories, id, card(id.replace(/\.png$/, ''), fav), null, null, options);
}

async function seedGroup(id, fav = false) {
    const group = { id, name: id, members: [], chats: [], fav };
    fs.writeFileSync(path.join(directories.groups, `${id}.json`), JSON.stringify(group));
    await metadataDb.upsertGroupRow(directories, id, id, { fav, group });
}

/** @param {string[]} ids */
async function saveTags(ids) {
    expect(await metadataDb.saveTagDefinitions(directories, ids.map(id => ({ id, name: `name-${id}` })))).toBe('ok');
}

async function assign(id, tagId) {
    expect(await metadataDb.assignEntityTag(directories, id, tagId)).toBe('ok');
}

/**
 * Opens the store (creating its schema) and sets the fill frontier of both kinds by hand.
 * @param {{ character: { upto: string | null, done: boolean }, group: { upto: string | null, done: boolean } }} frontier
 */
async function openWithFrontier(frontier) {
    await metadataDb.ensureSchemaMigrated(directories);
    withRawDb(db => {
        for (const kind of /** @type {const} */ (['character', 'group'])) {
            db.prepare('UPDATE entity_count_fill SET upto = ?, done = ? WHERE kind = ?').run(frontier[kind].upto, frontier[kind].done ? 1 : 0, kind);
        }
    });
}

const NOTHING = { upto: null, done: false };
const DONE = { upto: null, done: true };

/**
 * Every counter that differs from a direct COUNT over the filled range, as [table, key, stored, actual]. A counter
 * row at 0 is kept out of both sides: a missing row reads as 0.
 * @param {import('better-sqlite3').Database} db
 */
function counterMismatches(db) {
    const filled = (kind, column) => `EXISTS (SELECT 1 FROM entity_count_fill f WHERE f.kind = '${kind}' AND (f.done = 1 OR ${column} <= f.upto))`;
    const expectedEntities = Array.from(db.prepare(`
        SELECT 'character' AS kind, fav, COUNT(*) AS n FROM characters WHERE ${filled('character', 'id')} GROUP BY fav
        UNION ALL
        SELECT 'group' AS kind, fav, COUNT(*) AS n FROM groups WHERE ${filled('group', 'id')} GROUP BY fav
    `).iterate());
    const expectedTags = Array.from(db.prepare(`
        SELECT t.tag_id, 'character' AS kind, c.fav, COUNT(*) AS n FROM character_tags t JOIN characters c ON c.id = t.character_id
            WHERE ${filled('character', 'c.id')} GROUP BY t.tag_id, c.fav
        UNION ALL
        SELECT t.tag_id, 'group' AS kind, g.fav, COUNT(*) AS n FROM group_tags t JOIN groups g ON g.id = t.group_id
            WHERE substr(t.group_id, -4) <> '.png' AND ${filled('group', 'g.id')} GROUP BY t.tag_id, g.fav
    `).iterate());
    const storedEntities = Array.from(db.prepare('SELECT kind, fav, count AS n FROM entity_counts WHERE count <> 0').iterate());
    const storedTags = Array.from(db.prepare('SELECT tag_id, kind, fav, count AS n FROM entity_tag_counts WHERE count <> 0').iterate());

    const mismatches = [];
    const compare = (table, expected, stored, keyOf) => {
        const want = new Map(expected.map(r => [keyOf(r), r.n]));
        const have = new Map(stored.map(r => [keyOf(r), r.n]));
        for (const key of new Set([...want.keys(), ...have.keys()])) {
            if (want.get(key) !== have.get(key)) mismatches.push([table, key, have.get(key) ?? 0, want.get(key) ?? 0]);
        }
    };
    compare('entity_counts', expectedEntities, storedEntities, r => `${r.kind}/${r.fav}`);
    compare('entity_tag_counts', expectedTags, storedTags, r => `${r.tag_id}/${r.kind}/${r.fav}`);
    return mismatches;
}

function expectCountersExact() {
    withRawDb(db => expect(counterMismatches(db)).toEqual([]));
}

/** @param {import('better-sqlite3').Database} db */
function counterRowCount(db) {
    return db.prepare('SELECT (SELECT COUNT(*) FROM entity_counts) + (SELECT COUNT(*) FROM entity_tag_counts) AS n').get().n;
}

/**
 * Runs every write kind through the store's own functions, checking every counter after each one.
 * Character ids starting with a sort below 'm' and with z above; group ids starting with ga or gb sort below 'gm'
 * and with gz above.
 */
async function runEveryWriteKind() {
    await saveTags(['t1', 't2', 't3']);
    expectCountersExact();

    // Character insert, with fav and without.
    await seedCharacter('a1.png');
    await seedCharacter('a2.png', true);
    await seedCharacter('z1.png');
    await seedCharacter('z2.png', true);
    expectCountersExact();

    // Group insert, with fav and without.
    await seedGroup('ga1');
    await seedGroup('gb2', true);
    await seedGroup('gz1');
    await seedGroup('gz2', true);
    expectCountersExact();

    // Tag assign on characters and groups, both fav values.
    for (const id of ['a1.png', 'a2.png', 'z1.png', 'z2.png', 'ga1', 'gb2', 'gz1', 'gz2']) await assign(id, 't1');
    for (const id of ['a1.png', 'z2.png', 'gb2', 'gz1']) await assign(id, 't2');
    expectCountersExact();

    // Assigning a tag the entity already has (INSERT OR IGNORE) changes nothing.
    await assign('a1.png', 't1');
    await assign('ga1', 't1');
    expectCountersExact();

    // Character fav flips both ways, on entities with tags.
    expect(await metadataDb.setCharacterFav(directories, 'a1.png', true)).toBe(true);
    expect(await metadataDb.setCharacterFav(directories, 'z2.png', false)).toBe(true);
    expectCountersExact();
    expect(await metadataDb.setCharacterFav(directories, 'a1.png', false)).toBe(true);
    expectCountersExact();

    // Group fav flips both ways through the group upsert.
    await seedGroup('ga1', true);
    await seedGroup('gz1', true);
    expectCountersExact();
    await seedGroup('gb2', false);
    expectCountersExact();

    // Tag unassign.
    expect(await metadataDb.unassignEntityTag(directories, 'a1.png', 't2')).toBe('ok');
    expect(await metadataDb.unassignEntityTag(directories, 'gz1', 't2')).toBe('ok');
    expectCountersExact();

    // Moving entities to other tags, and a group to none.
    for (const [id, tagId] of [['a2.png', 't1'], ['z1.png', 't1'], ['gb2', 't1'], ['gb2', 't2'], ['gz2', 't1']]) {
        expect(await metadataDb.unassignEntityTag(directories, id, tagId)).toBe('ok');
    }
    for (const [id, tagId] of [['a2.png', 't2'], ['a2.png', 't3'], ['z1.png', 't3'], ['gb2', 't3']]) await assign(id, tagId);
    expectCountersExact();

    // Rewriting an existing character's card (upsert over the row, fav unchanged).
    await seedCharacter('a2.png', true);
    await seedCharacter('z1.png', false);
    expectCountersExact();

    // Rename: the new id takes the old id's tags, and the old row goes.
    await seedCharacter('a3.png');
    await metadataDb.renameCharacterRow(directories, 'z1.png', 'a3.png');
    expectCountersExact();

    // A tag marked deleted and merged, then finished: rows move from t2 to t1, one entity already has both.
    await assign('a2.png', 't1');
    await metadataDb.deleteTagDefinition(directories, 't2', 't1');
    expectCountersExact();
    await metadataDb.finishDeletedTags(directories);
    withRawDb(db => {
        expect(db.prepare('SELECT COUNT(*) AS n FROM character_tags WHERE tag_id = \'t2\'').get().n).toBe(0);
    });
    expectCountersExact();

    // Delete of entities that have tags.
    await metadataDb.deleteCharacterRow(directories, 'a2.png');
    await metadataDb.deleteCharacterRow(directories, 'z2.png');
    await metadataDb.deleteGroupRow(directories, 'gb2');
    await metadataDb.deleteGroupRow(directories, 'gz1');
    expectCountersExact();
}

/**
 * Legacy rows the store functions above never produce (tag rows with no entity row yet, tag rows of a group whose id
 * ends in .png), written raw, then the entity writes over them through the store.
 */
async function runLegacyRows() {
    withRawDb(db => {
        for (const id of ['a9.png', 'z9.png']) db.prepare('INSERT INTO character_tags (character_id, tag_id) VALUES (?, ?)').run(id, 't1');
        for (const id of ['ga9', 'gz9']) db.prepare('INSERT INTO group_tags (group_id, tag_id) VALUES (?, ?)').run(id, 't1');
        expect(counterMismatches(db)).toEqual([]);
    });
    // Tag rows written before their entity's row: counted once the entity row lands.
    await seedCharacter('a9.png', true);
    await seedCharacter('z9.png');
    await seedGroup('ga9', true);
    await seedGroup('gz9');
    expectCountersExact();

    // Legacy .png group rows: counted as groups, while their group_tags rows count for no tag. legacy2.png is kept to
    // the end, where the totals are compared with queryEntities().
    await seedGroup('legacy.png', true);
    await seedGroup('legacy2.png');
    withRawDb(db => {
        for (const id of ['legacy.png', 'legacy2.png']) db.prepare('INSERT INTO group_tags (group_id, tag_id) VALUES (?, ?)').run(id, 't1');
        expect(counterMismatches(db)).toEqual([]);
    });
    await seedGroup('legacy.png', false);
    expectCountersExact();

    // Entities with tag rows deleted.
    await metadataDb.deleteCharacterRow(directories, 'a9.png');
    await metadataDb.deleteGroupRow(directories, 'ga9');
    await metadataDb.deleteGroupRow(directories, 'legacy.png');
    expectCountersExact();
}

describe('entity counters', () => {
    test('the schema starts with nothing filled and every counter empty', async () => {
        await metadataDb.ensureSchemaMigrated(directories);
        withRawDb(db => {
            expect(Array.from(db.prepare('SELECT kind, upto, done FROM entity_count_fill ORDER BY kind').iterate())).toEqual([
                { kind: 'character', upto: null, done: 0 },
                { kind: 'group', upto: null, done: 0 },
            ]);
            expect(counterRowCount(db)).toBe(0);
        });
    });

    test('with nothing filled, no write touches a counter', async () => {
        await openWithFrontier({ character: NOTHING, group: NOTHING });
        await runEveryWriteKind();
        await runLegacyRows();
        withRawDb(db => expect(counterRowCount(db)).toBe(0));
    });

    test('filled part way, counters are exact for the filled range across every write kind', async () => {
        await openWithFrontier({ character: { upto: 'm', done: false }, group: { upto: 'gm', done: false } });
        await runEveryWriteKind();
        await runLegacyRows();
        withRawDb(db => {
            // Entities on both sides of the frontier exist, so the range really is partial.
            expect(db.prepare('SELECT COUNT(*) AS n FROM characters WHERE id > \'m\'').get().n).toBeGreaterThan(0);
            expect(db.prepare('SELECT COUNT(*) AS n FROM groups WHERE id > \'gm\'').get().n).toBeGreaterThan(0);
            expect(counterRowCount(db)).toBeGreaterThan(0);
        });
    });

    test('one kind done and the other with nothing filled, each kind follows its own frontier', async () => {
        await openWithFrontier({ character: DONE, group: NOTHING });
        await runEveryWriteKind();
        await runLegacyRows();
        withRawDb(db => {
            expect(db.prepare('SELECT COUNT(*) AS n FROM entity_counts WHERE kind = \'group\'').get().n).toBe(0);
            expect(db.prepare('SELECT COUNT(*) AS n FROM entity_tag_counts WHERE kind = \'group\'').get().n).toBe(0);
        });
    });

    test('marked done, counters are exact across every write kind', async () => {
        await openWithFrontier({ character: DONE, group: DONE });
        await runEveryWriteKind();
        await runLegacyRows();
        withRawDb(db => {
            expect(counterRowCount(db)).toBeGreaterThan(0);
            expect(counterMismatches(db)).toEqual([]);
        });
    });

    test('marked done, the counters give the same totals as queryEntities for every single-counter shape', async () => {
        await openWithFrontier({ character: DONE, group: DONE });
        await runEveryWriteKind();
        await runLegacyRows();

        const read = () => withRawDb(db => ({
            entities: Array.from(db.prepare('SELECT kind, fav, count FROM entity_counts').iterate()),
            tags: Array.from(db.prepare('SELECT tag_id, kind, fav, count FROM entity_tag_counts').iterate()),
        }));
        const { entities, tags } = read();
        const sum = (rows, pred) => rows.filter(pred).reduce((n, r) => n + r.count, 0);
        const favMatches = fav => r => fav === undefined || r.fav === (fav ? 1 : 0);

        for (const fav of [undefined, true, false]) {
            const kindTotal = sum(entities, favMatches(fav));
            const noTag = await metadataDb.queryEntities(directories, { fav, wantRows: false, wantTotal: true });
            expect(noTag?.total).toBe(kindTotal);
            for (const tagId of ['t1', 't3']) {
                const tagTotal = sum(tags, r => r.tag_id === tagId && favMatches(fav)(r));
                const included = await metadataDb.queryEntities(directories, { fav, tags: { include: [tagId] }, wantRows: false, wantTotal: true });
                expect(included?.total).toBe(tagTotal);
                const excluded = await metadataDb.queryEntities(directories, { fav, tags: { exclude: [tagId] }, wantRows: false, wantTotal: true });
                expect(excluded?.total).toBe(kindTotal - tagTotal);
            }
        }
    });

    test('a batch import keeps the counters exact', async () => {
        await openWithFrontier({ character: { upto: 'm', done: false }, group: DONE });
        await saveTags(['t1']);
        await metadataDb.beginBatchImport(directories);
        await seedCharacter('a1.png', true, { fromImport: true });
        await seedCharacter('z1.png', false, { fromImport: true });
        await metadataDb.endBatchImport(directories);
        expectCountersExact();
        await assign('a1.png', 't1');
        await assign('z1.png', 't1');
        withRawDb(db => {
            expect(counterMismatches(db)).toEqual([]);
            expect(Array.from(db.prepare('SELECT kind, fav, count FROM entity_counts').iterate())).toEqual([{ kind: 'character', fav: 1, count: 1 }]);
        });
    });

    test('a write that keeps fav the same leaves every counter as it was', async () => {
        await openWithFrontier({ character: DONE, group: DONE });
        await saveTags(['t1', 't2']);
        await seedCharacter('a1.png', true);
        await seedGroup('ga1', true);
        await assign('a1.png', 't1');
        await assign('a1.png', 't2');
        await assign('ga1', 't1');
        const counters = () => withRawDb(db => ({
            entities: Array.from(db.prepare('SELECT * FROM entity_counts ORDER BY kind, fav').iterate()),
            tags: Array.from(db.prepare('SELECT * FROM entity_tag_counts ORDER BY tag_id, kind, fav').iterate()),
        }));
        const before = counters();
        expect(await metadataDb.setCharacterFav(directories, 'a1.png', true)).toBe(true);
        await seedGroup('ga1', true);
        await seedCharacter('a1.png', true);
        await assign('a1.png', 't1');
        expect(counters()).toEqual(before);
        expectCountersExact();
    });

    test('a fav flip moves the entity and each of its tags to the other fav counter', async () => {
        await openWithFrontier({ character: DONE, group: DONE });
        await saveTags(['t1', 't2', 't3']);
        await seedCharacter('a1.png');
        for (const tagId of ['t1', 't2', 't3']) await assign('a1.png', tagId);
        await seedCharacter('a2.png', true);
        await assign('a2.png', 't1');
        expect(await metadataDb.setCharacterFav(directories, 'a1.png', true)).toBe(true);
        withRawDb(db => {
            expect(counterMismatches(db)).toEqual([]);
            expect(Array.from(db.prepare('SELECT kind, fav, count FROM entity_counts').iterate())).toEqual([{ kind: 'character', fav: 1, count: 2 }]);
        });
    });

    test('the card_json table rebuild keeps the counters, and writes after it are counted', async () => {
        await openWithFrontier({ character: DONE, group: DONE });
        await saveTags(['t1']);
        await seedCharacter('a1.png', true);
        await assign('a1.png', 't1');
        metadataDb.disposeMetadataStores();
        // A store whose card_json is still nullable (a boot that left unresolved rows).
        withRawDb(db => {
            const columns = Array.from(db.prepare('PRAGMA table_info(characters)').iterate());
            db.pragma('legacy_alter_table = ON');
            db.exec('CREATE TABLE characters_old (' + columns.map(c => `${c.name} ${c.type}${c.name !== 'card_json' && c.notnull ? ' NOT NULL' : ''}${c.pk ? ' PRIMARY KEY' : ''}`).join(', ') + ')');
            db.exec('INSERT INTO characters_old SELECT * FROM characters');
            db.exec('DROP TABLE characters');
            db.exec('ALTER TABLE characters_old RENAME TO characters');
            expect(db.prepare('SELECT "notnull" FROM pragma_table_info(\'characters\') WHERE name = \'card_json\'').get().notnull).toBe(0);
        });
        await metadataDb.ensureSchemaMigrated(directories);
        withRawDb(db => expect(db.prepare('SELECT "notnull" FROM pragma_table_info(\'characters\') WHERE name = \'card_json\'').get().notnull).toBe(1));
        await seedCharacter('a2.png');
        await assign('a2.png', 't1');
        await metadataDb.deleteCharacterRow(directories, 'a1.png');
        expectCountersExact();
        withRawDb(db => expect(db.prepare('SELECT count FROM entity_tag_counts WHERE tag_id = \'t1\' AND kind = \'character\' AND fav = 0').get()?.count).toBe(1));
    });

    test('the frontier and counters survive a reopen', async () => {
        await openWithFrontier({ character: DONE, group: DONE });
        await saveTags(['t1']);
        await seedCharacter('a1.png', true);
        await assign('a1.png', 't1');
        metadataDb.disposeMetadataStores();
        await seedCharacter('a2.png');
        await assign('a2.png', 't1');
        await seedGroup('ga1');
        await assign('ga1', 't1');
        expectCountersExact();
        withRawDb(db => expect(db.prepare('SELECT done FROM entity_count_fill WHERE kind = \'character\'').get().done).toBe(1));
    });
});

describe('random writes against a recount', () => {
    /** @param {number} seed */
    function rng(seed) {
        let s = seed >>> 0;
        return () => {
            s = (s + 0x6D2B79F5) >>> 0;
            let t = s;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    /** Every tag's usage count, stored (tag_usage and the tags row) next to the count of its rows, where they differ. */
    function tagUsageMismatches(db) {
        return Array.from(db.prepare(`
            WITH actual AS (SELECT tag_id, COUNT(*) AS n FROM (SELECT tag_id FROM character_tags UNION ALL SELECT tag_id FROM group_tags) GROUP BY tag_id)
            SELECT t.id, u.count AS stored, t.usage_count AS column, COALESCE(a.n, 0) AS actual FROM tags t
                LEFT JOIN tag_usage u ON u.tag_id = t.id LEFT JOIN actual a ON a.tag_id = t.id
            WHERE COALESCE(u.count, 0) <> COALESCE(a.n, 0) OR COALESCE(t.usage_count, 0) <> COALESCE(a.n, 0)
        `).iterate());
    }

    for (const seed of [1, 2, 3]) {
        test(`seed ${seed}: entity and tag counters, tag usage and list totals equal a recount after every write`, async () => {
            const random = rng(seed);
            const pick = (/** @type {any[]} */ list) => list[Math.floor(random() * list.length)];
            await openWithFrontier({ character: DONE, group: DONE });
            const TAGS = ['t1', 't2', 't3', 't4'];
            await saveTags(TAGS);
            const characters = ['a.png', 'b.png', 'c.png', 'm.png', 'z.png'];
            const groups = ['ga', 'gb', 'gz'];
            for (let step = 0; step < 250; step++) {
                const op = random();
                const isGroup = random() < 0.4;
                const id = isGroup ? pick(groups) : pick(characters);
                const exists = withRawDb(db => !!db.prepare(`SELECT 1 FROM ${isGroup ? 'groups' : 'characters'} WHERE id = ?`).get(id));
                if (op < 0.2) {
                    if (isGroup) await seedGroup(id, random() < 0.5);
                    else await seedCharacter(id, random() < 0.5);
                } else if (op < 0.3) {
                    if (isGroup) await metadataDb.deleteGroupRow(directories, id);
                    else await metadataDb.deleteCharacterRow(directories, id);
                } else if (op < 0.45) {
                    if (!exists) continue;
                    if (isGroup) await seedGroup(id, random() < 0.5);
                    else await metadataDb.toggleCharacterFav(directories, id);
                } else if (op < 0.7) {
                    if (exists) await assign(id, pick(TAGS));
                } else if (op < 0.9) {
                    if (exists) await unassign(id, pick(TAGS));
                } else if (op < 0.95) {
                    if (!exists || isGroup) continue;
                    const to = pick(characters);
                    const taken = withRawDb(db => !!db.prepare('SELECT 1 FROM characters WHERE id = ?').get(to));
                    if (taken) continue;
                    await seedCharacter(to);
                    await metadataDb.renameCharacterRow(directories, id, to);
                } else {
                    continue;
                }
                withRawDb(db => {
                    expect([step, counterMismatches(db)]).toEqual([step, []]);
                    expect([step, tagUsageMismatches(db)]).toEqual([step, []]);
                });
                if (step % 10 === 0) await expectTotals(step);
            }
        }, 120000);
    }

    /** List totals and a tag's usage count, read through the store, against a count of the rows. @param {number} step */
    async function expectTotals(step) {
        const want = withRawDb(db => ({
            all: db.prepare('SELECT (SELECT COUNT(*) FROM characters) + (SELECT COUNT(*) FROM groups)').pluck().get(),
            fav: db.prepare('SELECT (SELECT COUNT(*) FROM characters WHERE fav = 1) + (SELECT COUNT(*) FROM groups WHERE fav = 1)').pluck().get(),
            t1: db.prepare(`SELECT (SELECT COUNT(*) FROM character_tags t JOIN characters c ON c.id = t.character_id WHERE t.tag_id = 't1')
                            + (SELECT COUNT(*) FROM group_tags t JOIN groups g ON g.id = t.group_id WHERE t.tag_id = 't1')`).pluck().get(),
        }));
        expect([step, (await metadataDb.queryEntities(directories, { wantRows: false, wantTotal: true }))?.total]).toEqual([step, want.all]);
        expect([step, (await metadataDb.queryEntities(directories, { fav: true, wantRows: false, wantTotal: true }))?.total]).toEqual([step, want.fav]);
        expect([step, (await metadataDb.queryEntities(directories, { tags: { include: ['t1'] }, wantRows: false, wantTotal: true }))?.total]).toEqual([step, want.t1]);
        expect([step, await metadataDb.getTagUsageCount(directories, 't1')]).toEqual([step, withRawDb(db => db.prepare('SELECT (SELECT COUNT(*) FROM character_tags WHERE tag_id = \'t1\') + (SELECT COUNT(*) FROM group_tags WHERE tag_id = \'t1\')').pluck().get())]);
    }
});

/** @param {string} id @param {string} tagId */
async function unassign(id, tagId) {
    expect(await metadataDb.unassignEntityTag(directories, id, tagId)).toBe('ok');
}
