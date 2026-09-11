import { tokenizeSearchQuery, parseLabeledToken, unquoteSearchTerm } from './search-query.js';

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

export function buildExcludeIdsQuery(tantivy, schema, excludeIds) {
    return tantivy.Query.termSetQuery(schema, DATA_FIELD, excludeIds);
}

/**
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
 * @returns {{ results: { raw: string, score: number }[], total: number }} `raw` is DATA_FIELD's stored value,
 * un-parsed - caller decides what it means (full JSON vs. id-only).
 */
export function runSearch(index, query, maxRows, { orderByField, order, offset: searchOffset = 0, count = true } = {}) {
    const searcher = index.searcher();
    const limit = Number.isFinite(maxRows) && maxRows >= 0 ? Math.min(Math.trunc(maxRows), searcher.numDocs) : searcher.numDocs;
    if (limit <= 0) {
        return { results: [], total: 0 };
    }
    // Order enum: 0 = Asc, 1 = Desc (from @oxdev03/node-tantivy-binding's Order const enum)
    const tantivyOrder = orderByField ? (order === 'asc' ? 0 : 1) : undefined;
    const result = searcher.search(query, limit, count, orderByField ?? undefined, searchOffset, tantivyOrder);
    const results = result.hits.map(hit => {
        const doc = searcher.doc(hit.docAddress);
        const raw = doc.getFirst(DATA_FIELD);
        return { raw, score: orderByField ? 0 : -(hit.score ?? 0) };
    });
    return { results, total: result.count ?? results.length };
}
