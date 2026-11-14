import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';

import { looksArea } from '@st/looks/server';
import { NO_LOOK_STYLE, lookCss } from '@st/protocol/looks';
import { LOOK_FIELD, TYPE } from './library-codes.js';
import { fontsDirectory, lookImagesDirectory, looksPorts } from './looks-store.js';
import { writeDrafts } from './settings-model/model-store.js';
import { draft } from './settings-model/entity-draft.js';
import { bookmarkLookDeletes } from './bookmark-looks.js';
import { write as writeCard } from './character-card-parser.js';
import { cardParts } from './library-engine.js';
import { worldbuildingWorldPorts } from './world-info/worldbuilding-worlds.js';

const { emptyUser, writeCardWithImage, writeLibraryCard } = await import('../tests/converted-user.fixture.js');
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
    return Object.fromEntries(things.map(t => [t, read.things[t] === NO_LOOK_STYLE ? null : read.styles[read.things[t]]]));
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
    assert.deepEqual(answer.answer, { refused: [{ property: 'width', value: '9px', why: 'This property can’t be set.' }] });
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
    assert.equal((await act('looks.use', { thing: c, shared: house, before: null })).refused, 'That shared look isn’t available here.');
    assert.equal((await act('looks.makeShared', { name: 'Stray', world: book, usedBy: c })).refused, 'That shared look isn’t available here.');
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
    assert.deepEqual((await act('looks.moveShared', { shared: { id, world: book }, to: null })).changed, ['looks.look', 'looks.drawn', 'looks.theme']);
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
    const { styles, things } = (await looks.area.views['looks.drawn'](context)).looks;
    assert.deepEqual({ styles, things }, { styles: {}, things: {} });
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

test('the Look screen shows each state through every level, with the name, the levels and who sets what', async () => {
    const book = await importWorld({ entries: { 0: { uid: 0, key: ['Ilse'], comment: 'Ilse Varro', content: 'x' } } }, 'Shown');
    const ilse = await entryOf(book, 0);
    await set({ theme: true }, 'rest', [{ property: 'color', value: 'gray' }]);
    await set({ thing: book }, 'wordPointed', [{ property: 'text-shadow', value: '0 0 2px gold' }]);
    const regulars = (await act('looks.makeShared', { name: 'Regulars', world: book, usedBy: ilse })).answer.id;
    await set({ shared: { id: regulars, world: book } }, 'rest', [{ property: 'color', value: 'gold' }]);
    await set({ thing: ilse }, 'selected', red);
    await act('looks.setNote', { level: { thing: ilse }, note: 'the innkeeper' });
    assert.deepEqual((await act('looks.open', { thing: ilse })).opensViews, ['looks.look', 'looks.drawn']);
    const view = await looks.area.views['looks.look'](context);
    assert.deepEqual(view.named, { thing: ilse, text: 'Ilse Varro', shownAs: 'title' });
    assert.deepEqual(view.levels, [
        { kind: 'theme', level: { theme: true } },
        { kind: 'world', level: { thing: book }, name: 'Shown' },
        { kind: 'shared', level: { shared: { id: regulars, world: book } }, name: 'Regulars', by: 'thing' },
        { kind: 'thing', level: { thing: ilse } },
    ]);
    assert.deepEqual(view.shown.rest, [{ property: 'color', value: 'gold', state: 'rest', level: 2 }]);
    assert.deepEqual(view.shown.wordPointed, [
        { property: 'color', value: 'gold', state: 'rest', level: 2 },
        { property: 'text-shadow', value: '0 0 2px gold', state: 'wordPointed', level: 1 },
    ]);
    assert.deepEqual(view.shown.selected.at(-1), { property: 'color', value: 'red', state: 'selected', level: 3 });
    assert.deepEqual(view.placement, { before: null, after: null, note: { value: 'the innkeeper', level: 3 } });
    assert.deepEqual(view.picture, { own: null, image: null, crop: null });
    assert.deepEqual(view.fonts.map(f => f.family), ['Noto Sans', 'Noto Sans Mono']);
    assert.deepEqual(view.looks.styles[view.looks.things[ilse]].layers.selected, red);
    await set({ theme: true }, 'rest', []);
    await act('looks.setDeclarations', { level: { theme: true }, state: 'rest', set: [], reset: ['color'] });
});

test('an effect moves between the levels that draw a name: down onto the thing keeps it above, up takes it off', async () => {
    const book = await importWorld({ entries: { 0: { uid: 0, key: ['A'], content: 'a' }, 1: { uid: 1, key: ['B'], content: 'b' } } }, 'Applied');
    const [a, b] = [await entryOf(book, 0), await entryOf(book, 1)];
    const teal = [{ property: 'color', value: 'teal' }];
    await set({ thing: a }, 'rest', [...teal, { property: 'font-style', value: 'italic' }]);
    const moved = await act('looks.applyTo', {
        thing: a, what: { state: 'rest', properties: ['color'] }, from: { thing: a }, to: { newShared: { name: 'Teal', world: book } },
    });
    assert.deepEqual(moved.changed, ['looks.look', 'looks.drawn']);
    await act('looks.open', { thing: a });
    const view = await looks.area.views['looks.look'](context);
    const shared = view.levels[2];
    assert.equal(shared.kind, 'shared');
    assert.equal(shared.name, 'Teal');
    assert.deepEqual(view.own.rest, [{ property: 'font-style', value: 'italic' }]);
    assert.deepEqual(view.shown.rest, [{ property: 'font-style', value: 'italic', state: 'rest', level: 3 }, { property: 'color', value: 'teal', state: 'rest', level: 2 }].reverse());
    await act('looks.applyTo', { thing: a, what: { state: 'rest', properties: ['color'] }, from: shared.level, to: { thing: book } });
    assert.deepEqual((await drawn([b]))[b].layers.rest, teal);
    assert.deepEqual((await looks.area.views['looks.look'](context)).uses[0].look, {});
    await act('looks.applyTo', { thing: a, what: { state: 'wordPointed', properties: ['color'] }, from: { thing: book }, to: { thing: a } });
    assert.deepEqual((await drawn([a]))[a].layers.wordPointed, teal);
    assert.deepEqual((await drawn([b]))[b].layers.rest, teal);
    await act('looks.applyTo', { thing: a, what: { note: true }, from: { thing: a }, to: { thing: book } });
    assert.equal((await act('looks.applyTo', { thing: a, what: { note: true }, from: { thing: b }, to: { theme: true } })).refused, 'That look isn’t applied to this name.');
    await act('looks.setPicture', { level: { thing: a }, before: true, after: null });
    await act('looks.applyTo', { thing: a, what: { picture: true }, from: { thing: a }, to: { thing: book } });
    assert.deepEqual((await drawn([b]))[b].picture, { before: true, after: false, crop: null, image: null });
    assert.equal((await drawn([a]))[a].picture.before, true);
    assert.equal((await looks.area.views['looks.look'](context)).own.picture, undefined);
});

test('a small picture is a crop of the thing\'s own picture or another image, stored by its bytes and served by them', async () => {
    const book = await importWorld({ entries: { 0: { uid: 0, key: ['A'], content: 'a' } } }, 'Pictured');
    const a = await entryOf(book, 0);
    const crop = { x: 0.25, y: 0, width: 0.5, height: 0.75 };
    await act('looks.setPicture', { level: { thing: a }, before: true, after: null });
    await act('looks.cropPicture', { thing: a, crop });
    assert.deepEqual((await drawn([a]))[a].picture, { before: true, after: false, crop, image: null });
    assert.equal((await act('looks.cropPicture', { thing: a, crop: { x: 0.9, y: 0, width: 0.5, height: 0.5 } })).refused, 'The crop must cover at least 5% of each side.');
    assert.equal((await act('looks.uploadPicture', { thing: a }, upload('n.txt', 'hello'))).refused, 'That file is no image: send a PNG, JPEG, WebP or GIF.');
    const sent = await act('looks.uploadPicture', { thing: a }, upload('i.png', image));
    assert.deepEqual(sent.changed, ['looks.look', 'looks.drawn']);
    const id = `${crypto.createHash('sha256').update(image).digest('hex')}.png`;
    assert.deepEqual((await drawn([a]))[a].picture, { before: true, after: false, crop: null, image: `/look-images/${id}` });
    assert.ok(fs.existsSync(path.join(lookImagesDirectory(user.directories.root), id)));
    await act('looks.useOwnPicture', { thing: a });
    assert.deepEqual((await drawn([a]))[a].picture, { before: true, after: false, crop: null, image: null });

    assert.equal('ok', await worlds.setPicture(who, book, a, upload('own.png', image)));
    await act('looks.open', { thing: a });
    assert.equal((await looks.area.views['looks.look'](context)).picture.own, `/look-images/${id}`);
    assert.equal('ok', await worlds.setPicture(who, book, null, upload('world.png', image)));
    await act('looks.open', { thing: book });
    assert.equal((await looks.area.views['looks.look'](context)).picture.own, `/look-images/${id}`);

    const wrenCard = JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', name: 'Wren', data: { name: 'Wren', first_mes: 'Hi.', alternate_greetings: [], extensions: {} } });
    await writeCardWithImage(user, 'pictured.png', wrenCard, writeCard(image, wrenCard));
    const wren = String((await lib.ids(TYPE.character, ['pictured.png']))[0]);
    await act('looks.open', { thing: wren });
    const view = await looks.area.views['looks.look'](context);
    assert.deepEqual(view.named, { thing: wren, text: 'Wren', shownAs: 'name' });
    assert.match(view.picture.own, /^\/thumbnail\/s[0-9a-f]{64}\./);
    assert.deepEqual(view.levels.map(l => l.kind), ['theme', 'thing']);

    const express = (await import('express')).default;
    const { lookImagesRouter } = await import('./endpoints/fonts.js');
    const app = express();
    app.use((request, _response, next) => {
        /** @type {any} */ (request).user = { directories: user.directories };
        next();
    });
    app.use('/look-images', lookImagesRouter);
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    try {
        const at = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}/look-images/`;
        const served = await fetch(at + id);
        assert.equal(served.status, 200);
        assert.equal(served.headers.get('content-type'), 'image/png');
        assert.equal(served.headers.get('cache-control'), 'public, max-age=31536000, immutable');
        assert.equal((await fetch(at + `${'0'.repeat(64)}.png`)).status, 404);
    } finally {
        server.closeAllConnections?.();
        await new Promise(resolve => server.close(resolve));
    }
});

test('the trigger mark is the theme\'s, set per state and drawn by the view of what the tab draws, the Look screen and the theme settings', async () => {
    const at = { style: 'dotted', color: 'currentColor', opacity: 1 };
    assert.deepEqual((await looks.area.views['looks.drawn'](context)).looks.mark, { rest: at, earlierReply: at, messagePointed: at, wordPointed: at });
    const changed = await act('looks.setMark', { change: { rest: { style: 'none' }, messagePointed: { style: 'dashed', color: ' #ff0000 ' } } });
    assert.deepEqual(changed.changed, ['looks.look', 'looks.drawn', 'looks.theme']);
    const pointed = { style: 'dashed', color: '#ff0000', opacity: 1 };
    assert.deepEqual((await looks.area.views['looks.drawn'](context)).looks.mark, {
        rest: { ...at, style: 'none' },
        earlierReply: { ...at, style: 'none' },
        messagePointed: pointed,
        wordPointed: pointed,
    });
    const theme = await looks.area.views['looks.theme'](context);
    assert.deepEqual(theme.mark.stored, { rest: { style: 'none' }, messagePointed: { style: 'dashed', color: '#ff0000' } });

    const book = await importWorld({ entries: { 0: { uid: 0, key: ['Mark'], content: 'm' } } }, 'Marked');
    const entry = await entryOf(book, 0);
    await act('looks.open', { thing: entry });
    assert.deepEqual((await looks.area.views['looks.look'](context)).mark, theme.mark);
    await act('looks.close', {});

    assert.equal((await act('looks.setMark', { change: { rest: { color: 'red; position: fixed' } } })).refused.startsWith('Highlight color'), true);
    await act('looks.setMark', { change: { rest: { style: null }, messagePointed: { color: null } } });
    assert.deepEqual((await looks.area.views['looks.theme'](context)).mark.stored, { messagePointed: { style: 'dashed' } });
    await act('looks.resetMark', {});
    assert.deepEqual((await looks.area.views['looks.theme'](context)).mark.stored, {});
    const { values } = (await lib.entities(await lib.ids(TYPE.look, ['user'])))[0];
    assert.equal(values.some(v => v.field === 'mark'), false);
    const { styles } = await looks.looksFor(uiUser, [entry]);
    assert.equal(Object.values(styles).some(style => JSON.stringify(style).includes('dashed')), false);
});

test('the CSS of a state goes to the levels that set each declaration, a new one to the level asked, and a removed one off its level', async () => {
    const book = await importWorld({ entries: { 0: { uid: 0, key: ['Css'], content: 'c' } } }, 'Css');
    const entry = await entryOf(book, 0);
    await set({ theme: true }, 'rest', [{ property: 'text-shadow', value: '0 0 1px gray' }]);
    await set({ thing: entry }, 'rest', [{ property: 'letter-spacing', value: '1px' }]);
    await set({ thing: book }, 'rest', [{ property: 'font-weight', value: '600' }]);
    const written = await act('looks.writeCss', {
        thing: entry,
        state: 'rest',
        css: 'text-shadow: 0 0 2px gold; letter-spacing: 1px; font-style: italic; width: 9px',
        replaces: ['text-shadow', 'letter-spacing', 'font-weight'],
        newAt: { thing: book },
    });
    assert.deepEqual(written.answer.refused, [{ property: 'width', value: '9px', why: 'This property can’t be set.' }]);
    await act('looks.open', { thing: entry });
    const shown = (await looks.area.views['looks.look'](context)).shown.rest.map(d => [d.property, d.value, d.level]);
    assert.deepEqual(shown.sort(), [['font-style', 'italic', 1], ['letter-spacing', '1px', 2], ['text-shadow', '0 0 2px gold', 0]]);

    await act('looks.writeCss', { thing: entry, state: 'rest', css: 'letter-spacing: 2px', replaces: ['text-shadow', 'letter-spacing', 'font-style'], newAt: { thing: entry } });
    const after = (await looks.area.views['looks.look'](context)).shown.rest.map(d => [d.property, d.value, d.level]);
    assert.deepEqual(after, [['letter-spacing', '2px', 2]]);
    assert.equal((await act('looks.writeCss', { thing: entry, state: 'rest', css: '', replaces: [], newAt: { thing: '1' } })).refused, 'That look isn’t applied to this name.');
    await act('looks.close', {});
    await act('looks.setDeclarations', { level: { thing: entry }, state: 'rest', set: [], reset: ['letter-spacing'] });
});

test('the theme settings list the user\'s own shared looks, renamed and deleted there', async () => {
    const made = await act('looks.makeShared', { name: 'Gilded', world: null, usedBy: null });
    const shared = { id: made.answer.id, world: null };
    assert.equal((await looks.area.views['looks.theme'](context)).shared.some(s => s.id === shared.id && s.name === 'Gilded'), true);
    await act('looks.renameShared', { shared, name: 'Gilt' });
    assert.equal((await looks.area.views['looks.theme'](context)).shared.find(s => s.id === shared.id)?.name, 'Gilt');
    assert.deepEqual((await act('looks.deleteShared', { shared })).changed, ['looks.look', 'looks.drawn', 'looks.theme']);
    assert.equal((await looks.area.views['looks.theme'](context)).shared.some(s => s.id === shared.id), false);
});
