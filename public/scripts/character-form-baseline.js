// The value the fork last wrote into each hidden `#form_create` input that has no per-field save of its own.
// Every fork write to such an input must call setFormBaseline() right after, or createOrEditCharacter()
// (script.js) mistakes the fork's own write for an extension's and saves it.

/** @type {Map<string, string>} */
const baselines = new Map();

/**
 * @param {string} field The input's selector, e.g. `'#character_json_data'`.
 * @param {string} value The input's value right after the write.
 */
export function setFormBaseline(field, value) {
    baselines.set(field, value);
}

/**
 * @param {string} field
 * @returns {string|undefined} Undefined when the fork never wrote the field.
 */
export function getFormBaseline(field) {
    return baselines.get(field);
}
