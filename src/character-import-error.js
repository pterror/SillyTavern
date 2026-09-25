/** `error.code` for an import input that holds no character card data - a bad file, not a server fault. */
export const NO_CARD_DATA = 'NO_CARD_DATA';

/**
 * Names what was being imported in an error thrown from code that only saw its bytes or a temp path.
 * @param {string} name The uploaded file's original name, the local source path, or the remote URL/id.
 * @param {unknown} error The original error, kept as `cause`; its `code` is carried over.
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
