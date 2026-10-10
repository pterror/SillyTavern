// A message stored as the engine's values comes back byte for byte (build path 5b, the message shape).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';

import { loadEngine } from '../engine/load.js';
import { decodeMessage, encodeMessage, messageRecords } from './chat-codec.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-codec-test-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const t = 1_760_100_000_000;
const alice = { id: 7n, name: 'Alice', avatar: 'alice.png' };
const bot = { id: 8n, name: 'Bot', avatar: 'bot.png' };
const speakers = new Map([[7n, alice], [8n, bot]]);

/** [message, speaker] pairs: the shapes the page, the server and upstream's page make, and odd ones. */
const corpus = [
    [{ name: 'User', is_user: true, is_system: false, send_date: new Date(t - 30).toISOString(), mes: 'Hi there', extra: { isSmallSys: false }, force_avatar: '/thumbnail?type=persona&file=user.png' }, null],
    [{ name: 'Bot', is_user: false, mes: 'Hello', extra: {}, send_date: t, gen_started: t - 1000, gen_finished: t }, bot],
    [{ extra: { api: 'openai', model: 'gpt', reasoning: '', reasoning_duration: null, reasoning_signature: null }, name: 'Bot', is_user: false, send_date: 'October 10, 2025 3:04pm', mes: 'x', title: '', gen_started: '2025-10-10T15:04:00.000Z', gen_finished: '2025-10-10T15:04:05.123Z' }, bot],
    [{ mes: 5, is_user: 'yes', name: null, extra: [1, 2], zzz: { a: 1 }, is_system: 0, '\u0001weird': 1, send_date: 0, is_name: 'n' }, null],
    [{ name: 'Alice', is_user: false, send_date: t, mes: 'hi', extra: { gen_id: 123, tokens: [1] }, force_avatar: '/thumbnail?type=avatar&file=alice.png', original_avatar: 'alice.png' }, alice],
    [{ name: 'Old name', is_user: false, is_system: false, send_date: new Date(t).toISOString(), mes: 'renamed since', extra: {} }, alice],
    [{ mes: 'a\ud800b 😀', name: 'X', extra: { b: 1, a: 2, '\u0002x': 3, '\u0001y': [] } }, null],
    [{}, null],
    [{ name: 'User', is_user: true, is_system: false, send_date: 'not a date', mes: '', extra: { model: 'm', api: 'a' }, is_name: true }, null],
    [{ name: 'Bot', is_user: false, is_system: true, send_date: new Date(t + 5).toISOString(), mes: 'sys', extra: { type: 'narrator', isSmallSys: true }, gen_started: null, gen_finished: 'yesterday' }, bot],
];

for (const [name, engine] of Object.entries({ native: loadEngine().binding, wasm: loadEngine({ platform: null }).binding })) {
    test(`${name}: every message shape comes back byte for byte`, async () => {
        const store = await engine.Store.open(path.join(tmp, name));
        await store.commit([{ kind: 'keyMap', user: 1n, key: Buffer.from('user') }]);
        const records = [];
        for (const [i, [message, speaker]] of corpus.entries()) {
            const enc = encodeMessage(message, t + i, speaker);
            records.push(...messageRecords(BigInt(i), enc, { parent: i > 0 ? BigInt(i - 1) : null, owner: 1n, time: t + i, user: 1n }));
        }
        await store.commit(records);
        const stored = await store.chatRead('messages', { ids: corpus.map((_, i) => BigInt(i)) });
        for (const [i, [message]] of corpus.entries()) {
            const json = decodeMessage(stored[i], id => speakers.get(id) ?? null);
            assert.equal(json, JSON.stringify(message), `message ${i}`);
        }
        // A speaker renamed: the messages that used the name it had follow it; one that held its own name keeps it.
        const renamed = id => (id === 7n ? { ...alice, name: 'Alicia', avatar: 'alicia.png' } : speakers.get(id) ?? null);
        const four = JSON.parse(decodeMessage(stored[4], renamed));
        assert.equal(four.name, 'Alicia');
        assert.equal(four.original_avatar, 'alicia.png');
        assert.equal(four.force_avatar, '/thumbnail?type=avatar&file=alicia.png');
        assert.equal(JSON.parse(decodeMessage(stored[5], renamed)).name, 'Old name');
        // The usual messages store no order and no name; their flags take one byte.
        for (const i of [0, 1, 2, 4]) {
            const enc = encodeMessage(corpus[i][0], t + i, corpus[i][1]);
            assert.ok(enc.flags < 128 || i === 4, `flags of ${i}: ${enc.flags}`);
            assert.ok(!enc.values.has(10), `order of ${i}`);
            assert.equal(enc.name, i === 0 ? 'User' : null);
        }
        await store.close();
    });
}
