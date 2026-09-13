import { getStoppingStrings } from './stopping-strings.js';
import { tokenizers } from './tokenizer-resolve.js';

/**
 * Server-side port of public/scripts/nai-settings.js's getNovelGenerationData() - builds the
 * request-body payload for NovelAI text generation, matching the shape already done for textgen
 * (src/textgen-generation-data.js) and chat-completion (src/chat-completion-generation-data.js).
 *
 * Also ports these nai-settings.js helpers, which getNovelGenerationData() calls directly:
 * - selectPrefix() - picks the instruct prefix ('special_instruct' / user-selected / 'vanilla').
 * - getTokenizerTypeForModel() - maps a NovelAI model-name substring to a `tokenizers` enum value.
 *   Reuses the REAL `tokenizers` enum from src/tokenizer-resolve.js rather than re-declaring it.
 * - getBadWordIds()/getBadWordPermutations() - turns settings.banned_tokens lines into bad-word
 *   token id lists.
 * - calculateNovelLogitBias() - a faithful port of nai-settings.js's private, module-scoped
 *   `calculateLogitBias()` (via public/scripts/logit-bias.js's getLogitBiasListResult()). This is
 *   NOT the same function as src/token-bans-and-bias.js's exported `calculateLogitBias` - that one
 *   is the *textgen* generation port, for `textgenerationwebui_settings`, and returns a
 *   token-id-keyed bias OBJECT (`{ [tokenId]: value }`), matching what OOBA/etc. backends expect.
 *   NovelAI's own logit-bias wire format is an ARRAY of per-sequence objects instead
 *   (`{ bias, ensure_sequence_finish, generate_once, sequence }`, one per resolved token-id
 *   sequence) - a meaningfully different shape, not just a naming coincidence - so reusing
 *   src/token-bans-and-bias.js's version here would silently produce the wrong wire format. This
 *   module therefore ports NovelAI's own version as a separate function rather than reusing that
 *   one. (Judgment call, flagged per the task.)
 * - getNovelMaxResponseTokens() - maps a NovelAI account tier (1/2/3) to a max response length.
 *
 * Deliberately taken as explicit context parameters instead of resolved here:
 * - encodeTokens - turns (tokenizerType, text) into token ids. The client's getTextTokens()
 *   (public/scripts/tokenizers.js) ultimately calls encodeTextByLocalTokenizerType()
 *   (src/endpoints/tokenizers.js), which is `async`, so encodeTokens here is likewise treated as
 *   returning a Promise (and this whole module's functions that need encoding are `async`,
 *   `await`-ing every call) - even though the fake encoder in the test file is deliberately
 *   synchronous, to show the signature tolerates either (an `async` function returning a
 *   already-resolved value works fine when awaited). This module does NOT do any tokenizer-type
 *   resolution/dispatch beyond getTokenizerTypeForModel() (which only picks WHICH tokenizers enum
 *   value applies to a given NovelAI model name) - actually turning that enum value into ids is
 *   entirely the caller's job, via the injected encodeTokens.
 * - stoppingStringsParams - forwarded to src/stopping-strings.js's getStoppingStrings(), minus
 *   isImpersonate/isContinue/api (which this module supplies itself: api is fixed to a non-'openai'
 *   value, since NovelAI is never a chat-completion source).
 * - macroContext - merged into the getStoppingStrings() call args (that function's own
 *   `customStoppingStringsMacro` path uses it); not used anywhere else in this module, since
 *   getNovelGenerationData() itself never calls substituteParams().
 *
 * Documented simplifications (intentional, not gaps):
 * - `badWordsCache` (nai-settings.js) and `BIAS_CACHE`/`BIAS_KEY` (logit-bias.js, read via
 *   nai-settings.js's calculateLogitBias() call site) are BOTH purely client-side performance
 *   caches - keyed by a content hash of the banned-word/logit-bias settings, so a browser session
 *   doesn't re-tokenize the same banned words/bias entries on every chat turn. They have zero
 *   effect on the actual *value* returned - only on how often it's recomputed. Neither is ported
 *   here: getBadWordIds() and calculateNovelLogitBias() below always compute fresh. A server-side
 *   equivalent cache (if ever wanted) would need its own invalidation story tied to request
 *   lifecycle, which is out of scope for this port.
 */

/** Mirrors nai-settings.js's `maximum_output_length` constant. */
const MAXIMUM_OUTPUT_LENGTH = 150;

/** Mirrors nai-settings.js's `default_order` constant. */
const DEFAULT_ORDER = [1, 5, 0, 2, 3, 4];

/** Trivial reimplementation of public/scripts/utils.js's onlyUnique array filter. */
function onlyUnique(value, index, array) {
    return array.indexOf(value) === index;
}

/**
 * Mirrors nai-settings.js's getTokenizerTypeForModel(model).
 * @param {string} model nai_settings.model_novel equivalent.
 * @returns {number} A `tokenizers` value (see src/tokenizer-resolve.js).
 */
export function getTokenizerTypeForModel(model) {
    if (model.includes('clio')) {
        return tokenizers.NERD;
    }
    if (model.includes('kayra')) {
        return tokenizers.NERD2;
    }
    if (model.includes('erato')) {
        return tokenizers.LLAMA3;
    }
    return tokenizers.NONE;
}

/**
 * Mirrors nai-settings.js's selectPrefix(selected_prefix, finalPrompt), taking the NovelAI model
 * name as an explicit parameter instead of reading the module-level nai_settings.model_novel.
 * @param {string} selectedPrefix nai_settings.prefix equivalent.
 * @param {string} finalPrompt
 * @param {string} model nai_settings.model_novel equivalent.
 * @returns {string} 'special_instruct', `selectedPrefix`, or 'vanilla'.
 */
export function selectPrefix(selectedPrefix, finalPrompt, model) {
    const clio = model.includes('clio');
    const kayra = model.includes('kayra');
    const erato = model.includes('erato');
    const isNewModel = clio || kayra || erato;

    if (isNewModel) {
        // NovelAI claims they scan backwards 1000 characters (not tokens!) to look for instruct brackets. That's really short.
        const tail = finalPrompt.slice(-1500);
        const useInstruct = tail.includes('}');
        return useInstruct ? 'special_instruct' : selectedPrefix;
    }

    return 'vanilla';
}

/**
 * Mirrors nai-settings.js's getBadWordPermutations(text) exactly.
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
 * @param {number} tokenizerType A `tokenizers` value.
 * @param {string} text
 * @returns {Promise<number[]>|number[]}
 */

/**
 * Mirrors nai-settings.js's getBadWordIds(banned_tokens, tokenizerType), minus the `badWordsCache`
 * perf cache (see module doc comment - always computes fresh here).
 * @param {string} bannedTokens nai_settings.banned_tokens equivalent (newline-separated lines).
 * @param {number} tokenizerType A `tokenizers` value.
 * @param {EncodeTokensFn} encodeTokens
 * @returns {Promise<number[][]>}
 */
export async function getBadWordIds(bannedTokens, tokenizerType, encodeTokens) {
    if (tokenizerType === tokenizers.NONE) {
        return [];
    }

    const result = [];
    const sequence = bannedTokens.split('\n');

    for (const token of sequence) {
        const trimmed = token.trim();

        if (trimmed.length === 0) {
            continue;
        }

        if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
            const tokenIds = await encodeTokens(tokenizerType, trimmed.slice(1, -1));
            result.push(tokenIds);
        } else if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
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
            for (const permutation of permutations) {
                result.push(await encodeTokens(tokenizerType, permutation));
            }
        }
    }

    return result;
}

/**
 * @typedef {object} NovelLogitBiasEntry
 * @property {string} text One of: `{verbatim text}` (braces stripped, tokenized as-is), `[1,2,3]`
 * (raw token ids), or plain text (tokenized with a leading space prepended).
 * @property {number} value Bias value to apply to every token id sequence the entry resolves to.
 *
 * @typedef {object} NovelLogitBiasObject
 * @property {number} bias
 * @property {boolean} ensure_sequence_finish
 * @property {boolean} generate_once
 * @property {number[]} sequence
 */

/**
 * Mirrors nai-settings.js's private calculateLogitBias(), which itself delegates to
 * public/scripts/logit-bias.js's getLogitBiasListResult() with a NovelAI-specific
 * `getBiasObject(bias, sequence)` transformer. See the module doc comment for why this is a
 * separate port from src/token-bans-and-bias.js's `calculateLogitBias` rather than a reuse of it -
 * that one returns a token-id-keyed object, this one returns an array of per-sequence objects.
 * Minus the `BIAS_CACHE`/`BIAS_KEY` perf cache (always computes fresh here).
 * @param {NovelLogitBiasEntry[]} logitBiasEntries nai_settings.logit_bias equivalent.
 * @param {number} tokenizerType A `tokenizers` value.
 * @param {EncodeTokensFn} encodeTokens
 * @returns {Promise<NovelLogitBiasObject[]>}
 */
export async function calculateNovelLogitBias(logitBiasEntries, tokenizerType, encodeTokens) {
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

        // Skip empty lines
        if (text.length === 0) continue;

        if (text.startsWith('{') && text.endsWith('}')) {
            // Verbatim text
            const tokenIds = await encodeTokens(tokenizerType, text.slice(1, -1));
            result.push(getBiasObject(entry.value, tokenIds));
        } else if (text.startsWith('[') && text.endsWith(']')) {
            // Raw token ids, JSON serialized
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
            // Text with a leading space
            const biasText = ` ${text}`;
            const tokenIds = await encodeTokens(tokenizerType, biasText);
            result.push(getBiasObject(entry.value, tokenIds));
        }
    }

    return result;
}

/**
 * Mirrors nai-settings.js's getNovelMaxResponseTokens(), taking novel_data?.tier as a plain param
 * instead of reading the module-level novel_data.
 * @param {number} [novelDataTier] novel_data?.tier equivalent (1/2/3, from NovelAI's own API).
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
 * @typedef {object} NovelSettings Equivalent of nai_settings.
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
 *
 * @typedef {object} CreateNovelGenerationDataParams
 * @property {string} finalPrompt
 * @property {NovelSettings} settings Equivalent of nai_settings.
 * @property {number} maxLength Equivalent of the original function's `maxLength` param.
 * @property {boolean} [isImpersonate]
 * @property {boolean} [isContinue]
 * @property {string} [type] 'quiet'/'impersonate'/'continue'/'normal' equivalent - only used for a debug log line.
 * @property {number} [novelDataTier] novel_data?.tier equivalent, forwarded to getNovelMaxResponseTokens().
 * @property {number[]} [presetOrder] The original function's second positional `settings` param's
 * `.order` field - a distinct object from `settings` above (some preset-merge object), used only as
 * a fallback when `settings.order` (nai_settings.order) is unset. Kept separate to match the
 * original's two-different-`settings`-objects behavior (`nai_settings.order || settings.order || default_order`)
 * without conflating them into one param.
 * @property {boolean} [consoleLogPrompts] power_user.console_log_prompts equivalent.
 * @property {boolean} [requestTokenProbabilities] power_user.request_token_probabilities equivalent.
 * @property {import('./stopping-strings.js').GetStoppingStringsParams} [stoppingStringsParams]
 * Forwarded to getStoppingStrings(), minus isImpersonate/isContinue/api (supplied by this function).
 * @property {EncodeTokensFn} encodeTokens
 * @property {import('./macro-substitution.js').SubstituteParamsContext} [macroContext] Forwarded
 * into the getStoppingStrings() call (merged into stoppingStringsParams).
 */

/**
 * Server-side port of public/scripts/nai-settings.js's getNovelGenerationData(finalPrompt,
 * settings, maxLength, isImpersonate, isContinue, _cfgValues, type). Note `_cfgValues` is unused
 * in the original (its leading underscore is the original's own naming, not a typo) and is
 * therefore not a parameter here either.
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
    encodeTokens,
    macroContext = {},
}) {
    console.debug('NovelAI generation data for', type);
    const isKayra = settings.model_novel.includes('kayra');
    const isErato = settings.model_novel.includes('erato');

    const tokenizerType = getTokenizerTypeForModel(settings.model_novel);
    const stoppingStrings = getStoppingStrings({
        ...stoppingStringsParams,
        isImpersonate,
        isContinue,
        api: 'novel',
        macroContext,
    });

    // Llama 3 tokenizer, huh?
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
    let stopSequences;
    if (tokenizerType !== tokenizers.NONE) {
        stopSequences = [];
        for (const stoppingString of stoppingStrings.slice(0, MAX_STOP_SEQUENCES)) {
            stopSequences.push(await encodeTokens(tokenizerType, stoppingString));
        }
    }

    const badWordIds = (tokenizerType !== tokenizers.NONE)
        ? await getBadWordIds(settings.banned_tokens, tokenizerType, encodeTokens)
        : undefined;

    const prefix = selectPrefix(settings.prefix, finalPrompt, settings.model_novel);

    // Deviation from the client (flagged): the client initializes `logitBias` to `[]` and only
    // overwrites it when `tokenizerType !== tokenizers.NONE && ...`, so it stays `[]` (not
    // `undefined`) when the tokenizer type is NONE. Here, `logit_bias_exp` is `undefined` for
    // tokenizers.NONE instead, matching the `stop_sequences`/`bad_words_ids` convention above -
    // this reads as more consistent (all three "requires an actual tokenizer" fields behave the
    // same way) and NovelAI's own request handling almost certainly treats an omitted
    // `logit_bias_exp` and an empty-array one identically. Documented, not a silent guess.
    let logitBias;
    if (tokenizerType !== tokenizers.NONE) {
        logitBias = (Array.isArray(settings.logit_bias) && settings.logit_bias.length)
            ? await calculateNovelLogitBias(settings.logit_bias, tokenizerType, encodeTokens)
            : [];
    }

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
        'bad_words_ids': badWordIds,
        'logit_bias_exp': logitBias,
        'generate_until_sentence': true,
        'use_cache': false,
        'return_full_text': false,
        'prefix': prefix,
        'order': settings.order || presetOrder || DEFAULT_ORDER,
        'num_logprobs': requestTokenProbabilities ? 10 : undefined,
    };
}
