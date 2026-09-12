/** Dependency-free string-hashing helpers - must stay importable outside a browser DOM (e.g. under Node tests). */

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
 * Resolves a dot-separated path to a value within a nested object.
 * e.g. getAtPath({ a: { b: 3 } }, 'a.b') => 3
 * @param {object|null|undefined} obj
 * @param {string} dottedPath Dot-separated path (e.g. 'power_user.font_scale')
 * @returns {*} The value at the path, or undefined if any segment is missing
 */
export function getAtPath(obj, dottedPath) {
    let current = obj;
    for (const part of dottedPath.split('.')) {
        if (current == null || typeof current !== 'object') return undefined;
        current = current[part];
    }
    return current;
}

/**
 * Sets a value at a dot-separated path within a nested object, creating intermediate objects as needed.
 * e.g. setAtPath({}, 'a.b', 3) => { a: { b: 3 } }
 * @param {object} obj
 * @param {string} dottedPath Dot-separated path (e.g. 'power_user.font_scale')
 * @param {*} value Value to set
 */
export function setAtPath(obj, dottedPath, value) {
    const parts = dottedPath.split('.');
    let current = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        if (!(parts[i] in current) || current[parts[i]] == null || typeof current[parts[i]] !== 'object') {
            current[parts[i]] = {};
        }
        current = current[parts[i]];
    }
    current[parts[parts.length - 1]] = value;
}

/**
 * Recursively hashes every dotted path in a settings-shaped object into `map`, for partial-update conflict checks.
 * A path absent from `map` means "unknown", not "hash is 0" (0 is a real hash) - callers must check presence.
 * Cycle-safe via an `ancestors` walk-stack; a stringify failure only taints that one path, not its children.
 * @param {Record<string, number>} map Populated in place
 * @param {*} obj Value to walk
 * @param {string} [prefix] Dotted path prefix for `obj` itself
 * @param {Set<object>} [ancestors] Internal cycle guard
 */
export function seedKeyHashes(map, obj, prefix = '', ancestors = new Set()) {
    if (prefix) {
        try {
            map[prefix] = getStringHash(JSON.stringify(obj, null, 4));
        } catch (error) {
            // Unstringifiable (cyclic) at this path - leave it out of the map rather than throwing.
        }
    }
    if (obj != null && typeof obj === 'object' && !Array.isArray(obj)) {
        if (ancestors.has(obj)) {
            return;
        }
        ancestors.add(obj);
        try {
            for (const key of Object.keys(obj)) {
                seedKeyHashes(map, obj[key], prefix ? `${prefix}.${key}` : key, ancestors);
            }
        } finally {
            ancestors.delete(obj);
        }
    }
}

/** Hashes each top-level (or dotted) key of a settings-shaped object independently, for partial-update conflict checks. */
export function hashSettingsKeys(obj, keys) {
    /** @type {Record<string, number>} */
    const result = {};
    for (const key of keys) {
        const value = key.includes('.') ? getAtPath(obj, key) : obj?.[key];
        result[key] = getStringHash(JSON.stringify(value, null, 4));
    }
    return result;
}

/**
 * JSON.stringify with object keys sorted at every level, so equal objects serialize identically regardless of
 * insertion order. Deliberately does NOT strip fields (fav/chat/create_date) the way the server-only
 * canonicalStringify() in character-card-normalize.js does - this one must reflect everything the client would
 * see, so a desync in those fields is not silently hidden.
 * @param {*} value
 * @returns {string}
 */
export function canonicalStringify(value) {
    if (Array.isArray(value)) {
        return `[${value.map(canonicalStringify).join(',')}]`;
    }
    if (value !== null && typeof value === 'object') {
        // Filters out undefined-VALUED keys too, matching JSON.stringify()'s own semantics.
        const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
        return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalStringify(value[k])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

/**
 * Anti-entropy/Merkle-style state-digest helpers: partition an id-keyed replica into fixed buckets, keep one
 * order-independent digest per bucket, and only re-fetch a bucket whose digest mismatches - same shape as
 * MySQL pt-table-checksum / Cassandra anti-entropy repair.
 *
 * Digest input is always a hash of each record's actual content (`contentHashOf()`), never a stored revision
 * counter - a stored counter sitting next to corrupted data is just as capable of being wrong as the data
 * itself, with nothing to independently catch it. `rev` (the change-log cursor) still answers "what changed
 * since I last looked"; this answers "is what I already have still correct" - the two must not be conflated.
 *
 * Not cryptographic or collision-resistant - the threat model is accidental divergence, not a hostile peer.
 */

/** Bucket count for state-digest partitioning - see `bucketOf()`. */
export const DEFAULT_DIGEST_BUCKET_COUNT = 256;

/**
 * Branching factor for the recursive tree-descent anti-entropy protocol. leafThreshold = ceil(branching × 1.5),
 * the point where returning per-record hashes becomes cheaper than returning `branching` children hashes.
 */
export const DEFAULT_TREE_BRANCHING = 64;

/**
 * Deterministic bucket assignment for one id - client and server must agree without asking each other. Keyed
 * on `id` alone (not `id:rev`) so a record always lands in the same bucket regardless of edits.
 * @param {string} id
 * @param {number} [bucketCount]
 * @returns {number}
 */
export function bucketOf(id, bucketCount = DEFAULT_DIGEST_BUCKET_COUNT) {
    return getStringHash(String(id)) % bucketCount;
}

/**
 * Hierarchical extension of `bucketOf()` - tree-node index at a given level, from successive bit ranges of the
 * same hash. Level 0 equals `bucketOf(id, branching)`. Uses division/modulo, not bit shifts, because
 * `getStringHash()` returns 53 bits and `>>>` would truncate to 32.
 * @param {string} id
 * @param {number} level 0-based tree level (0 = same as `bucketOf`)
 * @param {number} [branching] Powers of 2 recommended.
 * @returns {number} Node index at this level (0 to branching-1)
 */
export function treeNodeAt(id, level, branching = DEFAULT_DIGEST_BUCKET_COUNT) {
    const hash = getStringHash(String(id));
    return Math.floor(hash / Math.pow(branching, level)) % branching;
}

/**
 * Recomputed fresh every call, never persisted as its own trusted value - see the anti-entropy section header.
 * @param {object} content
 * @returns {number}
 */
export function contentHashOf(content) {
    return getStringHash(canonicalStringify(content ?? {}));
}

/**
 * Picks the subset of a character object that's stable, comparable content between client and server. Excludes
 * `chat`, `chat_size`/`date_last_chat`, and `date_added`/`create_date` - each is recomputed/synthesized from
 * volatile state on one side with no stable equivalent on the other, so including them would make the digest
 * disagree with itself for values that were never actually wrong. Tradeoff: drift specifically in those fields
 * goes undetected, in exchange for zero false positives elsewhere.
 * @param {object} character A `toShallow()`-shaped object, or the full character object
 * @returns {object} The stable subset, ready for `contentHashOf()`
 */
export function characterDigestFingerprint(character) {
    return {
        name: character?.name,
        fav: character?.fav,
        tags: character?.tags,
        tag_ids: Array.isArray(character?.tag_ids) && character.tag_ids.length > 0 ? [...character.tag_ids].sort() : null,
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
 * Hand-unrolled fast path for `contentHashOf(characterDigestFingerprint(character))` - byte-identical output
 * (verified in tests), used where this runs over an entire character library. `canonicalStringify()`'s
 * recursive key discovery/sort is redundant when the shape is fixed and known statically; skipping it took a
 * 326k-row run from ~1.17s to ~340ms. Must still omit undefined-valued keys exactly like `canonicalStringify()`
 * does, or the two paths would disagree on identical input.
 * @param {object} character A `toShallow()`-shaped object (or the full character object)
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

    // Keys below are alphabetically sorted to match canonicalStringify()'s own output exactly.
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
 * The two fields that change independently via `setCharacterFav()` (a DB-only toggle, never touching the PNG) -
 * split out so a fav-only mismatch can be told apart from a content-field mismatch without a second round trip.
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
 * Everything `characterDigestFingerprint()` covers except the fav fields - grouped because these all change
 * atomically together when the PNG card is written.
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
 * tag_ids change independently via assignEntityTag/unassignEntityTag; sorted here for deterministic hashing
 * regardless of SQL row order.
 * @param {object} character
 * @returns {object}
 */
export function characterTagIdsFingerprint(character) {
    const tagIds = character?.tag_ids;
    return { tag_ids: Array.isArray(tagIds) && tagIds.length > 0 ? [...tagIds].sort() : null };
}

/**
 * Fixed-shape fast path for `contentHashOf(characterFavFingerprint(character))` - must stay byte-identical to
 * the generic path (verified in tests).
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
 * Fixed-shape fast path for `contentHashOf(characterContentFieldsFingerprint(character))` - must stay
 * byte-identical to the generic path (verified in tests).
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
 * Fixed-shape fast path for `contentHashOf(characterTagIdsFingerprint(character)) % 4294967296` (verified in
 * tests), truncated to 32 bits for the per-field digest mechanism.
 * @param {object} character
 * @returns {number} 32-bit unsigned integer
 */
export function characterDigestTagIdsHash(character) {
    const tagIds = character?.tag_ids;
    if (!Array.isArray(tagIds) || tagIds.length === 0) {
        return getStringHash('{"tag_ids":null}') % 4294967296;
    }
    const sorted = [...tagIds].sort();
    return getStringHash(`{"tag_ids":${JSON.stringify(sorted)}}`) % 4294967296;
}

/**
 * Group equivalents of the character*Fingerprint() functions above, same three-way fav/tag_ids/content split.
 * `content` is intentionally the whole group object minus `id`/`fav`/`tag_ids` rather than a narrowed field
 * list - unlike characters, a group's `/query` projection already returns the full object, so narrowing here
 * would silently miss changes to fields not explicitly named.
 * @param {object} group
 * @returns {object}
 */
export function groupFavFingerprint(group) {
    return { fav: group?.fav };
}

/** @param {object} group @returns {object} */
export function groupTagIdsFingerprint(group) {
    const tagIds = group?.tag_ids;
    return { tag_ids: Array.isArray(tagIds) && tagIds.length > 0 ? [...tagIds].sort() : null };
}

/** @param {object} group @returns {object} */
export function groupContentFingerprint(group) {
    if (!group || typeof group !== 'object') return {};
    const { id, fav, tag_ids, ...content } = group;
    return content;
}

/** @param {object} group @returns {number} 32-bit unsigned integer */
export function groupDigestFavHash(group) {
    return contentHashOf(groupFavFingerprint(group)) % 4294967296;
}

/** @param {object} group @returns {number} 32-bit unsigned integer */
export function groupDigestTagIdsHash(group) {
    return contentHashOf(groupTagIdsFingerprint(group)) % 4294967296;
}

/** @param {object} group @returns {number} 32-bit unsigned integer */
export function groupDigestContentHash(group) {
    return contentHashOf(groupContentFingerprint(group)) % 4294967296;
}

/**
 * The card-body fields that change when a user edits the character through the form. Paired with
 * `characterContentFieldsFingerprint()` (metadata fields) for full coverage of the edit endpoint.
 * @param {object} character
 * @returns {object}
 */
export function characterCardBodyFingerprint(character) {
    const dp = character?.data?.extensions?.depth_prompt;
    return {
        data: {
            alternate_greetings: character?.data?.alternate_greetings,
            description: character?.data?.description,
            extensions: {
                depth_prompt: dp !== undefined && dp !== null && typeof dp === 'object'
                    ? { depth: dp.depth, prompt: dp.prompt, role: dp.role }
                    : dp,
                talkativeness: character?.data?.extensions?.talkativeness,
            },
            first_mes: character?.data?.first_mes,
            mes_example: character?.data?.mes_example,
            personality: character?.data?.personality,
            post_history_instructions: character?.data?.post_history_instructions,
            scenario: character?.data?.scenario,
            system_prompt: character?.data?.system_prompt,
        },
    };
}

/**
 * Fixed-shape fast path for `contentHashOf(characterCardBodyFingerprint(character))` - must stay byte-identical
 * to the generic path.
 * @param {object} character
 * @returns {number}
 */
export function characterDigestCardBodyHash(character) {
    const data = character?.data;
    const alternateGreetings = data?.alternate_greetings;
    const description = data?.description;
    const firstMes = data?.first_mes;
    const mesExample = data?.mes_example;
    const personality = data?.personality;
    const postHistoryInstructions = data?.post_history_instructions;
    const scenario = data?.scenario;
    const systemPrompt = data?.system_prompt;
    const ext = data?.extensions;
    const depthPrompt = ext?.depth_prompt;
    const talkativeness = ext?.talkativeness;

    let depthPromptStr;
    if (depthPrompt !== undefined) {
        if (depthPrompt !== null && typeof depthPrompt === 'object') {
            let dpParts = '';
            const appendDp = (key, value) => {
                if (value === undefined) return;
                dpParts += (dpParts ? ',' : '') + `${JSON.stringify(key)}:${JSON.stringify(value)}`;
            };
            appendDp('depth', depthPrompt.depth);
            appendDp('prompt', depthPrompt.prompt);
            appendDp('role', depthPrompt.role);
            depthPromptStr = `{${dpParts}}`;
        } else {
            depthPromptStr = JSON.stringify(depthPrompt);
        }
    }

    let extParts = '';
    if (depthPrompt !== undefined) extParts += `"depth_prompt":${depthPromptStr}`;
    if (talkativeness !== undefined) extParts += (extParts ? ',' : '') + `"talkativeness":${JSON.stringify(talkativeness)}`;

    let dataParts = '';
    const appendData = (key, value) => {
        if (value === undefined) return;
        dataParts += (dataParts ? ',' : '') + `${JSON.stringify(key)}:${value}`;
    };
    if (alternateGreetings !== undefined) appendData('alternate_greetings', JSON.stringify(alternateGreetings));
    if (description !== undefined) appendData('description', JSON.stringify(description));
    appendData('extensions', `{${extParts}}`);
    if (firstMes !== undefined) appendData('first_mes', JSON.stringify(firstMes));
    if (mesExample !== undefined) appendData('mes_example', JSON.stringify(mesExample));
    if (personality !== undefined) appendData('personality', JSON.stringify(personality));
    if (postHistoryInstructions !== undefined) appendData('post_history_instructions', JSON.stringify(postHistoryInstructions));
    if (scenario !== undefined) appendData('scenario', JSON.stringify(scenario));
    if (systemPrompt !== undefined) appendData('system_prompt', JSON.stringify(systemPrompt));

    return getStringHash(`{"data":{${dataParts}}}`);
}

/**
 * The starting value for a bucket digest accumulator - see `combineDigest()`.
 * @returns {{ hi: number, lo: number }}
 */
export function emptyDigest() {
    return { hi: 0, lo: 0 };
}

/**
 * Order-independent fold of one `{id, contentHash}` pair into a running bucket digest. XOR (not addition) keeps
 * this on plain 32-bit-safe bitwise ops with no BigInt, and lets callers fold rows in any order and still land
 * on the same digest for the same set.
 * @param {{ hi: number, lo: number }} digest Accumulator so far (start from `emptyDigest()`)
 * @param {string} id
 * @param {number} contentHash From `contentHashOf()`
 * @returns {{ hi: number, lo: number }}
 */
export function combineDigest(digest, id, contentHash) {
    const h = getStringHash(`${id}:${contentHash}`);
    const lo = h % 4294967296;
    const hi = Math.floor(h / 4294967296);
    return { hi: (digest.hi ^ hi) >>> 0, lo: (digest.lo ^ lo) >>> 0 };
}

/**
 * Folds one bucket digest into another - derives the whole-library digest from the per-bucket table locally, so
 * the wire format never needs to carry a separately-computed whole-library digest too.
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

// --- 128-bit wide digest functions for field-granular sync ---
// Aggregates use 128 bits so a 32-bit per-field collision can't survive undetected; per-field hashes stay
// narrow (32 bits) for locating which field drifted.

/**
 * Starting value for a 128-bit bucket digest accumulator.
 * @returns {{ a: number, b: number, c: number, d: number }}
 */
export function emptyDigest128() {
    return { a: 0, b: 0, c: 0, d: 0 };
}

/**
 * Order-independent fold of one record's per-field hashes into a running 128-bit bucket digest, via four
 * differently-seeded cyrb53 hashes so a per-field 32-bit collision is still caught at the aggregate level.
 * @param {{ a: number, b: number, c: number, d: number }} digest
 * @param {string} id
 * @param {number} favHash 32-bit per-field hash
 * @param {number} tagIdsHash 32-bit per-field hash
 * @param {number} contentHash 32-bit per-field hash
 * @returns {{ a: number, b: number, c: number, d: number }}
 */
export function combineDigest128(digest, id, favHash, tagIdsHash, contentHash) {
    const key = `${id}:${favHash}:${tagIdsHash}:${contentHash}`;
    return {
        a: (digest.a ^ (getStringHash(key, 0) % 4294967296)) >>> 0,
        b: (digest.b ^ (getStringHash(key, 17) % 4294967296)) >>> 0,
        c: (digest.c ^ (getStringHash(key, 42) % 4294967296)) >>> 0,
        d: (digest.d ^ (getStringHash(key, 99) % 4294967296)) >>> 0,
    };
}

/**
 * Folds one 128-bit bucket digest into another - 128-bit counterpart of foldDigests().
 * @param {{ a: number, b: number, c: number, d: number }} x
 * @param {{ a: number, b: number, c: number, d: number }} y
 * @returns {{ a: number, b: number, c: number, d: number }}
 */
export function foldDigests128(x, y) {
    return {
        a: (x.a ^ y.a) >>> 0,
        b: (x.b ^ y.b) >>> 0,
        c: (x.c ^ y.c) >>> 0,
        d: (x.d ^ y.d) >>> 0,
    };
}

/**
 * @param {{ a: number, b: number, c: number, d: number }} x
 * @param {{ a: number, b: number, c: number, d: number }} y
 * @returns {boolean}
 */
export function digestsEqual128(x, y) {
    return x.a === y.a && x.b === y.b && x.c === y.c && x.d === y.d;
}
