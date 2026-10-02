import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import express from 'express';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

/**
 * The editor's find-and-replace presets and preset lists, per user, in one file. Each route is one action; the file
 * is read, changed and written in one synchronous step, so actions from two tabs don't lose each other's changes.
 */
export const router = express.Router();

const FILE_NAME = 'editor-presets.json';

/**
 * @typedef {{ id: string, name: string, find: string, flags: string, replace: string }} EditorPreset
 * @typedef {{ id: string, name: string, presetIds: string[] }} EditorPresetList
 * @typedef {{ presets: EditorPreset[], lists: EditorPresetList[] }} EditorPresetStore
 */

/** @param {import('express').Request} request */
function storePath(request) {
    return path.join(request.user.directories.root, FILE_NAME);
}

/**
 * @param {string} file
 * @returns {EditorPresetStore}
 */
function readStore(file) {
    if (!fs.existsSync(file)) return { presets: [], lists: [] };
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { presets: Array.isArray(parsed?.presets) ? parsed.presets : [], lists: Array.isArray(parsed?.lists) ? parsed.lists : [] };
}

/** @param {EditorPresetStore} store */
function hashStore(store) {
    return crypto.createHash('sha256').update(JSON.stringify(store)).digest('hex').slice(0, 32);
}

/**
 * Runs a change on the store and answers with the stored result and its hash. Writes only when something changed.
 * @param {import('express').Request} request
 * @param {import('express').Response} response
 * @param {(store: EditorPresetStore) => { changed: boolean, result?: object } | { error: string }} change
 */
function update(request, response, change) {
    const file = storePath(request);
    let store;
    try {
        store = readStore(file);
    } catch {
        return response.status(500).send({ error: 'The editor presets file is not valid JSON.' });
    }
    const outcome = change(store);
    if ('error' in outcome) return response.status(400).send({ error: outcome.error });
    if (outcome.changed) writeFileAtomicSync(file, JSON.stringify(store, null, 4), 'utf8');
    return response.send({ ...outcome.result, hash: hashStore(store) });
}

/** @param {unknown} value */
const isText = value => typeof value === 'string';

/** @param {unknown} flags */
function validFlags(flags) {
    if (!isText(flags) || !/^[dgimsuyv]*$/.test(/** @type {string} */ (flags))) return false;
    return new Set(/** @type {string} */ (flags)).size === /** @type {string} */ (flags).length;
}

router.post('/get', (request, response) => {
    let store;
    try {
        store = readStore(storePath(request));
    } catch {
        return response.status(500).send({ error: 'The editor presets file is not valid JSON.' });
    }
    const hash = hashStore(store);
    if (request.body?.hash === hash) return response.send({ unchanged: true, hash });
    return response.send({ ...store, hash });
});

router.post('/save-preset', (request, response) => {
    const { id, name, find, flags = '', replace = '' } = request.body ?? {};
    if (!isText(name) || !name.trim() || !isText(find) || !find || !validFlags(flags) || !isText(replace)) {
        return response.status(400).send({ error: 'A preset needs a name, a find pattern, valid flags and a replacement.' });
    }
    try {
        new RegExp(find, flags);
    } catch (error) {
        return response.status(400).send({ error: `The find pattern isn't a valid regular expression: ${error.message}` });
    }
    return update(request, response, (store) => {
        if (id !== undefined) {
            const existing = store.presets.find(p => p.id === id);
            if (!existing) return { error: 'No preset has that id.' };
            const next = { id, name: name.trim(), find, flags, replace };
            const changed = JSON.stringify(existing) !== JSON.stringify(next);
            Object.assign(existing, next);
            return { changed, result: { preset: existing } };
        }
        const preset = { id: crypto.randomUUID(), name: name.trim(), find, flags, replace };
        store.presets.push(preset);
        return { changed: true, result: { preset } };
    });
});

router.post('/delete-preset', (request, response) => {
    const { id } = request.body ?? {};
    if (!isText(id)) return response.status(400).send({ error: 'An id is needed.' });
    return update(request, response, (store) => {
        const before = store.presets.length;
        store.presets = store.presets.filter(p => p.id !== id);
        let changed = store.presets.length !== before;
        for (const list of store.lists) {
            const kept = list.presetIds.filter(presetId => presetId !== id);
            if (kept.length !== list.presetIds.length) {
                list.presetIds = kept;
                changed = true;
            }
        }
        return { changed, result: { deleted: store.presets.length !== before } };
    });
});

router.post('/save-list', (request, response) => {
    const { id, name, presetIds } = request.body ?? {};
    if (!isText(name) || !name.trim() || !Array.isArray(presetIds) || !presetIds.every(isText)) {
        return response.status(400).send({ error: 'A list needs a name and the ids of its presets, in order.' });
    }
    return update(request, response, (store) => {
        if (id !== undefined) {
            const existing = store.lists.find(l => l.id === id);
            if (!existing) return { error: 'No list has that id.' };
            const next = { id, name: name.trim(), presetIds };
            const changed = JSON.stringify(existing) !== JSON.stringify(next);
            Object.assign(existing, next);
            return { changed, result: { list: existing } };
        }
        const list = { id: crypto.randomUUID(), name: name.trim(), presetIds };
        store.lists.push(list);
        return { changed: true, result: { list } };
    });
});

router.post('/delete-list', (request, response) => {
    const { id } = request.body ?? {};
    if (!isText(id)) return response.status(400).send({ error: 'An id is needed.' });
    return update(request, response, (store) => {
        const before = store.lists.length;
        store.lists = store.lists.filter(l => l.id !== id);
        return { changed: store.lists.length !== before, result: { deleted: store.lists.length !== before } };
    });
});
