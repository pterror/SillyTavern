// Loads through the binding (`Store.load(budget)`) bound resident growth, including the caller's batch overhead,
// with records shaped as the conversion sends them: tags, big character cards with tags, then each character's chats
// (a reply chain, three swipes per reply, an itemization per swipe). Needs this checkout's native build in
// engine/dist/ (node engine/build.js).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';

import { loadEngine } from './load.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-engine-load-budget-test-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const engine = loadEngine().binding;

const BUDGET = 256 << 20;
/**
 * What the process may hold past its budget: the records of a batch in flight (as JS objects, then as the
 * engine's), the log file being laid out and the files queued for the workers, the workers' current partitions,
 * and the JS heap's own growth before a collection. The caller and in-flight records have a separate allowance from the spill target.
 */
const SLACK = 192 << 20;
const TAGS = 200;
const CARDS = 12000;
const OWNERS = 30;
const TURNS = 20;

let seed = 0x2545f491;
const next = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return seed >>> 0;
};
const words = (n) => Array.from({ length: n }, () => `w${next() % 30000}`).join(' ');
const text = (entity, field, t) => ({ kind: 'textValue', entity, field, text: t });

/** The library's records, then the chats', in the conversion's order. */
function* libraryRecords() {
    for (let t = 1; t <= TAGS; t++) {
        const id = BigInt(t);
        yield text(id, 1, `tag ${t} ${words(2)}`);
        yield { kind: 'entityCreate', entity: id, type: 2, key: `tag-${t}`, added: 0 };
    }
    for (let c = 0; c < CARDS; c++) {
        const id = BigInt(TAGS + 1 + c);
        yield text(id, 1, `card ${c}`);
        yield text(id, 10, words(1500));
        yield text(id, 11, words(200));
        yield text(id, 12, words(200));
        yield text(id, 13, words(400));
        yield text(id, 14, words(800));
        yield { kind: 'jsonValue', entity: id, field: 'data:extensions', json: JSON.stringify({ depth_prompt: words(100) }) };
        yield { kind: 'entityCreate', entity: id, type: 0, key: `c${c}.png`, added: 1_700_000_000_000 };
        for (let k = 0; k < 3; k++) yield { kind: 'tagAssign', entity: id, tag: BigInt(1 + (next() % TAGS)), assigned: true };
    }
}

function* chatRecords() {
    let message = 1n;
    for (let o = 0; o < OWNERS; o++) {
        const owner = BigInt(TAGS + 1 + o);
        let parent = null;
        for (let turn = 0; turn < TURNS; turn++) {
            const user = turn % 2 === 0;
            let first = null;
            for (let s = 0; s < (user ? 1 : 3); s++) {
                const id = message++;
                yield {
                    kind: 'messageAppend', id, owner, time: 1_700_000_000_000 + turn, text: words(user ? 50 : 400), flags: 0, user: 1n,
                    ...(parent === null ? {} : { parent }), ...(user ? {} : { speaker: owner }),
                };
                yield { kind: 'keyMap', message: id, key: Buffer.from(`m-${id}`) };
                if (!user) yield { kind: 'itemization', message: id, raw: false, data: Buffer.from(words(3000)) };
                first ??= id;
            }
            parent = first;
        }
    }
}

test('separate library and chat loads bound resident growth without one spill per card', async () => {
    const dir = path.join(tmp, 'store');
    const store = await engine.Store.open(dir);
    await store.commit([{ kind: 'keyMap', user: 1n, key: Buffer.from('default-user') }]);
    const start = process.memoryUsage().rss;
    let peak = start;
    const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 20);
    const results = [];
    try {
        // The converter installs the library before it starts a separate, owner-ordered chat load.
        for (const records of [libraryRecords, chatRecords]) {
            const load = store.load(BUDGET);
            let batch = [];
            for (const r of records()) {
                batch.push(r);
                if (batch.length === 8000) {
                    await load.add(batch);
                    batch = [];
                }
            }
            await load.add(batch);
            results.push(await load.finish());
        }
    } finally {
        clearInterval(sampler);
        await store.close();
    }
    const stats = results[0];
    peak = Math.max(peak, process.memoryUsage().rss);
    const over = peak - start;
    assert.ok(stats.spills > 0 || stats.keptRuns > 0, `the load spilled nothing: ${JSON.stringify(stats)}`);
    assert.ok(stats.peakBytes <= BUDGET + SLACK, `measured ${stats.peakBytes} past the budget ${BUDGET}`);
    assert.ok(over <= BUDGET + SLACK, `resident memory rose ${Math.round(over / 2 ** 20)} MiB, past ${Math.round(BUDGET / 2 ** 20)} MiB + ${Math.round(SLACK / 2 ** 20)} MiB`);
    assert.ok(stats.spills < CARDS / 2, `spill storm: ${stats.spills} files`);
    assert.ok(results[1].totalMs < 60000, `chat load took ${results[1].totalMs} ms`);
    console.log(`chat load ${Math.round(results[1].totalMs)} ms, ${results[1].spills} spill files`);
    console.log(`resident memory rose ${Math.round(over / 2 ** 20)} MiB at most; budget ${Math.round(BUDGET / 2 ** 20)} MiB, measured peak ${Math.round(stats.peakBytes / 2 ** 20)} MiB, ${stats.spills} spill files`);
});
