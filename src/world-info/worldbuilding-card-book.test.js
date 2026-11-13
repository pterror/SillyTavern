import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { HASH, TYPE } from '../library-codes.js';
import { References } from './references.js';
import { matchDefaultsOf } from './key-matching.js';
import { worldInfoGlobalsOf } from '../../public/scripts/world-info-globals.js';
import { worldbuildingEntryPorts } from './worldbuilding-entries.js';
import { CARD_BOOK_REFUSAL, worldbuildingWorldPorts } from './worldbuilding-worlds.js';
import { worldbuildingSearchPorts } from './worldbuilding-search.js';
import { NOT_IN_CARD_BOOKS, cardEntryAsWorld, cardEntryWritten } from './card-book-entries.js';
import { CARD_ENTRY_STAYS } from './worldbuilding-entries.js';
import { convertCharacterBook } from './candidate-resolution.js';

const { emptyUser } = await import('../../tests/converted-user.fixture.js');
const user = await emptyUser('st-worldbuilding-card-book-test-');
after(() => user.close());
const lib = user.store.lib;
const uiUser = /** @type {import('@st/server-ui').User} */ ({ handle: 'u', directories: user.directories });
const who = { user: uiUser, session: 's' };
const ports = {
    ...worldbuildingWorldPorts({ libOf: async () => lib, booksChanged: async (_user, change) => change() }),
    ...worldbuildingEntryPorts({
        libOf: async () => lib,
        referencesOf: async () => new References(lib, { defaults: matchDefaultsOf(worldInfoGlobalsOf(undefined)) }),
        countTokens: async (_user, texts) => texts.map(text => text.split(' ').length),
    }),
    ...worldbuildingSearchPorts({ libOf: async () => lib }),
};

const holder = lib.nextId++;
await lib.store.commit([{ kind: 'entityCreate', entity: holder, type: TYPE.user, key: 'u', added: 0 }]);

const book = {
    name: 'Nia\'s notes',
    entries: [
        { id: 0, keys: ['inn', 'Lantern Inn'], secondary_keys: [], comment: 'Lantern Inn', content: 'An inn by the river.', enabled: true, insertion_order: 100, constant: false, selective: false, extensions: { position: 1, display_index: 0, probability: 80, custom: 'kept' }, use_regex: true },
        { id: 1, keys: ['river'], comment: '', content: 'The river.', enabled: false, insertion_order: 50, extensions: { display_index: 1 } },
    ],
};
const card = { spec: 'chara_card_v2', spec_version: '2.0', name: 'Nia', data: { name: 'Nia', description: '', extensions: { world: 'Plain' }, character_book: book } };
await lib.books.write('Plain', { entries: { 0: { uid: 0, key: ['road'], content: 'A road.' } } });
await lib.writeCard(user.directories, 'nia', JSON.stringify(card));
const [nia] = await lib.ids(TYPE.character, ['nia']);
const character = String(nia);
const plain = String((await lib.books.find('Plain'))?.id);

const stored = async () => /** @type {any} */ ((await lib.cards(['nia']))[0]).data.character_book;
const entryIds = async (/** @type {string} */ b) => (await lib.books.storedEntries(BigInt(b))).map(({ entity }) => String(entity.id));
const read = async (/** @type {string} */ b, /** @type {string} */ e) => /** @type {any} */ (await ports.readEntry(uiUser, b, e, { mentions: { from: null, pages: 1 }, mentionChecks: 100, textLinkReads: 100 }));

test('a card book entry reads as a world\'s entry as upstream reads it, and a change is written to its own fields', () => {
    const [inn, river] = book.entries;
    assert.deepEqual(Object.values(convertCharacterBook(book).entries), book.entries.map((e, i) => cardEntryAsWorld(e, i)));
    const world = cardEntryAsWorld(river, 1);
    assert.equal(world.disable, true);
    assert.equal(world.order, 50);
    assert.equal(world.position, 1);
    assert.equal(cardEntryAsWorld({ keys: [] }, 3).uid, 3);
    const before = cardEntryAsWorld(inn, 0);
    assert.deepEqual(cardEntryWritten(inn, before, { ...before, disable: true, order: 5, depth: 2, key: ['inn'], extensions: { ...before.extensions, names: ['inn'] } }), {
        ...inn,
        keys: ['inn'],
        enabled: false,
        insertion_order: 5,
        extensions: { ...inn.extensions, depth: 2, names: ['inn'] },
    });
    assert.deepEqual(cardEntryWritten(inn, before, { ...before, characterFilter: { isExclude: true, names: ['Nia'], tags: [] } }), { refused: NOT_IN_CARD_BOOKS('characterFilter') });
});

test('the character\'s own book opens as a world, is never listed among them, and refuses what is done to worlds', async () => {
    const id = await ports.characterBook(uiUser, character);
    assert.ok(id !== null);
    assert.equal(await ports.characterBook(uiUser, plain), null);
    assert.deepEqual(await ports.readWorld(uiUser, id), {
        id, name: 'Nia\'s notes', entries: 2, usedInEveryChat: false, namesOffer: { entries: 1, example: (await ports.labelEntries(uiUser, id, [(await entryIds(id))[0]]))[0], running: null, marked: 0 },
        picture: null, description: '', cameWith: { thing: character, text: 'Nia', shownAs: 'name' },
    });
    assert.equal((await ports.readWorld(uiUser, plain))?.cameWith, null);
    assert.equal(await ports.openWorld(who, id), id);
    assert.equal(await ports.openWorld(who, null), plain, 'opening it leaves the world opened last as it was');
    assert.deepEqual((await ports.readWorlds(uiUser)).map(w => w.name), ['Plain']);
    for (const refused of [
        await ports.renameWorld(who, id, 'Other'),
        await ports.duplicateWorld(who, id),
        await ports.deleteWorld(who, id),
        await ports.exportWorld(uiUser, id),
        await ports.setUsedInEveryChat(who, id, true),
    ]) assert.deepEqual(refused, { refused: CARD_BOOK_REFUSAL });
    const [inn] = await entryIds(id);
    assert.deepEqual(await ports.moveEntryToWorld(who, id, inn, plain), { refused: CARD_ENTRY_STAYS });
    assert.deepEqual(await ports.moveEntryToWorld(who, plain, (await entryIds(plain))[0], id), { refused: CARD_ENTRY_STAYS });
    assert.deepEqual((await ports.findEntries(uiUser, { book: id, query: 'river', limit: 5 })).entries.map(e => e.text), ['The river.']);
});

test('the page\'s edits of the character\'s own book write the card\'s fields, and the card\'s export carries them', async () => {
    const id = /** @type {string} */ (await ports.characterBook(uiUser, character));
    const [inn, river] = await entryIds(id);
    const shown = await read(id, river);
    assert.equal(shown.text, 'The river.');
    assert.equal(shown.placement.disable, true);
    assert.equal(shown.placement.order, 50);
    const [before] = await lib.entities([nia]);
    const hashBefore = before?.hashes.find(h => h.which === HASH.identity)?.hash.toString('hex');

    assert.equal(await ports.editEntry(who, id, inn, { change: 'text', text: 'An inn by the bridge.' }), 'ok');
    assert.equal(await ports.editEntry(who, id, inn, { change: 'title', title: 'The Lantern' }), 'ok');
    assert.equal(await ports.editEntry(who, id, inn, { change: 'setKeyAs', key: 'Lantern Inn', as: 'name' }), 'ok');
    assert.equal(await ports.editEntry(who, id, river, { change: 'placement', fields: { disable: false, order: 7, probability: 40 } }), 'ok');
    assert.deepEqual(await ports.editEntry(who, id, river, { change: 'placement', fields: { characterFilter: { isExclude: false, names: ['Nia'], tags: [] } } }), { refused: NOT_IN_CARD_BOOKS('characterFilter') });
    const made = await ports.createEntry(who, id, { after: river, name: 'Bridge', relation: null }, 100);
    assert.ok(typeof made === 'object' && 'entry' in made);

    const exported = await stored();
    assert.equal(exported.name, 'Nia\'s notes');
    assert.deepEqual(exported.entries[0], { ...book.entries[0], keys: ['inn', 'Lantern Inn'], comment: 'The Lantern', content: 'An inn by the bridge.', extensions: { ...book.entries[0].extensions, names: ['Lantern Inn'] } });
    assert.deepEqual(exported.entries[1], { ...book.entries[1], enabled: true, insertion_order: 7, extensions: { display_index: 1, probability: 40 } });
    const bridge = exported.entries[2];
    assert.equal(bridge.id, 2);
    assert.deepEqual(bridge.keys, ['Bridge']);
    assert.deepEqual(bridge.extensions.names, ['Bridge']);
    assert.equal(bridge.extensions.display_index, 2);
    assert.equal(bridge.enabled, true);
    for (const e of exported.entries) for (const field of ['key', 'uid', 'disable', 'order', 'displayIndex']) assert.ok(!(field in e), `no ${field} in the card's entry`);
    assert.equal((await read(id, made.entry)).label.text, 'Bridge');

    const [after] = await lib.entities([nia]);
    assert.notEqual(after?.hashes.find(h => h.which === HASH.identity)?.hash.toString('hex'), hashBefore, 'the card\'s identity covers its book');

    const gone = await ports.deleteEntry(who, id, river);
    assert.ok(typeof gone === 'object' && 'label' in gone);
    assert.deepEqual((await stored()).entries.map((/** @type {any} */ e) => e.id), [0, 2]);
    assert.deepEqual(await ports.restoreEntry(who, id, river), { unreachedLoops: [] });
    await lib.books.jobs.settled();
    assert.deepEqual((await stored()).entries.map((/** @type {any} */ e) => e.id).sort(), [0, 1, 2]);
});

test('a bulk change of the character\'s own book is refused', async () => {
    const id = BigInt(/** @type {string} */ (await ports.characterBook(uiUser, character)));
    const all = { selected: { world: /** @type {const} */ (true) }, except: [] };
    assert.deepEqual(await lib.books.startBulk(id, all, { set: { disable: true } }, 100), { refused: 'A character\'s own lorebook is changed one entry at a time.' });
});

test('the character\'s own book has relation kinds and relations, carried in the card\'s export', async () => {
    const id = BigInt(/** @type {string} */ (await ports.characterBook(uiUser, character)));
    const kind = await lib.books.createRelationKind(id, 'is in');
    assert.equal(typeof kind, 'number');
    const [inn, river] = (await entryIds(String(id))).map(BigInt);
    assert.deepEqual(await lib.books.changeRelation(id, { change: 'add', entry: inn, kind: /** @type {number} */ (kind), target: river, after: null, before: null, weak: false }, 100), { unreachedLoops: [] });
    const exported = await stored();
    assert.deepEqual(exported.relationKinds, [{ id: kind, name: 'is in' }]);
    assert.deepEqual(exported.entries[0].extensions.relations.map((/** @type {any} */ r) => [r.kind, r.target]), [[kind, 1]]);
    const shown = await read(String(id), String(inn));
    assert.deepEqual(shown.relations.map((/** @type {any} */ r) => r.kindName), ['is in']);
});
