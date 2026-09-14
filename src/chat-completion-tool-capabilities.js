import { TOOL_REASONING_MODES } from './chat-completion-history.js';

/**
 * Server-side port of THREE small, pure, settings-driven predicate/enum groups from the client's
 * Chat Completion (`main_api === 'openai'`) pipeline that had previously been left unported and
 * were instead being treated - incorrectly - as pre-resolved inputs by
 * src/chat-completion-history.js and src/chat-completion-populate.js:
 *
 * 1. `chat_completion_sources` / `custom_prompt_post_processing_types` enums and the
 *    `interleaved_reasoning_providers` list (public/scripts/chat-completion-settings.js ~line
 *    177-265).
 * 2. `getToolReasoningMode(settings)` / `getEffectiveToolReasoningMode(settings)` /
 *    `isReasoningSignatureSupported(settings)` (same file, ~line 6437-6470).
 * 3. `ToolManager.isToolCallingSupported(settings, model)` / `ToolManager.canPerformToolCalls(type,
 *    settings, model)` (public/scripts/tool-calling.js ~line 610-690).
 *
 * All of the above are pure, settings-driven predicate functions with NO live extension-execution
 * dependency (contrary to how they were characterized when chat-completion-history.js and
 * chat-completion-populate.js were ported) - they only read from a settings object, an optional
 * model id string, and an optional model list array, all supplied by the caller.
 *
 * `TOOL_REASONING_MODES` is NOT redeclared here - it's imported from the already-committed
 * src/chat-completion-history.js, which mirrors the client's `tool_reasoning_modes` verbatim.
 *
 * DIFFERENCE FROM THE CLIENT, BY DESIGN ("caller resolves entities" - the same convention used by
 * every module ported this session): the client's `ToolManager.isToolCallingSupported`/
 * `canPerformToolCalls` close over the module-level globals `main_api` and `model_list` (and default
 * `settings`/`model` to `oai_settings`/`getChatCompletionModel(settings)` when omitted). This port
 * takes ALL of these as explicit, named options instead:
 * - `main_api` -> `mainApi` (string, compared against the literal `'openai'`, matching the client).
 * - `model_list` -> `modelList` (array, matching the client's `Array.isArray(model_list) ?
 *   model_list.find(...) : null` guard exactly - a non-array `modelList`, including `undefined`,
 *   behaves as "no model list").
 * - `model` and `settings` are NOT defaulted to any global here (there is no server-side
 *   `oai_settings`/`getChatCompletionModel` to fall back to) - callers must pass both explicitly.
 *
 * JUDGMENT CALL: the client's `isToolCallingSupported`/`canPerformToolCalls` are static methods on
 * the `ToolManager` class taking positional args `(settings, model)` / `(type, settings, model)`.
 * This port exposes them as plain functions taking a single options object
 * (`{ mainApi, settings, model, modelList }` / `{ type, mainApi, settings, model, modelList }`)
 * instead, matching this deliverable's documented signature and the options-object convention used
 * throughout this session's other chat-completion-* ports (e.g. `populateChatHistory`'s options
 * bag) - this is a calling-convention change only, not a behavioral one.
 *
 * @typedef {object} ChatCompletionToolCapabilitySettings A plain object shaped like the relevant
 * subset of the client's `oai_settings` (public/scripts/chat-completion-settings.js) that this
 * module's functions read. Every field is read as-is with no additional coercion beyond what's
 * documented per-function below.
 * @property {string} [chat_completion_source] One of `chat_completion_sources`'s values.
 * @property {string} [openrouter_model] The currently selected OpenRouter model id/slug, tested
 * against `/google\/gemini/i` by `isReasoningSignatureSupported`.
 * @property {string} [tool_reasoning_mode] One of `TOOL_REASONING_MODES`'s values (or anything else,
 * which `getToolReasoningMode` treats as absent/invalid).
 * @property {boolean} [show_thoughts] Gates `getEffectiveToolReasoningMode`.
 * @property {boolean} [function_calling] Gates `isToolCallingSupported`.
 * @property {string} [custom_prompt_post_processing] One of `custom_prompt_post_processing_types`'s
 * values, gating `isToolCallingSupported`.
 *
 * @typedef {object} ChatCompletionToolCapabilityModel A single entry from `modelList`, shaped
 * however the given `chat_completion_source`'s provider API returns it. Only the provider-specific
 * fields consulted by `isToolCallingSupported`'s switch (documented inline on each `case`) are ever
 * read; all others are ignored.
 */

/** Mirrors public/scripts/chat-completion-settings.js's `chat_completion_sources` verbatim (~line 177-204). */
export const chat_completion_sources = {
    OPENAI: 'openai',
    CLAUDE: 'claude',
    OPENROUTER: 'openrouter',
    AI21: 'ai21',
    MAKERSUITE: 'makersuite',
    VERTEXAI: 'vertexai',
    MISTRALAI: 'mistralai',
    CUSTOM: 'custom',
    COHERE: 'cohere',
    PERPLEXITY: 'perplexity',
    GROQ: 'groq',
    ELECTRONHUB: 'electronhub',
    CHUTES: 'chutes',
    NANOGPT: 'nanogpt',
    DEEPSEEK: 'deepseek',
    AIMLAPI: 'aimlapi',
    XAI: 'xai',
    POLLINATIONS: 'pollinations',
    MOONSHOT: 'moonshot',
    FIREWORKS: 'fireworks',
    COMETAPI: 'cometapi',
    AZURE_OPENAI: 'azure_openai',
    ZAI: 'zai',
    SILICONFLOW: 'siliconflow',
    WORKERS_AI: 'workers_ai',
    MINIMAX: 'minimax',
};

/** Mirrors public/scripts/chat-completion-settings.js's `custom_prompt_post_processing_types` verbatim (~line 220-230). */
export const custom_prompt_post_processing_types = {
    NONE: '',
    /** @deprecated Use MERGE instead. */
    CLAUDE: 'claude',
    MERGE: 'merge',
    MERGE_TOOLS: 'merge_tools',
    SEMI: 'semi',
    SEMI_TOOLS: 'semi_tools',
    STRICT: 'strict',
    STRICT_TOOLS: 'strict_tools',
    SINGLE: 'single',
};

/**
 * Mirrors public/scripts/chat-completion-settings.js's `interleaved_reasoning_providers` verbatim
 * (~line 261-265): providers that support interleaved reasoning forwarding in tool-call chains.
 * NOT exported directly (the client doesn't export it either) - use `isInterleavedReasoningProvider`.
 */
const interleaved_reasoning_providers = [
    chat_completion_sources.OPENROUTER,
    chat_completion_sources.CUSTOM,
];

/**
 * Server-side port of `getToolReasoningMode(settings)` (public/scripts/chat-completion-settings.js
 * ~line 6437-6443).
 * @param {ChatCompletionToolCapabilitySettings} settings
 * @returns {string} One of `TOOL_REASONING_MODES`'s values.
 */
export function getToolReasoningMode(settings) {
    const mode = String(settings.tool_reasoning_mode ?? '');
    if (Object.values(TOOL_REASONING_MODES).includes(mode)) {
        return mode;
    }
    return TOOL_REASONING_MODES.DISABLED;
}

/**
 * Server-side port of `getEffectiveToolReasoningMode(settings)`
 * (public/scripts/chat-completion-settings.js ~line 6451-6457). Interleaved thinking requires
 * explicit reasoning requests, so this is gated on `settings.show_thoughts`.
 * @param {ChatCompletionToolCapabilitySettings} settings
 * @returns {string} One of `TOOL_REASONING_MODES`'s values.
 */
export function getEffectiveToolReasoningMode(settings) {
    if (!settings.show_thoughts) {
        return TOOL_REASONING_MODES.DISABLED;
    }

    return getToolReasoningMode(settings);
}

/**
 * Server-side port of `isReasoningSignatureSupported(settings)`
 * (public/scripts/chat-completion-settings.js ~line 6464-6470).
 * @param {ChatCompletionToolCapabilitySettings} settings
 * @returns {boolean} True if reasoning signatures should be included in the request.
 */
export function isReasoningSignatureSupported(settings) {
    // If it's Vertex AI or Makersuite, that's OK - convertGooglePrompt() will handle it later.
    const isGoogle = [chat_completion_sources.VERTEXAI, chat_completion_sources.MAKERSUITE].includes(settings.chat_completion_source);
    // Need a more crunchy check for OpenRouter: look for Gemini models.
    const isOpenRouterGemini = settings.chat_completion_source === chat_completion_sources.OPENROUTER && /google\/gemini/i.test(settings.openrouter_model);
    return isGoogle || isOpenRouterGemini;
}

/**
 * Server-side port of `interleaved_reasoning_providers.includes(chat_completion_source)`
 * (public/scripts/chat-completion-settings.js ~line 261-265, 938 for the inline call site).
 * @param {string} chatCompletionSource One of `chat_completion_sources`'s values.
 * @returns {boolean}
 */
export function isInterleavedReasoningProvider(chatCompletionSource) {
    return interleaved_reasoning_providers.includes(chatCompletionSource);
}

/**
 * Server-side port of `ToolManager.isToolCallingSupported(settings, model)`
 * (public/scripts/tool-calling.js ~line 610-670). See the module doc comment's "DIFFERENCE FROM THE
 * CLIENT" section for the `main_api`/`model_list` -> `mainApi`/`modelList` explicit-param change.
 * @param {object} [options]
 * @param {string} [options.mainApi] The current main API selection (`main_api` on the client) -
 * tool calling is only ever supported when this is exactly `'openai'`.
 * @param {ChatCompletionToolCapabilitySettings} options.settings
 * @param {string} [options.model] The currently selected model id/slug for `settings`.
 * @param {ChatCompletionToolCapabilityModel[]} [options.modelList] Mirrors the client's module-level
 * `model_list` - looked up by `.id === model` when it's an array; anything else (including
 * `undefined`) is treated as "no model list", matching `Array.isArray(model_list) ? ... : null`.
 * @returns {boolean}
 */
export function isToolCallingSupported({ mainApi, settings, model, modelList } = {}) {
    if (mainApi !== 'openai' || !settings.function_calling) {
        return false;
    }

    // Post-processing will forcefully remove past tool calls from the prompt, making them useless.
    const { NONE, MERGE_TOOLS, SEMI_TOOLS, STRICT_TOOLS } = custom_prompt_post_processing_types;
    const allowedPromptPostProcessing = [NONE, MERGE_TOOLS, SEMI_TOOLS, STRICT_TOOLS];
    if (!allowedPromptPostProcessing.includes(settings.custom_prompt_post_processing)) {
        return false;
    }

    const currentModel = Array.isArray(modelList) ? modelList.find(m => m.id === model) : null;
    if (currentModel) {
        switch (settings.chat_completion_source) {
            case chat_completion_sources.POLLINATIONS:
                return currentModel.tools;
            case chat_completion_sources.FIREWORKS:
                return currentModel.supports_tools;
            case chat_completion_sources.OPENROUTER:
                return currentModel.supported_parameters?.includes('tools');
            case chat_completion_sources.MISTRALAI:
                return currentModel.capabilities?.function_calling;
            case chat_completion_sources.AIMLAPI:
                return currentModel.features?.includes('openai/chat-completion.function');
            case chat_completion_sources.CHUTES:
                return currentModel.supported_features?.includes('tools');
            case chat_completion_sources.ELECTRONHUB:
                return currentModel.metadata?.function_call;
            case chat_completion_sources.WORKERS_AI:
                return Array.isArray(currentModel.properties) && currentModel.properties.some(p => p.property_id === 'function_calling' && p.value === 'true');
        }
    }

    const supportedSources = [
        chat_completion_sources.OPENAI,
        chat_completion_sources.CUSTOM,
        chat_completion_sources.MISTRALAI,
        chat_completion_sources.CLAUDE,
        chat_completion_sources.OPENROUTER,
        chat_completion_sources.AIMLAPI,
        chat_completion_sources.GROQ,
        chat_completion_sources.COHERE,
        chat_completion_sources.DEEPSEEK,
        chat_completion_sources.MAKERSUITE,
        chat_completion_sources.VERTEXAI,
        chat_completion_sources.AI21,
        chat_completion_sources.XAI,
        chat_completion_sources.POLLINATIONS,
        chat_completion_sources.MOONSHOT,
        chat_completion_sources.FIREWORKS,
        chat_completion_sources.COMETAPI,
        chat_completion_sources.CHUTES,
        chat_completion_sources.ELECTRONHUB,
        chat_completion_sources.AZURE_OPENAI,
        chat_completion_sources.ZAI,
        chat_completion_sources.SILICONFLOW,
        chat_completion_sources.NANOGPT,
        chat_completion_sources.WORKERS_AI,
        chat_completion_sources.MINIMAX,
    ];
    return supportedSources.includes(settings.chat_completion_source);
}

/**
 * Server-side port of `ToolManager.canPerformToolCalls(type, settings, model)`
 * (public/scripts/tool-calling.js ~line 684-690).
 * @param {object} [options]
 * @param {string} [options.type] Generation type - tool calls are never performed for
 * `'impersonate'`, `'quiet'`, or `'continue'`.
 * @param {string} [options.mainApi] Forwarded to `isToolCallingSupported`.
 * @param {ChatCompletionToolCapabilitySettings} options.settings Forwarded to `isToolCallingSupported`.
 * @param {string} [options.model] Forwarded to `isToolCallingSupported`.
 * @param {ChatCompletionToolCapabilityModel[]} [options.modelList] Forwarded to `isToolCallingSupported`.
 * @returns {boolean}
 */
export function canPerformToolCalls({ type, mainApi, settings, model, modelList } = {}) {
    const noToolCallTypes = ['impersonate', 'quiet', 'continue'];
    const isSupported = isToolCallingSupported({ mainApi, settings, model, modelList });
    return isSupported && !noToolCallTypes.includes(type);
}
