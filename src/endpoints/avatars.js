import path from 'node:path';
import fs from 'node:fs';

import express from 'express';
import sanitize from 'sanitize-filename';
import { Jimp } from '../jimp.js';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { getImages, tryParse } from '../util.js';
import { getFileNameValidationFunction } from '../middleware/validateFileName.js';
import { applyAvatarCropResize } from './characters.js';
import { invalidateThumbnail, getThumbnailVersion } from './thumbnails.js';
import cacheBuster from '../middleware/cacheBuster.js';

export const router = express.Router();

/**
 * HTTP POST endpoint for the "/api/avatars/get" route: list of persona avatar filenames plus, for each one
 * that already has a cached thumbnail, the thumbnail's version (see getThumbnailVersion() in thumbnails.js).
 * The `thumbnailVersions` map lets the client's getThumbnailUrl() emit the thumbnail route's `?v=` up front
 * instead of taking its no-cache redirect detour on every persona avatar render.
 * @param  {import("express").Request} request The HTTP request object.
 * @param  {import("express").Response} response The HTTP response object.
 * @return {void}
 */
router.post('/get', function (request, response) {
    const avatars = getImages(request.user.directories.avatars);

    /** @type {Record<string, string>} */
    const thumbnailVersions = {};
    for (const avatar of avatars) {
        const version = getThumbnailVersion(request.user.directories, 'persona', avatar);
        if (version) thumbnailVersions[avatar] = version;
    }

    response.send({ avatars, thumbnailVersions });
});

router.post('/delete', getFileNameValidationFunction('avatar'), function (request, response) {
    if (!request.body) return response.sendStatus(400);

    if (request.body.avatar !== sanitize(request.body.avatar)) {
        console.error('Malicious avatar name prevented');
        return response.sendStatus(403);
    }

    const fileName = path.join(request.user.directories.avatars, sanitize(request.body.avatar));

    if (fs.existsSync(fileName)) {
        fs.unlinkSync(fileName);
        invalidateThumbnail(request.user.directories, 'persona', sanitize(request.body.avatar));
        return response.send({ result: 'ok' });
    }

    return response.sendStatus(404);
});

router.post('/upload', getFileNameValidationFunction('overwrite_name'), async (request, response) => {
    if (!request.file) return response.sendStatus(400);

    try {
        const pathToUpload = path.join(request.file.destination, request.file.filename);
        const crop = tryParse(request.query.crop);
        const rawImg = await Jimp.read(pathToUpload);
        const image = await applyAvatarCropResize(rawImg, crop);

        // Remove previous thumbnail and bust cache if overwriting
        if (request.body.overwrite_name) {
            invalidateThumbnail(request.user.directories, 'persona', sanitize(request.body.overwrite_name));
            cacheBuster.bust(request, response);
        }

        const filename = sanitize(request.body.overwrite_name || `${Date.now()}.png`);
        const pathToNewFile = path.join(request.user.directories.avatars, filename);
        writeFileAtomicSync(pathToNewFile, image);
        fs.unlinkSync(pathToUpload);
        return response.send({ path: filename });
    } catch (err) {
        console.error('Error uploading user avatar:', err);
        return response.status(400).send('Is not a valid image');
    }
});
