import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { setConfigFilePath } from '../util.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// user-stores.js reads the config at import time.
setConfigFilePath(path.join(here, '..', '..', 'config.yaml'));

const { directoriesFor, runConvert } = await import('./convert-settings-to-model.js');
const { setStoreEngine, userStore, closeUserStores } = await import('../user-stores.js');
const { writeAllSettings } = await import('../settings-store.js');
const { readUserModel } = await import('../settings-model/user-store.js');
const { loadEngine } = await import('../../engine/load.js');
const { TYPE } = await import('../library-codes.js');

const CONTENT = path.join(here, '../../default/content');
const SHIPPED = JSON.parse(fs.readFileSync(path.join(CONTENT, 'settings.json'), 'utf8'));
const binding = loadEngine().binding;
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'convert-settings-test-'));
after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));

/** The shipped files a new user has, copied into a synthetic user's folders. */
const SEEDED = {
    openAI_Settings: 'presets/openai/Default.json', textGen_Settings: 'presets/textgen/Default.json',
    novelAI_Settings: 'presets/novel/Talker-Chat-Clio.json', koboldAI_Settings: 'presets/kobold/Default.json',
    instruct: 'presets/instruct/ChatML.json', context: 'presets/context/Default.json', sysprompt: 'presets/sysprompt/Neutral - Chat.json',
    themes: 'themes/Dark Lite.json', quickreplies: 'presets/quick-replies/Default.json',
};

/**
 * A synthetic user with the shipped settings and some of the shipped bundles, and an engine store.
 * @param {string} handle
 * @param {(settings: Record<string, any>) => void} [change]
 */
async function seedUser(handle, change) {
    const directories = directoriesFor(dataRoot, handle);
    for (const dir of Object.values(directories)) fs.mkdirSync(dir, { recursive: true });
    for (const [key, file] of Object.entries(SEEDED)) {
        if (fs.existsSync(path.join(CONTENT, file))) fs.copyFileSync(path.join(CONTENT, file), path.join(directories[key], path.basename(file)));
    }
    fs.writeFileSync(path.join(directories.themes, 'Broken.json'), '{ not json');
    const settings = structuredClone(SHIPPED);
    change?.(settings);
    writeAllSettings(directories, settings);
    setStoreEngine(() => binding);
    await userStore({ root: directories.root });
    await closeUserStores();
    return directories;
}

const noServer = async () => ({ running: false, lines: [] });

/**
 * @param {string} handle
 * @param {boolean} apply
 */
async function convert(handle, apply, again = false) {
    const lines = [];
    const code = await runConvert({
        dataRoot, handle, apply, again, engine: async () => binding, probeServer: noServer,
        log: line => lines.push(line), warn: line => lines.push(line),
    });
    return { code, lines };
}

test('the dry run lists what it would make and writes nothing', async () => {
    const directories = await seedUser('dry');
    const before = fs.readdirSync(directories.root, { recursive: true }).sort();
    const { code, lines } = await convert('dry', false);
    assert.equal(code, 0, lines.join('\n'));
    assert.ok(lines.some(l => l.includes('to make:') && l.includes('samplerPreset')), lines.join('\n'));
    assert.ok(lines.some(l => l.includes('Broken.json') && l.includes('isn\'t valid JSON')), lines.join('\n'));
    assert.ok(lines.some(l => l.includes('0 value(s) past the documented losses')), lines.join('\n'));
    assert.deepEqual(fs.readdirSync(directories.root, { recursive: true }).sort(), before);
    setStoreEngine(() => binding);
    const store = await userStore({ root: directories.root });
    try {
        assert.equal(await readUserModel(store.lib, 'dry'), null);
    } finally {
        await closeUserStores();
    }
});

test('apply writes the model, reads it back the same, keeps the files, and refuses a second run', async () => {
    const directories = await seedUser('apply', settings => {
        settings.extension_settings.apiKey = 'extras-secret';
        settings.oai_settings.temp_openai = 0.33;
    });
    const settingsFiles = fs.readdirSync(path.join(directories.root, 'settings')).sort();
    const { code, lines } = await convert('apply', true);
    assert.equal(code, 0, lines.join('\n'));
    assert.ok(lines.some(l => l.includes('written and read back: the same settings')), lines.join('\n'));
    assert.deepEqual(fs.readdirSync(path.join(directories.root, 'settings')).sort(), settingsFiles);
    // The Extras key is in secrets.json; its connection names it.
    const secrets = JSON.parse(fs.readFileSync(path.join(directories.root, 'secrets.json'), 'utf8'));
    assert.equal(secrets.api_key_extras?.[0]?.value, 'extras-secret');
    setStoreEngine(() => binding);
    const store = await userStore({ root: directories.root });
    try {
        const model = await readUserModel(store.lib, 'apply');
        assert.equal(model?.user.overrides['preset.openai/temperature'], 0.33);
        const extras = model?.entities.find(e => e.type === TYPE.connection && e.values.type === 'extras');
        assert.equal(extras?.values.secret, secrets.api_key_extras[0].id);
    } finally {
        await closeUserStores();
    }
    const again = await convert('apply', true);
    assert.equal(again.code, 1);
    assert.ok(again.lines.some(l => l.includes('converted already')));
});

test('refused while the server runs', async () => {
    await seedUser('running');
    const lines = [];
    const code = await runConvert({ dataRoot, handle: 'running', apply: true, engine: async () => binding, probeServer: async () => ({ running: true, lines: [] }), log: l => lines.push(l), warn: l => lines.push(l) });
    assert.equal(code, 1);
    assert.ok(lines.some(l => l.includes('REFUSED')));
});

test('again: the last run\'s model goes, and the same one is made anew', async () => {
    await seedUser('again');
    assert.equal((await convert('again', true)).code, 0);
    const second = await convert('again', true, true);
    assert.equal(second.code, 0, second.lines.join('\n'));
    assert.ok(second.lines.some(l => l.includes('deleted the last run')));
    setStoreEngine(() => binding);
    const store = await userStore({ root: directoriesFor(dataRoot, 'again').root });
    try {
        const { entities } = await store.lib.store.libraryOfType(TYPE.connection, null, 1000);
        const model = await readUserModel(store.lib, 'again');
        assert.equal(entities.length, model?.entities.filter(e => e.type === TYPE.connection).length);
    } finally {
        await closeUserStores();
    }
});
