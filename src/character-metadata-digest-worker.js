import { parentPort } from 'node:worker_threads';

import { getSqliteEngine } from './endpoints/sqlite-engine.js';
import { getStringHash, emptyDigest128, combineDigest128, characterDigestFavHash, characterDigestFieldsHash, characterDigestTagIdsHash, characterDigestFingerprint, DEFAULT_DIGEST_BUCKET_COUNT } from '../public/scripts/hash-utils.js';

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

/** Default leaf threshold — nodes with ≤ this many records return per-record hash data directly instead of
 * children digests. Derived from branching: ceil(branching × 1.5) = the crossover where per-record hashes
 * (~40 bytes/record JSON) are cheaper than children digests (~60 bytes/child JSON). At B=64: threshold=96,
 * so L2 nodes at 10M (~38 records) are leaves. This ensures tree leaf cost ≤ flat digest cost at every
 * corruption level — see the module header for the full derivation. */
const DEFAULT_LEAF_THRESHOLD = 96;

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
        const rows = db.all('SELECT id, shallow_json, digest_fav, digest_tag_ids, digest_content FROM characters');

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
                childDigest: Array.from({ length: branching }, () => emptyDigest128()),
            };
        });

        // Pass 1: count + accumulate children digests. O(records × maxDepth) per record for path computation,
        // O(1) Map lookup per depth level to check node membership.
        for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
            for (let j = i; j < Math.min(i + CHUNK_SIZE, rows.length); j++) {
                const row = rows[j];
                const hash = getStringHash(String(row.id));

                // Compute path levels incrementally and check node membership at each depth
                let parsed = null, favHash, tagIdsHash, fieldsHash;
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
                        // Use pre-computed digest columns when available (every row written
                        // since the digest-columns migration). Fall back to computing from
                        // shallow_json for rows that predate the migration (digest columns NULL).
                        if (row.digest_fav != null && row.digest_tag_ids != null && row.digest_content != null) {
                            favHash = row.digest_fav;
                            tagIdsHash = row.digest_tag_ids;
                            fieldsHash = row.digest_content;
                            parsed = true; // mark as resolved so we don't re-enter
                        } else {
                            parsed = JSON.parse(row.shallow_json);
                            favHash = characterDigestFavHash(parsed) % 4294967296;
                            tagIdsHash = characterDigestTagIdsHash(parsed);
                            fieldsHash = characterDigestFieldsHash(parsed) % 4294967296;
                        }
                    }
                    for (const idx of nodeIndices) {
                        const nd = nodeData[idx];
                        nd.count++;
                        const childIdx = levelOf(hash, nd.depth, branching);
                        nd.childDigest[childIdx] = combineDigest128(nd.childDigest[childIdx], row.id, favHash, tagIdsHash, fieldsHash);
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

                        // Leaf members carry per-record HASHES only (id + favHash + fieldsHash), NOT
                        // fingerprint values. This keeps leaf cost linear in records (~40 bytes each) rather
                        // than 5x more (~200 bytes with fingerprint), so at 100% corruption the total leaf
                        // data equals a flat full-digest (~400 MB at 10M) instead of blowing up to 2 GB.
                        // Fingerprint values for the K actually-drifted records are fetched separately via
                        // 'resolve-fingerprints' after the client has identified them.
                        let memberFavHash, memberTagIdsHash, memberContentHash, memberFav;
                        if (row.digest_fav != null && row.digest_tag_ids != null && row.digest_content != null) {
                            memberFavHash = row.digest_fav;
                            memberTagIdsHash = row.digest_tag_ids;
                            memberContentHash = row.digest_content;
                            // fav needs the actual value, not the hash - parse just for this
                            const p = JSON.parse(row.shallow_json);
                            memberFav = !!p?.fav;
                        } else {
                            const p = JSON.parse(row.shallow_json);
                            memberFavHash = characterDigestFavHash(p) % 4294967296;
                            memberTagIdsHash = characterDigestTagIdsHash(p);
                            memberContentHash = characterDigestFieldsHash(p) % 4294967296;
                            memberFav = !!p?.fav;
                        }
                        for (const n of nodeIndices) {
                            leafMembers.get(n).push({
                                id: row.id,
                                favHash: memberFavHash,
                                tagIdsHash: memberTagIdsHash,
                                contentHash: memberContentHash,
                                fav: memberFav,
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
                children.push({ digest: nd.childDigest[c] });
            }
            return { path: nd.path, type: 'children', children };
        });

        return { results };
    } finally {
        db.close();
    }
}

/**
 * Fetches fingerprint field values for a specific set of record IDs. Called AFTER tree-descend has identified
 * the exact drifted records (via per-record hash comparison in leaf responses). Reads from `shallow_json` in
 * the DB — no processCharacter()/PNG disk reads.
 * @param {string} dbPath
 * @param {string[]} ids Record IDs (avatar filenames) to resolve.
 */
async function resolveFingerprints(dbPath, ids) {
    const db = await openReadOnly(dbPath);
    if (!db) return null;
    try {
        const idSet = new Set(ids);
        const results = [];
        // Single scan, filter by id set. For small id sets (<1000) a batched `WHERE id IN (...)` query would be
        // faster, but the worker doesn't have access to the main thread's prepared-statement cache, and for the
        // rare anti-entropy repair path, a single sequential scan is simpler and correct.
        const rows = db.all('SELECT id, shallow_json FROM characters');
        for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
            for (let j = i; j < Math.min(i + CHUNK_SIZE, rows.length); j++) {
                const row = rows[j];
                if (!idSet.has(row.id)) continue;
                const parsed = JSON.parse(row.shallow_json);
                results.push({ id: row.id, fingerprint: characterDigestFingerprint(parsed) });
            }
            await new Promise((resolve) => setImmediate(resolve));
        }
        return { records: results };
    } finally {
        db.close();
    }
}

/**
 * Computes the global root digest by scanning every row in the characters table and folding all records into a
 * single 128-bit digest. This is the same value you'd get from XOR-folding all 64 level-0 children from a
 * tree-descend root call, but without the bucketing overhead since XOR is associative+commutative.
 * @param {string} dbPath
 */
async function computeRootDigest(dbPath) {
    const db = await openReadOnly(dbPath);
    if (!db) return null;
    try {
        const rows = db.all('SELECT id, digest_fav, digest_tag_ids, digest_content, shallow_json FROM characters');
        let digest = emptyDigest128();

        for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
            for (let j = i; j < Math.min(i + CHUNK_SIZE, rows.length); j++) {
                const row = rows[j];
                let favHash, tagIdsHash, fieldsHash;
                if (row.digest_fav != null && row.digest_tag_ids != null && row.digest_content != null) {
                    favHash = row.digest_fav;
                    tagIdsHash = row.digest_tag_ids;
                    fieldsHash = row.digest_content;
                } else {
                    const parsed = JSON.parse(row.shallow_json);
                    favHash = characterDigestFavHash(parsed) % 4294967296;
                    tagIdsHash = characterDigestTagIdsHash(parsed);
                    fieldsHash = characterDigestFieldsHash(parsed) % 4294967296;
                }
                digest = combineDigest128(digest, row.id, favHash, tagIdsHash, fieldsHash);
            }
            await new Promise((resolve) => setImmediate(resolve));
        }

        return { digest };
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
        if (msg.type === 'root-digest') {
            const result = await computeRootDigest(msg.dbPath);
            parentPort.postMessage({ id: msg.id, ok: true, result });
            return;
        }
        if (msg.type === 'resolve-fingerprints') {
            const result = await resolveFingerprints(msg.dbPath, msg.ids ?? []);
            parentPort.postMessage({ id: msg.id, ok: true, result });
            return;
        }
        parentPort.postMessage({ id: msg.id, ok: false, error: `Unknown message type: ${msg.type}` });
    } catch (err) {
        parentPort.postMessage({ id: msg.id, ok: false, error: /** @type {any} */ (err)?.message ?? String(err) });
    }
});
