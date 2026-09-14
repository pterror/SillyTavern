import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ZAI_ENDPOINT, POLLINATIONS_ENDPOINT, MINIMAX_ENDPOINT } from './constants.js';
// chat-completion-generation-data.js now statically imports src/endpoints/tokenizers.js (for real
// logit_bias computation), which pulls in code that reads process-wide config at MODULE IMPORT
// time (e.g. src/endpoints/secrets.js) - the config path must be set before that import chain
// runs, same approach as src/tokenizer-resolve.test.js and src/novel-generation-data.test.js.
import { setConfigFilePath } from './util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
setConfigFilePath(path.join(__dirname, '..', 'config.yaml'));

const { createGenerationParameters } = await import('./chat-completion-generation-data.js');

function baseSettings(overrides = {}) {
    return {
        chat_completion_source: 'openai',
        temp_openai: 1.0,
        freq_pen_openai: 0,
        pres_pen_openai: 0,
        top_p_openai: 1.0,
        top_k_openai: 0,
        min_p_openai: 0,
        top_a_openai: 0,
        repetition_penalty_openai: 1,
        openai_max_tokens: 300,
        stream_openai: false,
        n: 1,
        show_thoughts: false,
        reasoning_effort: 'auto',
        enable_web_search: false,
        request_images: false,
        request_image_resolution: 'standard',
        request_image_aspect_ratio: 'square',
        custom_prompt_post_processing: '',
        verbosity: 'auto',
        seed: -1,
        ...overrides,
    };
}

const messages = [{ role: 'user', content: 'hi' }];

// Basic OpenAI shape, no routing fields leak
{
    const { generate_data, stream, canMultiSwipe } = await createGenerationParameters(baseSettings(), 'gpt-4o', 'normal', messages);
    assert.equal(generate_data.model, 'gpt-4o');
    assert.equal(generate_data.chat_completion_source, 'openai');
    assert.deepEqual(generate_data.messages, messages);
    assert.equal(stream, false);
    assert.equal(canMultiSwipe, false);
    assert.equal(generate_data.api_type, undefined);
    assert.equal(generate_data.api_server, undefined);
}

// canMultiSwipe: n>1, multiswipe-supported source, non-excluded type
{
    const { canMultiSwipe, generate_data } = await createGenerationParameters(baseSettings({ n: 3 }), 'gpt-4o', 'normal', messages);
    assert.equal(canMultiSwipe, true);
    assert.equal(generate_data.n, 3);
}
// canMultiSwipe false for quiet/impersonate/continue even with n>1
{
    const { canMultiSwipe, generate_data } = await createGenerationParameters(baseSettings({ n: 3 }), 'gpt-4o', 'quiet', messages);
    assert.equal(canMultiSwipe, false);
    assert.equal(generate_data.n, undefined);
}

// o1 model: max_completion_tokens instead of max_tokens, sampler fields stripped, system->user role rewrite
{
    const { generate_data } = await createGenerationParameters(baseSettings(), 'o1', 'normal', [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }]);
    assert.equal(generate_data.max_tokens, undefined);
    assert.equal(generate_data.max_completion_tokens, 300);
    assert.equal(generate_data.temperature, undefined);
    assert.equal(generate_data.messages[0].role, 'user');
}

// gpt-5: max_completion_tokens, and a gpt-5.1 with no reasoning_effort strips penalty/logit_bias/stop
{
    const { generate_data } = await createGenerationParameters(baseSettings({ reasoning_effort: 'auto' }), 'gpt-5.1', 'normal', messages, {
        getStoppingStrings: () => ['STOP'],
    });
    assert.equal(generate_data.max_completion_tokens, 300);
    assert.equal(generate_data.frequency_penalty, undefined);
    assert.equal(generate_data.stop, undefined);
}

// Claude: top_k/use_sysprompt/assistant_prefill, unlimited stop strings (getStoppingStrings called with no limit)
{
    let capturedLimit = 'not called';
    const { generate_data } = await createGenerationParameters(
        baseSettings({ chat_completion_source: 'claude', top_k_openai: 5, use_sysprompt: true, assistant_prefill: 'Well,' }),
        'claude-sonnet-4', 'normal', messages,
        { getStoppingStrings: (limit) => { capturedLimit = limit; return []; }, macroContext: { name1: 'Alice', name2: 'Bob' } },
    );
    assert.equal(generate_data.top_k, 5);
    assert.equal(generate_data.use_sysprompt, true);
    assert.equal(generate_data.assistant_prefill, 'Well,');
    assert.equal(capturedLimit, undefined, 'Claude calls getStoppingStrings() with no limit');
}

// Claude: no prefill on quiet type
{
    const { generate_data } = await createGenerationParameters(
        baseSettings({ chat_completion_source: 'claude', assistant_prefill: 'Well,' }),
        'claude-sonnet-4', 'quiet', messages,
    );
    assert.equal(generate_data.assistant_prefill, undefined);
}

// Claude 5/Fable/Opus-5/Sonnet-5: sampling params stripped, but reasoning_effort kept (native Claude source)
{
    const { generate_data } = await createGenerationParameters(
        baseSettings({ chat_completion_source: 'claude', reasoning_effort: 'high' }),
        'claude-sonnet-5', 'normal', messages,
    );
    assert.equal(generate_data.temperature, undefined);
    assert.equal(generate_data.top_p, undefined);
    assert.equal(generate_data.reasoning_effort, 'high');
}
// Same Claude-5-class model via a non-Claude source (proxy): reasoning_effort also stripped
{
    const { generate_data } = await createGenerationParameters(
        baseSettings({ chat_completion_source: 'custom', reasoning_effort: 'high' }),
        'claude-sonnet-5', 'normal', messages,
    );
    assert.equal(generate_data.reasoning_effort, undefined);
}

// OpenRouter-specific fields
{
    const { generate_data } = await createGenerationParameters(
        baseSettings({
            chat_completion_source: 'openrouter', top_k_openai: 3, min_p_openai: 0.1,
            openrouter_providers: ['a'], openrouter_quantizations: ['fp8'], openrouter_allow_fallbacks: true, openrouter_middleout: 'auto',
        }),
        'anthropic/claude-3', 'normal', messages,
    );
    assert.equal(generate_data.top_k, 3);
    assert.equal(generate_data.min_p, 0.1);
    assert.deepEqual(generate_data.provider, ['a']);
    assert.deepEqual(generate_data.quantizations, ['fp8']);
    assert.equal(generate_data.allow_fallbacks, true);
    assert.equal(generate_data.middleout, 'auto');
}

// OpenRouter o1-prefixed model routes through the o1 max_completion_tokens branch too
{
    const { generate_data } = await createGenerationParameters(baseSettings({ chat_completion_source: 'openrouter' }), 'openai/o1', 'normal', messages);
    assert.equal(generate_data.max_completion_tokens, 300);
    assert.equal(generate_data.max_tokens, undefined);
}

// Cohere: clamping
{
    const { generate_data } = await createGenerationParameters(
        baseSettings({ chat_completion_source: 'cohere', top_p_openai: 5, freq_pen_openai: -3, pres_pen_openai: 3 }),
        'command-r', 'normal', messages,
    );
    assert.equal(generate_data.top_p, 0.99);
    assert.equal(generate_data.frequency_penalty, 0);
    assert.equal(generate_data.presence_penalty, 1);
}

// MiniMax: temperature clamped away from 0
{
    const { generate_data } = await createGenerationParameters(baseSettings({ chat_completion_source: 'minimax', temp_openai: 0 }), 'abab', 'normal', messages);
    assert.ok(generate_data.temperature > 0);
    assert.equal(generate_data.minimax_endpoint, MINIMAX_ENDPOINT.GLOBAL);
}

// ZAI: default endpoint applied when unset
{
    const { generate_data } = await createGenerationParameters(baseSettings({ chat_completion_source: 'zai' }), 'glm-4', 'normal', messages);
    assert.equal(generate_data.zai_endpoint, ZAI_ENDPOINT.COMMON);
    assert.equal(generate_data.presence_penalty, undefined);
}

// Pollinations: default endpoint applied when unset
{
    const { generate_data } = await createGenerationParameters(baseSettings({ chat_completion_source: 'pollinations' }), 'openai', 'normal', messages);
    assert.equal(generate_data.pollinations_endpoint, POLLINATIONS_ENDPOINT.AUTHENTICATED);
}

// Groq: strips logprobs/logit_bias/n
{
    const { generate_data } = await createGenerationParameters(baseSettings({ chat_completion_source: 'groq', n: 2 }), 'llama3', 'normal', messages, { useLogprobs: true });
    assert.equal(generate_data.logprobs, undefined);
    assert.equal(generate_data.n, undefined);
}

// Empty stop array is dropped entirely
{
    const { generate_data } = await createGenerationParameters(baseSettings(), 'gpt-4o', 'normal', messages, { getStoppingStrings: () => [] });
    assert.equal(generate_data.stop, undefined);
}

// canPerformToolCalls gate: toolsPayload only merged in when !canMultiSwipe
{
    const withTools = await createGenerationParameters(baseSettings(), 'gpt-4o', 'normal', messages, { toolsPayload: { tools: ['x'] } });
    assert.deepEqual(withTools.generate_data.tools, ['x']);

    const multiswipeIgnoresTools = await createGenerationParameters(baseSettings({ n: 3 }), 'gpt-4o', 'normal', messages, { toolsPayload: { tools: ['x'] } });
    assert.equal(multiswipeIgnoresTools.generate_data.tools, undefined);
}

// logit_bias: empty object collapses to undefined; non-empty is kept
{
    const empty = await createGenerationParameters(baseSettings(), 'gpt-4o', 'normal', messages, { logitBias: {} });
    assert.equal(empty.generate_data.logit_bias, undefined);

    const nonEmpty = await createGenerationParameters(baseSettings(), 'gpt-4o', 'normal', messages, { logitBias: { 123: -100 } });
    assert.deepEqual(nonEmpty.generate_data.logit_bias, { 123: -100 });
}

// logit_bias: real computation from biasPresetEntries via computeLogitBias() (src/endpoints/
// tokenizers.js) - not just forwarding a caller-pre-resolved value. openai is a logitBiasSources
// member, so a non-empty entries array is actually tokenized and populates generate_data.logit_bias.
{
    const { generate_data } = await createGenerationParameters(baseSettings(), 'gpt-3.5-turbo', 'normal', messages, {
        biasPresetEntries: [{ text: 'hello', value: -100 }],
    });
    assert.equal(typeof generate_data.logit_bias, 'object');
    assert.deepEqual(Object.values(generate_data.logit_bias), [-100]);

    // A logitBias override still takes priority over biasPresetEntries when both are given.
    const { generate_data: overridden } = await createGenerationParameters(baseSettings(), 'gpt-3.5-turbo', 'normal', messages, {
        logitBias: { 1: 1 },
        biasPresetEntries: [{ text: 'hello', value: -100 }],
    });
    assert.deepEqual(overridden.logit_bias, { 1: 1 });

    // Empty/missing biasPresetEntries -> no bias computed.
    const { generate_data: none } = await createGenerationParameters(baseSettings(), 'gpt-3.5-turbo', 'normal', messages, {});
    assert.equal(none.logit_bias, undefined);

    // A source not in logitBiasSources (e.g. claude) never triggers computation, even with entries.
    const { generate_data: claudeGen } = await createGenerationParameters(baseSettings({ chat_completion_source: 'claude' }), 'claude-3-opus', 'normal', messages, {
        biasPresetEntries: [{ text: 'hello', value: -100 }],
    });
    assert.equal(claudeGen.logit_bias, undefined);
}

// messages must be an array
await assert.rejects(() => createGenerationParameters(baseSettings(), 'gpt-4o', 'normal', 'not an array'), /messages must be an array/);

console.log('chat-completion-generation-data.test.js: all assertions passed');
