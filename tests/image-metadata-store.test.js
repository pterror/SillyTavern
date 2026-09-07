import { afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** @type {typeof import('../src/endpoints/image-metadata.js')} */
let imageMetadata;

// A real, minimal 1x1 PNG so generateImageMetadata() (imageSize + Jimp) has something genuine to
// decode - these tests exercise the actual write path end to end, not a mocked-out generator.
const ONE_PIXEL_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
);

beforeAll(async () => {
    // image-metadata.js reads config.yaml at import time via getConfigValue() (thumbnail dimensions) -
    // point that at the repo's default config so the import doesn't hard process.exit(1).
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    imageMetadata = await import('../src/endpoints/image-metadata.js');
});

describe('image-metadata sharded storage', () => {
    let userRoot;
    let backgroundsDir;
    let renameSpy;

    beforeEach(() => {
        userRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'st-image-metadata-'));
        backgroundsDir = path.join(userRoot, 'backgrounds');
        fs.mkdirSync(backgroundsDir, { recursive: true });
        // write-file-atomic (used for every metadata write below) writes to a tmpfile then does a
        // callback-style fs.rename() to the real target path - that final rename is the reliable
        // "this file was actually (re)written" signal, since it names the true destination path.
        renameSpy = jest.spyOn(fs, 'rename');
    });

    afterEach(() => {
        jest.restoreAllMocks();
        fs.rmSync(userRoot, { recursive: true, force: true });
    });

    function writeBg(filename) {
        fs.writeFileSync(path.join(backgroundsDir, filename), ONE_PIXEL_PNG);
    }

    function metaFilePath(relativePath) {
        return path.join(userRoot, imageMetadata.METADATA_DIR, 'images', relativePath + '.json');
    }

    test('generating metadata for one image only writes that image\'s own metadata file', async () => {
        writeBg('a.png');
        writeBg('b.png');

        const { results, generatedCount } = await imageMetadata.getOrGenerateMetadataBatch(
            userRoot, ['backgrounds/a.png'], 'bg',
        );

        expect(generatedCount).toBe(1);
        expect(results['backgrounds/a.png'].hash).toBeDefined();
        expect(fs.existsSync(metaFilePath('backgrounds/a.png'))).toBe(true);
        expect(fs.existsSync(metaFilePath('backgrounds/b.png'))).toBe(false);

        // No per-user index file was touched at all.
        expect(fs.existsSync(path.join(userRoot, 'image-metadata.json'))).toBe(false);
    });

    test('regenerating one image\'s metadata does not rewrite an unrelated image\'s metadata file', async () => {
        writeBg('a.png');
        writeBg('b.png');
        await imageMetadata.getOrGenerateMetadataBatch(userRoot, ['backgrounds/a.png', 'backgrounds/b.png'], 'bg');

        const bMetaPath = metaFilePath('backgrounds/b.png');
        const bBytesBefore = fs.readFileSync(bMetaPath);

        // Touch a.png so its mtime changes, forcing regeneration, and regenerate just that one.
        fs.utimesSync(path.join(backgroundsDir, 'a.png'), new Date(), new Date(Date.now() + 5000));
        renameSpy.mockClear();
        await imageMetadata.getOrGenerateMetadataBatch(userRoot, ['backgrounds/a.png'], 'bg');

        // b.png's metadata file was never (re)written, and its bytes are unchanged.
        const renamedToPaths = renameSpy.mock.calls.map(call => String(call[1]));
        expect(renamedToPaths.some(p => p.includes('b.png'))).toBe(false);
        expect(renamedToPaths.some(p => p.endsWith(path.join('images', 'backgrounds', 'a.png.json')))).toBe(true);
        expect(fs.readFileSync(bMetaPath)).toEqual(bBytesBefore);
    });

    test('assigning an image to a folder only writes that image\'s metadata file, not the whole folder', async () => {
        writeBg('a.png');
        writeBg('b.png');
        await imageMetadata.getOrGenerateMetadataBatch(userRoot, ['backgrounds/a.png', 'backgrounds/b.png'], 'bg');
        const folder = await imageMetadata.createFolder(userRoot, 'My Folder');

        const bMetaPath = metaFilePath('backgrounds/b.png');
        const bBytesBefore = fs.readFileSync(bMetaPath);
        renameSpy.mockClear();

        await imageMetadata.assignImagesToFolder(userRoot, folder.id, ['backgrounds/a.png']);

        const renamedToPaths = renameSpy.mock.calls.map(call => String(call[1]));
        expect(renamedToPaths.some(p => p.endsWith(path.join('images', 'backgrounds', 'a.png.json')))).toBe(true);
        expect(renamedToPaths.some(p => p.includes('b.png'))).toBe(false);
        expect(fs.readFileSync(bMetaPath)).toEqual(bBytesBefore);

        const index = await imageMetadata.readMetadataIndex(userRoot);
        expect(index.images['backgrounds/a.png'].folderIds).toContain(folder.id);
        expect(index.images['backgrounds/b.png']?.folderIds ?? []).not.toContain(folder.id);
    });

    test('removing metadata deletes only that image\'s own file', async () => {
        writeBg('a.png');
        writeBg('b.png');
        await imageMetadata.getOrGenerateMetadataBatch(userRoot, ['backgrounds/a.png', 'backgrounds/b.png'], 'bg');

        await imageMetadata.removeMetadata(userRoot, 'backgrounds/a.png');

        expect(fs.existsSync(metaFilePath('backgrounds/a.png'))).toBe(false);
        expect(fs.existsSync(metaFilePath('backgrounds/b.png'))).toBe(true);
    });

    test('renaming metadata moves only the renamed image\'s file', async () => {
        writeBg('a.png');
        writeBg('b.png');
        await imageMetadata.getOrGenerateMetadataBatch(userRoot, ['backgrounds/a.png', 'backgrounds/b.png'], 'bg');

        await imageMetadata.renameMetadata(userRoot, 'backgrounds/a.png', 'backgrounds/renamed.png');

        expect(fs.existsSync(metaFilePath('backgrounds/a.png'))).toBe(false);
        expect(fs.existsSync(metaFilePath('backgrounds/renamed.png'))).toBe(true);
        expect(fs.existsSync(metaFilePath('backgrounds/b.png'))).toBe(true);
    });

    test('readMetadataIndex reconstructs the full index (images + folders) from the sharded files', async () => {
        writeBg('a.png');
        writeBg('b.png');
        await imageMetadata.getOrGenerateMetadataBatch(userRoot, ['backgrounds/a.png', 'backgrounds/b.png'], 'bg');
        const folder = await imageMetadata.createFolder(userRoot, 'Folder');
        await imageMetadata.assignImagesToFolder(userRoot, folder.id, ['backgrounds/a.png']);

        const index = await imageMetadata.readMetadataIndex(userRoot);
        expect(Object.keys(index.images).sort()).toEqual(['backgrounds/a.png', 'backgrounds/b.png']);
        expect(index.folders).toHaveLength(1);
        expect(index.folders[0].id).toBe(folder.id);
        expect(index.images['backgrounds/a.png'].folderIds).toEqual([folder.id]);
    });

    test('a legacy single-file index.json is migrated in place and its data is preserved', async () => {
        const legacyIndex = {
            version: 1,
            images: {
                'backgrounds/legacy.png': { hash: 'abc', folderIds: ['f1'], aspectRatio: 1 },
            },
            folders: [{ id: 'f1', name: 'Legacy Folder', thumbnailFile: 'legacy.png' }],
        };
        fs.writeFileSync(path.join(userRoot, 'image-metadata.json'), JSON.stringify(legacyIndex));

        const index = await imageMetadata.readMetadataIndex(userRoot);

        expect(index.images['backgrounds/legacy.png']).toEqual(legacyIndex.images['backgrounds/legacy.png']);
        expect(index.folders).toEqual(legacyIndex.folders);
        // Legacy file was moved out of the way, not left in place or destroyed.
        expect(fs.existsSync(path.join(userRoot, 'image-metadata.json'))).toBe(false);
        expect(fs.existsSync(path.join(userRoot, 'image-metadata.json.migrated'))).toBe(true);
    });
});
