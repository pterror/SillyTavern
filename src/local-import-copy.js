import fs from 'node:fs';
import fsPromises from 'node:fs/promises';

import { getConfigValue } from './util.js';

/** @type {Promise<null | { reflinkFile: (src: string, dst: string) => Promise<number> }> | null} */
let reflinkModule = null;

/**
 * A copy-on-write clone where the filesystem has them; none of its callers can tell how the file got there.
 * @param {string} sourcePath
 * @param {string} targetPath
 * @returns {Promise<boolean>} Whether the file was cloned.
 */
async function tryReflink(sourcePath, targetPath) {
    reflinkModule ??= import('@reflink/reflink').catch((/** @type {any} */ error) => {
        console.debug('local-import-copy: @reflink/reflink native binding is unavailable on this platform.', error?.message ?? error);
        return null;
    });
    const module = await reflinkModule;
    if (!module) return false;
    try {
        await module.reflinkFile(sourcePath, targetPath);
        return true;
    } catch (error) {
        console.debug(`local-import-copy: reflink failed for ${sourcePath} -> ${targetPath}.`, /** @type {any} */ (error)?.message ?? error);
        return false;
    }
}

/**
 * Puts the source's bytes, as they are, at the target: a clone, else a hardlink (when allowed), else a copy.
 * @param {string} sourcePath
 * @param {string} targetPath
 * @param {boolean|null} [allowCrossDeviceCopyFallback]
 * @param {{ hardlink?: boolean }} [options]
 * @returns {Promise<void>}
 */
export async function copyCharacterFile(sourcePath, targetPath, allowCrossDeviceCopyFallback = null, { hardlink = true } = {}) {
    if (await tryReflink(sourcePath, targetPath)) return;

    if (hardlink) {
        try {
            await fsPromises.link(sourcePath, targetPath);
            return;
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
}
