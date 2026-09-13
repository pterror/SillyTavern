import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import _ from 'lodash';
import sanitize from 'sanitize-filename';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { getDefaultPresetFile, getDefaultPresets } from './content-manager.js';

/**
 * Gets the folder and extension for the preset settings based on the API source ID.
 * @param {string} apiId API source ID
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @returns {{folder: string?, extension: string?}} Object containing the folder and extension for the preset settings
 */
function getPresetSettingsByAPI(apiId, directories) {
    switch (apiId) {
        case 'kobold':
        case 'koboldhorde':
            return { folder: directories.koboldAI_Settings, extension: '.json' };
        case 'novel':
            return { folder: directories.novelAI_Settings, extension: '.json' };
        case 'textgenerationwebui':
            return { folder: directories.textGen_Settings, extension: '.json' };
        case 'openai':
            return { folder: directories.openAI_Settings, extension: '.json' };
        case 'instruct':
            return { folder: directories.instruct, extension: '.json' };
        case 'context':
            return { folder: directories.context, extension: '.json' };
        case 'sysprompt':
            return { folder: directories.sysprompt, extension: '.json' };
        case 'reasoning':
            return { folder: directories.reasoning, extension: '.json' };
        default:
            return { folder: null, extension: null };
    }
}

export const router = express.Router();

router.post('/save', function (request, response) {
    const name = sanitize(request.body.name);
    if (!request.body.preset || !name) {
        return response.sendStatus(400);
    }

    const settings = getPresetSettingsByAPI(request.body.apiId, request.user.directories);
    const filename = name + settings.extension;

    if (!settings.folder) {
        return response.sendStatus(400);
    }

    const fullpath = path.join(settings.folder, filename);
    writeFileAtomicSync(fullpath, JSON.stringify(request.body.preset, null, 4), 'utf-8');
    return response.send({ name });
});

router.post('/delete', function (request, response) {
    const name = sanitize(request.body.name);
    if (!name) {
        return response.sendStatus(400);
    }

    const settings = getPresetSettingsByAPI(request.body.apiId, request.user.directories);
    const filename = name + settings.extension;

    if (!settings.folder) {
        return response.sendStatus(400);
    }

    const fullpath = path.join(settings.folder, filename);

    if (fs.existsSync(fullpath)) {
        fs.unlinkSync(fullpath);
        return response.sendStatus(200);
    } else {
        return response.sendStatus(404);
    }
});

router.post('/rename', function (request, response) {
    const oldName = sanitize(request.body.name);
    const newName = sanitize(request.body.newName);
    if (!oldName || !newName) {
        return response.sendStatus(400);
    }

    const settings = getPresetSettingsByAPI(request.body.apiId, request.user.directories);
    if (!settings.folder) {
        return response.sendStatus(400);
    }

    const oldPath = path.join(settings.folder, oldName + settings.extension);
    const newPath = path.join(settings.folder, newName + settings.extension);

    if (!fs.existsSync(oldPath)) {
        return response.sendStatus(404);
    }

    if (fs.existsSync(newPath)) {
        return response.status(400).send({ error: 'A preset with the new name already exists' });
    }

    fs.renameSync(oldPath, newPath);
    return response.send({ name: newName });
});

/**
 * Merges a value into a preset's `extensions` object at the given lodash path, without touching the rest
 * of the preset. Mirrors the settings-store /save-partial pattern.
 */
router.post('/save-partial', function (request, response) {
    const name = sanitize(request.body.name);
    if (!name) {
        return response.sendStatus(400);
    }

    const settings = getPresetSettingsByAPI(request.body.apiId, request.user.directories);
    if (!settings.folder) {
        return response.sendStatus(400);
    }

    const fullpath = path.join(settings.folder, name + settings.extension);
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

    writeFileAtomicSync(fullpath, JSON.stringify(preset, null, 4), 'utf-8');
    return response.send({ ok: true });
});

router.post('/restore', function (request, response) {
    try {
        const settings = getPresetSettingsByAPI(request.body.apiId, request.user.directories);
        const name = sanitize(request.body.name);
        const defaultPresets = getDefaultPresets(request.user.directories);

        const defaultPreset = defaultPresets.find(p => p.name === name && p.folder === settings.folder);

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
