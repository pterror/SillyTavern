import { beforeAll, beforeEach, afterEach, describe, test, expect, jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.SILLYTAVERN_PERFORMANCE_SHALLOWCHARACTERSINCLUDECREATORNOTES = 'false';

/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {typeof import('../src/message-tree-db.js')} */
let tree;
/** @type {typeof import('../src/owner-chat-stats.js')} */
let ownerChatStats;
/** @type {any} */
let directories;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    metadataDb = await import('../src/character-metadata-db.js');
    tree = await import('../src/message-tree-db.js');
    ownerChatStats = await import('../src/owner-chat-stats.js');
});

beforeEach(() => {
    ownerChatStats.installOwnerChatStatsHook();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-activity-queue-exactness-test-'));
    directories = {
        root,
        characters: path.join(root, 'characters'),
        chats: path.join(root, 'chats'),
        groups: path.join(root, 'groups'),
        groupChats: path.join(root, 'group chats'),
        backups: path.join(root, 'backups'),
    };
    for (const dir of [directories.characters, directories.chats, directories.groups, directories.groupChats, directories.backups]) {
        fs.mkdirSync(dir, { recursive: true });
    }
    jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
    await metadataDb.chatStatsReconcileIdle(directories);
    jest.restoreAllMocks();
    metadataDb.disposeMetadataStores();
    tree.disposeMessageTreeStores();
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

const CHARACTERS = ['Ann', 'Bea', 'Cal', 'Dee'];
const GROUPS = ['g1', 'g2'];
const TAGS = ['red', 'blue'];

/** @param {string} mes */
const msg = (mes) => ({ name: 'Alice', is_user: false, is_system: false, send_date: 1, mes, extra: {} });

/** @param {string} id */
const rowIdOf = (id) => (GROUPS.includes(id) ? id : `${id}.png`);

/**
 * What eager maintenance would have stored: recounted from the owner's messages.
 * @param {string} ownerId
 */
async function recount(ownerId) {
    const db = await tree.getDbHandle(directories);
    const rows = Array.from(db.iterate('SELECT content, created_at FROM messages WHERE owner_id = @ownerId AND parent_id IS NOT NULL', { ownerId }));
    return {
        chatSize: rows.reduce((sum, r) => sum + Buffer.byteLength(r.content, 'utf8') + 1, 0),
        dateLastChat: rows.reduce((max, r) => Math.max(max, r.created_at), 0),
    };
}

/** @param {string} ownerId */
async function nodesOf(ownerId) {
    const db = await tree.getDbHandle(directories);
    /** @type {{ id: string, parent_id: string | null }[]} */
    const rows = Array.from(db.iterate('SELECT id, parent_id FROM messages WHERE owner_id = @ownerId', { ownerId }));
    const parents = new Set(rows.map(r => r.parent_id));
    const messages = rows.filter(r => r.parent_id !== null);
    return { messages, leaves: messages.filter(r => !parents.has(r.id)) };
}

async function queueLength() {
    const { default: Database } = await import('better-sqlite3');
    const raw = new Database(path.join(directories.root, 'character-metadata.sqlite'), { readonly: true });
    try {
        return Number(raw.prepare('SELECT COUNT(*) AS n FROM activity_pending').get().n);
    } finally {
        raw.close();
    }
}

/** Every read that carries chat stats, against the recount. */
async function expectReadsExact() {
    /** @type {Map<string, { chatSize: number, dateLastChat: number }>} */
    const expected = new Map();
    for (const id of [...CHARACTERS, ...GROUPS]) expected.set(rowIdOf(id), await recount(id));
    const avatars = CHARACTERS.map(rowIdOf);

    for (const avatar of avatars) {
        expect([avatar, await metadataDb.getCharacterChatStats(directories, avatar)]).toEqual([avatar, expected.get(avatar)]);
        const row = await metadataDb.getCharacterMetadataRow(directories, avatar);
        const shallow = JSON.parse(row.shallow_json);
        const want = expected.get(avatar);
        expect([avatar, row.chat_size, row.date_last_chat, shallow.chat_size, shallow.date_last_chat])
            .toEqual([avatar, want?.chatSize, want?.dateLastChat, want?.chatSize, want?.dateLastChat]);
    }
    const shallowById = await metadataDb.getShallowByIds(directories, avatars);
    for (const avatar of avatars) {
        const s = /** @type {any} */ (shallowById[avatar]);
        expect([avatar, s.chat_size, s.date_last_chat]).toEqual([avatar, expected.get(avatar)?.chatSize, expected.get(avatar)?.dateLastChat]);
    }
    const indexRows = await metadataDb.getCharacterIndexRowsByIds(directories, avatars);
    for (const avatar of avatars) {
        const r = indexRows.get(avatar);
        expect([avatar, r?.chat_size, r?.date_last_chat]).toEqual([avatar, expected.get(avatar)?.chatSize, expected.get(avatar)?.dateLastChat]);
    }
    const groupStats = await metadataDb.getGroupChatStatsByIds(directories, GROUPS);
    for (const id of GROUPS) expect([id, groupStats.get(id)]).toEqual([id, expected.get(id)]);

    // Lists: by name (overlaid rows), and by each activity key in both directions (folded first), plus a range on
    // each key. Order is checked by the values: ties may come back in either order.
    const lists = [
        { sortField: 'name', sortOrder: 'asc' },
        { sortField: 'date_last_chat', sortOrder: 'desc' },
        { sortField: 'date_last_chat', sortOrder: 'asc' },
        { sortField: 'chat_size', sortOrder: 'desc' },
        { sortField: 'chat_size', sortOrder: 'asc' },
    ];
    for (const params of lists) {
        const result = await metadataDb.queryEntities(directories, { ...params, offset: 0, limit: 100, wantRows: true, wantTotal: true });
        const rows = result?.rows ?? [];
        expect(rows.map(r => r.id).sort()).toEqual([...expected.keys()].sort());
        for (const r of rows) {
            expect([params.sortField, r.id, r.chat_size, r.date_last_chat]).toEqual([params.sortField, r.id, expected.get(r.id)?.chatSize, expected.get(r.id)?.dateLastChat]);
            if (r.type === 'character') {
                const item = /** @type {any} */ (r.item);
                expect([r.id, item.chat_size, item.date_last_chat]).toEqual([r.id, r.chat_size, r.date_last_chat]);
            }
        }
        if (params.sortField !== 'name') {
            const values = rows.map(r => Number(/** @type {any} */ (r)[params.sortField]));
            const sorted = [...values].sort((a, b) => (params.sortOrder === 'asc' ? a - b : b - a));
            expect([params.sortField, params.sortOrder, values]).toEqual([params.sortField, params.sortOrder, sorted]);
        }
    }
    const sizes = [...expected.values()].map(v => v.chatSize).sort((a, b) => a - b);
    const mid = sizes[Math.floor(sizes.length / 2)];
    for (const field of ['chat_size', 'date_last_chat']) {
        const values = [...expected.values()].map(v => (field === 'chat_size' ? v.chatSize : v.dateLastChat));
        const min = field === 'chat_size' ? mid : [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
        const result = await metadataDb.queryEntities(directories, { ranges: { [field]: { min } }, sortField: 'name', sortOrder: 'asc', offset: 0, limit: 100, wantRows: true, wantTotal: true });
        const want = [...expected.entries()].filter(([, v]) => (field === 'chat_size' ? v.chatSize : v.dateLastChat) >= min).map(([id]) => id).sort();
        expect([field, min, (result?.rows ?? []).map(r => r.id).sort(), result?.total]).toEqual([field, min, want, want.length]);
    }
}

/**
 * Random message writes (openings, appends, alternatives, edits, deletes), fav flips and tag (un)assigns, with
 * reads in between; each read must equal the recount from messages.
 * @param {number} seed
 * @param {number} steps
 * @returns {Promise<number>} The longest the queue got.
 */
async function run(seed, steps) {
    const random = rng(seed);
    const pick = (/** @type {any[]} */ list) => list[Math.floor(random() * list.length)];
    const text = () => 'x'.repeat(1 + Math.floor(random() * 40)) + (random() < 0.2 ? 'é' : '');

    metadataDb.startChatStatsReconcile([directories]);
    for (const tag of TAGS) expect((await metadataDb.createTagDefinition(directories, { id: tag, name: tag })).refused).toEqual([]);
    for (const name of CHARACTERS) {
        const card = { name, fav: false, data: { name, tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } };
        await metadataDb.upsertCharacterFromWrite(directories, rowIdOf(name), JSON.stringify(card));
        await tree.getOrCreateAnchor(directories, name, { kind: 'character', rowId: rowIdOf(name) });
    }
    for (const id of GROUPS) {
        const group = { id, name: id, members: [], chats: [], fav: false };
        await metadataDb.writeGroupFileAndRow(directories, group, () => fs.writeFileSync(path.join(directories.groups, `${id}.json`), JSON.stringify(group)));
        await tree.getOrCreateAnchor(directories, id, { kind: 'group', rowId: id });
    }
    await new Promise(resolve => setImmediate(resolve));
    await metadataDb.chatStatsReconcileIdle(directories);

    let maxQueue = 0;
    for (let step = 0; step < steps; step++) {
        const owner = pick([...CHARACTERS, ...GROUPS]);
        const { messages, leaves } = await nodesOf(owner);
        const op = random();
        // A distinct created_at per write, so a delete of the newest message moves date_last_chat back.
        await new Promise(resolve => setTimeout(resolve, 2));
        if (op < 0.15 || messages.length === 0) {
            await tree.addOpeningAlternatives(directories, owner, [msg(text())]);
        } else if (op < 0.4) {
            const after = pick(messages).id;
            expect((await tree.appendMessages(directories, owner, after, [msg(text())])).ok).toBe(true);
        } else if (op < 0.5) {
            await tree.addAlternatives(directories, owner, pick(messages).id, [msg(text())]);
        } else if (op < 0.65) {
            await tree.editMessage(directories, owner, pick(messages).id, msg(text()));
        } else if (op < 0.75) {
            if (leaves.length > 0) await tree.deleteAlternative(directories, owner, pick(leaves).id);
        } else if (op < 0.82) {
            if (GROUPS.includes(owner)) await metadataDb.upsertGroupRow(directories, owner, owner, { fav: random() < 0.5 });
            else await metadataDb.toggleCharacterFav(directories, rowIdOf(owner));
        } else if (op < 0.9) {
            const tag = pick(TAGS);
            if (random() < 0.5) await metadataDb.assignEntityTag(directories, rowIdOf(owner), tag);
            else await metadataDb.unassignEntityTag(directories, rowIdOf(owner), tag);
        } else if (op < 0.93) {
            await metadataDb.foldAllActivity(directories);
            expect(await queueLength()).toBe(0);
        }
        maxQueue = Math.max(maxQueue, await queueLength());
        if (random() < 0.15) await expectReadsExact();
    }
    await expectReadsExact();
    await metadataDb.foldAllActivity(directories);
    expect(await queueLength()).toBe(0);
    await expectReadsExact();
    return maxQueue;
}

describe('queued chat stats read exactly what eager maintenance would have stored', () => {
    for (const seed of [1, 2, 3]) {
        test(`random writes and reads, seed ${seed}`, async () => {
            // Reads saw queued activity, not only folded rows.
            expect(await run(seed, 200)).toBeGreaterThan(0);
        }, 120000);
    }
});
