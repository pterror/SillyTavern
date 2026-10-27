import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { setConfigFilePath } from '../util.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// user-stores.js reads the config at import time.
setConfigFilePath(path.join(here, '..', '..', 'default', 'config.yaml'));

const { directoriesFor, runNameEveryChat } = await import('./name-every-chat.js');
const { setStoreEngine, userStore, closeUserStores } = await import('../user-stores.js');
const { readUserModel, writeUserModel } = await import('../settings-model/user-store.js');
const { importUpstream } = await import('../settings-model/settings-compat.js');
const { keyOf } = await import('../settings-model/keys.js');
const { SPACE } = await import('../chat-engine.js');
const { humanizedDateTime } = await import('../../public/scripts/humanized-date.js');
const { loadEngine } = await import('../../engine/load.js');

const binding = loadEngine().binding;
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'name-every-chat-test-'));
after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
const SHIPPED = JSON.parse(fs.readFileSync(path.join(here, '../../default/content/settings.json'), 'utf8'));

const card = name => JSON.stringify({ name, description: '', personality: '', scenario: '', first_mes: 'Hello.', mes_example: '', spec: 'chara_card_v2', spec_version: '2.0', data: { name, description: '', personality: '', scenario: '', first_mes: 'Hello.', mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [], tags: [], creator: '', character_version: '', extensions: {} } });
const noServer = async () => ({ running: false, lines: [] });
const SESSION = '0190a1b2-0000-7000-8000-0000000000aa';
const said = { name: 'Cara', is_user: false, send_date: 1, mes: 'Hi.', extra: {}, original_avatar: 'cara.png' };

/**
 * A synthetic user's store with chats as stores made before every chat was named have them: bookmarks with no label,
 * labels repeated in a scope, and old chat ids kept in an extension's settings.
 */
async function seed(handle) {
    const directories = directoriesFor(dataRoot, handle);
    for (const dir of Object.values(directories)) fs.mkdirSync(dir, { recursive: true });
    setStoreEngine(() => binding);
    const store = await userStore({ root: directories.root }, handle);
    const { lib, chats, people } = store;
    await lib.writeCard({}, 'cara.png', card('Cara'));
    await lib.writeGroup({ id: 'g1', name: 'One', members: ['cara.png'] });
    await lib.writeGroup({ id: 'g2', name: 'Two', members: ['cara.png'] });
    const [cara, g1, g2] = await people.trees([{ avatar: 'cara.png' }, { group: 'g1' }, { group: 'g2' }]);
    const speaker = (await people.byAvatar(['cara.png'])).get('cara.png');
    const actor = { user: handle, session: SESSION };
    const at = {};
    for (const [name, tree] of Object.entries({ cara, g1, g2 })) {
        [at[name]] = (await chats.appendMessages({ tree, treeSpeaker: name === 'cara' ? speaker : null, after: null, contents: [said], actor })).node_ids;
    }
    const [sid] = await chats.store.chatRead('ids', { space: SPACE.session, keys: [SESSION] });
    const [uid] = await chats.store.chatRead('ids', { space: SPACE.user, keys: [handle] });
    // Written as the store had them: with no check that a label is free, or that there is one.
    const bookmark = async (tree, name) => {
        const [m] = await chats.messageIds([at[tree]]);
        const id = chats.next.position++;
        await chats.store.commit([
            { kind: 'positionCreate', id, mode: 1, session: sid, user: uid, pointer: m },
            ...(name === null ? [] : [{ kind: 'positionName', id, name }]),
        ]);
        return id;
    };
    const ids = {
        walk: await bookmark('cara', 'Walk'),
        walkAgain: await bookmark('cara', 'Walk'),
        none: await bookmark('cara', null),
        g1: await bookmark('g1', '2026-10-27@12h00m00s000ms'),
        g2: await bookmark('g2', '2026-10-27@12h00m00s000ms'),
    };
    const settings = structuredClone(SHIPPED);
    settings.extension_settings = { ...settings.extension_settings, notes: { [`b${ids.walk}`]: 'kept', last: `s${SESSION}.${cara}`, other: `b${ids.g2}` } };
    const model = importUpstream(settings, { bundles: () => null, newKey: hint => keyOf(handle, hint) });
    await writeUserModel(lib, handle, model);
    await closeUserStores();
    return { directories, trees: { cara, g1, g2 }, ids };
}

test('every bookmark gets a label once in its scope, and old chat ids in extension settings become the names', async () => {
    const handle = 'u1';
    const { trees, ids } = await seed(handle);
    const lines = [];
    const run = apply => runNameEveryChat({ dataRoot, handle, apply, engine: async () => binding, probeServer: noServer, log: l => lines.push(l), warn: l => lines.push(`WARN ${l}`) });

    assert.equal(await run(false), 0);
    assert.ok(lines.some(l => l.includes(`bookmark ${ids.walkAgain}`) && l.includes('"Walk (2)"')), lines.join('\n'));
    assert.ok(lines.some(l => l.includes('3 old chat id(s)')), lines.join('\n'));
    assert.equal(await run(true), 0, lines.join('\n'));
    assert.ok(!lines.some(l => l.startsWith('WARN')), lines.join('\n'));

    setStoreEngine(() => binding);
    const store = await userStore({ root: directoriesFor(dataRoot, handle).root }, handle);
    try {
        const label = async id => (await store.chats.store.chatRead('bookmarks', { ids: [id] }))[0].name;
        const [made] = await store.chats.store.chatRead('bookmarks', { ids: [ids.none] });
        assert.equal(await label(ids.walk), 'Walk');
        assert.equal(await label(ids.walkAgain), 'Walk (2)');
        // Named as a new chat is: the character's name and the bookmark's time.
        assert.equal(await label(ids.none), `Cara - ${humanizedDateTime(made.time)}`);
        // Two groups, one scope: the later one is a millisecond on.
        assert.equal(await label(ids.g1), '2026-10-27@12h00m00s000ms');
        assert.equal(await label(ids.g2), '2026-10-27@12h00m00s001ms');
        // A name finds its chat: a group's with no tree given.
        assert.equal(await store.chats.treeOfChatId('2026-10-27@12h00m00s001ms'), trees.g2);
        assert.deepEqual(await store.chats.resolveChatName({ tree: trees.cara, name: 'Walk (2)' }), { bookmark: ids.walkAgain });

        const conversation = `Cara - ${humanizedDateTime(Number.parseInt(SESSION.slice(0, 8) + SESSION.slice(9, 13), 16))}`;
        const { ext } = /** @type {any} */ (await readUserModel(store.lib, handle));
        assert.deepEqual(ext.notes, { Walk: 'kept', last: conversation, other: '2026-10-27@12h00m00s001ms' });
        // The conversation named so has its name stored.
        const [sid] = await store.chats.store.chatRead('ids', { space: SPACE.session, keys: [SESSION] });
        assert.equal(await store.chats.store.chatRead('conversationName', { session: sid, tree: trees.cara }), conversation);
    } finally {
        await closeUserStores();
    }
});
