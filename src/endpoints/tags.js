import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { TAGS_FILE } from '../constants.js';

export const router = express.Router();

/**
 * Writes `{ tags, tag_map }` to the user's tags.json. This is currently an *additive mirror* of the copy that
 * still lives in settings.json (see the comment on TAGS_FILE in constants.js) - nothing reads this file back
 * yet, it exists so the tagsStore/tagMapStore onChange-triggered debounced save has somewhere real to land
 * ahead of the load-side repoint and settings.json field removal, which are separate follow-up chunks.
 */
router.post('/save', function (request, response) {
    try {
        if (!Object.prototype.hasOwnProperty.call(request.body, 'tags') || !Object.prototype.hasOwnProperty.call(request.body, 'tag_map')) {
            return response.status(400).send({ error: 'Both tags and tag_map are required' });
        }

        const pathToTags = path.join(request.user.directories.root, TAGS_FILE);
        const payload = {
            tags: request.body.tags,
            tag_map: request.body.tag_map,
        };
        writeFileAtomicSync(pathToTags, JSON.stringify(payload, null, 4), 'utf8');
        response.send({ result: 'ok' });
    } catch (err) {
        console.error('Could not save tags file', err);
        response.status(500).send({ error: 'Could not save tags file' });
    }
});

router.post('/get', (request, response) => {
    try {
        const pathToTags = path.join(request.user.directories.root, TAGS_FILE);

        if (!fs.existsSync(pathToTags)) {
            return response.send({ tags: null, tag_map: null });
        }

        const content = fs.readFileSync(pathToTags, 'utf8');
        const parsed = JSON.parse(content);
        response.send({ tags: parsed.tags ?? null, tag_map: parsed.tag_map ?? null });
    } catch (err) {
        console.error('Could not read tags file', err);
        response.sendStatus(500);
    }
});
