import { beforeAll, afterAll, beforeEach, afterEach, describe, test, expect, jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.SILLYTAVERN_BACKUPS_CHAT_ENABLED = 'false';
process.env.SILLYTAVERN_BACKUPS_CHAT_MAXTOTALBACKUPS = '-1';
process.env.SILLYTAVERN_BACKUPS_CHAT_THROTTLEINTERVAL = '0';
process.env.SILLYTAVERN_PERFORMANCE_SHALLOWCHARACTERSINCLUDECREATORNOTES = 'false';

/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {typeof import('../src/message-tree-db.js')} */
let tree;
/** @type {typeof import('../src/assistant-reply-persist.js')} */
let replyPersist;
/** @type {import('node:http').Server} */
let server;
let baseUrl;
/** @type {any} */
let directories;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    const chats = await import('../src/endpoints/chats.js');
    metadataDb = await import('../src/character-metadata-db.js');
    tree = await import('../src/message-tree-db.js');
    replyPersist = await import('../src/assistant-reply-persist.js');
    (await import('../src/owner-chat-stats.js')).installOwnerChatStatsHook();

    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.user = { directories, profile: { handle: 'test-user' } };
        next();
    });
    app.use('/api/chats', chats.router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise(resolve => server.close(resolve)));

beforeEach(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-owner-chat-stats-test-'));
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
});

afterEach(() => {
    jest.restoreAllMocks();
    metadataDb.disposeMetadataStores();
    tree.disposeMessageTreeStores();
    fs.rmSync(directories.root, { recursive: true, force: true });
});

async function postJson(urlPath, body) {
    const res = await fetch(`${baseUrl}${urlPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
}

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

/**
 * The owner's chat stats as the plan defines them, recomputed from the messages table.
 * @param {string} ownerId
 */
async function recompute(ownerId) {
    const db = await tree.getDbHandle(directories);
    const rows = Array.from(db.iterate('SELECT content, created_at FROM messages WHERE owner_id = @ownerId AND parent_id IS NOT NULL', { ownerId }));
    return {
        chatSize: rows.reduce((sum, r) => sum + Buffer.byteLength(r.content, 'utf8') + 1, 0),
        dateLastChat: rows.reduce((max, r) => Math.max(max, r.created_at), 0),
    };
}

/** @param {string} avatar */
async function stored(avatar) {
    const row = await metadataDb.getCharacterMetadataRow(directories, avatar);
    const listRow = /** @type {any} */ ((await metadataDb.getShallowByIds(directories, [avatar]))[avatar]);
    return { chatSize: row.chat_size, dateLastChat: row.date_last_chat, shallowChatSize: listRow.chat_size, shallowDateLastChat: listRow.date_last_chat };
}

/**
 * Change rows written by `write`.
 * @param {() => Promise<unknown>} write
 */
async function changesDuring(write) {
    const before = await metadataDb.getCurrentSeq(directories);
    await write();
    return (await metadataDb.getChangesSince(directories, before, { limit: 100 })).changes;
}

/** @param {string} mes */
const msg = (mes) => ({ name: 'Alice', is_user: false, is_system: false, send_date: 1, mes, extra: {} });

async function saveAliceChat() {
    const res = await postJson('/api/chats/save', {
        avatar_url: 'Alice.png',
        file_name: 'Alice - chat',
        chat: [{ chat_metadata: {} }, { name: 'User', is_user: true, mes: 'hi é', send_date: 1, extra: {} }, msg('hello there')],
    });
    expect(res.status).toBe(200);
    return res.body.assigned_node_ids.map(a => a.node_id);
}

async function expectStoredMatchesMessages() {
    const expected = await recompute('Alice');
    const actual = await stored('Alice.png');
    expect(actual).toEqual({
        chatSize: expected.chatSize, dateLastChat: expected.dateLastChat,
        shallowChatSize: expected.chatSize, shallowDateLastChat: expected.dateLastChat,
    });
}

describe('messageLineBytes', () => {
    test('is the UTF-8 byte length of the stored content plus the newline', () => {
        expect(tree.messageLineBytes('{"mes":"é"}')).toBe(13);
    });
});

describe('a character\'s chat stats follow every write to its messages', () => {
    test('/save sets chat_size and date_last_chat from the messages: read at once, written to the row with a change row when the queue is', async () => {
        await seedCharacter('Alice.png');
        let ids;
        const changes = await changesDuring(async () => { ids = await saveAliceChat(); });

        expect(ids).toHaveLength(2);
        expect((await stored('Alice.png')).chatSize).toBeGreaterThan(0);
        await expectStoredMatchesMessages();
        expect(changes.find(c => c.id === 'Alice.png' && (c.fields ?? []).includes('chat_size'))).toBeUndefined();

        const folded = await changesDuring(() => metadataDb.foldAllActivity(directories));
        await expectStoredMatchesMessages();
        const change = folded.find(c => c.id === 'Alice.png');
        expect(change?.fields).toEqual(expect.arrayContaining(['chat_size', 'date_last_chat']));
    });

    test('edit, append, alternative, and alternative delete each keep the stats equal to the messages', async () => {
        await seedCharacter('Alice.png');
        const [, replyId] = await saveAliceChat();

        expect((await postJson('/api/chats/message/edit', { avatar_url: 'Alice.png', node_id: replyId, content: msg('hello there, a longer reply') })).status).toBe(200);
        await expectStoredMatchesMessages();

        const appended = await postJson('/api/chats/message/append', { avatar_url: 'Alice.png', after_node_id: replyId, messages: [{ name: 'User', is_user: true, mes: 'and?', send_date: 2, extra: {} }] });
        expect(appended.status).toBe(200);
        await expectStoredMatchesMessages();

        const dateBeforeAlternative = (await stored('Alice.png')).dateLastChat;
        const alt = await postJson('/api/chats/message/alternative', { avatar_url: 'Alice.png', sibling_node_id: appended.body.node_ids[0], content: { name: 'User', is_user: true, mes: 'something else entirely', send_date: 3, extra: {} } });
        expect(alt.status).toBe(200);
        await expectStoredMatchesMessages();
        expect((await stored('Alice.png')).dateLastChat).toBeGreaterThanOrEqual(dateBeforeAlternative);

        // The alternative is the newest message, so deleting it moves date_last_chat back.
        const deleted = await postJson('/api/chats/message/alternative/delete', { avatar_url: 'Alice.png', node_id: alt.body.node_ids[0] });
        expect(deleted.status).toBe(200);
        await expectStoredMatchesMessages();
    });

    test('a server-side reply (not a chats route) is counted too', async () => {
        await seedCharacter('Alice.png');
        const [, replyId] = await saveAliceChat();

        const sizeBefore = (await stored('Alice.png')).chatSize;
        const persisted = await replyPersist.persistAssistantReply({ directories, ownerId: 'Alice', anchorNodeId: replyId, name2: 'Alice', isSwipe: false, isContinue: false, anchorContent: null }, 'a generated reply');

        expect(persisted?.node_id).toBeTruthy();
        expect((await stored('Alice.png')).chatSize).toBeGreaterThan(sizeBefore);
        await expectStoredMatchesMessages();
    });

    test('deleting a chat keeps its messages, so it changes no stats and writes no change row', async () => {
        await seedCharacter('Alice.png');
        await saveAliceChat();
        const before = await stored('Alice.png');

        const changes = await changesDuring(async () => {
            expect((await postJson('/api/chats/delete', { avatar_url: 'Alice.png', chatfile: 'Alice - chat' })).status).toBe(200);
        });

        expect(changes.filter(c => c.id === 'Alice.png')).toEqual([]);
        expect(await stored('Alice.png')).toEqual(before);
    });

    test('a card write keeps the row\'s chat stats', async () => {
        await seedCharacter('Alice.png');
        await saveAliceChat();
        const before = await stored('Alice.png');

        await seedCharacter('Alice.png');

        expect(await stored('Alice.png')).toEqual(before);
    });

    test('an owner whose kind was never recorded changes no row', async () => {
        await seedCharacter('Bob.png');
        await tree.getOrCreateAnchor(directories, 'Bob');
        const before = await stored('Bob.png');

        const changes = await changesDuring(() => tree.addOpeningAlternatives(directories, 'Bob', { name: 'Bob', is_user: false, mes: 'Hi', send_date: 1, extra: {} }));

        expect(changes).toEqual([]);
        expect(await stored('Bob.png')).toEqual(before);
    });

    test('a stated kind that doesn\'t fit the owner id is not recorded', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        await tree.getOrCreateAnchor(directories, 'Alice', { kind: 'character', rowId: 'Someone Else.png' });

        const db = await tree.getDbHandle(directories);
        expect(db.get('SELECT * FROM owners WHERE owner_id = @id', { id: 'Alice' })).toBeUndefined();
        expect(warn).toHaveBeenCalled();
    });
});

describe('character owner ids', () => {
    test('an avatar with .png inside its name maps back to its owner id', () => {
        expect(tree.characterAvatarsForOwnerId('a b')).toEqual(expect.arrayContaining(['a b.png', 'a b', '.pnga b']));
        for (const avatar of tree.characterAvatarsForOwnerId('x.png y')) {
            expect(tree.characterOwnerIdOf(avatar)).toBe('x.png y');
        }
        expect(tree.characterAvatarsForOwnerId('x.png y')).toContain('.pngx.png y');
        expect(tree.characterAvatarsForOwnerId('x.png y')).not.toContain('x.png y');
    });
});

describe('date_last_chat on a write that only adds rows', () => {
    /** @param {string} sql @param {object} params */
    async function writeMetadataRaw(sql, params) {
        const { default: Database } = await import('better-sqlite3');
        const raw = new Database(path.join(directories.root, 'character-metadata.sqlite'));
        const { defineCharacterStoreFunctions } = await import('../src/character-store-schema.js');
        defineCharacterStoreFunctions({ defineFunction: (name, fn) => raw.function(name, { deterministic: true }, fn) });
        try {
            raw.prepare(sql).run(params);
        } finally {
            raw.close();
        }
    }

    /** Alice's saved chat, with a stored date_last_chat later than any of her messages. */
    async function aliceWithFarDateLastChat() {
        await seedCharacter('Alice.png');
        const [, replyId] = await saveAliceChat();
        const far = Date.now() + 10 ** 9;
        await writeMetadataRaw('UPDATE characters SET date_last_chat = @far WHERE id = @id', { far, id: 'Alice.png' });
        return { replyId, far };
    }

    test('keeps a larger stored date_last_chat', async () => {
        const { replyId, far } = await aliceWithFarDateLastChat();

        expect((await postJson('/api/chats/message/append', { avatar_url: 'Alice.png', after_node_id: replyId, messages: [msg('and?')] })).status).toBe(200);

        expect((await stored('Alice.png')).dateLastChat).toBe(far);
    });

    test('keeps a larger stored date_last_chat even with an (owner, created_at) index on the tree', async () => {
        const { replyId, far } = await aliceWithFarDateLastChat();
        const db = await tree.getDbHandle(directories);
        db.exec('CREATE INDEX IF NOT EXISTS idx_messages_owner_created_at ON messages(owner_id, created_at)');

        expect((await postJson('/api/chats/message/append', { avatar_url: 'Alice.png', after_node_id: replyId, messages: [msg('and?')] })).status).toBe(200);

        expect((await stored('Alice.png')).dateLastChat).toBe(far);
    });

    test('no migration pass builds an (owner, created_at) index on the tree', async () => {
        const { MIGRATION_PASSES } = await import('../src/metadata-migration-coordinator.js');
        expect(MIGRATION_PASSES).not.toContain('buildTreeOwnerCreatedAtIndex');
    });

    test('a migration pass drops a leftover (owner, created_at) index, and does nothing once it\'s gone', async () => {
        const db = await tree.getDbHandle(directories);
        db.exec('CREATE INDEX IF NOT EXISTS idx_messages_owner_created_at ON messages(owner_id, created_at)');
        const hasIndex = () => !!db.get('SELECT 1 AS ok FROM sqlite_master WHERE type = \'index\' AND name = \'idx_messages_owner_created_at\'');
        expect(hasIndex()).toBe(true);

        const { MIGRATION_PASSES } = await import('../src/metadata-migration-coordinator.js');
        expect(MIGRATION_PASSES).toContain('dropTreeOwnerCreatedAtIndex');
        expect(await metadataDb.dropTreeOwnerCreatedAtIndex(directories)).toEqual({ batches: 1, rowsChanged: 0 });
        expect(hasIndex()).toBe(false);
        expect(await metadataDb.dropTreeOwnerCreatedAtIndex(directories)).toEqual({ batches: 0, rowsChanged: 0 });
    });
});

describe('a group\'s chat stats follow every write to its messages', () => {
    const GROUP_ID = 'g1';

    async function seedGroup() {
        const group = { id: GROUP_ID, name: 'G1', members: ['Alice.png'], chats: [], fav: false };
        await metadataDb.writeGroupFileAndRow(directories, group, () => fs.writeFileSync(path.join(directories.groups, `${GROUP_ID}.json`), JSON.stringify(group)));
    }

    /** The group's chat stats as readers get them: the row with its queued message writes on top. */
    async function storedGroup() {
        return (await metadataDb.getGroupChatStatsByIds(directories, [GROUP_ID])).get(GROUP_ID);
    }

    async function expectGroupMatchesMessages() {
        expect(await storedGroup()).toEqual(await recompute(GROUP_ID));
    }

    /**
     * Groups version log rows for the group added by `write`.
     * @param {() => Promise<unknown>} write
     */
    async function groupRowsDuring(write) {
        const before = await metadataDb.getGroupsVersion(directories);
        await write();
        const after = await metadataDb.getGroupsVersion(directories);
        return after - before;
    }

    /** @param {string} chatId @param {string[]} texts */
    async function saveGroupChat(chatId, texts) {
        const res = await postJson('/api/chats/group/save', {
            id: chatId,
            group_id: GROUP_ID,
            chat: [{ chat_metadata: {} }, ...texts.map(msg)],
        });
        expect(res.status).toBe(200);
        return res.body.assigned_node_ids.map(a => a.node_id);
    }

    test('/group/save adds each chat\'s messages to chat_size instead of replacing it with the last chat saved, and bumps the groups version when written out', async () => {
        await seedGroup();

        await saveGroupChat('chat one', ['first chat, a fairly long message', 'another']);
        await saveGroupChat('chat two', ['second']);

        const stats = await storedGroup();
        expect(stats.chatSize).toBeGreaterThan(0);
        await expectGroupMatchesMessages();
        expect(await groupRowsDuring(() => metadataDb.foldAllActivity(directories))).toBe(1);
        await expectGroupMatchesMessages();
    });

    test('edit, append, graft, alternative, and alternative delete each keep the stats equal to the messages, queued (no groups version row) except the delete, which is written at once', async () => {
        await seedGroup();
        const [firstId, replyId] = await saveGroupChat('chat one', ['hello', 'hello there']);

        expect(await groupRowsDuring(async () => {
            expect((await postJson('/api/chats/message/edit', { group_id: GROUP_ID, node_id: replyId, content: msg('hello there, a longer reply') })).status).toBe(200);
        })).toBe(0);
        await expectGroupMatchesMessages();

        let appended;
        expect(await groupRowsDuring(async () => {
            appended = await postJson('/api/chats/message/append', { group_id: GROUP_ID, after_node_id: replyId, messages: [msg('and?')] });
            expect(appended.status).toBe(200);
        })).toBe(0);
        await expectGroupMatchesMessages();

        expect(await groupRowsDuring(async () => {
            expect((await postJson('/api/chats/message/graft', { group_id: GROUP_ID, after_node_id: firstId, before_node_id: replyId, content: msg('spliced in') })).status).toBe(200);
        })).toBe(0);
        await expectGroupMatchesMessages();

        let alt;
        expect(await groupRowsDuring(async () => {
            alt = await postJson('/api/chats/message/alternative', { group_id: GROUP_ID, sibling_node_id: appended.body.node_ids[0], content: msg('something else entirely') });
            expect(alt.status).toBe(200);
        })).toBe(0);
        await expectGroupMatchesMessages();

        expect(await groupRowsDuring(async () => {
            expect((await postJson('/api/chats/message/alternative/delete', { group_id: GROUP_ID, node_id: alt.body.node_ids[0] })).status).toBe(200);
        })).toBe(1);
        await expectGroupMatchesMessages();
    });

    test('deleting a group chat keeps its messages, so its stats stay', async () => {
        await seedGroup();
        await saveGroupChat('chat one', ['hello', 'hello there']);
        const before = await storedGroup();

        expect((await postJson('/api/chats/group/delete', { id: 'chat one', group_id: GROUP_ID })).status).toBe(200);

        expect(await storedGroup()).toEqual(before);
    });

    test('a group write that changes no stats adds no groups version row', async () => {
        await seedGroup();
        await saveGroupChat('chat one', ['hello']);

        expect(await groupRowsDuring(() => metadataDb.applyGroupChatStats(directories, GROUP_ID, { sizeChange: 0, addedCreatedAt: 1, readLastCreatedAt: null }))).toBe(0);
    });

    test('a group with no row is logged and nothing is written', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        await metadataDb.getGroupsVersion(directories);

        expect(await groupRowsDuring(() => metadataDb.applyGroupChatStats(directories, 'missing', { sizeChange: 10, addedCreatedAt: 5, readLastCreatedAt: null }))).toBe(0);
        expect(warn.mock.calls.some(args => String(args[0]).includes('missing'))).toBe(true);
    });
});
