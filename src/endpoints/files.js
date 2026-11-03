import path from 'node:path';
import fs from 'node:fs';

import express from 'express';
import sanitize from 'sanitize-filename';
import { sync as writeFileSyncAtomic } from 'write-file-atomic';

import { clientRelativePath } from '../util.js';
import { UNSAFE_EXTENSIONS } from '../constants.js';

/**
 * Validates the name of a file to store.
 * @param {string} inputFilename Input filename
 * @returns {{error: boolean, message?: string}} Whether validation failed, and why if so
 */
function validateFileName(inputFilename) {
    if (!/^[a-zA-Z0-9_\-.]+$/.test(inputFilename)) {
        return {
            error: true,
            message: 'Illegal character in filename; only alphanumeric, \'_\', \'-\' are accepted.',
        };
    }

    const inputExtension = path.extname(inputFilename).toLowerCase();
    if (UNSAFE_EXTENSIONS.some(ext => ext === inputExtension)) {
        return {
            error: true,
            message: 'Forbidden file extension.',
        };
    }

    if (inputFilename.startsWith('.')) {
        return {
            error: true,
            message: 'Filename cannot start with \'.\'',
        };
    }

    if (sanitize(inputFilename) !== inputFilename) {
        return {
            error: true,
            message: 'Reserved or long filename.',
        };
    }

    return { error: false };
}

export const router = express.Router();

router.post('/sanitize-filename', async (request, response) => {
    try {
        const fileName = String(request.body.fileName);
        if (!fileName) {
            return response.status(400).send('No fileName specified');
        }

        const sanitizedFilename = sanitize(fileName);
        return response.send({ fileName: sanitizedFilename });
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/upload', async (request, response) => {
    try {
        if (!request.body.name) {
            return response.status(400).send('No upload name specified');
        }

        if (!request.body.data) {
            return response.status(400).send('No upload data specified');
        }

        // Validate filename
        const validation = validateFileName(request.body.name);
        if (validation.error)
            return response.status(400).send(validation.message);

        const pathToUpload = path.join(request.user.directories.files, request.body.name);
        writeFileSyncAtomic(pathToUpload, request.body.data, 'base64');
        const url = clientRelativePath(request.user.directories.root, pathToUpload);
        console.info(`Uploaded file: ${url} from ${request.user.profile.handle}`);
        return response.send({ path: url });
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

/**
 * @param {import('express').Request} request
 * @param {string} relativePath
 * @returns {{ok: true}|{ok: false, status: number}}
 */
function deleteOneFile(request, relativePath) {
    const pathToDelete = path.join(request.user.directories.root, relativePath);
    if (!pathToDelete.startsWith(request.user.directories.files)) {
        return { ok: false, status: 400 };
    }

    if (!fs.existsSync(pathToDelete)) {
        return { ok: false, status: 404 };
    }

    fs.unlinkSync(pathToDelete);
    console.info(`Deleted file: ${relativePath} from ${request.user.profile.handle}`);
    return { ok: true };
}

router.post('/delete', async (request, response) => {
    try {
        if (Array.isArray(request.body.paths)) {
            const results = request.body.paths.map(p => {
                if (typeof p !== 'string' || !p) {
                    return { path: p, ok: false };
                }
                return { path: p, ok: deleteOneFile(request, p).ok };
            });
            return response.send({ results });
        }

        if (!request.body.path) {
            return response.status(400).send('No path specified');
        }

        const result = deleteOneFile(request, request.body.path);
        if (!result.ok) {
            return response.status(result.status).send(result.status === 404 ? 'File not found' : 'Invalid path');
        }

        return response.sendStatus(200);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});
