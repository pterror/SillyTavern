import fs from 'node:fs';
import path from 'node:path';

import { TAGS_FILE } from '../constants.js';

/**
 * Reads a user's tags.json (if present) and returns its `tags`/`tag_map` content.
 *
 * Factored out of tags.js so it can be shared with the character/group search-index modules without those
 * modules importing tags.js (and tags.js importing them back to invalidate the indexes on save) - that shape
 * of two-way import between tags.js and the search-index modules is exactly the kind of circular import this
 * codebase has been bitten by before (see the tags.js TDZ fix earlier this session), so this tiny read-only
 * helper lives in its own leaf module that both sides can depend on one-way.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @returns {{ tags: object[], tag_map: Object.<string, string[]> }} Parsed tags/tag_map, empty if the file
 * doesn't exist or fails to parse.
 */
export function readTagsData(directories) {
    const pathToTags = path.join(directories.root, TAGS_FILE);

    if (!fs.existsSync(pathToTags)) {
        return { tags: [], tag_map: {} };
    }

    try {
        const parsed = JSON.parse(fs.readFileSync(pathToTags, 'utf8'));
        return { tags: parsed.tags ?? [], tag_map: parsed.tag_map ?? {} };
    } catch (err) {
        console.error('Could not read tags file', err);
        return { tags: [], tag_map: {} };
    }
}
