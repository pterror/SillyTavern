import fs from 'node:fs';
import path from 'node:path';
import { isPathUnderParent } from './util.js';

/** Serialize a raw relative filename as a URL, encoding literal percent signs too.
 * @param {string} relative
 */
export function userImageUrl(relative) {
    return relative.split('/').map(encodeURIComponent).join('/');
}

/** Resolve new encoded URLs and legacy raw paths without changing library keys.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} relative
 * @returns {string|null} The raw absolute filename, or null for an invalid path.
 */
export function userImageFile(directories, relative) {
    let decoded;
    try { decoded = decodeURIComponent(relative); } catch { decoded = relative; }
    const target = path.join(directories.root, decoded);
    const legacy = path.join(directories.root, relative);
    // Check both before probing the filesystem, including decoded traversal.
    if (!isPathUnderParent(directories.userImages, target) || !isPathUnderParent(directories.userImages, legacy)) return null;
    return fs.existsSync(target) || !fs.existsSync(legacy) ? target : legacy;
}
