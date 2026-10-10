// Speakers come from the library on the same engine store: a rename shows in every message that names the speaker.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { loadEngine } from '../engine/load.js';

(await import('./util.js')).setConfigFilePath(path.join(import.meta.dirname, '..', 'default', 'config.yaml'));
const { LibraryEngine } = await import('./library-engine.js');
const { ChatEngine } = await import('./chat-engine.js');
const { libraryPeople } = await import('./chat-people.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-people-test-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const card = name => JSON.stringify({ name, description: '', personality: '', scenario: '', first_mes: 'Hello.', mes_example: '', spec: 'chara_card_v2', spec_version: '2.0', data: { name, description: '', personality: '', scenario: '', first_mes: 'Hello.', mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [], tags: [], creator: '', character_version: '', extensions: {} } });

for (const [kind, engine] of Object.entries({ native: loadEngine().binding, wasm: loadEngine({ platform: null }).binding })) {
    test(`${kind}: speakers by id and avatar, and trees, from the library`, async () => {
        const store = await engine.Store.open(path.join(root, kind));
        const lib = new LibraryEngine(store, await store.libraryNextId());
        await lib.writeCard({}, 'cara.png', card('Cara'));
        await lib.writeGroup({ id: 'g1', name: 'Group', members: ['cara.png'] });
        const people = libraryPeople(lib);
        const [tree, group, none] = await people.trees([{ avatar: 'cara.png' }, { group: 'g1' }, { avatar: 'nobody.png' }]);
        assert.equal(none, null);
        assert.notEqual(tree, group);
        assert.deepEqual([...(await people.byAvatar(['cara.png', 'nobody.png'])).keys()], ['cara.png']);
        assert.equal((await people.speakers([group])).size, 0, 'a group speaks for no one');

        const chats = await ChatEngine.open(store, people);
        const actor = { user: 'tester', session: '0190a1b2-0000-7000-8000-0000000000aa' };
        const speaker = (await people.byAvatar(['cara.png'])).get('cara.png');
        const said = { name: 'Cara', is_user: false, send_date: 1, mes: 'Hi.', extra: {}, original_avatar: 'cara.png' };
        const [inTree] = (await chats.appendMessages({ tree, treeSpeaker: speaker, after: null, contents: [said], actor })).node_ids;
        const [inGroup] = (await chats.appendMessages({ tree: group, treeSpeaker: null, after: null, contents: [said], actor })).node_ids;
        // Renamed in the library: both messages show the new name, and nothing was written to them.
        await lib.writeCard({}, 'cara.png', card('Cara Prime'));
        for (const [t, at] of [[tree, inTree], [group, inGroup]]) {
            assert.equal((await chats.load({ tree: t, at })).messages[0].name, 'Cara Prime');
        }
        await store.close();
    });
}
