import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { setConfigFilePath } from './util.js';
import { USER_DIRECTORY_TEMPLATE } from './constants.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// user-stores.js reads the config at import time.
setConfigFilePath(path.join(here, '..', 'config.yaml'));

const { setStoreEngine, closeUserStores } = await import('./user-stores.js');
const settingsStore = await import('./settings-store.js');
const { openSettingsDocument } = await import('./settings-document.js');
const { setSettingsDocument } = await import('./settings-documents.js');
const { deleteBundle, listBundles, readBundle, renameBundle, writeBundle } = await import('./bundle-store.js');
const { loadEngine } = await import('../engine/load.js');

const CONTENT = path.join(here, '../default/content');
const SHIPPED = JSON.parse(fs.readFileSync(path.join(CONTENT, 'settings.json'), 'utf8'));
setStoreEngine(() => loadEngine().binding);
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-document-test-'));
after(async () => {
    await closeUserStores();
    fs.rmSync(dataRoot, { recursive: true, force: true });
});

/**
 * A user's directories under the test's data root.
 * @param {string} root
 * @param {string} handle
 * @returns {any}
 */
function directoriesFor(root, handle) {
    return Object.fromEntries(Object.entries(USER_DIRECTORY_TEMPLATE).map(([key, sub]) => [key, path.join(root, handle, sub)]));
}

/**
 * A new user as the content manager makes one: the shipped settings and some shipped bundles in files.
 * @param {string} handle
 */
function seedUser(handle) {
    const directories = directoriesFor(dataRoot, handle);
    for (const dir of Object.values(directories)) fs.mkdirSync(dir, { recursive: true });
    for (const [key, file] of [['openAI_Settings', 'presets/openai/Default.json'], ['themes', 'themes/Dark Lite.json'], ['instruct', 'presets/instruct/ChatML.json'], ['textGen_Settings', 'presets/textgen/Default.json']]) {
        fs.copyFileSync(path.join(CONTENT, file), path.join(directories[key], path.basename(file)));
    }
    fs.writeFileSync(path.join(directories.root, 'settings.json'), JSON.stringify(SHIPPED));
    return directories;
}

/**
 * The user's document closed and opened again from the store, as after a restart.
 * @param {any} directories
 * @param {string} handle
 */
async function reopen(directories, handle) {
    setSettingsDocument(directories, undefined);
    await openSettingsDocument(directories, handle);
}

test('opening converts the files, moves them aside, and reads the settings from the model', async () => {
    const directories = seedUser('fresh');
    await openSettingsDocument(directories, 'fresh');
    assert.equal(fs.existsSync(path.join(directories.root, 'settings.json')), false);
    // (the first read shards settings.json into settings/, which is what goes aside)
    assert.ok(fs.existsSync(path.join(directories.root, settingsStore.FILES_ASIDE, 'settings', 'power_user.json')));
    assert.deepEqual(fs.readdirSync(directories.openAI_Settings), []);
    const settings = settingsStore.readAllSettings(directories);
    assert.equal(settings.oai_settings.preset_settings_openai, SHIPPED.oai_settings.preset_settings_openai);
    assert.equal(settings.power_user.theme, SHIPPED.power_user.theme);
    assert.equal(settingsStore.readSettingsAtPaths(directories, ['power_user.theme'])['power_user.theme'], SHIPPED.power_user.theme);
    // A user whose files are aside reads nothing from them without the document.
    setSettingsDocument(directories, undefined);
    assert.throws(() => settingsStore.readAllSettings(directories), /settings model/);
    await openSettingsDocument(directories, 'fresh');
});

test('a write is shown at once and kept: the reopened model gives it', async () => {
    const directories = seedUser('writes');
    await openSettingsDocument(directories, 'writes');
    const pending = settingsStore.writeSettingsKeys(directories, { 'power_user.auto_swipe': true, 'oai_settings.temp_openai': 0.42, main_api: 'openai' });
    assert.equal(settingsStore.readSettingsAtPaths(directories, ['power_user.auto_swipe'])['power_user.auto_swipe'], true);
    await pending;
    await reopen(directories, 'writes');
    const back = settingsStore.readAllSettings(directories);
    assert.equal(back.power_user.auto_swipe, true);
    assert.equal(back.oai_settings.temp_openai, 0.42);
    assert.equal(back.main_api, 'openai');
    // A whole save, then a reset to a new user's settings.
    await settingsStore.writeNamedSettings(directories, { ...back, swipes: false });
    await reopen(directories, 'writes');
    assert.equal(settingsStore.readAllSettings(directories).swipes, false);
    await settingsStore.deleteAllSettings(directories);
    await reopen(directories, 'writes');
    assert.equal(settingsStore.readAllSettings(directories).swipes, SHIPPED.swipes);
});

test('statements at a character not in the library are warned of once, not at every save that keeps them', async () => {
    const directories = seedUser('kept');
    const upstream = structuredClone(SHIPPED);
    upstream.power_user.persona_descriptions = { 'me.png': { description: '', position: 0, connections: [{ type: 'character', id: 'Gone.png' }] } };
    fs.writeFileSync(path.join(directories.root, 'settings.json'), JSON.stringify(upstream));
    /** @type {string[]} */
    const warned = [];
    const warn = console.warn;
    console.warn = (/** @type {unknown[]} */ ...args) => { warned.push(args.map(String).join(' ')); };
    try {
        await openSettingsDocument(directories, 'kept');
        assert.equal(warned.filter(w => w.includes('Gone.png')).length, 1);
        await settingsStore.writeSettingsKeys(directories, { 'power_user.auto_swipe': true });
        await settingsStore.writeSettingsKeys(directories, { 'power_user.auto_swipe': false });
        await settingsStore.writeNamedSettings(directories, settingsStore.readAllSettings(directories));
        assert.equal(warned.filter(w => w.includes('Gone.png')).length, 1);
    } finally {
        console.warn = warn;
    }
});

test('bundles are the store\'s: listed, saved, renamed and deleted, a selected one\'s values in the settings', async () => {
    const directories = seedUser('bundles');
    await openSettingsDocument(directories, 'bundles');
    assert.deepEqual((await listBundles(directories, 'preset.openai')).map(b => b.name), ['Default']);
    const preset = await readBundle(directories, 'preset.openai', 'Default');
    assert.ok(preset);
    assert.equal(await writeBundle(directories, 'preset.openai', 'Mine/2', { ...preset, temperature: 0.9 }), 'Mine2');
    assert.equal((await readBundle(directories, 'preset.openai', 'Mine2'))?.temperature, 0.9);
    assert.equal(await renameBundle(directories, 'preset.openai', 'Mine2', 'Default'), 'taken');
    assert.equal(await renameBundle(directories, 'preset.openai', 'Mine2', 'Ours'), 'renamed');
    assert.equal(await readBundle(directories, 'preset.openai', 'Mine2'), null);
    // The prompts went with it.
    assert.deepEqual((await readBundle(directories, 'preset.openai', 'Ours'))?.prompts, preset.prompts);
    assert.equal(await deleteBundle(directories, 'preset.openai', 'Ours'), true);
    assert.equal(await deleteBundle(directories, 'preset.openai', 'Ours'), false);
    assert.deepEqual((await listBundles(directories, 'preset.openai')).map(b => b.name), ['Default']);
    // Selecting the edited preset's twin: its values are the settings', through a save.
    await writeBundle(directories, 'preset.openai', 'Warm', { ...preset, temperature: 1.7 });
    const settings = settingsStore.readAllSettings(directories);
    await settingsStore.writeNamedSettings(directories, { oai_settings: { ...settings.oai_settings, preset_settings_openai: 'Warm', temp_openai: 1.7 } });
    await reopen(directories, 'bundles');
    const back = settingsStore.readAllSettings(directories);
    assert.equal(back.oai_settings.preset_settings_openai, 'Warm');
    assert.equal(back.oai_settings.temp_openai, 1.7);
});

test('a bundle file arriving later (new content) is imported on open; one the store has stays as the store has it', async () => {
    const directories = seedUser('arrivals');
    await openSettingsDocument(directories, 'arrivals');
    await writeBundle(directories, 'theme', 'Dark Lite', { name: 'Dark Lite', main_text_color: 'rgb(1, 2, 3)' });
    fs.copyFileSync(path.join(CONTENT, 'themes/Azure.json'), path.join(directories.themes, 'Azure.json'));
    fs.copyFileSync(path.join(CONTENT, 'themes/Dark Lite.json'), path.join(directories.themes, 'Dark Lite.json'));
    await reopen(directories, 'arrivals');
    assert.ok(await readBundle(directories, 'theme', 'Azure'));
    assert.equal((await readBundle(directories, 'theme', 'Dark Lite'))?.main_text_color, 'rgb(1, 2, 3)');
    assert.deepEqual(fs.readdirSync(directories.themes), []);
});

test('a character\'s own preset and override: its context reads them, the user\'s doesn\'t, a user save and a reopen keep them', async () => {
    const { userStore } = await import('./user-stores.js');
    const { readSettingsFor, readUserSettings } = await import('./settings-reads.js');
    const { settingsDocumentOf } = await import('./settings-documents.js');
    const directories = seedUser('levels');
    await openSettingsDocument(directories, 'levels');
    const { lib } = await userStore(directories, 'levels');
    const card = name => JSON.stringify({ name, description: '', personality: '', scenario: '', first_mes: 'Hi.', mes_example: '', spec: 'chara_card_v2', spec_version: '2.0', data: { name, description: '', personality: '', scenario: '', first_mes: 'Hi.', mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [], tags: [], creator: '', character_version: '', extensions: {} } });
    await lib.writeCard({}, 'Cara.png', card('Cara'));
    const preset = await readBundle(directories, 'preset.openai', 'Default');
    await writeBundle(directories, 'preset.openai', 'Hot', { ...preset, temperature: 1.9, top_p: 0.3 });
    const document = settingsDocumentOf(directories);
    await document.writeLevel('character:Cara.png', { bundles: { 'preset.openai': 'openai:Hot' }, set: { 'preset.openai/top_p': 0.6 } });

    const read = context => readSettingsFor(directories, context, ['oai_settings.temp_openai', 'oai_settings.top_p_openai', 'oai_settings.preset_settings_openai']);
    assert.deepEqual(Object.values(read({ avatar: 'Cara.png' })), [1.9, 0.6, 'Hot']);
    assert.notEqual(read({ avatar: 'Other.png' })['oai_settings.temp_openai'], 1.9);
    assert.notEqual(readUserSettings(directories, ['oai_settings.temp_openai'])['oai_settings.temp_openai'], 1.9);

    // A save of the user's own settings leaves the character's.
    await settingsStore.writeSettingsKeys(directories, { 'power_user.auto_swipe': true });
    assert.equal(read({ avatar: 'Cara.png' })['oai_settings.temp_openai'], 1.9);
    await reopen(directories, 'levels');
    assert.deepEqual(Object.values(read({ avatar: 'Cara.png' })), [1.9, 0.6, 'Hot']);
    // Unstated, the character reads the user's again.
    await settingsDocumentOf(directories).writeLevel('character:Cara.png', { bundles: { 'preset.openai': null }, delete: ['preset.openai/top_p'] });
    assert.deepEqual(read({ avatar: 'Cara.png' }), read({}));
});

test('a save in a context goes to the range\'s top level: the character\'s, the user\'s, or the preset itself; a preference is the user\'s', async () => {
    const { userStore } = await import('./user-stores.js');
    const { settingsDocumentOf } = await import('./settings-documents.js');
    const directories = seedUser('ranges');
    await openSettingsDocument(directories, 'ranges');
    const { lib } = await userStore(directories, 'ranges');
    const card = name => JSON.stringify({ name, description: '', personality: '', scenario: '', first_mes: 'Hi.', mes_example: '', spec: 'chara_card_v2', spec_version: '2.0', data: { name, description: '', personality: '', scenario: '', first_mes: 'Hi.', mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [], tags: [], creator: '', character_version: '', extensions: {} } });
    await lib.writeCard({}, 'Cara.png', card('Cara'));
    const document = settingsDocumentOf(directories);
    const cara = { avatar: 'Cara.png' };
    const all = { from: 'default', to: 'character' };
    const edit = (/** @type {any} */ range, /** @type {(s: any) => void} */ change) => {
        const saved = structuredClone(document.view(cara, range).settings);
        change(saved);
        return document.saveIn(cara, range, saved);
    };

    // Top: the character. The temperature and a preference change.
    await edit(all, s => {
        s.oai_settings.temp_openai = 1.3;
        s.power_user.auto_swipe = true;
    });
    assert.equal(document.view(cara).settings.oai_settings.temp_openai, 1.3);
    assert.equal(document.view(cara).sources['oai_settings.temp_openai'], 'character');
    assert.notEqual(document.settings.oai_settings.temp_openai, 1.3);
    assert.equal(document.settings.power_user.auto_swipe, true);

    // Top: the user. Cara's still wins in her context; the user's is the fallback.
    await edit({ from: 'default', to: 'user' }, s => { s.oai_settings.temp_openai = 0.4; });
    assert.equal(document.settings.oai_settings.temp_openai, 0.4);
    assert.equal(document.view(cara).settings.oai_settings.temp_openai, 1.3);
    assert.equal(document.view({}).sources['oai_settings.temp_openai'], 'user');

    // Only the character's level: what Cara sets, and nothing else.
    const caraOnly = document.view(cara, { from: 'character', to: 'character' });
    assert.deepEqual(Object.values(caraOnly.sources), ['character']);

    // Top: the preset. The preset's file changes.
    await edit({ from: 'default', to: 'preset' }, s => { s.oai_settings.top_p_openai = 0.77; });
    assert.equal((await readBundle(directories, 'preset.openai', document.settings.oai_settings.preset_settings_openai))?.top_p, 0.77);
});

test('a value past what the model allows reads as its limit, from the model list the source last answered; the stored value stays', async () => {
    const { settingsDocumentOf } = await import('./settings-documents.js');
    const { readSettingsFor, readUserSettings } = await import('./settings-reads.js');
    const { rememberModelList } = await import('./model-lists.js');
    const directories = seedUser('limits');
    await openSettingsDocument(directories, 'limits');
    await settingsStore.writeSettingsKeys(directories, {
        'oai_settings.chat_completion_source': 'mistralai',
        'oai_settings.mistralai_model': 'm',
        'oai_settings.openai_max_context': 30000,
        'oai_settings.temp_openai': 1.8,
    });
    const document = settingsDocumentOf(directories);
    const paths = ['oai_settings.openai_max_context', 'oai_settings.temp_openai'];
    assert.deepEqual(readSettingsFor(directories, {}, paths), { 'oai_settings.openai_max_context': 30000, 'oai_settings.temp_openai': 1.5 });
    assert.equal(document.settings.oai_settings.temp_openai, 1.8);
    // The source lists the model with less: the next read is within it.
    assert.equal(await rememberModelList(directories, 'mistralai', [{ id: 'm', max_context_length: 20000, description: 'x' }]), true);
    assert.equal(readUserSettings(directories, paths)['oai_settings.openai_max_context'], 20000);
    assert.equal(await rememberModelList(directories, 'mistralai', [{ id: 'm', max_context_length: 20000, description: 'y' }]), false);
    assert.equal(document.view({}, { from: 'default', to: 'user' }).settings.oai_settings.openai_max_context, 20000);
    assert.equal(document.settings.oai_settings.openai_max_context, 30000);
    // Kept on disk: a restart reads the same.
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directories.root, 'model-lists', 'mistralai.json'), 'utf8')), [{ id: 'm', max_context_length: 20000 }]);
});

test('a write that selects another preset takes its values of the fields the server owns, as the old page wrote them with the selection', async () => {
    const { settingsDocumentOf } = await import('./settings-documents.js');
    const { pageWrite } = await import('./settings-hash.js');
    const directories = seedUser('selects');
    await openSettingsDocument(directories, 'selects');
    const document = settingsDocumentOf(directories);
    await writeBundle(directories, 'preset.openai', 'Cool', { temperature: 0.4 });
    await document.writeAt({}, { from: 'default', to: 'user' }, 'oai_settings.temp_openai', 0.6);
    assert.equal(document.settings.oai_settings.temp_openai, 0.6);
    // The page's save of the selection: what the server owns is kept as the server has it.
    const over = settingsStore.readAllSettings(directories);
    const sent = pageWrite('oai_settings', { ...over.oai_settings, preset_settings_openai: 'Cool' }, over);
    await settingsStore.writeSettingsKeys(directories, { oai_settings: sent?.value });
    assert.equal(document.settings.oai_settings.preset_settings_openai, 'Cool');
    assert.equal(document.settings.oai_settings.temp_openai, 0.4);
    // A write that keeps the selection keeps the user's own value.
    await document.writeAt({}, { from: 'default', to: 'user' }, 'oai_settings.temp_openai', 0.7);
    await settingsStore.writeSettingsKeys(directories, { oai_settings: settingsStore.readAllSettings(directories).oai_settings });
    assert.equal(document.settings.oai_settings.temp_openai, 0.7);
});
