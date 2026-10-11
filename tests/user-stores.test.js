import { describe, test, expect, beforeAll, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { setConfigFilePath } from '../src/util.js';

/** @type {any} */
let engine;
/** @type {typeof import('../src/user-stores.js')} */
let stores;
/** @type {string[]} */
const dirs = [];

beforeAll(async () => {
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    engine = (await import('../engine/load.js')).loadEngine().binding;
    stores = await import('../src/user-stores.js');
    stores.setStoreEngine(() => engine);
});

afterEach(async () => {
    await stores.closeUserStores();
    (await import('../src/character-metadata-db.js')).disposeMetadataStores();
    (await import('../src/message-tree-db.js')).disposeMessageTreeStores();
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempRoot() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'user-stores-'));
    dirs.push(dir);
    return dir;
}

describe('user stores', () => {
    test('a user directory in the old format is refused with one line naming the conversion; nothing is made', async () => {
        const root = path.join(tempRoot(), 'u');
        fs.mkdirSync(root);
        fs.writeFileSync(path.join(root, 'message-tree.sqlite'), '');
        const line = await stores.oldFormatLine({ root });
        expect(line).toContain('convert-to-engine.js');
        expect(line?.includes('\n')).toBe(false);
        await expect(stores.assertConverted([{ root }])).rejects.toThrow(stores.OldFormatError);
        await expect(stores.userStore({ root })).rejects.toThrow('convert-to-engine.js');
        expect(fs.existsSync(path.join(root, stores.STORE_DIR))).toBe(false);
    });

    test('a character-metadata.sqlite holding only saved views isn\'t an old library; one holding more is, and nothing is left beside it', async () => {
        const root = path.join(tempRoot(), 'u');
        fs.mkdirSync(root);
        const { getBetterSqlite3 } = await import('../src/endpoints/native-sqlite.js');
        const Database = await getBetterSqlite3();
        const file = path.join(root, 'character-metadata.sqlite');
        const db = new Database(file);
        db.pragma('journal_mode = WAL');
        db.exec('CREATE TABLE saved_views (id TEXT PRIMARY KEY)');
        db.close();
        const files = () => fs.readdirSync(root).sort();
        const before = files();
        expect(await stores.oldFormatLine({ root })).toBeNull();
        expect(files()).toEqual(before);
        const db2 = new Database(file);
        db2.exec('CREATE TABLE characters (id TEXT PRIMARY KEY)');
        db2.close();
        expect(await stores.oldFormatLine({ root })).toContain('(character-metadata.sqlite)');
        expect(files()).toEqual(before);
    });

    test('a new user gets a store marked for the default tags; opened once, read again after a reopen', async () => {
        const root = path.join(tempRoot(), 'u');
        fs.mkdirSync(root);
        expect(await stores.oldFormatLine({ root })).toBeNull();
        const first = stores.userStore({ root });
        expect(stores.userStore({ root })).toBe(first);
        const s = await first;
        expect(s.handle).toBe('u');
        expect(await s.lib.store.meta(['tags_seed_pending'])).toEqual(['true']);
        await s.lib.tags.create({ id: 't1', name: 'One' });
        await stores.closeUserStores();
        const again = await stores.userStore({ root });
        expect(again).not.toBe(s);
        expect((await again.lib.tags.byIds(['t1'])).tags.map((/** @type {any} */ t) => t.name)).toEqual(['One']);
    });

    test('a converted user is served, its old files left beside the store', async () => {
        const dataRoot = tempRoot();
        const root = path.join(dataRoot, 'u');
        const fixture = await import('./convert-to-engine.fixture.js');
        await fixture.buildOldUser(root);
        (await import('../src/character-metadata-db.js')).disposeMetadataStores();
        (await import('../src/message-tree-db.js')).disposeMessageTreeStores();
        expect(await stores.oldFormatLine({ root })).toContain('character-metadata.sqlite, message-tree.sqlite');
        const { getBetterSqlite3 } = await import('../src/endpoints/native-sqlite.js');
        const convert = await import('../src/migrations/convert-to-engine.js');
        const code = await convert.runConversion({
            dataRoot, handle: 'u', Database: await getBetterSqlite3(), engine: () => engine, apply: true, serverStopped: true,
            probeServer: async () => ({ running: false, lines: [] }), log: () => {}, warn: () => {},
        });
        expect(code).toBe(0);
        expect(await stores.oldFormatLine({ root })).toBeNull();
        const s = await stores.userStore({ root });
        const [card] = /** @type {any[]} */ (await s.lib.cards(['Alice.png']));
        expect(card.data.name).toBe('Alice');
        // Rows show the chats' stats: the newest message's time and the chat size; a tree with none, 0.
        const rows = (await s.lib.query({ sortField: 'name', sortOrder: 'asc', limit: 50 })).rows;
        const row = (/** @type {string} */ id) => rows.find((/** @type {any} */ r) => r.id === id);
        expect(row('Alice.png').date_last_chat).toBeGreaterThan(0);
        expect(row('Alice.png').chat_size).toBeGreaterThan(0);
        expect(row('Alice.png').item.chat_size).toBe(row('Alice.png').chat_size);
        expect(row('Cara.png')).toMatchObject({ date_last_chat: 0, chat_size: 0 });
        const hashes = (await s.lib.query({ sortField: 'name', sortOrder: 'asc', limit: 50, wantHashes: true })).hashRows;
        expect(hashes.find((/** @type {any} */ r) => r.id === 'Alice.png').chat_size).toBe(row('Alice.png').chat_size);
        const [groupId] = await s.lib.ids(1, ['1700000000001']);
        const groupStats = (await s.lib.chatStats([/** @type {bigint} */ (groupId)])).get(/** @type {bigint} */ (groupId));
        expect(groupStats?.chat_size).toBeGreaterThan(0);
        expect(groupStats?.date_last_chat).toBeGreaterThan(0);
        // findChar()'s library-wide half: an avatar wins, names compare as compareIgnoreCaseAndAccents() or exactly.
        expect(await s.lib.findCharacters({ name: 'alice' })).toEqual({ ids: ['Alice.png'], capped: false });
        expect(await s.lib.findCharacters({ name: 'alice', insensitive: false })).toEqual({ ids: [], capped: false });
        expect(await s.lib.findCharacters({ name: 'Bob' })).toEqual({ ids: ['Bob.png'], capped: false });
        expect(await s.lib.findCharacters({ name: 'Alice', tags: ['Blue'] })).toEqual({ ids: [], capped: false });
        expect(await s.lib.findCharacters({ tags: ['Red'] })).toEqual({ ids: ['Alice.png', 'Bob.png'], capped: false });
        expect(await s.lib.findCharacters({ tags: ['Nope'] })).toEqual({ ids: [], capped: false });
        expect(await s.lib.findGroups('PARTY')).toEqual(['1700000000001']);
        expect(await s.lib.findGroups('Nobody')).toEqual([]);
        // Card tags as tags: a name folds to a live tag, one with none is made; ROOT is never one.
        await s.lib.writeCard({ root }, 'Dee.png', JSON.stringify({ name: 'Dee', data: { name: 'Dee', tags: [' red ', 'ROOT', 'Fresh', 'fresh'] } }));
        const seeded = await s.lib.tags.seedCardTags('Dee.png');
        expect(seeded.tagDefinitions.map(t => t.name)).toEqual(['Red', 'Fresh']);
        expect(seeded.tagIds[0]).toBe('tag-red');
        expect((await s.lib.tags.tagIdsFor(['Dee.png']))['Dee.png'].sort()).toEqual([...seeded.tagIds].sort());
        expect((await s.lib.tags.seedCardTags('Dee.png', { onlyExisting: true })).tagIds).toEqual(seeded.tagIds);
        // The change feed: every character once; a change moves it to the end; a delete is answered as one.
        const all = await s.lib.changes(0, 1000);
        expect(all.changes.filter(c => c.op === 'upsert').map(c => c.id).sort()).toEqual(['Alice.png', 'Bob.png', 'Cara.png', 'Dee.png']);
        expect(all).toMatchObject({ truncated: false, hasMore: false });
        await s.lib.setFav(0, 'Bob.png', false);
        await s.lib.deleteEntity(0, 'Cara.png');
        const after = await s.lib.changes(all.seq, 1000);
        expect(after.changes).toEqual([{ id: 'Bob.png', op: 'upsert', fields: null }, { id: 'Cara.png', op: 'delete' }]);
        expect(after.seq).toBeGreaterThan(all.seq);
        expect((await s.lib.changes(after.seq, 1000)).changes).toEqual([]);
        // The local import scan's bookkeeping: per path, written only when it changes; a duplicate's delete forgets it.
        await s.lib.setLocalImportMtime('/in/a.png', 5.5, 'Alice.png');
        await s.lib.setLocalImportMtime('/in/b.png', 6);
        const end = s.lib.store.durableEnd();
        await s.lib.setLocalImportMtime('/in/b.png', 6);
        expect(s.lib.store.durableEnd()).toBe(end);
        expect([...await s.lib.localImportMtimes(['/in/a.png', '/in/b.png', '/in/c.png'])]).toEqual([['/in/a.png', 5.5], ['/in/b.png', 6]]);
        expect(await s.lib.localImportPathsAfter('/in/a.png', 10)).toEqual(['/in/b.png']);
        await s.lib.setLocalImportSkip('/in/n.txt', 1, 'not a card');
        expect(await s.lib.localImportSkip('/in/n.txt')).toEqual({ mtimeMs: 1, reason: 'not a card' });
        await s.lib.clearLocalImportSkip('/in/n.txt');
        expect(await s.lib.localImportSkip('/in/n.txt')).toBeNull();
        await s.lib.clearLocalImportMtime('/in/b.png');
        // A character deleted without its chats leaves an unowned tree the same key adopts; with them, the tree goes.
        const [alice] = await s.people.trees([{ avatar: 'Alice.png' }]);
        const marks = async (/** @type {bigint} */ t) => (await s.chats.bookmarks({ tree: t, limit: 50 })).rows.length;
        const aliceMarks = await marks(/** @type {bigint} */ (alice));
        expect(aliceMarks).toBeGreaterThan(0);
        await s.lib.deleteEntity(0, 'Alice.png', { keepChats: true });
        expect(await s.lib.localImportPathsAfter('', 10)).toEqual([]);
        expect((await s.lib.ids(6, ['Alice']))[0]).toBe(alice);
        await s.lib.writeCard({ root }, 'Alice.png', JSON.stringify({ name: 'Alice', data: { name: 'Alice' } }));
        expect((await s.lib.ids(0, ['Alice.png']))[0]).toBe(alice);
        expect(await marks(/** @type {bigint} */ (alice))).toBe(aliceMarks);
        const [bob] = await s.people.trees([{ avatar: 'Bob.png' }]);
        const bobTree = /** @type {bigint} */ (bob);
        const atRoot = await s.chats.changeState({ tree: bobTree, at: null, ops: [{ key: 'root note', value: 'x' }], actor: { user: 'u' } });
        expect(atRoot.ok).toBe(true);
        const gone = await s.chats.deleteTree({ tree: bobTree, actor: { user: 'u' } });
        expect(gone.ok).toBe(true);
        expect(gone.drops?.bookmarks.length).toBe(1);
        // The state at its root goes too, listed with the drops.
        const rootIds = atRoot.ok ? atRoot.changes : [];
        expect(gone.drops?.changes.filter(c => c.node_id === null).map(c => c.id)).toEqual(expect.arrayContaining(rootIds));
        expect((await s.chats.stateAt({ tree: bobTree, at: null })).state).toEqual({});
        await s.lib.deleteEntity(0, 'Bob.png');
        expect((await s.lib.ids(6, ['Bob']))[0]).toBeNull();
        expect(await marks(/** @type {bigint} */ (bob))).toBe(0);
        expect((await s.lib.store.chatRead('children', { tree: bob, limit: 5 })).ids).toEqual([]);
        await stores.resumeStoreWork([{ root }]);
    });
});
