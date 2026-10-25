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

/**
 * A common base function for case-insensitive and accent-insensitive string comparisons.
 *
 * @param {string} a - The first string to compare.
 * @param {string} b - The second string to compare.
 * @param {(a:string,b:string)=>T} comparisonFunction - The function to use for the comparison.
 * @returns {T} - The result of the comparison.
 * @template T
 */
export function compareIgnoreCaseAndAccents(a, b, comparisonFunction) {
    if (!a || !b) return comparisonFunction(a, b); // Return the comparison result if either string is empty

    // Normalize and remove diacritics, then convert to lower case
    const normalizedA = a.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const normalizedB = b.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

    // Check if the normalized strings are equal
    return comparisonFunction(normalizedA, normalizedB);
}

/**
 * Performs a case-insensitive and accent-insensitive equality check.
 * This function normalizes the strings to remove diacritical marks and converts them to lowercase to ensure the search is insensitive to case and accents.
 *
 * @param {string} a - The first string to compare
 * @param {string} b - The second string to compare
 * @returns {boolean} true if the strings are equal, otherwise returns false
 */
export function equalsIgnoreCaseAndAccents(a, b) {
    return compareIgnoreCaseAndAccents(a, b, (a, b) => a === b);
}

/**
 * Finds an extension by name, allowing omission of the "third-party/" prefix.
 * @param {{ names: string[], disabled: string[] }} extensions The extensions there are, and those turned off.
 * @param {string} name
 * @returns {{name: string, enabled: boolean}|null}
 */
export function findExtensionIn({ names, disabled }, name) {
    const internalExtensionName = names.find(extName => equalsIgnoreCaseAndAccents(extName, name) || equalsIgnoreCaseAndAccents(extName, `third-party/${name}`));
    if (!internalExtensionName) return null;
    return { name: internalExtensionName, enabled: !disabled.includes(internalExtensionName) };
}
