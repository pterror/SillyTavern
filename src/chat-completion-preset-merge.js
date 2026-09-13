// Mirrors public/scripts/chat-completion-settings.js's settingsToUpdate: maps a preset field name
// to the real oai_settings field it updates. Only the second tuple element (the settings key) is
// used here - the first element is a DOM selector, irrelevant server-side.
const SETTINGS_TO_UPDATE = {
    chat_completion_source: 'chat_completion_source',
    temperature: 'temp_openai',
    frequency_penalty: 'freq_pen_openai',
    presence_penalty: 'pres_pen_openai',
    top_p: 'top_p_openai',
    top_k: 'top_k_openai',
    top_a: 'top_a_openai',
    min_p: 'min_p_openai',
    repetition_penalty: 'repetition_penalty_openai',
    max_context_unlocked: 'max_context_unlocked',
    group_models: 'group_models',
    sort_models: 'sort_models',
    openai_model: 'openai_model',
    claude_model: 'claude_model',
    openrouter_model: 'openrouter_model',
    openrouter_use_fallback: 'openrouter_use_fallback',
    openrouter_providers: 'openrouter_providers',
    openrouter_quantizations: 'openrouter_quantizations',
    openrouter_allow_fallbacks: 'openrouter_allow_fallbacks',
    openrouter_middleout: 'openrouter_middleout',
    tool_reasoning_mode: 'tool_reasoning_mode',
    ai21_model: 'ai21_model',
    mistralai_model: 'mistralai_model',
    cohere_model: 'cohere_model',
    perplexity_model: 'perplexity_model',
    groq_model: 'groq_model',
    chutes_model: 'chutes_model',
    siliconflow_model: 'siliconflow_model',
    siliconflow_endpoint: 'siliconflow_endpoint',
    minimax_model: 'minimax_model',
    minimax_endpoint: 'minimax_endpoint',
    electronhub_model: 'electronhub_model',
    nanogpt_model: 'nanogpt_model',
    nanogpt_provider: 'nanogpt_provider',
    nanogpt_payg_override: 'nanogpt_payg_override',
    deepseek_model: 'deepseek_model',
    aimlapi_model: 'aimlapi_model',
    xai_model: 'xai_model',
    pollinations_model: 'pollinations_model',
    pollinations_endpoint: 'pollinations_endpoint',
    moonshot_model: 'moonshot_model',
    fireworks_model: 'fireworks_model',
    cometapi_model: 'cometapi_model',
    custom_model: 'custom_model',
    custom_url: 'custom_url',
    custom_include_body: 'custom_include_body',
    custom_exclude_body: 'custom_exclude_body',
    custom_include_headers: 'custom_include_headers',
    custom_prompt_post_processing: 'custom_prompt_post_processing',
    google_model: 'google_model',
    vertexai_model: 'vertexai_model',
    zai_model: 'zai_model',
    zai_endpoint: 'zai_endpoint',
    workers_ai_model: 'workers_ai_model',
    workers_ai_account_id: 'workers_ai_account_id',
    openai_max_context: 'openai_max_context',
    openai_max_tokens: 'openai_max_tokens',
    names_behavior: 'names_behavior',
    send_if_empty: 'send_if_empty',
    impersonation_prompt: 'impersonation_prompt',
    new_chat_prompt: 'new_chat_prompt',
    new_group_chat_prompt: 'new_group_chat_prompt',
    new_example_chat_prompt: 'new_example_chat_prompt',
    continue_nudge_prompt: 'continue_nudge_prompt',
    bias_preset_selected: 'bias_preset_selected',
    reverse_proxy: 'reverse_proxy',
    wi_format: 'wi_format',
    scenario_format: 'scenario_format',
    personality_format: 'personality_format',
    group_nudge_prompt: 'group_nudge_prompt',
    stream_openai: 'stream_openai',
    prompts: 'prompts',
    prompt_order: 'prompt_order',
    show_external_models: 'show_external_models',
    proxy_password: 'proxy_password',
    assistant_prefill: 'assistant_prefill',
    assistant_impersonation: 'assistant_impersonation',
    use_sysprompt: 'use_sysprompt',
    vertexai_auth_mode: 'vertexai_auth_mode',
    vertexai_region: 'vertexai_region',
    vertexai_express_project_id: 'vertexai_express_project_id',
    squash_system_messages: 'squash_system_messages',
    media_inlining: 'media_inlining',
    inline_image_quality: 'inline_image_quality',
    continue_prefill: 'continue_prefill',
    continue_postfix: 'continue_postfix',
    function_calling: 'function_calling',
    tool_call_recurse_limit: 'tool_call_recurse_limit',
    show_thoughts: 'show_thoughts',
    reasoning_effort: 'reasoning_effort',
    verbosity: 'verbosity',
    enable_web_search: 'enable_web_search',
    seed: 'seed',
    n: 'n',
    bypass_status_check: 'bypass_status_check',
    request_images: 'request_images',
    request_image_aspect_ratio: 'request_image_aspect_ratio',
    request_image_resolution: 'request_image_resolution',
    azure_base_url: 'azure_base_url',
    azure_deployment_name: 'azure_deployment_name',
    azure_api_version: 'azure_api_version',
    azure_openai_model: 'azure_openai_model',
    extensions: 'extensions',
};

/**
 * Mirrors ChatCompletionService.presetToGeneratePayload()'s preset-merge step (public/scripts/custom-request.js):
 * clone the base settings, then overlay only the fields a preset is allowed to carry, translated
 * through SETTINGS_TO_UPDATE. `bias_preset_selected` is cleared to match the client's own
 * "presets might have bias_preset_selected but not bias_presets" normalization.
 * @param {object} baseSettings The server's own stored oai_settings
 * @param {object} preset A named preset's raw fields (as read from disk)
 * @returns {object} baseSettings with the preset's fields applied
 */
export function mergeChatCompletionPreset(baseSettings, preset) {
    const settings = structuredClone(baseSettings);
    if (!preset || typeof preset !== 'object') return settings;

    const normalizedPreset = { ...preset };
    normalizedPreset.bias_preset_selected = normalizedPreset.bias_presets !== undefined ? normalizedPreset.bias_preset_selected : undefined;

    for (const [key, value] of Object.entries(normalizedPreset)) {
        const settingKey = SETTINGS_TO_UPDATE[key];
        if (!settingKey) continue;
        settings[settingKey] = value;
    }
    return settings;
}
