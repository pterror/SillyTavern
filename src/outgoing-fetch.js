/**
 * fetch() for the server's outgoing requests. A request that fails, before the response or while its body is read, is
 * rejected with an Error whose message says why (refused, blocked by the private request filter, unresolvable, the
 * connection closed mid-reply, ...), never fetch()'s bare "fetch failed" or "terminated". An abort is rejected as it
 * is, so callers can tell it by its name.
 * @param {string | URL | Request} input
 * @param {RequestInit} [init]
 * @returns {Promise<Response>}
 */
export async function fetchOutgoing(input, init) {
    let response;
    try {
        // eslint-disable-next-line no-restricted-globals
        response = await fetch(input, init);
    } catch (error) {
        throw outgoingRequestError(error);
    }
    if (!response.body) return response;
    const reader = response.body.getReader();
    const body = new ReadableStream({
        async pull(controller) {
            try {
                const { done, value } = await reader.read();
                if (done) controller.close();
                else controller.enqueue(value);
            } catch (error) {
                controller.error(outgoingRequestError(error));
            }
        },
        cancel(reason) {
            return reader.cancel(reason);
        },
    });
    const answer = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    Object.defineProperties(answer, { url: { value: response.url }, redirected: { value: response.redirected } });
    return answer;
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
    const message = error.message === 'terminated'
        ? `The connection closed before the reply ended: ${reason}`
        : cause.code === 'ECONNREFUSED' ? `Connection refused: ${reason}` : reason;
    return Object.assign(new Error(message, { cause: error }), cause.code ? { code: cause.code } : {});
}
