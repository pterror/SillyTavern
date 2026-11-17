import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setConfigFilePath } from './util.js';
import { hashGreetingText } from './greeting-ops.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));

test('editing the card to match a chat opening collapses the counter and retains the continuation', async () => {
    const { emptyUser } = await import('../tests/converted-user.fixture.js');
    const user = await emptyUser('relink-card-openings-');
    const previousRoot = globalThis.DATA_ROOT;
    globalThis.DATA_ROOT = user.dataRoot;
    try {
        const data = { name: 'Cara', description: '', personality: '', scenario: '', first_mes: 'Hello', mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [], tags: [], creator: '', character_version: '', extensions: {} };
        await user.store.lib.writeCard(user.directories, 'Cara.png', JSON.stringify({ name: 'Cara', spec: 'chara_card_v2', spec_version: '2.0', data }));
        const [tree] = await user.store.people.trees([{ avatar: 'Cara.png' }]);
        assert.ok(tree !== null);
        const model = await user.store.lib.greetingModel('Cara.png');
        const speaker = (await user.store.people.speakers([tree])).get(tree) ?? null;
        const actor = { user: 'u', session: '0190a1b2-0000-7000-8000-0000000000b1' };
        const chats = user.store.chats;
        const sent = await chats.appendMessages({ tree, treeSpeaker: speaker, after: null, actor, contents: [
            { name: 'Cara', mes: 'Hello', is_user: false, extra: {} },
            { name: 'You', mes: 'Reply', is_user: true, extra: {} },
        ] });
        await chats.editMessages({ tree, treeSpeaker: speaker, actor, edits: [{ node_id: sent.node_ids[0], patch: { mes: 'Edited hello' }, finished: true }] });
        assert.equal((await chats.openingAlternatives({ tree, actor })).total, 2);
        const { changeGreetings } = await import('./endpoints/characters.js');
        const changed = await changeGreetings({ directories: user.directories, store: user.store, actor: null, avatar: 'Cara.png', change: {
            op: 'edit', id: model.greetings[0].id, hash: hashGreetingText('Hello'), text: 'Edited hello',
        } });
        assert.equal(changed.result.ok, true);
        const opening = await chats.openingAlternatives({ tree, actor });
        assert.equal(opening.total, 1);
        assert.equal(opening.default_index, 0);
        assert.equal(/** @type {any} */ (opening.alternatives[0]).node_id, sent.node_ids[0]);
        const loaded = await chats.load({ tree, at: sent.node_ids[1] });
        assert.ok(loaded);
        assert.deepEqual(loaded.messages.map(m => m.mes), ['Edited hello', 'Reply']);
    } finally {
        globalThis.DATA_ROOT = previousRoot;
        await user.close();
    }
});
