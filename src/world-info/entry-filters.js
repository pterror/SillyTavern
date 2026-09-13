/**
 * Server-side port of checkWorldInfo()'s generation-trigger and character/tag filter checks
 * (public/scripts/world-info.js:4888-4925). Pure predicate, no lookups performed here - the caller
 * resolves the current character's filename/tags itself (this session's rule: report the raw fact,
 * don't re-derive the lookup mechanism in the port).
 * @param {object} entry
 * @param {string[]} [entry.triggers] Generation types this entry is restricted to
 * @param {{names?: string[], tags?: string[], isExclude?: boolean}} [entry.characterFilter]
 * @param {{trigger?: string, characterFilename?: string, characterTags?: string[]}} context
 * @returns {boolean} True if the entry passes every filter and should be considered for activation
 *
 * Simplification: the client skips the tag filter entirely when the character has no tagMap entry
 * at all (distinct from having one with zero tags) - this port treats "no known tags" the same as
 * "empty tags array" in both cases, which only differs from the client for that specific edge case.
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
