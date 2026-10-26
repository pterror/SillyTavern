import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { DEAD_PATHS, DERIVED_PATHS, assemble, importUpstream } from './settings-compat.js';

const CONTENT = path.join(import.meta.dirname, '../../default/content');
const SHIPPED = JSON.parse(fs.readFileSync(path.join(CONTENT, 'settings.json'), 'utf8'));
const FOLDERS = {
    'preset.openai': 'presets/openai', 'preset.textgenerationwebui': 'presets/textgen', 'preset.novel': 'presets/novel', 'preset.kobold': 'presets/kobold',
    'template.instruct': 'presets/instruct', 'template.context': 'presets/context', 'template.sysprompt': 'presets/sysprompt', 'template.reasoning': 'presets/reasoning',
    'theme': 'themes',
};

/** @type {import('./settings-compat.js').BundleFiles} */
function shippedBundles(group, name) {
    const file = path.join(CONTENT, FOLDERS[group], `${name}.json`);
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : undefined;
}

function keys() {
    let n = 0;
    return () => `k${++n}`;
}

/**
 * Every leaf of an object (arrays whole), by its keys.
 * @param {unknown} value
 * @param {string[]} [prefix]
 * @returns {[string[], unknown][]}
 */
function leaves(value, prefix = []) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || (prefix.length && Object.keys(value).length === 0)) return [[prefix, value]];
    return Object.entries(value).flatMap(([key, inner]) => leaves(inner, [...prefix, key]));
}

/**
 * @param {Record<string, any>} object
 * @param {string | string[]} path Dotted, or its keys.
 */
function at(object, path) {
    const keys = Array.isArray(path) ? path : path.split('.');
    return keys.reduce((value, key) => (value && typeof value === 'object' ? value[key] : undefined), object);
}

/**
 * The two-way translation's documented losses (the settings model §2.4), each a path and why.
 * @type {Record<string, string>}
 */
const LOSSY = {
    // §2.4.12: the current and the default persona are one user-level persona, the default, else the current.
    'power_user.default_persona': 'user-level persona',
};

/**
 * Imports and assembles, through JSON as the store holds it.
 * @param {Record<string, any>} settings
 */
function roundTrip(settings) {
    const model = importUpstream(structuredClone(settings), { bundles: shippedBundles, newKey: keys() });
    const { settings: back, warnings } = assemble(JSON.parse(JSON.stringify(model)), { bundles: shippedBundles, extrasApiKey: settings.extension_settings?.apiKey });
    return { model, back, warnings };
}

/**
 * The leaves of `settings` that `back` doesn't give back, less the dead and derived ones.
 * @param {Record<string, any>} settings
 * @param {Record<string, any>} back
 */
function lost(settings, back) {
    const skipped = [...DEAD_PATHS, ...DERIVED_PATHS, ...Object.keys(LOSSY)];
    return leaves(settings)
        .filter(([keys]) => !skipped.some(p => keys.join('.') === p || keys.join('.').startsWith(`${p}.`)))
        .filter(([keys, value]) => !isDeepStrictEqual(at(back, keys), value)) // §2.4.7: key order is the model's
        .map(([keys, value]) => `${keys.join('.')}: ${JSON.stringify(value)?.slice(0, 80)} → ${JSON.stringify(at(back, keys))?.slice(0, 80)}`);
}

test('the shipped settings come back as they came, but what is dead or derived', () => {
    const { model, back, warnings } = roundTrip(SHIPPED);
    assert.deepEqual(lost(SHIPPED, back), []);
    assert.deepEqual(warnings, []);
    // The selected bundles are statements, and an unsaved edit is an override.
    assert.equal(model.user.bundles['preset.openai'], 'openai:Default');
    assert.equal(model.user.bundles.theme, 'Dark Lite');
    for (const path of DEAD_PATHS) assert.equal(at(back, path), undefined, path);
    // The shipped file has no default persona: the current one becomes the user's.
    assert.equal(back.power_user.default_persona, SHIPPED.user_avatar);
});

test('a live value the selected preset doesn\'t have is an override; the preset\'s own values are not stored', () => {
    const settings = structuredClone(SHIPPED);
    const preset = shippedBundles('preset.textgenerationwebui', settings.textgenerationwebui_settings.preset);
    settings.textgenerationwebui_settings = { ...settings.textgenerationwebui_settings, ...structuredClone(preset), preset: settings.textgenerationwebui_settings.preset };
    delete settings.textgenerationwebui_settings.genamt;
    delete settings.textgenerationwebui_settings.max_length;
    settings.textgenerationwebui_settings.temp = 1.234;
    const { model, back } = roundTrip(settings);
    const textOverrides = Object.keys(model.user.overrides).filter(k => k.startsWith('preset.textgenerationwebui/'));
    assert.deepEqual(textOverrides, ['preset.textgenerationwebui/temp']);
    assert.deepEqual(lost(settings, back), []);
});

test('a selection naming a bundle there isn\'t keeps its name, every live value an override, warned', () => {
    const settings = structuredClone(SHIPPED);
    settings.power_user.theme = 'Gone';
    const { model, back } = roundTrip(settings);
    const warnings = model.warnings;
    assert.equal(model.user.bundles.theme, 'Gone');
    assert.ok(warnings.some(w => w.includes('"Gone"')));
    assert.deepEqual(lost(settings, back), []);
});

test('dead keys are dropped, warned; unknown ones kept as they came, warned', () => {
    const settings = structuredClone(SHIPPED);
    settings.selected_button = 'settings';
    settings.power_user.movingUIState = { sheld: { top: 1 } };
    settings.someday_key = { a: 1 };
    const { model, back } = roundTrip(settings);
    assert.equal(back.selected_button, undefined);
    assert.equal(back.power_user.movingUIState, undefined);
    assert.deepEqual(back.someday_key, { a: 1 });
    assert.ok(model.warnings.some(w => w.startsWith('selected_button')));
    assert.ok(model.warnings.some(w => w.startsWith('someday_key')));
});

test('a settings file using every catalog comes back as it came', () => {
    const settings = structuredClone(SHIPPED);
    Object.assign(settings.power_user, {
        default_persona: 'a.png',
        persona_data: { 'a.png': { name: 'Ann', description: 'd', position: 0, depth: 2, role: 0, lorebook: '', title: '', connections: [{ type: 'character', id: 'Bob.png' }] } },
        servers: [{ label: 'kobold', url: 'http://127.0.0.1:5001', lastConnection: 5 }],
        model_templates_mappings: { 'm.gguf': { instruct: 'ChatML', context: 'ChatML' } },
    });
    settings.power_user.personas = { 'a.png': 'Ann' };
    settings.power_user.persona_descriptions = { 'a.png': { description: 'd', position: 0, depth: 2, role: 0, lorebook: '', title: '', connections: [{ type: 'character', id: 'Bob.png' }] } };
    settings.user_avatar = 'a.png';
    settings.username = 'Ann';
    settings.proxies = [{ name: 'None', url: '', password: '' }, { name: 'P', url: 'http://p', password: 'x' }];
    settings.selected_proxy = { name: 'P', url: 'http://p', password: 'x' };
    settings.oai_settings.chat_completion_source = 'claude';
    settings.oai_settings.claude_model = 'claude-x';
    settings.oai_settings.bias_presets = { 'Default (none)': [], Mine: [{ id: 'b1', text: 'hi', value: 5 }] };
    Object.assign(settings.extension_settings, {
        connectionManager: { profiles: [{ id: 'p1', mode: 'cc', name: 'Claude', api: 'claude', preset: 'Default', exclude: [] }], selectedProfile: 'p1' },
        regex: [{ id: 'r1', scriptName: 'x', findRegex: '/a/', replaceString: 'b', trimStrings: [], placement: [2], disabled: false, markdownOnly: false, promptOnly: false, runOnEdit: true, substituteRegex: 0, minDepth: null, maxDepth: null }],
        regex_presets: [{ id: 'rp', name: 'Mine', isSelected: true, global: [{ id: 'r1' }], scoped: [], preset: [] }],
        variables: { global: { score: 3 } },
        attachments: [{ url: '/f.txt', size: 1, name: 'f.txt', created: 1 }],
        character_attachments: { 'Bob.png': [{ url: '/g.txt', size: 2, name: 'g.txt', created: 2 }] },
        disabled_attachments: ['/f.txt'],
        quickReplyV2: { isEnabled: true, isCombined: false, isPopout: false, showPopoutButton: true, config: { setList: [{ set: 'Default', isVisible: true }] }, characterConfigs: {} },
    });
    settings.extension_settings.caption = { ...settings.extension_settings.caption, source: 'multimodal', multimodal_api: 'anthropic' };
    settings.extension_settings.tts = { ...settings.extension_settings.tts, currentProvider: 'System' };
    const { model, back, warnings } = roundTrip(settings);
    assert.deepEqual(lost(settings, back), []);
    assert.deepEqual(warnings, []);
    // Captioning through Claude is the Claude connection text generation has.
    const claude = model.entities.find(e => e.values.type === 'openai:claude');
    assert.equal(model.statements.capabilities.captioning, claude.key);
});
