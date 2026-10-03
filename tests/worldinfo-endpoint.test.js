import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** @type {typeof import('../src/endpoints/worldinfo.js')} */
let worldinfo;
/** @type {import('node:http').Server} */
let server;
let baseUrl;
let tempDir;
let worldsDir;
/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

/**
 * Mounts the real worldinfo.js router behind a fake auth middleware (mirrors avatars-get.test.js), plus a
 * stand-in for the multer middleware that normally attaches `req.file` ahead of `/import` in server-startup.js
 * - it's not part of this router, so it has to be faked here to exercise `/import` at all.
 */
beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-worldinfo-test-'));
    worldsDir = path.join(tempDir, 'worlds');
    fs.mkdirSync(worldsDir, { recursive: true });
    directories = { worlds: worldsDir, root: tempDir };

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
    app.use('/api/worldinfo/import', (req, res, next) => {
        req.file = { originalname: req.body.importFilename || 'Imported.json' };
        next();
    });
    app.use('/api/worldinfo', worldinfo.router);
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

async function postJson(urlPath, body) {
    return fetch(`${baseUrl}${urlPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

function entriesDirFor(name) {
    return path.join(worldsDir, `${name}.entries`);
}

function makeEntry(uid, content) {
    return { uid, key: [`key${uid}`], content, comment: '', disable: false };
}

/**
 * @param {string} name
 * @returns {object} The book's manifest, as stored.
 */
function readManifest(name) {
    return JSON.parse(fs.readFileSync(path.join(worldsDir, `${name}.json`), 'utf8'));
}

/**
 * @param {string} name
 * @returns {Record<string, string>} Each entry uid's file, as the manifest names it.
 */
function entryFiles(name) {
    return Object.fromEntries(readManifest(name).entries.map(({ uid, file }) => [uid, file]));
}

/**
 * @param {string} file
 * @returns {{ ino: number, mtimeMs: number }}
 */
function identity(file) {
    const { ino, mtimeMs } = fs.statSync(file);
    return { ino, mtimeMs };
}

/** Waits long enough that a rewritten file would show a different mtime. */
function tick() {
    return new Promise(resolve => setTimeout(resolve, 15));
}

describe('worldinfo /edit - stored format', () => {
    test('a fresh save creates a manifest naming one file per entry, and nothing more', async () => {
        const data = { entries: { 0: makeEntry(0, 'Alpha'), 1: makeEntry(1, 'Beta') } };
        const res = await postJson('/api/worldinfo/edit', { name: 'Book', data });
        expect(res.status).toBe(200);

        const manifest = readManifest('Book');
        expect(manifest.format).toBe('sidecar-v2');
        expect(manifest.entries.map(e => e.uid).sort()).toEqual(['0', '1']);
        expect(fs.readdirSync(entriesDirFor('Book')).sort()).toEqual(Object.values(entryFiles('Book')).sort());
    });

    test('editing one entry writes only that entry\'s file; the other keeps its file', async () => {
        await postJson('/api/worldinfo/edit', { name: 'Book', data: { entries: { 0: makeEntry(0, 'Alpha'), 1: makeEntry(1, 'Beta') } } });
        const filesBefore = entryFiles('Book');
        const untouched = identity(path.join(entriesDirFor('Book'), filesBefore['1']));
        await tick();

        await postJson('/api/worldinfo/edit', { name: 'Book', data: { entries: { 0: makeEntry(0, 'Alpha (edited)'), 1: makeEntry(1, 'Beta') } } });

        const filesAfter = entryFiles('Book');
        expect(filesAfter['1']).toBe(filesBefore['1']);
        expect(identity(path.join(entriesDirFor('Book'), filesAfter['1']))).toEqual(untouched);
        expect(filesAfter['0']).not.toBe(filesBefore['0']);
        expect(fs.readdirSync(entriesDirFor('Book')).sort()).toEqual(Object.values(filesAfter).sort());

        const res = await postJson('/api/worldinfo/get', { name: 'Book' });
        expect((await res.json()).entries['0'].content).toBe('Alpha (edited)');
    });

    test('an edit that changes nothing writes nothing', async () => {
        const data = { entries: { 0: makeEntry(0, 'Alpha'), 1: makeEntry(1, 'Beta') }, name: 'Book' };
        await postJson('/api/worldinfo/edit', { name: 'Book', data });
        const manifestPath = path.join(worldsDir, 'Book.json');
        const snapshot = () => [manifestPath, ...fs.readdirSync(entriesDirFor('Book')).sort().map(f => path.join(entriesDirFor('Book'), f))]
            .map(file => [file, identity(file)]);
        const before = snapshot();
        await tick();

        const res = await postJson('/api/worldinfo/edit', { name: 'Book', data });
        expect(res.status).toBe(200);

        expect(snapshot()).toEqual(before);
    });

    test('removing an entry deletes only that entry\'s file', async () => {
        await postJson('/api/worldinfo/edit', { name: 'Book', data: { entries: { 0: makeEntry(0, 'Alpha'), 1: makeEntry(1, 'Beta') } } });
        const kept = entryFiles('Book')['0'];

        await postJson('/api/worldinfo/edit', { name: 'Book', data: { entries: { 0: makeEntry(0, 'Alpha') } } });

        expect(entryFiles('Book')).toEqual({ 0: kept });
        expect(fs.readdirSync(entriesDirFor('Book'))).toEqual([kept]);
    });

    test('top-level fields other than entries survive a save/read round trip', async () => {
        const data = { entries: { 0: makeEntry(0, 'Alpha') }, name: 'Book', extensions: { foo: 'bar' } };
        await postJson('/api/worldinfo/edit', { name: 'Book', data });

        const res = await postJson('/api/worldinfo/get', { name: 'Book' });
        const read = await res.json();
        expect(read.name).toBe('Book');
        expect(read.extensions).toEqual({ foo: 'bar' });
        expect(read.entries['0'].content).toBe('Alpha');
    });
});

describe('worldinfo read - only the stored format', () => {
    test('a file in upstream\'s format (entries inline) is refused, naming the conversion script', () => {
        fs.writeFileSync(path.join(worldsDir, 'Plain.json'), JSON.stringify({ entries: { 0: makeEntry(0, 'Plain') } }));

        expect(() => worldinfo.readWorldInfoFile(directories, 'Plain', false)).toThrow('src/migrations/convert-world-info-to-sidecar.js');
    });

    test('a file in the earlier sidecar format is refused, naming the conversion script', () => {
        fs.mkdirSync(entriesDirFor('Older'));
        fs.writeFileSync(path.join(entriesDirFor('Older'), '0.json'), JSON.stringify(makeEntry(0, 'Older')));
        fs.writeFileSync(path.join(worldsDir, 'Older.json'), JSON.stringify({ format: 'sidecar-v1', entries: ['0'] }));

        expect(() => worldinfo.readWorldInfoFile(directories, 'Older', false)).toThrow('src/migrations/convert-world-info-to-sidecar.js');
    });

    test('a file in the entries directory the manifest doesn\'t name is never read, and is gone after the next write', async () => {
        await postJson('/api/worldinfo/edit', { name: 'Book', data: { entries: { 0: makeEntry(0, 'Alpha') } } });
        const stray = path.join(entriesDirFor('Book'), '0.0000000000000000.json');
        fs.writeFileSync(stray, JSON.stringify(makeEntry(0, 'Left by a failed write')));

        const res = await postJson('/api/worldinfo/get', { name: 'Book' });
        expect(await res.json()).toEqual({ entries: { 0: makeEntry(0, 'Alpha') } });

        await postJson('/api/worldinfo/edit', { name: 'Book', data: { entries: { 0: makeEntry(0, 'Alpha'), 1: makeEntry(1, 'Beta') } } });
        expect(fs.existsSync(stray)).toBe(false);
        expect(fs.readdirSync(entriesDirFor('Book')).sort()).toEqual(Object.values(entryFiles('Book')).sort());
    });

    test('/get returns the dummy object for a book that does not exist', async () => {
        const res = await postJson('/api/worldinfo/get', { name: 'Nope' });
        expect(await res.json()).toEqual({ entries: {} });
    });
});

describe('worldinfo /delete', () => {
    test('removes both the manifest and the entries directory', async () => {
        const data = { entries: { 0: makeEntry(0, 'Alpha') } };
        await postJson('/api/worldinfo/edit', { name: 'Book', data });
        expect(fs.existsSync(entriesDirFor('Book'))).toBe(true);

        const res = await postJson('/api/worldinfo/delete', { name: 'Book' });
        expect(res.status).toBe(200);
        expect(fs.existsSync(path.join(worldsDir, 'Book.json'))).toBe(false);
        expect(fs.existsSync(entriesDirFor('Book'))).toBe(false);
    });
});

describe('worldinfo /import', () => {
    test('stores the book in the stored format, and /get reads back what was imported', async () => {
        const book = { entries: { 0: makeEntry(0, 'Imported content') }, name: 'Cool Book', extensions: { foo: 'bar' } };
        const res = await postJson('/api/worldinfo/import', { importFilename: 'Cool Book.json', convertedData: JSON.stringify(book) });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ name: 'Cool Book' });

        expect(readManifest('Cool Book').format).toBe('sidecar-v2');

        const getRes = await postJson('/api/worldinfo/get', { name: 'Cool Book' });
        expect(await getRes.json()).toEqual(book);
    });

    test('re-importing over a stored book leaves no stale entry files', async () => {
        await postJson('/api/worldinfo/edit', { name: 'Reimported', data: { entries: { 0: makeEntry(0, 'Old'), 1: makeEntry(1, 'Gone') } } });

        const book = { entries: { 0: makeEntry(0, 'Fresh import') } };
        await postJson('/api/worldinfo/import', { importFilename: 'Reimported.json', convertedData: JSON.stringify(book) });

        expect(fs.readdirSync(entriesDirFor('Reimported'))).toEqual([entryFiles('Reimported')['0']]);
        const getRes = await postJson('/api/worldinfo/get', { name: 'Reimported' });
        expect(await getRes.json()).toEqual(book);
    });

    test('rejects a file with no entries list', async () => {
        const res = await postJson('/api/worldinfo/import', { importFilename: 'Bad.json', convertedData: JSON.stringify({ notEntries: true }) });
        expect(res.status).toBe(400);
    });
});

describe('worldinfo /list', () => {
    test('lists books by name', async () => {
        await postJson('/api/worldinfo/import', { importFilename: 'ImportedOne.json', convertedData: JSON.stringify({ entries: {} }) });
        await postJson('/api/worldinfo/edit', { name: 'SidecarOne', data: { entries: { 0: makeEntry(0, 'x') }, name: 'SidecarOne' } });

        const res = await postJson('/api/worldinfo/list', {});
        const names = (await res.json()).map(x => x.name).sort();
        expect(names).toEqual(['ImportedOne', 'SidecarOne']);
    });
});

describe('worldinfo /entry/transplant', () => {
    async function seedBooks() {
        await postJson('/api/worldinfo/edit', {
            name: 'Source',
            data: { entries: { 0: makeEntry(0, 'Moved'), 1: makeEntry(1, 'Stays behind') } },
        });
        await postJson('/api/worldinfo/edit', {
            name: 'Target',
            data: { entries: { 5: { ...makeEntry(5, 'Already there'), displayIndex: 3 } } },
        });
    }

    test('moves an entry: removed from source, present in target with a fresh uid and end-of-list displayIndex', async () => {
        await seedBooks();

        const res = await postJson('/api/worldinfo/entry/transplant', {
            source_name: 'Source', target_name: 'Target', uid: 0, delete_original: true,
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.ok).toBe(true);
        expect(body.entry.content).toBe('Moved');
        expect(body.entry.uid).not.toBe(5); // server minted a fresh uid, distinct from target's existing entries
        expect(body.entry.displayIndex).toBe(4); // placed after the existing target entry's displayIndex of 3

        const source = await (await postJson('/api/worldinfo/get', { name: 'Source' })).json();
        expect(source.entries['0']).toBeUndefined();
        expect(source.entries['1'].content).toBe('Stays behind'); // other source entries untouched

        const target = await (await postJson('/api/worldinfo/get', { name: 'Target' })).json();
        const transplanted = Object.values(target.entries).find(e => e.content === 'Moved');
        expect(transplanted).toBeDefined();
        expect(transplanted.uid).toBe(body.entry.uid);
        expect(target.entries['5'].content).toBe('Already there'); // other target entries untouched
    });

    test('copies an entry (delete_original: false): present in both books afterward', async () => {
        await seedBooks();

        const res = await postJson('/api/worldinfo/entry/transplant', {
            source_name: 'Source', target_name: 'Target', uid: 0, delete_original: false,
        });
        expect(res.status).toBe(200);

        const source = await (await postJson('/api/worldinfo/get', { name: 'Source' })).json();
        expect(source.entries['0'].content).toBe('Moved'); // original untouched when not deleting

        const target = await (await postJson('/api/worldinfo/get', { name: 'Target' })).json();
        expect(Object.values(target.entries).some(e => e.content === 'Moved')).toBe(true);
    });

    test('a single request/response fully reflects the change in both files - no follow-up call needed', async () => {
        await seedBooks();

        await postJson('/api/worldinfo/entry/transplant', {
            source_name: 'Source', target_name: 'Target', uid: 1, delete_original: true,
        });

        // Read straight off disk (not through another endpoint) to confirm the one call already
        // finished both writes by the time it returned.
        const sourceManifest = JSON.parse(fs.readFileSync(path.join(worldsDir, 'Source.json'), 'utf8'));
        expect(sourceManifest.entries.map(e => e.uid)).toEqual(['0']);
        const targetManifest = JSON.parse(fs.readFileSync(path.join(worldsDir, 'Target.json'), 'utf8'));
        expect(targetManifest.entries.length).toBe(2);
    });

    test('rejects a nonexistent source uid without touching either book', async () => {
        await seedBooks();

        const res = await postJson('/api/worldinfo/entry/transplant', {
            source_name: 'Source', target_name: 'Target', uid: 999, delete_original: true,
        });
        expect(res.status).toBe(404);

        const source = await (await postJson('/api/worldinfo/get', { name: 'Source' })).json();
        expect(Object.keys(source.entries).sort()).toEqual(['0', '1']);
        const target = await (await postJson('/api/worldinfo/get', { name: 'Target' })).json();
        expect(Object.keys(target.entries)).toEqual(['5']);
    });

    test('rejects a nonexistent source or target book', async () => {
        await seedBooks();

        const noSource = await postJson('/api/worldinfo/entry/transplant', {
            source_name: 'Ghost', target_name: 'Target', uid: 0, delete_original: true,
        });
        expect(noSource.status).toBe(404);

        const noTarget = await postJson('/api/worldinfo/entry/transplant', {
            source_name: 'Source', target_name: 'Ghost', uid: 0, delete_original: true,
        });
        expect(noTarget.status).toBe(404);

        // Source book still has both entries - the failed noTarget call didn't partially apply.
        const source = await (await postJson('/api/worldinfo/get', { name: 'Source' })).json();
        expect(Object.keys(source.entries).sort()).toEqual(['0', '1']);
    });

    test('rejects source_name === target_name', async () => {
        await seedBooks();

        const res = await postJson('/api/worldinfo/entry/transplant', {
            source_name: 'Source', target_name: 'Source', uid: 0, delete_original: true,
        });
        expect(res.status).toBe(400);
    });
});

describe('worldinfo /entry/create', () => {
    test('mints a uid server-side for a brand-new entry and reserves it on disk', async () => {
        await postJson('/api/worldinfo/edit', {
            name: 'Book',
            data: { entries: {} },
        });

        const res = await postJson('/api/worldinfo/entry/create', { name: 'Book' });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.ok).toBe(true);
        expect(Number.isInteger(body.entry.uid)).toBe(true);

        const book = await (await postJson('/api/worldinfo/get', { name: 'Book' })).json();
        expect(Object.keys(book.entries)).toEqual([String(body.entry.uid)]);
    });

    test('mints a uid that does not collide with existing entries in the book', async () => {
        await postJson('/api/worldinfo/edit', {
            name: 'Book',
            data: { entries: { 0: makeEntry(0, 'Alpha'), 1: makeEntry(1, 'Beta') } },
        });

        const res = await postJson('/api/worldinfo/entry/create', { name: 'Book' });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.entry.uid).toBe(2); // lowest free integer, matching getFreeWorldEntryUid's scheme

        const book = await (await postJson('/api/worldinfo/get', { name: 'Book' })).json();
        expect(Object.keys(book.entries).sort()).toEqual(['0', '1', '2']);
    });

    test('two sequential create calls against the same book never collide', async () => {
        await postJson('/api/worldinfo/edit', {
            name: 'Book',
            data: { entries: {} },
        });

        const first = await (await postJson('/api/worldinfo/entry/create', { name: 'Book' })).json();
        const second = await (await postJson('/api/worldinfo/entry/create', { name: 'Book' })).json();
        expect(first.entry.uid).not.toBe(second.entry.uid);

        const book = await (await postJson('/api/worldinfo/get', { name: 'Book' })).json();
        expect(Object.keys(book.entries).sort()).toEqual([String(first.entry.uid), String(second.entry.uid)].sort());
    });

    test('rejects a nonexistent book', async () => {
        const res = await postJson('/api/worldinfo/entry/create', { name: 'Ghost' });
        expect(res.status).toBe(404);
    });

    test('rejects a missing name', async () => {
        const res = await postJson('/api/worldinfo/entry/create', {});
        expect(res.status).toBe(400);
    });
});

describe('worldinfo /create', () => {
    test('creates a brand-new, empty book with the given name when it is free', async () => {
        const res = await postJson('/api/worldinfo/create', { name: 'Fresh Book' });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true, name: 'Fresh Book' });

        const book = await (await postJson('/api/worldinfo/get', { name: 'Fresh Book' })).json();
        expect(book.entries).toEqual({});
    });

    test('defaults to "New World" when no name is given', async () => {
        const res = await postJson('/api/worldinfo/create', {});
        expect(res.status).toBe(200);
        expect((await res.json()).name).toBe('New World');
    });

    test('defaults to "New World" when the name is blank', async () => {
        const res = await postJson('/api/worldinfo/create', { name: '   ' });
        expect(res.status).toBe(200);
        expect((await res.json()).name).toBe('New World');
    });

    test('silently mints "<name> (<N>)" against real on-disk state when the name is taken (default unique:true)', async () => {
        await postJson('/api/worldinfo/create', { name: 'Taken' });

        const res = await postJson('/api/worldinfo/create', { name: 'Taken' });
        expect(res.status).toBe(200);
        expect((await res.json()).name).toBe('Taken (1)');

        // A third call skips past both now-taken names.
        const res2 = await postJson('/api/worldinfo/create', { name: 'Taken' });
        expect(res2.status).toBe(200);
        expect((await res2.json()).name).toBe('Taken (2)');

        expect(fs.existsSync(path.join(worldsDir, 'Taken.json'))).toBe(true);
        expect(fs.existsSync(path.join(worldsDir, 'Taken (1).json'))).toBe(true);
        expect(fs.existsSync(path.join(worldsDir, 'Taken (2).json'))).toBe(true);
    });

    test('uniquifies against a book that only exists on disk, not a client-supplied list', async () => {
        // Written straight to disk, bypassing any endpoint - simulates another tab/client having
        // already created this book, which a client-side cache of world_names could miss.
        fs.writeFileSync(path.join(worldsDir, 'External.json'), JSON.stringify({ format: 'sidecar-v2', entries: [] }));

        const res = await postJson('/api/worldinfo/create', { name: 'External' });
        expect(res.status).toBe(200);
        expect((await res.json()).name).toBe('External (1)');
    });

    test('unique:false rejects a taken name instead of renaming it', async () => {
        await postJson('/api/worldinfo/create', { name: 'Exact', unique: false });

        const res = await postJson('/api/worldinfo/create', { name: 'Exact', unique: false });
        expect(res.status).toBe(409);

        // Only the first book exists - the rejected call created nothing.
        expect(fs.readdirSync(worldsDir).filter(f => f.endsWith('.json'))).toEqual(['Exact.json']);
    });

    test('unique:false creates the exact name when it is free', async () => {
        const res = await postJson('/api/worldinfo/create', { name: 'Exact Free', unique: false });
        expect(res.status).toBe(200);
        expect((await res.json()).name).toBe('Exact Free');
    });

    test('rejects a non-string name', async () => {
        const res = await postJson('/api/worldinfo/create', { name: 42 });
        expect(res.status).toBe(400);
    });
});

describe('worldinfo missing-book memory', () => {
    const OLD_MTIME = new Date('2020-01-01T00:00:00Z');

    /** Backdates the worlds directory, so a miss seen now is trusted until the directory changes. */
    function settleWorldsDir() {
        fs.utimesSync(worldsDir, OLD_MTIME, OLD_MTIME);
    }

    /** Counts filesystem lookups of one book's file from now on. */
    function countLookups(name) {
        const target = path.join(worldsDir, `${name}.json`);
        const spy = jest.spyOn(fs, 'existsSync');
        return () => spy.mock.calls.filter(([p]) => p === target).length;
    }

    function silenceErrors() {
        return jest.spyOn(console, 'error').mockImplementation(() => {});
    }

    function printsFor(errorSpy, name) {
        return errorSpy.mock.calls.filter(([message]) => String(message).includes(`${name}.json`)).length;
    }

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('/get of a missing book answers an empty book every time and prints once', async () => {
        settleWorldsDir();
        const errors = silenceErrors();

        for (let i = 0; i < 3; i++) {
            const res = await postJson('/api/worldinfo/get', { name: 'Ghost Get' });
            expect(res.status).toBe(200);
            expect(await res.json()).toEqual({ entries: {} });
        }
        expect(printsFor(errors, 'Ghost Get')).toBe(1);
    });

    test('a remembered miss is answered without looking the file up again', () => {
        settleWorldsDir();
        const lookups = countLookups('Ghost Repeat');

        for (let i = 0; i < 3; i++) {
            expect(worldinfo.worldInfoFileExists(directories, 'Ghost Repeat')).toBe(false);
        }
        expect(lookups()).toBe(1);
    });

    test('worldInfoFileExists never prints; the first read that would print still does, once', () => {
        settleWorldsDir();
        const errors = silenceErrors();

        expect(worldinfo.worldInfoFileExists(directories, 'Ghost Quiet')).toBe(false);
        expect(printsFor(errors, 'Ghost Quiet')).toBe(0);

        expect(worldinfo.readWorldInfoFile(directories, 'Ghost Quiet', false)).toBeNull();
        expect(worldinfo.readWorldInfoFile(directories, 'Ghost Quiet', true)).toEqual({ entries: {} });
        expect(printsFor(errors, 'Ghost Quiet')).toBe(1);
    });

    test('re-checking after the directory changes does not print again while the book stays missing', () => {
        settleWorldsDir();
        const errors = silenceErrors();
        worldinfo.readWorldInfoFile(directories, 'Ghost Recheck', true);

        fs.writeFileSync(path.join(worldsDir, 'Other.json'), JSON.stringify({ format: 'sidecar-v2', entries: [] }));
        const lookups = countLookups('Ghost Recheck');
        worldinfo.readWorldInfoFile(directories, 'Ghost Recheck', true);

        expect(lookups()).toBe(1);
        expect(printsFor(errors, 'Ghost Recheck')).toBe(1);
    });

    test('saving a book under the name (/edit, as a rename does) drops the miss, even with the directory mtime unchanged', async () => {
        settleWorldsDir();
        expect(worldinfo.worldInfoFileExists(directories, 'Renamed In')).toBe(false);

        await postJson('/api/worldinfo/edit', { name: 'Renamed In', data: { entries: { 0: makeEntry(0, 'Alpha') } } });
        settleWorldsDir();

        expect(worldinfo.worldInfoFileExists(directories, 'Renamed In')).toBe(true);
        expect(worldinfo.readWorldInfoFile(directories, 'Renamed In', true).entries['0'].content).toBe('Alpha');
    });

    test('/create drops the miss, even with the directory mtime unchanged', async () => {
        settleWorldsDir();
        expect(worldinfo.worldInfoFileExists(directories, 'Made New')).toBe(false);

        await postJson('/api/worldinfo/create', { name: 'Made New', unique: false });
        settleWorldsDir();

        expect(worldinfo.worldInfoFileExists(directories, 'Made New')).toBe(true);
    });

    test('/import drops the miss, even with the directory mtime unchanged', async () => {
        settleWorldsDir();
        expect(worldinfo.worldInfoFileExists(directories, 'Imported Late')).toBe(false);

        const book = { entries: { 0: makeEntry(0, 'Imported content') } };
        await postJson('/api/worldinfo/import', { importFilename: 'Imported Late.json', convertedData: JSON.stringify(book) });
        settleWorldsDir();

        expect(worldinfo.worldInfoFileExists(directories, 'Imported Late')).toBe(true);
    });

    test('a book copied in by hand is found on the next lookup', () => {
        settleWorldsDir();
        expect(worldinfo.worldInfoFileExists(directories, 'Handmade')).toBe(false);

        fs.writeFileSync(path.join(worldsDir, 'Handmade.json'), JSON.stringify({ format: 'sidecar-v2', entries: [] }));

        expect(worldinfo.worldInfoFileExists(directories, 'Handmade')).toBe(true);
    });

    test('a miss seen while the directory mtime is fresh is looked up again, even if a copy leaves that mtime as it was', () => {
        const fresh = new Date(Date.now() - 1000);
        fs.utimesSync(worldsDir, fresh, fresh);
        expect(worldinfo.worldInfoFileExists(directories, 'Same Tick')).toBe(false);

        fs.writeFileSync(path.join(worldsDir, 'Same Tick.json'), JSON.stringify({ format: 'sidecar-v2', entries: [] }));
        fs.utimesSync(worldsDir, fresh, fresh);

        expect(worldinfo.worldInfoFileExists(directories, 'Same Tick')).toBe(true);
    });

    test('misses are kept per data directory', () => {
        const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'st-worldinfo-test-other-'));
        const other = { worlds: path.join(otherRoot, 'worlds'), root: otherRoot };
        fs.mkdirSync(other.worlds);
        fs.writeFileSync(path.join(other.worlds, 'Split.json'), JSON.stringify({ format: 'sidecar-v2', entries: [] }));
        fs.utimesSync(other.worlds, OLD_MTIME, OLD_MTIME);
        settleWorldsDir();

        try {
            expect(worldinfo.worldInfoFileExists(directories, 'Split')).toBe(false);
            expect(worldinfo.worldInfoFileExists(other, 'Split')).toBe(true);
        } finally {
            fs.rmSync(otherRoot, { recursive: true, force: true });
        }
    });

    test('holds 10,000 misses, dropping the least recently used one first', () => {
        settleWorldsDir();
        worldinfo.worldInfoFileExists(directories, 'Lru Kept');
        worldinfo.worldInfoFileExists(directories, 'Lru Dropped');
        for (let i = 0; i < 9_998; i++) {
            worldinfo.worldInfoFileExists(directories, `Lru Filler ${i}`);
        }
        worldinfo.worldInfoFileExists(directories, 'Lru Kept');
        worldinfo.worldInfoFileExists(directories, 'Lru Filler last');

        const keptLookups = countLookups('Lru Kept');
        expect(worldinfo.worldInfoFileExists(directories, 'Lru Kept')).toBe(false);
        expect(keptLookups()).toBe(0);
        jest.restoreAllMocks();

        const droppedLookups = countLookups('Lru Dropped');
        expect(worldinfo.worldInfoFileExists(directories, 'Lru Dropped')).toBe(false);
        expect(droppedLookups()).toBe(1);
    });
});
