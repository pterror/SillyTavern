import { Fuse, DOMPurify } from '../lib.js';

import {
    abortStatusCheck,
    cancelStatusCheck,
    generateRaw,
    is_send_press,
    resultCheckStatus,
    saveSettings,
    saveSettingsDebounced,
    setOnlineStatus,
    startStatusLoading,
    substituteParams,
} from '../script.js';
import { getRequestHeaders } from './request-headers.js';
import { buildPrompt } from './generation.js';
import { event_types, eventSource } from './events.js';

import {
    PromptManager,
} from './PromptManager.js';

import { markCharacterEditorCountsStale } from './power-user.js';
import { SECRET_KEYS, secret_state, writeSecret } from './secrets.js';

import {
    arraysEqual,
    download,
    getFileText,
    getSortableDelay,
    getStringHash,
    isUuid,
    isValidUrl,
    parseJsonFile,
    resetScrollHeight,
    textValueMatcher,
    uuidv4,
} from './utils.js';
import { isMobile } from './RossAscends-mods.js';
import { SlashCommandParser } from './slash-commands/SlashCommandParser.js';
import { SlashCommand } from './slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument } from './slash-commands/SlashCommandArgument.js';
import { renderTemplateAsync } from './templates.js';
import { SlashCommandEnumValue } from './slash-commands/SlashCommandEnumValue.js';
import { callGenericPopup, Popup, POPUP_RESULT, POPUP_TYPE } from './popup.js';
import { t } from './i18n.js';
import { ToolManager } from './tool-calling.js';
import { accountStorage } from './util/AccountStorage.js';
import { COMETAPI_IGNORE_PATTERNS } from './constants.js';
import { syncNanoGptProvidersForModel, syncOpenRouterProvidersForModel, updateNanoGptProvidersWarning, updateOpenRouterProvidersWarning } from './textgen-models.js';
import { main_api } from './generation-params.js';
import { GLOBAL_PROMPT_ORDER_ID } from './prompt-manager-defaults.js';
import { SERVER_OWNED, newUi, newUiStarted } from './new-ui-page.js';
import {
    default_main_prompt,
    default_nsfw_prompt,
    default_jailbreak_prompt,
    default_enhance_definitions_prompt,
    openrouter_website_model,
    chat_completion_sources,
    custom_prompt_post_processing_types,
    ZAI_ENDPOINT,
    POLLINATIONS_ENDPOINT,
    SILICONFLOW_ENDPOINT,
    MINIMAX_ENDPOINT,
    default_settings,
    migrateChatCompletionSettings,
    settingsToUpdate,
} from './chat-completion-defaults.js';

export {
    chat_completion_sources,
    custom_prompt_post_processing_types,
    ZAI_ENDPOINT,
    POLLINATIONS_ENDPOINT,
    SILICONFLOW_ENDPOINT,
    MINIMAX_ENDPOINT,
    oai_settings,
    loadOpenAISettings,
    setupChatCompletionPromptManager,
};


export let model_list = [];

const sensitiveFields = [
    'reverse_proxy',
    'proxy_password',
    'custom_url',
    'custom_include_body',
    'custom_exclude_body',
    'custom_include_headers',
    'vertexai_region',
    'vertexai_express_project_id',
    'azure_base_url',
    'azure_deployment_name',
    'workers_ai_account_id',
];


const oai_settings = structuredClone(default_settings);

export let proxies = [
    {
        name: 'None',
        url: '',
        password: '',
    },
];
export let selected_proxy = proxies[0];

export let openai_setting_names;
export let openai_settings;

/** @type {import('./PromptManager.js').PromptManager} */
export let promptManager = null;

async function validateReverseProxy() {
    if (!oai_settings.reverse_proxy) {
        return;
    }

    try {
        new URL(oai_settings.reverse_proxy);
    } catch (err) {
        toastr.error(t`Entered reverse proxy address is not a valid URL`);
        setOnlineStatus('no_connection');
        resultCheckStatus();
        throw err;
    }
    const rememberKey = `Proxy_SkipConfirm_${getStringHash(oai_settings.reverse_proxy)}`;
    const skipConfirm = accountStorage.getItem(rememberKey) === 'true';

    const confirmation = skipConfirm || await Popup.show.confirm(t`Connecting To Proxy`, await renderTemplateAsync('proxyConnectionWarning', { proxyURL: DOMPurify.sanitize(oai_settings.reverse_proxy) }));

    if (!confirmation) {
        toastr.error(t`Update or remove your reverse proxy settings.`);
        setOnlineStatus('no_connection');
        resultCheckStatus();
        throw new Error('Proxy connection denied.');
    }

    accountStorage.setItem(rememberKey, String(true));
}

/**
 * @param openAiSettings
 * @returns {PromptManager|null}
 */
function setupChatCompletionPromptManager(openAiSettings) {
    if (promptManager) {
        promptManager.render(false);
        return promptManager;
    }

    promptManager = new PromptManager();

    const configuration = {
        prefix: 'completion_',
        containerIdentifier: 'completion_prompt_manager',
        listIdentifier: 'completion_prompt_manager_list',
        toggleDisabled: [],
        sortableDelay: getSortableDelay(),
        defaultPrompts: {
            main: default_main_prompt,
            nsfw: default_nsfw_prompt,
            jailbreak: default_jailbreak_prompt,
            enhanceDefinitions: default_enhance_definitions_prompt,
        },
        promptOrder: {
            strategy: 'global',
            dummyId: GLOBAL_PROMPT_ORDER_ID,
        },
    };

    promptManager.saveServiceSettings = () => {
        saveSettingsDebounced('oai_settings');
        return new Promise((resolve) => eventSource.once(event_types.SETTINGS_UPDATED, resolve));
    };

    promptManager.tryGenerate = async () => {
        try {
            const built = await buildPrompt();
            if (built) promptManager.setBuiltPrompt(built);
        } catch (error) {
            promptManager.setBuiltPrompt(null, String(error?.message ?? error));
        }
    };

    promptManager.init(configuration, openAiSettings);
    promptManager.render(false);

    return promptManager;
}

/**
 * @param {ChatCompletionSettings} settings
 * @returns {string}
 */
export function getChatCompletionModel(settings = null) {
    settings = settings ?? oai_settings;
    const source = settings.chat_completion_source;
    switch (source) {
        case chat_completion_sources.CLAUDE:
            return settings.claude_model;
        case chat_completion_sources.OPENAI:
            return settings.openai_model;
        case chat_completion_sources.MAKERSUITE:
            return settings.google_model;
        case chat_completion_sources.VERTEXAI:
            return settings.vertexai_model;
        case chat_completion_sources.OPENROUTER:
            return settings.openrouter_model !== openrouter_website_model ? settings.openrouter_model : null;
        case chat_completion_sources.AI21:
            return settings.ai21_model;
        case chat_completion_sources.MISTRALAI:
            return settings.mistralai_model;
        case chat_completion_sources.CUSTOM:
            return settings.custom_model;
        case chat_completion_sources.COHERE:
            return settings.cohere_model;
        case chat_completion_sources.PERPLEXITY:
            return settings.perplexity_model;
        case chat_completion_sources.GROQ:
            return settings.groq_model;
        case chat_completion_sources.SILICONFLOW:
            return settings.siliconflow_model;
        case chat_completion_sources.MINIMAX:
            return settings.minimax_model;
        case chat_completion_sources.ELECTRONHUB:
            return settings.electronhub_model;
        case chat_completion_sources.CHUTES:
            return settings.chutes_model;
        case chat_completion_sources.NANOGPT:
            return settings.nanogpt_model;
        case chat_completion_sources.DEEPSEEK:
            return settings.deepseek_model;
        case chat_completion_sources.AIMLAPI:
            return settings.aimlapi_model;
        case chat_completion_sources.XAI:
            return settings.xai_model;
        case chat_completion_sources.POLLINATIONS:
            return settings.pollinations_model;
        case chat_completion_sources.COMETAPI:
            return settings.cometapi_model;
        case chat_completion_sources.MOONSHOT:
            return settings.moonshot_model;
        case chat_completion_sources.FIREWORKS:
            return settings.fireworks_model;
        case chat_completion_sources.AZURE_OPENAI:
            return settings.azure_openai_model;
        case chat_completion_sources.ZAI:
            return settings.zai_model;
        case chat_completion_sources.WORKERS_AI:
            return settings.workers_ai_model;
        default:
            console.error(`Unknown chat completion source: ${source}`);
            return '';
    }
}

function getOpenRouterModelTemplate(option) {
    const model = model_list.find(x => x.id === option?.element?.value);

    if (!option.id || !model) {
        return option.text;
    }

    let tokens_dollar = Number(1 / (1000 * model.pricing?.prompt));
    let tokens_rounded = (Math.round(tokens_dollar * 1000) / 1000).toFixed(0);

    const price = 0 === Number(model.pricing?.prompt) ? 'Free' : `${tokens_rounded}k t/$ `;

    return $((`
        <div class="flex-container flexFlowColumn" title="${DOMPurify.sanitize(model.id)}">
            <div><strong>${DOMPurify.sanitize(model.name)}</strong> | ${model.context_length} ctx | <small>${price}</small></div>
        </div>
    `));
}

function calculateOpenRouterCost() {
    if (oai_settings.chat_completion_source !== chat_completion_sources.OPENROUTER) {
        return;
    }

    let cost = 'Unknown';
    const model = model_list.find(x => x.id === oai_settings.openrouter_model);

    if (model?.pricing) {
        const completionCost = Number(model.pricing.completion);
        const promptCost = Number(model.pricing.prompt);
        const completionTokens = oai_settings.openai_max_tokens;
        const promptTokens = (oai_settings.openai_max_context - completionTokens);
        const totalCost = (completionCost * completionTokens) + (promptCost * promptTokens);
        if (!isNaN(totalCost)) {
            cost = '$' + totalCost.toFixed(3);
        }
    }

    if (oai_settings.enable_web_search) {
        const webSearchCost = (0.02).toFixed(2);
        cost = t`${cost} + $${webSearchCost}`;
    }

    $('#openrouter_max_prompt_cost').text(cost);
}

function getElectronHubModelTemplate(option) {
    const model = model_list.find(x => x.id === option?.element?.value);

    if (!option.id || !model) {
        return option.text;
    }

    const inputPrice = model.pricing?.input;
    const outputPrice = model.pricing?.output;
    const price = inputPrice && outputPrice ? `$${inputPrice}/$${outputPrice} in/out Mtoken` : 'Unknown';

    const visionIcon = model.metadata?.vision ? '<i class="fa-solid fa-eye fa-sm" title="This model supports vision"></i>' : '';
    const reasoningIcon = model.metadata?.reasoning ? '<i class="fa-solid fa-brain fa-sm" title="This model supports reasoning"></i>' : '';
    const toolCallsIcon = model.metadata?.function_call ? '<i class="fa-solid fa-wrench fa-sm" title="This model supports function tools"></i>' : '';
    const premiumIcon = model?.premium_model ? '<i class="fa-solid fa-crown fa-sm" title="This model requires a subscription"></i>' : '';

    const iconsContainer = document.createElement('span');
    iconsContainer.insertAdjacentHTML('beforeend', visionIcon);
    iconsContainer.insertAdjacentHTML('beforeend', reasoningIcon);
    iconsContainer.insertAdjacentHTML('beforeend', toolCallsIcon);
    iconsContainer.insertAdjacentHTML('beforeend', premiumIcon);

    const capabilities = (iconsContainer.children.length) ? ` | ${iconsContainer.innerHTML}` : '';

    return $((`
        <div class="flex-container alignItemsBaseline" title="${DOMPurify.sanitize(model.id)}">
            <strong>${DOMPurify.sanitize(model.name)}</strong> | ${model.tokens} ctx | <small>${price}</small>${capabilities}
        </div>
    `));
}

function calculateElectronHubCost() {
    if (oai_settings.chat_completion_source !== chat_completion_sources.ELECTRONHUB) {
        return;
    }

    let cost = 'Unknown';
    const model = model_list.find(x => x.id === oai_settings.electronhub_model);

    if (model?.pricing) {
        const outputCost = Number(model.pricing.output / 1000000);
        const inputCost = Number(model.pricing.input / 1000000);
        const outputTokens = oai_settings.openai_max_tokens;
        const inputTokens = (oai_settings.openai_max_context - outputTokens);
        const totalCost = (outputCost * outputTokens) + (inputCost * inputTokens);
        if (!isNaN(totalCost)) {
            cost = '$' + totalCost.toFixed(4);
        }
    }

    $('#electronhub_max_prompt_cost').text(cost);
}

function getChutesModelTemplate(option) {
    const model = model_list.find(x => x.id === option?.element?.value);

    if (!option.id || !model) {
        return option.text;
    }

    const inputPrice = model.pricing?.input;
    const outputPrice = model.pricing?.output;

    let price = 'Unknown';
    if (inputPrice !== undefined && outputPrice !== undefined) {
        if (inputPrice === 0 && outputPrice === 0) {
            price = 'Free';
        } else {
            price = `$${inputPrice}/$${outputPrice} in/out Mtoken`;
        }
    }

    const contextLength = model.context_length || model.max_model_len || 'Unknown';
    const visionIcon = model.input_modalities?.includes('image') ? '<i class="fa-solid fa-eye fa-sm" title="This model supports vision"></i>' : '';
    const reasoningIcon = model.supported_features?.includes('reasoning') ? '<i class="fa-solid fa-brain fa-sm" title="This model supports reasoning"></i>' : '';
    const toolCallsIcon = model.supported_features?.includes('structured_outputs') ? '<i class="fa-solid fa-wrench fa-sm" title="This model supports function tools"></i>' : '';

    const iconsContainer = document.createElement('span');
    iconsContainer.insertAdjacentHTML('beforeend', visionIcon);
    iconsContainer.insertAdjacentHTML('beforeend', reasoningIcon);
    iconsContainer.insertAdjacentHTML('beforeend', toolCallsIcon);

    const capabilities = (iconsContainer.children.length) ? ` | ${iconsContainer.innerHTML}` : '';

    return $((`
        <div class="flex-container alignItemsBaseline" title="${DOMPurify.sanitize(model.id)}">
            <strong>${DOMPurify.sanitize(model.id)}</strong> | ${contextLength} ctx | <small>${price}</small>${capabilities}
        </div>
    `));
}

function calculateChutesCost() {
    if (oai_settings.chat_completion_source !== chat_completion_sources.CHUTES) {
        return;
    }

    let cost = 'Unknown';
    const model = model_list.find(x => x.id === oai_settings.chutes_model);

    if (model?.pricing) {
        const outputPrice = model.pricing?.output;
        const inputPrice = model.pricing?.input;

        if (outputPrice !== undefined && inputPrice !== undefined) {
            const outputCost = Number(outputPrice / 1000000);
            const inputCost = Number(inputPrice / 1000000);
            const outputTokens = oai_settings.openai_max_tokens;
            const inputTokens = (oai_settings.openai_max_context - outputTokens);
            const totalCost = (outputCost * outputTokens) + (inputCost * inputTokens);
            if (!isNaN(totalCost)) {
                cost = '$' + totalCost.toFixed(4);
            }
        }
    }

    $('#chutes_max_prompt_cost').text(cost);
}

function getNanoGptModelTemplate(option) {
    const model = model_list.find(x => x.id === option?.element?.value);

    if (!option.id || !model) {
        return option.text;
    }

    const inputPrice = model.pricing?.prompt;
    const outputPrice = model.pricing?.completion;
    let price = 'Unknown';

    if (inputPrice !== undefined && outputPrice !== undefined) {
        if (inputPrice === 0 && outputPrice === 0) {
            price = 'Free';
        } else {
            price = `$${Math.round(inputPrice * 100) / 100}/$${Math.round(outputPrice * 100) / 100} in/out Mtoken`;
        }
    }

    const visionIcon = model.capabilities?.vision ? '<i class="fa-solid fa-eye fa-sm" title="This model supports vision"></i>' : '';
    const reasoningIcon = model.capabilities?.reasoning ? '<i class="fa-solid fa-brain fa-sm" title="This model supports reasoning"></i>' : '';
    const toolCallsIcon = model.capabilities?.tool_calling ? '<i class="fa-solid fa-wrench fa-sm" title="This model supports tool calling"></i>' : '';

    let subHtml = '';
    const sub = model.subscription;

    if (sub) {
        if (sub.included) {
            let titleText = 'Included in subscription';
            let multiplierText = '';

            if (sub.inputTokenMultiplier && sub.inputTokenMultiplier !== 1) {
                multiplierText = ` (${sub.inputTokenMultiplier}x)`;
                titleText += ` - Input Multiplier: ${sub.inputTokenMultiplier}x`;
            }
            subHtml = ` <small title="${titleText}"><i class="fa-solid fa-crown fa-sm"></i> Sub${multiplierText}</small>`;
        } else if (sub.note) {
            const safeNote = DOMPurify.sanitize(sub.note);
            subHtml = ` <small title="${safeNote}"><i class="fa-solid fa-circle-info fa-sm"></i> Not in Sub</small>`;
        }
    }

    const iconsContainer = document.createElement('span');
    iconsContainer.insertAdjacentHTML('beforeend', visionIcon);
    iconsContainer.insertAdjacentHTML('beforeend', reasoningIcon);
    iconsContainer.insertAdjacentHTML('beforeend', toolCallsIcon);
    iconsContainer.insertAdjacentHTML('beforeend', subHtml);

    const capabilities = (iconsContainer.children.length) ? ` | ${iconsContainer.innerHTML}` : '';

    const contextLength = model.context_length || 'Unknown';
    const modelName = model.name || model.id;

    return $((`
        <div class="flex-container alignItemsBaseline" title="${DOMPurify.sanitize(model.id)}">
            <strong>${DOMPurify.sanitize(modelName)}</strong> | ${contextLength} ctx | <small>${price}</small>${capabilities}
        </div>
    `));
}

function getAimlapiModelTemplate(option) {
    const model = model_list.find(x => x.id === option?.element?.value);

    if (!option.id || !model) {
        return option.text;
    }

    const vendor = model.id.split('/')[0];

    return $((`
        <div class="flex-container flexFlowColumn" title="${DOMPurify.sanitize(model.id)}">
            <div><strong>${DOMPurify.sanitize(model.info?.name || model.name || model.id)}</strong> | ${vendor}</div>
        </div>
    `));
}

function saveModelList(data) {
    model_list = data.map((model) => ({ ...model }));
    model_list.sort((a, b) => a?.id && b?.id && a.id.localeCompare(b.id));

    if (oai_settings.chat_completion_source == chat_completion_sources.OPENROUTER) {
        model_list = sortModelsBy(model_list, oai_settings.sort_models, chat_completion_sources.OPENROUTER);
        $('#model_openrouter_select').empty();
        $('#model_openrouter_select').append($('<option>', { value: openrouter_website_model, text: t`Use OpenRouter website setting` }));

        if (oai_settings.group_models) {
            groupModelsByVendor(model_list, chat_completion_sources.OPENROUTER).forEach((models, vendor) => {
                const optgroup = $('<optgroup>').attr('label', vendor);
                models.forEach((model) => {
                    optgroup.append($('<option>', { value: model.id, text: model.name }));
                });
                $('#model_openrouter_select').append(optgroup);
            });
        } else {
            model_list.forEach((model) => {
                $('#model_openrouter_select').append($('<option>', { value: model.id, text: model.name }));
            });
        }

        $('#model_openrouter_select').val(oai_settings.openrouter_model).trigger('change');
    }

    if (oai_settings.chat_completion_source == chat_completion_sources.OPENAI) {
        $('#openai_external_category').empty();
        model_list.forEach((model) => {
            $('#openai_external_category').append(
                $('<option>', {
                    value: model.id,
                    text: model.id,
                }));
        });
        if (oai_settings.show_external_models) {
            const model = model_list.findIndex((model) => model.id == oai_settings.openai_model) !== -1 ? oai_settings.openai_model : default_settings.openai_model;
            $('#model_openai_select').val(model).trigger('change');
        }
    }

    if (oai_settings.chat_completion_source == chat_completion_sources.CUSTOM) {
        $('.model_custom_select').empty();
        $('.model_custom_select').append('<option value="">None</option>');
        model_list.forEach((model) => {
            $('.model_custom_select').append(
                $('<option>', {
                    value: model.id,
                    text: model.id,
                    selected: model.id == oai_settings.custom_model,
                }));
        });

        if (!oai_settings.custom_model && model_list.length > 0) {
            $('#model_custom_select').val(model_list[0].id).trigger('change');
        }
    }

    if (oai_settings.chat_completion_source == chat_completion_sources.AIMLAPI) {
        model_list = model_list.filter(m => m.type === 'chat-completion');
        model_list = sortModelsBy(model_list, oai_settings.sort_models, chat_completion_sources.AIMLAPI);
        $('#model_aimlapi_select').empty();

        if (oai_settings.group_models) {
            groupModelsByVendor(model_list, chat_completion_sources.AIMLAPI).forEach((models, vendor) => {
                const optgroup = $('<optgroup>').attr('label', vendor);
                models.forEach((model) => {
                    optgroup.append($('<option>', { value: model.id, text: model.info?.name || model.id }));
                });
                $('#model_aimlapi_select').append(optgroup);
            });
        } else {
            model_list.forEach((model) => {
                $('#model_aimlapi_select').append($('<option>', { value: model.id, text: model.info?.name || model.id }));
            });
        }

        if (!oai_settings.aimlapi_model && model_list.length > 0) {
            oai_settings.aimlapi_model = model_list[0].id;
        }

        $('#model_aimlapi_select').val(oai_settings.aimlapi_model).trigger('change');
    }

    if (oai_settings.chat_completion_source == chat_completion_sources.MISTRALAI) {
        $('#model_mistralai_select').empty();

        for (const model of model_list.filter(model => model?.capabilities?.completion_chat)) {
            $('#model_mistralai_select').append(new Option(model.id, model.id));
        }

        const selectedModel = model_list.find(model => model.id === oai_settings.mistralai_model);
        if (!selectedModel) {
            oai_settings.mistralai_model = model_list.find(model => model?.capabilities?.completion_chat)?.id;
        }

        $('#model_mistralai_select').val(oai_settings.mistralai_model).trigger('change');
    }

    if (oai_settings.chat_completion_source == chat_completion_sources.ELECTRONHUB) {
        model_list = model_list.filter(model => model?.endpoints?.includes('/v1/chat/completions'));
        model_list = sortModelsBy(model_list, oai_settings.sort_models, chat_completion_sources.ELECTRONHUB);
        $('#model_electronhub_select').empty();

        if (oai_settings.group_models) {
            groupModelsByVendor(model_list, chat_completion_sources.ELECTRONHUB).forEach((models, vendor) => {
                const optgroup = $('<optgroup>').attr('label', vendor);
                models.forEach((model) => {
                    optgroup.append($('<option>', { value: model.id, text: model.name }));
                });
                $('#model_electronhub_select').append(optgroup);
            });
        } else {
            model_list.forEach((model) => {
                $('#model_electronhub_select').append($('<option>', { value: model.id, text: model.name }));
            });
        }

        const selectedModel = model_list.find(model => model.id === oai_settings.electronhub_model);
        if (model_list.length > 0 && (!selectedModel || !oai_settings.electronhub_model)) {
            oai_settings.electronhub_model = model_list[0].id;
        }

        $('#model_electronhub_select').val(oai_settings.electronhub_model).trigger('change');
    }

    if (oai_settings.chat_completion_source == chat_completion_sources.CHUTES) {
        model_list = model_list.filter(model => typeof model.id === 'string' && !model.id.toLowerCase().includes('affine'));
        model_list = sortModelsBy(model_list, oai_settings.sort_models, chat_completion_sources.CHUTES);
        $('#model_chutes_select').empty();

        if (oai_settings.group_models) {
            groupModelsByVendor(model_list, chat_completion_sources.CHUTES).forEach((models, vendor) => {
                const optgroup = $('<optgroup>').attr('label', vendor);
                models.forEach((model) => {
                    optgroup.append($('<option>', { value: model.id, text: model.id }));
                });
                $('#model_chutes_select').append(optgroup);
            });
        } else {
            model_list.forEach((model) => {
                $('#model_chutes_select').append($('<option>', { value: model.id, text: model.id }));
            });
        }

        const selectedModel = model_list.find(model => model.id === oai_settings.chutes_model);
        if (model_list.length > 0 && (!selectedModel || !oai_settings.chutes_model)) {
            oai_settings.chutes_model = model_list[0].id;
        }

        $('#model_chutes_select').val(oai_settings.chutes_model).trigger('change');
    }

    if (oai_settings.chat_completion_source == chat_completion_sources.NANOGPT) {
        model_list = sortModelsBy(model_list, oai_settings.sort_models, chat_completion_sources.NANOGPT);
        $('#model_nanogpt_select').empty();

        if (oai_settings.group_models) {
            groupModelsByVendor(model_list, chat_completion_sources.NANOGPT).forEach((models, vendor) => {
                const optgroup = $('<optgroup>').attr('label', vendor);
                models.forEach((model) => {
                    optgroup.append($('<option>', { value: model.id, text: model.name || model.id }));
                });
                $('#model_nanogpt_select').append(optgroup);
            });
        } else {
            model_list.forEach((model) => {
                $('#model_nanogpt_select').append($('<option>', { value: model.id, text: model.name || model.id }));
            });
        }

        const selectedModel = model_list.find(model => model.id === oai_settings.nanogpt_model);
        if (model_list.length > 0 && (!selectedModel || !oai_settings.nanogpt_model)) {
            oai_settings.nanogpt_model = model_list[0].id;
        }

        $('#model_nanogpt_select').val(oai_settings.nanogpt_model).trigger('change');
    }

    if (oai_settings.chat_completion_source == chat_completion_sources.DEEPSEEK) {
        $('#model_deepseek_select').empty();
        model_list.forEach((model) => {
            $('#model_deepseek_select').append($('<option>', { value: model.id, text: model.id }));
        });

        const selectedModel = model_list.find(model => model.id === oai_settings.deepseek_model);
        if (model_list.length > 0 && (!selectedModel || !oai_settings.deepseek_model)) {
            oai_settings.deepseek_model = model_list[0].id;
        }

        $('#model_deepseek_select').val(oai_settings.deepseek_model).trigger('change');
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.POLLINATIONS) {
        $('#model_pollinations_select').empty();
        model_list.forEach((model) => {
            $('#model_pollinations_select').append($('<option>', { value: model.id, text: model.id }));
        });

        const selectedModel = model_list.find(model => model.id === oai_settings.pollinations_model);
        if (model_list.length > 0 && (!selectedModel || !oai_settings.pollinations_model)) {
            oai_settings.pollinations_model = model_list[0].id;
        }

        $('#model_pollinations_select').val(oai_settings.pollinations_model).trigger('change');
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.MAKERSUITE) {
        $('#google_other_models').empty();

        const staticModels = [];
        $('#model_google_select option').each(function () {
            staticModels.push($(this).val());
        });

        model_list.forEach((model) => {
            if (!staticModels.includes(model.id)) {
                $('#google_other_models').append(
                    $('<option>', {
                        value: model.id,
                        text: model.id,
                    }));
            }
        });

        staticModels.forEach(modelId => {
            if (!model_list.some(model => model.id === modelId)) {
                model_list.push({ id: modelId });
            }
        });

        const selectedModel = model_list.find(model => model.id === oai_settings.google_model);
        if (model_list.length > 0 && (!selectedModel || !oai_settings.google_model)) {
            oai_settings.google_model = model_list[0].id;
        }

        $('#model_google_select').val(oai_settings.google_model).trigger('change');
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.GROQ) {
        $('#model_groq_select').empty();
        model_list.forEach((model) => {
            $('#model_groq_select').append(
                $('<option>', {
                    value: model.id,
                    text: model.id,
                }));
        });

        const selectedModel = model_list.find(model => model.id === oai_settings.groq_model);
        if (model_list.length > 0 && (!selectedModel || !oai_settings.groq_model)) {
            oai_settings.groq_model = model_list[0].id;
        }

        $('#model_groq_select').val(oai_settings.groq_model).trigger('change');
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.SILICONFLOW) {
        $('#model_siliconflow_select').empty();
        model_list.forEach((model) => {
            $('#model_siliconflow_select').append(
                $('<option>', {
                    value: model.id,
                    text: model.id,
                }));
        });

        const selectedModel = model_list.find(model => model.id === oai_settings.siliconflow_model);
        if (model_list.length > 0 && (!selectedModel || !oai_settings.siliconflow_model)) {
            oai_settings.siliconflow_model = model_list[0].id;
        }

        $('#model_siliconflow_select').val(oai_settings.siliconflow_model).trigger('change');
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.FIREWORKS) {
        $('#model_fireworks_select').empty();
        model_list.sort((a, b) => (a?.name || a?.id || '').localeCompare(b?.name || b?.id || ''));
        model_list.forEach((model) => {
            $('#model_fireworks_select').append(
                $('<option>', {
                    value: model.id,
                    text: model.name || model.id,
                }));
        });

        const selectedModel = model_list.find(model => model.id === oai_settings.fireworks_model);
        if (model_list.length > 0 && (!selectedModel || !oai_settings.fireworks_model)) {
            oai_settings.fireworks_model = model_list[0].id;
        }

        $('#model_fireworks_select').val(oai_settings.fireworks_model).trigger('change');
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.WORKERS_AI) {
        $('#model_workers_ai_select').empty();
        model_list.forEach((model) => {
            $('#model_workers_ai_select').append(
                $('<option>', {
                    value: model.id,
                    text: model.id,
                }));
        });

        const selectedModel = model_list.find(model => model.id === oai_settings.workers_ai_model);
        if (model_list.length > 0 && (!selectedModel || !oai_settings.workers_ai_model)) {
            oai_settings.workers_ai_model = model_list[0].id;
        }

        $('#model_workers_ai_select').val(oai_settings.workers_ai_model).trigger('change');
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.COMETAPI) {
        $('#model_cometapi_select').empty();

        model_list.forEach((model) => {
            const modelId = model.id.toLowerCase();
            const isIgnoredModel = COMETAPI_IGNORE_PATTERNS.some(pattern => modelId.includes(pattern));

            if (isIgnoredModel) {
                return;
            }

            $('#model_cometapi_select').append(new Option(model.id, model.id));
        });

        const selectedModel = model_list.find(model => model.id === oai_settings.cometapi_model);
        if (model_list.length > 0 && (!selectedModel || !oai_settings.cometapi_model)) {
            const oldCometapiModel = oai_settings.cometapi_model;
            oai_settings.cometapi_model = model_list[0].id;
            if (oai_settings.cometapi_model !== oldCometapiModel) {
                saveSettingsDebounced('oai_settings');
            }
        }

        $('#model_cometapi_select').val(oai_settings.cometapi_model).trigger('change');
    }

    if (oai_settings.chat_completion_source == chat_completion_sources.AZURE_OPENAI) {
        const modelId = model_list?.[0]?.id || '';
        oai_settings.azure_openai_model = modelId;

        $('#azure_openai_model')
            .empty()
            .append(new Option(modelId || 'None', modelId || '', true, true))
            .trigger('change');
    }

    if (oai_settings.chat_completion_source == chat_completion_sources.XAI) {
        $('#model_xai_select').empty();
        model_list.forEach((model) => {
            $('#model_xai_select').append(
                $('<option>', {
                    value: model.id,
                    text: model.id,
                }));
        });

        const selectedModel = model_list.find(model => model.id === oai_settings.xai_model);
        if (model_list.length > 0 && (!selectedModel || !oai_settings.xai_model)) {
            oai_settings.xai_model = model_list[0].id;
        }

        $('#model_xai_select').val(oai_settings.xai_model).trigger('change');
    }

    if (oai_settings.chat_completion_source == chat_completion_sources.MOONSHOT) {
        $('#model_moonshot_select').empty();
        model_list.forEach((model) => {
            $('#model_moonshot_select').append(new Option(model.id, model.id));
        });

        const selectedModel = model_list.find(model => model.id === oai_settings.moonshot_model);
        if (model_list.length > 0 && (!selectedModel || !oai_settings.moonshot_model)) {
            oai_settings.moonshot_model = model_list[0].id;
        }

        $('#model_moonshot_select').val(oai_settings.moonshot_model).trigger('change');
    }
}

/**
 * @param {object[]} data
 * @param {string} property
 * @param {string} source
 * @returns {object[]}
 */
function sortModelsBy(data, property, source) {
    switch (source) {
        case chat_completion_sources.OPENROUTER:
            return data.sort((a, b) => {
                if (property === 'context_length') {
                    return (b.context_length || 0) - (a.context_length || 0);
                } else if (property === 'pricing.input' || property === 'pricing.prompt') {
                    return parseFloat(a.pricing?.prompt || 0) - parseFloat(b.pricing?.prompt || 0);
                } else if (property === 'pricing.output' || property === 'pricing.completion') {
                    return parseFloat(a.pricing?.completion || 0) - parseFloat(b.pricing?.completion || 0);
                } else {
                    return a?.name && b?.name ? a.name.localeCompare(b.name) : 0;
                }
            });
        case chat_completion_sources.CHUTES:
            return data.sort((a, b) => {
                if (property === 'context_length') {
                    return (b.context_length || 0) - (a.context_length || 0);
                } else if (property === 'pricing.input' || property === 'pricing.prompt') {
                    return parseFloat(a.pricing?.input || 0) - parseFloat(b.pricing?.input || 0);
                } else if (property === 'pricing.output' || property === 'pricing.completion') {
                    return parseFloat(a.pricing?.output || 0) - parseFloat(b.pricing?.output || 0);
                } else {
                    return a?.id && b?.id ? a.id.localeCompare(b.id) : 0;
                }
            });
        case chat_completion_sources.ELECTRONHUB:
            return data.sort((a, b) => {
                if (property === 'context_length') {
                    return (b.tokens || 0) - (a.tokens || 0);
                } else if (property === 'pricing.input' || property === 'pricing.prompt') {
                    return parseFloat(a.pricing?.input || 0) - parseFloat(b.pricing?.input || 0);
                } else if (property === 'pricing.output' || property === 'pricing.completion') {
                    return parseFloat(a.pricing?.output || 0) - parseFloat(b.pricing?.output || 0);
                } else {
                    return a?.name && b?.name ? a.name.localeCompare(b.name) : 0;
                }
            });
        case chat_completion_sources.NANOGPT:
            return data.sort((a, b) => {
                if (property === 'context_length') {
                    return (b.context_length || 0) - (a.context_length || 0);
                } else if (property === 'pricing.input' || property === 'pricing.prompt') {
                    return parseFloat(a.pricing?.prompt || 0) - parseFloat(b.pricing?.prompt || 0);
                } else if (property === 'pricing.output' || property === 'pricing.completion') {
                    return parseFloat(a.pricing?.completion || 0) - parseFloat(b.pricing?.completion || 0);
                } else {
                    return a?.name && b?.name ? a.name.localeCompare(b.name) : 0;
                }
            });
        case chat_completion_sources.AIMLAPI:
            return data.sort((a, b) => {
                if (property === 'context_length') {
                    return (b.info?.contextLength || 0) - (a.info?.contextLength || 0);
                } else {
                    return a?.info?.name && b?.info?.name ? a.info.name.localeCompare(b.info.name) : 0;
                }
            });
        default:
            return data;
    }
}

/**
 * @param {object[]} array
 * @param {string} source
 * @returns {Map<string, object[]>}
 */
function groupModelsByVendor(array, source) {
    switch (source) {
        case chat_completion_sources.OPENROUTER:
            return array.reduce((acc, curr) => {
                const vendor = curr.id.split('/')[0];
                if (!acc.has(vendor)) {
                    acc.set(vendor, []);
                }
                acc.get(vendor).push(curr);
                return acc;
            }, new Map());
        case chat_completion_sources.ELECTRONHUB:
            return array.reduce((acc, curr) => {
                const vendor = String(curr?.name || curr?.id || 'Other').split(':')[0].trim() || 'Other';
                if (!acc.has(vendor)) {
                    acc.set(vendor, []);
                }
                acc.get(vendor).push(curr);
                return acc;
            }, new Map());
        case chat_completion_sources.NANOGPT:
            return array.reduce((acc, curr) => {
                const vendorPart = /\//.test(curr.id) ? curr.id.split('/')[0] : curr.id.split('-')[0];
                const vendor = String(vendorPart?.trim()?.toLowerCase() || 'Other');
                if (!acc.has(vendor)) {
                    acc.set(vendor, []);
                }
                acc.get(vendor).push(curr);
                return acc;
            }, new Map());
        case chat_completion_sources.CHUTES:
            return array.reduce((acc, curr) => {
                const vendor = curr.id.split('/')[0];
                if (!acc.has(vendor)) {
                    acc.set(vendor, []);
                }
                acc.get(vendor).push(curr);
                return acc;
            }, new Map());
        case chat_completion_sources.AIMLAPI:
            return array.reduce((acc, curr) => {
                const vendor = curr.info?.developer || 'Other';
                if (!acc.has(vendor)) {
                    acc.set(vendor, []);
                }
                acc.get(vendor).push(curr);
                return acc;
            }, new Map());
        default:
            return new Map([['', array]]);
    }
}

/**
 * @param {any} data
 * @param {ChatCompletionSettings} settings
 */
function loadOpenAISettings(data, settings) {
    openai_setting_names = data.openai_setting_names;
    openai_settings = data.openai_settings;
    openai_settings.forEach(function (item, i) {
        openai_settings[i] = JSON.parse(item);
    });

    $('#settings_preset_openai').empty();
    const settingNames = {};
    openai_setting_names.forEach(function (item, i) {
        settingNames[item] = i;
        const option = document.createElement('option');
        option.value = i;
        option.text = item;
        $('#settings_preset_openai').append(option);
    });
    openai_setting_names = settingNames;

    migrateChatCompletionSettings(settings);

    for (const key of Object.keys(default_settings)) {
        if (SERVER_OWNED.has(`oai_settings.${key}`)) {
            if (!newUiStarted()) oai_settings[key] = settings[key] ?? default_settings[key];
            continue;
        }
        oai_settings[key] = settings[key] ?? default_settings[key];
        const settingToUpdate = Object.values(settingsToUpdate).find(([_, k]) => k === key);
        if (settingToUpdate) {
            const [selector] = settingToUpdate;
            const $element = $(selector);

            if ($element.length === 0) {
                continue;
            }

            if ($element.is('input[type="checkbox"]')) {
                $element.prop('checked', oai_settings[key]);
            } else if ($element.is('select')) {
                $element.val(oai_settings[key]);
                $element.find(`option[value="${CSS.escape(oai_settings[key])}"]`).prop('selected', true);
            } else {
                $element.val(oai_settings[key]);
                if ($element.is('input[type="range"]')) {
                    const id = $element.attr('id');
                    const $counter = $(`input[type="number"][data-for="${id}"]`);
                    if ($counter.length > 0) {
                        $counter.val(Number(oai_settings[key]));
                    }
                }
            }
        }
    }

    $(`#settings_preset_openai option[value="${openai_setting_names[oai_settings.preset_settings_openai]}"]`).prop('selected', true);
    $('#bind_preset_to_connection').prop('checked', oai_settings.bind_preset_to_connection);
    $('#openai_external_category').toggle(oai_settings.show_external_models);
    $('.reverse_proxy_warning').toggle(oai_settings.reverse_proxy !== '');

    $('#vertexai_service_account_json').val('');
    updateVertexAIServiceAccountStatus();

    $('#openai_logit_bias_preset').empty();
    for (const preset of Object.keys(oai_settings.bias_presets)) {
        if (Array.isArray(oai_settings.bias_presets[preset])) {
            oai_settings.bias_presets[preset].forEach((bias) => {
                if (bias && !bias.id) {
                    bias.id = uuidv4();
                }
            });
        }
        const option = document.createElement('option');
        option.innerText = preset;
        option.value = preset;
        option.selected = preset === oai_settings.bias_preset_selected;
        $('#openai_logit_bias_preset').append(option);
    }
    $('#openai_logit_bias_preset').trigger('change');

    ToolManager.RECURSE_LIMIT = oai_settings.tool_call_recurse_limit;

    $('#openrouter_providers_chat').trigger('change');
    $('#openrouter_quantizations_chat').trigger('change');
    $('#nanogpt_provider').trigger('change');
    $('#chat_completion_source').trigger('change');
}

async function getStatusOpen() {
    const noValidateSources = [
        chat_completion_sources.CLAUDE,
        chat_completion_sources.AI21,
        chat_completion_sources.VERTEXAI,
        chat_completion_sources.PERPLEXITY,
        chat_completion_sources.ZAI,
        chat_completion_sources.MINIMAX,
    ];
    if (noValidateSources.includes(oai_settings.chat_completion_source)) {
        let status = t`Key saved; press \"Test Message\" to verify.`;
        setOnlineStatus(status);
        updateFeatureSupportFlags();
        return resultCheckStatus();
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.CUSTOM && !isValidUrl(oai_settings.custom_url)) {
        console.debug('Invalid endpoint URL of Custom OpenAI API:', oai_settings.custom_url);
        setOnlineStatus(t`Invalid endpoint URL. Requests may fail.`);
        return resultCheckStatus();
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.AZURE_OPENAI && !isValidUrl(oai_settings.azure_base_url)) {
        console.debug('Invalid endpoint URL of Azure OpenAI API:', oai_settings.azure_base_url);
        setOnlineStatus(t`Invalid Azure endpoint URL. Requests may fail.`);
        return resultCheckStatus();
    }

    let data = {
        reverse_proxy: oai_settings.reverse_proxy,
        proxy_password: oai_settings.proxy_password,
        chat_completion_source: oai_settings.chat_completion_source,
    };

    const validateProxySources = [
        chat_completion_sources.CLAUDE,
        chat_completion_sources.OPENAI,
        chat_completion_sources.MISTRALAI,
        chat_completion_sources.MAKERSUITE,
        chat_completion_sources.VERTEXAI,
        chat_completion_sources.DEEPSEEK,
        chat_completion_sources.XAI,
        chat_completion_sources.ZAI,
        chat_completion_sources.MOONSHOT,
    ];
    if (oai_settings.reverse_proxy && validateProxySources.includes(oai_settings.chat_completion_source)) {
        await validateReverseProxy();
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.CUSTOM) {
        $('.model_custom_select').empty();
        data.custom_url = oai_settings.custom_url;
        data.custom_include_headers = substituteParams(oai_settings.custom_include_headers);
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.AZURE_OPENAI) {
        data.azure_base_url = oai_settings.azure_base_url;
        data.azure_deployment_name = oai_settings.azure_deployment_name;
        data.azure_api_version = oai_settings.azure_api_version;
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.SILICONFLOW) {
        data.siliconflow_endpoint = oai_settings.siliconflow_endpoint;
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.MINIMAX) {
        data.minimax_endpoint = oai_settings.minimax_endpoint;
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.WORKERS_AI) {
        data.workers_ai_account_id = oai_settings.workers_ai_account_id;
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.POLLINATIONS) {
        data.pollinations_endpoint = oai_settings.pollinations_endpoint || POLLINATIONS_ENDPOINT.AUTHENTICATED;
    }

    const canBypass = (oai_settings.chat_completion_source === chat_completion_sources.OPENAI && oai_settings.bypass_status_check) || oai_settings.chat_completion_source === chat_completion_sources.CUSTOM;
    if (canBypass) {
        setOnlineStatus(t`Status check bypassed`);
    }

    try {
        const response = await fetch('/api/backends/chat-completions/status', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(data),
            signal: abortStatusCheck.signal,
            cache: 'no-cache',
        });

        if (!response.ok) {
            throw new Error(response.statusText);
        }

        const responseData = await response.json();

        if ('data' in responseData && Array.isArray(responseData.data)) {
            saveModelList(responseData.data);
        }
        if (!('error' in responseData)) {
            setOnlineStatus(t`Valid`);
        }
        if (responseData.bypass) {
            setOnlineStatus(t`Status check bypassed`);
        }
    } catch (error) {
        console.error(error);

        if (!canBypass) {
            setOnlineStatus('no_connection');
        }
    }

    updateFeatureSupportFlags();
    return resultCheckStatus();
}

/**
 * @param {ChatCompletionSettings} settings
 * @returns {Object}
 */
export function getChatCompletionPreset(settings = oai_settings) {
    const presetBody = {};
    for (const [presetKey, [, settingsKey]] of Object.entries(settingsToUpdate)) {
        presetBody[presetKey] = settings[settingsKey];
    }
    return structuredClone(presetBody);
}

/**
 * @param {string} name
 * @param {ChatCompletionSettings} settings
 * @param {boolean} triggerUi
 * @returns {Promise<void>}
 */
async function saveOpenAIPreset(name, settings, triggerUi = true) {
    const presetBody = getChatCompletionPreset(settings);
    const savePresetSettings = await fetch('/api/presets/save', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            apiId: 'openai',
            name: name,
            preset: presetBody,
        }),
    });

    if (savePresetSettings.ok) {
        const data = await savePresetSettings.json();

        if (Object.keys(openai_setting_names).includes(data.name)) {
            oai_settings.preset_settings_openai = data.name;
            const value = openai_setting_names[data.name];
            Object.assign(openai_settings[value], presetBody);
            $(`#settings_preset_openai option[value="${value}"]`).prop('selected', true);
            if (triggerUi) $('#settings_preset_openai').trigger('change');
        } else {
            openai_settings.push(presetBody);
            openai_setting_names[data.name] = openai_settings.length - 1;
            const option = document.createElement('option');
            option.selected = true;
            option.value = String(openai_settings.length - 1);
            option.innerText = data.name;
            if (triggerUi) $('#settings_preset_openai').append(option).trigger('change');
        }
    } else {
        toastr.error(t`Failed to save preset`);
        throw new Error('Failed to save preset');
    }
}

function onLogitBiasPresetChange() {
    const value = String($('#openai_logit_bias_preset').find(':selected').val());
    const preset = oai_settings.bias_presets[value];

    if (!Array.isArray(preset)) {
        console.error('Preset not found');
        return;
    }

    const presetChanged = oai_settings.bias_preset_selected !== value;
    oai_settings.bias_preset_selected = value;
    const list = $('.openai_logit_bias_list');
    list.empty();

    for (const entry of preset) {
        if (entry) {
            createLogitBiasListItem(entry);
        }
    }

    if (list.sortable('instance') !== undefined) {
        list.sortable('destroy');
    }

    list.sortable({
        delay: getSortableDelay(),
        handle: '.drag-handle',
        stop: function () {
            const order = [];
            list.children().each(function () {
                order.unshift($(this).data('id'));
            });
            preset.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
            console.log('Logit bias reordered:', preset);
            saveSettingsDebounced('oai_settings');
        },
    });

    if (presetChanged) {
        saveSettingsDebounced('oai_settings');
    }
}

function createNewLogitBiasEntry() {
    const entry = { id: uuidv4(), text: '', value: 0 };
    oai_settings.bias_presets[oai_settings.bias_preset_selected].push(entry);
    createLogitBiasListItem(entry);
    saveSettingsDebounced('oai_settings');
}

function createLogitBiasListItem(entry) {
    if (!entry.id) {
        entry.id = uuidv4();
    }
    const id = entry.id;
    const template = $('#openai_logit_bias_template .openai_logit_bias_form').clone();
    template.data('id', id);
    template.find('.openai_logit_bias_text').val(entry.text).on('input', function () {
        entry.text = String($(this).val());
        saveSettingsDebounced('oai_settings');
    });
    template.find('.openai_logit_bias_value').val(entry.value).on('input', function () {
        const min = Number($(this).attr('min'));
        const max = Number($(this).attr('max'));
        let value = Number($(this).val());

        if (value < min) {
            $(this).val(min);
            value = min;
        }

        if (value > max) {
            $(this).val(max);
            value = max;
        }

        entry.value = value;
        saveSettingsDebounced('oai_settings');
    });
    template.find('.openai_logit_bias_remove').on('click', function () {
        $(this).closest('.openai_logit_bias_form').remove();
        const preset = oai_settings.bias_presets[oai_settings.bias_preset_selected];
        const index = preset.findIndex(item => item.id === id);
        if (index >= 0) {
            preset.splice(index, 1);
        }
        onLogitBiasPresetChange();
    });
    $('.openai_logit_bias_list').prepend(template);
}

async function createNewLogitBiasPreset() {
    const name = await Popup.show.input(t`Preset name:`, null);

    if (!name) {
        return;
    }

    if (name in oai_settings.bias_presets) {
        toastr.error(t`Preset name should be unique.`);
        return;
    }

    oai_settings.bias_preset_selected = name;
    oai_settings.bias_presets[name] = [];

    addLogitBiasPresetOption(name);
    saveSettingsDebounced('oai_settings');
}

function addLogitBiasPresetOption(name) {
    const option = document.createElement('option');
    option.innerText = name;
    option.value = name;
    option.selected = true;

    $('#openai_logit_bias_preset').append(option);
    $('#openai_logit_bias_preset').trigger('change');
}

function onImportPresetClick() {
    $('#openai_preset_import_file').trigger('click');
}

function onLogitBiasPresetImportClick() {
    $('#openai_logit_bias_import_file').trigger('click');
}

async function onPresetImportFileChange(e) {
    const file = e.target.files[0];

    if (!file) {
        return;
    }

    const name = file.name.replace(/\.[^/.]+$/, '');
    const importedFile = await getFileText(file);
    let presetBody;
    e.target.value = '';

    try {
        presetBody = JSON.parse(importedFile);
    } catch (err) {
        toastr.error(t`Invalid file`);
        return;
    }

    const fields = sensitiveFields.filter(field => presetBody[field]).map(field => `<b>${field}</b>`);
    const shouldConfirm = fields.length > 0;

    if (shouldConfirm) {
        const textHeader = 'The imported preset contains proxy and/or custom endpoint settings.';
        const textMessage = fields.join('<br>');
        const cancelButton = { text: 'Cancel import', result: POPUP_RESULT.CANCELLED, appendAtEnd: true };
        const popupOptions = { customButtons: [cancelButton], okButton: 'Remove them', cancelButton: 'Import as-is' };
        const popupResult = await Popup.show.confirm(textHeader, textMessage, popupOptions);

        if (popupResult === POPUP_RESULT.CANCELLED) {
            return;
        }

        if (popupResult === POPUP_RESULT.AFFIRMATIVE) {
            sensitiveFields.forEach(field => delete presetBody[field]);
        }
    }

    if (name in openai_setting_names) {
        const confirm = await callGenericPopup('Preset name already exists. Overwrite?', POPUP_TYPE.CONFIRM);

        if (!confirm) {
            return;
        }
    }

    const savePresetSettings = await fetch('/api/presets/save', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            apiId: 'openai',
            name: name,
            preset: presetBody,
        }),
    });

    if (!savePresetSettings.ok) {
        toastr.error(t`Failed to save preset`);
        return;
    }

    const data = await savePresetSettings.json();

    if (Object.keys(openai_setting_names).includes(data.name)) {
        oai_settings.preset_settings_openai = data.name;
        const value = openai_setting_names[data.name];
        Object.assign(openai_settings[value], presetBody);
        $(`#settings_preset_openai option[value="${value}"]`).prop('selected', true);
        $('#settings_preset_openai').trigger('change');
    } else {
        openai_settings.push(presetBody);
        openai_setting_names[data.name] = openai_settings.length - 1;
        const option = document.createElement('option');
        option.selected = true;
        option.value = String(openai_settings.length - 1);
        option.innerText = data.name;
        $('#settings_preset_openai').append(option).trigger('change');
    }
}

async function onExportPresetClick() {
    if (!oai_settings.preset_settings_openai) {
        toastr.error(t`No preset selected`);
        return;
    }

    const preset = structuredClone(openai_settings[openai_setting_names[oai_settings.preset_settings_openai]]);

    const fieldValues = sensitiveFields.filter(field => preset[field]).map(field => `<b>${field}</b>: <code>${preset[field]}</code>`);
    if (fieldValues.length > 0) {
        const textHeader = t`Your preset contains proxy and/or custom endpoint settings.`;
        const textMessage = '<div>' + t`Do you want to remove these fields before exporting?` + `</div><br>${DOMPurify.sanitize(fieldValues.join('<br>'))}`;
        const cancelButton = { text: 'Cancel', result: POPUP_RESULT.CANCELLED, appendAtEnd: true };
        const popupOptions = { customButtons: [cancelButton] };
        const popupResult = await Popup.show.confirm(textHeader, textMessage, popupOptions);

        if (popupResult === POPUP_RESULT.CANCELLED) {
            return;
        }

        if (popupResult === POPUP_RESULT.AFFIRMATIVE) {
            sensitiveFields.forEach(field => delete preset[field]);
        }
    }

    const exportConnectionTemplate = $(await renderTemplateAsync('exportPreset'));
    await new Popup(exportConnectionTemplate, POPUP_TYPE.TEXT).show();

    const removeConnectionData = exportConnectionTemplate.find('input[name="export_connection_data"]:checked').val() === 'false';
    if (removeConnectionData) {
        for (const [, [, settingName, , isConnection]] of Object.entries(settingsToUpdate)) {
            if (isConnection) {
                delete preset[settingName];
            }
        }
    }

    const presetJsonString = JSON.stringify(preset, null, 4);
    const presetFileName = `${oai_settings.preset_settings_openai}.json`;
    download(presetJsonString, presetFileName, 'application/json');
}

async function onLogitBiasPresetImportFileChange(e) {
    const file = e.target.files[0];

    if (!file || file.type !== 'application/json') {
        return;
    }

    const name = file.name.replace(/\.[^/.]+$/, '');
    const importedFile = await parseJsonFile(file);
    e.target.value = '';

    if (name in oai_settings.bias_presets) {
        toastr.error(t`Preset name should be unique.`);
        return;
    }

    if (!Array.isArray(importedFile)) {
        toastr.error(t`Invalid logit bias preset file.`);
        return;
    }

    const validEntries = [];

    for (const entry of importedFile) {
        if (typeof entry == 'object' && entry !== null) {
            if (Object.hasOwn(entry, 'text') &&
                Object.hasOwn(entry, 'value')) {
                if (!entry.id) {
                    entry.id = uuidv4();
                }
                validEntries.push(entry);
            }
        }
    }

    oai_settings.bias_presets[name] = validEntries;
    oai_settings.bias_preset_selected = name;

    addLogitBiasPresetOption(name);
    saveSettingsDebounced('oai_settings');
}

function onLogitBiasPresetExportClick() {
    if (!oai_settings.bias_preset_selected || Object.keys(oai_settings.bias_presets).length === 0) {
        return;
    }

    const presetJsonString = JSON.stringify(oai_settings.bias_presets[oai_settings.bias_preset_selected], null, 4);
    const presetFileName = `${oai_settings.bias_preset_selected}.json`;
    download(presetJsonString, presetFileName, 'application/json');
}

async function onDeletePresetClick() {
    const confirm = await callGenericPopup(t`Delete the preset? This action is irreversible and your current settings will be overwritten.`, POPUP_TYPE.CONFIRM);

    if (!confirm) {
        return;
    }

    const nameToDelete = oai_settings.preset_settings_openai;
    const value = openai_setting_names[oai_settings.preset_settings_openai];
    $(`#settings_preset_openai option[value="${value}"]`).remove();
    delete openai_setting_names[oai_settings.preset_settings_openai];
    oai_settings.preset_settings_openai = null;

    if (Object.keys(openai_setting_names).length) {
        oai_settings.preset_settings_openai = Object.keys(openai_setting_names)[0];
        const newValue = openai_setting_names[oai_settings.preset_settings_openai];
        $(`#settings_preset_openai option[value="${newValue}"]`).prop('selected', true);
        $('#settings_preset_openai').trigger('change');
    }

    const response = await fetch('/api/presets/delete', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ apiId: 'openai', name: nameToDelete }),
    });

    if (!response.ok) {
        toastr.warning(t`Preset was not deleted from server`);
    } else {
        toastr.success(t`Preset deleted`);
    }

    saveSettingsDebounced('oai_settings');
}

async function onLogitBiasPresetDeleteClick() {
    const value = await callGenericPopup(t`Delete the preset?`, POPUP_TYPE.CONFIRM);

    if (!value) {
        return;
    }

    $(`#openai_logit_bias_preset option[value="${oai_settings.bias_preset_selected}"]`).remove();
    delete oai_settings.bias_presets[oai_settings.bias_preset_selected];
    oai_settings.bias_preset_selected = null;

    if (Object.keys(oai_settings.bias_presets).length) {
        oai_settings.bias_preset_selected = Object.keys(oai_settings.bias_presets)[0];
        $(`#openai_logit_bias_preset option[value="${oai_settings.bias_preset_selected}"]`).prop('selected', true);
        $('#openai_logit_bias_preset').trigger('change');
    }

    saveSettingsDebounced('oai_settings');
}

/** @type {Promise<void>} */
let presetApplicationPromise = Promise.resolve();

/**
 * @returns {Promise<void>}
 */
export function getPresetApplicationPromise() {
    return presetApplicationPromise;
}

function onSettingsPresetChange() {
    const presetNameBefore = oai_settings.preset_settings_openai;

    const presetName = $('#settings_preset_openai').find(':selected').text();
    oai_settings.preset_settings_openai = presetName;

    const preset = structuredClone(openai_settings[openai_setting_names[oai_settings.preset_settings_openai]]);

    migrateChatCompletionSettings(preset);

    const updateInput = (selector, value) => $(selector).val(value).trigger('input', { source: 'preset' });
    const updateCheckbox = (selector, value) => $(selector).prop('checked', value).trigger('input', { source: 'preset' });

    presetApplicationPromise = eventSource.emit(event_types.OAI_PRESET_CHANGED_BEFORE, {
        preset: preset,
        presetName: presetName,
        settingsToUpdate: settingsToUpdate,
        settings: oai_settings,
        savePreset: saveOpenAIPreset,
        presetNameBefore: presetNameBefore,
    }).finally(async () => {
        if (oai_settings.bind_preset_to_connection) {
            $('.model_custom_select').empty();
        }

        for (const [key, [selector, setting, isCheckbox, isConnection]] of Object.entries(settingsToUpdate)) {
            if (isConnection && !oai_settings.bind_preset_to_connection) {
                continue;
            }

            if (key === 'extensions') {
                oai_settings.extensions = preset.extensions || {};
                continue;
            }

            if (SERVER_OWNED.has(`oai_settings.${setting}`)) continue;

            if (preset[key] !== undefined) {
                if (isCheckbox) {
                    updateCheckbox(selector, preset[key]);
                } else {
                    updateInput(selector, preset[key]);
                }
                oai_settings[setting] = preset[key];
            }
        }

        if (oai_settings.bind_preset_to_connection) {
            $('#chat_completion_source').trigger('change');
            $('#openrouter_providers_chat').trigger('change');
            $('#openrouter_quantizations_chat').trigger('change');
            $('#nanogpt_provider').trigger('change');
        }

        $('#openai_logit_bias_preset').trigger('change');

        await saveSettings('oai_settings');
        if (newUiStarted()) await newUi().settings.reread();
        await eventSource.emit(event_types.OAI_PRESET_CHANGED_AFTER);
    });
}

async function onModelChange() {
    let value = String($(this).val() || '');

    const oldSettingsJson = JSON.stringify(oai_settings);

    const hasModelsLoaded = Array.isArray(model_list) && model_list.length > 0;

    if ($(this).is('#model_claude_select')) {
        if (value.includes('-v')) {
            value = value.replace('-v', '-');
        } else if (value === '' || value === 'claude-2') {
            value = default_settings.claude_model;
        }
        console.log('Claude model changed to', value);
        oai_settings.claude_model = value;
        $('#model_claude_select').val(oai_settings.claude_model);
    }

    if ($(this).is('#model_openai_select')) {
        console.log('OpenAI model changed to', value);
        oai_settings.openai_model = value;
    }

    if ($(this).is('#model_openrouter_select')) {
        if (!value || !hasModelsLoaded) {
            console.debug('Null OR model selected. Ignoring.');
            return;
        }

        console.log('OpenRouter model changed to', value);
        oai_settings.openrouter_model = value;
        syncOpenRouterProvidersForModel(value, '#openrouter_providers_chat');
    }

    if ($(this).is('#model_ai21_select')) {
        if (value === '' || value.startsWith('j2-')) {
            value = 'jamba-large';
            $('#model_ai21_select').val(value);
        }

        console.log('AI21 model changed to', value);
        oai_settings.ai21_model = value;
    }

    if ($(this).is('#model_google_select')) {
        if (!value) {
            console.debug('Null Google model selected. Ignoring.');
            return;
        }

        console.log('Google model changed to', value);
        oai_settings.google_model = value;
    }

    if ($(this).is('#model_vertexai_select')) {
        console.log('Vertex AI model changed to', value);
        oai_settings.vertexai_model = value;
    }

    if ($(this).is('#model_mistralai_select')) {
        if (!value || !hasModelsLoaded) {
            console.debug('Null MistralAI model selected. Ignoring.');
            return;
        }
        console.log('MistralAI model changed to', value);
        oai_settings.mistralai_model = value;
        $('#model_mistralai_select').val(oai_settings.mistralai_model);
    }

    if ($(this).is('#model_cohere_select')) {
        console.log('Cohere model changed to', value);
        oai_settings.cohere_model = value;
    }

    if ($(this).is('#model_perplexity_select')) {
        console.log('Perplexity model changed to', value);
        oai_settings.perplexity_model = value;
    }

    if ($(this).is('#model_groq_select')) {
        if (!value || !hasModelsLoaded) {
            console.debug('Null Groq model selected. Ignoring.');
            return;
        }
        console.log('Groq model changed to', value);
        oai_settings.groq_model = value;
    }

    if ($(this).is('#model_siliconflow_select')) {
        if (!value) {
            console.debug('Null SiliconFlow model selected. Ignoring.');
            return;
        }
        console.log('SiliconFlow model changed to', value);
        oai_settings.siliconflow_model = value;
    }

    if ($(this).is('#model_minimax_select')) {
        if (!value) {
            console.debug('Null MiniMax model selected. Ignoring.');
            return;
        }
        console.log('MiniMax model changed to', value);
        oai_settings.minimax_model = value;
    }

    if ($(this).is('#model_electronhub_select')) {
        if (!value || !hasModelsLoaded) {
            console.debug('Null ElectronHub model selected. Ignoring.');
            return;
        }
        console.log('ElectronHub model changed to', value);
        oai_settings.electronhub_model = value;
    }

    if ($(this).is('#model_chutes_select')) {
        if (!value || !hasModelsLoaded) {
            console.debug('Null Chutes model selected. Ignoring.');
            return;
        }
        console.log('Chutes model changed to', value);
        oai_settings.chutes_model = value;
    }

    if ($(this).is('#model_nanogpt_select')) {
        if (!value || !hasModelsLoaded) {
            console.debug('Null NanoGPT model selected. Ignoring.');
            return;
        }

        console.log('NanoGPT model changed to', value);
        oai_settings.nanogpt_model = value;
        syncNanoGptProvidersForModel(value, '#nanogpt_provider');
    }

    if ($(this).is('#model_deepseek_select')) {
        if (!value) {
            console.debug('Null DeepSeek model selected. Ignoring.');
            return;
        }

        console.log('DeepSeek model changed to', value);
        oai_settings.deepseek_model = value;
    }

    if (value && $(this).is('#model_custom_select')) {
        console.log('Custom model changed to', value);
        oai_settings.custom_model = value;
        $('#custom_model_id').val(value).trigger('input');
    }

    if (value && $(this).is('#model_pollinations_select')) {
        console.log('Pollinations model changed to', value);
        oai_settings.pollinations_model = value;
    }

    if ($(this).is('#model_aimlapi_select')) {
        if (!value || !hasModelsLoaded) {
            console.debug('Null AI/ML model selected. Ignoring.');
            return;
        }
        console.log('AI/ML model changed to', value);
        oai_settings.aimlapi_model = value;
    }

    if ($(this).is('#model_xai_select')) {
        if (!value) {
            console.debug('Null XAI model selected. Ignoring.');
            return;
        }
        console.log('XAI model changed to', value);
        oai_settings.xai_model = value;
    }

    if ($(this).is('#model_moonshot_select')) {
        if (!value || !hasModelsLoaded) {
            console.debug('Null Moonshot model selected. Ignoring.');
            return;
        }
        console.log('Moonshot model changed to', value);
        oai_settings.moonshot_model = value;
    }

    if ($(this).is('#model_fireworks_select')) {
        if (!value || !hasModelsLoaded) {
            console.debug('Null Fireworks model selected. Ignoring.');
            return;
        }
        console.log('Fireworks model changed to', value);
        oai_settings.fireworks_model = value;
    }

    if ($(this).is('#model_cometapi_select')) {
        if (!value) {
            console.debug('Null CometAPI model selected. Ignoring.');
            return;
        }
        console.log('CometAPI model changed to', value);
        oai_settings.cometapi_model = value;
    }

    if ($(this).is('#azure_openai_model')) {
        if (!value) {
            console.debug('Null Azure OpenAI model selected. Ignoring.');
            return;
        }
        oai_settings.azure_openai_model = value;
    }

    if ($(this).is('#model_zai_select')) {
        console.log('ZAI model changed to', value);
        oai_settings.zai_model = value;
    }

    if ($(this).is('#model_workers_ai_select')) {
        if (!value || !hasModelsLoaded) {
            console.debug('Null Workers AI model selected. Ignoring.');
            return;
        }
        console.log('Workers AI model changed to', value);
        oai_settings.workers_ai_model = value;
    }

    const source = oai_settings.chat_completion_source;
    if (source === chat_completion_sources.OPENROUTER) calculateOpenRouterCost();
    if (source === chat_completion_sources.CHUTES) calculateChutesCost();
    if (source === chat_completion_sources.ELECTRONHUB) calculateElectronHubCost();
    if (source === chat_completion_sources.CLAUDE) $('#openai_reverse_proxy').attr('placeholder', 'https://api.anthropic.com/v1');
    if (source === chat_completion_sources.OPENAI || source === chat_completion_sources.AZURE_OPENAI) {
        $('#openai_reverse_proxy').attr('placeholder', 'https://api.openai.com/v1');
    }

    if (JSON.stringify(oai_settings) !== oldSettingsJson) {
        saveSettingsDebounced('oai_settings');
    }
    updateFeatureSupportFlags();
    eventSource.emit(event_types.CHATCOMPLETION_MODEL_CHANGED, value);
}

async function onNewPresetClick() {
    const name = await Popup.show.input(t`Preset name:`, t`Hint: Use a character/group name to bind preset to a specific chat.`, oai_settings.preset_settings_openai);

    if (!name) {
        return;
    }

    await saveOpenAIPreset(name, oai_settings);
}

function onReverseProxyInput() {
    oai_settings.reverse_proxy = String($(this).val());
    $('.reverse_proxy_warning').toggle(oai_settings.reverse_proxy != '');
    saveSettingsDebounced('oai_settings');
}

async function onConnectButtonClick(e) {
    e.stopPropagation();

    /** @type {Object.<string, {key: string, selector: string, proxy?: boolean, keyless?: boolean}>} */
    const apiSourceConfig = {
        [chat_completion_sources.OPENROUTER]: { key: SECRET_KEYS.OPENROUTER, selector: '#api_key_openrouter', proxy: false },
        [chat_completion_sources.MAKERSUITE]: { key: SECRET_KEYS.MAKERSUITE, selector: '#api_key_makersuite', proxy: true },
        [chat_completion_sources.CLAUDE]: { key: SECRET_KEYS.CLAUDE, selector: '#api_key_claude', proxy: true },
        [chat_completion_sources.OPENAI]: { key: SECRET_KEYS.OPENAI, selector: '#api_key_openai', proxy: true },
        [chat_completion_sources.AI21]: { key: SECRET_KEYS.AI21, selector: '#api_key_ai21', proxy: false },
        [chat_completion_sources.MISTRALAI]: { key: SECRET_KEYS.MISTRALAI, selector: '#api_key_mistralai', proxy: true },
        [chat_completion_sources.CUSTOM]: { key: SECRET_KEYS.CUSTOM, selector: '#api_key_custom', proxy: false, keyless: true },
        [chat_completion_sources.COHERE]: { key: SECRET_KEYS.COHERE, selector: '#api_key_cohere', proxy: false },
        [chat_completion_sources.PERPLEXITY]: { key: SECRET_KEYS.PERPLEXITY, selector: '#api_key_perplexity', proxy: false },
        [chat_completion_sources.GROQ]: { key: SECRET_KEYS.GROQ, selector: '#api_key_groq', proxy: false },
        [chat_completion_sources.SILICONFLOW]: { key: SECRET_KEYS.SILICONFLOW, selector: '#api_key_siliconflow', proxy: false },
        [chat_completion_sources.ELECTRONHUB]: { key: SECRET_KEYS.ELECTRONHUB, selector: '#api_key_electronhub', proxy: false },
        [chat_completion_sources.NANOGPT]: { key: SECRET_KEYS.NANOGPT, selector: '#api_key_nanogpt', proxy: false },
        [chat_completion_sources.DEEPSEEK]: { key: SECRET_KEYS.DEEPSEEK, selector: '#api_key_deepseek', proxy: true },
        [chat_completion_sources.XAI]: { key: SECRET_KEYS.XAI, selector: '#api_key_xai', proxy: true },
        [chat_completion_sources.AIMLAPI]: { key: SECRET_KEYS.AIMLAPI, selector: '#api_key_aimlapi', proxy: false },
        [chat_completion_sources.MOONSHOT]: { key: SECRET_KEYS.MOONSHOT, selector: '#api_key_moonshot', proxy: true },
        [chat_completion_sources.FIREWORKS]: { key: SECRET_KEYS.FIREWORKS, selector: '#api_key_fireworks', proxy: false },
        [chat_completion_sources.COMETAPI]: { key: SECRET_KEYS.COMETAPI, selector: '#api_key_cometapi', proxy: false },
        [chat_completion_sources.AZURE_OPENAI]: { key: SECRET_KEYS.AZURE_OPENAI, selector: '#api_key_azure_openai', proxy: false },
        [chat_completion_sources.ZAI]: { key: SECRET_KEYS.ZAI, selector: '#api_key_zai', proxy: true },
        [chat_completion_sources.CHUTES]: { key: SECRET_KEYS.CHUTES, selector: '#api_key_chutes', proxy: false },
        [chat_completion_sources.POLLINATIONS]: { key: SECRET_KEYS.POLLINATIONS, selector: '#api_key_pollinations', proxy: false, keyless: oai_settings.pollinations_endpoint === POLLINATIONS_ENDPOINT.ANONYMOUS },
        [chat_completion_sources.WORKERS_AI]: { key: SECRET_KEYS.WORKERS_AI, selector: '#api_key_workers_ai', proxy: false },
        [chat_completion_sources.MINIMAX]: { key: SECRET_KEYS.MINIMAX, selector: '#api_key_minimax', proxy: false },
    };

    if (oai_settings.vertexai_auth_mode === 'express') {
        apiSourceConfig[chat_completion_sources.VERTEXAI] = { key: SECRET_KEYS.VERTEXAI, selector: '#api_key_vertexai', proxy: true };
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.VERTEXAI && oai_settings.vertexai_auth_mode === 'full') {
        if (!secret_state[SECRET_KEYS.VERTEXAI_SERVICE_ACCOUNT]) {
            toastr.error(t`Service Account JSON is required for Vertex AI full version. Please validate and save your Service Account JSON.`);
            return;
        }
    }

    const config = apiSourceConfig[oai_settings.chat_completion_source];
    if (config) {
        const apiKey = String($(config.selector).val()).trim();
        if (apiKey.length) {
            await writeSecret(config.key, apiKey);
        }

        if (!secret_state[config.key] && (!config.proxy || !oai_settings.reverse_proxy) && !config.keyless) {
            console.log(`No secret key saved for ${oai_settings.chat_completion_source}`);
            return;
        }
    }

    startStatusLoading();
    await getStatusOpen();
}

function toggleChatCompletionForms() {
    if (oai_settings.chat_completion_source == chat_completion_sources.CLAUDE) {
        $('#model_claude_select').trigger('change');
    } else if (oai_settings.chat_completion_source == chat_completion_sources.OPENAI) {
        if (oai_settings.show_external_models && (!Array.isArray(model_list) || model_list.length == 0)) {
            // Wait until the models list is loaded so that we could show a proper saved model
        } else {
            $('#model_openai_select').trigger('change');
        }
    } else if (oai_settings.chat_completion_source == chat_completion_sources.MAKERSUITE) {
        $('#model_google_select').trigger('change');
    } else if (oai_settings.chat_completion_source == chat_completion_sources.VERTEXAI) {
        $('#model_vertexai_select').trigger('change');
        onVertexAIAuthModeChange.call($('#vertexai_auth_mode')[0]);
    } else if (oai_settings.chat_completion_source == chat_completion_sources.OPENROUTER) {
        $('#model_openrouter_select').trigger('change');
    } else if (oai_settings.chat_completion_source == chat_completion_sources.AI21) {
        $('#model_ai21_select').trigger('change');
    } else if (oai_settings.chat_completion_source == chat_completion_sources.MISTRALAI) {
        $('#model_mistralai_select').trigger('change');
    } else if (oai_settings.chat_completion_source == chat_completion_sources.COHERE) {
        $('#model_cohere_select').trigger('change');
    } else if (oai_settings.chat_completion_source == chat_completion_sources.PERPLEXITY) {
        $('#model_perplexity_select').trigger('change');
    } else if (oai_settings.chat_completion_source == chat_completion_sources.GROQ) {
        $('#model_groq_select').trigger('change');
    } else if (oai_settings.chat_completion_source == chat_completion_sources.CHUTES) {
        $('#model_chutes_select').trigger('change');
    } else if (oai_settings.chat_completion_source == chat_completion_sources.SILICONFLOW) {
        $('#model_siliconflow_select').trigger('change');
    } else if (oai_settings.chat_completion_source == chat_completion_sources.MINIMAX) {
        $('#model_minimax_select').trigger('change');
    } else if (oai_settings.chat_completion_source == chat_completion_sources.ELECTRONHUB) {
        $('#model_electronhub_select').trigger('change');
    } else if (oai_settings.chat_completion_source == chat_completion_sources.NANOGPT) {
        $('#model_nanogpt_select').trigger('change');
    } else if (oai_settings.chat_completion_source == chat_completion_sources.CUSTOM) {
        $('#model_custom_select').trigger('change');
    } else if (oai_settings.chat_completion_source == chat_completion_sources.DEEPSEEK) {
        $('#model_deepseek_select').trigger('change');
    } else if (oai_settings.chat_completion_source == chat_completion_sources.AIMLAPI) {
        $('#model_aimlapi_select').trigger('change');
    } else if (oai_settings.chat_completion_source == chat_completion_sources.XAI) {
        $('#model_xai_select').trigger('change');
    } else if (oai_settings.chat_completion_source == chat_completion_sources.POLLINATIONS) {
        $('#pollinations_key_section').toggle(oai_settings.pollinations_endpoint === POLLINATIONS_ENDPOINT.AUTHENTICATED);
        $('#model_pollinations_select').trigger('change');
    } else if (oai_settings.chat_completion_source == chat_completion_sources.MOONSHOT) {
        $('#model_moonshot_select').trigger('change');
    } else if (oai_settings.chat_completion_source == chat_completion_sources.FIREWORKS) {
        $('#model_fireworks_select').trigger('change');
    } else if (oai_settings.chat_completion_source == chat_completion_sources.COMETAPI) {
        $('#model_cometapi_select').trigger('change');
    } else if (oai_settings.chat_completion_source == chat_completion_sources.AZURE_OPENAI) {
        $('#azure_openai_model').trigger('change');
    } else if (oai_settings.chat_completion_source == chat_completion_sources.ZAI) {
        $('#model_zai_select').trigger('change');
    } else if (oai_settings.chat_completion_source == chat_completion_sources.WORKERS_AI) {
        $('#model_workers_ai_select').trigger('change');
    }

    $('[data-source]').each(function () {
        const mode = $(this).data('source-mode');
        const validSources = $(this).data('source').split(',');
        const matchesSource = validSources.includes(oai_settings.chat_completion_source);
        $(this).toggle(mode !== 'except' ? matchesSource : !matchesSource);
    });
}

async function testApiConnection() {
    if (is_send_press) {
        toastr.info(t`Please wait for the previous request to complete.`);
        return;
    }

    try {
        const reply = await generateRaw({ prompt: 'Hi' });
        console.log(reply);
        toastr.success(t`API connection successful!`);
    } catch (err) {
        toastr.error(t`Could not get a reply from API. Check your connection settings / API key and try again.`);
    }
}

function reconnectOpenAi() {
    if (main_api == 'openai') {
        setOnlineStatus('no_connection');
        resultCheckStatus();
        $('#api_button_openai').trigger('click');
    }
}

function onProxyAccessKeyShowClick() {
    $('#openai_proxy_access_key').toggleClass('masked-secret');
    $(this).toggleClass('fa-eye-slash fa-eye');
}

async function onCustomizeParametersClick() {
    const template = $(await renderTemplateAsync('customEndpointAdditionalParameters'));

    template.find('#custom_include_body').val(oai_settings.custom_include_body).on('input', function () {
        oai_settings.custom_include_body = String($(this).val());
        saveSettingsDebounced('oai_settings');
    });

    template.find('#custom_exclude_body').val(oai_settings.custom_exclude_body).on('input', function () {
        oai_settings.custom_exclude_body = String($(this).val());
        saveSettingsDebounced('oai_settings');
    });

    template.find('#custom_include_headers').val(oai_settings.custom_include_headers).on('input', function () {
        oai_settings.custom_include_headers = String($(this).val());
        saveSettingsDebounced('oai_settings');
    });

    await callGenericPopup(template, POPUP_TYPE.TEXT, '', { wide: true, large: true });
}

/**
 * @returns {boolean}
 */
function isImageInliningSupported() {
    if (main_api !== 'openai') {
        return false;
    }

    if (!oai_settings.media_inlining) {
        return false;
    }

    const visionSupportedModels = [
        'chatgpt-4o-latest',
        'gpt-4-turbo',
        'gpt-4-vision',
        'gpt-4.1',
        'gpt-4.5-preview',
        'gpt-4o',
        'gpt-6-astra',
        'gpt-6-sol',
        'gpt-6-luna',
        'gpt-5',
        'o1',
        'o3',
        'o4-mini',
        'claude-3',
        'claude-fable',
        'claude-opus-4',
        'claude-opus-5',
        'claude-sonnet-4',
        'claude-sonnet-5',
        'claude-haiku-4',
        'c4ai-aya-vision',
        'command-a-vision',
        'gemini-2.0',
        'gemini-2.5',
        'gemini-3',
        'gemini-exp-1206',
        'learnlm',
        'gemini-robotics',
        'gemma-3-27b',
        'gemma-3-12b',
        'gemma-3-4b',
        'gemma-4',
        'mistral-small-2503',
        'mistral-small-2506',
        'mistral-small-latest',
        'mistral-medium-latest',
        'mistral-medium-2505',
        'mistral-medium-2508',
        'pixtral',
        'grok-4',
        'grok-2-vision',
        'moonshot-v1-8k-vision-preview',
        'moonshot-v1-32k-vision-preview',
        'moonshot-v1-128k-vision-preview',
        'kimi-k2.5',
        'kimi-latest',
        'deepseek-v4-flash-vision-exp',
        'glm-4.5v',
        'glm-4.6v',
        'glm-5v-turbo',
        'autoglm-phone',
        'Qwen/Qwen3-VL-32B-Instruct',
        'Qwen/Qwen3-VL-8B-Instruct',
        'Qwen/Qwen3-VL-235B-A22B-Instruct',
        'Qwen/Qwen3-VL-30B-A3B-Instruct',
        'zai-org/GLM-4.5V',
    ];

    switch (oai_settings.chat_completion_source) {
        case chat_completion_sources.OPENAI:
        case chat_completion_sources.AZURE_OPENAI: {
            const modelToCheck = oai_settings.chat_completion_source === chat_completion_sources.AZURE_OPENAI
                ? oai_settings.azure_openai_model
                : oai_settings.openai_model;
            return visionSupportedModels.some(model =>
                modelToCheck.includes(model)
                && ['gpt-4-turbo-preview', 'o1-mini', 'o3-mini'].some(x => !modelToCheck.includes(x)),
            );
        }
        case chat_completion_sources.MAKERSUITE:
            return visionSupportedModels.some(model => oai_settings.google_model.includes(model));
        case chat_completion_sources.VERTEXAI:
            return visionSupportedModels.some(model => oai_settings.vertexai_model.includes(model));
        case chat_completion_sources.CLAUDE:
            return visionSupportedModels.some(model => oai_settings.claude_model.includes(model));
        case chat_completion_sources.OPENROUTER:
            return (Array.isArray(model_list) && model_list.find(m => m.id === oai_settings.openrouter_model)?.architecture?.input_modalities?.includes('image'));
        case chat_completion_sources.CUSTOM:
            return true;
        case chat_completion_sources.MISTRALAI:
            return (Array.isArray(model_list) && model_list.find(m => m.id === oai_settings.mistralai_model)?.capabilities?.vision);
        case chat_completion_sources.COHERE:
            return visionSupportedModels.some(model => oai_settings.cohere_model.includes(model));
        case chat_completion_sources.XAI:
            return visionSupportedModels.some(model => oai_settings.xai_model.includes(model));
        case chat_completion_sources.AIMLAPI:
            return (Array.isArray(model_list) && model_list.find(m => m.id === oai_settings.aimlapi_model)?.features?.includes('openai/chat-completion.vision'));
        case chat_completion_sources.CHUTES:
            return (Array.isArray(model_list) && model_list.find(m => m.id === oai_settings.chutes_model)?.input_modalities?.includes('image'));
        case chat_completion_sources.ELECTRONHUB:
            return (Array.isArray(model_list) && model_list.find(m => m.id === oai_settings.electronhub_model)?.metadata?.vision);
        case chat_completion_sources.POLLINATIONS:
            return (Array.isArray(model_list) && model_list.find(m => m.id === oai_settings.pollinations_model)?.input_modalities?.includes('image'));
        case chat_completion_sources.COMETAPI:
            return true;
        case chat_completion_sources.MOONSHOT:
            return (Array.isArray(model_list) && model_list.find(m => m.id === oai_settings.moonshot_model)?.supports_image_in);
        case chat_completion_sources.NANOGPT:
            return (Array.isArray(model_list) && model_list.find(m => m.id === oai_settings.nanogpt_model)?.capabilities?.vision);
        case chat_completion_sources.ZAI:
            return visionSupportedModels.some(model => oai_settings.zai_model.includes(model));
        case chat_completion_sources.SILICONFLOW:
            return visionSupportedModels.some(model => oai_settings.siliconflow_model.includes(model));
        case chat_completion_sources.DEEPSEEK:
            return visionSupportedModels.some(model => oai_settings.deepseek_model.includes(model));
        case chat_completion_sources.WORKERS_AI: {
            const waiModel = Array.isArray(model_list) && model_list.find(m => m.id === oai_settings.workers_ai_model);
            return Boolean(waiModel && Array.isArray(waiModel.properties) && waiModel.properties.some(p => p.property_id === 'vision' && p.value === 'true'));
        }
        case chat_completion_sources.FIREWORKS:
            return (Array.isArray(model_list) && model_list.find(m => m.id === oai_settings.fireworks_model)?.supports_image_input);
        default:
            return false;
    }
}

/**
 * @returns {boolean}
 */
function isVideoInliningSupported() {
    if (main_api !== 'openai') {
        return false;
    }

    if (!oai_settings.media_inlining) {
        return false;
    }

    const videoSupportedModels = [
        'gemini-2.0',
        'gemini-2.5',
        'gemini-exp-1206',
        'gemini-3',
        'gemma-4',
        'glm-4.5v',
        'glm-4.6v',
        'glm-5v-turbo',
    ];

    switch (oai_settings.chat_completion_source) {
        case chat_completion_sources.MAKERSUITE:
            return videoSupportedModels.some(model => oai_settings.google_model.includes(model));
        case chat_completion_sources.VERTEXAI:
            return videoSupportedModels.some(model => oai_settings.vertexai_model.includes(model));
        case chat_completion_sources.OPENROUTER:
            return (Array.isArray(model_list) && model_list.find(m => m.id === oai_settings.openrouter_model)?.architecture?.input_modalities?.includes('video'));
        case chat_completion_sources.ZAI:
            return videoSupportedModels.some(model => oai_settings.zai_model.includes(model));
        default:
            return false;
    }
}

/**
 * @returns {boolean}
 */
function isAudioInliningSupported() {
    if (main_api !== 'openai') {
        return false;
    }

    if (!oai_settings.media_inlining) {
        return false;
    }

    const audioSupportedModels = [
        'gemini-2.0',
        'gemini-2.5',
        'gemini-3',
        'gemini-exp-1206',
        'gpt-4o-audio',
        'gpt-4o-realtime',
        'gpt-4o-mini-audio',
        'gpt-4o-mini-realtime',
        'gpt-audio',
        'gpt-realtime',
    ];

    switch (oai_settings.chat_completion_source) {
        case chat_completion_sources.OPENAI:
            return audioSupportedModels.some(model => oai_settings.openai_model.includes(model));
        case chat_completion_sources.MAKERSUITE:
            return audioSupportedModels.some(model => oai_settings.google_model.includes(model));
        case chat_completion_sources.VERTEXAI:
            return audioSupportedModels.some(model => oai_settings.vertexai_model.includes(model));
        case chat_completion_sources.OPENROUTER:
            return (Array.isArray(model_list) && model_list.find(m => m.id === oai_settings.openrouter_model)?.architecture?.input_modalities?.includes('audio'));
        case chat_completion_sources.CUSTOM:
            return true;
        default:
            return false;
    }
}

export function loadProxyPresets(settings) {
    let proxyPresets = settings.proxies;
    selected_proxy = settings.selected_proxy || selected_proxy;
    if (!Array.isArray(proxyPresets) || proxyPresets.length === 0) {
        proxyPresets = proxies;
    } else {
        proxies = proxyPresets;
    }

    $('#openai_proxy_preset').empty();

    for (const preset of proxyPresets) {
        const option = document.createElement('option');
        option.innerText = preset.name;
        option.value = preset.name;
        option.selected = preset.name === 'None';
        $('#openai_proxy_preset').append(option);
    }
    $('#openai_proxy_preset').val(selected_proxy.name);
    setProxyPreset(selected_proxy.name, selected_proxy.url, selected_proxy.password);
}

function setProxyPreset(name, url, password) {
    const preset = proxies.find(p => p.name === name);
    if (preset) {
        preset.url = url;
        preset.password = password;
        selected_proxy = preset;
    } else {
        let new_proxy = { name, url, password };
        proxies.push(new_proxy);
        selected_proxy = new_proxy;
    }

    $('#openai_reverse_proxy_name').val(name);
    oai_settings.reverse_proxy = url;
    $('#openai_reverse_proxy').val(oai_settings.reverse_proxy);
    oai_settings.proxy_password = password;
    $('#openai_proxy_access_key').val(oai_settings.proxy_password);
    reconnectOpenAi();
}

function onProxyPresetChange() {
    const value = String($('#openai_proxy_preset').find(':selected').val());
    const selectedPreset = proxies.find(preset => preset.name === value);

    if (selectedPreset) {
        setProxyPreset(selectedPreset.name, selectedPreset.url, selectedPreset.password);
    } else {
        console.error(t`Proxy preset '${value}' not found in proxies array.`);
    }
    saveSettingsDebounced('oai_settings');
}

$('#save_proxy').on('click', async function () {
    const presetName = $('#openai_reverse_proxy_name').val();
    const reverseProxy = $('#openai_reverse_proxy').val();
    const proxyPassword = $('#openai_proxy_access_key').val();

    setProxyPreset(presetName, reverseProxy, proxyPassword);
    saveSettingsDebounced('oai_settings');
    toastr.success(t`Proxy Saved`);
    if ($('#openai_proxy_preset').val() !== presetName) {
        const option = document.createElement('option');
        option.text = String(presetName);
        option.value = String(presetName);

        $('#openai_proxy_preset').append(option);
    }
    $('#openai_proxy_preset').val(presetName);
});

$('#delete_proxy').on('click', async function () {
    const presetName = $('#openai_reverse_proxy_name').val();
    const index = proxies.findIndex(preset => preset.name === presetName);

    if (index !== -1) {
        proxies.splice(index, 1);
        $('#openai_proxy_preset option[value="' + presetName + '"]').remove();

        if (proxies.length > 0) {
            const newIndex = Math.max(0, index - 1);
            selected_proxy = proxies[newIndex];
        } else {
            selected_proxy = { name: 'None', url: '', password: '' };
        }

        $('#openai_reverse_proxy_name').val(selected_proxy.name);
        oai_settings.reverse_proxy = selected_proxy.url;
        $('#openai_reverse_proxy').val(selected_proxy.url);
        oai_settings.proxy_password = selected_proxy.password;
        $('#openai_proxy_access_key').val(selected_proxy.password);

        saveSettingsDebounced('oai_settings');
        $('#openai_proxy_preset').val(selected_proxy.name);
        toastr.success(t`Proxy Deleted`);
    } else {
        toastr.error(t`Could not find proxy with name '${presetName}'`);
    }
});

function runProxyCallback(_, value) {
    if (!value) {
        return selected_proxy?.name || '';
    }

    const proxyNames = proxies.map(preset => preset.name);
    const fuse = new Fuse(proxyNames);
    const result = fuse.search(value);

    if (result.length === 0) {
        toastr.warning(t`Proxy preset '${value}' not found`);
        return '';
    }

    const foundName = result[0].item;
    $('#openai_proxy_preset').val(foundName).trigger('change');
    return foundName;
}

function onVertexAIAuthModeChange() {
    const authMode = String($(this).val());
    oai_settings.vertexai_auth_mode = authMode;

    $('#vertexai_form [data-mode]').each(function () {
        const mode = $(this).data('mode');
        $(this).toggle(mode === authMode);
        $(this).find('option').toggle(mode === authMode);
    });

    saveSettingsDebounced('oai_settings');
}

async function onVertexAIValidateServiceAccount() {
    const jsonContent = String($('#vertexai_service_account_json').val()).trim();

    if (!jsonContent) {
        toastr.error(t`Please enter Service Account JSON content`);
        return;
    }

    try {
        const serviceAccount = JSON.parse(jsonContent);
        const requiredFields = ['type', 'project_id', 'private_key', 'client_email', 'client_id'];
        const missingFields = requiredFields.filter(field => !serviceAccount[field]);

        if (missingFields.length > 0) {
            toastr.error(t`Missing required fields: ${missingFields.join(', ')}`);
            updateVertexAIServiceAccountStatus(false, t`Missing fields: ${missingFields.join(', ')}`);
            return;
        }

        if (serviceAccount.type !== 'service_account') {
            toastr.error(t`Invalid service account type. Expected "service_account"`);
            updateVertexAIServiceAccountStatus(false, t`Invalid service account type`);
            return;
        }

        const keyLabel = serviceAccount.client_email || '';
        await writeSecret(SECRET_KEYS.VERTEXAI_SERVICE_ACCOUNT, jsonContent, keyLabel);

        updateVertexAIServiceAccountStatus(true, `Project: ${serviceAccount.project_id}, Email: ${serviceAccount.client_email}`);

        toastr.success(t`Service Account JSON is valid and saved securely`);
    } catch (error) {
        console.error('JSON validation error:', error);
        toastr.error(t`Invalid JSON format`);
        updateVertexAIServiceAccountStatus(false, t`Invalid JSON format`);
    }
}

async function onVertexAIClearServiceAccount() {
    $('#vertexai_service_account_json').val('');

    await writeSecret(SECRET_KEYS.VERTEXAI_SERVICE_ACCOUNT, '');

    updateVertexAIServiceAccountStatus(false);
    toastr.info(t`Service Account JSON cleared`);
}

function onVertexAIServiceAccountJsonChange() {
    const jsonContent = String($(this).val()).trim();

    if (isUuid(jsonContent)) {
        return;
    }

    if (jsonContent) {
        try {
            const serviceAccount = JSON.parse(jsonContent);
            const requiredFields = ['type', 'project_id', 'private_key', 'client_email'];
            const hasAllFields = requiredFields.every(field => serviceAccount[field]);

            if (hasAllFields && serviceAccount.type === 'service_account') {
                updateVertexAIServiceAccountStatus(false, t`JSON appears valid - click "Validate JSON" to save`);
            } else {
                updateVertexAIServiceAccountStatus(false, t`Incomplete or invalid JSON`);
            }
        } catch (error) {
            updateVertexAIServiceAccountStatus(false, t`Invalid JSON format`);
        }
    } else {
        updateVertexAIServiceAccountStatus(false);
    }
}

/**
 * @param {boolean} isValid
 * @param {string} message
 */
function updateVertexAIServiceAccountStatus(isValid = false, message = '') {
    const statusDiv = $('#vertexai_service_account_status');
    const infoSpan = $('#vertexai_service_account_info');

    if (!message && secret_state[SECRET_KEYS.VERTEXAI_SERVICE_ACCOUNT]) {
        isValid = true;
        message = t`Service Account JSON is saved and ready to use`;
    }

    if (isValid && message) {
        infoSpan.html(`<i class="fa-solid fa-check-circle" style="color: green;"></i> ${message}`);
        statusDiv.show();
    } else if (!isValid && message) {
        infoSpan.html(`<i class="fa-solid fa-exclamation-triangle" style="color: orange;"></i> ${message}`);
        statusDiv.show();
    } else {
        statusDiv.hide();
    }
}

function updateFeatureSupportFlags() {
    if (!newUiStarted()) return;
    newUi().settings.setSupport({
        functionCalling: ToolManager.isToolCallingSupported(),
        image: isImageInliningSupported(),
        video: isVideoInliningSupported(),
        audio: isAudioInliningSupported(),
    });
}

/**
 * @param {import('/ui/entry.js').NewUi['settings']} settings
 */
export function bindChatCompletionSettings(settings) {
    settings.bind(oai_settings, 'oai_settings');
    const paths = (/** @type {string[]} */ ...keys) => keys.map(key => `oai_settings.${key}`);
    settings.watch(paths('openai_max_context', 'openai_max_tokens'), () => {
        calculateOpenRouterCost();
        calculateElectronHubCost();
        calculateChutesCost();
        if (promptManager?.activeCharacter) promptManager.renderDebounced();
    });
    settings.watch(paths('enable_web_search'), () => calculateOpenRouterCost());
    settings.watch(paths('tool_call_recurse_limit'), () => { ToolManager.RECURSE_LIMIT = oai_settings.tool_call_recurse_limit; });
    settings.watch(paths('media_inlining', 'function_calling'), () => updateFeatureSupportFlags());
    ToolManager.RECURSE_LIMIT = oai_settings.tool_call_recurse_limit;
    updateFeatureSupportFlags();
}

export function initOpenAI() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'proxy',
        callback: runProxyCallback,
        returns: 'current proxy',
        namedArgumentList: [],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'name',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                enumProvider: () => proxies.map(preset => new SlashCommandEnumValue(preset.name, preset.url)),
            }),
        ],
        helpString: 'Sets a proxy preset by name.',
    }));

    $('#test_api_button').on('click', testApiConnection);

    $('#update_oai_preset').on('click', async function () {
        const name = oai_settings.preset_settings_openai;
        await saveOpenAIPreset(name, oai_settings, false);
        toastr.success(t`Preset updated`);
    });

    $('#openai_bypass_status_check').on('input', function () {
        oai_settings.bypass_status_check = !!$(this).prop('checked');
        getStatusOpen();
        saveSettingsDebounced('oai_settings');
    });

    $('#chat_completion_source').on('change', function () {
        cancelStatusCheck('Chat Completion source changed');
        model_list = [];
        const newSource = String($(this).find(':selected').val());
        const sourceChanged = newSource !== oai_settings.chat_completion_source;
        oai_settings.chat_completion_source = newSource;
        toggleChatCompletionForms();
        if (sourceChanged) {
            saveSettingsDebounced('oai_settings');
        }
        reconnectOpenAi();
        markCharacterEditorCountsStale();
        updateFeatureSupportFlags();
        eventSource.emit(event_types.CHATCOMPLETION_SOURCE_CHANGED, oai_settings.chat_completion_source);
    });

    $('#openai_show_external_models').on('input', function () {
        oai_settings.show_external_models = !!$(this).prop('checked');
        $('#openai_external_category').toggle(oai_settings.show_external_models);
        saveSettingsDebounced('oai_settings');
    });

    $('#openai_proxy_access_key').on('input', function () {
        oai_settings.proxy_password = String($(this).val());
        saveSettingsDebounced('oai_settings');
    });

    $('#openai_proxy_access_key').on('copy cut', function (event) {
        if ($(this).hasClass('masked-secret')) {
            event.preventDefault();
        }
    });

    $('#openrouter_use_fallback').on('input', function () {
        oai_settings.openrouter_use_fallback = !!$(this).prop('checked');
        saveSettingsDebounced('oai_settings');
    });

    $('#openrouter_allow_fallbacks').on('input', function () {
        oai_settings.openrouter_allow_fallbacks = !!$(this).prop('checked');
        updateOpenRouterProvidersWarning('#openrouter_providers_chat');
        saveSettingsDebounced('oai_settings');
    });

    $('#openrouter_middleout').on('input', function () {
        oai_settings.openrouter_middleout = String($(this).val());
        saveSettingsDebounced('oai_settings');
    });

    $('#custom_api_url_text').on('input', function () {
        oai_settings.custom_url = String($(this).val());
        saveSettingsDebounced('oai_settings');
    });

    $('#custom_model_id').on('input', function () {
        oai_settings.custom_model = String($(this).val());
        saveSettingsDebounced('oai_settings');
    });

    $('#custom_prompt_post_processing').on('change', function () {
        oai_settings.custom_prompt_post_processing = String($(this).val());
        updateFeatureSupportFlags();
        saveSettingsDebounced('oai_settings');
    });

    $('#azure_base_url').on('input', function () {
        oai_settings.azure_base_url = String($(this).val());
        saveSettingsDebounced('oai_settings');
    });

    $('#azure_deployment_name').on('input', function () {
        oai_settings.azure_deployment_name = String($(this).val());
        saveSettingsDebounced('oai_settings');
    });

    $('#azure_api_version').on('input change', function () {
        oai_settings.azure_api_version = String($(this).val());
        saveSettingsDebounced('oai_settings');
    });

    if (!CSS.supports('field-sizing', 'content')) {
        $(document).on('input', '#openai_settings .autoSetHeight', function () {
            resetScrollHeight($(this));
        });
    }

    if (!isMobile()) {
        $('#model_openrouter_select').select2({
            placeholder: t`Select a model`,
            searchInputPlaceholder: t`Search models...`,
            searchInputCssClass: 'text_pole',
            width: '100%',
            templateResult: getOpenRouterModelTemplate,
            matcher: textValueMatcher,
        });
        $('#model_aimlapi_select').select2({
            placeholder: t`Select a model`,
            searchInputPlaceholder: t`Search models...`,
            searchInputCssClass: 'text_pole',
            width: '100%',
            templateResult: getAimlapiModelTemplate,
        });
        $('#model_electronhub_select').select2({
            placeholder: t`Select a model`,
            searchInputPlaceholder: t`Search models...`,
            searchInputCssClass: 'text_pole',
            width: '100%',
            templateResult: getElectronHubModelTemplate,
            matcher: textValueMatcher,
        });
        $('#model_chutes_select').select2({
            placeholder: t`Select a model`,
            searchInputPlaceholder: t`Search models...`,
            searchInputCssClass: 'text_pole',
            width: '100%',
            templateResult: getChutesModelTemplate,
            matcher: textValueMatcher,
        });
        $('#model_nanogpt_select').select2({
            placeholder: t`Select a model`,
            searchInputPlaceholder: t`Search models...`,
            searchInputCssClass: 'text_pole',
            width: '100%',
            templateResult: getNanoGptModelTemplate,
            matcher: textValueMatcher,
        });
        $('#completion_prompt_manager_popup_entry_form_injection_trigger').select2({
            placeholder: t`All types (default)`,
            width: '100%',
            closeOnSelect: false,
        });
    }

    $('#openrouter_providers_chat').on('change', function () {
        const selectedProviders = $(this).val();

        if (!Array.isArray(selectedProviders)) {
            return;
        }

        const providersChanged = !arraysEqual(selectedProviders, oai_settings.openrouter_providers ?? []);
        oai_settings.openrouter_providers = selectedProviders;

        updateOpenRouterProvidersWarning('#openrouter_providers_chat');
        if (providersChanged) {
            saveSettingsDebounced('oai_settings');
        }
    });

    $('#openrouter_quantizations_chat').on('change', function () {
        const selectedQuantizations = $(this).val();

        if (!Array.isArray(selectedQuantizations)) {
            return;
        }

        const quantizationsChanged = !arraysEqual(selectedQuantizations, oai_settings.openrouter_quantizations ?? []);
        oai_settings.openrouter_quantizations = selectedQuantizations;

        if (quantizationsChanged) {
            saveSettingsDebounced('oai_settings');
        }
    });

    $('#nanogpt_provider').on('change', function () {
        const newProvider = String($(this).val() || '');
        const providerChanged = newProvider !== oai_settings.nanogpt_provider;
        oai_settings.nanogpt_provider = newProvider;
        updateNanoGptProvidersWarning('#nanogpt_provider');
        if (providerChanged) {
            saveSettingsDebounced('oai_settings');
        }
    });

    $('#nanogpt_payg_override').on('input', function () {
        oai_settings.nanogpt_payg_override = !!$(this).prop('checked');
        saveSettingsDebounced('oai_settings');
    });

    $('#bind_preset_to_connection').on('input', function () {
        oai_settings.bind_preset_to_connection = !!$(this).prop('checked');
        saveSettingsDebounced('oai_settings');
    });

    $('#cc_group_models').on('input', async () => {
        oai_settings.group_models = $('#cc_group_models').prop('checked');
        reconnectOpenAi();
        saveSettingsDebounced('oai_settings');
    });

    $('#cc_sort_models').on('input', async () => {
        oai_settings.sort_models = $('#cc_sort_models').val().toString();
        reconnectOpenAi();
        saveSettingsDebounced('oai_settings');
    });

    $('#api_button_openai').on('click', onConnectButtonClick);
    $('#openai_reverse_proxy').on('input', onReverseProxyInput);
    $('#model_openai_select').on('change', onModelChange);
    $('#model_claude_select').on('change', onModelChange);
    $('#model_google_select').on('change', onModelChange);
    $('#model_vertexai_select').on('change', onModelChange);
    $('#vertexai_auth_mode').on('change', onVertexAIAuthModeChange);
    $('#vertexai_region').on('input', function () {
        oai_settings.vertexai_region = String($(this).val());
        saveSettingsDebounced('oai_settings');
    });
    $('#vertexai_express_project_id').on('input', function () {
        oai_settings.vertexai_express_project_id = String($(this).val());
        saveSettingsDebounced('oai_settings');
    });
    $('#zai_endpoint').on('input', function () {
        oai_settings.zai_endpoint = String($(this).val());
        saveSettingsDebounced('oai_settings');
    });
    $('#pollinations_endpoint').on('input', function () {
        oai_settings.pollinations_endpoint = String($(this).val());
        $('#pollinations_key_section').toggle(oai_settings.pollinations_endpoint === POLLINATIONS_ENDPOINT.AUTHENTICATED);
        reconnectOpenAi();
        saveSettingsDebounced('oai_settings');
    });
    $('#siliconflow_endpoint').on('input', function () {
        oai_settings.siliconflow_endpoint = String($(this).val());
        saveSettingsDebounced('oai_settings');
    });
    $('#minimax_endpoint').on('input', function () {
        oai_settings.minimax_endpoint = String($(this).val());
        saveSettingsDebounced('oai_settings');
    });
    $('#workers_ai_account_id').on('input', function () {
        oai_settings.workers_ai_account_id = String($(this).val());
        saveSettingsDebounced('oai_settings');
    });
    $('#vertexai_service_account_json').on('input', onVertexAIServiceAccountJsonChange);
    $('#vertexai_validate_service_account').on('click', onVertexAIValidateServiceAccount);
    $('#vertexai_clear_service_account').on('click', onVertexAIClearServiceAccount);
    $('#model_openrouter_select').on('change', onModelChange);
    $('#model_ai21_select').on('change', onModelChange);
    $('#model_mistralai_select').on('change', onModelChange);
    $('#model_cohere_select').on('change', onModelChange);
    $('#model_perplexity_select').on('change', onModelChange);
    $('#model_groq_select').on('change', onModelChange);
    $('#model_chutes_select').on('change', onModelChange);
    $('#model_siliconflow_select').on('change', onModelChange);
    $('#model_minimax_select').on('change', onModelChange);
    $('#model_electronhub_select').on('change', onModelChange);
    $('#model_nanogpt_select').on('change', onModelChange);
    $('#model_deepseek_select').on('change', onModelChange);
    $('#model_aimlapi_select').on('change', onModelChange);
    $('#model_custom_select').on('change', onModelChange);
    $('#model_xai_select').on('change', onModelChange);
    $('#model_pollinations_select').on('change', onModelChange);
    $('#model_cometapi_select').on('change', onModelChange);
    $('#model_moonshot_select').on('change', onModelChange);
    $('#model_fireworks_select').on('change', onModelChange);
    $('#azure_openai_model').on('change', onModelChange);
    $('#model_zai_select').on('change', onModelChange);
    $('#model_workers_ai_select').on('change', onModelChange);
    $('#settings_preset_openai').on('change', onSettingsPresetChange);
    $('#new_oai_preset').on('click', onNewPresetClick);
    $('#delete_oai_preset').on('click', onDeletePresetClick);
    $('#openai_logit_bias_preset').on('change', onLogitBiasPresetChange);
    $('#openai_logit_bias_new_preset').on('click', createNewLogitBiasPreset);
    $('#openai_logit_bias_new_entry').on('click', createNewLogitBiasEntry);
    $('#openai_logit_bias_import_file').on('input', onLogitBiasPresetImportFileChange);
    $('#openai_preset_import_file').on('input', onPresetImportFileChange);
    $('#export_oai_preset').on('click', onExportPresetClick);
    $('#openai_logit_bias_import_preset').on('click', onLogitBiasPresetImportClick);
    $('#openai_logit_bias_export_preset').on('click', onLogitBiasPresetExportClick);
    $('#openai_logit_bias_delete_preset').on('click', onLogitBiasPresetDeleteClick);
    $('#import_oai_preset').on('click', onImportPresetClick);
    $('#openai_proxy_access_key_show').on('click', onProxyAccessKeyShowClick);
    $('#customize_additional_parameters').on('click', onCustomizeParametersClick);
    $('#openai_proxy_preset').on('change', onProxyPresetChange);
}
