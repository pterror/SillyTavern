// State layer 1 on the engine (build path 5b): `chat_metadata` merged per key and per variable, and the state
// changes made while producing a reply recorded with it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { loadEngine } from '../engine/load.js';

const { ChatEngine } = await import('./chat-engine.js');

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
}
