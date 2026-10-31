import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { TYPE } from '../library-codes.js';
import { CONNECTION_PRESET_KEYS } from '../../public/scripts/chat-completion-defaults.js';
import { biasListFromUpstream, biasListToUpstream, presetFromUpstream, presetToUpstream } from './sampler-presets.js';

const PRESETS = path.join(import.meta.dirname, '../../default/content/presets');
const FOLDERS = { openai: 'openai', textgenerationwebui: 'textgen', novel: 'novel', kobold: 'kobold' };

/**
 * @param {string} api
 * @param {string} name
 * @param {Record<string, any>} file
 */
function roundTrip(api, name, file) {
    const { preset, connection, warnings } = presetFromUpstream(api, name, structuredClone(file));
    const stored = JSON.parse(JSON.stringify({ preset, connection }));
    return { back: presetToUpstream(stored.preset, stored.connection), preset, connection, warnings };
}

for (const [api, folder] of Object.entries(FOLDERS)) {
    test(`every shipped ${folder} preset comes back as it came`, () => {
        const files = fs.readdirSync(path.join(PRESETS, folder)).filter(file => file.endsWith('.json'));
        assert.ok(files.length > 0);
        for (const file of files) {
            const json = JSON.parse(fs.readFileSync(path.join(PRESETS, folder, file), 'utf8'));
            const { back, warnings } = roundTrip(api, path.basename(file, '.json'), json);
            assert.deepEqual(back, json, file);
            assert.deepEqual(warnings, [], file);
        }
    });
}

test('a chat completion preset: its connection keys go to the connection, its prompts and orders are parts', () => {
    const file = {
        temperature: 0.7,
        chat_completion_source: 'openai',
        openai_model: 'gpt-4o',
        prompts: [{ identifier: 'main', name: 'Main', content: 'Hi' }, { identifier: 'nsfw', name: 'NSFW', content: '' }],
        prompt_order: [{ character_id: 100001, order: [{ identifier: 'nsfw', enabled: false }, { identifier: 'main', enabled: true }] }],
        extensions: { regex: [{ id: 'x' }] },
    };
    const { preset, connection, back } = roundTrip('openai', 'Mine', file);
    assert.equal(preset.type, TYPE.samplerPreset);
    assert.equal(preset.key, 'openai:Mine');
    assert.deepEqual(preset.values, { temperature: 0.7, extensions: { regex: [{ id: 'x' }] } });
    assert.ok(CONNECTION_PRESET_KEYS.includes('chat_completion_source'));
    assert.deepEqual(connection, { chat_completion_source: 'openai', openai_model: 'gpt-4o' });
    assert.deepEqual(preset.lists[5].map(part => [part.type, part.key]), [
        [TYPE.chatPrompt, 'openai:Mine:main'], [TYPE.chatPrompt, 'openai:Mine:nsfw'],
    ]);
    assert.equal(Object.hasOwn(preset.lists[5][0].values, 'identifier'), false);
    const order = preset.lists[6][0];
    assert.equal(order.type, TYPE.chatPromptOrder);
    assert.equal(order.key, 'openai:Mine:100001');
    assert.deepEqual(order.lists, { 0: ['nsfw', 'main'], 1: ['nsfw'] });
    assert.deepEqual(back, file);
});

test('lists of scalars keep their values\' types', () => {
    const file = { temp: 1, sampler_order: [6, 0, 1], samplers: ['top_k', 'min_p'], sampler_priority: [] };
    const { preset, back } = roundTrip('textgenerationwebui', 'S', file);
    assert.deepEqual(preset.lists, { 0: ['6', '0', '1'], 1: ['"top_k"', '"min_p"'], 2: [] });
    assert.deepEqual(back, file);
});

test('a key not of the shape modeled stays a value', () => {
    const file = { sampler_order: 'broken', logit_bias: null };
    const { preset, back } = roundTrip('kobold', 'K', file);
    assert.deepEqual(preset.values, file);
    assert.deepEqual(back, file);
});

test('logit bias entries are parts keyed by their ids; a missing or repeated id is kept under its place, with a warning', () => {
    const file = { logit_bias: [{ id: 'a', text: 'x', value: 5 }, { text: 'y', value: -1 }, { id: 'a', text: 'z', value: 0 }] };
    const { preset, back, warnings } = roundTrip('novel', 'N', file);
    assert.deepEqual(preset.lists[4].map(part => [part.type, part.key]), [
        [TYPE.biasEntry, 'novel:N:a'], [TYPE.biasEntry, 'novel:N:#1'], [TYPE.biasEntry, 'novel:N:#2'],
    ]);
    assert.equal(warnings.length, 2);
    assert.deepEqual(back, file);
});

test('a prompt with no or a repeated identifier is kept under its place, with a warning', () => {
    const file = { prompts: [{ identifier: 'main' }, { name: 'none' }, { identifier: 'main', content: 'again' }] };
    const { preset, back, warnings } = roundTrip('openai', 'P', file);
    assert.deepEqual(preset.lists[5].map(part => part.key), ['openai:P:main', 'openai:P:#1', 'openai:P:#2']);
    assert.equal(warnings.length, 2);
    assert.deepEqual(back, file);
});

test('a chat completion bias list is a catalog entity with its entries as parts', () => {
    const entries = [{ id: 'u1', text: 'Hello', value: 10 }, { id: 'u2', text: 'Bye', value: -50 }];
    const { list, warnings } = biasListFromUpstream('Default (none)', structuredClone(entries));
    assert.equal(list.type, TYPE.biasList);
    assert.equal(list.key, 'Default (none)');
    assert.deepEqual(list.lists[0].map(part => part.key), ['Default (none):u1', 'Default (none):u2']);
    assert.deepEqual(warnings, []);
    assert.deepEqual(biasListToUpstream(JSON.parse(JSON.stringify(list))), entries);
    assert.deepEqual(biasListToUpstream(biasListFromUpstream('Empty', []).list), []);
});

test('an unknown family is refused', () => {
    assert.throws(() => presetFromUpstream('horde', 'x', {}));
});
