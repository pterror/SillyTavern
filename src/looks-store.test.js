import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';

import { looksArea } from '@st/looks/server';
import { lookCss } from '@st/protocol/looks';
import { LOOK_FIELD, TYPE } from './library-codes.js';
import { fontsDirectory, looksPorts } from './looks-store.js';
import { writeDrafts } from './settings-model/model-store.js';
import { draft } from './settings-model/entity-draft.js';
import { bookmarkLookDeletes } from './bookmark-looks.js';
import { write as writeCard } from './character-card-parser.js';
import { cardParts } from './library-engine.js';
import { worldbuildingWorldPorts } from './world-info/worldbuilding-worlds.js';

const { emptyUser, writeLibraryCard } = await import('../tests/converted-user.fixture.js');
const image = fs.readFileSync(path.join(import.meta.dirname, '..', 'public', 'img', 'ai4.png'));
const user = await emptyUser('st-looks-store-test-');
after(() => user.close());
const lib = user.store.lib;
const uiUser = /** @type {import('@st/server-ui').User} */ ({ handle: 'u', directories: user.directories });
const who = { user: uiUser, session: 's' };
const context = { user: uiUser, session: 's', chat: null, upload: null };

const holder = lib.nextId++;
await lib.store.commit([{ kind: 'entityCreate', entity: holder, type: TYPE.user, key: 'u', added: 0 }]);
const worlds = worldbuildingWorldPorts({ libOf: async () => lib, booksChanged: async (_user, change) => change() });
const looks = looksArea(looksPorts({ libOf: async () => lib }));

/**
 * @param {string} type
 * @param {unknown} payload
 * @param {import('@st/server-ui').Upload | null} [upload]
 */
const act = (type, payload, upload = null) => looks.area.actions[type]({ ...context, upload }, payload);

/**
 * @param {string} name
 * @param {string | Buffer} contents
 */
function upload(name, contents) {
    const file = path.join(user.dataRoot, `upload-${crypto.randomUUID()}-${name}`);
    fs.writeFileSync(file, contents);
    return { path: file, name, type: 'application/octet-stream', size: Buffer.byteLength(contents) };
}

/**
 * @param {unknown} file
 * @param {string} name
 */
async function importWorld(file, name) {
    const made = await worlds.importWorld(who, upload(`${name}.json`, JSON.stringify(file)));
    if (!('book' in made)) throw new Error(`no world: ${JSON.stringify(made)}`);
    return made.book;
}

/**
 * @param {string} book
 * @param {number} uid
 */
const entryOf = async (book, uid) => String((await lib.ids(TYPE.entry, [`${book}:${uid}`]))[0]);

/**
 * @param {string[]} things
 */
async function drawn(things) {
    const read = await looks.looksFor(uiUser, things);
    return Object.fromEntries(things.map(t => [t, read.things[t] === undefined ? null : read.styles[read.things[t]]]));
}

const red = [{ property: 'color', value: 'red' }];
const set = (level, state, declarations) => act('looks.setDeclarations', { level, state, set: declarations, reset: [] });

test('an entry\'s look is stored on the entry, sanitized by every write, and refusals are answered', async () => {
    const book = await importWorld({
        entries: {
            0: { uid: 0, key: ['Ilse'], content: 'x', extensions: { look: { rest: [{ property: 'color', value: 'teal' }, { property: 'position', value: 'fixed' }] } } },
        },
    }, 'Sanitized');
    const entry = await entryOf(book, 0);
    const [stored] = await lib.entities([BigInt(entry)], { fields: [LOOK_FIELD], lists: [] });
    assert.deepEqual(JSON.parse(stored.values[0].json), { rest: [{ property: 'color', value: 'teal' }] });
    const answer = await set({ thing: entry }, 'wordPointed', [{ property: 'text-shadow', value: '0 0 2px gold' }, { property: 'width', value: '9px' }]);
    assert.deepEqual(answer.changed, ['looks.look', 'looks.drawn']);
    assert.deepEqual(answer.answer, { refused: [{ property: 'width', value: '9px', why: 'a look may not set this property' }] });
    const exported = JSON.parse((await worlds.exportWorld(uiUser, book)).json);
    assert.deepEqual(exported.entries[0].extensions.look, {
        rest: [{ property: 'color', value: 'teal' }],
        wordPointed: [{ property: 'text-shadow', value: '0 0 2px gold' }],
    });
});

test('looks resolve theme, world, shared looks in order, then the thing; a world-level shared look stays in its world', async () => {
    const book = await importWorld({ entries: { 0: { uid: 0, key: ['A'], content: 'a' }, 1: { uid: 1, key: ['B'], content: 'b' } } }, 'Cascade');
    const [a, b] = [await entryOf(book, 0), await entryOf(book, 1)];
    await set({ theme: true }, 'rest', [{ property: 'color', value: 'gray' }, { property: 'font-style', value: 'italic' }]);
    await set({ thing: book }, 'rest', [{ property: 'color', value: 'teal' }]);
    const house = (await act('looks.makeShared', { name: 'House', world: book, usedBy: a })).answer.id;
    const everywhere = (await act('looks.makeShared', { name: 'Everywhere', world: null, usedBy: null })).answer.id;
    await set({ shared: { id: house, world: book } }, 'rest', [{ property: 'color', value: 'gold' }, { property: 'font-weight', value: 'bold' }]);
    await set({ shared: { id: everywhere, world: null } }, 'rest', [{ property: 'font-weight', value: '300' }]);
    await act('looks.use', { thing: a, shared: everywhere, before: null });
    await set({ thing: a }, 'selected', red);
    const look = (await drawn([a, b, book]));
    assert.deepEqual(look[a].layers, {
        rest: [{ property: 'font-style', value: 'italic' }, { property: 'color', value: 'gold' }, { property: 'font-weight', value: '300' }],
        selected: red,
    });
    assert.deepEqual(look[b].layers.rest, [{ property: 'font-style', value: 'italic' }, { property: 'color', value: 'teal' }]);
    assert.deepEqual(look[book].layers.rest, [{ property: 'font-style', value: 'italic' }, { property: 'color', value: 'teal' }]);
    await act('looks.use', { thing: a, shared: everywhere, before: house });
    assert.deepEqual((await drawn([a]))[a].layers.rest.slice(0, 2), [{ property: 'font-style', value: 'italic' }, { property: 'color', value: 'gold' }]);
    assert.equal((await drawn([a]))[a].layers.rest.find(d => d.property === 'font-weight').value, 'bold');
    const other = await importWorld({ entries: { 0: { uid: 0, key: ['C'], content: 'c' } } }, 'Elsewhere');
    const c = await entryOf(other, 0);
    assert.equal((await act('looks.use', { thing: c, shared: house, before: null })).refused, 'That shared look isn\'t one of this world\'s or yours.');
    assert.equal((await act('looks.makeShared', { name: 'Stray', world: book, usedBy: c })).refused, 'That shared look isn\'t one of this world\'s or yours.');
    assert.deepEqual(lookCss(a, (await drawn([a]))[a]).split('\n')[0], `.look-${a} { font-style: italic; color: gold; font-weight: bold; }`);
    await set({ theme: true }, 'rest', []);
    await act('looks.setDeclarations', { level: { theme: true }, state: 'rest', set: [], reset: ['color', 'font-style'] });
});

test('a shared look moves between its world and the user without rewriting what uses it; a deleted one is left out', async () => {
    const book = await importWorld({ entries: { 0: { uid: 0, key: ['A'], content: 'a' } } }, 'Mover');
    const a = await entryOf(book, 0);
    const id = (await act('looks.makeShared', { name: 'Moving', world: book, usedBy: a })).answer.id;
    await set({ shared: { id, world: book } }, 'rest', red);
    assert.deepEqual((await drawn([a]))[a].layers.rest, red);
    assert.deepEqual((await act('looks.moveShared', { shared: { id, world: book }, to: null })).changed, ['looks.look', 'looks.drawn']);
    assert.deepEqual((await drawn([a]))[a].layers.rest, red);
    const exported = JSON.parse((await worlds.exportWorld(uiUser, book)).json);
    assert.equal(exported.sharedLooks, undefined);
    assert.deepEqual((await looksPorts({ libOf: async () => lib }).listShared(uiUser, book)).find(s => s.id === id), { id, world: null, name: 'Moving' });
    await act('looks.moveShared', { shared: { id, world: null }, to: book });
    assert.equal(JSON.parse((await worlds.exportWorld(uiUser, book)).json).sharedLooks[0].id, id);
    await act('looks.renameShared', { shared: { id, world: book }, name: 'Moved' });
    await act('looks.deleteShared', { shared: { id, world: book } });
    assert.equal((await drawn([a]))[a], null);
    await act('looks.open', { thing: a });
    const view = await looks.area.views['looks.look'](context);
    assert.deepEqual(view.uses, [{ id, world: null, name: null, look: null }]);
    await act('looks.stopUsing', { thing: a, shared: id });
    assert.deepEqual((await looks.area.views['looks.look'](context)).uses, []);
});

const woff2 = (seed) => Buffer.concat([Buffer.from('wOF2'), Buffer.from(seed)]);

test('a world\'s fonts are stored once by their hash and travel with the world\'s export and its shared looks', async () => {
    const book = await importWorld({ entries: { 0: { uid: 0, key: ['A'], content: 'a' } } }, 'Typeset');
    const second = await importWorld({ entries: {} }, 'Typeset again');
    const bytes = woff2('glyphs');
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    const one = await act('looks.uploadFont', { world: book, name: 'Gothic' }, upload('g.woff2', bytes));
    const two = await act('looks.uploadFont', { world: second, name: 'Gothic too' }, upload('g2.woff2', bytes));
    assert.equal(one.answer.id, `${hash}.woff2`);
    assert.equal(two.answer.id, one.answer.id);
    assert.deepEqual(fs.readdirSync(fontsDirectory(user.directories.root)), [`${hash}.woff2`]);
    assert.equal((await act('looks.uploadFont', { world: book, name: 'No' }, upload('n.txt', 'hello'))).refused, 'That file is no font: send a WOFF2, WOFF, TTF or OTF file.');
    const a = await entryOf(book, 0);
    const font = one.answer.id;
    assert.equal((await set({ thing: (await entryOf(book, 0)) }, 'rest', [{ property: 'font-family', value: `"${font}", serif` }])).answer.refused.length, 0);
    const look = (await drawn([a]))[a];
    assert.deepEqual(look.fonts, [{ family: `look-font-${hash.slice(0, 16)}`, url: `/fonts/${font}`, format: 'woff2' }]);
    assert.equal((await set({ theme: true }, 'rest', [{ property: 'font-family', value: `"${font}"` }])).answer.refused.length, 1);
    const shared = (await act('looks.makeShared', { name: 'Gothic look', world: book, usedBy: null })).answer.id;
    await set({ shared: { id: shared, world: book } }, 'rest', [{ property: 'font-family', value: `"${font}"` }, { property: 'color', value: 'plum' }]);
    await set({ thing: book }, 'rest', red);
    const file = JSON.parse((await worlds.exportWorld(uiUser, book)).json);
    assert.deepEqual(file.fonts, [{ id: font, name: 'Gothic', data: bytes.toString('base64') }]);
    assert.deepEqual(file.look, { rest: red });
    assert.deepEqual(file.sharedLooks, [{ id: shared, name: 'Gothic look', look: { rest: [{ property: 'font-family', value: `"${font}"` }, { property: 'color', value: 'plum' }] } }]);
    fs.rmSync(path.join(fontsDirectory(user.directories.root), font));
    const copy = await importWorld(file, 'Typeset copy');
    assert.ok(fs.existsSync(path.join(fontsDirectory(user.directories.root), font)));
    const copied = await looksPorts({ libOf: async () => lib }).worldFonts(uiUser, copy);
    assert.deepEqual(copied, [{ id: font, name: 'Gothic' }]);
    const copyEntry = await entryOf(copy, 0);
    assert.deepEqual((await drawn([copyEntry]))[copyEntry].layers.rest, [{ property: 'color', value: 'red' }, { property: 'font-family', value: `"look-font-${hash.slice(0, 16)}", serif` }]);
    const duplicated = await worlds.duplicateWorld(who, book);
    assert.deepEqual(await looksPorts({ libOf: async () => lib }).worldFonts(uiUser, duplicated.book), [{ id: font, name: 'Gothic' }]);
    await act('looks.moveShared', { shared: { id: shared, world: copy }, to: null });
    const moved = await looksPorts({ libOf: async () => lib }).readShared(uiUser, null, [shared]);
    assert.deepEqual(moved[0].look, { rest: [{ property: 'color', value: 'plum' }] });
});

test('a character\'s and a persona\'s look are fields their own writes keep', async () => {
    await writeDrafts(lib, [draft(TYPE.persona, 'p.png', { name: 'Ilse' })]);
    const persona = String((await lib.ids(TYPE.persona, ['p.png']))[0]);
    await set({ thing: persona }, 'rest', red);
    await writeDrafts(lib, [draft(TYPE.persona, 'p.png', { name: 'Ilse Varro' })]);
    assert.deepEqual((await drawn([persona]))[persona].layers.rest, red);
    const card = name => JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', name, data: { name, first_mes: 'Hi.', alternate_greetings: [], extensions: {} } });
    await writeLibraryCard(user, 'c.png', card('Wren'), writeCard(image, card('Wren')));
    const character = String((await lib.ids(TYPE.character, ['c.png']))[0]);
    assert.deepEqual((await drawn([character]))[character], null);
    await set({ thing: character }, 'rest', red);
    await writeLibraryCard(user, 'c.png', card('Wren Vell'), writeCard(image, card('Wren Vell')));
    assert.deepEqual((await drawn([character]))[character].layers.rest, red);
    const [stored] = await lib.entities([BigInt(character)]);
    assert.equal(JSON.stringify(cardParts(stored)).includes('look'), false);
});

test('a bookmark\'s look goes with the bookmark\'s delete', async () => {
    const id = lib.nextId++;
    await lib.store.commit([{ kind: 'entityCreate', entity: id, type: TYPE.look, key: 'bookmark:77', added: 0 }]);
    const deletes = await bookmarkLookDeletes(lib.store, [77n, 78n]);
    assert.deepEqual(deletes, [{ kind: 'entityDelete', entity: id }]);
    await lib.store.commit(deletes);
    assert.deepEqual(await lib.ids(TYPE.look, ['bookmark:77']), [null]);
});

test('the looks of what a session draws are answered again after an edit', async () => {
    const book = await importWorld({ entries: { 0: { uid: 0, key: ['A'], content: 'a' } } }, 'Drawn');
    const a = await entryOf(book, 0);
    await looks.looksOf(context, 'worldbuilding.overview', [a]);
    await set({ thing: a }, 'rest', [{ property: 'color', value: 'navy' }]);
    const view = await looks.area.views['looks.drawn'](context);
    assert.deepEqual(view.looks.styles[view.looks.things[a]].layers.rest, [{ property: 'color', value: 'navy' }]);
    looks.area.gone('s');
    assert.deepEqual((await looks.area.views['looks.drawn'](context)).looks, { styles: {}, things: {} });
});

test('a font is served by its id with a cache that never asks again, and nothing else is', async () => {
    const express = (await import('express')).default;
    const { router } = await import('./endpoints/fonts.js');
    const app = express();
    app.use((request, _response, next) => {
        /** @type {any} */ (request).user = { directories: user.directories };
        next();
    });
    app.use('/fonts', router);
    const bytes = woff2('served');
    const id = (await act('looks.uploadFont', { world: await importWorld({ entries: {} }, 'Served'), name: 'S' }, upload('s.woff2', bytes))).answer.id;
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    try {
        const at = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}/fonts/`;
        const served = await fetch(at + id);
        assert.equal(served.status, 200);
        assert.equal(served.headers.get('cache-control'), 'public, max-age=31536000, immutable');
        assert.equal(served.headers.get('content-type'), 'font/woff2');
        assert.deepEqual(Buffer.from(await served.arrayBuffer()), bytes);
        assert.equal((await fetch(at + `${'0'.repeat(64)}.woff2`)).status, 404);
        assert.equal((await fetch(at + '..%2Fsecret')).status, 404);
    } finally {
        server.closeAllConnections?.();
        await new Promise(resolve => server.close(resolve));
    }
});
