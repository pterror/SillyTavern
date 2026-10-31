const CHANGE_STREAM_RETRY_FIRST_MS = 1000;
const CHANGE_STREAM_RETRY_MAX_MS = 60000;

/**
 * @param {number} failedTries
 * @returns {number}
 */
export function changeStreamRetryDelayMs(failedTries) {
    return Math.min(CHANGE_STREAM_RETRY_FIRST_MS * 2 ** failedTries, CHANGE_STREAM_RETRY_MAX_MS);
}
