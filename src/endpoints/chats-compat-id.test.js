import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

import express from 'express';

import { write as writeCard } from '../character-card-parser.js';
import { setConfigFilePath } from '../util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// chats.js's import chain reads process-wide config at import time, so the config path is set first.
setConfigFilePath(path.join(__dirname, '..', '..', 'config.yaml'));

// Upstream's compat chat id (`getCurrentChatId()`, `characters[].chat`) names the conversation, not the tab: a tab's
// current chat's `b<id>`, else its own conversation in the tree, `s<UUID>.<tree>`. Extensions key per-chat data by it
// (vectors, regex, tts, stable-diffusion) and the page keys the send box's draft by it, so it must differ per
// character and stay put through appends.
const { router: chatsRouter } = await import('./chats.js');
const { newSessionKey, MODE } = await import('../chat-engine.js');
const { SESSION_HEADER } = await import('../request-session.js');
const { buildDraftStorageKey } = await import('../../public/scripts/chat-draft.js');
const { convertedUser, writeLibraryCard, treeOf } = await import('../../tests/converted-user.fixture.js');

const user = await convertedUser('st-chats-compat-id-test-');
const { directories } = user;
globalThis.DATA_ROOT = user.dataRoot;

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
    req.user = { directories, profile: { handle: 'u' } };
    next();
});
app.use('/api/chats', chatsRouter);

/** @returns {Promise<{status: number, data: any}>} */
async function postJson(urlPath, body, tab) {
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    try {
        const res = await fetch(`http://127.0.0.1:${server.address().port}${urlPath}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(tab ? { [SESSION_HEADER]: tab } : {}) },
            body: JSON.stringify(body),
        });
        return { status: res.status, data: await res.json().catch(() => ({})) };
    } finally {
        server.closeAllConnections?.();
        await new Promise(resolve => server.close(resolve));
    }
}

const baseImage = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'img', 'ai4.png'));

async function writeCharacter(avatar, name) {
    const card = {
        spec: 'chara_card_v2', spec_version: '2.0', name, description: '', personality: '', scenario: '', first_mes: 'Hi.', mes_example: '', avatar,
        data: { name, description: '', personality: '', scenario: '', first_mes: 'Hi.', mes_example: '', system_prompt: '', post_history_instructions: '', character_version: '', creator_notes: '', alternate_greetings: [], extensions: {} },
    };
    const cardJson = JSON.stringify(card);
    await writeLibraryCard(user, avatar, cardJson, writeCard(baseImage, cardJson));
}

const message = (/** @type {boolean} */ isUser, /** @type {string} */ mes) => ({ name: isUser ? 'You' : 'Char', is_user: isUser, mes, send_date: 'x', extra: {} });

/** The id the page holds after opening a character in a tab (`characters[].chat`). */
const openedId = async (/** @type {string} */ avatar, /** @type {string} */ tab) => (await postJson('/api/chats/open', { avatar_url: avatar }, tab)).data.chat;

/** Saves the tab's conversation as the page does: under the id it holds, the whole chat. */
async function saveAs(/** @type {string} */ avatar, /** @type {string} */ tab, /** @type {string} */ id, /** @type {any[]} */ messages) {
    const saved = await postJson('/api/chats/save', { avatar_url: avatar, file_name: id, chat: [{ chat_metadata: {} }, ...messages], force: true }, tab);
    assert.equal(saved.status, 200);
    return saved.data;
}

test('two characters in one tab have different ids, each gets its own back, and per-chat data keyed by them never crosses', async () => {
    await writeCharacter('ann.png', 'Ann');
    await writeCharacter('ben.png', 'Ben');
    const tab = newSessionKey();
    const annTree = await treeOf(user.store, { avatar: 'ann.png' });
    const benTree = await treeOf(user.store, { avatar: 'ben.png' });

    const ann = await openedId('ann.png', tab);
    assert.equal(ann, `s${tab}.${annTree}`);
    await saveAs('ann.png', tab, ann, [message(false, 'Hi.'), message(true, 'Hello Ann.')]);
    // An extension keeps data per chat, by the id (as vectors' collection, regex's scoped scripts, tts's voice map).
    /** @type {Map<string, string>} */
    const perChat = new Map([[ann, 'Ann\'s memories']]);

    const ben = await openedId('ben.png', tab);
    assert.equal(ben, `s${tab}.${benTree}`);
    assert.notEqual(ben, ann, 'the same tab names each character\'s conversation apart');
    assert.equal(perChat.get(ben), undefined, 'Ben sees none of Ann\'s data');
    perChat.set(ben, 'Ben\'s memories');

    // Back to Ann: her id again, so her data again; and the save went on in her conversation only.
    const annAgain = await openedId('ann.png', tab);
    assert.equal(annAgain, ann);
    assert.equal(perChat.get(annAgain), 'Ann\'s memories');
    assert.equal(perChat.get(await openedId('ben.png', tab)), 'Ben\'s memories');
    const annChat = await postJson('/api/chats/get', { avatar_url: 'ann.png', file_name: ann }, tab);
    assert.deepEqual(annChat.data.slice(1).map(m => m.mes), ['Hi.', 'Hello Ann.']);
    const benChat = await postJson('/api/chats/get', { avatar_url: 'ben.png', file_name: ben }, tab);
    assert.deepEqual(benChat.data.slice(1).map(m => m.mes), []);

    // Another tab names its own conversation with Ann apart from this one's.
    const other = newSessionKey();
    assert.notEqual(await openedId('ann.png', other), ann);
});

test('the id stays through appends and bookmarks made at the pointer; only opening a chat switches it', async () => {
    await writeCharacter('cal.png', 'Cal');
    const tab = newSessionKey();
    const id = await openedId('cal.png', tab);
    const draftKey = buildDraftStorageKey({ type: 'character', id: 'cal.png', chatId: id });
    const saved = await saveAs('cal.png', tab, id, [message(false, 'Hi.'), message(true, 'One.')]);
    assert.equal(saved.file_name, id, 'a save answers the conversation\'s id, unchanged');
    const last = saved.assigned_node_ids.at(-1).node_id;

    // A bookmark made at the pointer, not opened: the tab's chat is still its own conversation.
    const made = await postJson('/api/chats/bookmark', { avatar_url: 'cal.png', node_id: last, label: 'Here' }, tab);
    assert.equal(made.status, 200);
    assert.equal(await openedId('cal.png', tab), id);

    // A reply (an append): the same id, so the same draft key.
    await saveAs('cal.png', tab, id, [message(false, 'Hi.'), message(true, 'One.'), message(false, 'Two.')]);
    assert.equal(await openedId('cal.png', tab), id);
    assert.equal(buildDraftStorageKey({ type: 'character', id: 'cal.png', chatId: await openedId('cal.png', tab) }), draftKey);

    // Opening the bookmark switches to it.
    const opened = await postJson('/api/chats/open', { avatar_url: 'cal.png', chat: made.data.id, make_current: true }, tab);
    assert.equal(opened.data.chat, made.data.id);
    assert.equal(opened.data.label_base, 'Here');
    // A new chat switches to none: the tab's own conversation again.
    const fresh = await postJson('/api/chats/new', { avatar_url: 'cal.png', chat: '' }, tab);
    assert.equal(fresh.data.chat, id);
    assert.equal(fresh.data.label_base, 'Cal');
});

test('a reply on a pinned current bookmark keeps the id and the draft; the bookmark stays, and the id still names the tab\'s conversation', async () => {
    await writeCharacter('dot.png', 'Dot');
    const tab = newSessionKey();
    const own = await openedId('dot.png', tab);
    const saved = await saveAs('dot.png', tab, own, [message(false, 'Hi.'), message(true, 'One.')]);
    const pinnedAt = saved.assigned_node_ids.at(-1).node_id;
    const made = await postJson('/api/chats/bookmark', { avatar_url: 'dot.png', node_id: pinnedAt, label: 'Pinned', open: true }, tab);
    const id = made.data.opened.chat;
    assert.equal(id, made.data.id);
    const tree = await treeOf(user.store, { avatar: 'dot.png' });
    assert.ok((await user.store.chats.changeBookmark({ tree, bookmark: id.slice(1), change: { mode: MODE.pinned } })).ok);
    const draftKey = buildDraftStorageKey({ type: 'character', id: 'dot.png', chatId: id });

    // The reply is saved under the id the page holds: the tab's own conversation, past the pinned bookmark.
    const replied = await saveAs('dot.png', tab, id, [message(false, 'Hi.'), message(true, 'One.'), message(false, 'Two.')]);
    assert.equal(replied.file_name, id);
    assert.equal(await openedId('dot.png', tab), id);
    assert.equal(buildDraftStorageKey({ type: 'character', id: 'dot.png', chatId: await openedId('dot.png', tab) }), draftKey);
    // This tab reads its conversation by the id; anyone else reads the pinned bookmark where it is.
    assert.deepEqual((await postJson('/api/chats/get', { avatar_url: 'dot.png', file_name: id }, tab)).data.slice(1).map(m => m.mes), ['Hi.', 'One.', 'Two.']);
    assert.deepEqual((await postJson('/api/chats/get', { avatar_url: 'dot.png', file_name: id }, newSessionKey())).data.slice(1).map(m => m.mes), ['Hi.', 'One.']);
});

test('an s-id resolves to its session\'s conversation in its tree: opening another tab\'s moves this tab there, never taking it over', async () => {
    await writeCharacter('eva.png', 'Eva');
    const first = newSessionKey();
    const second = newSessionKey();
    const firstId = await openedId('eva.png', first);
    await saveAs('eva.png', first, firstId, [message(false, 'Hi.'), message(true, 'From the first tab.')]);
    // A session's UUID alone (an id an extension stored before) still names that conversation.
    assert.deepEqual((await postJson('/api/chats/get', { avatar_url: 'eva.png', file_name: first }, second)).data.slice(1).map(m => m.mes), ['Hi.', 'From the first tab.']);

    const opened = await postJson('/api/chats/open', { avatar_url: 'eva.png', chat: firstId, make_current: true }, second);
    assert.deepEqual(opened.data.messages.map(m => m.mes), ['Hi.', 'From the first tab.']);
    // The second tab is there in its own session: its own id, no current chat.
    const tree = await treeOf(user.store, { avatar: 'eva.png' });
    assert.equal(opened.data.chat, `s${second}.${tree}`);
    // An id of another tree names nothing here.
    assert.equal((await postJson('/api/chats/get', { avatar_url: 'eva.png', file_name: `s${first}.${tree + 1n}` }, second)).status, 404);
});

after(async () => {
    await user.close();
    setImmediate(() => process.exit(0));
});
