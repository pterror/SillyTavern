import path from 'node:path';

import sanitize from 'sanitize-filename';

import { settingsDocumentOf } from './settings-documents.js';
import { deleteBundleFile, listBundleFiles, readBundleFile, renameBundleFile, writeBundleFile } from './bundle-files.js';
import { userStore } from './user-stores.js';
import { readDraft, writeDrafts } from './settings-model/model-store.js';
import { bundleDraftOf, bundleEntityOf, bundleFileFromStore } from './settings-model/bundle-import.js';
import { userConnections } from './settings-model/settings-compat.js';
import { keyOf } from './settings-model/keys.js';

/**
 * The bundles (sampler presets, templates, themes, quick reply sets) as the routes read and write them: the
 * settings model's entities once the user's settings document is open (settings-document.js), else their files
 * (bundle-files.js). A name is the file name it was (sanitized), so a route answers the name it always did.
 */

/**
 * @param {import('./users.js').UserDirectoryList} directories
 */
async function modelOf(directories) {
    const document = settingsDocumentOf(directories);
    if (!document) return null;
    const { lib } = await userStore(directories);
    return { lib, model: document.model(), handle: path.basename(directories.root) };
}

/**
 * @param {unknown} name
 */
function safeName(name) {
    return typeof name === 'string' ? sanitize(name) : '';
}

/**
 * A bundle's upstream file; null when there's none.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} group
 * @param {unknown} name
 * @returns {Promise<Record<string, any> | null>}
 */
export async function readBundle(directories, group, name) {
    const at = await modelOf(directories);
    if (!at) return readBundleFile(directories, group, name);
    const safe = safeName(name);
    if (!safe) return null;
    return (await bundleFileFromStore(at.lib, group, safe, userConnections(at.model))) ?? null;
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} group
 * @param {unknown} name
 * @param {unknown} content
 * @returns {Promise<string | undefined>} The name it was written under, or undefined when it can't be.
 */
export async function writeBundle(directories, group, name, content) {
    const at = await modelOf(directories);
    if (!at) return writeBundleFile(directories, group, name, content);
    const safe = safeName(name);
    if (!safe || !content || typeof content !== 'object') return undefined;
    const made = bundleDraftOf(group, safe, /** @type {Record<string, any>} */ (content), userConnections(at.model), hint => keyOf(at.handle, hint));
    if (!made) return undefined;
    for (const warning of made.warnings) console.warn(`[settings] ${at.handle}: ${warning}`);
    await writeDrafts(at.lib, made.drafts);
    return safe;
}

/**
 * The entity of a bundle and each of its parts, as stored.
 * @param {import('./library-engine.js').LibraryEngine} lib
 * @param {string} group
 * @param {string} name
 */
async function storedWithParts(lib, group, name) {
    const entity = bundleEntityOf(group, name);
    if (!entity) return null;
    const holder = await readDraft(lib, entity.type, entity.key);
    if (!holder) return null;
    /** @type {{ type: number, key: string }[]} */
    const all = [];
    const visit = (/** @type {import('./settings-model/entity-draft.js').EntityDraft} */ d) => {
        all.push({ type: d.type, key: d.key });
        for (const item of Object.values(d.lists ?? {}).flat()) if (typeof item === 'object') visit(item);
    };
    visit(holder);
    return all;
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} group
 * @param {unknown} name
 * @returns {Promise<boolean>} Whether there was one.
 */
export async function deleteBundle(directories, group, name) {
    const at = await modelOf(directories);
    if (!at) return deleteBundleFile(directories, group, name);
    const all = await storedWithParts(at.lib, group, safeName(name));
    if (!all) return false;
    const ids = await at.lib.store.libraryIds(all.map(e => [e.type, e.key]));
    /** @type {object[]} */
    const records = [];
    const stamp = await at.lib.stamper(null, records);
    for (const id of ids) if (id !== null) records.push({ kind: 'histEntityDelete', entity: id, ...stamp() });
    await at.lib.store.commit(records);
    return true;
}

/**
 * Renames a bundle: its key and its parts' change, so what refers to it follows.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} group
 * @param {unknown} name
 * @param {unknown} newName
 * @returns {Promise<'renamed' | 'missing' | 'taken' | 'invalid'>}
 */
export async function renameBundle(directories, group, name, newName) {
    const at = await modelOf(directories);
    if (!at) return renameBundleFile(directories, group, name, newName);
    const from = bundleEntityOf(group, safeName(name));
    const to = bundleEntityOf(group, safeName(newName));
    if (!from || !to || !safeName(name) || !safeName(newName)) return 'invalid';
    const all = await storedWithParts(at.lib, group, safeName(name));
    if (!all) return 'missing';
    if (await readDraft(at.lib, to.type, to.key)) return 'taken';
    for (const e of all) {
        const key = e.key === from.key ? to.key : `${to.key}${e.key.slice(from.key.length)}`;
        // The bundle first: a key taken (by a ref's placeholder) refuses it before any part moves.
        if (!(await at.lib.updateEntity(e.type, e.key, { key })) && e.key === from.key) return 'taken';
    }
    return 'renamed';
}

/**
 * Every bundle of a group, by name: its file's text (as it would be stored) and its parse.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} group
 * @param {{ order?: 'locale' | 'code' }} [options]
 * @returns {Promise<{ name: string, text: string, file: any }[]>}
 */
export async function listBundles(directories, group, { order = 'code' } = {}) {
    const at = await modelOf(directories);
    if (!at) return listBundleFiles(directories, group, { order });
    const probe = bundleEntityOf(group, '');
    if (!probe) return [];
    /** @type {string[]} */
    const names = [];
    let after = null;
    for (;;) {
        const { entities, more } = await at.lib.store.libraryOfType(probe.type, after, 500);
        for (const e of entities) if (e.key.startsWith(probe.key)) names.push(e.key.slice(probe.key.length));
        if (!more || entities.length === 0) break;
        after = entities[entities.length - 1].key;
    }
    names.sort(order === 'locale' ? (a, b) => a.localeCompare(b) : undefined);
    const connections = userConnections(at.model);
    /** @type {{ name: string, text: string, file: any }[]} */
    const listed = [];
    for (const name of names) {
        const file = await bundleFileFromStore(at.lib, group, name, connections);
        if (file) listed.push({ name, text: JSON.stringify(file, null, 4), file });
    }
    return listed;
}
