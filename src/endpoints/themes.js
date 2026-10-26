import path from 'node:path';
import fs from 'node:fs';

import express from 'express';
import sanitize from 'sanitize-filename';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { readUserSettings } from '../settings-reads.js';
import { THEME_FIELDS } from '../../public/scripts/theme-fields.js';

export const router = express.Router();

router.post('/save', (request, response) => {
    if (!request.body || !request.body.name) {
        return response.sendStatus(400);
    }

    const filename = path.join(request.user.directories.themes, sanitize(`${request.body.name}.json`));
    writeFileAtomicSync(filename, JSON.stringify(request.body, null, 4), 'utf8');

    return response.sendStatus(200);
});

// Composes a theme from the server's own stored power_user settings, instead of trusting a
// client-reassembled snapshot of settings it already has.
router.post('/save-from-settings', (request, response) => {
    const { name, overrides } = request.body ?? {};
    if (!name) {
        return response.sendStatus(400);
    }

    const dottedPaths = THEME_FIELDS.map(field => `power_user.${field}`);
    const values = readUserSettings(request.user.directories, dottedPaths);

    const theme = { name };
    for (const field of THEME_FIELDS) {
        theme[field] = values[`power_user.${field}`];
    }
    if (overrides && typeof overrides === 'object') {
        Object.assign(theme, overrides);
    }

    const filename = path.join(request.user.directories.themes, sanitize(`${name}.json`));
    writeFileAtomicSync(filename, JSON.stringify(theme, null, 4), 'utf8');

    return response.send({ theme });
});

router.post('/delete', (request, response) => {
    if (!request.body || !request.body.name) {
        return response.sendStatus(400);
    }

    try {
        const filename = path.join(request.user.directories.themes, sanitize(`${request.body.name}.json`));
        if (!fs.existsSync(filename)) {
            console.error('Theme file not found:', filename);
            return response.sendStatus(404);
        }
        fs.unlinkSync(filename);
        return response.sendStatus(200);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});
