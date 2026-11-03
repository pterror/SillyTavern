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
 * @property {number} total
 * @property {PromptPart[]} parts In the order each first appears in the prompt; none is empty.
 */

/**
 * @typedef {'main'|'system_prompt'|'story_string'|'description'|'personality'|'scenario'|'persona'|'world_info'
 *   |'examples'|'chat_start'|'chat_history'|'injections'|'post_history'|'auxiliary'|'nudge'|'impersonate'
 *   |'extensions'|'summary'|'authors_note'|'smart_context'|'chat_vectors'|'data_bank_vectors'|'bias'|'other_prompts'} PromptPartName
 */

/**
 * @typedef {object} PromptPart
 * @property {PromptPartName} part
 * @property {number} tokens
 */

/**
 * @param {[PromptPartName, number][]} counted In prompt order; a part may come more than once.
 * @returns {PromptPart[]}
 */
export function promptParts(counted) {
    /** @type {Map<PromptPartName, number>} */
    const parts = new Map();
    for (const [part, tokens] of counted) parts.set(part, (parts.get(part) ?? 0) + (Number(tokens) || 0));
    return [...parts].filter(([, tokens]) => tokens > 0).map(([part, tokens]) => ({ part, tokens }));
}

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
