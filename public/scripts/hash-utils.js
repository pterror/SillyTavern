/**
 * Pure string-hashing helpers. Deliberately dependency-free (no jQuery/DOM, no other app modules) so this
 * stays importable in a plain Node test environment - see tests/hash-utils.test.js. Split out of utils.js,
 * which pulls in the full browser module graph and cannot be imported outside a real DOM.
 */

/**
 * Calculates a hash code for a string.
 * cyrb53 (c) 2018 bryc ({@link https://github.com/bryc/code/blob/master/jshash/experimental/cyrb53.js|github.com/bryc})
 * License: Public domain (or MIT if needed). Attribution appreciated.
 * A fast and simple 53-bit string hash function with decent collision resistance.
 * Largely inspired by MurmurHash2/3, but with a focus on speed/simplicity.
 * @param {string} str The string to hash.
 * @param {number} [seed=0] The seed to use for the hash.
 * @returns {number} The hash code.
 */
export function getStringHash(str, seed = 0) {
    if (typeof str !== 'string') {
        return 0;
    }

    let h1 = 0xdeadbeef ^ seed,
        h2 = 0x41c6ce57 ^ seed;
    for (let i = 0, ch; i < str.length; i++) {
        ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }

    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);

    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * Hashes each of the given top-level keys of a settings-shaped object independently (JSON.stringify(value, null,
 * 4) per key, then getStringHash), rather than hashing the whole object as one string. This is the shallow,
 * one-level "merkle" shape optimistic-concurrency checks need for partial/delta updates: comparing a *map* of
 * per-key hashes instead of one whole-object hash means two concurrent updates to genuinely disjoint keys can
 * both succeed - only a real overlap on the same key(s) needs to conflict. A whole-object hash can't make that
 * distinction; any concurrent change anywhere invalidates it, which defeats a chunk of the point of a partial-
 * update mechanism whose actual data model (see settings.js) is already a flat dict of independent subsystems.
 *
 * A key missing from `obj` hashes to 0 (JSON.stringify(undefined) is `undefined`, not a string, and
 * getStringHash's own non-string fallback returns 0) - so two sides that both lack some key agree on its hash
 * without either needing to special-case "key doesn't exist yet".
 * @param {Record<string, unknown>|null|undefined} obj Parsed settings-shaped object (or null/undefined, treated as empty)
 * @param {string[]} keys Top-level keys to hash
 * @returns {Record<string, number>} Map of key -> hash of that key's current value
 */
export function hashSettingsKeys(obj, keys) {
    /** @type {Record<string, number>} */
    const result = {};
    for (const key of keys) {
        result[key] = getStringHash(JSON.stringify(obj?.[key], null, 4));
    }
    return result;
}

/**
 * JSON.stringify with object keys sorted at every level, so two objects with the same key/value pairs in a
 * different insertion order always serialize identically - the same technique character-card-normalize.js's
 * (server-only) `canonicalStringify()` uses for `computeContentIdentityHash()`, duplicated here (rather than
 * imported from there) so it stays in this dependency-free, browser-safe module: character-card-normalize.js
 * pulls in `node:crypto` and other server-only modules this file must never depend on (see this module's own
 * header on why it's split out of utils.js). Deliberately does NOT strip any fields the way
 * computeContentIdentityHash()'s own canonicalization does (fav/chat/create_date) - that stripping exists for a
 * different job (cross-install duplicate identity, where install-local state must NOT affect the hash); the
 * state-digest use below needs the exact opposite property; anything that changes what a client would see
 * cached for this id, including fav/chat, MUST change the hash, or a real desync in exactly those fields would
 * go undetected.
 * @param {*} value
 * @returns {string}
 */
export function canonicalStringify(value) {
    if (Array.isArray(value)) {
        return `[${value.map(canonicalStringify).join(',')}]`;
    }
    if (value !== null && typeof value === 'object') {
        // Skips undefined-VALUED own keys (not just absent ones), matching JSON.stringify()'s own semantics -
        // see character-card-normalize.js's canonicalStringify() for the full reasoning (same function, same
        // footgun it guards against).
        const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
        return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalStringify(value[k])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

/**
 * Anti-entropy/Merkle-style state-digest helpers for a large id-keyed replica (e.g. character-metadata-db.js's
 * `characters` table on the server, character-cache.js's IndexedDB mirror on the client): a cheap way to prove
 * two independently-maintained copies of the same {id -> content} set agree, and - only if they don't - to
 * narrow down which slice actually diverged, without either side ever transferring its full content list up
 * front. Same shape as MySQL's pt-table-checksum / Cassandra's anti-entropy repair / DynamoDB's replica
 * checksums: partition the id space into a fixed number of buckets, keep one small order-independent digest per
 * bucket, and only fetch (or re-fetch) the members of a bucket whose digest actually mismatches.
 *
 * Digest input is a hash of each record's actual CONTENT (`contentHashOf()` below), never a locally-stored
 * revision counter or any other value a client would have to remember-and-trust between syncs. That's a
 * deliberate correction, not a style choice: an earlier version of this mechanism folded `{id, rev}` into the
 * digest, where `rev` was a number character-cache.js persisted per record alongside its cached copy. That
 * doesn't actually solve the problem this mechanism exists to catch (a client cache that's silently gone wrong)
 * - it just moves the SAME kind of single-point-of-trust failure from one global cursor down to N per-record
 * ones. If a per-record write ever silently fails, corrupts, or gets mismatched (the exact failure modes this
 * whole mechanism exists to catch), a stored `rev` sitting next to the bad data is just as capable of being
 * wrong as the data itself, and nothing independently re-derives it to notice. Hashing content directly has no
 * such gap: there is nothing separate to distrust, because the digest input isn't remembered as state at all -
 * it's recomputed fresh, every time, from whatever the record's actual current content is. If that content is
 * missing, stale, or corrupted, the hash reflects that honestly, by construction, instead of needing a second
 * value to have also gone wrong in a correlated way.
 *
 * `rev` (character-metadata-db.js's change-log revision, `/api/characters/changes`'s cursor) still exists and
 * still matters - it answers "what changed since I last looked", the incremental-fetch question. This module
 * answers a genuinely different question - "is what I already have still correct" - and deliberately does not
 * reuse `rev` to answer it, for the reason above. Conflating the two into one mechanism is exactly what went
 * wrong the first time.
 *
 * Deliberately NOT cryptographic and NOT collision-resistant against an adversary - `getStringHash` (cyrb53) is
 * a fast, good-enough-for-drift-detection string hash, not a security primitive. The threat model here is
 * accidental divergence (a dropped write, storage eviction, a client cache built against a stale/replaced
 * server database), not a hostile server or client.
 */

/** Default bucket count for state-digest partitioning - see `bucketOf()`. 256 buckets keeps both the digest
 * table response (256 small entries) and a single bucket's repair payload (library size / 256 ids) small at
 * any realistic character-library size, without needing to tune this per install. */
export const DEFAULT_DIGEST_BUCKET_COUNT = 256;

/** Default branching factor for the recursive tree-descent anti-entropy protocol (tree-descend). 64 balances
 * per-level response size against descent depth: at N=64, 10K corrupted records produce a ~14 MB children
 * response per intermediate level (vs 80 MB at N=256 or 10 MB at N=32), and the tree reaches depth 3 at 10M
 * records (vs 2 at N=256 or 5 at N=32), giving 3 descent RTs — a good tradeoff between bandwidth and latency
 * for the high-latency/low-bandwidth mobile-data scenario this protocol is designed for.
 *
 * leafThreshold is derived from branching: ceil(branching × 1.5) — the crossover point where returning
 * per-record hashes (~40 bytes/record in JSON) becomes cheaper than returning branching children hashes
 * (~60 bytes/child in JSON). This ensures the tree's leaf-level cost never exceeds an equivalent flat
 * per-record digest. */
export const DEFAULT_TREE_BRANCHING = 64;

/**
 * Deterministic bucket assignment for one id - the same on client and server (both import this module) is the
 * entire point: neither side ever needs to ask the other "which bucket is this id in", they just agree.
 * Keyed on `id` alone (not `id:rev`) so a given character always lands in the same bucket across every sync,
 * regardless of how many times it's been edited - that's what lets a bucket mismatch be resolved by re-fetching
 * only that bucket's members instead of re-partitioning everything.
 * @param {string} id
 * @param {number} [bucketCount]
 * @returns {number}
 */
export function bucketOf(id, bucketCount = DEFAULT_DIGEST_BUCKET_COUNT) {
    return getStringHash(String(id)) % bucketCount;
}

/**
 * Hierarchical extension of `bucketOf()` - returns the tree-node index at a given level for an id, using
 * successive bit ranges of the same deterministic hash. Level 0 is exactly `bucketOf(id, branching)` (same low
 * bits, same assignment), so the flat-bucket scheme is literally level 0 of this tree; higher levels subdivide
 * each level-0 bucket into finer groups using the next bits of the hash.
 *
 * Stable by construction: adding/removing records never changes any other record's tree path, because the path
 * is derived purely from the id's own hash, with no dependence on the set of other ids present. Same hash →
 * same path, regardless of corpus size or composition.
 *
 * Uses division/modulo rather than bit shifts because `getStringHash()` returns a 53-bit number (not a 32-bit
 * int), and JavaScript's `>>>` operator truncates to 32 bits. Division stays in safe-integer range for all
 * levels up to floor(53 / log2(branching)) - at branching=256, that's 6 levels, covering up to 256^6 ≈ 281
 * trillion leaf nodes, well beyond any realistic corpus size.
 * @param {string} id
 * @param {number} level 0-based tree level (0 = same as `bucketOf`)
 * @param {number} [branching] Must be a positive integer; powers of 2 recommended for clean bit extraction.
 * @returns {number} Node index at this level (0 to branching-1)
 */
export function treeNodeAt(id, level, branching = DEFAULT_DIGEST_BUCKET_COUNT) {
    const hash = getStringHash(String(id));
    return Math.floor(hash / Math.pow(branching, level)) % branching;
}

/**
 * The content-derived fingerprint this whole mechanism is built on (see this section's own header for why it's
 * content, not a stored counter) - a single hash of whatever object it's given, recomputed fresh every call,
 * never persisted anywhere as its own independently-trusted value. Generic on purpose (this module stays
 * dependency-free and domain-agnostic); WHICH fields of a character actually belong in that object is a
 * character-shaped decision, made by `characterDigestFingerprint()` below, not by this function.
 * @param {object} content
 * @returns {number}
 */
export function contentHashOf(content) {
    return getStringHash(canonicalStringify(content ?? {}));
}

/**
 * Picks the subset of a processed character object (character-shallow.js's `toShallow()` shape - what
 * `/api/characters/batch` returns, and what `shallow_json` stores server-side) that's safe to compare between
 * client and server for cache-integrity purposes - see `contentHashOf()`'s callers (getStateDigest()/
 * getBucketMembers() server-side, verifyCharacterCacheDigest() client-side).
 *
 * Deliberately narrower than "the whole character object", because several of `toShallow()`'s fields are NOT
 * stable, comparable content - they're either live-recomputed from volatile external state on every server read,
 * or synthesized client-side with no server equivalent, so including them would make this digest disagree with
 * itself constantly for values that were never actually wrong:
 *   - `chat`: script.js's finalizeFetchedCharacter() replaces a falsy client-side `chat` with a freshly
 *     synthesized, timestamped placeholder before caching - real for EVERY never-chatted character, with no
 *     server-side equivalent to compare against (server's `shallow_json.chat` is legitimately `null` there).
 *   - `chat_size`/`date_last_chat`: server-side, these are only refreshed in the metadata store when a
 *     character's own PNG is re-written (upsertCharacterFromWrite()'s hook) - NOT when new chat messages are
 *     saved, which is a separate write path this metadata store doesn't watch. `/api/characters/batch`'s live
 *     processCharacter() call recomputes both fresh from the actual chat file on every request. The two
 *     legitimately, routinely disagree for any character with chat activity since its last card edit - not a
 *     bug, just two different staleness windows for the same underlying (frequently-changing) fact.
 *   - `date_added`/`create_date`: frozen once in the metadata store (by design - see character-metadata-db.js's
 *     own module header on "date_added IS RECORDED ONCE"), but /batch's processCharacter() recomputes a
 *     fallback from the PNG file's current ctime on every call - stable in the overwhelmingly common case, but
 *     not something this check should stake a false-positive on for the rare case a file's ctime moves without
 *     its content changing (e.g. a filesystem-level operation outside the app).
 *
 * The accepted tradeoff: a genuine active-chat-POINTER desync, or `chat_size`/`date_added` drift specifically,
 * isn't caught by this check - narrower coverage, but zero false positives, which matters more for a mechanism
 * whose entire value is "stays quiet when nothing's actually wrong".
 * @param {object} character A `toShallow()`-shaped object (or the full character object - only these fields
 * are read, so a full processCharacter(..., {shallow: false}) object works too)
 * @returns {object} Just the stable subset, ready to pass to `contentHashOf()`.
 */
export function characterDigestFingerprint(character) {
    return {
        name: character?.name,
        fav: character?.fav,
        tags: character?.tags,
        data: {
            name: character?.data?.name,
            character_version: character?.data?.character_version,
            creator: character?.data?.creator,
            tags: character?.data?.tags,
            creator_notes: character?.data?.creator_notes,
            extensions: {
                fav: character?.data?.extensions?.fav,
                world: character?.data?.extensions?.world,
            },
        },
    };
}

/**
 * Fixed-shape fast path for `contentHashOf(characterDigestFingerprint(character))` - produces byte-identical
 * output to that generic pipeline (verified in hash-utils.test.js against a wide range of inputs, including
 * missing/undefined fields), used at the two call sites that run this over an entire character library
 * (server's getStateDigest()/getBucketMembers() in character-metadata-db.js, client's
 * verifyCharacterCacheDigest() in script.js) rather than the generic pipeline itself.
 *
 * `canonicalStringify()` earns its recursive Object.keys()+filter()+sort() machinery when the shape of what
 * it's serializing is genuinely unknown at the call site - that's its actual job. `characterDigestFingerprint()`
 * doesn't have that problem: it always returns the exact same fixed key set (name/fav/tags/data{...}), in the
 * exact same nesting, no matter what character it's given - so re-discovering and re-sorting that key set at
 * runtime, on every single call, is pure repeated overhead for information already known once, statically, right
 * here. Measured on a real 326k-row character-metadata.sqlite (2026-08 state-digest perf investigation): the
 * generic path spent ~1.17s of a ~2.2s total in canonicalStringify() alone - about 3.6x the cost of a plain
 * `JSON.stringify()` on equivalent data - purely from that redundant per-call key discovery/sort/filter, not
 * from anything array/object-shape-genuinely-variable about this specific data. This function is that same
 * output, hand-unrolled once: ~340ms for the same 326k rows, matching plain `JSON.stringify()`'s own baseline
 * cost, because there is no longer any generic recursion left to pay for.
 *
 * Still has to replicate `canonicalStringify()`'s one real behavioral subtlety - an object key whose VALUE is
 * `undefined` is omitted entirely, matching `JSON.stringify()`'s own semantics (see that function's own doc
 * comment) - a character missing `data.creator_notes` entirely, for instance, must hash the same way whether it
 * went through this path or the generic one, or the two would silently disagree on the exact same content.
 * @param {object} character A `toShallow()`-shaped object (or the full character object) - passed straight
 * through, not pre-run through `characterDigestFingerprint()` (this function does that field selection itself).
 * @returns {number}
 */
export function characterDigestContentHash(character) {
    const name = character?.name;
    const fav = character?.fav;
    const tags = character?.tags;
    const data = character?.data;
    const characterVersion = data?.character_version;
    const creator = data?.creator;
    const creatorNotes = data?.creator_notes;
    const dataName = data?.name;
    const dataTags = data?.tags;
    const ext = data?.extensions;
    const extFav = ext?.fav;
    const extWorld = ext?.world;

    // Key order below matches exactly what canonicalStringify(characterDigestFingerprint(character)) would
    // produce: keys sorted alphabetically at every level (data/fav/name/tags at the top; character_version/
    // creator/creator_notes/extensions/name/tags inside `data`; fav/world inside `extensions`), undefined-valued
    // keys omitted. `tags`/`dataTags` are arrays of primitive strings in this domain, for which plain
    // `JSON.stringify()` already produces byte-identical output to canonicalStringify()'s own element-wise map
    // (no key-sorting applies to arrays either way) - see canonicalStringify()'s own array branch.
    let extParts = '';
    if (extFav !== undefined) extParts += `"fav":${JSON.stringify(extFav)}`;
    if (extWorld !== undefined) extParts += (extParts ? ',' : '') + `"world":${JSON.stringify(extWorld)}`;

    let dataParts = '';
    const appendData = (key, value) => {
        if (value === undefined) return;
        dataParts += (dataParts ? ',' : '') + `${JSON.stringify(key)}:${value}`;
    };
    if (characterVersion !== undefined) appendData('character_version', JSON.stringify(characterVersion));
    if (creator !== undefined) appendData('creator', JSON.stringify(creator));
    if (creatorNotes !== undefined) appendData('creator_notes', JSON.stringify(creatorNotes));
    // `extensions` itself is always a plain object here (characterDigestFingerprint() always constructs one,
    // even if `character?.data?.extensions` is undefined), so this key is never omitted.
    appendData('extensions', `{${extParts}}`);
    if (dataName !== undefined) appendData('name', JSON.stringify(dataName));
    if (dataTags !== undefined) appendData('tags', JSON.stringify(dataTags));

    let topParts = `"data":{${dataParts}}`;
    if (fav !== undefined) topParts += `,"fav":${JSON.stringify(fav)}`;
    if (name !== undefined) topParts += `,"name":${JSON.stringify(name)}`;
    if (tags !== undefined) topParts += `,"tags":${JSON.stringify(tags)}`;

    return getStringHash(`{${topParts}}`);
}

/**
 * Picks the fav-group subset of a character's fingerprint: the two fields (`fav`, `data.extensions.fav`) that
 * change independently via the `setCharacterFav()` endpoint (a DB-only toggle that never touches the PNG),
 * making them the most common single-field drift vector. Paired with `characterContentFieldsFingerprint()`
 * below; the two together cover exactly the same fields as `characterDigestFingerprint()` above, just split
 * into independently-hashable groups so the bucket-digest mechanism can tell a fav-only mismatch apart from a
 * real content-field mismatch without needing a second round trip to diff individual records.
 * @param {object} character
 * @returns {object}
 */
export function characterFavFingerprint(character) {
    return {
        fav: character?.fav,
        data: {
            extensions: {
                fav: character?.data?.extensions?.fav,
            },
        },
    };
}

/**
 * Picks the content-fields-group subset of a character's fingerprint: everything `characterDigestFingerprint()`
 * covers EXCEPT the fav fields (which go in `characterFavFingerprint()` above). These fields all change
 * atomically together when the character's PNG card is written, so grouping them into one hash stream means a
 * mismatch in any of them is detected as "content fields drifted" - which field specifically can be determined
 * by the targeted-patch repair path without a separate per-field hash (the server returns the actual field
 * values and the client diffs against its cached copy).
 * @param {object} character
 * @returns {object}
 */
export function characterContentFieldsFingerprint(character) {
    return {
        name: character?.name,
        tags: character?.tags,
        data: {
            name: character?.data?.name,
            character_version: character?.data?.character_version,
            creator: character?.data?.creator,
            tags: character?.data?.tags,
            creator_notes: character?.data?.creator_notes,
            extensions: {
                world: character?.data?.extensions?.world,
            },
        },
    };
}

/**
 * Fixed-shape fast path for `contentHashOf(characterFavFingerprint(character))` - same rationale as
 * `characterDigestContentHash()` above: the generic `canonicalStringify()` pipeline is redundant overhead for a
 * shape that's known statically. Must stay byte-identical to the generic path (verified in tests).
 *
 * Canonical key order: top-level `data` < `fav`; inside `data` only `extensions`; inside `extensions` only `fav`.
 * @param {object} character
 * @returns {number}
 */
export function characterDigestFavHash(character) {
    const fav = character?.fav;
    const extFav = character?.data?.extensions?.fav;

    let extParts = '';
    if (extFav !== undefined) extParts += `"fav":${JSON.stringify(extFav)}`;

    const dataParts = `"extensions":{${extParts}}`;

    let topParts = `"data":{${dataParts}}`;
    if (fav !== undefined) topParts += `,"fav":${JSON.stringify(fav)}`;

    return getStringHash(`{${topParts}}`);
}

/**
 * Fixed-shape fast path for `contentHashOf(characterContentFieldsFingerprint(character))` - the non-fav
 * fingerprint fields, same hand-unrolled approach as `characterDigestContentHash()` and
 * `characterDigestFavHash()`. Must stay byte-identical to the generic path (verified in tests).
 *
 * Canonical key order: top-level `data` < `name` < `tags`; inside `data`:
 * `character_version` < `creator` < `creator_notes` < `extensions` < `name` < `tags`;
 * inside `extensions` only `world`.
 * @param {object} character
 * @returns {number}
 */
export function characterDigestFieldsHash(character) {
    const name = character?.name;
    const tags = character?.tags;
    const data = character?.data;
    const characterVersion = data?.character_version;
    const creator = data?.creator;
    const creatorNotes = data?.creator_notes;
    const dataName = data?.name;
    const dataTags = data?.tags;
    const extWorld = data?.extensions?.world;

    let extParts = '';
    if (extWorld !== undefined) extParts += `"world":${JSON.stringify(extWorld)}`;

    let dataParts = '';
    const appendData = (key, value) => {
        if (value === undefined) return;
        dataParts += (dataParts ? ',' : '') + `${JSON.stringify(key)}:${value}`;
    };
    if (characterVersion !== undefined) appendData('character_version', JSON.stringify(characterVersion));
    if (creator !== undefined) appendData('creator', JSON.stringify(creator));
    if (creatorNotes !== undefined) appendData('creator_notes', JSON.stringify(creatorNotes));
    appendData('extensions', `{${extParts}}`);
    if (dataName !== undefined) appendData('name', JSON.stringify(dataName));
    if (dataTags !== undefined) appendData('tags', JSON.stringify(dataTags));

    let topParts = `"data":{${dataParts}}`;
    if (name !== undefined) topParts += `,"name":${JSON.stringify(name)}`;
    if (tags !== undefined) topParts += `,"tags":${JSON.stringify(tags)}`;

    return getStringHash(`{${topParts}}`);
}

/**
 * The starting value for a bucket digest accumulator - see `combineDigest()`.
 * @returns {{ hi: number, lo: number }}
 */
export function emptyDigest() {
    return { hi: 0, lo: 0 };
}

/**
 * Order-independent fold of one `{id, contentHash}` pair (see `contentHashOf()`) into a running bucket digest.
 * XOR across two 32-bit halves (rather than addition, or XOR-ing `getStringHash`'s raw 53-bit number directly)
 * so this only ever touches plain 32-bit-safe bitwise ops - no BigInt, no floating-point precision loss from
 * summing 53-bit numbers past 2^53. XOR is commutative and associative, so callers can fold rows in ANY order
 * (a SQL query's row order server-side, an IndexedDB cursor's order client-side) and still land on the same
 * digest for the same {id, contentHash} set - which is exactly what "the same replicated content, assembled two
 * different ways" needs. Self-inverting too (`combineDigest(combineDigest(d, x), x)` returns `d`), though
 * nothing here relies on that yet - noted for a future incremental-maintenance variant, not used by this pass's
 * on-demand computation.
 * @param {{ hi: number, lo: number }} digest Accumulator so far (start from `emptyDigest()`)
 * @param {string} id
 * @param {number} contentHash From `contentHashOf()`
 * @returns {{ hi: number, lo: number }}
 */
export function combineDigest(digest, id, contentHash) {
    const h = getStringHash(`${id}:${contentHash}`);
    // getStringHash returns a 53-bit non-negative number: `4294967296 * (2097151 & h2) + (h1 >>> 0)`. The low
    // 32 bits are exactly `h1 >>> 0`; the high bits are whatever's left after dividing that back out. Both
    // halves stay well within safe-integer/32-bit-bitwise-op range, so no BigInt is needed anywhere here.
    const lo = h % 4294967296;
    const hi = Math.floor(h / 4294967296);
    return { hi: (digest.hi ^ hi) >>> 0, lo: (digest.lo ^ lo) >>> 0 };
}

/**
 * Folds one bucket digest into another - used to derive the whole-library digest from a 256-entry bucket table
 * (both sides can do this locally; the wire format only ever needs to carry the per-bucket table, never a
 * separately-computed whole-library digest too).
 * @param {{ hi: number, lo: number }} a
 * @param {{ hi: number, lo: number }} b
 * @returns {{ hi: number, lo: number }}
 */
export function foldDigests(a, b) {
    return { hi: (a.hi ^ b.hi) >>> 0, lo: (a.lo ^ b.lo) >>> 0 };
}

/**
 * @param {{ hi: number, lo: number }} a
 * @param {{ hi: number, lo: number }} b
 * @returns {boolean}
 */
export function digestsEqual(a, b) {
    return a.hi === b.hi && a.lo === b.lo;
}
