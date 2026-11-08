import assert from 'node:assert/strict';
import { after, test } from 'node:test';

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
 * @param {{ occurrence: string, region?: any[], cell: string, alreadyOpenAbove?: boolean, moreCount?: number }} item
 * @param {string[]} out
 */
function outline(item, out) {
    out.push(item.cell === 'more' ? `${item.occurrence}=${item.moreCount}` : item.alreadyOpenAbove ? `${item.occurrence}!` : item.occurrence);
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
    assert.deepEqual(view.entries[0].region[0].relations.map(r => [r.kind, r.kindName, r.targetKey, r.target, r.targetTitle, r.weak]), [
        ['1', 'in', '1', a, 'entry 1', false],
        ['2', 'owes', '2', b, 'entry 2', true],
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
    assert.deepEqual(await add(x, y), { unreached: null });
    assert.deepEqual(await add(z, y), { unreached: null });
    const loop = await add(y, x);
    assert.ok(typeof loop === 'object' && 'unreached' in loop && loop.unreached);
    assert.deepEqual(new Set(loop.unreached), new Set([String(x), String(y)]));
    assert.deepEqual(await add(y, x), { refused: 'The entry already has that relation.' });
    assert.deepEqual(await lib.books.changeRelation(book, { change: 'add', entry: x, kind: 5, target: z, after: null, before: null, weak: false }, 100), { refused: 'This world has no such relation kind.' });
    assert.deepEqual(await lib.books.changeRelation(book, { change: 'setWeak', entry: y, kind, target: x, weak: true }, 100), { unreached: null });
    const view = await overview(book, kind);
    assert.deepEqual(view.entries.map(e => e.occurrence), [String(y)]);
    const keys = [];
    outline(view.entries[0], keys);
    assert.deepEqual(keys, [String(y), `${y}/${x}`, `${y}/${z}`]);
    const read = await lib.books.read('Loops');
    assert.deepEqual(read.relationKinds, [{ id: 1, name: 'in' }, { id: 2, name: 'inside' }]);
    assert.deepEqual(read.entries[2].extensions.relations.map(r => [r.kind, r.target, r.weak ?? false]), [[1, 1, true]]);
});

test('deleting an entry removes every relation pointing at it, and restoring one leaves out relations to what is gone since', async () => {
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
    assert.deepEqual(read.entries[2].extensions.relations, [{ kind: OWES, target: 3, position: 'a' }]);
    assert.deepEqual(read.entries[3].extensions.relations, []);
    const view = await overview(book, IN);
    assert.equal(view.topLevelCount, 2);

    const third = ids.get(3);
    const gone = await lib.books.apply('Deletes', [{ uid: 3, base_hash: await hash(3), data: null }], []);
    assert.ok(gone && typeof gone === 'object' && gone.ok);
    read = await lib.books.read('Deletes');
    assert.deepEqual(read.entries[2].extensions.relations, []);
    const restored = await lib.books.restore('Deletes', third);
    assert.ok(typeof restored === 'object');
    read = await lib.books.read('Deletes');
    assert.deepEqual(read.entries[3].extensions.relations, [], 'its relation to entry 1, deleted since, is left out');
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
    assert.deepEqual(from.entries[2].extensions.relations, []);
});

after(async () => {
    await user.close();
    setImmediate(() => process.exit(0));
});
