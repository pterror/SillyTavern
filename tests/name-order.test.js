import { describe, test, expect, beforeAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

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
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-name-order-test-'));
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
});

afterEach(() => {
    metadataDb.disposeMetadataStores();
    fs.rmSync(directories.root, { recursive: true, force: true });
});

const dbPath = () => path.join(directories.root, 'character-metadata.sqlite');

/** @param {string} id @param {string} name */
async function addCharacter(id, name) {
    const cardJson = JSON.stringify({ name, data: { name, tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });
    await metadataDb.upsertCharacterFromWrite(directories, id, cardJson);
}

/** @param {string} id @param {string} name */
async function addGroup(id, name) {
    const group = { id, name, members: [], chats: [], fav: false };
    fs.writeFileSync(path.join(directories.groups, `${id}.json`), JSON.stringify(group));
    await metadataDb.upsertGroupRow(directories, id, name, { fav: false, group });
}

/** @param {(db: import('better-sqlite3').Database) => void} work */
function withDb(work) {
    metadataDb.disposeMetadataStores();
    const db = new Database(dbPath());
    try {
        work(db);
    } finally {
        db.close();
    }
}

/**
 * Every entity in the order the rule gives it (name_fold, then characters before groups, then the id with a group's
 * as `<id>.json`, in UTF-8 bytes), against the order its positions give. A descending sort reads them reversed.
 */
function checkOrders() {
    const db = new Database(dbPath(), { readonly: true });
    try {
        const entities = [
            ...db.prepare('SELECT id, name_fold FROM characters').all().map(r => ({ key: `c|${r.id}`, nameFold: r.name_fold, tie: `c\u001f${r.id}` })),
            ...db.prepare('SELECT id, name_fold FROM groups').all().map(r => ({ key: `g|${r.id}`, nameFold: r.name_fold, tie: `g\u001f${r.id}.json` })),
        ];
        const bytes = (/** @type {string} */ s) => Buffer.from(s, 'utf8');
        const byTie = (a, b) => Buffer.compare(bytes(a.tie), bytes(b.tie));
        const asc = [...entities].sort((a, b) => Buffer.compare(bytes(a.nameFold), bytes(b.nameFold)) || byTie(a, b)).map(e => e.key);
        const rows = db.prepare('SELECT kind, entity_id, pos_asc FROM name_order').all();
        expect(rows).toHaveLength(entities.length);
        for (const r of rows) {
            expect(r.pos_asc).not.toBeNull();
            expect(r.pos_asc).toBeGreaterThan(0);
            expect(r.pos_asc).toBeLessThan(metadataDb.NAME_ORDER_LIMIT);
        }
        expect([...rows].sort((a, b) => a.pos_asc - b.pos_asc).map(r => `${r.kind}|${r.entity_id}`)).toEqual(asc);
        expect(new Set(rows.map(r => r.pos_asc)).size).toBe(rows.length);
    } finally {
        db.close();
    }
}

async function placeAll() {
    for (;;) {
        const result = await metadataDb.placeNameOrderRows(directories, 1000);
        if (result.placed === 0) return;
    }
}

describe('character-metadata-db.js: the full name order (search plan step 7f)', () => {
    test('the fill numbers the order exactly: shared prefixes, non-Latin names, ties with groups', async () => {
        for (const [id, name] of [['Alexandra.png', 'Alexandra'], ['Alexander.png', 'Alexander'], ['Alexanda.png', 'Alexanda'], ['b.png', 'Same'], ['a.png', 'Same'], ['cyr.png', 'аbc'], ['zero.png', '0bc']]) {
            await addCharacter(id, name);
        }
        await addGroup('1', 'Same');
        await addGroup('2', 'Alexandre');
        expect((await metadataDb.getNameOrderState(directories)).usable).toBe(false);

        await metadataDb.fillNameOrderIfNeeded(directories);

        checkOrders();
        const state = await metadataDb.getNameOrderState(directories);
        expect(state.usable).toBe(true);
        const changes = await metadataDb.getNameOrderChangesSince(directories, 0, 10);
        expect(changes.all).toBe(true);
    });

    test('adds, renames and deletes after the fill are placed in order, and moved characters are logged', async () => {
        for (let i = 0; i < 5; i++) await addCharacter(`c${i}.png`, `Name ${i}`);
        await metadataDb.fillNameOrderIfNeeded(directories);
        const afterFill = (await metadataDb.getNameOrderState(directories)).seq;

        await addCharacter('new.png', 'Name 2b');
        await addGroup('g9', 'Name 0');
        withDb(db => db.prepare('UPDATE characters SET name_fold = ? WHERE id = ?').run('aaa', 'c4.png'));
        withDb(db => db.prepare('DELETE FROM characters WHERE id = ?').run('c1.png'));
        expect((await metadataDb.getNameOrderState(directories)).usable).toBe(false);

        await placeAll();

        checkOrders();
        expect((await metadataDb.getNameOrderState(directories)).usable).toBe(true);
        const changes = await metadataDb.getNameOrderChangesSince(directories, afterFill, 100);
        expect(changes.all).toBe(false);
        expect(changes.ids).toEqual(expect.arrayContaining(['new.png', 'c4.png']));
        expect(changes.ids).not.toContain('g9');
    });

    test('inserts that exhaust a gap respace a window and keep the full order', async () => {
        await addCharacter('a.png', 'a');
        await addCharacter('z.png', 'z');
        await metadataDb.fillNameOrderIfNeeded(directories);
        // Every insert lands just after the previous one, halving the same gap until it runs out.
        let name = 'b';
        for (let i = 0; i < 40; i++) {
            name += 'b';
            await addCharacter(`n${String(i).padStart(2, '0')}.png`, name);
            await placeAll();
        }
        checkOrders();
    });

    test('a page of the fill that saw a row renamed behind it leaves that row for placement', async () => {
        for (let i = 0; i < 3; i++) await addCharacter(`c${i}.png`, `Name ${i}`);
        await metadataDb.fillNameOrderIfNeeded(directories);
        withDb(db => db.prepare('UPDATE characters SET name_fold = ? WHERE id = ?').run('zzz', 'c0.png'));
        const db = new Database(dbPath(), { readonly: true });
        try {
            expect(db.prepare('SELECT pos_asc FROM name_order WHERE entity_id = ?').get('c0.png').pos_asc).toBeNull();
        } finally {
            db.close();
        }
        await placeAll();
        checkOrders();
    });
});
