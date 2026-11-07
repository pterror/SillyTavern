import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

import express from 'express';

import { setConfigFilePath } from '../util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
setConfigFilePath(path.join(__dirname, '..', '..', 'config.yaml'));

const { router: chatsRouter } = await import('./chats.js');
const { newSessionKey } = await import('../chat-engine.js');
const { SESSION_HEADER } = await import('../request-session.js');
const { convertedUser, sessionPath, treeOf } = await import('../../tests/converted-user.fixture.js');

const user = await convertedUser('st-chats-save-compat-test-');
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

let groups = 0;

async function writeGroup() {
    const id = String(1_700_000_000_000 + groups++);
    await user.store.lib.writeGroup({ id, name: `Group ${id}`, members: [] });
    return id;
}

const save = (/** @type {string} */ group, /** @type {string} */ name, /** @type {any[]} */ chat, /** @type {string} */ tab) => postJson('/api/chats/group/save', { id: name, group_id: group, chat }, tab);

const header = metadata => ({ chat_metadata: metadata, user_name: 'User', character_name: 'Pia' });

test('an edited message is stored on its id; a message added without an id goes after the stored one before it', async () => {
    const group = await writeGroup();
    const tab = newSessionKey();
    const saved = await save(group, 'Talk', [header({ note_prompt: 'x' }), { name: 'Pia', is_user: false, mes: 'One.', send_date: 'x', extra: {} }], tab);
    const [first] = await sessionPath(user.store, { group }, tab);
    const integrity = saved.data.integrity;

    const { status, data } = await save(group, 'Talk', [header({ note_prompt: 'x', integrity }), { ...first, mes: 'One, edited.' }, { name: 'Narrator', is_user: false, mes: 'Added.', send_date: 'x', extra: {} }], tab);
    assert.equal(status, 200);
    assert.equal(data.integrity, integrity);
    assert.equal(data.not_saved, undefined);
    const after = await sessionPath(user.store, { group }, tab);
    assert.deepEqual(after.map(m => m.mes), ['One, edited.', 'Added.']);
    assert.equal(after[0].node_id, first.node_id, 'the edit landed on the same message');
});

test('an alternative is edited by its own id; one whose shown slot names another message, or with no id, is not saved', async () => {
    const group = await writeGroup();
    const tab = newSessionKey();
    await save(group, 'Swipes', [header({}), { name: 'Rho', is_user: false, mes: 'A.', send_date: 'x', extra: {}, swipes: ['A.', 'B.'], swipe_id: 0, swipe_info: [{}, {}] }], tab);
    const [loaded] = await sessionPath(user.store, { group }, tab);
    const b = loaded.swipes.indexOf('B.');
    assert.deepEqual(loaded.swipes.slice(b - 1), ['A.', 'B.']);
    const otherId = loaded.swipe_info[b].node_id;
    const mesOf = async () => (await user.store.chats.alternatives({ node_id: otherId })).alternatives.map(a => a.mes).slice(b - 1);

    const edited = await save(group, 'Swipes', [header({}), {
        ...loaded, swipes: [...loaded.swipes.slice(0, b), 'B, edited.', 'C.'],
        swipe_info: [...loaded.swipe_info.slice(0, b), { ...loaded.swipe_info[b], extra: { note: 1 } }, { send_date: 'x', extra: {} }],
    }], tab);
    assert.equal(edited.status, 200);
    assert.deepEqual(edited.data.not_saved, [{ index: 0, swipe: b + 1, reason: 'no id' }]);
    assert.deepEqual(await mesOf(), ['A.', 'B, edited.']);
    assert.equal((await user.store.chats.alternatives({ node_id: otherId })).alternatives[b].extra.note, 1);

    const ambiguous = await save(group, 'Swipes', [header({}), { ...loaded, mes: 'Which?', swipe_id: b }], tab);
    assert.deepEqual(ambiguous.data.not_saved, [{ index: 0, reason: 'the shown swipe names another message' }]);
    assert.deepEqual(await mesOf(), ['A.', 'B, edited.']);
});

test('a save named by a message id makes a bookmark of that name there', async () => {
    const group = await writeGroup();
    const tab = newSessionKey();
    await save(group, 'Greeting', [header({}), { name: 'Qin', is_user: false, mes: 'Hi.', send_date: 'x', extra: {} }], tab);
    const [{ node_id: nodeId }] = await sessionPath(user.store, { group }, tab);

    const again = await save(group, nodeId, [header({ note_prompt: 'kept' }), { name: 'Qin', is_user: false, mes: 'Hi.', send_date: 'x', extra: {}, node_id: nodeId }], tab);
    assert.equal(again.status, 200);
    const tree = await treeOf(user.store, { group });
    const atNode = await user.store.chats.load({ tree, at: nodeId });
    assert.equal(atNode?.metadata.note_prompt, 'kept');
    const named = (await user.store.chats.bookmarks({ tree, limit: 500 })).rows.filter(b => b.at === nodeId);
    assert.deepEqual(named.map(b => b.name).sort(), ['Greeting', nodeId].sort());
    assert.equal((await sessionPath(user.store, { group }, tab)).length, 1);
});

after(async () => {
    await user.close();
    setImmediate(() => process.exit(0));
});
