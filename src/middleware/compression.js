import compression from 'compression';

/**
 * @param {import('express').Request} request
 * @param {import('express').Response} response
 * @returns {boolean}
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
