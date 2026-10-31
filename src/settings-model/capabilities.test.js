import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TYPE } from '../library-codes.js';
import { chat_completion_sources } from '../../public/scripts/chat-completion-defaults.js';
import { textgen_types } from '../../public/scripts/textgen-connection-defaults.js';
import { CAPABILITY_SLOTS, FOLLOWS_TEXT_GENERATION, capabilitiesFromUpstream, capabilitiesToUpstream } from './capabilities.js';

const json = value => JSON.parse(JSON.stringify(value));
function keys() {
    let n = 0;
    return () => `k${++n}`;
}

/**
 * @param {Record<string, any>} extensionSettings
 * @param {import('./entity-draft.js').EntityDraft[]} [connections]
 */
function roundTrip(extensionSettings, connections = []) {
    const from = capabilitiesFromUpstream(structuredClone(extensionSettings), connections, keys());
    const stored = json(from);
    const all = [...connections, ...stored.connections];
    return { from, all, back: capabilitiesToUpstream(stored.settings, stored.capabilities, all) };
}

const llama = { type: TYPE.connection, key: 'c-llama', values: { type: 'textgenerationwebui:llamacpp', url: 'http://127.0.0.1:8080' } };

test('a provider that is a text completion backend names the connection text generation has for it', () => {
    const settings = {
        caption: { source: 'multimodal', multimodal_api: 'llamacpp', multimodal_model: 'llamacpp_current', prompt: 'Describe' },
        vectors: { source: 'llamacpp', chunk_size: 500 },
    };
    const { from, back } = roundTrip(settings, [llama]);
    assert.deepEqual(from.capabilities, { captioning: 'c-llama', embeddings: 'c-llama' });
    assert.deepEqual(from.connections, []);
    assert.deepEqual(from.settings.caption, { multimodal_model: 'llamacpp_current', prompt: 'Describe' });
    assert.deepEqual(from.settings.vectors, { chunk_size: 500 });
    assert.deepEqual(back, { settings, warnings: [] });
});

test('a type no connection has gets one; two capabilities on one service share it', () => {
    const settings = { tts: { currentProvider: 'OpenAI', OpenAI: { voice: 'alloy' } }, sd: { source: 'openai', width: 512 }, caption: { source: 'multimodal', multimodal_api: 'anthropic' } };
    const { from, back } = roundTrip(settings);
    assert.deepEqual(from.connections.map(c => [c.key, c.values.type]), [['k1', 'openai:claude'], ['k2', 'openai:openai']]);
    assert.deepEqual(from.capabilities, { captioning: 'k1', tts: 'k2', imageGeneration: 'k2' });
    assert.deepEqual(back.settings, settings);
});

test('browser-run providers, the server\'s own models, Extras, none and the main API', () => {
    const settings = {
        tts: { currentProvider: 'System' },
        vectors: { source: 'webllm' },
        caption: { source: 'local' },
        expressions: { api: 2 },
        sd: { source: 'extras' },
    };
    const { from, all, back } = roundTrip(settings);
    const typeOf = key => all.find(c => c.key === key)?.values.type;
    assert.equal(typeOf(from.capabilities.tts), 'browser:speech-synthesis');
    assert.equal(typeOf(from.capabilities.embeddings), 'browser:webllm');
    assert.equal(typeOf(from.capabilities.captioning), 'transformers');
    assert.equal(typeOf(from.capabilities.imageGeneration), 'extras');
    assert.equal(from.capabilities.classification, FOLLOWS_TEXT_GENERATION);
    assert.deepEqual(back.settings, settings);
    const none = roundTrip({ expressions: { api: 99 } });
    assert.equal(none.from.capabilities.classification, null);
    assert.deepEqual(none.back.settings, { expressions: { api: 99 } });
});

test('Google image generation by its API; a provider these tables don\'t know comes back as it came', () => {
    const settings = {
        sd: { source: 'google', google_api: 'vertexai' },
        tts: { currentProvider: 'My Extension Voice' },
        translate: { provider: 'deepl', deepl_endpoint: 'free' },
        caption: { source: 'multimodal', multimodal_api: 'someday' },
    };
    const { from, all, back } = roundTrip(settings);
    const typeOf = key => all.find(c => c.key === key)?.values.type;
    assert.equal(typeOf(from.capabilities.imageGeneration), 'openai:vertexai');
    assert.equal(typeOf(from.capabilities.tts), 'tts:My Extension Voice');
    assert.equal(typeOf(from.capabilities.translation), 'translation:deepl');
    assert.deepEqual(back.settings, settings);
});

test('a capability naming a connection its extension has no provider for is left out, warned', () => {
    const { settings, warnings } = capabilitiesToUpstream({ expressions: { translate: false } }, { classification: 'c-llama', tts: 'gone' }, [llama]);
    assert.deepEqual(settings, { expressions: { translate: false } });
    assert.equal(warnings.length, 2);
});

test('the slots, and every connection type the tables name is a chat or text completion source there is', () => {
    assert.deepEqual(CAPABILITY_SLOTS, ['captioning', 'classification', 'tts', 'imageGeneration', 'embeddings', 'translation']);
    const settings = {
        caption: ['aimlapi', 'chutes', 'anthropic', 'workers_ai', 'cohere', 'custom', 'electronhub', 'google', 'vertexai', 'groq', 'koboldcpp', 'llamacpp', 'mistral', 'moonshot', 'nanogpt', 'ollama', 'openai', 'openrouter', 'ooba', 'pollinations', 'vllm', 'xai', 'zai'],
        vectors: ['chutes', 'workers_ai', 'cohere', 'electronhub', 'palm', 'vertexai', 'koboldcpp', 'llamacpp', 'mistral', 'nanogpt', 'ollama', 'openai', 'openrouter', 'siliconflow', 'togetherai', 'vllm'],
        sd: ['openai', 'aimlapi', 'togetherai', 'pollinations', 'chutes', 'electronhub', 'nanogpt', 'xai', 'zai', 'openrouter', 'workersai'],
        tts: ['OpenAI', 'Chutes', 'Electron Hub', 'Pollinations', 'MiniMax'],
    };
    const known = new Set([...Object.values(chat_completion_sources).map(s => `openai:${s}`), ...Object.values(textgen_types).map(t => `textgenerationwebui:${t}`)]);
    for (const [extension, values] of Object.entries(settings)) {
        for (const value of values) {
            const one = extension === 'caption' ? { source: 'multimodal', multimodal_api: value } : extension === 'tts' ? { currentProvider: value } : { source: value };
            const { connections } = capabilitiesFromUpstream({ [extension]: one }, [], keys());
            const type = connections[0]?.values.type;
            assert.ok(known.has(String(type)), `${extension} ${value}: ${type}`);
        }
    }
});
