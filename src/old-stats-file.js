import fs from 'node:fs';
import path from 'node:path';

import { getAllUserHandles, getUserDirectories } from './users.js';

const STATS_FILE = 'stats.json';
export const STATS_BACKUP_FILE = 'stats.pre-derived.json';

/**
 * Keeps a user's old stats file as `stats.pre-derived.json`, once: an existing backup is never written again.
 * @param {string} root The user's data root.
 */
export function keepOldStatsFile(root) {
    const from = path.join(root, STATS_FILE);
    const to = path.join(root, STATS_BACKUP_FILE);
    if (!fs.existsSync(from) || fs.existsSync(to)) return;
    try {
        fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
    } catch (error) {
        if (error?.code !== 'EEXIST') console.error(`Could not keep the old stats file of ${root} as ${STATS_BACKUP_FILE}:`, error);
    }
}

/**
 * Keeps every user's old stats file (see keepOldStatsFile()).
 */
export async function keepOldStatsFiles() {
    try {
        for (const handle of await getAllUserHandles()) {
            keepOldStatsFile(getUserDirectories(handle).root);
        }
    } catch (error) {
        console.error('Could not keep the old stats files:', error);
    }
}
