import fs from 'node:fs';

import { color, generateTimestamp } from './util.js';

export const DEFAULT_TAG_NAMES = ['Plain Text', 'OpenAI', 'W++', 'Boostyle', 'PList', 'AliChat'];

/**
 * @param {string} filePath
 * @returns {{ missing: true } | { error: string } | { text: string, value: unknown }}
 */
export function readSettingsTagsSource(filePath) {
    let text;
    try {
        text = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
        if (/** @type {any} */ (err)?.code === 'ENOENT') return { missing: true };
        return { error: String(/** @type {any} */ (err)?.message ?? err) };
    }
    try {
        return { text, value: JSON.parse(text) };
    } catch (err) {
        return { error: String(/** @type {any} */ (err)?.message ?? err) };
    }
}

/**
 * @param {string} filePath
 * @param {string} importedText
 * @returns {boolean}
 */
export function moveImportedSettingsFile(filePath, importedText) {
    const current = readSettingsTagsSource(filePath);
    if ('missing' in current) return true;
    if (!('text' in current) || current.text !== importedText) {
        console.warn(color.yellow(`[character-metadata] ${filePath} changed after it was imported; left in place, imported again next boot.`));
        return false;
    }
    const stamp = generateTimestamp();
    for (let attempt = 0; ; attempt++) {
        const target = attempt === 0 ? `${filePath}.migrated` : `${filePath}.migrated-${stamp}${attempt > 1 ? `-${attempt}` : ''}`;
        try {
            fs.copyFileSync(filePath, target, fs.constants.COPYFILE_EXCL);
        } catch (err) {
            const code = /** @type {any} */ (err)?.code;
            if (code === 'EEXIST') continue;
            if (code === 'ENOENT') return true;
            console.error(`[character-metadata] Imported ${filePath} but could not copy it to ${target}; left in place:`, /** @type {any} */ (err)?.message);
            return false;
        }
        try {
            if (fs.readFileSync(target, 'utf8') !== importedText || fs.readFileSync(filePath, 'utf8') !== importedText) {
                fs.rmSync(target, { force: true });
                console.warn(color.yellow(`[character-metadata] ${filePath} changed after it was imported; left in place, imported again next boot.`));
                return false;
            }
            fs.rmSync(filePath);
        } catch (err) {
            console.error(`[character-metadata] Imported ${filePath} and copied it to ${target}, but could not remove it; left in place:`, /** @type {any} */ (err)?.message);
            return false;
        }
        return true;
    }
}
