import { readSettingsFor, settingsContextOf } from './settings-reads.js';
import { resolveTextGenBackend } from './textgen-backend-resolve.js';
import { loadChatHistory } from './chat-request.js';
import { readExtraBooks } from './endpoints/characters.js';
import { resolveSpeakers } from './macro-scope.js';
import { extension_prompt_types, extension_prompt_roles } from './prompt/injections.js';
import { resolveWorldInfoCandidates } from './world-info/candidate-resolution.js';
import { worldInfoGlobalsOf } from '../public/scripts/world-info-globals.js';
import { apiTokenLimits, generationMacroFacts, variablesBefore } from './macro-facts.js';
import { storyStringWithAnchors } from '../public/scripts/story-string-anchors.js';
import { persona_description_defaults, persona_description_positions } from '../public/scripts/constants.js';

const DEFAULT_STORY_STRING_POSITION = extension_prompt_types.IN_PROMPT;
const DEFAULT_STORY_STRING_DEPTH = 1;
const DEFAULT_STORY_STRING_ROLE = extension_prompt_roles.SYSTEM;

/**
 * @typedef {object} ReasoningSettings
 * @property {boolean} [add_to_prompts]
 * @property {number} [max_additions]
 * @property {string} [prefix]
 * @property {string} [separator]
 * @property {string} [suffix]
 */

/**
 * @typedef {object} SyspromptSettings
 * @property {boolean} [enabled]
 * @property {string} [content]
 * @property {string} [post_history]
 */

/**
 * @typedef {object} PowerUserContextSettings
 * @property {string} [story_string]
 * @property {number} [story_string_position]
 * @property {number} [story_string_depth]
 * @property {number} [story_string_role]
 * @property {boolean} [names_as_stop_strings]
 */

/**
 * @typedef {object} PowerUserSettingsBundle
 * @property {Record<string, import('../public/scripts/power-user.js').PersonaRecord>} [persona_data]
 * @property {string} [user_prompt_bias]
 * @property {boolean} [always_force_name2]
 * @property {number} [token_padding]
 * @property {boolean} [request_token_probabilities]
 * @property {boolean} [single_line]
 * @property {string} [custom_stopping_strings]
 * @property {boolean} [custom_stopping_strings_macro]
 * @property {boolean} [console_log_prompts]
 * @property {boolean} [collapse_newlines]
 * @property {boolean} [strip_examples]
 * @property {boolean} [pin_examples]
 * @property {PowerUserContextSettings} [context]
 * @property {import('./instruct-template-format.js').InstructSettings} [instruct]
 * @property {ReasoningSettings} [reasoning]
 * @property {SyspromptSettings} [sysprompt]
 */

/**
 * @typedef {object} WorldInfoSettingsBundle
 * @property {boolean} [world_info_include_names]
 * @property {number} [world_info_budget]
 * @property {number} [world_info_budget_cap]
 * @property {number} [world_info_depth]
 * @property {boolean} [world_info_recursive]
 * @property {number} [world_info_max_recursion_steps]
 * @property {number} [world_info_min_activations]
 * @property {number} [world_info_min_activations_depth_max]
 * @property {boolean} [world_info_use_group_scoring]
 * @property {WorldInfoSelectionBundle} [world_info]
 * @property {number} [world_info_character_strategy]
 */

/**
 * @typedef {object} WorldInfoSelectionBundle
 * @property {string[]} [globalSelect]
 */

/**
 * @typedef {object} TextGenSettingsBundle
 * @property {string} [banned_tokens]
 * @property {string} [global_banned_tokens]
 * @property {boolean} [send_banned_tokens]
 * @property {import('./token-bans-and-bias.js').LogitBiasEntry[]} [logit_bias]
 */

/**
 * @typedef {object} KoboldSettingsBundle
 * @property {string} [api_server]
 */

/**
 * @typedef {object} CfgSettingsBundle
 * @property {import('./cfg-prompt-resolve.js').CfgSettings} [global]
 * @property {(import('./cfg-prompt-resolve.js').CfgSettings & { name?: string })[]} [chara]
 */

/**
 * @typedef {object} ExtensionSettingsBundle
 * @property {import('./authors-note.js').AuthorsNoteSettings} [note]
 * @property {CfgSettingsBundle} [cfg]
 */

/**
 * @typedef {object} TextCompletionSettingsBundle
 * @property {PowerUserSettingsBundle} [power_user]
 * @property {WorldInfoSettingsBundle} [world_info_settings]
 * @property {TextGenSettingsBundle} [textgenerationwebui_settings]
 * @property {KoboldSettingsBundle} [kai_settings]
 * @property {object} [nai_settings]
 * @property {ExtensionSettingsBundle} [extension_settings]
 * @property {string} [username]
 * @property {string} [user_avatar]
 * @property {number} [amount_gen]
 * @property {number} [max_context]
 */

/**
 * @param {string} mainApi
 * @param {number} maxContext
 * @param {number} maxResponse
 * @param {string} [novelModel]
 * @returns {number}
 */
export function promptTokenBudget(mainApi, maxContext, maxResponse, novelModel = '') {
    let context = Number(maxContext);
    if (mainApi === 'novel') {
        if (/clio|kayra|erato/.test(novelModel)) context = Math.min(context, 8192);
        if (novelModel.includes('erato')) context -= 10;
    }
    return context - maxResponse;
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
 * @param {object} params
 * @param {string} [params.avatar]
 * @param {string} [params.groupId]
 * @param {string} [params.mainApi]
 * @param {import('./chat-request.js').ChatContext} [params.chatContext]
 * @param {string|null} [params.nodeId]
 * @param {string} [params.type]
 * @param {boolean} [params.isImpersonate]
 * @param {boolean} [params.isContinue]
 * @param {boolean} [params.isSwipe]
 * @param {string} [params.textareaText]
 * @param {ChatMetadata} [params.chatMetadata]
 * @param {string} [params.userMessageText]
 * @param {object} [params.userMessageExtra]
 * @param {import('./world-info/activation.js').WIEntry[]} [params.worldInfoCandidates]
 * @param {(text: string) => Promise<number>} [params.countTokens]
 * @param {(text: string) => number[]} [params.encodeTokens]
 * @param {(text: string) => Promise<number>} [params.countPromptTokens]
 * @param {number} [params.amountGen]
 * @param {object} [params.macroExtras]
 * @param {import('./macro-facts.js').PageMacroFacts} [params.pageFacts]
 * @param {import('./prompt/injections.js').PageInjections} [params.pageInjections]
 * @param {boolean} [params.skipWorldInfoAndNote] No lorebook entries and no author's note go in.
 * @param {boolean} [params.forceName2] The reply's line starts with the character's name.
 * @returns {Promise<import('./prompt/text-prompt.js').TextCompletionPromptInput>}
 */
export async function resolveTextCompletionGenerationInput(directories, {
    avatar, groupId, mainApi = 'textgenerationwebui', chatContext, nodeId,
    type, isImpersonate = false, isContinue = false, isSwipe = false,
    textareaText = '', chatMetadata: chatMetadataOverride, userMessageText, userMessageExtra,
    worldInfoCandidates: worldInfoCandidatesOverride, countTokens, encodeTokens, countPromptTokens, amountGen, macroExtras = {},
    pageFacts = {}, pageInjections = {}, skipWorldInfoAndNote = false, forceName2 = false,
} = {}) {
    if (typeof countTokens !== 'function') {
        throw new Error('resolveTextCompletionGenerationInput: countTokens is required (real tokenizer resolution is caller-owned - see module doc comment)');
    }
    if (typeof encodeTokens !== 'function') {
        throw new Error('resolveTextCompletionGenerationInput: encodeTokens is required (real tokenizer resolution is caller-owned - see module doc comment)');
    }
    if (!['textgenerationwebui', 'kobold', 'novel'].includes(mainApi)) {
        throw new Error(`resolveTextCompletionGenerationInput: unsupported mainApi '${mainApi}' (koboldhorde is deliberately not supported here - see module doc comment)`);
    }

    const settingsContext = settingsContextOf({ avatar, groupId, chat: chatContext, nodeId });
    const {
        power_user: powerUser = {},
        world_info_settings: worldInfoSettings = {},
        textgenerationwebui_settings: textgenSettings = {},
        kai_settings: koboldSettings = {},
        nai_settings: novelSettings = {},
        extension_settings: extensionSettings = {},
        username,
        user_avatar: userAvatar,
        amount_gen: settingsAmountGen,
        max_context: settingsMaxContext,
    } = /** @type {TextCompletionSettingsBundle} */ (readSettingsFor(directories, settingsContext, [
        'power_user', 'world_info_settings',
        'textgenerationwebui_settings', 'kai_settings', 'nai_settings',
        'extension_settings', 'username', 'user_avatar', 'amount_gen', 'max_context',
    ]));
    const activePersona = powerUser.persona_data?.[userAvatar] ?? {};
    const worldInfoSelection = worldInfoSettings.world_info ?? {};
    const worldInfoGlobals = worldInfoGlobalsOf(worldInfoSettings);

    const backendSettings = mainApi === 'kobold' ? koboldSettings : mainApi === 'novel' ? novelSettings : textgenSettings;

    const backend = mainApi === 'textgenerationwebui' ? resolveTextGenBackend(directories, settingsContext) : null;
    const model = backend ? backend.model : undefined;

    const isGroup = Boolean(groupId);
    const hasCharacterOrGroup = Boolean(avatar) || Boolean(groupId);

    const { chat: loadedChat, metadata: loadedChatMetadata, resolvedNodeId, ambiguous: chatResolutionAmbiguous } =
        await resolveChatHistory(chatContext, { nodeId });
    const chatMetadata = chatMetadataOverride ?? loadedChatMetadata;
    const stateBefore = variablesBefore(chatMetadata, extensionSettings.variables?.global ?? {});

    const { name2, character, groupMembers: groupMemberNames, groupDisabledMembers } = await resolveSpeakers(directories, { avatar, groupId });
    const name1 = (username != null && username !== '') ? username : 'User';

    const sentMessage = typeof userMessageText === 'string'
        ? { is_user: true, name: name1, mes: userMessageText, extra: userMessageExtra && typeof userMessageExtra === 'object' ? userMessageExtra : {}, send_date: Date.now() }
        : null;
    const chat = sentMessage ? [...loadedChat, sentMessage] : loadedChat;

    const WORLD_INFO_METADATA_KEY = 'world_info';
    let worldInfoCandidates = skipWorldInfoAndNote ? [] : worldInfoCandidatesOverride;
    if (worldInfoCandidates === undefined) {
        const characterExtraBooks = avatar != null ? await readExtraBooks(directories, avatar) : [];
        worldInfoCandidates = /** @type {import('./world-info/activation.js').WIEntry[]} */ (await resolveWorldInfoCandidates({
            directories,
            selectedWorldInfo: worldInfoSelection.globalSelect ?? [],
            character,
            characterExtraBooks,
            chatWorldName: chatMetadata[WORLD_INFO_METADATA_KEY] ?? null,
            personaWorldLorebook: activePersona.lorebook ?? null,
            worldInfoCharacterStrategy: worldInfoGlobals.world_info_character_strategy,
        }));
    }

    const context = powerUser.context ?? {};
    const instruct = /** @type {import('./instruct-template-format.js').InstructSettings & { user_alignment_message?: string }} */ (powerUser.instruct ?? {});
    const reasoning = powerUser.reasoning ?? {};
    const sysprompt = powerUser.sysprompt ?? {};
    const noteSettings = extensionSettings.note ?? {};
    const cfgSettings = extensionSettings.cfg ?? {};
    const globalCfg = cfgSettings.global;
    const charaCfg = Array.isArray(cfgSettings.chara) ? cfgSettings.chara.find(e => e.name === avatar) : undefined;

    const resolved = {
        type, isImpersonate, isContinue, isSwipe, isGroup,
        name1, name2,
        macroFacts: generationMacroFacts({
            powerUser, extensionSettings, mainApi, type, pageFacts,
            ...apiTokenLimits({ max_context: settingsMaxContext, amount_gen: amountGen ?? settingsAmountGen }, mainApi),
        }),

        directories, avatar, groupId,
        resolvedNodeId,
        chatResolutionAmbiguous: Boolean(chatResolutionAmbiguous),
        personaDescription: activePersona.description,
        chatMetadata, chat, sentMessage, textareaText,
        variablesBefore: stateBefore,
        userPromptBias: powerUser.user_prompt_bias,
        alwaysForceName2: Boolean(powerUser.always_force_name2),
        forceName2Override: forceName2,
        skipWorldInfoAndNote,

        reasoningAddToPrompts: Boolean(reasoning.add_to_prompts ?? false),
        reasoningMaxAdditions: reasoning.max_additions ?? 1,
        reasoningPrefix: reasoning.prefix ?? '<think>',
        reasoningSeparator: reasoning.separator ?? '\n',
        reasoningSuffix: reasoning.suffix ?? '</think>',

        pageInjections,

        thisMaxContext: promptTokenBudget(mainApi, settingsMaxContext ?? 8192, amountGen ?? settingsAmountGen ?? 0, novelSettings.model_novel),
        maxContext: settingsMaxContext ?? 8192,
        tokenPadding: powerUser.token_padding ?? 0,
        countTokens, encodeTokens, countPromptTokens,
        amountGen: amountGen ?? settingsAmountGen ?? 0,
        requestTokenProbabilities: Boolean(powerUser.request_token_probabilities ?? false),

        chatGuidanceScale: chatMetadata.cfg_guidance_scale,
        groupchatIndividualChars: Boolean(chatMetadata.cfg_groupchat_individual_chars ?? false),
        charaCfg, globalCfg,
        promptCombine: chatMetadata.cfg_prompt_combine ?? [],
        promptSeparator: chatMetadata.cfg_prompt_separator,
        promptInsertionDepth: chatMetadata.cfg_prompt_insertion_depth ?? 1,
        chatMetadataPrompts: {
            negativePrompt: chatMetadata.cfg_negative_prompt,
            positivePrompt: chatMetadata.cfg_positive_prompt,
        },

        worldInfoCandidates,
        worldInfoGlobals,

        noteSettings, hasCharacterOrGroup,

        storyStringTemplate: storyStringWithAnchors(context),
        storyStringPosition: context.story_string_position ?? DEFAULT_STORY_STRING_POSITION,
        storyStringDepth: context.story_string_depth ?? DEFAULT_STORY_STRING_DEPTH,
        storyStringRole: context.story_string_role ?? DEFAULT_STORY_STRING_ROLE,
        sysPromptEnabled: Boolean(sysprompt.enabled ?? false),
        sysPromptContent: sysprompt.content ?? '',
        personaDescriptionPosition: activePersona.position ?? persona_description_positions.IN_PROMPT,
        personaDescriptionDepth: activePersona.depth ?? persona_description_defaults.depth,
        personaDescriptionRole: activePersona.role ?? persona_description_defaults.role,
        stripExamples: Boolean(powerUser.strip_examples ?? false),
        isInstruct: Boolean(instruct.enabled ?? false),
        instructPreset: instruct,
        contextSettings: context,
        instructUserAlignmentMessage: instruct.user_alignment_message,
        instructWrap: Boolean(instruct.wrap ?? false),
        pinExamples: Boolean(powerUser.pin_examples ?? false),

        sysPromptPostHistory: sysprompt.post_history ?? '',

        mainApi,
        collapseNewlines: Boolean(powerUser.collapse_newlines ?? false),
        chatStart: context.chat_start ?? '',
        naiPreamble: mainApi === 'novel' ? novelSettings.preamble ?? '' : '',

        namesAsStopStrings: Boolean(context.names_as_stop_strings ?? false),
        singleLine: Boolean(powerUser.single_line ?? false),
        customStoppingStringsRaw: powerUser.custom_stopping_strings ?? '',
        customStoppingStringsMacro: Boolean(powerUser.custom_stopping_strings_macro ?? false),
        groupMemberNames, groupDisabledMembers,
        bannedTokensRaw: textgenSettings.banned_tokens ?? '',
        globalBannedTokensRaw: textgenSettings.global_banned_tokens ?? '',
        sendBannedTokens: Boolean(textgenSettings.send_banned_tokens ?? true),
        logitBiasEntries: textgenSettings.logit_bias ?? [],

        settings: backendSettings,
        model,

        apiServer: mainApi === 'kobold' ? (koboldSettings.api_server ?? '') : undefined,
        consoleLogPrompts: Boolean(powerUser.console_log_prompts ?? false),
    };

    return { ...resolved, ...macroExtras };
}
