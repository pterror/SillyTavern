import { readSettingsFor, settingsContextOf } from './settings-reads.js';
import { apiTokenLimits, generationMacroFacts, variablesBefore } from './macro-facts.js';
import { loadChatHistory } from './chat-request.js';
import { readExtraBooks } from './endpoints/characters.js';
import { resolveSpeakers } from './macro-scope.js';
import { getCharacterCardFields, getGroupCharacterDepthPrompts } from './character-card-fields.js';
import { buildChatCompletionMessages, buildChatCompletionMessageExamples, character_names_behavior } from './chat-completion-messages.js';
import { TokenHandler } from './prompt/chat-message.js';
import { chat_completion_sources } from './chat-completion-tool-capabilities.js';
import { resolveWorldInfoCandidates } from './world-info/candidate-resolution.js';
import { activateWorldInfoEntries } from './world-info/activation.js';
import { buildActivationRecord } from './world-info/activation-record.js';
import { userStore } from './user-stores.js';
import { bucketActivatedEntries } from './world-info/result-bucketing.js';
import { positionedEntries } from './prompt/injections.js';
import { outletMarkers, withoutOutletMarkers } from './prompt/model.js';
import { resolveAuthorsNote } from './authors-note.js';
import { persona_description_defaults, persona_description_positions } from '../public/scripts/constants.js';
import { GLOBAL_PROMPT_ORDER_ID, promptOrdersWithDefault, promptsWithDefaults } from '../public/scripts/prompt-manager-defaults.js';
import { chatCompletionSettingsWithDefaults } from '../public/scripts/chat-completion-defaults.js';
import { countChatCompletionMessages } from './endpoints/tokenizers.js';
import { resolveTokenizer, createTokenizerOutcome, tokenizerAnswer, tokenizerIdentity } from './tokenizer-resolve.js';
import { createStoredCounter } from './token-count-store.js';
import { formatMessageHistoryItem, getBiasStrings } from './prompt-line-formatting.js';
import { appendFileAttachments } from './file-attachment-inline.js';
import { substituteParams } from './macro-substitution.js';
import { exampleBlocks } from './example-blocks.js';
import { worldInfoGlobalsOf } from '../public/scripts/world-info-globals.js';

/**
 * @typedef {Pick<import('./users.js').UserDirectoryList, 'root'>} Directories
 * @typedef {ChatMessage & { persona?: string, _unchanged?: boolean, swipe_speaker_default?: { name?: string, is_user?: boolean }, }} TreeChatMessage
 * @typedef {import('./user-message-extra.js').SanitizedUserMessageExtra} SanitizedUserMessageExtra
 * @typedef {import('./world-info/activation.js').WIEntry} WIEntry
 * @typedef {import('./world-info/result-bucketing.js').WIActivatedEntry} WIActivatedEntry
 * @typedef {import('./world-info/result-bucketing.js').WIDepthEntry} WIDepthEntry
 * @typedef {import('./macro-substitution.js').SubstituteParamsContext} SubstituteParamsContext
 */

/**
 * @typedef {object} OaiSettingsShape
 * @property {string} [chat_completion_source]
 * @property {string} [claude_model]
 * @property {string} [openai_model]
 * @property {string} [google_model]
 * @property {string} [vertexai_model]
 * @property {string} [openrouter_model]
 * @property {string} [ai21_model]
 * @property {string} [mistralai_model]
 * @property {string} [custom_model]
 * @property {string} [custom_url]
 * @property {string} [custom_include_headers]
 * @property {string} [cohere_model]
 * @property {string} [perplexity_model]
 * @property {string} [groq_model]
 * @property {string} [siliconflow_model]
 * @property {string} [minimax_model]
 * @property {string} [electronhub_model]
 * @property {string} [chutes_model]
 * @property {string} [nanogpt_model]
 * @property {string} [deepseek_model]
 * @property {string} [aimlapi_model]
 * @property {string} [xai_model]
 * @property {string} [pollinations_model]
 * @property {string} [cometapi_model]
 * @property {string} [moonshot_model]
 * @property {string} [fireworks_model]
 * @property {string} [azure_openai_model]
 * @property {string} [zai_model]
 * @property {string} [workers_ai_model]
 * @property {number} [names_behavior]
 * @property {string} [inline_image_quality]
 * @property {string} [wi_format]
 * @property {number} [openai_max_context]
 * @property {number} [openai_max_tokens]
 * @property {boolean} [squash_system_messages]
 * @property {string} [scenario_format]
 * @property {string} [personality_format]
 * @property {string} [group_nudge_prompt]
 * @property {string} [impersonation_prompt]
 * @property {Record<string, any>[]} [prompts]
 * @property {{ character_id: string|number, order: { identifier: string, enabled: boolean }[] }[]} [prompt_order]
 * @property {boolean} [continue_prefill]
 * @property {string} [assistant_prefill]
 * @property {string} [new_chat_prompt]
 * @property {string} [new_group_chat_prompt]
 * @property {string} [continue_nudge_prompt]
 * @property {string} [send_if_empty]
 * @property {string} [new_example_chat_prompt]
 */

/**
 * @typedef {object} PowerUserSettingsShape
 * @property {boolean} [prefer_character_prompt]
 * @property {boolean} [prefer_character_jailbreak]
 * @property {Record<string, import('../public/scripts/power-user.js').PersonaRecord>} [persona_data]
 * @property {string} [user_prompt_bias]
 * @property {boolean} [console_log_prompts]
 * @property {boolean} [pin_examples]
 * @property {string} [media_display]
 */

/**
 * @typedef {object} WorldInfoSelectionShape
 * @property {string[]} [globalSelect]
 */

/**
 * @typedef {object} WorldInfoSettingsShape
 * @property {boolean} [world_info_include_names]
 * @property {number} [world_info_budget]
 * @property {number} [world_info_budget_cap]
 * @property {number} [world_info_depth]
 * @property {boolean} [world_info_recursive]
 * @property {number} [world_info_max_recursion_steps]
 * @property {number} [world_info_min_activations]
 * @property {number} [world_info_min_activations_depth_max]
 * @property {boolean} [world_info_use_group_scoring]
 * @property {WorldInfoSelectionShape} [world_info]
 * @property {number} [world_info_character_strategy]
 */

const PROMPT_ORDER_DUMMY_ID = GLOBAL_PROMPT_ORDER_ID;

const DEFAULT_SCENARIO_FORMAT = '{{scenario}}';
const DEFAULT_PERSONALITY_FORMAT = '{{personality}}';
const DEFAULT_GROUP_NUDGE_PROMPT = '[Write the next reply only as {{char}}.]';
const DEFAULT_NAMES_BEHAVIOR = character_names_behavior.DEFAULT;
const DEFAULT_INLINE_IMAGE_QUALITY = 'auto';

const GENERATION_TYPE_TRIGGERS = ['normal', 'continue', 'impersonate', 'swipe', 'regenerate'];

/**
 * @param {OaiSettingsShape} settings
 * @returns {string | null | undefined}
 */
export function getChatCompletionModel(settings) {
    switch (settings.chat_completion_source) {
        case chat_completion_sources.CLAUDE: return settings.claude_model;
        case chat_completion_sources.OPENAI: return settings.openai_model;
        case chat_completion_sources.MAKERSUITE: return settings.google_model;
        case chat_completion_sources.VERTEXAI: return settings.vertexai_model;
        case chat_completion_sources.OPENROUTER: return settings.openrouter_model !== 'OR_Website' ? settings.openrouter_model : null;
        case chat_completion_sources.AI21: return settings.ai21_model;
        case chat_completion_sources.MISTRALAI: return settings.mistralai_model;
        case chat_completion_sources.CUSTOM: return settings.custom_model;
        case chat_completion_sources.COHERE: return settings.cohere_model;
        case chat_completion_sources.PERPLEXITY: return settings.perplexity_model;
        case chat_completion_sources.GROQ: return settings.groq_model;
        case chat_completion_sources.SILICONFLOW: return settings.siliconflow_model;
        case chat_completion_sources.MINIMAX: return settings.minimax_model;
        case chat_completion_sources.ELECTRONHUB: return settings.electronhub_model;
        case chat_completion_sources.CHUTES: return settings.chutes_model;
        case chat_completion_sources.NANOGPT: return settings.nanogpt_model;
        case chat_completion_sources.DEEPSEEK: return settings.deepseek_model;
        case chat_completion_sources.AIMLAPI: return settings.aimlapi_model;
        case chat_completion_sources.XAI: return settings.xai_model;
        case chat_completion_sources.POLLINATIONS: return settings.pollinations_model;
        case chat_completion_sources.COMETAPI: return settings.cometapi_model;
        case chat_completion_sources.MOONSHOT: return settings.moonshot_model;
        case chat_completion_sources.FIREWORKS: return settings.fireworks_model;
        case chat_completion_sources.AZURE_OPENAI: return settings.azure_openai_model;
        case chat_completion_sources.ZAI: return settings.zai_model;
        case chat_completion_sources.WORKERS_AI: return settings.workers_ai_model;
        default: return '';
    }
}

/**
 * @param {import('./tokenizer-resolve.js').ResolvedTokenizer} resolved
 * @param {import('./tokenizer-resolve.js').TokenizerOutcome} [outcome]
 * @param {import('./users.js').UserDirectoryList} [directories]
 * @param {import('./token-count-store.js').StoredCounter} [storedCounter]
 * @returns {import('./prompt/chat-message.js').CountTokenAsyncFn}
 */
export function createOpenAITokenCounter(resolved, outcome = undefined, directories = undefined, storedCounter = undefined) {
    /** @type {import('./prompt/chat-message.js').CountTokenAsyncFn} */
    const countTokenAsyncFn = async function countTokenAsyncFn(messages) {
        const input = Array.isArray(messages) ? messages : [messages];
        const list = input
            .map(msg => Object.fromEntries(Object.entries(msg ?? {}).filter(([, value]) => typeof value === 'string')));
        if (storedCounter && input.every(isTextOnlyMessage)) {
            return storedCounter.countChatMessage(list);
        }
        return countChatCompletionMessages(resolved, list, outcome, directories);
    };
    return countTokenAsyncFn;
}

const TEXT_ONLY_MESSAGE_KEYS = new Set(['role', 'content', 'name']);

/**
 * @param {any} message
 * @returns {boolean}
 */
function isTextOnlyMessage(message) {
    return !!message && typeof message === 'object' && message.role !== 'tool'
        && Object.entries(message).every(([key, value]) => value === undefined
            || (TEXT_ONLY_MESSAGE_KEYS.has(key) && typeof value === 'string'));
}

/**
 * @param {import('./chat-request.js').ChatContext | undefined} chat
 * @param {{ nodeId?: string | null }} at
 */
async function resolveChatHistory(chat, { nodeId }) {
    return loadChatHistory(chat, { nodeId });
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {object} [params]
 * @param {string} [params.avatar]
 * @param {string} [params.groupId]
 * @param {import('./chat-request.js').ChatContext} [params.chatContext]
 * @param {string|null} [params.nodeId]
 * @param {string} [params.type]
 * @param {boolean} [params.isImpersonate]
 * @param {boolean} [params.isContinue]
 * @param {boolean} [params.isSwipe]
 * @param {boolean} [params.dryRun]
 * @param {string} [params.cyclePrompt]
 * @param {string} [params.textareaText]
 * @param {ChatMetadata} [params.chatMetadata]
 * @param {string} [params.userMessageText]
 * @param {SanitizedUserMessageExtra} [params.userMessageExtra]
 * @param {WIEntry[]} [params.worldInfoCandidates]
 * @param {string} [params.model]
 * @param {import('./chat-completion-tool-capabilities.js').ChatCompletionToolCapabilityModel[]} [params.modelList]
 * @param {string|number} [params.characterId]
 * @param {import('./prompt/chat-message.js').CountTokenAsyncFn} [params.countTokenAsyncFn]
 * @param {import('./prompt/chat-message.js').TokenHandler} [params.tokenHandler]
 * @param {string} [params.quietPrompt]
 * @param {string} [params.quietImage]
 * @param {number} [params.responseLength]
 * @param {object} [params.macroExtras]
 * @param {import('./macro-facts.js').PageMacroFacts} [params.pageFacts]
 * @param {import('./prompt/injections.js').PageInjections} [params.pageInjections]
 * @param {import('./llamacpp-props.js').LlamaCppPropsCheck} [params.llamaCppProps]
 * @param {import('./token-count-store.js').PendingTokenRows} [params.tokenCountRows]
 * @param {boolean} [params.skipWorldInfoAndNote] No lorebook entries and no author's note go in.
 * @returns {Promise<import('./prompt/chat-prompt.js').ChatCompletionPromptInput & { worldInfoCandidates: WIEntry[], activations: import('./world-info/activation-record.js').ActivationRecord | null, tokenizerOutcome: import('./tokenizer-resolve.js').TokenizerOutcome, countedWith: () => object|null, tokenCountRows: import('./token-count-store.js').PendingTokenRows }>}
 */
export async function resolveChatCompletionGenerationInput(directories, {
    avatar, groupId, chatContext, nodeId,
    type, isImpersonate = false, isContinue = false, isSwipe = false, dryRun,
    cyclePrompt = '', textareaText = '', chatMetadata: chatMetadataOverride, userMessageText, userMessageExtra,
    worldInfoCandidates: worldInfoCandidatesOverride,
    model: modelOverride, modelList, characterId = PROMPT_ORDER_DUMMY_ID,
    countTokenAsyncFn: countTokenAsyncFnOverride, tokenHandler: tokenHandlerOverride,
    quietPrompt, quietImage, responseLength,
    macroExtras = {}, llamaCppProps, tokenCountRows: tokenCountRowsParam, pageFacts = {}, pageInjections = {}, skipWorldInfoAndNote = false,
} = {}) {
    void isImpersonate; void isContinue;

    const {
        oai_settings: savedOaiSettings = /** @type {OaiSettingsShape} */ ({}),
        power_user: powerUser = /** @type {PowerUserSettingsShape} */ ({}),
        world_info_settings: worldInfoSettings = /** @type {WorldInfoSettingsShape} */ ({}),
        extension_settings: extensionSettings = {},
        username,
        user_avatar: userAvatar,
    } = /** @type {{ oai_settings?: OaiSettingsShape, power_user?: PowerUserSettingsShape, world_info_settings?: WorldInfoSettingsShape, extension_settings?: Record<string, any>, username?: string, user_avatar?: string, }} */ (readSettingsFor(directories, settingsContextOf({ avatar, groupId, chat: chatContext, nodeId }), [
        'oai_settings', 'power_user', 'world_info_settings', 'extension_settings', 'username', 'user_avatar',
    ]));
    const withDefaults = /** @type {OaiSettingsShape} */ (chatCompletionSettingsWithDefaults(savedOaiSettings));
    const oaiSettings = responseLength === undefined ? withDefaults : { ...withDefaults, openai_max_tokens: responseLength };
    const worldInfoSelection = /** @type {WorldInfoSelectionShape} */ (worldInfoSettings.world_info ?? {});
    const worldInfoGlobals = worldInfoGlobalsOf(worldInfoSettings);
    const activePersona = powerUser.persona_data?.[userAvatar] ?? {};

    const isGroup = Boolean(groupId);

    const { chat: loadedChat, metadata: loadedChatMetadata, resolvedNodeId, ambiguous: chatResolutionAmbiguous } =
        await resolveChatHistory(chatContext, { nodeId });
    const chatMetadata = chatMetadataOverride ?? loadedChatMetadata;
    const stateBefore = variablesBefore(chatMetadata, extensionSettings.variables?.global ?? {});

    const { name2, character, groupMembers: groupMemberNames, groupDisabledMembers } = await resolveSpeakers(directories, { avatar, groupId });
    const name1 = (username != null && username !== '') ? username : 'User';

    /** @type {TreeChatMessage | null} */
    const sentMessage = typeof userMessageText === 'string'
        ? { is_user: true, name: name1, mes: userMessageText, extra: /** @type {ChatMessageExtra} */ (userMessageExtra && typeof userMessageExtra === 'object' ? userMessageExtra : {}), send_date: Date.now() }
        : null;
    /** @type {TreeChatMessage[]} */
    const chat = sentMessage !== null ? [...loadedChat, sentMessage] : loadedChat;

    const promptChatBeforeFileInline = isSwipe && chat.length ? chat.slice(0, -1) : chat;

    /** @type {TreeChatMessage[]} */
    const promptChat = await Promise.all(promptChatBeforeFileInline.map(async (msg) => ({
        ...msg,
        mes: await appendFileAttachments(msg.extra ?? null, msg.mes ?? '', { directories }),
    })));

    const macroFacts = generationMacroFacts({
        powerUser, extensionSettings, mainApi: 'openai', type, pageFacts,
        ...apiTokenLimits({ oai_settings: oaiSettings }, 'openai'),
    });
    const fields = await getCharacterCardFields(directories, {
        avatar,
        groupId,
        preferCharacterPrompt: Boolean(powerUser.prefer_character_prompt),
        preferCharacterJailbreak: Boolean(powerUser.prefer_character_jailbreak),
        personaDescription: activePersona.description,
        chatMetadata,
        macroContext: { ...macroFacts, name1, isGroup, groupMembers: groupMemberNames, groupDisabledMembers, chat: promptChat, chatMetadata, outlets: outletMarkers },
    });

    const WORLD_INFO_METADATA_KEY = 'world_info';
    const charFilename = avatar != null ? avatar.replace(/\.[^/.]+$/, '') : null;
    let worldInfoCandidates = skipWorldInfoAndNote ? [] : worldInfoCandidatesOverride;
    if (worldInfoCandidates === undefined) {
        const characterExtraBooks = avatar != null ? await readExtraBooks(directories, avatar) : [];
        worldInfoCandidates = /** @type {WIEntry[]} */ (await resolveWorldInfoCandidates({
            directories,
            selectedWorldInfo: worldInfoSelection.globalSelect ?? [],
            character,
            characterExtraBooks,
            chatWorldName: /** @type {string | null} */ (chatMetadata[WORLD_INFO_METADATA_KEY] ?? null),
            personaWorldLorebook: activePersona.lorebook ?? null,
            worldInfoCharacterStrategy: worldInfoGlobals.world_info_character_strategy,
        }));
    }

    const model = modelOverride ?? getChatCompletionModel(oaiSettings);
    const namesBehavior = oaiSettings.names_behavior ?? DEFAULT_NAMES_BEHAVIOR;
    const imageQuality = oaiSettings.inline_image_quality ?? DEFAULT_INLINE_IMAGE_QUALITY;

    /** @type {SubstituteParamsContext} */
    const macroContext = {
        ...macroFacts,
        name1, name2, isGroup, groupMembers: groupMemberNames, groupDisabledMembers, model: model ?? undefined,
        characterCard: fields,
        chat: /** @type {import('./macro-substitution.js').ChatMessage[]} */ (promptChat), chatMetadata,
        outlets: outletMarkers,
    };

    const promptChatForMessages = promptChat.length
        ? [{ ...promptChat[0], mes: substituteParams(promptChat[0].mes ?? '', macroContext) }, ...promptChat.slice(1)]
        : promptChat;

    const messages = buildChatCompletionMessages(/** @type {import('./chat-completion-messages.js').ChatMessage[]} */ (promptChatForMessages), {
        isGroup, name1, name2, namesBehavior,
        currentApi: oaiSettings.chat_completion_source,
        currentModel: model ?? undefined,
        mediaDisplaySetting: powerUser.media_display,
    });

    const { promptBias } = getBiasStrings({
        textareaText, type, chat, userPromptBias: powerUser.user_prompt_bias, macroContext,
    });

    const tokenizerOutcome = createTokenizerOutcome();
    let tokenCountRows = tokenCountRowsParam ?? { counts: [], ids: [] };
    let tokenHandler = tokenHandlerOverride;
    if (!tokenHandler && countTokenAsyncFnOverride) {
        tokenHandler = new TokenHandler(countTokenAsyncFnOverride);
    }
    /** @type {() => object|null} */
    let countedWith = () => null;
    if (!tokenHandler) {
        const tokenizerState = { api: 'openai', source: oaiSettings.chat_completion_source, model: model ?? '', url: oaiSettings.custom_url };
        const resolved = await resolveTokenizer(
            tokenizerState,
            { directories, customIncludeHeaders: substituteParams(oaiSettings.custom_include_headers, macroContext), llamaCppProps },
        );
        countedWith = () => tokenizerAnswer(tokenizerState, resolved, tokenizerOutcome);
        const identityFacts = { llamaCppProps: llamaCppProps?.props };
        const storedCounter = createStoredCounter({
            resolved, identity: await tokenizerIdentity(resolved, identityFacts), directories,
            encodeOptions: { outcome: tokenizerOutcome }, identityFacts, pending: tokenCountRows,
        });
        tokenCountRows = storedCounter.pending;
        tokenHandler = new TokenHandler(createOpenAITokenCounter(resolved, tokenizerOutcome, directories, storedCounter));
    }

    const chatForWI = promptChat.map(x => worldInfoGlobals.world_info_include_names ? `${x.name}: ${x.mes}` : (x.mes ?? '')).reverse();
    const generationTrigger = type !== undefined && GENERATION_TYPE_TRIGGERS.includes(type) ? type : 'normal';
    const globalScanData = {
        personaDescription: withoutOutletMarkers(fields.persona),
        characterDescription: withoutOutletMarkers(fields.description),
        characterPersonality: withoutOutletMarkers(fields.personality),
        characterDepthPrompt: withoutOutletMarkers(fields.charDepthPrompt),
        scenario: withoutOutletMarkers(fields.scenario),
        creatorNotes: withoutOutletMarkers(fields.creatorNotes),
        trigger: generationTrigger,
    };
    /** @type {(text: string) => Promise<number>} */
    const countTokensForWorldInfo = async (text) => tokenHandler.countTokenAsyncFn([{ content: text }]);
    const noteSettings = extensionSettings.note ?? {};
    /** @type {ReturnType<typeof resolveAuthorsNote>} */
    const authorsNote = skipWorldInfoAndNote ? { disabled: true } : resolveAuthorsNote({ chatMetadata, noteSettings, chat: promptChat, avatar, hasCharacterOrGroup: Boolean(avatar) || Boolean(groupId) });
    const scanInjects = [
        ['quiet', quietPrompt],
        ['note', authorsNote.disabled === false && authorsNote.scan ? authorsNote.value : ''],
    ].filter(([, text]) => Boolean(text));
    const { activatedEntries, trace } = await activateWorldInfoEntries(worldInfoCandidates, chatForWI, {
        maxContext: oaiSettings.openai_max_context ?? 4095,
        globals: worldInfoGlobals,
        globalScanData, macroContext, countTokens: countTokensForWorldInfo,
        chatMetadata, isDryRun: Boolean(dryRun),
        entryFilterContext: { trigger: generationTrigger, characterFilename: charFilename ?? undefined },
        additionalScanInjects: scanInjects.map(([, text]) => text),
    });
    const activations = dryRun === true ? null : await buildActivationRecord(trace, {
        messages: promptChatBeforeFileInline.map(m => ({ nodeId: m === sentMessage ? null : (m.node_id ?? ''), text: m.mes ?? '' })).reverse(),
        injects: scanInjects.map(([label]) => label),
        books: (await userStore(directories)).lib.books,
    });
    const { worldInfoBefore, worldInfoAfter, worldInfoBeforeEntries, worldInfoAfterEntries, worldInfoExamples, worldInfoDepth: worldInfoDepthEntries, anBefore, anAfter, outletEntries } = bucketActivatedEntries(/** @type {WIActivatedEntry[]} */ (/** @type {unknown} */ (activatedEntries)));

    let continued = cyclePrompt;
    if (type === 'continue' && !continued && chat.length > 0) {
        continued = formatMessageHistoryItem(chat[chat.length - 1], false, false, { isGroup, name1, name2, macroContext });
        if (!continued.endsWith(' ')) continued += oaiSettings.continue_postfix ?? '';
    }

    const messageExamples = buildChatCompletionMessageExamples(
        exampleBlocks(fields.mesExamples ?? '', worldInfoExamples, { mainApi: 'openai', macroContext }),
        { isGroup, name1, name2, appendNamesForGroup: true },
    );

    const entries = positionedEntries({
        pageInjections, authorsNote, anBefore, anAfter,
        personaDescription: typeof activePersona.description === 'string' ? activePersona.description : '',
        personaDescriptionPosition: activePersona.position ?? persona_description_positions.IN_PROMPT,
        personaDescriptionDepth: activePersona.depth ?? persona_description_defaults.depth,
        personaDescriptionRole: activePersona.role ?? persona_description_defaults.role,
        worldInfoDepth: worldInfoDepthEntries,
        groupDepthPrompts: isGroup && avatar != null ? await getGroupCharacterDepthPrompts(directories, groupId, avatar, macroContext) : [],
        characterDepthPrompt: { text: fields.charDepthPrompt ?? '', depth: fields.charDepthPromptDepth, role: fields.charDepthPromptRole },
        substitute: text => substituteParams(text, macroContext),
    });

    const resolved = {
        resolvedNodeId,
        chatResolutionAmbiguous: Boolean(chatResolutionAmbiguous),
        variablesBefore: stateBefore,

        name2,
        charDescription: fields.description,
        charPersonality: fields.personality,
        scenario: fields.scenario,
        systemPromptOverride: fields.system,
        jailbreakPromptOverride: fields.jailbreak,
        personaDescription: activePersona.description,
        personaDescriptionPosition: activePersona.position ?? 0,

        worldInfoBefore,
        worldInfoAfter,
        worldInfoBeforeEntries,
        worldInfoAfterEntries,
        outletEntries,
        worldInfoCandidates,
        activations,
        wiFormat: oaiSettings.wi_format ?? '{0}',

        bias: promptBias,

        rawChatLength: chat.length,

        type, quietPrompt, quietImage,
        entries, cyclePrompt: continued,

        messages, messageExamples,
        groupMemberNames,

        tokenHandler,
        tokenizerOutcome,
        countedWith,
        tokenCountRows,
        maxContext: oaiSettings.openai_max_context ?? 4095,
        maxTokens: oaiSettings.openai_max_tokens ?? 300,

        squashSystemMessages: Boolean(oaiSettings.squash_system_messages ?? false),

        scenarioFormat: oaiSettings.scenario_format ?? DEFAULT_SCENARIO_FORMAT,
        personalityFormat: oaiSettings.personality_format ?? DEFAULT_PERSONALITY_FORMAT,
        groupNudgePrompt: oaiSettings.group_nudge_prompt ?? DEFAULT_GROUP_NUDGE_PROMPT,
        impersonationPrompt: oaiSettings.impersonation_prompt ?? '',

        prompts: promptsWithDefaults(oaiSettings.prompts),
        promptOrder: promptOrdersWithDefault(oaiSettings.prompt_order, characterId),
        characterId,
        macroContext,

        mainApi: 'openai',
        settings: oaiSettings,
        model: model ?? undefined, modelList,
        canUseToolsOverride: undefined,
        includeSignatureOverride: undefined,
        toolReasoningModeOverride: undefined,
        includeToolReasoningOverride: undefined,

        imageInlining: false, videoInlining: false, audioInlining: false,
        imageQuality, directories,

        toolBudgetTokens: 0,
        continuePrefill: Boolean(oaiSettings.continue_prefill ?? false),
        supportsAssistantPrefill: oaiSettings.chat_completion_source === chat_completion_sources.CLAUDE,
        namesInCompletion: namesBehavior === character_names_behavior.COMPLETION,
        assistantPrefill: oaiSettings.assistant_prefill ?? '',
        pinExamples: Boolean(powerUser.pin_examples ?? false),

        historyOptions: {
            isGroup,
            newChatPrompt: oaiSettings.new_chat_prompt ?? '',
            newGroupChatPrompt: oaiSettings.new_group_chat_prompt ?? '',
            continueNudgePrompt: oaiSettings.continue_nudge_prompt ?? '',
            sendIfEmpty: oaiSettings.send_if_empty ?? '',
            namesBehavior,
        },
        newExampleChatPrompt: oaiSettings.new_example_chat_prompt ?? '',
    };

    return { ...resolved, ...macroExtras };
}
