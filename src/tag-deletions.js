// A deleted tag definition stays in `tags` until the migration worker's batched pass has moved its rows, and a
// `tag_deletions` row marks it deleted until then. Reads treat a marked tag X as its merge target Y ("X is now Y"),
// or as absent when it has none. These helpers apply that to plain values; the table itself lives in
// character-metadata-db.js.

/**
 * The marks as a reader asks about them, one tag at a time, so no reader holds the whole table.
 * @typedef {object} TagDeletions
 * @property {boolean} any Whether any tag is marked; when false, every other answer is the unmarked one.
 * @property {(tagId: string) => boolean} has Whether `tagId` is marked.
 * @property {(tagId: string) => string | null | undefined} get The unmarked tag id a marked `tagId` merges into, null
 *   when it has none, undefined when `tagId` isn't marked.
 * @property {(target: string) => string[]} mergingInto Every marked tag id merging into `target`. Bounded: throws
 *   TagMergeBacklogError when more than MAX_MERGING_INTO are.
 */

/**
 * Most marked tags one tag may have merging into it before a read naming it is refused. They only pile up when tags
 * are merged into one faster than finishDeletedTags() moves their rows.
 */
export const MAX_MERGING_INTO = 1000;

/** More than MAX_MERGING_INTO marked tags merge into one tag a read needs. The read can be retried once they finish. */
export class TagMergeBacklogError extends Error {
    /** @param {string} target */
    constructor(target) {
        super(`More than ${MAX_MERGING_INTO} deleted tags are still merging into tag ${target}`);
        this.name = 'TagMergeBacklogError';
        this.target = target;
    }
}

/**
 * A TagDeletions over a plain Map of marked id -> merge target (or null). For marks already held in memory.
 * @param {Map<string, string | null>} marks
 * @returns {TagDeletions}
 */
export function tagDeletionsFromMap(marks) {
    return {
        any: marks.size > 0,
        has: (tagId) => marks.has(tagId),
        get: (tagId) => marks.get(tagId),
        mergingInto: (target) => {
            const ids = [];
            for (const [id, mergeInto] of marks) {
                if (mergeInto === target) ids.push(id);
            }
            if (ids.length > MAX_MERGING_INTO) throw new TagMergeBacklogError(target);
            return ids;
        },
    };
}

/** No tag marked. */
export const NO_TAG_DELETIONS = tagDeletionsFromMap(new Map());

/**
 * `tagIds` with each marked id replaced by its merge target (or dropped when it has none), each id once, sorted.
 * With nothing marked in it, the same array is returned untouched.
 * @param {string[]} tagIds
 * @param {TagDeletions} deletions
 * @returns {string[]}
 */
export function resolveTagIds(tagIds, deletions) {
    if (!deletions.any || !Array.isArray(tagIds) || !tagIds.some(id => deletions.has(id))) return tagIds;
    /** @type {Set<string>} */
    const out = new Set();
    for (const id of tagIds) {
        if (!deletions.has(id)) {
            out.add(id);
            continue;
        }
        const target = deletions.get(id);
        if (target) out.add(target);
    }
    return [...out].sort();
}

/**
 * What `tagId` is now: its merge target when marked, null when marked with none, else itself.
 * @param {string} tagId
 * @param {TagDeletions} deletions
 * @returns {string | null}
 */
export function resolveTagId(tagId, deletions) {
    return deletions.has(tagId) ? /** @type {string | null} */ (deletions.get(tagId)) : tagId;
}

/**
 * @typedef {object} ExpandedTagFilter
 * @property {string[][]} include One group per included tag: the tag and every marked id merging into it. An entity
 *   matches a group when it has any id in it.
 * @property {string[]} exclude Every id whose rows count as an excluded tag.
 * @property {'and' | 'or'} mode
 * @property {boolean} none The filter matches nothing (an included tag was deleted with no merge target, in 'and'
 *   mode, or every included tag was, in 'or' mode).
 */

/**
 * A /query tag filter as the tag rows see it: a filter naming a tag Y also matches rows of each marked X that merges
 * into Y, and one naming a marked X acts on its target. Returns null when no marked tag touches the filter, so the
 * caller keeps its plain form.
 * @param {{ include?: unknown, exclude?: unknown, mode?: unknown } | undefined | null} tags
 * @param {TagDeletions} deletions
 * @returns {ExpandedTagFilter | null}
 */
export function expandTagFilter(tags, deletions) {
    if (!tags || !deletions.any) return null;
    const include = Array.isArray(tags.include) ? tags.include.filter(Boolean).map(String) : [];
    const exclude = Array.isArray(tags.exclude) ? tags.exclude.filter(Boolean).map(String) : [];
    /** @type {Map<string, string[]>} */
    const mergedInto = new Map();
    const mergingInto = (/** @type {string} */ target) => {
        let ids = mergedInto.get(target);
        if (!ids) {
            ids = deletions.mergingInto(target);
            mergedInto.set(target, ids);
        }
        return ids;
    };
    const touched = (/** @type {string} */ id) => deletions.has(id) || mergingInto(id).length > 0;
    if (!include.some(touched) && !exclude.some(touched)) return null;

    /** @param {string} id @returns {string[]} */
    const groupOf = (id) => {
        const target = resolveTagId(id, deletions);
        if (target === null) return [];
        return [target, ...mergingInto(target)];
    };

    const mode = tags.mode === 'or' ? 'or' : 'and';
    /** @type {Map<string, string[]>} */
    const groups = new Map();
    let emptyGroups = 0;
    for (const id of include) {
        const group = groupOf(id);
        if (group.length === 0) emptyGroups++;
        else if (!groups.has(group[0])) groups.set(group[0], group);
    }
    const none = include.length > 0 && (mode === 'and' ? emptyGroups > 0 : groups.size === 0);
    return {
        include: [...groups.values()],
        exclude: [...new Set(exclude.flatMap(groupOf))],
        mode,
        none,
    };
}
