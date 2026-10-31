/** @type {Map<string, string>} */
const baselines = new Map();

/**
 * @param {string} field
 * @param {string} value
 */
export function setFormBaseline(field, value) {
    baselines.set(field, value);
}

/**
 * @param {string} field
 * @returns {string|undefined}
 */
export function getFormBaseline(field) {
    return baselines.get(field);
}
