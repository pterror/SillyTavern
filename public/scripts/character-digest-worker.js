import { bucketOf, emptyDigest, combineDigest, characterDigestContentHash, DEFAULT_DIGEST_BUCKET_COUNT } from './hash-utils.js';

/**
 * Module Web Worker (see kokoro.js's `new Worker(new URL(...), { type: 'module' })` for this codebase's existing
 * precedent) for script.js's verifyCharacterCacheDigest() - the client half of the state-digest anti-entropy
 * check (character-metadata-db.js's getStateDigest()/getBucketMembers() is the server half; see either side's
 * own doc comment for the full mechanism). Moved off the browser's main thread (2026-08 state-digest perf
 * investigation) for the same reason character-metadata-digest-worker.js moved the equivalent server-side scan
 * off the Express event loop: a real 326k-character cache measured multiple seconds of synchronous
 * fingerprint-extraction + hashing on this thread, which on a browser main thread means a multi-second frozen
 * UI (unresponsive scrolling/typing/clicks), not just queued-up requests.
 *
 * PROTOCOL: the main thread owns reading `getAllCachedCharacters()` (IndexedDB access stays main-thread - see
 * this file's own header note below on why) and sends it here in three phases: exactly one `{type: 'init',
 * bucketCount}` first, then any number of `{type: 'chunk', entries: [[id, character], ...]}`, then exactly one
 * `{type: 'end'}`. This worker replies once, after 'end', with `{buckets, localContentHashes: [[id, hash],
 * ...]}` - a plain array (not a Map - Maps aren't structured-cloneable in every target this project supports)
 * the main thread reconstructs into a Map for the repair pass (see verifyCharacterCacheDigest()'s own use of
 * it).
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

/** @type {{ hi: number, lo: number }[]} */
let buckets = [];
let bucketCount = DEFAULT_DIGEST_BUCKET_COUNT;
/** @type {[string, number][]} */
const localContentHashes = [];

/**
 * @param {[string, object][]} entries
 */
async function processChunk(entries) {
    for (let i = 0; i < entries.length; i += CHUNK_SIZE) {
        const slice = entries.slice(i, i + CHUNK_SIZE);
        for (const [id, character] of slice) {
            const contentHash = characterDigestContentHash(character);
            localContentHashes.push([id, contentHash]);
            const idx = bucketOf(id, bucketCount);
            buckets[idx] = combineDigest(buckets[idx], id, contentHash);
        }
        // eslint-disable-next-line no-undef
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
}

self.addEventListener('message', async (event) => {
    const msg = event.data;
    if (msg.type === 'init') {
        bucketCount = msg.bucketCount;
        buckets = Array.from({ length: bucketCount }, () => emptyDigest());
        return;
    }
    if (msg.type === 'chunk') {
        await processChunk(msg.entries);
        return;
    }
    if (msg.type === 'end') {
        self.postMessage({ buckets, localContentHashes });
    }
});
