import path from 'node:path';
import fs from 'node:fs';

import express from 'express';
import sanitize from 'sanitize-filename';
import { Jimp } from '../jimp.js';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { tryParse } from '../util.js';
import { getFileNameValidationFunction } from '../middleware/validateFileName.js';
import { applyAvatarCropResize } from './characters.js';
import { requestStore } from '../user-stores.js';
import { avatarPathOf } from '../character-avatars.js';
import { TYPE } from '../library-codes.js';
import { imagesOf, removeImage, writePersonaImage } from '../image-entities.js';
import { stillUrl, thumbnailOf } from '../thumbnail-urls.js';
import { avatarRefString } from '../avatar-refs.js';
import cacheBuster from '../middleware/cacheBuster.js';

export const router = express.Router();

router.post('/get', async function (request, response) {
    const { lib } = await requestStore(request);
    const images = (await imagesOf(lib, TYPE.personaImage)).sort((a, b) => Intl.Collator().compare(a.key, b.key));
    /** @type {Record<string, string>} */
    const thumbnails = {};
    for (const image of images) {
        const thumbnail = thumbnailOf(image, 'avatar');
        if (thumbnail !== null) thumbnails[image.key] = thumbnail;
    }
    const refs = Object.fromEntries(images.map(i => [i.key, avatarRefString(TYPE.personaImage, i.key)]));
    response.send({ avatars: images.map(i => i.key), thumbnails, refs });
});

router.post('/delete', getFileNameValidationFunction('avatar'), async function (request, response) {
    if (!request.body) return response.sendStatus(400);

    if (request.body.avatar !== sanitize(request.body.avatar)) {
        console.error('Malicious avatar name prevented');
        return response.sendStatus(403);
    }

    const file = sanitize(request.body.avatar);
    const fileName = path.join(request.user.directories.avatars, file);
    const { lib } = await requestStore(request);
    const removed = await removeImage(lib, TYPE.personaImage, file);
    if (fs.existsSync(fileName)) {
        fs.unlinkSync(fileName);
        return response.send({ result: 'ok' });
    }
    return removed ? response.send({ result: 'ok' }) : response.sendStatus(404);
});

/**
 * @param {import('express').Request} request
 * @param {string} filename
 * @param {Buffer} image
 */
async function savePersonaImage(request, filename, image) {
    writeFileAtomicSync(path.join(request.user.directories.avatars, filename), image);
    const facts = await writePersonaImage((await requestStore(request)).lib, filename, image);
    return stillUrl(facts.still, 'avatar');
}

router.post('/from-character', getFileNameValidationFunction('overwrite_name'), async (request, response) => {
    const { avatar, overwrite_name: overwriteName } = request.body ?? {};
    if (typeof avatar !== 'string' || !avatar || avatar !== sanitize(avatar) || typeof overwriteName !== 'string' || !overwriteName) {
        return response.sendStatus(400);
    }
    const cardPath = await avatarPathOf((await requestStore(request)).lib, request.user.directories, avatar);
    if (cardPath === null) return response.sendStatus(404);

    try {
        const image = await applyAvatarCropResize(await Jimp.read(cardPath), undefined);
        const filename = sanitize(overwriteName);
        cacheBuster.bust(request, response);
        const thumbnail = await savePersonaImage(request, filename, image);
        return response.send({ path: filename, thumbnail, ref: avatarRefString(TYPE.personaImage, filename) });
    } catch (err) {
        console.error('Error making a persona image from a character:', err);
        return response.status(400).send('Is not a valid image');
    }
});

router.post('/upload', getFileNameValidationFunction('overwrite_name'), async (request, response) => {
    if (!request.file) return response.sendStatus(400);

    try {
        const pathToUpload = path.join(request.file.destination, request.file.filename);
        const crop = tryParse(request.query.crop);
        const rawImg = await Jimp.read(pathToUpload);
        const image = await applyAvatarCropResize(rawImg, crop);

        if (request.body.overwrite_name) cacheBuster.bust(request, response);

        const filename = sanitize(request.body.overwrite_name || `${Date.now()}.png`);
        const thumbnail = await savePersonaImage(request, filename, image);
        fs.unlinkSync(pathToUpload);
        return response.send({ path: filename, thumbnail, ref: avatarRefString(TYPE.personaImage, filename) });
    } catch (err) {
        console.error('Error uploading user avatar:', err);
        return response.status(400).send('Is not a valid image');
    }
});
