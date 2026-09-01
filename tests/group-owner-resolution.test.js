import { describe, test, expect, beforeAll, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** @type {typeof import('../src/character-shallow.js').resolveGroupOwner} */
let resolveGroupOwner;

beforeAll(async () => {
    // character-shallow.js reads config at module scope, so the path has to be set before it loads.
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    ({ resolveGroupOwner } = await import('../src/character-shallow.js'));
});

const tmpDirs = [];

function makeGroupsDir(groups) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'group-owner-test-'));
    tmpDirs.push(dir);
    for (const group of groups) {
        fs.writeFileSync(path.join(dir, `${group.id}.json`), JSON.stringify(group));
    }
    return dir;
}

afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

describe('resolveGroupOwner()', () => {
    test('finds the owning group by chat id when no group id is supplied', () => {
        // The stock API shape: /group/save is handed group.chat_id and nothing else.
        const dir = makeGroupsDir([
            { id: 'grp-a', chats: ['chat-1', 'chat-2'] },
            { id: 'grp-b', chats: ['chat-3'] },
        ]);

        expect(resolveGroupOwner(dir, { chatId: 'chat-3' })).toEqual({ id: 'grp-b', chats: ['chat-3'] });
        expect(resolveGroupOwner(dir, { chatId: 'chat-2' }).id).toBe('grp-a');
    });

    test('a chat no group claims resolves to null rather than to some group', () => {
        // This has to stay distinguishable from a hit: a group chat whose owner can't be established has
        // no addressable place in the tree, and guessing an owner would file it under the wrong history.
        const dir = makeGroupsDir([{ id: 'grp-a', chats: ['chat-1'] }]);
        expect(resolveGroupOwner(dir, { chatId: 'chat-orphan' })).toBeNull();
        expect(resolveGroupOwner(dir, {})).toBeNull();
        expect(resolveGroupOwner(path.join(dir, 'nope'), { chatId: 'chat-1' })).toBeNull();
    });

    test('a supplied group id short-circuits the scan and still returns the chat list', () => {
        const dir = makeGroupsDir([{ id: 'grp-a', chats: ['chat-1', 'chat-2'] }]);
        expect(resolveGroupOwner(dir, { groupId: 'grp-a' })).toEqual({ id: 'grp-a', chats: ['chat-1', 'chat-2'] });
    });

    test('a group id is accepted for a chat the descriptor does not list yet', () => {
        // A chat created client-side isn't in the descriptor until the group is next saved. Refusing it
        // would break the first save of every new group chat.
        const dir = makeGroupsDir([{ id: 'grp-a', chats: [] }]);
        expect(resolveGroupOwner(dir, { groupId: 'grp-a', chatId: 'brand-new-chat' }).id).toBe('grp-a');
    });

    test('a group id that names nothing falls back to the chat-id scan instead of failing', () => {
        const dir = makeGroupsDir([{ id: 'grp-a', chats: ['chat-1'] }]);
        expect(resolveGroupOwner(dir, { groupId: 'grp-gone', chatId: 'chat-1' }).id).toBe('grp-a');
    });

    test('a group id cannot read a descriptor outside the groups directory', () => {
        // The id arrives in a request body and is used to pick a file to read.
        const dir = makeGroupsDir([{ id: 'grp-a', chats: ['chat-1'] }]);
        const outside = path.join(path.dirname(dir), 'outside-group.json');
        fs.writeFileSync(outside, JSON.stringify({ id: 'sneaky', chats: ['chat-1'] }));
        try {
            const resolved = resolveGroupOwner(dir, { groupId: '../outside-group', chatId: 'chat-1' });
            // Falls through to the scan and lands on the real owner, never on the outside file.
            expect(resolved).toEqual({ id: 'grp-a', chats: ['chat-1'] });
        } finally {
            fs.rmSync(outside, { force: true });
        }
    });

    test('a corrupt descriptor is skipped, not fatal to the whole lookup', () => {
        const dir = makeGroupsDir([{ id: 'grp-a', chats: ['chat-1'] }]);
        fs.writeFileSync(path.join(dir, 'broken.json'), '{ not json');
        expect(resolveGroupOwner(dir, { chatId: 'chat-1' }).id).toBe('grp-a');
    });
});
