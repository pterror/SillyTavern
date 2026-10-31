const UNREACHABLE_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN', 'ETIMEDOUT']);

const QUIET_MS = 10_000;

/** @type {Map<string, number>} */
const lastSaid = new Map();

/**
 * @param {unknown} error
 * @returns {string|null}
 */
export function unreachableCode(error) {
    const value = /** @type {any} */ (error);
    const code = value?.code ?? value?.cause?.code;
    return typeof code === 'string' && UNREACHABLE_CODES.has(code) ? code : null;
}

/**
 * @param {string} url
 * @param {string} code
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
 * @param {string} url
 * @param {unknown} error
 * @param {() => void} log
 */
export function logBackendFailure(url, error, log) {
    const code = unreachableCode(error);
    if (code) {
        warnBackendUnreachable(url, code);
    } else {
        log();
    }
}
