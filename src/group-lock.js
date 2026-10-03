import sanitize from 'sanitize-filename';

/**
 * Per-group async lock. Every writer of a group's JSON file or of its chat files - the group routes and
 * migrateGroupChatsMetadataFormat() - runs its read-modify-write under it, so no write can land between another
 * writer's read and write of the same group.
 *
 * A group is keyed by its JSON file's name within the user's groups directory: a route names the group by id and
 * writes `sanitize(<id>.json)` (groupLockName()), migrateGroupChatsMetadataFormat() names it by the file it listed. Only groups
 * that are held or waited on have an entry, so memory is bounded by in-flight work, not by the number of groups.
 * Main thread only: it serializes async work within this process, not across worker threads.
 */

/** @type {Map<string, Promise<void>>} key -> settles once the last holder queued on that key has released */
const tails = new Map();

/**
 * The lock name for the group with this id: the name of the JSON file its routes read and write.
 * @param {string} groupId
 * @returns {string}
 */
export function groupLockName(groupId) {
    return sanitize(`${groupId}.json`);
}

/**
 * @param {string} key
 * @returns {Promise<() => void>} Resolves once held; call the result exactly once to release.
 */
async function acquire(key) {
    const previous = tails.get(key) ?? Promise.resolve();
    /** @type {() => void} */
    let release = () => {};
    const held = new Promise(resolve => { release = () => resolve(undefined); });
    const tail = previous.then(() => held);
    tails.set(key, tail);
    await previous;
    return () => {
        release();
        if (tails.get(key) === tail) tails.delete(key);
    };
}

/**
 * Runs `fn` while holding the locks for every named group file of one user. Names are taken in sorted order, so two
 * holders of overlapping sets can't deadlock. Not reentrant: `fn` must not take a lock it already holds.
 * @template T
 * @param {{ root: string }} directories The user's directories; locks are per user.
 * @param {string[]} fileNames Group JSON file names within that user's groups directory
 * @param {() => Promise<T> | T} fn
 * @returns {Promise<T>}
 */
export async function withGroupFilesLock(directories, fileNames, fn) {
    const keys = [...new Set(fileNames)].sort().map(name => `${directories.root}\0${name}`);
    /** @type {(() => void)[]} */
    const releases = [];
    try {
        for (const key of keys) {
            releases.push(await acquire(key));
        }
        return await fn();
    } finally {
        for (const release of releases.reverse()) release();
    }
}

/**
 * Runs `fn` while holding the lock of the group with this id.
 * @template T
 * @param {{ root: string }} directories
 * @param {string} groupId
 * @param {() => Promise<T> | T} fn
 * @returns {Promise<T>}
 */
export function withGroupLock(directories, groupId, fn) {
    return withGroupFilesLock(directories, [groupLockName(groupId)], fn);
}
