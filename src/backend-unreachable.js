/** Error codes of a request that never reached a backend: nothing listens there, or the host can't be found. */
const UNREACHABLE_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN', 'ETIMEDOUT']);

/** One send asks a backend several things (its props, its model, a token count per text, the generation). */
const QUIET_MS = 10_000;

/** When each backend (by origin) was last said to be unreachable. @type {Map<string, number>} */
const lastSaid = new Map();

/**
 * @param {unknown} error A failed fetch's error.
 * @returns {string|null} Its code when the request never reached the backend; null for any other failure.
 */
export function unreachableCode(error) {
    const value = /** @type {any} */ (error);
    const code = value?.code ?? value?.cause?.code;
    return typeof code === 'string' && UNREACHABLE_CODES.has(code) ? code : null;
}

/**
 * Says, in one line, that the backend at `url` can't be reached: once for all the requests made to it within a few
 * seconds, so a backend that isn't running isn't reported once per request, each with a stack trace.
 * @param {string} url
 * @param {string} code The error's code (unreachableCode()).
 */
export function warnBackendUnreachable(url, code) {
    let origin = String(url);
    try {
        origin = new URL(origin).origin;
    } catch {
        // Not a URL: named as it was given.
    }
    const now = Date.now();
    if (now - (lastSaid.get(origin) ?? -Infinity) < QUIET_MS) return;
    for (const [key, at] of lastSaid) {
        if (now - at >= QUIET_MS) lastSaid.delete(key);
    }
    lastSaid.set(origin, now);
    console.warn(`The backend at ${origin} can't be reached (${code}). Is it running?`);
}

/**
 * Logs a failed request to a backend: one line for one that can't be reached (warnBackendUnreachable()), otherwise
 * as `log` does.
 * @param {string} url
 * @param {unknown} error
 * @param {() => void} log How any other failure is logged.
 */
export function logBackendFailure(url, error, log) {
    const code = unreachableCode(error);
    if (code) {
        warnBackendUnreachable(url, code);
    } else {
        log();
    }
}
