import fs from 'node:fs';
import path from 'node:path';
import { MODEL_SETTING, limitRecord } from '@st/settings/model-limits';

// Each user's chat completion model lists, by source, as the status route last answered them: a model's limits come
// from them (packages/areas/settings/model-limits.ts). Kept in <root>/model-lists/<source>.json, only what the limits
// read, so a restart answers the same limits before the page connects again.

/** @typedef {import('@st/settings/model-limits').ModelRecord} ModelRecord */

/** @type {Map<string, { version: number, lists: Map<string, readonly ModelRecord[]> }>} */
const users = new Map();

/** @param {{ root: string }} directories */
const userOf = directories => {
    let user = users.get(directories.root);
    if (!user) users.set(directories.root, user = { version: 0, lists: new Map() });
    return user;
};

/** @param {{ root: string }} directories @param {string} source */
const fileOf = (directories, source) => path.join(directories.root, 'model-lists', `${source}.json`);

/**
 * A source's model list as it last answered the user (empty when it never did, or isn't a chat completion source).
 * @param {{ root: string }} directories
 * @param {string} source
 * @returns {readonly ModelRecord[]}
 */
export function modelListOf(directories, source) {
    if (!Object.hasOwn(MODEL_SETTING, source)) return [];
    const user = userOf(directories);
    let list = user.lists.get(source);
    if (!list) {
        try {
            const read = JSON.parse(fs.readFileSync(fileOf(directories, source), 'utf8'));
            list = Array.isArray(read) ? read : [];
        } catch (error) {
            if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') console.warn(`[model lists] ${source} unreadable, taken as empty:`, error);
            list = [];
        }
        user.lists.set(source, list);
    }
    return list;
}

/**
 * Which lists the user has had: changes whenever one of them does.
 * @param {{ root: string }} directories
 */
export const modelListsVersion = directories => userOf(directories).version;

/**
 * Keeps what a source answered; written only when what the limits read changed.
 * @param {{ root: string }} directories
 * @param {string} source
 * @param {unknown[]} answered
 * @returns {Promise<boolean>} whether it changed
 */
export async function rememberModelList(directories, source, answered) {
    if (!Object.hasOwn(MODEL_SETTING, source)) return false;
    const list = answered.filter(record => record !== null && typeof record === 'object').map(record => limitRecord(/** @type {ModelRecord} */ (record)));
    const text = JSON.stringify(list);
    if (JSON.stringify(modelListOf(directories, source)) === text) return false;
    const file = fileOf(directories, source);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(`${file}.tmp`, text);
    await fs.promises.rename(`${file}.tmp`, file);
    const user = userOf(directories);
    user.lists.set(source, list);
    user.version++;
    return true;
}
