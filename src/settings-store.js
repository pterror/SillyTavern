import fs from 'node:fs';
import path from 'node:path';

import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { SETTINGS_FILE } from './constants.js';
import { getAtPath, setAtPath } from '../public/scripts/hash-utils.js';

/**
 * Sharded on-disk storage for a user's settings, one file per top-level key
 * (`<user root>/settings/<key>.json`) instead of a single monolithic settings.json.
 *
 * Why: settings.json's top-level shape is already a flat dict of independent subsystems (power_user,
 * extension_settings, oai_settings, ...) - see /api/settings/save-partial's own doc comment in
 * src/endpoints/settings.js. Before this module existed, save-partial already accepted a request naming just the
 * touched key(s), but its disk write still read, re-serialized, and rewrote the ENTIRE settings.json (tens to a
 * couple hundred KB) on every call, including for a single toggle flip - the client-side payload was minimal but
 * the actual disk I/O was not. Since a JSON text file can't be patched in place (any edit anywhere changes byte
 * offsets for everything after it), the only way to make a single-key change touch only that key's bytes on disk
 * is to stop keeping all keys in one file. This module is that: writeSettingsKeys() below touches only the
 * on-disk file(s) for the top-level key(s) actually being written, nothing else.
 *
 * Legacy monolithic settings.json is migrated in-place, lazily, the first time this module touches a given
 * user's directory (see ensureMigrated()) - transparent to every caller, no separate migration step to run.
 * readAllSettings()/readAllSettingsAsJson() reconstruct the same flat object/string shape callers (backups,
 * /api/settings/get, the tag-import-setting reader, etc.) already expect, so nothing downstream of a *read* needs
 * to know storage is sharded at all.
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
 * Top-level settings keys become filenames, and the "keys" object in a /save-partial request body is
 * client-controlled - without this check a key like '__proto__' or '../../etc' would let a request write
 * outside the settings directory or clobber an unintended path. Every real top-level settings key (power_user,
 * extension_settings, oai_settings, ...) is a plain identifier, so this is not a functional restriction.
 * @param {string} key
 * @returns {boolean}
 */
export function isValidSettingsKey(key) {
    return typeof key === 'string' && key.length > 0 && /^[A-Za-z0-9_]+$/.test(key);
}

/**
 * Sets `obj[key] = value` as a genuine own enumerable property, even when `key` is the literal string
 * '__proto__' (isValidSettingsKey() allows it - it's a plain run of letters/underscores like any other settings
 * key). A bare `obj[key] = value` for that exact key does NOT create an own property at all - JS special-cases
 * assignment to a literal '__proto__' key as a prototype swap instead - so a settings key that happened to be
 * named '__proto__' would silently vanish from every consumer that reads it back via ordinary property access
 * or enumeration (Object.keys/entries, JSON.stringify, a spread). Object.defineProperty has no such special
 * case for any key value.
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
 * One-time, idempotent migration from a legacy monolithic settings.json into the sharded settings/ directory.
 * A no-op once the directory exists - safe to call at the top of every read/write in this module.
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

    // The sharded directory is now authoritative; remove the legacy file so nothing downstream is ever tempted
    // to read stale bytes from it. A read-only consumer that still points at SETTINGS_FILE directly would
    // otherwise silently see whatever the file happened to contain at migration time, forever.
    fs.rmSync(legacyPath, { force: true });
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {boolean} Whether this user has any settings at all yet (sharded or not-yet-migrated legacy file).
 */
export function settingsExist(directories) {
    return fs.existsSync(settingsDirPath(directories)) || fs.existsSync(legacySettingsPath(directories));
}

/**
 * Reads and reconstructs the full flat settings object, same shape a legacy settings.json parsed to.
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Record<string, unknown>}
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
 * Same content as readAllSettings(), serialized the same way a legacy settings.json was
 * (JSON.stringify(..., null, 4)) - this exact string is what /api/settings/get sends as `settings` and what
 * checkSettingsConflict()/the returned settingsHash are hashed from, so every caller that needs "the current
 * canonical settings text" agrees on one function for it.
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {string}
 */
export function readAllSettingsAsJson(directories) {
    return JSON.stringify(readAllSettings(directories), null, 4);
}

/**
 * Reads the current value at each of the given top-level-or-dotted paths, reading only the on-disk file(s) for
 * the top-level key(s) those paths belong to (never the whole store) - used for per-key conflict-hash checks.
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
 * The actual "don't rewrite everything" fix: writes only the on-disk file(s) for the top-level key(s) named in
 * `keys` (top-level or dotted-path), leaving every other key's file completely untouched. A dotted path is
 * applied against that key's current on-disk value (read once, patched, rewritten) rather than replacing the
 * whole key.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {Record<string, unknown>} keys Top-level keys or dotted paths to their new values.
 * @returns {string[]} The top-level key names that were touched (and so had their file rewritten).
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
 * Full replace, for /api/settings/save and restore-snapshot: writes one file per top-level key in `fullObject`
 * (only those files - keys unrelated to the previous state that are also absent from `fullObject` are never
 * touched), and removes any existing per-key file whose key is NOT present in `fullObject`, so the end result is
 * exactly the keys `fullObject` has - the same semantics a whole-file overwrite of settings.json used to have.
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
 * Deletes all of a user's settings, sharded directory and any not-yet-migrated legacy file alike - used by
 * reset-settings. Deleting only the legacy path (the old behavior) would leave a stale sharded directory
 * around that ensureMigrated() would then treat as "already migrated", silently ignoring a freshly reseeded
 * default settings.json and defeating the reset.
 * @param {import('./users.js').UserDirectoryList} directories
 */
export function deleteAllSettings(directories) {
    fs.rmSync(settingsDirPath(directories), { recursive: true, force: true });
    fs.rmSync(legacySettingsPath(directories), { force: true });
}
