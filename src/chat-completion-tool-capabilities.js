import { TOOL_REASONING_MODES } from './chat-completion-history.js';
import { CHAT_COMPLETION_SOURCES } from './constants.js';

/**
 * @typedef {object} ChatCompletionToolCapabilitySettings
 * @property {string} [chat_completion_source]
 * @property {string} [openrouter_model]
 * @property {string} [tool_reasoning_mode]
 * @property {boolean} [show_thoughts]
 * @property {boolean} [function_calling]
 * @property {string} [custom_prompt_post_processing]
 * @typedef {object} ChatCompletionToolCapabilityModel
 */

export const chat_completion_sources = CHAT_COMPLETION_SOURCES;

export const custom_prompt_post_processing_types = {
    NONE: '',
    /** @deprecated */
    CLAUDE: 'claude',
    MERGE: 'merge',
    MERGE_TOOLS: 'merge_tools',
    SEMI: 'semi',
    SEMI_TOOLS: 'semi_tools',
    STRICT: 'strict',
    STRICT_TOOLS: 'strict_tools',
    SINGLE: 'single',
};

const interleaved_reasoning_providers = [
    chat_completion_sources.OPENROUTER,
    chat_completion_sources.CUSTOM,
];

/**
 * @param {ChatCompletionToolCapabilitySettings} settings
 * @returns {string}
 */
export function getToolReasoningMode(settings) {
    const mode = String(settings.tool_reasoning_mode ?? '');
    if (Object.values(TOOL_REASONING_MODES).includes(mode)) {
        return mode;
    }
    return TOOL_REASONING_MODES.DISABLED;
}

/**
 * @param {ChatCompletionToolCapabilitySettings} settings
 * @returns {string}
 */
export function getEffectiveToolReasoningMode(settings) {
    if (!settings.show_thoughts) {
        return TOOL_REASONING_MODES.DISABLED;
    }

    return getToolReasoningMode(settings);
}

/**
 * @param {ChatCompletionToolCapabilitySettings} settings
 * @returns {boolean}
 */
export function isReasoningSignatureSupported(settings) {
    const isGoogle = [chat_completion_sources.VERTEXAI, chat_completion_sources.MAKERSUITE].includes(settings.chat_completion_source);
    const isOpenRouterGemini = settings.chat_completion_source === chat_completion_sources.OPENROUTER && /google\/gemini/i.test(settings.openrouter_model);
    return isGoogle || isOpenRouterGemini;
}

/**
 * @param {string} chatCompletionSource
 * @returns {boolean}
 */
export function isInterleavedReasoningProvider(chatCompletionSource) {
    return interleaved_reasoning_providers.includes(chatCompletionSource);
}

/**
 * @param {object} [options]
 * @param {string} [options.mainApi]
 * @param {ChatCompletionToolCapabilitySettings} options.settings
 * @param {string} [options.model]
 * @param {ChatCompletionToolCapabilityModel[]} [options.modelList]
 * @returns {boolean}
 */
export function isToolCallingSupported({ mainApi, settings, model, modelList } = {}) {
    if (mainApi !== 'openai' || !settings.function_calling) {
        return false;
    }

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
 * @param {object} [options]
 * @param {string} [options.type]
 * @param {string} [options.mainApi]
 * @param {ChatCompletionToolCapabilitySettings} options.settings
 * @param {string} [options.model]
 * @param {ChatCompletionToolCapabilityModel[]} [options.modelList]
 * @returns {boolean}
 */
export function canPerformToolCalls({ type, mainApi, settings, model, modelList } = {}) {
    const noToolCallTypes = ['impersonate', 'quiet', 'continue'];
    const isSupported = isToolCallingSupported({ mainApi, settings, model, modelList });
    return isSupported && !noToolCallTypes.includes(type);
}
