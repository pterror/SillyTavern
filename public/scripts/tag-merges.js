/** @type {Map<string, string>} */
const mergedTagTargets = new Map();

/**
 * @param {unknown} merged
 */
export function takeInMergedTags(merged) {
    if (!merged || typeof merged !== 'object') return;
    for (const [id, target] of Object.entries(merged)) {
        if (typeof target === 'string' && target !== id) mergedTagTargets.set(id, target);
    }
}

/**
 * @param {string} id
 * @returns {string}
 */
export function mergedTagTarget(id) {
    return mergedTagTargets.get(id) ?? id;
}

/**
 * @param {string[]} tagIds
 * @returns {{ id: string, shownId: string }[]}
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
 * @param {{ gone?: unknown[], merged?: Record<string, unknown> }} answer
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

export function clearMergedTags() {
    mergedTagTargets.clear();
}
