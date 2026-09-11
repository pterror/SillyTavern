/**
 * Shared `label:value` search-string parsing for the tantivy-backed character/group search indexes. Lets a
 * user narrow a query to one field - `tag:vampire`, `creator:someone`.
 *
 * No per-index behavior baked in on purpose - callers each pass their own label -> field(s) map, since valid
 * labels differ per index.
 */

/**
 * Splits a raw search string into tokens on whitespace, except a `"quoted phrase"` (optionally with a
 * `label:` prefix directly attached, e.g. `tag:"cute girl"`) stays together as one token.
 */
export function tokenizeSearchQuery(searchTerm) {
    return searchTerm.trim().match(/[^\s"]*"[^"]*"|\S+/g) ?? [];
}

export function unquoteSearchTerm(value) {
    return value.startsWith('"') && value.endsWith('"') && value.length >= 2
        ? value.slice(1, -1)
        : value;
}

/**
 * @returns {{ column: string | string[], value: string, label: string, negate: boolean } | null} null if
 * `token` isn't a `label:value` (optionally `-label:value`) filter for a label the caller recognizes.
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
