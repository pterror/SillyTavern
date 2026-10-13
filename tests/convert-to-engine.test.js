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
        for (const want of ['characters 3', 'groups 2', 'world books 3', 'bookmarks 9', 'bookmarks at a tree\'s root 1', 'send keys 1', 'fork choices 2', 'itemizations 1',
            'some of its entries are past the end of its chat, so it may have been saved under another chat\'s name: 3 entries in 1 file(s)',
            'owner Gone: 1 message(s), 1 label(s)', 'Broken.json', 'Odd name', 'leftover.jsonl', 'chat "Dropped empty" (header only)', 'chat "Dropped twin"', 'queued tag moves with no reorder pass, applied: 1', 'group chat repaired: group 1700000000002 chat "c1"']) {
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
        // Images stay in characters/, untouched: the store holds none.
        expect(fs.existsSync(path.join(root, convert.STORE_DIR, 'avatars'))).toBe(false);

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
            // Old labels convert as they are, a repeated one too.
            expect((await names(alice)).map(n => n.join(' | ')).sort()).toEqual(['Alice - 2024-05-01@10h00m00s - Branch #1 | following', 'Alice - 2024-05-01@10h00m00s | following', 'Odd name | following', 'Odd name | following']);
            expect(await names(bob)).toEqual([['Bob - Checkpoint #1', 'pinned']]);
            expect(await names(group)).toEqual([['Party chat', 'following'], ['Dropped empty', 'following'], ['Dropped twin', 'following']]);
            const rows = (await chats.chatList({ tree: group, limit: 10, withMetadata: true })).rows;
            const row = (/** @type {string} */ name) => rows.find(r => r.name === name);
            // Newest first: the two at the chat's last message (the later made first), then the one at the root, made
            // (its header's create_date) before the chat's messages.
            expect(rows.map(r => r.name)).toEqual(['Dropped twin', 'Party chat', 'Dropped empty']);
            expect(row('Dropped empty')).toMatchObject({ at: null, message_count: 0, chat_metadata: { note_prompt: 'Empty one.' } });
            expect(row('Dropped twin')?.at).toBe(row('Party chat')?.at);
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
            // The damaged group chat, repaired: its first message back in front.
            const [damaged] = await people.trees([{ group: '1700000000002' }]);
            const [c1] = (await chats.bookmarks({ tree: damaged, limit: 5 })).rows;
            expect(c1.name).toBe('c1');
            expect((await chats.load({ tree: damaged, at: c1.at }))?.messages.map(m => m.mes)).toEqual(['m1b', 'm2a', 'm3']);
        } finally {
            await lib.close();
        }
    });

    test('a character\'s chat file no label names converts as a chat of its own; itemization files placed only where sure, the rest listed', async () => {
        const dataRoot = await oldUser();
        const root = path.join(dataRoot, 'u');
        const zlib = await import('node:zlib');
        const line = (/** @type {object} */ o) => JSON.stringify(o) + '\n';
        const header = (/** @type {object} */ chatMetadata) => ({ user_name: 'You', character_name: 'x', chat_metadata: chatMetadata });
        const msg = (/** @type {string} */ name, /** @type {boolean} */ isUser, /** @type {string} */ mes, /** @type {object} */ more = {}) => ({ name, is_user: isUser, is_system: false, send_date: '2024-05-01T10:00:00.000Z', mes, extra: {}, ...more });
        // Cara has no rows in the tree: her chat is written whole, every swipe kept.
        fs.mkdirSync(path.join(root, 'chats', 'Cara'), { recursive: true });
        fs.writeFileSync(path.join(root, 'chats', 'Cara', 'Cara lost.jsonl.pre-migration'),
            line(header({ note_prompt: 'Lost.' })) + line({ ...msg('Cara', false, 'Greetings.'), swipes: ['Greetings.', 'Other greeting.'], swipe_id: 0, swipe_info: [{}, {}] }) + line(msg('You', true, 'Hello Cara.')));
        // Only a header: a bookmark at the root.
        fs.mkdirSync(path.join(root, 'chats', 'Alice'), { recursive: true });
        fs.writeFileSync(path.join(root, 'chats', 'Alice', 'Alice header only.jsonl.pre-migration'), line(header({ note_prompt: 'Header only.' })));
        // A line that isn't JSON: read up to it; what's before is Bob's greeting, already in the tree.
        fs.mkdirSync(path.join(root, 'chats', 'Bob'), { recursive: true });
        fs.writeFileSync(path.join(root, 'chats', 'Bob', 'Bob broken.jsonl.pre-migration'), line(header({})) + line(msg('Bob', false, 'Bob here.')) + 'not json\n' + line(msg('You', true, 'Lost.')));
        // Two files naming the same messages: the same entry is placed once, different ones nowhere.
        const itemized = (/** @type {string} */ name, /** @type {object[]} */ list) => fs.writeFileSync(path.join(root, 'itemized prompts', `${name}.json.zst`), zlib.zstdCompressSync(Buffer.from(JSON.stringify(list))));
        itemized('Alice - 2024-05-01@10h00m00s', [{ mesId: 0, rawPrompt: 'one' }, { mesId: 1, rawPrompt: 'same' }]);
        itemized('Alice - 2024-05-01@10h00m00s - Branch #1', [{ mesId: 0, rawPrompt: 'another' }, { mesId: 1, rawPrompt: 'same' }]);

        const dry = await run(dataRoot, { apply: false, serverStopped: false });
        expect(dry.code).toBe(0);
        for (const want of [
            'chat files with no label converted 3',
            'Cara lost.jsonl.pre-migration: 2 message(s); its messages written as a branch of their own, with every swipe',
            'Alice header only.jsonl.pre-migration: 0 message(s); no messages: a bookmark at the tree\'s root',
            'Bob broken.jsonl.pre-migration: 1 message(s); its messages are a path in the tree: a bookmark at its last',
            'Bob broken.jsonl.pre-migration: stops at line 3, 2 line(s) not converted',
            'another file has a different itemization for a message it names: 2 entries in 2 file(s)',
            'itemizations 2',
        ]) expect(dry.text).toContain(want);

        const applied = await run(dataRoot, { apply: true, serverStopped: true });
        expect(applied.text).not.toContain('PROBLEM');
        expect(applied.code).toBe(0);
        const { LibraryEngine } = await import('../src/library-engine.js');
        const { ChatEngine } = await import('../src/chat-engine.js');
        const { libraryPeople } = await import('../src/chat-people.js');
        const { KEPT_ITEMIZATION_FILES } = await import('../src/library-codes.js');
        const lib = await LibraryEngine.open(engine, path.join(root, convert.STORE_DIR));
        try {
            const people = libraryPeople(lib);
            const chats = await ChatEngine.open(lib.store, people);
            const [cara, alice, bob] = await people.trees([{ avatar: 'Cara.png' }, { avatar: 'Alice.png' }, { avatar: 'Bob.png' }]);
            const [lost] = (await chats.bookmarks({ tree: cara, limit: 5 })).rows;
            expect(lost.name).toBe('Cara lost');
            const opened = await chats.load({ tree: cara, at: lost.at });
            expect(opened?.messages.map(m => m.mes)).toEqual(['Greetings.', 'Hello Cara.']);
            expect(opened?.messages[0].swipes).toEqual(['Greetings.', 'Other greeting.']);
            expect((await chats.chatList({ tree: cara, limit: 5, withMetadata: true })).rows[0]).toMatchObject({ name: 'Cara lost', chat_metadata: { note_prompt: 'Lost.' } });
            const aliceRows = (await chats.chatList({ tree: alice, limit: 10, withMetadata: true })).rows;
            expect(aliceRows.find(r => r.name === 'Alice header only')).toMatchObject({ at: null, chat_metadata: { note_prompt: 'Header only.' } });
            expect((await chats.bookmarks({ tree: bob, limit: 5 })).rows.map(b => b.name).sort()).toEqual(['Bob - Checkpoint #1', 'Bob broken']);
            const [kept] = await lib.store.meta([KEPT_ITEMIZATION_FILES]);
            expect(JSON.parse(kept).filter((/** @type {any} */ k) => k.reason.startsWith('another file')).map((/** @type {any} */ k) => [k.file, k.entries]).sort()).toEqual([
                ['Alice - 2024-05-01@10h00m00s - Branch #1.json.zst', 1], ['Alice - 2024-05-01@10h00m00s.json.zst', 1],
            ]);
        } finally {
            await lib.close();
        }
    });

    test('owners with no character or group are left out unless kept', async () => {
        const dataRoot = await oldUser();
        const applied = await run(dataRoot, { apply: true, serverStopped: true, keepOrphans: true });
        expect(applied.code).toBe(0);
        expect(applied.text).toContain('unowned tree kept: owner Gone, 1 message(s), 1 bookmark(s)');
        // Every conversation made is listed in recent chats, in the order of its last message (the check reads it back).
        expect(applied.text).toMatch(/conversations listed in recent chats 14/);
        const { LibraryEngine, TYPE } = await import('../src/library-engine.js');
        const lib = await LibraryEngine.open(engine, path.join(dataRoot, 'u', convert.STORE_DIR));
        try {
            expect((await lib.ids(TYPE.tree, ['Gone']))[0]).not.toBeNull();
        } finally {
            await lib.close();
        }
    });

    test('two chats\' different metadata at one message are both recorded there, the later one read, the overridden keys listed', async () => {
        const dataRoot = await oldUser();
        const root = path.join(dataRoot, 'u');
        // The duplicate group chat ends on the group chat's last message; give that message metadata of its own, other
        // than the duplicate's. In label order the message's own comes first, the dropped chat's after it.
        const db = new Database(path.join(root, 'message-tree.sqlite'));
        const end = db.prepare('SELECT id FROM messages WHERE owner_id = ? AND json_extract(content, \'$.mes\') = ?').get('1700000000001', 'Hey all.');
        db.prepare('UPDATE messages SET metadata = ? WHERE id = ?').run(JSON.stringify({ note_prompt: 'Row note.', variables: { y: 2 } }), end.id);
        db.close();
        const twin = path.join(root, 'group chats', 'Dropped twin.jsonl.pre-migration');
        const lines = fs.readFileSync(twin, 'utf8').split('\n');
        lines[0] = JSON.stringify({ ...JSON.parse(lines[0]), chat_metadata: { __is_group: true, note_prompt: 'Twin note.', variables: { x: 1 } } });
        fs.writeFileSync(twin, lines.join('\n'));

        const dry = await run(dataRoot, { apply: false, serverStopped: false });
        expect(dry.code).toBe(0);
        expect(dry.text).toContain('WARNING: chat metadata a later chat at the same message overrides (both recorded there, the later one read): 1');
        expect(dry.text).toContain(`group 1700000000001 at ${end.id} (${end.id} -> Dropped twin): keys note_prompt, y (variable)`);
        expect(dry.text).not.toContain('Twin note.');
        expect(dry.text).not.toContain('Row note.');

        const applied = await run(dataRoot, { apply: true, serverStopped: true });
        expect(applied.text).not.toContain('PROBLEM');
        expect(applied.code).toBe(0);
        const { LibraryEngine } = await import('../src/library-engine.js');
        const { ChatEngine } = await import('../src/chat-engine.js');
        const { libraryPeople } = await import('../src/chat-people.js');
        const lib = await LibraryEngine.open(engine, path.join(root, convert.STORE_DIR));
        try {
            const people = libraryPeople(lib);
            const chats = await ChatEngine.open(lib.store, people);
            const [group] = await people.trees([{ group: '1700000000001' }]);
            const [at] = await lib.store.chatRead('ids', { space: 0, keys: [end.id] });
            expect(await chats.metadata(group, at)).toEqual({ note_prompt: 'Twin note.', variables: { x: 1 } });
            // The earlier chat's change stays in the history there: reverting the later ones reads it again.
            const changes = await lib.store.chatRead('activeChanges', { message: at });
            expect(changes.length).toBe(6);
            for (const c of changes.slice(3)) expect((await chats.revertChange({ change: String(c.id), actor: { user: 'u' } })).ok).not.toBe(false);
            expect(await chats.metadata(group, at)).toEqual({ note_prompt: 'Row note.', variables: { y: 2 } });
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
