// Pure string helpers shared by the page and the server (the macro engine runs on both).

/**
 * Checks if a string is "true" value.
 * @param {string} arg String to check
 * @returns {boolean} True if the string is true, false otherwise.
 */
export function isTrueBoolean(arg) {
    return ['on', 'true', '1'].includes(arg?.trim()?.toLowerCase());
}

/**
 * Checks if a string is "false" value.
 * @param {string} arg String to check
 * @returns {boolean} True if the string is false, false otherwise.
 */
export function isFalseBoolean(arg) {
    return ['off', 'false', '0'].includes(arg?.trim()?.toLowerCase());
}

/**
 * Escapes a string for use in a regular expression.
 * @param {string} string The string to escape.
 * @returns {string} The escaped string.
 * @example
 * escapeRegex('^Hello$'); // '\\^Hello\\$'
 */
export function escapeRegex(string) {
    return string.replace(/[/\-\\^$*+?.()|[\]{}]/g, '\\$&');
}
