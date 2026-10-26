import express from 'express';

import { readUserSettings } from '../settings-reads.js';
import { deleteBundle, writeBundle } from '../bundle-store.js';
import { THEME_FIELDS } from '../../public/scripts/theme-fields.js';

export const router = express.Router();

router.post('/save', async (request, response) => {
    if (!request.body || !request.body.name) {
        return response.sendStatus(400);
    }

    return response.sendStatus(await writeBundle(request.user.directories, 'theme', request.body.name, request.body) ? 200 : 400);
});

// Composes a theme from the server's own stored power_user settings, instead of trusting a
// client-reassembled snapshot of settings it already has.
router.post('/save-from-settings', async (request, response) => {
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

    if (!await writeBundle(request.user.directories, 'theme', name, theme)) {
        return response.sendStatus(400);
    }
    return response.send({ theme });
});

router.post('/delete', async (request, response) => {
    if (!request.body || !request.body.name) {
        return response.sendStatus(400);
    }

    try {
        if (!await deleteBundle(request.user.directories, 'theme', request.body.name)) {
            console.error('Theme file not found:', request.body.name);
            return response.sendStatus(404);
        }
        return response.sendStatus(200);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});
