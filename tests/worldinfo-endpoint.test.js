import { describe, test, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
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

describe('worldinfo /edit - sidecar write path', () => {
    test('a fresh save creates a manifest file and one entry file per uid, nothing more', async () => {
        const data = { entries: { 0: makeEntry(0, 'Alpha'), 1: makeEntry(1, 'Beta') } };
        const res = await postJson('/api/worldinfo/edit', { name: 'Book', data });
        expect(res.status).toBe(200);

        const manifest = JSON.parse(fs.readFileSync(path.join(worldsDir, 'Book.json'), 'utf8'));
        expect(manifest.format).toBe('sidecar-v1');
        expect(manifest.entries.sort()).toEqual(['0', '1']);
        expect(fs.readdirSync(entriesDirFor('Book')).sort()).toEqual(['0.json', '1.json']);
    });

    test('editing one entry does not rewrite the file of an untouched entry', async () => {
        const data = { entries: { 0: makeEntry(0, 'Alpha'), 1: makeEntry(1, 'Beta') } };
        await postJson('/api/worldinfo/edit', { name: 'Book', data });

        const untouchedPath = path.join(entriesDirFor('Book'), '1.json');
        const before = fs.statSync(untouchedPath);
        await new Promise(resolve => setTimeout(resolve, 15)); // ensure mtime would visibly differ if rewritten

        const updated = { entries: { 0: makeEntry(0, 'Alpha (edited)'), 1: makeEntry(1, 'Beta') } };
        await postJson('/api/worldinfo/edit', { name: 'Book', data: updated });

        const after = fs.statSync(untouchedPath);
        expect(after.mtimeMs).toBe(before.mtimeMs);

        const editedEntry = JSON.parse(fs.readFileSync(path.join(entriesDirFor('Book'), '0.json'), 'utf8'));
        expect(editedEntry.content).toBe('Alpha (edited)');
    });

    test('removing an entry deletes only that entry file', async () => {
        const data = { entries: { 0: makeEntry(0, 'Alpha'), 1: makeEntry(1, 'Beta') } };
        await postJson('/api/worldinfo/edit', { name: 'Book', data });

        const updated = { entries: { 0: makeEntry(0, 'Alpha') } };
        await postJson('/api/worldinfo/edit', { name: 'Book', data: updated });

        expect(fs.readdirSync(entriesDirFor('Book'))).toEqual(['0.json']);
        const manifest = JSON.parse(fs.readFileSync(path.join(worldsDir, 'Book.json'), 'utf8'));
        expect(manifest.entries).toEqual(['0']);
    });

    test('a pre-existing legacy (pre-migration) file is migrated on its first edit and reads back the same', async () => {
        const legacy = { entries: { 5: makeEntry(5, 'Legacy content') } };
        fs.writeFileSync(path.join(worldsDir, 'OldBook.json'), JSON.stringify(legacy));

        const before = await postJson('/api/worldinfo/get', { name: 'OldBook' });
        expect((await before.json()).entries['5'].content).toBe('Legacy content');

        await postJson('/api/worldinfo/edit', { name: 'OldBook', data: { entries: { 5: makeEntry(5, 'Legacy content'), 6: makeEntry(6, 'New') } } });

        const manifest = JSON.parse(fs.readFileSync(path.join(worldsDir, 'OldBook.json'), 'utf8'));
        expect(manifest.format).toBe('sidecar-v1');

        const after = await postJson('/api/worldinfo/get', { name: 'OldBook' });
        const afterData = await after.json();
        expect(afterData.entries['5'].content).toBe('Legacy content');
        expect(afterData.entries['6'].content).toBe('New');
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

describe('worldinfo /get - reads both formats', () => {
    test('reads a plain legacy file unchanged', async () => {
        const legacy = { entries: { 0: makeEntry(0, 'Plain') } };
        fs.writeFileSync(path.join(worldsDir, 'Plain.json'), JSON.stringify(legacy));

        const res = await postJson('/api/worldinfo/get', { name: 'Plain' });
        expect(await res.json()).toEqual(legacy);
    });

    test('returns the dummy object for a book that does not exist', async () => {
        const res = await postJson('/api/worldinfo/get', { name: 'Nope' });
        expect(await res.json()).toEqual({ entries: {} });
    });
});

describe('worldinfo /delete', () => {
    test('removes both the manifest and the sidecar entries directory', async () => {
        const data = { entries: { 0: makeEntry(0, 'Alpha') } };
        await postJson('/api/worldinfo/edit', { name: 'Book', data });
        expect(fs.existsSync(entriesDirFor('Book'))).toBe(true);

        const res = await postJson('/api/worldinfo/delete', { name: 'Book' });
        expect(res.status).toBe(200);
        expect(fs.existsSync(path.join(worldsDir, 'Book.json'))).toBe(false);
        expect(fs.existsSync(entriesDirFor('Book'))).toBe(false);
    });

    test('removes a legacy (never-migrated) file with no sidecar directory just fine', async () => {
        fs.writeFileSync(path.join(worldsDir, 'Legacy.json'), JSON.stringify({ entries: {} }));

        const res = await postJson('/api/worldinfo/delete', { name: 'Legacy' });
        expect(res.status).toBe(200);
        expect(fs.existsSync(path.join(worldsDir, 'Legacy.json'))).toBe(false);
    });
});

describe('worldinfo /import', () => {
    test('imports as a plain legacy file, still readable via /get', async () => {
        const book = { entries: { 0: makeEntry(0, 'Imported content') } };
        const res = await postJson('/api/worldinfo/import', { importFilename: 'Cool Book.json', convertedData: JSON.stringify(book) });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ name: 'Cool Book' });

        const raw = JSON.parse(fs.readFileSync(path.join(worldsDir, 'Cool Book.json'), 'utf8'));
        expect(raw.format).toBeUndefined();
        expect(raw.entries['0'].content).toBe('Imported content');

        const getRes = await postJson('/api/worldinfo/get', { name: 'Cool Book' });
        expect(await getRes.json()).toEqual(book);
    });

    test('re-importing over a migrated (sidecar-format) book cleans up the old sidecar directory', async () => {
        await postJson('/api/worldinfo/edit', { name: 'Reimported', data: { entries: { 0: makeEntry(0, 'Old') } } });
        expect(fs.existsSync(entriesDirFor('Reimported'))).toBe(true);

        const book = { entries: { 0: makeEntry(0, 'Fresh import') } };
        await postJson('/api/worldinfo/import', { importFilename: 'Reimported.json', convertedData: JSON.stringify(book) });

        expect(fs.existsSync(entriesDirFor('Reimported'))).toBe(false);
        const getRes = await postJson('/api/worldinfo/get', { name: 'Reimported' });
        expect((await getRes.json()).entries['0'].content).toBe('Fresh import');
    });

    test('rejects a file with no entries list', async () => {
        const res = await postJson('/api/worldinfo/import', { importFilename: 'Bad.json', convertedData: JSON.stringify({ notEntries: true }) });
        expect(res.status).toBe(400);
    });
});

describe('worldinfo /list', () => {
    test('lists both legacy and sidecar-format books by name, unaffected by the storage format', async () => {
        fs.writeFileSync(path.join(worldsDir, 'LegacyOne.json'), JSON.stringify({ entries: {} }));
        await postJson('/api/worldinfo/edit', { name: 'SidecarOne', data: { entries: { 0: makeEntry(0, 'x') }, name: 'SidecarOne' } });

        const res = await postJson('/api/worldinfo/list', {});
        const names = (await res.json()).map(x => x.name).sort();
        expect(names).toEqual(['LegacyOne', 'SidecarOne']);
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
        expect(sourceManifest.entries.sort()).toEqual(['0']);
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
        fs.writeFileSync(path.join(worldsDir, 'External.json'), JSON.stringify({ entries: {} }));

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
