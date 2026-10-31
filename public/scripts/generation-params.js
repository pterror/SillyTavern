export let amount_gen = 80;

export let max_context = 2048;

/** @type {string} */
export let main_api;

/**
 * @param {number} value
 */
export function setAmountGen(value) {
    amount_gen = value;
}

/**
 * @param {number} value
 */
export function setMaxContext(value) {
    max_context = value;
}

/**
 * @param {string} value
 */
export function setMainApi(value) {
    main_api = value;
}
