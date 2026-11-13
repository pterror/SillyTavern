import path from 'node:path';

import express from 'express';
import sanitize from 'sanitize-filename';
import { LOOP_CHECK_VISITS_PER_WRITE } from '@st/worldbuilding/protocol';
import { isPlainObject } from '../util.js';
import { requestStore, storeRoute, userStore } from '../user-stores.js';
import { bookKey } from '../world-info-keys.js';
import { sessionHeaderOf } from '../request-session.js';
import { WORLD_FIELD, searchClauses } from '../search-clauses.js';
import { timedEffectHash } from '../world-info/candidate-resolution.js';
import { newWorldInfoEntryTemplate } from '../../public/scripts/world-info-entry-defaults.js';

/**
 * World info is stored in the user's engine store (`lib.books`, `src/world-info-engine.js`); a book is found by the
 * stem of the file its name would have had (`bookKey()`). Upstream's format comes in through importWorldInfoFromRaw().
 */

const CARD_COPY = 'This is a copy of a character\'s embedded lorebook. The character keeps its own lorebook, so the copy isn\'t added to the list.';

export const router = express.Router();

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
 * @returns {Promise<string | null>}
 */
export async function importWorldInfoFromRaw(directories, desiredName, fileContents, actor = null) {
    return (await importWorldInfo(directories, desiredName, fileContents, actor))?.name ?? null;
}

/**
 * @param {any} directories
 * @param {string} desiredName
 * @param {string} fileContents
 * @param {import('../world-info-engine.js').Actor | null} [actor]
 * @returns {Promise<{ name: string, unreachedLoops: import('../world-info-engine.js').UnreachedLoop[] } | null>}
 */
async function importWorldInfo(directories, desiredName, fileContents, actor = null) {
    const filename = `${path.parse(sanitize(desiredName)).name}.json`;

    const worldContent = JSON.parse(fileContents);
    if (!('entries' in worldContent)) {
        throw new Error('File must contain a world info entries list');
    }

    const worldName = path.parse(filename).name;

    if (!worldName) {
        throw new Error('World file must have a name');
    }

    const written = await (await userStore(directories)).lib.books.write(worldName, worldContent, actor);
    return written === 'card copy' ? null : { name: worldName, unreachedLoops: written.unreachedLoops };
}

router.post('/create', storeRoute('creating a World Info book', async (request, response) => {
    const { name, unique = true, replace = false, data } = request.body ?? {};
    if (name !== undefined && typeof name !== 'string') {
        return response.status(400).send({ error: 'name must be a string' });
    }
    if (data !== undefined && (!isPlainObject(data) || typeof data.entries !== 'object' || data.entries === null)) {
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

    const written = await lib.books.write(finalName, data ?? { entries: {} }, actorOf(request));
    if (written === 'card copy') {
        return response.status(400).send({ error: CARD_COPY });
    }

    return response.send({ ok: true, name: finalName, unreachedLoops: written.unreachedLoops });
}));

/**
 * @param {any} body
 * @returns {{ name: string, uid: string } | null}
 */
function entryNamed(body) {
    const { name, uid } = body ?? {};
    if (typeof name !== 'string' || !name || uid === undefined || uid === null || uid === '') return null;
    return { name, uid: String(uid) };
}

/**
 * @param {import('express').Response} response
 * @param {string} name
 * @param {string} uid
 * @param {'missing' | 'no entry'} refusal
 */
function noEntry(response, name, uid, refusal) {
    return response.status(404).send({ error: refusal === 'missing' ? `Lorebook '${name}' not found` : `Entry uid '${uid}' not found in lorebook '${name}'` });
}

router.post('/entry/create', storeRoute('creating a World Info entry', async (request, response) => {
    const { name, data: fields = {} } = request.body ?? {};
    if (typeof name !== 'string' || !name) {
        return response.status(400).send({ error: 'name is required' });
    }
    if (!isPlainObject(fields)) {
        return response.status(400).send({ error: 'data must be an object' });
    }
    const { lib } = await requestStore(request);
    const found = await lib.books.find(name);
    if (!found?.defined) return response.status(404).send({ error: `Lorebook '${name}' not found` });
    const entry = { ...structuredClone(newWorldInfoEntryTemplate), ...fields };
    const made = await lib.books.createEntryIn(found.id, { after: null, entry, relation: null }, LOOP_CHECK_VISITS_PER_WRITE, actorOf(request));
    if (made === 'missing') return response.status(404).send({ error: `Lorebook '${name}' not found` });
    if ('refused' in made) return response.status(400).send({ error: made.refused });
    return response.send({ ok: true, entry: { uid: Number(made.uid) } });
}));

router.post('/entry/get', storeRoute('reading a World Info entry', async (request, response) => {
    const named = entryNamed(request.body);
    if (!named) return response.status(400).send({ error: 'name and uid are required' });
    const { lib } = await requestStore(request);
    const read = await lib.books.entryOfFile(named.name, named.uid);
    if (typeof read === 'string') return noEntry(response, named.name, named.uid, read);
    return response.send({ entry: read.entry, hash: timedEffectHash(bookKey(named.name), read.entry) });
}));

const NO_FILTER = Object.freeze({ isExclude: false, names: [], tags: [] });

router.post('/entry/set', storeRoute('changing a World Info entry', async (request, response) => {
    const named = entryNamed(request.body);
    const { fields } = request.body ?? {};
    if (!named || !isPlainObject(fields)) return response.status(400).send({ error: 'name, uid and fields are required' });
    const { lib } = await requestStore(request);
    const at = await lib.books.entryOf(named.name, named.uid);
    if (typeof at === 'string') return noEntry(response, named.name, named.uid, at);
    const done = await lib.books.editEntryById(at.book, at.id, (/** @type {Record<string, any>} */ current) => {
        const next = { ...current };
        for (const [field, value] of Object.entries(fields)) {
            next[field] = field === 'characterFilter' && isPlainObject(value)
                ? { ...NO_FILTER, ...(isPlainObject(current.characterFilter) ? current.characterFilter : {}), ...value }
                : value;
        }
        return next;
    }, actorOf(request));
    if (done === 'ok') return response.send({ ok: true });
    if (typeof done === 'string') return noEntry(response, named.name, named.uid, done);
    return response.status(400).send({ error: done.refused });
}));

const FOUND_BY_FIELD = Object.freeze({
    key: WORLD_FIELD.key,
    comment: WORLD_FIELD.title,
    content: WORLD_FIELD.text,
    group: WORLD_FIELD.group,
    keysecondary: WORLD_FIELD.secondary,
    automationId: WORLD_FIELD.automationId,
    uid: WORLD_FIELD.uid,
});

router.post('/entry/find', storeRoute('finding a World Info entry', async (request, response) => {
    const { name, field = 'key', text } = request.body ?? {};
    if (typeof name !== 'string' || !name || typeof text !== 'string') return response.status(400).send({ error: 'name and text are required' });
    if (!Object.hasOwn(FOUND_BY_FIELD, field)) return response.status(400).send({ error: `An entry is found by one of: ${Object.keys(FOUND_BY_FIELD).join(', ')}` });
    const { lib } = await requestStore(request);
    const found = await lib.books.find(name);
    if (!found?.defined) return response.status(404).send({ error: `Lorebook '${name}' not found` });
    const clauses = searchClauses(text).map(clause => ({ ...clause, fields: [FOUND_BY_FIELD[/** @type {keyof typeof FOUND_BY_FIELD} */ (field)]] }));
    /** @type {{ entries: { label: { thing: string } }[] }} */
    const read = clauses.length ? await lib.store.worldRead('worldbuildingFind', { book: found.id, clauses, limit: 1 }) : { entries: [] };
    const [first] = read.entries.length ? await lib.entities([BigInt(read.entries[0].label.thing)]) : [null];
    const uid = first ? first.key.slice(first.key.indexOf(':') + 1) : null;
    return response.send({ uid: uid === null ? null : Number(uid) });
}));
