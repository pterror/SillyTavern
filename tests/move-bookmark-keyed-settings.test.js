import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

import { setConfigFilePath } from '../src/util.js';

// Extension settings kept under a bookmark's old chat id (b<id>) move to the id extensions see now (its label); a key
// whose bookmark keeps b<id>, or whose new name is taken, stays.

/** @type {any} */
let user;
/** @type {typeof import('../src/migrations/move-bookmark-keyed-settings.js')} */
let move;
/** @type {Record<string, string>} */
const ids = {};

beforeAll(async () => {
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    const fixture = await import('./converted-user.fixture.js');
    user = await fixture.convertedUser('move-bookmark-keys-');
    move = await import('../src/migrations/move-bookmark-keyed-settings.js');
    const { chats } = user.store;
    const tree = await fixture.treeOf(user.store, { avatar: 'Alice.png' });
    const { rows } = await chats.bookmarks({ tree, limit: 500 });
    const at = rows[0].at;
    const actor = { user: 'u', session: (await import('../src/chat-engine.js')).newSessionKey() };
    const make = async (/** @type {string} */ name) => {
        const made = await chats.createBookmark({ tree, node_id: at, name, actor });
        expect(made.ok).toBe(true);
        return String(made.bookmark);
    };
    ids.labelled = await make('Morning walk');
    ids.dupA = await make('Twice');
    ids.dupB = await make('Twice');
    ids.taken = await make('Taken name');
    expect(await chats.bookmarkChatId(tree, ids.labelled)).toBe('Morning walk');
    expect(await chats.bookmarkChatId(tree, ids.dupA)).toBe(`b${ids.dupA}`);
    fs.mkdirSync(path.join(user.root, 'settings'), { recursive: true });
    fs.writeFileSync(path.join(user.root, 'settings', 'extension_settings.json'), JSON.stringify({
        myExt: { [`b${ids.labelled}`]: { note: 'walk' }, [`b${ids.dupA}`]: { note: 'dup' }, other: 1 },
        perChat: { [`b${ids.taken}`]: 1, 'Taken name': 2 },
        b999999: 'no such bookmark',
    }, null, 4));
}, 120000);

afterAll(async () => {
    await user?.close();
});

describe('renameKeys', () => {
    test('renames the keys it names, in place and in order, at any depth, and leaves one whose new name is taken', () => {
        const value = { a: { b1: 1, keep: 2, b2: 3 }, b1: { b2: 4 }, list: [{ b1: 5 }], taken: { b1: 6, Morning: 7 } };
        const { moved, taken } = move.renameKeys(value, new Map([['b1', 'Morning'], ['b2', 'Evening']]));
        expect(value).toEqual({ a: { Morning: 1, keep: 2, Evening: 3 }, Morning: { Evening: 4 }, list: [{ Morning: 5 }], taken: { b1: 6, Morning: 7 } });
        expect(Object.keys(value.a)).toEqual(['Morning', 'keep', 'Evening']);
        expect(moved.length).toBe(5);
        expect(taken).toEqual([{ path: ['taken'], from: 'b1', to: 'Morning' }]);
    });
});

describe('runMove', () => {
    const file = () => path.join(user.root, 'settings', 'extension_settings.json');
    const run = (/** @type {boolean} */ apply) => move.runMove({
        dataRoot: user.dataRoot, handle: 'u', apply,
        engine: async () => (await import('../engine/load.js')).loadEngine().binding,
        probeServer: async () => ({ running: false, lines: [] }),
        log: () => {}, warn: () => {},
    });

    test('the dry run writes nothing; --apply moves each key whose bookmark has a label of its own', async () => {
        const { closeUserStores } = await import('../src/user-stores.js');
        await closeUserStores();
        const before = fs.readFileSync(file(), 'utf8');
        expect(await run(false)).toBe(0);
        expect(fs.readFileSync(file(), 'utf8')).toBe(before);

        expect(await run(true)).toBe(0);
        const after = JSON.parse(fs.readFileSync(file(), 'utf8'));
        expect(after.myExt).toEqual({ 'Morning walk': { note: 'walk' }, [`b${ids.dupA}`]: { note: 'dup' }, other: 1 });
        expect(after.perChat).toEqual({ [`b${ids.taken}`]: 1, 'Taken name': 2 });
        expect(after.b999999).toBe('no such bookmark');
        expect(fs.readdirSync(path.join(user.root, 'settings')).some(f => f.startsWith('extension_settings.json.before-bookmark-keys-'))).toBe(true);
    }, 120000);
});
