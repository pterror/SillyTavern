import sanitize from 'sanitize-filename';

/** @type {Map<string, Promise<void>>} */
const tails = new Map();

/**
 * @param {string} groupId
 * @returns {string}
 */
export function groupLockName(groupId) {
    return sanitize(`${groupId}.json`);
}

/**
 * @param {string} key
 * @returns {Promise<() => void>}
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
 * @template T
 * @param {{ root: string }} directories
 * @param {string[]} fileNames
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
 * @template T
 * @param {{ root: string }} directories
 * @param {string} groupId
 * @param {() => Promise<T> | T} fn
 * @returns {Promise<T>}
 */
export function withGroupLock(directories, groupId, fn) {
    return withGroupFilesLock(directories, [groupLockName(groupId)], fn);
}
