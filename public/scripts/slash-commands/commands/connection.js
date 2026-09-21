import { SlashCommandParser } from '../SlashCommandParser.js';
import { SlashCommand } from '../SlashCommand.js';
import { Fuse } from '../../../lib.js';
import { online_status, saveSettingsDebounced } from '../../../script.js';
import { main_api } from '../../generation-params.js';
import { MINIMAX_ENDPOINT, POLLINATIONS_ENDPOINT, SILICONFLOW_ENDPOINT, ZAI_ENDPOINT, chat_completion_sources, oai_settings } from '../../chat-completion-settings.js';
import { t } from '../../i18n.js';
import { instruct_presets, selectContextPreset, selectInstructPreset } from '../../instruct-mode.js';
import { kai_settings } from '../../kai-settings.js';
import { context_presets, power_user } from '../../power-user.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '../SlashCommandArgument.js';
import { commonEnumProviders, enumIcons } from '../SlashCommandCommonEnumsProvider.js';
import { SlashCommandEnumValue, enumTypes } from '../SlashCommandEnumValue.js';
import { SERVER_INPUTS, textgen_types, textgenerationwebui_settings } from '../../textgen-settings.js';
import { getAvailableTokenizers, selectTokenizer } from '../../tokenizers.js';
import { isTrueBoolean, onlyUnique, waitUntilCondition } from '../../utils.js';
import { CONNECT_API_MAP, UNIQUE_APIS } from '../core.js';

/**
 * Retrieves the available model options based on the currently selected main API and its subtype
 * @param {boolean} quiet - Whether to suppress toasts
 *
 * @returns {{control: HTMLSelectElement|HTMLInputElement, options: HTMLOptionElement[]}?} An array of objects representing the available model options, or null if not supported
 */
function getModelOptions(quiet) {
    const nullResult = { control: null, options: null };
    const modelSelectMap = [
        { id: 'generic_model_textgenerationwebui', api: 'textgenerationwebui', type: textgen_types.GENERIC },
        { id: 'custom_model_textgenerationwebui', api: 'textgenerationwebui', type: textgen_types.OOBA },
        { id: 'model_togetherai_select', api: 'textgenerationwebui', type: textgen_types.TOGETHERAI },
        { id: 'openrouter_model', api: 'textgenerationwebui', type: textgen_types.OPENROUTER },
        { id: 'model_infermaticai_select', api: 'textgenerationwebui', type: textgen_types.INFERMATICAI },
        { id: 'model_dreamgen_select', api: 'textgenerationwebui', type: textgen_types.DREAMGEN },
        { id: 'mancer_model', api: 'textgenerationwebui', type: textgen_types.MANCER },
        { id: 'vllm_model', api: 'textgenerationwebui', type: textgen_types.VLLM },
        { id: 'aphrodite_model', api: 'textgenerationwebui', type: textgen_types.APHRODITE },
        { id: 'ollama_model', api: 'textgenerationwebui', type: textgen_types.OLLAMA },
        { id: 'tabby_model', api: 'textgenerationwebui', type: textgen_types.TABBY },
        { id: 'llamacpp_model', api: 'textgenerationwebui', type: textgen_types.LLAMACPP },
        { id: 'featherless_model', api: 'textgenerationwebui', type: textgen_types.FEATHERLESS },
        { id: 'model_openai_select', api: 'openai', type: chat_completion_sources.OPENAI },
        { id: 'model_claude_select', api: 'openai', type: chat_completion_sources.CLAUDE },
        { id: 'model_openrouter_select', api: 'openai', type: chat_completion_sources.OPENROUTER },
        { id: 'model_ai21_select', api: 'openai', type: chat_completion_sources.AI21 },
        { id: 'model_google_select', api: 'openai', type: chat_completion_sources.MAKERSUITE },
        { id: 'model_vertexai_select', api: 'openai', type: chat_completion_sources.VERTEXAI },
        { id: 'model_mistralai_select', api: 'openai', type: chat_completion_sources.MISTRALAI },
        { id: 'custom_model_id', api: 'openai', type: chat_completion_sources.CUSTOM },
        { id: 'model_cohere_select', api: 'openai', type: chat_completion_sources.COHERE },
        { id: 'model_perplexity_select', api: 'openai', type: chat_completion_sources.PERPLEXITY },
        { id: 'model_groq_select', api: 'openai', type: chat_completion_sources.GROQ },
        { id: 'model_chutes_select', api: 'openai', type: chat_completion_sources.CHUTES },
        { id: 'model_siliconflow_select', api: 'openai', type: chat_completion_sources.SILICONFLOW },
        { id: 'model_minimax_select', api: 'openai', type: chat_completion_sources.MINIMAX },
        { id: 'model_electronhub_select', api: 'openai', type: chat_completion_sources.ELECTRONHUB },
        { id: 'model_nanogpt_select', api: 'openai', type: chat_completion_sources.NANOGPT },
        { id: 'model_deepseek_select', api: 'openai', type: chat_completion_sources.DEEPSEEK },
        { id: 'model_aimlapi_select', api: 'openai', type: chat_completion_sources.AIMLAPI },
        { id: 'model_xai_select', api: 'openai', type: chat_completion_sources.XAI },
        { id: 'model_pollinations_select', api: 'openai', type: chat_completion_sources.POLLINATIONS },
        { id: 'model_moonshot_select', api: 'openai', type: chat_completion_sources.MOONSHOT },
        { id: 'model_fireworks_select', api: 'openai', type: chat_completion_sources.FIREWORKS },
        { id: 'model_cometapi_select', api: 'openai', type: chat_completion_sources.COMETAPI },
        { id: 'model_zai_select', api: 'openai', type: chat_completion_sources.ZAI },
        { id: 'model_workers_ai_select', api: 'openai', type: chat_completion_sources.WORKERS_AI },
        { id: 'model_novel_select', api: 'novel', type: null },
        { id: 'horde_model', api: 'koboldhorde', type: null },
    ];

    function getSubType() {
        switch (main_api) {
            case 'textgenerationwebui':
                return textgenerationwebui_settings.type;
            case 'openai':
                return oai_settings.chat_completion_source;
            default:
                return null;
        }
    }

    const apiSubType = getSubType();
    const modelSelectItem = modelSelectMap.find(x => x.api == main_api && x.type == apiSubType)?.id;

    if (!modelSelectItem) {
        !quiet && toastr.info(t`Setting a model for your API is not supported or not implemented yet.`);
        return nullResult;
    }

    const modelSelectControl = document.getElementById(modelSelectItem);

    if (!(modelSelectControl instanceof HTMLSelectElement) && !(modelSelectControl instanceof HTMLInputElement)) {
        !quiet && toastr.error(t`Model select control not found: ${main_api}[${apiSubType}]`);
        return nullResult;
    }

    /**
     * Get options from a HTMLSelectElement or HTMLInputElement with a list.
     * @param {HTMLSelectElement | HTMLInputElement} control Control containing the options
     * @returns {HTMLOptionElement[]} Array of options
     */
    const getOptions = (control) => {
        if (control instanceof HTMLSelectElement) {
            return Array.from(control.options);
        }

        const valueOption = new Option(control.value, control.value);

        if (control instanceof HTMLInputElement && control.list instanceof HTMLDataListElement) {
            return [valueOption, ...Array.from(control.list.options)];
        }

        return [valueOption];
    };

    const options = getOptions(modelSelectControl).filter(x => x.value).filter(onlyUnique);
    return { control: modelSelectControl, options };
}

/**
 * @param {string} model New model name
 * @returns {string} New or existing model name
 */
function modelCallback(args, model) {
    const quiet = isTrueBoolean(args?.quiet);
    const { control: modelSelectControl, options } = getModelOptions(quiet);

    // Reason for no model found was already logged
    if (options === null) {
        return '';
    }

    model = String(model || '').trim();

    if (!model) {
        return modelSelectControl.value;
    }

    console.log('Set model to ' + model);

    if (modelSelectControl instanceof HTMLInputElement) {
        modelSelectControl.value = model;
        $(modelSelectControl).trigger('input');
        !quiet && toastr.success(t`Model set to "${model}"`);
        return model;
    }

    if (!options.length) {
        !quiet && toastr.warning(t`No model options found. Check your API settings.`);
        return '';
    }

    let newSelectedOption = null;

    const fuse = new Fuse(options, { keys: ['text', 'value'] });
    const fuzzySearchResult = fuse.search(model);

    const exactValueMatch = options.find(x => x.value.trim().toLowerCase() === model.trim().toLowerCase());
    const exactTextMatch = options.find(x => x.text.trim().toLowerCase() === model.trim().toLowerCase());

    if (exactValueMatch) {
        newSelectedOption = exactValueMatch;
    } else if (exactTextMatch) {
        newSelectedOption = exactTextMatch;
    } else if (fuzzySearchResult.length) {
        newSelectedOption = fuzzySearchResult[0].item;
    }

    if (newSelectedOption) {
        modelSelectControl.value = newSelectedOption.value;
        $(modelSelectControl).trigger('change');
        !quiet && toastr.success(t`Model set to "${newSelectedOption.text}"`);
        return newSelectedOption.value;
    } else {
        !quiet && toastr.warning(t`No model found with name "${model}"`);
        return '';
    }
}

/**
 * Sets the API URL and triggers the text generation web UI button click.
 *
 * @param {object} args - named args
 * @param {string?} [args.api=null] - the API name to set/get the URL for
 * @param {string?} [args.connect=true] - whether to connect to the API after setting
 * @param {string?} [args.quiet=false] - whether to suppress toasts
 * @param {string} url - the API URL to set
 * @returns {Promise<string>}
 */
async function setApiUrlCallback({ api = null, connect = 'true', quiet = 'false' }, url) {
    const isQuiet = isTrueBoolean(quiet);
    const autoConnect = isTrueBoolean(connect);

    // Chat Completion Custom (OpenAI-compatible) also supports API URL handling
    const isCurrentlyCustomOpenai = main_api === 'openai' && oai_settings.chat_completion_source === chat_completion_sources.CUSTOM;
    if (api === chat_completion_sources.CUSTOM || (!api && isCurrentlyCustomOpenai)) {
        if (!url) {
            return oai_settings.custom_url ?? '';
        }

        if (!isCurrentlyCustomOpenai && autoConnect) {
            toastr.warning(t`Custom OpenAI API is not the currently selected API, so we cannot do an auto-connect. Consider switching to it via /api beforehand.`);
            return '';
        }

        $('#custom_api_url_text').val(url).trigger('input');

        if (autoConnect) {
            $('#api_button_openai').trigger('click');
        }

        return url;
    }

    const isCurrentlyZAI = main_api === 'openai' && oai_settings.chat_completion_source === chat_completion_sources.ZAI;
    if (api === chat_completion_sources.ZAI || (!api && isCurrentlyZAI)) {
        if (!url) {
            return oai_settings.zai_endpoint || ZAI_ENDPOINT.COMMON;
        }

        const permittedValues = Object.values(ZAI_ENDPOINT);
        if (!permittedValues.includes(url)) {
            !isQuiet && toastr.warning(t`Valid options are: ${permittedValues.join(', ')}`, t`ZAI endpoint '${url}' is not a valid option.`);
            return '';
        }

        if (!isCurrentlyZAI && autoConnect) {
            toastr.warning(t`Z.AI is not the currently selected API, so we cannot do an auto-connect. Consider switching to it via /api beforehand.`);
            return '';
        }

        $('#zai_endpoint').val(url).trigger('input');

        if (autoConnect) {
            $('#api_button_openai').trigger('click');
        }

        return oai_settings.zai_endpoint || ZAI_ENDPOINT.COMMON;
    }

    const isCurrentlySiliconFlow = main_api === 'openai' && oai_settings.chat_completion_source === chat_completion_sources.SILICONFLOW;
    if (api === chat_completion_sources.SILICONFLOW || (!api && isCurrentlySiliconFlow)) {
        if (!url) {
            return oai_settings.siliconflow_endpoint || SILICONFLOW_ENDPOINT.GLOBAL;
        }

        const permittedValues = Object.values(SILICONFLOW_ENDPOINT);
        if (!permittedValues.includes(url)) {
            !isQuiet && toastr.warning(t`Valid options are: ${permittedValues.join(', ')}`, t`SiliconFlow endpoint '${url}' is not a valid option.`);
            return '';
        }

        if (!isCurrentlySiliconFlow && autoConnect) {
            toastr.warning(t`SiliconFlow is not the currently selected API, so we cannot do an auto-connect. Consider switching to it via /api beforehand.`);
            return '';
        }

        $('#siliconflow_endpoint').val(url).trigger('input');

        if (autoConnect) {
            $('#api_button_openai').trigger('click');
        }

        return oai_settings.siliconflow_endpoint || SILICONFLOW_ENDPOINT.GLOBAL;
    }

    const isCurrentlyMinimax = main_api === 'openai' && oai_settings.chat_completion_source === chat_completion_sources.MINIMAX;
    if (api === chat_completion_sources.MINIMAX || (!api && isCurrentlyMinimax)) {
        if (!url) {
            return oai_settings.minimax_endpoint || MINIMAX_ENDPOINT.GLOBAL;
        }

        const permittedValues = Object.values(MINIMAX_ENDPOINT);
        if (!permittedValues.includes(url)) {
            !isQuiet && toastr.warning(t`Valid options are: ${permittedValues.join(', ')}`, t`MiniMax endpoint '${url}' is not a valid option.`);
            return '';
        }

        if (!isCurrentlyMinimax && autoConnect) {
            toastr.warning(t`MiniMax is not the currently selected API, so we cannot do an auto-connect. Consider switching to it via /api beforehand.`);
            return '';
        }

        $('#minimax_endpoint').val(url).trigger('input');

        if (autoConnect) {
            $('#api_button_openai').trigger('click');
        }

        return oai_settings.minimax_endpoint || MINIMAX_ENDPOINT.GLOBAL;
    }

    const isCurrentlyVertexAI = main_api === 'openai' && oai_settings.chat_completion_source === chat_completion_sources.VERTEXAI;
    if (api === chat_completion_sources.VERTEXAI || (!api && isCurrentlyVertexAI)) {
        const defaultRegion = 'us-central1';
        const permittedValues = Array
            .from(document.querySelectorAll('#vertexai_region_suggestions option'))
            .map(e => e instanceof HTMLOptionElement ? e.value : '')
            .filter(x => x);

        if (!url) {
            return oai_settings.vertexai_region || defaultRegion;
        }

        if (!permittedValues.includes(url)) {
            !isQuiet && toastr.info(t`Generation requests may fail.`, t`Unknown VertexAI region '${url}'`);
        }

        if (!isCurrentlyVertexAI && autoConnect) {
            toastr.warning(t`VertexAI is not the currently selected API, so we cannot do an auto-connect. Consider switching to it via /api beforehand.`);
            return '';
        }

        $('#vertexai_region').val(url).trigger('input');

        if (autoConnect) {
            $('#api_button_openai').trigger('click');
        }

        return oai_settings.vertexai_region || defaultRegion;
    }

    const isCurrentlyPollinations = main_api === 'openai' && oai_settings.chat_completion_source === chat_completion_sources.POLLINATIONS;
    if (api === chat_completion_sources.POLLINATIONS || (!api && isCurrentlyPollinations)) {
        if (!url) {
            return oai_settings.pollinations_endpoint || POLLINATIONS_ENDPOINT.AUTHENTICATED;
        }

        const permittedValues = Object.values(POLLINATIONS_ENDPOINT);
        if (!permittedValues.includes(url)) {
            !isQuiet && toastr.warning(t`Valid options are: ${permittedValues.join(', ')}`, t`Pollinations endpoint '${url}' is not a valid option.`);
            return '';
        }

        if (!isCurrentlyPollinations && autoConnect) {
            toastr.warning(t`Pollinations API is not the currently selected API, so we cannot do an auto-connect. Consider switching to it via /api beforehand.`);
            return '';
        }

        $('#pollinations_endpoint').val(url).trigger('input');

        if (autoConnect) {
            $('#api_button_openai').trigger('click');
        }

        return oai_settings.pollinations_endpoint || POLLINATIONS_ENDPOINT.AUTHENTICATED;
    }

    // Special handling for Kobold Classic API
    const isCurrentlyKoboldClassic = main_api === 'kobold';
    if (api === 'kobold' || (!api && isCurrentlyKoboldClassic)) {
        if (!url) {
            return kai_settings.api_server ?? '';
        }

        if (!isCurrentlyKoboldClassic && autoConnect) {
            toastr.warning(t`Kobold Classic API is not the currently selected API, so we cannot do an auto-connect. Consider switching to it via /api beforehand.`);
            return '';
        }

        $('#api_url_text').val(url).trigger('input');
        // trigger blur debounced, so we hide the autocomplete menu
        setTimeout(() => $('#api_url_text').trigger('blur'), 1);

        if (autoConnect) {
            $('#api_button').trigger('click');
        }

        return kai_settings.api_server ?? '';
    }

    if (api && !Object.values(textgen_types).includes(api)) {
        !isQuiet && toastr.warning(t`API '${api}' is not a valid text_gen API.`);
        return '';
    }
    if (!api && !Object.values(textgen_types).includes(textgenerationwebui_settings.type)) {
        !isQuiet && toastr.warning(t`API '${textgenerationwebui_settings.type}' is not a valid text_gen API.`);
        return '';
    }
    if (!api && main_api !== 'textgenerationwebui') {
        !isQuiet && toastr.warning(t`API type '${main_api}' does not support setting the server URL.`);
        return '';
    }
    if (api && url && autoConnect && api !== textgenerationwebui_settings.type) {
        !isQuiet && toastr.warning(t`API '${api}' is not the currently selected API, so we cannot do an auto-connect. Consider switching to it via /api beforehand.`);
        return '';
    }
    const type = api || textgenerationwebui_settings.type;

    const inputSelector = SERVER_INPUTS[type];
    if (!inputSelector) {
        !isQuiet && toastr.warning(t`API '${type}' does not have a server url input.`);
        return '';
    }

    if (!url) {
        return textgenerationwebui_settings.server_urls[type] ?? '';
    }

    $(inputSelector).val(url).trigger('input');
    // trigger blur debounced, so we hide the autocomplete menu
    setTimeout(() => $(inputSelector).trigger('blur'), 1);

    if (autoConnect) {
        $('#api_button_textgenerationwebui').trigger('click');
    }

    // Re-acquire the value since validation on connect may have modified it
    return textgenerationwebui_settings.server_urls[type] ?? '';
}

async function selectTokenizerCallback(_, name) {
    if (!name) {
        return getAvailableTokenizers().find(tokenizer => tokenizer.tokenizerId === power_user.tokenizer)?.tokenizerKey ?? '';
    }

    const tokenizers = getAvailableTokenizers();
    const fuse = new Fuse(tokenizers, { keys: ['tokenizerKey', 'tokenizerName'] });
    const result = fuse.search(name);

    if (result.length === 0) {
        toastr.warning(t`Tokenizer "${name}" not found`);
        return '';
    }

    /** @type {import('../../tokenizers.js').Tokenizer} */
    const foundTokenizer = result[0].item;
    selectTokenizer(foundTokenizer.tokenizerId);

    return foundTokenizer.tokenizerKey;
}

export function registerConnectionCommands() {
    async function enableInstructCallback() {
        $('#instruct_enabled').prop('checked', true).trigger('input').trigger('change');
        return '';
    }

    async function disableInstructCallback() {
        $('#instruct_enabled').prop('checked', false).trigger('input').trigger('change');
        return '';
    }

    const promptPostProcessingEnumProvider = () => Array
        .from(document.getElementById('custom_prompt_post_processing').querySelectorAll('option'))
        .map(option => new SlashCommandEnumValue(option.value || 'none', option.textContent, enumTypes.enum));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'api',
        callback: async function (args, text) {
            if (!text?.toString()?.trim()) {
                for (const [key, config] of Object.entries(CONNECT_API_MAP)) {
                    if (config.selected !== main_api) continue;

                    if (config.source) {
                        if (oai_settings.chat_completion_source === config.source) {
                            return key;
                        } else {
                            continue;
                        }
                    }

                    if (config.type) {
                        if (textgenerationwebui_settings.type === config.type) {
                            return key;
                        } else {
                            continue;
                        }
                    }

                    return key;
                }

                console.error('FIXME: The current API is not in the API map');
                return '';
            }

            const apiConfig = CONNECT_API_MAP[text?.toString()?.toLowerCase() ?? ''];
            if (!apiConfig) {
                toastr.error(t`Error: ${text} is not a valid API`);
                return '';
            }

            let connectionRequired = false;

            if (main_api !== apiConfig.selected) {
                $(`#main_api option[value='${apiConfig.selected || text}']`).prop('selected', true);
                $('#main_api').trigger('change');
                connectionRequired = true;
            }

            if (apiConfig.source && oai_settings.chat_completion_source !== apiConfig.source) {
                $(`#chat_completion_source option[value='${apiConfig.source}']`).prop('selected', true);
                $('#chat_completion_source').trigger('change');
                connectionRequired = true;
            }

            if (apiConfig.type && textgenerationwebui_settings.type !== apiConfig.type) {
                $(`#textgen_type option[value='${apiConfig.type}']`).prop('selected', true);
                $('#textgen_type').trigger('change');
                connectionRequired = true;
            }

            if (connectionRequired && apiConfig.button) {
                $(apiConfig.button).trigger('click');
            }

            const quiet = isTrueBoolean(args?.quiet?.toString());
            const toast = quiet ? jQuery() : toastr.info(t`API set to ${text}, trying to connect..`);

            try {
                if (connectionRequired) {
                    await waitUntilCondition(() => online_status !== 'no_connection', 5000, 100);
                }
                console.log('Connection successful');
            } catch {
                console.log('Could not connect after 5 seconds, skipping.');
            }

            toastr.clear(toast);
            return text?.toString()?.trim() ?? '';
        },
        returns: t`the current API`,
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'quiet',
                description: t`Suppress the toast message on connection`,
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'false',
                enumList: commonEnumProviders.boolean('trueFalse')(),
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: t`API to connect to`,
                typeList: [ARGUMENT_TYPE.STRING],
                enumList: Object.entries(CONNECT_API_MAP).sort(([a], [b]) => a.localeCompare(b)).map(([api, { selected }]) =>
                    new SlashCommandEnumValue(api, selected, enumTypes.getBasedOnIndex(UNIQUE_APIS.findIndex(x => x === selected)),
                        selected[0].toUpperCase() ?? enumIcons.default)),
            }),
        ],
        helpString: `
            <div>
                ${t`Connect to an API. If no argument is provided, it will return the currently connected API.`}
            </div>
            <div>
                <strong>${t`Available APIs:`}</strong>
                <pre><code>${Object.keys(CONNECT_API_MAP).sort((a, b) => a.localeCompare(b)).join(', ')}</code></pre>
            </div>
        `,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'instruct',
        callback: async function (args, name) {
            if (!name) {
                return power_user.instruct.enabled || isTrueBoolean(args?.forceGet?.toString()) ? power_user.instruct.preset : '';
            }

            const quiet = isTrueBoolean(args?.quiet?.toString());
            const instructNames = instruct_presets.map(preset => preset.name);
            const fuse = new Fuse(instructNames);
            const result = fuse.search(name?.toString() ?? '');

            if (result.length === 0) {
                !quiet && toastr.warning(t`Instruct template '${name}' not found`);
                return '';
            }

            const foundName = result[0].item;
            selectInstructPreset(foundName, { quiet: quiet });
            return foundName;
        },
        returns: t`current template`,
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'quiet',
                description: t`Suppress the toast message on template change`,
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'false',
                enumList: commonEnumProviders.boolean('trueFalse')(),
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'forceGet',
                description: t`Force getting a name even if instruct mode is disabled`,
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'false',
                enumList: commonEnumProviders.boolean('trueFalse')(),
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: t`instruct template name`,
                typeList: [ARGUMENT_TYPE.STRING],
                enumProvider: () => instruct_presets.map(preset => new SlashCommandEnumValue(preset.name, null, enumTypes.enum, enumIcons.preset)),
            }),
        ],
        helpString: `
            <div>
                ${t`Selects instruct mode template by name. Enables instruct mode if not already enabled.`}
                ${t`Gets the current instruct template if no name is provided and instruct mode is enabled or <code>forceGet=true</code> is passed.`}
            </div>
            <div>
                <strong>${t`Example:`}</strong>
                <ul>
                    <li>
                        <pre><code class="language-stscript">/instruct creative</code></pre>
                    </li>
                </ul>
            </div>
        `,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'instruct-on',
        callback: enableInstructCallback,
        helpString: t`Enables instruct mode.`,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'instruct-off',
        callback: disableInstructCallback,
        helpString: t`Disables instruct mode`,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'instruct-state',
        aliases: ['instruct-toggle'],
        helpString: t`Gets the current instruct mode state. If an argument is provided, it will set the instruct mode state.`,
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: t`instruct mode state`,
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                enumList: commonEnumProviders.boolean('trueFalse')(),
            }),
        ],
        callback: async (_args, state) => {
            if (!state || typeof state !== 'string') {
                return String(power_user.instruct.enabled);
            }

            const newState = isTrueBoolean(state);
            newState ? enableInstructCallback() : disableInstructCallback();
            return String(power_user.instruct.enabled);
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'context',
        callback: async function (args, name) {
            if (!name) {
                return power_user.context.preset;
            }

            const quiet = isTrueBoolean(args?.quiet?.toString());
            const contextNames = context_presets.map(preset => preset.name);
            const fuse = new Fuse(contextNames);
            const result = fuse.search(name?.toString() ?? '');

            if (result.length === 0) {
                !quiet && toastr.warning(t`Context template '${name}' not found`);
                return '';
            }

            const foundName = result[0].item;
            selectContextPreset(foundName, { quiet: quiet });
            return foundName;
        },
        returns: t`template name`,
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'quiet',
                description: t`Suppress the toast message on template change`,
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'false',
                enumList: commonEnumProviders.boolean('trueFalse')(),
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: t`context template name`,
                typeList: [ARGUMENT_TYPE.STRING],
                enumProvider: () => context_presets.map(preset => new SlashCommandEnumValue(preset.name, null, enumTypes.enum, enumIcons.preset)),
            }),
        ],
        helpString: t`Selects context template by name. Gets the current template if no name is provided`,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'model',
        callback: modelCallback,
        returns: t`current model`,
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'quiet',
                description: t`suppress the toast message on model change`,
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'false',
                enumList: commonEnumProviders.boolean('trueFalse')(),
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: t`model name`,
                typeList: [ARGUMENT_TYPE.STRING],
                enumProvider: () => getModelOptions(true)?.options?.map(option => new SlashCommandEnumValue(option.value, option.value !== option.text ? option.text : null)) ?? [],
            }),
        ],
        helpString: t`Sets the model for the current API. Gets the current model name if no argument is provided.`,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'api-url',
        callback: setApiUrlCallback,
        returns: t`the current API url`,
        aliases: ['server'],
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'api',
                description: t`API to set/get the URL for - if not provided, current API is used`,
                typeList: [ARGUMENT_TYPE.STRING],
                enumList: [
                    new SlashCommandEnumValue('custom', 'custom OpenAI-compatible', enumTypes.getBasedOnIndex(UNIQUE_APIS.findIndex(x => x === 'openai')), 'O'),
                    new SlashCommandEnumValue('zai', 'Z.AI', enumTypes.getBasedOnIndex(UNIQUE_APIS.findIndex(x => x === 'zai')), 'Z'),
                    new SlashCommandEnumValue('vertexai', 'Google Vertex AI', enumTypes.getBasedOnIndex(UNIQUE_APIS.findIndex(x => x === 'vertexai')), 'V'),
                    new SlashCommandEnumValue('siliconflow', 'SiliconFlow', enumTypes.getBasedOnIndex(UNIQUE_APIS.findIndex(x => x === 'siliconflow')), 'S'),
                    new SlashCommandEnumValue('minimax', 'MiniMax', enumTypes.getBasedOnIndex(UNIQUE_APIS.findIndex(x => x === 'minimax')), 'M'),
                    new SlashCommandEnumValue('pollinations', 'Pollinations', enumTypes.getBasedOnIndex(UNIQUE_APIS.findIndex(x => x === 'pollinations')), 'P'),
                    new SlashCommandEnumValue('kobold', 'KoboldAI Classic', enumTypes.getBasedOnIndex(UNIQUE_APIS.findIndex(x => x === 'kobold')), 'K'),
                    ...Object.values(textgen_types).filter(api => Object.keys(SERVER_INPUTS).includes(api)).map(api => new SlashCommandEnumValue(api, null, enumTypes.getBasedOnIndex(UNIQUE_APIS.findIndex(x => x === 'textgenerationwebui')), 'T')),
                ],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'connect',
                description: t`Whether to auto-connect to the API after setting the URL`,
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'true',
                enumList: commonEnumProviders.boolean('trueFalse')(),
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'quiet',
                description: t`suppress the toast message on API change`,
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'false',
                enumList: commonEnumProviders.boolean('trueFalse')(),
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: t`API url to connect to`,
                typeList: [ARGUMENT_TYPE.STRING],
            }),
        ],
        helpString: `
            <div>
                ${t`Set the API URL / server URL / endpoint for the currently selected API, including the port. If no argument is provided, it will return the current API url.`}
            </div>
            <div>
                ${t`If a manual API is provided to <b>set</b> the URL, make sure to set <code>connect=false</code>, as auto-connect only works for the currently selected API, or consider switching to it with <code>/api</code> first.`}
            </div>
            <div>
                ${t`This slash command works for most of the Text Completion sources, KoboldAI Classic, and also Custom OpenAI compatible, Z.AI, SiliconFlow, MiniMax, Pollinations, and Google Vertex AI for the Chat Completion sources. If unsure which APIs are supported, check the auto-completion of the optional <code>api</code> argument of this command.`}
            </div>
        `,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'tokenizer',
        callback: selectTokenizerCallback,
        returns: t`current tokenizer`,
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: t`tokenizer name`,
                typeList: [ARGUMENT_TYPE.STRING],
                enumList: getAvailableTokenizers().map(tokenizer =>
                    new SlashCommandEnumValue(tokenizer.tokenizerKey, tokenizer.tokenizerName, enumTypes.enum, enumIcons.default)),
            }),
        ],
        helpString: `
            <div>
                ${t`Selects tokenizer by name. Gets the current tokenizer if no name is provided.`}
            </div>
            <div>
                <strong>${t`Available tokenizers:`}</strong>
                <pre><code>${getAvailableTokenizers().map(t => t.tokenizerKey).join(', ')}</code></pre>
            </div>
        `,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'prompt-post-processing',
        aliases: ['ppp'],
        helpString: `
            <div>
                ${t`Sets a "Prompt Post-Processing" type. Gets the current selection if no value is provided.`}
            </div>
            <div>
                <strong>${t`Examples:`}</strong>
            </div>
            <ul>
                <li><pre><code class="language-stscript">/prompt-post-processing | /echo</code></pre></li>
                <li><pre><code class="language-stscript">/prompt-post-processing single</code></pre></li>
            </ul>
        `,
        namedArgumentList: [],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: t`value`,
                typeList: [ARGUMENT_TYPE.STRING],
                acceptsMultiple: false,
                isRequired: true,
                forceEnum: true,
                enumProvider: promptPostProcessingEnumProvider,
            }),
        ],
        callback: (_args, value) => {
            const stringValue = String(value ?? '').trim().toLowerCase();
            if (!stringValue) {
                return oai_settings.custom_prompt_post_processing || 'none';
            }

            const validValues = promptPostProcessingEnumProvider().map(option => option.value);
            if (!validValues.includes(stringValue)) {
                throw new Error(t`Invalid value "${stringValue}". Valid values are: ${validValues.join(', ')}`);
            }

            // 'none' value must be coerced to an empty string
            oai_settings.custom_prompt_post_processing = stringValue === 'none' ? '' : stringValue;
            $('#custom_prompt_post_processing').val(oai_settings.custom_prompt_post_processing);
            saveSettingsDebounced('oai_settings');

            return oai_settings.custom_prompt_post_processing;
        },
    }));
}
