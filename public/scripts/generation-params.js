/** Default max length of AI generated responses. */
export let amount_gen = 80;

export let max_context = 2048;

/** @type {string} */
export let main_api;

/**
 * Sets the max length of AI generated responses.
 * @param {number} value New response length
 */
export function setAmountGen(value) {
    amount_gen = value;
}

/**
 * Sets the max context size.
 * @param {number} value New context size
 */
export function setMaxContext(value) {
    max_context = value;
}

/**
 * Raw mutator for main_api, with no notification/UI side effects - those live in script.js's
 * changeMainAPI, which calls this to write the value.
 * @param {string} value
 */
export function setMainApi(value) {
    main_api = value;
}
