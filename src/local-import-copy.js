import fs from 'node:fs';
import fsPromises from 'node:fs/promises';

import { getConfigValue } from './util.js';
import { loadReflinkModule } from './reflink-support.js';

/**
 * @typedef {'reflink' | 'hardlink' | 'copy'} CopyMethod
 */

/**
 * @typedef {Object} CopyCharacterFileResult
 * @property {CopyMethod} method Which strategy actually produced the file at `targetPath`.
 */

/**
 * Tries reflink, then hardlink, then plain copy. `targetPath` must not already exist.
 * Hardlinks stay safe only because every character-data write path uses write-file-atomic (temp file + rename), never in-place mutation.
 */
export async function copyCharacterFile(sourcePath, targetPath) {
    const reflinkModule = await loadReflinkModule();
    if (reflinkModule) {
        try {
            await reflinkModule.reflinkFile(sourcePath, targetPath);
            return { method: 'reflink' };
        } catch (error) {
            console.debug(`local-import-copy: reflink failed for ${sourcePath} -> ${targetPath}, trying hardlink.`, /** @type {any} */ (error)?.message ?? error);
        }
    }

    try {
        await fsPromises.link(sourcePath, targetPath);
        return { method: 'hardlink' };
    } catch (/** @type {any} */ error) {
        if (error?.code === 'EEXIST') {
            throw error;
        }

        const allowCrossDeviceCopyFallback = getConfigValue('localImport.allowCrossDeviceCopyFallback', true, 'boolean');
        if (!allowCrossDeviceCopyFallback) {
            throw error;
        }

        console.debug(`local-import-copy: hardlink failed for ${sourcePath} -> ${targetPath} (${error?.code ?? error}), falling back to a full copy.`);
    }

    await fsPromises.copyFile(sourcePath, targetPath, fs.constants.COPYFILE_EXCL);
    return { method: 'copy' };
}
