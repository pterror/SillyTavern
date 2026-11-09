import assert from 'node:assert/strict';
import { after, test } from 'node:test';

const { onUserStoreOpened } = await import('../user-stores.js');
/** @type {{ events: import('node:events').EventEmitter }[]} */
const opened = [];
onUserStoreOpened(store => opened.push(store));
const { emptyUser } = await import('../../tests/converted-user.fixture.js');
const user = await emptyUser('st-overview-test-');
const lib = user.store.lib;

const IN = 1;
const OWES = 2;
const KINDS = [{ id: IN, name: 'in' }, { id: OWES, name: 'owes' }];
const LAYOUT = { regionColumns: [2], regionRows: [2], cardTextCharacters: 100 };

const entry = (uid, displayIndex, relations) => ({
    uid,
    key: [`name ${uid}`],
    comment: `entry ${uid}`,
    content: `about ${uid}`,
    displayIndex,
    ...(relations ? { extensions: { relations } } : {}),
});

/**
 * @param {{ occurrence: string, region?: any[], cell: string, alreadyOpenAbove?: boolean, groupingKindRelationsTargetingRegionEntryNotShown?: number }} item
 * @param {string[]} out
 */
function outline(item, out) {
    out.push(item.cell === 'notShownTile' ? `${item.occurrence}=${item.groupingKindRelationsTargetingRegionEntryNotShown}` : item.alreadyOpenAbove ? `${item.occurrence}!` : item.occurrence);
    for (const c of item.region ?? []) outline(c, out);
}

async function idsOf(book) {
    return new Map((await lib.books.storedEntries(book)).map(({ entity }) => [Number(entity.key.split(':')[1]), entity.id]));
}

const overview = (book, groupBy) => lib.store.worldRead('worldbuildingOverview', { book, groupBy, firstRank: 0, endRank: 20, stepLandedOn: null, ...LAYOUT });

test('a world\'s relation kinds and its entries\' relations group the overview and round-trip; a world written whole leaves out relations to what it lacks', async () => {
    const entries = [
        entry(1, 0),
        entry(2, 1, [{ kind: IN, target: 1, position: 'b' }]),
        entry(3, 2, [{ kind: IN, target: 1, position: 'a' }, { kind: OWES, target: 2, position: 'a', weak: true }]),
        entry(4, 3, [{ kind: IN, target: 77, position: 'a' }, { kind: 9, target: 1, position: 'a' }]),
    ];
    await lib.books.write('World', { relationKinds: KINDS, entries: Object.fromEntries(entries.map(e => [e.uid, e])) });
    const found = await lib.books.find('World');
    assert.ok(found?.defined);
    const ids = await idsOf(found.id);
    const view = await overview(found.id, IN);
    assert.equal(view.topLevelCount, 2);
    const keys = [];
    for (const item of view.entries) outline(item, keys);
    const [a, b, c, d] = [1, 2, 3, 4].map(uid => String(ids.get(uid)));
    assert.deepEqual(keys, [a, `${a}/${c}`, `${a}/${b}`, d]);
    assert.deepEqual(view.entries[0].region[0].relations.map(r => [r.kind, r.kindName, r.targetKey, r.targetEntry, r.target, r.weak]), [
        ['1', 'in', '1', a, { thing: a, text: 'entry 1', shownAs: 'title' }, false],
        ['2', 'owes', '2', b, { thing: b, text: 'entry 2', shownAs: 'title' }, true],
    ]);
    assert.deepEqual(view.entries[0].keys, ['name 1']);

    const stepped = await lib.store.worldRead('worldbuildingStep', { book: found.id, groupBy: IN, from: `${a}/${b}`, by: 1, regionColumns: [2], regionRows: [2] });
    assert.deepEqual(stepped, { occurrence: d, topLevelRank: 1 });

    const back = await lib.books.read('World');
    assert.deepEqual(back.relationKinds, KINDS);
    assert.deepEqual(back.entries[3].extensions.relations, entries[2].extensions.relations);
    assert.deepEqual(back.entries[4].extensions.relations, [], 'the relation to a missing entry and the one of a missing kind are left out');
    assert.deepEqual(await lib.books.relationKinds(found.id), KINDS);
});

test('an entry\'s names are the keys it marks, in the keys\' order, through every write and round trip; a value that is no list holds none', async () => {
    const named = { uid: 1, key: ['Varro', 'Ilse', 'lamp'], comment: '', content: 'Ilse Varro keeps the lamp.', displayIndex: 0, extensions: { names: ['Ilse', 'nobody', 'Varro', 'Ilse'] } };
    const odd = { uid: 2, key: ['x'], comment: '', content: 'Second line\nfirst', displayIndex: 1, extensions: { names: { by: 'another tool' } } };
    await lib.books.write('Names', { entries: { 1: named, 2: odd } });
    let read = await lib.books.read('Names');
    assert.deepEqual(read.entries[1].extensions.names, ['Varro', 'Ilse']);
    assert.deepEqual(read.entries[2].extensions.names, { by: 'another tool' });
    const { id: book } = await lib.books.find('Names');
    let view = await overview(book, null);
    assert.deepEqual(view.entries.map(e => [e.names, e.label]), [
        [['Varro', 'Ilse'], { thing: view.entries[0].entry, text: 'Varro', shownAs: 'name' }],
        [[], { thing: view.entries[1].entry, text: 'Second line', shownAs: 'opening' }],
    ]);
    await lib.books.editEntry('Names', 1, { ...read.entries[1], key: ['Ilse', 'lamp'], comment: 'Ilse' });
    read = await lib.books.read('Names');
    assert.deepEqual(read.entries[1].extensions.names, ['Ilse'], 'a name that is no longer a key is no longer a name');
    view = await overview(book, null);
    assert.deepEqual(view.entries[0].label, { thing: view.entries[0].entry, text: 'Ilse', shownAs: 'name' });
    const { convertCharacterBook } = await import('./candidate-resolution.js');
    const card = { entries: [{ id: 0, keys: ['Ilse', 'lamp'], content: 'x', extensions: { names: ['lamp', 'Ilse', 'gone'] }, enabled: true, insertion_order: 1 }] };
    await lib.books.write('From card', convertCharacterBook(card));
    assert.deepEqual((await lib.books.read('From card')).entries[0].extensions.names, ['Ilse', 'lamp']);
});

test('relation actions pick a kind by id, place the entry, find a loop nothing at the top holds, and a weak relation opens it', async () => {
    await lib.books.write('Loops', { entries: Object.fromEntries([entry(1, 0), entry(2, 1), entry(3, 2)].map(e => [e.uid, e])) });
    const { id: book } = await lib.books.find('Loops');
    const kind = await lib.books.createRelationKind(book, 'in');
    assert.equal(kind, 1);
    assert.equal(await lib.books.createRelationKind(book, 'In'), 2, 'names differing only in case are two kinds');
    assert.equal(await lib.books.renameRelationKind(book, 2, 'inside'), 'ok');
    assert.equal(await lib.books.renameRelationKind(book, 7, 'x'), 'no kind');
    const ids = await idsOf(book);
    const [x, y, z] = [1, 2, 3].map(uid => ids.get(uid));
    const add = (entry, target, weak = false) => lib.books.changeRelation(book, { change: 'add', entry, kind, target, after: null, before: null, weak }, 100);
    assert.deepEqual(await add(x, y), { unreachedLoops: [] });
    assert.deepEqual(await add(z, y), { unreachedLoops: [] });
    const loop = await add(y, x);
    assert.ok(typeof loop === 'object' && 'unreachedLoops' in loop);
    assert.deepEqual(loop.unreachedLoops.map(found => [found.entry, found.kind, new Set(found.entries)]), [[String(y), '1', new Set([String(x), String(y)])]]);
    assert.deepEqual(await add(y, x), { refused: 'The entry already has that relation.' });
    assert.deepEqual(await lib.books.changeRelation(book, { change: 'add', entry: x, kind: 5, target: z, after: null, before: null, weak: false }, 100), { refused: 'This world has no such relation kind.' });
    assert.deepEqual(await lib.books.changeRelation(book, { change: 'setWeak', entry: y, kind, target: x, weak: true }, 100), { unreachedLoops: [] });
    const view = await overview(book, kind);
    assert.deepEqual(view.entries.map(e => e.occurrence), [String(y)]);
    const keys = [];
    outline(view.entries[0], keys);
    assert.deepEqual(keys, [String(y), `${y}/${x}`, `${y}/${z}`]);
    const read = await lib.books.read('Loops');
    assert.deepEqual(read.relationKinds, [{ id: 1, name: 'in' }, { id: 2, name: 'inside' }]);
    assert.deepEqual(read.entries[2].extensions.relations.map(r => [r.kind, r.target, r.weak ?? false]), [[1, 1, true]]);
    assert.equal(await lib.books.deleteRelationKind(book, kind), 'in use');
    assert.equal(await lib.books.deleteRelationKind(book, 2), 'ok');
    assert.equal(await lib.books.deleteRelationKind(book, 2), 'no kind');
    assert.deepEqual((await lib.books.relationKinds(book)).map(k => k.id), [1]);
});

test('a write that leaves entries held only by a loop says so in its own answer: an import, and a delete through apply', async () => {
    const loopOnly = [entry(1, 0, [{ kind: IN, target: 2, position: 'a' }]), entry(2, 1, [{ kind: IN, target: 1, position: 'a' }])];
    const imported = await lib.books.write('Imported loop', { relationKinds: KINDS, entries: Object.fromEntries(loopOnly.map(e => [e.uid, e])) });
    assert.ok(typeof imported === 'object');
    assert.equal(imported.unreachedLoops.length, 1);
    assert.equal(imported.unreachedLoops[0].entries.length, 2);

    const held = [
        entry(1, 0, [{ kind: IN, target: 2, position: 'a' }, { kind: IN, target: 3, position: 'a' }]),
        entry(2, 1, [{ kind: IN, target: 1, position: 'a' }]),
        entry(3, 2),
    ];
    const written = await lib.books.write('Held loop', { relationKinds: KINDS, entries: Object.fromEntries(held.map(e => [e.uid, e])) });
    assert.ok(typeof written === 'object');
    assert.deepEqual(written.unreachedLoops, []);
    const { jsonHash } = await import('../../public/scripts/hash-utils.js');
    const current = (await lib.books.read('Held loop')).entries[3];
    const deleted = await lib.books.apply('Held loop', [{ uid: 3, base_hash: jsonHash(current), data: null }], []);
    assert.ok(deleted && typeof deleted === 'object');
    assert.equal(deleted.unreachedLoops.length, 1, 'entry 1 lost its relation to 3 and only the loop holds it');
});

test('deleting an entry takes every relation targeting it out of use, kept in its source; restoring it puts back what its sources still hold', async () => {
    const entries = [
        entry(1, 0),
        entry(2, 1, [{ kind: IN, target: 1, position: 'a' }, { kind: OWES, target: 3, position: 'a' }]),
        entry(3, 2, [{ kind: IN, target: 1, position: 'b' }]),
    ];
    await lib.books.write('Deletes', { relationKinds: KINDS, entries: Object.fromEntries(entries.map(e => [e.uid, e])) });
    const { id: book } = await lib.books.find('Deletes');
    const ids = await idsOf(book);
    const hash = async uid => (await import('../../public/scripts/hash-utils.js')).jsonHash((await lib.books.read('Deletes')).entries[uid]);
    const result = await lib.books.apply('Deletes', [{ uid: 1, base_hash: await hash(1), data: null }], []);
    assert.ok(result && typeof result === 'object' && result.ok);
    let read = await lib.books.read('Deletes');
    const third = ids.get(3);
    assert.deepEqual(read.entries[2].extensions.relations, [{ kind: OWES, target: 3, position: 'a' }], 'a relation kept while its target is deleted is in no read or export');
    assert.ok(!JSON.stringify(read).includes('targetEntry'));
    const view = await overview(book, IN);
    assert.equal(view.topLevelCount, 2);
    assert.deepEqual(view.entries[0].relations.map(r => [r.targetDeleted, r.inUse]), [[true, false], [false, true]]);

    const saved = await lib.books.apply('Deletes', [{ uid: 2, base_hash: await hash(2), data: { ...read.entries[2], comment: 'saved whole' } }], []);
    assert.ok(saved && typeof saved === 'object' && saved.ok);
    await lib.books.editEntry('Deletes', 2, { ...(await lib.books.read('Deletes')).entries[2], content: 'edited whole' });
    await lib.books.write('Deletes', await lib.books.read('Deletes'));
    assert.deepEqual((await overview(book, IN)).entries[0].relations.map(r => [r.targetDeleted, r.inUse]), [[true, false], [false, true]], 'whole-entry and whole-world saves leave the kept relation as it was');

    const gone = await lib.books.apply('Deletes', [{ uid: 3, base_hash: await hash(3), data: null }], []);
    assert.ok(gone && typeof gone === 'object' && gone.ok);
    const reused = await lib.books.apply('Deletes', [{ uid: 3, base_hash: null, data: entry(3, 9) }], []);
    assert.ok(reused && typeof reused === 'object' && reused.ok, 'a new entry takes the deleted entry\'s key at once');
    const restored = await lib.books.restore('Deletes', third);
    assert.ok(typeof restored === 'object');
    await lib.books.jobs.settled();
    read = await lib.books.read('Deletes');
    assert.ok(typeof restored === 'object' && restored.uid !== '3');
    assert.deepEqual(read.entries[restored.uid].extensions.relations, [], 'its own relation to entry 1, deleted since, is kept out of sight');
    assert.deepEqual(read.entries[2].extensions.relations, [{ kind: OWES, target: Number(restored.uid), position: 'a' }], 'the restored entry, under its new key, not the new entry under its old one');

    const restoredFirst = await lib.books.restore('Deletes', ids.get(1));
    assert.ok(typeof restoredFirst === 'object');
    await lib.books.jobs.settled();
    read = await lib.books.read('Deletes');
    assert.deepEqual(read.entries[2].extensions.relations.map(r => [r.kind, r.target]).sort(), [[IN, 1], [OWES, Number(restored.uid)]].sort());
    assert.deepEqual(read.entries[restored.uid].extensions.relations, [{ kind: IN, target: 1, position: 'b' }]);
});

test('a kept relation goes only by its own removal', async () => {
    await lib.books.write('Removing', { relationKinds: KINDS, entries: Object.fromEntries([entry(1, 0), entry(2, 1, [{ kind: IN, target: 1, position: 'a' }])].map(e => [e.uid, e])) });
    const { id: book } = await lib.books.find('Removing');
    const ids = await idsOf(book);
    const { jsonHash } = await import('../../public/scripts/hash-utils.js');
    await lib.books.apply('Removing', [{ uid: 1, base_hash: jsonHash((await lib.books.read('Removing')).entries[1]), data: null }], []);
    const removed = await lib.books.changeRelation(book, { change: 'remove', entry: /** @type {bigint} */ (ids.get(2)), kind: IN, target: /** @type {bigint} */ (ids.get(1)) }, 100);
    assert.deepEqual(removed, { unreachedLoops: [] });
    await lib.books.restore('Removing', /** @type {bigint} */ (ids.get(1)));
    await lib.books.jobs.settled();
    assert.deepEqual((await lib.books.read('Removing')).entries[2].extensions.relations, [], 'removed by its own action, it does not come back');
});

test('deleting an entry that thousands of entries target removes it at once and takes their relations out of use in steps', async () => {
    const { RELATION_CHANGES_PER_STEP } = await import('../world-info-engine.js');
    const sources = RELATION_CHANGES_PER_STEP + 5;
    const entries = [entry(1, 0)];
    for (let uid = 2; uid < sources + 2; uid++) entries.push(entry(uid, uid, [{ kind: IN, target: 1, position: 'a' }]));
    await lib.books.write('Large', { relationKinds: KINDS, entries: Object.fromEntries(entries.map(e => [e.uid, e])) });
    const { id: book } = await lib.books.find('Large');
    const { jsonHash } = await import('../../public/scripts/hash-utils.js');
    const current = (await lib.books.read('Large')).entries[1];
    const result = await lib.books.apply('Large', [{ uid: 1, base_hash: jsonHash(current), data: null }], []);
    assert.ok(result && typeof result === 'object' && result.ok);
    assert.deepEqual(result.deleted, ['1']);
    await lib.books.jobs.settled();
    const after = await overview(book, IN);
    assert.equal(after.topLevelCount, sources);
    assert.ok(after.entries.every(cell => cell.cell === 'entry'));
});

test('a deletion step that leaves entries held only by a loop pushes what it found to the world\'s open tabs', async () => {
    const { RELATION_CHANGES_PER_STEP } = await import('../world-info-engine.js');
    const entries = [entry(1, 0), entry(2, 1, [{ kind: IN, target: 1, position: 'z' }, { kind: IN, target: 3, position: 'a' }]), entry(3, 2, [{ kind: IN, target: 2, position: 'a' }])];
    for (let uid = 4; uid < RELATION_CHANGES_PER_STEP + 5; uid++) entries.push(entry(uid, uid, [{ kind: IN, target: 1, position: 'a' }]));
    await lib.books.write('Looping', { relationKinds: KINDS, entries: Object.fromEntries(entries.map(e => [e.uid, e])) });
    const { id: book } = await lib.books.find('Looping');
    const ids = await idsOf(book);
    /** @type {bigint[]} */
    const pushed = [];
    const pushStep = lib.books.jobs.onStepDone;
    lib.books.jobs.onStepDone = world => pushed.push(world);
    const { jsonHash } = await import('../../public/scripts/hash-utils.js');
    const current = (await lib.books.read('Looping')).entries[1];
    const result = await lib.books.apply('Looping', [{ uid: 1, base_hash: jsonHash(current), data: null }], []);
    assert.ok(result && typeof result === 'object' && result.ok);
    assert.deepEqual(result.unreachedLoops, [], 'entry 2 is still held by the deleted entry\'s place when the delete answers');
    await lib.books.jobs.settled();
    lib.books.jobs.onStepDone = pushStep;
    assert.ok(pushed.length > 0 && pushed.every(world => world === book), 'every step is pushed for its world');
    assert.ok(opened.length > 0, 'a store opening tells its listeners, so a resumed job pushes without a request');
    let heard = 0;
    const listener = () => heard++;
    opened[0].events.on('worldbuildingJobStep', listener);
    pushStep?.(book);
    opened[0].events.off('worldbuildingJobStep', listener);
    assert.equal(heard, 1);
    const loops = lib.books.jobs.loopsLeft(book);
    assert.equal(loops.length, 1);
    assert.deepEqual(new Set(loops[0].entries), new Set([String(ids.get(2)), String(ids.get(3))]));
});

test('merging a kind into another turns its relations into the other kind, folds twins into one, then removes the kind', async () => {
    const entries = [
        entry(1, 0),
        entry(2, 1, [{ kind: OWES, target: 1, position: 'a', note: 'kept' }]),
        entry(3, 2, [{ kind: OWES, target: 1, position: 'a' }, { kind: IN, target: 1, position: 'b', weak: true }]),
    ];
    await lib.books.write('Merging', { relationKinds: KINDS, entries: Object.fromEntries(entries.map(e => [e.uid, e])) });
    const { id: book } = await lib.books.find('Merging');
    assert.equal(await lib.books.mergeRelationKind(book, OWES, OWES), 'same kind');
    assert.equal(await lib.books.mergeRelationKind(book, OWES, IN), 'ok');
    assert.equal(await lib.books.mergeRelationKind(book, OWES, IN), 'being merged');
    await lib.books.jobs.settled();
    const read = await lib.books.read('Merging');
    assert.deepEqual(read.relationKinds, [{ id: IN, name: 'in' }]);
    assert.deepEqual(read.entries[2].extensions.relations, [{ kind: IN, target: 1, position: 'a', note: 'kept' }]);
    assert.deepEqual(read.entries[3].extensions.relations, [{ kind: IN, target: 1, position: 'b' }]);
});

test('moving an entry to another world drops its relations there and removes the ones pointing at it here', async () => {
    const entries = [entry(1, 0, [{ kind: IN, target: 2, position: 'a' }]), entry(2, 1, [{ kind: IN, target: 1, position: 'a' }])];
    await lib.books.write('From', { relationKinds: KINDS, entries: Object.fromEntries(entries.map(e => [e.uid, e])) });
    await lib.books.write('To', { entries: {} });
    const moved = await lib.books.transplant({ source: 'From', target: 'To', uid: 1, deleteOriginal: true });
    assert.ok(typeof moved === 'object');
    assert.deepEqual(moved.entry.extensions, {});
    const from = await lib.books.read('From');
    assert.deepEqual(Object.keys(from.entries), ['2']);
    assert.deepEqual(from.entries[2].extensions.relations, [], 'kept while its target is deleted, out of sight');
    const { id: fromBook } = await lib.books.find('From');
    assert.equal((await overview(fromBook, IN)).topLevelCount, 1);
});

after(async () => {
    await user.close();
    setImmediate(() => process.exit(0));
});
