import { beforeAll, beforeEach, afterEach, describe, test, expect, jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {any} */
let directories;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    metadataDb = await import('../src/character-metadata-db.js');
});

beforeEach(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-changes-log-compaction-test-'));
    directories = {
        root,
        characters: path.join(root, 'characters'),
        chats: path.join(root, 'chats'),
        groups: path.join(root, 'groups'),
        groupChats: path.join(root, 'group chats'),
    };
    for (const dir of [directories.characters, directories.chats, directories.groups, directories.groupChats]) {
        fs.mkdirSync(dir, { recursive: true });
    }
    jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
    await metadataDb.chatStatsReconcileIdle(directories);
    jest.restoreAllMocks();
    metadataDb.disposeMetadataStores();
    fs.rmSync(directories.root, { recursive: true, force: true });
});

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

/** @param {string} name @param {string} [description] */
function card(name, description = '') {
    return JSON.stringify({ name, spec: 'chara_card_v2', spec_version: '2.0', data: { name, description, tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });
}

async function rawRows() {
    const { default: Database } = await import('better-sqlite3');
    const raw = new Database(path.join(directories.root, 'character-metadata.sqlite'), { readonly: true });
    try {
        return /** @type {{ seq: number, id: string, op: string, fields: string | null }[]} */ (raw.prepare('SELECT seq, id, op, fields FROM changes ORDER BY seq').all());
    } finally {
        raw.close();
    }
}

/**
 * Every change past `since`, read page by page as a reader does, collapsed per id across pages.
 * @param {number} since
 * @returns {Promise<{ truncated: boolean, byId: Map<string, { op: string, whole: boolean, fields: Set<string> }> }>}
 */
async function readAll(since) {
    /** @type {Map<string, { op: string, whole: boolean, fields: Set<string> }>} */
    const byId = new Map();
    let seq = since;
    for (;;) {
        const page = await metadataDb.getChangesSince(directories, seq, { limit: 3 });
        if (!page) throw new Error('store unavailable');
        if (page.truncated) return { truncated: true, byId };
        for (const change of page.changes) {
            const seen = byId.get(change.id) ?? { op: change.op, whole: false, fields: new Set() };
            seen.op = change.op;
            if (change.op === 'delete' || change.fields === null || change.fields === undefined) seen.whole = true;
            else for (const field of change.fields) seen.fields.add(field);
            byId.set(change.id, seen);
        }
        seq = page.seq;
        if (!page.hasMore) return { truncated: false, byId };
    }
}

describe('the change log keeps at most two rows per id and loses nothing a reader needs', () => {
    for (const seed of [1, 2, 3]) {
        test(`seed ${seed}: from every cursor, a reader learns every id changed since, as whole or with every field changed`, async () => {
            const random = rng(seed);
            const pick = (/** @type {any[]} */ list) => list[Math.floor(random() * list.length)];
            const ids = ['a.png', 'b.png', 'c.png', 'd.png'];
            expect((await metadataDb.createTagDefinition(directories, { id: 't1', name: 't1' })).refused).toEqual([]);
            /** @type {{ seq: number, id: string, whole: boolean, field: string | null, deleted: boolean }[]} */
            const history = [];
            /** @type {number[]} */
            const cursors = [0];
            for (let step = 0; step < 150; step++) {
                const id = pick(ids);
                const exists = await metadataDb.characterRowExists(directories, id);
                const before = await metadataDb.getCurrentSeq(directories);
                const op = random();
                let change = null;
                if (!exists || op < 0.15) {
                    await metadataDb.upsertCharacterFromWrite(directories, id, card(id, `v${step}`));
                    change = { whole: !exists, field: exists ? 'card' : null, deleted: false };
                } else if (op < 0.45) {
                    await metadataDb.toggleCharacterFav(directories, id);
                    change = { whole: false, field: 'fav', deleted: false };
                } else if (op < 0.75) {
                    if (random() < 0.5) await metadataDb.assignEntityTag(directories, id, 't1');
                    else await metadataDb.unassignEntityTag(directories, id, 't1');
                    change = { whole: false, field: 'tag_ids', deleted: false };
                } else if (op < 0.85) {
                    await metadataDb.deleteCharacterRow(directories, id);
                    change = { whole: true, field: null, deleted: true };
                }
                const after = await metadataDb.getCurrentSeq(directories);
                if (change && after !== before) history.push({ seq: Number(after), id, ...change });
                if (random() < 0.2) cursors.push(Number(after));

                const rows = await rawRows();
                const perId = new Map();
                for (const row of rows) perId.set(row.id, (perId.get(row.id) ?? 0) + 1);
                expect([step, [...perId.values()].filter(n => n > 2)]).toEqual([step, []]);
            }

            /** @type {unknown[]} */
            const misses = [];
            for (const cursor of cursors) {
                const { truncated, byId } = await readAll(cursor);
                if (truncated) misses.push([cursor, 'truncated']);
                const since = history.filter(h => h.seq > cursor);
                for (const id of new Set(since.map(h => h.id))) {
                    const seen = byId.get(id);
                    const mine = since.filter(h => h.id === id);
                    if (!seen) {
                        misses.push([cursor, id, 'missing']);
                        continue;
                    }
                    if (seen.op !== (mine[mine.length - 1].deleted ? 'delete' : 'upsert')) misses.push([cursor, id, 'op', seen.op]);
                    if (mine.some(h => h.whole) && !seen.whole) misses.push([cursor, id, 'not whole']);
                    if (seen.whole) continue;
                    // fav and tag_ids are named as such; a card write lists the fields of the card it changed.
                    for (const h of mine) if (h.field !== 'card' && !seen.fields.has(/** @type {string} */ (h.field))) misses.push([cursor, id, 'field', h.field]);
                }
            }
            expect(misses).toEqual([]);
        }, 120000);
    }
});

describe('the sparse old end is dropped, held at the search index position', () => {
    test('rows replaced away leave gaps; the stretch below the index position goes, readers behind it are told', async () => {
        metadataDb.startChatStatsReconcile([directories]);
        const id = (/** @type {number} */ i) => `c${String(i).padStart(2, '0')}.png`;
        // Seqs 1-40 create; 41-80 rewrite every card, replacing each id's row; 81-100 rewrite the first 20 again. Left:
        // 61-80 (ids 20-39) and 81-100 (ids 0-19), below them 60 seqs of gaps.
        for (let i = 0; i < 40; i++) await metadataDb.upsertCharacterFromWrite(directories, id(i), card(`c${i}`, 'v0'));
        for (let i = 0; i < 40; i++) await metadataDb.upsertCharacterFromWrite(directories, id(i), card(`c${i}`, 'v1'));
        for (let i = 0; i < 20; i++) await metadataDb.upsertCharacterFromWrite(directories, id(i), card(`c${i}`, 'v2'));
        expect((await rawRows()).map(r => r.seq)).toEqual([...Array(40).keys()].map(n => n + 61));
        // No index position recorded: nothing is dropped.
        await new Promise(resolve => setTimeout(resolve, 100));
        expect((await rawRows()).length).toBe(40);

        const hold = 80;
        await metadataDb.setMetaValue(directories, metadataDb.CHARACTERS_INDEX_SEQ_META_KEY, String(hold));
        await metadataDb.setCharacterFav(directories, id(0), true);
        await new Promise(resolve => setTimeout(resolve, 300));

        const rows = await rawRows();
        const floor = Number(await metadataDb.getMetaValue(directories, 'changes_floor'));
        expect(floor).toBe(hold);
        expect(rows.every(r => r.seq > floor)).toBe(true);
        // Every row past the index position is still there, and the newest row too.
        expect(rows.at(-1)?.seq).toBe(Number(await metadataDb.getCurrentSeq(directories)));
        expect(rows.map(r => r.seq)).toEqual([...Array(20).keys()].map(n => n + 81).concat([101]));

        // A reader behind the dropped stretch is told to start over; one at the floor reads on.
        expect((await metadataDb.getChangesSince(directories, floor - 1, { limit: 10 }))?.truncated).toBe(true);
        expect((await metadataDb.getChangesSince(directories, floor, { limit: 10 }))?.truncated).toBe(false);
        expect((await metadataDb.getEntityTagChangesSince(directories, { sinceSeq: floor - 1, sinceGroupsVersion: 0 }, { limit: 10 }))?.reset).toBe(true);
    }, 60000);
});
