import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { setConfigFilePath } from './util.js';

const here = path.dirname(fileURLToPath(import.meta.url));
setConfigFilePath(path.join(here, '..', 'default', 'config.yaml'));
const { LocalImportWorkerPool } = await import('./local-import-worker-pool.js');

// A pool's workers relay their output by write: none is piped into the process's stdout or stderr, which would add an
// `error` listener per worker there (a pool of 16 ran past the listener limit, warned at every boot).
test('a pool of workers adds no listener to the process\'s output', async () => {
    const before = [process.stdout.listenerCount('error'), process.stderr.listenerCount('error')];
    const pool = new LocalImportWorkerPool(12);
    try {
        await new Promise(resolve => setTimeout(resolve, 200));
        assert.deepEqual([process.stdout.listenerCount('error'), process.stderr.listenerCount('error')], before);
    } finally {
        await pool.dispose();
    }
});
