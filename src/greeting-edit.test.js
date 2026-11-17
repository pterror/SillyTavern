import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setConfigFilePath } from './util.js';
import { hashGreetingText } from './greeting-ops.js';
import { HASH, TYPE } from './library-codes.js';
import { calculateDataSize } from './character-shallow.js';
import { openingGreetingEdit } from '../public/scripts/opening-greeting-edit.js';
import { openingView } from '../public/scripts/opening-view.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const { openingState, greetingOpeningEdit } = await import('./opening-state.js');
const actor = { user: 'u', session: '0190a1b2-0000-7000-8000-0000000000b1' };
const card = (first = 'Hello', alternatives = []) => JSON.stringify({ name: 'Cara', spec: 'chara_card_v2', spec_version: '2.0', data: {
    name: 'Cara', description: '', personality: '', scenario: '', first_mes: first, mes_example: '', alternate_greetings: alternatives,
    creator_notes: '', system_prompt: '', post_history_instructions: '', tags: [], creator: '', character_version: '', extensions: {},
} });
const nodeId = alt => `greeting:${alt.greeting.avatar}:${alt.greeting.id}:${alt.greeting.hash}`;
/** @type {import('../public/scripts/opening-view.js').ShownFirst} */
const page = { first: undefined, count: 1, speaker: 'Cara', sendDate: '', greetingNodeId: nodeId, isStored: id => typeof id === 'string' && !id.startsWith('greeting:'), isProvisional: id => typeof id === 'string' && id.startsWith('greeting:') };

async function fixture() {
    const { emptyUser } = await import('../tests/converted-user.fixture.js');
    const user = await emptyUser('greeting-edit-');
    await user.store.lib.writeCard(user.directories, 'Cara.png', card('Hello', ['Other']));
    const [tree] = await user.store.people.trees([{ avatar: 'Cara.png' }]);
    return { ...user, tree };
}

test('one edit reads only its field, writes no whole card, preserves figures and rejects stale or duplicate edits', async () => {
    const user = await fixture();
    try {
        const { lib } = user.store;
        const model = await lib.greetingModel('Cara.png');
        const target = model.greetings[1];
        const originalIdentity = (await lib.entity(TYPE.character, 'Cara.png')).hashes.find(h => h.which === HASH.identity).hash.toString('hex');
        const assembled = lib.assembled;
        const writeCard = lib.writeCard;
        const entity = lib.entity;
        const greetingModel = lib.greetingModel;
        lib.greetingModel = () => { throw Error('whole greeting list on edit'); };
        lib.assembled = lib.writeCard = lib.entity = () => { throw Error('whole card on edit'); };
        const result = await lib.editGreeting('Cara.png', target.id, hashGreetingText('Other'), 'Changed 🐈');
        assert.equal(result.ok, true);
        assert.notEqual(result.baseRevision, result.revision);
        assert.equal('greetings' in result, false);
        const retry = await lib.editGreeting('Cara.png', target.id, hashGreetingText('Other'), 'Changed 🐈');
        assert.equal(retry.ok, true);
        assert.equal(retry.changed, false);
        assert.equal((await lib.editGreeting('Cara.png', target.id, hashGreetingText('Other'), 'No')).status, 409);
        assert.equal((await lib.editGreeting('Cara.png', target.id, hashGreetingText('Changed 🐈'), 'Hello')).sameId, model.defaultId);
        lib.assembled = assembled; lib.writeCard = writeCard; lib.entity = entity; lib.greetingModel = greetingModel;
        const e = await lib.entity(TYPE.character, 'Cara.png');
        const saved = await lib.assembled(e);
        assert.equal(saved.data.alternate_greetings[0], 'Changed 🐈');
        assert.equal(e.dataSize, calculateDataSize(saved.data));
        assert.equal(e.hashes.some(h => h.which === HASH.identity), false);
        assert.deepEqual(await lib.store.chatRead('dirtyCardIdentities', {}), [user.tree]);
        const { computeContentIdentityHash } = await import('./card-identity-hash.js');
        assert.equal(await lib.findByHash(HASH.identity, originalIdentity), null);
        assert.equal(await lib.findByHash(HASH.identity, computeContentIdentityHash(saved)), 'Cara.png');
        assert.deepEqual(await lib.store.chatRead('dirtyCardIdentities', {}), []);
    } finally { await user.close(); }
});

test('opening text index tracks edits, reparenting, speaker changes, deletion, and survives reopen', async () => {
    const user = await fixture();
    try {
        const { chats, lib } = user.store;
        const speaker = (await user.store.people.speakers([user.tree])).get(user.tree);
        const sent = await chats.appendMessages({ tree: user.tree, treeSpeaker: speaker, after: null, actor, contents: [
            { name: 'Cara', mes: 'Hello', is_user: false, extra: {} },
            { name: 'Cara', mes: 'Hello', is_user: false, extra: {} },
        ] });
        const [root, reply] = await chats.messageIds(sent.node_ids);
        let activeStore = user.store;
        const matching = text => activeStore.lib.store.chatRead('openingsMatchingText', { card: user.tree, text });
        assert.deepEqual((await matching('Hello')).map(r => r.id), [root]);
        await chats.editMessages({ tree: user.tree, treeSpeaker: speaker, actor, edits: [{ node_id: sent.node_ids[0], patch: { mes: 'New' }, finished: true }] });
        assert.equal((await matching('Hello')).length, 0);
        assert.deepEqual((await matching('New')).map(r => r.id), [root]);
        await lib.store.commit([{ kind: 'messageParent', message: reply }]);
        assert.deepEqual((await matching('Hello')).map(r => r.id), [reply]);
        await lib.store.commit([{ kind: 'messageParent', message: reply, parent: root }]);
        assert.equal((await matching('Hello')).length, 0);
        await lib.store.commit([{ kind: 'jsonValue', message: root, field: 18, json: '999' }]);
        assert.equal((await matching('New')).length, 0);
        await lib.store.commit([{ kind: 'valueDelete', message: root, field: 18 }]);
        assert.equal((await matching('New')).length, 1);
        const stores = await import('./user-stores.js');
        await stores.closeUserStores();
        activeStore = await stores.userStore(user.directories, 'u');
        assert.deepEqual((await matching('New')).map(row => row.id), [root]);
        await activeStore.lib.store.commit([{ kind: 'messageDelete', message: reply, time: Date.now() }, { kind: 'messageDelete', message: root, time: Date.now() }]);
        assert.equal((await matching('New')).length, 0);
    } finally { await user.close(); }
});

test('1000 greetings: an edit with name macros stays compact without conversation or whole-card reads', async () => {
    const user = await fixture();
    try {
        const { lib } = user.store;
        await lib.writeCard(user.directories, 'Cara.png', card('Hello', Array.from({ length: 999 }, (_, i) => `Greeting ${i}`)));
        const target = (await lib.greetingModel('Cara.png')).greetings.find(g => g.text === 'Greeting 499');
        const { changeGreetings } = await import('./endpoints/characters.js');
        const read = lib.store.chatRead.bind(lib.store);
        const reads = [];
        lib.store.chatRead = (op, args) => { reads.push(op); assert.notEqual(op, 'conversations'); return read(op, args); };
        let wholeReads = 0;
        lib.greetingModel = lib.assembled = lib.writeCard = () => { wholeReads++; throw Error('whole greeting/card read'); };
        const start = performance.now();
        const { result } = await changeGreetings({ directories: user.directories, store: user.store, actor, avatar: 'Cara.png', change: {
            op: 'edit', id: target.id, hash: hashGreetingText('Greeting 499'), text: 'Changed {{char}} and {{user}}',
        } });
        assert.equal(result.ok, true);
        assert.equal(wholeReads, 0);
        assert.equal(JSON.stringify(result, (_, v) => typeof v === 'bigint' ? String(v) : v).length < 500, true);
        assert.deepEqual(reads.filter(op => op === 'greetingsMatchingText' || op === 'openingsMatchingText'), ['greetingsMatchingText', 'openingsMatchingText']);
        process.stderr.write(`1000-greeting edit: ${(performance.now() - start).toFixed(2)} ms\n`);
    } finally { await user.close(); }
});

test('compact opening deltas equal a fresh opening projection across detach, match, and repeated edits', async () => {
    const user = await fixture();
    try {
        const { lib, chats } = user.store;
        const speaker = (await user.store.people.speakers([user.tree])).get(user.tree);
        const sent = await chats.appendMessages({ tree: user.tree, treeSpeaker: speaker, after: null, actor, contents: [
            { name: 'Cara', mes: 'Hello', is_user: false, extra: {} }, { name: 'You', mes: 'Reply', is_user: true, extra: {} },
        ] });
        /** @type {any} */
        let state = await openingState({ store: user.store, tree: user.tree, actor });
        let view = openingView(state, page);
        assert.equal(view.kind, 'show');
        let first = view.message;
        for (const text of ['Changed', 'Hello', 'Another', 'Hello']) {
            const before = await lib.greetingModel('Cara.png');
            const result = await lib.editGreeting('Cara.png', before.defaultId, hashGreetingText(before.greetings.find(g => g.id === before.defaultId).text), text);
            const moves = await chats.linkGreetingMatches(user.tree, { id: before.defaultId, text }, { user: 'u' });
            const edit = await greetingOpeningEdit(user.store, user.tree, user.tree, 'Cara.png', result.edit, moves);
            const delta = openingGreetingEdit(state.opening_layout, first, edit, { name: 'Cara', nodeId });
            assert.ok(delta);
            const fresh = await openingState({ store: user.store, tree: user.tree, actor });
            assert.deepEqual(delta.opening_layout, fresh.opening_layout);
            const actual = openingView(delta, { ...page, first, count: 2 });
            const expected = openingView(fresh, { ...page, first, count: 2 });
            assert.deepEqual(actual, expected);
            if (actual.kind === 'update') first = { ...first, ...actual.updates };
            state = delta;
        }
        const loaded = await chats.load({ tree: user.tree, at: sent.node_ids[1] });
        assert.deepEqual(loaded.messages.map(m => m.mes), ['Hello', 'Reply']);
    } finally { await user.close(); }
});

test('an existing greeting origin becomes current again without rewriting the opening', async () => {
    const user = await fixture();
    try {
        const { chats, lib, people } = user.store;
        const speaker = (await people.speakers([user.tree])).get(user.tree);
        const sent = await chats.appendMessages({ tree: user.tree, treeSpeaker: speaker, after: null, actor, contents: [
            { name: 'Cara', mes: 'Hello', is_user: false, extra: {} }, { name: 'You', mes: 'Reply', is_user: true, extra: {} },
        ] });
        await chats.editMessages({ tree: user.tree, treeSpeaker: speaker, actor, edits: [{ node_id: sent.node_ids[0], patch: { mes: 'Wanted' }, finished: true }] });
        const writes = [];
        const collect = records => writes.push(...records);
        user.store.events.on('commit', collect);
        const { changeGreetings } = await import('./endpoints/characters.js');
        const result = await changeGreetings({ directories: user.directories, store: user.store, actor, avatar: 'Cara.png', change: { op: 'edit', id: 0, hash: hashGreetingText('Hello'), text: 'Wanted' } });
        user.store.events.off('commit', collect);
        assert.equal(result.result.ok, true);
        assert.equal(writes.some(record => record.message !== undefined), false);
        assert.equal((await chats.openingAlternatives({ tree: user.tree, actor })).total, 2);
        assert.equal((await lib.readGreeting('Cara.png', 0)).text, 'Wanted');
    } finally { await user.close(); }
});

test('group deltas move only roots spoken by the edited character and preserve the other member', async () => {
    const user = await fixture();
    try {
        const { lib, chats, people } = user.store;
        await lib.writeCard(user.directories, 'Other.png', card('Different'));
        await lib.writeGroup({ id: 'band', name: 'Band', members: ['Cara.png', 'Other.png'] });
        const [tree] = await people.trees([{ group: 'band' }]);
        const roots = [];
        for (const avatar of ['Cara.png', 'Other.png']) {
            const sent = await chats.appendMessages({ tree, treeSpeaker: null, after: null, actor, contents: [
                { name: 'Cara', original_avatar: avatar, mes: 'Wanted', is_user: false, extra: {} },
                { name: 'You', mes: `Reply to ${avatar}`, is_user: true, extra: {} },
            ] });
            roots.push(sent.node_ids);
        }
        const before = await openingState({ store: user.store, tree, actor });
        const shown = openingView(before, page);
        assert.equal(shown.kind, 'show');
        const edit = await lib.editGreeting('Cara.png', 0, hashGreetingText('Hello'), 'Wanted');
        const moves = await chats.linkGreetingMatches(user.tree, { id: 0, text: 'Wanted' }, { user: 'u' });
        assert.equal(moves.length, 1);
        assert.equal(moves[0].node, roots[0][0]);
        const update = await greetingOpeningEdit(user.store, tree, user.tree, 'Cara.png', edit.edit, moves);
        assert.deepEqual(update.owner, { group_id: 'band' });
        const delta = openingGreetingEdit(before.opening_layout, shown.message, update, { name: '', nodeId });
        assert.ok(delta);
        const fresh = await openingState({ store: user.store, tree, actor });
        assert.deepEqual(delta.opening_layout, fresh.opening_layout);
        assert.deepEqual(openingView(delta, { ...page, first: shown.message, count: 2 }), openingView(fresh, { ...page, first: shown.message, count: 2 }));
        const other = await chats.load({ tree, at: roots[1][1] });
        assert.deepEqual(other.messages.map(message => message.mes), ['Wanted', 'Reply to Other.png']);
        assert.equal(other.messages[0].extra.greeting_id, undefined);
    } finally { await user.close(); }
});
