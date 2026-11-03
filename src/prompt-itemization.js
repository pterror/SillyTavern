export const ITEMIZED_PROMPT_FLAG = 'has_itemized_prompt';

export const PRESET_SETTINGS = {
    openai: { key: 'oai_settings', name: 'preset_settings_openai' },
    textgenerationwebui: { key: 'textgenerationwebui_settings', name: 'preset' },
    kobold: { key: 'kai_settings', name: 'preset_settings' },
    koboldhorde: { key: 'kai_settings', name: 'preset_settings' },
    novel: { key: 'nai_settings', name: 'preset_settings_novel' },
};

/**
 * @typedef {object} PromptItemization
 * @property {string} api
 * @property {string|null} preset
 * @property {Record<string, unknown>} sampler_config The request's parameters as sent, without its prompt.
 * @property {object|null} tokenizer tokenizerAnswer() of the counter.
 * @property {number} max_context
 * @property {number} padding
 * @property {string|object[]} rawPrompt
 * @property {number} messages_count
 * @property {number} examples_count
 * @property {PromptTokens} tokens
 */

/**
 * @typedef {object} PromptTokens
 * @property {number} total
 * @property {number} description
 * @property {number} personality
 * @property {number} scenario
 * @property {number} persona
 * @property {number} examples
 * @property {number} world_info
 * @property {number} chat_history
 * @property {number} post_history
 * @property {number} extensions Includes summary, authors_note, smart_context, chat_vectors and data_bank_vectors.
 * @property {number} summary
 * @property {number} authors_note
 * @property {number} smart_context
 * @property {number} chat_vectors
 * @property {number} data_bank_vectors
 * @property {number} bias
 * @property {number} [story_string]
 * @property {number} [system_prompt]
 * @property {number} [main]
 * @property {number} [chat_start]
 * @property {number} [auxiliary]
 * @property {number} [nudge]
 * @property {number} [impersonate]
 * @property {number} [other_prompts]
 */

export const NAMED_EXTENSIONS = Object.freeze({
    summary: '1_memory',
    authors_note: '2_floating_prompt',
    smart_context: 'chromadb',
    chat_vectors: '3_vectors',
    data_bank_vectors: '4_vectors_data_bank',
});

/**
 * @param {string} api
 * @param {Record<string, any>|null|undefined} settings
 * @returns {string|null}
 */
export function presetNameOf(api, settings) {
    const key = PRESET_SETTINGS[/** @type {keyof typeof PRESET_SETTINGS} */ (api)]?.name;
    const name = key ? settings?.[key] : undefined;
    return typeof name === 'string' && name !== '' ? name : null;
}

/**
 * @param {() => Promise<PromptItemization>} itemize
 * @returns {Promise<PromptItemization>}
 */
export function startItemizing(itemize) {
    const itemization = itemize();
    itemization.catch(() => {});
    return itemization;
}

/**
 * @param {Record<string, unknown>|null|undefined} params
 * @param {string[]} promptKeys
 * @returns {Record<string, unknown>}
 */
export function samplerConfigOf(params, promptKeys) {
    const config = { ...(params ?? {}) };
    for (const key of promptKeys) delete config[key];
    return config;
}
