// File-derived dates retain fractional milliseconds through loads, updates, ordering and reopen.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadEngine } from './load.js';

test('fractional dates added survive loading, updating, ordering and reopening', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-engine-fractional-dates-'));
    const engine = loadEngine().binding;
    let store;
    try {
        store = await engine.Store.open(dir);
        const load = store.load(256 << 20);
        await load.add([
            { kind: 'entityCreate', entity: 1n, type: 0, key: 'one.png', added: 1700000000000.75 },
            { kind: 'entityCreate', entity: 2n, type: 0, key: 'two.png', added: 1700000000000.25 },
        ]);
        await load.finish();
        const order = () => store.libraryPage({ characters: true, sort: { key: 2 }, limit: 2 });
        assert.deepEqual((await order()).ids, [2n, 1n]);
        await store.commit([{ kind: 'entityUpdate', entity: 1n, type: 0, key: 'one.png', added: 1700000000000.125 }]);
        assert.deepEqual((await order()).ids, [1n, 2n]);
        await store.close();
        store = await engine.Store.open(dir);
        assert.deepEqual((await store.libraryEntities([1n, 2n])).map(e => e.added), [1700000000000.125, 1700000000000.25]);
        assert.deepEqual((await order()).ids, [1n, 2n]);
    } finally {
        await store?.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
