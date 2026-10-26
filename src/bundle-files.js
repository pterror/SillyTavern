import fs from 'node:fs';
import path from 'node:path';

import sanitize from 'sanitize-filename';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

/**
 * The bundles' files (the settings model, step 7): sampler presets by API family, templates, themes and quick reply
 * sets, each a JSON file named by the bundle in its group's folder. Every route that reads or writes one goes
 * through here, and so does the compat edge's `bundles` (settings-compat.js); the model's switch (its step 10)
 * changes these and nothing else.
 */

/** Each group's folder, a user directories key. */
export const BUNDLE_FOLDERS = Object.freeze({
    'preset.openai': 'openAI_Settings',
    'preset.textgenerationwebui': 'textGen_Settings',
    'preset.novel': 'novelAI_Settings',
    'preset.kobold': 'koboldAI_Settings',
    'template.instruct': 'instruct',
    'template.context': 'context',
    'template.sysprompt': 'sysprompt',
    'template.reasoning': 'reasoning',
    'theme': 'themes',
    'quickReplies': 'quickreplies',
});

const EXTENSION = '.json';

/**
 * The group of an upstream preset API id (`/api/presets/*`'s `apiId`), or undefined for none.
 * @param {unknown} apiId
 * @returns {keyof typeof BUNDLE_FOLDERS | undefined}
 */
export function groupOfApi(apiId) {
    switch (apiId) {
        case 'kobold':
        case 'koboldhorde':
            return 'preset.kobold';
        case 'novel':
        case 'openai':
        case 'textgenerationwebui':
            return `preset.${apiId}`;
        case 'instruct':
        case 'context':
        case 'sysprompt':
        case 'reasoning':
            return `template.${apiId}`;
        default:
            return undefined;
    }
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} group
 */
export function bundleFolder(directories, group) {
    const key = BUNDLE_FOLDERS[group];
    return key ? directories[key] : undefined;
}

/**
 * A bundle's file path, its name sanitized; undefined for a group or name there can't be.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} group
 * @param {unknown} name
 */
export function bundleFilePath(directories, group, name) {
    const folder = bundleFolder(directories, group);
    const safe = typeof name === 'string' ? sanitize(name) : '';
    return folder && safe ? path.join(folder, `${safe}${EXTENSION}`) : undefined;
}

/**
 * A bundle's file, parsed; null when there's none or it isn't JSON.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} group
 * @param {unknown} name
 * @returns {Record<string, any> | null}
 */
export function readBundleFile(directories, group, name) {
    const file = bundleFilePath(directories, group, name);
    if (!file || !fs.existsSync(file)) return null;
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} group
 * @param {unknown} name
 * @param {unknown} content
 * @returns {string | undefined} The name it was written under (sanitized), or undefined when it can't be.
 */
export function writeBundleFile(directories, group, name, content) {
    const file = bundleFilePath(directories, group, name);
    if (!file) return undefined;
    writeFileAtomicSync(file, JSON.stringify(content, null, 4), 'utf8');
    return path.basename(file, EXTENSION);
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} group
 * @param {unknown} name
 * @returns {boolean} Whether there was one.
 */
export function deleteBundleFile(directories, group, name) {
    const file = bundleFilePath(directories, group, name);
    if (!file || !fs.existsSync(file)) return false;
    fs.unlinkSync(file);
    return true;
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} group
 * @param {unknown} name
 * @param {unknown} newName
 * @returns {'renamed' | 'missing' | 'taken' | 'invalid'}
 */
export function renameBundleFile(directories, group, name, newName) {
    const from = bundleFilePath(directories, group, name);
    const to = bundleFilePath(directories, group, newName);
    if (!from || !to) return 'invalid';
    if (!fs.existsSync(from)) return 'missing';
    if (fs.existsSync(to)) return 'taken';
    fs.renameSync(from, to);
    return 'renamed';
}

/**
 * Every bundle file of a group that is JSON, by name: its text as stored and its parse. A file that isn't JSON is
 * left out, warned.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} group
 * @param {{ order?: 'locale' | 'code' }} [options] How the file names sort: by locale (the presets' order) or by
 *   code unit (the templates', themes' and quick reply sets').
 * @returns {{ name: string, text: string, file: any }[]}
 */
export function listBundleFiles(directories, group, { order = 'code' } = {}) {
    const folder = bundleFolder(directories, group);
    if (!folder) return [];
    const names = fs.readdirSync(folder).filter(item => path.parse(item).ext === EXTENSION);
    names.sort(order === 'locale' ? (a, b) => a.localeCompare(b) : undefined);
    /** @type {{ name: string, text: string, file: any }[]} */
    const listed = [];
    for (const item of names) {
        try {
            const text = fs.readFileSync(path.join(folder, item), 'utf8');
            listed.push({ name: item.slice(0, -EXTENSION.length), text, file: JSON.parse(text) });
        } catch {
            console.warn(`${item} is not a valid JSON`);
        }
    }
    return listed;
}

/**
 * The compat edge's view of the user's bundle files.
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {import('./settings-model/settings-compat.js').BundleFiles}
 */
export function bundleFilesOf(directories) {
    return (group, name) => readBundleFile(directories, group, name) ?? undefined;
}
