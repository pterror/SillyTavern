import fs from 'node:fs';
import { pageSettingsHash } from '../settings-hash.js';
import path from 'node:path';

import express from 'express';
import sanitize from 'sanitize-filename';
import _ from 'lodash';
import { readAllSettings, writeSettingsKeys } from '../settings-store.js';
import { readUserSettings } from '../settings-reads.js';
import { resolveCharacterWorldLink } from '../../public/scripts/character-world-link.js';
import { engineStoreHere, requestStore, storeRoute, userStore } from '../user-stores.js';
import { MAX_UID, bookExistsHere, readBookHere } from '../world-info-engine.js';
import { bookKey } from '../world-info-keys.js';
import { TYPE } from '../library-codes.js';
import { sessionHeaderOf } from '../request-session.js';

/**
 * World info is stored in the user's engine store (`lib.books`, `src/world-info-engine.js`); a book is found by the
 * stem of the file its name would have had (`bookKey()`). Upstream's format comes in through importWorldInfoFromRaw().
 */

/** @type {Set<string>} */
const reportedMisses = new Set();
const REPORTED_MISS_LIMIT = 10_000;

/**
 * @param {{ root: string }} directories
 * @param {string} worldInfoName
 */
function reportMissing(directories, worldInfoName) {
    const at = `${path.resolve(directories.root)}\0${bookKey(worldInfoName)}`;
    if (reportedMisses.has(at)) {
        reportedMisses.delete(at);
        reportedMisses.add(at);
        return;
    }
    reportedMisses.add(at);
    if (reportedMisses.size > REPORTED_MISS_LIMIT) reportedMisses.delete(reportedMisses.values().next().value);
    console.error(`World info file ${sanitize(`${worldInfoName}.json`)} doesn't exist.`);
}

/**
 * @param {{ root: string }} directories
 * @param {string} worldInfoName
 */
function foundAgain(directories, worldInfoName) {
    reportedMisses.delete(`${path.resolve(directories.root)}\0${bookKey(worldInfoName)}`);
}

/**
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} worldInfoName
 * @returns {Promise<boolean>}
 */
export async function worldInfoFileExists(directories, worldInfoName) {
    if (!worldInfoName) {
        return false;
    }
    return (await userStore(directories)).lib.books.exists(worldInfoName);
}

/**
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {{data?: {extensions?: {world?: string}, character_book?: object}}|null|undefined} character
 * @returns {string}
 */
export function getCharacterWorldLink(directories, character) {
    return resolveCharacterWorldLink(character, (name) => !!name && bookExistsHere(engineStoreHere(directories), name));
}

function sanitizeEntryUid(uid) {
    const safe = sanitize(String(uid));
    return safe ? safe : null;
}

/**
 * Reads a World Info file and returns its contents (upstream's export, on this thread: the book is read from one
 * state of the user's store, opened here when no read has opened it yet).
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {string} worldInfoName Name of the World Info file
 * @param {boolean} allowDummy If true, returns an empty object if the file doesn't exist
 * @param {{ logMissing?: boolean }} [options] logMissing: false for a caller that reports a missing file itself.
 * @returns {object} World Info file contents
 */
export function readWorldInfoFile(directories, worldInfoName, allowDummy, { logMissing = true } = {}) {
    const dummyObject = allowDummy ? { entries: {} } : null;

    if (!worldInfoName) {
        return dummyObject;
    }

    const book = readBookHere(engineStoreHere(directories), worldInfoName);
    if (!book) {
        if (logMissing) reportMissing(directories, worldInfoName);
        return dummyObject;
    }
    foundAgain(directories, worldInfoName);
    return book;
}

/**
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} worldInfoName
 * @param {boolean} allowDummy
 * @param {{ logMissing?: boolean }} [options]
 * @returns {Promise<object>}
 */
export async function readWorldInfo(directories, worldInfoName, allowDummy, { logMissing = true } = {}) {
    const dummyObject = allowDummy ? { entries: {} } : null;

    if (!worldInfoName) {
        return dummyObject;
    }

    const book = await (await userStore(directories)).lib.books.read(worldInfoName);
    if (!book) {
        if (logMissing) reportMissing(directories, worldInfoName);
        return dummyObject;
    }
    foundAgain(directories, worldInfoName);
    return book;
}

export const router = express.Router();

router.post('/list', storeRoute('reading the World Info list', async (request, response) => {
    const { lib } = await requestStore(request);
    return response.send(await lib.books.list());
}));

router.post('/get', storeRoute('reading a World Info book', async (request, response) => {
    if (!request.body?.name) {
        return response.sendStatus(400);
    }

    const { lib } = await requestStore(request);
    const found = await lib.books.find(request.body.name);
    const file = await readWorldInfo(request.user.directories, request.body.name, true);

    if (found?.defined) response.set('X-ST-Book-Id', String(found.id));
    return response.send(file);
}));

router.post('/additional-books', storeRoute('changing a character\'s additional World Info', async (request, response) => {
    const { characterAvatar, op, books } = request.body ?? {};
    if (typeof characterAvatar !== 'string' || !characterAvatar) {
        return response.status(400).send({ result: 'error', error: 'characterAvatar is required' });
    }
    if (!['add', 'remove', 'set'].includes(op)) {
        return response.status(400).send({ result: 'error', error: 'op must be one of: add, remove, set' });
    }
    const requested = [...new Set((Array.isArray(books) ? books : [books]).filter(b => typeof b === 'string' && b))];
    if (op !== 'remove' && requested.length === 0) {
        return response.status(400).send({ result: 'error', error: 'books must be a non-empty string or array of strings' });
    }

    const { lib } = await requestStore(request);
    const unknownBooks = [];
    for (const name of requested) {
        if (!(await lib.books.exists(name))) unknownBooks.push(name);
    }
    if (unknownBooks.length > 0) {
        return response.status(404).send({ result: 'error', error: 'Unknown World(s)', unknownBooks });
    }

    const extraBooks = await lib.extraLinks(`${characterAvatar}.png`, op, requested);
    if (extraBooks === null) {
        console.warn(`[additional-books] no character ${characterAvatar}.png: nothing written`);
        return response.status(404).send({ result: 'error', error: 'Unknown character', unknownCharacter: characterAvatar });
    }
    return response.send({ result: 'ok', extraBooks });
}));

router.post('/delete', storeRoute('deleting a World Info book', async (request, response) => {
    if (!request.body?.name) {
        return response.sendStatus(400);
    }

    const worldInfoName = request.body.name;
    const { lib } = await requestStore(request);
    if (!(await lib.books.delete(worldInfoName, actorOf(request)))) {
        throw new Error(`World info file ${sanitize(`${worldInfoName}.json`)} doesn't exist.`);
    }

    return response.sendStatus(200);
}));

/**
 * @param {any} request
 * @returns {import('../world-info-engine.js').Actor}
 */
function actorOf(request) {
    return { user: request.user.profile.handle, session: sessionHeaderOf(request) ?? null };
}

/**
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} desiredName
 * @param {string} fileContents
 * @param {import('../world-info-engine.js').Actor | null} [actor]
 * @returns {Promise<string>}
 */
export async function importWorldInfoFromRaw(directories, desiredName, fileContents, actor = null) {
    const filename = `${path.parse(sanitize(desiredName)).name}.json`;

    const worldContent = JSON.parse(fileContents);
    if (!('entries' in worldContent)) {
        throw new Error('File must contain a world info entries list');
    }

    const worldName = path.parse(filename).name;

    if (!worldName) {
        throw new Error('World file must have a name');
    }

    await (await userStore(directories)).lib.books.write(worldName, worldContent, actor);
    return worldName;
}

router.post('/import', storeRoute('importing a World Info book', async (request, response) => {
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
        const worldName = await importWorldInfoFromRaw(request.user.directories, filename, fileContents, actorOf(request));
        return response.send({ name: worldName });
    } catch (err) {
        return response.status(400).send(err instanceof Error ? err.message : 'Is not a valid world info file');
    }
}));

router.post('/create', storeRoute('creating a World Info book', async (request, response) => {
    const { name, unique = true, replace = false, data } = request.body ?? {};
    if (name !== undefined && typeof name !== 'string') {
        return response.status(400).send({ error: 'name must be a string' });
    }
    if (data !== undefined && (!_.isPlainObject(data) || !_.isObjectLike(data.entries))) {
        return response.status(400).send({ error: 'data must be a World Info object with entries' });
    }

    const { lib } = await requestStore(request);
    const baseName = (typeof name === 'string' && name.trim()) ? name.trim() : 'New World';
    const exists = (/** @type {string} */ candidate) => lib.books.exists(candidate);

    let finalName = baseName;
    if (unique === false) {
        if (await exists(finalName) && replace !== true) {
            return response.status(409).send({ error: `World Info file '${finalName}' already exists` });
        }
    } else {
        const MAX_TRIES = 100_000;
        for (let i = 1; await exists(finalName); i++) {
            if (i > MAX_TRIES) {
                return response.status(500).send({ error: 'Could not allocate a unique World Info name' });
            }
            finalName = `${baseName} (${i})`;
        }
    }

    await lib.books.write(finalName, data ?? { entries: {} }, actorOf(request));

    return response.send({ ok: true, name: finalName });
}));

const isBookField = (/** @type {unknown} */ key) => typeof key === 'string' && key !== '' && key !== 'entries' && key !== 'format';

router.post('/entries/apply', storeRoute('applying World Info changes', async (request, response) => {
    const { name, entries: entryChanges = [], fields: fieldChanges = [] } = request.body ?? {};
    if (typeof name !== 'string' || !name) {
        return response.status(400).send({ error: 'name is required' });
    }
    if (!Array.isArray(entryChanges) || !Array.isArray(fieldChanges)) {
        return response.status(400).send({ error: 'entries and fields must be arrays' });
    }

    const { lib } = await requestStore(request);
    if (!(await lib.books.exists(name))) {
        return response.status(404).send({ error: `Lorebook '${name}' not found` });
    }
    for (const change of entryChanges) {
        const uid = change?.uid;
        if ((typeof uid !== 'number' && typeof uid !== 'string') || !sanitizeEntryUid(uid)) {
            return response.status(400).send({ error: 'every entry change needs a uid' });
        }
        if (change.data != null && !_.isPlainObject(change.data)) {
            return response.status(400).send({ error: `entry ${String(uid)}: data must be an object or null` });
        }
    }
    for (const change of fieldChanges) {
        if (!isBookField(change?.key)) {
            return response.status(400).send({ error: 'every field change needs a key other than entries and format' });
        }
    }

    const result = await lib.books.apply(name, entryChanges, fieldChanges, actorOf(request));
    if (!result) {
        return response.status(404).send({ error: `Lorebook '${name}' not found` });
    }
    return response.send(result);
}));

router.post('/duplicate', storeRoute('duplicating a World Info book', async (request, response) => {
    const { name, new_name: newName } = request.body ?? {};
    if (typeof name !== 'string' || !name || typeof newName !== 'string' || !newName.trim()) {
        return response.status(400).send({ error: 'name and new_name are required' });
    }
    const { lib } = await requestStore(request);
    const book = await lib.books.read(name);
    if (!book) {
        return response.status(404).send({ error: `Lorebook '${name}' not found` });
    }
    if (await lib.books.exists(newName)) {
        return response.status(409).send({ error: `World Info file '${newName}' already exists` });
    }
    await lib.books.write(newName, book, actorOf(request));
    return response.send({ ok: true, name: newName });
}));

router.post('/rename', storeRoute('renaming a World Info book', async (request, response) => {
    const { name, new_name: newName, relink_characters: relinkCharacters = false } = request.body ?? {};
    if (typeof name !== 'string' || !name || typeof newName !== 'string' || !newName.trim() || name === newName) {
        return response.status(400).send({ error: 'name and a different new_name are required' });
    }
    const directories = request.user.directories;
    const { lib } = await requestStore(request);
    /** @type {bigint[]} */
    const moved = [];
    const renamed = await lib.books.rename(name, newName, { relink: relinkCharacters === true, moved });
    if (renamed === 'missing') {
        return response.status(404).send({ error: `Lorebook '${name}' not found` });
    }
    if (renamed === 'taken') {
        return response.status(409).send({ error: `World Info file '${newName}' already exists` });
    }

    const rename = (/** @type {unknown} */ value) => value === name ? newName : value;
    const current = readUserSettings(directories, ['world_info_settings', 'power_user.persona_data']);
    /** @type {Record<string, unknown>} */
    const settings = {};
    const worldInfoSettings = _.isPlainObject(current.world_info_settings) ? _.cloneDeep(current.world_info_settings) : null;
    if (worldInfoSettings && _.isPlainObject(worldInfoSettings.world_info)) {
        const worldInfo = worldInfoSettings.world_info;
        const before = JSON.stringify(worldInfo);
        if (Array.isArray(worldInfo.globalSelect)) worldInfo.globalSelect = _.uniq(worldInfo.globalSelect.map(rename));
        if (JSON.stringify(worldInfo) !== before) settings.world_info_settings = worldInfoSettings;
    }
    const personaData = _.isPlainObject(current['power_user.persona_data']) ? _.cloneDeep(current['power_user.persona_data']) : null;
    if (personaData) {
        let personasChanged = false;
        for (const persona of Object.values(personaData)) {
            if (_.isPlainObject(persona) && persona.lorebook === name) {
                persona.lorebook = newName;
                personasChanged = true;
            }
        }
        if (personasChanged) settings['power_user.persona_data'] = personaData;
    }
    if (Object.keys(settings).length) await writeSettingsKeys(directories, settings);

    const keys = moved.length ? await lib.store.libraryKeys(moved) : [];
    return response.send({
        ok: true,
        name: newName,
        characters_updated: keys.filter(Boolean).map((/** @type {any} */ k) => k.key),
        characters_failed: [],
        settings,
        ...(Object.keys(settings).length ? { settings_hash: pageSettingsHash(readAllSettings(directories)) } : {}),
    });
}));

router.post('/edit', storeRoute('saving a World Info book', async (request, response) => {
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

    const { lib } = await requestStore(request);
    await lib.books.write(request.body.name, request.body.data, actorOf(request));

    return response.send({ ok: true });
}));

router.post('/entry/transplant', storeRoute('moving a World Info entry', async (request, response) => {
    const { source_name, target_name, uid, delete_original } = request.body ?? {};

    if (typeof source_name !== 'string' || !source_name) {
        return response.status(400).send({ error: 'source_name is required' });
    }
    if (typeof target_name !== 'string' || !target_name) {
        return response.status(400).send({ error: 'target_name is required' });
    }
    if (uid === undefined || uid === null || uid === '') {
        return response.status(400).send({ error: 'uid is required' });
    }
    if (source_name === target_name) {
        return response.status(400).send({ error: 'source_name and target_name must differ' });
    }

    const { lib } = await requestStore(request);
    const result = await lib.books.transplant({ source: source_name, target: target_name, uid, deleteOriginal: delete_original !== false }, actorOf(request));
    if (result === 'no source') {
        return response.status(404).send({ error: `Source lorebook '${source_name}' not found` });
    }
    if (result === 'no target') {
        return response.status(404).send({ error: `Target lorebook '${target_name}' not found` });
    }
    if (result === 'no entry') {
        return response.status(404).send({ error: `Entry uid '${String(uid)}' not found in source lorebook '${source_name}'` });
    }
    if (result === 'full') {
        return response.status(500).send({ error: `Could not allocate a free uid in target lorebook '${target_name}'` });
    }
    return response.send({ ok: true, entry: result.entry });
}));

router.post('/entry/create', storeRoute('creating a World Info entry', async (request, response) => {
    const { name, uid } = request.body ?? {};

    if (typeof name !== 'string' || !name) {
        return response.status(400).send({ error: 'name is required' });
    }
    if (uid !== undefined && !(Number.isInteger(uid) && uid >= 0 && uid < MAX_UID)) {
        return response.status(400).send({ error: `uid must be an integer in [0, ${MAX_UID})` });
    }

    const { lib } = await requestStore(request);
    const result = await lib.books.createEntry(name, uid);
    if (result === 'missing') {
        return response.status(404).send({ error: `Lorebook '${name}' not found` });
    }
    if (result === 'full') {
        return response.status(500).send({ error: `Could not allocate a free uid in lorebook '${name}'` });
    }
    return response.send({ ok: true, entry: result.entry });
}));

router.post('/entry/edit', storeRoute('saving a World Info entry', async (request, response) => {
    const { name, uid, data: entryData } = request.body ?? {};

    if (typeof name !== 'string' || !name) {
        return response.status(400).send({ error: 'name is required' });
    }
    if (uid === undefined || uid === null || uid === '') {
        return response.status(400).send({ error: 'uid is required' });
    }
    if (!_.isObjectLike(entryData) || Array.isArray(entryData)) {
        return response.status(400).send({ error: 'data must be an object' });
    }

    const { lib } = await requestStore(request);
    const result = await lib.books.editEntry(name, uid, entryData, actorOf(request));
    if (result === 'missing') {
        return response.status(404).send({ error: `Lorebook '${name}' not found` });
    }
    if (result === 'no entry') {
        return response.status(404).send({ error: `Entry uid '${String(uid)}' not found in lorebook '${name}'` });
    }
    return response.send({ ok: true, entry: result.entry });
}));

const DEFAULT_SEARCH_PAGE_SIZE = 50;
const MAX_SEARCH_PAGE_SIZE = 500;

router.post('/search', storeRoute('searching a World Info book', async (request, response) => {
    const { name, avatar, search, limit, cursor } = request.body ?? {};
    if ((typeof name === 'string') === (typeof avatar === 'string') || (name ?? avatar) === '') {
        return response.status(400).send({ error: 'one of name or avatar is required' });
    }
    if (typeof search !== 'string') {
        return response.status(400).send({ error: 'search must be a string' });
    }
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_PAGE_SIZE)) {
        return response.status(400).send({ error: `limit must be an integer from 1 to ${MAX_SEARCH_PAGE_SIZE}` });
    }
    if (cursor !== undefined && cursor !== null && typeof cursor !== 'string') {
        return response.status(400).send({ error: 'cursor must be a string' });
    }
    const { lib } = await requestStore(request);
    let character;
    if (typeof avatar === 'string') {
        [character] = await lib.ids(TYPE.character, [avatar]);
        if (character === null) return response.status(404).send({ error: `Character '${avatar}' not found` });
    }
    const found = await lib.books.search({
        ...(character !== undefined ? { character } : { name }),
        search,
        limit: limit ?? DEFAULT_SEARCH_PAGE_SIZE,
        ...(typeof cursor === 'string' ? { cursor } : {}),
    });
    if (found === 'missing') {
        return response.status(404).send({ error: `Lorebook '${name ?? avatar}' not found` });
    }
    return response.send(found);
}));
