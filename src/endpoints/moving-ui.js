import path from 'node:path';
import express from 'express';
import sanitize from 'sanitize-filename';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { readSettingsAtPaths } from '../settings-store.js';

export const router = express.Router();

router.post('/save', (request, response) => {
    if (!request.body || !request.body.name) {
        return response.sendStatus(400);
    }

    const filename = path.join(request.user.directories.movingUI, sanitize(`${request.body.name}.json`));
    writeFileAtomicSync(filename, JSON.stringify(request.body, null, 4), 'utf8');

    return response.sendStatus(200);
});

// Composes the preset from the server's own stored power_user.movingUIState, instead of trusting
// a client-reassembled snapshot of a setting it already has.
router.post('/save-from-settings', (request, response) => {
    const { name } = request.body ?? {};
    if (!name) {
        return response.sendStatus(400);
    }

    const { 'power_user.movingUIState': movingUIState } = readSettingsAtPaths(request.user.directories, ['power_user.movingUIState']);
    const preset = { name, movingUIState };

    const filename = path.join(request.user.directories.movingUI, sanitize(`${name}.json`));
    writeFileAtomicSync(filename, JSON.stringify(preset, null, 4), 'utf8');

    return response.send({ preset });
});
