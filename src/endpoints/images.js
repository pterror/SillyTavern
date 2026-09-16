import fs from 'node:fs';
import path from 'node:path';
import { Buffer } from 'node:buffer';

import express from 'express';
import sanitize from 'sanitize-filename';

import { clientRelativePath, removeFileExtension, getImages, isPathUnderParent } from '../util.js';
import { MEDIA_EXTENSIONS, MEDIA_REQUEST_TYPE } from '../constants.js';

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

        // Constructing filename and path
        let filename;
        if (request.body.filename) {
            filename = `${removeFileExtension(request.body.filename)}.${format}`;
        } else {
            filename = `${Date.now()}.${format}`;
        }

        // if character is defined, save to a sub folder for that character
        let pathToNewFile = path.join(request.user.directories.userImages, sanitize(filename));
        if (request.body.ch_name) {
            pathToNewFile = path.join(request.user.directories.userImages, sanitize(request.body.ch_name), sanitize(filename));
        }

        ensureDirectoryExistence(pathToNewFile);
        const imageBuffer = Buffer.from(image, 'base64');
        await fs.promises.writeFile(pathToNewFile, new Uint8Array(imageBuffer));
        response.send({ path: clientRelativePath(request.user.directories.root, pathToNewFile) });
    } catch (error) {
        console.error(error);
        response.status(500).send({ error: 'Failed to save the image' });
    }
});

router.post('/list/:folder?', (request, response) => {
    try {
        if (request.params.folder) {
            if (request.body.folder) {
                return response.status(400).send({ error: 'Folder specified in both URL and body' });
            }

            console.warn('Deprecated: Use POST /api/images/list with folder in request body');
            request.body.folder = request.params.folder;
        }

        if (!request.body.folder) {
            return response.status(400).send({ error: 'No folder specified' });
        }

        const directoryPath = path.join(request.user.directories.userImages, sanitize(request.body.folder));
        const type = Number(request.body.type ?? MEDIA_REQUEST_TYPE.IMAGE);
        const sort = request.body.sortField || 'date';
        const order = request.body.sortOrder || 'asc';

        if (!fs.existsSync(directoryPath)) {
            fs.mkdirSync(directoryPath, { recursive: true });
        }

        const images = getImages(directoryPath, sort, type);
        if (order === 'desc') {
            images.reverse();
        }
        return response.send(images);
    } catch (error) {
        console.error(error);
        return response.status(500).send({ error: 'Unable to retrieve files' });
    }
});

router.post('/folders', (request, response) => {
    try {
        const directoryPath = request.user.directories.userImages;
        if (!fs.existsSync(directoryPath)) {
            fs.mkdirSync(directoryPath, { recursive: true });
        }

        const folders = fs.readdirSync(directoryPath, { withFileTypes: true })
            .filter(dirent => dirent.isDirectory())
            .map(dirent => dirent.name);

        return response.send(folders);
    } catch (error) {
        console.error(error);
        return response.status(500).send({ error: 'Unable to retrieve folders' });
    }
});

/**
 * Deletes a single image at a client-relative path, validating it stays under userImages.
 * @param {import('express').Request} request The HTTP request object (used for `request.user.directories`).
 * @param {string} relativePath Client-relative path of the image to delete.
 * @returns {{ok: true}|{ok: false, status: number}}
 */
function deleteOneImage(request, relativePath) {
    const pathToDelete = path.join(request.user.directories.root, relativePath);
    if (!isPathUnderParent(request.user.directories.userImages, pathToDelete)) {
        return { ok: false, status: 400 };
    }

    if (!fs.existsSync(pathToDelete)) {
        return { ok: false, status: 404 };
    }

    fs.unlinkSync(pathToDelete);
    console.info(`Deleted image: ${relativePath} from ${request.user.profile.handle}`);
    return { ok: true };
}

router.post('/delete', async (request, response) => {
    try {
        // ── Bulk mode: paths array is present ─────────────────────
        if (Array.isArray(request.body.paths)) {
            const results = request.body.paths.map(p => {
                if (typeof p !== 'string' || !p) {
                    return { path: p, ok: false };
                }
                return { path: p, ok: deleteOneImage(request, p).ok };
            });
            return response.send({ results });
        }

        if (!request.body.path) {
            return response.status(400).send('No path specified');
        }

        const result = deleteOneImage(request, request.body.path);
        if (!result.ok) {
            return response.status(result.status).send(result.status === 404 ? 'File not found' : 'Invalid path');
        }

        return response.sendStatus(200);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});
