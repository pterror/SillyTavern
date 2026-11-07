import {
    abortStatusCheck,
    online_status,
    resultCheckStatus,
    saveSettings,
    saveSettingsDebounced,
    setGenerationParamsFromPreset,
    setOnlineStatus,
    startStatusLoading,
} from '../script.js';
import { max_context } from './generation-params.js';
import { getRequestHeaders } from './request-headers.js';
import { deriveTemplatesFromChatTemplate } from './chat-templates.js';
import { t } from './i18n.js';
import { autoSelectInstructPreset, selectContextPreset, selectInstructPreset } from './instruct-mode.js';
import { createNewLogitBiasEntry, displayLogitBias } from './logit-bias.js';

import { power_user, registerDebugFunction } from './power-user.js';
import { SERVER_OWNED, newUi, newUiStarted } from './new-ui-page.js';
import { importBrowserSamplerSelect } from './samplerSelect.js';
import { SECRET_KEYS, writeSecret } from './secrets.js';
import { loadAphroditeModels, loadDreamGenModels, loadFeatherlessModels, loadGenericModels, loadInfermaticAIModels, loadLlamaCppModels, loadMancerModels, loadOllamaModels, loadOpenRouterModels, loadTabbyModels, loadTogetherAIModels, loadVllmModels, updateOpenRouterProvidersWarning } from './textgen-models.js';
import { TOKENIZER_SUPPORTED_KEY } from './tokenizers.js';
import { AbortReason } from './util/AbortReason.js';
import { getSortableDelay, arraysEqual } from './utils.js';
import { setting_names } from './textgen-setting-names.js';
import { textgen_connection_defaults, textgen_types } from './textgen-connection-defaults.js';

const {
    GENERIC,
    MANCER,
    VLLM,
    APHRODITE,
    TABBY,
    TOGETHERAI,
    OOBA,
    OLLAMA,
    LLAMACPP,
    INFERMATICAI,
    DREAMGEN,
    OPENROUTER,
    KOBOLDCPP,
    HUGGINGFACE,
    FEATHERLESS,
} = textgen_types;

const LLAMACPP_DEFAULT_ORDER = [
    'penalties',
    'dry',
    'top_n_sigma',
    'top_k',
    'typ_p',
    'top_p',
    'min_p',
    'xtc',
    'temperature',
    'adaptive_p',
];
const OOBA_DEFAULT_ORDER = [
    'repetition_penalty',
    'presence_penalty',
    'frequency_penalty',
    'dry',
    'temperature',
    'dynamic_temperature',
    'quadratic_sampling',
    'top_n_sigma',
    'top_k',
    'top_p',
    'typical_p',
    'epsilon_cutoff',
    'eta_cutoff',
    'tfs',
    'top_a',
    'min_p',
    'adaptive_p',
    'mirostat',
    'xtc',
    'encoder_repetition_penalty',
    'no_repeat_ngram',
];
const APHRODITE_DEFAULT_ORDER = [
    'dry',
    'penalties',
    'no_repeat_ngram',
    'temperature',
    'top_nsigma',
    'top_p_top_k',
    'top_a',
    'min_p',
    'tfs',
    'eta_cutoff',
    'epsilon_cutoff',
    'typical_p',
    'quadratic',
    'xtc',
];
const BIAS_KEY = '#textgenerationwebui_api-settings';

// Maybe let it be configurable in the future?
// (7 days later) The future has come.
const MANCER_SERVER_KEY = 'mancer_server';
const MANCER_SERVER_DEFAULT = 'https://neuro.mancer.tech';
let MANCER_SERVER = localStorage.getItem(MANCER_SERVER_KEY) ?? MANCER_SERVER_DEFAULT;
let TOGETHERAI_SERVER = 'https://api.together.xyz';
let INFERMATICAI_SERVER = 'https://api.totalgpt.ai';
let DREAMGEN_SERVER = 'https://dreamgen.com';
let OPENROUTER_SERVER = 'https://openrouter.ai/api';
let FEATHERLESS_SERVER = 'https://api.featherless.ai/v1';

export const SERVER_INPUTS = {
    [textgen_types.OOBA]: '#textgenerationwebui_api_url_text',
    [textgen_types.VLLM]: '#vllm_api_url_text',
    [textgen_types.APHRODITE]: '#aphrodite_api_url_text',
    [textgen_types.TABBY]: '#tabby_api_url_text',
    [textgen_types.KOBOLDCPP]: '#koboldcpp_api_url_text',
    [textgen_types.LLAMACPP]: '#llamacpp_api_url_text',
    [textgen_types.OLLAMA]: '#ollama_api_url_text',
    [textgen_types.HUGGINGFACE]: '#huggingface_api_url_text',
    [textgen_types.GENERIC]: '#generic_api_url_text',
};

const KOBOLDCPP_ORDER = [6, 0, 1, 3, 4, 2, 5];
export const textgenerationwebui_settings = {
    temp: 0.7,
    temperature_last: true,
    top_p: 0.5,
    top_k: 40,
    top_a: 0,
    tfs: 1,
    epsilon_cutoff: 0,
    eta_cutoff: 0,
    typical_p: 1,
    min_p: 0,
    rep_pen: 1.2,
    rep_pen_range: 0,
    rep_pen_decay: 0,
    rep_pen_slope: 1,
    no_repeat_ngram_size: 0,
    penalty_alpha: 0,
    num_beams: 1,
    length_penalty: 1,
    min_length: 0,
    encoder_rep_pen: 1,
    freq_pen: 0,
    presence_pen: 0,
    skew: 0,
    do_sample: true,
    early_stopping: false,
    dynatemp: false,
    min_temp: 0,
    max_temp: 2.0,
    dynatemp_exponent: 1.0,
    smoothing_factor: 0.0,
    smoothing_curve: 1.0,
    dry_allowed_length: 2,
    dry_multiplier: 0.0,
    dry_base: 1.75,
    dry_sequence_breakers: '["\\n", ":", "\\"", "*"]',
    dry_penalty_last_n: 0,
    max_tokens_second: 0,
    seed: -1,
    preset: 'Default',
    add_bos_token: true,
    stopping_strings: [],
    //truncation_length: 2048,
    ban_eos_token: false,
    skip_special_tokens: true,
    include_reasoning: true,
    streaming: false,
    mirostat_mode: 0,
    mirostat_tau: 5,
    mirostat_eta: 0.1,
    guidance_scale: 1,
    negative_prompt: '',
    grammar_string: '',
    json_schema: null,
    json_schema_allow_empty: false,
    banned_tokens: '',
    global_banned_tokens: '',
    send_banned_tokens: true,
    sampler_priority: OOBA_DEFAULT_ORDER,
    samplers: LLAMACPP_DEFAULT_ORDER,
    samplers_priorities: APHRODITE_DEFAULT_ORDER,
    ignore_eos_token: false,
    spaces_between_special_tokens: true,
    speculative_ngram: false,
    type: textgen_types.OOBA,
    sampler_order: KOBOLDCPP_ORDER,
    logit_bias: [],
    n: 1,
    xtc_threshold: 0.1,
    xtc_probability: 0,
    nsigma: 0.0,
    min_keep: 0,
    ...structuredClone(textgen_connection_defaults),
    extensions: {},
    adaptive_target: -0.01,
    adaptive_decay: 0.9,
};


export let textgenerationwebui_banned_in_macros = [];

export let textgenerationwebui_presets = [];
export let textgenerationwebui_preset_names = [];

export { textgen_types };


function validateTextGenUrl() {
    const selector = SERVER_INPUTS[textgenerationwebui_settings.type];

    if (!selector) {
        return;
    }

    const control = $(selector);
    const url = String(control.val()).trim();
    const formattedUrl = formatTextGenURL(url);

    if (!formattedUrl) {
        toastr.error(t`Enter a valid API URL`, 'Text Completion API');
        return;
    }

    control.val(formattedUrl);
}

/**
 * Gets the API URL for the selected text generation type.
 * @param {string} type If it's set, ignores active type
 * @returns {string} API URL
 */
export function getTextGenServer(type = null) {
    const selectedType = type ?? textgenerationwebui_settings.type;
    switch (selectedType) {
        case FEATHERLESS:
            return FEATHERLESS_SERVER;
        case MANCER:
            return MANCER_SERVER;
        case TOGETHERAI:
            return TOGETHERAI_SERVER;
        case INFERMATICAI:
            return INFERMATICAI_SERVER;
        case DREAMGEN:
            return DREAMGEN_SERVER;
        case OPENROUTER:
            return OPENROUTER_SERVER;
        default:
            return textgenerationwebui_settings.server_urls[selectedType] ?? '';
    }
}

async function selectPreset(name) {
    const preset = textgenerationwebui_presets[textgenerationwebui_preset_names.indexOf(name)];

    if (!preset) {
        return;
    }

    textgenerationwebui_settings.preset = name;
    for (const name of setting_names) {
        if (isServerOwned(name)) continue;
        const value = preset[name];
        setSettingByName(name, value, true);
    }
    displayLogitBias(preset.logit_bias, BIAS_KEY, 'textgenerationwebui_settings');
    await saveSettings('textgenerationwebui_settings');
    if (newUiStarted()) await newUi().settings.reread();
}

function formatTextGenURL(value) {
    try {
        const noFormatTypes = [MANCER, TOGETHERAI, INFERMATICAI, DREAMGEN, OPENROUTER];
        if (noFormatTypes.includes(textgenerationwebui_settings.type)) {
            return value;
        }

        const url = new URL(value);
        return url.toString();
    } catch {
        // Just using URL as a validation check
    }
    return null;
}

function convertPresets(presets) {
    return Array.isArray(presets) ? presets.map((p) => JSON.parse(p)) : [];
}

const isServerOwned = (/** @type {string} */ key) => SERVER_OWNED.has(`textgenerationwebui_settings.${key}`);

export async function loadTextGenSettings(data, loadedSettings) {
    textgenerationwebui_presets = convertPresets(data.textgenerationwebui_presets);
    textgenerationwebui_preset_names = data.textgenerationwebui_preset_names ?? [];
    for (const [key, value] of Object.entries(loadedSettings.textgenerationwebui_settings ?? {})) {
        if (isServerOwned(key) && newUiStarted()) continue;
        textgenerationwebui_settings[key] = value;
    }

    if (loadedSettings.api_server_textgenerationwebui) {
        for (const type of Object.keys(SERVER_INPUTS)) {
            textgenerationwebui_settings.server_urls[type] = loadedSettings.api_server_textgenerationwebui;
        }
        delete loadedSettings.api_server_textgenerationwebui;
    }

    for (const [type, selector] of Object.entries(SERVER_INPUTS)) {
        const control = $(selector);
        control.val(textgenerationwebui_settings.server_urls[type] ?? '').on('input', function () {
            textgenerationwebui_settings.server_urls[type] = String($(this).val()).trim();
            saveSettingsDebounced('textgenerationwebui_settings');
        });
    }

    if (loadedSettings.api_use_mancer_webui) {
        textgenerationwebui_settings.type = MANCER;
    }

    for (const name of textgenerationwebui_preset_names) {
        const option = document.createElement('option');
        option.value = name;
        option.innerText = name;
        $('#settings_preset_textgenerationwebui').append(option);
    }

    if (textgenerationwebui_settings.preset) {
        $('#settings_preset_textgenerationwebui').val(textgenerationwebui_settings.preset);
    }

    for (const i of setting_names) {
        if (isServerOwned(i)) continue;
        const value = textgenerationwebui_settings[i];
        setSettingByName(i, value);
    }

    $('#textgen_type').val(textgenerationwebui_settings.type);
    $('#openrouter_providers_text').val(textgenerationwebui_settings.openrouter_providers).trigger('change');
    $('#openrouter_quantizations_text').val(textgenerationwebui_settings.openrouter_quantizations).trigger('change');
    showSamplerControls(textgenerationwebui_settings.type);
    displayLogitBias(textgenerationwebui_settings.logit_bias, BIAS_KEY, 'textgenerationwebui_settings');

    registerDebugFunction('change-mancer-url', 'Change Mancer base URL', 'Change Mancer API server base URL', () => {
        const result = prompt(`Enter Mancer base URL\nDefault: ${MANCER_SERVER_DEFAULT}`, MANCER_SERVER);

        if (result) {
            localStorage.setItem(MANCER_SERVER_KEY, result);
            MANCER_SERVER = result;
        }
    });
}

/**
 * Sorts the sampler items by the given order.
 * @param {any[]} orderArray Sampler order array.
 */
function sortKoboldItemsByOrder(orderArray) {
    console.debug('Preset samplers order:', orderArray);
    const $draggableItems = $('#koboldcpp_order');

    for (let i = 0; i < orderArray.length; i++) {
        const index = orderArray[i];
        const $item = $draggableItems.find(`[data-id="${index}"]`).detach();
        $draggableItems.append($item);
    }
}

function sortLlamacppItemsByOrder(orderArray) {
    console.debug('Preset samplers order: ', orderArray);
    const $container = $('#llamacpp_samplers_sortable');

    orderArray.forEach((name) => {
        const $item = $container.find(`[data-name="${name}"]`).detach();
        $container.append($item);
    });
}

function sortOobaItemsByOrder(orderArray) {
    console.debug('Preset samplers order: ', orderArray);
    const $container = $('#sampler_priority_container');

    orderArray.forEach((name) => {
        const $item = $container.find(`[data-name="${name}"]`).detach();
        $container.append($item);
    });
}

/**
 * Sorts the Aphrodite sampler items by the given order.
 * @param {string[]} orderArray Sampler order array.
 */
function sortAphroditeItemsByOrder(orderArray) {
    console.debug('Preset samplers order: ', orderArray);
    const $container = $('#sampler_priority_container_aphrodite');

    orderArray.forEach((name) => {
        const $item = $container.find(`[data-name="${name}"]`).detach();
        $container.append($item);
    });
}

async function getStatusTextgen() {
    const url = '/api/backends/text-completions/status';

    const endpoint = getTextGenServer();

    if (!endpoint) {
        console.warn('No endpoint for status check');
        setOnlineStatus('no_connection');
        return resultCheckStatus();
    }

    if ([textgen_types.GENERIC, textgen_types.OOBA].includes(textgenerationwebui_settings.type) && textgenerationwebui_settings.bypass_status_check) {
        setOnlineStatus(t`Status check bypassed`);
        return resultCheckStatus();
    }

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                api_server: endpoint,
                api_type: textgenerationwebui_settings.type,
            }),
            signal: abortStatusCheck.signal,
        });

        const data = await response.json();

        if (textgenerationwebui_settings.type === textgen_types.MANCER) {
            loadMancerModels(data?.data);
            setOnlineStatus(textgenerationwebui_settings.mancer_model);
        } else if (textgenerationwebui_settings.type === textgen_types.TOGETHERAI) {
            loadTogetherAIModels(data?.data);
            setOnlineStatus(textgenerationwebui_settings.togetherai_model);
        } else if (textgenerationwebui_settings.type === textgen_types.OLLAMA) {
            loadOllamaModels(data?.data);
            setOnlineStatus(textgenerationwebui_settings.ollama_model || t`Connected`);
        } else if (textgenerationwebui_settings.type === textgen_types.INFERMATICAI) {
            loadInfermaticAIModels(data?.data);
            setOnlineStatus(textgenerationwebui_settings.infermaticai_model);
        } else if (textgenerationwebui_settings.type === textgen_types.DREAMGEN) {
            loadDreamGenModels(data?.data);
            setOnlineStatus(textgenerationwebui_settings.dreamgen_model);
        } else if (textgenerationwebui_settings.type === textgen_types.OPENROUTER) {
            loadOpenRouterModels(data?.data);
            setOnlineStatus(textgenerationwebui_settings.openrouter_model);
        } else if (textgenerationwebui_settings.type === textgen_types.VLLM) {
            loadVllmModels(data?.data);
            setOnlineStatus(textgenerationwebui_settings.vllm_model);
        } else if (textgenerationwebui_settings.type === textgen_types.APHRODITE) {
            loadAphroditeModels(data?.data);
            setOnlineStatus(textgenerationwebui_settings.aphrodite_model);
        } else if (textgenerationwebui_settings.type === textgen_types.FEATHERLESS) {
            loadFeatherlessModels(data?.data);
            setOnlineStatus(textgenerationwebui_settings.featherless_model);
        } else if (textgenerationwebui_settings.type === textgen_types.TABBY) {
            loadTabbyModels(data?.data);
            setOnlineStatus(textgenerationwebui_settings.tabby_model || data?.result);
        } else if (textgenerationwebui_settings.type === textgen_types.LLAMACPP) {
            loadLlamaCppModels(data?.data);
            setOnlineStatus(textgenerationwebui_settings.llamacpp_model || data?.result || t`Connected`);
        } else if (textgenerationwebui_settings.type === textgen_types.GENERIC) {
            loadGenericModels(data?.data);
            setOnlineStatus(textgenerationwebui_settings.generic_model || data?.result || t`Connected`);
        } else {
            setOnlineStatus(data?.result);
        }

        if (!online_status) {
            setOnlineStatus('no_connection');
        }

        power_user.chat_template_hash = '';

        // Determine instruct mode preset
        const autoSelected = autoSelectInstructPreset(online_status);

        const supportsTokenization = response.headers.get('x-supports-tokenization') === 'true';
        supportsTokenization ? sessionStorage.setItem(TOKENIZER_SUPPORTED_KEY, 'true') : sessionStorage.removeItem(TOKENIZER_SUPPORTED_KEY);

        const wantsInstructDerivation = !autoSelected && (power_user.instruct.enabled && power_user.instruct_derived);
        const wantsContextDerivation = !autoSelected && power_user.context_derived;
        const wantsContextSize = power_user.context_size_derived;
        const supportsChatTemplate = [textgen_types.KOBOLDCPP, textgen_types.LLAMACPP].includes(textgenerationwebui_settings.type);

        if (supportsChatTemplate && (wantsInstructDerivation || wantsContextDerivation || wantsContextSize)) {
            const model = textgenerationwebui_settings.type === textgen_types.LLAMACPP
                ? textgenerationwebui_settings.llamacpp_model
                : undefined;

            const response = await fetch('/api/backends/text-completions/props', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({
                    api_server: endpoint,
                    api_type: textgenerationwebui_settings.type,
                    model: model,
                }),
            });

            if (response.ok) {
                const data = await response.json();
                if (data) {
                    const { chat_template, chat_template_hash } = data;
                    power_user.chat_template_hash = chat_template_hash;

                    if (wantsContextSize && 'default_generation_settings' in data) {
                        const backend_max_context = data.default_generation_settings.n_ctx;
                        if (backend_max_context && typeof backend_max_context === 'number') {
                            const old_value = max_context;
                            if (max_context !== backend_max_context) {
                                await setGenerationParamsFromPreset({ max_length: backend_max_context });
                            }
                            if (old_value !== max_context) {
                                console.log(`Auto-switched max context from ${old_value} to ${max_context}`);
                                toastr.info(`${old_value} ⇒ ${max_context}`, 'Context Size Changed');
                            }
                        }
                    }
                    console.log(`We have chat template ${chat_template.split('\n')[0]}...`);
                    const savedTemplate = power_user.model_templates_mappings[chat_template_hash];
                    const derivedTemplate = await deriveTemplatesFromChatTemplate(chat_template, chat_template_hash);
                    const { context, instruct } = savedTemplate ?? derivedTemplate;

                    if (wantsContextDerivation && context) {
                        selectContextPreset(context, { isAuto: true });
                    }
                    if (wantsInstructDerivation && power_user.instruct.enabled && instruct) {
                        selectInstructPreset(instruct, { isAuto: true });
                    }
                }
            }
        }

        // We didn't get a 200 status code, but the endpoint has an explanation. Which means it DID connect, but I digress.
        if (online_status === 'no_connection' && data.response) {
            toastr.error(data.response, t`API Error`, { timeOut: 5000, preventDuplicates: true });
        }
    } catch (err) {
        if (err instanceof AbortReason) {
            console.info('Status check aborted.', err.reason);
        } else {
            console.error('Error getting status', err);
        }
        setOnlineStatus('no_connection');
    }

    return resultCheckStatus();
}

/**
 * @param {import('/ui/entry.js').NewUi['settings']} settings
 */
export function bindTextGenSettings(settings) {
    settings.bind(textgenerationwebui_settings, 'textgenerationwebui_settings');
    settings.watchSamplers(() => showSamplerControls());
    showSamplerControls();
    void importBrowserSamplerSelect().catch(error => console.warn('[settings] the sampler select stays in the browser:', error));
}

export function initTextGenSettings() {
    $('#koboldcpp_order').sortable({
        delay: getSortableDelay(),
        stop: function () {
            const order = [];
            $('#koboldcpp_order').children().each(function () {
                order.push($(this).data('id'));
            });
            textgenerationwebui_settings.sampler_order = order;
            console.log('Samplers reordered:', textgenerationwebui_settings.sampler_order);
            saveSettingsDebounced('textgenerationwebui_settings');
        },
    });

    $('#koboldcpp_default_order').on('click', function () {
        textgenerationwebui_settings.sampler_order = KOBOLDCPP_ORDER;
        sortKoboldItemsByOrder(textgenerationwebui_settings.sampler_order);
        saveSettingsDebounced('textgenerationwebui_settings');
    });

    $('#llamacpp_samplers_sortable').sortable({
        delay: getSortableDelay(),
        stop: function () {
            const order = [];
            $('#llamacpp_samplers_sortable').children().each(function () {
                order.push($(this).data('name'));
            });
            textgenerationwebui_settings.samplers = order;
            console.log('Samplers reordered:', textgenerationwebui_settings.samplers);
            saveSettingsDebounced('textgenerationwebui_settings');
        },
    });

    $('#llamacpp_samplers_default_order').on('click', function () {
        sortLlamacppItemsByOrder(LLAMACPP_DEFAULT_ORDER);
        textgenerationwebui_settings.samplers = LLAMACPP_DEFAULT_ORDER;
        console.log('Default samplers order loaded:', textgenerationwebui_settings.samplers);
        saveSettingsDebounced('textgenerationwebui_settings');
    });

    $('#sampler_priority_container').sortable({
        delay: getSortableDelay(),
        stop: function () {
            const order = [];
            $('#sampler_priority_container').children().each(function () {
                order.push($(this).data('name'));
            });
            textgenerationwebui_settings.sampler_priority = order;
            console.log('Samplers reordered:', textgenerationwebui_settings.sampler_priority);
            saveSettingsDebounced('textgenerationwebui_settings');
        },
    });

    $('#sampler_priority_container_aphrodite').sortable({
        delay: getSortableDelay(),
        stop: function () {
            const order = [];
            $('#sampler_priority_container_aphrodite').children().each(function () {
                order.push($(this).data('name'));
            });
            textgenerationwebui_settings.samplers_priorities = order;
            console.log('Samplers reordered:', textgenerationwebui_settings.samplers_priorities);
            saveSettingsDebounced('textgenerationwebui_settings');
        },
    });

    $('#textgenerationwebui_default_order').on('click', function () {
        sortOobaItemsByOrder(OOBA_DEFAULT_ORDER);
        textgenerationwebui_settings.sampler_priority = OOBA_DEFAULT_ORDER;
        console.log('Default samplers order loaded:', textgenerationwebui_settings.sampler_priority);
        saveSettingsDebounced('textgenerationwebui_settings');
    });

    $('#aphrodite_default_order').on('click', function () {
        sortAphroditeItemsByOrder(APHRODITE_DEFAULT_ORDER);
        textgenerationwebui_settings.samplers_priorities = APHRODITE_DEFAULT_ORDER;
        console.log('Default samplers order loaded:', textgenerationwebui_settings.samplers_priorities);
        saveSettingsDebounced('textgenerationwebui_settings');
    });

    $('#textgen_type').on('change', function () {
        const type = String($(this).val());
        textgenerationwebui_settings.type = type;

        showSamplerControls(type);
        setOnlineStatus('no_connection');

        $('#main_api').trigger('change');

        if (!SERVER_INPUTS[type] || textgenerationwebui_settings.server_urls[type]) {
            $('#api_button_textgenerationwebui').trigger('click');
        }

        saveSettingsDebounced('textgenerationwebui_settings');
    });

    $('#settings_preset_textgenerationwebui').on('change', async function () {
        const presetName = $(this).val();
        await selectPreset(presetName);
    });

    for (const i of setting_names) {
        if (isServerOwned(i)) continue;
        $(`#${i}_textgenerationwebui`).attr('x-setting-id', i);
        $(document).on('input', `#${i}_textgenerationwebui`, function () {
            const isCheckbox = $(this).attr('type') == 'checkbox';
            const isText = $(this).attr('type') == 'text' || $(this).is('textarea');
            const id = $(this).attr('x-setting-id');

            if (isCheckbox) {
                const value = $(this).prop('checked');
                textgenerationwebui_settings[id] = value;
            } else if (isText) {
                const value = $(this).val();
                textgenerationwebui_settings[id] = value;
            } else {
                const value = Number($(this).val());
                $(`#${id}_counter_textgenerationwebui`).val(value);
                textgenerationwebui_settings[id] = value;
            }
            saveSettingsDebounced('textgenerationwebui_settings');
        });
    }

    $('#textgen_logit_bias_new_entry').on('click', () => createNewLogitBiasEntry(textgenerationwebui_settings.logit_bias, BIAS_KEY, 'textgenerationwebui_settings'));

    $('#openrouter_providers_text').on('change', function () {
        const selectedProviders = $(this).val();

        // Not a multiple select?
        if (!Array.isArray(selectedProviders)) {
            return;
        }

        const providersChanged = !arraysEqual(selectedProviders, textgenerationwebui_settings.openrouter_providers ?? []);
        textgenerationwebui_settings.openrouter_providers = selectedProviders;

        updateOpenRouterProvidersWarning('#openrouter_providers_text');
        if (providersChanged) {
            saveSettingsDebounced('textgenerationwebui_settings');
        }
    });

    $('#openrouter_allow_fallbacks_textgenerationwebui').on('input', function () {
        updateOpenRouterProvidersWarning('#openrouter_providers_text');
    });

    $('#openrouter_quantizations_text').on('change', function () {
        const selectedQuantizations = $(this).val();

        // Not a multiple select?
        if (!Array.isArray(selectedQuantizations)) {
            return;
        }

        const quantizationsChanged = !arraysEqual(selectedQuantizations, textgenerationwebui_settings.openrouter_quantizations ?? []);
        textgenerationwebui_settings.openrouter_quantizations = selectedQuantizations;

        if (quantizationsChanged) {
            saveSettingsDebounced('textgenerationwebui_settings');
        }
    });

    $('#api_button_textgenerationwebui').on('click', async function (e) {
        const keys = [
            { id: 'api_key_mancer', secret: SECRET_KEYS.MANCER },
            { id: 'api_key_vllm', secret: SECRET_KEYS.VLLM },
            { id: 'api_key_aphrodite', secret: SECRET_KEYS.APHRODITE },
            { id: 'api_key_tabby', secret: SECRET_KEYS.TABBY },
            { id: 'api_key_togetherai', secret: SECRET_KEYS.TOGETHERAI },
            { id: 'api_key_ooba', secret: SECRET_KEYS.OOBA },
            { id: 'api_key_infermaticai', secret: SECRET_KEYS.INFERMATICAI },
            { id: 'api_key_dreamgen', secret: SECRET_KEYS.DREAMGEN },
            { id: 'api_key_openrouter-tg', secret: SECRET_KEYS.OPENROUTER },
            { id: 'api_key_koboldcpp', secret: SECRET_KEYS.KOBOLDCPP },
            { id: 'api_key_llamacpp', secret: SECRET_KEYS.LLAMACPP },
            { id: 'api_key_featherless', secret: SECRET_KEYS.FEATHERLESS },
            { id: 'api_key_huggingface', secret: SECRET_KEYS.HUGGINGFACE },
            { id: 'api_key_generic', secret: SECRET_KEYS.GENERIC },
        ];

        for (const key of keys) {
            const keyValue = String($(`#${key.id}`).val()).trim();
            if (keyValue.length) {
                await writeSecret(key.secret, keyValue);
            }
        }

        validateTextGenUrl();
        startStatusLoading();
        getStatusTextgen();
    });
}

/**
 * Hides and shows preset samplers from the left panel.
 * @param {string?} apiType API Type selected in API Connections - Currently selected one by default
 * @returns void
 */
function showSamplerControls(apiType = null) {
    $('#textgenerationwebui_api-settings [data-tg-samplers], #textgenerationwebui_api [data-tg-samplers]').each(function (idx, elem) {
        const typeSpecificControlled = $(elem).data('tg-type') !== undefined;

        if (!typeSpecificControlled) $(this).show();
    });

    showTypeSpecificControls(apiType ?? textgenerationwebui_settings.type);

    const select = newUiStarted() ? newUi().settings.samplers() : { manual: false, shown: [] };
    const prioritizeManualSamplerSelect = select.manual;
    const samplersActivatedManually = select.shown;

    if (!samplersActivatedManually.length || !prioritizeManualSamplerSelect) return;

    $('#textgenerationwebui_api-settings [data-tg-samplers], #textgenerationwebui_api [data-tg-samplers]').each(function () {
        const tgSamplers = $(this).attr('data-tg-samplers').split(',').map(x => x.trim()).filter(str => str !== '');

        for (const tgSampler of tgSamplers) {
            if (samplersActivatedManually.includes(tgSampler)) {
                $(this).show();
                return;
            } else {
                $(this).hide();
            }
        }
    });
}

function showTypeSpecificControls(apiType) {
    $('[data-tg-type]').each(function () {
        const mode = String($(this).attr('data-tg-type-mode') ?? '').toLowerCase().trim();
        const tgTypes = $(this).attr('data-tg-type').split(',').map(x => x.trim());

        if (mode === 'except') {
            $(this)[tgTypes.includes(apiType) ? 'hide' : 'show']();
            return;
        }

        for (const tgType of tgTypes) {
            if (tgType === apiType || tgType == 'all') {
                $(this).show();
                return;
            } else {
                $(this).hide();
            }
        }
    });
}

/**
 * Inserts missing items from the source array into the target array.
 * @param {any[]} source - Source array
 * @param {any[]} target - Target array
 * @returns {void}
 */
function insertMissingArrayItems(source, target) {
    if (source === target || !Array.isArray(source) || !Array.isArray(target)) {
        return;
    }

    for (const item of source) {
        if (!target.includes(item)) {
            const index = source.indexOf(item);
            target.splice(index, 0, item);
        }
    }
}

function setSettingByName(setting, value, trigger) {
    if ('extensions' === setting) {
        value = value || {};
        textgenerationwebui_settings.extensions = value;
        return;
    }

    if ('json_schema' === setting) {
        textgenerationwebui_settings.json_schema = value ?? null;
        $('#tabby_json_schema').val(value ? JSON.stringify(textgenerationwebui_settings.json_schema, null, 2) : '');
        return;
    }

    if (value === null || value === undefined) {
        return;
    }

    if ('sampler_order' === setting) {
        value = Array.isArray(value) ? value : KOBOLDCPP_ORDER;
        sortKoboldItemsByOrder(value);
        textgenerationwebui_settings.sampler_order = value;
        return;
    }

    if ('sampler_priority' === setting) {
        value = Array.isArray(value) ? value : OOBA_DEFAULT_ORDER;
        insertMissingArrayItems(OOBA_DEFAULT_ORDER, value);
        sortOobaItemsByOrder(value);
        textgenerationwebui_settings.sampler_priority = value;
        return;
    }

    if ('samplers_priorities' === setting) {
        value = Array.isArray(value) ? value : APHRODITE_DEFAULT_ORDER;
        insertMissingArrayItems(APHRODITE_DEFAULT_ORDER, value);
        sortAphroditeItemsByOrder(value);
        textgenerationwebui_settings.samplers_priorities = value;
        return;
    }

    if ('samplers' === setting) {
        value = Array.isArray(value) ? value : LLAMACPP_DEFAULT_ORDER;
        insertMissingArrayItems(LLAMACPP_DEFAULT_ORDER, value);
        sortLlamacppItemsByOrder(value);
        textgenerationwebui_settings.samplers = value;
        return;
    }

    if ('logit_bias' === setting) {
        textgenerationwebui_settings.logit_bias = Array.isArray(value) ? value : [];
        return;
    }

    const isCheckbox = $(`#${setting}_textgenerationwebui`).attr('type') == 'checkbox';
    const isText = $(`#${setting}_textgenerationwebui`).attr('type') == 'text' || $(`#${setting}_textgenerationwebui`).is('textarea');
    if (isCheckbox) {
        const val = Boolean(value);
        $(`#${setting}_textgenerationwebui`).prop('checked', val);

        if ('send_banned_tokens' === setting) {
            $(`#${setting}_textgenerationwebui`).trigger('change');
        }
    } else if (isText) {
        $(`#${setting}_textgenerationwebui`).val(value);
    } else {
        const val = parseFloat(value);
        $(`#${setting}_textgenerationwebui`).val(val);
        $(`#${setting}_counter_textgenerationwebui`).val(val);
        if (power_user.enableZenSliders) {
            let zenSlider = $(`#${setting}_textgenerationwebui_zenslider`).slider();
            zenSlider.slider('option', 'value', val);
            zenSlider.slider('option', 'slide')
                .call(zenSlider, null, {
                    handle: $('.ui-slider-handle', zenSlider), value: val,
                });
        }
    }

    if (trigger) {
        $(`#${setting}_textgenerationwebui`).trigger('input');
    }
}

/**
 * parseTextgenLogprobs converts a logprobs object returned from a textgen API
 * for a single token into a TokenLogprobs object used by the Token
 * Probabilities feature.
 * @param {string} token - the text of the token that the logprobs are for
 * @param {Object} logprobs - logprobs object returned from the API
 * @returns {import('./logprobs.js').TokenLogprobs | null} - converted logprobs
 */
export function parseTextgenLogprobs(token, logprobs) {
    if (!logprobs) {
        return null;
    }

    switch (textgenerationwebui_settings.type) {
        case KOBOLDCPP:
        case TABBY:
        case VLLM:
        case APHRODITE:
        case MANCER:
        case INFERMATICAI:
        case OOBA: {
            /** @type {Record<string, number>[]} */
            const topLogprobs = logprobs.top_logprobs;
            if (!topLogprobs?.length) {
                return null;
            }
            const candidates = Object.entries(topLogprobs[0]);
            return { token, topLogprobs: candidates };
        }
        case LLAMACPP: {
            if (!logprobs?.length) {
                return null;
            }

            // 3 cases:
            // 1. Before commit 6c5bc06, "probs" key with "tok_str"/"prob", and probs are [0, 1] so use them directly.
            // 2. After commit 6c5bc06 but before commit 89d604f broke logprobs (they all return the first token's logprobs)
            //    We don't know the llama.cpp version so we can't do much about this.
            // 3. After commit 89d604f uses OpenAI-compatible format with "completion_probabilities" and "token"/"logprob" keys.
            //    Note that it is also the *actual* logprob (negative number), so we need to convert to [0, 1].
            if (logprobs?.[0]?.probs) {
                const candidates = logprobs?.[0]?.probs?.map(x => [x.tok_str, x.prob]);
                if (!candidates) {
                    return null;
                }
                return { token, topLogprobs: candidates };
            } else if (logprobs?.[0].top_logprobs) {
                const candidates = logprobs?.[0]?.top_logprobs?.map(x => [x.token, Math.exp(x.logprob)]);
                if (!candidates) {
                    return null;
                }
                return { token, topLogprobs: candidates };
            }
            return null;
        }
        default:
            return null;
    }
}

export function parseTabbyLogprobs(data) {
    const text = data?.choices?.[0]?.text;
    const offsets = data?.choices?.[0]?.logprobs?.text_offset;

    if (!text || !offsets) {
        return null;
    }

    // Convert string offsets list to tokens
    const tokens = offsets?.map((offset, index) => {
        const nextOffset = offsets[index + 1] || text.length;
        return text.substring(offset, nextOffset);
    });

    const topLogprobs = data?.choices?.[0]?.logprobs?.top_logprobs?.map(x => ({ top_logprobs: [x] }));
    return tokens?.map((token, index) => parseTextgenLogprobs(token, topLogprobs[index])) || null;
}

/**
 * Gets the text generation model specified by the given text completion settings
 * @param {TextCompletionSettings} settings Text completion settings to use
 * @returns {string} model name
 */
export function getTextGenModel(settings = null) {
    settings = settings ?? textgenerationwebui_settings;
    switch (settings.type) {
        case OOBA:
            if (settings.custom_model) {
                return settings.custom_model;
            }
            break;
        case GENERIC:
            if (settings.generic_model) {
                return settings.generic_model;
            }
            break;
        case MANCER:
            return settings.mancer_model;
        case TOGETHERAI:
            return settings.togetherai_model;
        case INFERMATICAI:
            return settings.infermaticai_model;
        case DREAMGEN:
            return settings.dreamgen_model;
        case OPENROUTER:
            return settings.openrouter_model;
        case VLLM:
            return settings.vllm_model;
        case APHRODITE:
            return settings.aphrodite_model;
        case OLLAMA:
            if (!settings.ollama_model) {
                toastr.error(t`No Ollama model selected.`, 'Text Completion API');
                throw new Error('No Ollama model selected');
            }
            return settings.ollama_model;
        case FEATHERLESS:
            return settings.featherless_model;
        case HUGGINGFACE:
            return 'tgi';
        case TABBY:
            if (settings.tabby_model) {
                return settings.tabby_model;
            }
            break;
        case LLAMACPP:
            if (settings.llamacpp_model) {
                return settings.llamacpp_model;
            }
            break;
        default:
            return undefined;
    }

    return undefined;
}

