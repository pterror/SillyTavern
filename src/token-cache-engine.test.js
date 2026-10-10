// The token-count cache on the engine answers as the old store's tables do, and keeps each table at its cap.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { loadEngine } from '../engine/load.js';

(await import('./util.js')).setConfigFilePath(path.join(import.meta.dirname, '..', 'default', 'config.yaml'));
const old = await import('./token-count-store.js');
const { disposeMessageTreeStores } = await import('./message-tree-db.js');
const { TokenCache } = await import('./token-cache-engine.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-cache-test-'));
after(() => {
    disposeMessageTreeStores();
    fs.rmSync(root, { recursive: true, force: true });
});

const DAY = old.LAST_USED_GRANULARITY_MS;
const hash = n => old.tokenKeyHash(old.TOKEN_KEY_KINDS.TEXT, `text ${n}`);

for (const [kind, engine] of Object.entries({ native: loadEngine().binding, wasm: loadEngine({ platform: null }).binding })) {
    test(`${kind}: counts and ids kept, replaced, filled and evicted as the old tables`, async () => {
        const directories = { root: path.join(root, `old-${kind}`) };
        fs.mkdirSync(directories.root);
        const limits = { cap: 5, batchRows: 2, pauseMs: 0 };
        const store = await engine.Store.open(path.join(root, `engine-${kind}`));
        const cache = new TokenCache(store, limits);
        const both = async (pending, now) => {
            const o = await old.writeBack(directories, pending, now, limits);
            const n = await cache.writeBack(pending, now);
            assert.deepEqual(n, o);
            await cache.idle();
            await old.tokenCountMaintenanceIdle(directories);
        };
        const same = async (identity, n) => {
            assert.equal(await cache.readCount(identity, hash(n)), await old.readCount(directories, identity, hash(n)), `count ${n}`);
            assert.deepEqual(await cache.readIdsRow(identity, hash(n)), await old.readIdsRow(directories, identity, hash(n)), `ids ${n}`);
        };
        await both({ counts: [{ identity: 'tok', hash: hash(0), count: 12 }], ids: [{ identity: 'tok', hash: hash(0), ids: [1, 200, 70000] }] }, 1_000);
        await same('tok', 0);
        // A count kept, then replaced on purpose; ids filled with their chunks; another tokenizer apart.
        await both({ counts: [{ identity: 'tok', hash: hash(0), count: 99 }, { identity: 'other', hash: hash(0), count: 3 }], ids: [{ identity: 'tok', hash: hash(0), ids: [5], chunks: ['a', 'b\ud800', 'c'] }] }, 2_000);
        await same('tok', 0);
        await same('other', 0);
        await both({ counts: [{ identity: 'tok', hash: hash(0), count: 13, replace: true }] }, 3_000);
        await same('tok', 0);
        // Past the cap, the least recently used go; one used again a day later stays.
        for (let n = 1; n <= 6; n++) await both({ counts: [{ identity: 'tok', hash: hash(n), count: n }] }, 10_000 + n);
        await both({ counts: [{ identity: 'tok', hash: hash(1), count: 1 }] }, 10_000 + DAY);
        await both({ counts: [{ identity: 'tok', hash: hash(7), count: 7 }] }, 20_000 + DAY);
        for (let n = 0; n <= 7; n++) await same('tok', n);
        await same('other', 0);
        assert.equal(await store.chatRead('tokenCacheCount', { table: 0 }), 5);
        await store.close();
    });
}
