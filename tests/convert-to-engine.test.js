import { describe, test, expect, beforeAll, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { setConfigFilePath } from '../src/util.js';
import { getBetterSqlite3 } from '../src/endpoints/native-sqlite.js';

/** @type {any} */
let Database;
/** @type {any} */
let engine;
/** @type {typeof import('../src/migrations/convert-to-engine.js')} */
let convert;
/** @type {typeof import('./convert-to-engine.fixture.js')} */
let fixture;
/** @type {string[]} */
const dirs = [];

beforeAll(async () => {
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    Database = await getBetterSqlite3();
    engine = (await import('../engine/load.js')).loadEngine().binding;
    convert = await import('../src/migrations/convert-to-engine.js');
    fixture = await import('./convert-to-engine.fixture.js');
});

afterEach(async () => {
    (await import('../src/character-metadata-db.js')).disposeMetadataStores();
    (await import('../src/message-tree-db.js')).disposeMessageTreeStores();
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A data root holding one user built by the fixture, and a copy of every byte of it. */
async function oldUser() {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'convert-engine-'));
    dirs.push(dataRoot);
    await fixture.buildOldUser(path.join(dataRoot, 'u'));
    return dataRoot;
}

/** Every file under `dir` and its bytes' hash, `store/` and `store.converting/` left out. */
function snapshot(dir) {
    const out = {};
    const walk = (/** @type {string} */ d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const full = path.join(d, e.name);
            if (e.isDirectory()) {
                if (d === dir && (e.name === convert.STORE_DIR || e.name === convert.BUILDING_DIR)) continue;
                walk(full);
            } else out[path.relative(dir, full)] = fs.readFileSync(full).toString('base64');
        }
    };
    walk(dir);
    return out;
}

/** @param {string} dataRoot @param {object} more */
async function run(dataRoot, more) {
    const lines = [];
    const code = await convert.runConversion({
        dataRoot, handle: 'u', Database, engine: () => engine, probeServer: async () => ({ running: false, lines: [] }),
        log: l => lines.push(l), warn: l => lines.push(l), ...more,
    });
    return { code, text: lines.join('\n') };
}

describe('convert-to-engine', () => {
    test('a dry run writes nothing and reports what the apply writes; the apply checks everything and leaves the old files', async () => {
        const dataRoot = await oldUser();
        const root = path.join(dataRoot, 'u');
        const before = snapshot(root);

        const dry = await run(dataRoot, { apply: false, serverStopped: false });
        expect(dry.code).toBe(0);
        expect(snapshot(root)).toEqual(before);
        expect(fs.existsSync(path.join(root, convert.BUILDING_DIR))).toBe(false);
        for (const want of ['characters 3', 'groups 1', 'world books 3', 'bookmarks 8', 'bookmarks at a tree\'s root 1', 'send keys 1', 'fork choices 1', 'itemizations 2',
            'owner Gone: 1 message(s), 1 label(s)', 'Broken.json', 'Odd name', 'leftover.jsonl', 'chat "Dropped empty" (header only)', 'chat "Dropped twin"', 'queued tag moves with no reorder pass, applied: 1']) {
            expect(dry.text).toContain(want);
        }

        // Refused while the server answers, and without --server-stopped.
        expect((await run(dataRoot, { apply: true, serverStopped: false })).code).toBe(1);
        expect((await run(dataRoot, { apply: true, serverStopped: true, probeServer: async () => ({ running: true, lines: [] }) })).code).toBe(1);

        // A run that stopped partway left its directory: it is built again.
        fs.mkdirSync(path.join(root, convert.BUILDING_DIR, 'junk'), { recursive: true });
        const applied = await run(dataRoot, { apply: true, serverStopped: true });
        expect(applied.text).not.toContain('PROBLEM');
        expect(applied.code).toBe(0);
        expect(snapshot(root)).toEqual(before);
        expect(fs.existsSync(path.join(root, convert.STORE_DIR))).toBe(true);
        expect(fs.existsSync(path.join(root, convert.BUILDING_DIR))).toBe(false);
        // Hard links: the avatars' bytes weren't written again.
        const avatars = fs.readdirSync(path.join(root, convert.STORE_DIR, 'avatars'));
        expect(avatars.length).toBe(3);
        expect(fs.statSync(path.join(root, convert.STORE_DIR, 'avatars', avatars[0])).nlink).toBe(2);

        // Converted once: a second run refuses.
        expect((await run(dataRoot, { apply: true, serverStopped: true })).code).toBe(1);

        // What the server will read.
        const { LibraryEngine } = await import('../src/library-engine.js');
        const { ChatEngine } = await import('../src/chat-engine.js');
        const { libraryPeople } = await import('../src/chat-people.js');
        const lib = await LibraryEngine.open(engine, path.join(root, convert.STORE_DIR));
        try {
            const people = libraryPeople(lib);
            const chats = await ChatEngine.open(lib.store, people);
            const [alice, bob, group] = await people.trees([{ avatar: 'Alice.png' }, { avatar: 'Bob.png' }, { group: '1700000000001' }]);
            const names = async (/** @type {bigint} */ t) => (await chats.bookmarks({ tree: t, limit: 20 })).rows.map(b => [b.name, b.mode]);
            // In the order the old chat list had them (their messages' creation), a repeated name suffixed.
            expect(new Set((await names(alice)).map(n => n.join(' | ')))).toEqual(new Set(['Alice - 2024-05-01@10h00m00s | following', 'Alice - 2024-05-01@10h00m00s - Branch #1 | following', 'Odd name | following', 'Odd name (1) | following']));
            expect(await names(bob)).toEqual([['Bob - Checkpoint #1', 'pinned']]);
            expect(await names(group)).toEqual([['Party chat', 'following'], ['Dropped empty', 'following'], ['Dropped twin', 'following']]);
            const rows = (await chats.chatList({ tree: group, limit: 10, withMetadata: true })).rows;
            expect(rows[1]).toMatchObject({ name: 'Dropped empty', at: null, message_count: 0, chat_metadata: { note_prompt: 'Empty one.' } });
            expect(rows[2].at).toBe(rows[0].at);
            // The deterministic session lands where today's server opens the chat.
            const landed = await chats.resolveSession({ tree: alice, user: 'u', header: undefined });
            const at = await chats.pointer(/** @type {string} */ (landed.session));
            const opened = await chats.load({ tree: alice, at: at?.at ?? null });
            expect(opened?.messages.map(m => m.mes)).toEqual(['Hi!', 'Hello.', 'How are you?', 'Fine \ud800 thanks.', 'Good to hear.', 'Bye.']);
            expect(opened?.messages[1].extra).toEqual({});
            const bobAt = await chats.pointer(/** @type {string} */ ((await chats.resolveSession({ tree: bob, user: 'u', header: undefined })).session));
            expect(bobAt).toEqual({ tree: bob, at: null });
            // Cards, tags and books.
            const [card] = /** @type {any[]} */ (await lib.cards(['Alice.png']));
            expect(card.data.character_book.entries.map((/** @type {any} */ e) => e.content)).toEqual(['embedded', 'second']);
            expect(card.data.extensions.world).toBe('Lore A');
            expect((await lib.tags.byIds(['tag-old'])).merged).toEqual({ 'tag-old': 'tag-red' });
            expect((await lib.books.list()).map(b => b.name)).toEqual(['Lore A', 'Lore V1', 'Lore V2']);
            expect(await chats.metadata(alice, null)).toEqual({});
        } finally {
            await lib.close();
        }
    });

    test('owners with no character or group are left out unless kept', async () => {
        const dataRoot = await oldUser();
        const applied = await run(dataRoot, { apply: true, serverStopped: true, keepOrphans: true });
        expect(applied.code).toBe(0);
        expect(applied.text).toContain('unowned tree kept: owner Gone, 1 message(s), 1 bookmark(s)');
        const { LibraryEngine, TYPE } = await import('../src/library-engine.js');
        const lib = await LibraryEngine.open(engine, path.join(dataRoot, 'u', convert.STORE_DIR));
        try {
            expect((await lib.ids(TYPE.tree, ['Gone']))[0]).not.toBeNull();
        } finally {
            await lib.close();
        }
    });

    test('a message that can\'t be read stops the apply, which leaves nothing', async () => {
        const dataRoot = await oldUser();
        const root = path.join(dataRoot, 'u');
        const db = new Database(path.join(root, 'message-tree.sqlite'));
        const row = db.prepare('SELECT id FROM messages WHERE owner_id = ? AND parent_id IS NOT NULL LIMIT 1').get('Bob');
        db.prepare('UPDATE messages SET content = ? WHERE id = ?').run('{not json', row.id);
        db.close();
        const before = snapshot(root);
        const applied = await run(dataRoot, { apply: true, serverStopped: true });
        expect(applied.code).toBe(1);
        expect(applied.text).toContain(row.id);
        expect(fs.existsSync(path.join(root, convert.BUILDING_DIR))).toBe(false);
        expect(fs.existsSync(path.join(root, convert.STORE_DIR))).toBe(false);
        expect(snapshot(root)).toEqual(before);
    });
});

describe('labels as bookmarks', () => {
    test('a name\'s wording, its last suffix first, decides pinned or following; the files and the backup settle the rest', async () => {
        const { modeByWording, classify } = await import('../src/migrations/convert-to-engine/labels.js');
        const { MODE } = await import('../src/chat-engine.js');
        const cases = [
            ['Alice - Checkpoint #3', MODE.pinned],
            ['Alice - 2024-05-01@10h00m00s - Bookmark #2', MODE.pinned],
            ['Bookmark #7', MODE.pinned],
            ['Bookmark - 12', MODE.pinned],
            ['Alice - Checkpoint #3 - Branch #1', MODE.following],
            ['Branch #2 - 2025-04-13@10h34m18s', MODE.following],
            ['Alice - 2025-04-13@10h34m18s123ms', MODE.following],
            ['2025-07-01@19h58m19s', MODE.following],
            ['Alice - 2024 imported', MODE.following],
            ['1752913314180', MODE.following],
            ['My chat', null],
        ];
        for (const [name, mode] of cases) expect([name, modeByWording(/** @type {string} */ (name))]).toEqual([name, mode]);
        const { modes, unsettled } = classify(['My chat', 'Linked', 'Saved label', 'Saved branch', 'Alice - Checkpoint #1'],
            () => ({ links: new Set(['Linked']) }),
            () => ({ labels: new Set(['Saved label']), branches: new Set(['Saved branch']) }));
        expect(Object.fromEntries(modes)).toEqual({ 'My chat': MODE.following, 'Linked': MODE.pinned, 'Saved label': MODE.pinned, 'Saved branch': MODE.following, 'Alice - Checkpoint #1': MODE.pinned });
        expect(unsettled).toEqual(['My chat']);
    });
});
