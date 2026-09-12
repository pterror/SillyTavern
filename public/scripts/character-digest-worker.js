import { getStringHash, emptyDigest128, combineDigest128, DEFAULT_DIGEST_BUCKET_COUNT, DEFAULT_TREE_BRANCHING } from './hash-utils.js';

/**
 * Client half of the recursive hash-tree anti-entropy check (verifyCharacterCacheDigest() in script.js);
 * character-metadata-digest-worker.js is the server half. Runs off the main thread since hashing a large
 * character cache synchronously would freeze the UI.
 *
 * Stays alive after its initial 'ready' reply (unlike a one-shot worker) because the recursive descent can't
 * know up front how many tree levels the server will ask it to re-fold; the main thread sends further
 * 'compute-digests' requests as needed and is responsible for terminate()'ing this worker when done.
 *
 * No IndexedDB access of its own - localforage/getCurrentUserHandle() aren't verified safe off the main thread
 * - so the main thread reads the cache and streams it in via postMessage ('init', then any number of 'chunk',
 * then 'end'); per-id hashes are sent back as arrays rather than Maps since Maps aren't structured-cloneable
 * everywhere.
 */

let branching = DEFAULT_DIGEST_BUCKET_COUNT;
/** @type {Map<string, { hash: number, favHash: number, tagIdsHash: number, contentHash: number }>} id -> precomputed data */
const records = new Map();

/**
 * @param {[string, {fav: number, tagIds: number, content: number}][]} entries Pre-computed per-field
 * hashes from character-cache.js's saveCachedCharacters(), stored atomically with the character data.
 */
function processChunk(entries) {
    for (const [id, hashes] of entries) {
        records.set(id, {
            hash: getStringHash(String(id)),
            favHash: hashes.fav,
            tagIdsHash: hashes.tagIds,
            contentHash: hashes.content,
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
        childDigest: Array.from({ length: branching }, () => emptyDigest128()),
    }));

    let processed = 0;
    for (const [id, { hash, favHash, tagIdsHash, contentHash }] of records) {
        for (let n = 0; n < results.length; n++) {
            const r = results[n];
            if (!isInSubtree(hash, r.path)) continue;
            const childIdx = levelOf(hash, r.depth);
            r.childDigest[childIdx] = combineDigest128(r.childDigest[childIdx], id, favHash, tagIdsHash, contentHash);
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
            children: r.childDigest.map(digest => ({ digest })),
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
        const childDigest = Array.from({ length: branching }, () => emptyDigest128());

        for (const [id, { hash, favHash, tagIdsHash, contentHash }] of records) {
            const l0 = hash % branching;
            childDigest[l0] = combineDigest128(childDigest[l0], id, favHash, tagIdsHash, contentHash);
        }

        const children = childDigest.map(digest => ({ digest }));

        // Build per-record hash arrays for the main thread's Maps
        const localHashes = [];
        for (const [id, { favHash, tagIdsHash, contentHash }] of records) {
            localHashes.push([id, { fav: favHash, tagIds: tagIdsHash, content: contentHash }]);
        }

        self.postMessage({ type: 'ready', children, localHashes });
        // Worker stays alive - the main thread will send further 'compute-digests' requests as the descent goes
        // deeper, and is responsible for terminate()'ing this worker once it's done with it.
        return;
    }
    if (msg.type === 'compute-digests') {
        await handleComputeDigests(msg.nodes);
        return;
    }
});
