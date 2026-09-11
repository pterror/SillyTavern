import fs from 'node:fs';
import path from 'node:path';

import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { SETTINGS_FILE } from './constants.js';
import { getAtPath, setAtPath } from '../public/scripts/hash-utils.js';

/**
 * Sharded on-disk storage for a user's settings, one file per top-level key
 * (`<user root>/settings/<key>.json`) instead of a single monolithic settings.json.
 * A JSON file can't be patched in place, so writing one key at a time requires one file per key.
 * Legacy monolithic settings.json is migrated in-place lazily on first touch (see ensureMigrated()).
 */

const SETTINGS_SUBDIR = 'settings';

/** @param {import('./users.js').UserDirectoryList} directories */
function settingsDirPath(directories) {
    return path.join(directories.root, SETTINGS_SUBDIR);
}

/** @param {import('./users.js').UserDirectoryList} directories */
function legacySettingsPath(directories) {
    return path.join(directories.root, SETTINGS_FILE);
}

/**
 * Top-level settings keys become filenames; this guards against a key like '__proto__' or '../../etc'
 * escaping the settings directory.
 * @param {string} key
 */
export function isValidSettingsKey(key) {
    return typeof key === 'string' && key.length > 0 && /^[A-Za-z0-9_]+$/.test(key);
}

/**
 * Sets `obj[key] = value` as a genuine own property even when `key === '__proto__'` - a bare
 * assignment to that literal key triggers a prototype swap instead of creating an own property.
 * @param {Record<string, unknown>} obj
 * @param {string} key
 * @param {unknown} value
 */
function setOwnProperty(obj, key, value) {
    Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * @param {string} filePath
 * @returns {*} Parsed content, or undefined if the file doesn't exist or fails to parse.
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
 * Idempotent; a no-op once the sharded directory exists.
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

/** @param {import('./users.js').UserDirectoryList} directories */
export function settingsExist(directories) {
    return fs.existsSync(settingsDirPath(directories)) || fs.existsSync(legacySettingsPath(directories));
}

/**
 * Reconstructs the full flat settings object, same shape a legacy settings.json parsed to.
 * @param {import('./users.js').UserDirectoryList} directories
 */
export function readAllSettings(directories) {
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
 * Serialized the same way legacy settings.json was; this exact string is what settingsHash is hashed from.
 * @param {import('./users.js').UserDirectoryList} directories
 */
export function readAllSettingsAsJson(directories) {
    return JSON.stringify(readAllSettings(directories), null, 4);
}

/**
 * Reads only the on-disk file(s) for the top-level key(s) the given paths belong to, never the whole store.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string[]} dottedPaths
 * @returns {Record<string, unknown>} Map of path -> current value (undefined if absent)
 */
export function readSettingsAtPaths(directories, dottedPaths) {
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
 * Writes only the on-disk file(s) for the top-level key(s) named in `keys`, leaving every other key's
 * file untouched. A dotted path is applied against that key's current on-disk value.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {Record<string, unknown>} keys Top-level keys or dotted paths to their new values.
 * @returns {string[]} The top-level key names touched.
 */
export function writeSettingsKeys(directories, keys) {
    ensureMigrated(directories);
    const dir = settingsDirPath(directories);

    /** @type {Map<string, Array<[string|null, unknown]>>} */
    const updatesByTopKey = new Map();
    for (const [key, value] of Object.entries(keys)) {
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

    for (const [topKey, updates] of updatesByTopKey) {
        const filePath = path.join(dir, `${topKey}.json`);
        let current = readKeyFile(filePath);
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
        writeFileAtomicSync(filePath, JSON.stringify(current, null, 4), 'utf8');
    }

    return [...updatesByTopKey.keys()];
}

/**
 * Full replace: writes one file per top-level key in `fullObject` and removes any existing per-key
 * file not present in `fullObject`, matching a whole-file settings.json overwrite.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {Record<string, unknown>} fullObject
 */
export function writeAllSettings(directories, fullObject) {
    ensureMigrated(directories);
    const dir = settingsDirPath(directories);

    const allKeys = Object.keys(fullObject ?? {});
    const validKeys = allKeys.filter(isValidSettingsKey);
    for (const key of allKeys) {
        if (!isValidSettingsKey(key)) {
            console.error(`Skipping non-identifier settings key "${key}" - not written to the sharded store`);
        }
    }
    const wantedFiles = new Set(validKeys.map(k => `${k}.json`));

    for (const key of validKeys) {
        writeFileAtomicSync(path.join(dir, `${key}.json`), JSON.stringify(fullObject[key], null, 4), 'utf8');
    }

    for (const file of fs.readdirSync(dir)) {
        if (file.endsWith('.json') && !wantedFiles.has(file)) {
            fs.rmSync(path.join(dir, file), { force: true });
        }
    }
}

/**
 * Deletes both the sharded directory and any not-yet-migrated legacy file. Deleting only the legacy
 * path would leave a stale sharded directory that ensureMigrated() treats as already-migrated,
 * defeating the reset.
 * @param {import('./users.js').UserDirectoryList} directories
 */
export function deleteAllSettings(directories) {
    fs.rmSync(settingsDirPath(directories), { recursive: true, force: true });
    fs.rmSync(legacySettingsPath(directories), { force: true });
}
