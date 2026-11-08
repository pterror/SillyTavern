import assert from 'node:assert/strict';
import { after, test } from 'node:test';

const { emptyUser } = await import('../../tests/converted-user.fixture.js');
const user = await emptyUser('st-overview-test-');
const lib = user.store.lib;

const entry = (uid, displayIndex, relations) => ({
    uid,
    key: [`name ${uid}`],
    comment: `entry ${uid}`,
    content: `about ${uid}`,
    displayIndex,
    ...(relations ? { extensions: { relations } } : {}),
});

/**
 * @param {{ key: string, children?: any[], kind: string, repeat?: boolean }} item
 * @param {string[]} out
 */
function outline(item, out) {
    out.push(item.kind === 'more' ? `${item.key}=${item.more}` : item.repeat ? `${item.key}!` : item.key);
    for (const c of item.children ?? []) outline(c, out);
}

test('an entry\'s extensions.relations groups it under its target, read back as the overview, and round-trips', async () => {
    const entries = [
        entry(1, 0),
        entry(2, 1, [{ relation: 'in', target: 1, position: 'b' }]),
        entry(3, 2, [{ relation: 'in', target: 1, position: 'a' }, { relation: 'owes', target: 2, position: 'a' }]),
        entry(4, 3),
    ];
    await lib.books.write('World', { entries: Object.fromEntries(entries.map(e => [e.uid, e])) });
    const found = await lib.books.find('World');
    assert.ok(found?.defined);
    const ids = new Map((await lib.books.storedEntries(found.id)).map(({ entity }) => [Number(entity.key.split(':')[1]), String(entity.id)]));
    const view = await lib.store.worldRead('overview', { book: found.id, relation: 'in', from: 0, to: 10, active: null });
    assert.equal(view.count, 2);
    const keys = [];
    for (const item of view.items) outline(item, keys);
    const [a, b, c, d] = [1, 2, 3, 4].map(uid => ids.get(uid));
    assert.deepEqual(keys, [a, `${a}/${c}`, `${a}/${b}`, d]);
    assert.deepEqual(view.items[0].children[0].relations.map(r => [r.relation, r.target, r.entry, r.title]), [
        ['in', '1', a, 'entry 1'],
        ['owes', '2', b, 'entry 2'],
    ]);
    assert.deepEqual(view.items[0].keys, ['name 1']);

    const moved = await lib.store.worldRead('overviewMove', { book: found.id, relation: 'in', from: `${a}/${b}`, by: 1 });
    assert.deepEqual(moved, { key: d, rank: 1 });

    const back = await lib.books.read('World');
    assert.deepEqual(back.entries[3].extensions.relations, entries[2].extensions.relations);

    const changed = entries.map(e => (e.uid === 2 ? { ...e, extensions: { relations: [] } } : e));
    await lib.books.write('World', { entries: Object.fromEntries(changed.map(e => [e.uid, e])) });
    const after = await lib.store.worldRead('overview', { book: found.id, relation: 'in', from: 0, to: 10, active: null });
    assert.deepEqual(after.items.map(i => i.key), [a, b, d]);
    assert.equal(after.items[0].members, 1);
});

after(async () => {
    await user.close();
    setImmediate(() => process.exit(0));
});
