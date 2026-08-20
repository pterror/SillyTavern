import {
    activateSendButtons,
    addOneMessage,
    appendMediaToMessage,
    callPopup,
    characters,
    chat,
    chat_metadata,
    CONNECT_API_MAP,
    create_save,
    deactivateSendButtons,
    event_types,
    eventSource,
    extension_prompts,
    extractMessageFromData,
    Generate,
    generateQuietPrompt,
    getCharacters,
    getCurrentChatId,
    getRequestHeaders,
    getThumbnailUrl,
    main_api,
    max_context,
    menu_type,
    messageFormatting,
    name1,
    name2,
    online_status,
    openCharacterChat,
    reloadCurrentChat,
    renameChat,
    saveChatConditional,
    saveMetadata,
    saveReply,
    saveSettingsDebounced,
    selectCharacterById,
    sendGenerationRequest,
    sendStreamingRequest,
    sendSystemMessage,
    setExtensionPrompt,
    stopGeneration,
    streamingProcessor,
    substituteParams,
    substituteParamsExtended,
    getCurrentCharacter,
    updateChatMetadata,
    updateMessageBlock,
    printMessages,
    clearChat,
    unshallowCharacter,
    deleteLastMessage,
    getCharacterCardFields,
    swipe_right,
    swipe_left,
    generateRaw,
    generateRawData,
    showSwipeButtons,
    hideSwipeButtons,
    deleteMessage,
    refreshSwipeButtons,
    swipe,
    isSwipingAllowed,
    swipeState,
    ensureMessageMediaIsArray,
    getMediaDisplay,
    getMediaIndex,
    scrollChatToBottom,
    scrollOnMediaLoad,
    getOneCharacter,
    getCharacterSource,
} from '../script.js';
import {
    extension_settings,
    getExtensionManifest,
    ModuleWorkerWrapper,
    openThirdPartyExtensionMenu,
    renderExtensionTemplate,
    renderExtensionTemplateAsync,
    saveMetadataDebounced,
    UNSET_VALUE,
    writeExtensionField,
    writeExtensionFieldBulk,
} from './extensions.js';
import { groups, groupsStore, openGroupChat, selected_group, unshallowGroupMembers } from './group-chats.js';
import { addLocaleData, getCurrentLocale, t, translate } from './i18n.js';
import { hideLoader, showLoader } from './loader.js';
import { loader } from './action-loader.js';
import { MacrosParser } from './macros.js';
import { getChatCompletionModel, oai_settings } from './openai.js';
import { callGenericPopup, Popup, POPUP_RESULT, POPUP_TYPE } from './popup.js';
import { power_user, personaStore, registerDebugFunction } from './power-user.js';
import { getPresetManager } from './preset-manager.js';
import { humanizedDateTime, isMobile, shouldSendOnEnter } from './RossAscends-mods.js';
import { ScraperManager } from './scrapers.js';
import { executeSlashCommands, executeSlashCommandsWithOptions, registerSlashCommand } from './slash-commands.js';
import { SlashCommand } from './slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from './slash-commands/SlashCommandArgument.js';
import { SlashCommandEnumValue } from './slash-commands/SlashCommandEnumValue.js';
import { SlashCommandParser } from './slash-commands/SlashCommandParser.js';
import { tag_map, tags, tagsStore, importTags } from './tags.js';
import { getTextGenServer, textgenerationwebui_settings } from './textgen-settings.js';
import { tokenizers, getTextTokens, getTokenCount, getTokenCountAsync, getTokenizerModel } from './tokenizers.js';
import { ToolManager } from './tool-calling.js';
import { accountStorage } from './util/AccountStorage.js';
import { timestampToMoment, uuidv4, importFromExternalUrl } from './utils.js';
import { addGlobalVariable, addLocalVariable, decrementGlobalVariable, decrementLocalVariable, deleteGlobalVariable, deleteLocalVariable, existsGlobalVariable, existsLocalVariable, getGlobalVariable, getLocalVariable, incrementGlobalVariable, incrementLocalVariable, setGlobalVariable, setLocalVariable } from './variables.js';
import { convertCharacterBook, getWorldInfoPrompt, loadWorldInfo, reloadEditor, saveWorldInfo, updateWorldInfoList, world_names } from './world-info.js';
import { ChatCompletionService, TextCompletionService } from './custom-request.js';
import { ConnectionManagerRequestService } from './extensions/shared.js';
import { updateReasoningUI, parseReasoningFromString, getReasoningTemplateByName } from './reasoning.js';
import { IGNORE_SYMBOL } from './constants.js';
import { macros } from './macros/macro-system.js';
import { MessageFormatter } from './message-formatter.js';

/**
 * Read-only O(1) lookup for a group by id, backed by groupsStore's Map index - use this instead of
 * `context.groups.find(x => x.id === id)` wherever the id is already known, since that scan is O(n) over
 * every group. `context.groups` (the raw array) stays available unchanged for anything that isn't a by-id
 * lookup (iteration, filtering, etc.) or that hasn't been updated to use this yet.
 * Deliberately exposes only the read (`.get()`), not the groupsStore instance itself, since that also has
 * mutation methods (`.update()`/`.remove()`/etc.) that extensions shouldn't get write access to via a read path.
 * @param {string} id - the group's id
 * @returns {object|undefined} the group, or undefined if no group with that id exists
 */
function getGroupById(id) {
    return groupsStore.get(id);
}

/**
 * Read-only O(1) lookup for a tag by id, backed by tagsStore's Map index - use this instead of
 * `context.tags.find(x => x.id === id)` wherever the id is already known, since that scan is O(n) over
 * every tag. `context.tags` (the raw array) stays available unchanged for anything that isn't a by-id
 * lookup (iteration, filtering, etc.) or that hasn't been updated to use this yet.
 * Deliberately exposes only the read (`.get()`), not the tagsStore instance itself, since that also has
 * mutation methods (`.update()`/`.remove()`/etc.) that extensions shouldn't get write access to via a read path.
 * @param {string} id - the tag's id
 * @returns {object|undefined} the tag, or undefined if no tag with that id exists
 */
function getTagById(id) {
    return tagsStore.get(id);
}

/**
 * Read-only O(1) lookup for a persona by avatar id, backed by personaStore's Map index. Personas aren't
 * exposed on `getContext()` at all otherwise (unlike `groups`/`tags`, there's no raw array/dict here to keep
 * for backwards compat - `context.powerUserSettings.persona_data` is technically reachable but not a clean
 * accessor), so this is the only path in.
 * Deliberately exposes only the read (`.get()`), not the personaStore instance itself, since that also has
 * mutation methods (`.update()`/`.remove()`/etc.) that extensions shouldn't get write access to via a read path.
 * @param {string} avatar - the persona's avatar id
 * @returns {object|undefined} the persona, or undefined if no persona with that avatar id exists
 */
function getPersonaById(avatar) {
    return personaStore.get(avatar);
}

export function getContext() {
    return {
        accountStorage,
        chat,
        characters,
        // Raw array - unchanged, O(n) `.find()` for by-id lookups. Kept exactly as-is for backwards
        // compatibility with existing extensions. Prefer getGroupById(id) below for O(1) by-id lookups.
        groups,
        getGroupById,
        name1,
        name2,
        // Lazy getter (not a snapshot like this_chid used to be here) so extensions that read
        // context.characterId later - after an await, from a closure, etc. - get an index recomputed
        // fresh from the live characters array/current avatar, instead of one that can go stale if the
        // array reorders or reloads in the meantime. Matches setCharacterId()'s own idx !== -1 ? String(idx)
        // : undefined convention, since this_chid itself is always a numeric string or undefined.
        get characterId() {
            const avatar = getCurrentCharacter()?.avatar;
            const index = avatar !== undefined ? characters.findIndex(x => x.avatar === avatar) : -1;
            return index !== -1 ? String(index) : undefined;
        },
        characterAvatar: getCurrentCharacter()?.avatar,
        groupId: selected_group,
        chatId: selected_group
            ? groupsStore.get(selected_group)?.chat_id
            : (getCurrentCharacter()?.chat),
        getCurrentChatId,
        getRequestHeaders,
        reloadCurrentChat,
        renameChat,
        saveSettingsDebounced,
        onlineStatus: online_status,
        maxContext: Number(max_context),
        chatMetadata: chat_metadata,
        saveMetadataDebounced,
        streamingProcessor,
        eventSource,
        eventTypes: event_types,
        addOneMessage,
        deleteLastMessage,
        deleteMessage,
        generate: Generate,
        sendStreamingRequest,
        sendGenerationRequest,
        stopGeneration,
        tokenizers,
        getTextTokens,
        /** @deprecated Use getTokenCountAsync instead */
        getTokenCount,
        getTokenCountAsync,
        extensionPrompts: extension_prompts,
        setExtensionPrompt,
        updateChatMetadata,
        saveChat: saveChatConditional,
        openCharacterChat,
        openGroupChat,
        saveMetadata,
        sendSystemMessage,
        activateSendButtons,
        deactivateSendButtons,
        saveReply,
        substituteParams,
        substituteParamsExtended,
        SlashCommandParser,
        SlashCommand,
        SlashCommandArgument,
        SlashCommandNamedArgument,
        SlashCommandEnumValue,
        ARGUMENT_TYPE,
        executeSlashCommandsWithOptions,
        /** @deprecated Use SlashCommandParser.addCommandObject() instead */
        registerSlashCommand,
        /** @deprecated Use executeSlashCommandWithOptions instead */
        executeSlashCommands,
        timestampToMoment,
        /** @deprecated Handlebars for extensions are no longer supported. */
        registerHelper: () => { },
        /** @deprecated Use `macros.register(name, { handler, description })` from scripts/macros/macro-system.js instead. */
        registerMacro: MacrosParser.registerMacro.bind(MacrosParser),
        /** @deprecated Use `macros.registry.unregisterMacro(name)` from scripts/macros/macro-system.js instead. */
        unregisterMacro: MacrosParser.unregisterMacro.bind(MacrosParser),
        registerFunctionTool: ToolManager.registerFunctionTool.bind(ToolManager),
        unregisterFunctionTool: ToolManager.unregisterFunctionTool.bind(ToolManager),
        isToolCallingSupported: ToolManager.isToolCallingSupported.bind(ToolManager),
        canPerformToolCalls: ToolManager.canPerformToolCalls.bind(ToolManager),
        ToolManager,
        registerDebugFunction,
        /** @deprecated Use renderExtensionTemplateAsync instead. */
        renderExtensionTemplate,
        renderExtensionTemplateAsync,
        registerDataBankScraper: ScraperManager.registerDataBankScraper.bind(ScraperManager),
        /** @deprecated Use callGenericPopup or Popup instead. */
        callPopup,
        callGenericPopup,
        /** @deprecated Use loader.show instead. */
        showLoader,
        /** @deprecated Use loader.hide instead. */
        hideLoader,
        mainApi: main_api,
        extensionSettings: extension_settings,
        ModuleWorkerWrapper,
        getTokenizerModel,
        generateQuietPrompt,
        generateRaw,
        generateRawData,
        writeExtensionField,
        writeExtensionFieldBulk,
        getThumbnailUrl,
        selectCharacterById,
        messageFormatting,
        shouldSendOnEnter,
        isMobile,
        t,
        translate,
        getCurrentLocale,
        addLocaleData,
        tags,
        tagMap: tag_map,
        getTagById,
        menuType: menu_type,
        createCharacterData: create_save,
        /** @deprecated Legacy snake-case naming, compatibility with old extensions */
        event_types: event_types,
        Popup,
        POPUP_TYPE,
        POPUP_RESULT,
        chatCompletionSettings: oai_settings,
        textCompletionSettings: textgenerationwebui_settings,
        powerUserSettings: power_user,
        getPersonaById,
        getCharacters,
        getOneCharacter,
        getCharacterCardFields,
        getCharacterSource,
        importFromExternalUrl,
        importTags,
        uuidv4,
        humanizedDateTime,
        updateMessageBlock,
        appendMediaToMessage,
        ensureMessageMediaIsArray,
        getMediaDisplay,
        getMediaIndex,
        scrollChatToBottom,
        scrollOnMediaLoad,
        macros,
        messageFormatter: MessageFormatter,
        loader,
        swipe: {
            left: swipe_left,
            right: swipe_right,
            to: swipe,
            show: showSwipeButtons,
            hide: hideSwipeButtons,
            refresh: refreshSwipeButtons,
            isAllowed: isSwipingAllowed,
            state: () => swipeState,
        },
        variables: {
            local: {
                get: getLocalVariable,
                set: setLocalVariable,
                del: deleteLocalVariable,
                add: addLocalVariable,
                inc: incrementLocalVariable,
                dec: decrementLocalVariable,
                has: existsLocalVariable,
            },
            global: {
                get: getGlobalVariable,
                set: setGlobalVariable,
                del: deleteGlobalVariable,
                add: addGlobalVariable,
                inc: incrementGlobalVariable,
                dec: decrementGlobalVariable,
                has: existsGlobalVariable,
            },
        },
        loadWorldInfo,
        saveWorldInfo,
        reloadWorldInfoEditor: reloadEditor,
        updateWorldInfoList,
        convertCharacterBook,
        getWorldInfoPrompt,
        getWorldInfoNames: () => Array.isArray(world_names) ? [...world_names] : [],
        CONNECT_API_MAP,
        getTextGenServer,
        extractMessageFromData,
        getPresetManager,
        getChatCompletionModel,
        printMessages,
        clearChat,
        ChatCompletionService,
        TextCompletionService,
        ConnectionManagerRequestService,
        updateReasoningUI,
        parseReasoningFromString,
        getReasoningTemplateByName,
        unshallowCharacter,
        unshallowGroupMembers,
        getExtensionManifest,
        openThirdPartyExtensionMenu,
        symbols: {
            ignore: IGNORE_SYMBOL,
        },
        constants: {
            unset: UNSET_VALUE,
        },
    };
}

export default getContext;
