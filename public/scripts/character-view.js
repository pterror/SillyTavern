/**
 * A view: everything that decides what the character list shows.
 * @typedef {object} CharacterView
 * @property {string} text Free search text, without its conditions.
 * @property {CharacterViewCondition[]} conditions Field conditions, in the order they were added.
 * @property {{ include: string[], exclude: string[], mode?: 'and'|'or' }} tags Tag ids the list must carry / must not carry.
 *   `mode` 'or': a row needs any one of `include`, not all of them.
 * @property {boolean|undefined} fav `true` favorites only, `false` no favorites, `undefined` either.
 * @property {Record<string, { min?: number, max?: number }>} [ranges] Inclusive bounds on the fields of RANGE_FIELDS;
 *   a missing end is open.
 * @property {boolean|undefined} group `true` groups only, `false` no groups, `undefined` either.
 * @property {CharacterViewSort} sort
 * @property {string|null} folderCase The closed-folder case shown: `'none'` for rows in no closed folder, a closed
 *   folder's tag id for its rows, `null` for every row ("Tags as Folders" off).
 */

/**
 * @typedef {object} CharacterViewCondition
 * @property {string} field A canonical field name from SEARCH_FIELDS.
 * @property {'contains'|'not_contains'} op
 * @property {string} value As typed, quotes included when the value has spaces.
 */

/**
 * @typedef {object} CharacterViewSort
 * @property {string} field A `/query` sort field, or `'search'` / `'random'`.
 * @property {'asc'|'desc'} order
 * @property {number} [seed] Set when `field` is `'random'`.
 */

/**
 * The fields a condition can name: the canonical label, then the aliases typing turns into it. These are the labels
 * the server's search indexes accept (characters-search-index.js and groups-search-index.js TANTIVY_FIELD_LABELS).
 * @type {Readonly<Record<string, readonly string[]>>}
 */
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

/** @type {Map<string, string>} Every accepted label, lowercased, to its canonical field. */
const LABEL_TO_FIELD = new Map(Object.entries(SEARCH_FIELDS).flatMap(([field, aliases]) =>
    [[field, field], ...aliases.map(alias => [alias, field])]));

/**
 * The canonical field a typed label names, or null when the server wouldn't treat it as a field.
 * @param {string} label
 * @returns {string|null}
 */
export function canonicalSearchField(label) {
    return LABEL_TO_FIELD.get(String(label).toLowerCase()) ?? null;
}

// Same tokens as the server's tokenizeSearchQuery() (src/endpoints/search-query.js).
const TOKEN_PATTERN = /[^\s"]*"[^"]*"|\S+/g;
const CONDITION_PATTERN = /^(-)?([A-Za-z][A-Za-z0-9_]*):(.+)$/;

/**
 * Splits a search string into free text and conditions, the way the server reads it.
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
 * The search string a view sends: its conditions, then its free text.
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
 * What `buildCharacterQuery()` (character-repository.js) takes to make the `/api/characters/query` request a view asks for.
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
        includeGroups,
        group: view.group,
        folder: view.folderCase ?? undefined,
    };
}

/**
 * The fields a range can bound: the server's `filter.ranges` fields (character-metadata-db.js QUERY_RANGE_COLUMNS).
 * `unit` says how the pill reads and writes the stored number.
 * @type {Readonly<Record<string, { unit: 'date'|'kb'|'count' }>>}
 */
export const RANGE_FIELDS = Object.freeze({
    create_date: { unit: 'date' },
    date_last_chat: { unit: 'date' },
    chat_size: { unit: 'kb' },
    data_size: { unit: 'count' },
});

/**
 * A view's ranges with empty bounds and unknown fields dropped, in field order; undefined when nothing is bounded.
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
 * How a view's included tags combine. With fewer than two there is nothing to combine, so it is 'and'.
 * @param {CharacterView['tags']} tags
 * @returns {'and'|'or'}
 */
export function tagMode(tags) {
    return tags.mode === 'or' && tags.include.length > 1 ? 'or' : 'and';
}

/**
 * Whether two views show the same list.
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
