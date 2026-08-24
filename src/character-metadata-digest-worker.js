import { parentPort } from 'node:worker_threads';

import { getSqliteEngine } from './endpoints/sqlite-engine.js';
import { getStringHash, emptyDigest, combineDigest, foldDigests, characterDigestFavHash, characterDigestFieldsHash, characterDigestFingerprint, DEFAULT_DIGEST_BUCKET_COUNT } from '../public/scripts/hash-utils.js';

/**
 * worker_threads entry point for the recursive hash-tree anti-entropy check (POST /api/characters/tree-descend).
 *
 * Genuinely recursive: the client calls the endpoint repeatedly, descending one level per round trip into
 * whichever subtrees mismatched, until every divergence is either resolved to individual records or reaches a
 * group small enough (≤ leafThreshold records) to compare its members directly. Tree depth adapts naturally to
 * corpus size as O(log_N(corpusSize / leafThreshold)) — NOT a fixed constant.
 *
 * Single message type: 'tree-descend'. Given a list of tree-node paths to expand, scans the characters table
 * and for each node returns either children hashes (if subtree > leafThreshold) or full member data (if small
 * enough). The client batches large node sets into multiple requests (DESCEND_BATCH_SIZE=1000) to keep each
 * response under ~8 MB, allowing the protocol to handle tens of thousands of mismatched nodes without any
 * single-response size explosion.
 *
 * NODE MATCHING OPTIMIZATION: the inner loop uses a Map-keyed lookup (path-string → nodeIndex) for O(1) per
 * record, not O(nodeCount) linear scan. This is critical when the client sends 1000+ nodes per batch — the
 * old linear scan would be O(nodes × records) = O(1K × 10M) = O(10B) per batch, while the Map-based approach
 * is O(records × depth) = O(10M × 3) = O(30M). For each record, we compute its path to the max depth among
 * requested nodes, then check whether that path exists in the node Map.
 *
 * Two-phase scan: pass 1 counts + accumulates children digests (always needed), pass 2 collects full member
 * data for nodes determined to be leaves (fingerprint values for repair — only done for the small leaf
 * subtrees, not the whole table).
 *
 * Same off-main-thread / WAL-safe / spawn-per-call / chunked-with-yields rationale as earlier implementations.
 */

/** Rows processed between yields. */
const CHUNK_SIZE = 5000;

/** Default leaf threshold — nodes with ≤ this many records return member data directly instead of children
 * hashes. 32 pushes the tree to depth 3 at 10M records (leaf groups of ~1 record each), which at 0.1%
 * corruption gives 10K leaf nodes × ~1 record × 200 bytes = 2 MB of leaf data — far more tolerable than the
 * old 256 threshold's 10K × 153 × 200 = 306 MB. */
const DEFAULT_LEAF_THRESHOLD = 32;

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
 * Returns the tree-node index at a given level for a pre-computed id hash.
 * @param {number} hash Pre-computed getStringHash(id)
 * @param {number} level
 * @param {number} branching
 * @returns {number}
 */
function levelOf(hash, level, branching) {
    return Math.floor(hash / Math.pow(branching, level)) % branching;
}

/**
 * Builds a path string for a record's tree position at a given depth.
 * @param {number} hash Pre-computed getStringHash(id)
 * @param {number} depth How many levels of the path to compute
 * @param {number} branching
 * @returns {string} e.g. "3,42" for depth=2 where level-0=3, level-1=42
 */
function pathKey(hash, depth, branching) {
    const parts = [];
    for (let l = 0; l < depth; l++) {
        parts.push(levelOf(hash, l, branching));
    }
    return parts.join(',');
}

/**
 * @param {string} dbPath
 * @param {{ path: number[] }[]} nodes Tree-node paths to expand.
 * @param {number} branching
 * @param {number} leafThreshold Nodes with ≤ this many records are resolved as leaves.
 */
async function treeDescend(dbPath, nodes, branching, leafThreshold) {
    const db = await openReadOnly(dbPath);
    if (!db) return null;
    try {
        const rows = db.all('SELECT id, shallow_json FROM characters');

        // Group nodes by depth for efficient matching. In the normal protocol flow, all nodes at a given
        // descent step are at the same depth, but this handles mixed depths correctly too.
        // nodesByDepth: depth -> Map<pathKey, nodeIndex[]>
        const nodesByDepth = new Map();
        let maxDepth = 0;
        const nodeData = nodes.map((n, idx) => {
            const depth = n.path.length;
            if (depth > maxDepth) maxDepth = depth;
            const key = n.path.join(',');
            if (!nodesByDepth.has(depth)) nodesByDepth.set(depth, new Map());
            const depthMap = nodesByDepth.get(depth);
            if (!depthMap.has(key)) depthMap.set(key, []);
            depthMap.get(key).push(idx);
            return {
                path: n.path,
                depth,
                count: 0,
                childFav: Array.from({ length: branching }, () => emptyDigest()),
                childFields: Array.from({ length: branching }, () => emptyDigest()),
            };
        });

        // Pass 1: count + accumulate children digests. O(records × maxDepth) per record for path computation,
        // O(1) Map lookup per depth level to check node membership.
        for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
            for (let j = i; j < Math.min(i + CHUNK_SIZE, rows.length); j++) {
                const row = rows[j];
                const hash = getStringHash(String(row.id));

                // Compute path levels incrementally and check node membership at each depth
                let parsed = null, favHash, fieldsHash;
                const pathParts = [];
                for (let d = 0; d <= maxDepth; d++) {
                    if (d > 0) pathParts.push(levelOf(hash, d - 1, branching));
                    const depthMap = nodesByDepth.get(d);
                    if (!depthMap) continue;
                    const key = pathParts.join(',');
                    const nodeIndices = depthMap.get(key);
                    if (!nodeIndices) continue;

                    // Record matches one or more nodes at this depth
                    if (!parsed) {
                        parsed = JSON.parse(row.shallow_json);
                        favHash = characterDigestFavHash(parsed);
                        fieldsHash = characterDigestFieldsHash(parsed);
                    }
                    for (const idx of nodeIndices) {
                        const nd = nodeData[idx];
                        nd.count++;
                        const childIdx = levelOf(hash, nd.depth, branching);
                        nd.childFav[childIdx] = combineDigest(nd.childFav[childIdx], row.id, favHash);
                        nd.childFields[childIdx] = combineDigest(nd.childFields[childIdx], row.id, fieldsHash);
                    }
                }
            }
            await new Promise((resolve) => setImmediate(resolve));
        }

        // Determine leaf vs children nodes
        const leafNodeIndices = new Set();
        for (let n = 0; n < nodeData.length; n++) {
            if (nodeData[n].count <= leafThreshold) leafNodeIndices.add(n);
        }

        // Pass 2: collect member data for leaf nodes. Same Map-based matching, only for leaf nodes.
        /** @type {Map<number, object[]>} */
        const leafMembers = new Map();
        if (leafNodeIndices.size > 0) {
            for (const n of leafNodeIndices) leafMembers.set(n, []);

            // Build a separate lookup for leaf nodes only
            const leafByDepth = new Map();
            for (const n of leafNodeIndices) {
                const nd = nodeData[n];
                if (!leafByDepth.has(nd.depth)) leafByDepth.set(nd.depth, new Map());
                const depthMap = leafByDepth.get(nd.depth);
                const key = nd.path.join(',');
                if (!depthMap.has(key)) depthMap.set(key, []);
                depthMap.get(key).push(n);
            }
            let leafMaxDepth = 0;
            for (const d of leafByDepth.keys()) if (d > leafMaxDepth) leafMaxDepth = d;

            for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
                for (let j = i; j < Math.min(i + CHUNK_SIZE, rows.length); j++) {
                    const row = rows[j];
                    const hash = getStringHash(String(row.id));

                    const pathParts = [];
                    for (let d = 0; d <= leafMaxDepth; d++) {
                        if (d > 0) pathParts.push(levelOf(hash, d - 1, branching));
                        const depthMap = leafByDepth.get(d);
                        if (!depthMap) continue;
                        const key = pathParts.join(',');
                        const nodeIndices = depthMap.get(key);
                        if (!nodeIndices) continue;

                        const parsed = JSON.parse(row.shallow_json);
                        for (const n of nodeIndices) {
                            leafMembers.get(n).push({
                                id: row.id,
                                favHash: characterDigestFavHash(parsed),
                                fieldsHash: characterDigestFieldsHash(parsed),
                                fingerprint: characterDigestFingerprint(parsed),
                            });
                        }
                    }
                }
                await new Promise((resolve) => setImmediate(resolve));
            }
        }

        // Build results
        const results = nodeData.map((nd, n) => {
            if (leafNodeIndices.has(n)) {
                return { path: nd.path, type: 'leaves', members: leafMembers.get(n) ?? [] };
            }
            const children = [];
            for (let c = 0; c < branching; c++) {
                children.push({ fav: nd.childFav[c], fields: nd.childFields[c] });
            }
            return { path: nd.path, type: 'children', children };
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
                msg.leafThreshold ?? DEFAULT_LEAF_THRESHOLD,
            );
            parentPort.postMessage({ id: msg.id, ok: true, result });
            return;
        }
        parentPort.postMessage({ id: msg.id, ok: false, error: `Unknown message type: ${msg.type}` });
    } catch (err) {
        parentPort.postMessage({ id: msg.id, ok: false, error: /** @type {any} */ (err)?.message ?? String(err) });
    }
});
