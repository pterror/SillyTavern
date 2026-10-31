import { getStoppingStrings } from './stopping-strings.js';
import { tokenizers } from './tokenizer-resolve.js';

const MAXIMUM_OUTPUT_LENGTH = 150;

const DEFAULT_ORDER = [1, 5, 0, 2, 3, 4];

function onlyUnique(value, index, array) {
    return array.indexOf(value) === index;
}

/**
 * @param {string} selectedPrefix
 * @param {string} finalPrompt
 * @param {string} model
 * @returns {string}
 */
export function selectPrefix(selectedPrefix, finalPrompt, model) {
    const clio = model.includes('clio');
    const kayra = model.includes('kayra');
    const erato = model.includes('erato');
    const isNewModel = clio || kayra || erato;

    if (isNewModel) {
        const tail = finalPrompt.slice(-1500);
        const useInstruct = tail.includes('}');
        return useInstruct ? 'special_instruct' : selectedPrefix;
    }

    return 'vanilla';
}

/**
 * @param {string} text
 * @returns {string[]}
 */
export function getBadWordPermutations(text) {
    const result = [];

    result.push(text);
    result.push(` ${text}`);
    result.push(text[0].toUpperCase() + text.slice(1));
    result.push(` ${text[0].toUpperCase() + text.slice(1)}`);
    result.push(text[0].toLowerCase() + text.slice(1));
    result.push(` ${text[0].toLowerCase() + text.slice(1)}`);
    result.push(text.toUpperCase());
    result.push(` ${text.toUpperCase()}`);
    result.push(text.toLowerCase());
    result.push(` ${text.toLowerCase()}`);

    return result.filter(onlyUnique);
}

/**
 * @callback EncodeTokensFn
 * @param {number} tokenizerType
 * @param {string} text
 * @returns {Promise<number[]|null>|number[]|null}
 */

/**
 * @param {string} bannedTokens
 * @param {number} tokenizerType
 * @param {EncodeTokensFn} encodeTokens
 * @param {string[]} [dropped]
 * @returns {Promise<number[][]>}
 */
export async function getBadWordIds(bannedTokens, tokenizerType, encodeTokens, dropped) {
    const result = [];
    const sequence = bannedTokens.split('\n');

    for (const token of sequence) {
        const trimmed = token.trim();

        if (trimmed.length === 0) {
            continue;
        }

        const isRawIds = trimmed.startsWith('[') && trimmed.endsWith(']');
        if (tokenizerType === tokenizers.NONE && !isRawIds) {
            dropped?.push(trimmed);
            continue;
        }

        if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
            const tokenIds = await encodeTokens(tokenizerType, trimmed.slice(1, -1));
            if (tokenIds === null) {
                dropped?.push(trimmed);
                continue;
            }
            result.push(tokenIds);
        } else if (isRawIds) {
            try {
                const tokenIds = JSON.parse(trimmed);

                if (Array.isArray(tokenIds) && tokenIds.every(t => Number.isInteger(t))) {
                    result.push(tokenIds);
                } else {
                    throw new Error('Not an array of integers');
                }
            } catch (err) {
                console.log(`Failed to parse bad word token list: ${trimmed}`, err);
            }
        } else {
            const permutations = getBadWordPermutations(trimmed);
            const permutationIds = [];
            for (const permutation of permutations) {
                permutationIds.push(await encodeTokens(tokenizerType, permutation));
            }
            if (permutationIds.includes(null)) {
                dropped?.push(trimmed);
                continue;
            }
            result.push(...permutationIds);
        }
    }

    return result;
}

/**
 * @typedef {object} NovelLogitBiasEntry
 * @property {string} text
 * @property {number} value
 * @typedef {object} NovelLogitBiasObject
 * @property {number} bias
 * @property {boolean} ensure_sequence_finish
 * @property {boolean} generate_once
 * @property {number[]} sequence
 */

/**
 * @param {NovelLogitBiasEntry[]} logitBiasEntries
 * @param {number} tokenizerType
 * @param {EncodeTokensFn} encodeTokens
 * @param {string[]} [dropped]
 * @returns {Promise<NovelLogitBiasObject[]>}
 */
export async function calculateNovelLogitBias(logitBiasEntries, tokenizerType, encodeTokens, dropped) {
    if (!Array.isArray(logitBiasEntries) || logitBiasEntries.length === 0) {
        return [];
    }

    function getBiasObject(bias, sequence) {
        return {
            bias: bias,
            ensure_sequence_finish: false,
            generate_once: false,
            sequence: sequence,
        };
    }

    const result = [];

    for (const entry of logitBiasEntries) {
        if (!(entry.text?.length > 0)) continue;
        const text = entry.text.trim();

        if (text.length === 0) continue;

        const isRawIds = text.startsWith('[') && text.endsWith(']');
        if (tokenizerType === tokenizers.NONE && !isRawIds) {
            dropped?.push(text);
            continue;
        }

        if (text.startsWith('{') && text.endsWith('}')) {
            const tokenIds = await encodeTokens(tokenizerType, text.slice(1, -1));
            if (tokenIds === null) {
                dropped?.push(text);
                continue;
            }
            result.push(getBiasObject(entry.value, tokenIds));
        } else if (isRawIds) {
            try {
                const tokenIds = JSON.parse(text);

                if (Array.isArray(tokenIds) && tokenIds.every(t => Number.isInteger(t))) {
                    result.push(getBiasObject(entry.value, tokenIds));
                } else {
                    throw new Error('Not an array of integers');
                }
            } catch (err) {
                console.log(`Failed to parse logit bias token list: ${text}`, err);
            }
        } else {
            const biasText = ` ${text}`;
            const tokenIds = await encodeTokens(tokenizerType, biasText);
            if (tokenIds === null) {
                dropped?.push(text);
                continue;
            }
            result.push(getBiasObject(entry.value, tokenIds));
        }
    }

    return result;
}

/**
 * @param {number} [novelDataTier]
 * @returns {number}
 */
export function getNovelMaxResponseTokens(novelDataTier) {
    switch (novelDataTier) {
        case 1:
            return 150;
        case 2:
            return 150;
        case 3:
            return 250;
    }

    return MAXIMUM_OUTPUT_LENGTH;
}

/**
 * @typedef {object} NovelSettings
 * @property {string} model_novel
 * @property {number} temperature
 * @property {number} min_length
 * @property {number} tail_free_sampling
 * @property {number} repetition_penalty
 * @property {number} repetition_penalty_range
 * @property {number} repetition_penalty_slope
 * @property {number} repetition_penalty_frequency
 * @property {number} repetition_penalty_presence
 * @property {number} top_a
 * @property {number} top_p
 * @property {number} top_k
 * @property {number} min_p
 * @property {number} math1_temp
 * @property {number} math1_quad
 * @property {number} math1_quad_entropy_scale
 * @property {number} typical_p
 * @property {number} mirostat_lr
 * @property {number} mirostat_tau
 * @property {*} phrase_rep_pen
 * @property {string} banned_tokens
 * @property {NovelLogitBiasEntry[]} logit_bias
 * @property {string} prefix
 * @property {number[]} [order]
 * @typedef {object} CreateNovelGenerationDataParams
 * @property {string} finalPrompt
 * @property {NovelSettings} settings
 * @property {number} maxLength
 * @property {boolean} [isImpersonate]
 * @property {boolean} [isContinue]
 * @property {string} [type]
 * @property {number} [novelDataTier]
 * @property {number[]} [presetOrder]
 * @property {boolean} [consoleLogPrompts]
 * @property {boolean} [requestTokenProbabilities]
 * @property {import('./stopping-strings.js').GetStoppingStringsParams} [stoppingStringsParams]
 * @property {number} tokenizerType
 * @property {EncodeTokensFn} encodeTokens
 * @property {string[]} [dropped]
 * @property {import('./macro-substitution.js').SubstituteParamsContext} [macroContext]
 */

/**
 * @param {CreateNovelGenerationDataParams} params
 * @returns {Promise<object>}
 */
export async function createNovelGenerationData({
    finalPrompt,
    settings,
    maxLength,
    isImpersonate = false,
    isContinue = false,
    type,
    novelDataTier,
    presetOrder,
    consoleLogPrompts = false,
    requestTokenProbabilities = false,
    stoppingStringsParams = {},
    tokenizerType,
    encodeTokens,
    dropped,
    macroContext = {},
}) {
    console.debug('NovelAI generation data for', type);
    if (typeof tokenizerType !== 'number') {
        throw new Error('createNovelGenerationData: tokenizerType is required');
    }
    const isKayra = settings.model_novel.includes('kayra');
    const isErato = settings.model_novel.includes('erato');

    const stoppingStrings = getStoppingStrings({
        ...stoppingStringsParams,
        isImpersonate,
        isContinue,
        api: 'novel',
        macroContext,
    });

    if (isErato) {
        const additionalStopStrings = [];
        for (const stoppingString of stoppingStrings) {
            if (stoppingString.startsWith('\n')) {
                additionalStopStrings.push('.' + stoppingString);
                additionalStopStrings.push('!' + stoppingString);
                additionalStopStrings.push('?' + stoppingString);
                additionalStopStrings.push('*' + stoppingString);
                additionalStopStrings.push('"' + stoppingString);
                additionalStopStrings.push('_' + stoppingString);
                additionalStopStrings.push('...' + stoppingString);
                additionalStopStrings.push('."' + stoppingString);
                additionalStopStrings.push('?"' + stoppingString);
                additionalStopStrings.push('!"' + stoppingString);
                additionalStopStrings.push('.*' + stoppingString);
                additionalStopStrings.push(')' + stoppingString);
            }
        }
        stoppingStrings.push(...additionalStopStrings);
    }

    const MAX_STOP_SEQUENCES = 1024;
    const sentStoppingStrings = stoppingStrings.slice(0, MAX_STOP_SEQUENCES);
    const hasTokenizer = tokenizerType !== tokenizers.NONE;
    let stopSequences;
    if (hasTokenizer) {
        stopSequences = [];
        for (const stoppingString of sentStoppingStrings) {
            const tokenIds = await encodeTokens(tokenizerType, stoppingString);
            if (tokenIds === null) {
                dropped?.push(stoppingString);
                continue;
            }
            stopSequences.push(tokenIds);
        }
    } else {
        dropped?.push(...sentStoppingStrings);
    }

    const badWordIds = await getBadWordIds(settings.banned_tokens, tokenizerType, encodeTokens, dropped);

    const prefix = selectPrefix(settings.prefix, finalPrompt, settings.model_novel);

    const logitBias = (Array.isArray(settings.logit_bias) && settings.logit_bias.length)
        ? await calculateNovelLogitBias(settings.logit_bias, tokenizerType, encodeTokens, dropped)
        : [];

    if (consoleLogPrompts) {
        console.log(finalPrompt);
    }

    if (isErato) {
        finalPrompt = '<|startoftext|><|reserved_special_token81|>' + finalPrompt;
    }

    const adjustedMaxLength = (isKayra || isErato) ? getNovelMaxResponseTokens(novelDataTier) : MAXIMUM_OUTPUT_LENGTH;

    return {
        'input': finalPrompt,
        'model': settings.model_novel,
        'use_string': true,
        'temperature': Number(settings.temperature),
        'max_length': maxLength < adjustedMaxLength ? maxLength : adjustedMaxLength,
        'min_length': Number(settings.min_length),
        'tail_free_sampling': Number(settings.tail_free_sampling),
        'repetition_penalty': Number(settings.repetition_penalty),
        'repetition_penalty_range': Number(settings.repetition_penalty_range),
        'repetition_penalty_slope': Number(settings.repetition_penalty_slope),
        'repetition_penalty_frequency': Number(settings.repetition_penalty_frequency),
        'repetition_penalty_presence': Number(settings.repetition_penalty_presence),
        'top_a': Number(settings.top_a),
        'top_p': Number(settings.top_p),
        'top_k': Number(settings.top_k),
        'min_p': Number(settings.min_p),
        'math1_temp': Number(settings.math1_temp),
        'math1_quad': Number(settings.math1_quad),
        'math1_quad_entropy_scale': Number(settings.math1_quad_entropy_scale),
        'typical_p': Number(settings.typical_p),
        'mirostat_lr': Number(settings.mirostat_lr),
        'mirostat_tau': Number(settings.mirostat_tau),
        'phrase_rep_pen': settings.phrase_rep_pen,
        'stop_sequences': stopSequences,
        'bad_words_ids': hasTokenizer || badWordIds.length ? badWordIds : undefined,
        'logit_bias_exp': hasTokenizer || logitBias.length ? logitBias : undefined,
        'generate_until_sentence': true,
        'use_cache': false,
        'return_full_text': false,
        'prefix': prefix,
        'order': settings.order || presetOrder || DEFAULT_ORDER,
        'num_logprobs': requestTokenProbabilities ? 10 : undefined,
    };
}
