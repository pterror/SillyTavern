import fs from 'node:fs';
import path from 'node:path';

import writeFileAtomic from 'write-file-atomic';

import { uuidv4 } from './util.js';

const METADATA_DIR = 'image-metadata';
const FOLDERS_FILE = 'folders.json';
const LEGACY_FILE = 'image-metadata.json';
const BACKGROUNDS = 'backgrounds/';

/**
 * @typedef {{ id: string, name: string, thumbnailFile: string }} BackgroundFolder
 */

/**
 * @param {string} root
 */
const foldersPath = root => path.join(root, METADATA_DIR, FOLDERS_FILE);

/**
 * @param {string} root
 * @returns {Promise<BackgroundFolder[]>}
 */
export async function readFolders(root) {
    try {
        const parsed = JSON.parse(await fs.promises.readFile(foldersPath(root), 'utf8'));
        if (Array.isArray(parsed)) return parsed;
    } catch {
        // No folders yet.
    }
    const legacy = readLegacy(root);
    return Array.isArray(legacy?.folders) ? legacy.folders : [];
}

/**
 * @param {string} root
 * @param {BackgroundFolder[]} folders
 */
async function writeFolders(root, folders) {
    await fs.promises.mkdir(path.join(root, METADATA_DIR), { recursive: true });
    await writeFileAtomic(foldersPath(root), JSON.stringify(folders, null, 4), 'utf8');
}

/**
 * @param {string} root
 * @param {string} name
 */
export async function createFolder(root, name) {
    const folders = await readFolders(root);
    const folder = { id: uuidv4(), name, thumbnailFile: '' };
    await writeFolders(root, [...folders, folder]);
    return folder;
}

/**
 * @param {string} root
 * @param {string} id
 * @param {{ name?: string, thumbnailFile?: string }} change
 */
export async function updateFolder(root, id, change) {
    const folders = await readFolders(root);
    const folder = folders.find(f => f.id === id);
    if (!folder) throw new Error(`Folder '${id}' not found.`);
    if (change.name !== undefined) folder.name = change.name;
    if (change.thumbnailFile !== undefined) folder.thumbnailFile = change.thumbnailFile;
    await writeFolders(root, folders);
}

/**
 * @param {string} root
 * @param {string} id
 */
export async function deleteFolder(root, id) {
    const folders = await readFolders(root);
    if (!folders.some(f => f.id === id)) throw new Error(`Folder '${id}' not found.`);
    await writeFolders(root, folders.filter(f => f.id !== id));
}

/**
 * @param {string} root
 * @param {string} from
 * @param {string} to
 */
export async function retargetCovers(root, from, to) {
    const folders = await readFolders(root);
    if (!folders.some(f => f.thumbnailFile === from)) return;
    await writeFolders(root, folders.map(f => (f.thumbnailFile === from ? { ...f, thumbnailFile: to } : f)));
}

/**
 * @param {string} root
 * @returns {{ images?: Record<string, { folderIds?: unknown }>, folders?: BackgroundFolder[] } | null}
 */
function readLegacy(root) {
    for (const name of [LEGACY_FILE, `${LEGACY_FILE}.migrated`]) {
        try {
            return JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
        } catch {
            // Not there.
        }
    }
    return null;
}

/**
 * @param {string} root
 * @returns {Map<string, string[]>}
 */
export function storedFolderIds(root) {
    /** @type {Map<string, string[]>} */
    const out = new Map();
    const take = (/** @type {string} */ file, /** @type {unknown} */ ids) => {
        if (Array.isArray(ids)) out.set(file, ids.filter(id => typeof id === 'string'));
    };
    for (const [relative, meta] of Object.entries(readLegacy(root)?.images ?? {})) {
        const posix = relative.replaceAll('\\', '/');
        if (posix.startsWith(BACKGROUNDS)) take(posix.slice(BACKGROUNDS.length), meta?.folderIds);
    }
    const dir = path.join(root, METADATA_DIR, 'images', 'backgrounds');
    for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
        if (!name.endsWith('.json')) continue;
        try {
            take(name.slice(0, -'.json'.length), JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))?.folderIds);
        } catch {
            // An unreadable file names no folders.
        }
    }
    return out;
}

/**
 * @param {string} root
 */
export function removeImageMetadataFiles(root) {
    fs.rmSync(path.join(root, METADATA_DIR, 'images'), { recursive: true, force: true });
}
