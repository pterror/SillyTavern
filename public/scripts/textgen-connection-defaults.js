/**
 * The defaults of text completion's connection settings: each backend type's model, URL and options. Kept apart from
 * textgen-settings.js so the server reads the same values (must stay importable outside a browser DOM).
 */
export const textgen_connection_defaults = Object.freeze({
    mancer_model: 'mytholite',
    togetherai_model: 'Gryphe/MythoMax-L2-13b',
    infermaticai_model: '',
    ollama_model: '',
    openrouter_model: 'openrouter/auto',
    openrouter_providers: [],
    openrouter_quantizations: [],
    vllm_model: '',
    aphrodite_model: '',
    dreamgen_model: 'lucid-v1-extra-large/text',
    tabby_model: '',
    llamacpp_model: '',
    server_urls: {},
    custom_model: '',
    bypass_status_check: false,
    openrouter_allow_fallbacks: true,
    featherless_model: '',
    generic_model: '',
});
