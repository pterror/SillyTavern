import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import crypto from 'node:crypto';

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

/**
 * Replaces `sourcePath`'s content IN PLACE with a hardlink to `targetPath` - used by the local-import
 * scan's opt-in `localImport.hardlinkDuplicateSourceFiles` feature to deduplicate a scanned source
 * directory itself once a file in it is confirmed to be a byte-identical duplicate of an
 * already-imported character (see local-import-scan.js's caller for that confirmation).
 *
 * Can't just `fs.link(targetPath, sourcePath)` directly - like copyCharacterFile() above, `fs.link`
 * fails loudly (EEXIST) against a path that already exists, and `sourcePath` legitimately already
 * exists here (it's the duplicate file being replaced, not created fresh). Instead: hardlink to a
 * fresh temp path next to `sourcePath` (guaranteed same directory, hence same filesystem, as
 * `sourcePath`, so the follow-up rename is atomic), then `fsPromises.rename()` that temp path over
 * `sourcePath`. A same-filesystem rename is atomic, so there is never a window where `sourcePath` is
 * missing or only partially replaced: a crash before the rename leaves the original `sourcePath`
 * completely untouched (the abandoned temp file is the only artifact), and a crash after leaves it
 * already-replaced - no in-between state either way.
 * @param {string} sourcePath Absolute path to the source file to replace. Must already exist.
 * @param {string} targetPath Absolute path to the canonical file to hardlink to. Must already exist,
 * on the same filesystem as `sourcePath` (an EXDEV from the initial `fs.link` propagates to the
 * caller unchanged, same as copyCharacterFile()'s hardlink stage - it is the caller's job to decide
 * whether cross-device is a real error or just "this feature doesn't apply here").
 * @returns {Promise<void>}
 */
export async function hardlinkOntoCanonical(sourcePath, targetPath) {
    const tempPath = `${sourcePath}.${crypto.randomUUID()}.tmp`;
    await fsPromises.link(targetPath, tempPath);
    try {
        await fsPromises.rename(tempPath, sourcePath);
    } catch (error) {
        await fsPromises.unlink(tempPath).catch(() => {});
        throw error;
    }
}
