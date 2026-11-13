import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

import express from 'express';

import { write as writeCard } from './character-card-parser.js';
import { setConfigFilePath } from './util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
setConfigFilePath(path.join(__dirname, '..', 'config.yaml'));

const { router: chatsRouter } = await import('./endpoints/chats.js');
const { newSessionKey } = await import('./chat-engine.js');
const { chatReadsBook, chatWorlds, linksOfTexts, CHAT_LINKS_EVENT } = await import('./chat-links.js');
const { References } = await import('./world-info/references.js');
const { writeAllSettings } = await import('./settings-store.js');
const { getStringHash } = await import('../public/scripts/hash-utils.js');
const { LOOSE } = await import('./world-info/test-globals.js');
const { convertedUser, writeLibraryCard, seedMessages, treeOf } = await import('../tests/converted-user.fixture.js');

const user = await convertedUser('st-chat-links-test-');
const { directories, store } = user;
const { lib } = store;
globalThis.DATA_ROOT = user.dataRoot;
after(() => user.close());

const baseImage = fs.readFileSync(path.join(__dirname, '..', 'public', 'img', 'ai4.png'));
{
    const cardJson = JSON.stringify({ name: 'Alice', spec: 'chara_card_v2', data: { name: 'Alice', extensions: { world: 'Harbour' } } });
    await writeLibraryCard(user, 'alice.png', cardJson, writeCard(baseImage, cardJson));
}

/**
 * @param {string} name
 * @param {{ uid: number, names: string[], keys?: string[], content?: string }[]} entries
 */
async function writeWorld(name, entries) {
    await lib.books.write(name, {
        entries: Object.fromEntries(entries.map(e => [e.uid, {
            uid: e.uid, key: [...e.names, ...(e.keys ?? [])], keysecondary: [], comment: '', content: e.content ?? '', extensions: { names: e.names },
        }])),
    });
    const found = await lib.books.find(name);
    assert.ok(found?.defined);
    return found.id;
}

const harbour = await writeWorld('Harbour', [{ uid: 1, names: ['Ilse Varro'] }, { uid: 2, names: ['the Lantern'], keys: ['lamp'] }]);
const everywhere = await writeWorld('Everywhere', [{ uid: 1, names: ['Vale'] }]);
const elsewhere = await writeWorld('Elsewhere', [{ uid: 1, names: ['Rowan'] }]);
await writeWorld('Plain', [{ uid: 1, names: [], keys: ['Ilse'] }]);
writeAllSettings(directories, { world_info_settings: { world_info: { globalSelect: ['Everywhere', 'Plain'] } } });

/** @param {bigint} book @param {number} uid */
const entityOf = async (book, uid) => String((await lib.ids(5, [`${book}:${uid}`]))[0]);

const owner = { avatar: 'alice.png' };
const tab = newSessionKey();
const texts = ['Ilse Varro lit the Lantern.', 'Rowan rode out of Vale past the lamp.'];
const [first, second] = await seedMessages(store, owner, null, texts.map((mes, i) => ({ name: i ? 'Alice' : 'User', is_user: !i, is_system: false, mes, send_date: 'x', extra: {} })), { session: tab });
const tree = await treeOf(store, owner);

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
    req.user = { directories, profile: { handle: 'u' } };
    next();
});
app.use('/api/chats', chatsRouter);

/**
 * @param {string} urlPath
 * @param {object} body
 * @returns {Promise<any>}
 */
async function post(urlPath, body) {
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    try {
        const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
        const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-ST-Session': tab },
            body: JSON.stringify(body),
        });
        assert.equal(res.status, 200);
        return res.json();
    } finally {
        server.closeAllConnections?.();
        await new Promise(resolve => server.close(resolve));
    }
}

test('the chat reads the worlds its replies read: the ones used in every chat, the character\'s, the chat\'s', async () => {
    const chatWorld = await writeWorld('Chat world', [{ uid: 1, names: ['Mira'] }]);
    const books = await chatWorlds(directories, store, tree, { world_info: 'Chat world' });
    assert.deepEqual(new Set(books), new Set([everywhere, (await lib.books.find('Plain'))?.id, harbour, chatWorld]));
    assert.ok(!books.includes(elsewhere));
});

test('a message is linked where it writes a name of an entry of the chat\'s worlds, each link opening its entry in its look', async () => {
    const { links } = await post('/api/chats/open', { avatar_url: 'alice.png' });
    const [ilse, lantern, vale] = [await entityOf(harbour, 1), await entityOf(harbour, 2), await entityOf(everywhere, 1)];
    assert.deepEqual(links.messages[first], { of: getStringHash(texts[0]), links: [[0, 10, ilse], [15, 26, lantern]], complete: true });
    assert.deepEqual(links.messages[second], { of: getStringHash(texts[1]), links: [[18, 22, vale]], complete: true }, 'a trigger and a world the chat doesn\'t read link nothing');
    assert.deepEqual(links.entries[ilse], { world: String(harbour), picture: null });
    assert.deepEqual(new Set(Object.keys(links.looks.things)), new Set([ilse, lantern, vale]));
});

test('the texts share one bound: the first one cut is answered as far as it got, the rest not at all', async () => {
    const references = new References(lib, { defaults: LOOSE });
    const newestFirst = [{ nodeId: 'b', text: texts[1] }, { nodeId: 'a', text: texts[0] }];
    const whole = await linksOfTexts(references, [harbour, everywhere], newestFirst);
    assert.deepEqual(Object.keys(whole.messages), ['b', 'a']);
    const short = await linksOfTexts(references, [harbour, everywhere], newestFirst, 12);
    assert.deepEqual(Object.keys(short.messages), ['b']);
    assert.equal(short.messages.b.complete, false);
    let readsOfNewest = 0;
    for (const book of [harbour, everywhere]) readsOfNewest += /** @type {any} */ (await references.spans(book, 0n, texts[1])).reads;
    const second = await linksOfTexts(references, [harbour, everywhere], newestFirst, readsOfNewest + 1);
    assert.deepEqual(Object.keys(second.messages), ['b'], 'the second text, not reached whole, is left for the page to ask again');
    assert.equal(second.messages.b.complete, true);
});

test('a renamed name is linked as it is now, and the tab holding the chat\'s links is pushed them again', async () => {
    await post('/api/chats/open', { avatar_url: 'alice.png' });
    const pushed = new Promise(resolve => store.events.once(CHAT_LINKS_EVENT, resolve));
    await writeWorld('Harbour', [{ uid: 1, names: ['Ilse'], keys: ['Ilse Varro'] }, { uid: 2, names: ['the Lantern'], keys: ['lamp'] }]);
    const { session, links } = /** @type {any} */ (await pushed);
    assert.equal(session, tab);
    const ilse = await entityOf(harbour, 1);
    assert.deepEqual(links.messages[first].links[0], [0, 4, ilse]);
    const { links: answered } = await post('/api/chats/message/edit', { avatar_url: 'alice.png', node_id: first, content: { mes: texts[0] } });
    assert.deepEqual(answered.messages[first].links[0], [0, 4, ilse]);
});

test('a chat reads a world when its replies do, and a character\'s own book when the character takes part and names no world in its place', async () => {
    const actor = { user: 'u', session: tab };
    assert.equal(await chatReadsBook(directories, store, tree, actor, harbour), true);
    assert.equal(await chatReadsBook(directories, store, tree, actor, elsewhere), false);

    const own = { name: 'Notes', entries: [{ id: 0, keys: ['Mira'], content: 'Mira.' }] };
    for (const [avatar, world] of [['bob.png', ''], ['cara.png', 'Harbour']]) {
        const cardJson = JSON.stringify({ name: avatar, spec: 'chara_card_v2', data: { name: avatar, extensions: { world }, character_book: own } });
        await writeLibraryCard(user, avatar, cardJson, writeCard(baseImage, cardJson));
    }
    const bookOf = async (/** @type {string} */ avatar) => {
        const [character] = await lib.ids(0, [avatar]);
        return /** @type {bigint} */ ((await lib.ids(4, [`${character}:c`]))[0]);
    };
    const [bobBook, caraBook] = [await bookOf('bob.png'), await bookOf('cara.png')];
    assert.equal(await chatReadsBook(directories, store, tree, actor, bobBook), false, 'not taking part');
    for (const avatar of ['bob.png', 'cara.png']) await seedMessages(store, { avatar }, null, [{ name: 'User', is_user: true, is_system: false, mes: 'Hi.', send_date: 'x', extra: {} }], { session: tab });
    assert.equal(await chatReadsBook(directories, store, await treeOf(store, { avatar: 'bob.png' }), actor, bobBook), true);
    assert.equal(await chatReadsBook(directories, store, await treeOf(store, { avatar: 'cara.png' }), actor, caraBook), false, 'its world stands in for it');
});
