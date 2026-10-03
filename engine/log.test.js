// The record log through the binding, native and wasm. Needs this checkout's builds in engine/dist/
// (node engine/build.js; node engine/build.js --wasm).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';

import { loadEngine } from './load.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-engine-log-test-'));
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
    { kind: 'textEdit', entity: 5n, field: 2, offset: 10, removed: 4, text: 'word' },
    { kind: 'textValue', entity: 5n, field: 'my-extension/key', text: 'x'.repeat(40_000) },
    { kind: 'textValue', entity: 6n, field: 3, text: 'lone \udc00 high \ud800 pair 😀 '.repeat(100) },
];

for (const [name, engine] of Object.entries(bindings)) {
    test(`${name}: records read back as they were appended, by position and in order`, async () => {
        const dir = path.join(tmp, `${name}-roundtrip`);
        const log = await engine.RecordLog.open(dir);
        const positions = await log.append(samples);
        assert.equal(positions.length, samples.length);
        for (const [i, p] of positions.entries()) {
            assert.equal(typeof p, 'bigint');
            assert.deepEqual(await log.read(p), { ...samples[i], position: p });
        }
        const page = await log.iterate(0n, 100);
        assert.deepEqual(page.records, samples.map((s, i) => ({ ...s, position: positions[i] })));
        assert.equal(page.next, log.durableEnd());
        log.close();
        const reopened = await engine.RecordLog.open(dir);
        assert.deepEqual((await reopened.iterate(0n, 100)).records.length, samples.length);
        reopened.close();
    });

    test(`${name}: a record that doesn't fit its kind is refused, not trimmed`, async () => {
        const log = await engine.RecordLog.open(path.join(tmp, `${name}-invalid`));
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
        ]) {
            assert.throws(() => log.append([samples[0], bad]), /./, JSON.stringify(bad, (_, v) => typeof v === 'bigint' ? `${v}n` : v));
        }
        assert.equal((await log.iterate(0n, 10)).records.length, 0);
        log.close();
    });

    test(`${name}: concurrent commits each resolve with their own positions, sharing syncs`, async () => {
        const log = await engine.RecordLog.open(path.join(tmp, `${name}-concurrent`));
        const commits = Array.from({ length: 200 }, (_, i) => [{ kind: 'fav', entity: BigInt(i), fav: true }]);
        const results = await Promise.all(commits.map(c => log.append(c)));
        for (const [i, [p]] of results.entries()) {
            assert.deepEqual(await log.read(p), { ...commits[i][0], position: p });
        }
        assert.ok(log.stats().rounds < 200, `${log.stats().rounds} rounds for 200 commits`);
        log.close();
        await assert.rejects(log.append(commits[0]), /closed/);
    });

    test(`${name}: a position that isn't a record's start is refused`, async () => {
        const log = await engine.RecordLog.open(path.join(tmp, `${name}-position`));
        const [p] = await log.append([samples[0]]);
        await assert.rejects(log.read(p + 1n), /not a record's start/);
        await assert.rejects(log.read(log.durableEnd()), /not durable/);
        log.close();
    });
}

test('native and wasm write the same bytes', async () => {
    for (const name of Object.keys(bindings)) {
        const log = await bindings[name].RecordLog.open(path.join(tmp, `same-${name}`));
        await log.append(samples);
        log.close();
    }
    const files = name => fs.readdirSync(path.join(tmp, `same-${name}`)).map(f => fs.readFileSync(path.join(tmp, `same-${name}`, f)));
    assert.deepEqual(files('wasm'), files('native'));
});

for (const [name, engine] of Object.entries(bindings)) {
    test(`${name}: a torn last group is cut off on reopen`, async () => {
        const dir = path.join(tmp, `${name}-torn`);
        let log = await engine.RecordLog.open(dir);
        const kept = await log.append(samples.slice(0, 3));
        const end = log.durableEnd();
        await log.append(samples.slice(3, 6));
        log.close();
        const [file] = fs.readdirSync(dir);
        fs.truncateSync(path.join(dir, file), fs.statSync(path.join(dir, file)).size - 1);
        log = await engine.RecordLog.open(dir);
        assert.equal(log.durableEnd(), end);
        assert.equal(fs.statSync(path.join(dir, file)).size, Number(end));
        assert.deepEqual((await log.iterate(0n, 100)).records.map(r => r.position), kept);
        log.close();
    });
}

for (const [name, engine] of Object.entries(bindings)) {
    test(`${name}: damage with whole groups after it refuses to open and changes nothing`, async () => {
        const dir = path.join(tmp, `${name}-damaged`);
        const log = await engine.RecordLog.open(dir);
        await log.append(samples.slice(0, 3));
        const [second] = await log.append(samples.slice(3, 5));
        await log.append(samples.slice(5, 6));
        log.close();
        const [file] = fs.readdirSync(dir);
        const bytes = fs.readFileSync(path.join(dir, file));
        bytes[Number(second) + 1] ^= 0x40;
        fs.writeFileSync(path.join(dir, file), bytes);
        await assert.rejects(engine.RecordLog.open(dir), new RegExp(`${file} is damaged: .* but 1 whole groups follow .*Nothing was changed`));
        assert.deepEqual(fs.readFileSync(path.join(dir, file)), bytes);
    });
}
