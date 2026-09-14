import { TEXTGEN_TYPES } from './constants.js';
import { substituteParams } from './macro-substitution.js';
import { computeTextgenLogitBias } from './endpoints/tokenizers.js';

/**
 * Server-side port of public/scripts/textgen-settings.js's createTextGenGenerationData() - builds
 * the sampler/request-shape payload for every textgenerationwebui backend type.
 *
 * api_type/api_server are NOT part of the output - src/textgen-backend-resolve.js already resolves
 * those server-side, and model resolution (getTextGenModel) lives there too; this takes `model` as
 * an already-resolved parameter, matching the original function's own signature.
 *
 * logitBias is now computed for real (this session, same pass as chat-completion-generation-data.js's
 * equivalent fix): the client's calculateLogitBias() (public/scripts/textgen-settings.js) does no
 * computation of its own beyond dispatching to getTokenizerForTokenIds() + getLogitBiasListResult() -
 * both of which bottom out in either an already-in-process local tokenizer or one of the server's own
 * existing remote-tokenize routes. Ported as computeTextgenLogitBias() (src/endpoints/tokenizers.js),
 * called directly against `settings.logit_bias` (the raw preset array - textgen keeps it inline on
 * settings, unlike chat-completion's separate bias_presets/bias_preset_selected indirection) via the
 * `logitBiasContext` context param. A pre-resolved `logitBias` override is still accepted (and takes
 * priority) for callers that already have one, mirroring the `logitBiasOverride` escape-hatch
 * convention from that same chat-completion port.
 *
 * Deliberately taken as explicit context parameters instead of ported (each needs its own
 * server-side capability that doesn't exist yet, tracked separately from this piece):
 * - bannedTokens/bannedStrings - getCustomTokenBans() needs the server's own tokenizer access to
 *   turn ban strings into token ids.
 * - stoppingStrings - getStoppingStrings() depends on instruct-mode stopping sequences and
 *   getCustomStoppingStrings()'s macro substitution + "ephemeral stopping strings" concept, which
 *   isn't ported. Pass the fully-resolved array in; used verbatim for both `stop` and
 *   `stopping_strings`, matching the original calling getStoppingStrings() twice for the same value.
 * - maxContext - the client's global `max_context`; this is really a resolved-settings value the
 *   caller already has to compute for other reasons (prompt budget), not specific to this function.
 * - requestTokenProbabilities - the client's power_user.request_token_probabilities setting.
 * - macroContext - passed through to substituteParams() for settings.negative_prompt; optional,
 *   defaults to {} (empty user/char context - substituteParams degrades gracefully).
 */

/** Mirrors public/scripts/textgen-settings.js's toIntArray(). */
function toIntArray(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value.map(x => parseInt(x)).filter(x => !isNaN(x));
    return String(value).split(',').map(x => parseInt(x)).filter(x => !isNaN(x));
}

function arraysEqual(a, b) {
    if (a === b) return true;
    if (a == null || b == null) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

function isPlainObject(item) {
    return !!(item && typeof item === 'object' && !Array.isArray(item));
}

/** Mirrors public/scripts/textgen-settings.js's getLogprobsNumber(). */
function getLogprobsNumber(type) {
    if (type === TEXTGEN_TYPES.VLLM || type === TEXTGEN_TYPES.INFERMATICAI) return 5;
    return 10;
}

// Static source: public/index.html's #dynatemp_block_ooba element's data-tg-type attribute -
// which backend types show/support the dynamic-temperature UI block. Not runtime data, just baked
// into the template rather than JS; mirror it here rather than reading a DOM attribute that has no
// server equivalent.
const DYNATEMP_SUPPORTED_TYPES = [
    TEXTGEN_TYPES.OOBA, TEXTGEN_TYPES.MANCER, TEXTGEN_TYPES.KOBOLDCPP,
    TEXTGEN_TYPES.TABBY, TEXTGEN_TYPES.LLAMACPP, TEXTGEN_TYPES.APHRODITE,
];

function isDynamicTemperatureSupported(settings) {
    return !!(settings.dynatemp && DYNATEMP_SUPPORTED_TYPES.includes(settings.type));
}

export const APHRODITE_DEFAULT_ORDER = [
    'dry', 'penalties', 'no_repeat_ngram', 'temperature', 'top_nsigma', 'top_p_top_k',
    'top_a', 'min_p', 'tfs', 'eta_cutoff', 'epsilon_cutoff', 'typical_p', 'quadratic', 'xtc',
];

const { OOBA, MANCER, VLLM, APHRODITE, TABBY, KOBOLDCPP, LLAMACPP, OLLAMA, INFERMATICAI, DREAMGEN, OPENROUTER, HUGGINGFACE } = TEXTGEN_TYPES;

/**
 * @typedef {object} TextGenGenerationDataContext
 * @property {string[]} [stoppingStrings] Fully-resolved stop strings (instruct sequences + custom stopping strings)
 * @property {string} [bannedTokens] Raw banned-token line/array data, same shape getCustomTokenBans() would return
 * @property {string[]} [bannedStrings]
 * @property {object} [logitBias] Escape hatch: an already-computed token-id-keyed bias map to use
 * as-is instead of computing one from `settings.logit_bias` via computeTextgenLogitBias(). Takes
 * priority when provided.
 * @property {object} [logitBiasContext] `{tokenizerOptions, remoteContext}` forwarded to
 * computeTextgenLogitBias() (src/endpoints/tokenizers.js) when `logitBias` isn't given - see that
 * function's doc comment for every field. Both default to `{}`, matching computeTextgenLogitBias()'s
 * own defaults.
 * @property {number} [maxContext]
 * @property {boolean} [requestTokenProbabilities]
 * @property {{name1?: string, name2?: string}} [macroContext] For substituting settings.negative_prompt
 */

/**
 * @param {object} settings textgenerationwebui_settings (or an equivalent object, e.g. a merged preset)
 * @param {string} model Already-resolved model name
 * @param {string} finalPrompt
 * @param {number} maxTokens
 * @param {boolean} isImpersonate
 * @param {boolean} isContinue
 * @param {{guidanceScale?: {value: number}, negativePrompt?: string}} cfgValues
 * @param {string} [type] 'quiet'/'impersonate'/'continue'/'normal' - only affects whether multi-swipe (n>1) is allowed
 * @param {TextGenGenerationDataContext} [context]
 * @returns {Promise<object>}
 */
export async function createTextGenGenerationData(settings, model, finalPrompt, maxTokens, isImpersonate, isContinue, cfgValues, type = 'quiet', context = {}) {
    const {
        stoppingStrings = [],
        bannedTokens = '',
        bannedStrings = [],
        logitBias: logitBiasOverride = undefined,
        logitBiasContext = {},
        maxContext = 0,
        requestTokenProbabilities = false,
        macroContext = {},
    } = context;

    // Mirrors the original: computed only when settings.logit_bias (the raw preset array) is a
    // non-empty array - the exact same condition public/scripts/textgen-settings.js's
    // createTextGenGenerationData() checks before calling calculateLogitBias(settings). A
    // pre-resolved override takes priority when given.
    let logitBias = logitBiasOverride;
    if (logitBias === undefined && Array.isArray(settings.logit_bias) && settings.logit_bias.length) {
        const { tokenizerOptions = {}, remoteContext = {} } = logitBiasContext;
        logitBias = await computeTextgenLogitBias(settings.logit_bias, tokenizerOptions, remoteContext);
    }

    const canMultiSwipe = !isContinue && !isImpersonate && type !== 'quiet';
    const dynatemp = isDynamicTemperatureSupported(settings);
    const jsonSchema = isPlainObject(settings.json_schema)
        ? settings.json_schema_allow_empty
            ? settings.json_schema
            : Object.keys(settings.json_schema).length > 0 ? settings.json_schema : undefined
        : undefined;

    let params = {
        'prompt': finalPrompt,
        'model': model,
        'max_new_tokens': maxTokens,
        'max_tokens': maxTokens,
        'logprobs': requestTokenProbabilities ? getLogprobsNumber(settings.type) : undefined,
        'temperature': dynatemp ? (settings.min_temp + settings.max_temp) / 2 : settings.temp,
        'top_p': settings.top_p,
        'typical_p': settings.typical_p,
        'typical': settings.typical_p,
        'sampler_seed': settings.seed >= 0 ? settings.seed : undefined,
        'min_p': settings.min_p,
        'repetition_penalty': settings.rep_pen,
        'frequency_penalty': settings.freq_pen,
        'presence_penalty': settings.presence_pen,
        'top_k': settings.top_k,
        'skew': settings.skew,
        'min_length': settings.type === OOBA ? settings.min_length : undefined,
        'minimum_message_content_tokens': settings.type === DREAMGEN ? settings.min_length : undefined,
        'min_tokens': settings.min_length,
        'num_beams': settings.type === OOBA ? settings.num_beams : undefined,
        'length_penalty': settings.type === OOBA ? settings.length_penalty : undefined,
        'early_stopping': settings.type === OOBA ? settings.early_stopping : undefined,
        'add_bos_token': settings.add_bos_token,
        'dynamic_temperature': dynatemp ? true : undefined,
        'dynatemp_low': dynatemp ? settings.min_temp : undefined,
        'dynatemp_high': dynatemp ? settings.max_temp : undefined,
        'dynatemp_range': dynatemp ? (settings.max_temp - settings.min_temp) / 2 : undefined,
        'dynatemp_exponent': dynatemp ? settings.dynatemp_exponent : undefined,
        'smoothing_factor': settings.smoothing_factor,
        'smoothing_curve': settings.smoothing_curve,
        'dry_allowed_length': settings.dry_allowed_length,
        'dry_multiplier': settings.dry_multiplier,
        'dry_base': settings.dry_base,
        'dry_sequence_breakers': substituteParams(settings.dry_sequence_breakers, macroContext),
        'dry_penalty_last_n': settings.dry_penalty_last_n,
        'max_tokens_second': settings.max_tokens_second,
        'sampler_priority': settings.type === OOBA ? settings.sampler_priority : undefined,
        'samplers': settings.type === LLAMACPP ? settings.samplers : undefined,
        'stopping_strings': stoppingStrings,
        'stop': stoppingStrings,
        'truncation_length': maxContext,
        'ban_eos_token': settings.ban_eos_token,
        'skip_special_tokens': settings.skip_special_tokens,
        'include_reasoning': settings.include_reasoning,
        'top_a': settings.top_a,
        'tfs': settings.tfs,
        'epsilon_cutoff': [OOBA, MANCER].includes(settings.type) ? settings.epsilon_cutoff : undefined,
        'eta_cutoff': [OOBA, MANCER].includes(settings.type) ? settings.eta_cutoff : undefined,
        'mirostat_mode': settings.mirostat_mode,
        'mirostat_tau': settings.mirostat_tau,
        'mirostat_eta': settings.mirostat_eta,
        'custom_token_bans': [APHRODITE, MANCER].includes(settings.type) ? toIntArray(bannedTokens) : bannedTokens,
        'banned_strings': bannedStrings,
        'sampler_order': settings.type === KOBOLDCPP ? settings.sampler_order : undefined,
        'xtc_threshold': settings.xtc_threshold,
        'xtc_probability': settings.xtc_probability,
        'nsigma': settings.nsigma,
        'top_n_sigma': settings.nsigma,
        'min_keep': settings.min_keep,
        'adaptive_target': settings.adaptive_target,
        'adaptive_decay': settings.adaptive_decay,
        parseSequenceBreakers: function () {
            try {
                return JSON.parse(this.dry_sequence_breakers);
            } catch {
                if (typeof this.dry_sequence_breakers === 'string') {
                    return this.dry_sequence_breakers.split(',');
                }
                return undefined;
            }
        },
    };
    const nonAphroditeParams = {
        'rep_pen': settings.rep_pen,
        'rep_pen_range': settings.rep_pen_range,
        'repetition_decay': settings.type === TABBY ? settings.rep_pen_decay : undefined,
        'repetition_penalty_range': settings.rep_pen_range,
        'encoder_repetition_penalty': settings.type === OOBA ? settings.encoder_rep_pen : undefined,
        'no_repeat_ngram_size': settings.type === OOBA ? settings.no_repeat_ngram_size : undefined,
        'penalty_alpha': settings.type === OOBA ? settings.penalty_alpha : undefined,
        'temperature_last': (settings.type === OOBA || settings.type === APHRODITE || settings.type === TABBY) ? settings.temperature_last : undefined,
        'speculative_ngram': settings.type === TABBY ? settings.speculative_ngram : undefined,
        'do_sample': settings.type === OOBA ? settings.do_sample : undefined,
        'seed': settings.seed >= 0 ? settings.seed : undefined,
        'guidance_scale': cfgValues?.guidanceScale?.value ?? settings.guidance_scale ?? 1,
        'negative_prompt': cfgValues?.negativePrompt ?? substituteParams(settings.negative_prompt, macroContext) ?? '',
        'grammar_string': settings.grammar_string || undefined,
        'json_schema': [TABBY, LLAMACPP].includes(settings.type) ? jsonSchema : undefined,
        'repeat_penalty': settings.rep_pen,
        'repeat_last_n': settings.rep_pen_range,
        'n_predict': maxTokens,
        'num_predict': maxTokens,
        'num_ctx': maxContext,
        'mirostat': settings.mirostat_mode,
        'ignore_eos': settings.ban_eos_token,
        'n_probs': requestTokenProbabilities ? 10 : undefined,
        'rep_pen_slope': settings.rep_pen_slope,
    };
    const vllmParams = {
        'n': canMultiSwipe ? settings.n : 1,
        'ignore_eos': settings.ignore_eos_token,
        'spaces_between_special_tokens': settings.spaces_between_special_tokens,
        'seed': settings.seed >= 0 ? settings.seed : undefined,
    };
    const aphroditeParams = {
        'n': canMultiSwipe ? settings.n : 1,
        'frequency_penalty': settings.freq_pen,
        'presence_penalty': settings.presence_pen,
        'repetition_penalty': settings.rep_pen,
        'seed': settings.seed >= 0 ? settings.seed : undefined,
        'stop': stoppingStrings,
        'temperature': dynatemp ? (settings.min_temp + settings.max_temp) / 2 : settings.temp,
        'temperature_last': settings.temperature_last,
        'top_p': settings.top_p,
        'top_k': settings.top_k,
        'top_a': settings.top_a,
        'min_p': settings.min_p,
        'tfs': settings.tfs,
        'eta_cutoff': settings.eta_cutoff,
        'epsilon_cutoff': settings.epsilon_cutoff,
        'typical_p': settings.typical_p,
        'smoothing_factor': settings.smoothing_factor,
        'smoothing_curve': settings.smoothing_curve,
        'ignore_eos': settings.ignore_eos_token,
        'min_tokens': settings.min_length,
        'skip_special_tokens': settings.skip_special_tokens,
        'spaces_between_special_tokens': settings.spaces_between_special_tokens,
        'guided_grammar': settings.grammar_string || undefined,
        'guided_json': jsonSchema || undefined,
        'early_stopping': false,
        'include_stop_str_in_output': false,
        'dynatemp_min': dynatemp ? settings.min_temp : undefined,
        'dynatemp_max': dynatemp ? settings.max_temp : undefined,
        'dynatemp_exponent': dynatemp ? settings.dynatemp_exponent : undefined,
        'xtc_threshold': settings.xtc_threshold,
        'xtc_probability': settings.xtc_probability,
        'nsigma': settings.nsigma,
        'custom_token_bans': toIntArray(bannedTokens),
        'no_repeat_ngram_size': settings.no_repeat_ngram_size,
        'sampler_priority': settings.type === APHRODITE && !arraysEqual(settings.samplers_priorities, APHRODITE_DEFAULT_ORDER)
            ? settings.samplers_priorities
            : undefined,
    };

    if (settings.type === OPENROUTER) {
        params.provider = settings.openrouter_providers;
        params.quantizations = settings.openrouter_quantizations;
        params.allow_fallbacks = settings.openrouter_allow_fallbacks;
    }

    if (settings.type === KOBOLDCPP) {
        params.grammar = settings.grammar_string || undefined;
        params.grammar_retain_state = (settings.grammar_string && !!isContinue) ? true : undefined;
        params.trim_stop = true;
        params.dry_sequence_breakers = params.parseSequenceBreakers();
    }

    if (settings.type === HUGGINGFACE) {
        params.top_p = Math.min(Math.max(Number(params.top_p), 0.0), 0.999);
        params.stop = Array.isArray(params.stop) ? params.stop.slice(0, 4) : [];
        nonAphroditeParams.seed = settings.seed >= 0 ? settings.seed : undefined;
    }

    if (settings.type === MANCER) {
        params.n = canMultiSwipe ? settings.n : 1;
        params.epsilon_cutoff /= 1000;
        params.eta_cutoff /= 1000;
        params.dynatemp_mode = params.dynamic_temperature ? 1 : 0;
        params.dynatemp_min = params.dynatemp_low;
        params.dynatemp_max = params.dynatemp_high;
        delete params.dynatemp_low;
        delete params.dynatemp_high;
        params.dry_sequence_breakers = params.parseSequenceBreakers();
    }

    if (settings.type === TABBY || settings.type === LLAMACPP) {
        params.n = canMultiSwipe ? settings.n : 1;
    }

    switch (settings.type) {
        case VLLM:
        case INFERMATICAI:
            params = Object.assign(params, vllmParams);
            break;
        case APHRODITE:
            params = Object.assign(params, aphroditeParams);
            break;
        default:
            params = Object.assign(params, nonAphroditeParams);
            break;
    }

    if (logitBias !== undefined && Array.isArray(settings.logit_bias) && settings.logit_bias.length) {
        params.logit_bias = logitBias;
    }

    if (settings.type === LLAMACPP || settings.type === OLLAMA) {
        const logitBiasArray = (params.logit_bias && typeof params.logit_bias === 'object' && Object.keys(params.logit_bias).length > 0)
            ? Object.entries(params.logit_bias).map(([key, value]) => [Number(key), value])
            : [];
        const tokenBans = toIntArray(bannedTokens);
        logitBiasArray.push(...tokenBans.map(x => [Number(x), false]));
        const sequenceBreakers = params.parseSequenceBreakers();
        const llamaCppParams = {
            'logit_bias': logitBiasArray,
            'grammar': settings.grammar_string,
            'cache_prompt': true,
            'dry_sequence_breakers': sequenceBreakers,
        };
        params = Object.assign(params, llamaCppParams);
        if (!Array.isArray(sequenceBreakers) || sequenceBreakers.length === 0) {
            delete params.dry_sequence_breakers;
        }
    }

    if ([LLAMACPP, APHRODITE].includes(settings.type)) {
        if (jsonSchema) {
            delete params.grammar_string;
            delete params.grammar;
            delete params.guided_grammar;
        } else {
            delete params.json_schema;
            delete params.guided_json;
        }
    }

    // Client leaves this function on the returned object (harmless there - JSON.stringify() drops
    // functions silently before the wire anyway); deleted here so the return value is a plain,
    // structuredClone-safe object. No behavior change either way.
    delete params.parseSequenceBreakers;
    return params;
}
