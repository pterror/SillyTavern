import { TEXTGEN_TYPES } from './constants.js';
import { readSettingsAtPaths } from './settings-store.js';

// Fixed vendor endpoints - mirrors the *_SERVER constants in public/scripts/textgen-settings.js.
// Known gap: that client also allows a per-browser Mancer server override via localStorage,
// which is never sent to (or stored by) the server - this always resolves the default instead.
const FIXED_SERVERS = {
    [TEXTGEN_TYPES.MANCER]: 'https://neuro.mancer.tech',
    [TEXTGEN_TYPES.TOGETHERAI]: 'https://api.together.xyz',
    [TEXTGEN_TYPES.INFERMATICAI]: 'https://api.totalgpt.ai',
    [TEXTGEN_TYPES.DREAMGEN]: 'https://dreamgen.com',
    [TEXTGEN_TYPES.OPENROUTER]: 'https://openrouter.ai/api',
    [TEXTGEN_TYPES.FEATHERLESS]: 'https://api.featherless.ai/v1',
};

// Mirrors getTextGenModel() in public/scripts/textgen-settings.js.
function resolveModel(settings) {
    switch (settings.type) {
        case TEXTGEN_TYPES.OOBA:
            return settings.custom_model || undefined;
        case TEXTGEN_TYPES.GENERIC:
            return settings.generic_model || undefined;
        case TEXTGEN_TYPES.MANCER:
            return settings.mancer_model;
        case TEXTGEN_TYPES.TOGETHERAI:
            return settings.togetherai_model;
        case TEXTGEN_TYPES.INFERMATICAI:
            return settings.infermaticai_model;
        case TEXTGEN_TYPES.DREAMGEN:
            return settings.dreamgen_model;
        case TEXTGEN_TYPES.OPENROUTER:
            return settings.openrouter_model;
        case TEXTGEN_TYPES.VLLM:
            return settings.vllm_model;
        case TEXTGEN_TYPES.APHRODITE:
            return settings.aphrodite_model;
        case TEXTGEN_TYPES.OLLAMA:
            if (!settings.ollama_model) {
                throw new Error('No Ollama model selected.');
            }
            return settings.ollama_model;
        case TEXTGEN_TYPES.FEATHERLESS:
            return settings.featherless_model;
        case TEXTGEN_TYPES.HUGGINGFACE:
            return 'tgi';
        case TEXTGEN_TYPES.TABBY:
            return settings.tabby_model || undefined;
        case TEXTGEN_TYPES.LLAMACPP:
            return settings.llamacpp_model || undefined;
        default:
            return undefined;
    }
}

// Mirrors getTextGenServer() in public/scripts/textgen-settings.js.
export function resolveServerUrl(settings) {
    if (settings.type in FIXED_SERVERS) {
        return FIXED_SERVERS[settings.type];
    }
    return settings.server_urls?.[settings.type] ?? '';
}

/**
 * Resolves which text-generation backend to talk to (type, server URL, model) from the server's
 * own stored settings, instead of trusting whatever a client request claims.
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {{ type: string, serverUrl: string, model: string|undefined }}
 */
export function resolveTextGenBackend(directories) {
    const { 'textgenerationwebui_settings': settings } = readSettingsAtPaths(directories, ['textgenerationwebui_settings']);
    const type = settings?.type;
    if (!type) {
        throw new Error('No text completion backend is configured.');
    }
    return {
        type,
        serverUrl: resolveServerUrl(settings),
        model: resolveModel(settings),
    };
}
