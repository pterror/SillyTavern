// The token-count cache on the engine answers as the old store's tables did, and keeps each table at its cap.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { loadEngine } from '../engine/load.js';

(await import('./util.js')).setConfigFilePath(path.join(import.meta.dirname, '..', 'default', 'config.yaml'));
const { LAST_USED_GRANULARITY_MS: DAY, tokenKeyHash, TOKEN_KEY_KINDS } = await import('./token-count-store.js');
const { TokenCache } = await import('./token-cache-engine.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-cache-test-'));
after(() => {
    fs.rmSync(root, { recursive: true, force: true });
});

const hash = (/** @type {number} */ n) => tokenKeyHash(TOKEN_KEY_KINDS.TEXT, `text ${n}`);

for (const [kind, engine] of Object.entries({ native: loadEngine().binding, wasm: loadEngine({ platform: null }).binding })) {
    test(`${kind}: counts and ids kept, replaced, filled and evicted as the old tables`, async () => {
        const store = await engine.Store.open(path.join(root, `engine-${kind}`));
        const cache = new TokenCache(store, { cap: 5, batchRows: 2, pauseMs: 0 });
        /** @type {string[][]} */
        const prunes = [];
        const write = async (/** @type {any} */ pending, /** @type {number} */ now) => {
            prunes.push((await cache.writeBack(pending, now)).prunesScheduled);
            await cache.idle();
        };
        await write({ counts: [{ identity: 'tok', hash: hash(0), count: 12 }], ids: [{ identity: 'tok', hash: hash(0), ids: [1, 200, 70000] }] }, 1_000);
        assert.equal(await cache.readCount('tok', hash(0)), 12);
        assert.deepEqual(await cache.readIdsRow('tok', hash(0)), { ids: [1, 200, 70000], chunks: null });
        // A count kept, then replaced on purpose; ids filled with their chunks; another tokenizer apart.
        await write({ counts: [{ identity: 'tok', hash: hash(0), count: 99 }, { identity: 'other', hash: hash(0), count: 3 }], ids: [{ identity: 'tok', hash: hash(0), ids: [5], chunks: ['a', 'b\ud800', 'c'] }] }, 2_000);
        assert.equal(await cache.readCount('tok', hash(0)), 12, 'a stored count keeps its value');
        assert.deepEqual(await cache.readIdsRow('tok', hash(0)), { ids: [1, 200, 70000], chunks: ['a', 'b\ud800', 'c'] }, 'stored ids take the chunks given');
        assert.equal(await cache.readCount('other', hash(0)), 3);
        assert.equal(await cache.readIdsRow('other', hash(0)), null);
        await write({ counts: [{ identity: 'tok', hash: hash(0), count: 13, replace: true }] }, 3_000);
        assert.equal(await cache.readCount('tok', hash(0)), 13, 'a replacing count writes over it');
        // Past the cap, the least recently used go; one used again a day later stays.
        for (let n = 1; n <= 6; n++) await write({ counts: [{ identity: 'tok', hash: hash(n), count: n }] }, 10_000 + n);
        await write({ counts: [{ identity: 'tok', hash: hash(1), count: 1 }] }, 10_000 + DAY);
        await write({ counts: [{ identity: 'tok', hash: hash(7), count: 7 }] }, 20_000 + DAY);
        const counts = [];
        for (let n = 0; n <= 7; n++) counts.push(await cache.readCount('tok', hash(n)));
        assert.deepEqual(counts, [null, 1, null, null, 4, 5, 6, 7]);
        assert.equal(await cache.readCount('other', hash(0)), null);
        assert.equal(await store.chatRead('tokenCacheCount', { table: 0 }), 5);
        assert.deepEqual(prunes, [[], [], [], [], [], [], ['token_counts'], ['token_counts'], ['token_counts'], ['token_counts'], ['token_counts']], 'an eviction scheduled whenever a write leaves the table over its cap');
        await store.close();
    });
}
