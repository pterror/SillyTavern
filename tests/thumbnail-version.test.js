import { describe, test, expect, beforeAll } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** @type {(directories: object, type: string, file: string) => string|null} */
let getThumbnailVersion;

let tempDir;
let thumbnailsAvatarDir;
let charactersDir;

/**
 * getThumbnailVersion() (src/endpoints/thumbnails.js) is the shared helper the character manifest,
 * background list, and persona list endpoints all use to hand a client the cached thumbnail's own mtime
 * ahead of time, so getThumbnailUrl() can skip the thumbnail route's no-cache redirect hop. This exercises it
 * directly, independent of any one endpoint's request/response plumbing.
 */
beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-thumbnail-version-test-'));
    thumbnailsAvatarDir = path.join(tempDir, 'thumbnails', 'avatar');
    charactersDir = path.join(tempDir, 'characters');
    fs.mkdirSync(thumbnailsAvatarDir, { recursive: true });
    fs.mkdirSync(charactersDir, { recursive: true });

    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    ({ getThumbnailVersion } = await import('../src/endpoints/thumbnails.js'));
});

describe('getThumbnailVersion', () => {
    test('returns null when no cached thumbnail exists yet', () => {
        const directories = { thumbnailsAvatar: thumbnailsAvatarDir };
        expect(getThumbnailVersion(directories, 'avatar', 'Nonexistent.png')).toBeNull();
    });

    test('returns null when the type has no configured thumbnail folder', () => {
        const directories = {};
        expect(getThumbnailVersion(directories, 'avatar', 'Alice.png')).toBeNull();
    });

    test('returns the cached thumbnail file\'s own mtime, not the original\'s', () => {
        const originalPath = path.join(charactersDir, 'Alice.png');
        const cachedPath = path.join(thumbnailsAvatarDir, 'Alice.png');
        fs.writeFileSync(originalPath, 'original content');
        // Make sure the cached thumbnail's mtime is distinguishable from the original's.
        const later = new Date(Date.now() + 5000);
        fs.writeFileSync(cachedPath, 'thumbnail bytes');
        fs.utimesSync(cachedPath, later, later);

        const directories = { thumbnailsAvatar: thumbnailsAvatarDir, characters: charactersDir };
        const version = getThumbnailVersion(directories, 'avatar', 'Alice.png');
        const originalMtime = String(Math.round(fs.statSync(originalPath).mtimeMs));
        const cachedMtime = String(Math.round(fs.statSync(cachedPath).mtimeMs));

        expect(version).toBe(cachedMtime);
        expect(version).not.toBe(originalMtime);
    });

    test('changes when the cached thumbnail is regenerated (matches invalidateThumbnail + regenerate flow)', () => {
        const cachedPath = path.join(thumbnailsAvatarDir, 'Bob.png');
        fs.writeFileSync(cachedPath, 'v1');
        const directories = { thumbnailsAvatar: thumbnailsAvatarDir };
        const before = getThumbnailVersion(directories, 'avatar', 'Bob.png');

        const bumped = new Date(Number(before) + 2000);
        fs.writeFileSync(cachedPath, 'v2');
        fs.utimesSync(cachedPath, bumped, bumped);

        const after = getThumbnailVersion(directories, 'avatar', 'Bob.png');
        expect(after).not.toBe(before);
    });
});
