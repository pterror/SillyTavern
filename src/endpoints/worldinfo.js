import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import sanitize from 'sanitize-filename';
import _ from 'lodash';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import { tryParse } from '../util.js';
import { readSettingsAtPaths, writeSettingsKeys } from '../settings-store.js';

/** Marks a World Info file as migrated to the sidecar format; absent means entries live inline. */
const WORLD_INFO_SIDECAR_FORMAT = 'sidecar-v1';

function getWorldInfoPaths(directories, worldInfoName) {
    const filename = sanitize(`${worldInfoName}.json`);
    const pathToWorldInfo = path.join(directories.worlds, filename);
    const entriesDir = path.join(directories.worlds, `${path.parse(filename).name}.entries`);
    return { filename, pathToWorldInfo, entriesDir };
}

/** Guards against a crafted uid (e.g. containing path separators) escaping the sidecar directory. */
function sanitizeEntryUid(uid) {
    const safe = sanitize(String(uid));
    return safe ? safe : null;
}

/** Reassembles a sidecar manifest plus its per-entry files into the original inline-entries shape. */
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
 * Writes a World Info file without rewriting entries that haven't changed, migrating it to the sidecar
 * format in the process. One-way: a book never edited here stays legacy until its next edit.
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

    // Write the manifest before deleting stale entries, so it never points at an already-deleted file.
    const manifest = { ...rest, format: WORLD_INFO_SIDECAR_FORMAT, entries: keptUids };
    writeFileAtomicSync(pathToWorldInfo, JSON.stringify(manifest, null, 4));

    const keptSafeUids = new Set(keptUids.map(sanitizeEntryUid));
    for (const safeUid of existingUids) {
        if (!keptSafeUids.has(safeUid)) {
            fs.unlinkSync(path.join(entriesDir, `${safeUid}.json`));
        }
    }
}

/**
 * Finds the lowest non-negative integer uid not already used by an entry in `data`. This is the one
 * server-side uid-minting primitive for World Info entries; both `/entry/transplant` (move/copy) and
 * `/entry/create` (brand-new entry) call it against the book they're writing into, immediately before
 * that write, so uid allocation always reflects the book's current on-disk state rather than a
 * possibly-stale client-side copy.
 * @param {object} data World Info file contents (as read by {@link readWorldInfoFile})
 * @returns {number|null} A free uid, or null if none could be found (should not happen in practice)
 */
export function getFreeWorldEntryUid(data) {
    if (!data || typeof data.entries !== 'object' || data.entries === null) {
        return null;
    }

    const MAX_UID = 1_000_000; // <- should be safe enough :)
    for (let uid = 0; uid < MAX_UID; uid++) {
        if (uid in data.entries) {
            continue;
        }
        return uid;
    }

    return null;
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

/**
 * Adds, removes, or replaces a character's additional (auxiliary) World Info bindings, in one
 * round trip: the client sends the action, not a client-computed next array, so it never needs
 * a fresh copy of world_info_settings just to mutate one character's entry, and this endpoint's
 * write scope is limited to exactly that one sub-path - not the whole settings key, let alone
 * the whole settings store.
 */
router.post('/additional-books', (request, response) => {
    const { characterAvatar, op, books } = request.body ?? {};
    if (typeof characterAvatar !== 'string' || !characterAvatar) {
        return response.status(400).send({ result: 'error', error: 'characterAvatar is required' });
    }
    if (!['add', 'remove', 'set'].includes(op)) {
        return response.status(400).send({ result: 'error', error: 'op must be one of: add, remove, set' });
    }
    const requested = (Array.isArray(books) ? books : [books]).filter(b => typeof b === 'string' && b);
    if (op !== 'remove' && requested.length === 0) {
        return response.status(400).send({ result: 'error', error: 'books must be a non-empty string or array of strings' });
    }

    // Reject names that don't correspond to a real World file - the whole point of a dedicated
    // endpoint is that the server decides what's a legal binding, not whatever the client asserts.
    const unknownBooks = requested.filter(name => !fs.existsSync(getWorldInfoPaths(request.user.directories, name).pathToWorldInfo));
    if (unknownBooks.length > 0) {
        return response.status(404).send({ result: 'error', error: 'Unknown World(s)', unknownBooks });
    }

    const path_ = 'world_info_settings.charLore';
    const current = readSettingsAtPaths(request.user.directories, [path_])[path_];
    const charLore = Array.isArray(current) ? current : [];
    const idx = charLore.findIndex(e => e?.name === characterAvatar);
    const existingBooks = idx !== -1 && Array.isArray(charLore[idx].extraBooks) ? charLore[idx].extraBooks : [];

    let nextBooks;
    if (op === 'add') nextBooks = [...new Set([...existingBooks, ...requested])];
    else if (op === 'remove') nextBooks = existingBooks.filter(b => !requested.includes(b));
    else nextBooks = [...new Set(requested)];

    const nextCharLore = [...charLore];
    if (nextBooks.length === 0) {
        if (idx !== -1) nextCharLore.splice(idx, 1);
    } else if (idx === -1) {
        nextCharLore.push({ name: characterAvatar, extraBooks: nextBooks });
    } else {
        nextCharLore[idx] = { ...nextCharLore[idx], extraBooks: nextBooks };
    }

    writeSettingsKeys(request.user.directories, { [path_]: nextCharLore });
    return response.send({ result: 'ok', extraBooks: nextBooks });
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

/**
 * Writes a raw World Info JSON blob to disk under the given user's worlds directory, deriving
 * the World's name from desiredName the same way the /import route does. Shared so other
 * endpoints (e.g. content-manager's Chub linked-lorebook import) can persist a World server-side
 * without a client round-trip through /import for bytes the server already fetched itself.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} desiredName Filename (with or without extension) to derive the World's name from
 * @param {string} fileContents Raw World Info JSON text; must contain an `entries` key
 * @returns {string} The written World's name
 */
export function importWorldInfoFromRaw(directories, desiredName, fileContents) {
    const filename = `${path.parse(sanitize(desiredName)).name}.json`;

    const worldContent = JSON.parse(fileContents);
    if (!('entries' in worldContent)) {
        throw new Error('File must contain a world info entries list');
    }

    const pathToNewFile = path.join(directories.worlds, filename);
    const worldName = path.parse(pathToNewFile).name;

    if (!worldName) {
        throw new Error('World file must have a name');
    }

    // Legacy format written directly, so clear any orphaned sidecar directory from a prior migration.
    const { entriesDir } = getWorldInfoPaths(directories, worldName);
    if (fs.existsSync(entriesDir)) {
        fs.rmSync(entriesDir, { recursive: true, force: true });
    }

    writeFileAtomicSync(pathToNewFile, fileContents);
    return worldName;
}

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
        const worldName = importWorldInfoFromRaw(request.user.directories, filename, fileContents);
        return response.send({ name: worldName });
    } catch (err) {
        return response.status(400).send(err instanceof Error ? err.message : 'Is not a valid world info file');
    }
});

/**
 * Creates a brand-new, empty World Info file, minting the real unique name server-side against
 * on-disk state instead of trusting a client-computed one against a possibly-stale cached copy of
 * `world_names` - the same "server owns identity" principle as /entry/create's uid minting above.
 * Mirrors this codebase's existing "<name> (<N>)" numbered-suffix convention for World Info names
 * (see the client's own getUniqueName()/getFreeWorldName() helpers), not the unrelated
 * "<name> - Branch #<N>" scheme used for chat branches.
 *
 * - `name` omitted or blank: defaults to "New World", then uniquified as below.
 * - `name` given and `unique` is not explicitly `false` (the default): uniquified against real
 *   on-disk names by appending " (<N>)" - the right behavior whenever the client is generating a
 *   name behind the scenes with no user-visible collision prompt of its own.
 * - `name` given and `unique === false`: the caller already has its own explicit-name semantics
 *   (e.g. a name a user typed with its own overwrite-confirmation UI) and wants an exact name or a
 *   clear error, not a silent rename - a taken name 409s instead.
 */
router.post('/create', (request, response) => {
    const { name, unique = true } = request.body ?? {};
    if (name !== undefined && typeof name !== 'string') {
        return response.status(400).send({ error: 'name must be a string' });
    }

    const baseName = (typeof name === 'string' && name.trim()) ? name.trim() : 'New World';
    const exists = (candidate) => fs.existsSync(getWorldInfoPaths(request.user.directories, candidate).pathToWorldInfo);

    let finalName = baseName;
    if (unique === false) {
        if (exists(finalName)) {
            return response.status(409).send({ error: `World Info file '${finalName}' already exists` });
        }
    } else {
        const MAX_TRIES = 100_000;
        for (let i = 1; exists(finalName); i++) {
            if (i > MAX_TRIES) {
                return response.status(500).send({ error: 'Could not allocate a unique World Info name' });
            }
            finalName = `${baseName} (${i})`;
        }
    }

    writeWorldInfoFile(request.user.directories, finalName, { entries: {} });

    return response.send({ ok: true, name: finalName });
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

/**
 * Moves (or copies) a single World Info entry from one lorebook to another, server-side, in one
 * request. Replaces the former client-side flow of loading both whole books, minting a new uid by
 * scanning the target book's entries in local memory, splicing the entry between the two in-memory
 * copies, and issuing two separate whole-book /edit POSTs - which left a client-visible race window
 * between the two saves (a crash/reload between them could leave the entry duplicated in both books,
 * or missing from both).
 *
 * Atomicity: this is sequential-but-server-side, NOT a single filesystem transaction. Both books are
 * written (via the same writeWorldInfoFile() used by /edit, itself a series of per-entry
 * write-file-atomic calls plus a manifest write) inside one synchronous handler, so no client-visible
 * intermediate state exists - the client only ever sees "not yet requested" or "done" - and the whole
 * network-round-trip-sized race window from the old two-request flow is eliminated. It does NOT
 * protect against the server process crashing mid-handler between the target write and the source
 * write (when delete_original is set): in that narrow in-process window the entry could still end up
 * in both books or - if the crash lands before the target write completes - the source deletion simply
 * never happens (delete_original writes source only after target succeeds), so at worst the operation
 * is left un-applied, never half-applied with the entry missing from both.
 *
 * Note on inter-entry linkage: World Info entries have no uid-based reference to other entries. The
 * `group` field is a plain string label matched at runtime among currently-activated entries (from any
 * book), not an identifier of a specific entry; `automationId` refers to an external Quick Reply
 * automation, not another WI entry. So transplanting one entry cannot orphan a reference from another
 * entry in either book - there is nothing that structurally requires two entries to travel together.
 */
router.post('/entry/transplant', (request, response) => {
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

    const deleteOriginal = delete_original !== false;
    const sourceUid = String(uid);

    const sourceData = readWorldInfoFile(request.user.directories, source_name, false);
    if (!sourceData || typeof sourceData.entries !== 'object' || sourceData.entries === null) {
        return response.status(404).send({ error: `Source lorebook '${source_name}' not found` });
    }

    const targetData = readWorldInfoFile(request.user.directories, target_name, false);
    if (!targetData || typeof targetData.entries !== 'object' || targetData.entries === null) {
        return response.status(404).send({ error: `Target lorebook '${target_name}' not found` });
    }

    if (!(sourceUid in sourceData.entries)) {
        return response.status(404).send({ error: `Entry uid '${sourceUid}' not found in source lorebook '${source_name}'` });
    }

    const newUid = getFreeWorldEntryUid(targetData);
    if (newUid === null) {
        return response.status(500).send({ error: `Could not allocate a free uid in target lorebook '${target_name}'` });
    }

    const transplantedEntry = _.cloneDeep(sourceData.entries[sourceUid]);
    transplantedEntry.uid = newUid;

    // Place the entry at the end of the target lorebook, mirroring the client's prior placement decision.
    const maxDisplayIndex = Object.values(targetData.entries).reduce((max, entry) => Math.max(max, entry?.displayIndex ?? -1), -1);
    transplantedEntry.displayIndex = maxDisplayIndex + 1;

    targetData.entries[newUid] = transplantedEntry;

    // Target write happens first: if the process dies before this completes, nothing has changed in
    // either book, so the operation is un-applied rather than half-applied.
    writeWorldInfoFile(request.user.directories, target_name, targetData);

    if (deleteOriginal) {
        delete sourceData.entries[sourceUid];
        writeWorldInfoFile(request.user.directories, source_name, sourceData);
    }

    return response.send({ ok: true, entry: transplantedEntry });
});

/**
 * Mints a uid for a brand-new World Info entry and reserves it in the given lorebook, server-side, in
 * one request. Replaces the former client-side flow of scanning the client's own cached copy of
 * `data.entries` for the lowest free integer and asserting it as the new entry's uid - a fabricated
 * identifier that could collide if the client's cache were stale (e.g. another tab, or a concurrent
 * move/copy into the same book, had already taken that uid on disk).
 *
 * This is structurally the same case `/entry/transplant` already solves (mint a free uid in a target
 * book via {@link getFreeWorldEntryUid}, immediately before writing), just without a source book to
 * pull from. Only a bare `{ uid }` placeholder is written here - the caller is expected to fill in the
 * entry's real fields (key, content, comment, ...) locally and persist them via the existing whole-book
 * `/edit` save shortly after, the same way a freshly-created entry's fields have always been populated.
 * Reserving the uid on disk immediately (rather than merely computing and returning one) is what
 * prevents two concurrent "create new entry" calls against the same book from ever being handed the
 * same uid.
 */
router.post('/entry/create', (request, response) => {
    const { name } = request.body ?? {};

    if (typeof name !== 'string' || !name) {
        return response.status(400).send({ error: 'name is required' });
    }

    const data = readWorldInfoFile(request.user.directories, name, false);
    if (!data || typeof data.entries !== 'object' || data.entries === null) {
        return response.status(404).send({ error: `Lorebook '${name}' not found` });
    }

    const newUid = getFreeWorldEntryUid(data);
    if (newUid === null) {
        return response.status(500).send({ error: `Could not allocate a free uid in lorebook '${name}'` });
    }

    const newEntry = { uid: newUid };
    data.entries[newUid] = newEntry;
    writeWorldInfoFile(request.user.directories, name, data);

    return response.send({ ok: true, entry: newEntry });
});
