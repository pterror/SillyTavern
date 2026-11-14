import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, jest } from '@jest/globals';
import path from 'node:path';

import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

/** @type {typeof import('../src/endpoints/worldinfo.js')} */
let worldinfo;
/** @type {typeof import('../src/world-info-files.js')} */
let worldInfoFiles;
/** @type {typeof import('../src/user-stores.js')} */
let stores;
/** @type {import('node:http').Server} */
let server;
let baseUrl = '';
/** @type {Awaited<ReturnType<typeof import('./converted-user.fixture.js').convertedUser>>} */
let user;
/** @type {any} */
let directories;

beforeAll(async () => {
    user = await (await import('./converted-user.fixture.js')).convertedUser('st-worldinfo-test-');
    directories = user.directories;
    stores = await import('../src/user-stores.js');
    worldinfo = await import('../src/endpoints/worldinfo.js');
    worldInfoFiles = await import('../src/world-info-files.js');
    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use((/** @type {any} */ req, _res, next) => {
        req.user = user.user;
        next();
    });
    app.use('/api/worldinfo', worldinfo.router);
    app.use('/api/settings', (await import('../src/endpoints/settings.js')).router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
});

afterAll(async () => {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    await user.close();
});

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

async function saveBook(body) {
    return postJson('/api/worldinfo/create', { ...body, unique: false, replace: true });
}

async function getBook(name) {
    return worldInfoFiles.readWorldInfo(directories, name, true);
}

async function bookVersion(name) {
    const { lib } = await stores.userStore(directories, 'u');
    const [id] = await lib.ids(3, [name]);
    return (await lib.entities([id]))[0]?.version;
}

describe('a book saved whole', () => {
    test('a saved book reads back as it was saved, top-level fields and all', async () => {
        const data = { entries: { 0: makeEntry(0, 'Alpha'), 1: makeEntry(1, 'Beta') }, name: 'Book', extensions: { foo: 'bar' } };
        expect((await saveBook({ name: 'Book', data })).status).toBe(200);
        expect(await getBook('Book')).toEqual(data);
    });

    test('a save that changes nothing writes nothing', async () => {
        const data = { entries: { 0: makeEntry(0, 'Alpha') } };
        await saveBook({ name: 'Same', data });
        const before = await bookVersion('Same');
        await saveBook({ name: 'Same', data });
        expect(await bookVersion('Same')).toBe(before);
    });

    test('removing an entry removes only it', async () => {
        await saveBook({ name: 'Book', data: { entries: { 0: makeEntry(0, 'Alpha'), 1: makeEntry(1, 'Beta') } } });
        await saveBook({ name: 'Book', data: { entries: { 1: makeEntry(1, 'Beta') } } });
        expect(await getBook('Book')).toEqual({ entries: { 1: makeEntry(1, 'Beta') } });
    });

    test('a book that does not exist reads as the dummy object', async () => {
        expect(await getBook('Nope')).toEqual({ entries: {} });
    });
});

describe('readWorldInfoFile (upstream\'s synchronous export)', () => {
    test('reads what the asynchronous read reads; a missing book is the dummy object or null', async () => {
        const data = { entries: { 0: makeEntry(0, 'Alpha') }, name: 'Sync' };
        await saveBook({ name: 'Sync', data });
        expect(worldInfoFiles.readWorldInfoFile(directories, 'Sync', false)).toEqual(await getBook('Sync'));
        expect(worldInfoFiles.readWorldInfoFile(directories, 'Missing', true, { logMissing: false })).toEqual({ entries: {} });
        expect(worldInfoFiles.readWorldInfoFile(directories, 'Missing', false, { logMissing: false })).toBeNull();
        expect(worldInfoFiles.readWorldInfoFile(directories, '', true)).toEqual({ entries: {} });
    });

    test('before the store is open it opens it on this thread, and that is the store every later read and write uses', async () => {
        await saveBook({ name: 'Before', data: { entries: { 0: makeEntry(0, 'kept') } } });
        await stores.closeUserStores();
        expect(worldInfoFiles.readWorldInfoFile(directories, 'Before', false).entries['0'].content).toBe('kept');
        await saveBook({ name: 'Before', data: { entries: { 0: makeEntry(0, 'changed') } } });
        expect(worldInfoFiles.readWorldInfoFile(directories, 'Before', false).entries['0'].content).toBe('changed');
        expect((await getBook('Before')).entries['0'].content).toBe('changed');
    });
});

describe('deleting a book unlinks', () => {
    test('the characters and chats that link the book, and leaves no entry or deleted entry of it', async () => {
        const store = await stores.userStore(directories, 'u');
        const { lib, chats } = store;
        await saveBook({ name: 'Linked', data: { entries: { 0: makeEntry(0, 'Alpha'), 1: makeEntry(1, 'Beta') } } });
        const removed = await lib.books.apply('Linked', [{ uid: 1, base_hash: (await import('../public/scripts/hash-utils.js')).jsonHash(makeEntry(1, 'Beta')), data: null }], []);
        expect(removed).toMatchObject({ deleted: ['1'] });
        expect(/** @type {any} */ (await lib.books.deleted('Linked')).entries).toHaveLength(1);
        const card = { spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'Linker', extensions: { world: 'Linked' } } };
        await lib.writeCard(directories, 'linker.png', JSON.stringify(card));
        const [tree] = await lib.ids((await import('../src/library-codes.js')).TYPE.character, ['linker.png']);
        await chats.mergeMetadata({ tree, at: null, set: { world_info: 'Linked' }, unset: [], actor: { user: 'u' } });
        expect((await chats.metadata(tree, null)).world_info).toBe('Linked');
        const book = await lib.books.find('Linked');

        const gone = await lib.books.delete('Linked');
        expect(await lib.store.libraryKeys(/** @type {any} */ (gone).characters)).toMatchObject([{ key: 'linker.png' }]);
        expect(await lib.store.libraryKeys(/** @type {any} */ (gone).trees)).toMatchObject([{ key: 'linker.png' }]);

        expect((await chats.metadata(tree, null)).world_info).toBeUndefined();
        expect(/** @type {any} */ ((await lib.cards(['linker.png']))[0]).data.extensions.world).toBeUndefined();
        expect(await lib.store.worldRead('linkers', { book: book?.id, limit: 10 })).toEqual({ ids: [], more: false });
        expect(await lib.store.worldRead('chatLinks', { book: book?.id, limit: 10 })).toEqual({ changes: [], more: false });
        await saveBook({ name: 'Linked', data: { entries: {} } });
        expect(/** @type {any} */ (await lib.books.deleted('Linked')).entries).toEqual([]);
        expect((await chats.metadata(tree, null)).world_info).toBeUndefined();
        expect(/** @type {any} */ ((await lib.cards(['linker.png']))[0]).data.extensions.world).toBeUndefined();
    });
});

describe('a copy of a character\'s embedded lorebook', () => {
    const copy = { entries: { 0: makeEntry(0, 'Card lore') }, originalData: { name: 'Card book', entries: [{ id: 0, keys: ['key0'], content: 'Card lore', enabled: true, insertion_order: 100 }] } };

    test('is not stored by /create', async () => {
        expect((await saveBook({ name: 'Copy', data: copy })).status).toBe(400);
        expect(await getBook('Copy')).toEqual({ entries: {} });
    });
});

describe('worldinfo /create', () => {
    test('creates a brand-new, empty book with the given name when it is free', async () => {
        const res = await postJson('/api/worldinfo/create', { name: 'Fresh Book' });
        expect(await res.json()).toEqual({ ok: true, name: 'Fresh Book', unreachedLoops: [] });
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
        const { lib } = await stores.userStore(directories, 'u');
        expect((await lib.books.list()).map(b => b.file_id)).toEqual(['Taken (1)', 'Taken (2)', 'Taken']);
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

describe('worldinfo missing books', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    /**
     * @param {import('@jest/globals').jest.Spied<typeof console.error>} errorSpy
     * @param {string} name
     */
    function printsFor(errorSpy, name) {
        return errorSpy.mock.calls.filter(([message]) => String(message).includes(`${name}.json`)).length;
    }

    test('a read of a missing book answers an empty book every time and prints once, until the book is found again', async () => {
        const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
        for (let i = 0; i < 3; i++) {
            expect(await getBook('Ghost Get')).toEqual({ entries: {} });
            expect(worldInfoFiles.readWorldInfoFile(directories, 'Ghost Get', true)).toEqual({ entries: {} });
        }
        expect(printsFor(errors, 'Ghost Get')).toBe(1);
        await postJson('/api/worldinfo/create', { name: 'Ghost Get' });
        await getBook('Ghost Get');
        await (await stores.userStore(directories, 'u')).lib.books.delete('Ghost Get');
        await getBook('Ghost Get');
        expect(printsFor(errors, 'Ghost Get')).toBe(2);
    });
});

describe('lorebook actions', () => {
    /**
     * @param {string} name
     * @param {object} entries
     * @param {object} [extra]
     */
    async function writeBook(name, entries, extra = {}) {
        const res = await postJson('/api/worldinfo/create', { name, unique: false, data: { entries, ...extra } });
        expect(res.status).toBe(200);
    }

    /** @type {(value: unknown) => number} */
    let jsonHash;
    beforeAll(async () => {
        ({ jsonHash } = await import('../public/scripts/hash-utils.js'));
    });

    test('additional-books changes a character\'s links after the first, as an action, writing no settings', async () => {
        const { lib } = await stores.userStore(directories, 'u');
        const { readAllSettingsAsJson } = await import('../src/settings-store.js');
        const data = { name: 'Extra', description: '', personality: '', scenario: '', first_mes: '', mes_example: '', tags: [] };
        const card = (/** @type {string} */ world) => JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', ...data, data: { ...data, extensions: { world } } });
        for (const name of ['First', 'X', 'Y']) await writeBook(name, {});
        await lib.writeCard(directories, 'wi-extra.png', card('First'));
        const settingsBefore = readAllSettingsAsJson(directories);
        const op = async (/** @type {object} */ body) => postJson('/api/worldinfo/additional-books', { characterAvatar: 'wi-extra', ...body });

        expect(await (await op({ op: 'add', books: ['X', 'Y', 'X'] })).json()).toEqual({ result: 'ok', extraBooks: ['X', 'Y'] });
        expect(await (await op({ op: 'remove', books: ['X'] })).json()).toEqual({ result: 'ok', extraBooks: ['Y'] });
        expect(await (await op({ op: 'set', books: ['X', 'First'] })).json()).toEqual({ result: 'ok', extraBooks: ['X'] });
        expect(await lib.extraBookNames('wi-extra.png')).toEqual(['X']);
        expect(/** @type {any} */ ((await lib.cards(['wi-extra.png']))[0]).data.extensions.world).toBe('First');

        const unknownBook = await op({ op: 'add', books: ['Nope'] });
        expect(unknownBook.status).toBe(404);
        expect((await unknownBook.json()).unknownBooks).toEqual(['Nope']);
        const unknownCharacter = await postJson('/api/worldinfo/additional-books', { characterAvatar: 'nobody', op: 'add', books: ['Y'] });
        expect(unknownCharacter.status).toBe(404);
        expect(await lib.extraBookNames('wi-extra.png')).toEqual(['X']);
        expect(readAllSettingsAsJson(directories)).toBe(settingsBefore);
        expect((await op({ op: 'set', books: [] })).status).toBe(400);
        expect(await (await op({ op: 'remove', books: [] })).json()).toEqual({ result: 'ok', extraBooks: ['X'] });
    });

    test('a rename moves the characters\' links with the world: they name it by id', async () => {
        const { lib } = await stores.userStore(directories, 'u');
        const data = { name: 'Linker', description: '', personality: '', scenario: '', first_mes: '', mes_example: '', tags: [] };
        const card = (/** @type {string} */ world) => JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', ...data, data: { ...data, extensions: { world } } });
        await writeBook('Linked', {});
        await lib.writeCard(directories, 'wi-linker.png', card('Linked'));
        const linkOf = async () => {
            const [id] = await lib.ids(0, ['wi-linker.png']);
            const [e] = await lib.entities([id]);
            const [r] = await lib.store.worldRead('resolved', { ids: [/** @type {any} */ (e).link.book] });
            return r;
        };

        expect(await lib.books.rename('Linked', 'Linked 2')).toBe('ok');
        expect(await linkOf()).toMatchObject({ key: 'Linked 2', defined: true });

        expect(await lib.books.rename('Linked 2', 'Linked 3')).toBe('ok');
        expect(await linkOf()).toMatchObject({ key: 'Linked 3', defined: true });
    });
});

describe('the worlds chosen at the settings edges', () => {
    test('the page reads the worlds used in every chat and the characters\' extra links; no hash covers them and no save from the page changes them', async () => {
        const { lib } = await stores.userStore(directories, 'u');
        const { readSettingsAtPaths, writeSettingsKeys } = await import('../src/settings-store.js');
        const data = { name: 'Lore', description: '', personality: '', scenario: '', first_mes: '', mes_example: '', tags: [] };
        const card = JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', ...data, data: { ...data, extensions: { world: 'P' } } });
        for (const name of ['P', 'Q', 'R']) await lib.books.write(name, { entries: {} });
        await lib.writeCard(directories, 'wi-lore.png', card);
        await lib.extraLinks('wi-lore.png', 'add', ['Q', 'R']);
        writeSettingsKeys(directories, { world_info_settings: { world_info: { globalSelect: ['P'] } } });

        const got = await (await postJson('/api/settings/get', {})).json();
        const settings = JSON.parse(got.settings);
        expect(settings.world_info_settings.world_info.charLore).toContainEqual({ name: 'wi-lore', extraBooks: ['Q', 'R'] });
        expect(settings.world_info_settings.world_info.globalSelect).toEqual(['P']);
        expect(got.keyHashes['world_info_settings.world_info']).toBeUndefined();
        expect(got.keyHashes['world_info_settings.world_info.charLore']).toBeUndefined();

        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const settled = () => new Promise(resolve => setTimeout(resolve, 200));
        try {
            const other = { globalSelect: ['Q'], charLore: [{ name: 'wi-lore', extraBooks: ['P'] }] };
            expect((await postJson('/api/settings/save-partial', { keys: { 'world_info_settings.world_info': other } })).status).toBe(200);
            expect((await postJson('/api/settings/save-partial', { keys: { world_info_settings: { world_info: other } } })).status).toBe(200);
            await settled();
            expect(readSettingsAtPaths(directories, ['world_info_settings.world_info'])['world_info_settings.world_info']).toEqual({ globalSelect: ['P'] });
            expect((await postJson('/api/settings/save', { ...settings, world_info_settings: { world_info: other } })).status).toBe(200);
            await settled();
            expect(readSettingsAtPaths(directories, ['world_info_settings.world_info'])['world_info_settings.world_info']).toEqual({ globalSelect: ['P'] });
            expect(await lib.extraBookNames('wi-lore.png')).toEqual(['Q', 'R']);
        } finally {
            warn.mockRestore();
        }
    });
});

describe('the entry endpoints the slash commands use', () => {
    test('create makes an entry with the fields asked for; get reads it with its timed effect hash; set changes fields; find finds it', async () => {
        await saveBook({ name: 'Slash', data: { entries: { 0: makeEntry(0, 'Alpha') } } });
        const made = await (await postJson('/api/worldinfo/entry/create', { name: 'Slash', data: { key: ['beacon'], content: 'Bright' } })).json();
        expect(made).toEqual({ ok: true, entry: { uid: 1 } });
        const read = await (await postJson('/api/worldinfo/entry/get', { name: 'Slash', uid: 1 })).json();
        expect(read.entry).toMatchObject({ uid: 1, key: ['beacon'], content: 'Bright' });
        expect(typeof read.hash).toBe('number');
        expect((await postJson('/api/worldinfo/entry/set', { name: 'Slash', uid: '1', fields: { content: 'Dim', characterFilter: { isExclude: true } } })).status).toBe(200);
        const changed = await (await postJson('/api/worldinfo/entry/get', { name: 'Slash', uid: 1 })).json();
        expect(changed.entry).toMatchObject({ content: 'Dim', characterFilter: { isExclude: true, names: [], tags: [] } });
        expect(changed.hash).not.toBe(read.hash);
        expect(await (await postJson('/api/worldinfo/entry/find', { name: 'Slash', field: 'key', text: 'beacon' })).json()).toEqual({ uid: 1 });
        expect(await (await postJson('/api/worldinfo/entry/find', { name: 'Slash', field: 'content', text: 'nothing like it' })).json()).toEqual({ uid: null });
    });

    test('a missing book or entry is 404, a malformed ask 400', async () => {
        await saveBook({ name: 'Slash', data: { entries: { 0: makeEntry(0, 'Alpha') } } });
        expect((await postJson('/api/worldinfo/entry/get', { name: 'Nope', uid: 0 })).status).toBe(404);
        expect((await postJson('/api/worldinfo/entry/get', { name: 'Slash', uid: 9 })).status).toBe(404);
        expect((await postJson('/api/worldinfo/entry/set', { name: 'Slash', uid: 9, fields: { content: 'x' } })).status).toBe(404);
        expect((await postJson('/api/worldinfo/entry/create', { name: 'Nope', data: {} })).status).toBe(404);
        expect((await postJson('/api/worldinfo/entry/get', { name: 'Slash' })).status).toBe(400);
        expect((await postJson('/api/worldinfo/entry/find', { name: 'Slash', field: 'nope', text: 'x' })).status).toBe(400);
    });
});
