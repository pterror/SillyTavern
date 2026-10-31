import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** @type {typeof import('../src/endpoints/content-manager.js')} */
let contentManager;

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'st-content-manager-fixture-'));

jest.unstable_mockModule('../src/server-directory.js', () => ({
    serverDirectory: fixtureRoot,
}));

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    globalThis.DATA_ROOT = fixtureRoot;

    contentManager = await import('../src/endpoints/content-manager.js');
});

afterAll(() => {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

/**
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

        seedContentDirectory(['a.png', 'b.png', 'c.png']);
        await contentManager.checkForNewContent([directories]);

        const logPath = path.join(userRoot, 'content.log');
        expect(appendSpy).toHaveBeenCalledTimes(1);
        expect(appendSpy).toHaveBeenCalledWith(logPath, '\nc.png');
        expect(fs.readFileSync(logPath, 'utf8')).toBe('a.png\nb.png\nc.png');
    });
});
