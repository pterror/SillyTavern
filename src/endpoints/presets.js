import fs from 'node:fs';

import express from 'express';
import _ from 'lodash';
import sanitize from 'sanitize-filename';

import { getDefaultPresetFile, getDefaultPresets } from './content-manager.js';
import { bundleFilePath, bundleFolder, deleteBundleFile, groupOfApi, renameBundleFile, writeBundleFile } from '../bundle-files.js';

export const router = express.Router();

router.post('/save', function (request, response) {
    const group = groupOfApi(request.body.apiId);
    if (!request.body.preset || !group) {
        return response.sendStatus(400);
    }
    const name = writeBundleFile(request.user.directories, group, request.body.name, request.body.preset);
    return name ? response.send({ name }) : response.sendStatus(400);
});

router.post('/delete', function (request, response) {
    const group = groupOfApi(request.body.apiId);
    if (!group || !bundleFilePath(request.user.directories, group, request.body.name)) {
        return response.sendStatus(400);
    }
    return response.sendStatus(deleteBundleFile(request.user.directories, group, request.body.name) ? 200 : 404);
});

router.post('/rename', function (request, response) {
    const group = groupOfApi(request.body.apiId);
    if (!group) {
        return response.sendStatus(400);
    }
    switch (renameBundleFile(request.user.directories, group, request.body.name, request.body.newName)) {
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

/**
 * Merges a value into a preset's `extensions` object at the given lodash path, without touching the rest
 * of the preset. Mirrors the settings-store /save-partial pattern.
 */
router.post('/save-partial', function (request, response) {
    const group = groupOfApi(request.body.apiId);
    const fullpath = group ? bundleFilePath(request.user.directories, group, request.body.name) : undefined;
    if (!fullpath) {
        return response.sendStatus(400);
    }
    if (!fs.existsSync(fullpath)) {
        return response.sendStatus(404);
    }

    let preset;
    try {
        preset = JSON.parse(fs.readFileSync(fullpath, 'utf-8'));
    } catch (err) {
        console.error('Could not read preset for partial update', err);
        return response.status(500).send({ error: 'Preset file is not valid JSON' });
    }

    const fieldPath = request.body.path;
    const value = request.body.value;

    if (!_.isPlainObject(preset.extensions)) {
        preset.extensions = {};
    }

    if (fieldPath) {
        _.set(preset.extensions, fieldPath, value);
    } else {
        preset.extensions = value;
    }

    writeBundleFile(request.user.directories, group, request.body.name, preset);
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
