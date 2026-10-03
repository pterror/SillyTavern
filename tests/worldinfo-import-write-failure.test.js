import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// A World Info write (/import or /edit) that fails partway leaves the old book reading back exactly as it was.

/** Decides, per write, whether it fails; null lets every write through. */
let failWrite = null;

// The copy the server code resolves (the repo's node_modules), not the one tests/node_modules also has.
jest.unstable_mockModule('../node_modules/write-file-atomic/lib/index.js', () => ({
    sync: (filePath, data) => {
        if (failWrite?.(filePath)) {
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
/** @type {import('node:http').Server} */
let server;
let baseUrl;

beforeAll(async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-worldinfo-write-fail-'));
    worldsDir = path.join(tempDir, 'worlds');
    fs.mkdirSync(worldsDir, { recursive: true });
    directories = /** @type {any} */ ({ worlds: worldsDir, root: tempDir });

    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    worldinfo = await import('../src/endpoints/worldinfo.js');

    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.user = { directories, profile: { handle: 'test-user' } };
        next();
    });
    app.use('/api/worldinfo', worldinfo.router);
    // Answers a thrown write with a bare 500, without printing the stack.
    app.use((err, req, res, next) => res.sendStatus(500));
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise(resolve => server.close(resolve)));

beforeEach(() => {
    for (const entry of fs.readdirSync(worldsDir)) {
        fs.rmSync(path.join(worldsDir, entry), { recursive: true, force: true });
    }
});

afterEach(() => {
    failWrite = null;
});

function makeEntry(uid, content) {
    return { uid, key: [`key${uid}`], content };
}

const OLD_BOOK = { entries: { 0: makeEntry(0, 'Old zero'), 1: makeEntry(1, 'Old one') }, name: 'Old name' };
const NEW_BOOK = { entries: { 0: makeEntry(0, 'New zero'), 1: makeEntry(1, 'Old one'), 2: makeEntry(2, 'New two') }, name: 'New name' };

/** @param {string} name */
function entriesDir(name) {
    return path.join(worldsDir, `${name}.entries`);
}

/** Fails the manifest's write. */
function failManifest(name) {
    const manifestPath = path.join(worldsDir, `${name}.json`);
    return filePath => filePath === manifestPath;
}

/** Fails the second entry file written, after the first has landed. */
function failSecondEntry(name) {
    let entryWrites = 0;
    return filePath => path.dirname(filePath) === entriesDir(name) && ++entryWrites === 2;
}

/**
 * @param {string} name
 * @param {object} data
 */
function edit(name, data) {
    return fetch(`${baseUrl}/api/worldinfo/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, data }),
    });
}

describe.each([
    ['the manifest write fails', failManifest],
    ['an entry write fails after another landed', failSecondEntry],
])('a write that fails partway (%s)', (_label, makeFailure) => {
    test('an import leaves the old book reading back exactly as it was', () => {
        worldinfo.importWorldInfoFromRaw(directories, 'Kept.json', JSON.stringify(OLD_BOOK));

        failWrite = makeFailure('Kept');
        expect(() => worldinfo.importWorldInfoFromRaw(directories, 'Kept.json', JSON.stringify(NEW_BOOK))).toThrow('synthetic write failure');
        failWrite = null;

        expect(worldinfo.readWorldInfoFile(directories, 'Kept', false)).toEqual(OLD_BOOK);
    });

    test('an /edit leaves the old book reading back exactly as it was', async () => {
        expect((await edit('Kept', OLD_BOOK)).status).toBe(200);

        failWrite = makeFailure('Kept');
        expect((await edit('Kept', NEW_BOOK)).status).toBe(500);
        failWrite = null;

        expect(worldinfo.readWorldInfoFile(directories, 'Kept', false)).toEqual(OLD_BOOK);
    });

    test('what the failed write left is gone after the next write that lands', async () => {
        await edit('Kept', OLD_BOOK);
        failWrite = makeFailure('Kept');
        await edit('Kept', NEW_BOOK);
        failWrite = null;

        expect((await edit('Kept', NEW_BOOK)).status).toBe(200);

        expect(worldinfo.readWorldInfoFile(directories, 'Kept', false)).toEqual(NEW_BOOK);
        const manifest = JSON.parse(fs.readFileSync(path.join(worldsDir, 'Kept.json'), 'utf8'));
        expect(fs.readdirSync(entriesDir('Kept')).sort()).toEqual(manifest.entries.map(e => e.file).sort());
    });
});
