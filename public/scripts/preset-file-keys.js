/**
 * Which keys of upstream's live settings objects a preset or template file holds. Must stay importable outside a
 * browser DOM (the server's settings model reads them).
 */

/**
 * Keys of a live settings object (`textgenerationwebui_settings`, `nai_settings`, `kai_settings`, `power_user.instruct`,
 * …) that its preset or template file doesn't hold: the connection, streaming, the selected name, switches that aren't
 * the template's. A file holds every other key of its object.
 */
export const PRESET_EXCLUDED_KEYS = Object.freeze([
    'api_server', 'preset', 'streaming', 'truncation_length', 'n', 'streaming_url', 'stopping_strings',
    'can_use_tokenization', 'can_use_streaming', 'preset_settings_novel', 'preset_settings', 'streaming_novel',
    'nai_preamble', 'model_novel', 'streaming_kobold', 'enabled', 'bind_to_context', 'seed', 'legacy_api',
    'mancer_model', 'togetherai_model', 'ollama_model', 'vllm_model', 'aphrodite_model', 'llamacpp_model',
    'server_urls', 'type', 'custom_model', 'bypass_status_check', 'infermaticai_model', 'dreamgen_model',
    'openrouter_model', 'featherless_model', 'max_tokens_second', 'openrouter_providers', 'openrouter_quantizations',
    'openrouter_allow_fallbacks', 'tabby_model', 'derived', 'generic_model', 'include_reasoning',
    'global_banned_tokens', 'send_banned_tokens', 'auto_parse', 'add_to_prompts', 'auto_expand', 'show_hidden',
    'max_additions',
]);

/** `power_user` keys a context template holds besides `power_user.context`'s own (`getContextSettings`). */
export const CONTEXT_TEMPLATE_POWER_USER_KEYS = Object.freeze(['always_force_name2', 'trim_sentences', 'single_line']);

/** A text API's preset file's response length and context size keys, and the settings they are. */
export const TEXT_PRESET_LENGTH_KEYS = Object.freeze({ genamt: 'amount_gen', max_length: 'max_context' });

/** NovelAI's own preset files' lengths: `max_length` is the response length there, `max_context` the context size. */
const NOVEL_PRESET_LENGTH_KEYS = Object.freeze({ max_length: 'amount_gen', max_context: 'max_context' });

/**
 * A text preset file's length keys and the settings they are. NovelAI's own presets (no `genamt`) name them their way
 * (as the old page's loadNovelPreset() read them); the app's own files, NovelAI's included, the common way.
 * @param {string} group The preset's group (`preset.novel`, ...).
 * @param {Record<string, unknown> | undefined} file
 * @returns {Readonly<Record<string, string>>}
 */
export function presetLengthKeys(group, file) {
    return group === 'preset.novel' && file && !Object.hasOwn(file, 'genamt') ? NOVEL_PRESET_LENGTH_KEYS : TEXT_PRESET_LENGTH_KEYS;
}
