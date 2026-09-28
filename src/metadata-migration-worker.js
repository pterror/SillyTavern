import { parentPort, workerData } from 'node:worker_threads';

import { setConfigFilePath } from './util.js';

/**
 * One user store's metadata migration worker (spawned by metadata-migration-coordinator.js). Runs the store's
 * one-time migration passes on its own database connection, in MIGRATION_PASSES order, then exits. A pass that
 * throws stops the passes after it; each is retried next boot, since its done-marker is written last.
 *
 * Messages to the coordinator:
 *   { type: 'batch', changed, tagDefinitionsChanged }   a batch committed that wrote change rows (changed) and/or
 *                                                     tag definitions (tagDefinitionsChanged).
 *   { type: 'error', message }
 * Requests from the coordinator: { type: 'close' }: stop before the next pass, then exit.
 */

const { directories, configPath } = workerData;

// Must precede importing anything that reads config.
if (configPath) {
    setConfigFilePath(configPath);
}
const metadataDb = await import('./character-metadata-db.js');
const { MIGRATION_PASSES } = await import('./metadata-migration-coordinator.js');

/** @param {object} msg */
const post = (msg) => parentPort?.postMessage(msg);

// Both events fire inside a pass's synchronous transaction, so the microtask runs once that batch has committed.
let changed = false;
let tagDefinitionsChanged = false;
let batchReportQueued = false;
function queueBatchReport() {
    if (batchReportQueued) return;
    batchReportQueued = true;
    queueMicrotask(() => {
        post({ type: 'batch', changed, tagDefinitionsChanged });
        changed = false;
        tagDefinitionsChanged = false;
        batchReportQueued = false;
    });
}
metadataDb.characterChangeEmitter.on('change', () => {
    changed = true;
    queueBatchReport();
});
metadataDb.characterChangeEmitter.on(metadataDb.TAG_DEFINITIONS_CHANGED_EVENT, () => {
    tagDefinitionsChanged = true;
    queueBatchReport();
});

let closing = false;
parentPort?.on('message', (msg) => {
    if (msg?.type === 'close') closing = true;
});

async function runPasses() {
    const chainStart = process.hrtime.bigint();
    for (const name of MIGRATION_PASSES) {
        if (closing) return;
        const start = process.hrtime.bigint();
        console.log(`[boot-timing] [metadata-migrations] (${directories.root}) ${name}: start`);
        try {
            await metadataDb[name](directories);
        } catch (err) {
            post({ type: 'error', message: `${name} failed for ${directories.root}, skipping the passes after it until next boot: ${err?.stack ?? err}` });
            return;
        }
        const now = process.hrtime.bigint();
        console.log(`[boot-timing] [metadata-migrations] (${directories.root}) ${name}: ${Number(now - start) / 1e6}ms (migrations total so far: ${Number(now - chainStart) / 1e6}ms)`);
    }
}

await runPasses();
metadataDb.disposeMetadataStores();
parentPort?.close();
