import { treeNodeAt, characterDigestFavHash, characterDigestFieldsHash, emptyDigest, combineDigest, foldDigests, DEFAULT_DIGEST_BUCKET_COUNT } from './hash-utils.js';

/**
 * Module Web Worker (see kokoro.js's `new Worker(new URL(...), { type: 'module' })` for this codebase's existing
 * precedent) for script.js's verifyCharacterCacheDigest() - the client half of the hierarchical hash-tree
 * anti-entropy check (character-metadata-db.js's getTreeDigest()/resolveTreeLeaves() is the server half; see
 * either side's own doc comment for the full mechanism). Moved off the browser's main thread (2026-08
 * state-digest perf investigation) for the same reason character-metadata-digest-worker.js moved the equivalent
 * server-side scan off the Express event loop: a real 326k-character cache measured multiple seconds of
 * synchronous fingerprint-extraction + hashing on this thread, which on a browser main thread means a
 * multi-second frozen UI (unresponsive scrolling/typing/clicks), not just queued-up requests.
 *
 * TREE STRUCTURE: same 2-level, branching-256 tree the server builds (see character-metadata-digest-worker.js's
 * own header for the full shape/rationale) - level-0 nodes are exactly the old flat-bucket assignment
 * (treeNodeAt(id, 0) === bucketOf(id)), level-1 subdivides each level-0 bucket into a further branching-way split
 * using the next bits of the id hash. `subtrees` is a flat branching*branching array indexed by `l0 * branching +
 * l1`.
 *
 * PROTOCOL: the main thread owns reading `getAllCachedCharacters()` (IndexedDB access stays main-thread - see
 * this file's own header note below on why) and sends it here in three phases: exactly one `{type: 'init',
 * branching}` first, then any number of `{type: 'chunk', entries: [[id, character], ...]}`, then exactly one
 * `{type: 'end'}`. This worker replies once, after 'end', with `{children, subtrees, localFavHashes: [[id, hash],
 * ...], localFieldsHashes: [[id, hash], ...]}` - `children` is the branching-length array of level-0 digests
 * (fav/fields fold of their level-1 children), `subtrees` is the full level-1 data, and the per-id hash lists are
 * plain arrays (not Maps - Maps aren't structured-cloneable in every target this project supports) the main
 * thread reconstructs into Maps for the repair pass (see verifyCharacterCacheDigest()'s own use of it).
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
 * CHUNKED ON THIS SIDE TOO: even one 'chunk' message's worth of entries is processed in its own internal
 * sub-batches with a `setTimeout(0)` yield between them (see CHUNK_SIZE below) - same reasoning as
 * character-metadata-digest-worker.js's own internal chunking: this worker should stay responsive to a future
 * cancellation/second request rather than running one long synchronous stretch, even though it's already off
 * the main thread.
 */

/** Sub-batch size processed between yields within a single 'chunk' message - see this module's own header. */
const CHUNK_SIZE = 2000;

let branching = DEFAULT_DIGEST_BUCKET_COUNT;
/** @type {{ fav: { hi: number, lo: number }, fields: { hi: number, lo: number } }[]} */
let subtrees = []; // flat array, index = l0 * branching + l1
/** @type {[string, number][]} */
const localFavHashes = [];
/** @type {[string, number][]} */
const localFieldsHashes = [];

/**
 * @param {[string, object][]} entries
 */
async function processChunk(entries) {
    for (let i = 0; i < entries.length; i += CHUNK_SIZE) {
        const slice = entries.slice(i, i + CHUNK_SIZE);
        for (const [id, character] of slice) {
            const favHash = characterDigestFavHash(character);
            const fieldsHash = characterDigestFieldsHash(character);
            localFavHashes.push([id, favHash]);
            localFieldsHashes.push([id, fieldsHash]);
            const l0 = treeNodeAt(id, 0, branching);
            const l1 = treeNodeAt(id, 1, branching);
            const idx = l0 * branching + l1;
            subtrees[idx].fav = combineDigest(subtrees[idx].fav, id, favHash);
            subtrees[idx].fields = combineDigest(subtrees[idx].fields, id, fieldsHash);
        }
        // eslint-disable-next-line no-undef
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
}

self.addEventListener('message', async (event) => {
    const msg = event.data;
    if (msg.type === 'init') {
        branching = msg.branching ?? msg.bucketCount ?? DEFAULT_DIGEST_BUCKET_COUNT;
        const size = branching * branching;
        subtrees = Array.from({ length: size }, () => ({ fav: emptyDigest(), fields: emptyDigest() }));
        return;
    }
    if (msg.type === 'chunk') {
        await processChunk(msg.entries);
        return;
    }
    if (msg.type === 'end') {
        // Fold level-1 up to level-0
        const children = [];
        for (let l0 = 0; l0 < branching; l0++) {
            let fav = emptyDigest();
            let fields = emptyDigest();
            for (let l1 = 0; l1 < branching; l1++) {
                const idx = l0 * branching + l1;
                fav = foldDigests(fav, subtrees[idx].fav);
                fields = foldDigests(fields, subtrees[idx].fields);
            }
            children.push({ fav, fields });
        }
        self.postMessage({ children, subtrees, localFavHashes, localFieldsHashes });
    }
});
