import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { filterClauses, findClauses, worldbuildingSearchPorts } from './worldbuilding-search.js';
import { WORLD_FIELD } from '../search-clauses.js';
import { WALK_STEPS_PER_READ } from '@st/worldbuilding/protocol';

const { emptyUser } = await import('../../tests/converted-user.fixture.js');
const user = await emptyUser('st-worldbuilding-search-test-');
const lib = user.store.lib;
const uiUser = /** @type {import('@st/server-ui').User} */ ({ handle: 'u', directories: user.directories });
const ports = worldbuildingSearchPorts({ libOf: async () => lib });

const IN = 1;
const LAYOUT = { regionsByNestingLevel: [], cardTextCharacters: 8 };

test('the filter reads the app\'s search syntax with a world\'s fields as labels; finding looks at keys and titles', () => {
    assert.deepEqual(filterClauses('title:lamp -text:"old oil" street'), [
        { text: 'lamp', negate: false, quoted: false, fields: [WORLD_FIELD.title] },
        { text: 'old oil', negate: true, quoted: true, fields: [WORLD_FIELD.text] },
        { text: 'street', negate: false, quoted: false },
    ]);
    assert.deepEqual(findClauses('old title:lamp'), [
        { text: 'old', negate: false, quoted: false, fields: [WORLD_FIELD.key, WORLD_FIELD.title] },
        { text: 'title:lamp', negate: false, quoted: false, fields: [WORLD_FIELD.key, WORLD_FIELD.title] },
    ]);
});

test('results, chips and found entries over the store', async () => {
    const entries = {
        1: { uid: 1, key: ['Saltmarrow'], comment: '', content: 'a city by the sea', displayIndex: 0, extensions: { names: ['Saltmarrow'] } },
        2: { uid: 2, key: ['docks'], comment: 'The Docks', content: 'lamp oil and nets', displayIndex: 1, extensions: { relations: [{ kind: IN, target: 1, position: 'a' }] } },
        3: { uid: 3, key: ['street'], comment: 'Lamp Street', content: 'the lamps', displayIndex: 2, extensions: { relations: [{ kind: IN, target: 1, position: 'b' }] } },
        4: { uid: 4, key: ['old lamp'], comment: '', content: 'an old lamp', displayIndex: 3, extensions: { relations: [{ kind: IN, target: 2, position: 'a' }] } },
        5: { uid: 5, key: ['far'], comment: 'Far Lamp', content: 'a lamp far away', displayIndex: 4 },
    };
    await lib.books.write('Search', { relationKinds: [{ id: IN, name: 'in' }], entries });
    const { id: book } = /** @type {{ id: bigint }} */ (await lib.books.find('Search'));
    const ids = new Map((await lib.books.storedEntries(book)).map(({ entity }) => [entity.key.split(':')[1], String(entity.id)]));
    const id = (/** @type {number} */ uid) => /** @type {string} */ (ids.get(String(uid)));
    const B = String(book);

    assert.deepEqual(await ports.labelEntries(uiUser, B, [id(1), '424242']), [{ thing: id(1), text: 'Saltmarrow', shownAs: 'name' }, null]);
    const query = { book: B, groupBy: String(IN), layout: LAYOUT, pageSize: 10, from: null, pages: 1, walkSteps: WALK_STEPS_PER_READ };
    const read = await ports.readResults(uiUser, { ...query, query: 'lamp', chips: [{ kind: String(IN), target: id(1), depth: 'anyDepth' }] });
    assert.deepEqual(read.chips, [{ kindName: 'in', target: { thing: id(1), text: 'Saltmarrow', shownAs: 'name' } }]);
    assert.deepEqual(new Set(read.pages[0].entries.map(card => card.entry)), new Set([id(2), id(3), id(4)]));
    const card = /** @type {any} */ (read.pages[0].entries.find(found => found.entry === id(4)));
    assert.equal(card.occurrence, id(4));
    assert.equal(card.text, 'an old l');
    assert.equal(card.textCut, true);
    assert.deepEqual(card.relations.map((/** @type {any} */ relation) => relation.target.text), ['The Docks']);
    assert.deepEqual(card.region, []);
    assert.equal(read.pages[0].next, null);

    const titled = await ports.readResults(uiUser, { ...query, query: 'title:lamp', chips: [] });
    assert.deepEqual(new Set(titled.pages[0].entries.map(found => found.entry)), new Set([id(3), id(5)]));

    const first = await ports.readResults(uiUser, { ...query, pageSize: 1, query: '  ', chips: [{ kind: String(IN), target: id(1), depth: 'directly' }] });
    assert.deepEqual(first.pages[0].entries.map(found => found.occurrence), [`${id(1)}/${id(2)}`]);
    const cursor = /** @type {string} */ (first.pages[0].next);
    const both = await ports.readResults(uiUser, { ...query, pageSize: 1, query: '', pages: 5, chips: [{ kind: String(IN), target: id(1), depth: 'directly' }] });
    assert.deepEqual(both.pages.map(page => page.entries.map(found => found.entry)), [[id(2)], [id(3)]], 'a run reads on to the last page');
    assert.deepEqual(both.pages.map(page => page.cursor), [null, cursor]);
    assert.equal(both.pages[1].next, null);
    const later = await ports.readResults(uiUser, { ...query, pageSize: 1, query: '', from: cursor, pages: 1, chips: [{ kind: String(IN), target: id(1), depth: 'directly' }] });
    assert.deepEqual(later.pages.map(page => page.entries.map(found => found.entry)), [[id(3)]]);

    const found = await ports.findEntries(uiUser, { book: B, query: 'lamp', limit: 20 });
    assert.deepEqual(new Set(found.entries.map(named => named.text)), new Set(['Lamp Street', 'an old lamp', 'Far Lamp']), 'a trigger matches too; the label is the label rule\'s');
    assert.equal(found.next, null);
    assert.deepEqual(await ports.findEntries(uiUser, { book: B, query: ' ', limit: 20 }), { entries: [], next: null });
});

after(async () => {
    await user.close();
    setImmediate(() => process.exit(0));
});
