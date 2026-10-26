import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { DEAD_PATHS, applyWrites, assemble, importUpstream, lostLeaves, routeSave, unitOfPath } from './settings-compat.js';

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
 * @param {Record<string, any>} object
 * @param {string | string[]} path Dotted, or its keys.
 */
function at(object, path) {
    const keys = Array.isArray(path) ? path : path.split('.');
    return keys.reduce((value, key) => (value && typeof value === 'object' ? value[key] : undefined), object);
}

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
 * The leaves of `settings` that `back` doesn't give back, as text.
 * @param {Record<string, any>} settings
 * @param {Record<string, any>} back
 */
function lost(settings, back) {
    return lostLeaves(settings, back).map(l => `${l.path.join('.')}: ${JSON.stringify(l.before)?.slice(0, 80)} → ${JSON.stringify(l.after)?.slice(0, 80)}`);
}

test('the shipped settings come back as they came, but what is dead or derived', () => {
    const { model, back, warnings } = roundTrip(SHIPPED);
    assert.deepEqual(lost(SHIPPED, back), []);
    assert.deepEqual(warnings, []);
    // The selected bundles are statements, and an unsaved edit is an override.
    assert.equal(model.user.bundles['preset.openai'], 'openai:Default');
    assert.equal(model.user.bundles.theme, 'Dark Lite');
    for (const path of DEAD_PATHS) assert.equal(at(back, path), undefined, path);
    // The shipped file has no default persona, and the current one is its own.
    assert.equal(back.power_user.default_persona, null);
    assert.equal(back.user_avatar, SHIPPED.user_avatar);
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

/**
 * The shipped settings as the model, and what assemble gives for it.
 */
function shippedModel() {
    const model = JSON.parse(JSON.stringify(importUpstream(structuredClone(SHIPPED), { bundles: shippedBundles, newKey: keys() })));
    const { settings } = assemble(model, { bundles: shippedBundles });
    return { model, settings };
}

test('upstream paths name their units in the model', () => {
    assert.deepEqual(unitOfPath(['oai_settings', 'temp_openai']), { kind: 'field', field: 'preset.openai/temperature', path: 'oai_settings.temp_openai' });
    assert.deepEqual(unitOfPath(['oai_settings', 'claude_model']), { kind: 'connection', path: 'oai_settings.claude_model' });
    assert.deepEqual(unitOfPath(['oai_settings', 'preset_settings_openai']), { kind: 'selection', group: 'preset.openai', path: 'oai_settings.preset_settings_openai' });
    assert.deepEqual(unitOfPath(['textgenerationwebui_settings', 'temp']), { kind: 'field', field: 'preset.textgenerationwebui/temp', path: 'textgenerationwebui_settings.temp' });
    assert.deepEqual(unitOfPath(['textgenerationwebui_settings', 'streaming']), { kind: 'field', field: 'textgenerationwebui_settings.streaming', path: 'textgenerationwebui_settings.streaming' });
    assert.deepEqual(unitOfPath(['power_user', 'instruct', 'input_sequence']), { kind: 'field', field: 'template.instruct/input_sequence', path: 'power_user.instruct.input_sequence' });
    assert.deepEqual(unitOfPath(['power_user', 'instruct', 'enabled']), { kind: 'field', field: 'power_user.instruct.enabled', path: 'power_user.instruct.enabled' });
    assert.deepEqual(unitOfPath(['power_user', 'trim_sentences']), { kind: 'field', field: 'template.context/trim_sentences', path: 'power_user.trim_sentences' });
    assert.deepEqual(unitOfPath(['power_user', 'main_text_color']), { kind: 'field', field: 'theme/main_text_color', path: 'power_user.main_text_color' });
    assert.deepEqual(unitOfPath(['power_user', 'stscript', 'parser', 'flags']), { kind: 'field', field: 'power_user.stscript', path: 'power_user.stscript' });
    assert.deepEqual(unitOfPath(['extension_settings', 'dice', 'x']), { kind: 'ext', key: 'dice' });
    assert.deepEqual(unitOfPath(['extension_settings', 'regex', '0']), { kind: 'catalog', path: 'extension_settings.regex' });
    assert.deepEqual(unitOfPath(['power_user', 'movingUIState']), { kind: 'ignored', path: 'power_user.movingUIState' });
    assert.deepEqual(unitOfPath(['amount_gen']), { kind: 'field', field: 'amount_gen', path: 'amount_gen' });
    assert.deepEqual(unitOfPath(['someday']), { kind: 'unknown', key: 'someday' });
});

test('saving what assemble gave routes nothing', () => {
    const { model, settings } = shippedModel();
    assert.deepEqual(routeSave(model, structuredClone(settings), { bundles: shippedBundles }), []);
});

test('a sampler edit is an override; setting it back to the preset\'s value removes it', () => {
    const { model, settings } = shippedModel();
    const edited = structuredClone(settings);
    edited.oai_settings.temp_openai = 0.123;
    const writes = routeSave(model, edited, { bundles: shippedBundles });
    assert.deepEqual(writes, [{ op: 'set', field: 'preset.openai/temperature', value: 0.123 }]);
    const after = applyWrites(model, writes);
    const preset = shippedBundles('preset.openai', 'Default');
    const back = structuredClone(edited);
    back.oai_settings.temp_openai = preset.temperature;
    assert.deepEqual(routeSave(after, back, { bundles: shippedBundles }), [{ op: 'delete', field: 'preset.openai/temperature' }]);
});

test('selecting a theme with its values loaded is one statement, dropping the old theme\'s edits', () => {
    const { model, settings } = shippedModel();
    const edited = structuredClone(settings);
    edited.power_user.main_text_color = 'rgb(1, 2, 3)';
    const withEdit = applyWrites(model, routeSave(model, edited, { bundles: shippedBundles }));
    assert.equal(withEdit.user.overrides['theme/main_text_color'], 'rgb(1, 2, 3)');
    const azure = shippedBundles('theme', 'Azure');
    const switched = structuredClone(edited);
    switched.power_user.theme = 'Azure';
    for (const [key, value] of Object.entries(azure)) if (key !== 'name') switched.power_user[key] = value;
    const writes = routeSave(withEdit, switched, { bundles: shippedBundles });
    // Azure's fields replace the edits of them; an edit of a field Azure doesn't hold would stay.
    const replaced = Object.keys(withEdit.user.overrides).filter(field => field.startsWith('theme/') && Object.hasOwn(azure, field.slice('theme/'.length)));
    assert.ok(replaced.includes('theme/main_text_color'));
    assert.deepEqual(writes, [{ op: 'bundle', group: 'theme', ref: 'Azure', drop: replaced }]);
    const after = applyWrites(withEdit, writes);
    assert.deepEqual(routeSave(after, switched, { bundles: shippedBundles }), []);
});

test('a preference, an extension\'s own settings, a connection key and an unknown key', () => {
    const { model, settings } = shippedModel();
    const edited = structuredClone(settings);
    edited.power_user.auto_swipe = !settings.power_user.auto_swipe;
    edited.extension_settings.dice = { ...settings.extension_settings.dice, rolled: 1 };
    edited.oai_settings.claude_model = 'claude-y';
    edited.someday = 1;
    const writes = routeSave(model, edited, { bundles: shippedBundles });
    assert.deepEqual(writes, [
        { op: 'set', field: 'power_user.auto_swipe', value: edited.power_user.auto_swipe },
        { op: 'ext', key: 'dice', value: edited.extension_settings.dice },
        { op: 'connection', path: 'oai_settings.claude_model', value: 'claude-y' },
        { op: 'unknown', key: 'someday', value: 1 },
    ].sort((a, b) => writes.findIndex(w => w.op === a.op) - writes.findIndex(w => w.op === b.op)));
    const after = applyWrites(model, writes.filter(w => w.op !== 'connection'));
    const { settings: back } = assemble(after, { bundles: shippedBundles });
    assert.equal(back.power_user.auto_swipe, edited.power_user.auto_swipe);
    assert.deepEqual(back.extension_settings.dice, edited.extension_settings.dice);
    assert.equal(back.someday, 1);
});

test('KoboldAI with no preset: \'gui\' stays the choice, and none stated stays none (the page reads its fallback)', () => {
    const none = structuredClone(SHIPPED);
    delete none.kai_settings.preset_settings;
    assert.equal(roundTrip(none).back.kai_settings?.preset_settings, undefined);
    const gui = structuredClone(SHIPPED);
    gui.kai_settings.preset_settings = 'gui';
    const { model, back } = roundTrip(gui);
    assert.equal(back.kai_settings.preset_settings, 'gui');
    assert.equal(model.user.bundles['preset.kobold'], undefined);
});

test('a field the settings lack stays the page\'s default, not the selected bundle\'s', () => {
    assert.equal(Object.hasOwn(SHIPPED.power_user, 'bogus_folders'), false);
    assert.equal(shippedBundles('theme', SHIPPED.power_user.theme).bogus_folders, true);
    const { model, back } = roundTrip(SHIPPED);
    assert.equal(Object.hasOwn(back.power_user, 'bogus_folders'), false);
    assert.deepEqual(model.user.overrides['theme/bogus_folders'], { $default: true });
});
