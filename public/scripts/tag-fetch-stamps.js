// Orders fetches of entity data against local tag changes, so a fetch that started before a local tag change was
// saved can't write its older tag_ids over the resident entity. Kept free of imports so any module that fetches
// entities can use it without closing an import cycle.

/**
 * A logical clock: a fetch takes a stamp before its request, and a local change takes one when its save finishes.
 */
let tagClock = 0;

/**
 * Per entity key changed in this session: how many of its tag saves haven't finished yet, and the stamp of the
 * latest one that has. Only keys this session changed have an entry.
 * @type {Map<string, {pending: number, savedAt: number}>}
 */
const localTagChanges = new Map();

/**
 * Stamp to take right before requesting entity data whose `tag_ids` may be written back into a resident entity.
 * @returns {number}
 */
export function tagFetchStamp() {
    return ++tagClock;
}

/**
 * Whether `tag_ids` fetched for `key` under `fetchStamp` may replace the resident ones: not while a local tag
 * save for `key` is unfinished, nor when one finished after the fetch started, since the fetched copy then
 * predates a local change the resident copy already has.
 * @param {string} key
 * @param {number|undefined} fetchStamp From tagFetchStamp(); undefined counts as older than any local change.
 * @returns {boolean}
 */
export function isFetchedTagIdsCurrent(key, fetchStamp) {
    const change = localTagChanges.get(key);
    if (!change) return true;
    return change.pending === 0 && fetchStamp !== undefined && change.savedAt < fetchStamp;
}

/**
 * Marks a local tag change on `key` as unsaved right away.
 * @param {string} key
 * @returns {() => void} Call once the change's save has finished (successfully or not).
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
