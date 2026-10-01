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
 * @property {(target: string) => boolean} hasMergingInto Whether any marked tag merges into `target`.
 * @property {(target: string, limit: number) => string[] | null} mergingIntoUpTo The marked tag ids merging into
 *   `target`, or null when more than `limit` do. SQL readers never need the list: they match the marks in the query.
 */

/**
 * Most marked ids a tag filter hands the search index for every tag it names together. The index has no table to join
 * to, so a filter whose named tags have more merging into them is checked in SQL instead (tantivyTagFilter()).
 */
export const TANTIVY_MERGED_IDS_LIMIT = 1000;

/**
 * A TagDeletions over a plain Map of marked id -> merge target (or null). For marks already held in memory.
 * @param {Map<string, string | null>} marks
 * @returns {TagDeletions}
 */
export function tagDeletionsFromMap(marks) {
    const merging = (/** @type {string} */ target) => [...marks].filter(([, mergeInto]) => mergeInto === target).map(([id]) => id);
    return {
        any: marks.size > 0,
        has: (tagId) => marks.has(tagId),
        get: (tagId) => marks.get(tagId),
        hasMergingInto: (target) => merging(target).length > 0,
        mergingIntoUpTo: (target, limit) => {
            const ids = merging(target);
            return ids.length > limit ? null : ids;
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
 * @property {string[]} include The unmarked tags the filter includes, each once. An entity matches an included tag
 *   when it has the tag or a marked tag merging into it.
 * @property {string[]} exclude The unmarked tags the filter excludes, each once, matched the same way.
 * @property {'and' | 'or'} mode
 * @property {boolean} none The filter matches nothing (an included tag was deleted with no merge target, in 'and'
 *   mode, or every included tag was, in 'or' mode).
 */

/**
 * A /query tag filter as the tag rows see it: a filter naming a tag Y also matches rows of each marked X that merges
 * into Y, and one naming a marked X acts on its target. Returns null when no marked tag touches the filter, so the
 * caller keeps its plain form. Each question is a lookup by key; nothing here lists the marks.
 * @param {{ include?: unknown, exclude?: unknown, mode?: unknown } | undefined | null} tags
 * @param {TagDeletions} deletions
 * @returns {ExpandedTagFilter | null}
 */
export function expandTagFilter(tags, deletions) {
    if (!tags || !deletions.any) return null;
    const include = Array.isArray(tags.include) ? tags.include.filter(Boolean).map(String) : [];
    const exclude = Array.isArray(tags.exclude) ? tags.exclude.filter(Boolean).map(String) : [];
    /** @type {Map<string, boolean>} */
    const merged = new Map();
    const hasMerging = (/** @type {string} */ target) => {
        if (!merged.has(target)) merged.set(target, deletions.hasMergingInto(target));
        return /** @type {boolean} */ (merged.get(target));
    };
    const touched = (/** @type {string} */ id) => deletions.has(id) || hasMerging(id);
    if (!include.some(touched) && !exclude.some(touched)) return null;

    const mode = tags.mode === 'or' ? 'or' : 'and';
    /** @type {Set<string>} */
    const included = new Set();
    let emptyGroups = 0;
    for (const id of include) {
        const target = resolveTagId(id, deletions);
        if (target === null) emptyGroups++;
        else included.add(target);
    }
    /** @type {Set<string>} */
    const excluded = new Set();
    for (const id of exclude) {
        const target = resolveTagId(id, deletions);
        if (target !== null) excluded.add(target);
    }
    const none = include.length > 0 && (mode === 'and' ? emptyGroups > 0 : included.size === 0);
    return { include: [...included], exclude: [...excluded], mode, none };
}

/**
 * An expanded filter in the form the search index takes: each included tag as a group of its own id and every marked
 * id merging into it, and every excluded id. The index has no table to join to, so it needs the ids themselves; null
 * when the named tags have more than TANTIVY_MERGED_IDS_LIMIT merging into them together, and the caller then leaves
 * the tags to SQL, which matches the marks in the query and needs no list.
 * @param {ExpandedTagFilter} expanded
 * @param {TagDeletions} deletions
 * @returns {{ include: string[][], exclude: string[], mode: 'and' | 'or' } | null}
 */
export function tantivyTagFilter(expanded, deletions) {
    let budget = TANTIVY_MERGED_IDS_LIMIT;
    /** @type {Map<string, string[]>} */
    const groups = new Map();
    for (const target of [...expanded.include, ...expanded.exclude]) {
        if (groups.has(target)) continue;
        const ids = deletions.mergingIntoUpTo(target, budget);
        if (ids === null) return null;
        budget -= ids.length;
        groups.set(target, [target, ...ids]);
    }
    return {
        include: expanded.include.map(target => /** @type {string[]} */ (groups.get(target))),
        exclude: expanded.exclude.flatMap(target => /** @type {string[]} */ (groups.get(target))),
        mode: expanded.mode,
    };
}

/**
 * @typedef {object} SearchIndexTagFilter
 * @property {{ include: string[][], exclude: string[], mode: 'and' | 'or' } | null} expanded tantivyTagFilter()'s form
 *   for buildTagFilterQuery(), or null when the plain filter applies (or leftToSql).
 * @property {boolean} none The filter matches nothing.
 * @property {boolean} leftToSql The index can't take the filter (too many marked tags merge into its tags to list): the
 *   search runs without it and without a row cap, and the caller's SQL, which checks tags anyway, applies it.
 */

/**
 * A /query tag filter as a search index applies it, given the marks.
 * @param {{ include?: unknown, exclude?: unknown, mode?: unknown } | undefined | null} tags
 * @param {TagDeletions} deletions
 * @returns {SearchIndexTagFilter}
 */
export function searchIndexTagFilter(tags, deletions) {
    const expanded = expandTagFilter(tags, deletions);
    if (!expanded) return { expanded: null, none: false, leftToSql: false };
    if (expanded.none) return { expanded: null, none: true, leftToSql: false };
    const forIndex = tantivyTagFilter(expanded, deletions);
    return forIndex ? { expanded: forIndex, none: false, leftToSql: false } : { expanded: null, none: false, leftToSql: true };
}
