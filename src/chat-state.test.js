// State layer 1 on the engine (build path 5b): `chat_metadata` merged per key and per variable, and the state
// changes made while producing a reply recorded with it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { loadEngine } from '../engine/load.js';

const { ChatEngine } = await import('./chat-engine.js');
const { baselineAfter, baselineOf, metadataChanges, replaceInPlace } = await import('../public/scripts/state-sync.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-state-test-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const cara = { id: 1n, name: 'Cara', avatar: 'cara.png' };
const people = {
    speakers: async ids => new Map(ids.filter(id => id === cara.id).map(id => [id, cara])),
    byAvatar: async avatars => new Map(avatars.filter(a => a === cara.avatar).map(a => [a, cara])),
};
const tabA = { user: 'ann', session: '0190a1b2-0000-7000-8000-0000000000a1' };
const tabB = { user: 'bea', session: '0190a1b2-0000-7000-8000-0000000000b2' };
const greeting = { name: 'Cara', is_user: false, is_system: false, send_date: '2025-10-10T10:00:00.000Z', mes: 'Hello!', extra: {} };

let n = 0;
async function open(engine) {
    const store = await engine.Store.open(path.join(root, `engine-${n++}`));
    const chats = await ChatEngine.open(store, people);
    let clock = 1_760_090_000_000;
    chats.now = () => (clock += 1000);
    const t = 5n;
    const { node_ids: [at] } = await chats.appendMessages({ tree: t, treeSpeaker: cara, after: null, contents: [greeting], actor: tabA });
    const state = async () => (await chats.stateAt({ tree: t, at })).state;
    return { chats, t, at, state };
}

for (const [kind, engine] of Object.entries({ native: loadEngine().binding, wasm: loadEngine({ platform: null }).binding })) {
    test(`${kind}: two tabs changing different variables keep both`, async () => {
        const { chats, t, at, state } = await open(engine);
        await chats.mergeMetadata({ tree: t, at, set: { variables: { hp: 3 } }, unset: [], actor: tabA });
        // Tab B last had no variables from the server, and sets its own.
        await chats.mergeMetadata({ tree: t, at, set: { variables: { mp: 1 } }, unset: [], actor: tabB });
        assert.deepEqual(await state(), { variables: { hp: 3, mp: 1 } });
        // Per variable: set and removed by name, the others left; nothing written when nothing differs.
        await chats.mergeMetadata({ tree: t, at, set: {}, unset: [], variables: { set: { gold: 5 }, unset: ['hp'] }, actor: tabB });
        assert.deepEqual(await state(), { variables: { mp: 1, gold: 5 } });
        const head = await chats.store.chatRead('nextIds', {});
        await chats.mergeMetadata({ tree: t, at, set: { variables: { mp: 1 } }, unset: [], variables: { set: { gold: 5 }, unset: ['nobody'] }, actor: tabA });
        assert.deepEqual(await chats.store.chatRead('nextIds', {}), head);
        // A variable set and removed in one merge is removed; the object stays.
        await chats.mergeMetadata({ tree: t, at, set: {}, unset: [], variables: { set: { mp: 2 }, unset: ['mp', 'gold'] }, actor: tabA });
        assert.deepEqual(await state(), { variables: {} });
        // Setting a variable makes the object; removing `variables` removes every one.
        await chats.mergeMetadata({ tree: t, at, set: { note: 'x' }, unset: ['variables'], actor: tabA });
        await chats.mergeMetadata({ tree: t, at, set: {}, unset: [], variables: { set: { hp: 1 } }, actor: tabA });
        assert.deepEqual(await state(), { note: 'x', variables: { hp: 1 } });
        await chats.mergeMetadata({ tree: t, at, set: {}, unset: ['variables'], actor: tabB });
        assert.deepEqual(await state(), { note: 'x' });
    });

    test(`${kind}: a whole chat's save removes the variables its metadata lacks, as upstream's does`, async () => {
        const { chats, t, at, state } = await open(engine);
        await chats.mergeMetadata({ tree: t, at, set: { variables: { hp: 3, mp: 1 } }, unset: [], actor: tabA });
        const loaded = await chats.load({ tree: t, at, session: tabA.session });
        const header = { user_name: 'unused', character_name: 'unused', chat_metadata: { ...loaded.metadata, variables: { hp: 4 } } };
        await chats.saveChat({ tree: t, treeSpeaker: cara, chat: [header, ...loaded.messages], actor: tabA });
        assert.deepEqual(await state(), { variables: { hp: 4 } });
    });

    test(`${kind}: a reply's state changes are part of it when it is generated again`, async () => {
        const { chats, t, at } = await open(engine);
        const reply = { name: 'Cara', is_user: false, mes: 'You find a coin.', extra: {} };
        const gain = [{ key: 'gold', variable: true, value: 1 }, { key: 'scene', value: 'road' }];
        const append = (changes, actor = tabA, sendKeys = []) => chats.appendMessages({ tree: t, treeSpeaker: cara, after: at, contents: [reply], changes: [changes], sendKeys, actor });
        const stateAt = async id => (await chats.stateAt({ tree: t, at: id })).state;
        await chats.changeState({ tree: t, at, ops: [{ key: 'scene', value: 'road' }], actor: tabA });

        const first = await append(gain, tabA, ['k1']);
        const [r1] = first.node_ids;
        // The scene was already the road: only the gold is the reply's change.
        assert.deepEqual(await stateAt(r1), { scene: 'road', variables: { gold: 1 } });
        assert.deepEqual(await stateAt(at), { scene: 'road' });

        // Generated again with the same text and changes: that reply, nothing recorded.
        await chats.changeState({ tree: t, at: r1, ops: [{ key: 'mood', value: 'glad' }], actor: tabA });
        const head = await chats.store.chatRead('nextIds', {});
        assert.deepEqual((await append(gain, tabB)).node_ids, [r1]);
        assert.equal((await chats.store.chatRead('nextIds', {})).change, head.change);
        assert.equal((await chats.store.chatRead('nextIds', {})).message, head.message);

        // The same text with other changes, or none, is an alternative of its own with its own state.
        const [r2] = (await append([{ key: 'gold', variable: true, value: 2 }])).node_ids;
        const [r3] = (await append([])).node_ids;
        assert.equal(new Set([r1, r2, r3]).size, 3);
        assert.deepEqual(await stateAt(r2), { scene: 'road', variables: { gold: 2 } });
        assert.deepEqual(await stateAt(r3), { scene: 'road' });
        assert.deepEqual((await append([])).node_ids, [r3]);
        assert.deepEqual((await append([{ key: 'gold', variable: true, value: 2 }])).node_ids, [r2]);

        // A metadata key named like a variable is a change of its own.
        const [r4] = (await append([{ key: 'gold', value: 1 }])).node_ids;
        assert.notEqual(r4, r1);

        // A re-sent message records nothing again; one sent after a stored one is filtered against its state.
        const head2 = await chats.store.chatRead('nextIds', {});
        const again = await append([{ key: 'gold', variable: true, value: 9 }], tabA, ['k1']);
        assert.deepEqual(again.already_stored, [r1]);
        assert.deepEqual(await chats.store.chatRead('nextIds', {}), head2);
        const user = { name: 'You', is_user: true, mes: 'I take it.', extra: {} };
        const chain = await chats.appendMessages({
            tree: t, treeSpeaker: cara, after: at, contents: [reply, user],
            changes: [gain, [{ key: 'gold', variable: true, value: 1 }, { key: 'took', variable: true, value: true }]], actor: tabA,
        });
        assert.equal(chain.node_ids[0], r1);
        // The gold was already 1 there (with the mood set on the reply since): only `took` is the message's change.
        assert.deepEqual(await stateAt(chain.node_ids[1]), { scene: 'road', variables: { gold: 1, took: true }, mood: 'glad' });
        assert.deepEqual(await chats.store.chatRead('produced', { messages: [(await chats.messageIds([chain.node_ids[1]]))[0]] }),
            [[{ key: 'took', variable: true, value: 'true' }]]);
    });

    test(`${kind}: a continue's state changes hang on the reply it continues, with the continue`, async () => {
        const { chats, t, at } = await open(engine);
        const reply = { name: 'Cara', is_user: false, mes: 'You find', extra: {} };
        const [r] = (await chats.appendMessages({ tree: t, treeSpeaker: cara, after: at, contents: [reply], changes: [[{ key: 'gold', variable: true, value: 1 }]], actor: tabA })).node_ids;
        const [id] = await chats.messageIds([r]);
        const continued = { ...reply, mes: 'You find a coin.' };
        const edited = await chats.editMessages({ tree: t, treeSpeaker: cara, edits: [{ node_id: r, content: continued, changes: [{ key: 'gold', variable: true, value: 2 }, { key: 'scene', value: 'road' }] }], actor: tabA });
        assert.deepEqual(edited, { ok: true, applied: 1, refused: [] });
        assert.deepEqual((await chats.stateAt({ tree: t, at: r })).state, { variables: { gold: 2 }, scene: 'road' });
        assert.deepEqual(await chats.store.chatRead('produced', { messages: [id] }),
            [[{ key: 'gold', variable: true, value: '1' }, { key: 'gold', variable: true, value: '2' }, { key: 'scene', variable: false, value: '"road"' }]]);
        // A refused edit records none of its changes.
        const head = await chats.store.chatRead('nextIds', {});
        const refused = await chats.editMessages({ tree: t, treeSpeaker: cara, edits: [{ node_id: r, content: { ...reply, mes: '' }, changes: [{ key: 'gold', variable: true, value: 3 }] }], actor: tabA });
        assert.equal(refused.refused.length, 1);
        assert.equal((await chats.store.chatRead('nextIds', {})).change, head.change);
    });

    test(`${kind}: two pages' per-variable changes merged by the engine leave each page's change`, async () => {
        const { chats, t, at, state } = await open(engine);
        const page = async () => {
            const metadata = {};
            replaceInPlace(metadata, await state());
            return { metadata, baseline: baselineOf(metadata) };
        };
        const save = async (p, actor) => {
            const changes = metadataChanges(p.metadata, p.baseline);
            if (!changes) return;
            await chats.mergeMetadata({ tree: t, at, set: changes.set, unset: changes.unset, variables: changes.variables, actor });
            p.baseline = baselineAfter(p.baseline, changes);
        };
        await chats.mergeMetadata({ tree: t, at, set: { note: 'n', variables: { hp: 3, mp: 1 } }, unset: [], actor: tabA });
        const a = await page();
        const b = await page();
        a.metadata.variables.hp = 4;
        delete a.metadata.variables.mp;
        // Page B replaces the object wholesale, as an extension might.
        b.metadata.variables = { hp: 3, mp: 1, gold: 7 };
        b.metadata.note = 'm';
        await save(a, tabA);
        await save(b, tabB);
        assert.deepEqual(await state(), { note: 'm', variables: { hp: 4, gold: 7 } });
        // Saved again unchanged, nothing is written.
        const head = await chats.store.chatRead('nextIds', {});
        await save(a, tabA);
        await save(b, tabB);
        assert.deepEqual(await chats.store.chatRead('nextIds', {}), head);
    });
}
