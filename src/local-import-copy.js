import fs from 'node:fs';
import fsPromises from 'node:fs/promises';

import { getConfigValue } from './util.js';

/**
 * @typedef {'reflink' | 'hardlink' | 'copy'} CopyMethod
 */

/**
 * @typedef {Object} CopyCharacterFileResult
 * @property {CopyMethod} method Which strategy actually produced the file at `targetPath`.
 */

/**
 * Lazily-loaded `@reflink/reflink` native binding, memoized across calls.
 * @type {Promise<null | { reflinkFile: (src: string, dst: string) => Promise<number> }>|null}
 */
let reflinkModulePromise = null;

/**
 * Loads the `@reflink/reflink` native binding on first use. This is a NAPI-RS binding that ships
 * one prebuilt binary per platform/arch/libc combination as an optional dependency - on a
 * combination it doesn't ship a binary for, `require`-ing it throws *synchronously at module load*
 * (see its `binding.js`). A static top-level `import` of that package would therefore crash every
 * process that pulls this module in on an unsupported platform, not just local-import users, so it's
 * loaded dynamically behind a try/catch instead, and only the first call pays the load cost - later
 * calls reuse the memoized result (including a memoized "unavailable" outcome).
 * @returns {Promise<null | { reflinkFile: (src: string, dst: string) => Promise<number> }>}
 */
function loadReflinkModule() {
    if (!reflinkModulePromise) {
        reflinkModulePromise = import('@reflink/reflink').catch((/** @type {any} */ error) => {
            console.debug('local-import-copy: @reflink/reflink native binding is unavailable on this platform, falling back to hardlink/copy.', error?.message ?? error);
            return null;
        });
    }
    return reflinkModulePromise;
}

/**
 * Copies a character file from `sourcePath` to `targetPath` using the cheapest strategy the
 * filesystem allows, in order:
 *   1. reflink (copy-on-write clone via `@reflink/reflink`) - near-zero cost, same-filesystem,
 *      COW-capable filesystems only (e.g. btrfs, XFS with reflink support, APFS).
 *   2. hardlink (`fs.link`) - near-zero cost, same-filesystem only.
 *   3. plain copy (`fs.copyFile`) - full disk cost, works across filesystems/devices. Only used if
 *      `localImport.allowCrossDeviceCopyFallback` (default `true`) allows it; otherwise the error
 *      from the hardlink attempt propagates instead of silently paying the full copy cost.
 *
 * `targetPath` must not already exist - all three strategies fail loudly (`EEXIST`) rather than
 * overwrite an existing file, so this function never silently clobbers something already at
 * `targetPath`.
 *
 * This function does no COW/link-count detection of its own. A hardlinked copy stays safe from
 * being clobbered by a later edit to the character it was linked from (or vice versa) only because
 * every character-data write path in this codebase writes through `write-file-atomic` (temp file +
 * rename), which always produces a fresh inode instead of mutating file content in place - see the
 * write-path audit this module shipped alongside (2026-08 local-import work) for the file-by-file
 * confirmation.
 * @param {string} sourcePath Absolute path to the source character file (outside this codebase's managed directories).
 * @param {string} targetPath Absolute path to the destination character file. Must not already exist.
 * @returns {Promise<CopyCharacterFileResult>} Which method produced the file.
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
