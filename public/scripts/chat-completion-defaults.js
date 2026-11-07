import { chatCompletionDefaultPrompts, promptManagerDefaultPromptOrders } from './prompt-manager-defaults.js';

export const default_main_prompt = 'Write {{char}}\'s next reply in a fictional chat between {{charIfNotGroup}} and {{user}}.';
export const default_nsfw_prompt = '';
export const default_jailbreak_prompt = '';
const default_impersonation_prompt = '[Write your next reply from the point of view of {{user}}, using the chat history so far as a guideline for the writing style of {{user}}. Don\'t write as {{char}} or system. Don\'t describe actions of {{char}}.]';
export const default_enhance_definitions_prompt = 'If you have more knowledge of {{char}}, add to the character\'s lore and personality to enhance them but keep the Character Sheet\'s definitions absolute.';
const default_wi_format = '{0}';
const default_new_chat_prompt = '[Start a new Chat]';
const default_new_group_chat_prompt = '[Start a new group chat. Group members: {{group}}]';
const default_new_example_chat_prompt = '[Example Chat]';
const default_continue_nudge_prompt = '[Continue your last message without repeating its original content.]';
const default_bias = 'Default (none)';
const default_personality_format = '{{personality}}';
const default_scenario_format = '{{scenario}}';
const default_group_nudge_prompt = '[Write the next reply only as {{char}}.]';
const default_bias_presets = {
    [default_bias]: [],
    'Anti-bond': [
        { id: '22154f79-dd98-41bc-8e34-87015d6a0eaf', text: ' bond', value: -50 },
        { id: '8ad2d5c4-d8ef-49e4-bc5e-13e7f4690e0f', text: ' future', value: -50 },
        { id: '52a4b280-0956-4940-ac52-4111f83e4046', text: ' bonding', value: -50 },
        { id: 'e63037c7-c9d1-4724-ab2d-7756008b433b', text: ' connection', value: -25 },
    ],
};
const max_4k = 4095;
export const openrouter_website_model = 'OR_Website';
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
const character_names_behavior = {
    NONE: -1,
    DEFAULT: 0,
    COMPLETION: 1,
    CONTENT: 2,
};
const continue_postfix_types = {
    NONE: '',
    SPACE: ' ',
    NEWLINE: '\n',
    DOUBLE_NEWLINE: '\n\n',
};
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
const openrouter_middleout_types = {
    AUTO: 'auto',
    ON: 'on',
    OFF: 'off',
};
const reasoning_effort_types = {
    auto: 'auto',
    low: 'low',
    medium: 'medium',
    high: 'high',
    min: 'min',
    max: 'max',
};
const verbosity_levels = {
    auto: 'auto',
    low: 'low',
    medium: 'medium',
    high: 'high',
};
const tool_reasoning_modes = {
    DISABLED: 'disabled',
    SINCE_LAST_USER: 'since_last_user',
    ACTIVE_CHAIN: 'active_chain',
};
export const ZAI_ENDPOINT = {
    COMMON: 'common',
    CODING: 'coding',
};
export const POLLINATIONS_ENDPOINT = {
    AUTHENTICATED: 'authenticated',
    ANONYMOUS: 'anonymous',
};
export const SILICONFLOW_ENDPOINT = {
    GLOBAL: 'global',
    CN: 'cn',
};
export const MINIMAX_ENDPOINT = {
    GLOBAL: 'global',
    CN: 'cn',
};
export const default_settings = {
    preset_settings_openai: 'Default',
    temp_openai: 1.0,
    freq_pen_openai: 0,
    pres_pen_openai: 0,
    top_p_openai: 1.0,
    top_k_openai: 0,
    min_p_openai: 0,
    top_a_openai: 0,
    repetition_penalty_openai: 1,
    stream_openai: false,
    openai_max_context: max_4k,
    openai_max_tokens: 300,
    ...chatCompletionDefaultPrompts,
    ...promptManagerDefaultPromptOrders,
    send_if_empty: '',
    impersonation_prompt: default_impersonation_prompt,
    new_chat_prompt: default_new_chat_prompt,
    new_group_chat_prompt: default_new_group_chat_prompt,
    new_example_chat_prompt: default_new_example_chat_prompt,
    continue_nudge_prompt: default_continue_nudge_prompt,
    bias_preset_selected: default_bias,
    bias_presets: default_bias_presets,
    wi_format: default_wi_format,
    group_nudge_prompt: default_group_nudge_prompt,
    scenario_format: default_scenario_format,
    personality_format: default_personality_format,
    sort_models: 'alphabetically',
    group_models: false,
    openai_model: 'gpt-6-sol',
    claude_model: 'claude-sonnet-5',
    google_model: 'gemini-3.8-flash',
    vertexai_model: 'gemini-3.8-flash',
    ai21_model: 'jamba-large',
    mistralai_model: 'mistral-large-latest',
    cohere_model: 'command-r-plus',
    perplexity_model: 'sonar-pro',
    groq_model: 'llama-3.3-70b-versatile',
    chutes_model: 'deepseek-ai/DeepSeek-V3-0324',
    siliconflow_model: 'deepseek-ai/DeepSeek-V3',
    siliconflow_endpoint: SILICONFLOW_ENDPOINT.GLOBAL,
    minimax_model: 'MiniMax-M2.7',
    minimax_endpoint: MINIMAX_ENDPOINT.GLOBAL,
    electronhub_model: 'gpt-4o-mini',
    nanogpt_model: 'gpt-4o-mini',
    nanogpt_provider: '',
    nanogpt_payg_override: false,
    deepseek_model: 'deepseek-v4-flash',
    aimlapi_model: 'chatgpt-4o-latest',
    xai_model: 'grok-3-beta',
    pollinations_model: 'openai',
    pollinations_endpoint: POLLINATIONS_ENDPOINT.AUTHENTICATED,
    cometapi_model: 'gpt-4o',
    moonshot_model: 'kimi-latest',
    fireworks_model: 'accounts/fireworks/models/kimi-k2-instruct',
    zai_model: 'glm-4.6',
    zai_endpoint: ZAI_ENDPOINT.COMMON,
    workers_ai_model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    workers_ai_account_id: '',
    azure_base_url: '',
    azure_deployment_name: '',
    azure_api_version: '2024-02-15-preview',
    azure_openai_model: '',
    custom_model: '',
    custom_url: '',
    custom_include_body: '',
    custom_exclude_body: '',
    custom_include_headers: '',
    openrouter_model: openrouter_website_model,
    openrouter_use_fallback: false,
    openrouter_providers: [],
    openrouter_quantizations: [],
    openrouter_allow_fallbacks: true,
    openrouter_middleout: openrouter_middleout_types.ON,
    tool_reasoning_mode: tool_reasoning_modes.DISABLED,
    reverse_proxy: '',
    chat_completion_source: chat_completion_sources.OPENAI,
    max_context_unlocked: false,
    show_external_models: false,
    proxy_password: '',
    assistant_prefill: '',
    assistant_impersonation: '',
    use_sysprompt: false,
    vertexai_auth_mode: 'express',
    vertexai_region: 'us-central1',
    vertexai_express_project_id: '',
    squash_system_messages: false,
    media_inlining: true,
    inline_image_quality: 'auto',
    bypass_status_check: false,
    continue_prefill: false,
    function_calling: false,
    tool_call_recurse_limit: 5,
    names_behavior: character_names_behavior.DEFAULT,
    continue_postfix: continue_postfix_types.SPACE,
    custom_prompt_post_processing: custom_prompt_post_processing_types.NONE,
    show_thoughts: true,
    reasoning_effort: reasoning_effort_types.auto,
    verbosity: verbosity_levels.auto,
    enable_web_search: false,
    request_images: false,
    request_image_aspect_ratio: '',
    request_image_resolution: '',
    seed: -1,
    n: 1,
    bind_preset_to_connection: true,
    extensions: {},
};
/**
 * @param {ChatCompletionSettings} settings
 */
export function migrateChatCompletionSettings(settings) {
    const migrateMap = [
        { oldKey: 'names_in_completion', oldValue: true, newKey: 'names_behavior', newValue: character_names_behavior.COMPLETION },
        { oldKey: 'chat_completion_source', oldValue: 'palm', newKey: 'chat_completion_source', newValue: chat_completion_sources.MAKERSUITE },
        { oldKey: 'custom_prompt_post_processing', oldValue: custom_prompt_post_processing_types.CLAUDE, newKey: 'custom_prompt_post_processing', newValue: custom_prompt_post_processing_types.MERGE },
        { oldKey: 'ai21_model', oldValue: /^j2-/, newKey: 'ai21_model', newValue: 'jamba-large' },
        { oldKey: 'google_model', oldValue: 'gemini-3.1-flash-lite-preview', newKey: 'google_model', newValue: 'gemini-3.1-flash-lite' },
        { oldKey: 'vertexai_model', oldValue: 'gemini-3.1-flash-lite-preview', newKey: 'vertexai_model', newValue: 'gemini-3.1-flash-lite' },
        { oldKey: 'google_model', oldValue: 'gemini-3.1-flash-image-preview', newKey: 'google_model', newValue: 'gemini-3.1-flash-image' },
        { oldKey: 'vertexai_model', oldValue: 'gemini-3.1-flash-image-preview', newKey: 'vertexai_model', newValue: 'gemini-3.1-flash-image' },
        { oldKey: 'google_model', oldValue: 'gemini-3-pro-image-preview', newKey: 'google_model', newValue: 'gemini-3-pro-image' },
        { oldKey: 'vertexai_model', oldValue: 'gemini-3-pro-image-preview', newKey: 'vertexai_model', newValue: 'gemini-3-pro-image' },
        { oldKey: 'image_inlining', oldValue: false, newKey: 'media_inlining', newValue: false },
        { oldKey: 'image_inlining', oldValue: true, newKey: 'media_inlining', newValue: true },
        { oldKey: 'video_inlining', oldValue: true, newKey: 'media_inlining', newValue: true },
        { oldKey: 'audio_inlining', oldValue: true, newKey: 'media_inlining', newValue: true },
        { oldKey: 'claude_use_sysprompt', oldValue: true, newKey: 'use_sysprompt', newValue: true },
        { oldKey: 'use_makersuite_sysprompt', oldValue: true, newKey: 'use_sysprompt', newValue: true },
        { oldKey: 'mistralai_model', oldValue: /^(mistral-medium|mistral-small)$/, newKey: 'mistralai_model', newValue: (settings.mistralai_model + '-latest') },
        { oldKey: 'deepseek_model', oldValue: /^deepseek-(chat|reasoner|coder)$/, newKey: 'deepseek_model', newValue: 'deepseek-v4-flash' },
        { oldKey: 'openrouter_sort_models', oldValue: 'alphabetically', newKey: 'sort_models', newValue: 'alphabetically' },
        { oldKey: 'openrouter_sort_models', oldValue: 'pricing.prompt', newKey: 'sort_models', newValue: 'pricing.prompt' },
        { oldKey: 'openrouter_sort_models', oldValue: 'context_length', newKey: 'sort_models', newValue: 'context_length' },
        { oldKey: 'openrouter_group_models', oldValue: true, newKey: 'group_models', newValue: true },
    ];

    for (const migration of migrateMap) {
        if (Object.hasOwn(settings, migration.oldKey)) {
            const shouldMigrate = migration.oldValue instanceof RegExp
                ? migration.oldValue.test(settings[migration.oldKey])
                : settings[migration.oldKey] === migration.oldValue;
            if (shouldMigrate) {
                settings[migration.newKey] = migration.newValue;
            }
            if (migration.oldKey !== migration.newKey) {
                delete settings[migration.oldKey];
            }
        }
    }
}

/** @type {Record<string, [string, string, boolean, boolean]>} */
export const settingsToUpdate = {
    chat_completion_source: ['#chat_completion_source', 'chat_completion_source', false, true],
    temperature: ['#temp_openai', 'temp_openai', false, false],
    frequency_penalty: ['#freq_pen_openai', 'freq_pen_openai', false, false],
    presence_penalty: ['#pres_pen_openai', 'pres_pen_openai', false, false],
    top_p: ['#top_p_openai', 'top_p_openai', false, false],
    top_k: ['#top_k_openai', 'top_k_openai', false, false],
    top_a: ['#top_a_openai', 'top_a_openai', false, false],
    min_p: ['#min_p_openai', 'min_p_openai', false, false],
    repetition_penalty: ['#repetition_penalty_openai', 'repetition_penalty_openai', false, false],
    max_context_unlocked: ['#oai_max_context_unlocked', 'max_context_unlocked', true, false],
    group_models: ['#cc_group_models', 'group_models', true, true],
    sort_models: ['#cc_sort_models', 'sort_models', false, true],
    openai_model: ['#model_openai_select', 'openai_model', false, true],
    claude_model: ['#model_claude_select', 'claude_model', false, true],
    openrouter_model: ['#model_openrouter_select', 'openrouter_model', false, true],
    openrouter_use_fallback: ['#openrouter_use_fallback', 'openrouter_use_fallback', true, true],
    openrouter_providers: ['#openrouter_providers_chat', 'openrouter_providers', false, true],
    openrouter_quantizations: ['#openrouter_quantizations_chat', 'openrouter_quantizations', false, true],
    openrouter_allow_fallbacks: ['#openrouter_allow_fallbacks', 'openrouter_allow_fallbacks', true, true],
    openrouter_middleout: ['#openrouter_middleout', 'openrouter_middleout', false, true],
    tool_reasoning_mode: ['#tool_reasoning_mode', 'tool_reasoning_mode', false, false],
    ai21_model: ['#model_ai21_select', 'ai21_model', false, true],
    mistralai_model: ['#model_mistralai_select', 'mistralai_model', false, true],
    cohere_model: ['#model_cohere_select', 'cohere_model', false, true],
    perplexity_model: ['#model_perplexity_select', 'perplexity_model', false, true],
    groq_model: ['#model_groq_select', 'groq_model', false, true],
    chutes_model: ['#model_chutes_select', 'chutes_model', false, true],
    siliconflow_model: ['#model_siliconflow_select', 'siliconflow_model', false, true],
    siliconflow_endpoint: ['#siliconflow_endpoint', 'siliconflow_endpoint', false, true],
    minimax_model: ['#model_minimax_select', 'minimax_model', false, true],
    minimax_endpoint: ['#minimax_endpoint', 'minimax_endpoint', false, true],
    electronhub_model: ['#model_electronhub_select', 'electronhub_model', false, true],
    nanogpt_model: ['#model_nanogpt_select', 'nanogpt_model', false, true],
    nanogpt_provider: ['#nanogpt_provider', 'nanogpt_provider', false, true],
    nanogpt_payg_override: ['#nanogpt_payg_override', 'nanogpt_payg_override', true, true],
    deepseek_model: ['#model_deepseek_select', 'deepseek_model', false, true],
    aimlapi_model: ['#model_aimlapi_select', 'aimlapi_model', false, true],
    xai_model: ['#model_xai_select', 'xai_model', false, true],
    pollinations_model: ['#model_pollinations_select', 'pollinations_model', false, true],
    pollinations_endpoint: ['#pollinations_endpoint', 'pollinations_endpoint', false, true],
    moonshot_model: ['#model_moonshot_select', 'moonshot_model', false, true],
    fireworks_model: ['#model_fireworks_select', 'fireworks_model', false, true],
    cometapi_model: ['#model_cometapi_select', 'cometapi_model', false, true],
    custom_model: ['#custom_model_id', 'custom_model', false, true],
    custom_url: ['#custom_api_url_text', 'custom_url', false, true],
    custom_include_body: ['#custom_include_body', 'custom_include_body', false, true],
    custom_exclude_body: ['#custom_exclude_body', 'custom_exclude_body', false, true],
    custom_include_headers: ['#custom_include_headers', 'custom_include_headers', false, true],
    custom_prompt_post_processing: ['#custom_prompt_post_processing', 'custom_prompt_post_processing', false, true],
    google_model: ['#model_google_select', 'google_model', false, true],
    vertexai_model: ['#model_vertexai_select', 'vertexai_model', false, true],
    zai_model: ['#model_zai_select', 'zai_model', false, true],
    zai_endpoint: ['#zai_endpoint', 'zai_endpoint', false, true],
    workers_ai_model: ['#model_workers_ai_select', 'workers_ai_model', false, true],
    workers_ai_account_id: ['#workers_ai_account_id', 'workers_ai_account_id', false, true],
    openai_max_context: ['#openai_max_context', 'openai_max_context', false, false],
    openai_max_tokens: ['#openai_max_tokens', 'openai_max_tokens', false, false],
    names_behavior: ['#names_behavior', 'names_behavior', false, false],
    send_if_empty: ['#send_if_empty_textarea', 'send_if_empty', false, false],
    impersonation_prompt: ['#impersonation_prompt_textarea', 'impersonation_prompt', false, false],
    new_chat_prompt: ['#newchat_prompt_textarea', 'new_chat_prompt', false, false],
    new_group_chat_prompt: ['#newgroupchat_prompt_textarea', 'new_group_chat_prompt', false, false],
    new_example_chat_prompt: ['#newexamplechat_prompt_textarea', 'new_example_chat_prompt', false, false],
    continue_nudge_prompt: ['#continue_nudge_prompt_textarea', 'continue_nudge_prompt', false, false],
    bias_preset_selected: ['#openai_logit_bias_preset', 'bias_preset_selected', false, false],
    reverse_proxy: ['#openai_reverse_proxy', 'reverse_proxy', false, true],
    wi_format: ['#wi_format_textarea', 'wi_format', false, false],
    scenario_format: ['#scenario_format_textarea', 'scenario_format', false, false],
    personality_format: ['#personality_format_textarea', 'personality_format', false, false],
    group_nudge_prompt: ['#group_nudge_prompt_textarea', 'group_nudge_prompt', false, false],
    stream_openai: ['#stream_toggle', 'stream_openai', true, false],
    prompts: ['', 'prompts', false, false],
    prompt_order: ['', 'prompt_order', false, false],
    show_external_models: ['#openai_show_external_models', 'show_external_models', true, true],
    proxy_password: ['#openai_proxy_access_key', 'proxy_password', false, true],
    assistant_prefill: ['#claude_assistant_prefill', 'assistant_prefill', false, false],
    assistant_impersonation: ['#claude_assistant_impersonation', 'assistant_impersonation', false, false],
    use_sysprompt: ['#use_sysprompt', 'use_sysprompt', true, false],
    vertexai_auth_mode: ['#vertexai_auth_mode', 'vertexai_auth_mode', false, true],
    vertexai_region: ['#vertexai_region', 'vertexai_region', false, true],
    vertexai_express_project_id: ['#vertexai_express_project_id', 'vertexai_express_project_id', false, true],
    squash_system_messages: ['#squash_system_messages', 'squash_system_messages', true, false],
    media_inlining: ['#openai_media_inlining', 'media_inlining', true, false],
    inline_image_quality: ['#openai_inline_image_quality', 'inline_image_quality', false, false],
    continue_prefill: ['#continue_prefill', 'continue_prefill', true, false],
    continue_postfix: ['#continue_postfix', 'continue_postfix', false, false],
    function_calling: ['#openai_function_calling', 'function_calling', true, false],
    tool_call_recurse_limit: ['#tool_call_recurse_limit', 'tool_call_recurse_limit', false, false],
    show_thoughts: ['#openai_show_thoughts', 'show_thoughts', true, false],
    reasoning_effort: ['#openai_reasoning_effort', 'reasoning_effort', false, false],
    verbosity: ['#openai_verbosity', 'verbosity', false, false],
    enable_web_search: ['#openai_enable_web_search', 'enable_web_search', true, false],
    seed: ['#seed_openai', 'seed', false, false],
    n: ['#n_openai', 'n', false, false],
    bypass_status_check: ['#openai_bypass_status_check', 'bypass_status_check', true, true],
    request_images: ['#openai_request_images', 'request_images', true, false],
    request_image_aspect_ratio: ['#request_image_aspect_ratio', 'request_image_aspect_ratio', false, false],
    request_image_resolution: ['#request_image_resolution', 'request_image_resolution', false, false],
    azure_base_url: ['#azure_base_url', 'azure_base_url', false, true],
    azure_deployment_name: ['#azure_deployment_name', 'azure_deployment_name', false, true],
    azure_api_version: ['#azure_api_version', 'azure_api_version', false, true],
    azure_openai_model: ['#azure_openai_model', 'azure_openai_model', false, true],
    extensions: ['#NULL_SELECTOR', 'extensions', false, false],
};

/**
 * @param {Record<string, any> | undefined} saved
 * @returns {Record<string, any>}
 */
export function chatCompletionSettingsWithDefaults(saved) {
    const settings = structuredClone(saved ?? {});
    migrateChatCompletionSettings(settings);
    for (const key of Object.keys(default_settings)) {
        settings[key] = settings[key] ?? structuredClone(default_settings[key]);
    }
    return settings;
}

export const CONNECTION_PRESET_KEYS = Object.freeze(Object.entries(settingsToUpdate).filter(([, [, , , isConnection]]) => isConnection).map(([key]) => key));
