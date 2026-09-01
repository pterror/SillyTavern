/**
 * Shared `label:value` search-string parsing for the tantivy-backed character/group search indexes
 * (characters-search-index.js, groups-search-index.js, via tantivy-search.js). Lets a user narrow a query to one
 * field - `tag:vampire`, `creator:someone` - instead of always searching every indexed column at once.
 *
 * This module has no per-index behavior baked in on purpose - callers each pass their own label -> field(s) map,
 * since the set of valid labels differs (characters have creator/scenario/personality/etc, groups only have
 * name/tag/member/id).
 *
 * tokenize()/parseLabeledToken()/unquote() are exported (as tokenizeSearchQuery()/parseLabeledToken()/
 * unquoteSearchTerm()) for tantivy-search.js to reuse directly when building its own Query objects against the
 * tantivy Query API - see that module's header for the full rationale.
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
 * @param {string} token One token from tokenizeSearchQuery()
 * @param {Record<string, string | string[]>} fieldLabels Map of recognized lowercase label -> whatever shape
 * the caller uses to represent "which field(s) this label targets" (a field-name array for tantivy-search.js
 * callers) - this function is agnostic to that shape, it just looks the label up and hands the value back
 * untouched.
 * @returns {{ column: string | string[], value: string, label: string, negate: boolean } | null} The resolved
 * column-filter expression, this token's (still possibly quoted) value, the matched lowercase label itself (so a
 * caller that special-cases one particular label - e.g. tantivy-search.js's exact tag-id matching - doesn't have
 * to re-derive it from `column`), and whether the token carried a leading `-` (e.g. `-tag:villain`), or null if
 * `token` isn't a `label:value` (optionally `-label:value`) filter for a label the caller recognizes. Negation is
 * general to every label, not special-cased to any one of them - see tantivy-search.js's buildSearchQuery() for
 * how a caller turns this into a MustNot composition.
 */
export function parseLabeledToken(token, fieldLabels) {
    const match = token.match(/^(-)?([A-Za-z][A-Za-z0-9_]*):(.+)$/);
    if (!match) {
        return null;
    }
    const label = match[2].toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(fieldLabels, label)) {
        return null;
    }
    return { column: fieldLabels[label], value: match[3], label, negate: match[1] === '-' };
}
