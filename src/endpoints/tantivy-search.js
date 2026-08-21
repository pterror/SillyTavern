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
 * QUOTED MULTI-WORD PHRASES ARE NOT TRUE ADJACENCY-PHRASE-PREFIX MATCHES HERE, UNLIKE THE OLD FTS5 BEHAVIOR: FTS5's
 * `"vampire lord"*` is a genuine phrase-prefix match (the words must be adjacent, in order, with the last one
 * prefix-matched). tantivy's confirmed prefix mechanism (regexQuery, above) matches individual *indexed tokens*
 * against a regex - it has no adjacency concept, and this binding exposes phraseQuery() (exact adjacency, no
 * prefix) but nothing that combines phrase adjacency with a trailing prefix match. A quoted phrase here is instead
 * split into words and AND-ed together (each word independently prefix-matched via regexQuery, across the same
 * field/label scope) - so `tag:"cute girl"` becomes "this field contains a token starting with 'cute' AND a token
 * starting with 'girl'", not "contains the adjacent phrase 'cute girl...'". This is a real, deliberate behavioral
 * difference from the FTS5 version, not something confirmed equivalent - flagging it here rather than silently
 * changing what quoting means.
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

/** The stored-only field name every tantivy-backed index (characters, groups) uses for the full JSON payload -
 * see buildSchema()'s doc comment for why this field is `raw`-tokenized + `basic`-indexed rather than a real
 * searchable text field. */
export const DATA_FIELD = 'data';

/**
 * Builds a tantivy Schema for a search index: one real (tokenized, position-indexed, unstored) text field per
 * entry in `searchableFieldNames`, plus one `data` field holding the full JSON payload of the indexed item.
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
 * @returns {import('@oxdev03/node-tantivy-binding').Schema}
 */
export function buildSchema(tantivy, searchableFieldNames) {
    const builder = new tantivy.SchemaBuilder();
    for (const name of searchableFieldNames) {
        builder.addTextField(name, { stored: false, tokenizerName: 'default', indexOption: 'position' });
    }
    builder.addTextField(DATA_FIELD, { stored: true, tokenizerName: 'raw', indexOption: 'basic' });
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
 * `label:value` filter (searched only across the label's target field(s)). A quoted multi-word value is split
 * into words and AND-ed together - see this module's header for why that's not a true adjacency-phrase match.
 * @param {typeof import('@oxdev03/node-tantivy-binding')} tantivy
 * @param {import('@oxdev03/node-tantivy-binding').Schema} schema
 * @param {string} token One token from tokenizeSearchQuery()
 * @param {Record<string, number>} fieldWeights Map of every searchable field name -> its relevance weight
 * @param {Record<string, string[]>} fieldLabels Map of recognized lowercase label -> the field name(s) it scopes
 * a token to (analogous to search-query.js's FTS5-column-expression maps, but as field-name arrays)
 * @returns {import('@oxdev03/node-tantivy-binding').Query | null}
 */
function tokenQuery(tantivy, schema, token, fieldWeights, fieldLabels) {
    const labeled = parseLabeledToken(token, fieldLabels);
    const rawValue = labeled ? labeled.value : token;
    const term = unquoteSearchTerm(rawValue).trim();
    if (!term) {
        return null;
    }

    const targetFieldNames = labeled
        ? (Array.isArray(labeled.column) ? labeled.column : [labeled.column])
        : Object.keys(fieldWeights);

    const words = term.split(/\s+/).filter(Boolean);
    const wordQueries = words
        .map(word => fieldGroupQuery(tantivy, schema, word, targetFieldNames, fieldWeights))
        .filter(Boolean);

    if (wordQueries.length === 0) {
        return null;
    }
    if (wordQueries.length === 1) {
        return wordQueries[0];
    }
    return tantivy.Query.booleanQuery(wordQueries.map(query => ({ occur: tantivy.Occur.Must, query })));
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
 * @returns {import('@oxdev03/node-tantivy-binding').Query | null} A query, or null if there's nothing to search
 * for (empty input, or every token turned out to be empty after unquoting)
 */
export function buildSearchQuery(tantivy, schema, searchTerm, fieldWeights, fieldLabels) {
    const tokens = tokenizeSearchQuery(searchTerm);
    if (tokens.length === 0) {
        return null;
    }

    const perTokenQueries = tokens
        .map(token => tokenQuery(tantivy, schema, token, fieldWeights, fieldLabels))
        .filter(Boolean);

    if (perTokenQueries.length === 0) {
        return null;
    }
    if (perTokenQueries.length === 1) {
        return perTokenQueries[0];
    }
    return tantivy.Query.booleanQuery(perTokenQueries.map(query => ({ occur: tantivy.Occur.Must, query })));
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
 * @param {number} maxRows Caps how many matching docs get fetched and JSON.parse()'d - same unbounded-fetch OOM
 * concern as querySqliteIndex() (see that function's doc comment in characters-search-index.js), so this is
 * required, not optional, here.
 * @returns {{ results: { item: object, score: number }[], total: number }}
 */
export function runSearch(index, query, maxRows) {
    const searcher = index.searcher();
    const limit = Math.max(0, Math.trunc(maxRows));
    const result = searcher.search(query, limit, true, undefined, 0);
    const results = result.hits.map(hit => {
        const doc = searcher.doc(hit.docAddress);
        const raw = doc.getFirst(DATA_FIELD);
        return { item: JSON.parse(raw), score: -(hit.score ?? 0) };
    });
    return { results, total: result.count ?? results.length };
}
