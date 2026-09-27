import { saveSettingsDebounced } from '../script.js';
import { getEntryTokenIds, getTextTokens, prefetchEntryTokenIdsDebounced, showDroppedEntries, tokenizers } from './tokenizers.js';
import { getSortableDelay, uuidv4 } from './utils.js';

/** Nothing reads it; kept because upstream exports it. */
export const BIAS_CACHE = new Map();

/**
 * Displays the logit bias list in the specified container.
 * @param {object} logitBias Logit bias object
 * @param {string} containerSelector Container element selector
 * @param {string} [settingsKey] Top-level settings key this logit bias array actually lives under
 * (oai_settings/nai_settings/textgenerationwebui_settings) - saveSettingsDebounced() only flushes the
 * keys it's told are dirty, so passing the wrong one here silently drops the edit on the next save.
 * @returns
 */
export function displayLogitBias(logitBias, containerSelector, settingsKey = 'oai_settings') {
    if (!Array.isArray(logitBias)) {
        console.log('Logit bias set not found');
        return;
    }

    const list = $(containerSelector).find('.logit_bias_list');
    list.empty();

    for (const entry of logitBias) {
        if (entry) {
            createLogitBiasListItem(entry, logitBias, containerSelector, settingsKey);
        }
    }

    // Check if a sortable instance exists
    if (list.sortable('instance') !== undefined) {
        // Destroy the instance
        list.sortable('destroy');
    }

    // Make the list sortable
    list.sortable({
        delay: getSortableDelay(),
        handle: '.drag-handle',
        stop: function () {
            const order = [];
            list.children().each(function () {
                order.unshift($(this).data('id'));
            });
            logitBias.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
            console.log('Logit bias reordered:', logitBias);
            saveSettingsDebounced(settingsKey);
        },
    });

    prefetchEntryTokenIdsDebounced();
}

/**
 * Creates a new logit bias entry
 * @param {object[]} logitBias Array of logit bias objects
 * @param {string} containerSelector Container element ID
 * @param {string} [settingsKey] Top-level settings key this logit bias array lives under - see displayLogitBias().
 */
export function createNewLogitBiasEntry(logitBias, containerSelector, settingsKey = 'oai_settings') {
    const entry = { id: uuidv4(), text: '', value: 0 };
    logitBias.push(entry);
    prefetchEntryTokenIdsDebounced();
    createLogitBiasListItem(entry, logitBias, containerSelector, settingsKey);
    saveSettingsDebounced(settingsKey);
}

/**
 * Creates a logit bias list item.
 * @param {object} entry Logit bias entry
 * @param {object[]} logitBias Array of logit bias objects
 * @param {string} containerSelector Container element ID
 * @param {string} [settingsKey] Top-level settings key this logit bias array lives under - see displayLogitBias().
 */
function createLogitBiasListItem(entry, logitBias, containerSelector, settingsKey = 'oai_settings') {
    const id = entry.id;
    const template = $('#logit_bias_template .logit_bias_form').clone();
    template.data('id', id);
    template.find('.logit_bias_text').val(entry.text).on('input', function () {
        entry.text = $(this).val();
        prefetchEntryTokenIdsDebounced();
        saveSettingsDebounced(settingsKey);
    });
    template.find('.logit_bias_value').val(entry.value).on('input', function () {
        entry.value = Number($(this).val());
        prefetchEntryTokenIdsDebounced();
        saveSettingsDebounced(settingsKey);
    });
    template.find('.logit_bias_remove').on('click', function () {
        $(this).closest('.logit_bias_form').remove();
        const index = logitBias.indexOf(entry);
        if (index > -1) {
            logitBias.splice(index, 1);
        }
        prefetchEntryTokenIdsDebounced();
        saveSettingsDebounced(settingsKey);
    });
    $(containerSelector).find('.logit_bias_list').prepend(template);
}

/**
 * The text an entry encodes: `{verbatim}` without its braces, plain text with a leading space.
 * @param {string} text The entry's trimmed text.
 * @returns {string|null} null for raw token ids.
 */
function getEntryEncodeText(text) {
    if (text.startsWith('{') && text.endsWith('}')) {
        return text.slice(1, -1);
    }
    if (text.startsWith('[') && text.endsWith(']')) {
        return null;
    }
    return ` ${text}`;
}

/**
 * The texts a bias preset's entries encode.
 * @param {object[]} biasPreset Bias preset
 * @returns {string[]}
 */
export function getLogitBiasEntryTexts(biasPreset) {
    const texts = [];
    for (const entry of Array.isArray(biasPreset) ? biasPreset : []) {
        const text = entry?.text?.length > 0 ? entry.text.trim() : '';
        const encodeText = text.length > 0 ? getEntryEncodeText(text) : null;
        if (encodeText !== null) {
            texts.push(encodeText);
        }
    }
    return texts;
}

/**
 * Builds the logit bias list with the given token ids.
 * @param {object[]} biasPreset Bias preset
 * @param {(text: string) => number[]|null} getIds Token ids for an entry's text; null leaves the entry out.
 * @param {(bias: number, sequence: number[]) => object} getBiasObject Transformer function to create bias object
 * @param {string[]} [dropped] Receives the text of each entry left out.
 * @returns {object[]} Array of logit bias objects
 */
export function buildLogitBiasListResult(biasPreset, getIds, getBiasObject, dropped = undefined) {
    const result = [];

    for (const entry of biasPreset) {
        if (entry.text?.length > 0) {
            const text = entry.text.trim();

            // Skip empty lines
            if (text.length === 0) {
                continue;
            }

            const encodeText = getEntryEncodeText(text);
            if (encodeText === null) {
                // Raw token ids, JSON serialized
                try {
                    const tokens = JSON.parse(text);

                    if (Array.isArray(tokens) && tokens.every(t => Number.isInteger(t))) {
                        result.push(getBiasObject(entry.value, tokens));
                    } else {
                        throw new Error('Not an array of integers');
                    }
                } catch (err) {
                    console.log(`Failed to parse logit bias token list: ${text}`, err);
                }
                continue;
            }

            const tokens = getIds(encodeText);
            if (tokens === null) {
                dropped?.push(text);
                continue;
            }
            result.push(getBiasObject(entry.value, tokens));
        }
    }
    return result;
}

/**
 * Populate logit bias list from preset.
 * @param {object[]} biasPreset Bias preset
 * @param {number} tokenizerType Tokenizer type (see tokenizers.js). `API_CURRENT` and `BEST_MATCH`
 * use the tokenizer the server resolves, leave out entries it has no ids for, and warn about them.
 * @param {(bias: number, sequence: number[]) => object} getBiasObject Transformer function to create bias object
 * @returns {object[]} Array of logit bias objects
 */
export function getLogitBiasListResult(biasPreset, tokenizerType, getBiasObject) {
    if (tokenizerType === tokenizers.API_CURRENT || tokenizerType === tokenizers.BEST_MATCH) {
        const { ids, tokenizer } = getEntryTokenIds(getLogitBiasEntryTexts(biasPreset));
        const dropped = [];
        const result = buildLogitBiasListResult(biasPreset, text => ids.get(text) ?? null, getBiasObject, dropped);
        showDroppedEntries(tokenizer, dropped);
        return result;
    }
    return buildLogitBiasListResult(biasPreset, text => getTextTokens(tokenizerType, text), getBiasObject);
}
