import assert from 'node:assert/strict';
import { after, test } from 'node:test';

const { emptyUser } = await import('../../tests/converted-user.fixture.js');
const { RELATION_CHANGES_PER_STEP } = await import('../world-info-engine.js');
const user = await emptyUser('st-worldbuilding-bulk-test-');
const lib = user.store.lib;

const IN = 1;
const KINDS = [{ id: IN, name: 'in' }];
const LOOPS = 12_000;

const entry = (uid, content, relations) => ({
    uid,
    key: [`name ${uid}`],
    comment: '',
    content,
    displayIndex: uid,
    ...(relations ? { extensions: { relations } } : {}),
});

const write = async (name, entries) => {
    await lib.books.write(name, { relationKinds: KINDS, entries: Object.fromEntries(entries.map(e => [e.uid, e])) });
    const { id: book } = await lib.books.find(name);
    const ids = new Map((await lib.books.storedEntries(book)).map(({ entity }) => [Number(entity.key.split(':')[1]), String(entity.id)]));
    return { book, id: (/** @type {number} */ uid) => /** @type {string} */ (ids.get(uid)) };
};

const entriesOf = async name => (await lib.books.read(name)).entries;

const targetsOf = (stored, uid) => (stored[uid]?.extensions?.relations ?? []).map(relation => `${relation.kind}:${relation.target}`).sort();

test('a set over a filter with words runs a chunk in its own request and the rest as a job, skipping the exceptions and what doesn\'t match', async () => {
    const count = RELATION_CHANGES_PER_STEP + 5;
    const lamps = Array.from({ length: count }, (_, i) => entry(i, `the lamp keeper ${i}`));
    const others = [0, 1, 2].map(i => entry(count + i, `a quiet harbour ${i}`));
    const { book, id } = await write('Lamps', [...lamps, ...others]);
    const selection = { selected: { query: 'lamp', chips: [] }, except: [id(3), id(count - 1)] };

    assert.deepEqual(await lib.books.selectionCount(book, selection, 1000), { matching: 1000, capped: true });
    assert.deepEqual(await lib.books.selectionCount(book, { ...selection, selected: { query: 'harbour', chips: [] } }, 1000), { matching: 3, capped: false });

    assert.deepEqual(await lib.books.startBulk(book, selection, { set: { order: 7, group: 'kept' } }, LOOPS, { user: 'u', session: 's' }), { unreachedLoops: [] });
    const running = await lib.books.bulkJobs(book);
    assert.deepEqual(running, [{ job: 1, action: { set: { order: 7, group: 'kept' } }, done: RELATION_CHANGES_PER_STEP - 1 }], 'the first chunk is done in the request, less its one exception');
    await lib.books.jobs.settled();
    assert.deepEqual(await lib.books.bulkJobs(book), []);

    const stored = await entriesOf('Lamps');
    assert.equal(stored[0].order, 7);
    assert.equal(stored[0].group, 'kept');
    assert.equal(stored[count - 2].order, 7, 'the job reached the last chunk');
    assert.equal(stored[3].order, undefined, 'an exception is left as it was');
    assert.equal(stored[count - 1].order, undefined);
    assert.equal(stored[count].order, undefined, 'an entry the filter doesn\'t match is left as it was');
    assert.equal(Object.keys(await lib.books.read('Lamps')).some(field => field.includes('bulkJob')), false, 'no job is part of the world file');
});

test('a delete over the whole world takes all but its exceptions; one over picked entries stops a chunk where their relations would pass a step', async () => {
    const small = await write('Small', [1, 2, 3, 4, 5].map(uid => entry(uid, `entry ${uid}`)));
    const whole = { selected: { world: true }, except: [small.id(2), small.id(4)] };
    assert.deepEqual(await lib.books.selectionCount(small.book, whole, 1000), { matching: 3, capped: false });
    assert.deepEqual(await lib.books.startBulk(small.book, whole, { delete: true }, LOOPS), { unreachedLoops: [] });
    assert.deepEqual(await lib.books.bulkJobs(small.book), [], 'a selection that fits one chunk leaves no job behind');
    assert.deepEqual(Object.keys(await entriesOf('Small')).sort(), ['2', '4']);

    const heavy = Math.floor(RELATION_CHANGES_PER_STEP * 0.6);
    const sources = Array.from({ length: 2 * heavy }, (_, i) => entry(10 + i, `source ${i}`, [{ kind: IN, target: i < heavy ? 1 : 2, position: 'a' }]));
    const hubs = await write('Hubs', [entry(1, 'hub one'), entry(2, 'hub two'), entry(3, 'plain'), ...sources]);
    const picked = { selected: { entries: [hubs.id(1), hubs.id(2), hubs.id(3)] }, except: [] };
    assert.deepEqual(await lib.books.startBulk(hubs.book, picked, { delete: true }, LOOPS), { unreachedLoops: [] });
    assert.deepEqual((await lib.books.bulkJobs(hubs.book)).map(job => job.done), [1], 'the second hub\'s relations would pass one step with the first\'s');
    await lib.books.jobs.settled();
    const left = await entriesOf('Hubs');
    assert.equal([1, 2, 3].some(uid => uid in left), false);
    assert.deepEqual(targetsOf(left, 10), [], 'a source of a deleted hub keeps no relation to it');
});

test('Move to replaces the relations of its kind, Also put in adds one; the target itself is skipped and loops are reported', async () => {
    const { book, id } = await write('Places', [
        entry(1, 'A'),
        entry(2, 'B'),
        entry(3, 'C'),
        entry(4, 'D'),
        entry(5, 'X', [{ kind: IN, target: 1, position: 'a' }]),
        entry(6, 'Y', [{ kind: IN, target: 1, position: 'b' }, { kind: IN, target: 2, position: 'a', weak: true }]),
        entry(7, 'Z', [{ kind: IN, target: 3, position: 'a' }]),
    ]);
    const inA = { selected: { query: '', chips: [{ kind: String(IN), target: id(1), depth: 'directly' }] }, except: [] };
    assert.deepEqual(await lib.books.selectionCount(book, inA, 1000), { matching: 2, capped: false });
    assert.deepEqual(await lib.books.startBulk(book, inA, { moveTo: { kind: String(IN), target: id(3) } }, LOOPS), { unreachedLoops: [] });
    let stored = await entriesOf('Places');
    assert.deepEqual(targetsOf(stored, 5), ['1:3']);
    assert.deepEqual(targetsOf(stored, 6), ['1:3'], 'its first relation of the kind goes to the target, the rest go');
    assert.equal(stored[6].extensions.relations[0].weak, undefined);

    const picked = { selected: { entries: [id(7), id(4), id(3)] }, except: [] };
    assert.deepEqual(await lib.books.startBulk(book, picked, { alsoPutIn: { kind: String(IN), target: id(4) } }, LOOPS), { unreachedLoops: [] });
    stored = await entriesOf('Places');
    assert.deepEqual(targetsOf(stored, 7), ['1:3', '1:4']);
    assert.deepEqual(targetsOf(stored, 3), ['1:4']);
    assert.deepEqual(targetsOf(stored, 4), [], 'the target is never put in itself');

    const loop = await lib.books.startBulk(book, { selected: { entries: [id(4)] }, except: [] }, { moveTo: { kind: String(IN), target: id(3) } }, LOOPS);
    assert.ok('unreachedLoops' in loop && loop.unreachedLoops.some(found => found.entries.includes(id(3)) && found.entries.includes(id(4))), 'C in D and D in C hold each other and nothing else');

    assert.deepEqual(await lib.books.startBulk(book, picked, { moveTo: { kind: String(IN), target: '999999' } }, LOOPS), { refused: 'The target isn\'t an entry of this world.' });
    assert.deepEqual(await lib.books.startBulk(book, picked, { alsoPutIn: { kind: '9', target: id(1) } }, LOOPS), { refused: 'This world has no such relation kind.' });
});

test('a job\'s steps report the loops they leave, and a job found when the store opens carries on from its cursor', async () => {
    const count = RELATION_CHANGES_PER_STEP + 3;
    const { book, id } = await write('Ring', [
        entry(1, 'the ring', [{ kind: IN, target: 2, position: 'a' }]),
        ...Array.from({ length: count }, (_, i) => entry(10 + i, `bead ${i}`)),
        entry(2, 'the clasp'),
    ]);
    const first = await lib.books.startBulk(book, { selected: { world: true }, except: [id(1)] }, { moveTo: { kind: String(IN), target: id(1) } }, LOOPS);
    assert.ok('unreachedLoops' in first);
    await lib.books.jobs.settled();
    const stored = await entriesOf('Ring');
    assert.deepEqual(targetsOf(stored, 10 + count - 1), ['1:1']);
    const loops = [...first.unreachedLoops, ...lib.books.jobs.loopsLeft(book)];
    assert.ok(loops.some(found => found.entries.includes(id(2)) && found.entries.includes(id(1))), 'the clasp, moved into the ring that is in it, is held only by the loop');

    const resumed = await write('Resumed', [1, 2, 3].map(uid => entry(uid, `bead ${uid}`)));
    const state = { action: { set: { order: 3 } }, selected: { world: true }, except: [resumed.id(2)], actor: null };
    await lib.store.commit([
        { kind: 'textValue', entity: resumed.book, field: '\u0001bulkJob:4', text: JSON.stringify(state) },
        { kind: 'textValue', entity: resumed.book, field: '\u0001bulkJobCursor:4', text: JSON.stringify({ cursor: null, done: 0 }) },
    ]);
    assert.deepEqual(await lib.books.bulkJobs(resumed.book), [{ job: 4, action: { set: { order: 3 } }, done: 0 }]);
    const read = await lib.books.read('Resumed');
    await lib.books.write('Resumed', read);
    assert.equal((await lib.books.bulkJobs(resumed.book)).length, 1, 'a whole-world save keeps a running job');
    await lib.books.jobs.resume();
    await lib.books.jobs.settled();
    const after = await entriesOf('Resumed');
    assert.deepEqual([after[1].order, after[2].order, after[3].order], [3, undefined, 3]);
    assert.deepEqual(await lib.books.bulkJobs(resumed.book), []);
});

after(async () => {
    await user.close();
    setImmediate(() => process.exit(0));
});
