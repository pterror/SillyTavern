import path from 'node:path';

import sanitize from 'sanitize-filename';

/**
 * @param {string} name
 * @returns {string}
 */
export function bookKey(name) {
    return path.parse(sanitize(`${name}.json`)).name;
}
