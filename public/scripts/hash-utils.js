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
