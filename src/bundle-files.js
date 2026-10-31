import fs from 'node:fs';
import path from 'node:path';

import sanitize from 'sanitize-filename';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

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
 * @returns {string | undefined}
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
 * @returns {boolean}
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
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} group
 * @param {{ order?: 'locale' | 'code', skipped?: (file: string) => void }} [options]
 * @returns {{ name: string, text: string, file: any }[]}
 */
export function listBundleFiles(directories, group, { order = 'code', skipped } = {}) {
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
            if (skipped) skipped(path.join(folder, item));
            else console.warn(`${item} is not a valid JSON`);
        }
    }
    return listed;
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {import('./settings-model/settings-compat.js').BundleFiles}
 */
export function bundleFilesOf(directories) {
    return (group, name) => readBundleFile(directories, group, name) ?? undefined;
}
