import path from 'node:path';

import sanitize from 'sanitize-filename';
import { resolveCharacterWorldLink } from '../public/scripts/character-world-link.js';
import { engineStoreHere, userStore } from './user-stores.js';
import { bookExistsHere, readBookHere } from './world-info-engine.js';
import { bookKey } from './world-info-keys.js';

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
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {{data?: {extensions?: {world?: string}, character_book?: object}}|null|undefined} character
 * @returns {string}
 */
export function getCharacterWorldLink(directories, character) {
    return resolveCharacterWorldLink(character, (name) => !!name && bookExistsHere(engineStoreHere(directories), name));
}


/**
 * Reads a World Info file and returns its contents (upstream's export, on this thread: the book is read from one
 * state of the user's store, opened here when no read has opened it yet).
 * @param {import('./users.js').UserDirectoryList} directories User directories
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
 * @param {import('./users.js').UserDirectoryList} directories
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
