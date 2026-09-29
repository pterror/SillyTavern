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
/** @type {any} */
let warn;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    metadataDb = await import('../src/character-metadata-db.js');
    tree = await import('../src/message-tree-db.js');
    ownerChatStats = await import('../src/owner-chat-stats.js');
});

beforeEach(() => {
    ownerChatStats.installOwnerChatStatsHook();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-chat-stats-queue-test-'));
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
    // Messages stored before their row exists are warned about by the owner write hook.
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
    await metadataDb.chatStatsReconcileIdle(directories);
    jest.restoreAllMocks();
    metadataDb.disposeMetadataStores();
    tree.disposeMessageTreeStores();
    fs.rmSync(directories.root, { recursive: true, force: true });
});

/** @param {string} avatar */
async function seedCharacter(avatar) {
    const name = avatar.replace(/\.png$/, '');
    const card = {
        name,
        fav: false,
        data: { name, tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } },
    };
    await metadataDb.upsertCharacterFromWrite(directories, avatar, JSON.stringify(card));
}

/** @param {string} id */
async function seedGroup(id) {
    const group = { id, name: id, members: [], chats: [], fav: false };
    await metadataDb.writeGroupFileAndRow(directories, group, () => fs.writeFileSync(path.join(directories.groups, `${id}.json`), JSON.stringify(group)));
}

/** @param {string} mes */
const msg = (mes) => ({ name: 'Alice', is_user: false, is_system: false, send_date: 1, mes, extra: {} });

/**
 * Stores messages under `ownerId`, recording its kind only when `owner` is given.
 * @param {string} ownerId
 * @param {import('../src/message-tree-db.js').OwnerDescriptor | undefined} owner
 * @param {string[]} texts
 */
async function seedMessages(ownerId, owner, texts) {
    await tree.getOrCreateAnchor(directories, ownerId, owner);
    await tree.addOpeningAlternatives(directories, ownerId, texts.map(msg));
}

/** @param {string} ownerId */
async function recompute(ownerId) {
    const db = await tree.getDbHandle(directories);
    const rows = Array.from(db.iterate('SELECT content, created_at FROM messages WHERE owner_id = @ownerId AND parent_id IS NOT NULL', { ownerId }));
    return {
        chatSize: rows.reduce((sum, r) => sum + Buffer.byteLength(r.content, 'utf8') + 1, 0),
        dateLastChat: rows.reduce((max, r) => Math.max(max, r.created_at), 0),
    };
}

/** @param {string} avatar */
async function storedCharacter(avatar) {
    const row = await metadataDb.getCharacterMetadataRow(directories, avatar);
    const shallow = JSON.parse(row.shallow_json);
    expect({ chatSize: shallow.chat_size, dateLastChat: shallow.date_last_chat }).toEqual({ chatSize: row.chat_size, dateLastChat: row.date_last_chat });
    return { chatSize: row.chat_size, dateLastChat: row.date_last_chat };
}

/**
 * @param {string} sql
 * @param {unknown[]} params
 */
async function readMetadata(sql, ...params) {
    const { default: Database } = await import('better-sqlite3');
    const raw = new Database(path.join(directories.root, 'character-metadata.sqlite'), { readonly: true });
    try {
        return Array.from(raw.prepare(sql).iterate(...params));
    } finally {
        raw.close();
    }
}

/** @param {string} id */
async function storedGroup(id) {
    const [row] = await readMetadata('SELECT chat_size, date_last_chat FROM groups WHERE id = ?', id);
    return { chatSize: row.chat_size, dateLastChat: row.date_last_chat };
}

async function queued() {
    return readMetadata('SELECT kind, id FROM chat_stats_pending ORDER BY kind, id');
}

async function drained() {
    // A queue kick runs on the next turn of the event loop.
    await new Promise(resolve => setImmediate(resolve));
    await metadataDb.chatStatsReconcileIdle(directories);
}

describe('a new row starts at 0/0 and its owner\'s messages are counted in the background', () => {
    test('before the start, a new row is only queued; the start counts it', async () => {
        await seedMessages('Alice', { kind: 'character', rowId: 'Alice.png' }, ['hello', 'there']);
        await seedCharacter('Alice.png');
        await drained();

        expect(await storedCharacter('Alice.png')).toEqual({ chatSize: 0, dateLastChat: 0 });
        expect(await queued()).toEqual([{ kind: 'character', id: 'Alice.png' }]);

        metadataDb.startChatStatsReconcile([directories]);
        await drained();

        expect(await storedCharacter('Alice.png')).toEqual(await recompute('Alice'));
        expect(await queued()).toEqual([]);
    });

    test('a character re-created over messages it already has gets their stats, with a change row', async () => {
        await seedMessages('Alice', { kind: 'character', rowId: 'Alice.png' }, ['hello', 'a second opening é']);
        await seedCharacter('Alice.png');
        const before = await metadataDb.getCurrentSeq(directories);

        metadataDb.startChatStatsReconcile([directories]);
        await drained();

        const expected = await recompute('Alice');
        expect(expected.chatSize).toBeGreaterThan(0);
        expect(await storedCharacter('Alice.png')).toEqual(expected);
        const { changes } = await metadataDb.getChangesSince(directories, before, { limit: 100 });
        expect(changes.some(c => c.id === 'Alice.png' && c.fields?.includes('chat_size') && c.fields?.includes('date_last_chat'))).toBe(true);
        expect(await queued()).toEqual([]);
    });

    test('a card write to an existing row queues nothing', async () => {
        metadataDb.startChatStatsReconcile([directories]);
        await seedCharacter('Alice.png');
        await drained();

        await seedCharacter('Alice.png');

        expect(await queued()).toEqual([]);
    });

    test('an owner with messages but no recorded kind is recorded by the rows, so later writes keep the row current', async () => {
        metadataDb.startChatStatsReconcile([directories]);
        await seedMessages('Bob', undefined, ['hi']);
        await seedCharacter('Bob.png');
        await drained();

        expect(await storedCharacter('Bob.png')).toEqual(await recompute('Bob'));
        const treeDb = await tree.getDbHandle(directories);
        expect(treeDb.get('SELECT kind, row_id FROM owners WHERE owner_id = ?', 'Bob')).toEqual({ kind: 'character', row_id: 'Bob.png' });

        await tree.addOpeningAlternatives(directories, 'Bob', msg('another opening'));
        expect(await storedCharacter('Bob.png')).toEqual(await recompute('Bob'));
    });

    test('an owner recorded as another entity leaves the row at 0/0', async () => {
        metadataDb.startChatStatsReconcile([directories]);
        await seedMessages('X', { kind: 'group', rowId: 'X' }, ['group message']);
        await seedCharacter('X.png');
        await drained();

        expect(await storedCharacter('X.png')).toEqual({ chatSize: 0, dateLastChat: 0 });
        expect(await queued()).toEqual([]);
    });

    test('a row whose owner has a write with its stats change in flight stays queued until it lands, and is counted once', async () => {
        metadataDb.startChatStatsReconcile([directories]);
        /** @type {() => void} */
        let release = () => {};
        const gate = new Promise(resolve => { release = () => resolve(undefined); });
        tree.setOwnerWriteHandler(async (write) => {
            await gate;
            if (write.kind === 'character') await metadataDb.applyCharacterChatStats(directories, write.rowId, write);
        });

        await tree.getOrCreateAnchor(directories, 'Alice', { kind: 'character', rowId: 'Alice.png' });
        const write = tree.addOpeningAlternatives(directories, 'Alice', msg('written before the row existed'));
        // Committed; its change waits at the gate.
        await new Promise(resolve => setImmediate(resolve));
        await seedCharacter('Alice.png');
        await new Promise(resolve => setTimeout(resolve, 50));

        expect(await queued()).toEqual([{ kind: 'character', id: 'Alice.png' }]);
        expect(await storedCharacter('Alice.png')).toEqual({ chatSize: 0, dateLastChat: 0 });

        warn.mockClear();
        release();
        await write;
        await drained();

        expect(await storedCharacter('Alice.png')).toEqual(await recompute('Alice'));
        expect(await queued()).toEqual([]);
        expect(warn).not.toHaveBeenCalled();
    });

    test('a group created over messages it already has gets their stats, with a groups version row', async () => {
        metadataDb.startChatStatsReconcile([directories]);
        await seedMessages('g1', { kind: 'group', rowId: 'g1' }, ['one', 'two']);
        await seedGroup('g1');
        const versionBefore = await metadataDb.getGroupsVersion(directories);
        await drained();

        const expected = await recompute('g1');
        expect(expected.chatSize).toBeGreaterThan(0);
        expect(await storedGroup('g1')).toEqual(expected);
        expect(await metadataDb.getGroupsVersion(directories)).toBeGreaterThan(versionBefore);
        expect(await queued()).toEqual([]);
    });

    test('the groups bootstrap inserts at 0/0 and queues each group', async () => {
        await seedMessages('g2', { kind: 'group', rowId: 'g2' }, ['hello']);
        fs.writeFileSync(path.join(directories.groups, 'g2.json'), JSON.stringify({ id: 'g2', name: 'G2', members: [], chats: [], fav: false }));

        await metadataDb.bootstrapGroupsIfNeeded(directories);

        expect(await storedGroup('g2')).toEqual({ chatSize: 0, dateLastChat: 0 });
        expect(await queued()).toEqual([{ kind: 'group', id: 'g2' }]);

        metadataDb.startChatStatsReconcile([directories]);
        await drained();

        expect(await storedGroup('g2')).toEqual(await recompute('g2'));
    });
});

describe('a one-time pass counts every row\'s chat stats', () => {
    /**
     * @param {string} sql
     * @param {unknown[]} params
     */
    async function writeMetadata(sql, ...params) {
        const { default: Database } = await import('better-sqlite3');
        const raw = new Database(path.join(directories.root, 'character-metadata.sqlite'));
        try {
            raw.prepare(sql).run(...params);
        } finally {
            raw.close();
        }
    }

    async function fullPassProgress() {
        const [row] = await readMetadata('SELECT value FROM meta WHERE key = ?', 'chat_stats_full_pass');
        return row?.value ?? null;
    }

    /**
     * Rows seeded before the start, with nothing queued, so only the pass can count them.
     * @param {string[]} avatars
     * @param {string[]} groupIds
     */
    async function seedUnqueued(avatars, groupIds) {
        for (const avatar of avatars) await seedCharacter(avatar);
        for (const id of groupIds) await seedGroup(id);
        await writeMetadata('DELETE FROM chat_stats_pending');
    }

    test('drifted character and group rows are fixed with a change row or groups version row, each logged, and the pass is marked done', async () => {
        await seedMessages('Alice', { kind: 'character', rowId: 'Alice.png' }, ['hello', 'there é']);
        await seedMessages('g1', { kind: 'group', rowId: 'g1' }, ['one']);
        await seedUnqueued(['Alice.png', 'Empty.png'], ['g1']);
        await writeMetadata('UPDATE characters SET chat_size = 7, date_last_chat = 3 WHERE id = ?', 'Empty.png');
        const seqBefore = await metadataDb.getCurrentSeq(directories);
        const versionBefore = await metadataDb.getGroupsVersion(directories);
        const log = /** @type {any} */ (console.log);
        log.mockClear();

        metadataDb.startChatStatsReconcile([directories]);
        await drained();

        expect(await storedCharacter('Alice.png')).toEqual(await recompute('Alice'));
        expect(await storedCharacter('Empty.png')).toEqual({ chatSize: 0, dateLastChat: 0 });
        expect(await storedGroup('g1')).toEqual(await recompute('g1'));
        const { changes } = await metadataDb.getChangesSince(directories, seqBefore, { limit: 100 });
        expect(changes.map(c => c.id).sort()).toEqual(['Alice.png', 'Empty.png']);
        expect(await metadataDb.getGroupsVersion(directories)).toBeGreaterThan(versionBefore);
        const logged = log.mock.calls.map(args => String(args[0]));
        for (const what of ['character Alice.png', 'character Empty.png', 'group g1']) {
            expect(logged.some(line => line.includes(`Chat stats of ${what} counted`))).toBe(true);
        }
        expect(await fullPassProgress()).toBe('done');
        expect(await queued()).toEqual([]);
    });

    test('once done, later starts leave the rows alone', async () => {
        await seedMessages('Alice', { kind: 'character', rowId: 'Alice.png' }, ['hello']);
        await seedUnqueued(['Alice.png'], []);
        metadataDb.startChatStatsReconcile([directories]);
        await drained();
        expect(await fullPassProgress()).toBe('done');

        metadataDb.disposeMetadataStores();
        await writeMetadata('UPDATE characters SET chat_size = 1 WHERE id = ?', 'Alice.png');
        metadataDb.startChatStatsReconcile([directories]);
        await drained();

        expect(await readMetadata('SELECT chat_size FROM characters WHERE id = ?', 'Alice.png')).toEqual([{ chat_size: 1 }]);
    });

    test('a pass stopped part way resumes after the last row it saved', async () => {
        await seedMessages('A', { kind: 'character', rowId: 'A.png' }, ['a']);
        await seedMessages('C', { kind: 'character', rowId: 'C.png' }, ['c']);
        await seedMessages('g1', { kind: 'group', rowId: 'g1' }, ['g']);
        await seedUnqueued(['A.png', 'B.png', 'C.png'], ['g1']);
        await writeMetadata('INSERT INTO meta (key, value) VALUES (?, ?)', 'chat_stats_full_pass', JSON.stringify({ kind: 'character', id: 'B.png' }));

        metadataDb.startChatStatsReconcile([directories]);
        await drained();

        expect(await storedCharacter('A.png')).toEqual({ chatSize: 0, dateLastChat: 0 });
        expect(await storedCharacter('C.png')).toEqual(await recompute('C'));
        expect(await storedGroup('g1')).toEqual(await recompute('g1'));
        expect(await fullPassProgress()).toBe('done');
    });

    test('a row whose owner has a stats change in flight goes into chat_stats_pending and is counted once it lands', async () => {
        await seedMessages('Alice', { kind: 'character', rowId: 'Alice.png' }, ['already stored']);
        await seedUnqueued(['Alice.png'], []);
        /** @type {() => void} */
        let release = () => {};
        const gate = new Promise(resolve => { release = () => resolve(undefined); });
        tree.setOwnerWriteHandler(async (write) => {
            await gate;
            if (write.kind === 'character') await metadataDb.applyCharacterChatStats(directories, write.rowId, write);
        });
        const write = tree.addOpeningAlternatives(directories, 'Alice', msg('in flight'));
        await new Promise(resolve => setImmediate(resolve));

        metadataDb.startChatStatsReconcile([directories]);
        await new Promise(resolve => setTimeout(resolve, 50));

        expect(await fullPassProgress()).toBe('done');
        expect(await queued()).toEqual([{ kind: 'character', id: 'Alice.png' }]);
        expect(await storedCharacter('Alice.png')).toEqual({ chatSize: 0, dateLastChat: 0 });

        release();
        await write;
        await drained();

        expect(await storedCharacter('Alice.png')).toEqual(await recompute('Alice'));
        expect(await queued()).toEqual([]);
    });
});

describe('a tree migration queues the rows of the owner it migrated', () => {
    /** @type {typeof import('../src/message-tree-migration.js')} */
    let migration;
    beforeAll(async () => {
        migration = await import('../src/message-tree-migration.js');
    });

    async function clearQueue() {
        const { default: Database } = await import('better-sqlite3');
        const raw = new Database(path.join(directories.root, 'character-metadata.sqlite'));
        try {
            raw.prepare('DELETE FROM chat_stats_pending').run();
        } finally {
            raw.close();
        }
    }

    /**
     * @param {string} dir
     * @param {string} fileName
     * @param {string[]} texts
     */
    function writeChatFile(dir, fileName, texts) {
        fs.mkdirSync(dir, { recursive: true });
        const lines = [{ user_name: 'User', character_name: 'Alice', chat_metadata: {} }, ...texts.map(msg)];
        fs.writeFileSync(path.join(dir, fileName), lines.map(line => JSON.stringify(line)).join('\n'));
    }

    test('a character\'s chat files migrated with no known kind queue its row, and the drain counts them', async () => {
        await seedCharacter('Alice.png');
        await clearQueue();
        const chatDir = path.join(directories.chats, 'Alice');
        writeChatFile(chatDir, 'first.jsonl', ['one', 'two']);

        await migration.migrateOwnerOnTouch(directories, { ownerId: 'Alice', chatDir });

        expect(await queued()).toEqual([{ kind: 'character', id: 'Alice.png' }]);
        metadataDb.startChatStatsReconcile([directories]);
        await drained();
        const expected = await recompute('Alice');
        expect(expected.chatSize).toBeGreaterThan(0);
        expect(await storedCharacter('Alice.png')).toEqual(expected);
    });

    test('a group\'s chat files migrated queue its row', async () => {
        await seedGroup('g1');
        await clearQueue();
        writeChatFile(directories.groupChats, 'c1.jsonl', ['hello group']);

        await migration.migrateOwnerOnTouch(directories, { ownerId: 'g1', chatDir: directories.groupChats, isGroup: true, fileNames: ['c1.jsonl'] });

        expect(await queued()).toEqual([{ kind: 'group', id: 'g1' }]);
        metadataDb.startChatStatsReconcile([directories]);
        await drained();
        expect(await storedGroup('g1')).toEqual(await recompute('g1'));
    });

    test('an owner with no row queues nothing, and one with nothing to migrate isn\'t queued', async () => {
        await seedCharacter('Bob.png');
        await clearQueue();
        const chatDir = path.join(directories.chats, 'Nobody');
        writeChatFile(chatDir, 'x.jsonl', ['hi']);

        await migration.migrateOwnerOnTouch(directories, { ownerId: 'Nobody', chatDir });
        await migration.migrateOwnerOnTouch(directories, { ownerId: 'Bob', chatDir: path.join(directories.chats, 'Bob') });

        expect(await queued()).toEqual([]);
    });
});
