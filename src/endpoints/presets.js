import express from 'express';
import sanitize from 'sanitize-filename';

import { getDefaultPresetFile, getDefaultPresets } from './content-manager.js';
import { bundleFolder, groupOfApi } from '../bundle-files.js';
import { deleteBundle, readBundle, renameBundle, writeBundle } from '../bundle-store.js';
import { isPlainObject } from '../util.js';
import { setAtPath } from '../../public/scripts/hash-utils.js';

export const router = express.Router();

router.post('/save', async function (request, response) {
    const group = groupOfApi(request.body.apiId);
    if (!request.body.preset || !group) {
        return response.sendStatus(400);
    }
    const name = await writeBundle(request.user.directories, group, request.body.name, request.body.preset);
    return name ? response.send({ name }) : response.sendStatus(400);
});

router.post('/delete', async function (request, response) {
    const group = groupOfApi(request.body.apiId);
    if (!group || !sanitize(String(request.body.name ?? ''))) {
        return response.sendStatus(400);
    }
    return response.sendStatus(await deleteBundle(request.user.directories, group, request.body.name) ? 200 : 404);
});

router.post('/rename', async function (request, response) {
    const group = groupOfApi(request.body.apiId);
    if (!group) {
        return response.sendStatus(400);
    }
    switch (await renameBundle(request.user.directories, group, request.body.name, request.body.newName)) {
        case 'invalid':
            return response.sendStatus(400);
        case 'missing':
            return response.sendStatus(404);
        case 'taken':
            return response.status(400).send({ error: 'A preset with the new name already exists' });
        default:
            return response.send({ name: sanitize(request.body.newName) });
    }
});

router.post('/save-partial', async function (request, response) {
    const group = groupOfApi(request.body.apiId);
    if (!group || !sanitize(String(request.body.name ?? ''))) {
        return response.sendStatus(400);
    }
    const preset = await readBundle(request.user.directories, group, request.body.name);
    if (!preset) {
        return response.sendStatus(404);
    }

    const fieldPath = request.body.path;
    const value = request.body.value;

    if (!isPlainObject(preset.extensions)) {
        preset.extensions = {};
    }

    if (fieldPath) {
        setAtPath(preset.extensions, fieldPath, value);
    } else {
        preset.extensions = value;
    }

    await writeBundle(request.user.directories, group, request.body.name, preset);
    return response.send({ ok: true });
});

router.post('/restore', function (request, response) {
    try {
        const folder = bundleFolder(request.user.directories, groupOfApi(request.body.apiId) ?? '');
        const name = sanitize(request.body.name);
        const defaultPresets = getDefaultPresets(request.user.directories);

        const defaultPreset = defaultPresets.find(p => p.name === name && p.folder === folder);

        const result = { isDefault: false, preset: {} };

        if (defaultPreset) {
            result.isDefault = true;
            result.preset = getDefaultPresetFile(defaultPreset.filename) || {};
        }

        return response.send(result);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});
