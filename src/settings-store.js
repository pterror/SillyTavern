import fs from 'node:fs';
import path from 'node:path';

import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { SETTINGS_FILE } from './constants.js';
import { getAtPath, setAtPath, settingsWithoutCharLore } from '../public/scripts/hash-utils.js';
import { settingsDocumentOf } from './settings-documents.js';

export const FILES_ASIDE = 'settings.before-model';

/**
 * @param {import('./users.js').UserDirectoryList} directories
 */
function documentOf(directories) {
    const document = settingsDocumentOf(directories);
    if (!document && typeof directories?.root === 'string' && fs.existsSync(path.join(directories.root, FILES_ASIDE))) {
        throw new Error(`the settings of ${directories.root} are the settings model's: open its settings document first`);
    }
    return document;
}

const SETTINGS_SUBDIR = 'settings';

/** @param {import('./users.js').UserDirectoryList} directories */
export function settingsDirPath(directories) {
    return path.join(directories.root, SETTINGS_SUBDIR);
}

/** @param {import('./users.js').UserDirectoryList} directories */
export function legacySettingsPath(directories) {
    return path.join(directories.root, SETTINGS_FILE);
}

/**
 * @param {string} key
 */
export function isValidSettingsKey(key) {
    return typeof key === 'string' && key.length > 0 && /^[A-Za-z0-9_]+$/.test(key);
}

/**
 * @param {Record<string, unknown>} obj
 * @param {string} key
 * @param {unknown} value
 */
function setOwnProperty(obj, key, value) {
    Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * @param {string} filePath
 * @returns {*}
 */
function readKeyFile(filePath) {
    if (!fs.existsSync(filePath)) {
        return undefined;
    }
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
        console.error(`Could not parse settings file ${filePath}, treating its value as absent`, err);
        return undefined;
    }
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 */
function ensureMigrated(directories) {
    const dir = settingsDirPath(directories);
    if (fs.existsSync(dir)) {
        return;
    }

    const legacyPath = legacySettingsPath(directories);
    fs.mkdirSync(dir, { recursive: true });

    if (!fs.existsSync(legacyPath)) {
        return;
    }

    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
    } catch (err) {
        console.error(`Could not parse legacy ${legacyPath} during sharded-settings migration - leaving it in place, starting fresh`, err);
        return;
    }

    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(parsed)) {
            if (!isValidSettingsKey(key)) {
                console.error(`Skipping non-identifier settings key "${key}" found in legacy settings.json during migration`);
                continue;
            }
            writeFileAtomicSync(path.join(dir, `${key}.json`), JSON.stringify(value, null, 4), 'utf8');
        }
    }

    fs.rmSync(legacyPath, { force: true });
}

/**
 * @param {Record<string, any>} settings
 * @param {string[]} dottedPaths
 * @returns {Record<string, unknown>}
 */
export function valuesAtPaths(settings, dottedPaths) {
    /** @type {Record<string, unknown>} */
    const read = {};
    for (const dottedPath of dottedPaths) {
        const dot = dottedPath.indexOf('.');
        const top = settings[dot === -1 ? dottedPath : dottedPath.slice(0, dot)];
        setOwnProperty(read, dottedPath, structuredClone(dot === -1 ? top : getAtPath(top, dottedPath.slice(dot + 1))));
    }
    return read;
}

/** @param {import('./users.js').UserDirectoryList} directories */
export function settingsExist(directories) {
    if (documentOf(directories)) return true;
    return fs.existsSync(settingsDirPath(directories)) || fs.existsSync(legacySettingsPath(directories));
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 */
export function readAllSettings(directories) {
    const document = documentOf(directories);
    if (document) return structuredClone(document.settings);
    ensureMigrated(directories);
    const dir = settingsDirPath(directories);
    /** @type {Record<string, unknown>} */
    const result = {};
    for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort()) {
        const key = file.slice(0, -'.json'.length);
        const value = readKeyFile(path.join(dir, file));
        if (value !== undefined) {
            setOwnProperty(result, key, value);
        }
    }
    return result;
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 */
export function readAllSettingsAsJson(directories) {
    return JSON.stringify(readAllSettings(directories), null, 4);
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string[]} dottedPaths
 * @returns {Record<string, unknown>}
 */
export function readSettingsAtPaths(directories, dottedPaths) {
    const document = documentOf(directories);
    if (document) return valuesAtPaths(document.settings, dottedPaths);
    ensureMigrated(directories);
    const dir = settingsDirPath(directories);
    /** @type {Map<string, unknown>} */
    const topValueCache = new Map();
    /** @type {Record<string, unknown>} */
    const result = {};
    for (const dottedPath of dottedPaths) {
        const dotIndex = dottedPath.indexOf('.');
        const topKey = dotIndex === -1 ? dottedPath : dottedPath.slice(0, dotIndex);
        if (!topValueCache.has(topKey)) {
            topValueCache.set(topKey, readKeyFile(path.join(dir, `${topKey}.json`)));
        }
        const topValue = topValueCache.get(topKey);
        setOwnProperty(result, dottedPath, dotIndex === -1 ? topValue : getAtPath(topValue, dottedPath.slice(dotIndex + 1)));
    }
    return result;
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {Record<string, unknown>} keys
 * @returns {Promise<string[]>}
 */
export function writeSettingsKeys(directories, keys) {
    const document = documentOf(directories);
    if (!document) ensureMigrated(directories);
    const dir = settingsDirPath(directories);

    /** @type {Map<string, Array<[string|null, unknown]>>} */
    const updatesByTopKey = new Map();
    for (const [key, given] of Object.entries(keys)) {
        const { value, skip } = settingsWithoutCharLore(key, given);
        if (skip) continue;
        const dotIndex = key.indexOf('.');
        const topKey = dotIndex === -1 ? key : key.slice(0, dotIndex);
        if (!isValidSettingsKey(topKey)) {
            throw new Error(`Invalid settings key: ${topKey}`);
        }
        const subPath = dotIndex === -1 ? null : key.slice(dotIndex + 1);
        if (!updatesByTopKey.has(topKey)) {
            updatesByTopKey.set(topKey, []);
        }
        updatesByTopKey.get(topKey).push([subPath, value]);
    }

    const next = document ? structuredClone(document.settings) : null;
    for (const [topKey, updates] of updatesByTopKey) {
        const filePath = path.join(dir, `${topKey}.json`);
        let current = next ? next[topKey] : readKeyFile(filePath);
        for (const [subPath, value] of updates) {
            if (subPath === null) {
                current = value;
            } else {
                if (current === undefined || current === null || typeof current !== 'object' || Array.isArray(current)) {
                    current = {};
                }
                setAtPath(current, subPath, value);
            }
        }
        if (next) setOwnProperty(next, topKey, current);
        else writeFileAtomicSync(filePath, JSON.stringify(current, null, 4), 'utf8');
    }
    const touched = [...updatesByTopKey.keys()];
    return document && next ? document.replace(next).then(() => touched) : Promise.resolve(touched);
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {Record<string, unknown>} object
 * @returns {Promise<Set<string>>}
 */
export function writeNamedSettings(directories, object) {
    const document = documentOf(directories);
    if (!document) ensureMigrated(directories);
    const dir = settingsDirPath(directories);

    const allKeys = Object.keys(object ?? {});
    const validKeys = allKeys.filter(isValidSettingsKey);
    for (const key of allKeys) {
        if (!isValidSettingsKey(key)) {
            console.error(`Skipping non-identifier settings key "${key}" - not written to the sharded store`);
        }
    }

    const next = document ? structuredClone(document.settings) : null;
    for (const key of validKeys) {
        const { value } = settingsWithoutCharLore(key, object[key]);
        if (next) setOwnProperty(next, key, structuredClone(value));
        else writeFileAtomicSync(path.join(dir, `${key}.json`), JSON.stringify(value, null, 4), 'utf8');
    }
    const written = new Set(validKeys.map(k => `${k}.json`));
    return document && next ? document.replace(next).then(() => written) : Promise.resolve(written);
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {Record<string, unknown>} fullObject
 * @returns {Promise<void>}
 */
export function writeAllSettings(directories, fullObject) {
    const document = documentOf(directories);
    if (document) {
        /** @type {Record<string, unknown>} */
        const next = {};
        for (const key of Object.keys(fullObject ?? {}).filter(isValidSettingsKey)) setOwnProperty(next, key, settingsWithoutCharLore(key, fullObject[key]).value);
        return document.replace(next);
    }
    const wantedFiles = new Set(Object.keys(fullObject ?? {}).filter(isValidSettingsKey).map(k => `${k}.json`));
    void writeNamedSettings(directories, fullObject);
    const dir = settingsDirPath(directories);

    for (const file of fs.readdirSync(dir)) {
        if (file.endsWith('.json') && !wantedFiles.has(file)) {
            fs.rmSync(path.join(dir, file), { force: true });
        }
    }
    return Promise.resolve();
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<void>}
 */
export function deleteAllSettings(directories) {
    const document = documentOf(directories);
    if (document) return document.reset();
    fs.rmSync(settingsDirPath(directories), { recursive: true, force: true });
    fs.rmSync(legacySettingsPath(directories), { force: true });
    return Promise.resolve();
}
