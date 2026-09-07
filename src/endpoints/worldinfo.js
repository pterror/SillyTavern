import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import sanitize from 'sanitize-filename';
import _ from 'lodash';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import { tryParse } from '../util.js';

/**
 * Marker written into the top-level `format` field of a World Info file once its entries have been
 * split out into a sidecar directory (see getWorldInfoPaths/writeWorldInfoFile). Its absence means the
 * file is in the original, pre-existing format: the entries live inline as `entries: { [uid]: entry }`.
 */
const WORLD_INFO_SIDECAR_FORMAT = 'sidecar-v1';

/**
 * Resolves the on-disk paths for a World Info file: the small top-level file (always present; either the
 * full legacy document or - once migrated - a manifest pointing at the sidecar directory) and the sidecar
 * directory that holds one file per entry for books that have been migrated.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {string} worldInfoName Name of the World Info file
 * @returns {{ filename: string, pathToWorldInfo: string, entriesDir: string }} Resolved paths
 */
function getWorldInfoPaths(directories, worldInfoName) {
    const filename = sanitize(`${worldInfoName}.json`);
    const pathToWorldInfo = path.join(directories.worlds, filename);
    const entriesDir = path.join(directories.worlds, `${path.parse(filename).name}.entries`);
    return { filename, pathToWorldInfo, entriesDir };
}

/**
 * Turns an entry uid into a safe filename component. Real uids are always small non-negative integers
 * assigned by the client, but this guards against a crafted uid (e.g. containing path separators) being
 * used to escape the sidecar directory.
 * @param {string} uid Entry uid (object key from `entries`)
 * @returns {string | null} Safe filename (without extension), or null if the uid sanitizes to nothing
 */
function sanitizeEntryUid(uid) {
    const safe = sanitize(String(uid));
    return safe ? safe : null;
}

/**
 * Reads a sidecar-format manifest (top-level file) plus its per-entry files and reassembles the same
 * shape callers of readWorldInfoFile() have always gotten: the original top-level fields, with `entries`
 * inlined as `{ [uid]: entry }`. An entry whose file is missing or unreadable is skipped (with a warning)
 * rather than failing the whole read.
 * @param {object} manifest Parsed manifest file contents
 * @param {string} entriesDir Sidecar directory holding one file per entry
 * @returns {object} World Info file contents, in the original inline-entries shape
 */
function inflateSidecarWorldInfo(manifest, entriesDir) {
    const { format, entries: uids, ...rest } = manifest;
    const entries = {};

    for (const uid of Array.isArray(uids) ? uids : []) {
        const safeUid = sanitizeEntryUid(uid);
        if (!safeUid) {
            continue;
        }
        try {
            const entryPath = path.join(entriesDir, `${safeUid}.json`);
            entries[uid] = JSON.parse(fs.readFileSync(entryPath, 'utf8'));
        } catch (err) {
            console.warn(`World info entry ${uid} could not be read from ${entriesDir}:`, err);
        }
    }

    return { ...rest, entries };
}

/**
 * Reads a World Info file and returns its contents
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {string} worldInfoName Name of the World Info file
 * @param {boolean} allowDummy If true, returns an empty object if the file doesn't exist
 * @returns {object} World Info file contents
 */
export function readWorldInfoFile(directories, worldInfoName, allowDummy) {
    const dummyObject = allowDummy ? { entries: {} } : null;

    if (!worldInfoName) {
        return dummyObject;
    }

    const { filename, pathToWorldInfo, entriesDir } = getWorldInfoPaths(directories, worldInfoName);

    if (!fs.existsSync(pathToWorldInfo)) {
        console.error(`World info file ${filename} doesn't exist.`);
        return dummyObject;
    }

    const worldInfoText = fs.readFileSync(pathToWorldInfo, 'utf8');
    const worldInfo = JSON.parse(worldInfoText);

    if (worldInfo && worldInfo.format === WORLD_INFO_SIDECAR_FORMAT && Array.isArray(worldInfo.entries)) {
        return inflateSidecarWorldInfo(worldInfo, entriesDir);
    }

    return worldInfo;
}

/**
 * Writes a World Info file without rewriting entries that haven't changed. The top-level file becomes a
 * small manifest (original fields + the list of entry uids); each entry is its own file in a sidecar
 * directory, and only entries that are new or actually differ from what's on disk get written. This is a
 * one-way migration: a book saved through here stays in the sidecar format from then on, but a book that
 * has never been through here (e.g. straight off `/import`) is left as a plain legacy file until its next
 * edit - readWorldInfoFile() understands both.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {string} worldInfoName Name of the World Info file
 * @param {object} data World Info file contents (`entries` inline, as sent by the client)
 */
function writeWorldInfoFile(directories, worldInfoName, data) {
    const { pathToWorldInfo, entriesDir } = getWorldInfoPaths(directories, worldInfoName);
    const { entries: incomingEntries, ...rest } = data;
    const entries = _.isObjectLike(incomingEntries) ? incomingEntries : {};
    const incomingUids = Object.keys(entries);

    fs.mkdirSync(entriesDir, { recursive: true });

    const existingUids = fs.readdirSync(entriesDir)
        .filter(f => f.endsWith('.json'))
        .map(f => path.parse(f).name);
    const existingUidSet = new Set(existingUids);

    const keptUids = [];

    for (const uid of incomingUids) {
        const safeUid = sanitizeEntryUid(uid);
        if (!safeUid) {
            console.warn(`Skipping world info entry with unusable uid: ${uid}`);
            continue;
        }

        keptUids.push(uid);
        const entryPath = path.join(entriesDir, `${safeUid}.json`);
        const nextEntry = entries[uid];

        let shouldWrite = true;
        if (existingUidSet.has(safeUid)) {
            try {
                const currentEntry = JSON.parse(fs.readFileSync(entryPath, 'utf8'));
                shouldWrite = !_.isEqual(currentEntry, nextEntry);
            } catch {
                shouldWrite = true;
            }
        }

        if (shouldWrite) {
            writeFileAtomicSync(entryPath, JSON.stringify(nextEntry, null, 4));
        }
    }

    // Commit the new entry list before removing anything that's no longer referenced, so a manifest never
    // points at an entry file that's already been deleted.
    const manifest = { ...rest, format: WORLD_INFO_SIDECAR_FORMAT, entries: keptUids };
    writeFileAtomicSync(pathToWorldInfo, JSON.stringify(manifest, null, 4));

    const keptSafeUids = new Set(keptUids.map(sanitizeEntryUid));
    for (const safeUid of existingUids) {
        if (!keptSafeUids.has(safeUid)) {
            fs.unlinkSync(path.join(entriesDir, `${safeUid}.json`));
        }
    }
}

export const router = express.Router();

router.post('/list', async (request, response) => {
    try {
        const data = [];
        const jsonFiles = (await fs.promises.readdir(request.user.directories.worlds, { withFileTypes: true }))
            .filter((file) => file.isFile() && path.extname(file.name).toLowerCase() === '.json')
            .sort((a, b) => a.name.localeCompare(b.name));

        for (const file of jsonFiles) {
            try {
                const filePath = path.join(request.user.directories.worlds, file.name);
                const fileContents = await fs.promises.readFile(filePath, 'utf8');
                const fileContentsParsed = tryParse(fileContents) || {};
                const fileExtensions = fileContentsParsed?.extensions || {};
                const fileNameWithoutExt = path.parse(file.name).name;
                const fileData = {
                    file_id: fileNameWithoutExt,
                    name: fileContentsParsed?.name || fileNameWithoutExt,
                    extensions: _.isObjectLike(fileExtensions) ? fileExtensions : {},
                };
                data.push(fileData);
            } catch (err) {
                console.warn(`Error reading or parsing World Info file ${file.name}:`, err);
            }
        }

        return response.send(data);
    } catch (err) {
        console.error('Error reading World Info directory:', err);
        return response.sendStatus(500);
    }
});

router.post('/get', (request, response) => {
    if (!request.body?.name) {
        return response.sendStatus(400);
    }

    const file = readWorldInfoFile(request.user.directories, request.body.name, true);

    return response.send(file);
});

router.post('/delete', (request, response) => {
    if (!request.body?.name) {
        return response.sendStatus(400);
    }

    const worldInfoName = request.body.name;
    const { filename, pathToWorldInfo, entriesDir } = getWorldInfoPaths(request.user.directories, worldInfoName);

    if (!fs.existsSync(pathToWorldInfo)) {
        throw new Error(`World info file ${filename} doesn't exist.`);
    }

    fs.unlinkSync(pathToWorldInfo);

    if (fs.existsSync(entriesDir)) {
        fs.rmSync(entriesDir, { recursive: true, force: true });
    }

    return response.sendStatus(200);
});

router.post('/import', (request, response) => {
    if (!request.file) return response.sendStatus(400);

    const filename = `${path.parse(sanitize(request.file.originalname)).name}.json`;

    let fileContents = null;

    if (request.body.convertedData) {
        fileContents = request.body.convertedData;
    } else {
        const pathToUpload = path.join(request.file.destination, request.file.filename);
        fileContents = fs.readFileSync(pathToUpload, 'utf8');
        fs.unlinkSync(pathToUpload);
    }

    try {
        const worldContent = JSON.parse(fileContents);
        if (!('entries' in worldContent)) {
            throw new Error('File must contain a world info entries list');
        }
    } catch (err) {
        return response.status(400).send('Is not a valid world info file');
    }

    const pathToNewFile = path.join(request.user.directories.worlds, filename);
    const worldName = path.parse(pathToNewFile).name;

    if (!worldName) {
        return response.status(400).send('World file must have a name');
    }

    // Importing writes the plain (legacy) format directly; if a book by this name was previously migrated
    // to the sidecar format, its now-orphaned sidecar directory needs to go too, or it'd just sit there
    // unreferenced. The freshly-imported file gets migrated to the sidecar format lazily on its next edit,
    // same as any other pre-existing book.
    const { entriesDir } = getWorldInfoPaths(request.user.directories, worldName);
    if (fs.existsSync(entriesDir)) {
        fs.rmSync(entriesDir, { recursive: true, force: true });
    }

    writeFileAtomicSync(pathToNewFile, fileContents);
    return response.send({ name: worldName });
});

router.post('/edit', (request, response) => {
    if (!request.body) {
        return response.sendStatus(400);
    }

    if (!request.body.name) {
        return response.status(400).send('World file must have a name');
    }

    try {
        if (!('entries' in request.body.data)) {
            throw new Error('World info must contain an entries list');
        }
    } catch (err) {
        return response.status(400).send('Is not a valid world info file');
    }

    writeWorldInfoFile(request.user.directories, request.body.name, request.body.data);

    return response.send({ ok: true });
});
