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
    text: 'héllo \ud800 lone 😀', flags: 1, session: 7n, user: 1n,
};
const samples = [
    { kind: 'fav', entity: 2n ** 40n, fav: true },
    { kind: 'fav', entity: 5n, fav: false },
    { kind: 'tagAssign', entity: 5n, tag: 9n, assigned: true },
    { kind: 'pointerMove', session: 7n, user: 1n, target: 10n },
    { kind: 'forkSelection', message: 9n, reply: 10n, session: 7n, user: 1n },
    message,
    { kind: 'messageAppend', id: 1n, owner: 3n, name: 'Narrator', time: -5, text: '', flags: 0, session: 7n, user: 1n },
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
