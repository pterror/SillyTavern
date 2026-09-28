import { describe, test, expect, beforeAll, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// An import over an existing book writes the new file before it clears the old book's sidecar entries directory,
// so a write that fails leaves a sidecar-format book as it was.

/** Path whose write fails, or null. */
let failWriteTo = null;

// The copy the server code resolves (the repo's node_modules), not the one tests/node_modules also has.
jest.unstable_mockModule('../node_modules/write-file-atomic/lib/index.js', () => ({
    sync: (filePath, data) => {
        if (filePath === failWriteTo) {
            throw new Error('synthetic write failure');
        }
        fs.writeFileSync(filePath, data);
    },
}));

/** @type {typeof import('../src/endpoints/worldinfo.js')} */
let worldinfo;
let worldsDir;
/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

beforeAll(async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-worldinfo-import-fail-'));
    worldsDir = path.join(tempDir, 'worlds');
    fs.mkdirSync(worldsDir, { recursive: true });
    directories = /** @type {any} */ ({ worlds: worldsDir, root: tempDir });

    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    worldinfo = await import('../src/endpoints/worldinfo.js');
});

beforeEach(() => {
    for (const entry of fs.readdirSync(worldsDir)) {
        fs.rmSync(path.join(worldsDir, entry), { recursive: true, force: true });
    }
});

afterEach(() => {
    failWriteTo = null;
});

/**
 * Writes a sidecar-format book: a manifest listing uid 0 and its entry file in the entries directory.
 * @param {string} name
 * @param {string} content
 */
function writeSidecarBook(name, content) {
    fs.mkdirSync(path.join(worldsDir, `${name}.entries`));
    fs.writeFileSync(path.join(worldsDir, `${name}.entries`, '0.json'), JSON.stringify({ uid: 0, key: ['k'], content }));
    fs.writeFileSync(path.join(worldsDir, `${name}.json`), JSON.stringify({ format: 'sidecar-v1', entries: ['0'] }));
}

describe('importWorldInfoFromRaw over a sidecar-format book', () => {
    test('a write that fails leaves the old book and its entries as they were', () => {
        writeSidecarBook('Kept', 'Old');

        failWriteTo = path.join(worldsDir, 'Kept.json');
        const fresh = JSON.stringify({ entries: { 0: { uid: 0, key: ['k'], content: 'Fresh import' } } });
        expect(() => worldinfo.importWorldInfoFromRaw(directories, 'Kept.json', fresh)).toThrow('synthetic write failure');

        expect(worldinfo.readWorldInfoFile(directories, 'Kept', false).entries['0'].content).toBe('Old');
    });

    test('a write that lands replaces the book and clears the old entries directory', () => {
        writeSidecarBook('Replaced', 'Old');

        const fresh = JSON.stringify({ entries: { 0: { uid: 0, key: ['k'], content: 'Fresh import' } } });
        expect(worldinfo.importWorldInfoFromRaw(directories, 'Replaced.json', fresh)).toBe('Replaced');

        expect(fs.existsSync(path.join(worldsDir, 'Replaced.entries'))).toBe(false);
        expect(worldinfo.readWorldInfoFile(directories, 'Replaced', false).entries['0'].content).toBe('Fresh import');
    });
});
