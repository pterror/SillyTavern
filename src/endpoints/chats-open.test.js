import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';

import { write as writeCard } from '../character-card-parser.js';
import '../fetch-patch.js';
import { setConfigFilePath } from '../util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
setConfigFilePath(path.join(__dirname, '..', '..', 'config.yaml'));

// POST /api/chats/open: one request opens a character's or group's conversation. The server resolves which one,
// writes only what changed (the current chat when asked to make one current, and which character or group was
// opened last), and never mints a chat name or creates a chat folder.

const { router } = await import('./chats.js');
const { writeAllSettings, readSettingsAtPaths } = await import('../settings-store.js');
const { upsertCharacterFromWrite, getCharacterActiveChatsByIds, setCharacterActiveChat } = await import('../character-metadata-db.js');
const { saveChatToTree, addOpeningAlternatives, appendMessages, selectDefaultChild } = await import('../message-tree-db.js');
const { writeGroupFile, readGroupFile } = await import('./groups.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-chats-open-test-'));
const directories = { root };
for (const dir of ['characters', 'groups', 'worlds', 'files', 'chats']) {
    directories[dir] = path.join(root, dir);
    fs.mkdirSync(directories[dir], { recursive: true });
}
globalThis.DATA_ROOT = root;
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
    fs.writeFileSync(path.join(directories.characters, avatar), writeCard(baseImage, cardJson));
    await upsertCharacterFromWrite(directories, avatar, cardJson);
}

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
    req.user = { directories, profile: { handle: 'tester' } };
    next();
});
app.use('/api/chats', router);
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

async function open(body) {
    const res = await fetch(`${base}/api/chats/open`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
}

const message = (mes, extra = {}) => ({ name: 'Rex', is_user: false, mes, send_date: 1, extra, ...extra });

async function pointerOf(avatar) {
    return (await getCharacterActiveChatsByIds(directories, [avatar]))[avatar] ?? null;
}

try {
    // A card nobody has chatted with: its greeting, no conversation, nothing written but "last opened".
    {
        await writeCharacter('Fresh.png', 'Fresh', 'Hello there.');
        const first = await open({ avatar_url: 'Fresh.png' });
        assert.equal(first.status, 200);
        assert.equal(first.body.chat, '', 'no chat name is minted');
        assert.deepEqual(first.body.messages, []);
        assert.equal(first.body.openings.alternatives[0].mes, 'Hello there.');
        assert.equal(fs.existsSync(path.join(directories.chats, 'Fresh')), false, 'no chat folder is created');
        assert.equal(await pointerOf('Fresh.png'), null, 'the pointer stays unset');
        assert.deepEqual(readSettingsAtPaths(directories, ['active_character', 'active_group']), { active_character: 'Fresh.png', active_group: null });
        assert.equal(typeof first.body.settings_hash, 'number', 'the new settings hash comes with a write');
        const again = await open({ avatar_url: 'Fresh.png' });
        assert.equal(again.body.settings_hash, undefined, 'opening it again writes nothing');
    }

    // The chat the character is on; a stale one falls to its most recently active bookmark.
    {
        await writeCharacter('Rex.png', 'Rex', 'Hi.');
        await saveChatToTree(directories, 'Rex', 'older', [{ chat_metadata: { note: 'old' } }, message('Hi, before.'), message('older reply')]);
        await saveChatToTree(directories, 'Rex', 'newer', [{ chat_metadata: { note: 'new' } }, message('Hi.'), message('newer reply')]);
        await setCharacterActiveChat(directories, 'Rex.png', 'older');

        const onPointer = await open({ avatar_url: 'Rex.png' });
        assert.equal(onPointer.body.chat, 'older');
        assert.deepEqual(onPointer.body.messages.map(m => m.mes), ['Hi, before.', 'older reply']);
        assert.equal(onPointer.body.chat_metadata.note, 'old');

        await setCharacterActiveChat(directories, 'Rex.png', 'gone');
        const stale = await open({ avatar_url: 'Rex.png' });
        assert.deepEqual(stale.body.messages.map(m => m.mes).at(-1), 'newer reply', 'the most recently active bookmark');
        assert.equal(await pointerOf('Rex.png'), 'gone', 'resolving a stale pointer writes nothing');

        // Naming a chat opens it; it becomes current only when asked.
        const named = await open({ avatar_url: 'Rex.png', chat: 'older' });
        assert.equal(named.body.chat, 'older');
        assert.equal(await pointerOf('Rex.png'), 'gone');
        await open({ avatar_url: 'Rex.png', chat: 'older', make_current: true });
        assert.equal(await pointerOf('Rex.png'), 'older');

        // A new chat: only the greetings.
        const fresh = await open({ avatar_url: 'Rex.png', fresh: true });
        assert.equal(fresh.body.chat, '');
        assert.deepEqual(fresh.body.messages, []);
        assert.equal(await pointerOf('Rex.png'), 'older');
    }

    // No pointer and no bookmark: the choices last made from the first message.
    {
        await writeCharacter('Ivy.png', 'Ivy', 'Hey.');
        const made = await addOpeningAlternatives(directories, 'Ivy', [message('Hey.')]);
        const openingId = made.node_ids[0];
        await selectDefaultChild(directories, openingId);
        await appendMessages(directories, 'Ivy', openingId, [{ name: 'User', is_user: true, mes: 'Hi Ivy', send_date: 2, extra: {} }]);
        const opened = await open({ avatar_url: 'Ivy.png' });
        assert.deepEqual(opened.body.messages.map(m => m.mes), ['Hey.', 'Hi Ivy']);
        assert.equal(opened.body.chat, openingId);

        // Of the send keys the page kept, the ones stored for this character are named.
        await appendMessages(directories, 'Ivy', openingId, [{ name: 'User', is_user: true, mes: 'Kept?', send_date: 3, extra: {} }], { sendKeys: ['key-stored'] });
        const asked = await open({ avatar_url: 'Ivy.png', send_keys: ['key-stored', 'key-never-arrived'] });
        assert.deepEqual(asked.body.stored_sends, ['key-stored']);
        const otherOwner = await open({ avatar_url: 'Rex.png', send_keys: ['key-stored'] });
        assert.deepEqual(otherOwner.body.stored_sends, [], 'another owner\'s key is not this one\'s');
    }

    // A group: its current chat, or a named one, made current only when asked.
    {
        await writeGroupFile(directories, { id: 'g1', name: 'Band', members: ['Rex.png'], chats: ['c1', 'c2'], chat_id: 'c1', date_last_chat: 5 });
        await saveChatToTree(directories, 'g1', 'c2', [{ chat_metadata: {} }, message('group says')], true);
        const current = await open({ group_id: 'g1' });
        assert.equal(current.body.chat, 'c1');
        assert.deepEqual(current.body.messages, [], 'a chat with no messages yet');
        assert.deepEqual(readSettingsAtPaths(directories, ['active_character', 'active_group']), { active_character: null, active_group: 'g1' });

        const named = await open({ group_id: 'g1', chat: 'c2' });
        assert.deepEqual(named.body.messages.map(m => m.mes), ['group says']);
        assert.equal(readGroupFile(directories, 'g1').chat_id, 'c1');
        const switched = await open({ group_id: 'g1', chat: 'c2', make_current: true });
        assert.equal(switched.body.chat, 'c2');
        assert.equal(readGroupFile(directories, 'g1').chat_id, 'c2');
        assert.ok(readGroupFile(directories, 'g1').date_last_chat > 5);
    }

    // Unknown owners.
    assert.equal((await open({ avatar_url: 'Nobody.png' })).status, 404);
    assert.equal((await open({ group_id: 'nope' })).status, 404);

    console.log('chats-open.test.js: all assertions passed');
} finally {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
}
// The settings autosave backup is throttled with a timer that would hold the process open.
process.exit(0);
