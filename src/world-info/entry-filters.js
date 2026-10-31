/**
 * @param {object} entry
 * @param {string[]} [entry.triggers]
 * @param {{names?: string[], tags?: string[], isExclude?: boolean}} [entry.characterFilter]
 * @param {{trigger?: string, characterFilename?: string, characterTags?: string[]}} context
 * @returns {boolean}
 */
export function passesEntryFilters(entry, context = {}) {
    const { trigger, characterFilename, characterTags = [] } = context;

    if (Array.isArray(entry.triggers) && entry.triggers.length > 0) {
        if (!entry.triggers.includes(trigger)) return false;
    }

    if (entry.characterFilter?.names?.length > 0) {
        const nameIncluded = entry.characterFilter.names.includes(characterFilename);
        const filtered = entry.characterFilter.isExclude ? nameIncluded : !nameIncluded;
        if (filtered) return false;
    }

    if (entry.characterFilter?.tags?.length > 0) {
        const includesTag = characterTags.some((tag) => entry.characterFilter.tags.includes(tag));
        const filtered = entry.characterFilter.isExclude ? includesTag : !includesTag;
        if (filtered) return false;
    }

    return true;
}
