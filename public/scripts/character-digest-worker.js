import { getStringHash, treeNodeAt, characterDigestFavHash, characterDigestFieldsHash, emptyDigest, combineDigest, foldDigests, DEFAULT_DIGEST_BUCKET_COUNT, DEFAULT_TREE_BRANCHING } from './hash-utils.js';

/**
 * Module Web Worker (see kokoro.js's `new Worker(new URL(...), { type: 'module' })` for this codebase's existing
 * precedent) for script.js's verifyCharacterCacheDigest() - the client half of the recursive hash-tree
 * anti-entropy check (character-metadata-db.js's treeDescend() is the server half; character-metadata-digest-
 * worker.js's own header has the full mechanism). Moved off the browser's main thread (2026-08 state-digest perf
 * investigation) for the same reason character-metadata-digest-worker.js moved the equivalent server-side scan
 * off the Express event loop: a real 326k-character cache measured multiple seconds of synchronous fingerprint-
 * extraction + hashing on this thread, which on a browser main thread means a multi-second frozen UI
 * (unresponsive scrolling/typing/clicks), not just queued-up requests.
 *
 * PERSISTENT WORKER, unlike the fixed-depth-2 approach this replaces: the worker stays alive after its initial
 * `'end'` response instead of terminating, because the recursive descent protocol needs the worker to keep
 * computing children digests for whichever deeper tree nodes the server's own descent turns up as mismatched -
 * there's no way to know how many levels deep that goes up front (see character-metadata-digest-worker.js's own
 * header on why the depth isn't fixed). The main thread (verifyCharacterCacheDigest() in script.js) is
 * responsible for calling `worker.terminate()` once the descent finishes or errors.
 *
 * PROTOCOL: the main thread owns reading `getAllCachedCharacters()` (IndexedDB access stays main-thread - see
 * this file's own header note below on why) and sends it here in three phases: exactly one `{type: 'init',
 * branching}` first, then any number of `{type: 'chunk', entries: [[id, character], ...]}`, then exactly one
 * `{type: 'end'}`. This worker replies once to that sequence, with `{type: 'ready', children, localFavHashes:
 * [[id, hash], ...], localFieldsHashes: [[id, hash], ...]}` - `children` is the branching-length array of
 * level-0 digests, and the per-id hash lists are plain arrays (not Maps - Maps aren't structured-cloneable in
 * every target this project supports) the main thread reconstructs into Maps for the repair pass.
 *
 * After that, the main thread can send any number of `{type: 'compute-digests', nodes: [{path: [...]}, ...]}`
 * messages - each one asks this still-alive worker to compute children digests for specific deeper tree nodes
 * (id -> hash/favHash/fieldsHash are all kept in the `records` Map below, computed once up front, so a deeper-
 * level request is just a re-fold over already-hashed data, not a re-extraction). Each such message gets exactly
 * one `{type: 'digests', results: [{path, children}, ...]}` reply.
 *
 * NOT given its own IndexedDB access (unlike character-metadata-digest-worker.js, which DOES open its own
 * sqlite connection): localforage's driver selection/feature-detection (lib.js) hasn't been verified safe to
 * run inside a Worker global scope on every browser this app supports, and getCurrentUserHandle() (which
 * character-cache.js's store lookup depends on) reads app state that isn't obviously available off the main
 * thread either. Chunked message-passing sidesteps both unknowns entirely - the worker only ever receives plain,
 * already-resolved data - at the cost of the main thread doing the (cheap, IndexedDB-native) read and the
 * postMessage clone of already-fetched data, not a second copy of the actual heavy work (fingerprint
 * extraction/canonicalization/hashing, all done here).
 *
 * CHUNKED ON THIS SIDE TOO: both the initial 'chunk' ingestion and 'compute-digests' handling process records in
 * their own internal sub-batches with a yield between them - same reasoning as character-metadata-digest-
 * worker.js's own internal chunking: this worker should stay responsive to a future cancellation/second request
 * rather than running one long synchronous stretch, even though it's already off the main thread.
 */

let branching = DEFAULT_DIGEST_BUCKET_COUNT;
/** @type {Map<string, { hash: number, favHash: number, fieldsHash: number }>} id -> precomputed data */
const records = new Map();

/**
 * @param {[string, object][]} entries
 */
function processChunk(entries) {
    for (const [id, character] of entries) {
        records.set(id, {
            hash: getStringHash(String(id)),
            favHash: characterDigestFavHash(character),
            fieldsHash: characterDigestFieldsHash(character),
        });
    }
}

/**
 * Returns the tree-node index at a given level for a pre-computed id hash - same math as hash-utils.js's
 * treeNodeAt(), but takes the raw hash directly rather than re-hashing the id on every level check.
 * @param {number} hash
 * @param {number} level
 * @returns {number}
 */
function levelOf(hash, level) {
    return Math.floor(hash / Math.pow(branching, level)) % branching;
}

/**
 * Checks whether a record (identified by its pre-computed hash) falls under a given tree node path.
 * @param {number} hash
 * @param {number[]} path
 * @returns {boolean}
 */
function isInSubtree(hash, path) {
    for (let l = 0; l < path.length; l++) {
        if (levelOf(hash, l) !== path[l]) return false;
    }
    return true;
}

/**
 * Computes children digests for each requested node by iterating the already-hashed `records` Map once, folding
 * every record that falls under a given node's subtree into that node's own branching-length children array.
 * @param {{ path: number[] }[]} nodes
 */
async function handleComputeDigests(nodes) {
    const results = nodes.map(n => ({
        path: n.path,
        depth: n.path.length,
        childFav: Array.from({ length: branching }, () => emptyDigest()),
        childFields: Array.from({ length: branching }, () => emptyDigest()),
    }));

    let processed = 0;
    for (const [id, { hash, favHash, fieldsHash }] of records) {
        for (let n = 0; n < results.length; n++) {
            const r = results[n];
            if (!isInSubtree(hash, r.path)) continue;
            const childIdx = levelOf(hash, r.depth);
            r.childFav[childIdx] = combineDigest(r.childFav[childIdx], id, favHash);
            r.childFields[childIdx] = combineDigest(r.childFields[childIdx], id, fieldsHash);
        }
        if (++processed % 5000 === 0) {
            // eslint-disable-next-line no-undef
            await new Promise(resolve => setTimeout(resolve, 0));
        }
    }

    self.postMessage({
        type: 'digests',
        results: results.map(r => ({
            path: r.path,
            children: r.childFav.map((fav, i) => ({ fav, fields: r.childFields[i] })),
        })),
    });
}

self.addEventListener('message', async (event) => {
    const msg = event.data;
    if (msg.type === 'init') {
        branching = msg.branching ?? DEFAULT_TREE_BRANCHING;
        records.clear();
        return;
    }
    if (msg.type === 'chunk') {
        processChunk(msg.entries);
        return;
    }
    if (msg.type === 'end') {
        // Compute level-0 children from records
        const childFav = Array.from({ length: branching }, () => emptyDigest());
        const childFields = Array.from({ length: branching }, () => emptyDigest());

        for (const [id, { hash, favHash, fieldsHash }] of records) {
            const l0 = hash % branching;
            childFav[l0] = combineDigest(childFav[l0], id, favHash);
            childFields[l0] = combineDigest(childFields[l0], id, fieldsHash);
        }

        const children = childFav.map((fav, i) => ({ fav, fields: childFields[i] }));

        // Build per-record hash arrays for the main thread's Maps
        const localFavHashes = [];
        const localFieldsHashes = [];
        for (const [id, { favHash, fieldsHash }] of records) {
            localFavHashes.push([id, favHash]);
            localFieldsHashes.push([id, fieldsHash]);
        }

        self.postMessage({ type: 'ready', children, localFavHashes, localFieldsHashes });
        // Worker stays alive - the main thread will send further 'compute-digests' requests as the descent goes
        // deeper, and is responsible for terminate()'ing this worker once it's done with it.
        return;
    }
    if (msg.type === 'compute-digests') {
        await handleComputeDigests(msg.nodes);
        return;
    }
});
