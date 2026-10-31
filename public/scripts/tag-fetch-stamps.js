let tagClock = 0;

/** @type {Map<string, {pending: number, savedAt: number}>} */
const localTagChanges = new Map();

/**
 * @returns {number}
 */
export function tagFetchStamp() {
    return ++tagClock;
}

/**
 * @param {string} key
 * @param {number|undefined} fetchStamp
 * @returns {boolean}
 */
export function isFetchedTagIdsCurrent(key, fetchStamp) {
    const change = localTagChanges.get(key);
    if (!change) return true;
    return change.pending === 0 && fetchStamp !== undefined && change.savedAt < fetchStamp;
}

/**
 * @param {string} key
 * @returns {() => void}
 */
export function beginLocalTagChange(key) {
    const change = localTagChanges.get(key) ?? { pending: 0, savedAt: 0 };
    change.pending++;
    localTagChanges.set(key, change);
    return () => {
        change.pending--;
        change.savedAt = ++tagClock;
    };
}
