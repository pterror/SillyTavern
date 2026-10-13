import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';

import '../fetch-patch.js';
import { setConfigFilePath } from '../util.js';

setConfigFilePath(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'config.yaml'));

// Prompt itemizations are kept per message: recorded with the reply, flagged on loaded messages, read one at a time.

const { router } = await import('./itemized-prompts.js');
const { persistAssistantReply } = await import('../assistant-reply-persist.js');
const { itemizationOf } = await import('../itemization-of.js');
const { encodeStoredReplyFrame } = await import('./backends/llamacpp-compact-stream.js');
const { newSessionKey } = await import('../chat-engine.js');
// The flag a loaded message carries when it has an itemization.
const ITEMIZED_PROMPT_FLAG = 'has_itemized_prompt';
const { RequestSession } = await import('../request-session.js');
const { convertedUser, treeOf, seedMessages } = await import('../../tests/converted-user.fixture.js');

/** @type {Awaited<ReturnType<typeof convertedUser>>} */
let user;
/** @type {import('node:http').Server} */
let server;
let base = '';

before(async () => {
    user = await convertedUser('st-itemized-prompts-test-');
    const app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use((req, _res, next) => {
        req.user = user.user;
        next();
    });
    app.use('/api/itemized-prompts', router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
});

after(async () => {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    await user.close();
});

async function post(route, body) {
    const res = await fetch(`${base}/api/itemized-prompts/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
}

const reply = (mes) => ({ name: 'Alice', is_user: false, mes, send_date: 1, extra: {} });
const said = (mes) => ({ name: 'You', is_user: true, mes, send_date: 1, extra: {} });
const alice = { avatar: 'Alice.png' };

/**
 * A chat of Alice's, through a session of its own: greeting, user, reply, user, reply.
 * @param {string} label Makes the texts the chat's own.
 */
async function makeChat(label) {
    const session = newSessionKey();
    const ids = await seedMessages(user.store, alice, null, [
        reply(`${label} hello`), said(`${label} one`), reply(`${label} two`), said(`${label} three`), reply(`${label} four`),
    ], { session });
    return { ids, session };
}

/** The chat context a reply is stored through. */
async function chatOf(session = newSessionKey()) {
    const tree = await treeOf(user.store, alice);
    const treeSpeaker = (await user.store.people.byAvatar([alice.avatar])).get(alice.avatar) ?? null;
    return { store: user.store, tree, treeSpeaker, session: new RequestSession(session, 'u', { session, identifier: session }) };
}

const record = (nodeId, entry) => user.store.chats.recordItemization({ node_id: nodeId, entry });

describe('recording and reading one message', () => {
    test('a stored reply records the itemization sent with it, the server\'s breakdown taking precedence', async () => {
        const { ids } = await makeChat('Recorded');
        const itemization = itemizationOf({ presetName: 'P', rawPrompt: 'page', mesId: 7 }, { rawPrompt: 'server prompt', finalPrompt: 'f' });
        const persisted = await persistAssistantReply({
            chat: await chatOf(), anchorNodeId: ids[4], name2: 'Alice', isSwipe: false, isContinue: false, anchorContent: null,
            warnings: [], itemization,
        }, 'a new reply');
        assert.ok(persisted?.node_id);

        const read = await post('message', { node_id: persisted.node_id });
        assert.equal(read.status, 200);
        assert.deepEqual(read.body.entry, { presetName: 'P', rawPrompt: 'server prompt', finalPrompt: 'f' }, 'no mesId is stored');
        assert.equal(read.body.previous_node_id, null, 'nothing above it has a raw prompt');
    });

    test('an itemization that can\'t be stored leaves the reply stored and says so, to a stream too', async () => {
        const { ids } = await makeChat('Unstorable');
        const pending = {
            chat: await chatOf(), anchorNodeId: ids[4], name2: 'Alice', isSwipe: false, isContinue: false, anchorContent: null,
            warnings: [], itemization: { rawPrompt: 1n },
        };
        const persisted = await persistAssistantReply(pending, 'kept anyway');
        assert.ok(persisted?.node_id);
        assert.deepEqual(pending.warnings.map(w => w.kind), ['itemization-not-saved']);
        const withWarning = encodeStoredReplyFrame(persisted, pending);
        const nodeOnly = encodeStoredReplyFrame(persisted, null);
        assert.ok(withWarning.length > nodeOnly.length && withWarning.subarray(0, nodeOnly.length).equals(nodeOnly));
        assert.ok(withWarning.includes(Buffer.from('itemization-not-saved')));
    });

    test('a message without one answers 404', async () => {
        const { ids } = await makeChat('Without');
        assert.equal((await post('message', { node_id: ids[2] })).status, 404);
        assert.equal((await post('message', {})).status, 400);
    });

    test('the previous one is the nearest message above holding a raw prompt', async () => {
        const { ids } = await makeChat('Previous');
        await record(ids[0], { rawPrompt: 'first' });
        await record(ids[2], { presetName: 'no prompt here' });
        await record(ids[4], { rawPrompt: 'third' });
        assert.equal((await post('message', { node_id: ids[4] })).body.previous_node_id, ids[0]);
        assert.equal((await post('message', { node_id: ids[2] })).body.previous_node_id, ids[0]);
        assert.equal((await post('message', { node_id: ids[0] })).body.previous_node_id, null);
    });

    test('recording the same itemization again writes nothing', async () => {
        const { ids } = await makeChat('Same');
        assert.equal(await record(ids[2], { rawPrompt: 'x', mesId: 2 }), 'written');
        assert.equal(await record(ids[2], { rawPrompt: 'x' }), 'unchanged');
        assert.equal(await record('no-such-node', { rawPrompt: 'x' }), 'no-message');
    });
});

describe('the flag on loaded messages', () => {
    test('a loaded chat flags its itemized messages and alternatives', async () => {
        const { ids } = await makeChat('Flags');
        const [alt] = await seedMessages(user.store, alice, ids[1], [reply('Flags two, again')]);
        await record(ids[2], { rawPrompt: 'a' });
        await record(alt, { rawPrompt: 'b' });

        const loaded = await user.store.chats.load({ tree: await treeOf(user.store, alice), at: ids[4] });
        const flagOf = (/** @type {any} */ m) => m?.extra?.[ITEMIZED_PROMPT_FLAG] === true;
        assert.deepEqual(loaded.messages.map(flagOf), [false, false, true, false, false]);
        assert.deepEqual(loaded.messages[2].swipe_info.map(flagOf), [true, true]);
    });

    test('the flag is never stored in a message', async () => {
        const { ids } = await makeChat('Stored');
        await record(ids[2], { rawPrompt: 'a' });
        const tree = await treeOf(user.store, alice);
        const loaded = await user.store.chats.load({ tree, at: ids[4] });
        const { storedForm } = await import('../chat-engine.js');
        const edited = await user.store.chats.editMessages({
            tree, treeSpeaker: null, edits: [{ node_id: ids[2], content: storedForm({ ...loaded.messages[2], mes: 'Stored two, edited' }) }], actor: { user: 'u', session: newSessionKey() },
        });
        assert.deepEqual(edited.refused, []);
        const stored = await user.store.chats.messageOf(tree, ids[2]);
        const [content] = await user.store.chats.decoded([stored]);
        assert.equal(content.extra?.[ITEMIZED_PROMPT_FLAG], undefined);
    });
});

describe('the routes behind upstream\'s exports', () => {
    test('/chat answers a chat\'s itemizations by position, or its node ids', async () => {
        const { ids, session } = await makeChat('Whole');
        await record(ids[2], { rawPrompt: 'two' });
        await record(ids[4], { rawPrompt: 'four' });
        const whole = await post('chat', { avatar_url: 'Alice.png', chat: session });
        assert.deepEqual(whole.body.entries, [
            { index: 2, node_id: ids[2], entry: { rawPrompt: 'two' } },
            { index: 4, node_id: ids[4], entry: { rawPrompt: 'four' } },
        ]);
        assert.deepEqual((await post('chat', { avatar_url: 'Alice.png', chat: session, ids_only: true })).body.node_ids, ids);
        assert.equal((await post('chat', { avatar_url: 'Alice.png', chat: 'Nope' })).status, 404);
        assert.equal((await post('chat', { avatar_url: 'Bob.png', chat: session })).status, 404, 'a chat of another tree');
        assert.equal((await post('chat', { avatar_url: 'Someone.png', chat: session })).status, 404, 'no such character');
        assert.equal((await post('chat', { avatar_url: 'Alice.png' })).status, 400);
    });

    test('/set replaces entries and merges fields, writing only what changed', async () => {
        const { ids } = await makeChat('Set');
        await record(ids[2], { rawPrompt: 'old', presetName: 'P' });
        const first = await post('set', { items: [
            { node_id: ids[2], fields: { rawPrompt: 'new' } },
            { node_id: ids[4], entry: { rawPrompt: 'four' } },
            { node_id: ids[1], fields: { rawPrompt: 'x' } },
        ] });
        assert.deepEqual(first.body, { written: [ids[2], ids[4]], unchanged: [], missing: [ids[1]] });
        assert.deepEqual((await post('message', { node_id: ids[2] })).body.entry, { rawPrompt: 'new', presetName: 'P' });
        const again = await post('set', { items: [{ node_id: ids[2], fields: { rawPrompt: 'new' } }, { node_id: ids[4], entry: { rawPrompt: 'four' } }] });
        assert.deepEqual(again.body, { written: [], unchanged: [ids[2], ids[4]], missing: [] });
        assert.equal((await post('set', { items: [{ node_id: ids[2], entry: {}, fields: {} }] })).status, 400);
    });

    test('/delete removes a chat\'s itemizations, /clear all of them', async () => {
        const { ids, session } = await makeChat('Gone');
        await record(ids[2], { rawPrompt: 'two' });
        await record(ids[4], { rawPrompt: 'four' });
        assert.deepEqual((await post('delete', { avatar_url: 'Alice.png', chat: session })).body, { removed: 2 });
        assert.equal((await post('message', { node_id: ids[2] })).status, 404);

        const other = await makeChat('Kept');
        await record(other.ids[2], { rawPrompt: 'two' });
        assert.equal((await post('clear', {})).status, 200);
        assert.equal((await post('message', { node_id: other.ids[2] })).status, 404);
    });
});
