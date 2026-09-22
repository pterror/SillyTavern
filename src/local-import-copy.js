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
 * @param {string} sourcePath
 * @param {string} targetPath
 * @param {boolean|null} [allowCrossDeviceCopyFallback] `localImport.allowCrossDeviceCopyFallback`, pre-resolved
 * by the caller - `getConfigValue()` reads main-thread-only state, so a worker_threads caller (which can't call
 * it directly) must resolve this on the main thread and pass it in; `null` (the default) looks it up here,
 * for every other, main-thread caller.
 */
export async function copyCharacterFile(sourcePath, targetPath, allowCrossDeviceCopyFallback = null) {
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

        const allowFallback = allowCrossDeviceCopyFallback ?? getConfigValue('localImport.allowCrossDeviceCopyFallback', true, 'boolean');
        if (!allowFallback) {
            throw error;
        }

        console.debug(`local-import-copy: hardlink failed for ${sourcePath} -> ${targetPath} (${error?.code ?? error}), falling back to a full copy.`);
    }

    await fsPromises.copyFile(sourcePath, targetPath, fs.constants.COPYFILE_EXCL);
    return { method: 'copy' };
}
