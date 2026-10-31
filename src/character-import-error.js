export const NO_CARD_DATA = 'NO_CARD_DATA';

/**
 * @param {string} name
 * @param {unknown} error
 * @returns {Error & { code?: string }}
 */
export function importFailure(name, error) {
    const message = error instanceof Error ? error.message : String(error);
    /** @type {Error & { code?: string }} */
    const wrapped = new Error(`Failed to import "${name}": ${message}`, { cause: error });
    const code = /** @type {any} */ (error)?.code;
    if (code !== undefined) wrapped.code = code;
    return wrapped;
}
