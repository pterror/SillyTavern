/**
 * A seeded random order over the ranks 0..n-1 of one numbering space (search plan step 7c, R1 = A2): a keyed
 * Feistel permutation of [0, 2^m) with cycle-walking down to [0, n). Position i of the order shows the entity at
 * rank permute(i). Each (seed, space) pair gets its own order; nothing is stored per seed.
 */

const MASK64 = (1n << 64n) - 1n;

/**
 * The splitmix64 finalizer.
 * @param {bigint} x
 * @returns {bigint}
 */
function mix64(x) {
    let z = x & MASK64;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
    return z ^ (z >> 31n);
}

/**
 * FNV-1a over the UTF-16 code units, 64 bits, so a space name can be mixed into the key.
 * @param {string} text
 * @returns {bigint}
 */
function hashText(text) {
    let h = 0xcbf29ce484222325n;
    for (let i = 0; i < text.length; i++) {
        h ^= BigInt(text.charCodeAt(i));
        h = (h * 0x100000001b3n) & MASK64;
    }
    return h;
}

/**
 * The key of one space's order under one seed.
 * @param {number} seed The client's `sort.seed`.
 * @param {string} space
 * @returns {bigint}
 */
export function orderKey(seed, space) {
    const seedBits = BigInt.asUintN(64, BigInt(Math.trunc(Number(seed) || 0)));
    return mix64(seedBits ^ mix64(hashText(space)));
}

const ROUNDS = 6;

/**
 * The bit width of the permuted domain for n items: the smallest m with 2^m >= n, at least 2 so both halves of the
 * Feistel network have a bit.
 * @param {number} n
 */
function domainBits(n) {
    let m = 2;
    while (2 ** m < n) m++;
    return m;
}

/**
 * One round's function: key, round and the input half mixed by splitmix64, cut to `bits`.
 * @param {bigint} key
 * @param {number} round
 * @param {number} half
 * @param {number} bits
 */
function roundValue(key, round, half, bits) {
    return Number(mix64(key ^ (BigInt(round) << 56n) ^ BigInt(half)) & ((1n << BigInt(bits)) - 1n));
}

/**
 * The Feistel network over [0, 2^m): the left part has ⌈m/2⌉ bits, the right ⌊m/2⌋; each round's output halves
 * swap sizes, and an even number of rounds brings them back.
 * @param {number} x
 * @param {number} m
 * @param {bigint} key
 */
function feistel(x, m, key) {
    let aBits = Math.ceil(m / 2);
    let bBits = m - aBits;
    let left = Math.floor(x / 2 ** bBits);
    let right = x % 2 ** bBits;
    for (let round = 0; round < ROUNDS; round++) {
        const next = (left ^ roundValue(key, round, right, aBits)) >>> 0;
        left = right;
        right = next % 2 ** aBits;
        [aBits, bBits] = [bBits, aBits];
    }
    return left * 2 ** bBits + right;
}

/**
 * The network run backwards.
 * @param {number} y
 * @param {number} m
 * @param {bigint} key
 */
function feistelInverse(y, m, key) {
    // After ROUNDS (even) rounds the sizes are back to (⌈m/2⌉, ⌊m/2⌋).
    let aBits = Math.ceil(m / 2);
    let bBits = m - aBits;
    let left = Math.floor(y / 2 ** bBits);
    let right = y % 2 ** bBits;
    for (let round = ROUNDS - 1; round >= 0; round--) {
        // The sizes this round started with: its left had aBits, its right (now our left) bBits.
        [aBits, bBits] = [bBits, aBits];
        const originalRight = left;
        const originalLeft = (right ^ roundValue(key, round, originalRight, aBits)) >>> 0;
        left = originalLeft % 2 ** aBits;
        right = originalRight;
    }
    return left * 2 ** bBits + right;
}

/**
 * The rank shown at position `i` of a space of `n` members under `key`.
 * @param {number} i 0 <= i < n
 * @param {number} n
 * @param {bigint} key
 */
export function permute(i, n, key) {
    if (n <= 1) return 0;
    const m = domainBits(n);
    let x = feistel(i, m, key);
    while (x >= n) x = feistel(x, m, key);
    return x;
}

/**
 * The position at which rank `r` is shown: permute()'s inverse.
 * @param {number} r 0 <= r < n
 * @param {number} n
 * @param {bigint} key
 */
export function unpermute(r, n, key) {
    if (n <= 1) return 0;
    const m = domainBits(n);
    let x = feistelInverse(r, m, key);
    while (x >= n) x = feistelInverse(x, m, key);
    return x;
}
