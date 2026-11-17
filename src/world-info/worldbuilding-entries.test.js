import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { PLACEMENT_DEFAULTS, editedEntry, placementOf, sentenceAround, worldbuildingEntryPorts } from './worldbuilding-entries.js';
import { References } from './references.js';
import { entryAsWorld } from '../world-info-engine.js';
import { matchDefaultsOf } from './key-matching.js';
import { worldInfoGlobalsOf } from '../../public/scripts/world-info-globals.js';
import { GENERATION_TYPE_TRIGGERS } from '../../public/scripts/constants.js';
import { MENTION_CHECKS_PER_READ, MENTIONS_PER_PAGE, TEXT_LINK_READS_PER_READ, TRIGGERS } from '@st/worldbuilding/protocol';
import { TYPE } from '../library-codes.js';

const { emptyUser } = await import('../../tests/converted-user.fixture.js');
const user = await emptyUser('st-worldbuilding-entries-test-');
const lib = user.store.lib;
const uiUser = /** @type {import('@st/server-ui').User} */ ({ handle: 'u', directories: user.directories });
const who = { user: uiUser, session: 's' };
/**
 * An edit made against the entry as it is now
 * @param {string} book
 * @param {string} entry
 * @param {import('@st/worldbuilding/server').EntryEdit} change
 */
const edit = async (book, entry, change) => ports.editEntry(who, book, entry, change, (await ports.readFacts(uiUser, book, [entry], false))[0]?.version ?? '0');
const ports = worldbuildingEntryPorts({
    libOf: async () => lib,
    referencesOf: async () => new References(lib, { defaults: matchDefaultsOf(worldInfoGlobalsOf(undefined)) }),
    countTokens: async (_user, texts) => texts.map(text => text.split(' ').length),
});

test('a mention\'s sentence runs from its sentence\'s start to its end, each side cut at a word past 200 characters', () => {
    const text = 'The lamp went out. Then Ilse Varro lit it again, slowly. Nobody saw.';
    const at = text.indexOf('Ilse');
    assert.deepEqual(sentenceAround(text, [at, at + 4]), { before: 'Then ', mention: 'Ilse', after: ' Varro lit it again, slowly.' });
    const long = `${'word '.repeat(100)}Ilse ${'more '.repeat(100)}end.`;
    const far = long.indexOf('Ilse');
    const cut = sentenceAround(long, [far, far + 4]);
    assert.ok(cut.before.length <= 200 && cut.before.startsWith('word'));
    assert.ok(cut.after.length <= 200 && cut.after.startsWith(' more') && cut.after.endsWith('more'));
    assert.deepEqual(sentenceAround('Ilse.', [0, 4]), { before: '', mention: 'Ilse', after: '.' });
});

test('placement is every upstream field but the keys, title and text, as stored, missing ones at their defaults', () => {
    assert.deepEqual(TRIGGERS, GENERATION_TYPE_TRIGGERS);
    assert.ok(!('key' in PLACEMENT_DEFAULTS) && !('content' in PLACEMENT_DEFAULTS) && !('comment' in PLACEMENT_DEFAULTS));
    const plain = placementOf({ key: ['x'], content: 'y' });
    assert.equal(plain.differs, false);
    assert.equal(plain.placement.depth, 4);
    assert.deepEqual(plain.placement.characterFilter, { isExclude: false, names: [], tags: [] });
    const placed = placementOf({ depth: 2, characterFilter: { isExclude: false, names: [], tags: [] } });
    assert.equal(placed.differs, true);
    assert.equal(placed.placement.depth, 2);
});

test('a key is added, switched and removed on the entry as stored; a name is a key it marks', () => {
    const entry = { key: ['Ilse', 'lamp'], extensions: { names: ['Ilse'], relations: [] } };
    assert.deepEqual(editedEntry(entry, { change: 'addKeys', keys: ['Varro'], as: 'name' }), { key: ['Ilse', 'lamp', 'Varro'], extensions: { names: ['Ilse', 'Varro'], relations: [] } });
    assert.deepEqual(editedEntry(entry, { change: 'addKeys', keys: ['Ilse'], as: 'trigger' }), { key: ['Ilse', 'lamp'], extensions: { names: [], relations: [] } });
    assert.deepEqual(editedEntry(entry, { change: 'setKeyAs', key: 'lamp', as: 'name' }).extensions, { names: ['Ilse', 'lamp'], relations: [] });
    assert.deepEqual(editedEntry(entry, { change: 'setKeyAs', key: 'nope', as: 'name' }), { refused: 'That entry has no such key.' });
    assert.deepEqual(editedEntry(entry, { change: 'removeKey', key: 'Ilse' }).key, ['lamp']);
    const odd = { key: ['x'], extensions: { names: 'by another tool' } };
    assert.deepEqual(editedEntry(odd, { change: 'addKeys', keys: ['y'], as: 'trigger' }), { key: ['x', 'y'], extensions: { names: 'by another tool' } });
});

test('several keys are added at once and a key is renamed in place, keeping its flag; patterns are triggers only', () => {
    const entry = { key: ['Ilse', 'lamp'], extensions: { names: ['Ilse'], relations: [] } };
    assert.deepEqual(editedEntry(entry, { change: 'addKeys', keys: ['a', 'lamp', 'b', 'a'], as: 'trigger' }).key, ['Ilse', 'lamp', 'a', 'b']);
    assert.deepEqual(editedEntry(entry, { change: 'addKeys', keys: ['a', 'b'], as: 'name' }).extensions, { names: ['Ilse', 'a', 'b'], relations: [] });
    assert.deepEqual(editedEntry(entry, { change: 'renameKey', key: 'Ilse', to: 'Ilsa' }), { key: ['Ilsa', 'lamp'], extensions: { names: ['Ilsa'], relations: [] } });
    assert.deepEqual(editedEntry(entry, { change: 'renameKey', key: 'lamp', to: 'torch' }), { key: ['Ilse', 'torch'], extensions: { names: ['Ilse'], relations: [] } });
    assert.deepEqual(editedEntry(entry, { change: 'renameKey', key: 'lamp', to: 'lamp' }), entry);
    assert.deepEqual(editedEntry(entry, { change: 'renameKey', key: 'lamp', to: 'Ilse' }), { refused: 'That entry already has that key.' });
    assert.deepEqual(editedEntry(entry, { change: 'renameKey', key: 'nope', to: 'x' }), { refused: 'That entry has no such key.' });
    const refused = { refused: 'A pattern can only be a trigger, not a name.' };
    assert.deepEqual(editedEntry(entry, { change: 'addKeys', keys: ['a', '/b+/i'], as: 'name' }), refused);
    assert.deepEqual(editedEntry(entry, { change: 'addKeys', keys: ['/b+/i'], as: 'trigger' }).key, ['Ilse', 'lamp', '/b+/i']);
    assert.deepEqual(editedEntry({ key: ['/b+/'], extensions: {} }, { change: 'setKeyAs', key: '/b+/', as: 'name' }), refused);
    assert.deepEqual(editedEntry(entry, { change: 'renameKey', key: 'Ilse', to: '/I.se/' }), refused);
    assert.deepEqual(editedEntry(entry, { change: 'renameKey', key: 'lamp', to: '/l.mp/' }).key, ['Ilse', '/l.mp/']);
});

const IN = 1;

/**
 * @param {string | null} from
 * @param {number} pages
 */
const asked = (from, pages) => ({ mentions: { from, pages }, mentionChecks: MENTION_CHECKS_PER_READ, textLinkReads: TEXT_LINK_READS_PER_READ });
const FIRST = asked(null, 1);

test('the entry view, its edits, a new entry after another, delete, restore and moving to another world, over the store', async () => {
    const entries = {
        1: { uid: 1, key: ['Ilse', 'Varro'], comment: '', content: 'Ilse Varro keeps the lamp.', displayIndex: 0, depth: 2, extensions: { names: ['Varro'], picture: 'p1' } },
        2: { uid: 2, key: ['Ilse', 'house'], comment: 'The Lantern House', content: 'A house. Ilse Varro lives here, mostly. Nobody else.', displayIndex: 1, extensions: { picture: 'p2' } },
    };
    await lib.books.write('Entries', { relationKinds: [{ id: IN, name: 'in' }], entries });
    await lib.books.write('Elsewhere', { entries: {} });
    const { id: book } = /** @type {{ id: bigint }} */ (await lib.books.find('Entries'));
    const { id: other } = /** @type {{ id: bigint }} */ (await lib.books.find('Elsewhere'));
    const ids = new Map((await lib.books.storedEntries(book)).map(({ entity }) => [entity.key.split(':')[1], String(entity.id)]));
    const [first, second] = [(ids.get('1')), /** @type {string} */ (ids.get('2'))];
    const B = String(book);

    let read = await ports.readEntry(uiUser, B, first, FIRST);
    assert.ok(read && !read.deleted);
    assert.deepEqual(read.label, { thing: first, text: 'Varro', shownAs: 'name' });
    assert.deepEqual(read.keys, [{ text: 'Ilse', isName: false, alsoBringsUp: 1 }, { text: 'Varro', isName: true, alsoBringsUp: 0 }]);
    assert.equal(read.placement.depth, 2);
    assert.equal(read.placementDiffersFromDefaults, true);
    assert.equal(read.tokens, 5);
    assert.deepEqual(read.mentionedIn, { pages: [{
        cursor: null,
        entries: [{
            from: { thing: second, text: 'The Lantern House', shownAs: 'title' },
            picture: '/look-images/p2',
            sentence: { before: '', mention: 'Ilse', after: ' Varro lives here, mostly.' },
        }],
        next: null,
        lookedThrough: 1,
        stoppedForBound: false,
    }] });
    assert.deepEqual(read.links, [], 'a key that is no name links nothing');
    assert.equal(read.linksComplete, true);
    assert.deepEqual(await ports.readKeySharers(uiUser, { book: B, entry: first, key: 'Ilse', limit: 5 }), { entries: [{ thing: second, text: 'The Lantern House', shownAs: 'title' }], more: false });
    assert.deepEqual(await ports.readKeySharers(uiUser, { book: B, entry: first, key: 'Ilse', limit: 0 }), { entries: [], more: true });
    assert.deepEqual(await ports.readKeySharers(uiUser, { book: B, entry: first, key: 'Varro', limit: 5 }), { entries: [], more: false });
    assert.equal(await ports.readKeySharers(uiUser, { book: '424242', entry: first, key: 'Ilse', limit: 5 }), null);
    assert.equal(await edit(B, first, { change: 'setKeyAs', key: 'Ilse', as: 'name' }), 'ok');
    let linked = await ports.readEntry(uiUser, B, second, FIRST);
    assert.ok(linked && !linked.deleted);
    assert.deepEqual(linked.links, [{ entry: first, from: 9, to: 13, picture: '/look-images/p1' }, { entry: first, from: 14, to: 19, picture: '/look-images/p1' }], 'every name links where it is written, with the picture of what it names');
    assert.equal(await edit(B, first, { change: 'addKeys', keys: ['Ilse Varro'], as: 'name' }), 'ok');
    linked = await ports.readEntry(uiUser, B, second, FIRST);
    assert.ok(linked && !linked.deleted);
    assert.deepEqual(linked.links, [{ entry: first, from: 9, to: 19, picture: '/look-images/p1' }], 'of names written over each other, the longest that starts first links');
    assert.equal(await edit(B, first, { change: 'removeKey', key: 'Ilse Varro' }), 'ok');
    assert.equal(await edit(B, first, { change: 'setKeyAs', key: 'Ilse', as: 'trigger' }), 'ok');

    assert.equal(await edit(B, second, { change: 'addKeys', keys: ['The Lantern House'], as: 'name' }), 'ok');
    read = await ports.readEntry(uiUser, B, second, FIRST);
    assert.ok(read && !read.deleted);
    assert.deepEqual(read.label, { thing: second, text: 'The Lantern House', shownAs: 'name' });
    assert.equal(await edit(B, second, { change: 'removeKey', key: 'Ilse' }), 'ok');
    assert.deepEqual(/** @type {any} */ (await ports.readEntry(uiUser, B, first, FIRST)).keys[0], { text: 'Ilse', isName: false, alsoBringsUp: 0 });
    assert.equal(await edit(B, first, { change: 'placement', fields: { depth: 4 } }), 'ok');
    assert.equal(/** @type {any} */ (await ports.readEntry(uiUser, B, first, FIRST)).placementDiffersFromDefaults, false);
    assert.deepEqual(await edit(B, first, { change: 'setKeyAs', key: 'nope', as: 'name' }), { refused: 'That entry has no such key.' });
    assert.equal(await edit(String(other), first, { change: 'text', text: '' }), 'no entry');
    assert.equal(await edit(B, first, { change: 'text', text: 'Varro keeps the lamp.' }), 'ok');
    assert.equal((await lib.books.read('Entries')).entries[1].content, 'Varro keeps the lamp.');

    const made = await ports.createEntry(who, B, { after: first, name: 'Saltmarrow', relation: { kind: String(IN), target: second } }, 100);
    assert.ok(typeof made === 'object' && 'entry' in made);
    const written = (await lib.books.read('Entries')).entries;
    const newest = /** @type {any} */ (Object.values(written).find((/** @type {any} */ e) => e.key[0] === 'Saltmarrow'));
    assert.equal(newest.displayIndex, 0.5, 'right after the first entry, before the second');
    assert.deepEqual(newest.extensions.names, ['Saltmarrow']);
    assert.deepEqual(newest.extensions.relations.map((/** @type {any} */ r) => [r.kind, r.target]), [[IN, 2]]);
    assert.equal(newest.probability, 100, 'a new entry has upstream\'s fields at their defaults');
    const madeRead = await ports.readEntry(uiUser, B, made.entry, FIRST);
    assert.ok(madeRead && !madeRead.deleted);
    assert.deepEqual(madeRead.relations.map(r => [r.kind, r.targetEntry, r.target?.text]), [['1', second, 'The Lantern House']]);
    assert.deepEqual(await ports.createEntry(who, B, { after: null, name: null, relation: { kind: '9', target: second } }, 100), { refused: 'This world has no such relation kind.' });

    const deleted = await ports.deleteEntry(who, B, second);
    assert.ok(typeof deleted === 'object' && 'label' in deleted);
    assert.deepEqual(deleted.label, { thing: second, text: 'The Lantern House', shownAs: 'name' });
    assert.deepEqual(await ports.readEntry(uiUser, B, second, FIRST), { deleted: true });
    assert.equal(await ports.deleteEntry(who, B, second), 'no entry');
    const restored = await ports.restoreEntry(who, B, second);
    assert.ok(typeof restored === 'object' && 'unreachedLoops' in restored);
    await lib.books.jobs.settled();
    const back = await ports.readEntry(uiUser, B, second, FIRST);
    assert.ok(back && !back.deleted);
    assert.deepEqual(back.keys.map(k => [k.text, k.alsoBringsUp]), [['house', 0], ['The Lantern House', 0]]);
    assert.equal(await ports.restoreEntry(who, B, second), 'no entry');
    await edit(B, first, { change: 'addKeys', keys: ['house'], as: 'trigger' });
    assert.deepEqual(/** @type {any} */ (await ports.readEntry(uiUser, B, second, FIRST)).keys[0], { text: 'house', isName: false, alsoBringsUp: 1 }, 'a restored entry\'s keys count again');

    const moved = await ports.moveEntryToWorld(who, B, first, String(other));
    assert.ok(typeof moved === 'object' && 'entry' in moved);
    assert.equal(await ports.readEntry(uiUser, B, first, FIRST).then(r => r && 'deleted' in r && r.deleted), true);
    const there = await ports.readEntry(uiUser, String(other), moved.entry, FIRST);
    assert.ok(there && !there.deleted);
    assert.equal(there.text, 'Varro keeps the lamp.');
    assert.deepEqual(await ports.moveEntryToWorld(who, B, first, String(other)), 'no entry');
    assert.equal(await ports.readEntry(uiUser, B, '424242', FIRST), null);
});

test('what mentions an entry is read as a run of pages, each from the cursor the one before ends at', async () => {
    const many = 260;
    const sources = Object.fromEntries(Array.from({ length: many }, (_, at) => [at + 2, { uid: at + 2, key: [`source ${at}`], comment: '', content: `Ilse ${at}.`, displayIndex: at + 1 }]));
    await lib.books.write('Mentioned', { entries: { 1: { uid: 1, key: ['Ilse'], comment: '', content: 'Ilse.', displayIndex: 0, extensions: { names: ['Ilse'] } }, ...sources } });
    const { id: book } = /** @type {{ id: bigint }} */ (await lib.books.find('Mentioned'));
    const ilse = String((await lib.books.storedEntries(book)).find(({ entity }) => entity.key.endsWith(':1'))?.entity.id);
    const run = /** @type {any} */ (await ports.readEntry(uiUser, String(book), ilse, asked(null, 30))).mentionedIn.pages;
    assert.equal(run.length, Math.ceil(many / MENTIONS_PER_PAGE));
    assert.equal(run.reduce((/** @type {number} */ sum, /** @type {any} */ page) => sum + page.entries.length, 0), many);
    assert.equal(run[0].cursor, null);
    for (let at = 1; at < run.length; at++) assert.equal(run[at].cursor, run[at - 1].next, 'each page is read from where the one before ends');
    assert.equal(run.at(-1).next, null);
    const later = /** @type {any} */ (await ports.readEntry(uiUser, String(book), ilse, asked(run[0].next, 1))).mentionedIn.pages;
    assert.deepEqual(later, [run[1]]);
});

test('a run of mention pages looks through at most MENTION_CHECKS_PER_READ entries in all, ending at the page that reaches it', async () => {
    const others = MENTION_CHECKS_PER_READ + 10;
    const sources = Object.fromEntries(Array.from({ length: others }, (_, at) => [at + 2, { uid: at + 2, key: [], comment: '', content: at === others - 1 ? 'Ilse, at last.' : 'nobody', displayIndex: at + 1 }]));
    await lib.books.write('Far', { entries: { 1: { uid: 1, key: ['Ilse'], comment: '', content: 'Ilse.', displayIndex: 0, extensions: { names: ['Ilse'] } }, ...sources } });
    const { id: book } = /** @type {{ id: bigint }} */ (await lib.books.find('Far'));
    const ilse = String((await lib.books.storedEntries(book)).find(({ entity }) => entity.key.endsWith(':1'))?.entity.id);
    const run = /** @type {any} */ (await ports.readEntry(uiUser, String(book), ilse, asked(null, 3))).mentionedIn.pages;
    assert.equal(run.length, 1, 'the run ends at the page that stopped for the bound');
    assert.deepEqual([run[0].entries, run[0].lookedThrough, run[0].stoppedForBound], [[], MENTION_CHECKS_PER_READ, true]);
    assert.notEqual(run[0].next, null);
    const further = /** @type {any} */ (await ports.readEntry(uiUser, String(book), ilse, asked(run[0].next, 3))).mentionedIn.pages;
    assert.equal(further.length, 1);
    assert.equal(further[0].entries.length, 1);
    assert.deepEqual([further[0].lookedThrough, further[0].stoppedForBound, further[0].next], [others, false, null]);
});

const asWorld = (/** @type {any} */ stored) => entryAsWorld(stored, 'world');

test('an entry\'s character filter is stored in upstream\'s form and shown by the user\'s characters and tags', async () => {
    const card = (/** @type {string} */ name) => JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', name, data: { name, tags: ['npc'] } });
    await lib.writeCard(user.directories, 'Wren.png', card('Wren'));
    const { tagIds: [npc] } = await lib.tags.seedCardTags('Wren.png');
    const [npcThing] = (await lib.ids(TYPE.tag, [npc])).map(String);
    const npcNamed = { thing: npcThing, text: 'npc', shownAs: 'name' };
    await lib.books.write('Filtered', { entries: { 1: { uid: 1, key: ['x'], content: 'x', displayIndex: 0 } } });
    const { id: book } = /** @type {{ id: bigint }} */ (await lib.books.find('Filtered'));
    const [{ entity }] = await lib.books.storedEntries(book);
    const [B, E] = [String(book), String(entity.id)];
    for (const filter of [{ add: { character: 'Wren' } }, { add: { character: 'Gone' } }, { add: { tag: npc } }, { exclude: true }, { add: { character: 'Wren' } }]) {
        assert.equal(await edit(B, E, { change: 'characterFilter', filter }), 'ok');
    }
    assert.deepEqual(asWorld(await lib.books.entryIn(book, entity.id)).characterFilter, { isExclude: true, names: ['Gone', 'Wren'], tags: [npc] });
    const read = /** @type {any} */ (await ports.readEntry(uiUser, B, E, FIRST));
    assert.equal(read.characterFilter.exclude, true);
    assert.deepEqual(read.characterFilter.characters.map((/** @type {any} */ c) => [c.key, c.named?.text ?? null]), [['Gone', null], ['Wren', 'Wren']]);
    assert.deepEqual(read.characterFilter.tags, [{ key: npc, named: npcNamed }]);
    assert.equal(read.characterFilter.more, 0);
    assert.equal(await edit(B, E, { change: 'characterFilter', filter: { remove: { character: 'Gone' } } }), 'ok');
    assert.deepEqual(asWorld(await lib.books.entryIn(book, entity.id)).characterFilter.names, ['Wren']);
    const found = await ports.findCharacters(uiUser, { query: 'wre', limit: 20 });
    assert.deepEqual(found.characters.map(c => [c.key, c.named?.text]), [['Wren', 'Wren']]);
    assert.deepEqual((await ports.findCharacters(uiUser, { query: 'np', limit: 20 })).tags, [{ key: npc, named: npcNamed }]);
});

after(async () => {
    await user.close();
    setImmediate(() => process.exit(0));
});

test('an edit made against an older version merges with what another tab changed since, unless both changed one thing', async () => {
    const entries = {
        1: { uid: 1, key: ['Ilse'], comment: 'Ilse', content: 'Ilse keeps the lamp by the door. She sleeps late.', displayIndex: 0, depth: 4, extensions: { names: ['Ilse'] } },
    };
    await lib.books.write('Two tabs', { entries });
    const { id: book } = /** @type {{ id: bigint }} */ (await lib.books.find('Two tabs'));
    const B = String(book);
    const [{ entity }] = await lib.books.storedEntries(book);
    const E = String(entity.id);
    const tab = (/** @type {string} */ session) => ({ user: uiUser, session });
    const [one, two] = [tab('one'), tab('two')];
    const version = async () => /** @type {any} */ (await ports.readEntry(uiUser, B, E, FIRST)).version;
    const shown = async () => /** @type {any} */ (await ports.readEntry(uiUser, B, E, FIRST));

    let v0 = await version();
    assert.equal(await ports.editEntry(one, B, E, { change: 'text', text: 'Ilse keeps the old lamp by the door. She sleeps late.' }, v0), 'ok');
    assert.notEqual(await version(), v0, 'an edit makes a new version');
    assert.equal(await ports.editEntry(two, B, E, { change: 'text', text: 'Ilse keeps the lamp by the door. She wakes early.' }, v0), 'ok');
    assert.equal((await shown()).text, 'Ilse keeps the old lamp by the door. She wakes early.', 'text changed in different places merges');

    v0 = await version();
    assert.equal(await ports.editEntry(one, B, E, { change: 'title', title: 'Ilse Varro' }, v0), 'ok');
    assert.equal(await ports.editEntry(two, B, E, { change: 'placement', fields: { depth: 2 } }, v0), 'ok');
    assert.equal(await ports.editEntry(two, B, E, { change: 'addKeys', keys: ['lamp'], as: 'trigger' }, v0), 'ok');
    assert.equal(await ports.editEntry(one, B, E, { change: 'addKeys', keys: ['door'], as: 'trigger' }, v0), 'ok');
    let read = await shown();
    assert.equal(read.title, 'Ilse Varro');
    assert.equal(read.placement.depth, 2);
    assert.deepEqual(read.keys.map((/** @type {{ text: string }} */ key) => key.text), ['Ilse', 'lamp', 'door'], 'both tabs\' keys are kept');

    v0 = await version();
    assert.equal(await ports.editEntry(one, B, E, { change: 'placement', fields: { depth: 6 } }, v0), 'ok');
    assert.equal(await ports.editEntry(one, B, E, { change: 'placement', fields: { depth: 7 } }, v0), 'ok', 'a tab\'s own changes since never conflict');
    const depth = await ports.editEntry(two, B, E, { change: 'placement', fields: { depth: 1 } }, v0);
    assert.ok(typeof depth === 'object' && 'conflict' in depth);
    assert.equal(depth.conflict.version, await version());
    assert.deepEqual(depth.conflict.fields, [{ field: 'depth', mine: 1, theirs: 7, merged: null, diff: null }]);
    assert.equal((await shown()).placement.depth, 7, 'a refused edit writes nothing');

    v0 = await version();
    assert.equal(await ports.editEntry(one, B, E, { change: 'text', text: 'Ilse keeps the old lamp by the window. She wakes early.' }, v0), 'ok');
    const text = await ports.editEntry(two, B, E, { change: 'text', text: 'Ilse keeps the old lamp by the gate. She wakes early.' }, v0);
    assert.ok(typeof text === 'object' && 'conflict' in text);
    const [field] = text.conflict.fields;
    assert.equal(field.field, 'content');
    assert.equal(field.mine, 'Ilse keeps the old lamp by the gate. She wakes early.');
    assert.equal(field.theirs, 'Ilse keeps the old lamp by the window. She wakes early.');
    assert.equal(field.merged, 'Ilse keeps the old lamp by the windowgate. She wakes early.');
    assert.deepEqual(field.diff, [
        { text: 'Ilse keeps the old lamp by the ', in: 'both' },
        { text: 'gate', in: 'mine' },
        { text: 'window', in: 'theirs' },
        { text: '. She wakes early.', in: 'both' },
    ]);
    assert.equal(await ports.editEntry(two, B, E, { change: 'text', text: 'Ilse keeps the old lamp by the gate. She wakes early.' }, text.conflict.version), 'ok', 'kept against the version it was refused with');
    read = await shown();
    assert.equal(read.text, 'Ilse keeps the old lamp by the gate. She wakes early.');
    assert.equal(read.title, 'Ilse Varro');
});

test('card facts distinguish vector search and preserve disabled and constant precedence', async () => {
    await lib.books.write('Status dots', { entries: {
        1: { uid: 1, vectorized: true },
        2: { uid: 2, vectorized: true, constant: true },
        3: { uid: 3, vectorized: true, constant: true, disable: true },
        4: { uid: 4 },
    } });
    const { id } = await lib.books.find('Status dots');
    const entries = await lib.books.storedEntries(id);
    const ids = [1, 2, 3, 4].map(uid => String(entries.find(({ entity }) => entity.key.endsWith(`:${uid}`)).entity.id));
    const facts = await ports.readFacts(uiUser, String(id), ids, false);
    assert.deepEqual(facts.map(fact => fact.comesIn), ['found', 'always', 'never', 'broughtUp']);
});
