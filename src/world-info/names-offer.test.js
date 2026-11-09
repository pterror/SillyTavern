import assert from 'node:assert/strict';
import { after, test } from 'node:test';

const { emptyUser } = await import('../../tests/converted-user.fixture.js');
const { RELATION_CHANGES_PER_STEP } = await import('../world-info-engine.js');
const user = await emptyUser('st-names-offer-test-');
const lib = user.store.lib;

const imported = (count, extra = {}) => Object.fromEntries(Array.from({ length: count }, (_, i) => [i, {
    uid: i,
    key: [`Person ${i}`, `person-${i}`],
    comment: `Person ${i}`,
    content: `About person ${i}.`,
    displayIndex: i,
    ...extra,
}]));

const namesOf = async (name, uid) => (await lib.books.read(name)).entries[uid].extensions?.names;

test('an imported book offers its title keys as names, counted on write; marking them takes chunks, the first in its own request', async () => {
    const count = 2 * RELATION_CHANGES_PER_STEP + 3;
    await lib.books.write('Imported', { entries: { ...imported(count), [count]: { uid: count, key: ['lamp'], comment: 'A lamp', content: '' } } });
    const { id: book } = await lib.books.find('Imported');
    const offer = await lib.books.namesOffer(book);
    assert.deepEqual({ ...offer, example: offer.example?.text }, { state: null, namedEntries: 0, offeredEntries: count, marks: 0, example: 'Person 0' });

    assert.equal(await lib.books.undoMarkTitleKeysAsNames(book).then(done => typeof done === 'object' && done.refused), 'Nothing was marked to take back.');
    assert.equal(await lib.books.markTitleKeysAsNames(book), 'ok');
    const right = await lib.books.namesOffer(book);
    assert.equal(right.state, 'marking', 'the answer comes before the rest of the job');
    assert.equal(right.marks, RELATION_CHANGES_PER_STEP, 'the action marks the first chunk in its own request');
    assert.equal(await lib.books.markTitleKeysAsNames(book).then(done => typeof done === 'object' && done.refused), 'This world offers no names to mark.');
    await lib.books.jobs.settled();
    const done = await lib.books.namesOffer(book);
    assert.deepEqual({ ...done, example: done.example }, { state: 'done', namedEntries: count, offeredEntries: 0, marks: count, example: null });
    assert.deepEqual(await namesOf('Imported', 5), ['Person 5']);
    assert.equal(await namesOf('Imported', count), undefined, 'an entry with no key of its title is left as it was');

    const read = await lib.books.read('Imported');
    assert.equal(Object.keys(read).some(field => field.includes('namesOffer')), false, 'the offer is no part of the world file');
    await lib.books.write('Imported', { ...read, name: 'Imported again' });
    assert.equal((await lib.books.namesOffer(book)).state, 'done', 'a whole-world save keeps the offer as it was');
});

test('Undo takes back each mark the author has not changed since, in chunks, and the offer comes back', async () => {
    const count = RELATION_CHANGES_PER_STEP + 2;
    await lib.books.write('Undone', { entries: imported(count) });
    const { id: book } = await lib.books.find('Undone');
    assert.equal(await lib.books.markTitleKeysAsNames(book), 'ok');
    await lib.books.jobs.settled();
    const entry = (await lib.books.read('Undone')).entries[1];
    await lib.books.editEntry('Undone', 1, { ...entry, extensions: { ...entry.extensions, names: ['Person 1', 'person-1'] } });
    assert.equal(await lib.books.undoMarkTitleKeysAsNames(book), 'ok');
    await lib.books.jobs.settled();
    assert.deepEqual(await namesOf('Undone', 1), ['Person 1', 'person-1'], 'the author\'s own names stay');
    assert.deepEqual(await namesOf('Undone', 0), []);
    assert.deepEqual(await namesOf('Undone', count - 1), []);
    const back = await lib.books.namesOffer(book);
    assert.deepEqual([back.state, back.namedEntries, back.offeredEntries, back.marks], [null, 1, count - 1, 0]);
});

test('a job whose marker is set when the store opens carries on, and leaving the offer is kept', async () => {
    await lib.books.write('Resumed', { entries: imported(3) });
    const { id: book } = await lib.books.find('Resumed');
    await lib.store.commit([{ kind: 'textValue', entity: book, field: '\u0001namesOffer', text: 'marking' }]);
    await lib.books.jobs.resume();
    await lib.books.jobs.settled();
    const resumed = await lib.books.namesOffer(book);
    assert.deepEqual([resumed.state, resumed.namedEntries, resumed.marks], ['done', 3, 3]);

    await lib.books.write('Left', { entries: imported(2) });
    const { id: left } = await lib.books.find('Left');
    assert.equal(await lib.books.declineNamesOffer(left), 'ok');
    assert.equal((await lib.books.namesOffer(left)).state, 'declined');
    assert.equal(await lib.books.markTitleKeysAsNames(left).then(done => typeof done === 'object' && done.refused), 'This world offers no names to mark.');
});

after(async () => {
    await user.close();
    setImmediate(() => process.exit(0));
});
