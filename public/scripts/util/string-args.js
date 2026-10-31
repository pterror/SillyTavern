/**
 * @param {string} arg
 * @returns {boolean}
 */
export function isTrueBoolean(arg) {
    return ['on', 'true', '1'].includes(arg?.trim()?.toLowerCase());
}

/**
 * @param {string} arg
 * @returns {boolean}
 */
export function isFalseBoolean(arg) {
    return ['off', 'false', '0'].includes(arg?.trim()?.toLowerCase());
}

/**
 * @param {string} string
 * @returns {string}
 */
export function escapeRegex(string) {
    return string.replace(/[/\-\\^$*+?.()|[\]{}]/g, '\\$&');
}

/**
 * @param {string} a
 * @param {string} b
 * @param {(a:string,b:string)=>T} comparisonFunction
 * @returns {T}
 * @template T
 */
export function compareIgnoreCaseAndAccents(a, b, comparisonFunction) {
    if (!a || !b) return comparisonFunction(a, b);

    const normalizedA = a.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const normalizedB = b.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

    return comparisonFunction(normalizedA, normalizedB);
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function equalsIgnoreCaseAndAccents(a, b) {
    return compareIgnoreCaseAndAccents(a, b, (a, b) => a === b);
}

/**
 * @param {{ names: string[], disabled: string[] }} extensions
 * @param {string} name
 * @returns {{name: string, enabled: boolean}|null}
 */
export function findExtensionIn({ names, disabled }, name) {
    const internalExtensionName = names.find(extName => equalsIgnoreCaseAndAccents(extName, name) || equalsIgnoreCaseAndAccents(extName, `third-party/${name}`));
    if (!internalExtensionName) return null;
    return { name: internalExtensionName, enabled: !disabled.includes(internalExtensionName) };
}
