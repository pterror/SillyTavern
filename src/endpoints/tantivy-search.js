import { tokenizeSearchQuery, parseLabeledToken, unquoteSearchTerm } from './search-query.js';
import { timePhase } from '../search-timing.js';

/**
 * Builds real tantivy Query objects (reusing search-query.js's tokenizer/label parser) instead of an FTS5 match-string.
 *
 * `Index.parseQuery()`'s `*` syntax does not do real prefix matching (matches only whole tokens), so prefix
 * queries use `Query.regexQuery(schema, field, escapedLowercaseTerm + '.*')` instead.
 * Quoted multi-word phrases use phrasePrefixQuery for real adjacency+prefix matching; phrasePrefixQuery requires
 * at least two terms, so single words go through the regexQuery path instead.
 * `Query.booleanQuery()` takes `{ occur, query }` objects, not `[occur, query]` tuples.
 */

/** Stored, `raw`-tokenized payload field. Not full-text searchable by design; also the delete-by-term key.
 * Caller-defined content: full JSON (groups) or just an id (characters). */
export const DATA_FIELD = 'data';

/** Indexed, unstored boolean favorite-flag field. */
export const FAV_FIELD = 'fav';

// byteCount must not exceed 6: a JS number is only exact up to 2^53-1, and 7 bytes (2^56) silently overflows and collides.
export function stringToSortKey(str, byteCount = 6) {
    const lower = (str || '').toLowerCase();
    let key = 0;
    for (let i = 0; i < byteCount; i++) {
        key = key * 256 + (i < lower.length ? lower.charCodeAt(i) & 0xFF : 0);
    }
    return key;
}

/**
 * Favorite filtering happens at the query level (via FAV_FIELD), not as a post-fetch filter, since relevance
 * ranking has no relationship to favorite status and could otherwise miss favorited items entirely under a row cap.
 * @param {typeof import('@oxdev03/node-tantivy-binding')} tantivy
 * @param {string[]} searchableFieldNames
 * @param {string[]} [unsignedFastFieldNames] Fields usable as runSearch()'s `orderByField`; must be declared `fast: true`.
 * @param {{name: string, tokenizerName?: string}[]} [filterTextFields] Exact-tokenized fields for structured term filtering (e.g. tag IDs).
 * @returns {import('@oxdev03/node-tantivy-binding').Schema}
 */
export function buildSchema(tantivy, searchableFieldNames, unsignedFastFieldNames = [], filterTextFields = []) {
    const builder = new tantivy.SchemaBuilder();
    for (const name of searchableFieldNames) {
        builder.addTextField(name, { stored: false, tokenizerName: 'default', indexOption: 'position' });
    }
    for (const name of unsignedFastFieldNames) {
        builder.addUnsignedField(name, { stored: false, indexed: false, fast: true });
    }
    for (const { name, tokenizerName } of filterTextFields) {
        builder.addTextField(name, { stored: false, tokenizerName: tokenizerName ?? 'whitespace', indexOption: 'basic' });
    }
    builder.addTextField(DATA_FIELD, { stored: true, tokenizerName: 'raw', indexOption: 'basic' });
    builder.addBooleanField(FAV_FIELD, { indexed: true });
    return builder.build();
}

function escapeRegex(term) {
    return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function fieldPrefixQuery(tantivy, schema, fieldName, word, weight) {
    const pattern = `${escapeRegex(word.toLowerCase())}.*`;
    const query = tantivy.Query.regexQuery(schema, fieldName, pattern);
    return tantivy.Query.boostQuery(query, weight);
}

function fieldGroupQuery(tantivy, schema, word, fieldNames, fieldWeights) {
    const fieldQueries = fieldNames
        .filter(name => Object.prototype.hasOwnProperty.call(fieldWeights, name))
        .map(name => fieldPrefixQuery(tantivy, schema, name, word, fieldWeights[name]));

    if (fieldQueries.length === 0) {
        return null;
    }
    if (fieldQueries.length === 1) {
        return fieldQueries[0];
    }
    return tantivy.Query.booleanQuery(fieldQueries.map(query => ({ occur: tantivy.Occur.Should, query })));
}

/**
 * @returns {{ query: import('@oxdev03/node-tantivy-binding').Query, negate: boolean } | null}
 */
function tokenQuery(tantivy, schema, token, fieldWeights, fieldLabels) {
    const labeled = parseLabeledToken(token, fieldLabels);
    const negate = labeled ? labeled.negate : false;
    const rawValue = labeled ? labeled.value : token;
    const term = unquoteSearchTerm(rawValue).trim();
    if (!term) {
        return null;
    }

    const targetFieldNames = labeled
        ? (Array.isArray(labeled.column) ? labeled.column : [labeled.column])
        : Object.keys(fieldWeights);

    const words = term.split(/\s+/).filter(Boolean);

    if (words.length >= 2) {
        const lowered = words.map(w => w.toLowerCase());
        const fieldQueries = targetFieldNames
            .filter(name => Object.prototype.hasOwnProperty.call(fieldWeights, name))
            .map(name => {
                const q = tantivy.Query.phrasePrefixQuery(schema, name, lowered);
                return tantivy.Query.boostQuery(q, fieldWeights[name]);
            });
        if (fieldQueries.length === 0) return null;
        const query = fieldQueries.length === 1
            ? fieldQueries[0]
            : tantivy.Query.booleanQuery(fieldQueries.map(query => ({ occur: tantivy.Occur.Should, query })));
        return { query, negate };
    }

    const wordQueries = words
        .map(word => fieldGroupQuery(tantivy, schema, word, targetFieldNames, fieldWeights))
        .filter(Boolean);

    if (wordQueries.length === 0) {
        return null;
    }
    const query = wordQueries.length === 1
        ? wordQueries[0]
        : tantivy.Query.booleanQuery(wordQueries.map(query => ({ occur: tantivy.Occur.Must, query })));
    return { query, negate };
}

/**
 * AND-across-words by default, mirroring buildFtsQuery()'s (search-query.js) contract.
 * @param {object} [options]
 * @param {boolean} [options.favOnly=false] AND-combines with a `fav = true` filter, applied before runSearch()'s
 * row cap so a broad term can't crowd favorited items out of the candidate set.
 * @returns {import('@oxdev03/node-tantivy-binding').Query | null}
 */
export function buildSearchQuery(tantivy, schema, searchTerm, fieldWeights, fieldLabels, { favOnly = false } = {}) {
    const tokens = tokenizeSearchQuery(searchTerm);
    if (tokens.length === 0) {
        return null;
    }

    const perTokenResults = tokens
        .map(token => tokenQuery(tantivy, schema, token, fieldWeights, fieldLabels))
        .filter(Boolean);

    if (perTokenResults.length === 0) {
        return null;
    }

    // tantivy's booleanQuery does not implicitly match-all, so an all-negated query needs an explicit
    // Query.allQuery() Must clause as its positive base.
    const mustQueries = perTokenResults.filter(r => !r.negate).map(r => r.query);
    const mustNotQueries = perTokenResults.filter(r => r.negate).map(r => r.query);

    const subqueries = [];
    if (mustQueries.length > 0) {
        const positiveQuery = mustQueries.length === 1
            ? mustQueries[0]
            : tantivy.Query.booleanQuery(mustQueries.map(query => ({ occur: tantivy.Occur.Must, query })));
        subqueries.push({ occur: tantivy.Occur.Must, query: positiveQuery });
    } else {
        subqueries.push({ occur: tantivy.Occur.Must, query: tantivy.Query.allQuery() });
    }
    for (const query of mustNotQueries) {
        subqueries.push({ occur: tantivy.Occur.MustNot, query });
    }

    const textQuery = subqueries.length === 1
        ? subqueries[0].query
        : tantivy.Query.booleanQuery(subqueries);

    if (!favOnly) {
        return textQuery;
    }

    const favQuery = tantivy.Query.termQuery(schema, FAV_FIELD, true);
    return tantivy.Query.booleanQuery([
        { occur: tantivy.Occur.Must, query: textQuery },
        { occur: tantivy.Occur.Must, query: favQuery },
    ]);
}

/**
 * @param {typeof import('@oxdev03/node-tantivy-binding')} tantivy
 * @param {import('@oxdev03/node-tantivy-binding').Schema} schema
 * @param {import('@oxdev03/node-tantivy-binding').Query} query
 * @param {boolean|undefined} fav
 * @returns {import('@oxdev03/node-tantivy-binding').Query}
 */
export function withFavFilter(tantivy, schema, query, fav) {
    if (typeof fav !== 'boolean') return query;
    return tantivy.Query.booleanQuery([
        { occur: tantivy.Occur.Must, query },
        { occur: fav ? tantivy.Occur.Must : tantivy.Occur.MustNot, query: tantivy.Query.termQuery(schema, FAV_FIELD, true) },
    ]);
}

const U64_MAX = (1n << 64n) - 1n;

/**
 * The `order` the binding reports on a fast-field-sorted hit whose field holds `value`: the value itself when
 * descending, `u64::MAX - value` rounded to a JS number when ascending. Hits always come back in descending
 * `order`, so comparing against this value (rounding included) places an outside item where tantivy would.
 * @param {number} value A non-negative integer.
 * @param {'asc'|'desc'} order
 * @returns {number}
 */
export function fastFieldOrderValue(value, order) {
    return order === 'asc' ? Number(U64_MAX - BigInt(value)) : value;
}

/**
 * Merges a window of the characters' sorted matches with every matching group, and returns the merged ranks
 * [offset, offset + count). Both lists are in descending `order`; on equal `order` characters come first.
 *
 * `chars` must hold the character matches from rank `charStart`, where `charStart` is at most
 * `offset - groups.length` (or 0), and must reach `offset + count - charStart` entries unless `charsExhausted`
 * (no further character matches exist). When `chars` is empty, `charStart` must be 0.
 * @template {{ id: string, order: number }} T
 * @param {{ chars: T[], charStart: number, charsExhausted: boolean, groups: T[], offset: number, count: number }} params
 * @returns {{ type: 'character'|'group', id: string }[]}
 */
export function mergeSortedWindow({ chars, charStart, charsExhausted, groups, offset, count }) {
    let firstRank = 0;
    let g = 0;
    if (charStart > 0) {
        // Groups sorting before the window's first character sit at ranks below it.
        while (g < groups.length && groups[g].order > chars[0].order) g++;
        firstRank = charStart + g;
    }
    /** @type {{ type: 'character'|'group', id: string }[]} */
    const merged = [];
    const end = offset - firstRank + count;
    let c = 0;
    while (merged.length < end) {
        const charLeft = c < chars.length;
        if (!charLeft && !charsExhausted) break;
        if (g < groups.length && (!charLeft || groups[g].order > chars[c].order)) {
            merged.push({ type: 'group', id: groups[g++].id });
        } else if (charLeft) {
            merged.push({ type: 'character', id: chars[c++].id });
        } else {
            break;
        }
    }
    return merged.slice(offset - firstRank);
}

export function buildIdsQuery(tantivy, schema, ids) {
    return tantivy.Query.termSetQuery(schema, DATA_FIELD, ids);
}

export function buildExcludeIdsQuery(tantivy, schema, excludeIds) {
    return tantivy.Query.termSetQuery(schema, DATA_FIELD, excludeIds);
}

/**
 * tantivy's booleanQuery does not implicitly match-all, so with only excluded tags the query gets an explicit
 * Query.allQuery() Must clause as its positive base.
 * @returns {import('@oxdev03/node-tantivy-binding').Query | null} null if the tags object produces no constraints
 */
export function buildTagFilterQuery(tantivy, schema, tags, fieldName) {
    const subqueries = [];
    const include = Array.isArray(tags.include) ? tags.include.filter(Boolean) : [];
    const exclude = Array.isArray(tags.exclude) ? tags.exclude.filter(Boolean) : [];

    if (include.length > 0) {
        const mode = tags.mode === 'or' ? tantivy.Occur.Should : tantivy.Occur.Must;
        const includeQuery = tantivy.Query.booleanQuery(
            include.map(id => ({ occur: mode, query: tantivy.Query.termQuery(schema, fieldName, id) })),
        );
        subqueries.push({ occur: tantivy.Occur.Must, query: includeQuery });
    } else if (exclude.length > 0) {
        subqueries.push({ occur: tantivy.Occur.Must, query: tantivy.Query.allQuery() });
    }

    for (const id of exclude) {
        subqueries.push({ occur: tantivy.Occur.MustNot, query: tantivy.Query.termQuery(schema, fieldName, id) });
    }

    if (subqueries.length === 0) return null;
    return tantivy.Query.booleanQuery(subqueries);
}

/**
 * Score convention: results sort ascending-by-score (lower is better), opposite of tantivy's own
 * higher-is-better convention, so the score is negated here.
 * @param {import('@oxdev03/node-tantivy-binding').Index} index
 * @param {import('@oxdev03/node-tantivy-binding').Query} query
 * @param {number} maxRows
 * @param {object} [options]
 * @param {string} [options.orderByField] A fast field (declared via buildSchema()'s `unsignedFastFieldNames`) to
 * sort by instead of BM25 relevance; when set, every result's `score` is a meaningless 0 placeholder.
 * @param {'asc'|'desc'} [options.order] Sort direction when `orderByField` is set; defaults to descending.
 * @param {number} [options.offset]
 * @param {boolean} [options.count]
 * @param {string} [options.timingLabel] Records `<label>_tantivy_search` and `<label>_hit_docs` search-timing phases.
 * @returns {{ results: { raw: string, score: number, order?: number }[], total: number }} `raw` is DATA_FIELD's
 * stored value, un-parsed - caller decides what it means (full JSON vs. id-only). `order` is set only with
 * `orderByField` - see fastFieldOrderValue().
 */
export function runSearch(index, query, maxRows, { orderByField, order, offset: searchOffset = 0, count = true, timingLabel } = {}) {
    const timed = (phase, fn) => timingLabel ? timePhase(`${timingLabel}_${phase}`, fn) : fn();
    const searcher = timed('tantivy_search', () => index.searcher());
    const limit = Number.isFinite(maxRows) && maxRows >= 0 ? Math.min(Math.trunc(maxRows), searcher.numDocs) : searcher.numDocs;
    if (limit <= 0) {
        return { results: [], total: 0 };
    }
    // Order enum: 0 = Asc, 1 = Desc (from @oxdev03/node-tantivy-binding's Order const enum)
    const tantivyOrder = orderByField ? (order === 'asc' ? 0 : 1) : undefined;
    const result = timed('tantivy_search', () => searcher.search(query, limit, count, orderByField ?? undefined, searchOffset, tantivyOrder));
    const results = timed('hit_docs', () => result.hits.map(hit => {
        const doc = searcher.doc(hit.docAddress);
        const raw = doc.getFirst(DATA_FIELD);
        return orderByField ? { raw, score: 0, order: hit.order } : { raw, score: -(hit.score ?? 0) };
    }));
    return { results, total: result.count ?? results.length };
}
