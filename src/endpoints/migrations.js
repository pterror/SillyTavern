import express from 'express';
import { getNoticesForClient, markNoticeSeen, NOTICE_IDS } from '../migrations/migration-notices.js';

export const router = express.Router();

/** Lists every boot-migration notice stored for this user, each listed character with its name. */
router.post('/notices', async (request, response) => {
    try {
        return response.send({ notices: await getNoticesForClient(request.user.directories) });
    } catch (error) {
        console.error('Could not read migration notices:', error);
        return response.sendStatus(500);
    }
});

/** Deletes a notice the user has seen, only if it is still the version they saw. */
router.post('/notices/seen', async (request, response) => {
    const id = request.body?.id;
    const version = request.body?.version;
    if (typeof id !== 'string' || !NOTICE_IDS.includes(id) || typeof version !== 'number' || !Number.isFinite(version)) {
        return response.sendStatus(400);
    }
    try {
        return response.send({ cleared: await markNoticeSeen(request.user.directories, id, version) });
    } catch (error) {
        console.error('Could not mark a migration notice as seen:', error);
        return response.sendStatus(500);
    }
});
