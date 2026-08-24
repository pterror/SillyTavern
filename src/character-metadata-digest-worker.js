import { parentPort } from 'node:worker_threads';

import { getSqliteEngine } from './endpoints/sqlite-engine.js';
import { treeNodeAt, emptyDigest, combineDigest, foldDigests, characterDigestFavHash, characterDigestFieldsHash, characterDigestFingerprint, DEFAULT_DIGEST_BUCKET_COUNT } from '../public/scripts/hash-utils.js';

/**
 * worker_threads entry point for the hierarchical hash-tree anti-entropy check (POST /api/characters/tree-digest
 * and POST /api/characters/tree-resolve). Supersedes the previous flat-bucket state-digest/bucket-members
 * approach with a real 2-level N-ary tree that localizes diverged records through descent rather than
 * brute-force bucket-member comparison.
 *
 * The tree structure: branching-factor-256 (matching the existing DEFAULT_DIGEST_BUCKET_COUNT), 2 levels deep.
 * Level-0 nodes are exactly the old bucketOf() buckets (treeNodeAt(id, 0) === bucketOf(id)). Level-1 nodes
 * subdivide each level-0 bucket using the next 8 bits of the id hash. Each leaf group (identified by its
 * [l0, l1] path) contains roughly corpusSize / 256^2 records (~5 at 326k, ~15 at 1M, ~153 at 10M).
 *
 * Deterministic and stable by construction: a record's tree path depends only on its own id hash, never on
 * other records in the corpus. Adding or removing records changes no existing record's path.
 *
 * Two message types:
 *  - 'tree-digest': full-table scan, builds the 2-level tree, returns level-0 children hashes PLUS the full
 *    level-1 subtree data for the main thread to cache in memory (~2MB at 10M records) for the subsequent
 *    tree-resolve call.
 *  - 'tree-resolve': given a list of specific leaf groups (by [l0, l1] path), scans all records, filters to
 *    those leaf groups, returns member data including per-record hashes AND full fingerprint field values (so
 *    the client can repair without any additional fetch).
 *
 * Same off-main-thread / WAL-safe / spawn-per-call / chunked-with-yields rationale as the previous worker
 * implementation - see the old header for the full reasoning on each of those properties (all still apply
 * unchanged, just operating over a tree structure instead of a flat bucket array).
 */

/** Rows processed between yields - see module header. */
const CHUNK_SIZE = 5000;

/**
 * @param {string} dbPath
 * @returns {Promise<import('./endpoints/sqlite-engine.js').SqliteEngineHandle | null>}
 */
async function openReadOnly(dbPath) {
    const engine = await getSqliteEngine();
    if (!engine) return null;
    return engine.openDatabase(dbPath);
}

/**
 * Builds the full 2-level hash tree over the characters table. Two independent hash streams per node (fav and
 * fields) so the client can distinguish fav-only drift from content-field drift.
 *
 * Returns:
 * - `children`: branching-length array of level-0 child digests, each `{ fav: {hi,lo}, fields: {hi,lo} }`
 * - `subtrees`: branching × branching array of level-1 digests (flat index: l0 * branching + l1)
 *
 * The level-0 digests are the XOR-fold of their level-1 children (same math as flat-bucket digests, so
 * level 0 is backward-compatible: treeNodeAt(id, 0) === bucketOf(id)).
 * @param {string} dbPath
 * @param {number} branching
 */
async function computeTreeDigest(dbPath, branching) {
    const db = await openReadOnly(dbPath);
    if (!db) return null;
    try {
        const rows = db.all('SELECT id, shallow_json FROM characters');
        const size = branching * branching;

        // Level-1 leaf node digests: flat array indexed by l0 * branching + l1
        const subtrees = Array.from({ length: size }, () => ({
            fav: emptyDigest(),
            fields: emptyDigest(),
        }));

        for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
            for (let j = i; j < Math.min(i + CHUNK_SIZE, rows.length); j++) {
                const row = rows[j];
                const parsed = JSON.parse(row.shallow_json);
                const l0 = treeNodeAt(row.id, 0, branching);
                const l1 = treeNodeAt(row.id, 1, branching);
                const idx = l0 * branching + l1;
                const favHash = characterDigestFavHash(parsed);
                const fieldsHash = characterDigestFieldsHash(parsed);
                subtrees[idx].fav = combineDigest(subtrees[idx].fav, row.id, favHash);
                subtrees[idx].fields = combineDigest(subtrees[idx].fields, row.id, fieldsHash);
            }
            await new Promise((resolve) => setImmediate(resolve));
        }

        // Fold level-1 up to level-0 children
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

        return { children, subtrees };
    } finally {
        db.close();
    }
}

/**
 * Resolves specific leaf groups to their full member data: per-record hashes for the client to compare against
 * its own locally-computed hashes (true pinpointing - the tree descent identified WHICH leaf groups diverged,
 * and the per-record hashes within those groups identify the exact records), plus full fingerprint field values
 * for direct repair (no additional fetch needed by the client).
 *
 * The fingerprint values in the response are what `characterDigestFingerprint()` extracts from `shallow_json`:
 * name, fav, tags, data.{name, character_version, creator, tags, creator_notes, extensions.{fav, world}}.
 * These are ALL the fields the digest mechanism covers, so a client that patches these fields into its cached
 * copy will bring it into exact agreement with the server's ground truth for those fields.
 * @param {string} dbPath
 * @param {{ l0: number, l1: number }[]} targetLeaves Leaf groups to resolve, identified by tree path.
 * @param {number} branching
 */
async function resolveTreeLeaves(dbPath, targetLeaves, branching) {
    const db = await openReadOnly(dbPath);
    if (!db) return null;
    try {
        const targetSet = new Set(targetLeaves.map(t => t.l0 * branching + t.l1));
        /** @type {Map<number, { path: number[], members: object[] }>} */
        const leafMap = new Map();
        for (const t of targetLeaves) {
            leafMap.set(t.l0 * branching + t.l1, { path: [t.l0, t.l1], members: [] });
        }

        const rows = db.all('SELECT id, shallow_json FROM characters');
        for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
            for (let j = i; j < Math.min(i + CHUNK_SIZE, rows.length); j++) {
                const row = rows[j];
                const l0 = treeNodeAt(row.id, 0, branching);
                const l1 = treeNodeAt(row.id, 1, branching);
                const idx = l0 * branching + l1;
                if (!targetSet.has(idx)) continue;

                const parsed = JSON.parse(row.shallow_json);
                leafMap.get(idx).members.push({
                    id: row.id,
                    favHash: characterDigestFavHash(parsed),
                    fieldsHash: characterDigestFieldsHash(parsed),
                    fingerprint: characterDigestFingerprint(parsed),
                });
            }
            await new Promise((resolve) => setImmediate(resolve));
        }

        return { leaves: Array.from(leafMap.values()) };
    } finally {
        db.close();
    }
}

parentPort.on('message', async (msg) => {
    try {
        if (msg.type === 'tree-digest') {
            const result = await computeTreeDigest(msg.dbPath, msg.branching ?? DEFAULT_DIGEST_BUCKET_COUNT);
            parentPort.postMessage({ id: msg.id, ok: true, result });
            return;
        }
        if (msg.type === 'tree-resolve') {
            const result = await resolveTreeLeaves(msg.dbPath, msg.targetLeaves, msg.branching ?? DEFAULT_DIGEST_BUCKET_COUNT);
            parentPort.postMessage({ id: msg.id, ok: true, result });
            return;
        }
        parentPort.postMessage({ id: msg.id, ok: false, error: `Unknown message type: ${msg.type}` });
    } catch (err) {
        parentPort.postMessage({ id: msg.id, ok: false, error: /** @type {any} */ (err)?.message ?? String(err) });
    }
});
