import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import path from 'node:path';

import { setConfigFilePath } from '../src/util.js';

/** @type {Awaited<ReturnType<typeof import('./converted-user.fixture.js').convertedUser>>} */
let user;
/** @type {typeof import('../src/endpoints/chats.js')} */
let chats;
const GROUP = '1700000000001';

beforeAll(async () => {
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    user = await (await import('./converted-user.fixture.js')).convertedUser('chats-compat-');
    chats = await import('../src/endpoints/chats.js');
});

afterAll(async () => {
    await user.close();
});

const characterChat = (/** @type {string} */ name) => path.join(user.directories.chats, 'Alice', `${name}.jsonl`);
const groupChat = (/** @type {string} */ name) => path.join(user.directories.groupChats, `${name}.jsonl`);

/** Every bookmark name of a tree. */
async function namesOf(/** @type {{ avatar?: string, group?: string }} */ owner) {
    const { chatNamesOf } = await import('../src/chat-request.js');
    const { treeOf } = await import('./converted-user.fixture.js');
    return chatNamesOf(user.store, await treeOf(user.store, owner));
}

/** What `/get` answers for a chat name of a tree (no tab). */
async function asLoaded(/** @type {{ avatar?: string, group?: string }} */ owner, /** @type {string} */ name) {
    const { treeOf } = await import('./converted-user.fixture.js');
    const tree = await treeOf(user.store, owner);
    const { chatNamePosition } = await import('../src/chat-request.js');
    const at = await chatNamePosition(/** @type {any} */ ({ store: user.store, tree }), name);
    const loaded = await user.store.chats.load({ tree, at: /** @type {string | null} */ (at) });
    return [{ chat_metadata: { ...loaded?.metadata }, user_name: 'unused', character_name: 'unused' }, ...(loaded?.messages ?? [])];
}

describe('upstream\'s chats.js exports on the engine', () => {
    test('getBackupKey keeps ASCII names and keeps non-ASCII names apart', () => {
        expect(chats.getBackupKey('Alice - Chat 1')).toBe('alice___chat_1');
        const a = chats.getBackupKey('猫');
        const b = chats.getBackupKey('犬');
        expect(a).toMatch(/^__[0-9a-f]{8}$/);
        expect(a).not.toBe(b);
    });

    test('getChatData reads every chat a path names as /get answers it, synchronously', async () => {
        const alice = await namesOf({ avatar: 'Alice.png' });
        const party = await namesOf({ group: GROUP });
        expect(alice.length).toBeGreaterThan(1);
        expect(party.length).toBeGreaterThan(0);
        for (const name of alice) {
            const read = chats.getChatData(characterChat(name));
            expect(Array.isArray(read)).toBe(true);
            expect(read).toEqual(await asLoaded({ avatar: 'Alice.png' }, name));
            expect(read.length).toBeGreaterThan(1);
        }
        for (const name of party) expect(chats.getChatData(groupChat(name))).toEqual(await asLoaded({ group: GROUP }, name));
        expect(chats.getChatData(characterChat('no such chat'))).toEqual([]);
        expect(chats.getChatData(path.join(user.directories.chats, 'Nobody', 'x.jsonl'))).toEqual([]);
        expect(chats.getChatData(path.join(user.directories.root, 'elsewhere.jsonl'))).toEqual([]);
    });

    test('trySaveChat saves a chat a path names, and refuses another chat\'s integrity unless told to skip the check', async () => {
        const [name] = await namesOf({ avatar: 'Alice.png' });
        const before = chats.getChatData(characterChat(name));
        const changed = structuredClone(before);
        changed.push({ name: 'You', is_user: true, is_system: false, send_date: '2025-01-01T00:00:00.000Z', mes: 'Saved through trySaveChat.', extra: {} });
        changed[0].chat_metadata.integrity = 'some other chat';
        await expect(chats.trySaveChat(changed, characterChat(name), false, 'u', 'Alice', user.directories.backups)).rejects.toThrow(/integrity/);
        expect(chats.getChatData(characterChat(name))).toEqual(before);
        await chats.trySaveChat(changed, characterChat(name), true, 'u', 'Alice', user.directories.backups);
        const after = chats.getChatData(characterChat(name));
        expect(after[after.length - 1].mes).toBe('Saved through trySaveChat.');
        await expect(chats.trySaveChat(changed, path.join(user.directories.chats, 'Nobody', 'x.jsonl'), true, 'u', 'Nobody', user.directories.backups)).rejects.toThrow();
    });
});
