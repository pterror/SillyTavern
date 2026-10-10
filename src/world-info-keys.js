import path from 'node:path';

import sanitize from 'sanitize-filename';

/**
 * The key a world book is found by: the stem of the file a name would have (`<name>.json`, sanitized), so every
 * route's `name` finds the book it found when books were files.
 * @param {string} name
 * @returns {string}
 */
export function bookKey(name) {
    return path.parse(sanitize(`${name}.json`)).name;
}
