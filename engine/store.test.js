// The store through the binding, native and wasm. Needs this checkout's builds in engine/dist/
// (node engine/build.js; node engine/build.js --wasm).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';

import { loadEngine } from './load.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-engine-store-test-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const bindings = {
    native: loadEngine().binding,
    wasm: loadEngine({ platform: null }).binding,
};

const message = {
    kind: 'messageAppend', id: 10n, parent: 9n, owner: 3n, speaker: 3n, time: 1_700_000_000_123,
    text: 'héllo \ud800 lone 😀', flags: 1, session: 7n, user: 1n, sendKey: Buffer.alloc(16, 7),
};
const samples = [
    { kind: 'keyMap', session: 7n, key: Buffer.from('0190a1b2-0000-7000-8000-000000000000') },
    { kind: 'keyMap', user: 1n, key: Buffer.from('default-user') },
    { kind: 'fav', entity: 2n ** 40n, fav: true },
    { kind: 'fav', entity: 5n, fav: false },
    { kind: 'tagAssign', entity: 5n, tag: 9n, assigned: true },
    { kind: 'messageAppend', id: 9n, owner: 3n, name: 'Narrator', time: -5, text: '', flags: 0, user: 1n },
    message,
    { kind: 'pointerMove', session: 7n, user: 1n, target: 10n },
    { kind: 'forkSelection', message: 9n, reply: 10n, session: 7n, user: 1n },
    { kind: 'textValue', message: 10n, field: 1, text: 'edited' },
    { kind: 'jsonValue', message: 10n, field: 'extra.api', json: '"openai"' },
    { kind: 'positionCreate', id: 8n, mode: 1, session: 7n, user: 1n, pointer: 10n },
    { kind: 'positionRoot', id: 12n, mode: 2, session: 7n, user: 1n, tree: 3n },
    { kind: 'textValue', entity: 5n, field: 2, text: 'a description '.repeat(20) },
    { kind: 'textEdit', entity: 5n, field: 2, offset: 10, removed: 4, text: 'word' },
    { kind: 'textValue', entity: 5n, field: 'my-extension/key', text: 'x'.repeat(40_000) },
    { kind: 'textValue', entity: 6n, field: 3, text: 'lone \udc00 high \ud800 pair 😀 '.repeat(100) },
];

/** @param {string} dir */
function logFiles(dir) {
    return fs.readdirSync(dir).filter(f => f.startsWith('log-')).sort();
}

for (const [name, engine] of Object.entries(bindings)) {
    test(`${name}: records read back as they were committed, by position and in the feed`, async () => {
        const dir = path.join(tmp, `${name}-roundtrip`);
        const log = await engine.Store.open(dir);
        const positions = await log.commit(samples);
        assert.equal(positions.length, samples.length);
        for (const [i, p] of positions.entries()) {
            assert.equal(typeof p, 'bigint');
            assert.deepEqual(await log.read(p), { ...samples[i], position: p });
        }
        const page = await log.feed(0n, 100);
        assert.deepEqual(page.records, samples.map((s, i) => ({ ...s, position: positions[i] })));
        assert.equal(page.next, log.durableEnd());
        await log.close();
        const reopened = await engine.Store.open(dir);
        assert.deepEqual((await reopened.feed(0n, 100)).records.length, samples.length);
        await reopened.close();
    });

    test(`${name}: derived values follow commits and survive a reopen`, async () => {
        const dir = path.join(tmp, `${name}-derived`);
        let store = await engine.Store.open(dir);
        await store.ready();
        assert.equal(await store.fav(1n), null);
        const [favAt] = await store.commit([{ kind: 'fav', entity: 1n, fav: true }]);
        assert.equal(await store.fav(1n), true);
        assert.equal(await store.version(1n), favAt);
        const text = 'héllo \ud800 wörld '.repeat(10);
        await store.commit([{ kind: 'textValue', entity: 1n, field: 'ext/key', text }]);
        // 'héllo' is 6 bytes of WTF-8: replace it.
        const [editAt] = await store.commit([{ kind: 'textEdit', entity: 1n, field: 'ext/key', offset: 0, removed: 6, text: 'bye' }]);
        assert.equal((await store.read(editAt)).kind, 'textEdit');
        const edited = 'bye' + text.slice(5);
        assert.equal(await store.text(1n, 'ext/key'), edited);
        assert.equal(await store.version(1), editAt);
        // Outside the value, or inside a character: refused, nothing written.
        const end = store.durableEnd();
        await assert.rejects(store.commit([{ kind: 'textEdit', entity: 1n, field: 'ext/key', offset: 1000, removed: 0, text: 'x' }]), /outside/);
        await assert.rejects(store.commit([{ kind: 'fav', entity: 2n, fav: true }, { kind: 'textEdit', entity: 1n, field: 'ext/key', offset: 5, removed: 0, text: 'x' }]), /inside a character/);
        assert.equal(store.durableEnd(), end);
        assert.equal(await store.fav(2n), null);
        await store.close();
        store = await engine.Store.open(dir);
        assert.equal(await store.text(1n, 'ext/key'), edited);
        assert.equal(await store.fav(1n), true);
        assert.equal(store.stats().replayBytes, 0);
        await store.close();
    });

    test(`${name}: a record that doesn't fit its kind is refused, not trimmed`, async () => {
        const log = await engine.Store.open(path.join(tmp, `${name}-invalid`));
        for (const bad of [
            { kind: 'nope' },
            { kind: 'fav', entity: 1n },
            { kind: 'fav', entity: 1n, fav: true, extra: 1 },
            { kind: 'fav', entity: -1, fav: true },
            { kind: 'fav', entity: 1.5, fav: true },
            { kind: 'fav', entity: 2n ** 63n, fav: true },
            { kind: 'fav', entity: 1n, fav: 1 },
            { kind: 'textEdit', entity: 1n, field: 0, offset: 0, removed: 0, text: '' },
            { kind: 'textEdit', entity: 1n, field: 1, offset: 2 ** 53, removed: 0, text: '' },
            { kind: 'messageAppend', ...message, parent: null },
            { kind: 'textValue', entity: 1n, message: 1n, field: 1, text: '' },
            { kind: 'keyMap', key: Buffer.from('x') },
            { kind: 'moved', from: 0n },
        ]) {
            assert.throws(() => log.commit([samples[0], bad]), /./, JSON.stringify(bad, (_, v) => typeof v === 'bigint' ? `${v}n` : v));
        }
        assert.equal((await log.feed(0n, 10)).records.length, 0);
        await log.close();
    });

    test(`${name}: concurrent commits each resolve with their own positions, sharing syncs`, async () => {
        const log = await engine.Store.open(path.join(tmp, `${name}-concurrent`));
        const commits = Array.from({ length: 200 }, (_, i) => [{ kind: 'fav', entity: BigInt(i), fav: true }]);
        const results = await Promise.all(commits.map(c => log.commit(c)));
        for (const [i, [p]] of results.entries()) {
            assert.deepEqual(await log.read(p), { ...commits[i][0], position: p });
        }
        assert.ok(log.stats().logRounds < 200, `${log.stats().logRounds} rounds for 200 commits`);
        await log.close();
        await assert.rejects(log.commit(commits[0]), /closed/);
    });

    test(`${name}: a position that isn't a record's start is refused`, async () => {
        const log = await engine.Store.open(path.join(tmp, `${name}-position`));
        const [p] = await log.commit([samples[0]]);
        await assert.rejects(log.read(p + 1n), /not a record's start/);
        await assert.rejects(log.read(log.durableEnd()), /not durable/);
        await log.close();
    });

    test(`${name}: an owner's messages are searched by word and phrase, folded, and survive a reopen`, async () => {
        const dir = path.join(tmp, `${name}-search`);
        let store = await engine.Store.open(dir);
        const say = (id, owner, text) => ({ kind: 'messageAppend', id, owner, time: 1, text, flags: 0, session: 1n, user: 1n });
        await store.commit([
            { kind: 'keyMap', session: 1n, key: Buffer.from('s') },
            { kind: 'keyMap', user: 1n, key: Buffer.from('u') },
            say(1n, 5n, 'The Dragon sleeps.'),
            say(2n, 5n, 'a dragon? No, a drake'),
            say(3n, 5n, 'Café au lait \ud800 dragon dragon'),
            say(4n, 6n, 'dragon of another owner'),
        ]);
        const search = (clauses, extra = {}) => store.search({ scope: { chat: 5n }, clauses, limit: 10, ...extra });
        let found = await search([{ text: 'dragon' }]);
        assert.deepEqual(found.hits.map(h => h.doc), [3n, 1n, 2n]);
        assert.equal(found.total, 3);
        assert.ok(found.totalExact && found.pageExact && !found.more);
        // Tags whose names match are answered in the library only.
        assert.deepEqual(found.tags, []);
        assert.ok(found.tagsExact);
        assert.deepEqual((await search([{ text: 'cafe' }, { text: 'dragon' }])).hits.map(h => h.doc), [3n]);
        assert.deepEqual((await search([{ text: 'the dragon', quoted: true }])).hits.map(h => h.doc), [1n]);
        assert.deepEqual((await search([{ text: 'dragon' }, { text: 'drake', negate: true }])).hits.map(h => h.doc), [3n, 1n]);
        const page = await search([{ text: 'dragon' }], { limit: 1 });
        assert.ok(page.more);
        const next = await search([{ text: 'dragon' }], { limit: 1, after: page.hits[0] });
        assert.deepEqual(next.hits.map(h => h.doc), [1n]);
        await assert.rejects(async () => store.search({ scope: 'nope', clauses: [], limit: 1 }), /no search scope/);
        await store.close();
        store = await engine.Store.open(dir);
        found = await search([{ text: 'DRAGON' }]);
        assert.deepEqual(found.hits.map(h => h.doc), [3n, 1n, 2n]);
        await store.close();
    });
}

test('native and wasm write the same bytes', async () => {
    for (const name of Object.keys(bindings)) {
        const log = await bindings[name].Store.open(path.join(tmp, `same-${name}`));
        await log.commit(samples);
        await log.close();
    }
    const files = name => {
        const dir = path.join(tmp, `same-${name}`);
        const runs = path.join(dir, 'runs');
        return [
            ...logFiles(dir).map(f => fs.readFileSync(path.join(dir, f))),
            ...fs.readdirSync(runs).sort().map(f => fs.readFileSync(path.join(runs, f))),
        ];
    };
    assert.deepEqual(files('wasm'), files('native'));
});

for (const [name, engine] of Object.entries(bindings)) {
    test(`${name}: a torn last group is cut off on reopen`, async () => {
        const dir = path.join(tmp, `${name}-torn`);
        let log = await engine.Store.open(dir);
        const kept = await log.commit(samples.slice(0, 3));
        const end = log.durableEnd();
        await log.commit(samples.slice(3, 6));
        await log.close();
        // As a crash before the first flush leaves it: no runs, the last group's sync cut short.
        fs.rmSync(path.join(dir, 'runs'), { recursive: true });
        const [file] = logFiles(dir);
        fs.truncateSync(path.join(dir, file), fs.statSync(path.join(dir, file)).size - 1);
        log = await engine.Store.open(dir);
        assert.equal(log.durableEnd(), end);
        assert.equal(fs.statSync(path.join(dir, file)).size, Number(end));
        assert.deepEqual((await log.feed(0n, 100)).records.map(r => r.position), kept);
        await log.close();
    });

    test(`${name}: damage with whole groups after it refuses to open and changes nothing`, async () => {
        const dir = path.join(tmp, `${name}-damaged`);
        const log = await engine.Store.open(dir);
        await log.commit(samples.slice(0, 3));
        const [second] = await log.commit(samples.slice(3, 5));
        await log.commit(samples.slice(5, 6));
        await log.close();
        const [file] = logFiles(dir);
        const bytes = fs.readFileSync(path.join(dir, file));
        bytes[Number(second) + 1] ^= 0x40;
        fs.writeFileSync(path.join(dir, file), bytes);
        await assert.rejects(engine.Store.open(dir), new RegExp(`${file} is damaged: .* but 1 whole groups follow .*Nothing was changed`));
        assert.deepEqual(fs.readFileSync(path.join(dir, file)), bytes);
    });

    test(`${name}: a log cut short of what the runs cover refuses to open`, async () => {
        const dir = path.join(tmp, `${name}-short`);
        const log = await engine.Store.open(dir);
        await log.commit(samples.slice(0, 3));
        const end = log.durableEnd();
        await log.commit(samples.slice(3, 6));
        await log.close();
        const [file] = logFiles(dir);
        fs.truncateSync(path.join(dir, file), Number(end));
        await assert.rejects(engine.Store.open(dir), /the runs cover the log up to/);
    });
}

for (const [name, engine] of Object.entries(bindings)) {
    test(`${name}: library entities are found by key and paged in their orders`, async () => {
        const dir = path.join(tmp, `${name}-library`);
        const store = await engine.Store.open(dir);
        await store.commit([{ kind: 'entityCreate', entity: 100n, type: 2, key: 'tag-a', added: 0 }]);
        const names = ['Zed', 'émile', 'Ana', 'bob'];
        for (const [i, n] of names.entries()) {
            const e = BigInt(i + 1);
            await store.commit([
                { kind: 'entityCreate', entity: e, type: 0, key: `${n}.png`, added: 1000 + i },
                { kind: 'textValue', entity: e, field: 1, text: n },
                { kind: 'dataSize', entity: e, size: 10 * (i + 1) },
                { kind: 'jsonValue', entity: e, field: 'ext:depth_prompt', json: '{"depth":4}' },
                ...(i % 2 ? [{ kind: 'tagAssign', entity: e, tag: 100n, assigned: true }] : []),
            ]);
        }
        await assert.rejects(store.commit([{ kind: 'entityCreate', entity: 9n, type: 0, key: 'Ana.png', added: 1 }]), /has that key already/);
        assert.deepEqual(await store.libraryIds([[0, 'Ana.png'], [0, 'nobody.png'], [2, 'tag-a']]), [3n, null, 100n]);
        assert.equal(await store.libraryNextId(), 101n);
        const page = await store.libraryPage({ characters: true, groups: true, sort: { key: 0 }, limit: 3, count: true });
        assert.deepEqual(page.ids, [3n, 4n, 2n]);
        assert.equal(page.total, 4);
        assert.equal(page.totalExact, true);
        const next = await store.libraryPage({ characters: true, groups: true, sort: { key: 0 }, limit: 3, cursor: page.cursor });
        assert.deepEqual(next.ids, [1n]);
        const tagged = await store.libraryPage({ characters: true, allTags: [100n], sort: { key: 5, desc: true }, count: true });
        assert.deepEqual(tagged.ids, [4n, 2n]);
        const random = await store.libraryPage({ characters: true, sort: { seed: -7 }, limit: 10 });
        assert.deepEqual([...random.ids].sort(), [1n, 2n, 3n, 4n]);
        const [entity, none] = await store.libraryEntities([2n, 50n]);
        assert.equal(none, null);
        assert.equal(entity.key, 'émile.png');
        assert.equal(entity.dataSize, 20);
        assert.deepEqual(entity.tags, [100n]);
        assert.deepEqual(entity.values.map(v => [v.field, v.text ?? v.json]).sort(), [[1, 'émile'], ['ext:depth_prompt', '{"depth":4}']]);
        // A new key and date added: found by the new key only, placed by both.
        await store.commit([{ kind: 'entityUpdate', entity: 3n, type: 0, key: 'zz.png', added: 5000 }]);
        await assert.rejects(store.commit([{ kind: 'entityUpdate', entity: 1n, type: 0, key: 'zz.png', added: 1 }]), /has that key already/);
        assert.deepEqual(await store.libraryIds([[0, 'Ana.png'], [0, 'zz.png']]), [null, 3n]);
        assert.deepEqual((await store.libraryPage({ characters: true, sort: { key: 2, desc: true }, limit: 1 })).ids, [3n]);
        const hash = (/** @type {number} */ n) => Buffer.alloc(32, n);
        await store.commit([1n, 2n, 3n].flatMap(e => [
            { kind: 'cardHash', entity: e, which: 0, hash: hash(e === 3n ? 2 : 1) },
            { kind: 'cardHash', entity: e, which: 3, hash: hash(e === 1n ? 9 : 8) },
        ]));
        assert.deepEqual(await store.libraryByHashes(0, hash(1), 3, hash(8), 5), [2n]);
        assert.deepEqual(await store.libraryByHashes(0, hash(2), 3, hash(9), 5), []);
        await store.close();
    });
}

for (const [name, engine] of Object.entries(bindings)) {
    test(`${name}: chat reads answer the tree, sessions, state and stats`, async () => {
        const store = await engine.Store.open(path.join(tmp, `${name}-chat`));
        const say = (id, parent, text, extra = {}) => ({ kind: 'messageAppend', id, ...(parent === null ? {} : { parent }), owner: 3n, time: 1_700_000_000_000 + Number(id), text, flags: 0, user: 1n, ...extra });
        await store.commit([
            { kind: 'keyMap', session: 1n, key: Buffer.from('0190a1b2-0000-7000-8000-00000000000a') },
            { kind: 'keyMap', user: 1n, key: Buffer.from('default-user') },
            say(0n, null, 'Hello'),
            say(1n, 0n, 'reply one', { session: 1n, sendKey: Buffer.alloc(16, 1) }),
            say(2n, 0n, 'reply two'),
            { kind: 'jsonValue', message: 1n, field: 'api', json: '"openai"' },
            { kind: 'messageTime', message: 1n, field: 6, delta: -5 },
            { kind: 'stateChange', id: 0n, message: 1n, time: 5, author: 0, key: 'note', value: '"hi"' },
            { kind: 'stateChange', id: 1n, tree: 3n, time: 5, author: 8, key: 'x', value: '1' },
            { kind: 'positionCreate', id: 9n, mode: 2, session: 1n, user: 1n, pointer: 1n },
            { kind: 'positionName', id: 9n, name: 'Checkpoint' },
            { kind: 'itemization', message: 1n, raw: true, data: Buffer.from([1, 2, 3]) },
        ]);
        const [m0, m1, none] = await store.chatRead('messages', { ids: [0n, 1n, 77n] });
        assert.equal(none, null);
        assert.equal(m0.parent, null);
        assert.deepEqual(m0.texts, [{ field: 1, text: 'Hello' }]);
        assert.equal(m1.parent, 0n);
        assert.equal(m1.depth, 2n);
        assert.deepEqual(m1.values, [{ field: 'api', json: '"openai"' }]);
        assert.deepEqual(m1.times, [{ field: 6, delta: -5 }]);
        assert.deepEqual(m1.itemized, { raw: true });
        assert.deepEqual(m1.branches, [9n]);
        assert.deepEqual(m1.sendKey, Buffer.alloc(16, 1));
        assert.deepEqual(await store.chatRead('children', { parent: 0n, tree: 3n, limit: 1 }), { ids: [1n], more: true });
        assert.deepEqual(await store.chatRead('children', { tree: 3n, limit: 5 }), { ids: [0n], more: false });
        // A position shows the path from the tree's root down to it; session 1 lands at its reply.
        assert.deepEqual(await store.chatRead('path', { tree: 3n, at: 1n }), [0n, 1n]);
        assert.equal(await store.chatRead('landing', { tree: 3n, session: 1n }), 1n);
        assert.deepEqual((await store.chatRead('sessions', { ids: [1n, 5n] }))[1], null);
        assert.deepEqual(await store.chatRead('userInTree', { user: 1n, tree: 3n }), { session: 1n, at: 1n });
        assert.deepEqual(await store.chatRead('history', { session: 1n, limit: 10 }), [{ n: 1, target: 1n, tree: null, gone: false }]);
        assert.equal((await store.chatRead('recent', { limit: 10 }))[0].session, 1n);
        assert.deepEqual(await store.chatRead('messageCount', { tree: 3n, at: 1n }), { count: 2, estimate: false });
        assert.deepEqual(await store.chatRead('ids', { space: 1, keys: ['0190a1b2-0000-7000-8000-00000000000a', 'nope'] }), [1n, null]);
        assert.deepEqual(await store.chatRead('keyStates', { space: 1, keys: ['0190a1b2-0000-7000-8000-00000000000a', 'nope'] }), [{ id: 1n }, null]);
        assert.deepEqual(await store.chatRead('nextIds', {}), { message: 3n, position: 10n, user: 2n, change: 2n });
        const [b] = await store.chatRead('treeBookmarks', { tree: 3n, limit: 10 });
        assert.deepEqual(b, { id: 9n, at: 1n, root: null, mode: 2, name: 'Checkpoint', createdAt: 1n, session: 1n, user: 1n });
        assert.deepEqual(await store.chatRead('state', { tree: 3n, at: 1n }), [
            { variable: true, field: 'x', json: '1' },
            { variable: false, field: 'note', json: '"hi"' },
        ]);
        assert.deepEqual(await store.chatRead('state', { tree: 3n, at: 2n }), [{ variable: true, field: 'x', json: '1' }]);
        const { owners: [s3] } = await store.chatRead('stats', { owners: [3n] });
        assert.equal(s3.charMsgs, 2);
        assert.equal(s3.swipes, 1);
        assert.deepEqual(await store.chatRead('itemization', { message: 1n }), { raw: true, data: Buffer.from([1, 2, 3]) });
        assert.deepEqual(await store.chatRead('sent', { owner: 3n, keys: [Buffer.alloc(16, 1), Buffer.alloc(16, 2)] }), [1n, null]);
        assert.throws(() => store.chatRead('nope', {}), /no chat read/);
        await store.close();
    });
}

for (const [name, engine] of Object.entries(bindings)) {
    test(`${name}: a bulk load installs its records at once, ordered, numbered and searched`, async () => {
        const dir = path.join(tmp, `${name}-load`);
        const store = await engine.Store.open(dir);
        const load = store.load();
        assert.throws(() => store.load(), /already running/);
        const names = ['Zed', 'émile', 'Ana', 'bob'];
        for (const [i, n] of names.entries()) {
            const e = BigInt(i + 1);
            await load.add([
                { kind: 'textValue', entity: e, field: 1, text: n },
                { kind: 'fav', entity: e, fav: i === 2 },
                { kind: 'entityCreate', entity: e, type: 0, key: `${n}.png`, added: 1000 + i },
            ]);
        }
        // Nothing shows until it is installed.
        assert.deepEqual(await store.libraryIds([[0, 'Ana.png']]), [null]);
        const stats = await load.finish();
        assert.equal(stats.records, 12);
        assert.ok(stats.numberEntries > 0);
        await assert.rejects(load.finish(), /finished/);
        assert.deepEqual(await store.libraryIds([[0, 'Ana.png']]), [3n]);
        const page = await store.libraryPage({ characters: true, sort: { key: 0 }, limit: 10, count: true });
        assert.deepEqual(page.ids, [3n, 4n, 2n, 1n]);
        const random = await store.libraryPage({ characters: true, sort: { seed: 3 }, limit: 10 });
        assert.deepEqual([...random.ids].sort(), [1n, 2n, 3n, 4n]);
        const found = await store.librarySearch({ characters: true, clauses: [{ text: 'emile' }], relevance: true, limit: 5 });
        assert.deepEqual(found.ids, [2n]);
        // A second load of characters into a library that has some is refused, and leaves nothing.
        const again = store.load();
        await again.add([{ kind: 'entityCreate', entity: 9n, type: 0, key: 'late.png', added: 1 }]);
        await assert.rejects(again.finish(), /only into a store with none/);
        assert.deepEqual(await store.libraryIds([[0, 'late.png']]), [null]);
        // An abandoned load leaves nothing either.
        const dropped = store.load();
        await dropped.add([{ kind: 'messageAppend', id: 1n, owner: 3n, time: 1, text: 'x', flags: 0, user: 1n }]);
        dropped.abandon();
        await store.close();
        const reopened = await engine.Store.open(dir);
        assert.deepEqual(await reopened.libraryIds([[0, 'Ana.png'], [0, 'late.png']]), [3n, null]);
        await reopened.close();
    });
}

const TREES = [3_000n, 700_000n, 9_000_000n];
/** @param {number} o @param {number} i */
const messageId = (o, i) => 50_000n + BigInt(i) * 4_096n + BigInt(o);

/**
 * A forest of messages over three trees with everything a conversion records about them: values, times, outside
 * keys, itemizations, replaced texts, state changes at messages and at a root.
 */
function chatRecords() {
    const words = ['dragon', 'knight', 'quiet', 'ember', 'river', 'storm'];
    const records = [];
    let change = 1n;
    // Owners and messages far apart, so a message's own id and its owner's fall to different load workers.
    for (const [o, owner] of TREES.entries()) {
        const ids = [];
        for (let i = 0; i < 60; i++) {
            const m = messageId(o, i);
            const parent = i === 0 ? undefined : ids[Math.floor((i - 1) / 2)];
            records.push({ kind: 'messageAppend', id: m, ...(parent ? { parent } : {}), owner, time: 1_700_000_000_000 + (i % 7), text: `${words[i % 6]} ${words[(i * 5) % 6]} number ${i}`, flags: i % 2, user: 1n, ...(i % 9 === 0 ? { sendKey: Buffer.from(`key-${owner}-${i}`) } : {}) });
            records.push({ kind: 'keyMap', message: m, key: Buffer.from(`old-${owner}-${i}`) });
            if (i % 3 === 0) records.push({ kind: 'jsonValue', message: m, field: 'extra.api', json: '"openai"' });
            if (i % 4 === 0) records.push({ kind: 'messageTime', message: m, field: 6, delta: -i });
            if (i % 5 === 0) records.push({ kind: 'itemization', message: m, raw: i % 2 === 0, data: Buffer.from(`prompt ${i}`) });
            if (i % 7 === 0) records.push({ kind: 'textValue', message: m, field: 1, text: `replaced ${words[i % 6]}` });
            if (i % 8 === 0) records.push({ kind: 'stateChange', id: change++, message: m, time: 5, author: 4, key: 'note', value: `"n${i}"`, user: 1n });
            ids.push(m);
        }
        records.push({ kind: 'stateChange', id: change++, tree: owner, time: 5, author: 4, key: 'root', value: '1', user: 1n });
    }
    return records;
}

/** @param {unknown} v A read with every record position taken out. */
function withoutPositions(v) {
    if (Array.isArray(v)) return v.map(withoutPositions);
    if (v && typeof v === 'object' && !Buffer.isBuffer(v)) return Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'position').map(([k, x]) => [k, withoutPositions(x)]));
    return v;
}

for (const [name, engine] of Object.entries(bindings)) {
    test(`${name}: chats bulk loaded read as the same chats committed`, async () => {
        const committed = await engine.Store.open(path.join(tmp, `${name}-chats-committed`));
        const loaded = await engine.Store.open(path.join(tmp, `${name}-chats-loaded`));
        const user = [{ kind: 'keyMap', user: 1n, key: Buffer.from('u') }];
        await committed.commit(user);
        await loaded.commit(user);
        const records = chatRecords();
        for (let i = 0; i < records.length; i += 97) await committed.commit(records.slice(i, i + 97));
        const load = loaded.load();
        for (let i = 0; i < records.length; i += 97) await load.add(records.slice(i, i + 97));
        await load.finish();
        const ids = records.filter(r => r.kind === 'messageAppend').map(r => r.id);
        const read = async (/** @type {any} */ s) => {
            const keys = TREES.flatMap((owner, o) => Array.from({ length: 60 }, (_, i) => [`old-${owner}-${i}`, messageId(o, i)]));
            const out = { messages: await s.chatRead('messages', { ids }), stats: await s.chatRead('stats', { owners: TREES }), keys: await s.chatRead('ids', { space: 0, keys: keys.map(k => k[0]) }) };
            assert.deepEqual(out.keys, keys.map(k => k[1]));
            for (const tree of TREES) {
                out[`roots ${tree}`] = await s.chatRead('children', { tree, limit: 100 });
                out[`search ${tree}`] = await s.search({ scope: { chat: tree }, clauses: [{ text: 'dragon' }], limit: 100 });
                out[`state ${tree}`] = await s.chatRead('state', { tree });
                out[`sent ${tree}`] = await s.chatRead('sent', { owner: tree, keys: [Buffer.from(`key-${tree}-9`), Buffer.from(`key-${tree}-18`)] });
            }
            for (const m of ids) {
                const tree = TREES[Number((m - 50_000n) % 4_096n)];
                out[`children ${m}`] = await s.chatRead('children', { tree, parent: m, limit: 100 });
                out[`path ${m}`] = await s.chatRead('path', { tree, at: m });
                out[`state at ${m}`] = await s.chatRead('state', { tree, at: m });
                out[`count ${m}`] = await s.chatRead('messageCount', { tree, at: m });
            }
            return withoutPositions(out);
        };
        assert.deepEqual(await read(loaded), await read(committed));
        await committed.close();
        await loaded.close();
    });
}
