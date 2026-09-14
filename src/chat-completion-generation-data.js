import { CHAT_COMPLETION_SOURCES, ZAI_ENDPOINT, POLLINATIONS_ENDPOINT, SILICONFLOW_ENDPOINT, MINIMAX_ENDPOINT } from './constants.js';
import { substituteParams } from './macro-substitution.js';
import { computeLogitBias } from './endpoints/tokenizers.js';

/**
 * Server-side port of public/scripts/chat-completion-settings.js's createGenerationParameters() -
 * builds the sampler/request-shape payload for every chat-completion source. This does NOT decide
 * which source to use (settings.chat_completion_source is an input, same as the client function);
 * it only shapes the payload given one.
 *
 * The server's per-vendor dispatch functions in src/endpoints/backends/chat-completions.js
 * (sendClaudeRequest, etc.) already independently re-derive some model-capability flags (e.g.
 * Claude's thinking/verbosity detection via regex on request.body.model) - this port does not try
 * to reconcile that overlap; it's a faithful port of the client function as its own piece, flagged
 * for a later pass to de-duplicate against the existing dispatch functions.
 *
 * logitBias is now computed for real: the client's calculateLogitBias() (public/scripts/chat-
 * completion-settings.js) turned out to do no computation of its own - it just POSTs
 * bias_presets[bias_preset_selected] to the server's existing `/api/backends/chat-completions/bias`
 * route (src/endpoints/backends/chat-completions.js), which does the actual tokenizer-based work
 * in-process. That route's core logic is now extracted into src/endpoints/tokenizers.js's exported
 * computeLogitBias(), which this module calls directly given a `biasPresetEntries` context param
 * (the same bias_presets[bias_preset_selected]-shaped array the client sends) - so the previously
 * "not portable, needs the server's own tokenizer access" characterization was wrong: the server
 * already has full tokenizer access via src/endpoints/tokenizers.js. A pre-resolved `logitBias`
 * override is still accepted (and takes priority) for callers that already have one, mirroring the
 * `toolsPayload` escape-hatch convention used elsewhere in this module.
 *
 * Deliberately taken as explicit context parameters instead of ported (each needs its own
 * server-side capability that doesn't exist yet, or is genuinely external/live data):
 * - getStoppingStrings(limit) - a function, not a flat array, because the original calls
 *   getCustomStoppingStrings() with a DIFFERENT limit per source (default openai_max_stop_strings,
 *   unlimited for Claude/Mistral/Chutes, 5 for MakerSuite/VertexAI/Cohere, 1 for ZAI) - a flat
 *   array can't represent that. getCustomStoppingStrings() itself depends on macro substitution
 *   (ported, ported callers should use src/macro-substitution.js) plus an "ephemeral stopping
 *   strings" concept that isn't ported anywhere yet (same gap as the textgen port).
 * - groupNames - getGroupNames() reads the live group/character store.
 * - useLogprobs - power_user.request_token_probabilities, a plain setting the caller already
 *   resolves for other reasons.
 * - electronHubReasoningEfforts - ELECTRONHUB's supported_reasoning_efforts lookup depends on
 *   model_list, a live list fetched from the provider - not server-stored data.
 * - toolsPayload - tool-calling registration (ToolManager.registerFunctionToolsOpenAI) depends on
 *   isToolCallingSupported()'s model_list lookup (live provider data) and extension-registered tool
 *   definitions (no server registry exists, same category as MacrosParser-registered macros). This
 *   function only replicates the pure `!canMultiSwipe` gate; the caller resolves whether tools
 *   should be sent at all and what they contain.
 * - reverseProxyValidated - validateReverseProxy() shows a user confirmation popup for an unusual
 *   proxy URL; that UX belongs to whoever collects reverse_proxy/proxy_password as a setting, not
 *   here. This just uses settings.reverse_proxy/proxy_password as given.
 * - macroContext - passed through to substituteParams() for assistant_prefill/custom_include_body/etc.
 * - chatId - getCurrentChatId(), only used for FIREWORKS's chat_id field; the caller already knows
 *   which chat this generation belongs to.
 */

const openaiMaxStopStrings = 4;

// "OpenAI-like" sources.
const gptSources = [CHAT_COMPLETION_SOURCES.OPENAI, CHAT_COMPLETION_SOURCES.AZURE_OPENAI, CHAT_COMPLETION_SOURCES.OPENROUTER];

const seedSupportedSources = [
    CHAT_COMPLETION_SOURCES.OPENAI, CHAT_COMPLETION_SOURCES.AZURE_OPENAI, CHAT_COMPLETION_SOURCES.OPENROUTER,
    CHAT_COMPLETION_SOURCES.MISTRALAI, CHAT_COMPLETION_SOURCES.CUSTOM, CHAT_COMPLETION_SOURCES.COHERE,
    CHAT_COMPLETION_SOURCES.GROQ, CHAT_COMPLETION_SOURCES.ELECTRONHUB, CHAT_COMPLETION_SOURCES.NANOGPT,
    CHAT_COMPLETION_SOURCES.XAI, CHAT_COMPLETION_SOURCES.POLLINATIONS, CHAT_COMPLETION_SOURCES.AIMLAPI,
    CHAT_COMPLETION_SOURCES.VERTEXAI, CHAT_COMPLETION_SOURCES.MAKERSUITE, CHAT_COMPLETION_SOURCES.CHUTES,
];

const proxySupportedSources = [
    CHAT_COMPLETION_SOURCES.CLAUDE, CHAT_COMPLETION_SOURCES.OPENAI, CHAT_COMPLETION_SOURCES.MISTRALAI,
    CHAT_COMPLETION_SOURCES.MAKERSUITE, CHAT_COMPLETION_SOURCES.VERTEXAI, CHAT_COMPLETION_SOURCES.DEEPSEEK,
    CHAT_COMPLETION_SOURCES.XAI, CHAT_COMPLETION_SOURCES.ZAI, CHAT_COMPLETION_SOURCES.MOONSHOT,
];

const logprobsSupportedSources = [
    CHAT_COMPLETION_SOURCES.OPENAI, CHAT_COMPLETION_SOURCES.AZURE_OPENAI, CHAT_COMPLETION_SOURCES.OPENROUTER,
    CHAT_COMPLETION_SOURCES.CUSTOM, CHAT_COMPLETION_SOURCES.DEEPSEEK, CHAT_COMPLETION_SOURCES.XAI,
    CHAT_COMPLETION_SOURCES.AIMLAPI, CHAT_COMPLETION_SOURCES.CHUTES,
];

// Exported so a caller can replicate the client's gating decision for whether to compute a bias at
// all (bias_preset_selected && logitBiasSources.includes(source) && non-empty bias_presets entry).
export const logitBiasSources = [
    CHAT_COMPLETION_SOURCES.OPENAI, CHAT_COMPLETION_SOURCES.AZURE_OPENAI, CHAT_COMPLETION_SOURCES.OPENROUTER,
    CHAT_COMPLETION_SOURCES.ELECTRONHUB, CHAT_COMPLETION_SOURCES.CHUTES, CHAT_COMPLETION_SOURCES.CUSTOM,
];

const multiswipeSources = [
    CHAT_COMPLETION_SOURCES.OPENAI, CHAT_COMPLETION_SOURCES.AZURE_OPENAI, CHAT_COMPLETION_SOURCES.CUSTOM,
    CHAT_COMPLETION_SOURCES.XAI, CHAT_COMPLETION_SOURCES.AIMLAPI, CHAT_COMPLETION_SOURCES.MOONSHOT,
];

const reasoningEffortSources = [
    CHAT_COMPLETION_SOURCES.OPENAI, CHAT_COMPLETION_SOURCES.AZURE_OPENAI, CHAT_COMPLETION_SOURCES.CUSTOM,
    CHAT_COMPLETION_SOURCES.XAI, CHAT_COMPLETION_SOURCES.AIMLAPI, CHAT_COMPLETION_SOURCES.OPENROUTER,
    CHAT_COMPLETION_SOURCES.POLLINATIONS, CHAT_COMPLETION_SOURCES.PERPLEXITY, CHAT_COMPLETION_SOURCES.COMETAPI,
    CHAT_COMPLETION_SOURCES.ELECTRONHUB, CHAT_COMPLETION_SOURCES.CHUTES, CHAT_COMPLETION_SOURCES.DEEPSEEK,
    CHAT_COMPLETION_SOURCES.FIREWORKS,
];

const reasoning_effort_types = { auto: 'auto', low: 'low', medium: 'medium', high: 'high', min: 'min', max: 'max' };
export const verbosity_levels = { auto: 'auto', low: 'low', medium: 'medium', high: 'high' };

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

/** Mirrors getReasoningEffort() in public/scripts/chat-completion-settings.js. */
function getReasoningEffort(settings, model, { electronHubReasoningEfforts = null } = {}) {
    if (!reasoningEffortSources.includes(settings.chat_completion_source)) {
        return settings.reasoning_effort;
    }

    function resolveReasoningEffort() {
        if (settings.chat_completion_source === CHAT_COMPLETION_SOURCES.DEEPSEEK) {
            switch (settings.reasoning_effort) {
                case reasoning_effort_types.auto: return undefined;
                case reasoning_effort_types.min:
                case reasoning_effort_types.low: return reasoning_effort_types.low;
                case reasoning_effort_types.max: return reasoning_effort_types.max;
                default: return reasoning_effort_types.high;
            }
        }

        if (settings.chat_completion_source === CHAT_COMPLETION_SOURCES.FIREWORKS) {
            switch (settings.reasoning_effort) {
                case reasoning_effort_types.auto: return undefined;
                case reasoning_effort_types.min: return reasoning_effort_types.low;
                default: return settings.reasoning_effort;
            }
        }

        if (settings.chat_completion_source === CHAT_COMPLETION_SOURCES.CUSTOM && /^koboldcpp\/(.+)$/.test(model)) {
            switch (settings.reasoning_effort) {
                case reasoning_effort_types.auto: return undefined;
                case reasoning_effort_types.min: return 'minimal';
                case reasoning_effort_types.low: return 'low';
                case reasoning_effort_types.medium: return 'medium';
                case reasoning_effort_types.high: return 'high';
                case reasoning_effort_types.max: return 'xhigh';
                default: return settings.reasoning_effort;
            }
        }

        switch (settings.reasoning_effort) {
            case reasoning_effort_types.auto:
                return undefined;
            case reasoning_effort_types.min:
                if (CHAT_COMPLETION_SOURCES.OPENROUTER === settings.chat_completion_source && !settings.show_thoughts) {
                    return 'none';
                }
                if ([CHAT_COMPLETION_SOURCES.OPENAI, CHAT_COMPLETION_SOURCES.AZURE_OPENAI].includes(settings.chat_completion_source)) {
                    if (/^gpt-5\.(4|5|6)/.test(model)) return 'none';
                    if (/^gpt-5/.test(model)) return reasoning_effort_types.min;
                }
                return reasoning_effort_types.low;
            case reasoning_effort_types.max:
                if ([CHAT_COMPLETION_SOURCES.OPENAI, CHAT_COMPLETION_SOURCES.AZURE_OPENAI].includes(settings.chat_completion_source)
                    && /^gpt-5\.6/.test(model)) {
                    return 'xhigh';
                }
                return reasoning_effort_types.high;
            default:
                return settings.reasoning_effort;
        }
    }

    const reasoningEffort = resolveReasoningEffort();

    if (settings.chat_completion_source === CHAT_COMPLETION_SOURCES.ELECTRONHUB) {
        if (Array.isArray(electronHubReasoningEfforts) && reasoningEffort) {
            return electronHubReasoningEfforts.includes(reasoningEffort) ? reasoningEffort : undefined;
        }
    }

    return reasoningEffort;
}

/** Mirrors getVerbosity() in public/scripts/chat-completion-settings.js. */
function getVerbosity(settings) {
    if (settings.verbosity === verbosity_levels.auto) return undefined;
    return settings.verbosity;
}

/**
 * @typedef {object} ChatCompletionGenerationContext
 * @property {object} [jsonSchema]
 * @property {object} [logitBias] Escape hatch: an already-computed token-id-keyed bias map to use
 * as-is instead of computing one from `biasPresetEntries`. Takes priority when provided.
 * @property {{text?: string, value?: number}[]} [biasPresetEntries] Raw bias-preset entries -
 * settings.bias_presets[settings.bias_preset_selected] client-side - used to compute `logit_bias`
 * via computeLogitBias() (src/endpoints/tokenizers.js) when `logitBias` isn't given.
 * @property {(limit?: number) => string[]} [getStoppingStrings] Mirrors getCustomStoppingStrings(limit) - called with a different limit per source
 * @property {string[]} [groupNames]
 * @property {boolean} [useLogprobs]
 * @property {string[]} [electronHubReasoningEfforts]
 * @property {object} [toolsPayload] Already-resolved tool-calling fields to merge in when !canMultiSwipe, or undefined for none
 * @property {{name1?: string, name2?: string}} [macroContext]
 * @property {string} [chatId] getCurrentChatId() - only used for FIREWORKS's chat_id field
 */

/**
 * @param {object} settings oai_settings (or an equivalent object, e.g. a merged preset)
 * @param {string} model
 * @param {string} type 'quiet'/'impersonate'/'continue'/'normal'
 * @param {{role: string, content: any}[]} messages
 * @param {ChatCompletionGenerationContext} [context]
 * @returns {Promise<{generate_data: object, stream: boolean, canMultiSwipe: boolean}>}
 */
export async function createGenerationParameters(settings, model, type, messages, context = {}) {
    const {
        jsonSchema = null,
        logitBias: logitBiasOverride = undefined,
        biasPresetEntries = undefined,
        getStoppingStrings = () => [],
        groupNames = [],
        useLogprobs = false,
        electronHubReasoningEfforts = null,
        toolsPayload = undefined,
        macroContext = {},
        chatId = undefined,
    } = context;

    if (!Array.isArray(messages)) {
        throw new Error('messages must be an array');
    }
    messages = messages.filter(msg => msg && typeof msg === 'object');

    const isDeepSeekVisionModel = typeof model === 'string' && model.toLowerCase().includes('deepseek-v4-flash-vision-exp');
    if (isDeepSeekVisionModel) {
        messages = messages.flatMap((message) => {
            if (!['system', 'assistant'].includes(message.role) || !Array.isArray(message.content)) {
                return [message];
            }
            const content = message.content.filter(block => block?.type !== 'image_url');
            return content.length > 0 ? [{ ...message, content }] : [];
        });
    }

    const isO1 = gptSources.includes(settings.chat_completion_source) && ['o1-2024-12-17', 'o1'].includes(model);
    const isWorkersAIJsonMode = settings.chat_completion_source === CHAT_COMPLETION_SOURCES.WORKERS_AI && jsonSchema;
    const stream = settings.stream_openai && type !== 'quiet' && !isO1 && !isWorkersAIJsonMode;

    const noMultiSwipeTypes = ['quiet', 'impersonate', 'continue'];
    const canMultiSwipe = settings.n > 1 && !noMultiSwipeTypes.includes(type) && multiswipeSources.includes(settings.chat_completion_source);

    // Mirrors the original: defaults to {} (not undefined). Uses a pre-resolved override if given,
    // else computes a real bias map from biasPresetEntries - gated on the same
    // bias-preset-selected (non-empty entries array, standing in for it) + logitBiasSources
    // condition the client checks before calling calculateLogitBias().
    let logit_bias = {};
    if (logitBiasOverride !== undefined) {
        logit_bias = logitBiasOverride;
    } else if (Array.isArray(biasPresetEntries) && biasPresetEntries.length && logitBiasSources.includes(settings.chat_completion_source)) {
        logit_bias = await computeLogitBias(biasPresetEntries, model);
    }
    if (Object.keys(logit_bias).length === 0) {
        logit_bias = undefined;
    }

    const generate_data = {
        'type': type,
        'messages': messages,
        'model': model,
        'temperature': Number(settings.temp_openai),
        'frequency_penalty': Number(settings.freq_pen_openai),
        'presence_penalty': Number(settings.pres_pen_openai),
        'top_p': Number(settings.top_p_openai),
        'max_tokens': settings.openai_max_tokens,
        'stream': stream,
        'logit_bias': logit_bias,
        'stop': getStoppingStrings(openaiMaxStopStrings),
        'chat_completion_source': settings.chat_completion_source,
        'n': canMultiSwipe ? settings.n : undefined,
        'user_name': macroContext.name1,
        'char_name': macroContext.name2,
        'group_names': groupNames,
        'include_reasoning': Boolean(settings.show_thoughts),
        'reasoning_effort': getReasoningEffort(settings, model, { electronHubReasoningEfforts }),
        'enable_web_search': Boolean(settings.enable_web_search),
        'request_images': Boolean(settings.request_images),
        'request_image_resolution': String(settings.request_image_resolution),
        'request_image_aspect_ratio': String(settings.request_image_aspect_ratio),
        'custom_prompt_post_processing': settings.custom_prompt_post_processing,
        'verbosity': getVerbosity(settings),
    };

    if (settings.chat_completion_source === CHAT_COMPLETION_SOURCES.AZURE_OPENAI) {
        generate_data.azure_base_url = settings.azure_base_url;
        generate_data.azure_deployment_name = settings.azure_deployment_name;
        generate_data.azure_api_version = settings.azure_api_version;
        if (/^gpt-[34]/.test(model)) {
            delete generate_data.reasoning_effort;
        }
    }

    if (!canMultiSwipe && toolsPayload) {
        Object.assign(generate_data, toolsPayload);
    }

    if (!Array.isArray(generate_data.stop) || !generate_data.stop.length) {
        delete generate_data.stop;
    }

    if (settings.reverse_proxy && proxySupportedSources.includes(settings.chat_completion_source)) {
        generate_data.reverse_proxy = settings.reverse_proxy;
        generate_data.proxy_password = settings.proxy_password;
    }

    if (useLogprobs && logprobsSupportedSources.includes(settings.chat_completion_source)) {
        generate_data.logprobs = 5;
    }

    const isVision = (m) => ['gpt', 'vision'].every(x => typeof m === 'string' && m.includes(x));
    if (gptSources.includes(settings.chat_completion_source) && isVision(model)) {
        delete generate_data.logit_bias;
        delete generate_data.stop;
        delete generate_data.logprobs;
    }
    if (gptSources.includes(settings.chat_completion_source) && /gpt-4.5/.test(model)) {
        delete generate_data.logprobs;
    }

    if (settings.chat_completion_source === CHAT_COMPLETION_SOURCES.CLAUDE) {
        generate_data.top_k = Number(settings.top_k_openai);
        generate_data.use_sysprompt = settings.use_sysprompt;
        generate_data.stop = getStoppingStrings();
        if (type !== 'quiet' && !(type === 'continue' && settings.continue_prefill)) {
            generate_data.assistant_prefill = type === 'impersonate'
                ? substituteParams(settings.assistant_impersonation, macroContext)
                : substituteParams(settings.assistant_prefill, macroContext);
        }
    }

    if (settings.chat_completion_source === CHAT_COMPLETION_SOURCES.OPENROUTER) {
        generate_data.top_k = Number(settings.top_k_openai);
        generate_data.min_p = Number(settings.min_p_openai);
        generate_data.repetition_penalty = Number(settings.repetition_penalty_openai);
        generate_data.top_a = Number(settings.top_a_openai);
        generate_data.use_fallback = settings.openrouter_use_fallback;
        generate_data.provider = settings.openrouter_providers;
        generate_data.quantizations = settings.openrouter_quantizations;
        generate_data.allow_fallbacks = settings.openrouter_allow_fallbacks;
        generate_data.middleout = settings.openrouter_middleout;
    }

    if (settings.chat_completion_source === CHAT_COMPLETION_SOURCES.NANOGPT) {
        generate_data.nanogpt_provider = settings.nanogpt_provider;
        generate_data.nanogpt_payg_override = settings.nanogpt_payg_override;
    }

    if (settings.chat_completion_source === CHAT_COMPLETION_SOURCES.FIREWORKS && type !== 'quiet') {
        generate_data.chat_id = chatId;
    }

    if ([CHAT_COMPLETION_SOURCES.MAKERSUITE, CHAT_COMPLETION_SOURCES.VERTEXAI].includes(settings.chat_completion_source)) {
        const stopStringsLimit = 5;
        generate_data.top_k = Number(settings.top_k_openai);
        generate_data.stop = getStoppingStrings(stopStringsLimit).slice(0, stopStringsLimit).filter(x => x.length >= 1 && x.length <= 16);
        generate_data.use_sysprompt = settings.use_sysprompt;
        if (settings.chat_completion_source === CHAT_COMPLETION_SOURCES.VERTEXAI) {
            generate_data.vertexai_auth_mode = settings.vertexai_auth_mode;
            generate_data.vertexai_region = settings.vertexai_region;
            generate_data.vertexai_express_project_id = settings.vertexai_express_project_id;
        }
    }

    if (settings.chat_completion_source === CHAT_COMPLETION_SOURCES.MISTRALAI) {
        generate_data.safe_prompt = false;
        generate_data.stop = getStoppingStrings();
    }

    if (settings.chat_completion_source === CHAT_COMPLETION_SOURCES.CUSTOM) {
        generate_data.custom_url = settings.custom_url;
        generate_data.custom_include_body = substituteParams(settings.custom_include_body, macroContext);
        generate_data.custom_exclude_body = substituteParams(settings.custom_exclude_body, macroContext);
        generate_data.custom_include_headers = substituteParams(settings.custom_include_headers, macroContext);
    }

    if (settings.chat_completion_source === CHAT_COMPLETION_SOURCES.COHERE) {
        generate_data.top_p = clamp(Number(settings.top_p_openai), 0.01, 0.99);
        generate_data.top_k = Number(settings.top_k_openai);
        generate_data.frequency_penalty = clamp(Number(settings.freq_pen_openai), 0, 1);
        generate_data.presence_penalty = clamp(Number(settings.pres_pen_openai), 0, 1);
        generate_data.stop = getStoppingStrings(5);
    }

    if (settings.chat_completion_source === CHAT_COMPLETION_SOURCES.PERPLEXITY) {
        generate_data.frequency_penalty = Number(settings.freq_pen_openai);
        generate_data.presence_penalty = Number(settings.pres_pen_openai);
        delete generate_data.stop;
    }

    if (settings.chat_completion_source === CHAT_COMPLETION_SOURCES.GROQ) {
        delete generate_data.logprobs;
        delete generate_data.logit_bias;
        delete generate_data.top_logprobs;
        delete generate_data.n;
    }

    if (settings.chat_completion_source === CHAT_COMPLETION_SOURCES.DEEPSEEK) {
        generate_data.top_p = generate_data.top_p || Number.EPSILON;
    }

    if (settings.chat_completion_source === CHAT_COMPLETION_SOURCES.XAI) {
        if (model.includes('grok-3-mini')) {
            delete generate_data.presence_penalty;
            delete generate_data.frequency_penalty;
            delete generate_data.stop;
        } else {
            delete generate_data.reasoning_effort;
        }

        if (model.includes('grok-4') || model.includes('grok-code')) {
            delete generate_data.presence_penalty;
            delete generate_data.frequency_penalty;
            if (!model.includes('grok-4-fast-non-reasoning')) {
                delete generate_data.stop;
            }
        }
    }

    if (settings.chat_completion_source === CHAT_COMPLETION_SOURCES.ELECTRONHUB) {
        generate_data.top_k = Number(settings.top_k_openai);
    }

    if (settings.chat_completion_source === CHAT_COMPLETION_SOURCES.CHUTES) {
        generate_data.min_p = Number(settings.min_p_openai);
        generate_data.top_k = settings.top_k_openai > 0 ? Number(settings.top_k_openai) : undefined;
        generate_data.repetition_penalty = Number(settings.repetition_penalty_openai);
        generate_data.stop = getStoppingStrings();
    }

    if (settings.chat_completion_source === CHAT_COMPLETION_SOURCES.ZAI) {
        generate_data.top_p = generate_data.top_p || 0.01;
        generate_data.stop = getStoppingStrings(1);
        generate_data.zai_endpoint = settings.zai_endpoint || ZAI_ENDPOINT.COMMON;
        delete generate_data.presence_penalty;
        delete generate_data.frequency_penalty;
    }

    if (settings.chat_completion_source === CHAT_COMPLETION_SOURCES.POLLINATIONS) {
        generate_data.pollinations_endpoint = settings.pollinations_endpoint || POLLINATIONS_ENDPOINT.AUTHENTICATED;
    }

    if (settings.chat_completion_source === CHAT_COMPLETION_SOURCES.SILICONFLOW) {
        generate_data.siliconflow_endpoint = settings.siliconflow_endpoint || SILICONFLOW_ENDPOINT.GLOBAL;
    }

    if (settings.chat_completion_source === CHAT_COMPLETION_SOURCES.MINIMAX) {
        generate_data.minimax_endpoint = settings.minimax_endpoint || MINIMAX_ENDPOINT.GLOBAL;
        if (Number.isFinite(generate_data.temperature)) {
            generate_data.temperature = clamp(generate_data.temperature, Number.EPSILON, 1.0);
        }
    }

    if (settings.chat_completion_source === CHAT_COMPLETION_SOURCES.WORKERS_AI) {
        generate_data.workers_ai_account_id = settings.workers_ai_account_id;
        generate_data.top_k = settings.top_k_openai > 0 ? Math.min(Number(settings.top_k_openai), 50) : undefined;
        generate_data.repetition_penalty = Number(settings.repetition_penalty_openai);
        generate_data.seed = settings.seed >= 1 ? Number(settings.seed) : undefined;
        generate_data.top_p = Math.max(Number(settings.top_p_openai), 0.001);
        delete generate_data.n;
        delete generate_data.logit_bias;
    }

    if (settings.chat_completion_source === CHAT_COMPLETION_SOURCES.NANOGPT) {
        generate_data.top_k = Number(settings.top_k_openai);
        generate_data.min_p = Number(settings.min_p_openai);
        generate_data.repetition_penalty = Number(settings.repetition_penalty_openai);
        generate_data.top_a = Number(settings.top_a_openai);
    }

    if (settings.chat_completion_source === CHAT_COMPLETION_SOURCES.MOONSHOT) {
        if (/kimi-k2.5/.test(model)) {
            delete generate_data.temperature;
            delete generate_data.top_p;
            delete generate_data.frequency_penalty;
            delete generate_data.presence_penalty;
        }
    }

    if (seedSupportedSources.includes(settings.chat_completion_source) && settings.seed >= 0) {
        generate_data.seed = settings.seed;
    }

    if ([CHAT_COMPLETION_SOURCES.OPENAI, CHAT_COMPLETION_SOURCES.AZURE_OPENAI].includes(settings.chat_completion_source) && /^(o1|o3|o4)/.test(model) ||
        (CHAT_COMPLETION_SOURCES.OPENROUTER === settings.chat_completion_source && /^openai\/(o1|o3|o4)/.test(model))) {
        generate_data.max_completion_tokens = generate_data.max_tokens;
        delete generate_data.max_tokens;
        delete generate_data.logprobs;
        delete generate_data.top_logprobs;
        delete generate_data.stop;
        delete generate_data.logit_bias;
        delete generate_data.temperature;
        delete generate_data.top_p;
        delete generate_data.frequency_penalty;
        delete generate_data.presence_penalty;
        if (/^(openai\/)?(o1)/.test(model)) {
            generate_data.messages.forEach((msg) => {
                if (msg.role === 'system') {
                    msg.role = 'user';
                }
            });
            delete generate_data.n;
            delete generate_data.tools;
            delete generate_data.tool_choice;
        }
    }

    if (gptSources.includes(settings.chat_completion_source) && /gpt-5/.test(model)) {
        generate_data.max_completion_tokens = generate_data.max_tokens;
        delete generate_data.max_tokens;
        delete generate_data.logprobs;
        delete generate_data.top_logprobs;
        if (/gpt-5-chat-latest/.test(model)) {
            delete generate_data.tools;
            delete generate_data.tool_choice;
        } else if (/gpt-5\.(1|2|3|4)/.test(model) && !/chat-latest/.test(model) && !generate_data.reasoning_effort) {
            delete generate_data.frequency_penalty;
            delete generate_data.presence_penalty;
            delete generate_data.logit_bias;
            delete generate_data.stop;
        } else {
            delete generate_data.temperature;
            delete generate_data.top_p;
            delete generate_data.frequency_penalty;
            delete generate_data.presence_penalty;
            delete generate_data.logit_bias;
            delete generate_data.stop;
        }
    }

    if (/claude-(fable|opus-5|sonnet-5)/.test(model)) {
        delete generate_data.temperature;
        delete generate_data.top_p;
        delete generate_data.top_k;
        delete generate_data.frequency_penalty;
        delete generate_data.presence_penalty;
        if (settings.chat_completion_source !== CHAT_COMPLETION_SOURCES.CLAUDE) {
            delete generate_data.reasoning_effort;
        }
    }

    if (jsonSchema) {
        generate_data.json_schema = jsonSchema;
    }

    return { generate_data, stream, canMultiSwipe };
}
