import { afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** @type {typeof import('../src/local-import-copy.js')} */
let localImportCopy;

const getConfigValueMock = jest.fn((_key, defaultValue) => defaultValue);
const reflinkFileMock = jest.fn();

jest.unstable_mockModule('../src/util.js', () => ({
    getConfigValue: getConfigValueMock,
}));

// The real @reflink/reflink is a NAPI-RS native binding - platform-specific and not something a unit
// test should depend on being loadable/behaving one particular way on CI. Mocking it here also lets
// each test drive the reflink stage deterministically (succeed / fail) without touching a real
// filesystem's actual COW support.
jest.unstable_mockModule('@reflink/reflink', () => ({
    reflinkFile: reflinkFileMock,
}));

beforeAll(async () => {
    localImportCopy = await import('../src/local-import-copy.js');
});

describe('copyCharacterFile', () => {
    let tempDir;
    let sourcePath;
    let targetPath;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-local-import-copy-'));
        sourcePath = path.join(tempDir, 'source.png');
        targetPath = path.join(tempDir, 'target.png');
        fs.writeFileSync(sourcePath, 'character-bytes');

        getConfigValueMock.mockClear();
        getConfigValueMock.mockImplementation((_key, defaultValue) => defaultValue);

        reflinkFileMock.mockReset();
        // Default: reflink unavailable/unsupported on this "filesystem", so most tests exercise the
        // hardlink/copy stages. Tests that care about the reflink-success path override this.
        reflinkFileMock.mockRejectedValue(new Error('reflink not supported on this filesystem'));
    });

    afterEach(() => {
        jest.restoreAllMocks();
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('reflinks the file when the reflink binding succeeds, without touching hardlink/copy', async () => {
        const linkSpy = jest.spyOn(fsPromises, 'link');
        const copyFileSpy = jest.spyOn(fsPromises, 'copyFile');
        reflinkFileMock.mockImplementationOnce(async (src, dst) => {
            fs.copyFileSync(src, dst);
            return 0;
        });

        const result = await localImportCopy.copyCharacterFile(sourcePath, targetPath);

        expect(result).toEqual({ method: 'reflink' });
        expect(reflinkFileMock).toHaveBeenCalledWith(sourcePath, targetPath);
        expect(linkSpy).not.toHaveBeenCalled();
        expect(copyFileSpy).not.toHaveBeenCalled();
        expect(fs.readFileSync(targetPath, 'utf8')).toBe('character-bytes');
    });

    test('hardlinks the file when reflink fails and the filesystem supports hardlinks (same-filesystem path)', async () => {
        const result = await localImportCopy.copyCharacterFile(sourcePath, targetPath);

        expect(result).toEqual({ method: 'hardlink' });
        expect(fs.readFileSync(targetPath, 'utf8')).toBe('character-bytes');
        // A hardlink shares the source's inode - editing through one is visible via the other, which is
        // exactly why every character-data write path has to go through write-file-atomic (temp file +
        // rename) rather than mutate in place; see this module's write-path audit note.
        expect(fs.statSync(sourcePath).ino).toBe(fs.statSync(targetPath).ino);
    });

    test('falls back to a full copy on EXDEV when the config toggle allows it (default)', async () => {
        const exdevError = Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
        jest.spyOn(fsPromises, 'link').mockRejectedValueOnce(exdevError);

        const result = await localImportCopy.copyCharacterFile(sourcePath, targetPath);

        expect(result).toEqual({ method: 'copy' });
        expect(getConfigValueMock).toHaveBeenCalledWith('localImport.allowCrossDeviceCopyFallback', true, 'boolean');
        expect(fs.readFileSync(targetPath, 'utf8')).toBe('character-bytes');
        // A plain copy produces an independent inode, unlike a hardlink.
        expect(fs.statSync(sourcePath).ino).not.toBe(fs.statSync(targetPath).ino);
    });

    test('throws on EXDEV instead of copying when the config toggle disallows the fallback', async () => {
        const exdevError = Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
        jest.spyOn(fsPromises, 'link').mockRejectedValueOnce(exdevError);
        const copyFileSpy = jest.spyOn(fsPromises, 'copyFile');
        getConfigValueMock.mockImplementation(() => false);

        await expect(localImportCopy.copyCharacterFile(sourcePath, targetPath)).rejects.toBe(exdevError);
        expect(copyFileSpy).not.toHaveBeenCalled();
        expect(fs.existsSync(targetPath)).toBe(false);
    });

    test('propagates a hardlink EEXIST error without falling back to a copy', async () => {
        fs.writeFileSync(targetPath, 'already-here');
        const copyFileSpy = jest.spyOn(fsPromises, 'copyFile');

        await expect(localImportCopy.copyCharacterFile(sourcePath, targetPath)).rejects.toMatchObject({ code: 'EEXIST' });
        expect(copyFileSpy).not.toHaveBeenCalled();
        expect(fs.readFileSync(targetPath, 'utf8')).toBe('already-here');
    });
});

describe('hardlinkOntoCanonical', () => {
    let tempDir;
    let sourcePath;
    let targetPath;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-local-import-hardlink-'));
        sourcePath = path.join(tempDir, 'source.png');
        targetPath = path.join(tempDir, 'target.png');
        fs.writeFileSync(sourcePath, 'duplicate-bytes');
        fs.writeFileSync(targetPath, 'canonical-bytes');
    });

    afterEach(() => {
        jest.restoreAllMocks();
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('replaces sourcePath in place with a hardlink to targetPath', async () => {
        await localImportCopy.hardlinkOntoCanonical(sourcePath, targetPath);

        expect(fs.readFileSync(sourcePath, 'utf8')).toBe('canonical-bytes');
        expect(fs.statSync(sourcePath).ino).toBe(fs.statSync(targetPath).ino);
    });

    test('never leaves a window where sourcePath is missing (temp-link-then-rename, not unlink-then-link)', async () => {
        const unlinkSpy = jest.spyOn(fsPromises, 'unlink');
        const renameSpy = jest.spyOn(fsPromises, 'rename');

        await localImportCopy.hardlinkOntoCanonical(sourcePath, targetPath);

        // unlink is only ever the crash-cleanup path (see the failure test below) - a successful run never
        // calls it, since sourcePath is replaced via rename, never via a preceding delete.
        expect(unlinkSpy).not.toHaveBeenCalled();
        expect(renameSpy).toHaveBeenCalledTimes(1);
    });

    test('on a rename failure, leaves the original sourcePath untouched and cleans up the temp hardlink', async () => {
        const renameError = new Error('simulated rename failure');
        jest.spyOn(fsPromises, 'rename').mockRejectedValueOnce(renameError);

        await expect(localImportCopy.hardlinkOntoCanonical(sourcePath, targetPath)).rejects.toBe(renameError);

        // Original file untouched - still its own bytes/inode, not linked to targetPath.
        expect(fs.readFileSync(sourcePath, 'utf8')).toBe('duplicate-bytes');
        expect(fs.statSync(sourcePath).ino).not.toBe(fs.statSync(targetPath).ino);
        // No leftover ".tmp" file abandoned in the directory.
        const leftovers = fs.readdirSync(tempDir).filter(f => f.endsWith('.tmp'));
        expect(leftovers).toEqual([]);
    });

    test('propagates an EXDEV from the initial link (cross-device) without attempting a rename', async () => {
        const exdevError = Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
        jest.spyOn(fsPromises, 'link').mockRejectedValueOnce(exdevError);
        const renameSpy = jest.spyOn(fsPromises, 'rename');

        await expect(localImportCopy.hardlinkOntoCanonical(sourcePath, targetPath)).rejects.toBe(exdevError);
        expect(renameSpy).not.toHaveBeenCalled();
        expect(fs.readFileSync(sourcePath, 'utf8')).toBe('duplicate-bytes');
    });
});
