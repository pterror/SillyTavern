import { tokenizeSearchQuery, parseLabeledToken, unquoteSearchTerm } from './search-query.js';

/**
 * Shared schema/query-building helpers for the tantivy-backed character/group search indexes
 * (characters-search-index.js, groups-search-index.js) - the tantivy equivalent of search-query.js's
 * buildFtsQuery(), reusing that module's tokenizer and `label:value` parser directly rather than re-deriving
 * them, but building real tantivy Query objects instead of an FTS5 match-string (tantivy has no query-string
 * syntax that maps onto this codebase's needs - see the prefix-matching note below).
 *
 * PREFIX MATCHING DOES NOT WORK VIA `Index.parseQuery()`/`parseQueryLenient()`'s `*` SYNTAX - confirmed by direct
 * testing against a real in-memory index, not assumed from docs: `index.parseQuery("vamp*", ['name'])` against an
 * indexed "Vampire Lord" document returns 0 hits, while `parseQuery("vampire*", ...)` returns 1 hit only because
 * "vampire*" happens to equal the whole indexed token, not because prefix matching actually ran. The query-string
 * parser's `*` is not a real prefix scan against the term dictionary. The fix used here instead:
 * `Query.regexQuery(schema, fieldName, escapedLowercaseTerm + '.*')` - confirmed correct by direct testing: it's
 * case-insensitive (the term is lowercased before building the pattern, since the default tokenizer lowercases
 * indexed terms), it correctly rejects a non-prefix substring ("amp" does not match "Vampire" - regexQuery matches
 * whole indexed tokens against the pattern, so only a token that actually *starts with* "amp" would match), and
 * the term is regex-escaped before `.*` gets appended so a search term containing regex metacharacters is treated
 * as a literal prefix, not interpreted as a pattern.
 *
 * QUOTED MULTI-WORD PHRASES USE REAL ADJACENCY+PREFIX MATCHING via phrasePrefixQuery (available since
 * @oxdev03/node-tantivy-binding 0.3.x): `tag:"cute girl"` is a genuine phrase-prefix match where the words must
 * appear adjacent, in order, with the last word prefix-matched - the same semantics FTS5's `"cute girl"*` had.
 * Single words still go through the regexQuery prefix path (fieldPrefixQuery below) since phrasePrefixQuery
 * requires at least two terms.
 *
 * COMPOSITION: each (sub)word becomes a Should-group boolean query over its candidate field(s) (each field's
 * regexQuery wrapped in a per-field boostQuery so relevance ranking honors the same weights the FTS5 bm25() calls
 * used), and every word's group gets combined with Must into one outer boolean query per token, and every token's
 * query gets combined with Must again - confirmed by direct testing against a real 4-doc in-memory index that this
 * nesting produces the same AND-across-words/OR-across-fields behavior the old FTS5 query strings had (a query for
 * "vamp" AND "lord" matched only "Vampire Lord", not "Vampire Hunter" or "Werewolf Lord").
 *
 * `Query.booleanQuery()` takes an array of `{ occur: Occur.Should|Must|MustNot, query: Query }` objects, not
 * `[occur, query]` tuples - confirmed the tuple shape throws "Missing 'occur' field in subquery". `Occur` is a
 * numeric const enum baked in by the NAPI-RS codegen (introspects as `{}` at runtime, `tantivy.Occur.Should` etc.
 * still works, just don't try to enumerate its keys).
 */

/** The stored, `raw`-tokenized field every tantivy-backed index (characters, groups) uses for its per-document
 * payload - see buildSchema()'s doc comment for why this field is `raw`-tokenized + `basic`-indexed rather than a
 * real searchable text field, and why that's also exactly what qualifies it as the delete-by-term key (design doc
 * §3: "the delete key must be a `tokenizerName: 'raw'` field"). What a caller actually stores in it is caller-
 * defined and NOT parsed here (see runSearch()'s doc comment): groups-search-index.js stores the full group JSON
 * (unchanged, full-rebuild-only - no incremental maintenance for groups yet), characters-search-index.js stores
 * just the character id (design doc §5.1's payload shrink - "the tantivy schema needs the `stored: true` payload
 * changed from the full character JSON to just the id, since rows now come from SQLite"), which is also exactly
 * the value deleteDocumentsByTerm(DATA_FIELD, id) needs to delete that one document without collateral damage. */
export const DATA_FIELD = 'data';

/** The indexed (not stored, not full-text) boolean field every tantivy-backed index (characters, groups) uses to
 * hold the item's favorite flag - see buildSchema()'s doc comment for why this exists and buildSearchQuery()'s
 * `favOnly` option for how it's queried. */
export const FAV_FIELD = 'fav';

/**
 * Builds a tantivy Schema for a search index: one real (tokenized, position-indexed, unstored) text field per
 * entry in `searchableFieldNames`, one `data` field holding the full JSON payload of the indexed item, and one
 * `fav` boolean field so a query can restrict to favorited items without ever seeing an unfavorited one - see
 * buildSearchQuery()'s `favOnly` option doc comment for why that has to happen at the query level (inside
 * whatever row cap the caller applies), not as a post-fetch filter over an already-capped, relevance-only result
 * page: relevance ranking has no relationship to favorite status, so a favorited item can rank arbitrarily far
 * outside any fixed-size page of "most relevant" results, silently making a favorites-only search combined with
 * a broad/common term look empty or wrong regardless of what the caller's cap is set to.
 *
 * STORAGE DESIGN (already decided, not re-litigated here): the full character/group JSON gets stored directly in
 * the tantivy doc as the `data` field, `stored: true` so it's retrievable straight from a search hit with no
 * second disk lookup - mirrors the old FTS5 schema's `data UNINDEXED` column and how querySqliteIndex() (in each
 * search-index module) already does `JSON.parse(row.data)`. It's deliberately NOT a real text-searchable field
 * (`tokenizerName: 'raw'`, `indexOption: 'basic'`) - indexing raw JSON text for real search would pollute every
 * query's relevance scoring with JSON syntax noise (field names, braces, quotes) that has nothing to do with what
 * the user actually typed. `raw` + `basic` keeps it stored-and-exact-fetchable without indexing it for search.
 * @param {typeof import('@oxdev03/node-tantivy-binding')} tantivy
 * @param {string[]} searchableFieldNames
 * @param {string[]} [unsignedFastFieldNames] Names of columnar "fast" fields (unstored, unindexed for search) that
 * exist purely so runSearch()'s `orderByField` can sort on them - a field has to be declared `fast: true` here
 * before it can be used that way.
 * @param {{name: string, tokenizerName?: string}[]} [filterTextFields] Extra whitespace/exact-tokenized, unstored
 * text fields for structured term-query filtering (e.g. tag IDs) rather than free-text search or sorting - see
 * buildTagFilterQuery() below for how these get queried.
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

/**
 * @param {string} term Already-lowercased, not-yet-escaped search term
 * @returns {string} `term` with regex metacharacters escaped, so it's safe to append `.*` to and hand to
 * Query.regexQuery() as a literal-prefix pattern rather than a user-controlled regex
 */
function escapeRegex(term) {
    return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Builds a boosted prefix-match query for one field - see this module's header for why regexQuery() is used
 * instead of the query-string parser's (non-functional, for this purpose) `*` syntax.
 * @param {typeof import('@oxdev03/node-tantivy-binding')} tantivy
 * @param {import('@oxdev03/node-tantivy-binding').Schema} schema
 * @param {string} fieldName
 * @param {string} word A single (already-unquoted, already-split-on-whitespace) word - not a whole phrase
 * @param {number} weight Relevance boost for this field, same numbers the old FTS5 bm25() weight arrays used
 * @returns {import('@oxdev03/node-tantivy-binding').Query}
 */
function fieldPrefixQuery(tantivy, schema, fieldName, word, weight) {
    const pattern = `${escapeRegex(word.toLowerCase())}.*`;
    const query = tantivy.Query.regexQuery(schema, fieldName, pattern);
    return tantivy.Query.boostQuery(query, weight);
}

/**
 * One word's prefix query, OR-ed across every field it's scoped to search (all weighted fields for a bare word,
 * or just the label-targeted field(s) for a `label:value` token).
 * @param {typeof import('@oxdev03/node-tantivy-binding')} tantivy
 * @param {import('@oxdev03/node-tantivy-binding').Schema} schema
 * @param {string} word
 * @param {string[]} fieldNames
 * @param {Record<string, number>} fieldWeights
 * @returns {import('@oxdev03/node-tantivy-binding').Query | null}
 */
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
 * One search token's query - either a bare word/phrase (searched across every weighted field) or a recognized
 * `label:value` filter (searched only across the label's target field(s)). A quoted multi-word value uses
 * phrasePrefixQuery for real adjacency+prefix semantics (see this module's header).
 * @param {typeof import('@oxdev03/node-tantivy-binding')} tantivy
 * @param {import('@oxdev03/node-tantivy-binding').Schema} schema
 * @param {string} token One token from tokenizeSearchQuery()
 * @param {Record<string, number>} fieldWeights Map of every searchable field name -> its relevance weight
 * @param {Record<string, string[]>} fieldLabels Map of recognized lowercase label -> the field name(s) it scopes
 * a token to (analogous to search-query.js's FTS5-column-expression maps, but as field-name arrays)
 * @returns {{ query: import('@oxdev03/node-tantivy-binding').Query, negate: boolean } | null} The token's query
 * plus whether it was a negated (`-label:value`) token - negation is resolved here (parseLabeledToken() only
 * parses the flag) so buildSearchQuery() can compose each token with Must or MustNot accordingly.
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

    // Multi-word phrases (from quoted input like `"vampire lord"` or `tag:"cute girl"`) use
    // phrasePrefixQuery for real adjacency+prefix semantics - the words must appear adjacent, in
    // order, with the last one prefix-matched - restoring the behavior FTS5's `"vampire lord"*`
    // provided. Single words still go through the regexQuery prefix path (fieldGroupQuery below)
    // since phrasePrefixQuery requires at least 2 terms.
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
 * Turns a raw user search string into a tantivy Query, mirroring buildFtsQuery()'s (search-query.js) contract and
 * AND-across-words-by-default behavior exactly (same rationale, not relitigated here - see that module's header
 * and characters-search-index.js's original doc comment for the measured numbers behind AND-by-default), just
 * producing a real Query object instead of an FTS5 match-string.
 * @param {typeof import('@oxdev03/node-tantivy-binding')} tantivy
 * @param {import('@oxdev03/node-tantivy-binding').Schema} schema
 * @param {string} searchTerm Raw user input
 * @param {Record<string, number>} fieldWeights Map of every searchable field name -> its relevance weight
 * @param {Record<string, string[]>} fieldLabels Map of recognized lowercase label -> target field name(s)
 * @param {object} [options] Optional call parameters
 * @param {boolean} [options.favOnly=false] When true, AND-combines the text query with a `fav = true` term query
 * (Query.termQuery() against FAV_FIELD, added to the schema by buildSchema() above) so only favorited items can
 * ever match - restricting the candidate set *before* runSearch()'s row cap/ORDER BY applies, not after. This is
 * what makes "favorites only" + a search term combine correctly: without this, runSearch() ranks and caps purely
 * by text relevance, which has no relationship to favorite status, so a caller's own post-search favorite filter
 * can only ever narrow whatever made it into that relevance-capped page - which can easily be zero favorited
 * items for a common/broad term against a large library, making the favorites filter look broken rather than
 * just working on an already-wrong candidate set.
 * @returns {import('@oxdev03/node-tantivy-binding').Query | null} A query, or null if there's nothing to search
 * for (empty input, or every token turned out to be empty after unquoting)
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

    // Positive (non-negated) tokens AND together as Must, same as before negation existed. Negated
    // (`-label:value`) tokens each become a MustNot clause in the same outer boolean query - general to
    // every label, not special-cased to tags (see parseLabeledToken()'s doc comment in search-query.js).
    // A query made of MustNot clauses alone has nothing to restrict *from* - tantivy's booleanQuery (unlike
    // some other engines) does not implicitly fall back to "match everything" in that case, confirmed by
    // this module's test suite - so an all-negative query needs an explicit Query.allQuery() Must clause as
    // its positive base.
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
 * Builds a MustNot boolean query that excludes documents whose DATA_FIELD matches any of the
 * given ids. Composes with an existing query via `Query.booleanQuery([{occur: Must, query: baseQuery}, {occur: MustNot, query: excludeQuery}])`.
 * @param {typeof import('@oxdev03/node-tantivy-binding')} tantivy
 * @param {import('@oxdev03/node-tantivy-binding').Schema} schema
 * @param {string[]} excludeIds
 * @returns {import('@oxdev03/node-tantivy-binding').Query}
 */
export function buildExcludeIdsQuery(tantivy, schema, excludeIds) {
    return tantivy.Query.termSetQuery(schema, DATA_FIELD, excludeIds);
}

/**
 * Builds a tantivy query for structured tag filtering (include with AND/OR, exclude with MustNot)
 * against a whitespace-tokenized `tag_ids` field in the schema.
 * @param {typeof import('@oxdev03/node-tantivy-binding')} tantivy
 * @param {import('@oxdev03/node-tantivy-binding').Schema} schema
 * @param {{ include?: string[], exclude?: string[], mode?: 'and'|'or' }} tags
 * @param {string} fieldName The tag_ids field name in the schema
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
 * Runs a query against a tantivy index and returns both the requested page of results and the true total match
 * count from a single search() call - confirmed by direct testing that `searcher.search(query, limit, true, ...)`
 * gives an accurate `result.count` independent of `limit`/`offset` pagination (a paginated limit-1/offset-1 query
 * against 2 real matches correctly returned the 2nd match while `count` stayed 2). That means, unlike the SQLite
 * FTS5 tier (which needs a separate COUNT(*) query - see countSqliteIndexMatches() in each search-index module),
 * the tantivy tier never needs a second query just to learn the true total.
 *
 * Score convention: this codebase sorts search results ascending-by-score (lower is better - see
 * paginateSearchResults() in characters.js, and every `bm25()` ORDER BY in the SQLite tier). tantivy's own score
 * is the opposite convention (higher is more relevant, standard BM25-style), so it's negated here to keep every
 * caller downstream of this function - shared code that also handles the SQLite tier's results - working with one
 * consistent "lower is better" convention regardless of which engine actually produced a given result.
 * @param {import('@oxdev03/node-tantivy-binding').Index} index
 * @param {import('@oxdev03/node-tantivy-binding').Query} query
 * @param {number} maxRows Caps how many matching docs get fetched - same unbounded-fetch-cost concern
 * querySqliteIndex() documents (characters-search-index.js), though what exactly is unbounded here depends on
 * what the caller stores in DATA_FIELD: a full-JSON payload (groups) still pays a per-hit JSON.parse, while an
 * id-only payload (characters, since design doc §5.1's payload shrink) makes this cap purely about avoiding a
 * pathologically large hit list, not about parse cost.
 * @param {object} [options]
 * @param {string} [options.orderByField] Name of a fast field (declared via buildSchema()'s `unsignedFastFieldNames`)
 * to sort results by instead of BM25 relevance. When set, every result's `score` is a meaningless 0 placeholder -
 * there's no relevance score once ordering comes from a fast field instead of the query match.
 * @param {'asc'|'desc'} [options.order] Sort direction when `orderByField` is set; defaults to descending.
 * @param {number} [options.offset] Row offset for pagination, handled natively by tantivy's own search() call
 * rather than by fetching everything and slicing in JS.
 * @returns {{ results: { raw: string, score: number }[], total: number }} `raw` is DATA_FIELD's stored value
 * exactly as indexed, UN-parsed - the caller decides what it means (JSON.parse for a full-payload index,
 * used as-is for an id-only one). Deliberately not parsed here so this one function serves both shapes without
 * a mode flag - see DATA_FIELD's doc comment.
 */
export function runSearch(index, query, maxRows, { orderByField, order, offset: searchOffset = 0 } = {}) {
    const searcher = index.searcher();
    // When maxRows is undefined or non-finite, fetch all matching documents - capped at
    // the index's own document count to avoid over-allocating tantivy's internal result heap.
    const limit = Number.isFinite(maxRows) && maxRows >= 0 ? Math.min(Math.trunc(maxRows), searcher.numDocs) : searcher.numDocs;
    if (limit <= 0) {
        return { results: [], total: 0 };
    }
    // Order enum: 0 = Asc, 1 = Desc (from @oxdev03/node-tantivy-binding's Order const enum)
    const tantivyOrder = orderByField ? (order === 'asc' ? 0 : 1) : undefined;
    const result = searcher.search(query, limit, true, orderByField ?? undefined, searchOffset, tantivyOrder);
    const results = result.hits.map(hit => {
        const doc = searcher.doc(hit.docAddress);
        const raw = doc.getFirst(DATA_FIELD);
        // When sorting by a fast field, there's no relevance score - use 0 as a placeholder.
        return { raw, score: orderByField ? 0 : -(hit.score ?? 0) };
    });
    return { results, total: result.count ?? results.length };
}
