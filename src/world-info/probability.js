/**
 * Mirrors the verifyProbability() closure inside public/scripts/world-info.js's checkWorldInfo().
 * @param {{useProbability?: boolean, probability?: number}} entry
 * @param {boolean} isSticky
 * @param {() => number} [random] Injectable RNG (0-1), defaults to Math.random - tests pin this.
 * @returns {boolean}
 */
export function verifyProbability(entry, isSticky, random = Math.random) {
    if (!entry.useProbability || entry.probability === 100) return true;
    if (isSticky) return true;
    const rollValue = random() * 100;
    return rollValue <= entry.probability;
}
