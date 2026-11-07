/**
 * fetch() for the server's outgoing requests. A request that fails before a response is rejected with an Error whose
 * message says why (refused, blocked by the private request filter, unresolvable, ...), never fetch()'s bare
 * "fetch failed". An abort is rejected as it is, so callers can tell it by its name.
 * @param {string | URL | Request} input
 * @param {RequestInit} [init]
 * @returns {Promise<Response>}
 */
export async function fetchOutgoing(input, init) {
    try {
        // eslint-disable-next-line no-restricted-globals
        return await fetch(input, init);
    } catch (error) {
        throw outgoingRequestError(error);
    }
}

/**
 * @param {unknown} error What fetch() rejected with.
 * @returns {unknown} An Error saying why the request failed, with the reason's `code` and the original as `cause`;
 * anything that isn't fetch()'s network failure is returned as it is.
 */
export function outgoingRequestError(error) {
    if (!(error instanceof TypeError) || !(error.cause instanceof Error)) return error;
    const cause = /** @type {Error & { code?: string, errors?: Error[] }} */ (error.cause);
    const reason = cause.message || (cause.errors ?? []).map(inner => inner.message).filter(Boolean).join('; ') || cause.code || cause.name;
    const message = cause.code === 'ECONNREFUSED' ? `Connection refused: ${reason}` : reason;
    return Object.assign(new Error(message, { cause: error }), cause.code ? { code: cause.code } : {});
}
