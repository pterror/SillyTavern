import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { setConfigFilePath } from '../util.js';
import { USER_DIRECTORY_TEMPLATE } from '../constants.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// user-stores.js reads the config at import time.
setConfigFilePath(path.join(here, '..', '..', 'default', 'config.yaml'));

const { setStoreEngine, userStore, closeUserStores, STORE_DIR } = await import('../user-stores.js');
const { readUserModel, writeUserModel } = await import('../settings-model/user-store.js');
const { importUpstream } = await import('../settings-model/settings-compat.js');
const { keyOf } = await import('../settings-model/keys.js');
const { SPACE, CHAT_NAMES_META } = await import('../chat-engine.js');
const { MIGRATIONS, doneKey, stateKey } = await import('./registry.js');
const { migrationGateMiddleware, migrationStateOf, startStoreMigrations } = await import('./run.js');
const { SNAPSHOTS_DIR, readMarker, restoreStoreSnapshot } = await import('./snapshot.js');
const { humanizedDateTime } = await import('../../public/scripts/humanized-date.js');
const { loadEngine } = await import('../../engine/load.js');

const binding = loadEngine().binding;
setStoreEngine(() => binding);
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'store-migrations-test-'));
after(async () => {
    await closeUserStores();
    fs.rmSync(dataRoot, { recursive: true, force: true });
});
const SHIPPED = JSON.parse(fs.readFileSync(path.join(here, '../../default/content/settings.json'), 'utf8'));

const card = (/** @type {string} */ name) => JSON.stringify({ name, description: '', personality: '', scenario: '', first_mes: 'Hello.', mes_example: '', spec: 'chara_card_v2', spec_version: '2.0', data: { name, description: '', personality: '', scenario: '', first_mes: 'Hello.', mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [], tags: [], creator: '', character_version: '', extensions: {} } });
const SESSION = '0190a1b2-0000-7000-8000-0000000000aa';
const said = { name: 'Cara', is_user: false, send_date: 1, mes: 'Hi.', extra: {}, original_avatar: 'cara.png' };

/**
 * A user's directories under the test's data root.
 * @param {string} handle
 * @returns {any}
 */
function directoriesFor(handle) {
    return Object.fromEntries(Object.entries(USER_DIRECTORY_TEMPLATE).map(([key, sub]) => [key, path.join(dataRoot, handle, sub)]));
}

/**
 * A synthetic user's store as stores made before every chat was named are: bookmarks with no label, labels repeated
 * in a scope, old chat ids kept in an extension's settings, and no migration recorded.
 * @param {string} handle
 */
async function seed(handle) {
    const directories = directoriesFor(handle);
    for (const dir of Object.values(directories)) fs.mkdirSync(dir, { recursive: true });
    const store = await userStore({ root: directories.root }, handle);
    const { lib, chats, people } = store;
    await lib.writeCard({}, 'cara.png', card('Cara'));
    await lib.writeGroup({ id: 'g1', name: 'One', members: ['cara.png'] });
    await lib.writeGroup({ id: 'g2', name: 'Two', members: ['cara.png'] });
    const [cara, g1, g2] = await people.trees([{ avatar: 'cara.png' }, { group: 'g1' }, { group: 'g2' }]);
    const speaker = (await people.byAvatar(['cara.png'])).get('cara.png');
    const actor = { user: handle, session: SESSION };
    /** @type {Record<string, string>} */
    const at = {};
    for (const [name, tree] of Object.entries({ cara, g1, g2 })) {
        [at[name]] = (await chats.appendMessages({ tree, treeSpeaker: name === 'cara' ? speaker : null, after: null, contents: [said], actor })).node_ids;
    }
    const [sid] = await chats.store.chatRead('ids', { space: SPACE.session, keys: [SESSION] });
    const [uid] = await chats.store.chatRead('ids', { space: SPACE.user, keys: [handle] });
    // Written as the store had them: with no check that a label is free, or that there is one.
    const bookmark = async (/** @type {string} */ tree, /** @type {string | null} */ name) => {
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
    const model = importUpstream(settings, { bundles: () => undefined, newKey: hint => keyOf(handle, hint) });
    await writeUserModel(lib, handle, model);
    // A store from before: none of its migrations recorded, nor the hand-run one-off's mark.
    await lib.store.commit([{ kind: 'metaValue', key: CHAT_NAMES_META }, ...MIGRATIONS.map(m => ({ kind: 'metaValue', key: doneKey(m.id) }))]);
    await closeUserStores();
    return { directories, trees: { cara, g1, g2 }, ids };
}

/**
 * What the request gate answers a request of the user.
 * @param {any} directories
 * @param {string} url
 * @param {{ method?: string, accept?: string }} [options]
 * @returns {{ status: number, body: any, type?: string } | 'next'}
 */
function gate(directories, url, { method = 'GET', accept = '*/*' } = {}) {
    /** @type {any} */
    let out = 'next';
    const response = /** @type {any} */ ({
        statusCode: 200,
        headers: {},
        status(code) { this.statusCode = code; return this; },
        set() { return this; },
        type(t) { this.contentType = t; return this; },
        send(body) { out = { status: this.statusCode, body, type: this.contentType }; return this; },
    });
    const request = /** @type {any} */ ({ user: { directories }, path: url, method, get: (/** @type {string} */ h) => (h.toLowerCase() === 'accept' ? accept : undefined) });
    migrationGateMiddleware(request, response, () => {});
    return out;
}

test('a store needing name-every-chat gets it at start, snapshotted first, with no hand-run step', async () => {
    const handle = 'old';
    const { directories, trees, ids } = await seed(handle);
    const [run] = startStoreMigrations([directories]);
    await run;
    assert.deepEqual(migrationStateOf(directories), { state: 'done' });
    // The snapshot before it, and the run's marker gone.
    const snapshots = fs.readdirSync(path.join(directories.root, SNAPSHOTS_DIR));
    assert.equal(snapshots.length, 1);
    assert.match(snapshots[0], /-before-name-every-chat$/);
    assert.equal(readMarker(directories.root), null);

    const store = await userStore({ root: directories.root }, handle);
    const label = async (/** @type {bigint} */ id) => (await store.chats.store.chatRead('bookmarks', { ids: [id] }))[0].name;
    const [made] = await store.chats.store.chatRead('bookmarks', { ids: [ids.none] });
    assert.equal(await label(ids.walk), 'Walk');
    assert.equal(await label(ids.walkAgain), 'Walk (2)');
    assert.equal(await label(ids.none), `Cara - ${humanizedDateTime(made.time)}`);
    assert.equal(await label(ids.g1), '2026-10-27@12h00m00s000ms');
    assert.equal(await label(ids.g2), '2026-10-27@12h00m00s001ms');
    assert.equal(await store.chats.treeOfChatId('2026-10-27@12h00m00s001ms'), trees.g2);
    const conversation = `Cara - ${humanizedDateTime(Number.parseInt(SESSION.slice(0, 8) + SESSION.slice(9, 13), 16))}`;
    const { ext } = /** @type {any} */ (await readUserModel(store.lib, handle));
    assert.deepEqual(ext.notes, { Walk: 'kept', last: conversation, other: '2026-10-27@12h00m00s001ms' });
    assert.ok((await store.lib.store.meta([doneKey('name-every-chat')]))[0]);

    // The snapshot, put back, is the store before it: the labels as they were.
    await closeUserStores();
    restoreStoreSnapshot(directories.root, snapshots[0], STORE_DIR);
    const back = await userStore({ root: directories.root }, handle);
    assert.equal((await back.chats.store.chatRead('bookmarks', { ids: [ids.walkAgain] }))[0].name, 'Walk');
    assert.equal((await back.lib.store.meta([doneKey('name-every-chat')]))[0], null);
    await closeUserStores();
});

test('a store marked by the hand-run one-off, or made by this version, is untouched', async () => {
    const { directories } = await seed('marked');
    const store = await userStore({ root: directories.root }, 'marked');
    await store.lib.store.commit([{ kind: 'metaValue', key: CHAT_NAMES_META, json: 'true' }]);
    await closeUserStores();
    const fresh = directoriesFor('fresh');
    for (const dir of Object.values(fresh)) fs.mkdirSync(dir, { recursive: true });
    await userStore({ root: fresh.root }, 'fresh');
    await closeUserStores();

    await Promise.all(startStoreMigrations([directories, fresh]));
    for (const d of [directories, fresh]) {
        assert.deepEqual(migrationStateOf(d), { state: 'done' });
        assert.equal(fs.existsSync(path.join(d.root, SNAPSHOTS_DIR)), false);
    }
    const again = await userStore({ root: directories.root }, 'marked');
    // Not run: its done key isn't written, the one-off's mark stands for it.
    assert.equal((await again.lib.store.meta([doneKey('name-every-chat')]))[0], null);
    await closeUserStores();
});

test('a migration a stop cut short goes on from what it saved, with the snapshot it took first', async () => {
    const { directories } = await seed('cut');
    let stopAt = 3;
    /** @type {number[]} */
    const ran = [];
    /** @type {import('./registry.js').Migration[]} */
    const migrations = [{
        id: 'steps',
        description: 'Five steps',
        load: async () => ({
            run: async ({ store, saved, save, progress }) => {
                for (let step = /** @type {any} */ (saved)?.next ?? 0; step < 5; step++) {
                    // The stop: the process gone mid-run (here, a throw before the step is written).
                    if (step === stopAt) throw new Error('stopped');
                    await store.lib.store.commit([{ kind: 'metaValue', key: `step.${step}`, json: 'true' }]);
                    ran.push(step);
                    await save({ next: step + 1 });
                    progress(step + 1, 5);
                }
            },
        }),
    }];
    await startStoreMigrations([directories], migrations)[0];
    assert.equal(migrationStateOf(directories).state, 'failed');
    const marker = readMarker(directories.root);
    assert.ok(marker);
    await closeUserStores();

    stopAt = -1;
    await startStoreMigrations([directories], migrations)[0];
    assert.deepEqual(migrationStateOf(directories), { state: 'done' });
    // Steps 0-2 once, then 3 and 4: nothing done twice.
    assert.deepEqual(ran, [0, 1, 2, 3, 4]);
    // One snapshot: the second run went on with the first one's.
    assert.deepEqual(fs.readdirSync(path.join(directories.root, SNAPSHOTS_DIR)), [(marker).snapshot]);
    const store = await userStore({ root: directories.root }, 'cut');
    assert.deepEqual(await store.lib.store.meta([stateKey('steps'), doneKey('steps')]).then((/** @type {any[]} */ v) => [JSON.parse(v[0]), Boolean(v[1])]), [null, true]);
    await closeUserStores();
});

test('a failing migration keeps the snapshot and blocks only its user; the progress answers while one runs', async () => {
    const failing = (await seed('failing')).directories;
    const running = (await seed('running')).directories;
    /** @type {() => void} */
    let finish = () => {};
    const waiting = new Promise(resolve => {
        finish = () => resolve(undefined);
    });
    /** @type {import('./registry.js').Migration[]} */
    const migrations = [{
        id: 'slow-or-broken',
        description: 'Something that takes a while',
        load: async () => ({
            run: async ({ handle, progress }) => {
                if (handle === 'failing') throw new Error('the data is not what it expected');
                progress(1, 4);
                await waiting;
            },
        }),
    }];
    const [failed, slow] = startStoreMigrations([failing, running], migrations);
    await failed;
    // Failed: said why, the store refused to everything past the gate, the snapshot and marker kept.
    const state = /** @type {any} */ (migrationStateOf(failing));
    assert.equal(state.state, 'failed');
    assert.equal(state.id, 'slow-or-broken');
    assert.match(state.error, /not what it expected/);
    await assert.rejects(() => userStore({ root: failing.root }, 'failing'), /not what it expected/);
    assert.ok(readMarker(failing.root));
    assert.equal(fs.readdirSync(path.join(failing.root, SNAPSHOTS_DIR)).filter(n => n !== 'migrating.json').length, 1);
    const refused = /** @type {any} */ (gate(failing, '/api/chats/get', { method: 'POST' }));
    assert.equal(refused.status, 503);
    assert.equal(refused.body.migration.state, 'failed');

    // The other user, still running: its status, a 503 for its API, the progress page for a page load, files served.
    await new Promise(resolve => setTimeout(resolve, 50));
    const status = /** @type {any} */ (gate(running, '/api/migrations/status'));
    assert.deepEqual(status.body, { state: 'running', id: 'slow-or-broken', description: 'Something that takes a while', done: 1, total: 4 });
    assert.equal(/** @type {any} */ (gate(running, '/api/characters/all', { method: 'POST' })).status, 503);
    const page = /** @type {any} */ (gate(running, '/', { accept: 'text/html,application/xhtml+xml' }));
    assert.equal(page.status, 503);
    assert.equal(page.type, 'html');
    assert.match(page.body, /\/api\/migrations\/status/);
    assert.equal(gate(running, '/script.js'), 'next');

    finish();
    await slow;
    assert.deepEqual(migrationStateOf(running), { state: 'done' });
    assert.equal(gate(running, '/api/characters/all', { method: 'POST' }), 'next');
    assert.deepEqual(/** @type {any} */ (gate(running, '/api/migrations/status')).body, { state: 'done' });
    await closeUserStores();
});
