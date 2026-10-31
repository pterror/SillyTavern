const DEFAULT_WEIGHT = 100;
const sortByOrderDesc = (a, b) => b.order - a.order;

/**
 * @param {Record<string, object[]>} groups
 * @param {import('./timed-effects.js').WorldInfoTimedEffects} timedEffects
 * @param {(entry: object) => void} removeEntry
 * @returns {Map<string, boolean>}
 */
function filterGroupsByTimedEffects(groups, timedEffects, removeEntry) {
    const hasStickyMap = new Map();

    for (const [key, group] of Object.entries(groups)) {
        hasStickyMap.set(key, false);

        const stickyEntries = group.filter(x => timedEffects.isEffectActive('sticky', x));
        if (stickyEntries.length) {
            for (const entry of group) {
                if (!stickyEntries.includes(entry)) removeEntry(entry);
            }
            hasStickyMap.set(key, true);
        }

        for (const entry of group.filter(x => timedEffects.isEffectActive('cooldown', x))) removeEntry(entry);
        for (const entry of group.filter(x => timedEffects.isEffectActive('delay', x))) removeEntry(entry);
    }

    return hasStickyMap;
}

/**
 * @param {Record<string, object[]>} groups
 * @param {import('./key-matching.js').WorldInfoBuffer} buffer
 * @param {(entry: object) => void} removeEntry
 * @param {number} scanState
 * @param {Map<string, boolean>} hasStickyMap
 * @param {boolean} useGroupScoringDefault
 */
function filterGroupsByScoring(groups, buffer, removeEntry, scanState, hasStickyMap, useGroupScoringDefault) {
    for (const [key, group] of Object.entries(groups)) {
        if (!useGroupScoringDefault && !group.some(x => x.useGroupScoring)) continue;
        if (hasStickyMap.get(key)) continue;

        const scores = group.map(entry => buffer.getScore(entry, scanState));
        const maxScore = Math.max(...scores);

        for (let i = 0; i < group.length; i++) {
            const isScored = group[i].useGroupScoring ?? useGroupScoringDefault;
            if (!isScored) continue;
            if (scores[i] < maxScore) {
                removeEntry(group[i]);
                group.splice(i, 1);
                scores.splice(i, 1);
                i--;
            }
        }
    }
}

/**
 * @param {object[]} activatedNow
 * @param {Map<string, object>} allActivatedEntries
 * @param {import('./key-matching.js').WorldInfoBuffer} buffer
 * @param {number} scanState
 * @param {import('./timed-effects.js').WorldInfoTimedEffects} timedEffects
 * @param {{useGroupScoring?: boolean, random?: () => number}} [options]
 */
export function filterByInclusionGroups(activatedNow, allActivatedEntries, buffer, scanState, timedEffects, options = {}) {
    const { useGroupScoring = false, random = Math.random } = options;

    const grouped = activatedNow.filter(x => x.group).reduce((acc, item) => {
        item.group.split(/,\s*/).filter(Boolean).forEach(group => {
            (acc[group] ??= []).push(item);
        });
        return acc;
    }, {});

    if (Object.keys(grouped).length === 0) return;

    const removeEntry = (entry) => {
        const index = activatedNow.indexOf(entry);
        if (index !== -1) activatedNow.splice(index, 1);
    };
    const removeAllBut = (group, chosen) => {
        for (const entry of group) {
            if (entry !== chosen) removeEntry(entry);
        }
    };

    const hasStickyMap = filterGroupsByTimedEffects(grouped, timedEffects, removeEntry);
    filterGroupsByScoring(grouped, buffer, removeEntry, scanState, hasStickyMap, useGroupScoring);

    for (const [key, group] of Object.entries(grouped)) {
        if (hasStickyMap.get(key)) continue;

        if (Array.from(allActivatedEntries.values()).some(x => x.group === key)) {
            removeAllBut(group, null);
            continue;
        }

        if (!Array.isArray(group) || group.length <= 1) continue;

        const prios = group.filter(x => x.groupOverride).sort(sortByOrderDesc);
        if (prios.length) {
            removeAllBut(group, prios[0]);
            continue;
        }

        const totalWeight = group.reduce((acc, item) => acc + (item.groupWeight ?? DEFAULT_WEIGHT), 0);
        const rollValue = random() * totalWeight;
        let currentWeight = 0;
        let winner = null;

        for (const entry of group) {
            currentWeight += (entry.groupWeight ?? DEFAULT_WEIGHT);
            if (rollValue <= currentWeight) {
                winner = entry;
                break;
            }
        }

        if (!winner) continue;
        removeAllBut(group, winner);
    }
}
