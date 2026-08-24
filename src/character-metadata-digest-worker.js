import { parentPort } from 'node:worker_threads';

import { getSqliteEngine } from './endpoints/sqlite-engine.js';
import { getStringHash, emptyDigest, combineDigest, foldDigests, characterDigestFavHash, characterDigestFieldsHash, characterDigestFingerprint, DEFAULT_DIGEST_BUCKET_COUNT } from '../public/scripts/hash-utils.js';

/**
 * worker_threads entry point for the recursive hash-tree anti-entropy check (POST /api/characters/tree-descend).
 *
 * Genuinely recursive: the client calls the endpoint repeatedly, descending one level per round trip into
 * whichever subtrees mismatched, until every divergence is either resolved to individual records or reaches a
 * group small enough (≤ leafThreshold records) that comparing its members directly costs less than one more
 * round trip would. The tree depth is NOT fixed — it's O(log_N(corpusSize / leafThreshold)), naturally adapting
 * to corpus size (2 levels at 326k, 2-3 at 10M with default threshold).
 *
 * Single message type: 'tree-descend'. Given a list of tree-node paths to expand, this worker scans the
 * characters table and for each node either:
 *  - returns N children hashes (if the subtree is larger than leafThreshold), or
 *  - returns the subtree's full member data (per-record hashes + fingerprint field values for direct repair)
 *    if the subtree is small enough to resolve directly.
 *
 * The server decides the cutoff per node based on actual subtree size — the client doesn't need to know the
 * corpus size or predict the tree depth.
 *
 * Each call is stateless (no caching between requests). The table scan is O(N) per call regardless of how many
 * nodes are requested, because a single pass can accumulate data for all requested nodes simultaneously. Total
 * server work across a full descent: O(N × depth) where depth = O(log_N(corpusSize / leafThreshold)), with
 * each scan running off the main thread in this worker.
 *
 * Two-phase scan for each call: pass 1 counts records per node and accumulates children digests (cheap — just
 * XOR folds); pass 2 (only for nodes determined to be leaves) collects member data (JSON.parse +
 * characterDigestFingerprint, heavier but only for the small leaf subtrees). This avoids wastefully parsing
 * shallow_json for the vast majority of records that fall under large (non-leaf) nodes.
 *
 * Same off-main-thread / WAL-safe / spawn-per-call / chunked-with-yields rationale as earlier versions of this
 * worker — see the original header for the full reasoning.
 */

/** Rows processed between yields. */
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
 * Returns the tree-node index at a given level for a pre-computed id hash. Same math as hash-utils.js's
 * treeNodeAt(), but takes the raw hash directly (avoids re-calling getStringHash on every level check).
 * @param {number} hash Pre-computed getStringHash(id)
 * @param {number} level
 * @param {number} branching
 * @returns {number}
 */
function levelOf(hash, level, branching) {
    return Math.floor(hash / Math.pow(branching, level)) % branching;
}

/**
 * Checks whether a record (identified by its pre-computed hash) falls under a given tree node path.
 * @param {number} hash Pre-computed getStringHash(id)
 * @param {number[]} path Node path (e.g. [3, 42] for level-0=3, level-1=42)
 * @param {number} branching
 * @returns {boolean}
 */
function isInSubtree(hash, path, branching) {
    for (let l = 0; l < path.length; l++) {
        if (levelOf(hash, l, branching) !== path[l]) return false;
    }
    return true;
}

/**
 * @param {string} dbPath
 * @param {{ path: number[] }[]} nodes Tree-node paths to expand.
 * @param {number} branching
 * @param {number} leafThreshold Nodes with ≤ this many records are resolved as leaves (member data); nodes
 *   with more return children hashes for the client to compare and descend further.
 */
async function treeDescend(dbPath, nodes, branching, leafThreshold) {
    const db = await openReadOnly(dbPath);
    if (!db) return null;
    try {
        const rows = db.all('SELECT id, shallow_json FROM characters');

        // Per-node accumulators for pass 1
        const nodeData = nodes.map(n => ({
            path: n.path,
            depth: n.path.length,
            count: 0,
            // Children digests (branching entries each)
            childFav: Array.from({ length: branching }, () => emptyDigest()),
            childFields: Array.from({ length: branching }, () => emptyDigest()),
        }));

        // Pass 1: count records per node, accumulate children digests. JSON.parse + hash computation happen at
        // most once per record (lazy, deduped across nodes — if a record matches multiple requested nodes, which
        // shouldn't happen for disjoint sibling paths but is handled correctly regardless).
        for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
            for (let j = i; j < Math.min(i + CHUNK_SIZE, rows.length); j++) {
                const row = rows[j];
                const hash = getStringHash(String(row.id));

                let parsed = null, favHash, fieldsHash;
                for (let n = 0; n < nodeData.length; n++) {
                    const nd = nodeData[n];
                    if (!isInSubtree(hash, nd.path, branching)) continue;
                    if (!parsed) {
                        parsed = JSON.parse(row.shallow_json);
                        favHash = characterDigestFavHash(parsed);
                        fieldsHash = characterDigestFieldsHash(parsed);
                    }
                    nd.count++;
                    const childIdx = levelOf(hash, nd.depth, branching);
                    nd.childFav[childIdx] = combineDigest(nd.childFav[childIdx], row.id, favHash);
                    nd.childFields[childIdx] = combineDigest(nd.childFields[childIdx], row.id, fieldsHash);
                }
            }
            await new Promise((resolve) => setImmediate(resolve));
        }

        // Determine which nodes are leaves vs children
        const leafNodes = new Set();
        for (let n = 0; n < nodeData.length; n++) {
            if (nodeData[n].count <= leafThreshold) {
                leafNodes.add(n);
            }
        }

        // Pass 2: collect member data for leaf nodes (only if there are any)
        /** @type {Map<number, object[]>} nodeIndex -> members */
        const leafMembers = new Map();
        if (leafNodes.size > 0) {
            for (const n of leafNodes) leafMembers.set(n, []);

            for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
                for (let j = i; j < Math.min(i + CHUNK_SIZE, rows.length); j++) {
                    const row = rows[j];
                    const hash = getStringHash(String(row.id));

                    for (const n of leafNodes) {
                        const nd = nodeData[n];
                        if (!isInSubtree(hash, nd.path, branching)) continue;

                        const parsed = JSON.parse(row.shallow_json);
                        leafMembers.get(n).push({
                            id: row.id,
                            favHash: characterDigestFavHash(parsed),
                            fieldsHash: characterDigestFieldsHash(parsed),
                            fingerprint: characterDigestFingerprint(parsed),
                        });
                    }
                }
                await new Promise((resolve) => setImmediate(resolve));
            }
        }

        // Build results
        const results = nodeData.map((nd, n) => {
            if (leafNodes.has(n)) {
                return {
                    path: nd.path,
                    type: 'leaves',
                    members: leafMembers.get(n) ?? [],
                };
            }
            // Build children array from accumulated digests
            const children = [];
            for (let c = 0; c < branching; c++) {
                children.push({
                    fav: nd.childFav[c],
                    fields: nd.childFields[c],
                });
            }
            return {
                path: nd.path,
                type: 'children',
                children,
            };
        });

        return { results };
    } finally {
        db.close();
    }
}

parentPort.on('message', async (msg) => {
    try {
        if (msg.type === 'tree-descend') {
            const result = await treeDescend(
                msg.dbPath,
                msg.nodes ?? [{ path: [] }],
                msg.branching ?? DEFAULT_DIGEST_BUCKET_COUNT,
                msg.leafThreshold ?? DEFAULT_DIGEST_BUCKET_COUNT,
            );
            parentPort.postMessage({ id: msg.id, ok: true, result });
            return;
        }
        parentPort.postMessage({ id: msg.id, ok: false, error: `Unknown message type: ${msg.type}` });
    } catch (err) {
        parentPort.postMessage({ id: msg.id, ok: false, error: /** @type {any} */ (err)?.message ?? String(err) });
    }
});
