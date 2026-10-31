/**
 * @typedef {object} CharacterView
 * @property {string} text
 * @property {CharacterViewCondition[]} conditions
 * @property {{ include: string[], exclude: string[], mode?: 'and'|'or' }} tags
 * @property {boolean|undefined} fav
 * @property {Record<string, { min?: number, max?: number }>} [ranges]
 * @property {boolean|undefined} group
 * @property {CharacterViewSort} sort
 * @property {string|null} folderCase
 */

/**
 * @typedef {object} CharacterViewCondition
 * @property {string} field
 * @property {'contains'|'not_contains'} op
 * @property {string} value
 */

/**
 * @typedef {object} CharacterViewSort
 * @property {string} field
 * @property {'asc'|'desc'} order
 * @property {number} [seed]
 * @property {{ field: string, order: 'asc'|'desc', seed?: number }} [tie]
 */

/** @type {Readonly<Record<string, readonly string[]>>} */
export const SEARCH_FIELDS = Object.freeze({
    name: Object.freeze([]),
    tag: Object.freeze(['tags']),
    description: Object.freeze(['desc']),
    personality: Object.freeze([]),
    scenario: Object.freeze([]),
    greeting: Object.freeze([]),
    alternate: Object.freeze(['alt']),
    example: Object.freeze([]),
    notes: Object.freeze([]),
    creator: Object.freeze(['from', 'by', 'author']),
    member: Object.freeze(['members']),
    id: Object.freeze([]),
});

/** @type {Map<string, string>} */
const LABEL_TO_FIELD = new Map(Object.entries(SEARCH_FIELDS).flatMap(([field, aliases]) =>
    [[field, field], ...aliases.map(alias => [alias, field])]));

/**
 * @param {string} label
 * @returns {string|null}
 */
export function canonicalSearchField(label) {
    return LABEL_TO_FIELD.get(String(label).toLowerCase()) ?? null;
}

const TOKEN_PATTERN = /[^\s"]*"[^"]*"|\S+/g;
const CONDITION_PATTERN = /^(-)?([A-Za-z][A-Za-z0-9_]*):(.+)$/;

/**
 * @param {string} searchText
 * @returns {{ text: string, conditions: CharacterViewCondition[] }}
 */
export function parseSearchText(searchText) {
    const tokens = String(searchText ?? '').trim().match(TOKEN_PATTERN) ?? [];
    /** @type {string[]} */
    const words = [];
    /** @type {CharacterViewCondition[]} */
    const conditions = [];
    for (const token of tokens) {
        const match = token.match(CONDITION_PATTERN);
        const field = match ? canonicalSearchField(match[2]) : null;
        if (match && field) {
            conditions.push({ field, op: match[1] === '-' ? 'not_contains' : 'contains', value: match[3] });
        } else {
            words.push(token);
        }
    }
    return { text: words.join(' '), conditions };
}

/**
 * @param {Pick<CharacterView, 'text'|'conditions'>} view
 * @returns {string}
 */
export function serializeSearchText({ text, conditions }) {
    const conditionText = (conditions ?? [])
        .filter(condition => String(condition.value ?? '').trim())
        .map(condition => `${condition.op === 'not_contains' ? '-' : ''}${condition.field}:${condition.value}`)
        .join(' ');
    return [conditionText, String(text ?? '').trim()].filter(Boolean).join(' ');
}

/**
 * @param {CharacterView} view
 * @param {{ includeGroups?: boolean }} [options]
 * @returns {import('./character-repository.js').CharacterQueryStateInput}
 */
export function viewToQueryState(view, { includeGroups = false } = {}) {
    return {
        searchTerm: serializeSearchText(view),
        tagsInclude: view.tags.include,
        tagsExclude: view.tags.exclude,
        tagsMode: tagMode(view.tags),
        ranges: cleanRanges(view.ranges),
        fav: view.fav,
        sortField: view.sort.field,
        sortOrder: view.sort.order,
        randomSeed: view.sort.field === 'random' ? view.sort.seed : undefined,
        sortTie: view.sort.field === 'search' ? view.sort.tie : undefined,
        includeGroups,
        group: view.group,
        folder: view.folderCase ?? undefined,
    };
}

/** @type {Readonly<Record<string, { unit: 'date'|'kb'|'count' }>>} */
export const RANGE_FIELDS = Object.freeze({
    create_date: { unit: 'date' },
    date_last_chat: { unit: 'date' },
    chat_size: { unit: 'kb' },
    data_size: { unit: 'count' },
});

/**
 * @param {CharacterView['ranges']} ranges
 * @returns {CharacterView['ranges'] | undefined}
 */
export function cleanRanges(ranges) {
    /** @type {Record<string, { min?: number, max?: number }>} */
    const clean = {};
    for (const field of Object.keys(RANGE_FIELDS)) {
        const bound = ranges?.[field];
        if (!bound) continue;
        /** @type {{ min?: number, max?: number }} */
        const kept = {};
        if (Number.isFinite(bound.min)) kept.min = bound.min;
        if (Number.isFinite(bound.max)) kept.max = bound.max;
        if (Object.keys(kept).length > 0) clean[field] = kept;
    }
    return Object.keys(clean).length > 0 ? clean : undefined;
}

/**
 * @param {CharacterView['tags']} tags
 * @returns {'and'|'or'}
 */
export function tagMode(tags) {
    return tags.mode === 'or' && tags.include.length > 1 ? 'or' : 'and';
}

/**
 * @param {CharacterView} a
 * @param {CharacterView} b
 * @returns {boolean}
 */
export function sameView(a, b) {
    return JSON.stringify(viewKey(a)) === JSON.stringify(viewKey(b));
}

/**
 * @param {CharacterView} view
 */
function viewKey(view) {
    return {
        search: serializeSearchText(view),
        include: [...view.tags.include].sort(),
        exclude: [...view.tags.exclude].sort(),
        mode: tagMode(view.tags),
        ranges: cleanRanges(view.ranges) ?? null,
        fav: view.fav ?? null,
        group: view.group ?? null,
        sort: view.sort,
        folderCase: view.folderCase ?? null,
    };
}
