import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { loadEngine } from '../../engine/load.js';
import { LibraryEngine } from '../library-engine.js';
import { STATEMENT_PREFIX, TYPE } from '../library-codes.js';
import { assemble, importUpstream } from './settings-compat.js';
import { readUserModel, writeUserModel } from './user-store.js';
import { bundleDraftsFromFiles, bundleFileFromStore, statedBundleFiles } from './bundle-import.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'user-store-test-'));
const CONTENT = path.join(import.meta.dirname, '../../default/content');
const SHIPPED = JSON.parse(fs.readFileSync(path.join(CONTENT, 'settings.json'), 'utf8'));
const FOLDERS = {
    'preset.openai': 'presets/openai', 'preset.textgenerationwebui': 'presets/textgen', 'preset.novel': 'presets/novel', 'preset.kobold': 'presets/kobold',
    'template.instruct': 'presets/instruct', 'template.context': 'presets/context', 'template.sysprompt': 'presets/sysprompt', 'template.reasoning': 'presets/reasoning',
    'theme': 'themes',
};
/** @type {import('./settings-compat.js').BundleFiles} */
function bundles(group, name) {
    const file = path.join(CONTENT, FOLDERS[group], `${name}.json`);
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : undefined;
}
/** @type {LibraryEngine[]} */
const opened = [];
after(async () => {
    for (const lib of opened) await lib.close();
    fs.rmSync(root, { recursive: true, force: true });
});

function keys() {
    let n = 0;
    return () => `00000000-0000-0000-0000-${String(++n).padStart(12, '0')}`;
}

const card = name => JSON.stringify({ name, description: '', personality: '', scenario: '', first_mes: 'Hi.', mes_example: '', spec: 'chara_card_v2', spec_version: '2.0', data: { name, description: '', personality: '', scenario: '', first_mes: 'Hi.', mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [], tags: [], creator: '', character_version: '', extensions: {} } });

function everything() {
    const settings = structuredClone(SHIPPED);
    const record = { description: 'd', position: 0, depth: 2, role: 0, lorebook: 'Ann lore', title: '', connections: [{ type: 'character', id: 'Bob.png' }] };
    Object.assign(settings.power_user, {
        default_persona: 'a.png',
        persona_data: { 'a.png': { name: 'Ann', ...record } },
        personas: { 'a.png': 'Ann' },
        persona_descriptions: { 'a.png': record },
        servers: [{ label: 'kobold', url: 'http://127.0.0.1:5001', lastConnection: 5 }],
        model_templates_mappings: { 'm.gguf': { instruct: 'ChatML', context: 'ChatML' } },
    });
    settings.user_avatar = 'a.png';
    settings.username = 'Ann';
    settings.proxies = [{ name: 'None', url: '', password: '' }, { name: 'P', url: 'http://p', password: 'x' }];
    settings.selected_proxy = { name: 'P', url: 'http://p', password: 'x' };
    settings.oai_settings.chat_completion_source = 'claude';
    settings.oai_settings.claude_model = 'claude-x';
    Object.assign(settings.extension_settings, {
        connectionManager: { profiles: [{ id: 'p1', mode: 'cc', name: 'Claude', api: 'claude', preset: 'Default', exclude: [] }], selectedProfile: 'p1' },
        regex: [
            { id: 'r2', scriptName: 'second', findRegex: '/b/', replaceString: '', trimStrings: [], placement: [2], disabled: false, markdownOnly: false, promptOnly: false, runOnEdit: true, substituteRegex: 0, minDepth: null, maxDepth: null },
            { id: 'r1', scriptName: 'first', findRegex: '/a/', replaceString: '', trimStrings: [], placement: [1], disabled: false, markdownOnly: false, promptOnly: false, runOnEdit: true, substituteRegex: 0, minDepth: null, maxDepth: null },
        ],
        regex_presets: [{ id: 'rp', name: 'Mine', isSelected: true, global: [{ id: 'r1' }], scoped: [], preset: [] }],
        variables: { global: { score: 3 } },
        attachments: [{ url: '/f.txt', size: 1, name: 'f.txt', created: 1 }],
        character_attachments: { 'Bob.png': [{ url: '/g.txt', size: 2, name: 'g.txt', created: 2 }] },
        disabled_attachments: ['/f.txt'],
        quickReplyV2: { isEnabled: true, isCombined: false, isPopout: false, showPopoutButton: true, config: { setList: [{ set: 'Default', isVisible: true }] }, characterConfigs: { 'Bob.png': { setList: [{ set: 'Default', isVisible: false }] } } },
    });
    settings.extension_settings.caption = { ...settings.extension_settings.caption, source: 'multimodal', multimodal_api: 'anthropic' };
    settings.extension_settings.tts = { ...settings.extension_settings.tts, currentProvider: 'System' };
    return settings;
}

test('a user\'s model comes back from the store as it went in: assembled, the same settings', async () => {
    const lib = await LibraryEngine.open(loadEngine().binding, path.join(root, 'everything'));
    opened.push(lib);
    await lib.writeCard({}, 'Bob.png', card('Bob'));
    const settings = everything();
    const model = importUpstream(settings, { bundles, newKey: keys() });
    const { warnings } = await writeUserModel(lib, 'default-user', model);
    assert.deepEqual(warnings, []);
    const back = await readUserModel(lib, 'default-user');
    assert.ok(back);
    const before = assemble({ ...JSON.parse(JSON.stringify(model)), elsewhere: {} }, { bundles }).settings;
    const after = assemble(/** @type {any} */ (back), { bundles }).settings;
    assert.ok(isDeepStrictEqual(after, before), JSON.stringify(diff(before, after)).slice(0, 2000));
    const bob = await lib.entity(TYPE.character, 'Bob.png');
    const personas = JSON.parse(bob.values.find(v => v.field === `${STATEMENT_PREFIX}personas`).json);
    assert.deepEqual(personas, [String((await lib.ids(TYPE.persona, ['a.png']))[0])]);
});

test('a statement at a character not in the library is kept as it came, warned', async () => {
    const lib = await LibraryEngine.open(loadEngine().binding, path.join(root, 'missing'));
    opened.push(lib);
    const model = importUpstream(everything(), { bundles, newKey: keys() });
    const { warnings } = await writeUserModel(lib, 'default-user', model);
    assert.ok(warnings.some(w => w.includes('Bob.png')));
    const back = await readUserModel(lib, 'default-user');
    assert.deepEqual(back?.statements.personasConnected, [{ holder: { type: 'character', id: 'Bob.png' }, personas: ['a.png'] }]);
    const again = await writeUserModel(lib, 'default-user', /** @type {any} */ (back), { previous: back ?? undefined });
    assert.ok(!again.warnings.some(w => w.includes('Bob.png')));
});

/**
 * @param {any} a
 * @param {any} b
 * @param {string} [at]
 * @returns {string[]}
 */
function diff(a, b, at = '') {
    if (isDeepStrictEqual(a, b)) return [];
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return [`${at}: ${JSON.stringify(a)?.slice(0, 120)} → ${JSON.stringify(b)?.slice(0, 120)}`];
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap(k => diff(a[k], b[k], `${at}.${k}`));
}

test('the bundles\' files go into the store with the model, and assemble from there the same', async () => {
    const lib = await LibraryEngine.open(loadEngine().binding, path.join(root, 'bundles'));
    opened.push(lib);
    await lib.writeCard({}, 'Bob.png', card('Bob'));
    const directories = /** @type {any} */ ({
        openAI_Settings: path.join(CONTENT, 'presets/openai'), textGen_Settings: path.join(CONTENT, 'presets/textgen'),
        novelAI_Settings: path.join(CONTENT, 'presets/novel'), koboldAI_Settings: path.join(CONTENT, 'presets/kobold'),
        instruct: path.join(CONTENT, 'presets/instruct'), context: path.join(CONTENT, 'presets/context'),
        sysprompt: path.join(CONTENT, 'presets/sysprompt'), reasoning: path.join(CONTENT, 'presets/reasoning'),
        themes: path.join(CONTENT, 'themes'), quickreplies: path.join(CONTENT, 'presets/quick-replies'),
    });
    const newKey = keys();
    const model = importUpstream(everything(), { bundles, newKey });
    const imported = bundleDraftsFromFiles(directories, model.entities.filter(e => e.type === TYPE.connection), newKey);
    model.entities.push(...imported.connections);
    await writeUserModel(lib, 'default-user', model, { bundles: imported.bundles });
    const back = /** @type {any} */ (await readUserModel(lib, 'default-user'));
    const fromStore = await statedBundleFiles(lib, back);
    const expected = assemble({ ...JSON.parse(JSON.stringify(model)), elsewhere: {} }, { bundles }).settings;
    const actual = assemble(back, { bundles: fromStore }).settings;
    assert.ok(isDeepStrictEqual(actual, expected), JSON.stringify(diff(expected, actual)).slice(0, 2000));
    const textgen = await bundleFileFromStore(lib, 'preset.textgenerationwebui', 'Deterministic', []);
    assert.ok(textgen);
    assert.deepEqual(textgen, bundles('preset.textgenerationwebui', 'Deterministic'));
    const azure = await bundleFileFromStore(lib, 'theme', 'Azure', []);
    assert.ok(azure);
    assert.deepEqual(azure, bundles('theme', 'Azure'));
    assert.equal(await bundleFileFromStore(lib, 'theme', 'No such theme', []), undefined);
});
