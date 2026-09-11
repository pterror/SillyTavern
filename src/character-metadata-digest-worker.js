import { parentPort } from 'node:worker_threads';

import { getSqliteEngine } from './endpoints/sqlite-engine.js';
import { getStringHash, emptyDigest128, combineDigest128, characterDigestFavHash, characterDigestFieldsHash, characterDigestTagIdsHash, characterDigestFingerprint, DEFAULT_DIGEST_BUCKET_COUNT } from '../public/scripts/hash-utils.js';

/**
 * worker_threads entry point for the recursive hash-tree anti-entropy check (POST /api/characters/tree-descend).
 * The client descends one level per round trip into mismatched subtrees until each reaches a leaf (≤ leafThreshold
 * records). Node matching uses a path-string → nodeIndex Map for O(records × depth) instead of O(nodes × records).
 */

/** Rows processed between yields. */
const CHUNK_SIZE = 5000;

/** Nodes with ≤ this many records return per-record hash data directly instead of children digests. */
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

        for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
            for (let j = i; j < Math.min(i + CHUNK_SIZE, rows.length); j++) {
                const row = rows[j];
                const hash = getStringHash(String(row.id));

                let parsed = null, favHash, tagIdsHash, fieldsHash;
                const pathParts = [];
                for (let d = 0; d <= maxDepth; d++) {
                    if (d > 0) pathParts.push(levelOf(hash, d - 1, branching));
                    const depthMap = nodesByDepth.get(d);
                    if (!depthMap) continue;
                    const key = pathParts.join(',');
                    const nodeIndices = depthMap.get(key);
                    if (!nodeIndices) continue;

                    if (!parsed) {
                        // digest columns are NULL for rows written before the digest-columns migration
                        if (row.digest_fav != null && row.digest_tag_ids != null && row.digest_content != null) {
                            favHash = row.digest_fav;
                            tagIdsHash = row.digest_tag_ids;
                            fieldsHash = row.digest_content;
                            parsed = true;
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

        const leafNodeIndices = new Set();
        for (let n = 0; n < nodeData.length; n++) {
            if (nodeData[n].count <= leafThreshold) leafNodeIndices.add(n);
        }

        /** @type {Map<number, object[]>} */
        const leafMembers = new Map();
        if (leafNodeIndices.size > 0) {
            for (const n of leafNodeIndices) leafMembers.set(n, []);

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

                        // Leaf members carry per-record hashes only, not fingerprint values (fetched
                        // separately via 'resolve-fingerprints' for records identified as drifted).
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
 * Reads from `shallow_json` in the DB — no processCharacter()/PNG disk reads.
 * @param {string[]} ids Record IDs (avatar filenames) to resolve.
 */
async function resolveFingerprints(dbPath, ids) {
    const db = await openReadOnly(dbPath);
    if (!db) return null;
    try {
        const idSet = new Set(ids);
        const results = [];
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
 * Same value as XOR-folding all level-0 children from a tree-descend root call, without the bucketing overhead.
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
