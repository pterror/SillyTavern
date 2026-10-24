import { describe, test, expect, beforeAll, jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** @type {(directories: object, type: string, file: string, forceGenerate?: boolean, isKnownAnimated?: boolean|null) => Promise<{ path: string|null }>} */
let generateThumbnail;

let tempDir;
let directories;

/**
 * An original that isn't a readable image (an image saved with broken bytes) gets no thumbnail. It is asked for on every
 * list draw, so it is decoded and reported once per version of the file, and tried again once the file changes.
 */
beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-thumbnail-undecodable-test-'));
    // A persona image: its original is a plain file in the avatars folder, with no store to look it up in.
    directories = { thumbnailsPersona: path.join(tempDir, 'thumbnails', 'persona'), avatars: path.join(tempDir, 'User Avatars') };
    fs.mkdirSync(directories.thumbnailsPersona, { recursive: true });
    fs.mkdirSync(directories.avatars, { recursive: true });

    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    ({ generateThumbnail } = await import('../src/endpoints/thumbnails.js'));
});

describe('an original that is not a readable image', () => {
    test('gets no thumbnail, is reported once while unchanged, and is read again once changed', async () => {
        const original = path.join(directories.avatars, 'Broken.png');
        fs.writeFileSync(original, 'PNG-0');
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const error = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            expect((await generateThumbnail(directories, 'persona', 'Broken.png')).path).toBeNull();
            expect((await generateThumbnail(directories, 'persona', 'Broken.png')).path).toBeNull();
            expect(warn).toHaveBeenCalledTimes(1);
            expect(String(warn.mock.calls[0][0])).toContain('Broken.png');
            expect(error).not.toHaveBeenCalled();

            // Jimp doesn't take a Buffer from jest's module realm as one, so a real image can't be decoded here: the
            // change is seen by the file being read, and reported, again.
            fs.writeFileSync(original, 'PNG-1 still broken');
            expect((await generateThumbnail(directories, 'persona', 'Broken.png')).path).toBeNull();
            expect(warn).toHaveBeenCalledTimes(2);
            expect((await generateThumbnail(directories, 'persona', 'Broken.png')).path).toBeNull();
            expect(warn).toHaveBeenCalledTimes(2);
            expect(error).not.toHaveBeenCalled();
        } finally {
            warn.mockRestore();
            error.mockRestore();
        }
    });
});
