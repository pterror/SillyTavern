import { Fuse, DOMPurify } from '../lib.js';

import {
    abortStatusCheck,
    cancelStatusCheck,
    getCurrentCharacter,
    extension_prompt_roles,
    extension_prompt_types,
    Generate,
    getCurrentChatId,
    getExtensionPrompt,
    getExtensionPromptMaxDepth,
    getMediaDisplay,
    getMediaIndex,
    is_send_press,
    name2,
    responseLengthFor,
    resultCheckStatus,
    saveSettings,
    saveSettingsDebounced,
    setOnlineStatus,
    startStatusLoading,
    substituteParams,
    substituteParamsExtended,
    system_message_types,
    takeInStoppedReply,
} from '../script.js';
import { name1 } from './app-selection-state.js';
import { beginServerGeneration, endServerGeneration } from './generation-stop.js';
import { getRequestHeaders } from './request-headers.js';
import { event_types, eventSource } from './events.js';
import { getGroupNames, selected_group } from './group-chats.js';

import {
    INJECTION_POSITION,
    Prompt,
    PromptManager,
} from './PromptManager.js';

import { markCharacterEditorCountsStale, getCustomStoppingStrings, persona_description_positions, power_user } from './power-user.js';
import { getPersonaDescription, getPersonaDescriptionPosition } from './personas.js';
import { SECRET_KEYS, secret_state, writeSecret } from './secrets.js';

import { CompactStreamDecoder, ResumableCompactStreamReader } from './llamacpp-compact-stream.js';
import {
    arraysEqual,
    clamp,
    createThumbnail,
    delay,
    download,
    getAudioDurationFromDataURL,
    getBase64Async,
    getFileText,
    getImageSizeFromDataURL,
    getSortableDelay,
    getStringHash,
    getVideoDurationFromDataURL,
    isDataURL,
    isUuid,
    isValidUrl,
    parseJsonFile,
    resetScrollHeight,
    stringFormat,
    textValueMatcher,
    uuidv4,
} from './utils.js';
import { countTokensOpenAIAsync, getTokenizerAnswer, getTokenizerStateHeader, onTokenizerChange, showDroppedEntries } from './tokenizers.js';
import { isMobile } from './RossAscends-mods.js';
import { saveLogprobsForActiveMessage } from './logprobs.js';
import { SlashCommandParser } from './slash-commands/SlashCommandParser.js';
import { SlashCommand } from './slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument } from './slash-commands/SlashCommandArgument.js';
import { renderTemplateAsync } from './templates.js';
import { SlashCommandEnumValue } from './slash-commands/SlashCommandEnumValue.js';
import { callGenericPopup, Popup, POPUP_RESULT, POPUP_TYPE } from './popup.js';
import { t } from './i18n.js';
import { ToolManager } from './tool-calling.js';
import { accountStorage } from './util/AccountStorage.js';
import { COMETAPI_IGNORE_PATTERNS, IGNORE_SYMBOL, MEDIA_DISPLAY, MEDIA_TYPE } from './constants.js';
import { syncNanoGptProvidersForModel, syncOpenRouterProvidersForModel, updateNanoGptProvidersWarning, updateOpenRouterProvidersWarning } from './textgen-models.js';
import { main_api } from './generation-params.js';
import { showTokenizerWarnings } from './tokenizer-notices.js';
import { reportStored, reportStoredHeader } from './stored-report.js';
import { GLOBAL_PROMPT_ORDER_ID } from './prompt-manager-defaults.js';
import { SERVER_OWNED, newUi, newUiStarted } from './new-ui-page.js';
import { reasoningOf } from './reasoning-block.js';
import {
    default_main_prompt,
    default_nsfw_prompt,
    default_jailbreak_prompt,
    default_enhance_definitions_prompt,
    openrouter_website_model,
    chat_completion_sources,
    character_names_behavior,
    custom_prompt_post_processing_types,
    reasoning_effort_types,
    verbosity_levels,
    tool_reasoning_modes,
    ZAI_ENDPOINT,
    POLLINATIONS_ENDPOINT,
    SILICONFLOW_ENDPOINT,
    MINIMAX_ENDPOINT,
    default_settings,
    migrateChatCompletionSettings,
    settingsToUpdate,
} from './chat-completion-defaults.js';

export {
    settingsToUpdate,
    chat_completion_sources,
    custom_prompt_post_processing_types,
    reasoning_effort_types,
    verbosity_levels,
    tool_reasoning_modes,
    ZAI_ENDPOINT,
    POLLINATIONS_ENDPOINT,
    SILICONFLOW_ENDPOINT,
    MINIMAX_ENDPOINT,
    openai_messages_count,
    oai_settings,
    loadOpenAISettings,
    setOpenAIMessages,
    setOpenAIMessageExamples,
    setupChatCompletionPromptManager,
    sendOpenAIRequest,
    TokenHandler,
    IdentifierNotFoundError,
    Message,
    MessageCollection,
};

let openai_messages_count = 0;

const openai_max_stop_strings = 4;

const textCompletionModels = [
    'gpt-3.5-turbo-instruct',
    'gpt-3.5-turbo-instruct-0914',
    'text-davinci-003',
    'text-davinci-002',
    'text-davinci-001',
    'text-curie-001',
    'text-babbage-001',
    'text-ada-001',
    'code-davinci-002',
    'code-davinci-001',
    'code-cushman-002',
    'code-cushman-001',
    'text-davinci-edit-001',
    'code-davinci-edit-001',
    'text-embedding-ada-002',
    'text-similarity-davinci-001',
    'text-similarity-curie-001',
    'text-similarity-babbage-001',
    'text-similarity-ada-001',
    'text-search-davinci-doc-001',
    'text-search-curie-doc-001',
    'text-search-babbage-doc-001',
    'text-search-ada-doc-001',
    'code-search-babbage-code-001',
    'code-search-ada-code-001',
];

/** @type {{ logitBias: object, dropped: string[] } | undefined} */
let biasCache = undefined;
export let model_list = [];


const interleaved_reasoning_providers = [
    chat_completion_sources.OPENROUTER,
    chat_completion_sources.CUSTOM,
];


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
 * @param {ChatMessage[]} chat
 * @returns {object[]}
 */
function setOpenAIMessages(chat) {
    let j = 0;
    const messages = [];
    const currentApi = oai_settings.chat_completion_source;
    const currentModel = getChatCompletionModel();

    for (let i = chat.length - 1; i >= 0; i--) {
        let role = chat[j].is_user ? 'user' : 'assistant';
        let content = chat[j].mes;

        if (chat[j].extra?.[IGNORE_SYMBOL]) {
            j++;
            continue;
        }

        if (chat[j].extra?.type === system_message_types.NARRATOR) {
            role = 'system';
        }

        switch (oai_settings.names_behavior) {
            case character_names_behavior.NONE:
                break;
            case character_names_behavior.DEFAULT:
                if ((selected_group && chat[j].name !== name1) || (chat[j].force_avatar && chat[j].name !== name1 && chat[j].extra?.type !== system_message_types.NARRATOR)) {
                    content = `${chat[j].name}: ${content}`;
                }
                break;
            case character_names_behavior.CONTENT:
                if (chat[j].extra?.type !== system_message_types.NARRATOR) {
                    content = `${chat[j].name}: ${content}`;
                }
                break;
            case character_names_behavior.COMPLETION:
                break;
            default:
                break;
        }

        content = content.replace(/\r/gm, '');

        const name = chat[j].name;
        const media = chat[j]?.extra?.media;
        const mediaDisplay = getMediaDisplay(chat[j]);
        const mediaIndex = getMediaIndex(chat[j]);
        const invocations = chat[j]?.extra?.tool_invocations?.slice();

        const originApi = chat[j]?.extra?.api;
        const originModel = chat[j]?.extra?.model;
        const isSameModel = originApi === currentApi && originModel === currentModel;
        const isOtherGroupMember = selected_group && chat[j].name !== name2;
        const signature = isSameModel && !isOtherGroupMember ? chat[j]?.extra?.reasoning_signature : null;
        const reasoning = isSameModel && !isOtherGroupMember ? (reasoningOf(chat[j]?.extra) ?? '') : '';

        if (Array.isArray(invocations) && invocations.length > 0) {
            invocations.forEach((invocation, index) => {
                if (!isSameModel && (invocation.signature || invocation.reasoning)) {
                    const cloneInvocation = structuredClone(invocation);
                    delete cloneInvocation.signature;
                    delete cloneInvocation.reasoning;
                    invocations[index] = cloneInvocation;
                }
            });
        }

        messages[i] = { 'role': role, 'content': content, name: name, 'media': media, 'mediaDisplay': mediaDisplay, 'mediaIndex': mediaIndex, 'invocations': invocations, 'signature': signature, 'reasoning': reasoning };
        j++;
    }

    return messages;
}

/**
 * @param {string[]} mesExamplesArray
 * @returns {object[]}
 */
function setOpenAIMessageExamples(mesExamplesArray) {
    const examples = [];
    for (let item of mesExamplesArray) {
        let replaced = item.replace(/<START>/i, '{Example Dialogue:}').replace(/\r/gm, '');
        let parsed = parseExampleIntoIndividual(replaced, true);
        examples.push(parsed);
    }
    return examples;
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

    promptManager.tryGenerate = () => {
        if (getCurrentCharacter()) {
            return Generate('normal', {}, true);
        } else {
            return Promise.resolve();
        }
    };

    promptManager.tokenHandler = tokenHandler;

    promptManager.init(configuration, openAiSettings);
    promptManager.render(false);

    return promptManager;
}

/**
 * @param {string} messageExampleString
 * @param {boolean} appendNamesForGroup
 * @returns {Message[]}
 */
export function parseExampleIntoIndividual(messageExampleString, appendNamesForGroup = true) {
    const groupBotNames = getGroupNames().map(name => `${name}:`);

    let result = [];
    let tmp = messageExampleString.split('\n');
    let cur_msg_lines = [];
    let in_user = false;
    let in_bot = false;
    let botName = name2;

    function add_msg(name, role, system_name) {
        let parsed_msg = cur_msg_lines.join('\n').replace(name + ':', '').trim();

        if (appendNamesForGroup && selected_group && ['example_user', 'example_assistant'].includes(system_name)) {
            parsed_msg = `${name}: ${parsed_msg}`;
        }

        result.push({ 'role': role, 'content': parsed_msg, 'name': system_name });
        cur_msg_lines = [];
    }
    for (let i = 1; i < tmp.length; i++) {
        let cur_str = tmp[i];
        if (cur_str.startsWith(name1 + ':')) {
            in_user = true;
            if (in_bot) {
                add_msg(botName, 'system', 'example_assistant');
            }
            in_bot = false;
        } else if (cur_str.startsWith(name2 + ':') || groupBotNames.some(n => cur_str.startsWith(n))) {
            if (!cur_str.startsWith(name2 + ':') && groupBotNames.length) {
                botName = cur_str.split(':')[0];
            }

            in_bot = true;
            if (in_user) {
                add_msg(name1, 'system', 'example_user');
            }
            in_user = false;
        }
        cur_msg_lines.push(cur_str);
    }
    if (in_user) {
        add_msg(name1, 'system', 'example_user');
    } else if (in_bot) {
        add_msg(botName, 'system', 'example_assistant');
    }
    return result;
}

export function formatWorldInfo(value, { wiFormat = null } = {}) {
    if (!value) {
        return '';
    }

    const format = wiFormat ?? oai_settings.wi_format;

    if (!format.trim()) {
        return value;
    }

    return stringFormat(format, value);
}

/**
 * @param {Prompt[]} prompts
 * @param {Object[]} messages
 * @returns {Promise<Object[]>}
 */
async function populationInjectionPrompts(prompts, messages) {
    let totalInsertedMessages = 0;

    const roleTypes = {
        'system': extension_prompt_roles.SYSTEM,
        'user': extension_prompt_roles.USER,
        'assistant': extension_prompt_roles.ASSISTANT,
    };

    const maxDepth = getExtensionPromptMaxDepth();
    for (let i = 0; i <= maxDepth; i++) {
        const depthPrompts = prompts.filter(prompt => prompt.injection_depth === i && prompt.content);

        const roleMessages = [];
        const separator = '\n';
        const wrap = false;

        const extensionPromptsOrder = '100';
        const orderGroups = {
            [extensionPromptsOrder]: [],
        };
        for (const prompt of depthPrompts) {
            const order = prompt.injection_order ?? 100;
            if (!orderGroups[order]) {
                orderGroups[order] = [];
            }
            orderGroups[order].push(prompt);
        }

        const orders = Object.keys(orderGroups).sort((a, b) => +b - +a);
        for (const order of orders) {
            const orderPrompts = orderGroups[order];

            const roles = ['system', 'user', 'assistant'];
            for (const role of roles) {
                const rolePrompts = orderPrompts
                    .filter(prompt => prompt.role === role)
                    .map(x => x.content)
                    .join(separator);

                const extensionPrompt = order === extensionPromptsOrder
                    ? await getExtensionPrompt(extension_prompt_types.IN_CHAT, i, separator, roleTypes[role], wrap)
                    : '';
                const jointPrompt = [rolePrompts, extensionPrompt].filter(x => x).map(x => x.trim()).join(separator);

                if (jointPrompt && jointPrompt.length) {
                    roleMessages.push({ 'role': role, 'content': jointPrompt, injected: true });
                }
            }
        }

        if (roleMessages.length) {
            const injectIdx = i + totalInsertedMessages;
            messages.splice(injectIdx, 0, ...roleMessages);
            totalInsertedMessages += roleMessages.length;
        }
    }

    messages = messages.reverse();
    return messages;
}

/**
 * @param {object[]} messages
 * @param {import('./PromptManager').PromptCollection} prompts
 * @param {ChatCompletion} chatCompletion
 * @param type
 * @param cyclePrompt
 */
async function populateChatHistory(messages, prompts, chatCompletion, type = null, cyclePrompt = null) {
    if (!prompts.has('chatHistory')) {
        return;
    }

    chatCompletion.add(new MessageCollection('chatHistory'), prompts.index('chatHistory'));

    const newChat = selected_group ? oai_settings.new_group_chat_prompt : oai_settings.new_chat_prompt;
    const newChatMessage = await Message.createAsync('system', substituteParams(newChat), 'newMainChat');
    chatCompletion.reserveBudget(newChatMessage);

    let groupNudgeMessage = null;
    const noGroupNudgeTypes = ['impersonate'];
    if (selected_group && prompts.has('groupNudge') && !noGroupNudgeTypes.includes(type)) {
        groupNudgeMessage = await Message.fromPromptAsync(prompts.get('groupNudge'));
        chatCompletion.reserveBudget(groupNudgeMessage);
    }

    let continueMessageCollection = null;
    if (type === 'continue' && cyclePrompt && !oai_settings.continue_prefill) {
        const promptObject = {
            identifier: 'continueNudge',
            role: 'system',
            content: substituteParamsExtended(oai_settings.continue_nudge_prompt, { lastChatMessage: String(cyclePrompt).trim() }),
            system_prompt: true,
        };
        continueMessageCollection = new MessageCollection('continueNudge');
        const continueMessageIndex = messages.findLastIndex(x => !x.injected);
        if (continueMessageIndex >= 0) {
            const continueMessage = messages.splice(continueMessageIndex, 1)[0];
            const prompt = new Prompt(continueMessage);
            const chatMessage = await Message.fromPromptAsync(promptManager.preparePrompt(prompt));
            continueMessageCollection.add(chatMessage);
        }
        const continueNudgePrompt = new Prompt(promptObject);
        const preparedNudgePrompt = promptManager.preparePrompt(continueNudgePrompt);
        const continueNudgeMessage = await Message.fromPromptAsync(preparedNudgePrompt);
        continueMessageCollection.add(continueNudgeMessage);
        chatCompletion.reserveBudget(continueMessageCollection);
    }

    const lastChatPrompt = messages[messages.length - 1];
    const message = await Message.createAsync('user', oai_settings.send_if_empty, 'emptyUserMessageReplacement');
    if (lastChatPrompt && lastChatPrompt.role === 'assistant' && oai_settings.send_if_empty && chatCompletion.canAfford(message)) {
        chatCompletion.insert(message, 'chatHistory');
    }

    const imageInlining = isImageInliningSupported();
    const videoInlining = isVideoInliningSupported();
    const audioInlining = isAudioInliningSupported();
    const canUseTools = ToolManager.isToolCallingSupported();
    const includeSignature = isReasoningSignatureSupported();
    const isToolReasoningProvider = interleaved_reasoning_providers.includes(oai_settings.chat_completion_source);
    const toolReasoningMode = isToolReasoningProvider
        ? getEffectiveToolReasoningMode()
        : tool_reasoning_modes.DISABLED;
    const includeToolReasoning = toolReasoningMode !== tool_reasoning_modes.DISABLED;
    const lastUserIdx = messages.findLastIndex(x => x.role === 'user');

    const chatPool = [...messages].reverse();
    for (let index = 0; index < chatPool.length; index++) {
        const chatPrompt = chatPool[index];

        const prompt = new Prompt(chatPrompt);
        prompt.identifier = `chatHistory-${messages.length - index}`;
        const chatMessage = await Message.fromPromptAsync(promptManager.preparePrompt(prompt));

        if (promptManager.serviceSettings.names_behavior === character_names_behavior.COMPLETION && prompt.name) {
            const messageName = promptManager.isValidName(prompt.name) ? prompt.name : promptManager.sanitizeName(prompt.name);
            await chatMessage.setName(messageName);
        }

        /**
         * @param {MediaAttachment} media
         */
        async function inlineMediaAttachment(media) {
            if (!media || !media.url) {
                return;
            }
            if (!media.type) {
                media.type = MEDIA_TYPE.IMAGE;
            }
            if (imageInlining && media.type === MEDIA_TYPE.IMAGE) {
                await chatMessage.addImage(media.url);
            }
            if (videoInlining && media.type === MEDIA_TYPE.VIDEO) {
                await chatMessage.addVideo(media.url);
            }
            if (audioInlining && media.type === MEDIA_TYPE.AUDIO) {
                await chatMessage.addAudio(media.url);
            }
        }

        if (Array.isArray(chatPrompt.media) && chatPrompt.media.length) {
            if (chatPrompt.mediaDisplay === MEDIA_DISPLAY.LIST) {
                for (const media of chatPrompt.media) {
                    await inlineMediaAttachment(media);
                }
            }
            if (chatPrompt.mediaDisplay === MEDIA_DISPLAY.GALLERY) {
                const media = chatPrompt.media[chatPrompt.mediaIndex];
                await inlineMediaAttachment(media);
            }
        }

        if (canUseTools && Array.isArray(chatPrompt.invocations)) {
            const promptIdx = messages.indexOf(chatPrompt);
            const reasoningIsEligible = toolReasoningMode !== tool_reasoning_modes.DISABLED
                && promptIdx > lastUserIdx;
            let previousAssistantReasoning = '';
            if (reasoningIsEligible) {
                if (toolReasoningMode === tool_reasoning_modes.ACTIVE_CHAIN) {
                    for (let idx = promptIdx - 1; idx > lastUserIdx; idx--) {
                        const candidate = messages[idx];
                        if (candidate?.role === 'tool') {
                            continue;
                        }
                        if (candidate?.role === 'assistant' && Array.isArray(candidate.invocations)) {
                            continue;
                        }
                        const hasAssistantText = candidate?.role === 'assistant'
                            && !Array.isArray(candidate.invocations)
                            && typeof candidate.content === 'string'
                            && candidate.content.trim().length > 0;
                        if (hasAssistantText) {
                            previousAssistantReasoning = String(candidate.reasoning ?? '');
                        }
                        break;
                    }
                } else if (toolReasoningMode === tool_reasoning_modes.SINCE_LAST_USER) {
                    for (let idx = promptIdx - 1; idx > lastUserIdx; idx--) {
                        const candidate = messages[idx];
                        const hasAssistantText = candidate?.role === 'assistant'
                            && !Array.isArray(candidate.invocations)
                            && typeof candidate.content === 'string'
                            && candidate.content.trim().length > 0;
                        if (!hasAssistantText) {
                            continue;
                        }
                        const candidateReasoning = String(candidate.reasoning ?? '');
                        if (candidateReasoning) {
                            previousAssistantReasoning = candidateReasoning;
                            break;
                        }
                    }
                }
            }
            /** @type {import('./tool-calling.js').ToolInvocation[]} */
            const invocations = chatPrompt.invocations.map(invocation => {
                const clone = structuredClone(invocation);
                if (!reasoningIsEligible) {
                    delete clone.reasoning;
                } else if (previousAssistantReasoning && !clone.reasoning) {
                    clone.reasoning = previousAssistantReasoning;
                }
                return clone;
            });
            const toolCallMessage = await Message.createAsync(chatMessage.role, undefined, 'toolCall-' + chatMessage.identifier);
            const toolResultMessages = await Promise.all(invocations.slice().reverse().map((invocation) => Message.createAsync('tool', invocation.result || '[No content]', invocation.id)));
            await toolCallMessage.setToolCalls(invocations, includeSignature, includeToolReasoning);
            if (chatCompletion.canAffordAll([toolCallMessage, ...toolResultMessages])) {
                for (const resultMessage of toolResultMessages) {
                    chatCompletion.insertAtStart(resultMessage, 'chatHistory');
                }
                chatCompletion.insertAtStart(toolCallMessage, 'chatHistory');
            } else {
                break;
            }

            continue;
        }

        if (includeSignature && chatPrompt.signature) {
            chatMessage.signature = chatPrompt.signature;
        }

        if (chatCompletion.canAfford(chatMessage)) {
            chatCompletion.insertAtStart(chatMessage, 'chatHistory');
        } else {
            break;
        }
    }

    chatCompletion.freeBudget(newChatMessage);
    chatCompletion.insertAtStart(newChatMessage, 'chatHistory');

    if (selected_group && groupNudgeMessage) {
        chatCompletion.freeBudget(groupNudgeMessage);
        chatCompletion.insertAtEnd(groupNudgeMessage, 'chatHistory');
    }

    if (type === 'continue' && continueMessageCollection) {
        chatCompletion.freeBudget(continueMessageCollection);
        chatCompletion.add(continueMessageCollection, -1);
    }
}

/**
 * @param {import('./PromptManager').PromptCollection} prompts
 * @param {ChatCompletion} chatCompletion
 * @param {Object[]} messageExamples
 */
async function populateDialogueExamples(prompts, chatCompletion, messageExamples) {
    if (!prompts.has('dialogueExamples')) {
        return;
    }

    chatCompletion.add(new MessageCollection('dialogueExamples'), prompts.index('dialogueExamples'));
    if (Array.isArray(messageExamples) && messageExamples.length) {
        const newExampleChat = await Message.createAsync('system', substituteParams(oai_settings.new_example_chat_prompt), 'newChat');
        for (const dialogue of [...messageExamples]) {
            const dialogueIndex = messageExamples.indexOf(dialogue);
            const chatMessages = [];

            for (let promptIndex = 0; promptIndex < dialogue.length; promptIndex++) {
                const prompt = dialogue[promptIndex];
                const role = 'system';
                const content = prompt.content || '';
                const identifier = `dialogueExamples ${dialogueIndex}-${promptIndex}`;

                const chatMessage = await Message.createAsync(role, content, identifier);
                await chatMessage.setName(prompt.name);
                chatMessages.push(chatMessage);
            }

            if (!chatCompletion.canAffordAll([newExampleChat, ...chatMessages])) {
                break;
            }

            chatCompletion.insert(newExampleChat, 'dialogueExamples');
            for (const chatMessage of chatMessages) {
                chatCompletion.insert(chatMessage, 'dialogueExamples');
            }
        }
    }
}

/**
 * @param {number} position
 * @returns {string|false}
 */
export function getPromptPosition(position) {
    if (position == extension_prompt_types.BEFORE_PROMPT) {
        return 'start';
    }

    if (position == extension_prompt_types.IN_PROMPT) {
        return 'end';
    }

    return false;
}

/**
 * @param {number} role
 * @returns {string}
 */
export function getPromptRole(role) {
    switch (role) {
        case extension_prompt_roles.SYSTEM:
            return 'system';
        case extension_prompt_roles.USER:
            return 'user';
        case extension_prompt_roles.ASSISTANT:
            return 'assistant';
        default:
            return 'system';
    }
}

/**
 * @param {import('./PromptManager.js').PromptCollection} prompts
 * @param {ChatCompletion} chatCompletion
 * @param {Object} options
 * @param {string} options.bias
 * @param {string} options.quietPrompt
 * @param {string} options.quietImage
 * @param {string} options.type
 * @param {string} options.cyclePrompt
 * @param {object[]} options.messages
 * @param {object[]} options.messageExamples
 * @returns {Promise<void>}
 */
async function populateChatCompletion(prompts, chatCompletion, { bias, quietPrompt, quietImage, type, cyclePrompt, messages, messageExamples }) {
    const addToChatCompletion = async (source, target = null) => {
        if (false === prompts.has(source)) return;

        if (promptManager.isPromptDisabledForActiveCharacter(source) && source !== 'main') {
            promptManager.log(`Skipping prompt ${source} because it is disabled`);
            return;
        }

        const prompt = prompts.get(source);

        if (prompt.injection_position === INJECTION_POSITION.ABSOLUTE) {
            promptManager.log(`Skipping prompt ${source} because it is an absolute prompt`);
            return;
        }

        const index = target ? prompts.index(target) : prompts.index(source);
        const collection = new MessageCollection(source);
        const message = await Message.fromPromptAsync(prompt);
        collection.add(message);
        chatCompletion.add(collection, index);
    };

    chatCompletion.reserveBudget(3);
    await addToChatCompletion('worldInfoBefore');
    await addToChatCompletion('main');
    await addToChatCompletion('worldInfoAfter');
    await addToChatCompletion('charDescription');
    await addToChatCompletion('charPersonality');
    await addToChatCompletion('scenario');
    await addToChatCompletion('personaDescription');

    chatCompletion.setOverriddenPrompts(prompts.overriddenPrompts);
    const controlPrompts = new MessageCollection('controlPrompts');

    const impersonateMessage = await Message.fromPromptAsync(prompts.get('impersonate')) ?? null;
    if (type === 'impersonate') controlPrompts.add(impersonateMessage);

    const quietPromptMessage = await Message.fromPromptAsync(prompts.get('quietPrompt')) ?? null;
    if (quietPromptMessage && quietPromptMessage.content) {
        if (isImageInliningSupported() && quietImage) {
            await quietPromptMessage.addImage(quietImage);
        }

        controlPrompts.add(quietPromptMessage);
    }

    chatCompletion.reserveBudget(controlPrompts);

    const systemPrompts = ['nsfw', 'jailbreak'];
    const userRelativePrompts = prompts.collection
        .filter((prompt) => false === prompt.system_prompt && prompt.injection_position !== INJECTION_POSITION.ABSOLUTE)
        .reduce((acc, prompt) => {
            acc.push(prompt.identifier);
            return acc;
        }, []);
    const absolutePrompts = prompts.collection
        .filter((prompt) => prompt.injection_position === INJECTION_POSITION.ABSOLUTE)
        .reduce((acc, prompt) => {
            acc.push(prompt);
            return acc;
        }, []);

    for (const identifier of [...systemPrompts, ...userRelativePrompts]) {
        await addToChatCompletion(identifier);
    }

    if (prompts.has('enhanceDefinitions')) await addToChatCompletion('enhanceDefinitions');

    if (bias && bias.trim().length) await addToChatCompletion('bias');

    const injectToMain = async (/** @type {Prompt} */ prompt, /** @type {string|number} */ position) => {
        if (chatCompletion.has('main')) {
            const message = await Message.fromPromptAsync(prompt);
            chatCompletion.insert(message, 'main', position);
        } else {
            const indexOfMain = absolutePrompts.findIndex(p => p.identifier === 'main');
            if (indexOfMain >= 0) {
                const main = absolutePrompts[indexOfMain];
                const promptCopy = new Prompt(prompt);
                promptCopy.role = main.role;
                promptCopy.injection_position = main.injection_position;
                promptCopy.injection_depth = main.injection_depth;
                promptCopy.injection_order = main.injection_order;
                const newIndex = position === 'end' ? indexOfMain + 1 : indexOfMain;
                absolutePrompts.splice(newIndex, 0, promptCopy);
            }
        }
    };

    const knownPrompts = [
        'summary',
        'authorsNote',
        'vectorsMemory',
        'vectorsDataBank',
        'smartContext',
    ];

    for (const key of knownPrompts) {
        if (prompts.has(key)) {
            const prompt = prompts.get(key);
            if (prompt.position) {
                await injectToMain(prompt, prompt.position);
            }
        }
    }

    for (const prompt of prompts.collection.filter(p => p.extension && p.position)) {
        await injectToMain(prompt, prompt.position);
    }

    if (ToolManager.canPerformToolCalls(type)) {
        const toolData = {};
        await ToolManager.registerFunctionToolsOpenAI(toolData);
        const toolMessage = [{ role: 'user', content: JSON.stringify(toolData) }];
        const toolTokens = await tokenHandler.countAsync(toolMessage);
        chatCompletion.reserveBudget(toolTokens);
    }

    if (type === 'continue' && oai_settings.continue_prefill && messages.length) {
        const chatMessage = messages.shift();
        const isAssistantRole = chatMessage.role === 'assistant';
        const supportsAssistantPrefill = oai_settings.chat_completion_source === chat_completion_sources.CLAUDE;
        const namesInCompletion = oai_settings.names_behavior === character_names_behavior.COMPLETION;
        const assistantPrefill = isAssistantRole && supportsAssistantPrefill ? substituteParams(oai_settings.assistant_prefill) : '';
        const messageContent = [assistantPrefill, chatMessage.content].filter(x => x).join('\n\n');
        const continueMessage = await Message.createAsync(chatMessage.role, messageContent, 'continuePrefill');
        chatMessage.name && namesInCompletion && await continueMessage.setName(promptManager.sanitizeName(chatMessage.name));
        controlPrompts.add(continueMessage);
        chatCompletion.reserveBudget(continueMessage);
    }

    messages = await populationInjectionPrompts(absolutePrompts, messages);

    if (power_user.pin_examples) {
        await populateDialogueExamples(prompts, chatCompletion, messageExamples);
        await populateChatHistory(messages, prompts, chatCompletion, type, cyclePrompt);
    } else {
        await populateChatHistory(messages, prompts, chatCompletion, type, cyclePrompt);
        await populateDialogueExamples(prompts, chatCompletion, messageExamples);
    }

    chatCompletion.freeBudget(controlPrompts);
    if (controlPrompts.collection.length) chatCompletion.add(controlPrompts);
}

/**
 * @param {Object} options
 * @param {string} options.scenario
 * @param {string} options.charPersonality
 * @param {string} options.name2
 * @param {string} options.worldInfoBefore
 * @param {string} options.worldInfoAfter
 * @param {string} options.charDescription
 * @param {string} options.quietPrompt
 * @param {string} options.bias
 * @param {Object} options.extensionPrompts
 * @param {string} options.systemPromptOverride
 * @param {string} options.jailbreakPromptOverride
 * @param {string} options.type
 * @returns {Promise<Object>}
 */
async function preparePromptsForChatCompletion({ scenario, charPersonality, name2, worldInfoBefore, worldInfoAfter, charDescription, quietPrompt, bias, extensionPrompts, systemPromptOverride, jailbreakPromptOverride, type }) {
    const scenarioText = scenario && oai_settings.scenario_format ? substituteParams(oai_settings.scenario_format) : (scenario || '');
    const charPersonalityText = charPersonality && oai_settings.personality_format ? substituteParams(oai_settings.personality_format) : (charPersonality || '');
    const groupNudge = substituteParams(oai_settings.group_nudge_prompt);
    const impersonationPrompt = oai_settings.impersonation_prompt ? substituteParams(oai_settings.impersonation_prompt) : '';

    const systemPrompts = [
        { role: 'system', content: formatWorldInfo(worldInfoBefore), identifier: 'worldInfoBefore' },
        { role: 'system', content: formatWorldInfo(worldInfoAfter), identifier: 'worldInfoAfter' },
        { role: 'system', content: charDescription, identifier: 'charDescription' },
        { role: 'system', content: charPersonalityText, identifier: 'charPersonality' },
        { role: 'system', content: scenarioText, identifier: 'scenario' },
        { role: 'system', content: impersonationPrompt, identifier: 'impersonate' },
        { role: 'system', content: quietPrompt, identifier: 'quietPrompt' },
        { role: 'system', content: groupNudge, identifier: 'groupNudge' },
        { role: 'assistant', content: bias, identifier: 'bias' },
    ];

    const summary = extensionPrompts['1_memory'];
    if (summary && summary.value) systemPrompts.push({
        role: getPromptRole(summary.role),
        content: summary.value,
        identifier: 'summary',
        position: getPromptPosition(summary.position),
    });

    const authorsNote = extensionPrompts['2_floating_prompt'];
    if (authorsNote && authorsNote.value) systemPrompts.push({
        role: getPromptRole(authorsNote.role),
        content: authorsNote.value,
        identifier: 'authorsNote',
        position: getPromptPosition(authorsNote.position),
    });

    const vectorsMemory = extensionPrompts['3_vectors'];
    if (vectorsMemory && vectorsMemory.value) systemPrompts.push({
        role: 'system',
        content: vectorsMemory.value,
        identifier: 'vectorsMemory',
        position: getPromptPosition(vectorsMemory.position),
    });

    const vectorsDataBank = extensionPrompts['4_vectors_data_bank'];
    if (vectorsDataBank && vectorsDataBank.value) systemPrompts.push({
        role: getPromptRole(vectorsDataBank.role),
        content: vectorsDataBank.value,
        identifier: 'vectorsDataBank',
        position: getPromptPosition(vectorsDataBank.position),
    });

    const smartContext = extensionPrompts.chromadb;
    if (smartContext && smartContext.value) systemPrompts.push({
        role: 'system',
        content: smartContext.value,
        identifier: 'smartContext',
        position: getPromptPosition(smartContext.position),
    });

    const personaDescription = getPersonaDescription();
    if (personaDescription && getPersonaDescriptionPosition() === persona_description_positions.IN_PROMPT) {
        systemPrompts.push({ role: 'system', content: personaDescription, identifier: 'personaDescription' });
    }

    const knownExtensionPrompts = [
        '1_memory',
        '2_floating_prompt',
        '3_vectors',
        '4_vectors_data_bank',
        'chromadb',
        'PERSONA_DESCRIPTION',
        'QUIET_PROMPT',
        'DEPTH_PROMPT',
    ];

    for (const key in extensionPrompts) {
        if (Object.hasOwn(extensionPrompts, key)) {
            const prompt = extensionPrompts[key];
            if (knownExtensionPrompts.includes(key)) continue;
            if (!extensionPrompts[key].value) continue;
            if (![extension_prompt_types.BEFORE_PROMPT, extension_prompt_types.IN_PROMPT].includes(prompt.position)) continue;

            const hasFilter = typeof prompt.filter === 'function';
            if (hasFilter && !await prompt.filter()) continue;

            systemPrompts.push({
                identifier: key.replace(/\W/g, '_'),
                position: getPromptPosition(prompt.position),
                role: getPromptRole(prompt.role),
                content: prompt.value,
                extension: true,
            });
        }
    }

    const prompts = promptManager.getPromptCollection(type);

    systemPrompts.forEach(prompt => {
        const collectionPrompt = prompts.get(prompt.identifier);

        if (collectionPrompt) {
            prompt.injection_position = collectionPrompt.injection_position ?? prompt.injection_position;
            prompt.injection_depth = collectionPrompt.injection_depth ?? prompt.injection_depth;
            prompt.injection_order = collectionPrompt.injection_order ?? prompt.injection_order;
            prompt.role = collectionPrompt.role ?? prompt.role;
        }

        const newPrompt = promptManager.preparePrompt(prompt);
        const markerIndex = prompts.index(prompt.identifier);

        if (-1 !== markerIndex) prompts.collection[markerIndex] = newPrompt;
        else prompts.add(newPrompt);
    });

    const systemPrompt = prompts.get('main') ?? null;
    const isSystemPromptDisabled = promptManager.isPromptDisabledForActiveCharacter('main');
    if (systemPromptOverride && systemPrompt && systemPrompt.forbid_overrides !== true && !isSystemPromptDisabled) {
        const mainOriginalContent = systemPrompt.content;
        systemPrompt.content = systemPromptOverride;
        const mainReplacement = promptManager.preparePrompt(systemPrompt, mainOriginalContent);
        prompts.override(mainReplacement, prompts.index('main'));
    }

    const jailbreakPrompt = prompts.get('jailbreak') ?? null;
    const isJailbreakPromptDisabled = promptManager.isPromptDisabledForActiveCharacter('jailbreak');
    if (jailbreakPromptOverride && jailbreakPrompt && jailbreakPrompt.forbid_overrides !== true && !isJailbreakPromptDisabled) {
        const jbOriginalContent = jailbreakPrompt.content;
        jailbreakPrompt.content = jailbreakPromptOverride;
        const jbReplacement = promptManager.preparePrompt(jailbreakPrompt, jbOriginalContent);
        prompts.override(jbReplacement, prompts.index('jailbreak'));
    }

    return prompts;
}

/**
 * @param {Object} content
 * @param {string} content.name2
 * @param {string} content.charDescription
 * @param {string} content.charPersonality
 * @param {string} content.scenario
 * @param {string} content.worldInfoBefore
 * @param {string} content.worldInfoAfter
 * @param {string} content.bias
 * @param {string} content.type
 * @param {string} content.quietPrompt
 * @param {string} content.quietImage
 * @param {string} content.cyclePrompt
 * @param {string} content.systemPromptOverride
 * @param {string} content.jailbreakPromptOverride
 * @param {object} content.extensionPrompts
 * @param {object[]} content.messages
 * @param {string[]} content.messageExamples
 * @param dryRun
 * @returns {Promise<(any[]|boolean)[]>}
 */
export async function prepareOpenAIMessages({
    name2,
    charDescription,
    charPersonality,
    scenario,
    worldInfoBefore,
    worldInfoAfter,
    bias,
    type,
    quietPrompt,
    quietImage,
    extensionPrompts,
    cyclePrompt,
    systemPromptOverride,
    jailbreakPromptOverride,
    messages,
    messageExamples,
}, dryRun) {
    if (!promptManager.activeCharacter && dryRun) return [null, false];

    const chatCompletion = new ChatCompletion();
    if (power_user.console_log_prompts) chatCompletion.enableLogging();

    const userSettings = promptManager.serviceSettings;
    chatCompletion.setTokenBudget(userSettings.openai_max_context, userSettings.openai_max_tokens);

    try {
        const prompts = await preparePromptsForChatCompletion({
            scenario,
            charPersonality,
            name2,
            worldInfoBefore,
            worldInfoAfter,
            charDescription,
            quietPrompt,
            bias,
            extensionPrompts,
            systemPromptOverride,
            jailbreakPromptOverride,
            type,
        });

        await populateChatCompletion(prompts, chatCompletion, { bias, quietPrompt, quietImage, type, cyclePrompt, messages, messageExamples });
    } catch (error) {
        if (error instanceof TokenBudgetExceededError) {
            toastr.error(t`Mandatory prompts exceed the context size.`);
            chatCompletion.log('Mandatory prompts exceed the context size.');
            promptManager.error = t`Not enough free tokens for mandatory prompts. Raise your token limit or disable custom prompts.`;
        } else if (error instanceof InvalidCharacterNameError) {
            toastr.warning(t`An error occurred while counting tokens: Invalid character name`);
            chatCompletion.log('Invalid character name');
            promptManager.error = t`The name of at least one character contained whitespaces or special characters. Please check your user and character name.`;
        } else {
            toastr.error(t`An unknown error occurred while counting tokens. Further information may be available in console.`);
            chatCompletion.log('----- Unexpected error while preparing prompts -----');
            chatCompletion.log(error);
            chatCompletion.log(error.stack);
            chatCompletion.log('----------------------------------------------------');
        }
    } finally {
        promptManager.setChatCompletion(chatCompletion);

        if (oai_settings.squash_system_messages && dryRun == false) {
            await chatCompletion.squashSystemMessages();
        }

        if (false === dryRun) promptManager.render(false);
    }

    const chat = chatCompletion.getChat();

    const eventData = { chat, dryRun };
    await eventSource.emit(event_types.CHAT_COMPLETION_PROMPT_READY, eventData);

    openai_messages_count = chat.filter(x => !x?.tool_calls && ['user', 'assistant', 'tool'].includes(x?.role)).length || 0;

    return [chat, promptManager.tokenHandler.counts];
}

/**
 * @param {object} data
 * @param {Response} response
 * @returns {string}
 */
function getChatCompletionErrorMessage(data, response) {
    const error = data?.error ?? data?.detail?.error;
    const message = typeof error === 'string' ? error : (error?.message || error?.code || error?.type);
    return String(message || (!response.ok && response.statusText) || t`Unknown error`);
}

/**
 * @param {Response} response
 * @param {string} decoded
 * @param {object} [options]
 * @param {boolean?} [options.quiet=false]
 */
export function tryParseStreamingError(response, decoded, { quiet = false } = {}) {
    try {
        const data = JSON.parse(decoded);

        if (!data) {
            return;
        }

        checkQuotaError(data, { quiet });
        checkModerationError(data, { quiet });

        if (data.error) {
            !quiet && toastr.error(getChatCompletionErrorMessage(data, response), 'Chat Completion API');
            throw new Error(data);
        }

        if (data.message) {
            !quiet && toastr.error(data.message, 'Chat Completion API');
            throw new Error(data);
        }

        if (data.detail) {
            !quiet && toastr.error(getChatCompletionErrorMessage(data, response), 'Chat Completion API');
            throw new Error(data);
        }
    } catch {
        // No JSON. Do nothing.
    }
}

/**
 * @param data
 * @param {object} [options]
 * @param {boolean?} [options.quiet=false]
 * @returns {void}
 * @throws {object}
 */
function checkQuotaError(data, { quiet = false } = {}) {
    if (!data) {
        return;
    }

    if (data.quota_error) {
        !quiet && renderTemplateAsync('quotaError').then((html) => Popup.show.text('Quota Error', html));

        throw new Error(data);
    }
}

/**
 * @param {any} data
 * @param {object} [options]
 * @param {boolean?} [options.quiet=false]
 */
function checkModerationError(data, { quiet = false } = {}) {
    const moderationError = data?.error?.message?.includes('requires moderation');
    if (moderationError && !quiet) {
        const moderationReason = `Reasons: ${data?.error?.metadata?.reasons?.join(', ') ?? '(N/A)'}`;
        const flaggedText = data?.error?.metadata?.flagged_input ?? '(N/A)';
        toastr.info(flaggedText, moderationReason, { timeOut: 10000 });
    }
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
 * @param {ChatCompletionSettings} settings
 * @param {string} model
 * @returns {string}
 */
function getReasoningEffort(settings = null, model = null) {
    settings = settings ?? oai_settings;
    model = model ?? getChatCompletionModel(settings);

    const reasoningEffortSources = [
        chat_completion_sources.OPENAI,
        chat_completion_sources.AZURE_OPENAI,
        chat_completion_sources.CUSTOM,
        chat_completion_sources.XAI,
        chat_completion_sources.AIMLAPI,
        chat_completion_sources.OPENROUTER,
        chat_completion_sources.POLLINATIONS,
        chat_completion_sources.PERPLEXITY,
        chat_completion_sources.COMETAPI,
        chat_completion_sources.ELECTRONHUB,
        chat_completion_sources.CHUTES,
        chat_completion_sources.DEEPSEEK,
        chat_completion_sources.FIREWORKS,
    ];

    if (!reasoningEffortSources.includes(settings.chat_completion_source)) {
        return settings.reasoning_effort;
    }

    function resolveReasoningEffort() {
        if (settings.chat_completion_source === chat_completion_sources.DEEPSEEK) {
            switch (settings.reasoning_effort) {
                case reasoning_effort_types.auto:
                    return undefined;
                case reasoning_effort_types.min:
                case reasoning_effort_types.low:
                    return reasoning_effort_types.low;
                case reasoning_effort_types.max:
                    return reasoning_effort_types.max;
                default:
                    return reasoning_effort_types.high;
            }
        }

        if (settings.chat_completion_source === chat_completion_sources.FIREWORKS) {
            switch (settings.reasoning_effort) {
                case reasoning_effort_types.auto:
                    return undefined;
                case reasoning_effort_types.min:
                    return reasoning_effort_types.low;
                default:
                    return settings.reasoning_effort;
            }
        }

        if (settings.chat_completion_source === chat_completion_sources.CUSTOM && /^koboldcpp\/(.+)$/.test(model)) {
            switch (settings.reasoning_effort) {
                case reasoning_effort_types.auto:
                    return undefined;
                case reasoning_effort_types.min:
                    return 'minimal';
                case reasoning_effort_types.low:
                    return 'low';
                case reasoning_effort_types.medium:
                    return 'medium';
                case reasoning_effort_types.high:
                    return 'high';
                case reasoning_effort_types.max:
                    return 'xhigh';
                default:
                    return settings.reasoning_effort;
            }
        }

        switch (settings.reasoning_effort) {
            case reasoning_effort_types.auto:
                return undefined;
            case reasoning_effort_types.min:
                if (chat_completion_sources.OPENROUTER === settings.chat_completion_source && !settings.show_thoughts) {
                    return 'none';
                }

                if ([chat_completion_sources.OPENAI, chat_completion_sources.AZURE_OPENAI].includes(settings.chat_completion_source)) {
                    if (/^(?:gpt-5\.(?:4|5|6)|gpt-6-(?:sol|luna))/.test(model)) {
                        return 'none';
                    }
                    if (/^gpt-5/.test(model)) {
                        return reasoning_effort_types.min;
                    }
                }

                return reasoning_effort_types.low;
            case reasoning_effort_types.max:
                if ([chat_completion_sources.OPENAI, chat_completion_sources.AZURE_OPENAI].includes(settings.chat_completion_source)
                    && /^gpt-6-/.test(model)) {
                    return reasoning_effort_types.max;
                }
                if ([chat_completion_sources.OPENAI, chat_completion_sources.AZURE_OPENAI].includes(settings.chat_completion_source)
                    && /^gpt-5\.6/.test(model)) {
                    return 'xhigh';
                }
                return reasoning_effort_types.high;
            default:
                return settings.reasoning_effort;
        }
    }

    const reasoningEffort = resolveReasoningEffort();

    if (settings.chat_completion_source === chat_completion_sources.ELECTRONHUB) {
        if (Array.isArray(model_list) && reasoningEffort) {
            const currentModel = model_list.find(m => m.id === model);
            const supportedEfforts = currentModel?.metadata?.supported_reasoning_efforts;
            if (Array.isArray(supportedEfforts) && supportedEfforts.includes(reasoningEffort)) {
                return reasoningEffort;
            }
            return undefined;
        }
    }

    return reasoningEffort;
}

/**
 * @param {ChatCompletionSettings} settings
 * @returns {string}
 */
function getVerbosity(settings = null) {
    settings = settings ?? oai_settings;

    if (settings.verbosity === verbosity_levels.auto) {
        return undefined;
    }

    return settings.verbosity;
}


const CHAT_COMPLETION_GPT_SOURCES = [
    chat_completion_sources.OPENAI,
    chat_completion_sources.AZURE_OPENAI,
    chat_completion_sources.OPENROUTER,
];

const CHAT_COMPLETION_MULTISWIPE_SOURCES = [
    chat_completion_sources.OPENAI,
    chat_completion_sources.AZURE_OPENAI,
    chat_completion_sources.CUSTOM,
    chat_completion_sources.XAI,
    chat_completion_sources.AIMLAPI,
    chat_completion_sources.MOONSHOT,
];

const CHAT_COMPLETION_NO_MULTISWIPE_TYPES = ['quiet', 'impersonate', 'continue'];

/**
 * @param {ChatCompletionSettings} settings
 * @param {string} model
 * @param {string} type
 * @param {ChatCompletionMessage[]} messages
 * @param {import('../script.js').AdditionalRequestOptions} options
 * @returns {Promise<object>}
 */
export async function createGenerationParameters(settings, model, type, messages, { jsonSchema = null } = {}) {
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

    const gptSources = CHAT_COMPLETION_GPT_SOURCES;

    const seedSupportedSources = [
        chat_completion_sources.OPENAI,
        chat_completion_sources.AZURE_OPENAI,
        chat_completion_sources.OPENROUTER,
        chat_completion_sources.MISTRALAI,
        chat_completion_sources.CUSTOM,
        chat_completion_sources.COHERE,
        chat_completion_sources.GROQ,
        chat_completion_sources.ELECTRONHUB,
        chat_completion_sources.NANOGPT,
        chat_completion_sources.XAI,
        chat_completion_sources.POLLINATIONS,
        chat_completion_sources.AIMLAPI,
        chat_completion_sources.VERTEXAI,
        chat_completion_sources.MAKERSUITE,
        chat_completion_sources.CHUTES,
    ];

    const proxySupportedSources = [
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

    const logprobsSupportedSources = [
        chat_completion_sources.OPENAI,
        chat_completion_sources.AZURE_OPENAI,
        chat_completion_sources.OPENROUTER,
        chat_completion_sources.CUSTOM,
        chat_completion_sources.DEEPSEEK,
        chat_completion_sources.XAI,
        chat_completion_sources.AIMLAPI,
        chat_completion_sources.CHUTES,
    ];

    const logitBiasSources = [
        chat_completion_sources.OPENAI,
        chat_completion_sources.AZURE_OPENAI,
        chat_completion_sources.OPENROUTER,
        chat_completion_sources.ELECTRONHUB,
        chat_completion_sources.CHUTES,
        chat_completion_sources.CUSTOM,
    ];

    const multiswipeSources = CHAT_COMPLETION_MULTISWIPE_SOURCES;

    const isO1 = gptSources.includes(settings.chat_completion_source) && ['o1-2024-12-17', 'o1'].includes(model);
    const isWorkersAIJsonMode = settings.chat_completion_source === chat_completion_sources.WORKERS_AI && jsonSchema;
    const stream = settings.stream_openai && type !== 'quiet' && !isO1 && !isWorkersAIJsonMode;

    const noMultiSwipeTypes = CHAT_COMPLETION_NO_MULTISWIPE_TYPES;
    const canMultiSwipe = settings.n > 1 && !noMultiSwipeTypes.includes(type) && multiswipeSources.includes(settings.chat_completion_source);

    let logit_bias = {};
    if (settings.bias_preset_selected
        && logitBiasSources.includes(settings.chat_completion_source)
        && Array.isArray(settings.bias_presets[settings.bias_preset_selected])
        && settings.bias_presets[settings.bias_preset_selected].length) {
        const bias = biasCache || await calculateLogitBias();
        biasCache = bias;
        logit_bias = bias.logitBias;
        if (bias.dropped.length > 0) {
            showDroppedEntries(getTokenizerAnswer('openai'), bias.dropped);
        }
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
        'stop': getCustomStoppingStrings(openai_max_stop_strings),
        'chat_completion_source': settings.chat_completion_source,
        'n': canMultiSwipe ? settings.n : undefined,
        'user_name': name1,
        'char_name': name2,
        'group_names': getGroupNames(),
        'include_reasoning': Boolean(settings.show_thoughts),
        'reasoning_effort': getReasoningEffort(settings, model),
        'enable_web_search': Boolean(settings.enable_web_search),
        'request_images': Boolean(settings.request_images),
        'request_image_resolution': String(settings.request_image_resolution),
        'request_image_aspect_ratio': String(settings.request_image_aspect_ratio),
        'custom_prompt_post_processing': settings.custom_prompt_post_processing,
        'verbosity': getVerbosity(settings),
    };

    if (settings.chat_completion_source === chat_completion_sources.AZURE_OPENAI) {
        generate_data.azure_base_url = settings.azure_base_url;
        generate_data.azure_deployment_name = settings.azure_deployment_name;
        generate_data.azure_api_version = settings.azure_api_version;
        if (/^gpt-[34]/.test(model)) {
            delete generate_data.reasoning_effort;
        }
    }

    if (!canMultiSwipe && ToolManager.canPerformToolCalls(type, settings, model)) {
        await ToolManager.registerFunctionToolsOpenAI(generate_data);
    }

    if (!Array.isArray(generate_data.stop) || !generate_data.stop.length) {
        delete generate_data.stop;
    }

    if (settings.reverse_proxy && proxySupportedSources.includes(settings.chat_completion_source)) {
        await validateReverseProxy();
        generate_data.reverse_proxy = settings.reverse_proxy;
        generate_data.proxy_password = settings.proxy_password;
    }

    const useLogprobs = !!power_user.request_token_probabilities;
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

    if (settings.chat_completion_source === chat_completion_sources.CLAUDE) {
        generate_data.top_k = Number(settings.top_k_openai);
        generate_data.use_sysprompt = settings.use_sysprompt;
        generate_data.stop = getCustomStoppingStrings();
        if (type !== 'quiet' && !(type === 'continue' && settings.continue_prefill)) {
            generate_data.assistant_prefill = type === 'impersonate'
                ? substituteParams(settings.assistant_impersonation)
                : substituteParams(settings.assistant_prefill);
        }
    }

    if (settings.chat_completion_source === chat_completion_sources.OPENROUTER) {
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

    if (settings.chat_completion_source === chat_completion_sources.NANOGPT) {
        generate_data.nanogpt_provider = settings.nanogpt_provider;
        generate_data.nanogpt_payg_override = settings.nanogpt_payg_override;
    }

    if (settings.chat_completion_source === chat_completion_sources.FIREWORKS && type !== 'quiet') {
        generate_data.chat_id = getCurrentChatId();
    }

    if ([chat_completion_sources.MAKERSUITE, chat_completion_sources.VERTEXAI].includes(settings.chat_completion_source)) {
        const stopStringsLimit = 5;
        generate_data.top_k = Number(settings.top_k_openai);
        generate_data.stop = getCustomStoppingStrings(stopStringsLimit).slice(0, stopStringsLimit).filter(x => x.length >= 1 && x.length <= 16);
        generate_data.use_sysprompt = settings.use_sysprompt;
        if (settings.chat_completion_source === chat_completion_sources.VERTEXAI) {
            generate_data.vertexai_auth_mode = settings.vertexai_auth_mode;
            generate_data.vertexai_region = settings.vertexai_region;
            generate_data.vertexai_express_project_id = settings.vertexai_express_project_id;
        }
    }

    if (settings.chat_completion_source === chat_completion_sources.MISTRALAI) {
        generate_data.safe_prompt = false;
        generate_data.stop = getCustomStoppingStrings();
    }

    if (settings.chat_completion_source === chat_completion_sources.CUSTOM) {
        generate_data.custom_url = settings.custom_url;
        generate_data.custom_include_body = substituteParams(settings.custom_include_body);
        generate_data.custom_exclude_body = substituteParams(settings.custom_exclude_body);
        generate_data.custom_include_headers = substituteParams(settings.custom_include_headers);
    }

    if (settings.chat_completion_source === chat_completion_sources.COHERE) {
        generate_data.top_p = Math.min(Math.max(Number(settings.top_p_openai), 0.01), 0.99);
        generate_data.top_k = Number(settings.top_k_openai);
        generate_data.frequency_penalty = Math.min(Math.max(Number(settings.freq_pen_openai), 0), 1);
        generate_data.presence_penalty = Math.min(Math.max(Number(settings.pres_pen_openai), 0), 1);
        generate_data.stop = getCustomStoppingStrings(5);
    }

    if (settings.chat_completion_source === chat_completion_sources.PERPLEXITY) {
        generate_data.top_k = Number(settings.top_k_openai);
        generate_data.frequency_penalty = Number(settings.freq_pen_openai);
        generate_data.presence_penalty = Number(settings.pres_pen_openai);
        delete generate_data.stop;
    }

    if (settings.chat_completion_source === chat_completion_sources.GROQ) {
        delete generate_data.logprobs;
        delete generate_data.logit_bias;
        delete generate_data.top_logprobs;
        delete generate_data.n;
    }

    if (settings.chat_completion_source === chat_completion_sources.DEEPSEEK) {
        generate_data.top_p = generate_data.top_p || Number.EPSILON;
    }

    if (settings.chat_completion_source === chat_completion_sources.XAI) {
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

    if (settings.chat_completion_source === chat_completion_sources.ELECTRONHUB) {
        generate_data.top_k = Number(settings.top_k_openai);
    }

    if (settings.chat_completion_source === chat_completion_sources.CHUTES) {
        generate_data.min_p = Number(settings.min_p_openai);
        generate_data.top_k = settings.top_k_openai > 0 ? Number(settings.top_k_openai) : undefined;
        generate_data.repetition_penalty = Number(settings.repetition_penalty_openai);
        generate_data.stop = getCustomStoppingStrings();
    }

    if (settings.chat_completion_source === chat_completion_sources.ZAI) {
        generate_data.top_p = generate_data.top_p || 0.01;
        generate_data.stop = getCustomStoppingStrings(1);
        generate_data.zai_endpoint = settings.zai_endpoint || ZAI_ENDPOINT.COMMON;
        delete generate_data.presence_penalty;
        delete generate_data.frequency_penalty;
    }

    if (settings.chat_completion_source === chat_completion_sources.POLLINATIONS) {
        generate_data.pollinations_endpoint = settings.pollinations_endpoint || POLLINATIONS_ENDPOINT.AUTHENTICATED;
    }

    if (settings.chat_completion_source === chat_completion_sources.SILICONFLOW) {
        generate_data.siliconflow_endpoint = settings.siliconflow_endpoint || SILICONFLOW_ENDPOINT.GLOBAL;
    }

    if (settings.chat_completion_source === chat_completion_sources.MINIMAX) {
        generate_data.minimax_endpoint = settings.minimax_endpoint || MINIMAX_ENDPOINT.GLOBAL;
        if (Number.isFinite(generate_data.temperature)) {
            generate_data.temperature = clamp(generate_data.temperature, Number.EPSILON, 1.0);
        }
    }

    if (settings.chat_completion_source === chat_completion_sources.WORKERS_AI) {
        generate_data.workers_ai_account_id = settings.workers_ai_account_id;
        generate_data.top_k = settings.top_k_openai > 0 ? Math.min(Number(settings.top_k_openai), 50) : undefined;
        generate_data.repetition_penalty = Number(settings.repetition_penalty_openai);
        generate_data.seed = settings.seed >= 1 ? Number(settings.seed) : undefined;
        generate_data.top_p = Math.max(Number(settings.top_p_openai), 0.001);
        delete generate_data.n;
        delete generate_data.logit_bias;
    }

    if (settings.chat_completion_source === chat_completion_sources.NANOGPT) {
        generate_data.top_k = Number(settings.top_k_openai);
        generate_data.min_p = Number(settings.min_p_openai);
        generate_data.repetition_penalty = Number(settings.repetition_penalty_openai);
        generate_data.top_a = Number(settings.top_a_openai);
    }

    if (settings.chat_completion_source === chat_completion_sources.MOONSHOT) {
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

    if ([chat_completion_sources.OPENAI, chat_completion_sources.AZURE_OPENAI].includes(settings.chat_completion_source) && /^(o1|o3|o4)/.test(model) ||
        (chat_completion_sources.OPENROUTER === settings.chat_completion_source && /^openai\/(o1|o3|o4)/.test(model))) {
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

    if (gptSources.includes(settings.chat_completion_source) && /gpt-6-/.test(model)) {
        generate_data.max_completion_tokens = generate_data.max_tokens;
        delete generate_data.max_tokens;
        if (model.includes('gpt-6-astra') || generate_data.reasoning_effort !== 'none') {
            delete generate_data.temperature;
            delete generate_data.top_p;
            delete generate_data.logprobs;
            delete generate_data.top_logprobs;
        }
    }

    if (/claude-(fable|opus-5|sonnet-5)/.test(model)) {
        delete generate_data.temperature;
        delete generate_data.top_p;
        delete generate_data.top_k;
        delete generate_data.frequency_penalty;
        delete generate_data.presence_penalty;
        if (settings.chat_completion_source !== chat_completion_sources.CLAUDE) {
            delete generate_data.reasoning_effort;
        }
    }

    if (jsonSchema) {
        generate_data.json_schema = jsonSchema;
    }

    return { generate_data, stream, canMultiSwipe };
}

/**
 * @param {string} type
 * @param {ChatCompletionMessage[]} messages
 * @param {AbortSignal?} signal
 * @param {import('../script.js').AdditionalRequestOptions} options
 * @returns {Promise<unknown>}
 * @throws {Error}
 */
async function sendOpenAIRequest(type, messages, signal, { jsonSchema = null, rawAction = null } = {}) {
    if (!signal) {
        signal = new AbortController().signal;
    }

    /** @type {object} */
    let generate_data;
    /** @type {boolean} */
    let stream;
    /** @type {boolean} */
    let canMultiSwipe;

    if (rawAction) {
        const model = getChatCompletionModel(oai_settings);
        const isO1 = CHAT_COMPLETION_GPT_SOURCES.includes(oai_settings.chat_completion_source) && ['o1-2024-12-17', 'o1'].includes(model);
        const isWorkersAIJsonMode = oai_settings.chat_completion_source === chat_completion_sources.WORKERS_AI && jsonSchema;
        stream = oai_settings.stream_openai && type !== 'quiet' && !isO1 && !isWorkersAIJsonMode;
        canMultiSwipe = oai_settings.n > 1 && !CHAT_COMPLETION_NO_MULTISWIPE_TYPES.includes(type) && CHAT_COMPLETION_MULTISWIPE_SOURCES.includes(oai_settings.chat_completion_source);
        generate_data = { ...rawAction, stream: stream };
    } else {
        const model = getChatCompletionModel(oai_settings);
        const settings = { ...oai_settings, openai_max_tokens: responseLengthFor('openai') };
        ({ generate_data, stream, canMultiSwipe } = await createGenerationParameters(settings, model, type, messages, { jsonSchema }));
    }

    await eventSource.emit(event_types.CHAT_COMPLETION_SETTINGS_READY, generate_data);

    const generate_url = '/api/backends/chat-completions/generate';
    const generationId = beginServerGeneration('/api/backends/chat-completions', { stream: !!stream });
    let response;
    try {
        response = await fetch(generate_url, {
            method: 'POST',
            body: JSON.stringify(generate_data),
            headers: { ...getRequestHeaders(), 'X-Generation-Id': generationId },
            signal: signal,
        });
    } catch (error) {
        if (!stream) takeInStoppedReply(generationId);
        throw error;
    } finally {
        if (!stream) endServerGeneration(generationId);
    }

    reportStoredHeader(response);
    if (!response.ok) {
        tryParseStreamingError(response, await response.text());
        throw new Error(`Got response status ${response.status}`);
    }
    if (stream) {
        if (response.headers.get('X-ST-Stream-Format') === 'compact-v1') {
            const reader = new ResumableCompactStreamReader(response, '/api/backends/chat-completions/generate/resume', getRequestHeaders);
            return async function* streamData() {
                const decoder = new CompactStreamDecoder();
                let text = '';
                const swipes = [];
                const toolCalls = [];
                const state = { reasoning: '', images: [], signature: '', toolSignatures: {}, toolCallHandoff: null, toolCallAborted: false };
                let swipeIndex = 0;
                while (true) {
                    const { done, value } = await reader.read();
                    const events = done ? decoder.flush() : decoder.push(value);

                    for (const event of events) {
                        if ('content' in event) {
                            if (canMultiSwipe && swipeIndex > 0) {
                                const idx = swipeIndex - 1;
                                swipes[idx] = (swipes[idx] || '') + event.content;
                            } else {
                                text += event.content;
                            }
                        } else if ('index' in event) {
                            swipeIndex = event.index;
                        } else if ('reasoning' in event) {
                            if (oai_settings.show_thoughts) {
                                state.reasoning += event.reasoning;
                            }
                        } else if ('assistantNodeId' in event) {
                            state.assistantNodeId = event.assistantNodeId;
                        } else if ('toolCallDelta' in event) {
                            // the server runs and stores tool calls itself
                        } else if ('control' in event) {
                            if (event.control?.stored) {
                                state.stored = event.control.stored;
                            } else if (event.control?.tool_call_handoff) {
                                state.toolCallHandoff = event.control.tool_call_handoff;
                            } else if (event.control?.tool_call_aborted) {
                                state.toolCallAborted = true;
                            } else if (event.control?.error) {
                                tryParseStreamingError(response, JSON.stringify(event.control));
                            } else if (event.control?.warnings) {
                                showTokenizerWarnings(event.control.warnings);
                            }
                        }
                    }

                    if (events.length) {
                        yield { text, swipes: swipes, logprobs: null, toolCalls: toolCalls, state: state };
                    }

                    if (done) return;
                }
            };
        }

        throw new Error('Expected X-ST-Stream-Format: compact-v1 - every streaming response from this route uses the compact binary protocol.');
    } else {
        const data = await response.json();
        reportStored(data?.stored);

        checkQuotaError(data);
        checkModerationError(data);

        if (data.error) {
            const message = getChatCompletionErrorMessage(data, response);
            toastr.error(message, t`API returned an error`);
            throw new Error(message);
        }

        if (type !== 'quiet') {
            const logprobs = parseChatCompletionLogprobs(data);
            delay(1).then(() => saveLogprobsForActiveMessage(logprobs, null));
        }

        return data;
    }
}

/**
 * @param {object} data
 * @param {object} state
 * @param {object} [options]
 * @param {string?} [options.chatCompletionSource]
 * @param {boolean?} [options.overrideShowThoughts]
 * @returns {string}
 */
export function getStreamingReply(data, state, { chatCompletionSource = null, overrideShowThoughts = null } = {}) {
    const chat_completion_source = chatCompletionSource ?? oai_settings.chat_completion_source;
    const show_thoughts = overrideShowThoughts ?? oai_settings.show_thoughts;

    if (chat_completion_source === chat_completion_sources.CLAUDE) {
        if (show_thoughts) {
            state.reasoning += data?.delta?.thinking || '';
        }
        return data?.delta?.text || '';
    } else if ([chat_completion_sources.MAKERSUITE, chat_completion_sources.VERTEXAI].includes(chat_completion_source)) {
        const inlineData = data?.candidates?.[0]?.content?.parts?.filter(x => x.inlineData && !x.thought)?.map(x => x.inlineData) || [];
        if (Array.isArray(inlineData) && inlineData.length > 0) {
            state.images.push(...inlineData.map(x => `data:${x.mimeType};base64,${x.data}`).filter(isDataURL));
        }
        if (show_thoughts) {
            state.reasoning += (data?.candidates?.[0]?.content?.parts?.filter(x => x.thought)?.map(x => x.text)?.[0] || '');
        }
        const parts = data?.candidates?.[0]?.content?.parts || [];
        parts.forEach((part) => {
            if (part.thoughtSignature && typeof part.text === 'string') {
                state.signature = part.thoughtSignature;
            }
        });
        return data?.candidates?.[0]?.content?.parts?.filter(x => !x.thought)?.map(x => x.text)?.[0] || '';
    } else if (chat_completion_source === chat_completion_sources.COHERE) {
        return data?.delta?.message?.content?.text || data?.delta?.message?.tool_plan || '';
    } else if (chat_completion_source === chat_completion_sources.DEEPSEEK) {
        if (show_thoughts) {
            state.reasoning += (data.choices?.filter(x => x?.delta?.reasoning_content)?.[0]?.delta?.reasoning_content || '');
        }
        return data.choices?.[0]?.delta?.content || '';
    } else if (chat_completion_source === chat_completion_sources.XAI) {
        if (show_thoughts) {
            state.reasoning += (data.choices?.filter(x => x?.delta?.reasoning_content)?.[0]?.delta?.reasoning_content || '');
        }
        return data.choices?.[0]?.delta?.content || '';
    } else if (chat_completion_source === chat_completion_sources.OPENROUTER) {
        const imageUrls = data?.choices?.[0]?.delta?.images?.filter(x => x.type === 'image_url')?.map(x => x?.image_url?.url) || [];
        if (Array.isArray(imageUrls) && imageUrls.length > 0) {
            state.images.push(...imageUrls.filter(isDataURL));
        }
        if (show_thoughts) {
            state.reasoning +=
                data.choices?.filter(x => x?.delta?.reasoning)?.[0]?.delta?.reasoning ??
                data.choices?.filter(x => x?.delta?.reasoning_content)?.[0]?.delta?.reasoning_content ??
                data.choices?.filter(x => x?.message?.reasoning)?.[0]?.message?.reasoning ??
                data.choices?.filter(x => x?.message?.reasoning_content)?.[0]?.message?.reasoning_content ??
                '';
        }
        const reasoningDetails = [
            ...(data?.choices?.[0]?.delta?.reasoning_details || []),
            ...(data?.choices?.[0]?.message?.reasoning_details || []),
        ];
        reasoningDetails.forEach((detail) => {
            if (detail.type === 'reasoning.encrypted' && detail.data) {
                const isToolLikeId = typeof detail.id === 'string' && /^(tool_|call_)/.test(detail.id);
                if (typeof detail.id === 'string' && detail.id.length > 0) {
                    state.toolSignatures[detail.id] = detail.data;
                }
                if (!isToolLikeId) {
                    state.signature = detail.data;
                }
            }
        });
        return data.choices?.[0]?.delta?.content ?? data.choices?.[0]?.message?.content ?? data.choices?.[0]?.text ?? '';
    } else if ([chat_completion_sources.CUSTOM, chat_completion_sources.POLLINATIONS, chat_completion_sources.AIMLAPI, chat_completion_sources.MOONSHOT, chat_completion_sources.COMETAPI, chat_completion_sources.ELECTRONHUB, chat_completion_sources.NANOGPT, chat_completion_sources.ZAI, chat_completion_sources.SILICONFLOW, chat_completion_sources.CHUTES, chat_completion_sources.WORKERS_AI, chat_completion_sources.FIREWORKS].includes(chat_completion_source)) {
        if (show_thoughts) {
            state.reasoning +=
                data.choices?.filter(x => x?.delta?.reasoning_content)?.[0]?.delta?.reasoning_content ??
                data.choices?.filter(x => x?.delta?.reasoning)?.[0]?.delta?.reasoning ??
                '';
        }
        return data.choices?.[0]?.delta?.content ?? data.choices?.[0]?.message?.content ?? data.choices?.[0]?.text ?? '';
    } else if (chat_completion_source === chat_completion_sources.MISTRALAI) {
        if (show_thoughts) {
            state.reasoning += (data.choices?.filter(x => x?.delta?.content?.[0]?.thinking)?.[0]?.delta?.content?.[0]?.thinking?.[0]?.text || '');
        }
        const content = data.choices?.[0]?.delta?.content ?? data.choices?.[0]?.message?.content ?? data.choices?.[0]?.text ?? '';
        return Array.isArray(content) ? content.map(x => x.text).filter(x => x).join('') : content;
    } else {
        return data.choices?.[0]?.delta?.content ?? data.choices?.[0]?.message?.content ?? data.choices?.[0]?.text ?? '';
    }
}

/**
 * @param {Object} data
 * @returns {import('./logprobs.js').TokenLogprobs[] | null}
 */
function parseChatCompletionLogprobs(data) {
    if (!data) {
        return null;
    }

    switch (oai_settings.chat_completion_source) {
        case chat_completion_sources.AIMLAPI:
            return Object.keys(data?.choices?.[0]?.logprobs ?? {}).includes('content')
                ? parseOpenAIChatLogprobs(data.choices[0]?.logprobs)
                : parseOpenAITextLogprobs(data.choices[0]?.logprobs);
        case chat_completion_sources.OPENAI:
        case chat_completion_sources.AZURE_OPENAI:
        case chat_completion_sources.OPENROUTER:
        case chat_completion_sources.DEEPSEEK:
        case chat_completion_sources.XAI:
        case chat_completion_sources.CUSTOM:
        case chat_completion_sources.CHUTES:
            if (!data.choices?.length) {
                return null;
            }
            return textCompletionModels.includes(getChatCompletionModel())
                ? parseOpenAITextLogprobs(data.choices[0]?.logprobs)
                : parseOpenAIChatLogprobs(data.choices[0]?.logprobs);
        default:
    }
    return null;
}

/**
 * @param {{content: { token: string, logprob: number, top_logprobs: { token: string, logprob: number }[] }[]}} logprobs
 * @returns {import('./logprobs.js').TokenLogprobs[] | null}
 */
function parseOpenAIChatLogprobs(logprobs) {
    const { content } = logprobs ?? {};

    if (!Array.isArray(content)) {
        return null;
    }

    /** @type {(x: { token: string, logprob: number }) => [string, number]} */
    const toTuple = (x) => [x.token, x.logprob];

    return content.map(({ token, logprob, top_logprobs = [] }) => {
        const chosenTopToken = top_logprobs.some((top) => token === top.token);
        /** @type {import('./logprobs.js').Candidate[]} */
        const topLogprobs = chosenTopToken
            ? top_logprobs.map(toTuple)
            : [...top_logprobs.map(toTuple), [token, logprob]];
        return { token, topLogprobs };
    });
}

/**
 * @param {{tokens: string[], token_logprobs: number[], top_logprobs: { token: string, logprob: number }[][]}} logprobs
 * @returns {import('./logprobs.js').TokenLogprobs[] | null}
 */
function parseOpenAITextLogprobs(logprobs) {
    const { tokens, token_logprobs, top_logprobs } = logprobs ?? {};

    if (!Array.isArray(tokens)) {
        return null;
    }

    return tokens.map((token, i) => {
        /** @type {any[]} */
        const topLogprobs = top_logprobs[i] ? Object.entries(top_logprobs[i]) : [];
        const chosenTopToken = topLogprobs.some(([topToken]) => token === topToken);
        if (!chosenTopToken) {
            topLogprobs.push([token, token_logprobs[i]]);
        }
        return { token, topLogprobs };
    });
}

/**
 * @returns {Promise<{ logitBias: object, dropped: string[] }>}
 */
async function calculateLogitBias() {
    const body = JSON.stringify(oai_settings.bias_presets[oai_settings.bias_preset_selected]);
    let logitBias = {};
    let dropped = [];

    try {
        const reply = await fetch('/api/backends/chat-completions/bias', {
            method: 'POST',
            headers: { ...getRequestHeaders(), 'X-ST-Connection-State': getTokenizerStateHeader('openai') },
            body,
        });

        logitBias = await reply.json();
        const droppedHeader = JSON.parse(reply.headers.get('X-ST-Tokenizer-Dropped') ?? '[]');
        dropped = Array.isArray(droppedHeader) ? droppedHeader.map(String) : [];
    } catch (err) {
        logitBias = {};
        console.error(err);
    }
    return { logitBias, dropped };
}

class TokenHandler {
    /**
     * @param {(messages: object[] | object, full?: boolean) => Promise<number>} countTokenAsyncFn
     */
    constructor(countTokenAsyncFn) {
        this.countTokenAsyncFn = countTokenAsyncFn;
        this.counts = {
            'start_chat': 0,
            'prompt': 0,
            'bias': 0,
            'nudge': 0,
            'jailbreak': 0,
            'impersonate': 0,
            'examples': 0,
            'conversation': 0,
        };
    }

    getCounts() {
        return this.counts;
    }

    resetCounts() {
        Object.keys(this.counts).forEach((key) => this.counts[key] = 0);
    }

    setCounts(counts) {
        this.counts = counts;
    }

    uncount(value, type) {
        this.counts[type] -= value;
    }

    /**
     * @param {object|any[]} messages
     * @param {boolean} [full]
     * @param {string} [type]
     * @returns {Promise<number>}
     */
    async countAsync(messages, full, type) {
        const token_count = await this.countTokenAsyncFn(messages, full);
        this.counts[type] += token_count;

        return token_count;
    }

    getTokensForIdentifier(identifier) {
        return this.counts[identifier] ?? 0;
    }

    getTotal() {
        return Object.values(this.counts).reduce((a, b) => a + (isNaN(b) ? 0 : b), 0);
    }

    log() {
        console.table({ ...this.counts, 'total': this.getTotal() });
    }
}


const tokenHandler = new TokenHandler(countTokensOpenAIAsync);

class IdentifierNotFoundError extends Error {
    constructor(identifier) {
        super(`Identifier ${identifier} not found.`);
        this.name = 'IdentifierNotFoundError';
    }
}

class TokenBudgetExceededError extends Error {
    constructor(identifier = '') {
        super(`Token budged exceeded. Message: ${identifier}`);
        this.name = 'TokenBudgetExceeded';
    }
}

class InvalidCharacterNameError extends Error {
    constructor(identifier = '') {
        super(`Invalid character name. Message: ${identifier}`);
        this.name = 'InvalidCharacterName';
    }
}

class Message {
    static tokensPerImage = 85;

    /** @type {number} */
    tokens;
    /** @type {string} */
    identifier;
    /** @type {string} */
    role;
    /** @type {string|any[]} */
    content;
    /** @type {string} */
    name;
    /** @type {object} */
    tool_call = null;
    /** @type {string?} */
    signature = null;
    /** @type {string?} */
    reasoning = null;

    /**
     * @constructor
     * @param {string} role
     * @param {string} content
     * @param {string} identifier
     * @private
     */
    constructor(role, content, identifier) {
        this.identifier = identifier;
        this.role = role;
        this.content = content;

        if (!this.role) {
            console.log(`Message role not set, defaulting to 'system' for identifier '${this.identifier}'`);
            this.role = 'system';
        }

        this.tokens = 0;
    }

    /**
     * @param {string} role
     * @param {string} content
     * @param {string} identifier
     * @returns {Promise<Message>}
     */
    static async createAsync(role, content, identifier) {
        const message = new Message(role, content, identifier);

        if (typeof message.content === 'string' && message.content.length > 0) {
            message.tokens = await tokenHandler.countAsync({ role: message.role, content: message.content });
        }

        return message;
    }

    /**
     * @param {import('./tool-calling.js').ToolInvocation[]} invocations
     * @param {boolean} includeSignature
     * @param {boolean} includeReasoning
     * @returns {Promise<void>}
     */
    async setToolCalls(invocations, includeSignature, includeReasoning = false) {
        this.tool_calls = invocations.map(i => ({
            id: i.id,
            type: 'function',
            function: {
                arguments: i.parameters,
                name: i.name,
            },
            ...(includeSignature && i.signature ? { signature: i.signature } : {}),
        }));
        const fallbackReasoning = invocations.find(i => typeof i.reasoning === 'string' && i.reasoning.length > 0)?.reasoning || null;
        this.reasoning = includeReasoning ? fallbackReasoning : null;
        this.tokens = await tokenHandler.countAsync({
            role: this.role,
            tool_calls: JSON.stringify(this.tool_calls),
            ...(this.reasoning ? { reasoning: this.reasoning } : {}),
        });
    }

    /**
     * @param {string} name
     * @returns {Promise<void>}
     */
    async setName(name) {
        this.name = name;
        this.tokens = await tokenHandler.countAsync({ role: this.role, content: this.content, name: this.name });
    }

    /**
     * @returns {any[]}
     */
    ensureContentIsArray() {
        const textContent = this.content;
        if (!Array.isArray(this.content)) {
            this.content = [];
            if (typeof textContent === 'string') {
                this.content.push({ type: 'text', text: textContent });
            }
        }
        return this.content;
    }

    /**
     * @param {string} image
     * @returns {Promise<void>}
     */
    async addImage(image) {
        this.content = this.ensureContentIsArray();
        const isDataUrl = isDataURL(image);
        if (!isDataUrl) {
            try {
                const response = await fetch(image, { method: 'GET', cache: 'force-cache' });
                if (!response.ok) throw new Error('Failed to fetch image');
                const blob = await response.blob();
                image = await getBase64Async(blob);
            } catch (error) {
                console.error('Image adding skipped', error);
                return;
            }
        }

        image = await this.compressImage(image);

        const quality = oai_settings.inline_image_quality || default_settings.inline_image_quality;
        this.content.push({ type: 'image_url', image_url: { 'url': image, 'detail': quality } });

        try {
            const tokens = await this.getImageTokenCost(image, quality);
            this.tokens += tokens;
        } catch (error) {
            this.tokens += Message.tokensPerImage;
            console.error('Failed to get image token cost', error);
        }
    }

    /**
     * @param {string} video
     * @returns {Promise<void>}
     */
    async addVideo(video) {
        this.content = this.ensureContentIsArray();
        const isDataUrl = isDataURL(video);
        if (!isDataUrl) {
            try {
                const response = await fetch(video, { method: 'GET', cache: 'force-cache' });
                if (!response.ok) throw new Error('Failed to fetch video');
                const blob = await response.blob();
                video = await getBase64Async(blob);
            } catch (error) {
                console.error('Video adding skipped', error);
                return;
            }
        }

        const quality = oai_settings.inline_image_quality || default_settings.inline_image_quality;
        this.content.push({ type: 'video_url', video_url: { 'url': video, 'detail': quality } });

        try {
            const duration = await getVideoDurationFromDataURL(video);
            this.tokens += 263 * Math.ceil(duration);
        } catch (error) {
            this.tokens += 263 * 40;
            console.error('Failed to get video token cost', error);
        }
    }

    /**
     * @param {string} audio
     * @returns {Promise<void>}
     */
    async addAudio(audio) {
        this.content = this.ensureContentIsArray();
        const isDataUrl = isDataURL(audio);
        if (!isDataUrl) {
            try {
                const response = await fetch(audio, { method: 'GET', cache: 'force-cache' });
                if (!response.ok) throw new Error('Failed to fetch audio');
                const blob = await response.blob();
                audio = await getBase64Async(blob);
            } catch (error) {
                console.error('Audio adding skipped', error);
                return;
            }
        }

        this.content.push({ type: 'audio_url', audio_url: { 'url': audio } });

        try {
            const duration = await getAudioDurationFromDataURL(audio);
            this.tokens += 32 * Math.ceil(duration);
        } catch (error) {
            const tokens = 32 * 300;
            this.tokens += tokens;
            console.error('Failed to get audio token cost', error);
        }
    }

    /**
     * @param {string} image
     * @returns {Promise<string>}
     */
    async compressImage(image) {
        const compressImageSources = [
            chat_completion_sources.OPENROUTER,
            chat_completion_sources.MAKERSUITE,
            chat_completion_sources.MISTRALAI,
            chat_completion_sources.VERTEXAI,
        ];
        const sizeThreshold = 2 * 1024 * 1024;
        const dataSize = image.length * 0.75;
        const safeMimeTypes = ['image/jpeg', 'image/png', 'image/webp'];
        const mimeType = image?.split(';')?.[0]?.split(':')?.[1];
        if (compressImageSources.includes(oai_settings.chat_completion_source) && dataSize > sizeThreshold) {
            const maxSide = 2048;
            image = await createThumbnail(image, maxSide, maxSide);
        } else if (!safeMimeTypes.includes(mimeType)) {
            image = await createThumbnail(image, null, null);
        }
        return image;
    }

    /**
     * @param {string} dataUrl
     * @param {string} quality
     * @returns {Promise<number>}
     */
    async getImageTokenCost(dataUrl, quality) {
        if (quality === 'low') {
            return Message.tokensPerImage;
        }

        const size = await getImageSizeFromDataURL(dataUrl);

        if (quality === 'auto' && size.width <= 512 && size.height <= 512) {
            return Message.tokensPerImage;
        }


        const scale = 2048 / Math.min(size.width, size.height);
        const scaledWidth = Math.round(size.width * scale);
        const scaledHeight = Math.round(size.height * scale);

        const finalScale = 768 / Math.min(scaledWidth, scaledHeight);
        const finalWidth = Math.round(scaledWidth * finalScale);
        const finalHeight = Math.round(scaledHeight * finalScale);

        const squares = Math.ceil(finalWidth / 512) * Math.ceil(finalHeight / 512);
        const tokens = squares * 170 + 85;
        return tokens;
    }

    /**
     * @param {Object} prompt
     * @returns {Promise<Message>}
     */
    static fromPromptAsync(prompt) {
        return Message.createAsync(prompt.role, prompt.content, prompt.identifier);
    }

    /**
     * @returns {number}
     */
    getTokens() { return this.tokens; }
}

/**
 * @class
 */
class MessageCollection {
    collection = [];
    identifier;

    /**
     * @constructor
     * @param {string} identifier
     * @param {...Object} items
     */
    constructor(identifier, ...items) {
        for (let item of items) {
            if (!(item instanceof Message || item instanceof MessageCollection)) {
                throw new Error('Only Message and MessageCollection instances can be added to MessageCollection');
            }
        }

        this.collection.push(...items);
        this.identifier = identifier;
    }

    /**
     * @returns {Array}
     */
    getChat() {
        return this.collection.reduce((acc, message) => {
            if (message.content || message.tool_calls) {
                acc.push({
                    role: message.role,
                    content: message.content,
                    ...(message.name && { name: message.name }),
                    ...(message.tool_calls && { tool_calls: message.tool_calls }),
                    ...(message.role === 'tool' && { tool_call_id: message.identifier }),
                    ...(message.signature && { signature: message.signature }),
                    ...(message.reasoning && { reasoning: message.reasoning }),
                });
            }
            return acc;
        }, []);
    }

    /**
     * @returns {Array}
     */
    getCollection() {
        return this.collection;
    }

    /**
     * @param {Object} item
     */
    add(item) {
        this.collection.push(item);
    }

    /**
     * @param {string} identifier
     * @returns {Object}
     */
    getItemByIdentifier(identifier) {
        return this.collection.find(item => item?.identifier === identifier);
    }

    /**
     * @param {string} identifier
     * @returns {boolean}
     */
    hasItemWithIdentifier(identifier) {
        return this.collection.some(message => message.identifier === identifier);
    }

    /**
     * @returns {number}
     */
    getTokens() {
        return this.collection.reduce((tokens, message) => tokens + message.getTokens(), 0);
    }

    /**
     * @returns {Message[]}
     */
    flatten() {
        return this.collection.reduce((acc, message) => {
            if (message instanceof MessageCollection) {
                acc.push(...message.flatten());
            } else {
                acc.push(message);
            }
            return acc;
        }, []);
    }
}

export class ChatCompletion {
    /**
     * @returns {Promise<void>}
     */
    async squashSystemMessages() {
        const excludeList = ['newMainChat', 'newChat', 'groupNudge'];
        this.messages.collection = this.messages.flatten();

        let lastMessage = null;
        let squashedMessages = [];

        for (let message of this.messages.collection) {
            if (message.role === 'system' && !message.content) {
                continue;
            }

            const shouldSquash = (message) => {
                return !excludeList.includes(message.identifier) && message.role === 'system' && !message.name;
            };

            if (shouldSquash(message)) {
                if (lastMessage && shouldSquash(lastMessage)) {
                    lastMessage.content += '\n' + message.content;
                    lastMessage.tokens = await tokenHandler.countAsync({ role: lastMessage.role, content: lastMessage.content });
                } else {
                    squashedMessages.push(message);
                    lastMessage = message;
                }
            } else {
                squashedMessages.push(message);
                lastMessage = message;
            }
        }

        this.messages.collection = squashedMessages;
    }

    constructor() {
        this.tokenBudget = 0;
        this.messages = new MessageCollection('root');
        this.loggingEnabled = false;
        this.overriddenPrompts = [];
    }

    /**
     * @returns {MessageCollection}
     */
    getMessages() {
        return this.messages;
    }

    /**
     * @param {number} context
     * @param {number} response
     */
    setTokenBudget(context, response) {
        this.log(`Prompt tokens: ${context}`);
        this.log(`Completion tokens: ${response}`);

        this.tokenBudget = context - response;

        this.log(`Token budget: ${this.tokenBudget}`);
    }

    /**
     * @param {Message|MessageCollection} collection
     * @param {number|null} position
     * @returns {ChatCompletion}
     */
    add(collection, position = null) {
        this.validateMessageCollection(collection);
        this.checkTokenBudget(collection, collection.identifier);

        if (null !== position && -1 !== position) {
            this.messages.collection[position] = collection;
        } else {
            this.messages.collection.push(collection);
        }

        this.decreaseTokenBudgetBy(collection.getTokens());

        this.log(`Added ${collection.identifier}. Remaining tokens: ${this.tokenBudget}`);

        return this;
    }

    /**
     * @param {Message} message
     * @param {string} identifier
     */
    insertAtStart(message, identifier) {
        this.insert(message, identifier, 'start');
    }

    /**
     * @param {Message} message
     * @param {string} identifier
     */
    insertAtEnd(message, identifier) {
        this.insert(message, identifier, 'end');
    }

    /**
     * @param {Message} message
     * @param {string} identifier
     * @param {string|number} position
     */
    insert(message, identifier, position = 'end') {
        this.validateMessage(message);
        this.checkTokenBudget(message, message.identifier);

        const index = this.findMessageIndex(identifier);
        if (message.content || message.tool_calls) {
            if ('start' === position) this.messages.collection[index].collection.unshift(message);
            else if ('end' === position) this.messages.collection[index].collection.push(message);
            else if (typeof position === 'number') this.messages.collection[index].collection.splice(position, 0, message);

            this.decreaseTokenBudgetBy(message.getTokens());

            this.log(`Inserted ${message.identifier} into ${identifier}. Remaining tokens: ${this.tokenBudget}`);
        }
    }

    /**
     * @param identifier
     */
    removeLastFrom(identifier) {
        const index = this.findMessageIndex(identifier);
        const message = this.messages.collection[index].collection.pop();

        if (!message) {
            this.log(`No message to remove from ${identifier}`);
            return;
        }

        this.increaseTokenBudgetBy(message.getTokens());

        this.log(`Removed ${message.identifier} from ${identifier}. Remaining tokens: ${this.tokenBudget}`);
    }

    /**
     * @param {Message|MessageCollection} message
     * @returns {boolean}
     */
    canAfford(message) {
        return 0 <= this.tokenBudget - message.getTokens();
    }

    /**
     * @param {Message[]} messages
     * @returns {boolean}
     */
    canAffordAll(messages) {
        return 0 <= this.tokenBudget - messages.reduce((total, message) => total + message.getTokens(), 0);
    }

    /**
     * @param {string} identifier
     * @returns {boolean}
     */
    has(identifier) {
        return this.messages.hasItemWithIdentifier(identifier);
    }

    /**
     * @returns {number}
     */
    getTotalTokenCount() {
        return this.messages.getTokens();
    }

    /**
     * @returns {Array}
     */
    getChat() {
        const chat = [];
        for (let item of this.messages.collection) {
            if (item instanceof MessageCollection) {
                chat.push(...item.getChat());
            } else if (item instanceof Message && (item.content || item.tool_calls)) {
                const message = {
                    role: item.role,
                    content: item.content,
                    ...(item.name ? { name: item.name } : {}),
                    ...(item.tool_calls ? { tool_calls: item.tool_calls } : {}),
                    ...(item.role === 'tool' ? { tool_call_id: item.identifier } : {}),
                    ...(item.signature ? { signature: item.signature } : {}),
                    ...(item.reasoning ? { reasoning: item.reasoning } : {}),
                };
                chat.push(message);
            } else {
                this.log(`Skipping invalid or empty message in collection: ${JSON.stringify(item)}`);
            }
        }
        return chat;
    }

    /**
     * @param {string} output
     */
    log(output) {
        if (this.loggingEnabled) console.log('[ChatCompletion] ' + output);
    }

    enableLogging() {
        this.loggingEnabled = true;
    }

    disableLogging() {
        this.loggingEnabled = false;
    }

    /**
     * @param {MessageCollection|Message} collection
     */
    validateMessageCollection(collection) {
        if (!(collection instanceof MessageCollection)) {
            console.log(collection);
            throw new Error('Argument must be an instance of MessageCollection');
        }
    }

    /**
     * @param {Message} message
     */
    validateMessage(message) {
        if (!(message instanceof Message)) {
            console.log(message);
            throw new Error('Argument must be an instance of Message');
        }
    }

    /**
     * @param {Message|MessageCollection} message
     * @param {string} identifier
     */
    checkTokenBudget(message, identifier) {
        if (!this.canAfford(message)) {
            throw new TokenBudgetExceededError(identifier);
        }
    }

    /**
     * @param {Message|MessageCollection|number} message
     */
    reserveBudget(message) {
        const tokens = typeof message === 'number' ? message : message.getTokens();
        this.decreaseTokenBudgetBy(tokens);
    }

    /**
     * @param {Message|MessageCollection} message
     */
    freeBudget(message) { this.increaseTokenBudgetBy(message.getTokens()); }

    /**
     * @param {number} tokens
     */
    increaseTokenBudgetBy(tokens) {
        this.tokenBudget += tokens;
    }

    /**
     * @param {number} tokens
     */
    decreaseTokenBudgetBy(tokens) {
        this.tokenBudget -= tokens;
    }

    /**
     * @param {string} identifier
     * @returns {number}
     */
    findMessageIndex(identifier) {
        const index = this.messages.collection.findIndex(item => item?.identifier === identifier);
        if (index < 0) {
            throw new IdentifierNotFoundError(identifier);
        }
        return index;
    }

    /**
     * @param {string[]} list
     */
    setOverriddenPrompts(list) {
        this.overriddenPrompts = list;
    }

    getOverriddenPrompts() {
        return this.overriddenPrompts ?? [];
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

    biasCache = undefined;
    if (presetChanged) {
        saveSettingsDebounced('oai_settings');
    }
}

function createNewLogitBiasEntry() {
    const entry = { id: uuidv4(), text: '', value: 0 };
    oai_settings.bias_presets[oai_settings.bias_preset_selected].push(entry);
    biasCache = undefined;
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
        biasCache = undefined;
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
        biasCache = undefined;
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

    await eventSource.emit(event_types.OAI_PRESET_IMPORT_READY, { data: presetBody, presetName: name });

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

    await eventSource.emit(event_types.OAI_PRESET_EXPORT_READY, preset);
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
        await eventSource.emit(event_types.PRESET_DELETED, { apiId: 'openai', name: nameToDelete });
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

    biasCache = undefined;
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
        await eventSource.emit(event_types.PRESET_CHANGED, { apiId: 'openai', name: presetName });
    });
}

async function onModelChange() {
    biasCache = undefined;
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
        const reply = await sendOpenAIRequest('quiet', [{ 'role': 'user', 'content': 'Hi' }], new AbortController().signal);
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
export function isImageInliningSupported() {
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
export function isVideoInliningSupported() {
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
export function isAudioInliningSupported() {
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

/**
 * @param {ChatCompletionSettings} settings
 * @returns {string}
 */
function getToolReasoningMode(settings = oai_settings) {
    const mode = String(settings.tool_reasoning_mode ?? '');
    if (Object.values(tool_reasoning_modes).includes(mode)) {
        return mode;
    }
    return tool_reasoning_modes.DISABLED;
}

/**
 * @param {ChatCompletionSettings} settings
 * @returns {string}
 */
function getEffectiveToolReasoningMode(settings = oai_settings) {
    if (!settings.show_thoughts) {
        return tool_reasoning_modes.DISABLED;
    }

    return getToolReasoningMode(settings);
}

/**
 * @param {ChatCompletionSettings} settings
 * @returns {boolean}
 */
export function isReasoningSignatureSupported(settings = oai_settings) {
    const isGoogle = [chat_completion_sources.VERTEXAI, chat_completion_sources.MAKERSUITE].includes(settings.chat_completion_source);
    const isOpenRouterGemini = settings.chat_completion_source === chat_completion_sources.OPENROUTER && /google\/gemini/i.test(settings.openrouter_model);
    return isGoogle || isOpenRouterGemini;
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
    onTokenizerChange(() => { biasCache = undefined; });
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
