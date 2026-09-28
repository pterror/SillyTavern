import { parentPort, workerData } from 'node:worker_threads';

import { setConfigFilePath } from './util.js';

/**
 * One user store's metadata migration worker (spawned by metadata-migration-coordinator.js). Runs the store's
 * migration passes named in workerData.passes (all of MIGRATION_PASSES when absent) on its own database connection,
 * in that order, then exits. A pass that throws stops the passes after it; each is retried next boot, since its
 * done-marker is written last. workerData.boot is set for the once-per-boot run, whose lines are [boot-timing] ones.
 *
 * Messages to the coordinator:
 *   { type: 'batch', changed, tagDefinitionsChanged }   a batch committed that wrote change rows (changed) and/or
 *                                                     tag definitions (tagDefinitionsChanged).
 *   { type: 'tag-move-failed', payload }               a queued tag move couldn't be applied (reportTagMoveFailed()).
 *   { type: 'error', message }
 * Requests from the coordinator: { type: 'close' }: stop before the next pass, then exit.
 */

const { directories, configPath, boot = true } = workerData;

// Must precede importing anything that reads config.
if (configPath) {
    setConfigFilePath(configPath);
}
const metadataDb = await import('./character-metadata-db.js');
const { MIGRATION_PASSES } = await import('./metadata-migration-coordinator.js');
/** @type {readonly string[]} */
const passes = workerData.passes ?? MIGRATION_PASSES;
const logPrefix = boot ? '[boot-timing] [metadata-migrations]' : '[metadata-migrations]';

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
// The main process reports it on to the user's clients, or logs it.
metadataDb.characterChangeEmitter.on(metadataDb.TAG_MOVE_FAILED_EVENT, (root, payload, ack) => {
    post({ type: 'tag-move-failed', payload });
    ack.delivered = true;
});

let closing = false;
parentPort?.on('message', (msg) => {
    if (msg?.type === 'close') closing = true;
});

async function runPasses() {
    const chainStart = process.hrtime.bigint();
    for (const name of passes) {
        if (closing) return;
        const start = process.hrtime.bigint();
        console.log(`${logPrefix} (${directories.root}) ${name}: start`);
        /** @type {any} */
        let result;
        try {
            result = await metadataDb[name](directories);
        } catch (err) {
            post({ type: 'error', message: `${name} failed for ${directories.root}, skipping the passes after it until next boot: ${err?.stack ?? err}` });
            return;
        }
        const now = process.hrtime.bigint();
        const counts = typeof result?.batches === 'number' ? `, ${result.batches} batch(es), ${result.rowsChanged} row(s) changed` : '';
        console.log(`${logPrefix} (${directories.root}) ${name}: ${Number(now - start) / 1e6}ms${counts} (migrations total so far: ${Number(now - chainStart) / 1e6}ms)`);
    }
}

await runPasses();
metadataDb.disposeMetadataStores();
parentPort?.close();
