import fs from 'node:fs';
import fsPromises from 'node:fs/promises';

import { getConfigValue } from './util.js';
import { loadReflinkModule } from './reflink-support.js';

/** @typedef {'reflink' | 'hardlink' | 'copy'} CopyMethod */

/**
 * @typedef {Object} CopyCharacterFileResult
 * @property {CopyMethod} method
 */

/**
 * @param {string} sourcePath
 * @param {string} targetPath
 * @param {boolean|null} [allowCrossDeviceCopyFallback]
 * @param {{ hardlink?: boolean }} [options]
 */
export async function copyCharacterFile(sourcePath, targetPath, allowCrossDeviceCopyFallback = null, { hardlink = true } = {}) {
    const reflinkModule = await loadReflinkModule();
    if (reflinkModule) {
        try {
            await reflinkModule.reflinkFile(sourcePath, targetPath);
            return { method: 'reflink' };
        } catch (error) {
            console.debug(`local-import-copy: reflink failed for ${sourcePath} -> ${targetPath}, trying hardlink.`, /** @type {any} */ (error)?.message ?? error);
        }
    }

    if (hardlink) {
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
    }

    await fsPromises.copyFile(sourcePath, targetPath, fs.constants.COPYFILE_EXCL);
    return { method: 'copy' };
}
