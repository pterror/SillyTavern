import {
    activateSendButtons,
    addOneMessage,
    appendMediaToMessage,
    callPopup,
    characters,
    charactersStore,
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
    chatOpAppend,
    chatOpEdit,
    chatOpEditMany,
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
    updateMessage,
    updateIn,
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
import { healDirtyMessages } from './chat-store.js';
import { addLocaleData, getCurrentLocale, t, translate } from './i18n.js';
import { hideLoader, showLoader } from './loader.js';
import { loader } from './action-loader.js';
import { MacrosParser } from './macros.js';
import { getChatCompletionModel, oai_settings } from './chat-completion-settings.js';
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

/** O(1) by-id lookup via groupsStore's Map index; exposes only the read, not the store's mutation methods. */
function getGroupById(id) {
    return groupsStore.get(id);
}

/** O(1) by-avatar lookup via charactersStore's Map index; exposes only the read, not the store's mutation methods. */
function getCharacterByAvatar(avatar) {
    return charactersStore.get(avatar);
}

/** O(1) by-id lookup via tagsStore's Map index; exposes only the read, not the store's mutation methods. */
function getTagById(id) {
    return tagsStore.get(id);
}

/** O(1) by-avatar lookup via personaStore's Map index; exposes only the read, not the store's mutation methods. */
function getPersonaById(avatar) {
    return personaStore.get(avatar);
}

export function getContext() {
    return {
        accountStorage,
        chat,
        // Raw array kept as-is for backwards compat; prefer getCharacterByAvatar(avatar) for O(1) lookups.
        characters,
        getCharacterByAvatar,
        // Raw array kept as-is for backwards compat; prefer getGroupById(id) for O(1) lookups.
        groups,
        getGroupById,
        name1,
        name2,
        // Lazy getter so it stays fresh instead of going stale like a snapshot would.
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
        // The one truly generic save entry point: an extension may have mutated `chat[]` directly
        // (edited `.mes`, added a swipe, appended a message) without calling editMessage/appendMessage/
        // etc. above, so - unlike saveChatConditional() on its own, which every first-party call site
        // reaches only after already stating its own chatOp*() - this can't assume nothing changed
        // without asking. healDirtyMessages() (chat-store.js) is that diff, and it's owner-agnostic (an
        // extension may be looking at a solo or a group chat): it resolves against whichever owner
        // _currentOwner() (chat-store.js) currently reports, with no branch needed here for which kind
        // is open. Runs once, here, then defers to the ordinary save path for whatever's left
        // (metadata, per-owner stat bumps) - not baked into saveChatConditional() itself, so a
        // first-party call after a stated op doesn't pay for a diff it doesn't need.
        saveChat: async () => {
            await healDirtyMessages().catch(error =>
                console.error('[getContext().saveChat] Could not sync unstated changes:', error));
            await saveChatConditional();
        },
        editMessage: chatOpEdit,
        editMessages: chatOpEditMany,
        appendMessage: chatOpAppend,
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
        updateMessage,
        updateIn,
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
