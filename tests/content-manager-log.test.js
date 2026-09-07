import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** @type {typeof import('../src/endpoints/content-manager.js')} */
let contentManager;

// content-manager.js resolves `default/content`/`default/scaffold` off `serverDirectory` into
// top-level consts at import time, so the fixture dir has to exist (and the mock has to be
// registered) *before* that import happens - hence creating it eagerly at module scope here rather
// than in a beforeEach.
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'st-content-manager-fixture-'));

// Redirect the module's hardcoded `default/content` and `default/scaffold` lookup to a throwaway
// fixture directory, so tests don't depend on (or mutate) the real repo's default content set.
jest.unstable_mockModule('../src/server-directory.js', () => ({
    serverDirectory: fixtureRoot,
}));

beforeAll(async () => {
    // content-manager.js transitively imports modules (e.g. character-card-parser.js) that read
    // config.yaml at import time via getConfigValue() - point that at the repo's default config so
    // the import doesn't hard process.exit(1) for lacking a configured path.
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    // checkForNewContent() also seeds "global" content (error pages, stylesheets) under
    // globalThis.DATA_ROOT, which the real server-startup.js sets - point it at the fixture so that
    // path doesn't throw before per-user seeding (this test's actual subject) even runs.
    globalThis.DATA_ROOT = fixtureRoot;

    contentManager = await import('../src/endpoints/content-manager.js');
});

afterAll(() => {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

/**
 * Writes a minimal content index + backing files under `<fixtureRoot>/default/content`, mirroring
 * what a real default/content/index.json + assets would look like for a couple of background images.
 * @param {string[]} filenames
 */
function seedContentDirectory(filenames) {
    const contentDir = path.join(fixtureRoot, 'default', 'content');
    fs.mkdirSync(contentDir, { recursive: true });
    const index = filenames.map(filename => ({ filename, type: 'background' }));
    fs.writeFileSync(path.join(contentDir, 'index.json'), JSON.stringify(index));
    for (const filename of filenames) {
        fs.writeFileSync(path.join(contentDir, filename), `bytes-for-${filename}`);
    }
}

describe('content-manager content.log write path', () => {
    let userRoot;
    let backgroundsDir;
    let directories;
    let appendSpy;

    beforeEach(() => {
        userRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'st-content-manager-user-'));
        backgroundsDir = path.join(userRoot, 'backgrounds');
        directories = { root: userRoot, backgrounds: backgroundsDir };
        appendSpy = jest.spyOn(fs, 'appendFileSync');
    });

    afterEach(() => {
        jest.restoreAllMocks();
        fs.rmSync(userRoot, { recursive: true, force: true });
    });

    test('first seed pass creates content.log containing only the seeded filenames', async () => {
        seedContentDirectory(['a.png', 'b.png']);

        await contentManager.checkForNewContent([directories]);

        const logPath = path.join(userRoot, 'content.log');
        expect(fs.readFileSync(logPath, 'utf8')).toBe('a.png\nb.png');
        expect(fs.existsSync(path.join(backgroundsDir, 'a.png'))).toBe(true);
        expect(fs.existsSync(path.join(backgroundsDir, 'b.png'))).toBe(true);
    });

    test('a seed pass with nothing new to add never touches content.log', async () => {
        seedContentDirectory(['a.png', 'b.png']);
        await contentManager.checkForNewContent([directories]);

        const logPath = path.join(userRoot, 'content.log');
        const before = fs.readFileSync(logPath);
        appendSpy.mockClear();
        const writeSpy = jest.spyOn(fs, 'writeFileSync');

        await contentManager.checkForNewContent([directories]);

        expect(appendSpy).not.toHaveBeenCalled();
        expect(writeSpy).not.toHaveBeenCalledWith(logPath, expect.anything());
        expect(fs.readFileSync(logPath)).toEqual(before);
    });

    test('a later seed pass with one new item appends only that entry, leaving prior bytes untouched', async () => {
        seedContentDirectory(['a.png', 'b.png']);
        await contentManager.checkForNewContent([directories]);
        appendSpy.mockClear();

        // Simulate a content update that adds one more default file to the index.
        seedContentDirectory(['a.png', 'b.png', 'c.png']);
        await contentManager.checkForNewContent([directories]);

        const logPath = path.join(userRoot, 'content.log');
        // The write path itself only ever appended the new delta, not the whole log.
        expect(appendSpy).toHaveBeenCalledTimes(1);
        expect(appendSpy).toHaveBeenCalledWith(logPath, '\nc.png');
        // And the resulting file reflects all three entries, in order, still no trailing newline.
        expect(fs.readFileSync(logPath, 'utf8')).toBe('a.png\nb.png\nc.png');
    });
});
