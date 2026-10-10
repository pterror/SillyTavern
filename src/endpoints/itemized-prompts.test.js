import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';

import express from 'express';

import '../fetch-patch.js';

// Prompt itemizations are kept per message: recorded with the reply, flagged on loaded messages, read one at a time,
// and removed with their message.

const { router } = await import('./itemized-prompts.js');
const tree = await import('../message-tree-db.js');
const { persistAssistantReply } = await import('../assistant-reply-persist.js');
const { itemizationOf, recordItemization } = await import('../itemization-store.js');
const { encodeStoredReplyFrame } = await import('./backends/llamacpp-compact-stream.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-itemized-prompts-test-'));
const directories = { root };

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use((req, _res, next) => {
    req.user = { directories };
    next();
});
app.use('/api/itemized-prompts', router);
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

after(() => {
    server.close();
    tree.disposeMessageTreeStores();
    fs.rmSync(root, { recursive: true, force: true });
});

async function post(route, body) {
    const res = await fetch(`${base}/api/itemized-prompts/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
}

const reply = (mes) => ({ name: 'Rex', is_user: false, mes, send_date: 1, extra: {} });
const user = (mes) => ({ name: 'You', is_user: true, mes, send_date: 1, extra: {} });

/** A chat of `owner`: greeting, user, reply, user, reply; labelled `label`. */
async function makeChat(owner, label) {
    const anchor = await tree.getOrCreateAnchor(directories, owner);
    const { node_ids: ids } = await tree.appendMessages(directories, owner, anchor, [
        reply(`${label} hello`), user(`${label} one`), reply(`${label} two`), user(`${label} three`), reply(`${label} four`),
    ]);
    await tree.labelNode(directories, ids[0], label, { ownerId: owner });
    return ids;
}

const db = await tree.getMessageTreeDb(directories);
const rowCount = () => db.get('SELECT COUNT(*) AS n FROM itemizations').n;

describe('recording and reading one message', () => {
    test('a stored reply records the itemization sent with it, the server\'s breakdown taking precedence', async () => {
        const ids = await makeChat('Rex', 'Recorded');
        const itemization = itemizationOf({ presetName: 'P', rawPrompt: 'page', mesId: 7 }, { rawPrompt: 'server prompt', finalPrompt: 'f' });
        const persisted = await persistAssistantReply({
            directories, ownerId: 'Rex', anchorNodeId: ids[4], name2: 'Rex', isSwipe: false, isContinue: false, anchorContent: null,
            warnings: [], itemization,
        }, 'a new reply');
        assert.ok(persisted?.node_id);

        const read = await post('message', { node_id: persisted.node_id });
        assert.equal(read.status, 200);
        assert.deepEqual(read.body.entry, { presetName: 'P', rawPrompt: 'server prompt', finalPrompt: 'f' }, 'no mesId is stored');
        assert.equal(read.body.previous_node_id, null, 'nothing above it has a raw prompt');
    });

    test('an itemization that can\'t be stored leaves the reply stored and says so, to a stream too', async () => {
        const ids = await makeChat('Rex', 'Unstorable');
        const pending = {
            directories, ownerId: 'Rex', anchorNodeId: ids[4], name2: 'Rex', isSwipe: false, isContinue: false, anchorContent: null,
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
        const ids = await makeChat('Rex', 'Without');
        assert.equal((await post('message', { node_id: ids[2] })).status, 404);
        assert.equal((await post('message', {})).status, 400);
    });

    test('the previous one is the nearest message above holding a raw prompt', async () => {
        const ids = await makeChat('Ann', 'Previous');
        await recordItemization(directories, ids[0], { rawPrompt: 'first' });
        await recordItemization(directories, ids[2], { presetName: 'no prompt here' });
        await recordItemization(directories, ids[4], { rawPrompt: 'third' });
        assert.equal((await post('message', { node_id: ids[4] })).body.previous_node_id, ids[0]);
        assert.equal((await post('message', { node_id: ids[2] })).body.previous_node_id, ids[0]);
        assert.equal((await post('message', { node_id: ids[0] })).body.previous_node_id, null);
    });

    test('recording the same itemization again writes nothing', async () => {
        const ids = await makeChat('Bob', 'Same');
        assert.equal(await recordItemization(directories, ids[2], { rawPrompt: 'x', mesId: 2 }), 'written');
        assert.equal(await recordItemization(directories, ids[2], { rawPrompt: 'x' }), 'unchanged');
        assert.equal(await recordItemization(directories, 'no-such-node', { rawPrompt: 'x' }), 'no-message');
    });
});

describe('the flag on loaded messages', () => {
    test('a loaded chat flags its itemized messages and alternatives, an export doesn\'t', async () => {
        const ids = await makeChat('Cat', 'Flags');
        const alt = (await tree.addAlternatives(directories, 'Cat', ids[2], [reply('Flags two, again')])).node_ids[0];
        await recordItemization(directories, ids[2], { rawPrompt: 'a' });
        await recordItemization(directories, alt, { rawPrompt: 'b' });

        const loaded = await tree.loadAtNode(directories, 'Cat', ids[0]);
        const flagOf = (/** @type {any} */ m) => m?.extra?.[tree.ITEMIZED_PROMPT_FLAG] === true;
        assert.deepEqual(loaded.messages.map(flagOf), [false, false, true, false, false]);
        assert.deepEqual(loaded.messages[2].swipe_info.map(flagOf), [true, true]);

        const alternatives = await tree.getAlternatives(directories, ids[2]);
        assert.deepEqual(alternatives.alternatives.map(flagOf), [true, true]);

        const exported = await tree.loadBranch(directories, 'Cat', 'Flags', true);
        assert.ok(exported.messages.every(m => !flagOf(m)));
    });

    test('the flag is never stored in a message', async () => {
        const ids = await makeChat('Dan', 'Stored');
        await recordItemization(directories, ids[2], { rawPrompt: 'a' });
        const loaded = await tree.loadAtNode(directories, 'Dan', ids[0]);
        const edited = { ...loaded.messages[2], mes: 'Stored two, edited' };
        assert.ok((await tree.editMessage(directories, 'Dan', ids[2], edited)).ok);
        const row = db.get('SELECT content FROM messages WHERE id = @id', { id: ids[2] });
        assert.equal(JSON.parse(row.content).extra?.[tree.ITEMIZED_PROMPT_FLAG], undefined);
    });

    test('an itemization goes with its message when the message is deleted', async () => {
        const ids = await makeChat('Eve', 'Deleted');
        const alt = (await tree.addAlternatives(directories, 'Eve', ids[4], [reply('Deleted four, again')])).node_ids[0];
        await recordItemization(directories, alt, { rawPrompt: 'a' });
        const before = rowCount();
        assert.ok((await tree.deleteAlternative(directories, 'Eve', alt)).ok);
        assert.equal(rowCount(), before - 1);
    });
});

describe('the routes behind upstream\'s exports', () => {
    test('/chat answers a chat\'s itemizations by position, or its node ids', async () => {
        const ids = await makeChat('Fay', 'Whole');
        await recordItemization(directories, ids[2], { rawPrompt: 'two' });
        await recordItemization(directories, ids[4], { rawPrompt: 'four' });
        const whole = await post('chat', { avatar_url: 'Fay.png', chat: 'Whole' });
        assert.deepEqual(whole.body.entries, [
            { index: 2, node_id: ids[2], entry: { rawPrompt: 'two' } },
            { index: 4, node_id: ids[4], entry: { rawPrompt: 'four' } },
        ]);
        assert.deepEqual((await post('chat', { avatar_url: 'Fay.png', chat: ids[0], ids_only: true })).body.node_ids, ids);
        assert.equal((await post('chat', { avatar_url: 'Fay.png', chat: 'Nope' })).status, 404);
        assert.equal((await post('chat', { avatar_url: 'Someone.png', chat: 'Whole' })).status, 404, 'a chat of another owner');
    });

    test('/set replaces entries and merges fields, writing only what changed', async () => {
        const ids = await makeChat('Gus', 'Set');
        await recordItemization(directories, ids[2], { rawPrompt: 'old', presetName: 'P' });
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
        const ids = await makeChat('Hal', 'Gone');
        await recordItemization(directories, ids[2], { rawPrompt: 'two' });
        await recordItemization(directories, ids[4], { rawPrompt: 'four' });
        assert.deepEqual((await post('delete', { avatar_url: 'Hal.png', chat: 'Gone' })).body, { removed: 2 });
        assert.equal((await post('message', { node_id: ids[2] })).status, 404);

        assert.ok(rowCount() > 0);
        assert.equal((await post('clear', {})).status, 200);
        assert.equal(rowCount(), 0);
    });
});
