import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { TYPE } from '../library-codes.js';
import { CONNECTION_PRESET_KEYS, chatCompletionSettingsWithDefaults } from '../../public/scripts/chat-completion-defaults.js';
import { textgen_connection_defaults } from '../../public/scripts/textgen-connection-defaults.js';
import { COVERED, chatConnectionsFromUpstream, chatConnectionsToUpstream, connectionsFromUpstream, connectionsToUpstream } from './connections.js';

const SHIPPED = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '../../default/content/settings.json'), 'utf8'));

function keys() {
    let n = 0;
    return () => `c${++n}`;
}

/**
 * Upstream's settings with every connection key its page would hold.
 * @param {Record<string, any>} settings
 */
function filled(settings) {
    return {
        main_api: settings.main_api,
        oai_settings: chatCompletionSettingsWithDefaults(settings.oai_settings),
        textgenerationwebui_settings: { ...structuredClone(textgen_connection_defaults), ...settings.textgenerationwebui_settings },
        kai_settings: { api_server: '', ...settings.kai_settings },
        nai_settings: settings.nai_settings,
        horde_settings: settings.horde_settings,
        extras: { apiUrl: 'http://localhost:5100', autoConnect: false },
    };
}

/**
 * The connection keys of upstream's settings, to compare.
 * @param {Record<string, any>} settings
 */
function connectionKeys(settings) {
    const pick = (object, list) => Object.fromEntries(list.filter(key => Object.hasOwn(object ?? {}, key)).map(key => [key, object[key]]));
    return {
        main_api: settings.main_api,
        oai_settings: pick(settings.oai_settings, COVERED.chat),
        textgenerationwebui_settings: pick(settings.textgenerationwebui_settings, [...COVERED.text, 'type']),
        kai_settings: pick(settings.kai_settings, ['api_server']),
        nai_settings: pick(settings.nai_settings, ['model_novel']),
        horde_settings: settings.horde_settings ?? {},
        extras: settings.extras,
    };
}

/**
 * @param {import('./connections.js').UpstreamConnectionSettings} settings
 */
function roundTrip(settings) {
    const from = connectionsFromUpstream(structuredClone(settings), keys());
    const stored = JSON.parse(JSON.stringify(from));
    return { from, back: connectionsToUpstream(stored.connections, stored) };
}

test('the tables cover every connection key of a chat completion preset and of text completion', () => {
    assert.deepEqual([...COVERED.chat].sort(), [...CONNECTION_PRESET_KEYS].sort());
    assert.deepEqual([...COVERED.text].sort(), Object.keys(textgen_connection_defaults).sort());
});

test('the shipped settings\' connections come back as they came', () => {
    const settings = filled(SHIPPED);
    const { from, back } = roundTrip(settings);
    assert.deepEqual(connectionKeys(back), connectionKeys(settings));
    // Horde is the shipped API: its connection is text generation's.
    assert.equal(from.connections.find(c => c.key === from.textGeneration)?.values.type, 'horde');
    // Only the selected chat completion source, the rest being defaults.
    assert.deepEqual(from.connections.filter(c => String(c.values.type).startsWith('openai:')).map(c => c.values.type), ['openai:openai']);
    assert.ok(from.connections.every(c => c.type === TYPE.connection));
});

test('a source with a value of its own gets a connection; the selected one is text generation\'s, shared values on each', () => {
    const settings = filled({
        main_api: 'openai',
        oai_settings: { chat_completion_source: 'claude', claude_model: 'claude-x', openrouter_model: 'meta/llama', reverse_proxy: 'http://proxy', group_models: true },
    });
    const { from, back } = roundTrip(settings);
    const byType = Object.fromEntries(from.connections.map(c => [c.values.type, c]));
    assert.equal(from.textGeneration, byType['openai:claude'].key);
    assert.equal(byType['openai:claude'].values.model, 'claude-x');
    assert.equal(byType['openai:openrouter'].values.model, 'meta/llama');
    assert.equal(byType['openai:openrouter'].values.reverse_proxy, 'http://proxy');
    assert.equal(byType['openai:openai'], undefined);
    assert.equal(from.preferences.group_models, true);
    assert.deepEqual(connectionKeys(back), connectionKeys(settings));
});

test('the other families\' selected connections are remembered, and switching back finds them', () => {
    const settings = filled({
        main_api: 'textgenerationwebui',
        oai_settings: { chat_completion_source: 'openrouter' },
        textgenerationwebui_settings: { type: 'llamacpp', server_urls: { llamacpp: 'http://127.0.0.1:8080', koboldcpp: 'http://127.0.0.1:5001' }, llamacpp_model: 'm.gguf' },
    });
    const { from, back } = roundTrip(settings);
    const typeOf = key => from.connections.find(c => c.key === key)?.values.type;
    assert.equal(typeOf(from.textGeneration), 'textgenerationwebui:llamacpp');
    assert.equal(typeOf(from.remembered.openai), 'openai:openrouter');
    assert.equal(from.remembered.textgenerationwebui, undefined);
    assert.deepEqual(from.connections.filter(c => c.values.type === 'textgenerationwebui:koboldcpp').map(c => c.values.url), ['http://127.0.0.1:5001']);
    assert.deepEqual(connectionKeys(back), connectionKeys(settings));
    // Text generation on the remembered chat completion connection: main_api and the source follow it.
    const switched = connectionsToUpstream(from.connections, { textGeneration: from.remembered.openai, remembered: { textgenerationwebui: from.textGeneration } });
    assert.equal(switched.main_api, 'openai');
    assert.equal(switched.oai_settings.chat_completion_source, 'openrouter');
    assert.equal(switched.textgenerationwebui_settings.type, 'llamacpp');
});

test('the Extras key goes to secrets, and comes back from them', () => {
    const settings = filled({ main_api: 'kobold' });
    settings.extras = { apiUrl: 'http://extras', apiKey: 'k', autoConnect: true };
    const from = connectionsFromUpstream(settings, keys());
    const extras = from.connections.find(c => c.values.type === 'extras');
    assert.deepEqual(extras.values, { type: 'extras', url: 'http://extras', autoConnect: true });
    assert.deepEqual(from.secrets, [{ connection: extras.key, value: 'k' }]);
    assert.deepEqual(connectionsToUpstream(from.connections, { ...from, extrasApiKey: 'k' }).extras, settings.extras);
});

test('a chat completion preset\'s connection keys: the connection of its source, and back', () => {
    const preset = chatCompletionSettingsWithDefaults({ chat_completion_source: 'custom', custom_url: 'http://local/v1', custom_model: 'qwen' });
    const flat = Object.fromEntries(CONNECTION_PRESET_KEYS.map(key => [key, preset[key]]));
    const { connections, selected } = chatConnectionsFromUpstream(flat, keys());
    const chosen = connections.find(c => c.key === selected);
    assert.deepEqual([chosen.values.type, chosen.values.url, chosen.values.model], ['openai:custom', 'http://local/v1', 'qwen']);
    assert.deepEqual(chatConnectionsToUpstream(connections, chosen, { group_models: flat.group_models, sort_models: flat.sort_models, show_external_models: flat.show_external_models }), flat);
});
