import path from 'node:path';
import fs from 'node:fs';

import express from 'express';
import sanitize from 'sanitize-filename';
import { imageSize } from 'image-size';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { tryParse } from '../util.js';
import { getFileNameValidationFunction } from '../middleware/validateFileName.js';
import { stripCardData } from '../character-card-parser.js';
import { requestStore } from '../user-stores.js';
import { avatarPathOf } from '../character-avatars.js';
import { TYPE } from '../library-codes.js';
import { imagesOf, removeImage, writePersonaImage } from '../image-entities.js';
import { cropOf, normalizeCrop, thumbnailsFor, thumbnailsOf } from '../thumbnail-urls.js';
import { avatarRefString } from '../avatar-refs.js';
import cacheBuster from '../middleware/cacheBuster.js';

export const router = express.Router();

/**
 * @param {import('express').Request} request
 */
export async function personaImagesAnswer(request) {
    const { lib } = await requestStore(request);
    const images = (await imagesOf(lib, TYPE.personaImage)).sort((a, b) => Intl.Collator().compare(a.key, b.key));
    /** @type {Record<string, string>} */
    const thumbnails = {};
    /** @type {Record<string, string>} */
    const stills = {};
    /** @type {Record<string, import('../thumbnail-urls.js').Crop>} */
    const crops = {};
    for (const image of images) {
        const shown = thumbnailsOf(image, 'avatar');
        if (shown.thumbnail !== null) thumbnails[image.key] = shown.thumbnail;
        if (shown.thumbnail_still !== null) stills[image.key] = shown.thumbnail_still;
        const crop = cropOf(image);
        if (crop) crops[image.key] = crop;
    }
    const refs = Object.fromEntries(images.map(i => [i.key, avatarRefString(TYPE.personaImage, i.key)]));
    return { avatars: images.map(i => i.key), thumbnails, thumbnails_still: stills, crops, refs };
}

router.post('/get', async function (request, response) {
    response.send(await personaImagesAnswer(request));
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
 * @param {import('../thumbnail-urls.js').Crop | null} crop
 */
async function savePersonaImage(request, filename, image, crop) {
    const size = imageSize(image);
    if (!size.width || !size.height) throw new Error('Not an image');
    writeFileAtomicSync(path.join(request.user.directories.avatars, filename), image);
    const facts = await writePersonaImage((await requestStore(request)).lib, filename, image, crop);
    return thumbnailsFor(facts, 'avatar', crop);
}

router.post('/from-character', getFileNameValidationFunction('overwrite_name'), async (request, response) => {
    const { avatar, overwrite_name: overwriteName } = request.body ?? {};
    if (typeof avatar !== 'string' || !avatar || avatar !== sanitize(avatar) || typeof overwriteName !== 'string' || !overwriteName) {
        return response.sendStatus(400);
    }
    const { lib } = await requestStore(request);
    const cardPath = await avatarPathOf(lib, request.user.directories, avatar);
    if (cardPath === null) return response.sendStatus(404);

    try {
        const image = stripCardData(await fs.promises.readFile(cardPath));
        const crop = cropOf(await lib.entity(TYPE.character, avatar));
        const filename = sanitize(overwriteName);
        cacheBuster.bust(request, response);
        const shown = await savePersonaImage(request, filename, image, crop);
        return response.send({ path: filename, ...shown, ref: avatarRefString(TYPE.personaImage, filename) });
    } catch (err) {
        console.error('Error making a persona image from a character:', err);
        return response.status(400).send('Is not a valid image');
    }
});

router.post('/upload', getFileNameValidationFunction('overwrite_name'), async (request, response) => {
    if (!request.file) return response.sendStatus(400);

    try {
        const pathToUpload = path.join(request.file.destination, request.file.filename);
        const crop = normalizeCrop(tryParse(request.query.crop));
        const image = await fs.promises.readFile(pathToUpload);

        if (request.body.overwrite_name) cacheBuster.bust(request, response);

        const filename = sanitize(request.body.overwrite_name || `${Date.now()}.png`);
        const shown = await savePersonaImage(request, filename, image, crop);
        fs.unlinkSync(pathToUpload);
        return response.send({ path: filename, ...shown, ref: avatarRefString(TYPE.personaImage, filename) });
    } catch (err) {
        console.error('Error uploading user avatar:', err);
        return response.status(400).send('Is not a valid image');
    }
});
