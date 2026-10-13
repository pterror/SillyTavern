import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, jest } from '@jest/globals';
import path from 'node:path';

import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

/** @type {typeof import('../src/endpoints/worldinfo.js')} */
let worldinfo;
/** @type {typeof import('../src/user-stores.js')} */
let stores;
/** @type {import('node:http').Server} */
let server;
let baseUrl = '';
/** @type {Awaited<ReturnType<typeof import('./converted-user.fixture.js').convertedUser>>} */
let user;
/** @type {any} */
let directories;

/**
 * The real worldinfo.js router over a store converted from the synthetic old user, behind a fake auth middleware,
 * plus a stand-in for the multer middleware that attaches `req.file` ahead of `/import` in server-startup.js.
 */
beforeAll(async () => {
    user = await (await import('./converted-user.fixture.js')).convertedUser('st-worldinfo-test-');
    directories = user.directories;
    stores = await import('../src/user-stores.js');
    worldinfo = await import('../src/endpoints/worldinfo.js');
    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use((/** @type {any} */ req, _res, next) => {
        req.user = user.user;
        next();
    });
    app.use('/api/worldinfo/import', (/** @type {any} */ req, _res, next) => {
        req.file = { originalname: req.body.importFilename || 'Imported.json' };
        next();
    });
    app.use('/api/worldinfo', worldinfo.router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
});

afterAll(async () => {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    await user.close();
});

/** Each test starts with no books. */
beforeEach(async () => {
    const { lib } = await stores.userStore(directories, 'u');
    for (const book of await lib.books.list()) await lib.books.delete(book.file_id);
});

async function postJson(urlPath, body) {
    return fetch(`${baseUrl}${urlPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

function makeEntry(uid, content) {
    return { uid, key: [`key${uid}`], content, comment: '', disable: false };
}

async function getBook(name) {
    return (await postJson('/api/worldinfo/get', { name })).json();
}

/** The stored version of a book's entity (it moves on every write to the book). */
async function bookVersion(name) {
    const { lib } = await stores.userStore(directories, 'u');
    const [id] = await lib.ids(3, [name]);
    return (await lib.entities([id]))[0]?.version;
}

describe('worldinfo /edit and /get', () => {
    test('a saved book reads back as it was saved, top-level fields and all', async () => {
        const data = { entries: { 0: makeEntry(0, 'Alpha'), 1: makeEntry(1, 'Beta') }, name: 'Book', extensions: { foo: 'bar' } };
        expect((await postJson('/api/worldinfo/edit', { name: 'Book', data })).status).toBe(200);
        expect(await getBook('Book')).toEqual(data);
    });

    test('a save that changes nothing writes nothing', async () => {
        const data = { entries: { 0: makeEntry(0, 'Alpha') } };
        await postJson('/api/worldinfo/edit', { name: 'Same', data });
        const before = await bookVersion('Same');
        await postJson('/api/worldinfo/edit', { name: 'Same', data });
        expect(await bookVersion('Same')).toBe(before);
    });

    test('removing an entry removes only it', async () => {
        await postJson('/api/worldinfo/edit', { name: 'Book', data: { entries: { 0: makeEntry(0, 'Alpha'), 1: makeEntry(1, 'Beta') } } });
        await postJson('/api/worldinfo/edit', { name: 'Book', data: { entries: { 1: makeEntry(1, 'Beta') } } });
        expect(await getBook('Book')).toEqual({ entries: { 1: makeEntry(1, 'Beta') } });
    });

    test('rejects a book without entries', async () => {
        expect((await postJson('/api/worldinfo/edit', { name: 'Bad', data: { notEntries: true } })).status).toBe(400);
        expect((await postJson('/api/worldinfo/edit', { data: { entries: {} } })).status).toBe(400);
    });

    test('/get returns the dummy object for a book that does not exist', async () => {
        expect(await getBook('Nope')).toEqual({ entries: {} });
    });
});

describe('readWorldInfoFile (upstream\'s synchronous export)', () => {
    test('reads what /get reads; a missing book is the dummy object or null', async () => {
        const data = { entries: { 0: makeEntry(0, 'Alpha') }, name: 'Sync' };
        await postJson('/api/worldinfo/edit', { name: 'Sync', data });
        expect(worldinfo.readWorldInfoFile(directories, 'Sync', false)).toEqual(await getBook('Sync'));
        expect(worldinfo.readWorldInfoFile(directories, 'Missing', true, { logMissing: false })).toEqual({ entries: {} });
        expect(worldinfo.readWorldInfoFile(directories, 'Missing', false, { logMissing: false })).toBeNull();
        expect(worldinfo.readWorldInfoFile(directories, '', true)).toEqual({ entries: {} });
    });

    test('before the store is open it opens it on this thread, and that is the store every later read and write uses', async () => {
        await postJson('/api/worldinfo/edit', { name: 'Before', data: { entries: { 0: makeEntry(0, 'kept') } } });
        await stores.closeUserStores();
        expect(worldinfo.readWorldInfoFile(directories, 'Before', false).entries['0'].content).toBe('kept');
        await postJson('/api/worldinfo/edit', { name: 'Before', data: { entries: { 0: makeEntry(0, 'changed') } } });
        expect(worldinfo.readWorldInfoFile(directories, 'Before', false).entries['0'].content).toBe('changed');
        expect((await getBook('Before')).entries['0'].content).toBe('changed');
    });
});

describe('worldinfo /delete', () => {
    test('deletes the book; a missing one fails', async () => {
        await postJson('/api/worldinfo/edit', { name: 'Book', data: { entries: { 0: makeEntry(0, 'Alpha') } } });
        expect((await postJson('/api/worldinfo/delete', { name: 'Book' })).status).toBe(200);
        expect(await getBook('Book')).toEqual({ entries: {} });
        const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            expect((await postJson('/api/worldinfo/delete', { name: 'Book' })).status).toBe(500);
        } finally {
            errors.mockRestore();
        }
    });
});

describe('worldinfo /import', () => {
    test('stores the book, and /get reads back what was imported', async () => {
        const book = { entries: { 0: makeEntry(0, 'Imported content') }, name: 'Cool Book', extensions: { foo: 'bar' } };
        const res = await postJson('/api/worldinfo/import', { importFilename: 'Cool Book.json', convertedData: JSON.stringify(book) });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ name: 'Cool Book' });
        expect(await getBook('Cool Book')).toEqual(book);
    });

    test('re-importing over a stored book replaces it', async () => {
        await postJson('/api/worldinfo/edit', { name: 'Reimported', data: { entries: { 0: makeEntry(0, 'Old'), 1: makeEntry(1, 'Gone') } } });
        const book = { entries: { 0: makeEntry(0, 'Fresh import') } };
        await postJson('/api/worldinfo/import', { importFilename: 'Reimported.json', convertedData: JSON.stringify(book) });
        expect(await getBook('Reimported')).toEqual(book);
    });

    test('rejects a file with no entries list', async () => {
        const res = await postJson('/api/worldinfo/import', { importFilename: 'Bad.json', convertedData: JSON.stringify({ notEntries: true }) });
        expect(res.status).toBe(400);
    });
});

describe('worldinfo /list', () => {
    test('lists books by file name, with their names and extensions', async () => {
        await postJson('/api/worldinfo/import', { importFilename: 'ImportedOne.json', convertedData: JSON.stringify({ entries: {} }) });
        await postJson('/api/worldinfo/edit', { name: 'SavedOne', data: { entries: { 0: makeEntry(0, 'x') }, name: 'Shown Name', extensions: { a: 1 } } });
        const res = await postJson('/api/worldinfo/list', {});
        expect(await res.json()).toEqual([
            { file_id: 'ImportedOne', name: 'ImportedOne', extensions: {} },
            { file_id: 'SavedOne', name: 'Shown Name', extensions: { a: 1 } },
        ]);
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
        expect(body.entry.uid).toBe(0);
        expect(body.entry.displayIndex).toBe(4);

        const source = await getBook('Source');
        expect(source.entries['0']).toBeUndefined();
        expect(source.entries['1'].content).toBe('Stays behind');
        const target = await getBook('Target');
        expect(target.entries['0']).toEqual(body.entry);
        expect(target.entries['5'].content).toBe('Already there');
    });

    test('copies an entry (delete_original: false): present in both books afterward', async () => {
        await seedBooks();
        const res = await postJson('/api/worldinfo/entry/transplant', {
            source_name: 'Source', target_name: 'Target', uid: 0, delete_original: false,
        });
        expect(res.status).toBe(200);
        expect((await getBook('Source')).entries['0'].content).toBe('Moved');
        expect(Object.values((await getBook('Target')).entries).some((/** @type {any} */ e) => e.content === 'Moved')).toBe(true);
    });

    test('rejects a nonexistent source uid, source or target book without touching either book', async () => {
        await seedBooks();
        for (const body of [
            { source_name: 'Source', target_name: 'Target', uid: 999 },
            { source_name: 'Ghost', target_name: 'Target', uid: 0 },
            { source_name: 'Source', target_name: 'Ghost', uid: 0 },
        ]) {
            expect((await postJson('/api/worldinfo/entry/transplant', { ...body, delete_original: true })).status).toBe(404);
        }
        expect(Object.keys((await getBook('Source')).entries).sort()).toEqual(['0', '1']);
        expect(Object.keys((await getBook('Target')).entries)).toEqual(['5']);
    });

    test('rejects source_name === target_name, and a missing uid', async () => {
        await seedBooks();
        expect((await postJson('/api/worldinfo/entry/transplant', { source_name: 'Source', target_name: 'Source', uid: 0 })).status).toBe(400);
        expect((await postJson('/api/worldinfo/entry/transplant', { source_name: 'Source', target_name: 'Target' })).status).toBe(400);
    });
});

describe('worldinfo /entry/create and /entry/edit', () => {
    test('mints the lowest free uid and reserves it; two calls never collide', async () => {
        await postJson('/api/worldinfo/edit', { name: 'Book', data: { entries: { 0: makeEntry(0, 'Alpha'), 1: makeEntry(1, 'Beta') } } });
        const first = await (await postJson('/api/worldinfo/entry/create', { name: 'Book' })).json();
        const second = await (await postJson('/api/worldinfo/entry/create', { name: 'Book' })).json();
        expect(first).toEqual({ ok: true, entry: { uid: 2 } });
        expect(second).toEqual({ ok: true, entry: { uid: 3 } });
        expect(Object.keys((await getBook('Book')).entries).sort()).toEqual(['0', '1', '2', '3']);
    });

    test('create rejects a nonexistent book and a missing name', async () => {
        expect((await postJson('/api/worldinfo/entry/create', { name: 'Ghost' })).status).toBe(404);
        expect((await postJson('/api/worldinfo/entry/create', {})).status).toBe(400);
    });

    test('edit writes one entry whole and keeps its uid', async () => {
        await postJson('/api/worldinfo/edit', { name: 'Book', data: { entries: { 0: makeEntry(0, 'Alpha'), 1: makeEntry(1, 'Beta') } } });
        const res = await postJson('/api/worldinfo/entry/edit', { name: 'Book', uid: 1, data: { ...makeEntry(7, 'Changed') } });
        const changed = { ...makeEntry(7, 'Changed'), uid: 1 };
        expect(await res.json()).toEqual({ ok: true, entry: changed });
        expect(await getBook('Book')).toEqual({ entries: { 0: makeEntry(0, 'Alpha'), 1: changed } });
        expect((await postJson('/api/worldinfo/entry/edit', { name: 'Book', uid: 9, data: {} })).status).toBe(404);
        expect((await postJson('/api/worldinfo/entry/edit', { name: 'Ghost', uid: 0, data: {} })).status).toBe(404);
        expect((await postJson('/api/worldinfo/entry/edit', { name: 'Book', uid: 0, data: [] })).status).toBe(400);
    });
});

describe('worldinfo /create', () => {
    test('creates a brand-new, empty book with the given name when it is free', async () => {
        const res = await postJson('/api/worldinfo/create', { name: 'Fresh Book' });
        expect(await res.json()).toEqual({ ok: true, name: 'Fresh Book' });
        expect((await getBook('Fresh Book')).entries).toEqual({});
    });

    test('defaults to "New World" when no name or a blank one is given', async () => {
        expect((await (await postJson('/api/worldinfo/create', {})).json()).name).toBe('New World');
        expect((await (await postJson('/api/worldinfo/create', { name: '   ' })).json()).name).toBe('New World (1)');
    });

    test('silently mints "<name> (<N>)" against the stored books when the name is taken (default unique:true)', async () => {
        await postJson('/api/worldinfo/create', { name: 'Taken' });
        expect((await (await postJson('/api/worldinfo/create', { name: 'Taken' })).json()).name).toBe('Taken (1)');
        expect((await (await postJson('/api/worldinfo/create', { name: 'Taken' })).json()).name).toBe('Taken (2)');
        const res = await postJson('/api/worldinfo/list', {});
        expect((await res.json()).map((/** @type {any} */ b) => b.file_id)).toEqual(['Taken (1)', 'Taken (2)', 'Taken']);
    });

    test('unique:false rejects a taken name, unless replace; creates the exact name when it is free', async () => {
        expect((await postJson('/api/worldinfo/create', { name: 'Exact', unique: false })).status).toBe(200);
        expect((await postJson('/api/worldinfo/create', { name: 'Exact', unique: false })).status).toBe(409);
        const data = { entries: { 0: makeEntry(0, 'Replaced') } };
        expect((await postJson('/api/worldinfo/create', { name: 'Exact', unique: false, replace: true, data })).status).toBe(200);
        expect(await getBook('Exact')).toEqual(data);
    });

    test('rejects a non-string name and data without entries', async () => {
        expect((await postJson('/api/worldinfo/create', { name: 42 })).status).toBe(400);
        expect((await postJson('/api/worldinfo/create', { name: 'X', data: { notEntries: 1 } })).status).toBe(400);
    });
});

describe('worldinfo /search', () => {
    test('a world book\'s and a character\'s own book\'s entries, paged by cursor, 50 when no limit is sent', async () => {
        const entries = {};
        for (let i = 0; i < 60; i++) entries[i] = makeEntry(i, `dragon ${i}`);
        await postJson('/api/worldinfo/edit', { name: 'Searched', data: { entries } });
        const first = await (await postJson('/api/worldinfo/search', { name: 'Searched', search: 'dragon' })).json();
        expect(first.entries).toHaveLength(50);
        expect(first.total).toBe(60);
        const rest = await (await postJson('/api/worldinfo/search', { name: 'Searched', search: 'dragon', limit: 50, cursor: first.cursor })).json();
        expect(rest.entries).toHaveLength(10);
        expect(rest.cursor).toBeUndefined();
        expect(new Set([...first.entries, ...rest.entries].map(e => e.uid)).size).toBe(60);
        const keyed = await (await postJson('/api/worldinfo/search', { name: 'Searched', search: 'key7', limit: 5 })).json();
        expect(keyed.entries.map(e => e.uid)).toEqual(['7']);

        const { lib } = await stores.userStore(directories, 'u');
        const card = { spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'C', character_book: { entries: [{ id: 3, keys: ['wyvern'], secondary_keys: [], comment: '', content: 'scales', extensions: {} }] } } };
        await lib.writeCard(directories, 'wi-search.png', JSON.stringify(card));
        const own = await (await postJson('/api/worldinfo/search', { avatar: 'wi-search.png', search: 'wyv' })).json();
        expect(own.entries.map(e => e.uid)).toEqual(['0']);
        await lib.deleteEntity(0, 'wi-search.png');
    });

    test('a missing book or character is 404; a bad body is 400', async () => {
        expect((await postJson('/api/worldinfo/search', { name: 'Nope', search: 'x' })).status).toBe(404);
        expect((await postJson('/api/worldinfo/search', { avatar: 'nope.png', search: 'x' })).status).toBe(404);
        await postJson('/api/worldinfo/create', { name: 'Bad Bodies' });
        for (const body of [
            { search: 'x' },
            { name: 'Bad Bodies', avatar: 'a.png', search: 'x' },
            { name: 'Bad Bodies' },
            { name: 'Bad Bodies', search: 'x', limit: 0 },
            { name: 'Bad Bodies', search: 'x', limit: 501 },
            { name: 'Bad Bodies', search: 'x', limit: 2.5 },
            { name: 'Bad Bodies', search: 'x', limit: '5' },
            { name: 'Bad Bodies', search: 'x', cursor: 5 },
        ]) {
            expect((await postJson('/api/worldinfo/search', body)).status).toBe(400);
        }
        expect((await postJson('/api/worldinfo/search', { name: 'Bad Bodies', search: 'x', limit: 500 })).status).toBe(200);
    });
});

describe('worldinfo missing books', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    /** @param {import('@jest/globals').jest.Spied<typeof console.error>} errorSpy @param {string} name */
    function printsFor(errorSpy, name) {
        return errorSpy.mock.calls.filter(([message]) => String(message).includes(`${name}.json`)).length;
    }

    test('/get of a missing book answers an empty book every time and prints once, until the book is found again', async () => {
        const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
        for (let i = 0; i < 3; i++) {
            expect(await getBook('Ghost Get')).toEqual({ entries: {} });
            expect(worldinfo.readWorldInfoFile(directories, 'Ghost Get', true)).toEqual({ entries: {} });
        }
        expect(printsFor(errors, 'Ghost Get')).toBe(1);
        await postJson('/api/worldinfo/create', { name: 'Ghost Get' });
        await getBook('Ghost Get');
        await postJson('/api/worldinfo/delete', { name: 'Ghost Get' });
        await getBook('Ghost Get');
        expect(printsFor(errors, 'Ghost Get')).toBe(2);
    });

    test('worldInfoFileExists never prints', async () => {
        const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
        expect(await worldinfo.worldInfoFileExists(directories, 'Ghost Quiet')).toBe(false);
        expect(printsFor(errors, 'Ghost Quiet')).toBe(0);
        await postJson('/api/worldinfo/create', { name: 'Ghost Quiet' });
        expect(await worldinfo.worldInfoFileExists(directories, 'Ghost Quiet')).toBe(true);
    });
});

describe('lorebook actions', () => {
    /** @param {string} name @param {object} entries @param {object} [extra] */
    async function writeBook(name, entries, extra = {}) {
        const res = await postJson('/api/worldinfo/create', { name, unique: false, data: { entries, ...extra } });
        expect(res.status).toBe(200);
    }

    /** @type {(value: unknown) => number} */
    let jsonHash;
    beforeAll(async () => {
        ({ jsonHash } = await import('../public/scripts/hash-utils.js'));
    });

    test('apply stores only the changes made against the version the page had, and reports the rest', async () => {
        await writeBook('Apply', { 0: makeEntry(0, 'zero'), 1: makeEntry(1, 'one'), 2: makeEntry(2, 'two') }, { name: 'Apply' });
        const loaded = await getBook('Apply');
        const loadedHash = uid => jsonHash(loaded.entries[uid]);

        // Another tab changes entry 1 and adds entry 3 after this page loaded the book.
        await postJson('/api/worldinfo/entry/edit', { name: 'Apply', uid: 1, data: makeEntry(1, 'one, elsewhere') });
        await postJson('/api/worldinfo/entries/apply', { name: 'Apply', entries: [{ uid: 3, base_hash: null, data: makeEntry(3, 'three, elsewhere') }] });

        const res = await postJson('/api/worldinfo/entries/apply', {
            name: 'Apply',
            entries: [
                { uid: 0, base_hash: loadedHash(0), data: makeEntry(0, 'zero, here') },
                { uid: 1, base_hash: loadedHash(1), data: makeEntry(1, 'one, here') },
                { uid: 2, base_hash: loadedHash(2), data: null },
            ],
            fields: [{ key: 'name', base_hash: jsonHash('Apply'), value: 'Applied' }],
        });
        expect(res.status).toBe(200);
        const result = await res.json();
        expect(Object.keys(result.entries)).toEqual(['0']);
        expect(result.deleted).toEqual(['2']);
        expect(result.fields).toEqual({ name: 'Applied' });
        expect(result.conflicts).toEqual([{ uid: '1', current: makeEntry(1, 'one, elsewhere') }]);

        const after = await getBook('Apply');
        expect(Object.fromEntries(Object.entries(after.entries).map(([uid, entry]) => [uid, entry.content]))).toEqual({
            0: 'zero, here', 1: 'one, elsewhere', 3: 'three, elsewhere',
        });
        expect(after.name).toBe('Applied');
    });

    test('a new entry whose uid was taken since is a conflict, and an unchanged apply writes nothing', async () => {
        await writeBook('Taken', { 0: makeEntry(0, 'zero') });
        const conflict = await (await postJson('/api/worldinfo/entries/apply', { name: 'Taken', entries: [{ uid: 0, base_hash: null, data: makeEntry(0, 'mine') }] })).json();
        expect(conflict.conflicts).toEqual([{ uid: '0', current: makeEntry(0, 'zero') }]);

        const before = await bookVersion('Taken');
        const same = await (await postJson('/api/worldinfo/entries/apply', { name: 'Taken', entries: [{ uid: 0, base_hash: jsonHash(makeEntry(0, 'zero')), data: makeEntry(0, 'zero') }] })).json();
        expect(same).toEqual({ ok: true, entries: {}, deleted: [], fields: {}, conflicts: [] });
        expect(await bookVersion('Taken')).toBe(before);
    });

    test('apply: a missing book is 404 before a malformed change is 400', async () => {
        expect((await postJson('/api/worldinfo/entries/apply', { name: 'Ghost', entries: [{ data: 1 }] })).status).toBe(404);
        await writeBook('Checked', {});
        expect((await postJson('/api/worldinfo/entries/apply', { name: 'Checked', entries: [{ uid: 0, data: 1 }] })).status).toBe(400);
        expect((await postJson('/api/worldinfo/entries/apply', { name: 'Checked', entries: [{ data: {} }] })).status).toBe(400);
        expect((await postJson('/api/worldinfo/entries/apply', { name: 'Checked', fields: [{ key: 'entries' }] })).status).toBe(400);
    });

    test('duplicate copies on the server and refuses a taken name', async () => {
        await writeBook('Original', { 0: makeEntry(0, 'zero') });
        expect((await postJson('/api/worldinfo/duplicate', { name: 'Original', new_name: 'Copy' })).status).toBe(200);
        expect((await getBook('Copy')).entries['0'].content).toBe('zero');
        expect((await postJson('/api/worldinfo/duplicate', { name: 'Original', new_name: 'Copy' })).status).toBe(409);
        expect((await postJson('/api/worldinfo/duplicate', { name: 'Ghost', new_name: 'Copy 2' })).status).toBe(404);
    });

    test('rename moves the book and the links naming it in settings', async () => {
        const { writeAllSettings, readSettingsAtPaths } = await import('../src/settings-store.js');
        writeAllSettings(directories, {
            world_info_settings: { world_info: { globalSelect: ['Old', 'Other'], charLore: [{ name: 'a.png', extraBooks: ['Old', 'Other'] }] } },
            power_user: { persona_data: { 'p.png': { lorebook: 'Old' }, 'q.png': { lorebook: 'Other' } } },
        });
        await writeBook('Old', { 0: makeEntry(0, 'zero') });

        const res = await postJson('/api/worldinfo/rename', { name: 'Old', new_name: 'New' });
        expect(res.status).toBe(200);
        const result = await res.json();
        expect(result.characters_updated).toEqual([]);
        expect(result.characters_failed).toEqual([]);
        expect(await getBook('Old')).toEqual({ entries: {} });
        expect((await getBook('New')).entries['0'].content).toBe('zero');

        const stored = readSettingsAtPaths(directories, ['world_info_settings', 'power_user.persona_data']);
        expect(stored.world_info_settings.world_info).toEqual({ globalSelect: ['New', 'Other'], charLore: [{ name: 'a.png', extraBooks: ['New', 'Other'] }] });
        expect(stored['power_user.persona_data']).toEqual({ 'p.png': { lorebook: 'New' }, 'q.png': { lorebook: 'Other' } });
        expect(result.settings).toEqual(stored);
        expect(typeof result.settings_hash).toBe('number');

        await writeBook('Taken2', { 0: makeEntry(0, 'x') });
        expect((await postJson('/api/worldinfo/rename', { name: 'New', new_name: 'Taken2' })).status).toBe(409);
        expect((await postJson('/api/worldinfo/rename', { name: 'Ghost', new_name: 'Elsewhere' })).status).toBe(404);
    });

    test('rename with relink_characters moves the characters\' links and answers them; without, they keep the old name', async () => {
        const { lib } = await stores.userStore(directories, 'u');
        const data = { name: 'Linker', description: '', personality: '', scenario: '', first_mes: '', mes_example: '', tags: [] };
        const card = (/** @type {string} */ world) => JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', ...data, data: { ...data, extensions: { world } } });
        await writeBook('Linked', {});
        await lib.writeCard(directories, 'wi-linker.png', card('Linked'));
        const linkOf = async () => {
            const [id] = await lib.ids(0, ['wi-linker.png']);
            const [book] = await lib.store.worldRead('links', { ids: [id] });
            const [r] = await lib.store.worldRead('resolved', { ids: [book] });
            return r;
        };

        const moved = await (await postJson('/api/worldinfo/rename', { name: 'Linked', new_name: 'Linked 2', relink_characters: true })).json();
        expect(moved.characters_updated).toEqual(['wi-linker.png']);
        expect(await linkOf()).toMatchObject({ key: 'Linked 2', defined: true });

        const kept = await (await postJson('/api/worldinfo/rename', { name: 'Linked 2', new_name: 'Linked 3' })).json();
        expect(kept.characters_updated).toEqual([]);
        expect(await linkOf()).toMatchObject({ key: 'Linked 2', defined: false });
    });
});
