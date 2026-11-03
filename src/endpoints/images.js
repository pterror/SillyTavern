import fs from 'node:fs';
import path from 'node:path';
import { Buffer } from 'node:buffer';

import express from 'express';
import sanitize from 'sanitize-filename';

import { clientRelativePath, removeFileExtension, isPathUnderParent } from '../util.js';
import { MEDIA_EXTENSIONS } from '../constants.js';
import { requestStore } from '../user-stores.js';
import { TYPE } from '../library-codes.js';
import { removeImage, userImageKey, writeUserImage } from '../image-entities.js';
import { normalizeCrop, thumbnailsFor } from '../thumbnail-urls.js';

const IMAGE_FORMATS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'apng', 'bmp', 'avif']);

/**
 * Ensure the directory for the provided file path exists.
 * If not, it will recursively create the directory.
 *
 * @param {string} filePath - The full path of the file for which the directory should be ensured.
 */
function ensureDirectoryExistence(filePath) {
    const dirname = path.dirname(filePath);
    if (fs.existsSync(dirname)) {
        return true;
    }
    ensureDirectoryExistence(dirname);
    fs.mkdirSync(dirname);
}

/**
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {object} lib
 * @param {{ buffer: Buffer, format: string, subFolder?: string, filename?: string, crop?: object | null }} image
 * @returns {Promise<{ path: string, facts: object | null }>}
 */
export async function saveUserImageFile(directories, lib, { buffer, format, subFolder, filename, crop = null }) {
    const name = filename ? `${removeFileExtension(filename)}.${format}` : `${Date.now()}.${format}`;
    const pathToNewFile = subFolder
        ? path.join(directories.userImages, sanitize(subFolder), sanitize(name))
        : path.join(directories.userImages, sanitize(name));
    ensureDirectoryExistence(pathToNewFile);
    await fs.promises.writeFile(pathToNewFile, new Uint8Array(buffer));
    const relative = clientRelativePath(directories.root, pathToNewFile);
    if (!IMAGE_FORMATS.has(String(format).toLowerCase())) return { path: relative, facts: null };
    return { path: relative, facts: await writeUserImage(lib, relative, buffer, crop) };
}

export const router = express.Router();

/**
 * Endpoint to handle image uploads.
 * The image should be provided in the request body in base64 format.
 * Optionally, a character name can be provided to save the image in a sub-folder.
 *
 * @route POST /api/images/upload
 * @param {Object} request.body - The request payload.
 * @param {string} request.body.image - The base64 encoded image data.
 * @param {string} [request.body.ch_name] - Optional character name to determine the sub-directory.
 * @returns {Object} response - The response object containing the path where the image was saved.
 */
router.post('/upload', async (request, response) => {
    try {
        if (!request.body) {
            return response.status(400).send({ error: 'No data provided' });
        }

        const { image, format } = request.body;

        if (!image) {
            return response.status(400).send({ error: 'No image data provided' });
        }

        const validFormat = MEDIA_EXTENSIONS.includes(format);
        if (!validFormat) {
            return response.status(400).send({ error: 'Invalid image format' });
        }

        const crop = normalizeCrop(request.body.crop);
        const saved = await saveUserImageFile(request.user.directories, (await requestStore(request)).lib, {
            buffer: Buffer.from(image, 'base64'), format, subFolder: request.body.ch_name, filename: request.body.filename, crop,
        });
        if (saved.facts === null) return response.send({ path: saved.path });
        response.send({ path: saved.path, ...thumbnailsFor(saved.facts, 'avatar', crop) });
    } catch (error) {
        console.error(error);
        response.status(500).send({ error: 'Failed to save the image' });
    }
});

/**
 * @param {import('express').Request} request
 * @param {string} relativePath
 * @returns {Promise<{ok: true}|{ok: false, status: number}>}
 */
async function deleteOneImage(request, relativePath) {
    const pathToDelete = path.join(request.user.directories.root, relativePath);
    if (!isPathUnderParent(request.user.directories.userImages, pathToDelete)) {
        return { ok: false, status: 400 };
    }

    await removeImage((await requestStore(request)).lib, TYPE.userImage, userImageKey(relativePath));
    if (!fs.existsSync(pathToDelete)) {
        return { ok: false, status: 404 };
    }

    fs.unlinkSync(pathToDelete);
    console.info(`Deleted image: ${relativePath} from ${request.user.profile.handle}`);
    return { ok: true };
}

router.post('/delete', async (request, response) => {
    try {
        if (Array.isArray(request.body.paths)) {
            const results = await Promise.all(request.body.paths.map(async p => {
                if (typeof p !== 'string' || !p) {
                    return { path: p, ok: false };
                }
                return { path: p, ok: (await deleteOneImage(request, p)).ok };
            }));
            return response.send({ results });
        }

        if (!request.body.path) {
            return response.status(400).send('No path specified');
        }

        const result = await deleteOneImage(request, request.body.path);
        if (!result.ok) {
            return response.status(result.status).send(result.status === 404 ? 'File not found' : 'Invalid path');
        }

        return response.sendStatus(200);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});
