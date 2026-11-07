import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

import express from 'express';

import { write as writeCard } from '../character-card-parser.js';
import '../fetch-patch.js';
import { setConfigFilePath } from '../util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
setConfigFilePath(path.join(__dirname, '..', '..', 'config.yaml'));

const { router } = await import('./chats.js');
const { router: tokenizersRouter } = await import('./tokenizers-current.js');
const { router: avatarsRouter } = await import('./avatars.js');
const { writeAllSettings, readSettingsAtPaths } = await import('../settings-store.js');
const { newSessionKey, chatNameAt, sessionTime } = await import('../chat-engine.js');
const { SESSION_HEADER } = await import('../request-session.js');
const { convertedUser, writeLibraryCard, seedMessages, sessionPath, treeOf, namedChat } = await import('../../tests/converted-user.fixture.js');

const user = await convertedUser('st-chats-open-test-');
const { directories } = user;
globalThis.DATA_ROOT = user.dataRoot;
writeAllSettings(directories, { username: 'Tester' });

const baseImage = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'img', 'ai4.png'));

async function writeCharacter(avatar, name, firstMes, { description = '', alternateGreetings = [] } = {}) {
    const card = {
        spec: 'chara_card_v2', spec_version: '2.0', name, description, personality: '', scenario: '',
        first_mes: firstMes, mes_example: '', avatar,
        data: {
            name, description, personality: '', scenario: '', first_mes: firstMes, mes_example: '',
            system_prompt: '', post_history_instructions: '', character_version: '', creator_notes: '',
            alternate_greetings: alternateGreetings, extensions: {},
        },
    };
    const cardJson = JSON.stringify(card);
    await writeLibraryCard(user, avatar, cardJson, writeCard(baseImage, cardJson));
}

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
    req.user = { directories, profile: { handle: 'u' } };
    next();
});
app.use('/api/chats', router);
app.use('/api/tokenizers', tokenizersRouter);
app.use('/api/avatars', avatarsRouter);
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

async function open(body, tab) {
    const res = await fetch(`${base}/api/chats/open`, { method: 'POST', headers: { 'Content-Type': 'application/json', [SESSION_HEADER]: tab ?? 'none' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
}

const message = (mes, extra = {}) => ({ name: 'Rex', is_user: false, mes, send_date: 1, extra, ...extra });

const conversationOf = (/** @type {string | null} */ character, /** @type {string} */ tab) => chatNameAt({ group: character === null, name: character ?? '' }, /** @type {number} */ (sessionTime(tab)));

/**
 * @param {Record<string, any>} owner
 * @param {string} name
 * @param {Record<string, any>[]} chat
 * @returns {Promise<string>}
 */
async function saveWholeChat(owner, name, chat) {
    const tab = newSessionKey();
    if (!owner.group) {
        await namedChat(user.store, owner, name, chat.slice(1), { session: tab, metadata: chat[0].chat_metadata });
        return tab;
    }
    const res = await fetch(`${base}/api/chats/group/save`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', [SESSION_HEADER]: tab },
        body: JSON.stringify({ id: name, group_id: owner.group, chat }),
    });
    assert.equal(res.status, 200, `saving ${name}`);
    return tab;
}

after(async () => {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    await user.close();
    setImmediate(() => process.exit(0));
});

test('a card nobody has chatted with opens on its greeting, writing only the last opened', async () => {
    await writeCharacter('Fresh.png', 'Fresh', 'Hello there.');
    const first = await open({ avatar_url: 'Fresh.png' });
    assert.equal(first.status, 200);
    assert.match(first.body.chat, /^Fresh - \d{4}-\d{2}-\d{2}@\d{2}h\d{2}m\d{2}s\d{3}ms$/);
    assert.deepEqual(first.body.messages, []);
    assert.equal(first.body.openings.alternatives[0].mes, 'Hello there.');
    assert.equal(fs.existsSync(path.join(directories.chats, 'Fresh')), false, 'no chat folder is created');
    assert.deepEqual(readSettingsAtPaths(directories, ['active_character', 'active_group']), { active_character: 'Fresh.png', active_group: null });
    assert.equal(typeof first.body.settings_hash, 'number', 'the new settings hash comes with a write');
    const again = await open({ avatar_url: 'Fresh.png' });
    assert.equal(again.body.settings_hash, undefined, 'opening it again writes nothing');
    assert.equal(again.body.chat, first.body.chat);
});

test('a character opens on its current chat, a named one, or a new one', async () => {
    await writeCharacter('Rex.png', 'Rex', 'Hi.');
    const owner = { avatar: 'Rex.png' };
    const older = await saveWholeChat(owner, 'older', [{ chat_metadata: { note: 'old' } }, message('Hi, before.'), message('older reply')]);
    const newer = await saveWholeChat(owner, 'newer', [{ chat_metadata: { note: 'new' } }, message('Hi.'), message('newer reply')]);

    const onPointer = await open({ avatar_url: 'Rex.png' }, older);
    assert.equal(onPointer.body.chat, conversationOf('Rex', older));
    assert.deepEqual(onPointer.body.messages.map(m => m.mes), ['Hi, before.', 'older reply']);
    assert.equal(onPointer.body.chat_metadata.note, 'old');

    const stale = await open({ avatar_url: 'Rex.png' }, newSessionKey());
    assert.deepEqual(stale.body.messages.map(m => m.mes).at(-1), 'newer reply', 'the most recently active bookmark');

    const named = await open({ avatar_url: 'Rex.png', chat: 'older' }, newer);
    assert.deepEqual(named.body.messages.map(m => m.mes), ['Hi, before.', 'older reply']);
    assert.equal(named.body.chat, conversationOf('Rex', newer));
    assert.deepEqual((await sessionPath(user.store, owner, newer)).map(m => m.mes), ['Hi.', 'newer reply']);
    const switched = await open({ avatar_url: 'Rex.png', chat: 'older', make_current: true }, newer);
    assert.deepEqual((await sessionPath(user.store, owner, newer)).map(m => m.mes), ['Hi, before.', 'older reply']);
    assert.equal(switched.body.chat, 'older');

    const fresh = await open({ avatar_url: 'Rex.png', fresh: true }, newer);
    assert.equal(fresh.body.chat, switched.body.chat);
    assert.deepEqual(fresh.body.messages, []);
    assert.deepEqual((await sessionPath(user.store, owner, newer)).map(m => m.mes), ['Hi, before.', 'older reply']);
});

test('with no current chat and no bookmark, a character opens on the choices last made', async () => {
    await writeCharacter('Ivy.png', 'Ivy', 'Hey.');
    await writeCharacter('Rex2.png', 'Rex2', 'Hi.');
    const [openingId] = await seedMessages(user.store, { avatar: 'Ivy.png' }, null, [message('Hey.')]);
    await seedMessages(user.store, { avatar: 'Ivy.png' }, openingId, [{ name: 'User', is_user: true, mes: 'Hi Ivy', send_date: 2, extra: {} }]);
    const opened = await open({ avatar_url: 'Ivy.png' });
    assert.deepEqual(opened.body.messages.map(m => m.mes), ['Hey.', 'Hi Ivy']);
    const tree = await treeOf(user.store, { avatar: 'Ivy.png' });
    const session = await user.store.chats.resolveSession({ tree, user: 'u', header: 'none' });
    assert.equal(opened.body.chat, await user.store.chats.conversationName(session.session, session.identifier, tree));
    assert.match(opened.body.chat, /^Ivy - \d{4}-/);

    await user.store.chats.appendMessages({
        tree: await treeOf(user.store, { avatar: 'Ivy.png' }), treeSpeaker: null, after: openingId,
        contents: [{ name: 'User', is_user: true, mes: 'Kept?', send_date: 3, extra: {} }], sendKeys: ['key-stored'], actor: { user: 'u', session: newSessionKey() },
    });
    const asked = await open({ avatar_url: 'Ivy.png', send_keys: ['key-stored', 'key-never-arrived'] });
    assert.deepEqual(asked.body.stored_sends, ['key-stored']);
    const otherOwner = await open({ avatar_url: 'Rex2.png', send_keys: ['key-stored'] });
    assert.deepEqual(otherOwner.body.stored_sends, [], 'another owner\'s key is not this one\'s');
});

test('a group opens on its current chat, or a named one, made current only when asked', async () => {
    await user.store.lib.writeGroup({ id: 'g1', name: 'Band', members: ['Rex.png'] });
    const c1 = newSessionKey();
    await user.store.chats.newChat({ tree: await treeOf(user.store, { group: 'g1' }), actor: { user: 'u', session: c1 }, group: true });
    await user.store.chats.nameSession({ session: c1, name: 'c1', actor: { user: 'u', session: c1 } });
    await saveWholeChat({ group: 'g1' }, 'c2', [{ chat_metadata: {} }, message('group says')]);
    const current = await open({ group_id: 'g1' }, c1);
    assert.equal(current.body.chat, conversationOf(null, c1));
    assert.deepEqual(current.body.messages, [], 'a chat with no messages yet');
    assert.deepEqual(readSettingsAtPaths(directories, ['active_character', 'active_group']), { active_character: null, active_group: 'g1' });

    const named = await open({ group_id: 'g1', chat: 'c2' }, c1);
    assert.deepEqual(named.body.messages.map(m => m.mes), ['group says']);
    const switched = await open({ group_id: 'g1', chat: 'c2', make_current: true }, c1);
    assert.deepEqual(switched.body.messages.map(m => m.mes), ['group says']);
    assert.equal(switched.body.chat, 'c2');
    assert.ok(switched.body.date_last_chat > 5);
});

test('a group opened by a page that does not hold it answers the whole group too, and only when asked', async () => {
    await user.store.lib.writeGroup({ id: 'g2', name: 'Duo', members: ['Rex.png'], disabled_members: [] });
    const tab = newSessionKey();
    const asked = await open({ group_id: 'g2', with_group: true }, tab);
    assert.equal(asked.status, 200);
    assert.equal(asked.body.group.id, 'g2');
    assert.equal(asked.body.group.name, 'Duo');
    assert.deepEqual(asked.body.group.members, ['Rex.png']);
    assert.equal(asked.body.group.chat_id, asked.body.chat);
    assert.deepEqual(asked.body.group.chats, asked.body.chats);
    assert.equal((await open({ group_id: 'g2' }, tab)).body.group, undefined);
});

test('unknown owners are 404', async () => {
    assert.equal((await open({ avatar_url: 'Nobody.png' })).status, 404);
    assert.equal((await open({ group_id: 'nope' })).status, 404);
});

/**
 * @param {string} route
 * @param {'GET'|'POST'} method
 * @param {object} [body]
 */
async function answerOf(route, method, body) {
    const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json', 'X-ST-Session': 'none' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal(res.status, 200, route);
    return res.json();
}

test('a character opened by a page that does not hold it answers the whole card too, and only when asked', async () => {
    await writeCharacter('Card.png', 'Card', 'Hi from Card.', { description: 'About Card.' });
    const asked = await open({ avatar_url: 'Card.png', with_character: true });
    assert.equal(asked.status, 200);
    assert.equal(asked.body.character.avatar, 'Card.png');
    assert.equal(asked.body.character.description, 'About Card.');
    assert.equal((await open({ avatar_url: 'Card.png' })).body.character, undefined);
});

test('an open answers each part the page asked for, the same as the part\'s own route would, and no other', async () => {
    await writeCharacter('Parts.png', 'Parts', 'Hello, {{user}}.', { description: 'I am {{char}}.', alternateGreetings: ['Second\r\ngreeting.'] });
    const tokenizer = { api: 'textgenerationwebui', type: 'ooba', url: '', model: '', tokenizerSetting: 1 };

    const opened = await open({ avatar_url: 'Parts.png', parts: { card_token_counts: { tokenizer, macro_facts: {} }, personas: {}, unknown: {} } });
    assert.equal(opened.status, 200);
    const { parts } = opened.body;
    assert.deepEqual(Object.keys(parts).sort(), ['card_token_counts', 'personas']);

    const texts = ['Parts', 'I am Parts.', '', '', '', '', '', '', 'Hello, Tester.', 'Second\ngreeting.'];
    const counted = await answerOf('/api/tokenizers/current/count', 'POST', { state: tokenizer, texts, padding: 0 });
    assert.deepEqual(parts.card_token_counts.counts, counted.counts);
    assert.deepEqual(parts.card_token_counts.state, tokenizer);
    assert.equal(parts.card_token_counts.avatar, 'Parts.png');
    assert.deepEqual(parts.card_token_counts.tokenizer, counted.tokenizer);

    assert.deepEqual(parts.personas, await answerOf('/api/avatars/get', 'POST'));

    await user.store.lib.writeGroup({ id: 'g3', name: 'Trio', members: ['Parts.png', 'Rex.png'], disabled_members: [] });
    const group = await open({ group_id: 'g3', parts: { card_token_counts: { tokenizer }, personas: {} } });
    assert.deepEqual(Object.keys(group.body.parts), ['personas'], 'a group\'s open has no card to count');
    assert.deepEqual((await open({ avatar_url: 'Parts.png' })).body.parts, {});
});
