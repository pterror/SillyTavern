import fs from 'node:fs';
import path from 'node:path';

import { TAGS_FILE } from '../constants.js';

/**
 * Factored out of tags.js into its own leaf module to avoid a circular import with the search-index modules.
 * @returns {{ tags: object[], tag_map: Object.<string, string[]> }} Empty if the file doesn't exist or fails to parse.
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
