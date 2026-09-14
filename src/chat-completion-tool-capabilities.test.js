import assert from 'node:assert';
import { test } from 'node:test';

import { TOOL_REASONING_MODES } from './chat-completion-history.js';
import {
    chat_completion_sources,
    custom_prompt_post_processing_types,
    getToolReasoningMode,
    getEffectiveToolReasoningMode,
    isReasoningSignatureSupported,
    isToolCallingSupported,
    canPerformToolCalls,
    isInterleavedReasoningProvider,
} from './chat-completion-tool-capabilities.js';

// ---------------------------------------------------------------------------
// getToolReasoningMode
// ---------------------------------------------------------------------------

test('getToolReasoningMode returns a valid configured mode as-is', () => {
    assert.strictEqual(
        getToolReasoningMode({ tool_reasoning_mode: TOOL_REASONING_MODES.ACTIVE_CHAIN }),
        TOOL_REASONING_MODES.ACTIVE_CHAIN,
    );
    assert.strictEqual(
        getToolReasoningMode({ tool_reasoning_mode: TOOL_REASONING_MODES.SINCE_LAST_USER }),
        TOOL_REASONING_MODES.SINCE_LAST_USER,
    );
});

test('getToolReasoningMode falls back to DISABLED for an invalid mode', () => {
    assert.strictEqual(getToolReasoningMode({ tool_reasoning_mode: 'not_a_real_mode' }), TOOL_REASONING_MODES.DISABLED);
});

test('getToolReasoningMode falls back to DISABLED when the mode is missing entirely', () => {
    assert.strictEqual(getToolReasoningMode({}), TOOL_REASONING_MODES.DISABLED);
});

// ---------------------------------------------------------------------------
// getEffectiveToolReasoningMode
// ---------------------------------------------------------------------------

test('getEffectiveToolReasoningMode is DISABLED when show_thoughts is falsy, regardless of configured mode', () => {
    assert.strictEqual(
        getEffectiveToolReasoningMode({ show_thoughts: false, tool_reasoning_mode: TOOL_REASONING_MODES.ACTIVE_CHAIN }),
        TOOL_REASONING_MODES.DISABLED,
    );
    assert.strictEqual(
        getEffectiveToolReasoningMode({ tool_reasoning_mode: TOOL_REASONING_MODES.ACTIVE_CHAIN }),
        TOOL_REASONING_MODES.DISABLED,
    );
});

test('getEffectiveToolReasoningMode delegates to getToolReasoningMode when show_thoughts is truthy', () => {
    assert.strictEqual(
        getEffectiveToolReasoningMode({ show_thoughts: true, tool_reasoning_mode: TOOL_REASONING_MODES.SINCE_LAST_USER }),
        TOOL_REASONING_MODES.SINCE_LAST_USER,
    );
    assert.strictEqual(
        getEffectiveToolReasoningMode({ show_thoughts: true, tool_reasoning_mode: 'garbage' }),
        TOOL_REASONING_MODES.DISABLED,
    );
});

// ---------------------------------------------------------------------------
// isReasoningSignatureSupported
// ---------------------------------------------------------------------------

test('isReasoningSignatureSupported is true for Vertex AI and Makersuite', () => {
    assert.strictEqual(isReasoningSignatureSupported({ chat_completion_source: chat_completion_sources.VERTEXAI }), true);
    assert.strictEqual(isReasoningSignatureSupported({ chat_completion_source: chat_completion_sources.MAKERSUITE }), true);
});

test('isReasoningSignatureSupported is true for OpenRouter with a matching Gemini model name', () => {
    assert.strictEqual(
        isReasoningSignatureSupported({ chat_completion_source: chat_completion_sources.OPENROUTER, openrouter_model: 'google/gemini-2.5-pro' }),
        true,
    );
    // Case-insensitive regex.
    assert.strictEqual(
        isReasoningSignatureSupported({ chat_completion_source: chat_completion_sources.OPENROUTER, openrouter_model: 'Google/Gemini-Flash' }),
        true,
    );
});

test('isReasoningSignatureSupported is false for OpenRouter with a non-Gemini model name', () => {
    assert.strictEqual(
        isReasoningSignatureSupported({ chat_completion_source: chat_completion_sources.OPENROUTER, openrouter_model: 'openai/gpt-4o' }),
        false,
    );
});

test('isReasoningSignatureSupported is false for an unrelated source', () => {
    assert.strictEqual(isReasoningSignatureSupported({ chat_completion_source: chat_completion_sources.OPENAI }), false);
    assert.strictEqual(isReasoningSignatureSupported({ chat_completion_source: chat_completion_sources.CLAUDE }), false);
});

// ---------------------------------------------------------------------------
// isToolCallingSupported
// ---------------------------------------------------------------------------

function baseToolSettings(overrides = {}) {
    return {
        function_calling: true,
        custom_prompt_post_processing: custom_prompt_post_processing_types.NONE,
        chat_completion_source: chat_completion_sources.OPENAI,
        ...overrides,
    };
}

test('isToolCallingSupported short-circuits to false when mainApi is not openai', () => {
    assert.strictEqual(
        isToolCallingSupported({ mainApi: 'textgenerationwebui', settings: baseToolSettings(), model: 'gpt-4o' }),
        false,
    );
});

test('isToolCallingSupported is false when settings.function_calling is falsy', () => {
    assert.strictEqual(
        isToolCallingSupported({ mainApi: 'openai', settings: baseToolSettings({ function_calling: false }), model: 'gpt-4o' }),
        false,
    );
});

test('isToolCallingSupported gates on custom_prompt_post_processing: allowed vs disallowed values', () => {
    assert.strictEqual(
        isToolCallingSupported({ mainApi: 'openai', settings: baseToolSettings({ custom_prompt_post_processing: custom_prompt_post_processing_types.MERGE_TOOLS }), model: 'gpt-4o' }),
        true,
    );
    assert.strictEqual(
        isToolCallingSupported({ mainApi: 'openai', settings: baseToolSettings({ custom_prompt_post_processing: custom_prompt_post_processing_types.MERGE }), model: 'gpt-4o' }),
        false,
    );
});

test('isToolCallingSupported reads currentModel.supports_tools for FIREWORKS specifically', () => {
    const settings = baseToolSettings({ chat_completion_source: chat_completion_sources.FIREWORKS });
    const modelList = [{ id: 'fw-model', supports_tools: true, tools: false, supported_parameters: [] }];
    assert.strictEqual(isToolCallingSupported({ mainApi: 'openai', settings, model: 'fw-model', modelList }), true);

    const modelListFalse = [{ id: 'fw-model', supports_tools: false, tools: true }];
    assert.strictEqual(isToolCallingSupported({ mainApi: 'openai', settings, model: 'fw-model', modelList: modelListFalse }), false);
});

test('isToolCallingSupported reads currentModel.tools for POLLINATIONS specifically', () => {
    const settings = baseToolSettings({ chat_completion_source: chat_completion_sources.POLLINATIONS });
    const modelList = [{ id: 'poll-model', tools: true, supports_tools: false }];
    assert.strictEqual(isToolCallingSupported({ mainApi: 'openai', settings, model: 'poll-model', modelList }), true);
});

test('isToolCallingSupported reads currentModel.supported_parameters (array includes "tools") for OPENROUTER specifically', () => {
    const settings = baseToolSettings({ chat_completion_source: chat_completion_sources.OPENROUTER });
    const modelList = [{ id: 'or-model', supported_parameters: ['tools', 'reasoning'], tools: false }];
    assert.strictEqual(isToolCallingSupported({ mainApi: 'openai', settings, model: 'or-model', modelList }), true);

    const modelListNoTools = [{ id: 'or-model', supported_parameters: ['reasoning'] }];
    assert.strictEqual(isToolCallingSupported({ mainApi: 'openai', settings, model: 'or-model', modelList: modelListNoTools }), false);
});

test('isToolCallingSupported reads currentModel.capabilities.function_calling for MISTRALAI specifically', () => {
    const settings = baseToolSettings({ chat_completion_source: chat_completion_sources.MISTRALAI });
    const modelList = [{ id: 'mi-model', capabilities: { function_calling: true }, tools: false }];
    assert.strictEqual(isToolCallingSupported({ mainApi: 'openai', settings, model: 'mi-model', modelList }), true);
});

test('isToolCallingSupported reads currentModel.metadata.function_call for ELECTRONHUB specifically', () => {
    const settings = baseToolSettings({ chat_completion_source: chat_completion_sources.ELECTRONHUB });
    const modelList = [{ id: 'eh-model', metadata: { function_call: true } }];
    assert.strictEqual(isToolCallingSupported({ mainApi: 'openai', settings, model: 'eh-model', modelList }), true);
});

test('isToolCallingSupported reads currentModel.features (array includes the openai function-call feature id) for AIMLAPI specifically', () => {
    const settings = baseToolSettings({ chat_completion_source: chat_completion_sources.AIMLAPI });
    const modelList = [{ id: 'ai-model', features: ['openai/chat-completion.function'] }];
    assert.strictEqual(isToolCallingSupported({ mainApi: 'openai', settings, model: 'ai-model', modelList }), true);
});

test('isToolCallingSupported reads currentModel.supported_features (array includes "tools") for CHUTES specifically', () => {
    const settings = baseToolSettings({ chat_completion_source: chat_completion_sources.CHUTES });
    const modelList = [{ id: 'ch-model', supported_features: ['tools'] }];
    assert.strictEqual(isToolCallingSupported({ mainApi: 'openai', settings, model: 'ch-model', modelList }), true);
});

test('isToolCallingSupported reads currentModel.properties (array of {property_id, value}) for WORKERS_AI specifically', () => {
    const settings = baseToolSettings({ chat_completion_source: chat_completion_sources.WORKERS_AI });
    const modelList = [{ id: 'wa-model', properties: [{ property_id: 'function_calling', value: 'true' }] }];
    assert.strictEqual(isToolCallingSupported({ mainApi: 'openai', settings, model: 'wa-model', modelList }), true);

    const modelListNoMatch = [{ id: 'wa-model', properties: [{ property_id: 'function_calling', value: 'false' }] }];
    assert.strictEqual(isToolCallingSupported({ mainApi: 'openai', settings, model: 'wa-model', modelList: modelListNoMatch }), false);
});

test('isToolCallingSupported falls back to the supportedSources allowlist when no model-specific case applies', () => {
    // CLAUDE has no switch case, and no model list is supplied - falls through to supportedSources.
    const settings = baseToolSettings({ chat_completion_source: chat_completion_sources.CLAUDE });
    assert.strictEqual(isToolCallingSupported({ mainApi: 'openai', settings, model: 'claude-3-opus' }), true);
});

test('isToolCallingSupported falls back to the supportedSources allowlist when modelList has no matching model', () => {
    const settings = baseToolSettings({ chat_completion_source: chat_completion_sources.GROQ });
    const modelList = [{ id: 'some-other-model', supports_tools: false }];
    assert.strictEqual(isToolCallingSupported({ mainApi: 'openai', settings, model: 'groq-model', modelList }), true);
});

test('isToolCallingSupported is false for a source genuinely not in supportedSources', () => {
    // PERPLEXITY is in chat_completion_sources but deliberately absent from the ~25-entry supportedSources allowlist.
    const settings = baseToolSettings({ chat_completion_source: chat_completion_sources.PERPLEXITY });
    assert.strictEqual(isToolCallingSupported({ mainApi: 'openai', settings, model: 'perplexity-model' }), false);
});

// ---------------------------------------------------------------------------
// canPerformToolCalls
// ---------------------------------------------------------------------------

test('canPerformToolCalls excludes impersonate, quiet, and continue generation types', () => {
    const settings = baseToolSettings();
    for (const type of ['impersonate', 'quiet', 'continue']) {
        assert.strictEqual(canPerformToolCalls({ type, mainApi: 'openai', settings, model: 'gpt-4o' }), false);
    }
});

test('canPerformToolCalls allows a normal generation type when tool calling is supported', () => {
    const settings = baseToolSettings();
    assert.strictEqual(canPerformToolCalls({ type: 'normal', mainApi: 'openai', settings, model: 'gpt-4o' }), true);
});

test('canPerformToolCalls is false for a normal type when tool calling itself is unsupported', () => {
    const settings = baseToolSettings({ function_calling: false });
    assert.strictEqual(canPerformToolCalls({ type: 'normal', mainApi: 'openai', settings, model: 'gpt-4o' }), false);
});

// ---------------------------------------------------------------------------
// isInterleavedReasoningProvider
// ---------------------------------------------------------------------------

test('isInterleavedReasoningProvider is true for OPENROUTER and CUSTOM only', () => {
    assert.strictEqual(isInterleavedReasoningProvider(chat_completion_sources.OPENROUTER), true);
    assert.strictEqual(isInterleavedReasoningProvider(chat_completion_sources.CUSTOM), true);
});

test('isInterleavedReasoningProvider is false for a source outside the 2-entry list', () => {
    assert.strictEqual(isInterleavedReasoningProvider(chat_completion_sources.OPENAI), false);
    assert.strictEqual(isInterleavedReasoningProvider(chat_completion_sources.CLAUDE), false);
});
