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

// NOTE: this module used to also export hardlinkOntoCanonical(sourcePath, targetPath), which replaced a
// duplicate SOURCE file's own directory entry in place with a hardlink to the canonical already-imported
// character file. It was removed (2026-08 real-corpus investigation) because that direction is backwards
// for this feature's actual purpose: `sourcePath` here is a file inside the user's own external,
// supposedly-immutable source archive, and hardlinking it onto `targetPath` destroys the archive file's
// independent identity - its own inode is gone, replaced by one shared with (and thereafter vulnerable to
// mutation from) the app-managed canonical file. Confirmed against a real ~300k-file archive: tens of
// thousands of source files already had their own directory entry replaced this way, silently, by this
// function. local-import-scan.js's maybeReflinkDuplicateTarget() now uses
// character-card-parser.js's reclaimReflinkPrefix() instead, which only ever reflinks the CANONICAL file
// (inside this install's own data directory) to share extents with the source - `sourcePath`'s own
// directory entry/inode is never opened for writing, so the archive stays genuinely untouched.
