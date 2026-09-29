const CHANGE_STREAM_RETRY_FIRST_MS = 1000;
const CHANGE_STREAM_RETRY_MAX_MS = 60000;

/**
 * The wait before the next rebuild of a closed /changes/stream EventSource.
 * @param {number} failedTries Rebuilds that closed without opening since the stream was last open.
 * @returns {number} Milliseconds.
 */
export function changeStreamRetryDelayMs(failedTries) {
    return Math.min(CHANGE_STREAM_RETRY_FIRST_MS * 2 ** failedTries, CHANGE_STREAM_RETRY_MAX_MS);
}
