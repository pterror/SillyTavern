import compression from 'compression';

/**
 * The default filter treats text/event-stream as compressible (it matches any `text/*`), and gzip holds small
 * writes in its buffer until the response ends. An event stream doesn't end, so its events and pings would only
 * reach the client when the connection dies.
 * @param {import('express').Request} request Express request object.
 * @param {import('express').Response} response Express response object.
 * @returns {boolean} Whether the response should be compressed.
 */
function shouldCompress(request, response) {
    const contentType = String(response.getHeader('Content-Type') ?? '');
    if (contentType.toLowerCase().startsWith('text/event-stream')) {
        return false;
    }
    return compression.filter(request, response);
}

/** @type {import('express').RequestHandler} */
export const compressionMiddleware = compression({ filter: shouldCompress });

export default compressionMiddleware;
