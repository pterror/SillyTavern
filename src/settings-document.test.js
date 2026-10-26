import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { setConfigFilePath } from './util.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// user-stores.js reads the config at import time.
setConfigFilePath(path.join(here, '..', 'config.yaml'));

const { directoriesFor } = await import('./migrations/convert-settings-to-model.js');
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
