/**
 * Shared `label:value` search-string parsing for the SQLite FTS5 character/group search indexes
 * (characters-search-index.js, groups-search-index.js). Lets a user narrow a query to one field - `tag:vampire`,
 * `creator:someone` - instead of always searching every indexed column at once.
 *
 * DESIGN: lean on FTS5's own native `column:term` column-filter syntax rather than building a custom query
 * parser/AST. Confirmed by direct experiment against a real FTS5 table (not assumed from docs) that:
 *   - `col:term` scopes only the *single* term/phrase/parenthesized-group immediately after the colon - a
 *     second bare word later in the query is NOT still scoped to that column, it goes back to searching every
 *     indexed column (`name:alpha forest` is `name:alpha AND forest`, not `name:alpha AND name:forest`). That
 *     means per-token translation (below) composes correctly with zero extra grouping logic: each token is
 *     independently either a `label:value` filter or a plain term, and joining them with AND reproduces exactly
 *     what FTS5 would do with the real column name substituted in by hand.
 *   - `{col1 col2}:term` (FTS5's column-group syntax) searches term across multiple columns at once - used here
 *     so `tag:`/`tags:` can cover both of characters-search-index.js's tag-ish columns (resolved_tags AND the
 *     raw embedded tags) in one filter, matching how BM25_WEIGHTS already treats them as the same concept.
 *   - An unrecognized column name is a hard FTS5 error ("no such column"), not silently ignored - so a token
 *     that merely *looks* like `label:value` (an unrecognized label, or something like a bare URL) must never be
 *     handed to FTS5 as a column filter. Every token gets checked against the caller-supplied allow-list of
 *     recognized labels first; anything else falls through to being searched as a literal quoted phrase across
 *     all columns, colon included, so a search for `http://example.com` still works.
 *
 * This module has no per-index behavior baked in on purpose - callers (characters-search-index.js,
 * groups-search-index.js) each pass their own label -> column-filter-expression map, since the set of valid
 * labels differs (characters have creator/scenario/personality/etc, groups only have name/tag/member/id).
 *
 * tokenize()/parseLabeledToken()/unquote() are also exported (as tokenizeSearchQuery()/parseLabeledToken()/
 * unquoteSearchTerm()) for tantivy-search.js to reuse directly, rather than re-deriving the same tokenization
 * and label-parsing rules against the tantivy Query API - see that module's header for why the tantivy query
 * path needs the same tokens/labels but can't reuse buildFtsQuery() itself (it needs real Query objects, not an
 * FTS5 match-string).
 */

/**
 * Splits a raw search string into tokens on whitespace, except a `"quoted phrase"` (optionally with a
 * `label:` prefix directly attached, e.g. `tag:"cute girl"`) stays together as one token.
 * @param {string} searchTerm Raw user input
 * @returns {string[]}
 */
export function tokenizeSearchQuery(searchTerm) {
    return searchTerm.trim().match(/[^\s"]*"[^"]*"|\S+/g) ?? [];
}

/**
 * @param {string} value
 * @returns {string} `value` with a single pair of surrounding double quotes stripped, if present
 */
export function unquoteSearchTerm(value) {
    return value.startsWith('"') && value.endsWith('"') && value.length >= 2
        ? value.slice(1, -1)
        : value;
}

/**
 * @param {string} value
 * @returns {string} `value` with internal double quotes escaped the way FTS5 string literals expect (doubled)
 */
function escapeFtsQuotes(value) {
    return value.replace(/"/g, '""');
}

/**
 * @param {string} token One token from tokenizeSearchQuery()
 * @param {Record<string, string | string[]>} fieldLabels Map of recognized lowercase label -> whatever shape
 * the caller uses to represent "which field(s) this label targets" (an FTS5 column name/`{col1 col2}` group
 * string for buildFtsQuery() callers, or a field-name array for tantivy-search.js callers) - this function is
 * agnostic to that shape, it just looks the label up and hands the value back untouched.
 * @returns {{ column: string | string[], value: string } | null} The resolved column-filter expression and this
 * token's (still possibly quoted) value, or null if `token` isn't a `label:value` filter for a label the caller
 * recognizes.
 */
export function parseLabeledToken(token, fieldLabels) {
    const match = token.match(/^([A-Za-z][A-Za-z0-9_]*):(.+)$/);
    if (!match) {
        return null;
    }
    const label = match[1].toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(fieldLabels, label)) {
        return null;
    }
    return { column: fieldLabels[label], value: match[2] };
}

/**
 * Turns a raw user search string into an FTS5 MATCH query: each whitespace-separated word becomes a
 * prefix-matched term (so "vamp" matches "vampire" while typing), multiple words are combined with an explicit
 * AND (see characters-search-index.js's original header comment for the measured rationale - unchanged here),
 * and any token starting with a recognized `label:` prefix is scoped to just that label's column(s) instead of
 * searching everything.
 * @param {string} searchTerm Raw user input
 * @param {Record<string, string>} fieldLabels Map of recognized lowercase label -> FTS5 column-filter expression
 * @returns {string | null} An FTS5 MATCH query string, or null if there's nothing to search for
 */
export function buildFtsQuery(searchTerm, fieldLabels) {
    const tokens = tokenizeSearchQuery(searchTerm);
    if (tokens.length === 0) {
        return null;
    }
    return tokens.map(token => {
        const labeled = parseLabeledToken(token, fieldLabels);
        if (labeled) {
            return `${labeled.column}:"${escapeFtsQuotes(unquoteSearchTerm(labeled.value))}"*`;
        }
        return `"${escapeFtsQuotes(unquoteSearchTerm(token))}"*`;
    }).join(' AND ');
}
