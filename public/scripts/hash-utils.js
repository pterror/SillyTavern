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
 * Recomputed fresh every call, never persisted as its own trusted value - see the anti-entropy section header.
 * @param {object} content
 * @returns {number}
 */
export function contentHashOf(content) {
    return getStringHash(canonicalStringify(content ?? {}));
}

/**
 * fav is true iff the value is `true`, `'true'` or `1`; everything else (`false`, `'false'`, `0`, null, missing,
 * anything else) is false.
 * @param {*} value
 * @returns {boolean}
 */
export function normalizeFav(value) {
    return value === true || value === 'true' || value === 1;
}

/**
 * The stored form of an entity's tag_ids, on the server and in the client caches: a sorted copy, and `[]` for
 * anything that isn't an array (absent included). The tag_ids digests read it the same way, so two records with
 * equal digests hold equal tag_ids.
 * @param {*} tagIds
 * @returns {string[]}
 */
export function normalizeTagIds(tagIds) {
    return Array.isArray(tagIds) ? [...tagIds].sort() : [];
}

/**
 * The form two tag names are compared in: equal keys are the same tag. Matches upstream's
 * equalsIgnoreCaseAndAccents() (utils.js), which getTag() uses: accents stripped, then lower-cased.
 * @param {string} name
 * @returns {string}
 */
export function tagNameKey(name) {
    return name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/**
 * The `data` object of a shallow character (the server's toShallow(), src/character-shallow.js): each field
 * falls back to its default only when absent.
 * @param {object} character
 * @param {boolean} includeCreatorNotes The server's `performance.shallowCharactersIncludeCreatorNotes`.
 * @returns {object}
 */
export function shallowCharacterData(character, includeCreatorNotes) {
    const data = character?.data;
    const orDefault = (value, fallback) => (value === undefined ? fallback : value);
    return {
        name: orDefault(data?.name, ''),
        character_version: orDefault(data?.character_version, ''),
        creator: orDefault(data?.creator, ''),
        tags: orDefault(data?.tags, []),
        ...(includeCreatorNotes && { creator_notes: orDefault(data?.creator_notes, '') }),
        extensions: {
            fav: orDefault(data?.extensions?.fav, false),
            world: orDefault(data?.extensions?.world, ''),
        },
    };
}

/**
 * The card's list fields an edit can change, apart from fav: what the edit route's conflict check compares
 * (`characterDigestFieldsHash()`), alongside `characterCardBodyFingerprint()`.
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
 * A group's three digests (its `/query` hash-mode cache key): fav, tag_ids and content.
 * `content` is intentionally the whole group object minus `id`/`fav`/`tag_ids` rather than a narrowed field
 * list - unlike characters, a group's `/query` projection already returns the full object, so narrowing here
 * would silently miss changes to fields not explicitly named.
 * @param {object} group
 * @returns {object}
 */
export function groupFavFingerprint(group) {
    return { fav: normalizeFav(group?.fav) };
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
 * @param {{ hi: number, lo: number }} a
 * @param {{ hi: number, lo: number }} b
 * @returns {boolean}
 */
export function digestsEqual(a, b) {
    return a.hi === b.hi && a.lo === b.lo;
}
