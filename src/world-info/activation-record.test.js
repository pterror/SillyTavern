import assert from 'node:assert/strict';
import { activateWorldInfoEntries } from './activation.js';
import { buildActivationRecord, mergeRecords, withSentMessage } from './activation-record.js';
import { findKeySpans } from './key-matching.js';
import { EMBEDDED_WORLD_NAME } from './candidate-resolution.js';

const countTokens = async (text) => Math.ceil(text.length / 4);
/** @param {import('./activation-record.js').EntryRef} ref */
const entryOf = ref => ('entry' in ref ? ref.entry : null);
const books = {
    async entryRefs(entries) {
        return entries.map(({ world, uid }) => (world === 'gone' ? null : { book: 7n, entry: BigInt(100 + Number(uid)) }));
    },
};

{
    assert.deepEqual(findKeySpans('The Dragon and the dragonfly', 'dragon', {}), [[4, 10], [19, 25]]);
    assert.deepEqual(findKeySpans('The Dragon and the dragonfly', 'dragon', { matchWholeWords: true }), [[4, 10]]);
    assert.deepEqual(findKeySpans('The Dragon', 'dragon', { caseSensitive: true }), []);
    assert.deepEqual(findKeySpans('dragon dragon', 'dragon', { matchWholeWords: true }), [[0, 6], [7, 13]]);
    assert.deepEqual(findKeySpans('a red dragon, a blue drake', '/dra(gon|ke)/i', {}), [[6, 12], [21, 26]]);
    assert.deepEqual(findKeySpans('x', '', {}), []);
}

{
    const entries = [
        { uid: '1', world: 'w', key: ['dragon'], content: 'The dragon guards a cave.', position: 4, depth: 2, role: 0 },
        { uid: '2', world: 'w', key: ['cave'], content: 'The cave is dark.' },
        { uid: '3', world: 'w', key: [], constant: true, content: 'Always.' },
    ];
    const messages = ['I see a dragon', 'hello there'];
    const { trace } = await activateWorldInfoEntries(entries, messages, {
        maxContext: 4000, budgetPercent: 100, depth: 2, recursive: true, countTokens,
    });
    const record = await buildActivationRecord(trace, {
        messages: [{ nodeId: null, text: 'I see a dragon' }, { nodeId: 'n1', text: 'hello there' }],
        injects: [],
        books,
    });
    assert.ok(record);
    const byUid = Object.fromEntries(record.entries.map(e => [entryOf(e.ref), e]));
    const dragon = byUid['101'];
    assert.equal(dragon.why, 'key');
    assert.deepEqual(dragon.ref, { book: '7', entry: '101' });
    assert.deepEqual(dragon.keys, [{ key: 'dragon', in: [{ sent: true, spans: [[8, 14]] }] }]);
    assert.deepEqual([dragon.position, dragon.depth, dragon.role], [4, 2, 0]);
    const cave = byUid['102'];
    assert.equal(cave.why, 'key');
    assert.deepEqual(cave.keys, [{ key: 'cave', in: [] }], 'a key matched only in another entry is not placed in a message');
    assert.deepEqual(cave.via, [record.entries.indexOf(dragon)], 'the entry whose text brought it in');
    assert.equal(byUid['103'].why, 'always');
    assert.deepEqual(record.cut, []);

    const sent = withSentMessage(record, 'n2');
    assert.deepEqual(sent.entries.find(e => e === sent.entries[record.entries.indexOf(dragon)]).keys[0].in, [{ node: 'n2', spans: [[8, 14]] }]);
}

{
    const entries = [
        { uid: '3', world: 'w', key: ['dragon'], content: 'z', useProbability: true, probability: 0 },
        { uid: '1', world: 'w', key: ['dragon'], content: 'x'.repeat(400), order: 2 },
        { uid: '2', world: 'w', key: ['dragon'], content: 'y'.repeat(400), order: 1 },
    ];
    const { activatedEntries, trace } = await activateWorldInfoEntries(entries, ['a dragon'], {
        maxContext: 1000, budgetPercent: 15, depth: 1, recursive: false, countTokens, random: () => 0.99,
    });
    const record = await buildActivationRecord(trace, { messages: [{ nodeId: 'n', text: 'a dragon' }], injects: [], books });
    assert.ok(record);
    const activated = new Set(activatedEntries.map(e => e.uid));
    assert.deepEqual(record.entries.map(e => entryOf(e.ref)).sort(), [...activated].map(u => String(100 + Number(u))).sort());
    const cut = Object.fromEntries(record.cut.map(c => [entryOf(c.ref), c.why]));
    assert.equal(cut['103'], 'chance');
    assert.ok(Object.values(cut).includes('budget'), 'an entry past the budget is recorded as cut');
}

{
    const entries = [
        { uid: '1', world: 'w', key: ['tavern'], content: 'A', group: 'g' },
        { uid: '2', world: 'w', key: ['tavern'], content: 'B', group: 'g' },
    ];
    const { activatedEntries, trace } = await activateWorldInfoEntries(entries, ['the tavern'], {
        maxContext: 4000, budgetPercent: 100, depth: 1, countTokens, random: () => 0,
    });
    assert.equal(activatedEntries.length, 1);
    const record = await buildActivationRecord(trace, { messages: [{ nodeId: 'n', text: 'the tavern' }], injects: [], books });
    assert.equal(record?.cut.length, 1);
    assert.equal(record?.cut[0].why, 'group');
}

{
    const entries = [
        { uid: '4', world: EMBEDDED_WORLD_NAME, key: ['inn'], content: 'An inn.' },
        { uid: '5', world: 'gone', key: ['inn'], content: 'Gone.' },
    ];
    const { trace } = await activateWorldInfoEntries(entries, ['the inn'], {
        maxContext: 4000, budgetPercent: 100, depth: 1, countTokens,
        globalScanData: {}, additionalScanInjects: ['an inn note'],
    });
    const record = await buildActivationRecord(trace, { messages: [{ nodeId: 'n', text: 'the inn' }], injects: ['note'], books });
    assert.deepEqual(record?.entries.map(e => e.ref), [{ card: '4' }], 'a card book entry is named by its uid; an entry with no stored id is left out');
    assert.deepEqual(record?.entries[0].keys[0].in, [{ node: 'n', spans: [[4, 7]] }, { inject: 'note' }]);
}

{
    const { trace } = await activateWorldInfoEntries([{ uid: '1', world: 'w', key: ['nope'], content: 'x' }], ['hello'], {
        maxContext: 4000, budgetPercent: 100, depth: 1, countTokens,
    });
    assert.equal(await buildActivationRecord(trace, { messages: [], injects: [], books }), null, 'nothing came up: no record');
}

{
    const before = {
        entries: [
            { ref: { book: '1', entry: '1' }, why: 'key', step: 1, keys: [], via: [], position: null, depth: null, role: null },
            { ref: { book: '1', entry: '2' }, why: 'key', step: 2, keys: [], via: [0], position: null, depth: null, role: null },
        ],
        cut: [{ ref: { book: '1', entry: '3' }, why: 'budget' }],
    };
    const after = {
        entries: [{ ref: { book: '1', entry: '1' }, why: 'always', step: 1, keys: [], via: [], position: null, depth: null, role: null }],
        cut: [],
    };
    const merged = mergeRecords(/** @type {any} */ (before), /** @type {any} */ (after));
    assert.deepEqual(merged.entries.map(e => e.ref.entry), ['1', '2']);
    assert.equal(merged.entries[0].why, 'always', 'the continuation\'s reason wins');
    assert.deepEqual(merged.entries[1].via, [0], 'a reference to an entry the continuation replaced points at its replacement');
    assert.deepEqual(merged.cut.map(c => c.ref.entry), ['3']);
}
