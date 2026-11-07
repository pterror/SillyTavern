import { chat_completion_sources } from './chat-completion-tool-capabilities.js';

/**
 * @param {import('./chat-completion-generation-input.js').OaiSettingsShape} settings
 * @returns {string | null | undefined}
 */
export function getChatCompletionModel(settings) {
    switch (settings.chat_completion_source) {
        case chat_completion_sources.CLAUDE: return settings.claude_model;
        case chat_completion_sources.OPENAI: return settings.openai_model;
        case chat_completion_sources.MAKERSUITE: return settings.google_model;
        case chat_completion_sources.VERTEXAI: return settings.vertexai_model;
        case chat_completion_sources.OPENROUTER: return settings.openrouter_model !== 'OR_Website' ? settings.openrouter_model : null;
        case chat_completion_sources.AI21: return settings.ai21_model;
        case chat_completion_sources.MISTRALAI: return settings.mistralai_model;
        case chat_completion_sources.CUSTOM: return settings.custom_model;
        case chat_completion_sources.COHERE: return settings.cohere_model;
        case chat_completion_sources.PERPLEXITY: return settings.perplexity_model;
        case chat_completion_sources.GROQ: return settings.groq_model;
        case chat_completion_sources.SILICONFLOW: return settings.siliconflow_model;
        case chat_completion_sources.MINIMAX: return settings.minimax_model;
        case chat_completion_sources.ELECTRONHUB: return settings.electronhub_model;
        case chat_completion_sources.CHUTES: return settings.chutes_model;
        case chat_completion_sources.NANOGPT: return settings.nanogpt_model;
        case chat_completion_sources.DEEPSEEK: return settings.deepseek_model;
        case chat_completion_sources.AIMLAPI: return settings.aimlapi_model;
        case chat_completion_sources.XAI: return settings.xai_model;
        case chat_completion_sources.POLLINATIONS: return settings.pollinations_model;
        case chat_completion_sources.COMETAPI: return settings.cometapi_model;
        case chat_completion_sources.MOONSHOT: return settings.moonshot_model;
        case chat_completion_sources.FIREWORKS: return settings.fireworks_model;
        case chat_completion_sources.AZURE_OPENAI: return settings.azure_openai_model;
        case chat_completion_sources.ZAI: return settings.zai_model;
        case chat_completion_sources.WORKERS_AI: return settings.workers_ai_model;
        default: return '';
    }
}
