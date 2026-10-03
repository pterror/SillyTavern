/**
 * Tags deleted and merged into another, as the server's tag reads report them (`merged`: id to the live tag it now
 * reads as). A merged id is a replacement wherever it shows: a character's or group's tag ids carry it as stored until
 * the server moves them, it draws as its target, and a filter or held copy of it is moved to the target.
 */

/** @type {Map<string, string>} */
const mergedTagTargets = new Map();

/**
 * Keeps what a tag read says was merged.
 * @param {unknown} merged A tag read's `merged`.
 */
export function takeInMergedTags(merged) {
    if (!merged || typeof merged !== 'object') return;
    for (const [id, target] of Object.entries(merged)) {
        if (typeof target === 'string' && target !== id) mergedTagTargets.set(id, target);
    }
}

/**
 * The tag `id` reads as: its merge target when it was merged, else itself.
 * @param {string} id
 * @returns {string}
 */
export function mergedTagTarget(id) {
    return mergedTagTargets.get(id) ?? id;
}

/**
 * The tags `tagIds` show as, in order: each merged id as its target, and each tag once.
 * @param {string[]} tagIds
 * @returns {{ id: string, shownId: string }[]} `id` the id as given, `shownId` the tag it shows as.
 */
export function shownTagIds(tagIds) {
    /** @type {Set<string>} */
    const seen = new Set();
    /** @type {{ id: string, shownId: string }[]} */
    const shown = [];
    for (const id of tagIds) {
        const shownId = typeof id === 'string' ? mergedTagTarget(id) : id;
        if (seen.has(shownId)) continue;
        seen.add(shownId);
        shown.push({ id, shownId });
    }
    return shown;
}

/**
 * What a tag read means for tags this page holds: each id the server no longer has goes, each merged one is replaced
 * by its target (as the tag change feed's `mergedInto` replaces it).
 * @param {{ gone?: unknown[], merged?: Record<string, unknown> }} answer A `/api/tags/by-ids` answer.
 * @returns {{ id: string, replaceWithId?: string }[]}
 */
export function tagReadDrops(answer) {
    /** @type {{ id: string, replaceWithId?: string }[]} */
    const drops = (Array.isArray(answer.gone) ? answer.gone : []).map(id => ({ id: String(id) }));
    for (const [id, target] of Object.entries(answer.merged ?? {})) {
        if (typeof target === 'string') drops.push({ id, replaceWithId: target });
    }
    return drops;
}

/** Forgets every merge; for tests. */
export function clearMergedTags() {
    mergedTagTargets.clear();
}
