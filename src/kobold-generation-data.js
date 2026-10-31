import { getStoppingStrings } from './stopping-strings.js';
import { substituteParams } from './macro-substitution.js';

/**
 * @typedef {object} KoboldGenerationSettings
 * @property {number} [rep_pen]
 * @property {number} [rep_pen_range]
 * @property {number} [rep_pen_slope]
 * @property {number} [temp]
 * @property {number} [tfs]
 * @property {number} [top_a]
 * @property {number} [top_k]
 * @property {number} [top_p]
 * @property {number} [min_p]
 * @property {number} [typical]
 * @property {number} [mirostat]
 * @property {number} [mirostat_tau]
 * @property {number} [mirostat_eta]
 * @property {boolean} [use_default_badwordsids]
 * @property {string} [grammar]
 * @property {number} [seed]
 * @property {boolean} [streaming_kobold]
 * @property {number[]} [sampler_order]
 * @property {string} [api_server]
 */

/**
 * @typedef {object} KoboldGenerationFlags
 * @property {boolean} [can_use_min_p]
 * @property {boolean} [can_use_stop_sequence]
 * @property {boolean} [can_use_streaming]
 * @property {boolean} [can_use_mirostat]
 * @property {boolean} [can_use_default_badwordsids]
 * @property {boolean} [can_use_grammar]
 */

/**
 * @typedef {object} KoboldGenerationDataContext
 * @property {object} settings
 * @property {KoboldGenerationSettings} [koboldSettings]
 * @property {KoboldGenerationFlags} [koboldFlags]
 * @property {string} [apiServer]
 * @property {import('./stopping-strings.js').GetStoppingStringsParams} [stoppingStringsParams]
 * @property {import('./macro-substitution.js').SubstituteParamsContext} [macroContext]
 */

/**
 * @param {object} params
 * @param {string} params.finalPrompt
 * @param {number} params.maxLength
 * @param {number} params.maxContextLength
 * @param {boolean} params.isHorde
 * @param {string} [params.type]
 * @param {KoboldGenerationDataContext} params
 * @returns {object}
 */
export function createKoboldGenerationData({
    finalPrompt,
    settings,
    maxLength,
    maxContextLength,
    isHorde,
    type,
    koboldSettings = {},
    koboldFlags = {},
    apiServer,
    stoppingStringsParams = {},
    macroContext = {},
}) {
    const isImpersonate = type === 'impersonate';
    const isContinue = type === 'continue';
    const sampler_order = koboldSettings.sampler_order || settings.sampler_order;

    const generate_data = {
        prompt: finalPrompt,
        gui_settings: false,
        sampler_order: sampler_order,
        max_context_length: Number(maxContextLength),
        max_length: maxLength,
        rep_pen: Number(koboldSettings.rep_pen),
        rep_pen_range: Number(koboldSettings.rep_pen_range),
        rep_pen_slope: koboldSettings.rep_pen_slope,
        temperature: Number(koboldSettings.temp),
        tfs: koboldSettings.tfs,
        top_a: koboldSettings.top_a,
        top_k: koboldSettings.top_k,
        top_p: koboldSettings.top_p,
        min_p: (koboldFlags.can_use_min_p || isHorde) ? koboldSettings.min_p : undefined,
        typical: koboldSettings.typical,
        use_world_info: false,
        singleline: false,
        stop_sequence: (koboldFlags.can_use_stop_sequence || isHorde)
            ? getStoppingStrings({ ...stoppingStringsParams, isImpersonate, isContinue, api: 'kobold' })
            : undefined,
        streaming: koboldSettings.streaming_kobold && koboldFlags.can_use_streaming && type !== 'quiet',
        can_abort: koboldFlags.can_use_streaming,
        mirostat: (koboldFlags.can_use_mirostat || isHorde) ? koboldSettings.mirostat : undefined,
        mirostat_tau: (koboldFlags.can_use_mirostat || isHorde) ? koboldSettings.mirostat_tau : undefined,
        mirostat_eta: (koboldFlags.can_use_mirostat || isHorde) ? koboldSettings.mirostat_eta : undefined,
        use_default_badwordsids: (koboldFlags.can_use_default_badwordsids || isHorde) ? koboldSettings.use_default_badwordsids : undefined,
        grammar: (koboldFlags.can_use_grammar || isHorde) ? substituteParams(koboldSettings.grammar, macroContext) : undefined,
        grammar_retain_state: (koboldFlags.can_use_grammar && !!isContinue) ? true : undefined,
        sampler_seed: koboldSettings.seed >= 0 ? koboldSettings.seed : undefined,
        api_server: apiServer,
    };
    return generate_data;
}
