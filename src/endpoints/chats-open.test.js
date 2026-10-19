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

// POST /api/chats/open: one request opens a character's or group's conversation. The server resolves which one,
// writes only what changed (the tab's session when asked to make a chat current, and which character or group was
// opened last), and never mints a chat name or creates a chat folder.

const { router } = await import('./chats.js');
const { writeAllSettings, readSettingsAtPaths } = await import('../settings-store.js');
const { newSessionKey, defaultSessionKey } = await import('../chat-engine.js');
const { SESSION_HEADER } = await import('../request-session.js');
const { convertedUser, writeLibraryCard, seedMessages, sessionPath, treeOf } = await import('../../tests/converted-user.fixture.js');

const user = await convertedUser('st-chats-open-test-');
const { directories } = user;
globalThis.DATA_ROOT = user.dataRoot;
writeAllSettings(directories, { username: 'Tester' });

const baseImage = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'img', 'ai4.png'));

async function writeCharacter(avatar, name, firstMes) {
    const card = {
        spec: 'chara_card_v2', spec_version: '2.0', name, description: '', personality: '', scenario: '',
        first_mes: firstMes, mes_example: '', avatar,
        data: {
            name, description: '', personality: '', scenario: '', first_mes: firstMes, mes_example: '',
            system_prompt: '', post_history_instructions: '', character_version: '', creator_notes: '',
            alternate_greetings: [], extensions: {},
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
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

async function open(body, tab) {
    const res = await fetch(`${base}/api/chats/open`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tab ? { [SESSION_HEADER]: tab } : {}) }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
}

const message = (mes, extra = {}) => ({ name: 'Rex', is_user: false, mes, send_date: 1, extra, ...extra });

/**
 * A chat as a tab saves it: stored through a session of its own, named `name`; `chat` is `[header, ...messages]`.
 * @param {Record<string, any>} owner
 * @param {string} name
 * @param {Record<string, any>[]} chat
 * @returns {Promise<string>} The tab's session.
 */
async function saveWholeChat(owner, name, chat) {
    const tab = newSessionKey();
    const res = await fetch(`${base}/api/chats/${owner.group ? 'group/save' : 'save'}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', [SESSION_HEADER]: tab },
        body: JSON.stringify(owner.group ? { id: name, group_id: owner.group, chat } : { avatar_url: owner.avatar, file_name: name, chat }),
    });
    assert.equal(res.status, 200, `saving ${name}`);
    return tab;
}

after(async () => {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    await user.close();
    // The settings autosave backup is throttled with a timer that would hold the process open.
    setImmediate(() => process.exit(0));
});

// A card nobody has chatted with: its greeting, no conversation, nothing written but "last opened".
test('a card nobody has chatted with opens on its greeting, writing only the last opened', async () => {
    await writeCharacter('Fresh.png', 'Fresh', 'Hello there.');
    const first = await open({ avatar_url: 'Fresh.png' });
    assert.equal(first.status, 200);
    // A caller with no tab and no session there: the user's deterministic session's conversation in the tree, derived,
    // not stored; named after the character.
    const freshTree = await treeOf(user.store, { avatar: 'Fresh.png' });
    assert.equal(first.body.chat, `s${defaultSessionKey('u', freshTree)}.${freshTree}`);
    assert.equal(first.body.label_base, 'Fresh');
    assert.deepEqual(first.body.messages, []);
    assert.equal(first.body.openings.alternatives[0].mes, 'Hello there.');
    assert.equal(fs.existsSync(path.join(directories.chats, 'Fresh')), false, 'no chat folder is created');
    assert.deepEqual(readSettingsAtPaths(directories, ['active_character', 'active_group']), { active_character: 'Fresh.png', active_group: null });
    assert.equal(typeof first.body.settings_hash, 'number', 'the new settings hash comes with a write');
    const again = await open({ avatar_url: 'Fresh.png' });
    assert.equal(again.body.settings_hash, undefined, 'opening it again writes nothing');
});

// The chat the tab is on; a stale one falls to the most recently active bookmark.
test('a character opens on its current chat, a named one, or a new one', async () => {
    await writeCharacter('Rex.png', 'Rex', 'Hi.');
    const owner = { avatar: 'Rex.png' };
    const older = await saveWholeChat(owner, 'older', [{ chat_metadata: { note: 'old' } }, message('Hi, before.'), message('older reply')]);
    const newer = await saveWholeChat(owner, 'newer', [{ chat_metadata: { note: 'new' } }, message('Hi.'), message('newer reply')]);

    const tree = await treeOf(user.store, owner);
    const onPointer = await open({ avatar_url: 'Rex.png' }, older);
    // No current chat: the tab's own conversation (`older` is a bookmark where it is, never opened).
    assert.equal(onPointer.body.chat, `s${older}.${tree}`);
    assert.deepEqual(onPointer.body.messages.map(m => m.mes), ['Hi, before.', 'older reply']);
    assert.equal(onPointer.body.chat_metadata.note, 'old');

    const stale = await open({ avatar_url: 'Rex.png' }, newSessionKey());
    assert.deepEqual(stale.body.messages.map(m => m.mes).at(-1), 'newer reply', 'the most recently active bookmark');

    // Naming a chat opens it; the tab moves there only when asked.
    const named = await open({ avatar_url: 'Rex.png', chat: 'older' }, newer);
    assert.deepEqual(named.body.messages.map(m => m.mes), ['Hi, before.', 'older reply']);
    assert.equal(named.body.chat, `s${newer}.${tree}`);
    assert.deepEqual((await sessionPath(user.store, owner, newer)).map(m => m.mes), ['Hi.', 'newer reply']);
    const switched = await open({ avatar_url: 'Rex.png', chat: 'older', make_current: true }, newer);
    assert.deepEqual((await sessionPath(user.store, owner, newer)).map(m => m.mes), ['Hi, before.', 'older reply']);
    // Opened by name, the bookmark is the tab's current chat.
    assert.match(switched.body.chat, /^b\d+$/);
    assert.equal(switched.body.label_base, 'older');

    // A new chat's greetings only (the page's /new switches the chat after).
    const fresh = await open({ avatar_url: 'Rex.png', fresh: true }, newer);
    assert.equal(fresh.body.chat, switched.body.chat);
    assert.deepEqual(fresh.body.messages, []);
    assert.deepEqual((await sessionPath(user.store, owner, newer)).map(m => m.mes), ['Hi, before.', 'older reply']);
});

// No pointer and no bookmark: the choices last made from the first message.
test('with no current chat and no bookmark, a character opens on the choices last made', async () => {
    await writeCharacter('Ivy.png', 'Ivy', 'Hey.');
    await writeCharacter('Rex2.png', 'Rex2', 'Hi.');
    const [openingId] = await seedMessages(user.store, { avatar: 'Ivy.png' }, null, [message('Hey.')]);
    await seedMessages(user.store, { avatar: 'Ivy.png' }, openingId, [{ name: 'User', is_user: true, mes: 'Hi Ivy', send_date: 2, extra: {} }]);
    const opened = await open({ avatar_url: 'Ivy.png' });
    assert.deepEqual(opened.body.messages.map(m => m.mes), ['Hey.', 'Hi Ivy']);
    // A caller with no tab: the user's last session in the tree, else the deterministic one.
    const tree = await treeOf(user.store, { avatar: 'Ivy.png' });
    assert.equal(opened.body.chat, `s${(await user.store.chats.resolveSession({ tree, user: 'u', header: undefined })).identifier}.${tree}`);

    // Of the send keys the page kept, the ones stored for this character are named.
    await user.store.chats.appendMessages({
        tree: await treeOf(user.store, { avatar: 'Ivy.png' }), treeSpeaker: null, after: openingId,
        contents: [{ name: 'User', is_user: true, mes: 'Kept?', send_date: 3, extra: {} }], sendKeys: ['key-stored'], actor: { user: 'u', session: newSessionKey() },
    });
    const asked = await open({ avatar_url: 'Ivy.png', send_keys: ['key-stored', 'key-never-arrived'] });
    assert.deepEqual(asked.body.stored_sends, ['key-stored']);
    const otherOwner = await open({ avatar_url: 'Rex2.png', send_keys: ['key-stored'] });
    assert.deepEqual(otherOwner.body.stored_sends, [], 'another owner\'s key is not this one\'s');
});

// A group: its current chat, or a named one, made current only when asked.
test('a group opens on its current chat, or a named one, made current only when asked', async () => {
    await user.store.lib.writeGroup({ id: 'g1', name: 'Band', members: ['Rex.png'] });
    const c1 = newSessionKey();
    await user.store.chats.newChat({ tree: await treeOf(user.store, { group: 'g1' }), actor: { user: 'u', session: c1 }, group: true });
    await user.store.chats.nameSession({ session: c1, name: 'c1', actor: { user: 'u', session: c1 } });
    await saveWholeChat({ group: 'g1' }, 'c2', [{ chat_metadata: {} }, message('group says')]);
    const groupTree = await treeOf(user.store, { group: 'g1' });
    const current = await open({ group_id: 'g1' }, c1);
    // No current chat: the session's conversation in the tree, named or not; its names start from the session's label.
    assert.equal(current.body.chat, `s${c1}.${groupTree}`);
    assert.equal(current.body.label_base, 'c1');
    assert.deepEqual(current.body.messages, [], 'a chat with no messages yet');
    assert.deepEqual(readSettingsAtPaths(directories, ['active_character', 'active_group']), { active_character: null, active_group: 'g1' });

    const named = await open({ group_id: 'g1', chat: 'c2' }, c1);
    assert.deepEqual(named.body.messages.map(m => m.mes), ['group says']);
    const switched = await open({ group_id: 'g1', chat: 'c2', make_current: true }, c1);
    // The tab's session (named `c1`) moved to bookmark `c2`'s message, now its current chat.
    assert.deepEqual(switched.body.messages.map(m => m.mes), ['group says']);
    assert.match(switched.body.chat, /^b\d+$/);
    assert.equal(switched.body.label_base, 'c2');
    assert.ok(switched.body.date_last_chat > 5);
});

test('unknown owners are 404', async () => {
    assert.equal((await open({ avatar_url: 'Nobody.png' })).status, 404);
    assert.equal((await open({ group_id: 'nope' })).status, 404);
});
