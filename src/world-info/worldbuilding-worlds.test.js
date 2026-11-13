import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';

import { TYPE } from '../library-codes.js';
import { CHOICE, readChoices, takeUpstreamLastOpened } from '../settings-model/book-choices.js';
import { EMBEDDED_NAME_REFUSAL, LENGTH_REFUSAL, NAME_REFUSAL, worldbuildingWorldPorts } from './worldbuilding-worlds.js';
import { withPictureUrls } from './worldbuilding-pictures.js';

const { emptyUser } = await import('../../tests/converted-user.fixture.js');
const user = await emptyUser('st-worldbuilding-worlds-test-');
after(() => user.close());
const lib = user.store.lib;
const uiUser = /** @type {import('@st/server-ui').User} */ ({ handle: 'u', directories: user.directories });
const who = { user: uiUser, session: 's' };

/** @type {import('../settings-documents.js').BookChooser[][]} */
const changes = [];
const ports = worldbuildingWorldPorts({
    libOf: async () => lib,
    async booksChanged(_user, change) {
        const done = await change();
        changes.push(done.choosers);
        return done;
    },
});

const holder = lib.nextId++;
await lib.store.commit([{ kind: 'entityCreate', entity: holder, type: TYPE.user, key: 'u', added: 0 }]);

/**
 * @param {import('@st/worldbuilding/server').NewWorld | 'missing'} made
 */
function bookOf(made) {
    if (typeof made === 'string' || 'refused' in made) throw new Error(`nothing made: ${JSON.stringify(made)}`);
    return made.book;
}

/**
 * @param {string} name
 * @param {unknown} contents
 */
function upload(name, contents) {
    const file = path.join(user.dataRoot, `upload-${name}`);
    fs.writeFileSync(file, JSON.stringify(contents));
    return { path: file, name, type: 'application/json', size: 0 };
}

const names = async () => (await ports.readWorlds(uiUser)).map(w => w.name);

test('a world is made under the name asked for, refused when taken, reserved or no name a world can have', async () => {
    const lantern = bookOf(await ports.createWorld(who, 'Lantern'));
    assert.deepEqual(await ports.readWorld(uiUser, lantern), { id: lantern, name: 'Lantern', entries: 0, usedInEveryChat: false, namesOffer: null, picture: null, description: '', cameWith: null });
    assert.deepEqual(await ports.createWorld(who, 'Lantern'), { refused: 'A world named "Lantern" already exists.' });
    assert.deepEqual(await ports.createWorld(who, '__embedded__'), { refused: EMBEDDED_NAME_REFUSAL });
    assert.deepEqual(await ports.createWorld(who, 'a/b'), { refused: NAME_REFUSAL });
    assert.deepEqual(await ports.createWorld(who, 'con'), { refused: NAME_REFUSAL });
    assert.deepEqual(await ports.createWorld(who, 'é'.repeat(126)), { refused: LENGTH_REFUSAL });
    assert.equal(await ports.readWorld(uiUser, '999999'), null);
});

test('a file is imported under its own name, made free when taken, and counted from the kept counts', async () => {
    const book = { entries: { 0: { uid: 0, key: ['Ilse'], comment: ' Ilse', content: 'Keeper.' }, 1: { uid: 1, key: ['lamp'], content: 'A lamp.' } } };
    const ashfall = bookOf(await ports.importWorld(who, upload('Ashfall.json', book)));
    const read = await ports.readWorld(uiUser, ashfall);
    assert.deepEqual({ ...read, namesOffer: null }, { id: ashfall, name: 'Ashfall', entries: 2, usedInEveryChat: false, namesOffer: null, picture: null, description: '', cameWith: null });
    assert.deepEqual({ ...read?.namesOffer, example: read?.namesOffer?.example?.text }, { entries: 1, example: ' Ilse', running: null, marked: 0 }, 'an imported key with the title\'s words is offered as a name');
    assert.equal(await ports.markTitleKeysAsNames(who, ashfall), 'ok');
    assert.deepEqual((await ports.readWorld(uiUser, ashfall))?.namesOffer, null, 'a book of one chunk is marked in the action\'s own request');
    const thing = String(read?.namesOffer?.example?.thing);
    assert.deepEqual(await lib.store.worldRead('worldbuildingLabels', { book: BigInt(ashfall), entities: [BigInt(thing)] }), [{ thing, text: ' Ilse', shownAs: 'name' }]);
    const again = bookOf(await ports.importWorld(who, upload('Ashfall.json', { kind: 'memory', entries: [{ name: 'Inn', entry: 'An inn.', keywords: ['inn'], weight: 1, enabled: true }] })));
    assert.deepEqual(await ports.readWorld(uiUser, again), { id: again, name: 'Ashfall (1)', entries: 1, usedInEveryChat: false, namesOffer: null, picture: null, description: '', cameWith: null });
    assert.deepEqual(await ports.importWorld(who, upload('notes.json', { notes: [] })), { refused: 'This file isn\'t a world: it holds no entries SillyTavern, NovelAI, Agnai or Risu can make.' });
    assert.deepEqual(await names(), ['Ashfall (1)', 'Ashfall', 'Lantern']);
});

test('a copy takes the next free name and every entry; an export is the world file under its name', async () => {
    const [ashfall] = (await ports.readWorlds(uiUser)).filter(w => w.name === 'Ashfall');
    const copy = bookOf(await ports.duplicateWorld(who, ashfall.id));
    assert.deepEqual(await ports.readWorld(uiUser, copy), { id: copy, name: 'Ashfall (2)', entries: 2, usedInEveryChat: false, namesOffer: null, picture: null, description: '', cameWith: null });
    const exported = await ports.exportWorld(uiUser, copy);
    assert.equal(exported?.fileName, 'Ashfall (2).json');
    assert.deepEqual(Object.values(JSON.parse(exported?.json ?? '{}').entries).map((/** @type {any} */ e) => e.key), [['Ilse'], ['lamp']]);
    assert.equal(await ports.duplicateWorld(who, '999999'), 'missing');
    assert.equal(await ports.exportWorld(uiUser, '999999'), null);
});

test('the world opened is the one asked for, else the last opened, else the first; it is kept by id through a rename and gone with its world', async () => {
    const [first, , , lantern] = await ports.readWorlds(uiUser);
    assert.equal(lantern.name, 'Lantern');
    assert.equal(await ports.openWorld(who, null), first.id);
    assert.equal(await ports.openWorld(who, lantern.id), lantern.id);
    assert.equal(await ports.openWorld(who, null), lantern.id);
    assert.equal(await ports.openWorld(who, '999999'), null);
    assert.equal(await ports.openWorld(who, null), lantern.id);

    assert.equal(await ports.renameWorld(who, lantern.id, 'Lantern House'), 'ok');
    assert.equal((await ports.readWorld(uiUser, lantern.id))?.name, 'Lantern House');
    assert.equal(await ports.openWorld(who, null), lantern.id);
    assert.deepEqual(await ports.renameWorld(who, lantern.id, 'Ashfall'), { refused: 'A world named "Ashfall" already exists.' });
    assert.deepEqual(await ports.renameWorld(who, lantern.id, 'a:b'), { refused: NAME_REFUSAL });
    assert.equal(await ports.renameWorld(who, '999999', 'x'), 'missing');

    const kiln = bookOf(await ports.createWorld(who, 'Kiln'));
    const listed = await ports.readWorlds(uiUser);
    assert.deepEqual(listed.slice(-2).map(w => w.id), [kiln, lantern.id]);
    assert.deepEqual(await ports.deleteWorld(who, kiln), { next: lantern.id }, 'the next world is the one the list orders after');
    assert.deepEqual(await ports.deleteWorld(who, lantern.id), { next: listed[listed.length - 3].id }, 'the last world\'s next is the one before it');
    assert.equal(await ports.readWorld(uiUser, lantern.id), null);
    assert.equal(await ports.openWorld(who, null), first.id);
    assert.equal(await ports.deleteWorld(who, lantern.id), 'missing');
});

test('being used in every chat is the global selection, written by id and gone with its world', async () => {
    const [one, two, three] = await ports.readWorlds(uiUser);
    changes.length = 0;
    assert.equal(await ports.setUsedInEveryChat(who, [{ book: one.id, used: true }]), 'ok');
    assert.equal(await ports.setUsedInEveryChat(who, [{ book: two.id, used: true }]), 'ok');
    assert.equal(await ports.setUsedInEveryChat(who, [{ book: two.id, used: true }]), 'ok');
    assert.deepEqual((await ports.readWorlds(uiUser)).map(w => w.usedInEveryChat), [true, true, false]);
    assert.deepEqual(changes.map(c => c.length), [1, 1, 0]);
    assert.deepEqual(changes[0], [{ holder, slot: CHOICE.selected, type: TYPE.user, key: 'u' }]);
    assert.equal(await ports.setUsedInEveryChat(who, [{ book: one.id, used: false }]), 'ok');
    assert.deepEqual((await readChoices(lib, [holder])).get(holder)?.get(CHOICE.selected), [two.name]);
    changes.length = 0;
    assert.equal(await ports.setUsedInEveryChat(who, [{ book: two.id, used: false }, { book: three.id, used: true }]), 'ok');
    assert.deepEqual((await readChoices(lib, [holder])).get(holder)?.get(CHOICE.selected), [three.name]);
    assert.deepEqual(changes.map(c => c.length), [1], 'a batch is one write');
    assert.equal(await ports.setUsedInEveryChat(who, [{ book: two.id, used: true }, { book: '999999', used: true }]), 'missing');
    assert.deepEqual((await readChoices(lib, [holder])).get(holder)?.get(CHOICE.selected), [three.name], 'a batch naming a missing world writes nothing');
    assert.equal(await ports.setUsedInEveryChat(who, [{ book: three.id, used: false }, { book: two.id, used: true }]), 'ok');
    changes.length = 0;
    assert.deepEqual(await ports.deleteWorld(who, two.id), { next: three.id });
    assert.ok(changes[0].some(c => c.holder === holder && c.slot === CHOICE.selected), 'the delete names the user as a chooser');
    assert.deepEqual((await readChoices(lib, [holder])).get(holder)?.get(CHOICE.selected) ?? [], []);
    assert.equal(await ports.setUsedInEveryChat(who, [{ book: two.id, used: true }]), 'missing');
});

test('upstream\'s last edited world, read when upstream\'s settings are converted, is the last opened', async () => {
    const [world] = await ports.readWorlds(uiUser);
    await takeUpstreamLastOpened(lib, 'u', { power_user: { wi_last_editor_book: world.name } });
    assert.deepEqual((await readChoices(lib, [holder])).get(holder)?.get(CHOICE.lastOpened), [world.name]);
    await takeUpstreamLastOpened(lib, 'u', { power_user: { wi_last_editor_book: 'No such world' } });
    assert.deepEqual((await readChoices(lib, [holder])).get(holder)?.get(CHOICE.lastOpened) ?? [], []);
    await takeUpstreamLastOpened(lib, 'nobody', { power_user: { wi_last_editor_book: world.name } });
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

/**
 * @param {string} name
 * @param {Buffer} bytes
 */
function image(name, bytes) {
    const file = path.join(user.dataRoot, `upload-${name}`);
    fs.writeFileSync(file, bytes);
    return { path: file, name, type: 'image/png', size: bytes.length };
}

test('a world has a description and a picture, and its entries pictures, which no world file carries', async () => {
    const book = bookOf(await ports.createWorld(who, 'Drowned Coast'));
    await lib.books.write('Drowned Coast', { entries: { 0: { uid: 0, key: ['Ilse'], content: 'Ilse keeps the inn.' } }, description: 'A delta.' });
    assert.equal((await ports.readWorld(uiUser, book))?.description, 'A delta.', 'a world file\'s description is the world\'s');
    assert.equal(await ports.setWorldDescription(who, book, 'A drowned delta.'), 'ok');
    assert.equal((await ports.readWorld(uiUser, book))?.description, 'A drowned delta.');

    assert.deepEqual(await ports.setPicture(who, book, null, image('notes.txt', Buffer.from('words'))), { refused: 'That file is no image: send a PNG, JPEG, WebP or GIF.' });
    assert.equal(await ports.setPicture(who, book, null, image('coast.png', PNG)), 'ok');
    const id = `${crypto.createHash('sha256').update(PNG).digest('hex')}.png`;
    assert.equal((await ports.readWorld(uiUser, book))?.picture, `/look-images/${id}`);
    assert.equal((await ports.readWorlds(uiUser)).find(w => w.id === book)?.picture, `/look-images/${id}`);
    assert.ok(fs.existsSync(path.join(user.directories.root, 'look-images', id)));

    const [{ entity: ilse }] = await lib.books.storedEntries(BigInt(book));
    assert.equal(await ports.setPicture(who, book, String(ilse.id), image('ilse.png', PNG)), 'ok');
    const overview = withPictureUrls(await lib.store.worldRead('worldbuildingOverview', { book: BigInt(book), groupBy: null, firstRank: 0, endRank: 5, stepLandedOn: null, cardTextCharacters: 50, regionColumns: [], regionRows: [] }));
    assert.equal(overview.entries[0].picture, `/look-images/${id}`);
    assert.equal((await lib.store.worldRead('worldbuildingEntry', { book: BigInt(book), entry: ilse.id })).picture, id);

    const copy = bookOf(await ports.duplicateWorld(who, book));
    assert.equal((await ports.readWorld(uiUser, copy))?.picture, `/look-images/${id}`);
    const exported = JSON.parse(/** @type {any} */ (await ports.exportWorld(uiUser, book)).json);
    assert.equal(exported.description, 'A drowned delta.');
    assert.ok(!('picture' in (exported.entries[0].extensions ?? {})), 'the export leaves the entry\'s picture out');
    assert.ok(!Object.keys(exported).some(k => k.includes('picture')), 'and the world\'s');
    const imported = bookOf(await ports.importWorld(who, upload('Again.json', { entries: { 0: { uid: 0, key: ['x'], content: 'x', extensions: { picture: id } } } })));
    const [{ entity: kept }] = await lib.books.storedEntries(BigInt(imported));
    assert.equal((await lib.store.worldRead('worldbuildingEntry', { book: BigInt(imported), entry: kept.id })).picture, null, 'an imported file names no picture');

    assert.equal(await ports.setPicture(who, book, String(ilse.id), null), 'ok');
    assert.equal((await lib.store.worldRead('worldbuildingEntry', { book: BigInt(book), entry: ilse.id })).picture, null);
    assert.equal(await ports.setPicture(who, book, null, null), 'ok');
    assert.equal((await ports.readWorld(uiUser, book))?.picture, null);
    assert.equal(await ports.setPicture(who, book, '999999', null), 'no entry');
    assert.equal(await ports.setPicture(who, '999999', null, null), 'missing');
    assert.equal(await ports.setWorldDescription(who, '999999', 'x'), 'missing');
});
