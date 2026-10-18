// An upstream user directory's groups, books and chats go into the store once, every message with its swipes; what
// is in the store already is left as it is, and what can't be imported is listed with why.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

import { write as writeCard } from './character-card-parser.js';
import { setConfigFilePath } from './util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
setConfigFilePath(path.join(__dirname, '..', 'config.yaml'));

const { importUpstreamData, resumeUpstreamImport, UPSTREAM_META, MAP_FILE } = await import('./upstream-import.js');
const { emptyUser, writeLibraryCard, treeOf } = await import('../tests/converted-user.fixture.js');

const user = await emptyUser('st-upstream-import-test-');
const { directories, store } = user;

const baseImage = fs.readFileSync(path.join(__dirname, '..', 'public', 'img', 'ai4.png'));
async function writeCharacter(avatar, name) {
    const card = {
        spec: 'chara_card_v2', spec_version: '2.0', name, description: '', personality: '', scenario: '', first_mes: 'Hi.', mes_example: '', avatar,
        data: { name, description: '', personality: '', scenario: '', first_mes: 'Hi.', mes_example: '', system_prompt: '', post_history_instructions: '', character_version: '', creator_notes: '', alternate_greetings: [], extensions: {} },
    };
    const cardJson = JSON.stringify(card);
    await writeLibraryCard(user, avatar, cardJson, writeCard(baseImage, cardJson));
}

const jsonl = (/** @type {object[]} */ lines) => lines.map(l => JSON.stringify(l)).join('\n');
const write = (/** @type {string} */ rel, /** @type {string} */ text) => {
    const file = path.join(directories.root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
};

/** The messages shown down to the tree's bookmark labelled `name`. */
async function chatNamed(owner, name) {
    const tree = await treeOf(store, owner);
    const [b] = await store.lib.store.chatRead('bookmarksNamed', { tree, name });
    assert.ok(b, `a bookmark named ${name}`);
    const page = await store.chats.bookmarks({ tree, limit: 500 });
    const row = page.rows.find(r => String(r.id) === String(b.id ?? b));
    return (await store.chats.load({ tree, at: row.at })).messages;
}

const GROUP_ID = '1700000000000';

test('a new store is marked to import its upstream data once', async () => {
    const [pending] = await store.lib.store.meta([UPSTREAM_META]);
    assert.ok(pending !== null && pending !== undefined);
    assert.ok(await resumeUpstreamImport(store, directories));
    assert.equal((await store.lib.store.meta([UPSTREAM_META]))[0] ?? null, null);
    assert.equal(await resumeUpstreamImport(store, directories), null);
});

test('groups, books, chats and group chats go in, every swipe kept; a second run imports nothing', async () => {
    await writeCharacter('nia.png', 'Nia');
    write('chats/nia/Nia - 2024-01-01@10h00m00s.jsonl', jsonl([
        { user_name: 'User', character_name: 'Nia', chat_metadata: { note_prompt: 'kept' } },
        { name: 'Nia', is_user: false, mes: 'Hello.', send_date: 'x', extra: {} },
        { name: 'User', is_user: true, mes: 'Hi!', send_date: 'x', extra: {} },
        { name: 'Nia', is_user: false, mes: 'second', send_date: 'x', extra: {}, swipe_id: 1, swipes: ['first', 'second', 'third'], swipe_info: [{ extra: {} }, { extra: {} }, { extra: {} }] },
    ]));
    write(`groups/${GROUP_ID}.json`, JSON.stringify({ id: GROUP_ID, name: 'Party', members: ['nia.png'], chat_id: 'Party chat', chats: ['Party chat'], fav: false }));
    write('group chats/Party chat.jsonl', jsonl([
        { chat_metadata: {} },
        { name: 'User', is_user: true, mes: 'Hey all.', send_date: 'x', extra: {} },
        { name: 'Nia', is_user: false, mes: 'Hey.', original_avatar: 'nia.png', send_date: 'x', extra: {} },
    ]));
    write('worlds/Lore.json', JSON.stringify({ entries: { 0: { uid: 0, key: ['dragon'], keysecondary: ['red'], comment: 'Dragons', content: 'Dragons are red.', constant: false, selective: true, order: 100, position: 0, disable: false, probability: 100, useProbability: true, depth: 4 } } }));

    const first = await importUpstreamData(store, directories);
    assert.deepEqual(first.imported, { groups: 1, worlds: 1, chats: 1, groupChats: 1, messages: 5 });
    assert.deepEqual(first.notImported, []);

    const chat = await chatNamed({ avatar: 'nia.png' }, 'Nia - 2024-01-01@10h00m00s');
    assert.deepEqual(chat.map(m => m.mes), ['Hello.', 'Hi!', 'second']);
    assert.deepEqual(chat[2].swipes, ['first', 'second', 'third']);
    assert.equal(chat[2].swipe_id, 1);
    assert.deepEqual((await chatNamed({ group: GROUP_ID }, 'Party chat')).map(m => m.mes), ['Hey all.', 'Hey.']);

    const book = await store.lib.books.read('Lore');
    const entry = Object.values(book.entries)[0];
    assert.deepEqual([entry.key, entry.keysecondary, entry.comment, entry.content, entry.depth], [['dragon'], ['red'], 'Dragons', 'Dragons are red.', 4]);

    const map = JSON.parse(fs.readFileSync(path.join(directories.root, MAP_FILE), 'utf8'));
    assert.match(map.chats['chats/nia/Nia - 2024-01-01@10h00m00s.jsonl'], /^b\d+$/);
    assert.match(map.chats['group chats/Party chat.jsonl'], /^b\d+$/);

    const again = await importUpstreamData(store, directories);
    assert.deepEqual(again.imported, { groups: 0, worlds: 0, chats: 0, groupChats: 0, messages: 0 });
    assert.equal(again.present.length, 4);
    assert.equal((await store.chats.bookmarks({ tree: await treeOf(store, { avatar: 'nia.png' }), limit: 500 })).rows.length, 1);
});

test('a chat stored before a stop that left it out of the map isn\'t imported again', async () => {
    const mapPath = path.join(directories.root, MAP_FILE);
    const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
    delete map.chats['chats/nia/Nia - 2024-01-01@10h00m00s.jsonl'];
    fs.writeFileSync(mapPath, JSON.stringify(map));
    const run = await importUpstreamData(store, directories);
    assert.equal(run.imported.chats, 0);
    assert.ok(run.present.some(p => p.file === 'chats/nia/Nia - 2024-01-01@10h00m00s.jsonl'));
});

test('what can\'t be imported is listed with why, and the rest goes in', async () => {
    write('chats/nobody/Nobody - chat.jsonl', jsonl([{ name: 'Nobody', is_user: false, mes: 'x', extra: {} }]));
    write('chats/nia/Broken.jsonl', `${JSON.stringify({ chat_metadata: {} })}\n{not json\n${JSON.stringify({ name: 'Nia', mes: 'ok', extra: {} })}`);
    write('group chats/Orphan.jsonl', jsonl([{ name: 'User', is_user: true, mes: 'x', extra: {} }]));
    write('worlds/NotABook.json', JSON.stringify({ name: 'no entries' }));
    write('groups/bad.json', '{');
    write('chats/nia/Nia - fine.jsonl', jsonl([{ name: 'Nia', is_user: false, mes: 'Fine.', extra: {} }]));

    const run = await importUpstreamData(store, directories);
    assert.equal(run.imported.chats, 1);
    const why = Object.fromEntries(run.notImported.map(n => [n.file, n.why]));
    assert.match(why['chats/nobody/Nobody - chat.jsonl'], /no character with the avatar nobody\.png/);
    assert.match(why['chats/nia/Broken.jsonl'], /2/);
    assert.match(why['group chats/Orphan.jsonl'], /no group lists this chat/);
    assert.match(why['worlds/NotABook.json'], /not a World Info book/);
    assert.match(why['groups/bad.json'], /unreadable group file/);
    assert.equal(Object.keys(why).length, 5);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directories.root, MAP_FILE), 'utf8')).notImported, run.notImported);
});

test('a 10k-message chat goes in as one import', async () => {
    /** @type {object[]} */
    const lines = [{ chat_metadata: {} }];
    for (let i = 0; i < 10_000; i++) {
        const isUser = i % 2 === 1;
        lines.push(isUser
            ? { name: 'User', is_user: true, mes: `user line ${i}`, send_date: 'x', extra: {} }
            : { name: 'Nia', is_user: false, mes: `reply ${i}`, send_date: 'x', extra: {}, swipe_id: 0, swipes: [`reply ${i}`, `alt ${i}`], swipe_info: [{ extra: {} }, { extra: {} }] });
    }
    write('chats/nia/Nia - long.jsonl', jsonl(lines));
    const started = process.hrtime.bigint();
    const run = await importUpstreamData(store, directories);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    console.log(`[upstream-import test] 10,000 messages (15,000 with swipes) in ${ms.toFixed(0)} ms, ${(ms * 1000 / 10_000).toFixed(1)} µs per message`);
    assert.equal(run.imported.messages, 10_000);
    const chat = await chatNamed({ avatar: 'nia.png' }, 'Nia - long');
    assert.equal(chat.length, 10_000);
    assert.deepEqual(chat[9_998].swipes, ['reply 9998', 'alt 9998']);
});

after(async () => {
    await user.close();
    setImmediate(() => process.exit(0));
});
