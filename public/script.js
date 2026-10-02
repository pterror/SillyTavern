import {
    showdown,
    moment,
    DOMPurify,
    hljs,
    Handlebars,
    SVGInject,
    Popper,
    initLibraryShims,
    default as libs,
    lodash,
} from './lib.js';

import { favsToHotswap, getMessageTimeStamp, dragElement, isMobile, initRossMods, countCharTokensWhenShown, onCharacterEditorMaybeShown } from './scripts/RossAscends-mods.js';
import { exposedCharacters, charactersStore, this_avatar, this_chid, setCharacterId, holdCharacter, keepHeldCharacters, selectCharacterById, resolveCharacterRef, resolveCharacterRefPair, CHARACTER_REF_MISMATCH } from './scripts/character-store.js';
import { printCharacters, printCharactersDebounced, getEntitiesList, findCharacterListPage, getOneCharacter, getCharacterSource, seedCharactersFromCache, getCharacters, showCharacterSyncFailedToast, initCharacterSearch, updateCharacterListRow, removeCharacterListRow, renameCharacterListRow, refreshCharacterListCurrentPage, hasActiveCharacterSearch, isCharacterListShowing, onSearchIndexUpdated, onCharacterListShown, entitiesFilter, characterToEntity, groupToEntity, tagToEntity, DEFAULT_PRINT_TIMEOUT } from './scripts/character-list.js';
// Re-exported for existing importers (upstream's script.js exports these too). Extensions get the characters
// they are shown, not every character the page holds.
export { exposedCharacters as characters, charactersStore, selectCharacterById, setCharacterId, this_chid };
export { printCharacters, printCharactersDebounced, getEntitiesList, getOneCharacter, getCharacterSource, getCharacters, entitiesFilter, characterToEntity, groupToEntity, tagToEntity, DEFAULT_PRINT_TIMEOUT };
import { userStatsHandler, statMesProcess, initStats } from './scripts/stats.js';
import { showMigrationNotices } from './scripts/migration-notices.js';
import {
    generateKoboldWithStreaming,
    kai_settings,
    loadKoboldSettings,
    getKoboldGenerationData,
    kai_flags,
    koboldai_settings,
    koboldai_setting_names,
    initKoboldSettings,
} from './scripts/kai-settings.js';

import {
    textgenerationwebui_settings as textgen_settings,
    loadTextGenSettings,
    generateTextGenWithStreaming,
    getTextGenGenerationData,
    textgen_types,
    parseTextgenLogprobs,
    parseTabbyLogprobs,
    initTextGenSettings,
} from './scripts/textgen-settings.js';

import {
    world_info,
    getWorldInfoSettings,
    setWorldInfoSettings,
    world_names,
    importEmbeddedWorldInfo,
    openEmbeddedLoreEditor,
    checkEmbeddedWorld,
    setWorldInfoButtonClass,
    updateCharacterWorldButton,
    getCharacterWorldLink,
    initWorldInfo,
    charUpdatePrimaryWorld,
    charSetAuxWorlds,
} from './scripts/world-info.js';
import { character_world_link } from './scripts/character-world-link.js';

import {
    groupsStore,
    selected_group,
    saveGroupField,
    is_group_generating,
    resetSelectedGroup,
    select_group_chats,
    regenerateGroup,
    group_generation_id,
    getGroupChat,
    renameGroupMember,
    createNewGroupChat,
    getGroupAvatar,
    deleteGroupChat,
    renameGroupChat,
    importGroupChat,
    getGroupCharacterCardsLazy,
} from './scripts/group-chats.js';

import {
    collapseNewlines,
    loadPowerUserSettings,
    playMessageSound,
    power_user,
    persona_description_positions,
    personaStore,
    loadMovingUIState,
    getCustomStoppingStrings,
    MAX_CONTEXT_DEFAULT,
    MAX_RESPONSE_DEFAULT,
    registerDebugFunction,
    flushEphemeralStoppingStrings,
    resetMovableStyles,
    markCharacterEditorCountsStale,
    applyPowerUserSettings,
    generatedTextFiltered,
    applyStylePins,
    invalidateCharactersFuseIndex,
} from './scripts/power-user.js';

import {
    setupChatCompletionPromptManager,
    sendOpenAIRequest,
    loadOpenAISettings,
    oai_settings,
    chat_completion_sources,
    getChatCompletionModel,
    proxies,
    loadProxyPresets,
    selected_proxy,
    initOpenAI,
} from './scripts/chat-completion-settings.js';

import {
    generateNovelWithStreaming,
    getNovelGenerationData,
    getKayraMaxContextTokens,
    loadNovelSettings,
    nai_settings,
    adjustNovelInstructionPrompt,
    parseNovelAILogprobs,
    novelai_settings,
    novelai_setting_names,
    initNovelAISettings,
} from './scripts/nai-settings.js';

import {
    initBookmarks,
    showBookmarksButtons,
} from './scripts/bookmarks.js';

import {
    horde_settings,
    loadHordeSettings,
    generateHorde,
    generateHordeRawAction,
    getStatusHorde,
    getHordeModels,
    isHordeGenerationNotAllowed,
    initHorde,
} from './scripts/horde.js';

import {
    debounce,
    delay,
    trimToEndSentence,
    countOccurrences,
    isOdd,
    sortMoments,
    timestampToMoment,
    download,
    isDataURL,
    getCharaFilename,
    waitUntilCondition,
    escapeRegex,
    onlyUnique,
    getBase64Async,
    humanFileSize,
    Stopwatch,
    isValidUrl,
    ensureImageFormatSupported,
    flashHighlight,
    toggleDrawer,
    isElementInViewport,
    copyText,
    escapeHtml,
    saveBase64AsFile,
    equalsIgnoreCaseAndAccents,
    importFromExternalUrl,
    trimSpaces,
    clamp,
    shakeElement,
    createTimeout,
    getStringHash,
    cancelDebounce,
    uuidv4,
} from './scripts/utils.js';
// Imported directly from hash-utils.js, not re-exported via utils.js, so tests mocking utils.js aren't affected.
import { getAtPath, seedKeyHashes, characterDigestFieldsHash, characterDigestCardBodyHash, normalizeFav } from './scripts/hash-utils.js';
import { debounce_timeout, IGNORE_SYMBOL, inject_ids, MEDIA_DISPLAY, MEDIA_SOURCE, MEDIA_TYPE, OVERSWIPE_BEHAVIOR, SCROLL_BEHAVIOR, SWIPE_DIRECTION, SWIPE_SOURCE, SWIPE_STATE } from './scripts/constants.js';

import { cancelDebouncedMetadataSave, doDailyExtensionUpdatesCheck, extension_settings, initExtensions, loadExtensionSettings, UNSET_VALUE } from './scripts/extensions.js';
import { CONNECT_API_MAP, executeSlashCommandsOnChatInput, initDefaultSlashCommands, initSlashCommandAutoComplete, isExecutingCommandsFromChatInput, pauseScriptExecution, stopScriptExecution, UNIQUE_APIS } from './scripts/slash-commands.js';
import { initMacroAutoComplete } from './scripts/autocomplete/MacroAutoComplete.js';
import {
    chooseBogusFolder,
    loadTagsSettings,
    reindexTagAssignments,
    createTagMapFromList,
    importTags,
    mergeServerTagDefinitions,
    initTags,
    tag_import_setting,
    applyCharacterTagsToMessageDivs,
    removeEntityTags,
    onTagsChanged,
    onEntityTagsChanged,
    storeTagChangesMadeThroughExport,
    noteTagExportsMayHaveChanged,
} from './scripts/tags.js';
import { checkOpenRouterAuth, initSecrets, readSecretState } from './scripts/secrets.js';
import { markdownExclusionExt } from './scripts/showdown-exclusion.js';
import { reloadMarkedProcessor } from './scripts/marked-processor.js';
import { markdownUnderscoreExt } from './scripts/showdown-underscore.js';
import { NOTE_MODULE_NAME, initAuthorsNote, metadata_keys, shouldWIAddPrompt } from './scripts/authors-note.js';
import { registerPromptManagerMigration } from './scripts/PromptManager.js';
import { getRegexedString, regex_placement } from './scripts/extensions/regex/engine.js';
import { initLogprobs, saveLogprobsForActiveMessage } from './scripts/logprobs.js';
import { openRightMenu, closeRightMenu } from './scripts/right-menu-state.js';
import { initCfg } from './scripts/cfg-scale.js';
import {
    formatInstructModeChat,
    formatInstructModePrompt,
    formatInstructModeExamples,
    formatInstructModeStoryString,
    getInstructStoppingSequences,
} from './scripts/instruct-mode.js';
import { initLocales, t } from './scripts/i18n.js';
import { changeStreamRetryDelayMs } from './scripts/change-stream-backoff.js';
import { getTokenCount, getTokenCountAsync, initTokenizers } from './scripts/tokenizers.js';
import {
    user_avatar,
    getUserAvatars,
    getUserAvatar,
    setUserAvatar,
    initPersonas,
    setPersonaDescription,
    initUserAvatar,
    isPersonaPanelOpen,
    DEFAULT_DEPTH as PERSONA_DEFAULT_DEPTH,
    DEFAULT_ROLE as PERSONA_DEFAULT_ROLE,
    getPersonaDescription,
    getPersonaDescriptionPosition,
    getPersonaDescriptionDepth,
    getPersonaDescriptionRole,
} from './scripts/personas.js';
import { getBackgrounds, initBackgrounds, loadBackgroundSettings, background_settings } from './scripts/backgrounds.js';
import { loader } from './scripts/action-loader.js';
import { BulkEditOverlay } from './scripts/BulkEditOverlay.js';
import { initTextGenModels } from './scripts/textgen-models.js';
import { hasPendingFileAttachment, populateFileAttachment, isExternalMediaAllowed, preserveNeutralChat, restoreNeutralChat, formatCreatorNotes, initChatUtilities, addDOMPurifyHooks, showMediaLightbox } from './scripts/chats.js';
import { beginEdit, blockFieldEditStart, blockWhileFieldEditing, initCharacterFieldEditor, isFieldInEdit, setFieldValue } from './scripts/character-field-editor.js';
import { initCharInfoTabDimming, refreshCharInfoTabDimming } from './scripts/char-info-tab-dimming.js';
import { getFormBaseline, setFormBaseline } from './scripts/character-form-baseline.js';
import { initPresetManager } from './scripts/preset-manager.js';
import { evaluateMacros, getLastMessageId, initMacros } from './scripts/macros.js';
import { currentUser, setUserControls } from './scripts/user.js';
import { POPUP_RESULT, POPUP_TYPE, Popup, callGenericPopup, fixToastrForDialogs } from './scripts/popup.js';
import { renderTemplate, renderTemplateAsync } from './scripts/templates.js';
import { initScrapers } from './scripts/scrapers.js';
import { initCustomSelectedSamplers, validateDisabledSamplers } from './scripts/samplerSelect.js';
import { DragAndDropHandler } from './scripts/dragdrop.js';
import { INTERACTABLE_CONTROL_CLASS, initKeyboard } from './scripts/keyboard.js';
import { initDynamicStyles } from './scripts/dynamic-styles.js';
import { initInputMarkdown } from './scripts/input-md-formatting.js';
import { autosizeTextareas, initAutosizeTextareas } from './scripts/autosize-textareas.js';
import { AbortReason } from './scripts/util/AbortReason.js';
import { initDrawerStack, isDrawerCovered, frontmostOf, raiseDrawer, updateDrawerStack, bringChatForward } from './scripts/drawer-stack.js';
import { initSystemPrompts } from './scripts/sysprompt.js';
import { registerExtensionSlashCommands as initExtensionSlashCommands } from './scripts/extensions-slashcommands.js';
import { ToolManager } from './scripts/tool-calling.js';
import { addShowdownPatch } from './scripts/util/showdown-patch.js';
import { applyBrowserFixes } from './scripts/browser-fixes.js';
import { initServerHistory } from './scripts/server-history.js';
import { initSettingsSearch } from './scripts/setting-search.js';
import { initBulkEdit } from './scripts/bulk-edit.js';
import { getContext } from './scripts/st-context.js';
import { initReasoning, parseReasoningInSwipes, PromptReasoning, ReasoningHandler, removeReasoningFromString, updateReasoningUI } from './scripts/reasoning.js';
import { accountStorage } from './scripts/util/AccountStorage.js';
import { initWelcomeScreen, openPermanentAssistantChat, openPermanentAssistantCard } from './scripts/welcome-screen.js';
import { initDataMaid } from './scripts/data-maid.js';
import { saveDraft, loadDraft } from './scripts/chat-draft.js';
import { clearItemizedPrompts, deleteItemizedPromptForMessage, deleteItemizedPrompts, findItemizedPromptSet, initItemizedPrompts, itemizedParams, itemizedPrompts, loadItemizedPrompts, promptItemize, replaceItemizedPromptText, saveItemizedPrompts, swapItemizedPrompts } from './scripts/itemized-prompts.js';
import { getSystemMessageByType, initSystemMessages, SAFETY_CHAT, sendSystemMessage, system_message_types, system_messages } from './scripts/system-messages.js';
import { event_types, eventSource } from './scripts/events.js';
import { token, setToken, getRequestHeaders } from './scripts/request-headers.js';
import { chat, chat_metadata, setChatMetadata } from './scripts/chat-state.js';
import { active_character, active_group, name1, default_user_name, setActiveCharacter, setActiveGroup, setActiveCharacterAndGroupFromSettings, setName1Raw } from './scripts/app-selection-state.js';
import { amount_gen, max_context, main_api, setAmountGen, setMaxContext, setMainApi } from './scripts/generation-params.js';
// Re-exported for existing importers (upstream's script.js exports these too).
export { event_types, eventSource, getRequestHeaders, token, chat, chat_metadata, active_character, active_group, name1, amount_gen, max_context, main_api, setActiveCharacter, setActiveGroup };
import { initAccessibility } from './scripts/a11y.js';
import { applyStreamFadeIn } from './scripts/util/stream-fadein.js';
import { initDomHandlers } from './scripts/dom-handlers.js';
import { SimpleMutex } from './scripts/util/SimpleMutex.js';
import { AudioPlayer } from './scripts/audio-player.js';
import { MacroEnvBuilder } from './scripts/macros/engine/MacroEnvBuilder.js';
// Lives in message-formatting.js, isolated from this module's chat-store write access; re-exported for existing importers.
import { messageFormatting } from './scripts/message-formatting.js';
import { reportStoredHeader } from './scripts/stored-report.js';
export { messageFormatting };
// Lives in chat-store.js, the only module allowed to write messages; re-exported for existing importers.
import {
    updateMessage, updateIn, deepFreeze,
    ensureOpeningRow, chatOpEdit, chatOpEditMany, chatOpAppend, chatOpAddAlternative, chatOpEndPath, chatOpEndPathAtAnchor, chatOpSelect, chatOpGraft, chatOpDegraft, chatOpSwapAdjacent, chatOpDeleteAlternative, chatOpDeleteAlternativeNode,
    _mergeCardGreetingsIntoOpening, _restoreContinuation, _isBlankSlot, _setCurrentTarget, setStoreRef, adoptStored,
} from './scripts/chat-store.js';
export {
    updateMessage, updateIn,
    ensureOpeningRow, chatOpEdit, chatOpEditMany, chatOpAppend, chatOpAddAlternative, chatOpEndPath, chatOpEndPathAtAnchor, chatOpSelect, chatOpGraft, chatOpDegraft, chatOpSwapAdjacent, chatOpDeleteAlternative, chatOpDeleteAlternativeNode,
};
// Lives in node-identity.js, a standalone module with no dependency on anything else in this cluster; re-exported for existing importers.
import { isStoredNodeId, isProvisionalNodeId, provisionalNodeId } from './scripts/node-identity.js';
export { isStoredNodeId, isProvisionalNodeId, provisionalNodeId };
// Lives in metadata-store.js, isolated so it can be typechecked under strict null checks; re-exported for existing importers.
import { saveMetadata, _resetMetadataSaveSnapshot } from './scripts/metadata-store.js';
export { saveMetadata };
// Lives in node-navigation.js, isolated so it can be typechecked under strict null checks; re-exported for existing importers.
import { switchToNode, switchToAlternativePath } from './scripts/node-navigation.js';
export { switchToNode };
// Lives in generation.js, isolated so it can be typechecked under strict null checks; re-exported for existing importers.
import {
    Generate, stopGeneration,
    saveChat, saveChatConditional,
    isChatSaving, streamingProcessor, abortController, setAbortController, kobold_horde_model, generation_started,
    _messageSnapshots, _snapshotMessages, _isBlankUnwrittenSwipe, finishStreamedReplyPersistence,
} from './scripts/generation.js';
export {
    Generate, stopGeneration,
    saveChat, saveChatConditional,
    isChatSaving, streamingProcessor,
    _messageSnapshots,
};
import { MacroEngine } from './scripts/macros/engine/MacroEngine.js';
import { addChatBackupsBrowser } from './scripts/chat-backups.js';
import { onboardingExperimentalMacroEngine } from './scripts/macros/engine/MacroDiagnostics.js';
import { compressRequest, setRequestCompressionConfig } from './scripts/request-compression.js';
import { canJumpToSwipeForMessage, canOpenSwipePickerForMessage, initSwipePicker } from './scripts/swipe-picker.js';
import { PickAndPlace } from './scripts/pick-and-place.js';

// API OBJECT FOR EXTERNAL WIRING
globalThis.SillyTavern = {
    libs,
    getContext,
};

export {
    user_avatar,
    setUserAvatar,
    getUserAvatars,
    getUserAvatar,
    nai_settings,
    isOdd,
    countOccurrences,
    renderTemplate,
    promptItemize,
    itemizedPrompts,
    saveItemizedPrompts,
    loadItemizedPrompts,
    itemizedParams,
    clearItemizedPrompts,
    replaceItemizedPromptText,
    deleteItemizedPrompts,
    findItemizedPromptSet,
    koboldai_settings,
    koboldai_setting_names,
    novelai_settings,
    novelai_setting_names,
    UNIQUE_APIS,
    CONNECT_API_MAP,
    system_messages,
    system_message_types,
    sendSystemMessage,
    getSystemMessageByType,
    /** @deprecated Use setCharacterSettingsOverrides instead. */
    setCharacterSettingsOverrides as setScenarioOverride,
    /** @deprecated Use appendMediaToMessage instead. */
    appendMediaToMessage as appendImageToMessage,
    /** @deprecated Use getMaxPromptTokens instead. */
    getMaxPromptTokens as getMaxContextSize,
};

await new Promise((resolve) => {
    if (document.readyState === 'complete') {
        resolve();
    } else {
        window.addEventListener('load', resolve);
    }
});

toastr.options = {
    positionClass: 'toast-top-center',
    closeButton: false,
    progressBar: false,
    showDuration: 250,
    hideDuration: 250,
    timeOut: 4000,
    extendedTimeOut: 10000,
    showEasing: 'linear',
    hideEasing: 'linear',
    showMethod: 'fadeIn',
    hideMethod: 'fadeOut',
    escapeHtml: true,
    onHidden: function () {
        // Keep the toastr-container alive inside an open dialog, or its toasts stop showing there.
        fixToastrForDialogs();
    },
};

toastr.subscribe(function (args) {
    if (args.state !== 'visible') {
        return;
    }

    const $container = toastr.getContainer(args.options, false);
    if (!$container || !$container.length) {
        return;
    }

    // toastr has already inserted the element at this point
    const $toast = args.options.newestOnTop
        ? $container.children().first()
        : $container.children().last();

    // Meaning of "clickable":
    // Interactable unless tapToDismiss was explicitly false
    const isInteractable = args.options.tapToDismiss !== false;
    $toast.toggleClass('interactable', isInteractable);
    if (isInteractable) {
        $toast.attr('title', t`Tap to close`);
    } else {
        $toast.removeAttr('title');
        $toast.addClass('toast-non-interactable');
    }
});

export const characterGroupOverlay = new BulkEditOverlay();

// Markdown converter
export let mesForShowdownParse; //intended to be used as a context to compare showdown strings against
// Setter exists because `mesForShowdownParse` is an ESM live-binding: message-formatting.js can't assign to it directly.
export function setMesForShowdownParse(value) {
    mesForShowdownParse = value;
}
/** @type {import('showdown').Converter} */
export let converter;

// array for prompt token calculations

export const systemUserName = 'SillyTavern System';
export const neutralCharacterName = 'Assistant';
export let name2 = systemUserName;

/**
 * @type {import('./scripts/constants.js').SWIPE_STATE}
 */
export let swipeState = SWIPE_STATE.NONE;
let chatSaveTimeout;
let importFlashTimeout;
let firstRun = false;
export let settingsReady = false;
let currentVersion = '0.0.0';
export let displayVersion = 'SillyTavern';

// Not narrowed to specific ops/fields: invalidateCharactersFuseIndex() just sets a dirty flag, rebuild is lazy.
charactersStore.onChange(() => invalidateCharactersFuseIndex());
export function getCurrentCharacter() {
    return this_avatar !== undefined ? charactersStore.get(this_avatar) : undefined;
}

// Classifies selection as a tristate (character / group / none) instead of repeating the
// `this_chid === undefined && !selected_group` conjunction at every call site.
export function getSelectionState() {
    if (selected_group) {
        return { type: 'group', groupId: selected_group };
    }
    if (this_avatar !== undefined) {
        return { type: 'character', avatar: this_avatar };
    }
    return { type: 'none' };
}

export const default_avatar = 'img/ai4.png';
export const system_avatar = 'img/five.png';
export const comment_avatar = 'img/quill.png';
export const default_user_avatar = 'img/user-default.png';
export let CLIENT_VERSION = 'SillyTavern:UNKNOWN:Cohee#1207'; // For Horde header
let optionsPopper = Popper.createPopper(document.getElementById('options_button'), document.getElementById('options'), {
    placement: 'top-start',
});
let exportPopper = Popper.createPopper(document.getElementById('export_button'), document.getElementById('export_format_popup'), {
    placement: 'left',
});
let isExportPopupOpen = false;

// Saved here for performance reasons
const messageTemplate = $('#message_template .mes');
export const chatElement = $('#chat');

let dialogueResolve = null;
let dialogueCloseStop = false;
let crop_data = undefined;

/** @type {Object<string, {v1?: string, v2: string, transform?: string}>} */
const FORM_TO_CARD = {
    '#character_name_pole': { v1: 'name', v2: 'data.name' },
    '#description_textarea': { v1: 'description', v2: 'data.description' },
    '#personality_textarea': { v1: 'personality', v2: 'data.personality' },
    '#scenario_pole': { v1: 'scenario', v2: 'data.scenario' },
    '#mes_example_textarea': { v1: 'mes_example', v2: 'data.mes_example' },
    '#creator_notes_textarea': { v1: 'creatorcomment', v2: 'data.creator_notes' },
    '#system_prompt_textarea': { v2: 'data.system_prompt' },
    '#post_history_instructions_textarea': { v2: 'data.post_history_instructions' },
    '#tags_textarea': { v1: 'tags', v2: 'data.tags', transform: 'tags' },
    '#creator_textarea': { v2: 'data.creator' },
    '#character_version_textarea': { v2: 'data.character_version' },
    '#talkativeness_slider': { v1: 'talkativeness', v2: 'data.extensions.talkativeness', transform: 'number' },
    '#depth_prompt_prompt': { v2: 'data.extensions.depth_prompt.prompt' },
    '#depth_prompt_depth': { v2: 'data.extensions.depth_prompt.depth', transform: 'int' },
    '#depth_prompt_role': { v2: 'data.extensions.depth_prompt.role' },
    '#character_world': { v2: 'data.extensions.world' },
    // #character_book_json is a hidden field, not a visible control; world-info.js writes it directly.
    '#character_book_json': { v2: 'data.character_book', transform: 'json' },
};

/**
 * What the editor shows in a FORM_TO_CARD input for a stored card.
 * @param {object} character
 * @param {string} formId A FORM_TO_CARD key.
 * @returns {string}
 */
function characterFormValue(character, formId) {
    const data = character.data;
    switch (formId) {
        case '#character_name_pole': return String(character.name ?? '');
        case '#description_textarea': return String(character.description ?? '');
        case '#personality_textarea': return String(character.personality ?? '');
        case '#scenario_pole': return String(character.scenario ?? '');
        case '#mes_example_textarea': return String(character.mes_example ?? '');
        case '#creator_notes_textarea': return String(data?.creator_notes || character.creatorcomment || '');
        case '#system_prompt_textarea': return String(data?.system_prompt || '');
        case '#post_history_instructions_textarea': return String(data?.post_history_instructions || '');
        case '#tags_textarea': return Array.isArray(data?.tags) ? data.tags.join(', ') : '';
        case '#creator_textarea': return String(data?.creator ?? '');
        case '#character_version_textarea': return String(data?.character_version || '');
        case '#talkativeness_slider': return String(character.talkativeness || talkativeness_default);
        case '#depth_prompt_prompt': return String(data?.extensions?.depth_prompt?.prompt ?? '');
        case '#depth_prompt_depth': return String(data?.extensions?.depth_prompt?.depth ?? depth_prompt_depth_default);
        case '#depth_prompt_role': return String(data?.extensions?.depth_prompt?.role ?? depth_prompt_role_default);
        case '#character_world': return String(data?.extensions?.world || '');
        case '#character_book_json': return data?.character_book ? JSON.stringify(data.character_book) : '';
        default: throw new Error(`characterFormValue: ${formId} is not a character card field`);
    }
}

// Per-field hash of the value as it stood when the editor was populated, keyed by v2 path. Captured
// once at load time so a later change-feed sync of the character store can't mask a real conflict.
// Only ever describes the character the editor currently has loaded (`_loadedCharacterFieldHashesAvatar`).
/** @type {Map<string, number>} */
const _loadedCharacterFieldHashes = new Map();
/** @type {string|null} */
let _loadedCharacterFieldHashesAvatar = null;

/**
 * Same hash the server computes for its per-field conflict check.
 * @param {object} character
 * @param {string} v2Path
 * @returns {number}
 */
function hashCharacterFieldValue(character, v2Path) {
    const value = lodash.get(character, v2Path);
    return getStringHash(JSON.stringify(value !== undefined ? value : null));
}

/**
 * Seeds the conflict baseline for every field from the character just loaded into the editor; each field
 * save afterwards replaces its own entry with the hash the server hands back.
 * @param {object} character
 */
function snapshotLoadedCharacterFieldHashes(character) {
    _loadedCharacterFieldHashes.clear();
    _loadedCharacterFieldHashesAvatar = character?.avatar ?? null;
    for (const mapping of Object.values(FORM_TO_CARD)) {
        _loadedCharacterFieldHashes.set(mapping.v2, hashCharacterFieldValue(character, mapping.v2));
    }
}

/**
 * A conflict baseline for one field of any character, loaded in the editor or not, taken off the character
 * object the value being edited was read from. Pass it to {@link saveCharacterField}, which sends it and
 * keeps it current after each save.
 * @param {object} character
 * @param {string} formId A FORM_TO_CARD key, e.g. `'#character_book_json'`.
 * @returns {{hash: number|undefined}}
 */
export function characterFieldBaseline(character, formId) {
    const mapping = FORM_TO_CARD[formId];
    if (!mapping) {
        throw new Error(`characterFieldBaseline: ${formId} is not a character card field`);
    }
    return { hash: hashCharacterFieldValue(character, mapping.v2) };
}

/**
 * Converts a form field's string value into the value stored on the card.
 * @param {string} formId
 * @param {{transform?: string}} mapping
 * @param {string} value
 * @returns {{ok: true, value: any}|{ok: false}}
 */
function characterFieldValueToCardValue(formId, mapping, value) {
    if (mapping.transform === 'tags') {
        return { ok: true, value: value.split(',').map(x => x.trim()).filter(x => x) };
    }
    if (mapping.transform === 'number') {
        return { ok: true, value: Number(value) || 0 };
    }
    if (mapping.transform === 'int') {
        const n = Number(value);
        return { ok: true, value: !isNaN(n) ? n : 4 };
    }
    if (mapping.transform === 'json') {
        // '' means "no value" - unset the card path entirely rather than write an empty string/null over it.
        if (!value) {
            return { ok: true, value: UNSET_VALUE };
        }
        try {
            return { ok: true, value: JSON.parse(value) };
        } catch (err) {
            console.error(`saveCharacterField: failed to parse JSON for ${formId}, not saving it`, err);
            return { ok: false };
        }
    }
    return { ok: true, value };
}

/**
 * Field saves waiting out their debounce, keyed per character + field so a pending edit to one field is
 * never cancelled or absorbed by an edit to another.
 * @type {Map<string, {timer: ReturnType<typeof setTimeout>, avatar: string, formId: string, value: string}>}
 */
const pendingCharacterFieldSaves = new Map();

/**
 * Field saves in flight, serialized per character + field. `hash` is that field's current server-side
 * conflict baseline for this character, carried from one save to the next in the chain.
 * @type {Map<string, {tail: Promise<boolean>, hash: number|undefined}>}
 */
const characterFieldSaveChains = new Map();

/**
 * @param {string} avatar
 * @param {string} formId
 */
function characterFieldSaveKey(avatar, formId) {
    return `${avatar}\n${formId}`;
}

// A character whose field saves are still in flight, or that is loaded in the editor, stays held.
keepHeldCharacters(() => {
    const avatars = [...characterFieldSaveChains.keys(), ...pendingCharacterFieldSaves.keys()].map(key => key.split('\n')[0]);
    if (_loadedCharacterFieldHashesAvatar) avatars.push(_loadedCharacterFieldHashesAvatar);
    return avatars;
});

/**
 * The `id` CHARACTER_EDITED carries for an edit to `avatar`'s card: upstream's index into `characters`, which
 * upstream always takes from the edited character. `this_chid` when the edited character is the current one,
 * and undefined otherwise, so the event never carries an index that names a different character.
 * @param {string|undefined} avatar
 * @returns {string|undefined}
 */
function characterEditedId(avatar) {
    return avatar !== undefined && avatar === this_avatar ? this_chid : undefined;
}

/**
 * Saves exactly one character field - only this field is sent, through `/api/characters/merge-attributes`,
 * with its own per-field conflict check. Never reads the form.
 * @param {string} avatar Avatar filename of the character being edited.
 * @param {string} formId A FORM_TO_CARD key, e.g. `'#description_textarea'`.
 * @param {string} value The field's value, in the form's own string representation.
 * @param {{hash: number|undefined}} [baseline] The conflict baseline the value was edited from, from
 * {@link characterFieldBaseline}; required when the character isn't the one loaded in the editor. Updated with
 * the server's hash after each save.
 * @returns {Promise<boolean>} Whether the value was saved.
 */
export function saveCharacterField(avatar, formId, value, baseline = undefined) {
    const mapping = FORM_TO_CARD[formId];
    if (!mapping) {
        throw new Error(`saveCharacterField: ${formId} is not a character card field`);
    }
    if (!avatar) {
        throw new Error(`saveCharacterField: no character to save ${formId} to`);
    }

    const key = characterFieldSaveKey(avatar, formId);
    let chain = characterFieldSaveChains.get(key);
    if (!chain) {
        let hash;
        if (baseline) {
            hash = baseline.hash;
        } else {
            // Read synchronously, before any await: callers that switch the editor to another character
            // flush first (see flushCharacterFieldSaves()), so the baseline here is still this character's.
            if (_loadedCharacterFieldHashesAvatar !== avatar) {
                throw new Error(`saveCharacterField: ${avatar} is not the character loaded in the editor`);
            }
            hash = _loadedCharacterFieldHashes.get(mapping.v2);
        }
        chain = { tail: Promise.resolve(true), hash };
        characterFieldSaveChains.set(key, chain);
    }

    const run = async () => {
        const converted = characterFieldValueToCardValue(formId, mapping, value);
        if (!converted.ok) {
            return false;
        }

        const mergeData = { avatar };
        if (mapping.v1) lodash.set(mergeData, mapping.v1, converted.value);
        lodash.set(mergeData, mapping.v2, converted.value);
        mergeData._loadedFieldHashes = { [mapping.v2]: chain.hash };

        try {
            const fetchResult = await fetch('/api/characters/merge-attributes', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify(mergeData),
            });

            // The server's fresh post-write hash for this field, on a plain (non-conflict) success.
            let savedHash;

            if (fetchResult.status === 409) {
                let errorData;
                try { errorData = await fetchResult.json(); } catch { /* ignore parse errors */ }
                if (errorData?.error !== 'conflict') {
                    throw new Error('Field save refused');
                }
                const fieldName = mapping.v2.replace(/^data\.extensions\.depth_prompt\./, 'Depth Prompt ')
                    .replace(/^data\.extensions\./, '')
                    .replace(/^data\./, '')
                    .replace(/_/g, ' ');
                // Named, since the save may be for a character other than the one the panel now shows.
                const characterName = escapeHtml(String(charactersStore.get(avatar)?.name ?? avatar));

                const confirmOverwrite = await callGenericPopup(
                    t`<h3>Character edited in another session</h3>
                      <p>The following fields of <strong>${characterName}</strong> were changed by another session:</p>
                      <p><strong>${fieldName}</strong></p>
                      <p>Overwrite with your version, or discard your changes?</p>`,
                    POPUP_TYPE.CONFIRM,
                    '',
                    { okButton: t`Overwrite with mine`, cancelButton: t`Discard my changes` },
                );
                if (confirmOverwrite !== POPUP_RESULT.AFFIRMATIVE) {
                    window.location.reload();
                    return false;
                }
                delete mergeData._loadedFieldHashes;
                const retryResult = await fetch('/api/characters/merge-attributes', {
                    method: 'POST',
                    headers: getRequestHeaders(),
                    body: JSON.stringify(mergeData),
                });
                if (!retryResult.ok) {
                    throw new Error('Force save after conflict failed');
                }
            } else if (!fetchResult.ok) {
                throw new Error('Fetch result is not ok');
            } else {
                try {
                    const payload = await fetchResult.json();
                    savedHash = payload?.hashes?.[mapping.v2];
                } catch { /* no body, or not JSON - the fallback below covers it */ }
            }

            await getOneCharacter(avatar);
            const character = charactersStore.get(avatar);

            // Server-issued when it gave one; otherwise (forced overwrite) computed off the reloaded card.
            chain.hash = Number.isFinite(savedHash) ? savedHash : hashCharacterFieldValue(character, mapping.v2);
            if (_loadedCharacterFieldHashesAvatar === avatar) {
                _loadedCharacterFieldHashes.set(mapping.v2, chain.hash);
            }
            if (baseline) {
                baseline.hash = chain.hash;
            }

            await eventSource.emit(event_types.CHARACTER_EDITED, { detail: { id: characterEditedId(avatar), character } });
            updateCharacterListRow(avatar);
            return true;
        } catch (error) {
            console.error(`Failed to save ${formId} for ${avatar}`, error);
            toastr.error(t`Something went wrong while saving the character. Your edit is still shown here, but it was not saved.`);
            return false;
        }
    };

    const tail = chain.tail.then(run);
    chain.tail = tail;
    tail.finally(() => {
        if (characterFieldSaveChains.get(key)?.tail === tail) {
            characterFieldSaveChains.delete(key);
        }
    });
    return tail;
}

/**
 * Debounced {@link saveCharacterField}: one debounce per character + field.
 * @param {string} avatar
 * @param {string} formId
 * @param {string} value
 */
export function saveCharacterFieldDebounced(avatar, formId, value) {
    if (!avatar) return;
    const key = characterFieldSaveKey(avatar, formId);
    const pending = pendingCharacterFieldSaves.get(key);
    if (pending) {
        clearTimeout(pending.timer);
    }
    const timer = setTimeout(() => {
        pendingCharacterFieldSaves.delete(key);
        void saveCharacterField(avatar, formId, value);
    }, DEFAULT_SAVE_EDIT_TIMEOUT);
    pendingCharacterFieldSaves.set(key, { timer, avatar, formId, value });
}

/**
 * Starts every debounced field save now, then resolves once every field save (including ones already in
 * flight) has finished. The debounced ones are started synchronously, before this returns.
 * @returns {Promise<void>}
 */
export async function flushCharacterFieldSaves() {
    const pending = [...pendingCharacterFieldSaves.values()];
    pendingCharacterFieldSaves.clear();
    for (const save of pending) {
        clearTimeout(save.timer);
        saveCharacterField(save.avatar, save.formId, save.value);
    }
    await Promise.all([...characterFieldSaveChains.values()].map(chain => chain.tail));
}

/** @returns {string} Avatar filename of the character loaded in the editor, or '' when none is. */
function getEditorCharacterAvatar() {
    return String($('#avatar_url_pole').val() ?? '');
}

/**
 * In create mode the value goes into `create_save`, which is what Create builds the new character from.
 * @param {string} formId
 * @param {keyof typeof create_save} createSaveKey
 * @param {string} value
 * @returns {Promise<boolean>}
 */
async function saveTextField(formId, createSaveKey, value) {
    if (menu_type === 'create') {
        create_save[createSaveKey] = value;
        return true;
    }
    return await saveCharacterField(getEditorCharacterAvatar(), formId, value);
}

/** @param {string} value @returns {Promise<boolean>} */
export function saveCreatorNotesField(value) {
    return saveTextField('#creator_notes_textarea', 'creator_notes', value);
}

/** @param {string} value @returns {Promise<boolean>} */
export function saveDescriptionField(value) {
    return saveTextField('#description_textarea', 'description', value);
}

/** @param {string} value @returns {Promise<boolean>} */
export function saveSystemPromptField(value) {
    return saveTextField('#system_prompt_textarea', 'system_prompt', value);
}

/** @param {string} value @returns {Promise<boolean>} */
export function savePostHistoryInstructionsField(value) {
    return saveTextField('#post_history_instructions_textarea', 'post_history_instructions', value);
}

/** @param {string} value @returns {Promise<boolean>} */
function savePersonalityField(value) {
    return saveTextField('#personality_textarea', 'personality', value);
}

/** @param {string} value @returns {Promise<boolean>} */
function saveScenarioField(value) {
    return saveTextField('#scenario_pole', 'scenario', value);
}

/** @param {string} value @returns {Promise<boolean>} */
function saveCharacterNoteField(value) {
    return saveTextField('#depth_prompt_prompt', 'depth_prompt_prompt', value);
}

/** @param {string} value @returns {Promise<boolean>} */
function saveExampleMessagesField(value) {
    return saveTextField('#mes_example_textarea', 'mes_example', value);
}

let is_delete_mode = false;
let fav_ch_checked = false;
let scrollLock = false;
export let abortStatusCheck = new AbortController();
export let charDragDropHandler = null;
export let chatDragDropHandler = null;

/** @type {debounce_timeout} The debounce timeout used for chat/settings save. debounce_timeout.long: 1.000 ms */
export const DEFAULT_SAVE_EDIT_TIMEOUT = debounce_timeout.relaxed;

// The window's keys are already in pendingSettingsKeys.
const _debouncedSaveImpl = debounce(() => {
    const { full, count } = _settingsSaveWindow;
    _settingsSaveWindow = { full: false, count: 0 };
    return runSettingsSave({ full, count });
}, DEFAULT_SAVE_EDIT_TIMEOUT);

/**
 * A full request anywhere in the window makes its run a full save, so it is never dropped.
 * The count is the last call's, as a plain debounce() of saveSettings(loopCounter) would pass it.
 * @param {{ full: boolean, count: any }} save The call's kind and count.
 */
function scheduleSettingsSave({ full, count }) {
    _settingsSaveWindow = { full: _settingsSaveWindow.full || full, count };
    _debouncedSaveImpl();
}

/**
 * Saves settings after the debounce window. A string first argument is a keyed partial save of the string arguments;
 * anything else (a number, or no argument) is a full save, which also includes any pending keys.
 * @param {number|string} [loopCounter] Retry count of a full save, or the first key of a keyed save.
 * @param {...string} keys Further settings keys to save.
 */
export function saveSettingsDebounced(loopCounter, ...keys) {
    // Upstream's extensions change `tags` and `tag_map` and then ask for a settings save to have them stored.
    noteTagExportsMayHaveChanged();
    scheduleSettingsSave(readSettingsSaveArgs(loopCounter, keys));
}


// With a search term the list isn't re-queried here; the visible page is, on 'search-index-updated'.
const getCharactersDebounced = debounce(() => getCharacters({ skipPrint: hasActiveCharacterSearch(), keepListPosition: true }), 2000);

/**
 * The warning for a queued tag move the server couldn't apply. src/character-metadata-db.js's tagMoveFailedText()
 * says the same.
 * @param {{ tagId: string, tagName: string | null, anchorId: string | null, anchorName: string | null, refusedId: string, reason: string }} message
 */
function tagMoveFailedText({ tagId, tagName, anchorId, anchorName, refusedId, reason }) {
    const tag = tagName ?? tagId;
    if (anchorId === null) return `Couldn't set the order of tag "${tag}": its stored data couldn't be read.`;
    const anchor = anchorName ?? anchorId;
    const prefix = `Couldn't move tag "${tag}" next to "${anchor}": `;
    switch (reason) {
        case 'deleted': return `${prefix}"${anchor}" was deleted.`;
        case 'unreadable': return `${prefix}the stored data of "${refusedId === tagId ? tag : refusedId === anchorId ? anchor : refusedId}" couldn't be read.`;
        case 'unordered': return `${prefix}"${anchor}" is too far into the tags with no order.`;
        case 'no-room': return `${prefix}there was no room left in the order.`;
    }
}

/**
 * The warning for a card the server couldn't put in its search index (src/endpoints/characters-search-index.js's
 * CharacterIndexFailure). A card whose name is empty is named by its id alone.
 * @param {{ id: string, name: string, error: string, retryInMs: number, keptEntry: boolean }} message
 */
function characterIndexFailedText({ id, name, error, retryInMs, keptEntry }) {
    const card = name ? `"${name}" (${id})` : id;
    const entry = keptEntry ? 'It keeps its previous search entry, if it had one,' : 'It has no search entry';
    return `Couldn't update the search entry of character ${card}: ${error}. ${entry} until a retry in ${Math.ceil(retryInMs / 1000)}s succeeds.`;
}

const CHANGE_STREAM_NOTICE_AFTER_MS = 10000;

function onCharacterChangeMessage() {
    // Wherever a held character's tags are shown, not only in the list.
    onEntityTagsChanged();
    if (isCharacterListShowing()) {
        getCharactersDebounced();
    } else {
        _charactersDirty = true;
    }
}

// One SSE connection per tab, doubling as change notification and presence heartbeat - avoids exhausting the per-origin connection pool.
function setupCharacterChangeStream() {
    if (typeof EventSource === 'undefined') return;
    // Messages sent while the stream was down are lost, so an open that follows an error counts as both kinds of message.
    let hadError = false;
    let failedTries = 0;
    let notice = null;
    let noticeTimer = null;
    const startNoticeTimer = () => {
        if (noticeTimer !== null || notice) return;
        noticeTimer = setTimeout(() => {
            noticeTimer = null;
            notice = toastr.warning(t`Live updates are disconnected. Retrying...`, '', { timeOut: 0, extendedTimeOut: 0 });
        }, CHANGE_STREAM_NOTICE_AFTER_MS);
    };

    const connect = (isRebuild) => {
        const source = new EventSource('/api/characters/changes/stream');
        let opened = false;
        source.onmessage = (event) => {
            let message;
            try {
                message = JSON.parse(event.data);
            } catch {
                message = null;
            }
            if (message?.type === 'search-index-updated') {
                onSearchIndexUpdated();
                return;
            }
            if (message?.type === 'tag-move-failed') {
                toastr.warning(tagMoveFailedText(message));
                return;
            }
            if (message?.type === 'tags-changed' || message?.type === 'tag-order-settled') {
                onTagsChanged();
                return;
            }
            if (message?.type === 'groups-changed') {
                onEntityTagsChanged();
                return;
            }
            if (message?.type === 'character-index-failed') {
                toastr.warning(characterIndexFailedText(message));
                return;
            }
            onCharacterChangeMessage();
        };
        source.onopen = () => {
            opened = true;
            failedTries = 0;
            clearTimeout(noticeTimer);
            noticeTimer = null;
            if (notice) {
                toastr.clear(notice);
                notice = null;
            }
            if (!hadError) return;
            hadError = false;
            onCharacterChangeMessage();
            onSearchIndexUpdated();
            onTagsChanged();
        };
        source.onerror = () => {
            hadError = true;
            startNoticeTimer();
            // Any other state is the browser reconnecting on its own. It never reconnects a CLOSED one, so that's rebuilt.
            if (source.readyState !== EventSource.CLOSED) return;
            if (isRebuild && !opened) failedTries++;
            setTimeout(() => connect(true), changeStreamRetryDelayMs(failedTries));
        };
    };
    startNoticeTimer();
    connect(false);
}

/**
 * @enum {number} Extension prompt types
 */
export const extension_prompt_types = {
    NONE: -1,
    IN_PROMPT: 0,
    IN_CHAT: 1,
    BEFORE_PROMPT: 2,
};

/**
 * @enum {number} Extension prompt roles
 */
export const extension_prompt_roles = {
    SYSTEM: 0,
    USER: 1,
    ASSISTANT: 2,
};

export const MAX_INJECTION_DEPTH = 10000;

async function getClientVersion() {
    try {
        const response = await fetch('/version');
        const data = await response.json();
        CLIENT_VERSION = data.agent;
        displayVersion = `SillyTavern ${data.pkgVersion}`;
        currentVersion = data.pkgVersion;

        if (data.gitRevision && data.gitBranch) {
            displayVersion += ` '${data.gitBranch}' (${data.gitRevision})`;
        }

        $('#version_display').text(displayVersion);
        $('#version_display_welcome').text(displayVersion);
    } catch (err) {
        console.error('Couldn\'t get client version', err);
    }
}

export function reloadMarkdownProcessor() {
    converter = new showdown.Converter({
        emoji: true,
        literalMidWordUnderscores: true,
        parseImgDimensions: true,
        tables: true,
        underline: true,
        simpleLineBreaks: true,
        strikethrough: true,
        disableForced4SpacesIndentedSublists: true,
        extensions: [markdownUnderscoreExt()],
    });

    // Inject the dinkus extension after creating the converter
    // Maybe move this into power_user init?
    converter.addExtension(markdownExclusionExt(), 'exclusion');

    reloadMarkedProcessor(power_user.markdown_escape_strings, substituteParams);

    return converter;
}

export function getCurrentChatId() {
    const selection = getSelectionState();
    if (selection.type === 'group') {
        return groupsStore.get(selection.groupId)?.chat_id;
    } else if (selection.type === 'character') {
        return getCurrentCharacter()?.chat;
    }
}

// null means no fully-resolved chat to scope a draft to - callers must skip save/load/clear, not fall back to
// a shared key that unrelated chats could collide on.
export function getCurrentDraftContext() {
    const selection = getSelectionState();
    const chatId = getCurrentChatId();
    if (!chatId) {
        return null;
    }
    if (selection.type === 'group') {
        return { type: 'group', id: selection.groupId, chatId };
    }
    if (selection.type === 'character') {
        return { type: 'character', id: selection.avatar, chatId };
    }
    return null;
}

// Synchronous, so safe to call directly right before a page reload rather than relying on the debounced wrapper.
export function flushDraftSave() {
    const context = getCurrentDraftContext();
    if (!context) {
        return;
    }
    saveDraft(localStorage, context, String($('#send_textarea').val()));
}

const saveDraftDebounced = debounce(flushDraftSave, debounce_timeout.standard);

export const talkativeness_default = 0.5;
export const depth_prompt_depth_default = 4;
export const depth_prompt_role_default = 'system';
export const per_page_default = 50;

/**
 * The type of the right menu
 * @typedef {'characters' | 'character_edit' | 'create' | 'group_edit' | 'group_create' | '' } MenuType
 */

/**
 * The type of the right menu that is currently open
 * @type {MenuType}
 */
export let menu_type = '';

let _charactersDirty = false;
let characterListWasShowing = false;
// Set while select_rm_characters() shows the list, since it re-queries the list itself.
let characterListShowHandledByCaller = false;

export let selected_button = ''; //which button pressed

//create pole save
export let create_save = {
    name: '',
    description: '',
    creator_notes: '',
    post_history_instructions: '',
    character_version: '',
    system_prompt: '',
    tags: '',
    creator: '',
    personality: '',
    first_message: '',
    /** @type {FileList|null} */
    avatar: null,
    scenario: '',
    mes_example: '',
    world: '',
    talkativeness: talkativeness_default,
    alternate_greetings: [],
    depth_prompt_prompt: '',
    depth_prompt_depth: depth_prompt_depth_default,
    depth_prompt_role: depth_prompt_role_default,
    extensions: {},
    extra_books: [],
};

//animation right menu
export const ANIMATION_DURATION_DEFAULT = 125;
export let animation_duration = ANIMATION_DURATION_DEFAULT;
export let animation_easing = 'ease-in-out';
let popup_type = '';
let chat_file_for_del = '';
export let online_status = 'no_connection';

export let is_send_press = false; //Send generation
export const isGenerating = () => (is_send_press || is_group_generating);

let this_del_mes = -1;
let deleteToolCallsInDeleteMode = true;

/** @type {string} */
let this_edit_mes_chname = '';
/** @type {number|undefined} */
let this_edit_mes_id = undefined;

//settings
export let settings;
// Lets saveSettings() skip a POST when the rebuilt payload hashes the same as last time.
/** @type {number|null} */
let lastSavedSettingsHash = null;
// Hash (server key order) of settings this client believes is persisted server-side; sent as X-Settings-Hash for conflict detection.
/** @type {number|null} */
let knownServerSettingsHash = null;
// Settings keys marked for saving and not yet sent; a keyed save sends them, a full save includes them in the blob.
const pendingSettingsKeys = new Set();
// Per-key content hashes of what this client believes the server has; used for the partial save's expectedHashes conflict check.
/** @type {Record<string, number>} */
const serverKeyHashes = {};
// Kind and count of the pending debounced save window (see scheduleSettingsSave()); reset when the window runs or is cancelled.
/** @type {{ full: boolean, count: any }} */
let _settingsSaveWindow = { full: false, count: 0 };
// Serializes saveSettings() so overlapping calls can't race on a stale serverKeyHashes snapshot.
let _saveQueue = Promise.resolve();
/** User preference for swipeable messages */
let swipes = true;
/** Forcefully hide swipes. */
export let swipesHidden = false;
/** @type {{ now: number, direction: string }} */
export let lastSwipeInfo = { now: performance.now(), direction: SWIPE_DIRECTION.RIGHT };
export let recentSwipes = 0;

export let extension_prompts = {};

//css
var css_send_form_display = $('<div id=send_form></div>').css('display');


export function getSlideToggleOptions() {
    return {
        miliseconds: animation_duration * 1.5,
        transitionFunction: animation_duration > 0 ? 'ease-in-out' : 'step-start',
    };
}

$.ajaxPrefilter((options, originalOptions, xhr) => {
    xhr.setRequestHeader('X-CSRF-Token', token);
});

/**
 * Pings the STserver to check if it is reachable.
 * @returns {Promise<boolean>} True if the server is reachable, false otherwise.
 */
export async function pingServer() {
    try {
        const result = await fetch('api/ping', {
            method: 'POST',
            headers: getRequestHeaders({ omitContentType: true }),
        });

        if (!result.ok) {
            return false;
        }

        return true;
    } catch (error) {
        console.error('Error pinging server', error);
        return false;
    }
}

//MARK: firstLoadInit
async function firstLoadInit() {
    try {
        const tokenResponse = await fetch('/csrf-token');
        const tokenData = await tokenResponse.json();
        setToken(tokenData.token);
    } catch {
        toastr.error(t`Couldn't get CSRF token. Please refresh the page.`, t`Error`, { timeOut: 0, extendedTimeOut: 0, preventDuplicates: true });
        throw new Error('Initialization failed');
    }

    const initLoaderOverlay = loader.createOverlay();
    initLoaderOverlay.classList.add('splash-screen');

    const splashLogo = document.createElement('img');
    splashLogo.src = '/img/logo.png';
    splashLogo.alt = 'SillyTavern';
    splashLogo.className = 'splash-logo';
    splashLogo.ariaLabel = t`SillyTavern Logo`;

    const splashMessage = document.createElement('h2');
    splashMessage.className = 'splash-message';

    const splashLabel = document.createElement('span');
    splashLabel.className = 'splash-label';
    splashLabel.textContent = t`Initializing…`;

    const splashElapsed = document.createElement('span');
    splashElapsed.className = 'splash-elapsed';

    splashMessage.appendChild(splashLabel);
    splashMessage.appendChild(splashElapsed);

    const splashStagesLog = document.createElement('div');
    splashStagesLog.className = 'splash-stages-log';

    initLoaderOverlay.prepend(splashLogo);
    initLoaderOverlay.appendChild(splashMessage);
    initLoaderOverlay.appendChild(splashStagesLog);

    const bootStart = performance.now();
    /** @type {{stage: string, ms: number}[]} */
    const stageTimings = [];
    let stageStart = bootStart;
    let currentStageLabel = 'Init';

    function setStage(label) {
        const now = performance.now();
        const elapsed = now - stageStart;
        stageTimings.push({ stage: currentStageLabel, ms: elapsed });

        const entry = document.createElement('div');
        entry.className = 'splash-stage-entry';
        entry.textContent = `${currentStageLabel} — ${(elapsed / 1000).toFixed(1)}s`;
        splashStagesLog.appendChild(entry);

        currentStageLabel = label;
        stageStart = now;
        splashLabel.textContent = `${label}…`;
        splashElapsed.textContent = '';
    }

    const elapsedInterval = setInterval(() => {
        const secs = (performance.now() - stageStart) / 1000;
        splashElapsed.textContent = secs >= 0.5 ? ` ${secs.toFixed(1)}s` : '';
    }, 100);

    const initLoaderHandle = loader.show({
        slug: 'app-init',
        toastMode: loader.ToastMode.NONE,
        overlayContent: initLoaderOverlay,
    });

    registerPromptManagerMigration();
    initDomHandlers();
    initStandaloneMode();
    initLibraryShims();
    addShowdownPatch(showdown);
    addDOMPurifyHooks();
    reloadMarkdownProcessor();
    applyBrowserFixes();

    setStage('Loading client info');
    await getClientVersion();

    setStage('Loading secrets');
    await initSecrets();
    await readSecretState();

    setStage('Loading locales');
    await initLocales();
    initChatUtilities();
    initCharacterFieldEditor({
        substituteParams,
        messageFormatting,
        formatCreatorNotes: text => formatCreatorNotes(text, menu_type === 'create' ? '' : getCurrentCharacter()?.avatar),
        power_user,
        t,
        autoSaveTimeout: DEFAULT_SAVE_EDIT_TIMEOUT,
        saveCreatorNotesField,
        saveDescriptionField,
        saveGreetingField,
        saveSystemPromptField,
        savePostHistoryInstructionsField,
        savePersonalityField,
        saveScenarioField,
        saveCharacterNoteField,
        saveExampleMessagesField,
        confirmDiscard: async (title, text) => Boolean(await Popup.show.confirm(title, text)),
        onEditStart: id => { if (id === 'greeting_field') beginGreetingPagerEdit(); },
        onEditEnd: id => { if (id === 'greeting_field') endGreetingPagerEdit(); },
    });
    initCharInfoTabDimming(() => greetingPagerState.greetings.some((greeting, i) => i !== greetingPagerState.index && greeting !== ''));
    initDefaultSlashCommands();
    initTextGenModels();
    initOpenAI();
    initTextGenSettings();
    initKoboldSettings();
    initNovelAISettings();
    initSystemPrompts();

    setStage('Loading extensions');
    await initExtensions();
    initExtensionSlashCommands();
    ToolManager.initToolSlashCommands();

    setStage('Loading presets');
    await initPresetManager();
    await initSystemMessages();

    setStage('Loading settings');
    await getSettings(initLoaderHandle, setStage);

    setStage('Loading user data');
    await checkOpenRouterAuth();
    initKeyboard();
    initDynamicStyles();
    initTags();
    initBookmarks();
    await getUserAvatars(true, user_avatar);

    // Doesn't gate first paint; awaited right before APP_READY, so the first sync has run by then.
    let residencySettled = false;
    const characterResidencyPromise = (async () => {
        await seedCharactersFromCache();
        await getCharacters();
        // Must run after getCharacters() (also awaits getGroups()): tag assignments live on characters'/groups'
        // own tag_ids, so their usage-count index can't be built until both are resident.
        await reindexTagAssignments();
    })();
    characterResidencyPromise.then(() => { residencySettled = true; }, () => { residencySettled = true; });

    setStage('Rendering characters');
    await printCharacters(true);
    setupCharacterChangeStream();

    setStage('Loading assets');
    await getBackgrounds();
    await initTokenizers();
    initBackgrounds();
    initAuthorsNote();
    await initPersonas();
    await initSlashCommandAutoComplete();
    initMacroAutoComplete();
    initWorldInfo();
    initHorde();
    initRossMods();
    initStats();
    initCfg();
    initLogprobs();
    initInputMarkdown();
    initAutosizeTextareas();
    initServerHistory();
    initSettingsSearch();
    initBulkEdit();
    initReasoning();
    initWelcomeScreen();

    setStage('Starting up');
    await initScrapers();
    initCustomSelectedSamplers();
    initDataMaid();
    initItemizedPrompts();
    initAccessibility();
    initSwipePicker();
    addDebugFunctions();
    doDailyExtensionUpdatesCheck();
    await eventSource.emit(event_types.APP_INITIALIZED);

    stageTimings.push({ stage: currentStageLabel, ms: performance.now() - stageStart });
    clearInterval(elapsedInterval);

    const totalMs = performance.now() - bootStart;
    console.groupCollapsed(`[Boot] Completed in ${(totalMs / 1000).toFixed(2)}s`);
    console.table(stageTimings.map(s => ({ Stage: s.stage, Duration: `${(s.ms / 1000).toFixed(2)}s` })));
    console.groupEnd();

    await initLoaderHandle.hide();
    await fixViewport();
    try {
        if (!residencySettled) {
            const residencyWaitStart = performance.now();
            await characterResidencyPromise;
            console.log(`[Boot] Character residency resolved ${((performance.now() - residencyWaitStart) / 1000).toFixed(2)}s after splash`);
        } else {
            await characterResidencyPromise;
        }
    } catch (error) {
        console.error('[Boot] Character residency failed:', error);
        showCharacterSyncFailedToast();
    }
    await eventSource.emit(event_types.APP_READY);
    showMigrationNotices({ t, escapeHtml }).catch(error => console.error('Could not show migration notices', error));
}

async function fixViewport() {
    document.body.style.position = 'absolute';
    await delay(1);
    document.body.style.position = '';
}

function initStandaloneMode() {
    const isPwaMode = window.matchMedia('(display-mode: standalone)').matches;
    if (isPwaMode) {
        $('body').addClass('PWA');
    }
}

export function cancelStatusCheck(reason = 'Manually cancelled status check') {
    abortStatusCheck?.abort(new AbortReason(reason));
    abortStatusCheck = new AbortController();
    setOnlineStatus('no_connection');
}

export function displayOnlineStatus() {
    if (online_status == 'no_connection') {
        $('.online_status_indicator').removeClass('success');
        $('.online_status_text').text($('#API-status-top').attr('no_connection_text'));
    } else {
        $('.online_status_indicator').addClass('success');
        $('.online_status_text').text(online_status);
    }
}

/**
 * Sets the duration of JS animations.
 * @param {number} ms Duration in milliseconds. Resets to default if null.
 */
export function setAnimationDuration(ms = null) {
    animation_duration = ms ?? ANIMATION_DURATION_DEFAULT;
    // Set CSS variable to document
    document.documentElement.style.setProperty('--animation-duration', `${animation_duration}ms`);
}

export function startStatusLoading() {
    $('.api_loading').show();
    $('.api_button').addClass('disabled');
}

export function stopStatusLoading() {
    $('.api_loading').hide();
    $('.api_button').removeClass('disabled');
}

export function resultCheckStatus() {
    displayOnlineStatus();
    stopStatusLoading();
}

// Prefer this over selectCharacterById() internally - avatar is the source of truth (this_avatar), no
// array-index lookup needed.
export async function selectCharacterByAvatar(avatar, { switchMenu = true } = {}) {
    let entity = charactersStore.get(avatar);
    if (!entity) {
        // Can be hit before boot residency hydration finishes; an explicit open is worth an on-demand fetch.
        try {
            const response = await fetch('/api/characters/get', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ avatar_url: avatar }),
            });
            if (response.ok) {
                const data = await response.json();
                // Same normalization as finalizeFetchedCharacter(): a character with no active
                // chat pointer comes back with `chat` unset/null (Workstream 6 - that's a valid,
                // common state now, not an error) - `String(undefined)` would otherwise corrupt it
                // into the literal string "undefined" and get treated as a real (bogus) chat name.
                data.chat = data.chat ? String(data.chat) : '';
                data.shallow = false;
                // Re-check: a concurrent fetch may have made this resident while this request was in flight.
                entity = charactersStore.get(avatar) ?? charactersStore.create(data)?.entity;
            }
        } catch (error) {
            console.error('Failed to resolve character for open:', avatar, error);
        }
        if (!entity) {
            toastr.error(t`Character ${avatar} not found`, t`Error`, { timeOut: 5000, preventDuplicates: true });
            return;
        }
    }

    if (isChatSaving) {
        toastr.info(t`Please wait until the chat is saved before switching characters.`, t`Your chat is still saving...`);
        return;
    }

    if (selected_group && is_group_generating) {
        return;
    }

    if (selected_group || String(this_avatar) !== String(avatar)) {
        //if clicked on a different character from what was currently selected
        if (blockWhileFieldEditing()) {
            return;
        }
        if (!is_send_press) {
            setCharacterId(undefined);
            setCharacterName('');
            resetSelectedGroup();
            await clearChat({ clearData: true });
            cancelTtsPlay();
            this_edit_mes_id = undefined;
            selected_button = 'character_edit';
            setCharacterId(entity);
            setChatMetadata({});
            _resetMetadataSaveSnapshot();
            await getChat();
        } else {
            toastr.info(t`Please wait until the current generation finishes before switching characters.`, t`Generation in progress...`);
        }
    } else {
        //if clicked on character that was already selected
        switchMenu && (selected_button = 'character_edit');
        await unshallowCharacter(avatar);
        select_selected_character(avatar, { switchMenu });
    }
}


async function delChat(chatfile) {
    const response = await fetch('/api/chats/delete', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            chatfile: chatfile,
            avatar_url: getCurrentCharacter().avatar,
        }),
    });
    if (response.ok === true) {
        // choose another chat if current was deleted
        const name = chatfile.replace('.jsonl', '');
        if (name === getCurrentCharacter().chat) {
            setChatMetadata({});
            _resetMetadataSaveSnapshot();
            await replaceCurrentChat();
        }
        await eventSource.emit(event_types.CHAT_DELETED, name);
    }
}

/**
 * Deletes a character chat by its name.
 * @param {string|number} characterId An index into `getContext().characters`, or an avatar key
 * @param {string} fileName Name of the chat file to delete (without .jsonl extension)
 * @returns {Promise<void>} A promise that resolves when the chat is deleted.
 */
export async function deleteCharacterChatByName(characterId, fileName) {
    // Make sure all the data is loaded.
    await unshallowCharacter(characterId);

    const character = resolveCharacterRef(characterId);
    if (!character) {
        console.warn(`Character ${characterId} not found.`);
        return;
    }

    const response = await fetch('/api/chats/delete', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            chatfile: `${fileName}.jsonl`,
            avatar_url: character.avatar,
        }),
    });

    if (!response.ok) {
        console.error('Failed to delete chat for character.');
        return;
    }

    // The server already atomically repointed the deleted chat's owner - whichever character that
    // is, not necessarily the globally-selected/on-screen one, since this is called from the
    // "recent chats" list, which can list any character - to its most recently active remaining
    // chat (or cleared the pointer if none remain), as part of the delete itself. When it did,
    // `activeChat` carries the result; mirror it onto the stored character record without touching
    // the live `chat`/`chat_metadata` UI state, which belongs to whichever character is actually
    // being displayed right now.
    const data = await response.json().catch(() => null);
    if (data && typeof data.activeChat === 'string') {
        character.chat = data.activeChat;
    }

    await eventSource.emit(event_types.CHAT_DELETED, fileName);
}

/**
 * Clears this character's active-chat pointer and rebuilds the opening state from the card/tree,
 * with no name-minting step (Workstream 6: a character's conversation is one anchor with no
 * required name - "nothing to point at yet" is a valid, final state, not something that needs a
 * fabricated `${name} - ${timestamp}` string, client- or server-side).
 *
 * getFirstMessage() -> _openingFromTree() resolves this character's real, stored opening node id
 * whenever real anchor-rooted history already exists (even if it was never labeled/named) - and
 * loadAtNode()'s own default-child descent (server-side) recovers the FULL current conversation
 * from that single node id on the next load, not just the opening line. Only a genuinely
 * never-touched character, or one whose card-only greeting has never been used, falls back to an
 * empty pointer here.
 */
async function pointToFreshChat() {
    _setCurrentTarget('', null);
    $('#selected_chat_pole').val('');
    setFormBaseline('#selected_chat_pole', String($('#selected_chat_pole').val()));
    await getChat({ isNewChat: true });
    // getChat() can refetch and clobber the clear above back to a still-old server value; reapply it before the save below.
    const openingNodeId = chat[0]?.node_id;
    const pointer = isStoredNodeId(openingNodeId) ? openingNodeId : '';
    _setCurrentTarget(pointer, chat_metadata.integrity ?? null);
    $('#selected_chat_pole').val(pointer);
    setFormBaseline('#selected_chat_pole', String($('#selected_chat_pole').val()));
    await saveActiveChat(getCurrentCharacter().avatar, pointer);
}

export async function replaceCurrentChat() {
    await clearChat({ clearData: true });

    const chatsResponse = await fetch('/api/characters/chats', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ avatar_url: getCurrentCharacter().avatar }),
    });

    if (chatsResponse.ok) {
        const chats = Object.values(await chatsResponse.json());
        chats.sort((a, b) => sortMoments(timestampToMoment(a.last_mes), timestampToMoment(b.last_mes)));

        if (chats.length && typeof chats[0] === 'object') {
            // Resume the most recently active labeled checkpoint. `/api/characters/chats` lists
            // branches (labeled tree nodes) when this character is tree-backed - node_id addresses
            // it exactly; the JSONL-era fallback shape has no node_id, so fall back to its name.
            const pointer = chats[0].node_id || chats[0].file_name.replace('.jsonl', '');
            _setCurrentTarget(pointer, null);
            $('#selected_chat_pole').val(getCurrentCharacter().chat);
            setFormBaseline('#selected_chat_pole', String($('#selected_chat_pole').val()));
            await saveActiveChat(getCurrentCharacter().avatar, getCurrentCharacter().chat);
            await getChat();
        } else {
            // No labeled checkpoint exists for this character. That does not mean "nothing to
            // resume" - it only means nothing has been explicitly named (see pointToFreshChat()).
            await pointToFreshChat();
        }
    }
}

export async function showMoreMessages(messagesToLoad = null) {
    const firstDisplayedMesId = chatElement.children('.mes').first().attr('mesid');
    let messageId = Number(firstDisplayedMesId);
    let count = messagesToLoad || power_user.chat_truncation || Number.MAX_SAFE_INTEGER;

    // If there are no messages displayed, or the message somehow has no mesid, we default to one higher than last message id,
    // so the first "new" message being shown will be the last available message
    if (isNaN(messageId)) {
        messageId = getLastMessageId() + 1;
    }

    console.debug('Inserting messages before', messageId, 'count', count, 'chat length', chat.length);
    const prevHeight = chatElement.prop('scrollHeight');
    const showMoreButton = $('#show_more_messages');
    const isButtonInView = isElementInViewport(showMoreButton[0]);

    const firstId = clamp(messageId - count, 0, Infinity);
    const messageElements = [];
    chat.slice(firstId, messageId).forEach((message, id) => {
        messageElements.push(updateMessageElement(message, { messageId: firstId + id }));
    });
    // This could be faster: https://developer.mozilla.org/en-US/docs/Web/API/Element/insertAdjacentElement
    // Fallback to chatElement if the button isn't where it's expected to be.
    if (showMoreButton[0]) {
        showMoreButton.after(messageElements);
    } else {
        chatElement.prepend(messageElements);
    }

    refreshSwipeButtons();

    if (firstId === 0) {
        showMoreButton.remove();
    }

    if (isButtonInView) {
        const newHeight = chatElement.prop('scrollHeight');
        chatElement.scrollTop(newHeight - prevHeight);
    }

    applyStylePins();
    await eventSource.emit(event_types.MORE_MESSAGES_LOADED);
}

export async function printMessages() {
    let startIndex = 0;
    let count = power_user.chat_truncation || Number.MAX_SAFE_INTEGER;

    if (chat.length > count) {
        startIndex = chat.length - count;
        chatElement.append('<div id="show_more_messages">Show more messages</div>');
    }

    await redisplayChat({ startIndex, fade: false });

    scrollChatToBottom({ waitForFrame: true });
    delay(debounce_timeout.short).then(() => scrollOnMediaLoad());
}

/**
 * Visually updates all chat messages including and after index by removing them, then adding them.
 * @param {object} [options] Options
 * @param {ChatMessage[]} [options.targetChat=chat] All messages in chat before startIndex will remain unchanged.
 * @param {Number} [options.startIndex=0] Everything including and after startIndex will be replaced.
 * @param {Boolean} [options.fade=true] When false, the swipe chevrons will not fade in.
 */
export async function redisplayChat({ targetChat = chat, startIndex = 0, fade = true } = {}) {
    const messageElements = chatElement.find('.mes');
    messageElements.removeClass('last_mes');

    //Remove messages after index.
    messageElements.filter(`.mes[mesid="${startIndex}"]`).nextAll('.mes').addBack().remove();

    const t1 = performance.now();

    const messages = targetChat.slice(startIndex);

    if (messages.length > 0) {
        const newMessageElements = messages.map((message, offset) => {
            const i = startIndex + offset;
            const messageElement = updateMessageElement(message, { messageId: i });

            return messageElement[0];
        });

        //The last_mes has been removed, add it to the new last message.
        newMessageElements.at(-1).classList.add('last_mes');

        //Append to chat in one DOM update.
        chatElement.append(newMessageElements);

        applyCharacterTagsToMessageDivs({ mesIds: lodash.range(startIndex, targetChat.length, 1) });
    }

    refreshSwipeButtons(false, fade);
    applyStylePins();
    updateEditArrowClasses();

    console.info(`Rendered ${targetChat.length - startIndex} messages in ${((performance.now() - t1) / 1000).toFixed(3)} seconds.`);
}

export function scrollOnMediaLoad() {
    const started = Date.now();
    const media = chatElement.find('.mes_block img, .mes_block video, .mes_block audio').toArray();
    let mediaLoaded = 0;

    for (const currentElement of media) {
        if (currentElement instanceof HTMLImageElement) {
            if (currentElement.complete) {
                incrementAndCheck();
            } else {
                currentElement.addEventListener('load', incrementAndCheck);
                currentElement.addEventListener('error', incrementAndCheck);
            }
        }
        if (currentElement instanceof HTMLMediaElement) {
            if (currentElement.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
                incrementAndCheck();
            } else {
                currentElement.addEventListener('loadeddata', incrementAndCheck);
                currentElement.addEventListener('error', incrementAndCheck);
            }
        }
    }

    function incrementAndCheck() {
        const MAX_DELAY = 1000; // 1 second
        if ((Date.now() - started) > MAX_DELAY) {
            return;
        }
        mediaLoaded++;
        if (mediaLoaded === media.length) {
            scrollChatToBottom({ waitForFrame: true });
        }
    }
}

/**
 * Cancels the debounced chat save if it is currently pending.
 */
export function cancelDebouncedChatSave() {
    if (chatSaveTimeout) {
        console.debug('Debounced chat save cancelled');
        clearTimeout(chatSaveTimeout);
        chatSaveTimeout = null;
    }
}

/**
 * True when a debounced chat save is currently queued, i.e. some chat-mutating action has happened
 * since the last save and hasn't been flushed to the server yet. Every mutating code path either
 * saves immediately (saveChatConditional()) or schedules one via saveChatDebounced() - so when this
 * is false, whatever is on screen is already exactly what the server has, and pure-read actions
 * (reloading the current chat, exporting it) have nothing to gain by forcing another save first.
 * @returns {boolean} Whether a chat save is currently scheduled.
 */
export function isChatSaveScheduled() {
    return !!chatSaveTimeout;
}

/**
 * Visually removes all chat message elements.
 * @param {object} [options] Options
 * @param {boolean} [options.clearData=false] Optionally clear the chat array's contents.
 */
export async function clearChat({ clearData = false } = {}) {
    cancelDebouncedChatSave();
    cancelDebouncedMetadataSave();
    closeMessageEditor();
    extension_prompts = {};
    if (is_delete_mode) {
        $('#dialogue_del_mes_cancel').trigger('click');
    }
    //This will also remove non '.mes' elements, e.g. '<div id="show_more_messages">Show more messages</div>'.
    chatElement.children().remove();
    if ($('.zoomed_avatar[forChar]').length) {
        console.debug('saw avatars to remove');
        $('.zoomed_avatar[forChar]').remove();
    } else { console.debug('saw no avatars'); }

    await saveItemizedPrompts(getCurrentChatId());
    itemizedPrompts.length = 0;

    if (clearData) {
        chat.length = 0;
        _messageSnapshots.clear();
    }
}

export async function deleteLastMessage() {
    if (this_edit_mes_id !== undefined && Number(this_edit_mes_id) === chat.length - 1) {
        closeMessageEditor();
    }
    deleteItemizedPromptForMessage(chat.length - 1);
    chat.length = chat.length - 1;
    chatElement.children('.mes').last().remove();
    await eventSource.emit(event_types.MESSAGE_DELETED, chat.length);
}

/**
 * Widens a single message id backward to include any preceding tool-invocation system messages,
 * so deleting an assistant message also removes the tool-call preamble that produced it.
 * Exported so bulk-delete callers (e.g. doMesCut()) can precompute the true removal range once,
 * against the still-intact `chat[]`, instead of relying on deleteMessage()'s own per-call widening.
 * @param {number} id The ID of the message that is about to be deleted.
 * @param {boolean} [deleteToolCalls=true] Whether to widen over preceding tool-call messages.
 * @returns {number} The actual first message ID to delete.
 */
export function getMessageDeletionStartId(id, deleteToolCalls = true) {
    const message = chat[id];
    if (!deleteToolCalls || message?.is_user || message?.is_system) {
        return id;
    }

    let startId = id;
    while (startId > 0) {
        const previousMessage = chat[startId - 1];
        if (!previousMessage?.is_system || !Array.isArray(previousMessage.extra?.tool_invocations)) {
            break;
        }
        startId--;
    }

    return startId;
}

/**
 * Deletes a message from the chat by its ID, optionally asking for confirmation.
 * @param {number} id The ID of the message to delete.
 * @param {number} [swipeDeletionIndex] Deletes the swipe with that index.
 * @param {boolean} [askConfirmation=false] Whether to ask for confirmation before deleting.
 * @param {boolean} [deleteToolCalls=true] Whether to delete preceding tool-call messages.
 * @param {boolean} [persist=true] Whether to persist this deletion to the tree (chatOpDegraft/chatOpEndPath).
 * Pass false when a caller is deleting several messages in one user action and will persist the
 * whole range itself in a single call - this still performs every local effect (splice, DOM removal,
 * tainting, view update, event emission), it just skips the per-call network round trip.
 */
export async function deleteMessage(id, swipeDeletionIndex = undefined, askConfirmation = false, deleteToolCalls = true, persist = true) {
    const canDeleteSwipe = swipeDeletionIndex !== undefined && swipeDeletionIndex !== null;
    if (canDeleteSwipe) {
        if (swipeDeletionIndex < 0) {
            throw new Error('Swipe index cannot be negative');
        }
        if (!Array.isArray(chat[id].swipes)) {
            throw new Error('Message has no swipes to delete');
        }
        if (chat[id].swipes.length <= swipeDeletionIndex) {
            throw new Error('Swipe index out of bounds');
        }
    }

    const minId = getFirstDisplayedMessageId();
    const messageElement = chatElement.find(`.mes[mesid="${id}"]`);
    if (messageElement.length === 0) {
        return;
    }

    let deleteOnlySwipe = canDeleteSwipe;
    if (askConfirmation) {
        const result = await callGenericPopup(t`Are you sure you want to delete this message?`, POPUP_TYPE.CONFIRM, null, {
            okButton: canDeleteSwipe ? t`Delete Swipe` : t`Delete Message`,
            cancelButton: 'Cancel',
            customButtons: canDeleteSwipe ? [t`Delete Message`] : null,
        });
        if (!result) {
            return;
        }
        deleteOnlySwipe = canDeleteSwipe && result === POPUP_RESULT.AFFIRMATIVE; // Default button, not the custom one
    }

    if (deleteOnlySwipe) {
        await deleteSwipe(swipeDeletionIndex, id);
        return;
    }

    const firstMessageId = getMessageDeletionStartId(id, deleteToolCalls);
    const messageIds = Array.from({ length: id - firstMessageId + 1 }, (_, index) => id - index);

    // Close the editor first, before its DOM element and chat entry are removed.
    if (this_edit_mes_id !== undefined && messageIds.includes(Number(this_edit_mes_id))) {
        closeMessageEditor();
    }

    // Nothing follows this range once it's gone — the existing tail-delete path (chatOpEndPath),
    // which is already correct. Otherwise it's a mid-chain delete: every SURVIVING message keeps its
    // own unchanged node_id, so the diff engine would see no change at all and persist nothing — this
    // must be told to the tree explicitly, and before splicing, since chatOpDegraft reads the range's
    // (and its neighbors') node ids off `chat[]` by index.
    const preSpliceLength = chat.length;
    const postSpliceLength = preSpliceLength - messageIds.length;
    const isTailDeletion = postSpliceLength > 0 && firstMessageId === postSpliceLength;
    if (persist && !isTailDeletion) {
        await chatOpDegraft(firstMessageId, id).catch(error =>
            console.error('Could not remove the deleted message(s) from the tree:', error));
    }

    // Delete from the end so earlier indices remain stable.
    for (const messageId of messageIds) {
        chat.splice(messageId, 1);
        chatElement.find(`.mes[mesid="${messageId}"]`).remove();
        deleteItemizedPromptForMessage(messageId);
    }

    chat_metadata.tainted = true;

    // Only meaningful for a removal reaching the end - the tree-backed store otherwise has no way to learn where the conversation now ends.
    if (persist && isTailDeletion) {
        await chatOpEndPath(chat.length - 1).catch(error =>
            console.error('Could not end the conversation at the last remaining message:', error));
    }

    const startIndex = firstMessageId <= minId ? firstMessageId : null;
    updateViewMessageIds(startIndex);

    refreshSwipeButtons();

    await eventSource.emit(event_types.MESSAGE_DELETED, chat.length);
}

export const reloadChatMutex = new SimpleMutex(reloadCurrentChatUnsafe);
export const reloadCurrentChat = reloadChatMutex.update.bind(reloadChatMutex);

export const userInputGenerateMutex = new SimpleMutex(sendTextareaMessage);

// A send asked for after a reply has shown the Send button again but while the previous send is still
// finishing (the lock is held until Generate() returns) would otherwise be dropped by the lock. It is kept
// instead, one at a time, and runs once the page is idle; the input is read then, so the latest text goes.
const QUEUED_SEND_POLL_MS = 50;
/** @type {{ chatId: string|undefined, timer: ReturnType<typeof setInterval> } | null} */
let queuedSend = null;

/**
 * Sends what is in the input, as the Send button and Enter do. In the gap after a reply, while the previous
 * send still holds the lock, the send is queued instead of dropped: the button shows "send queued", a click on
 * it cancels, Enter leaves it queued, and a chat change cancels it with a toast.
 * @param {'button'|'enter'} source
 */
export async function requestTextareaSend(source) {
    if (queuedSend) {
        if (source === 'button') cancelQueuedSend();
        return;
    }
    const inGap = userInputGenerateMutex.isBusy && !isGenerating() && $('#send_but').is(':visible');
    if (!inGap) {
        await userInputGenerateMutex.update();
        return;
    }
    // Keeps the text in this chat's draft, in case a chat change cancels the send.
    flushDraftSave();
    queuedSend = {
        chatId: getCurrentChatId(),
        timer: setInterval(() => {
            const idle = !userInputGenerateMutex.isBusy && !isGenerating() && swipeState === SWIPE_STATE.NONE && !isExecutingCommandsFromChatInput;
            if (!idle) return;
            clearQueuedSend();
            userInputGenerateMutex.update();
        }, QUEUED_SEND_POLL_MS),
    };
    $('#send_but').addClass('send_queued').attr('title', t`Send queued - click to cancel`);
}

function clearQueuedSend() {
    if (!queuedSend) return;
    clearInterval(queuedSend.timer);
    queuedSend = null;
    $('#send_but').removeClass('send_queued').attr('title', t`Send a message`);
}

/**
 * @param {string} [reason] Shown as a toast when set.
 */
function cancelQueuedSend(reason) {
    if (!queuedSend) return;
    clearQueuedSend();
    if (reason) toastr.info(reason);
}

/**
 * Reloads the current chat unsafely, without mutex protection.
 * Use `reloadCurrentChat` instead to ensure thread safety.
 * @returns {Promise<void>} A promise that resolves when the chat is reloaded.
 */
export async function reloadCurrentChatUnsafe() {
    preserveNeutralChat();
    await clearChat({ clearData: true });

    const selection = getSelectionState();
    if (selection.type === 'group') {
        await getGroupChat(selection.groupId, true);
    } else if (selection.type === 'character') {
        await getChat();
    } else {
        resetChatState();
        restoreNeutralChat();
        await getCharacters();
        await printMessages();
        await eventSource.emit(event_types.CHAT_CHANGED, getCurrentChatId());
    }

    refreshSwipeButtons();
}

export async function sendTextareaMessage() {
    if (swipeState == SWIPE_STATE.EDITING) {
        toastr.warning(t`Confirm the edit to start a generation.`, t`You cannot send a message during a swipe-edit.`);
        return;
    }
    if (swipeState !== SWIPE_STATE.NONE) return; // don't proceed if mid-swipe.
    if (is_send_press) return;

    // Overswiping opens a blank slot with nothing written yet; SWIPE_STATE.EDITING is never actually set for it.
    const lastIndex = chat.length - 1;
    if (lastIndex >= 0 && _isBlankUnwrittenSwipe(chat[lastIndex])) {
        toastr.warning(t`Write something in the message first, or cancel the edit.`, t`Nothing to send`);
        return;
    }
    if (isExecutingCommandsFromChatInput) return;

    hideSwipeButtons(); //Swipe buttons must be hidden now, otherwise concurrent generations are possible.

    let generateType = 'normal';
    // "Continue on send" is activated when the user hits "send" (or presses enter) on an empty chat box, and the last
    // message was sent from a character (not the user or the system).
    const textareaText = String($('#send_textarea').val());
    const lastMessage = chat[chat.length - 1];
    if (power_user.continue_on_send &&
        !hasPendingFileAttachment() &&
        !textareaText &&
        !selected_group &&
        chat.length &&
        !lastMessage.is_user &&
        !lastMessage.is_system
    ) {
        generateType = 'continue';
    }

    if (textareaText && getSelectionState().type === 'none' && name2 !== neutralCharacterName) {
        await newAssistantChat({ temporary: false });
    }

    let generation = await Generate(generateType);
    showSwipeButtons();
    return generation;
}

/**
 * Creates an Image element for the given API/model icon.
 * The image references the matching SVG file from `/img/` and includes a tooltip with API and model info.
 * The caller is responsible for appending the image to the DOM and optionally calling `SVGInject` on it.
 *
 * @param {string} apiName - API identifier matching an SVG file in /img/ (e.g. 'openai', 'openrouter', 'claude')
 * @param {string} [modelName=''] - Model name shown in the tooltip
 * @returns {HTMLImageElement} The image element (not yet in the DOM)
 */
export function createModelIcon(apiName, modelName = '') {
    const image = new Image();
    image.classList.add('icon-svg');
    image.src = `/img/${apiName}.svg`;
    image.title = modelName ? `${apiName} - ${modelName}` : apiName;
    return image;
}

/**
 * Inserts or replaces an SVG icon adjacent to the provided message's timestamp.
 *
 * @param {JQuery<HTMLElement>} mes - The message element containing the timestamp where the icon should be inserted or replaced.
 * @param {ChatMessageExtra} extra - Contains the API and model details.
 */
function insertSVGIcon(mes, extra) {
    const apiName = extra?.api || '';

    if (!apiName) {
        return;
    }

    const insertOrReplaceSVG = (image, className, targetSelector, insertBefore) => {
        image.onload = async function () {
            let existingSVG = insertBefore ? mes.find(targetSelector).prev(`.${className}`) : mes.find(targetSelector).next(`.${className}`);
            if (existingSVG.length) {
                existingSVG.replaceWith(image);
            } else {
                if (insertBefore) mes.find(targetSelector).before(image);
                else mes.find(targetSelector).after(image);
            }
            await SVGInject(image);
        };
    };

    const insertIcon = (className, targetSelector, insertBefore) => {
        const image = createModelIcon(apiName, extra?.model);
        image.classList.add(className);
        insertOrReplaceSVG(image, className, targetSelector, insertBefore);
    };

    insertIcon('timestamp-icon', '.timestamp');
    insertIcon('thinking-icon', '.mes_reasoning_header_title', true);
}

/**
 * Re-renders a message block with updated content.
 * @param {number} messageId Message ID
 * @param {object} message Message object
 * @param {object} [options={}] Optional arguments
 * @param {boolean} [options.rerenderMessage=true] Whether to re-render the message content (inside <c>.mes_text</c>)
 */
export function updateMessageBlock(messageId, message, { rerenderMessage = true } = {}) {
    const messageElement = chatElement.find(`[mesid="${messageId}"]`);
    if (rerenderMessage) {
        const text = message?.extra?.display_text ?? message.mes;
        messageElement.find('.mes_text').html(messageFormatting(text, message.name, message.is_system, message.is_user, messageId, {}, false));
    }

    updateReasoningUI(messageElement);

    addCopyToCodeBlocks(messageElement);
    appendMediaToMessage(message, messageElement);
}

/**
 * Ensures that the message media properties are arrays, adding getters/setters for single media items.
 * @param {ChatMessage} mes Message object
 */
export function ensureMessageMediaIsArray(mes) {
    /**
     * Determines if a property of an object is a plain property (not a getter/setter or non-enumerable).
     * @param {object} obj Object to check
     * @param {string} name Property name
     * @returns {boolean} True if the property is a plain property, false otherwise
     */
    function isPlainObjectProperty(obj, name) {
        const hasProperty = Object.hasOwn(obj, name);
        if (hasProperty) {
            const descriptor = Object.getOwnPropertyDescriptor(obj, name);
            return descriptor && descriptor.enumerable && descriptor.configurable && descriptor.writable;
        }
        return false;
    }

    /**
     * Determines if a property of an object is a getter (not a plain property).
     * @param {object} obj Object to check
     * @param {string} name Property name
     * @returns {boolean} True if the property is a getter, false otherwise
     */
    function isGetterObjectProperty(obj, name) {
        const hasProperty = Object.hasOwn(obj, name);
        if (hasProperty) {
            const descriptor = Object.getOwnPropertyDescriptor(obj, name);
            return descriptor && typeof descriptor.get === 'function';
        }
        return false;
    }

    /**
     * Adds a plain property to an object that wraps around an array property.
     * @param {object} obj Object to add property to
     * @param {string} plainProperty Plain property name
     * @param {string} arrayProperty Array property to back the plain property
     * @param {(value: any) => boolean} [filterFn] Optional filter function to apply when getting/setting the plain property
     * @param {(value: any) => any} [mapFn] Optional map function to apply when getting/setting the plain property
     */
    function addArrayAutoWrapper(obj, plainProperty, arrayProperty, filterFn = () => true, mapFn = (t) => t) {
        // If the plain property is already a getter, do nothing.
        const hasGetterProperty = isGetterObjectProperty(obj, plainProperty);
        if (hasGetterProperty) {
            return;
        }

        // Frozen objects can't have properties defined on them; the wrappers were set up pre-freeze.
        if (Object.isFrozen(obj)) {
            return;
        }

        // Define the plain property as a getter/setter that wraps around the array property.
        Object.defineProperty(obj, plainProperty, {
            // Getting the plain property returns the first item in the array property, or undefined if the array is empty.
            get: function () {
                console.trace(`Attempting to GET an array-wrapped property '${plainProperty}'. Use the array property '${arrayProperty}' instead.`);
                const array = Array.isArray(this[arrayProperty]) ? this[arrayProperty].filter(filterFn).map(mapFn) : [];
                return array.length > 0 ? array[0] : void 0;
            },
            // Setting the plain property is not supported, as it would be ambiguous.
            set: function () {
                console.trace(`Attempting to SET an array-wrapped property '${plainProperty}'. Use the array property '${arrayProperty}' instead.`);
            },
            // Exclude the property from JSON serialization and from being listed in for...in loops.
            enumerable: false,
            // Make the property non-configurable to prevent deletion or redefinition.
            configurable: false,
        });
    }

    /**
     * Migrates image swipes from a single image property to an array.
     * @param {ChatMessageExtra} obj
     */
    function migrateMediaToArray(obj) {
        // Frozen objects (deep-frozen messages) already had migration applied pre-freeze.
        if (Object.isFrozen(obj)) {
            return;
        }

        if (isPlainObjectProperty(obj, 'file')) {
            if (!Array.isArray(obj.files)) {
                obj.files = [];
            }
            const fileValue = obj.file;
            delete obj.file;
            if (fileValue) {
                obj.files.push(fileValue);
            }
        }

        if (Array.isArray(obj.image_swipes)) {
            if (!Array.isArray(obj.media)) {
                obj.media = [];
            }
            for (const swipe of obj.image_swipes) {
                if (swipe && typeof swipe === 'string') {
                    obj.media_display = MEDIA_DISPLAY.GALLERY;
                    obj.media.push({ type: MEDIA_TYPE.IMAGE, url: swipe });
                }
            }
            delete obj.image_swipes;
        }

        if (isPlainObjectProperty(obj, 'image')) {
            if (!Array.isArray(obj.media)) {
                obj.media = [];
            }
            const imageValue = obj.image;
            delete obj.image;
            if (imageValue && typeof imageValue === 'string') {
                obj.media.push({ type: MEDIA_TYPE.IMAGE, url: imageValue });
            }
            if (obj.media_display === MEDIA_DISPLAY.GALLERY) {
                const selectedIndex = obj.media.findIndex(t => t.url === imageValue);
                if (selectedIndex > -1) {
                    obj.media_index = selectedIndex;
                }
            }
            obj.media = obj.media.filter((v, i, a) => i === a.findIndex(t => t.url === v.url));
        }

        if (isPlainObjectProperty(obj, 'video')) {
            if (!Array.isArray(obj.media)) {
                obj.media = [];
            }
            const videoValue = obj.video;
            delete obj.video;
            if (videoValue && typeof videoValue === 'string') {
                obj.media.push({ type: MEDIA_TYPE.VIDEO, url: videoValue });
            }
        }
    }

    if (!mes || !mes.extra || typeof mes.extra !== 'object') {
        return;
    }

    migrateMediaToArray(mes.extra);
    addArrayAutoWrapper(mes.extra, 'file', 'files');
    addArrayAutoWrapper(mes.extra, 'image', 'media', (t) => t.type === MEDIA_TYPE.IMAGE, (t) => t.url);
    addArrayAutoWrapper(mes.extra, 'video', 'media', (t) => t.type === MEDIA_TYPE.VIDEO, (t) => t.url);
}

/**
 * Gets the media display setting for a message.
 * @param {ChatMessage} mes Message object
 * @returns {MEDIA_DISPLAY} Media display setting
 */
export function getMediaDisplay(mes) {
    const value = mes?.extra?.media_display || power_user.media_display || MEDIA_DISPLAY.LIST;
    return Object.values(MEDIA_DISPLAY).includes(value) ? value : MEDIA_DISPLAY.LIST;
}

/**
 * Gets the media index for a message.
 * @param {ChatMessage} mes Message object
 * @returns {number} Media index
 */
export function getMediaIndex(mes) {
    if (!Array.isArray(mes?.extra?.media)) {
        return 0;
    }
    const value = mes.extra?.media_index;
    if (isNaN(value) || value < 0 || value >= mes.extra.media.length) {
        return 0;
    }
    return value;
}

/**
 * Appends image or file to the message element.
 * @param {ChatMessage} mes Message object
 * @param {JQuery<HTMLElement>} messageElement Message element
 * @param {string} [scrollBehavior] Scroll behavior when adjusting scroll position
 */
export function appendMediaToMessage(mes, messageElement, scrollBehavior = SCROLL_BEHAVIOR.ADJUST) {
    ensureMessageMediaIsArray(mes);

    const fileWrapper = messageElement.find('.mes_file_wrapper');
    const mediaWrapper = messageElement.find('.mes_media_wrapper');

    const hasMedia = Array.isArray(mes?.extra?.media) && mes.extra.media.length > 0;
    const hasFiles = Array.isArray(mes?.extra?.files) && mes.extra.files.length > 0;
    const mediaDisplay = hasMedia ? getMediaDisplay(mes) : null;
    const hideMessageText = hasMedia && mes?.extra?.inline_image === false;

    const mediaBlocks = [];
    const mediaPromises = [];

    const chatHeight = (hasMedia || hasFiles) ? chatElement.prop('scrollHeight') : 0;
    const scrollPosition = (hasMedia || hasFiles) ? chatElement.scrollTop() : 0;
    const doAdjustScroll = () => {
        if (!hasMedia && !hasFiles) {
            return;
        }
        if (scrollBehavior === SCROLL_BEHAVIOR.NONE) {
            return;
        }
        if (scrollBehavior === SCROLL_BEHAVIOR.KEEP) {
            chatElement.scrollTop(scrollPosition);
            return;
        }
        const newChatHeight = chatElement.prop('scrollHeight');
        const diff = newChatHeight - chatHeight;
        chatElement.scrollTop(scrollPosition + diff);
    };

    // Set media display attribute
    messageElement.attr('data-media-display', mediaDisplay);
    // Toggle text visibility
    messageElement.find('.mes_text').toggleClass('inline_media', hideMessageText);

    /**
     * Appends a single image attachment to the message element.
     * @param {MediaAttachment} attachment Image attachment object
     * @param {number} index Index of the image attachment
     * @returns {JQuery<HTMLElement>} The appended image container element
     */
    function appendImageAttachment(attachment, index) {
        const template = $('#message_image_template .mes_img_container').clone();
        template.attr('data-index', index);

        const image = template.find('.mes_img');
        image.attr('src', attachment.url);
        image.attr('title', attachment.title || mes.extra.title || '');
        mediaPromises.push(new Promise((resolve) => {
            function onLoad() {
                image.removeAttr('alt');
                image.removeClass('error');
                resolve();
            }
            function onError() {
                image.attr('alt', '');
                image.addClass('error');
                resolve();
            }
            if (image.prop('complete')) {
                onLoad();
            } else {
                image.off('load').on('load', onLoad);
                image.off('error').on('error', onError);
            }
        }));

        mediaBlocks.push(template);
        return template;
    }

    /**
     * Appends a single video attachment to the message element.
     * @param {MediaAttachment} attachment Video attachment object
     * @param {number} index Index of the video attachment
     * @returns {JQuery<HTMLElement>} The appended video container element
     */
    function appendVideoAttachment(attachment, index) {
        const template = $('#message_video_template .mes_video_container').clone();
        template.attr('data-index', index);

        const video = template.find('.mes_video');
        video.attr('src', attachment.url);
        video.attr('title', attachment.title || mes.extra.title || '');
        mediaPromises.push(new Promise((resolve) => {
            function onLoad() {
                resolve();
            }
            function onError() {
                video.addClass('error');
                resolve();
            }
            if (video.prop('readyState') >= HTMLMediaElement.HAVE_CURRENT_DATA) {
                onLoad();
            } else {
                video.off('loadeddata').on('loadeddata', onLoad);
                video.off('error').on('error', onError);
            }
        }));

        mediaBlocks.push(template);
        return template;
    }

    /**
     * Appends a single audio attachment to the message element.
     * @param {MediaAttachment} attachment Audio attachment object
     * @param {number} index Index of the audio attachment
     * @returns {JQuery<HTMLElement>} The appended audio container element
     */
    function appendAudioAttachment(attachment, index) {
        const template = $('#message_audio_template .mes_audio_container').clone();
        template.attr('data-index', index);
        const audio = template.find('.mes_audio');
        audio.attr('src', attachment.url);
        audio.attr('title', attachment.title || mes.extra.title || '');

        mediaPromises.push(new Promise((resolve) => {
            function onLoad() {
                resolve();
            }
            function onError() {
                audio.addClass('error');
                resolve();
            }
            if (audio.prop('readyState') >= HTMLMediaElement.HAVE_CURRENT_DATA) {
                onLoad();
            } else {
                audio.off('loadeddata').on('loadeddata', onLoad);
                audio.off('error').on('error', onError);
            }
        }));

        new AudioPlayer(audio.get(0), template.get(0));

        mediaBlocks.push(template);
        return template;
    }

    /**
     * Appends a media attachment to the message element.
     * @param {MediaAttachment} attachment Media attachment object
     * @param {number} index Index of the media attachment
     * @returns {JQuery<HTMLElement>} The appended media container element
     */
    function appendMediaAttachment(attachment, index) {
        if (!attachment.type) {
            attachment.type = MEDIA_TYPE.IMAGE;
        }
        switch (attachment.type) {
            case MEDIA_TYPE.IMAGE:
                return appendImageAttachment(attachment, index);
            case MEDIA_TYPE.VIDEO:
                return appendVideoAttachment(attachment, index);
            case MEDIA_TYPE.AUDIO:
                return appendAudioAttachment(attachment, index);
        }

        console.warn(`Unknown media type: ${attachment.type}, defaulting to image.`, attachment);
        return appendImageAttachment(attachment, index);
    }

    /**
     * Saves the current playback times of media elements in the message.
     * @returns {Map<string, MediaState>} Media playback times by source URL
     */
    function saveMediaStates() {
        const states = new Map();
        const media = mediaWrapper.find('video, audio');
        media.each((_, element) => {
            if (element instanceof HTMLMediaElement) {
                if (!element.currentSrc || element.readyState === HTMLMediaElement.HAVE_NOTHING) {
                    return;
                }
                const state = { currentTime: element.currentTime, paused: element.paused };
                states.set(element.currentSrc, state);
            }
        });
        return states;
    }

    /**
     * Restores the playback times of media elements in the message.
     * @param {Map<string, MediaState>} states Media playback times by source URL
     */
    function restoreMediaStates(states) {
        const media = mediaWrapper.find('video, audio');
        media.each((_, element) => {
            if (element instanceof HTMLMediaElement) {
                const restoreState = () => {
                    if (!states.has(element.currentSrc)) {
                        return;
                    }
                    const state = states.get(element.currentSrc);
                    element.currentTime = state.currentTime;
                    if (!state.paused) {
                        element.play();
                    }
                };
                if (element.readyState < HTMLMediaElement.HAVE_METADATA) {
                    element.addEventListener('loadedmetadata', () => restoreState(), { once: true });
                } else {
                    restoreState();
                }
            }
        });
    }

    // Add media gallery to message
    if (hasMedia && mediaDisplay === MEDIA_DISPLAY.GALLERY) {
        const mediaIndex = getMediaIndex(mes);
        const selectedMedia = mes.extra.media[mediaIndex];

        const galleryControls = $('#message_gallery_controls .mes_img_swipes').clone();
        const counter = galleryControls.find('.mes_img_swipe_counter');
        counter.text(`${mediaIndex + 1}/${mes.extra.media.length}`);

        const template = appendMediaAttachment(selectedMedia, mediaIndex);
        template.addClass('img_swipes');
        template.append(galleryControls);
    }

    // Add media as a list to message
    if (hasMedia && mediaDisplay === MEDIA_DISPLAY.LIST) {
        for (let index = 0; index < mes.extra.media.length; index++) {
            const attachment = mes.extra.media[index];
            appendMediaAttachment(attachment, index);
        }
    }

    // Remove existing file containers
    fileWrapper.empty();

    // Add files to message
    if (hasFiles) {
        // Resolved once and reused for every clone, instead of re-running the selector per iteration.
        const $fileTemplate = $('#message_file_template .mes_file_container');
        for (let index = 0; index < mes.extra.files.length; index++) {
            const file = mes.extra.files[index];
            const template = $fileTemplate.clone();
            template.attr('data-index', index);
            template.find('.mes_file_name').text(file.name).attr('title', file.name);
            template.find('.mes_file_size').text(humanFileSize(file.size)).attr('title', file.size);
            fileWrapper.append(template);
        }
    }

    // Early return if no media
    if (!hasMedia) {
        mediaWrapper.empty();
        doAdjustScroll();
        return;
    }

    // TODO: Consider making this awaitable
    Promise.race([Promise.all(mediaPromises), delay(debounce_timeout.short)]).then(() => {
        const states = saveMediaStates();
        mediaWrapper.empty().append(mediaBlocks);
        restoreMediaStates(states);
        doAdjustScroll();
    });
}

export function addCopyToCodeBlocks(messageElement) {
    const codeBlocks = $(messageElement).find('pre code');
    for (let i = 0; i < codeBlocks.length; i++) {
        hljs.highlightElement(codeBlocks.get(i));
        const copyButton = document.createElement('i');
        copyButton.classList.add('fa-solid', 'fa-copy', 'code-copy', 'interactable');
        copyButton.title = 'Copy code';
        codeBlocks.get(i).appendChild(copyButton);
        copyButton.addEventListener('click', function (e) {
            e.stopPropagation();
        });
        copyButton.addEventListener('pointerup', async function () {
            const text = codeBlocks.get(i).textContent;
            await copyText(text);
            toastr.info(t`Copied!`, '', { timeOut: 2000 });
        });
    }
}

/**
 * Shows or hides the Prompt display button
 * @param {ChatMessage} message Message object
 * @param {object} options Options
 * @param {number} [options.messageId] Message ID
 * @param {JQuery<HTMLElement>} [options.messageElement] Message element
 * @return {void}
 */
function updateMessageItemizedPromptButton(message, { messageId = chat.indexOf(message), messageElement = chatElement.find(`.mes[mesid="${messageId}"]`) }) {
    //if we have itemized messages, and the array isn't null..
    if (!message.is_user && Array.isArray(itemizedPrompts) && itemizedPrompts.length > 0) {
        const itemizedPrompt = itemizedPrompts.find(x => Number(x.mesId) === Number(messageId));
        if (itemizedPrompt) {
            messageElement.find('.mes_prompt').show();
        }
    }
}

/**
 * Gets messageFormatting for a ChatMessage object.
 * @param {ChatMessage} message
 * @param {object} options Options
 * @param {number} [options.messageId] Message ID
 * @returns {string} Formatted message HTML
 */
function getMessageTextHTML(message, { messageId = chat.indexOf(message) }) {
    // if mes.extra.uses_system_ui is true, set an override on the sanitizer options
    /** @type {Partial<DOMPurify.Config>} */
    const sanitizerOverrides = message.extra?.uses_system_ui ? { MESSAGE_ALLOW_SYSTEM_UI: true } : {};

    return messageFormatting(
        message.extra?.display_text || message.mes,
        message.name,
        message.is_system,
        message.is_user,
        messageId,
        sanitizerOverrides,
        false,
    );
}

/**
 * Adds a single message to the chat.
 * @param {ChatMessage} mes Message object
 * @param {object} [options] Options
 * @param {string} [options.type=undefined|'swipe'] Deprecated. Use updateMessageElement instead.
 * @param {number} [options.insertAfter=null] Message ID to insert the new message after
 * @param {boolean} [options.scroll=true] Whether to scroll to the new message
 * @param {number} [options.insertBefore=null] Message ID to insert the new message before
 * @param {number} [options.forceId=null] Force the message ID
 * @param {boolean} [options.showSwipes=true] Whether to refresh the swipe buttons.
 * @returns {JQuery<HTMLElement>} The newly added message element
 */
export function addOneMessage(mes, { type = undefined, insertAfter = null, scroll = true, insertBefore = null, forceId = null, showSwipes = true } = {}) {
    // Callers push the new message to chat before calling addOneMessage
    const messageId = (() => {
        if (typeof forceId === 'number') {
            return forceId;
        }
        if (typeof insertBefore === 'number') {
            return insertBefore - 1;
        }
        if (typeof insertAfter === 'number') {
            return insertAfter + 1;
        }
        const index = chat.indexOf(mes);
        if (index !== -1) {
            return index;
        }
        return chat.length - 1;
    })();

    let messageElement;

    if (type === 'swipe') {
        // Forbidden black magic
        // This allows to use "continue" on user messages
        mes.swipe_id ??= 0;
        mes.swipes ??= [mes.mes];
        //This keeps listeners intact.
        messageElement = chatElement.find(`[mesid="${messageId}"]`);
        updateMessageElement(mes, { messageId, messageElement, adjustMediaScroll: scroll ? SCROLL_BEHAVIOR.ADJUST : SCROLL_BEHAVIOR.NONE });
    } else {
        messageElement = updateMessageElement(mes, { messageId, adjustMediaScroll: scroll ? SCROLL_BEHAVIOR.ADJUST : SCROLL_BEHAVIOR.NONE });
        if (typeof insertAfter === 'number' && insertAfter >= 0) {
            const target = chatElement.find(`.mes[mesid="${insertAfter}"]`);
            $(messageElement).insertAfter(target);
        } else if (typeof insertBefore === 'number' && insertBefore >= 0) {
            const target = chatElement.find(`.mes[mesid="${insertBefore}"]`);
            $(messageElement).insertBefore(target);
        } else {
            chatElement.append(messageElement);
        }
    }


    //last_mes should always be updated.
    chatElement.find('.mes').removeClass('last_mes');
    chatElement.find('.mes').last().addClass('last_mes');

    if (showSwipes) refreshSwipeButtons();
    // Don't scroll if not inserting last
    if (!insertAfter && !insertBefore && scroll) {
        scrollChatToBottom({ waitForFrame: true });
    }

    applyCharacterTagsToMessageDivs({ mesIds: messageId });
    updateEditArrowClasses();
    return messageElement;
}

/**
 * Creates the element of a single message as if it were the last message or at forceMesId
 * @param {ChatMessage} mes Message object
 * @param {object} [options] Options
 * @param {number} [options.messageId=chat.length - 1] Force the message ID
 * @param {JQuery<HTMLElement>} [options.messageElement=messageTemplate.clone()] This message element will be updated with the ChatMessage object.
 * @param {SCROLL_BEHAVIOR} [options.adjustMediaScroll=SCROLL_BEHAVIOR.NONE] Scroll behavior option passed to appendMediaToMessage.
 * @returns {JQuery<HTMLElement>} Rendered HTMLElement.
 */
export function updateMessageElement(mes, { messageId = chat.length - 1, messageElement = messageTemplate.clone(), adjustMediaScroll = SCROLL_BEHAVIOR.NONE } = {}) {
    let avatarImg = getThumbnailUrl('persona', user_avatar);

    //for non-user messages
    if (!mes.is_user) {
        if (mes.force_avatar) {
            avatarImg = mes.force_avatar;
        } else if (getSelectionState().type !== 'character') {
            avatarImg = system_avatar;
        } else if (getCurrentCharacter() && getCurrentCharacter().avatar !== 'none') {
            avatarImg = getThumbnailUrl('avatar', getCurrentCharacter().avatar);
        } else {
            avatarImg = default_avatar;
        }
        //old processing:
        //if message is from system, use the name provided in the message JSONL to proceed,
        //if not system message, use name2 (char's name) to proceed
        //characterName = mes.is_system || mes.force_avatar ? mes.name : name2;
    } else if (mes.is_user && mes.force_avatar) {
        // Special case for persona images.
        avatarImg = mes.force_avatar;
    }
    const momentDate = timestampToMoment(mes.send_date);
    const timestamp = momentDate.isValid() ? momentDate.format('LL LT') : '';
    const messageHTML = getMessageTextHTML(mes, { messageId });
    const tokenCount = mes.extra?.token_count;
    const { timerValue, timerTitle } = formatGenerationTimer(mes.gen_started, mes.gen_finished, mes.extra?.token_count, mes.extra?.reasoning_duration, mes.extra?.time_to_first_token);

    messageElement.attr({
        'mesid': messageId,
        'swipeid': mes.swipe_id ?? 0,
        'ch_name': mes.name,
        'is_user': mes.is_user,
        'is_system': !!mes.is_system,
        'force_avatar': !!mes.force_avatar,
        'timestamp': timestamp,
        // ...(type ?? { type }),
        'type': mes.extra?.type ?? '',
    });

    messageElement.find('.avatar img').attr('src', avatarImg);
    messageElement.find('.ch_name .name_text').text(mes.name);
    messageElement.find('.timestamp').text(timestamp).attr('title', `${mes.extra?.api ? mes.extra.api + ' - ' : ''}${mes.extra?.model ?? ''}`);
    messageElement.find('.mesIDDisplay').text(`#${messageId}`);
    tokenCount && messageElement.find('.tokenCounterDisplay').text(`${tokenCount}t`);
    mes.title && messageElement.attr('title', mes.title);
    timerValue && messageElement.find('.mes_timer').attr('title', timerTitle).text(timerValue);

    if (mes.extra?.bias !== '') {
        const bias = messageFormatting(mes.extra?.bias, '', false, false, -1, {}, false);
        messageElement.find('.mes_bias').html(bias);
    }

    updateReasoningUI(messageElement);

    if (power_user.timestamp_model_icon && mes.extra?.api) {
        insertSVGIcon(messageElement, mes.extra);
    }

    if (mes?.extra?.isSmallSys === true) {
        messageElement.addClass('smallSysMes');
    }

    if (Array.isArray(mes?.extra?.tool_invocations)) {
        messageElement.addClass('toolCall');
    }

    updateMessageItemizedPromptButton(mes, { messageId, messageElement });

    messageElement.find('.avatar img').on('error', function () {
        $(this).hide();
        $(this).parent().html('<div class="missing-avatar fa-solid fa-user-slash"></div>');
    });

    appendMediaToMessage(mes, messageElement, adjustMediaScroll);
    messageElement.find('.mes_text').html(messageHTML);
    addCopyToCodeBlocks(messageElement);

    // User messages can carry alternatives too, so this isn't limited to non-user messages.
    updateSwipeCounter(messageId, { message: mes, messageElement });

    return messageElement;
}

/**
 * Returns the URL of the avatar for the given character.
 * @param {string|number} characterId An index into `getContext().characters`, or an avatar key
 * @returns {string} Avatar URL
 */
export function getCharacterAvatar(characterId) {
    const character = resolveCharacterRef(characterId);
    const avatarImg = character?.avatar;

    if (!avatarImg || avatarImg === 'none') {
        return default_avatar;
    }

    return formatCharacterAvatar(avatarImg);
}

export function formatCharacterAvatar(characterAvatar) {
    return `characters/${characterAvatar}`;
}

/**
 * Formats the title for the generation timer.
 * @param {MessageTimestamp} gen_started Date when generation was started
 * @param {MessageTimestamp} gen_finished Date when generation was finished
 * @param {number} tokenCount Number of tokens generated (0 if not available)
 * @param {number?} [reasoningDuration=null] Reasoning duration (null if no reasoning was done)
 * @param {number?} [timeToFirstToken=null] Time to first token
 * @returns {Object} Object containing the formatted timer value and title
 * @example
 * const { timerValue, timerTitle } = formatGenerationTimer(gen_started, gen_finished, tokenCount);
 * console.log(timerValue); // 1.2s
 * console.log(timerTitle); // Generation queued: 12:34:56 7 Jan 2021\nReply received: 12:34:57 7 Jan 2021\nTime to generate: 1.2 seconds\nToken rate: 5 t/s
 */
function formatGenerationTimer(gen_started, gen_finished, tokenCount, reasoningDuration = null, timeToFirstToken = null) {
    if (!gen_started || !gen_finished) {
        return {};
    }

    const dateFormat = 'HH:mm:ss D MMM YYYY';
    const start = moment(gen_started);
    const finish = moment(gen_finished);
    const seconds = finish.diff(start, 'seconds', true);
    const timerValue = `${seconds.toFixed(1)}s`;
    const timerTitle = [
        `Generation queued: ${start.format(dateFormat)}`,
        `Reply received: ${finish.format(dateFormat)}`,
        `Time to generate: ${seconds} seconds`,
        timeToFirstToken ? `Time to first token: ${timeToFirstToken / 1000} seconds` : '',
        reasoningDuration > 0 ? `Time to think: ${reasoningDuration / 1000} seconds` : '',
        tokenCount > 0 ? `Token rate: ${Number(tokenCount / seconds).toFixed(3)} t/s` : '',
    ].filter(x => x).join('\n').trim();

    if (isNaN(seconds) || seconds < 0) {
        return { timerValue: '', timerTitle };
    }

    return { timerValue, timerTitle };
}

let requestId = null;

/**
 * Scrolls the chat to the bottom if configured to do so.
 * @param {object} [options] Options
 * @param {boolean} [options.waitForFrame] If true, waits for the animation frame before scrolling
 */
export function scrollChatToBottom({ waitForFrame } = {}) {
    if (!power_user.auto_scroll_chat_to_bottom) {
        return;
    }

    const doScroll = () => {
        let position = chatElement[0].scrollHeight;

        if (power_user.waifuMode) {
            const lastMessage = chatElement.find('.mes').last();
            if (lastMessage.length) {
                const lastMessagePosition = lastMessage.position().top;
                position = chatElement.scrollTop() + lastMessagePosition;
            }
        }

        chatElement.scrollTop(position);
        requestId = null;
    };

    // Do not check truthiness. requestId can loop to zero.
    if (requestId !== null) {
        cancelAnimationFrame(requestId);
    }

    if (!waitForFrame) {
        doScroll();
        return;
    }

    // This prevents layout thrashing.
    // https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame#return_value
    // https://gist.github.com/paulirish/5d52fb081b3570c81e3a#file-what-forces-layout-md
    requestId = requestAnimationFrame(() => doScroll());
}

/**
 * @deprecated Function is not needed anymore, as the new signature of substituteParams is more flexible.
 *
 * Substitutes {{macro}} parameters in a string.
 * @returns {string} The string with substituted parameters.
 */
export function substituteParamsExtended(content, additionalMacro = {}, postProcessFn = (x) => x) {
    return substituteParams(content, { dynamicMacros: additionalMacro, postProcessFn });
}

/**
 * Substitutes {{macro}} parameters in a string.
 * @param {string} content - The string to substitute parameters in.
 * @param {string} [_name1] - The name of the user. Uses global name1 if not provided.
 * @param {string} [_name2] - The name of the character. Uses global name2 if not provided.
 * @param {string} [_original] - The original message for {{original}} substitution.
 * @param {string} [_group] - The group members list for {{group}} substitution.
 * @param {boolean} [_replaceCharacterCard] - Whether to replace character card macros.
 * @param {Record<string,any>} [additionalMacro] - Additional environment variables for substitution.
 * @param {(x: string) => string} [postProcessFn] - Post-processing function for each substituted macro.
 * @returns {string} The string with substituted parameters.
 */
export function substituteParamsLegacy(content, _name1, _name2, _original, _group, _replaceCharacterCard = true, additionalMacro = {}, postProcessFn = (x) => x) {
    if (!content) {
        return '';
    }

    // If experimental macro engine is enabled, use it. This code will be cleaned up in the future.
    if (power_user?.experimental_macro_engine) {
        return substituteParams(content, {
            name1Override: _name1,
            name2Override: _name2,
            original: _original,
            groupOverride: _group,
            replaceCharacterCard: _replaceCharacterCard ?? true,
            dynamicMacros: additionalMacro ?? {},
            postProcessFn: postProcessFn ?? ((x) => x),
        });
    }

    // Try to roughly detect experimental macro features to show the onboarding if needed.
    // This does not have to be 100% accurate, only best effort what we can quickly check.
    // Only do this if the warning wasn't shown yet, to prevent needless regex checks.
    if (accountStorage.getItem('slash_command_experimental_engine_warning_shown') !== 'true') {
        let feature = /** @type {string|null} */ (null);
        if (/{{\s*if/.test(content)) feature = '{{if}} macro';
        else if (/{{\s*\//.test(content)) feature = 'scoped macro';
        else if (/{{\s*[!?~#/]/.test(content)) feature = 'macro flags';
        else if (/{{\s*[.$]/.test(content)) feature = 'variable shorthands';
        else if (/\{\{(?:(?!\}\}).)*\{\{(?=[\s\S]*?\}\}[\s\S]*?\}\})/.test(content)) feature = 'nested macro';
        else if (/{{(?:greeting|charFirstMessage)(?:::\d+)?}}/i.test(content)) feature = 'greeting macro';

        if (feature) void onboardingExperimentalMacroEngine(feature);
    }

    const environment = {};

    if (typeof _original === 'string') {
        let originalSubstituted = false;
        environment.original = () => {
            if (originalSubstituted) {
                return '';
            }

            originalSubstituted = true;
            return _original;
        };
    }

    const getGroupValue = (includeMuted) => {
        if (typeof _group === 'string') {
            return _group;
        }

        if (selected_group) {
            const members = groupsStore.get(selected_group)?.members;
            /** @type {string[]} */
            const disabledMembers = groupsStore.get(selected_group)?.disabled_members ?? [];
            const isMuted = x => includeMuted ? true : !disabledMembers.includes(x);
            const names = Array.isArray(members)
                ? members.filter(isMuted).map(m => charactersStore.get(m)?.name).filter(Boolean).join(', ')
                : '';
            return names;
        } else {
            return _name2 ?? name2;
        }
    };

    const getNotCharValue = () => {
        const currentUser = _name1 ?? name1;
        const currentSpeaker = _name2 ?? name2;

        // Single character chat
        if (!selected_group) {
            return currentUser;
        }

        // Group chat
        const members = groupsStore.get(selected_group)?.members;

        if (!Array.isArray(members)) {
            return currentUser;
        }

        const memberNames = members
            .map(m => charactersStore.get(m)?.name)
            .filter(Boolean); // Filter out any null/undefined names

        // Filter out the current speaker and add the user
        const otherMembers = memberNames.filter(name => name !== currentSpeaker);
        otherMembers.push(currentUser);

        return otherMembers.join(', ');
    };

    if (_replaceCharacterCard) {
        const fields = getCharacterCardFields();
        environment.charPrompt = fields.system || '';
        environment.charInstruction = environment.charJailbreak = fields.jailbreak || '';
        environment.description = fields.description || '';
        environment.personality = fields.personality || '';
        environment.scenario = fields.scenario || '';
        environment.persona = fields.persona || '';
        environment.mesExamples = () => {
            const isInstruct = power_user.instruct.enabled && main_api !== 'openai';
            const mesExamplesArray = parseMesExamples(fields.mesExamples, isInstruct);
            if (isInstruct) {
                const instructExamples = formatInstructModeExamples(mesExamplesArray, name1, name2);
                return instructExamples.join('');
            }
            return mesExamplesArray.join('');
        };
        environment.mesExamplesRaw = fields.mesExamples || '';
        environment.charVersion = fields.version || '';
        environment.char_version = fields.version || '';
        environment.charDepthPrompt = fields.charDepthPrompt || '';
        environment.creatorNotes = fields.creatorNotes || '';
    }

    // Must be substituted last so that they're replaced inside {{description}}
    environment.user = _name1 ?? name1;
    environment.char = _name2 ?? name2;
    environment.group = environment.charIfNotGroup = getGroupValue(true);
    environment.groupNotMuted = getGroupValue(false);
    environment.notChar = getNotCharValue();
    environment.model = getGeneratingModel();

    if (additionalMacro && typeof additionalMacro === 'object') {
        Object.assign(environment, additionalMacro);
    }

    return evaluateMacros(content, environment, postProcessFn);
}

/** @typedef {import('./scripts/macros/engine/MacroRegistry.js').MacroHandler} MacroHandler */

/**
 * Substitutes {{macros}} in a string using the new macro engine.
 *
 * This will replace all registered macros and dynamic additional macros as environment context.
 *
 * @param {string} content - The string to substitute parameters in.
 * @param {Object} [options={}] - Options for the substitution.
 * @param {string} [options.name1Override] - The name of the user. Uses global name1 if not provided.
 * @param {string} [options.name2Override] - The name of the character. Uses global name2 if not provided.
 * @param {string} [options.original] - The original message for {{original}} substitution.
 * @param {string} [options.groupOverride] - The group members list for {{group}} substitution.
 * @param {boolean} [options.replaceCharacterCard=true] - Whether to replace character card macros.
 * @param {Record<string, import('./scripts/macros/engine/MacroEnv.types.js').DynamicMacroValue>} [options.dynamicMacros={}] - Additional environment variables as dynamic macros for substitution. Registered as macro functions.
 * @param {(x: string) => string} [options.postProcessFn=(x) => x] - Post-processing function for each substituted macro.
 * @returns {string} The string with substituted parameters.
 */
export function substituteParams(content, options = {}) {
    if (!content) return '';

    if (typeof content !== 'string') {
        console.warn('substituteParams: content will be coerced to string', content);
        content = String(content);
    }

    // Handle legacy signature calls to substituteParams
    // We'll simply re-route them to a temporary legacy function. In the future, we'll remove this and cleanly build the options object ourselves.
    const isOptionsObject = options && typeof options === 'object' && !Array.isArray(options);
    if (!isOptionsObject) {
        return substituteParamsLegacy.call(this, ...arguments);
    }

    // Keep the new macro engine behind a feature switch for now
    if (!power_user?.experimental_macro_engine) {
        return substituteParamsLegacy(content, options.name1Override, options.name2Override, options.original, options.groupOverride, options.replaceCharacterCard, options.dynamicMacros, options.postProcessFn);
    }

    const ctx = /** @type {import('./scripts/macros/engine/MacroEnvBuilder.js').MacroEnvRawContext} */ ({
        content,
        name1Override: options.name1Override,
        name2Override: options.name2Override,
        original: options.original,
        groupOverride: options.groupOverride,
        replaceCharacterCard: options.replaceCharacterCard ?? true,
        dynamicMacros: options.dynamicMacros ?? {},
        postProcessFn: options.postProcessFn ?? ((x) => x),
    });

    const env = MacroEnvBuilder.buildFromRawEnv(ctx);
    const result = MacroEngine.evaluate(content, env);
    return result;
}


/**
 * Gets stopping sequences for the prompt.
 * @param {boolean} isImpersonate A request is made to impersonate a user
 * @param {boolean} isContinue A request is made to continue the message
 * @param {string} [api] Optional API name to get API-specific stopping sequences for
 * @returns {string[]} Array of stopping strings
 */
export function getStoppingStrings(isImpersonate, isContinue, api = main_api) {
    // Only custom stop strings apply to Chat Completion
    if (api === 'openai') {
        return getCustomStoppingStrings();
    }

    const result = [];

    if (power_user.context.names_as_stop_strings) {
        const charString = `\n${name2}:`;
        const userString = `\n${name1}:`;
        result.push(isImpersonate ? charString : userString);

        result.push(userString);

        if (isContinue && Array.isArray(chat) && chat[chat.length - 1]?.is_user) {
            result.push(charString);
        }

        // Add group members as stopping strings if generating for a specific group member or user. (Allow slash commands to work around name stopping string restrictions)
        if (selected_group && (name2 || isImpersonate)) {
            const group = groupsStore.get(selected_group);

            if (group && Array.isArray(group.members)) {
                const names = group.members
                    .map(x => charactersStore.get(x))
                    .filter(x => x && x.name && x.name !== name2)
                    .map(x => `\n${x.name}:`);
                result.push(...names);
            }
        }
    }

    result.push(...getInstructStoppingSequences());
    result.push(...getCustomStoppingStrings());

    if (power_user.single_line) {
        result.unshift('\n');
    }

    return result.filter(x => x).filter(onlyUnique);
}

/**
 * Background generation based on the provided prompt.
 * @typedef {object} GenerateQuietPromptParams
 * @prop {string} [quietPrompt] Instruction prompt for the AI
 * @prop {boolean} [quietToLoud] Whether the message should be sent in a foreground (loud) or background (quiet) mode
 * @prop {boolean} [skipWIAN] Whether to skip addition of World Info and Author's Note into the prompt
 * @prop {string} [quietImage] Image to use for the quiet prompt
 * @prop {string} [quietName] Name to use for the quiet prompt (defaults to "System:")
 * @prop {number} [responseLength] Maximum response length. If unset, the global default value is used.
 * @prop {number} [forceChId] Character ID to use for this generation run. Works in groups only.
 * @prop {string} [forceAvatar] Avatar key of the character to use for this generation run, instead of `forceChId`. Works in groups only.
 * @prop {object} [jsonSchema] JSON schema to use for the structured generation. Usually requires a special instruction.
 * @prop {boolean} [removeReasoning] Parses and removes the reasoning block according to reasoning format preferences
 * @prop {boolean} [trimToSentence] Whether to trim the response to the last complete sentence
 * @param {GenerateQuietPromptParams} params Parameters for the quiet prompt generation
 * @returns {Promise<string>} Generated text. If using structured output, will contain a serialized JSON object.
 */
export async function generateQuietPrompt({ quietPrompt = '', quietToLoud = false, skipWIAN = false, quietImage = null, quietName = null, responseLength = null, forceChId = null, forceAvatar = null, jsonSchema = null, removeReasoning = true, trimToSentence = false } = {}) {
    if (arguments.length > 0 && typeof arguments[0] !== 'object') {
        console.trace('generateQuietPrompt called with positional arguments. Please use an object instead.');
        [quietPrompt, quietToLoud, skipWIAN, quietImage, quietName, responseLength, forceChId, jsonSchema] = arguments;
    }

    const responseLengthCustomized = typeof responseLength === 'number' && responseLength > 0;
    let eventHook = () => { };
    try {
        /** @type {GenerateOptions} */
        const generateOptions = {
            quiet_prompt: quietPrompt ?? '',
            quietToLoud: quietToLoud ?? false,
            skipWIAN: skipWIAN ?? false,
            force_name2: true,
            quietImage: quietImage ?? null,
            quietName: quietName ?? null,
            // forceChId (legacy numeric id) translated to an avatar here, so everything downstream is avatar-shaped.
            force_avatar: forceAvatar ?? ((forceChId !== null && forceChId !== undefined) ? exposedCharacters[forceChId]?.avatar ?? null : null),
            jsonSchema: jsonSchema ?? null,
        };
        if (responseLengthCustomized) {
            TempResponseLength.save(main_api, responseLength);
            eventHook = TempResponseLength.setupEventHook(main_api);
        }
        let result = await Generate('quiet', generateOptions);
        result = trimToSentence ? trimToEndSentence(result) : result;
        result = removeReasoning ? removeReasoningFromString(result) : result;
        return result;
    } finally {
        if (responseLengthCustomized && TempResponseLength.isCustomized()) {
            TempResponseLength.restore(main_api);
            TempResponseLength.removeEventHook(main_api, eventHook);
        }
    }
}

/**
 * Executes slash commands and returns the new text and whether the generation was interrupted.
 * @param {string} message Text to be sent
 * @returns {Promise<boolean>} Whether the message sending was interrupted
 */
export async function processCommands(message) {
    if (!message || !message.trim().startsWith('/')) {
        return false;
    }
    await executeSlashCommandsOnChatInput(message, {
        clearChatInput: true,
    });
    return true;
}

/**
 * Extracts the contents of bias macros from a message.
 * @param {string} message Message text
 * @returns {string} Message bias extracted from the message (or an empty string if not found)
 */
export function extractMessageBias(message) {
    if (!message) {
        return '';
    }

    try {
        const biasHandlebars = Handlebars.create();
        const biasMatches = [];
        biasHandlebars.registerHelper('bias', function (text) {
            biasMatches.push(text);
            return '';
        });
        const template = biasHandlebars.compile(message);
        template({});

        if (biasMatches && biasMatches.length > 0) {
            return ` ${biasMatches.join(' ')}`;
        }

        return '';
    } catch {
        return '';
    }
}

/**
 * Removes impersonated group member lines from the group member messages.
 * Doesn't do anything if group reply trimming is disabled.
 * @param {string} getMessage Group message
 * @returns Cleaned-up group message
 */
function cleanGroupMessage(getMessage) {
    if (power_user.disable_group_trimming) {
        return getMessage;
    }

    const group = groupsStore.get(selected_group);

    if (group && Array.isArray(group.members) && group.members) {
        for (let member of group.members) {
            const character = charactersStore.get(member);

            if (!character) {
                continue;
            }

            const name = character.name;

            // Skip current speaker.
            if (name === name2) {
                continue;
            }

            const regex = new RegExp(`(^|\n)${escapeRegex(name)}:`);
            const nameMatch = getMessage.match(regex);
            if (nameMatch) {
                getMessage = getMessage.substring(0, nameMatch.index);
            }
        }
    }
    return getMessage;
}

export function addPersonaDescriptionExtensionPrompt() {
    const INJECT_TAG = 'PERSONA_DESCRIPTION';
    setExtensionPrompt(INJECT_TAG, '', extension_prompt_types.IN_PROMPT, 0);

    const personaDescription = getPersonaDescription();
    const personaDescriptionPosition = getPersonaDescriptionPosition();

    if (!personaDescription || personaDescriptionPosition === persona_description_positions.NONE) {
        return;
    }

    const promptPositions = [persona_description_positions.BOTTOM_AN, persona_description_positions.TOP_AN];

    if (promptPositions.includes(personaDescriptionPosition) && shouldWIAddPrompt) {
        const originalAN = extension_prompts[NOTE_MODULE_NAME].value;
        const ANWithDesc = personaDescriptionPosition === persona_description_positions.TOP_AN
            ? `${personaDescription}\n${originalAN}`
            : `${originalAN}\n${personaDescription}`;

        setExtensionPrompt(NOTE_MODULE_NAME, ANWithDesc, chat_metadata[metadata_keys.position], chat_metadata[metadata_keys.depth], extension_settings.note.allowWIScan, chat_metadata[metadata_keys.role]);
    }

    if (personaDescriptionPosition === persona_description_positions.AT_DEPTH) {
        setExtensionPrompt(INJECT_TAG, personaDescription, extension_prompt_types.IN_CHAT, getPersonaDescriptionDepth(), true, getPersonaDescriptionRole());
    }
}

/**
 * Returns all extension prompts combined.
 * @returns {Promise<string>} Combined extension prompts
 */
export async function getAllExtensionPrompts() {
    const values = [];

    for (const prompt of Object.values(extension_prompts)) {
        const value = prompt?.value?.trim();

        if (!value) {
            continue;
        }

        const hasFilter = typeof prompt.filter === 'function';
        if (hasFilter && !await prompt.filter()) {
            continue;
        }

        values.push(value);
    }

    return substituteParams(values.join('\n'));
}

/**
 * Wrapper to fetch extension prompts by module name
 * @param {string} moduleName Module name
 * @returns {Promise<string>} Extension prompt
 */
export async function getExtensionPromptByName(moduleName) {
    if (!moduleName) {
        return '';
    }

    const prompt = extension_prompts[moduleName];

    if (!prompt) {
        return '';
    }

    const hasFilter = typeof prompt.filter === 'function';

    if (hasFilter && !await prompt.filter()) {
        return '';
    }

    return substituteParams(prompt.value);
}

/**
 * Gets the maximum depth of extension prompts.
 * @returns {number} Maximum depth of extension prompts
 */
export function getExtensionPromptMaxDepth() {
    return MAX_INJECTION_DEPTH;
    /*
    const prompts = Object.values(extension_prompts);
    const maxDepth = Math.max(...prompts.map(x => x.depth ?? 0));
    // Clamp to 1 <= depth <= MAX_INJECTION_DEPTH
    return Math.max(Math.min(maxDepth, MAX_INJECTION_DEPTH), 1);
    */
}

/**
 * Returns the extension prompt for the given position, depth, and role.
 * If multiple prompts are found, they are joined with a separator.
 * @param {number} [position] Position of the prompt
 * @param {number} [depth] Depth of the prompt
 * @param {string} [separator] Separator for joining multiple prompts
 * @param {number} [role] Role of the prompt
 * @param {boolean} [wrap] Wrap start and end with a separator
 * @returns {Promise<string>} Extension prompt
 */
export async function getExtensionPrompt(position = extension_prompt_types.IN_PROMPT, depth = undefined, separator = '\n', role = undefined, wrap = true) {
    const filterByFunction = async (prompt) => {
        const hasFilter = typeof prompt.filter === 'function';
        if (hasFilter && !await prompt.filter()) {
            return false;
        }
        return true;
    };
    const promptPromises = Object.keys(extension_prompts)
        .sort()
        .map((x) => extension_prompts[x])
        .filter(x => x.position == position && x.value)
        .filter(x => depth === undefined || x.depth === undefined || x.depth === depth)
        .filter(x => role === undefined || x.role === undefined || x.role === role)
        .filter(filterByFunction);
    const prompts = await Promise.all(promptPromises);

    let values = prompts.map(x => x.value.trim()).join(separator);
    if (wrap && values.length && !values.startsWith(separator)) {
        values = separator + values;
    }
    if (wrap && values.length && !values.endsWith(separator)) {
        values = values + separator;
    }
    if (values.length) {
        values = substituteParams(values);
    }
    return values;
}

/**
 * Base chat replacement function for character card fields.
 * 1. Substitutes macros using substituteParams.
 * 2. Collapses newlines if enabled in power user settings.
 * 3. Removes carriage return characters.
 * @param {string} value Input string
 * @param {string?} name1Override Override for name1
 * @param {string?} name2Override Override for name2
 * @returns {string} Processed string
 */
export function baseChatReplace(value, name1Override = null, name2Override = null) {
    if (typeof value === 'string' && value.length > 0) {
        value = substituteParams(value, { name1Override, name2Override, replaceCharacterCard: false });

        if (power_user.collapse_newlines) {
            value = collapseNewlines(value);
        }

        value = value.replace(/\r/g, '');
    }
    return value;
}

/**
 * @typedef {Object} CharacterCardFields
 * @property {string} system System prompt
 * @property {string} mesExamples Message examples
 * @property {string} description Description
 * @property {string} personality Personality
 * @property {string} persona Persona
 * @property {string} scenario Scenario
 * @property {string} jailbreak Jailbreak instructions
 * @property {string} version Character version
 * @property {string} charDepthPrompt Character depth note
 * @property {string} creatorNotes Character creator notes
 * @property {string} firstMessage Character first message / greeting
 * @property {string[]} alternateGreetings Character alternate greetings
 */

/**
 * Helper to create an object with lazy, memoized getters from a map of field resolvers.
 * @param {Record<string, () => string|string[]>} resolvers Map of field names to resolver functions
 * @returns {CharacterCardFields} Object with lazy getters
 */
export function createLazyFields(resolvers) {
    const result = /** @type {CharacterCardFields} */ ({});
    for (const [key, resolver] of Object.entries(resolvers)) {
        let cached;
        let resolved = false;
        Object.defineProperty(result, key, {
            get() {
                if (!resolved) {
                    cached = resolver();
                    resolved = true;
                }
                return cached;
            },
            enumerable: true,
            configurable: true,
        });
    }
    return result;
}

/**
 * Returns the character card fields for the current character as lazy getters.
 * Each field is only processed (baseChatReplace) when first accessed.
 * @param {Object} [options={}]
 * @param {number|string} [options.chid] Optional character: an index into `getContext().characters`, or an avatar key. Falls back to the current character when null or undefined.
 * @param {string} [options.avatar] Optional character avatar, used when `chid` is null or undefined. With both naming different characters, the fields are those of no character.
 * @returns {CharacterCardFields} Character card fields with lazy evaluation
 */
export function getCharacterCardFieldsLazy({ chid = undefined, avatar = undefined } = {}) {
    let character;
    if (chid == null) {
        character = avatar !== undefined ? charactersStore.get(avatar) : getCurrentCharacter();
    } else if (avatar !== undefined) {
        const resolved = resolveCharacterRefPair(chid, avatar);
        character = resolved === CHARACTER_REF_MISMATCH ? undefined : resolved;
    } else {
        character = resolveCharacterRef(chid);
    }

    // For group chats, we need to check if group cards should be used
    const useGroupCards = selected_group && character;
    const groupCardsLazy = useGroupCards ? getGroupCharacterCardsLazy(selected_group, character.avatar) : null;

    /** @type {Record<string, () => string|string[]>} */
    const resolvers = {
        persona: () => baseChatReplace(getPersonaDescription().trim()),
        system: () => {
            if (!character) return '';
            const systemPrompt = chat_metadata.system_prompt || character.data?.system_prompt || '';
            return power_user.prefer_character_prompt ? baseChatReplace(systemPrompt.trim()) : '';
        },
        jailbreak: () => {
            if (!character) return '';
            return power_user.prefer_character_jailbreak ? baseChatReplace(character.data?.post_history_instructions?.trim()) : '';
        },
        version: () => character?.data?.character_version ?? '',
        charDepthPrompt: () => {
            if (!character) return '';
            return baseChatReplace(character.data?.extensions?.depth_prompt?.prompt?.trim());
        },
        creatorNotes: () => {
            if (!character) return '';
            return baseChatReplace(character.data?.creator_notes?.trim());
        },
        // These four fields may be overridden by group cards
        description: () => {
            if (groupCardsLazy) return groupCardsLazy.description;
            if (!character) return '';
            return baseChatReplace(character.description?.trim());
        },
        personality: () => {
            if (groupCardsLazy) return groupCardsLazy.personality;
            if (!character) return '';
            return baseChatReplace(character.personality?.trim());
        },
        scenario: () => {
            if (groupCardsLazy) return groupCardsLazy.scenario;
            if (!character) return '';
            const scenarioText = chat_metadata.scenario || character.scenario || '';
            return baseChatReplace(scenarioText.trim());
        },
        mesExamples: () => {
            if (groupCardsLazy) return groupCardsLazy.mesExamples;
            if (!character) return '';
            const exampleDialog = chat_metadata.mes_example || character.mes_example || '';
            return baseChatReplace(exampleDialog.trim());
        },
        firstMessage: () => {
            if (!character) return '';
            const firstMes = character.first_mes?.trim() || '';
            return baseChatReplace(firstMes);
        },
        alternateGreetings: () => {
            if (!character) return [];
            const altGreetings = character.data?.alternate_greetings;
            if (!Array.isArray(altGreetings)) return [];
            return altGreetings.map(greeting => baseChatReplace(greeting?.trim()));
        },
    };

    return createLazyFields(resolvers);
}

/**
 * Returns the character card fields for the current character.
 * @param {Object} [options={}]
 * @param {number|string} [options.chid] Optional character, as for {@link getCharacterCardFieldsLazy}
 * @param {string} [options.avatar] Optional character avatar, as for {@link getCharacterCardFieldsLazy}
 * @returns {CharacterCardFields} Character card fields
 */
export function getCharacterCardFields({ chid = undefined, avatar = undefined } = {}) {
    const lazy = getCharacterCardFieldsLazy({ chid, avatar });

    // Resolve all lazy fields into a plain object
    return {
        system: lazy.system,
        mesExamples: lazy.mesExamples,
        description: lazy.description,
        personality: lazy.personality,
        persona: lazy.persona,
        scenario: lazy.scenario,
        jailbreak: lazy.jailbreak,
        version: lazy.version,
        charDepthPrompt: lazy.charDepthPrompt,
        creatorNotes: lazy.creatorNotes,
        firstMessage: lazy.firstMessage,
        alternateGreetings: lazy.alternateGreetings,
    };
}

/**
 * Parses an examples string.
 * @param {string} examplesStr
 * @returns {string[]} Examples array with block heading
 */
export function parseMesExamples(examplesStr, isInstruct) {
    if (!examplesStr || examplesStr.length === 0 || examplesStr === '<START>') {
        return [];
    }

    if (!examplesStr.startsWith('<START>')) {
        examplesStr = '<START>\n' + examplesStr.trim();
    }

    const exampleSeparator = power_user.context.example_separator ? `${substituteParams(power_user.context.example_separator)}\n` : '';
    const blockHeading = (main_api === 'openai' || isInstruct) ? '<START>\n' : exampleSeparator;
    const splitExamples = examplesStr.split(/<START>/gi).slice(1).map(block => `${blockHeading}${block.trim()}\n`);

    return splitExamples;
}

export function isStreamingEnabled() {
    return (
        (main_api == 'openai' &&
            oai_settings.stream_openai &&
            !(oai_settings.chat_completion_source == chat_completion_sources.OPENAI && ['o1-2024-12-17', 'o1'].includes(oai_settings.openai_model))
        )
        || (main_api == 'kobold' && kai_settings.streaming_kobold && kai_flags.can_use_streaming)
        || (main_api == 'novel' && nai_settings.streaming_novel)
        || (main_api == 'textgenerationwebui' && textgen_settings.streaming));
}

export function showStopButton() {
    $('#mes_stop').css({ 'display': 'flex' });
}

export function hideStopButton() {
    // prevent NOOP, because hideStopButton() gets called multiple times
    if ($('#mes_stop').css('display') !== 'none') {
        $('#mes_stop').css({ 'display': 'none' });
        eventSource.emit(event_types.GENERATION_ENDED, chat.length);
    }
}

export class StreamingProcessor {
    /**
     * Creates a new streaming processor.
     * @param {string} type Generation type
     * @param {boolean} forceName2 If true, force the use of name2
     * @param {Date} timeStarted Date when generation was started
     * @param {string} continueMessage Previous message if the type is 'continue'
     * @param {PromptReasoning} promptReasoning Prompt reasoning instance
     */
    constructor(type, forceName2, timeStarted, continueMessage, promptReasoning) {
        this.result = '';
        this.messageId = -1;
        /** @type {HTMLElement} */
        this.messageDom = null;
        /** @type {HTMLElement} */
        this.messageTextDom = null;
        /** @type {HTMLElement} */
        this.messageTimerDom = null;
        /** @type {HTMLElement} */
        this.messageTokenCounterDom = null;
        /** @type {HTMLTextAreaElement} */
        this.sendTextarea = document.querySelector('#send_textarea');
        this.type = type;
        this.force_name2 = forceName2;
        this.isStopped = false;
        this.isFinished = false;
        this.generator = this.nullStreamingGeneration;
        this.abortController = new AbortController();
        this.firstMessageText = '...';
        this.timeStarted = timeStarted;
        /** @type {number?} */
        this.timeToFirstToken = null;
        this.createdAt = new Date();
        this.continueMessage = type === 'continue' ? continueMessage : '';
        this.swipes = [];
        /** @type {import('./scripts/logprobs.js').TokenLogprobs[]} */
        this.messageLogprobs = [];
        this.toolCalls = [];
        /** @type {{node_id: string, pending_tool_calls: any[]}?} */
        this.toolCallHandoff = null;
        // THIS TASK (stealth-tool parity) - see this class's end-of-stream call site
        // (finishGenerating()) and forwardAndPersistCompactStreamWithServerTools()'s `aborted` branch doc
        // comment (src/endpoints/backends/chat-completions.js) for the full mechanism. Mirrors
        // `toolCallHandoff` above exactly, for the distinct "abort, nothing persisted" trailer.
        this.toolCallAborted = false;
        /** @type {string?} The node persistAssistantReply() wrote, if the server sent one ahead of [DONE]. */
        this.assistantNodeId = null;
        /** @type {Record<string, *>?} Raw-action prompt-breakdown fields for itemized-prompts.js, if the server sent them via a control frame. */
        this.itemization = null;
        /** @type {unknown} The server's last `stored` list this stream adopted (see adoptStored(), chat-store.js). */
        this.adoptedStored = null;
        // Initialize reasoning in its own handler
        this.reasoningHandler = new ReasoningHandler(timeStarted);
        /** @type {PromptReasoning} */
        this.promptReasoning = promptReasoning;
        /** @type {string[]} */
        this.images = [];
        /** @type {string?} */
        this.reasoningSignature = null;
    }

    /**
     * Initializes DOM elements for the current message.
     * @param {number} messageId Current message ID
     * @param {boolean?} continueOnReasoning If continuing on reasoning
     */
    async #checkDomElements(messageId, continueOnReasoning = null) {
        if (this.messageDom === null || this.messageTextDom === null) {
            this.messageDom = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
            this.messageTextDom = this.messageDom?.querySelector('.mes_text');
            this.messageTimerDom = this.messageDom?.querySelector('.mes_timer');
            this.messageTokenCounterDom = this.messageDom?.querySelector('.tokenCounterDisplay');
        }
        if (continueOnReasoning) {
            await this.reasoningHandler.process(messageId, false, this.promptReasoning);
        }
        this.reasoningHandler.updateDom(messageId);
    }

    #updateMessageBlockVisibility() {
        if (this.messageDom instanceof HTMLElement && Array.isArray(this.toolCalls) && this.toolCalls.length > 0) {
            const shouldHide = ['', '...'].includes(this.result) && !this.reasoningHandler.reasoning;
            this.messageDom.classList.toggle('displayNone', shouldHide);
        }
    }

    markUIGenStarted() {
        deactivateSendButtons();
    }

    markUIGenStopped() {
        unblockGeneration();
    }

    async onStartStreaming(text) {
        const continueOnReasoning = !!(this.type === 'continue' && this.promptReasoning.prefixReasoning);
        if (continueOnReasoning) {
            this.reasoningHandler.initContinue(this.promptReasoning);
        }

        let messageId = -1;

        if (this.type == 'impersonate') {
            this.sendTextarea.value = '';
            this.sendTextarea.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
            await saveReply({ type: this.type, getMessage: text, fromStreaming: true });
            messageId = chat.length - 1;
            await this.#checkDomElements(messageId, continueOnReasoning);
            this.markUIGenStarted();
        }
        hideSwipeButtons({ hideCounters: true });
        scrollChatToBottom({ waitForFrame: true });
        return messageId;
    }

    async onProgressStreaming(messageId, text, isFinal) {
        const isImpersonate = this.type == 'impersonate';
        const isContinue = this.type == 'continue';

        if (!isImpersonate && !isContinue && Array.isArray(this.swipes) && this.swipes.length > 0) {
            for (let i = 0; i < this.swipes.length; i++) {
                this.swipes[i] = cleanUpMessage({
                    getMessage: this.swipes[i],
                    isImpersonate: false,
                    isContinue: false,
                    displayIncompleteSentences: true,
                    stoppingStrings: this.stoppingStrings,
                });
            }
        }

        let processedText = cleanUpMessage({
            getMessage: text,
            isImpersonate: isImpersonate,
            isContinue: isContinue,
            displayIncompleteSentences: !isFinal,
            stoppingStrings: this.stoppingStrings,
        });

        const charsToBalance = ['*', '"', '```', '~~~'];
        for (const char of charsToBalance) {
            if (!isFinal && isOdd(countOccurrences(processedText, char))) {
                const separator = char.length > 1 ? '\n' : '';
                processedText = processedText.trimEnd() + separator + char;
            }
        }

        if (isImpersonate) {
            this.sendTextarea.value = processedText;
            this.sendTextarea.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
            const mesChanged = chat[messageId].mes !== processedText;
            await this.#checkDomElements(messageId);
            this.#updateMessageBlockVisibility();
            const currentTime = new Date();

            // Immutable message update: batch property changes into one replace
            updateMessage(messageId, {
                mes: processedText,
                gen_started: this.timeStarted,
                gen_finished: currentTime,
                extra: { ...(chat[messageId].extra || {}), time_to_first_token: this.timeToFirstToken },
            });

            // Update reasoning (may itself call updateMessage)
            await this.reasoningHandler.process(messageId, mesChanged, this.promptReasoning);
            processedText = chat[messageId].mes;

            // Token count update.
            const tokenCountText = this.reasoningHandler.reasoning + processedText;
            const currentTokenCount = isFinal && power_user.message_token_count_enabled ? await getTokenCountAsync(tokenCountText, 0) : 0;
            if (currentTokenCount) {
                updateMessage(messageId, {
                    extra: { ...chat[messageId].extra, token_count: currentTokenCount },
                });
                if (this.messageTokenCounterDom instanceof HTMLElement) {
                    this.messageTokenCounterDom.textContent = `${currentTokenCount}t`;
                }
            }

            if ((this.type == 'swipe' || this.type === 'continue') && Array.isArray(chat[messageId].swipes)) {
                const newSwipes = [...chat[messageId].swipes];
                newSwipes[chat[messageId].swipe_id] = processedText;
                const newSwipeInfo = [...(chat[messageId].swipe_info || [])];
                newSwipeInfo[chat[messageId].swipe_id] = {
                    'send_date': chat[messageId].send_date,
                    'gen_started': chat[messageId].gen_started,
                    'gen_finished': chat[messageId].gen_finished,
                    'extra': structuredClone(chat[messageId].extra),
                };
                updateMessage(messageId, { swipes: newSwipes, swipe_info: newSwipeInfo });
            }

            const formattedText = messageFormatting(
                processedText,
                chat[messageId].name,
                chat[messageId].is_system,
                chat[messageId].is_user,
                messageId,
                {},
                false,
            );
            if (this.messageTextDom instanceof HTMLElement) {
                if (power_user.stream_fade_in) {
                    applyStreamFadeIn(this.messageTextDom, formattedText);
                } else {
                    this.messageTextDom.innerHTML = formattedText;
                }
            }

            const timePassed = formatGenerationTimer(this.timeStarted, currentTime, currentTokenCount, this.reasoningHandler.getDuration(), this.timeToFirstToken);
            if (this.messageTimerDom instanceof HTMLElement) {
                this.messageTimerDom.textContent = timePassed.timerValue;
                this.messageTimerDom.title = timePassed.timerTitle;
            }

            this.setFirstSwipe(messageId);
        }

        if (!scrollLock) {
            scrollChatToBottom({ waitForFrame: true });
        }
    }

    /**
     * Finalizes an intermediary message after generation is complete, or a tool call is performed.
     * Performs essential message processing (code blocks, reasoning, swipes, attachments, events)
     * without the heavier finish operations (UI unlock - optional, auto-swipe, sound, save chat).
     * @param {number} messageId - The message ID to finalize.
     * @param {string} text - The message text.
     * @param {Object} options - Additional options for finalization.
     * @param {boolean} options.unlockUI - Whether to unlock the generation UI.
     */
    async finalizeIntermediaryMessage(messageId, text, { unlockUI = true }) {
        await this.onProgressStreaming(messageId, text, true);
        const messageElement = chatElement.find(`.mes[mesid="${messageId}"]`);
        let message = chat[messageId];
        addCopyToCodeBlocks(messageElement);

        await this.reasoningHandler.finish(messageId);

        if (Array.isArray(this.swipes) && this.swipes.length > 0) {
            const swipeInfoExtra = structuredClone(message.extra ?? {});
            delete swipeInfoExtra.token_count;
            delete swipeInfoExtra.reasoning;
            delete swipeInfoExtra.reasoning_duration;
            const swipeInfo = {
                send_date: message.send_date,
                gen_started: message.gen_started,
                gen_finished: message.gen_finished,
                extra: swipeInfoExtra,
            };
            const swipeInfoArray = Array(this.swipes.length).fill().map(() => structuredClone(swipeInfo));
            parseReasoningInSwipes(this.swipes, swipeInfoArray, message.extra?.reasoning_duration);
            updateMessage(messageId, {
                swipes: [...(message.swipes || []), ...this.swipes],
                swipe_info: [...(message.swipe_info || []), ...swipeInfoArray],
            });
            message = chat[messageId]; // refresh local reference after update
        }

        syncMesToSwipe(messageId);
        saveLogprobsForActiveMessage(this.messageLogprobs.filter(Boolean), this.continueMessage);

        if (Array.isArray(this.images) && this.images.length > 0) {
            // processImageAttachment mutates its argument; clone so the frozen original isn't touched.
            const mutableMsg = structuredClone(chat[messageId]);
            await processImageAttachment(mutableMsg, { imageUrls: this.images });
            updateMessage(messageId, { extra: mutableMsg.extra });
            message = chat[messageId];
            appendMediaToMessage(message, $(this.messageDom));
        }

        // Store reasoning signature for models that support multi-turn context
        if (this.reasoningSignature) {
            updateMessage(messageId, {
                extra: { ...(chat[messageId].extra || {}), reasoning_signature: this.reasoningSignature },
            });
            message = chat[messageId];
        }

        if (unlockUI) {
            this.markUIGenStopped();
        }

        if (this.type !== 'impersonate') {
            await eventSource.emit(event_types.MESSAGE_RECEIVED, this.messageId, this.type);
            await eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, this.messageId, this.type);
        } else {
            await eventSource.emit(event_types.IMPERSONATE_READY, text);
        }

        updateSwipeCounter(messageId, { message, messageElement });
    }

    async onFinishStreaming(messageId, text) {
        await this.finalizeIntermediaryMessage(messageId, text, { unlockUI: true });

        const isAborted = this.abortController.signal.aborted;
        if (!isAborted && power_user.auto_swipe && generatedTextFiltered(text)) {
            return await swipe(null, SWIPE_DIRECTION.RIGHT, { source: SWIPE_SOURCE.AUTO_SWIPE, repeated: true, forceMesId: chat.length - 1 });
        }
        // Save/persist decision extracted to generation.js (finishStreamedReplyPersistence()) so it can
        // be typechecked under strict null checks with the rest of that invariant-critical cluster -
        // see that function's own comment for the assistantNodeId-vs-heal reasoning.
        await finishStreamedReplyPersistence({ assistantNodeId: this.assistantNodeId, itemization: this.itemization });

        playMessageSound();
    }

    onErrorStreaming() {
        this.abortController.abort();
        this.isStopped = true;

        this.markUIGenStopped();

        const noEmitTypes = ['swipe', 'impersonate', 'continue'];
        if (!noEmitTypes.includes(this.type)) {
            eventSource.emit(event_types.MESSAGE_RECEIVED, this.messageId, this.type);
            eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, this.messageId, this.type);
        }
    }

    setFirstSwipe(messageId) {
        if (this.type !== 'swipe' && this.type !== 'impersonate') {
            if (Array.isArray(chat[messageId].swipes) && chat[messageId].swipes.length === 1 && chat[messageId].swipe_id === 0) {
                updateMessage(messageId, {
                    swipes: [chat[messageId].mes],
                    swipe_info: [{
                        'send_date': chat[messageId].send_date,
                        'gen_started': chat[messageId].gen_started,
                        'gen_finished': chat[messageId].gen_finished,
                        'extra': structuredClone(chat[messageId].extra),
                    }],
                });
            }
        }
    }

    onStopStreaming() {
        this.abortController.abort();
        this.isFinished = true;
    }

    /**
     * @returns {AsyncGenerator<{ text: string, swipes: string[], logprobs: import('./scripts/logprobs.js').TokenLogprobs, toolCalls: any[], state: any }, void, void>}
     */
    async* nullStreamingGeneration() {
        throw new Error('Generation function for streaming is not hooked up');
    }

    async generate() {
        if (this.messageId == -1) {
            this.messageId = await this.onStartStreaming(this.firstMessageText);
            await delay(1); // delay for message to be rendered
            scrollLock = false;
        }

        // Stopping strings are expensive to calculate, especially with macros enabled. To remove stopping strings
        // when streaming, we cache the result of getStoppingStrings instead of calling it once per token.
        const isImpersonate = this.type == 'impersonate';
        const isContinue = this.type == 'continue';
        this.stoppingStrings = getStoppingStrings(isImpersonate, isContinue, main_api);

        try {
            const sw = new Stopwatch(1000 / power_user.streaming_fps);
            const timestamps = [];
            for await (const { text, swipes, logprobs, toolCalls, state } of this.generator()) {
                const now = Date.now();
                timestamps.push(now);
                if (!this.timeToFirstToken) {
                    this.timeToFirstToken = now - this.createdAt.getTime();
                }
                if (this.isStopped || this.abortController.signal.aborted) {
                    return this.result;
                }

                this.toolCalls = toolCalls;
                // Streaming raw-action tool-calling cutover - see StreamingProcessor.toolCallHandoff's
                // own use at this class's end-of-stream call site (finishGenerating()) and
                // forwardAndPersistCompactStreamWithServerTools()'s doc comment (src/endpoints/backends/
                // chat-completions.js) for the full mechanism. `state` is the SAME object reused across
                // every yield of this generator, so once set it stays set for every later iteration.
                this.toolCallHandoff = state?.toolCallHandoff ?? this.toolCallHandoff;
                // THIS TASK (stealth-tool parity) - see StreamingProcessor.toolCallAborted's own
                // declaration comment above.
                this.toolCallAborted = state?.toolCallAborted ?? this.toolCallAborted;
                this.assistantNodeId = state?.assistantNodeId ?? this.assistantNodeId;
                this.itemization = state?.itemization ?? this.itemization;
                if (state?.stored && state.stored !== this.adoptedStored) {
                    this.adoptedStored = state.stored;
                    adoptStored(state.stored);
                }
                this.result = text;
                this.swipes = Array.from(swipes ?? []);
                if (logprobs) {
                    this.messageLogprobs.push(...(Array.isArray(logprobs) ? logprobs : [logprobs]));
                }
                // Get the updated reasoning string into the handler
                this.reasoningHandler.updateReasoning(this.messageId, state?.reasoning);
                this.images = state?.images ?? [];
                this.reasoningSignature = state?.signature ?? null;
                await eventSource.emit(event_types.STREAM_TOKEN_RECEIVED, text);
                await sw.tick(async () => await this.onProgressStreaming(this.messageId, this.continueMessage + text));
            }
            const seconds = (timestamps[timestamps.length - 1] - timestamps[0]) / 1000;
            console.warn(`Stream stats: ${timestamps.length} tokens, ${seconds.toFixed(2)} seconds, rate: ${Number(timestamps.length / seconds).toFixed(2)} TPS`);
        } catch (err) {
            // in the case of a self-inflicted abort, we have already cleaned up
            if (!this.isFinished) {
                console.error(err);
                this.onErrorStreaming();
            }
            return this.result;
        }

        this.isFinished = true;
        return this.result;
    }
}

/**
 * Constructs a prompt to be used for either Text Completion or Chat Completion. Input is format-agnostic.
 * @param {string | object[]} prompt Input prompt. Can be a string or an array of chat-style messages, i.e. [{role: '', content: ''}, ...]
 * @param {string} api API to use.
 * @param {boolean} instructOverride true to override instruct mode, false to use the default value
 * @param {boolean} quietToLoud true to generate a message in system mode, false to generate a message in character mode
 * @param {string} [systemPrompt] System prompt to use.
 * @param {string} [prefill] Prefill for the prompt.
 * @returns {string | object[]} Prompt ready for use in generation. If using TC, this will be a string. If using CC, this will be an array of chat-style messages.
 */
export function createRawPrompt(prompt, api, instructOverride, quietToLoud, systemPrompt, prefill) {
    const isInstruct = power_user.instruct.enabled && api !== 'openai' && api !== 'novel' && !instructOverride;

    // If the prompt was given as a string, convert to a message-style object assuming user role
    if (typeof prompt === 'string') {
        const message = { role: 'user', content: prompt.trim() };
        prompt = [message];
    } else {  // checks for message-style object
        if (prompt.length === 0 && !systemPrompt) throw Error('No messages provided');
    }

    // Substitute the prefill if provided
    prefill = substituteParams(prefill ?? '');

    // Format each message in the prompt, accounting for the provided roles
    for (const message of prompt) {
        let name = '';
        if (message.role === 'user') name = message.name ?? name1;
        if (message.role === 'assistant') name = message.name ?? name2;
        if (message.role === 'system') name = message.name ?? '';
        const prefix = isInstruct || api === 'openai' ? '' : (name ? `${name}: ` : '');
        message.content = prefix + substituteParams(message.content ?? '');
        if (isInstruct) {  // instruct formatting for text completion
            const isUser = message.role === 'user';
            const isNarrator = message.role === 'system';
            message.content = formatInstructModeChat(name, message.content, isUser, isNarrator, '', name1, name2, false);
        }
    }

    // prepend system prompt, if provided
    if (systemPrompt) {
        systemPrompt = substituteParams(systemPrompt);
        systemPrompt = isInstruct ? formatInstructModeStoryString(systemPrompt) : systemPrompt.trim();
        if (isInstruct && systemPrompt.length > 0 && !systemPrompt.endsWith('\n')) {
            if (power_user.instruct.wrap && !power_user.instruct.story_string_suffix) {
                systemPrompt += '\n';
            }
        }
        prompt.unshift({ role: 'system', content: systemPrompt });
    }

    // with Chat Completion, the prefill is an additional assistant message at the end.
    if (api === 'openai' && prefill) {
        prompt.push({ role: 'assistant', content: prefill });
    }

    // if text completion, convert to text prompt by concatenating all message contents and adding the prefill as a promptBias.
    if (api !== 'openai') {
        const joiner = isInstruct ? '' : '\n';
        prompt = prompt.map(message => message.content).join(joiner);
        prompt = api === 'novel' ? adjustNovelInstructionPrompt(prompt) : prompt;
        prompt = prompt + (isInstruct ? formatInstructModePrompt(name2, false, prefill, name1, name2, true, quietToLoud) : `\n${prefill}`);  // add last line
    }

    return prompt;
}

/**
 * @typedef {object} GenerateRawParams
 * @prop {string | object[]} [prompt] Prompt to generate a message from. Can be a string or an array of chat-style messages, i.e. [{role: '', content: ''}, ...]
 * @prop {string} [api] API to use. Main API is used if not specified.
 * @prop {boolean} [instructOverride] true to override instruct mode, false to use the default value
 * @prop {boolean} [quietToLoud] true to generate a message in system mode, false to generate a message in character mode
 * @prop {string} [systemPrompt] System prompt to use.
 * @prop {number} [responseLength] Maximum response length. If unset, the global default value is used.
 * @prop {boolean} [trimNames] Whether to allow trimming "{{user}}:" and "{{char}}:" from the response.
 * @prop {string} [prefill] An optional prefill for the prompt.
 * @prop {JsonSchema} [jsonSchema] JSON schema to use for the structured generation. Usually requires a special instruction.
 */

/**
 * Generates a raw data object using the provided prompt.
 * This used to be part of `generateRaw`, but separating it out allows extensions to access other data such as reasoning message.
 * @param {GenerateRawParams} params Parameters for generating a message
 * @returns {Promise<object | string>} Raw API response data, or a JSON string extracted from the response when `jsonSchema` is provided.
 */
export async function generateRawData({ prompt = '', api = null, instructOverride = false, quietToLoud = false, systemPrompt = '', responseLength = null, prefill = '', jsonSchema = null } = {}) {
    if (!api) {
        api = main_api;
    }

    const abortController = new AbortController();
    const responseLengthCustomized = typeof responseLength === 'number' && responseLength > 0;
    let eventHook = () => { };

    // construct final prompt from the input. Can either be a string or an array of chat-style messages.
    prompt = createRawPrompt(prompt, api, instructOverride, quietToLoud, systemPrompt, prefill);

    // Allow extensions to stop generation before it happens
    const eventAbortController = new AbortController();
    const abortHook = () => {
        abortController.abort(new Error('Cancelled by stop event'));
        eventAbortController.abort(new Error('Cancelled by extension'));
    };
    eventSource.on(event_types.GENERATION_STOPPED, abortHook);

    try {
        if (responseLengthCustomized) {
            TempResponseLength.save(api, responseLength);
        }
        /** @type {object|any[]} */
        let generateData = {};

        // Allow extensions to modify the prompt before generation
        // 1. for text completion
        if (typeof prompt === 'string') {
            const eventData = { prompt: prompt, dryRun: false };
            await eventSource.emit(event_types.GENERATE_AFTER_COMBINE_PROMPTS, eventData);
            prompt = eventData.prompt;
        }
        // 2. for chat completion
        if (Array.isArray(prompt)) {
            const eventData = { chat: prompt, dryRun: false };
            await eventSource.emit(event_types.CHAT_COMPLETION_PROMPT_READY, eventData);
            prompt = eventData.chat;
        }

        // Check if the generation was aborted during the event
        eventAbortController.signal.throwIfAborted();

        switch (api) {
            case 'kobold':
            case 'koboldhorde':
                if (kai_settings.preset_settings === 'gui') {
                    generateData = { prompt: prompt, gui_settings: true, max_length: amount_gen, max_context_length: max_context, api_server: kai_settings.api_server };
                } else {
                    const isHorde = api === 'koboldhorde';
                    const koboldSettings = koboldai_settings[koboldai_setting_names[kai_settings.preset_settings]];
                    generateData = getKoboldGenerationData(prompt.toString(), koboldSettings, amount_gen, max_context, isHorde, 'quiet');
                }
                TempResponseLength.restore(api);
                break;
            case 'novel': {
                const novelSettings = novelai_settings[novelai_setting_names[nai_settings.preset_settings_novel]];
                generateData = getNovelGenerationData(prompt, novelSettings, amount_gen, false, false, null, 'quiet');
                TempResponseLength.restore(api);
                break;
            }
            case 'textgenerationwebui':
                generateData = await getTextGenGenerationData(prompt, amount_gen, false, false, null, 'quiet');
                TempResponseLength.restore(api);
                break;
            case 'openai': {
                generateData = prompt;  // generateData is just the chat message object
                eventHook = TempResponseLength.setupEventHook(api);
            } break;
        }

        let data = {};

        if (api === 'koboldhorde') {
            data = await generateHorde(prompt.toString(), generateData, abortController.signal, false);
        } else if (api === 'openai') {
            data = await sendOpenAIRequest('quiet', generateData, abortController.signal, { jsonSchema });
        } else {
            const generateUrl = getGenerateUrl(api);
            const response = await fetch(generateUrl, {
                method: 'POST',
                headers: getRequestHeaders(),
                cache: 'no-cache',
                body: JSON.stringify(generateData),
                signal: abortController.signal,
            });

            if (!response.ok) {
                throw await response.json();
            }

            data = await response.json();
        }

        // should only happen for text completions
        // other frontend paths do not return data if calling the backend fails,
        // they throw things instead
        if (data.error) {
            throw new Error(data.response);
        }

        if (jsonSchema) {
            return extractJsonFromData(data, { mainApi: api, returnInvalidJson: jsonSchema.returnInvalid });
        }

        return data;
    } finally {
        eventSource.removeListener(event_types.GENERATION_STOPPED, abortHook);
        if (responseLengthCustomized && TempResponseLength.isCustomized()) {
            TempResponseLength.restore(api);
            TempResponseLength.removeEventHook(api, eventHook);
        }
    }
}

/**
 * Generates a message using the provided prompt.
 * If the prompt is an array of chat-style messages and not using chat completion, it will be converted to a text prompt.
 * @param {GenerateRawParams} params Parameters for generating a message
 * @returns {Promise<string>} Generated output: a cleaned-up message string when `jsonSchema` is not provided, or an extracted JSON string conforming to `jsonSchema` when it is.
 */
export async function generateRaw({ prompt = '', api = null, instructOverride = false, quietToLoud = false, systemPrompt = '', responseLength = null, trimNames = true, prefill = '', jsonSchema = null } = {}) {
    if (arguments.length > 0 && typeof arguments[0] !== 'object') {
        console.trace('generateRaw called with positional arguments. Please use an object instead.');
        [prompt, api, instructOverride, quietToLoud, systemPrompt, responseLength, trimNames, prefill, jsonSchema] = arguments;
    }

    const data = await generateRawData({ prompt, api, instructOverride, quietToLoud, systemPrompt, responseLength, prefill, jsonSchema });

    // JSON string (matching the provided schema) will already be extracted.
    if (jsonSchema) {
        return data;
    }

    // format result, exclude user prompt bias
    const message = cleanUpMessage({
        getMessage: extractMessageFromData(data, api),
        isImpersonate: false,
        isContinue: false,
        displayIncompleteSentences: true,
        includeUserPromptBias: false,
        trimNames: trimNames,
        trimWrongNames: trimNames,
    });

    if (!message) {
        throw new Error('No message generated');
    }

    return message;
}

class TempResponseLength {
    static #originalResponseLength = -1;
    static #lastApi = null;

    static isCustomized() {
        return this.#originalResponseLength > -1;
    }

    /**
     * Save the current response length for the specified API.
     * @param {string} api API identifier
     * @param {number} responseLength New response length
     */
    static save(api, responseLength) {
        if (api === 'openai') {
            this.#originalResponseLength = oai_settings.openai_max_tokens;
            oai_settings.openai_max_tokens = responseLength;
        } else {
            this.#originalResponseLength = amount_gen;
            setAmountGen(responseLength);
        }

        this.#lastApi = api;
        console.log('[TempResponseLength] Saved original response length:', TempResponseLength.#originalResponseLength);
    }

    /**
     * Restore the original response length for the specified API.
     * @param {string|null} api API identifier
     * @returns {void}
     */
    static restore(api) {
        if (this.#originalResponseLength === -1) {
            return;
        }
        if (!api && this.#lastApi) {
            api = this.#lastApi;
        }
        if (api === 'openai') {
            oai_settings.openai_max_tokens = this.#originalResponseLength;
        } else {
            setAmountGen(this.#originalResponseLength);
        }

        console.log('[TempResponseLength] Restored original response length:', this.#originalResponseLength);
        this.#originalResponseLength = -1;
        this.#lastApi = null;
    }

    /**
     * Sets up an event hook to restore the original response length when the event is emitted.
     * @param {string} api API identifier
     * @returns {function(): void} Event hook function
     */
    static setupEventHook(api) {
        const eventHook = () => {
            if (this.isCustomized()) {
                this.restore(api);
            }
        };

        switch (api) {
            case 'openai':
                eventSource.once(event_types.CHAT_COMPLETION_SETTINGS_READY, eventHook);
                break;
            default:
                eventSource.once(event_types.GENERATE_AFTER_DATA, eventHook);
                break;
        }

        return eventHook;
    }

    /**
     * Removes the event hook for the specified API.
     * @param {string} api API identifier
     * @param {function(): void} eventHook Previously set up event hook
     */
    static removeEventHook(api, eventHook) {
        switch (api) {
            case 'openai':
                eventSource.removeListener(event_types.CHAT_COMPLETION_SETTINGS_READY, eventHook);
                break;
            default:
                eventSource.removeListener(event_types.GENERATE_AFTER_DATA, eventHook);
                break;
        }
    }
}

/**
 * Removes last message from the chat DOM.
 * @returns {Promise<void>} Resolves when the message is removed.
 */
export function removeLastMessage() {
    return new Promise((resolve) => {
        const lastMes = chatElement.children('.mes').last();
        if (lastMes.length === 0) {
            return resolve();
        }
        lastMes.hide(animation_duration, function () {
            $(this).remove();
            resolve();
        });
    });
}

/**
 * @typedef {object} JsonSchema
 * @property {string} name Name of the schema.
 * @property {object} value JSON schema value.
 * @property {string} [description] Description of the schema.
 * @property {boolean} [strict] If true, the schema will be used in strict mode, meaning that only the fields defined in the schema will be allowed.
 * @property {boolean} [returnInvalid] If true, a string that can't be parsed as a JSON will be returned as is, instead of an empty object.
 *
 * @typedef {object} GenerateOptions
 * @property {boolean} [automatic_trigger] If the generation was triggered automatically (e.g. group auto mode).
 * @property {boolean} [force_name2] If a char name should be forced to add to the prompt's last line (Text Completion, non-Instruct only).
 * @property {string} [quiet_prompt] A system instruction to use for the quiet prompt.
 * @property {boolean} [quietToLoud] Whether the system instruction should be sent in background (quiet) or a foreground (loud) mode.
 * @property {boolean} [skipWIAN] Skip adding World Info and Author's Note to the prompt.
 * @property {string} [force_avatar] Force character (by avatar) to use for the generation. Only works in groups.
 * @property {AbortSignal} [signal] Abort signal to cancel the generation. If not provided, will create a new AbortController.
 * @property {string} [quietImage] Image URL to use for the quiet prompt (defaults to empty string)
 * @property {string} [quietName] Name to use for the quiet prompt (defaults to "System:")
 * @property {number} [depth] Recursion depth for the generation. Used to prevent infinite loops in tool calls.
 * @property {JsonSchema} [jsonSchema] JSON schema to use for the structured generation. Usually requires a special instruction.
 */

/**
 * Assembles the full prompt that would be sent for the next generation, without sending it - a dry run of
 * Generate() that captures whichever combine-prompt event fires for the active backend, then displays it.
 */
export async function previewFullPrompt() {
    if (is_send_press) {
        toastr.warning(t`Cannot preview the prompt while a generation is in progress.`);
        return;
    }

    if (getSelectionState().type === 'none') {
        toastr.warning(t`Select a character or group first.`);
        return;
    }

    // Generate() can recurse internally (e.g. re-running once WI activation changes the budget), firing the
    // combine-prompt event more than once per dry run - keep overwriting so we end up with the last (final)
    // one once Generate() actually returns, rather than an earlier, possibly-incomplete recursive pass.
    let captured = null;
    const onChatCompletionReady = (data) => { if (data.dryRun) captured = { chatCompletion: data.chat }; };
    const onCombinePrompts = (data) => { if (data.dryRun) captured = { textCompletion: data.prompt }; };

    eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, onChatCompletionReady);
    eventSource.on(event_types.GENERATE_AFTER_COMBINE_PROMPTS, onCombinePrompts);

    try {
        await Generate('normal', {}, true);

        if (!captured) {
            toastr.error(t`Could not assemble the prompt.`);
            return;
        }

        const text = captured.chatCompletion
            ? captured.chatCompletion.map(m => `${m.role}:\n${m.content}`).join('\n\n')
            : captured.textCompletion;

        const pre = $('<pre class="justifyLeft" style="white-space: pre-wrap; word-break: break-word;"></pre>').text(text);
        await callGenericPopup(pre, POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true });
    } finally {
        eventSource.removeListener(event_types.CHAT_COMPLETION_PROMPT_READY, onChatCompletionReady);
        eventSource.removeListener(event_types.GENERATE_AFTER_COMBINE_PROMPTS, onCombinePrompts);
    }
}

/**
 * Injects extension prompts into chat messages.
 * @param {object[]} messages Array of chat messages
 * @param {boolean} isContinue Whether the generation is a continuation. If true, the extension prompts of depth 0 are injected at position 1.
 * @returns {Promise<number[]>} Array of indices where the extension prompts were injected
 */
export async function doChatInject(messages, isContinue) {
    const injectedMessages = [];
    let totalInsertedMessages = 0;
    messages.reverse();

    const maxDepth = getExtensionPromptMaxDepth();
    for (let i = 0; i <= maxDepth; i++) {
        // Order of priority (most important go lower)
        const roles = [extension_prompt_roles.SYSTEM, extension_prompt_roles.USER, extension_prompt_roles.ASSISTANT];
        const names = {
            [extension_prompt_roles.SYSTEM]: '',
            [extension_prompt_roles.USER]: name1,
            [extension_prompt_roles.ASSISTANT]: name2,
        };
        const roleMessages = [];
        const separator = '\n';
        const wrap = false;

        for (const role of roles) {
            const extensionPrompt = String(await getExtensionPrompt(extension_prompt_types.IN_CHAT, i, separator, role, wrap)).trimStart();
            const isNarrator = role === extension_prompt_roles.SYSTEM;
            const isUser = role === extension_prompt_roles.USER;
            const name = names[role];

            if (extensionPrompt) {
                roleMessages.push({
                    name: name,
                    is_user: isUser,
                    mes: extensionPrompt,
                    extra: {
                        type: isNarrator ? system_message_types.NARRATOR : null,
                    },
                });
            }
        }

        if (roleMessages.length) {
            const depth = isContinue && i === 0 ? 1 : i;
            const injectIdx = Math.min(depth + totalInsertedMessages, messages.length);
            messages.splice(injectIdx, 0, ...roleMessages);
            totalInsertedMessages += roleMessages.length;
            injectedMessages.push(...roleMessages);
        }
    }

    const injectedIndices = injectedMessages.map(msg => messages.indexOf(msg));
    messages.reverse();
    return injectedIndices;
}

export function flushWIInjections() {
    const depthPrefix = inject_ids.CUSTOM_WI_DEPTH;
    const outletPrefix = inject_ids.CUSTOM_WI_OUTLET('');

    for (const key of Object.keys(extension_prompts)) {
        if (key.startsWith(depthPrefix) || key.startsWith(outletPrefix)) {
            delete extension_prompts[key];
        }
    }
}

/**
 * Unblocks the UI after a generation is complete.
 * @param {string} [type] Generation type (optional)
 */
export function unblockGeneration(type) {
    // Don't unblock if a parallel stream is still running
    if (type === 'quiet' && streamingProcessor && !streamingProcessor.isFinished) {
        return;
    }

    is_send_press = false;
    activateSendButtons();
    setGenerationProgress(0);
    flushEphemeralStoppingStrings();
    flushWIInjections();
}

export function getNextMessageId(type) {
    return type == 'swipe' ? chat.length - 1 : chat.length;
}

/**
 * Determines if the message should be auto-continued.
 * @param {string} messageChunk Current message chunk
 * @param {boolean} isImpersonate Is the user impersonation
 * @returns {boolean} Whether the message should be auto-continued
 */
export function shouldAutoContinue(messageChunk, isImpersonate) {
    if (!power_user.auto_continue.enabled) {
        console.debug('Auto-continue is disabled by user.');
        return false;
    }

    if (typeof messageChunk !== 'string') {
        console.debug('Not triggering auto-continue because message chunk is not a string');
        return false;
    }

    if (isImpersonate) {
        console.log('Continue for impersonation is not implemented yet');
        return false;
    }

    if (is_send_press) {
        console.debug('Auto-continue is disabled because a message is currently being sent.');
        return false;
    }

    if (abortController && abortController.signal.aborted) {
        console.debug('Auto-continue is not triggered because the generation was stopped.');
        return false;
    }

    if (power_user.auto_continue.target_length <= 0) {
        console.log('Auto-continue target length is 0, not triggering auto-continue');
        return false;
    }

    if (main_api === 'openai' && !power_user.auto_continue.allow_chat_completions) {
        console.log('Auto-continue for OpenAI is disabled by user.');
        return false;
    }

    const textareaText = String($('#send_textarea').val());
    const USABLE_LENGTH = 5;

    if (textareaText.length > 0) {
        console.log('Not triggering auto-continue because user input is not empty');
        return false;
    }

    if (messageChunk.trim().length > USABLE_LENGTH && chat.length) {
        const lastMessage = chat[chat.length - 1];
        const messageLength = getTokenCount(lastMessage.mes);
        const shouldAutoContinue = messageLength < power_user.auto_continue.target_length;

        if (shouldAutoContinue) {
            console.log(`Triggering auto-continue. Message tokens: ${messageLength}. Target tokens: ${power_user.auto_continue.target_length}. Message chunk: ${messageChunk}`);
            return true;
        } else {
            console.log(`Not triggering auto-continue. Message tokens: ${messageLength}. Target tokens: ${power_user.auto_continue.target_length}`);
            return false;
        }
    } else {
        console.log('Last generated chunk was empty, not triggering auto-continue');
        return false;
    }
}

/**
 * Triggers auto-continue if the message meets the criteria.
 * @param {string} messageChunk Current message chunk
 * @param {boolean} isImpersonate Is the user impersonation
 */
export function triggerAutoContinue(messageChunk, isImpersonate) {
    if (selected_group) {
        console.debug('Auto-continue is disabled for group chat');
        return;
    }

    if (shouldAutoContinue(messageChunk, isImpersonate)) {
        $('#option_continue').trigger('click');
    }
}

export function getBiasStrings(textareaText, type) {
    if (type == 'impersonate' || type == 'continue') {
        return { messageBias: '', promptBias: '', isUserPromptBias: false };
    }

    let promptBias = '';
    let messageBias = extractMessageBias(textareaText);

    // If user input is not provided, retrieve the bias of the most recent relevant message
    if (!textareaText) {
        for (let i = chat.length - 1; i >= 0; i--) {
            const mes = chat[i];
            if (type === 'swipe' && chat.length - 1 === i) {
                continue;
            }
            if (mes && (mes.is_user || mes.is_system || mes.extra?.type === system_message_types.NARRATOR)) {
                if (mes.extra?.bias?.trim()?.length > 0) {
                    promptBias = mes.extra.bias;
                }
                break;
            }
        }
    }

    promptBias = messageBias || promptBias || power_user.user_prompt_bias || '';
    const isUserPromptBias = promptBias === power_user.user_prompt_bias;

    // Substitute params for everything
    messageBias = substituteParams(messageBias);
    promptBias = substituteParams(promptBias);

    return { messageBias, promptBias, isUserPromptBias };
}

/**
 * @param {Object} chatItem Message history item.
 * @param {boolean} isInstruct Whether instruct mode is enabled.
 * @param {boolean|number} forceOutputSequence Whether to force the first/last output sequence for instruct mode.
 */
export function formatMessageHistoryItem(chatItem, isInstruct, forceOutputSequence) {
    const isNarratorType = chatItem?.extra?.type === system_message_types.NARRATOR;
    const characterName = chatItem?.name ? chatItem.name : name2;
    const itemName = chatItem.is_user ? chatItem.name : characterName;
    const shouldPrependName = !isNarratorType;

    // If this symbol flag is set, completely ignore the message.
    // This can be used to hide messages without affecting the number of messages in the chat.
    if (chatItem.extra?.[IGNORE_SYMBOL]) {
        return '';
    }

    // Don't include a name if it's empty
    let textResult = chatItem?.name && shouldPrependName ? `${itemName}: ${chatItem.mes}\n` : `${chatItem.mes}\n`;

    if (isInstruct) {
        textResult = formatInstructModeChat(itemName, chatItem.mes, chatItem.is_user, isNarratorType, chatItem.force_avatar, name1, name2, forceOutputSequence);
    }

    return textResult;
}

/**
 * Removes all {{macros}} from a string.
 * @param {string} str String to remove macros from.
 * @returns {string} String with macros removed.
 */
export function removeMacros(str) {
    return (str ?? '').replace(/\{\{[\s\S]*?\}\}/gm, '').trim();
}

/**
 * Inserts a user message into the chat history.
 * @param {string} messageText Message text.
 * @param {string} messageBias Message bias.
 * @param {number} [insertAt] Optional index to insert the message at.
 * @param {boolean} [compact] Send as a compact display message.
 * @param {string} [name] Name of the user sending the message. Defaults to name1.
 * @param {string} [avatar] Avatar of the user sending the message. Defaults to user_avatar.
 * @param {boolean} [skipTreePersistence] When true, skip this function's own tree-store
 *  append/graft call (chatOpAppend()/chatOpGraft(), public/scripts/chat-store.js). Set by
 *  Generate() (public/script.js) when a raw-action generate call is about to independently
 *  persist this SAME message server-side via its own appendMessages() call
 *  (src/message-tree-db.js) - see Generate()'s own `willUseRawAction` local for the full rationale.
 * @returns {Promise<any>} A promise that resolves to the message when it is inserted.
 */
export async function sendMessageAsUser(messageText, messageBias, insertAt = null, compact = false, name = name1, avatar = user_avatar, skipTreePersistence = false) {
    messageText = getRegexedString(messageText, regex_placement.USER_INPUT);

    const message = {
        name: name,
        is_user: true,
        is_system: false,
        send_date: getMessageTimeStamp(),
        mes: substituteParams(messageText),
        // Identity uses the avatar id, not the display name, since the name drifts on rename.
        persona: avatar,
        extra: {
            isSmallSys: compact,
        },
    };

    if (power_user.message_token_count_enabled) {
        message.extra.token_count = await getTokenCountAsync(message.mes, 0);
    }

    // Lock user avatar to a persona.
    if (personaStore.has(avatar)) {
        message.force_avatar = getThumbnailUrl('persona', avatar);
    }

    if (messageBias) {
        message.extra.bias = messageBias;
        message.mes = removeMacros(message.mes);
    }

    await populateFileAttachment(message);
    statMesProcess(message, 'user', getCurrentCharacter(), '');
    // A raw-action send asks the server to store this message and sends this ref with it, so the
    // server's answer can say which node it was stored at.
    setStoreRef(message, uuidv4());

    chat_metadata.tainted = true;

    if (typeof insertAt === 'number' && insertAt >= 0 && insertAt <= chat.length) {
        chat.splice(insertAt, 0, message);
        // A mid-chain insert is a graft (the new node lands between the message that used to precede
        // this slot and the one that used to follow it) — the diff engine can't see this correctly,
        // since every message after the insertion point keeps its own unchanged node_id.
        // See this function's own `skipTreePersistence` doc comment - not reachable with
        // `skipTreePersistence: true` from Generate() today (it never passes `insertAt`), kept
        // here purely so the parameter's contract holds for any future/other caller.
        if (!skipTreePersistence) {
            await chatOpGraft(insertAt).catch(error =>
                console.error('Could not save the inserted message:', error));
        }
        await eventSource.emit(event_types.MESSAGE_SENT, insertAt);
        await reloadCurrentChat();
        await eventSource.emit(event_types.USER_MESSAGE_RENDERED, insertAt);
    } else {
        chat.push(message);
        const chat_id = (chat.length - 1);

        addOneMessage(message);
        await eventSource.emit(event_types.MESSAGE_SENT, chat_id);
        await eventSource.emit(event_types.USER_MESSAGE_RENDERED, chat_id);

        // Awaited, not fire-and-forget: otherwise the next save can miss the isChatSaving window and drop the AI message.
        // See skipTreePersistence's own doc comment above.
        if (!skipTreePersistence) {
            await chatOpAppend(chat_id).catch(error =>
                console.error('Could not save the new user message:', error));
        }
    }

    return message;
}

/**
 * Gets the maximum context token limit (the full context window size before subtracting response length).
 * @returns {number} The maximum context token limit for the current API.
 */
export function getMaxContextTokens() {
    if (main_api == 'kobold' || main_api == 'koboldhorde' || main_api == 'textgenerationwebui') {
        return max_context;
    }
    if (main_api == 'novel') {
        let this_max_context = Number(max_context);
        if (nai_settings.model_novel.includes('clio')) {
            this_max_context = Math.min(max_context, 8192);
        }
        if (nai_settings.model_novel.includes('kayra')) {
            this_max_context = Math.min(max_context, 8192);

            const subscriptionLimit = getKayraMaxContextTokens();
            if (typeof subscriptionLimit === 'number' && this_max_context > subscriptionLimit) {
                this_max_context = subscriptionLimit;
                console.log(`NovelAI subscription limit reached. Max context size is now ${this_max_context}`);
            }
        }
        if (nai_settings.model_novel.includes('erato')) {
            // subscriber limits coming soon
            this_max_context = Math.min(max_context, 8192);

            // Added special tokens and whatnot
            this_max_context -= 10;
        }
        return this_max_context;
    }
    if (main_api == 'openai') {
        return oai_settings.openai_max_context;
    }
    return 1487;
}

/**
 * Gets the maximum response token limit (the max generation/reply length).
 * @returns {number} The maximum response token limit for the current API.
 */
export function getMaxResponseTokens() {
    if (main_api == 'kobold' || main_api == 'koboldhorde' || main_api == 'textgenerationwebui' || main_api == 'novel') {
        return amount_gen;
    }
    if (main_api == 'openai') {
        return oai_settings.openai_max_tokens;
    }
    return 0;
}

/**
 * Gets the maximum usable prompt size for the current API.
 * @param {number|null} overrideResponseLength Optional override for the response length.
 * @returns {number} Maximum usable prompt size.
 */
export function getMaxPromptTokens(overrideResponseLength = null) {
    if (typeof overrideResponseLength !== 'number' || overrideResponseLength <= 0 || isNaN(overrideResponseLength)) {
        overrideResponseLength = null;
    }

    return getMaxContextTokens() - (overrideResponseLength || getMaxResponseTokens());
}

export function parseTokenCounts(counts, thisPromptBits) {
    /**
     * @param {any[]} numbers
     */
    function getSum(...numbers) {
        return numbers.map(x => Number(x)).filter(x => !Number.isNaN(x)).reduce((acc, val) => acc + val, 0);
    }
    const total = getSum(Object.values(counts));

    thisPromptBits.push({
        oaiStartTokens: (counts?.start + counts?.controlPrompts) || 0,
        oaiPromptTokens: getSum(counts?.prompt, counts?.charDescription, counts?.charPersonality, counts?.scenario) || 0,
        oaiBiasTokens: counts?.bias || 0,
        oaiNudgeTokens: counts?.nudge || 0,
        oaiJailbreakTokens: counts?.jailbreak || 0,
        oaiImpersonateTokens: counts?.impersonate || 0,
        oaiExamplesTokens: (counts?.dialogueExamples + counts?.examples) || 0,
        oaiConversationTokens: (counts?.conversation + counts?.chatHistory) || 0,
        oaiNsfwTokens: counts?.nsfw || 0,
        oaiMainTokens: counts?.main || 0,
        oaiTotalTokens: total,
    });
}

export function addChatsPreamble(mesSendString) {
    return main_api === 'novel'
        ? substituteParams(nai_settings.preamble) + '\n' + mesSendString
        : mesSendString;
}

export function addChatsSeparator(mesSendString) {
    if (power_user.context.chat_start) {
        return substituteParams(power_user.context.chat_start + '\n') + mesSendString;
    } else {
        return mesSendString;
    }
}

/**
 * Duplicates a character.
 * @param {object} [options={}] - Options
 * @param {string} [options.avatar] - Avatar key of the character to duplicate. Uses current character if not provided.
 * @param {boolean} [options.silent=false] - Whether to skip the confirmation popup
 * @returns {Promise<string>} The avatar key of the duplicated character, or empty string if cancelled/failed
 */
export async function duplicateCharacter({ avatar = null, silent = false } = {}) {
    // Determine the character to duplicate
    let targetAvatar;
    if (avatar) {
        // The server answers for a character the page doesn't hold, and says when there is none.
        targetAvatar = avatar;
    } else {
        if (!getCurrentCharacter()) {
            toastr.warning(t`You must first select a character to duplicate!`);
            return '';
        }
        targetAvatar = getCurrentCharacter().avatar;
    }

    // Show confirmation unless silent
    if (!silent) {
        const confirmMessage = $(await renderTemplateAsync('duplicateConfirm'));
        const confirm = await callGenericPopup(confirmMessage, POPUP_TYPE.CONFIRM);

        if (!confirm) {
            console.log('User cancelled duplication');
            return '';
        }
    }

    const body = { avatar_url: targetAvatar };
    const response = await fetch('/api/characters/duplicate', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        toastr.error(t`Failed to duplicate character`);
        return '';
    }

    toastr.success(t`Character Duplicated`);
    const data = await response.json();
    await eventSource.emit(event_types.CHARACTER_DUPLICATED, { oldAvatar: targetAvatar, newAvatar: data.path });
    await getCharacters({ silent: true, skipPrint: true });
    charactersStore.reportCreated(data.path);
    // The duplicate's sorted position isn't knowable client-side (sort can be by name/date/fav/random/search) -
    // re-fetch just the current page rather than guess where to insert a new row.
    if (!refreshCharacterListCurrentPage()) {
        await printCharacters(false);
    }

    return data.path;
}

export function setInContextMessages(msgInContextCount, type) {
    chatElement.find('.mes').removeClass('lastInContext');

    if (type === 'swipe' || type === 'regenerate' || type === 'continue') {
        msgInContextCount++;
    }

    const lastMessageBlock = chatElement.find('.mes:not([is_system="true"]), .mes.toolCall').eq(-msgInContextCount);
    lastMessageBlock.addClass('lastInContext');

    if (lastMessageBlock.length === 0) {
        const firstMessageId = getFirstDisplayedMessageId();
        chatElement.find(`.mes[mesid="${firstMessageId}"]`).addClass('lastInContext');
    }

    // Update last id to chat. No metadata save on purpose, gets hopefully saved via another call
    const lastMessageId = Math.max(0, chat.length - msgInContextCount);
    chat_metadata.lastInContextMessageId = lastMessageId;
}

/**
 * @typedef {object} AdditionalRequestOptions
 * @property {JsonSchema} [jsonSchema]
 */

/**
 * Chunk (c) of the tool-calling raw-action cutover: resolves a chain of `pending_tool_calls`
 * hand-offs from the raw-action chat-completion route (src/endpoints/backends/chat-completions.js,
 * `runServerToolRounds()`'s own doc comment) by actually invoking the named CLIENT tools (registered
 * via `ToolManager.registerFunctionTool()`, public/scripts/tool-calling.js - the ones the server
 * genuinely cannot execute itself: arbitrary client JS callbacks, DOM access, extension state) and
 * submitting their results back via `type: 'tool_result'` follow-up requests, resuming the server's
 * own loop each time.
 *
 * This is a SMALL, LOCAL loop - not a recursive `Generate('normal', {...depth})` call like the
 * legacy (non-raw-action) tool-calling path (see the `canPerformToolCalls` block inside
 * `finishGenerating()`'s `onSuccess()`) - because recursing through the whole `Generate()` function
 * again would re-trigger legacy assembly checks/UI side effects that don't belong mid-tool-loop.
 * Every round here is a real raw-action request; there is no fallback to legacy client-side prompt
 * assembly at any point.
 *
 * TERMINATION: bounded by `ToolManager.RECURSE_LIMIT` (5, the same numeric bound the legacy
 * client-side tool-calling loop and the server's own `SERVER_TOOL_ROUND_LIMIT` use) - the `for` loop
 * below runs at most that many iterations, and each iteration makes exactly one `fetch()` call (no
 * further recursion), so the worst case is a bounded, finite number of network round-trips, never an
 * infinite loop. If `data.pending_tool_calls` is STILL set after the loop exits (bound exceeded, not
 * a normal exit), a real `Error` is thrown - mirroring the server's own "exceeded round limit" 500 -
 * rather than returning a malformed `pending_tool_calls`-shaped object to `onSuccess()` (which
 * expects a normal `{choices: [...]}` result and would otherwise crash confusingly on
 * `extractMessageFromData()`).
 *
 * STEALTH TOOLS - FIXED (this task; formerly a documented KNOWN LIMITATION here). Precise legacy
 * semantics, verified by reading `ToolManager.invokeFunctionTools()`/`finishGenerating()`'s
 * `onSuccess()` in full (public/scripts/tool-calling.js, this file): `stealth` is a per-TOOL
 * registration property (`ToolManager.registerFunctionTool()`'s own `stealth` param - never
 * per-call), and `shouldStopGeneration = (!invocationResult.invocations.length && shouldDeleteMessage)
 * || invocationResult.stealthCalls.length` - the `||` means ANY stealth call present in a round stops
 * generation entirely and UNCONDITIONALLY discards the whole round (even an already-succeeded
 * non-stealth invocation in the SAME round never gets `saveFunctionToolInvocations()`'d), not merely
 * "every call in the round was stealth" (the narrower case this doc comment used to describe).
 *
 * This could not be replicated here before this task because, by the time the client saw a
 * `pending_tool_calls` hand-off, the server had ALREADY persisted the pending tool-call node with no
 * way to know a tool is "stealth" (a client-only registration flag, never sent to the server). Fixed
 * by teaching the server about it in advance: `Generate()`'s raw-action gate now also sends a
 * `stealth_tool_names` list (the subset of `client_tools` names `ToolManager.isStealthTool()` flags -
 * see that gate's own `stealthToolNamesPayload` doc comment for why this is a separate list rather
 * than an extra key smuggled into the OpenAI-standard `client_tools` schema entries themselves) and
 * `runServerToolRounds()` (src/endpoints/backends/chat-completions.js) checks it BEFORE persisting
 * anything: if ANY call in a round is in that set, the round returns `{ok: 'aborted'}` - no tool
 * invoked, no tree node written, no hand-off - so this function typically never even sees such a round
 * (it never reaches `pending_tool_calls` at all for a first-round abort - see `finishGenerating()`'s
 * own `isStreamWithToolCallAborted`/non-streaming `data.aborted` checks, which intercept it earlier).
 * The one place THIS function still has to care is a LATER round of its own loop (this function's own
 * `tool_result` follow-up can just as easily trigger a fresh abort) - handled by the explicit
 * `data?.aborted` check inside the loop below, which stops iterating and returns the `{aborted: true}`
 * body straight back to the caller, exactly like a first-round abort.
 *
 * DOCUMENTED, DELIBERATE NARROWING (not a parity gap - see `runServerToolRounds()`'s own doc comment,
 * step 2b, for the full reasoning): unlike legacy (which invokes every non-stealth call first, real
 * side effects happen, and only THEN discards the round), the server here never invokes anything once
 * a stealth name is detected in a round - it does not run a real server-native tool's `invoke()`
 * purely to throw the result away. This is exact, verified parity for a stealth call mixed with other
 * CLIENT-ONLY calls (stealth or not) - legacy has no equivalent concept of "server-native" tools at
 * all, so a stealth call mixed with a genuine server-native call is the one case with no legacy
 * precedent to match; the "never invoke, just abort" behavior was chosen there as the safer,
 * user-visibly-identical ("nothing persisted, generation stops") simplification. Also documented,
 * narrower-than-legacy on the CLIENT side: any real narrative text the model generated in the SAME
 * round as the stealth call is not preserved either (the in-progress placeholder message is deleted
 * unconditionally on abort - see `isStreamWithToolCallAborted` above - whereas legacy keeps
 * already-persisted visible text and only discards the tool-invocation record).
 *
 * NO DOUBLE-FIRE OF PERSISTENCE: this function never itself writes to the chat tree - every write
 * (the in-flight tool-invocation node, the in-place edit resolving it, the eventual final reply) is
 * performed SERVER-side, exactly once per real fact, by the same code chunk (b) already uses
 * (`runServerToolRounds()`/`resolvePendingToolResults()`/`persistAssistantReply()`). This function
 * only invokes the client's own tool callback (a pure computation from the caller's point of view -
 * `ToolManager.invokeFunctionTool()` has no chat-tree side effect) and forwards its result; it never
 * calls `ToolManager.saveFunctionToolInvocations()` (that would create a SECOND, redundant
 * client-side tree write for a turn the server already persisted).
 * @param {object} initialData The raw-action route's response body, already known to carry a
 *   non-empty `pending_tool_calls` array (`[{node_id, tool_call_id, name, arguments}, ...]`).
 * @param {object} rawAction The SAME raw-action object originally sent (`character_avatar`/
 *   `group_id`/`owner_id` are read off it; `node_id`/`type`/`user_message` are not used here - each
 *   round addresses the pending node named in that round's own `pending_tool_calls` entries instead).
 * @returns {Promise<object>} The final response body once the server stops returning
 *   `pending_tool_calls` (a normal `{choices: [...]}` result, or an `{error: true, ...}` body if the
 *   server rejected the follow-up for some other reason - both handled identically to any other
 *   `sendGenerationRequest()` result by the caller).
 * @throws {Error} If the response isn't ok, or if the bound above is exceeded without ever reaching a
 *   non-`pending_tool_calls` response.
 */
export async function resolveClientToolHandoffLoop(initialData, rawAction) {
    let data = initialData;

    for (let round = 0; round < ToolManager.RECURSE_LIMIT && Array.isArray(data?.pending_tool_calls) && data.pending_tool_calls.length; round++) {
        const pending = data.pending_tool_calls;
        // Chunk (b)/(c)'s single-node-per-round persistence (see `runServerToolRounds()`'s own doc
        // comment) means every entry in one `pending_tool_calls` array shares the same `node_id`.
        const nodeId = pending[0]?.node_id;

        // Reuse the EXISTING client tool-invocation machinery (toasts, error handling, stealth
        // handling) rather than hand-rolling it - `ToolManager.invokeFunctionTools()` just needs a
        // synthetic OpenAI-Chat-Completions-shaped `data` object to read `tool_calls` off of.
        const syntheticData = {
            choices: [{
                index: 0,
                message: {
                    tool_calls: pending.map(call => ({
                        id: call.tool_call_id,
                        function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
                    })),
                },
            }],
        };
        const invocationResult = await ToolManager.invokeFunctionTools(syntheticData);
        if (Array.isArray(invocationResult.errors) && invocationResult.errors.length) {
            ToolManager.showToolCallError(invocationResult.errors);
        }
        const invocationsById = new Map(invocationResult.invocations.map(invocation => [invocation.id, invocation]));

        // Every pending call gets a real tool_results entry regardless of `stealthCalls`/an unknown
        // name (`ToolManager.invokeFunctionTool()` itself already turns "no such tool registered"
        // into an Error result, not a thrown exception) - the server-side pending invocation MUST be
        // resolved one way or another, or the round can never advance.
        const tool_results = pending.map(call => {
            const invocation = invocationsById.get(call.tool_call_id);
            return {
                id: call.tool_call_id,
                result: invocation ? (typeof invocation.result === 'string' ? invocation.result : String(invocation.result)) : 'This tool call could not be resolved on the client (no invocation result was produced).',
                error: invocation ? !!invocation.error : true,
            };
        });

        // Re-advertise the SAME client tools - the server never remembers a live client-only tool
        // list across requests (REST is stateless; the tree is the only durable state) - see
        // `buildRawActionChatCompletionRequest()`'s own `clientToolSchemas` doc comment. THIS TASK:
        // `stealth_tool_names` is re-derived and re-sent alongside them every round for the identical
        // reason - a LATER round's own backend response can call a (possibly different) stealth tool
        // just as easily as the first one could, and the server has no memory of the first round's
        // advertised set either. See `Generate()`'s own identical `stealthToolNamesPayload`
        // computation/doc comment (this function's own doc comment references it) for the full
        // rationale - duplicated here rather than shared, since `registerFunctionToolsOpenAI()` itself
        // must NOT gain a `stealth_tool_names` field (it also builds the LEGACY path's real backend
        // request body via the SAME method - see that method's own callers - so anything it adds would
        // leak a non-standard field straight into an actual provider request).
        const toolsHolder = {};
        await ToolManager.registerFunctionToolsOpenAI(toolsHolder);
        const stealthNames = (toolsHolder.tools ?? [])
            .map(tool => tool?.function?.name)
            .filter(name => typeof name === 'string' && ToolManager.isStealthTool(name));

        const response = await fetch('/api/backends/chat-completions/generate', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                character_avatar: rawAction.character_avatar,
                group_id: rawAction.group_id,
                owner_id: rawAction.owner_id,
                node_id: nodeId,
                type: 'tool_result',
                tool_results,
                client_tools: toolsHolder.tools,
                stealth_tool_names: stealthNames.length ? stealthNames : undefined,
            }),
        });

        if (!response.ok) {
            throw await response.json();
        }
        data = await response.json();

        // THIS TASK (stealth-tool parity) - a LATER round (this `tool_result` follow-up's own backend
        // response) can hit a stealth call too, exactly like the very first round can (see
        // `finishGenerating()`'s own `isStreamWithToolCallAborted`/non-streaming `data.aborted` checks,
        // which only ever see the FIRST round - this loop's own subsequent rounds need the identical
        // check inline). The server already decided not to persist/hand off anything for this round
        // (`{aborted: true}`, no `.pending_tool_calls`) - stop looping (the `for` condition below would
        // stop anyway, since `data.pending_tool_calls` is absent) and let the caller's own `.aborted`
        // check (both call sites in `finishGenerating()`) handle unblocking generation, exactly the
        // same way it would have for a first-round abort.
        if (data?.aborted) {
            return data;
        }
    }

    if (Array.isArray(data?.pending_tool_calls) && data.pending_tool_calls.length) {
        throw new Error('Exceeded the maximum number of client tool-call rounds without receiving a final reply.');
    }

    return data;
}

/**
 * Sends a non-streaming request to the API.
 * @param {string} type Generation type
 * @param {object} data Generation data
 * @param {AdditionalRequestOptions} [options] Additional options for the generation request
 * @returns {Promise<object>} Response data from the API
 * @throws {Error|object}
 */
export async function sendGenerationRequest(type, data, options = {}) {
    if (main_api === 'openai') {
        // `data.rawAction`, when set, is the raw-action chat-completion cutover object built in Generate()'s
        // `case 'openai':` block - forwarded through as an option so sendOpenAIRequest() can detect and use it
        // (see that function's own "Raw-action chat-completion cutover" comment). `undefined` for every other
        // (non-cutover) call, exactly like today - a no-op for sendOpenAIRequest() in that case.
        return await sendOpenAIRequest(type, data.prompt, abortController.signal, { ...options, rawAction: data.rawAction });
    }

    if (main_api === 'koboldhorde') {
        // Real raw-action cutover (see JUDGMENT CALL #7 above `let rawActionGenerateData;`, and
        // src/endpoints/horde.js's own `buildRawActionHordePayload()` doc comment for the full
        // architecture) - `data.owner_id` is only ever present on a real raw-action payload (see
        // `rawActionGenerateData`'s own construction), matching the exact same detection kobold.js's
        // own raw-action `/generate` route uses server-side. generateHordeRawAction() is a dedicated
        // function, not a branch inside generateHorde() itself, because the real request SHAPE
        // differs (no client-resolved `prompt`/`params` at all - the server resolves those) even
        // though the submit-then-poll mechanics are shared (see that function's own doc comment).
        if (data.owner_id) {
            return await generateHordeRawAction(data, abortController.signal, true);
        }
        return await generateHorde(data.prompt, data, abortController.signal, true);
    }

    const response = await fetch(getGenerateUrl(main_api), {
        method: 'POST',
        headers: getRequestHeaders(),
        cache: 'no-cache',
        body: JSON.stringify(data),
        signal: abortController.signal,
    });

    // An error answer after the server stored the user message names it in this header, whatever its body.
    reportStoredHeader(response);
    if (!response.ok) {
        const error = await response.json();
        adoptStored(error?.stored);
        throw error;
    }

    const answer = await response.json();
    adoptStored(answer?.stored);
    return answer;
}

/**
 * Sends a streaming request to the API.
 * @param {string} type Generation type
 * @param {object} data Generation data
 * @param {AdditionalRequestOptions} [options] Additional options for the generation request
 * @returns {Promise<any>} Streaming generator
 */
export async function sendStreamingRequest(type, data, options = {}) {
    if (abortController?.signal?.aborted) {
        throw new Error('Generation was aborted.');
    }

    switch (main_api) {
        case 'openai':
            // See sendGenerationRequest()'s identical comment above `data.rawAction` - same forwarding here for the
            // streaming call path.
            return await sendOpenAIRequest(type, data.prompt, streamingProcessor.abortController.signal, { ...options, rawAction: data.rawAction });
        case 'textgenerationwebui':
            return await generateTextGenWithStreaming(data, streamingProcessor.abortController.signal);
        case 'novel':
            return await generateNovelWithStreaming(data, streamingProcessor.abortController.signal);
        case 'kobold':
            return await generateKoboldWithStreaming(data, streamingProcessor.abortController.signal);
        default:
            throw new Error('Streaming is enabled, but the current API does not support streaming.');
    }
}

/**
 * Gets the generation endpoint URL for the specified API.
 * @param {string} api API name
 * @returns {string} Generation URL
 * @throws {Error} If the API is unknown
 */
export function getGenerateUrl(api) {
    switch (api) {
        case 'kobold':
            return '/api/backends/kobold/generate';
        case 'koboldhorde':
            return '/api/backends/koboldhorde/generate';
        case 'textgenerationwebui':
            return '/api/backends/text-completions/generate';
        case 'novel':
            return '/api/novelai/generate';
        default:
            throw new Error(`Unknown API: ${api}`);
    }
}

export function extractTitleFromData(data) {
    if (main_api == 'koboldhorde') {
        return data.workerName;
    }

    return undefined;
}

/**
 * Extracts the image from the response data.
 * @param {object} data Response data
 * @param {object} [options] Extraction options
 * @param {string} [options.mainApi] Main API to use
 * @param {string} [options.chatCompletionSource] Chat completion source
 * @returns {string[]} Extracted images or empty array
 */
export function extractImagesFromData(data, { mainApi = null, chatCompletionSource = null } = {}) {
    switch (mainApi ?? main_api) {
        case 'openai': {
            switch (chatCompletionSource ?? oai_settings.chat_completion_source) {
                case chat_completion_sources.VERTEXAI:
                case chat_completion_sources.MAKERSUITE: {
                    const inlineData = data?.responseContent?.parts?.filter(x => x.inlineData && !x.thought)?.map(x => x.inlineData);
                    if (Array.isArray(inlineData) && inlineData.length > 0) {
                        return inlineData.map(x => `data:${x.mimeType};base64,${x.data}`).filter(isDataURL);
                    }
                } break;
                case chat_completion_sources.OPENROUTER: {
                    const imageUrl = data?.choices[0]?.message?.images?.filter(x => x.type === 'image_url')?.map(x => x?.image_url?.url);
                    if (Array.isArray(imageUrl) && imageUrl.length > 0) {
                        return imageUrl.filter(isDataURL);
                    }
                    // TODO: Handle remote URLs
                }
            }
        } break;
    }

    return [];
}

/**
 * parseAndSaveLogprobs receives the full data response for a non-streaming
 * generation, parses logprobs for all tokens in the message, and saves them
 * to the currently active message.
 * @param {object} data - response data containing all tokens/logprobs
 * @param {string} continueFrom - for 'continue' generations, the prompt
 *  */
export function parseAndSaveLogprobs(data, continueFrom) {
    /** @type {import('./scripts/logprobs.js').TokenLogprobs[] | null} */
    let logprobs = null;

    switch (main_api) {
        case 'novel':
            // parser only handles one token/logprob pair at a time
            logprobs = data.logprobs?.map(parseNovelAILogprobs) || null;
            break;
        case 'openai':
            // OAI and other chat completion APIs must handle this earlier in
            // `sendOpenAIRequest`. `data` for these APIs is just a string with
            // the text of the generated message, logprobs are not included.
            return;
        case 'textgenerationwebui':
            switch (textgen_settings.type) {
                case textgen_types.LLAMACPP: {
                    logprobs = data?.completion_probabilities?.map(x => parseTextgenLogprobs(x.content, [x])) || null;
                } break;
                case textgen_types.KOBOLDCPP:
                case textgen_types.VLLM:
                case textgen_types.INFERMATICAI:
                case textgen_types.APHRODITE:
                case textgen_types.MANCER:
                case textgen_types.TABBY: {
                    logprobs = parseTabbyLogprobs(data) || null;
                } break;
            } break;
        default:
            return;
    }

    saveLogprobsForActiveMessage(logprobs, continueFrom);
}

/**
 * Extracts the message from the response data.
 * @param {object} data Response data
 * @param {string} activeApi If it's set, ignores active API
 * @returns {string} Extracted message
 */
export function extractMessageFromData(data, activeApi = null) {
    function getResult() {
        if (typeof data === 'string') {
            return data;
        }

        switch (activeApi ?? main_api) {
            case 'kobold':
                return data.results[0].text;
            case 'koboldhorde':
                return data.text;
            case 'textgenerationwebui':
                return data.choices?.[0]?.text ?? data.choices?.[0]?.message?.content ?? data.content ?? data.response ?? data[0]?.content ?? '';
            case 'novel':
                return data.output;
            case 'openai':
                return data?.content?.filter(p => p.type === 'text')?.map(p => p.text)?.join('\n\n') ?? data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? data?.text ?? data?.message?.content?.[0]?.text ?? data?.message?.tool_plan ?? '';
            default:
                return '';
        }
    }

    const result = getResult();
    return Array.isArray(result) ? result.map(x => x.text).filter(x => x).join('') : result;
}

/**
 * Extracts JSON from the response data.
 * @param {object} data Response data
 * @param {object} [options] Extraction options
 * @param {string} [options.mainApi] Main API to use
 * @param {string} [options.chatCompletionSource] Chat completion source
 * @param {boolean} [options.returnInvalidJson=false] Whether to return the raw JSON string even if it fails to parse
 * @returns {string} Extracted JSON string from the response data
 */
export function extractJsonFromData(data, { mainApi = null, chatCompletionSource = null, returnInvalidJson = false } = {}) {
    mainApi = mainApi ?? main_api;
    chatCompletionSource = chatCompletionSource ?? oai_settings.chat_completion_source;

    const tryParse = (/** @type {string} */ value) => {
        try {
            return JSON.parse(value);
        } catch (e) {
            console.debug('Failed to parse content as JSON.', e);
        }
    };

    let result = {};

    switch (mainApi) {
        case 'openai': {
            const text = extractMessageFromData(data, mainApi);
            switch (chatCompletionSource) {
                case chat_completion_sources.CLAUDE:
                    result = data?.content?.find(x => x.type === 'tool_use')?.input;
                    break;
                case chat_completion_sources.PERPLEXITY:
                    result = tryParse(removeReasoningFromString(text));
                    if (!result && returnInvalidJson) {
                        return text;
                    }
                    break;
                case chat_completion_sources.VERTEXAI:
                case chat_completion_sources.MAKERSUITE:
                case chat_completion_sources.DEEPSEEK:
                case chat_completion_sources.AI21:
                case chat_completion_sources.GROQ:
                case chat_completion_sources.POLLINATIONS:
                case chat_completion_sources.AIMLAPI:
                case chat_completion_sources.OPENAI:
                case chat_completion_sources.OPENROUTER:
                case chat_completion_sources.MISTRALAI:
                case chat_completion_sources.CUSTOM:
                case chat_completion_sources.COHERE:
                case chat_completion_sources.XAI:
                case chat_completion_sources.ELECTRONHUB:
                case chat_completion_sources.CHUTES:
                case chat_completion_sources.AZURE_OPENAI:
                case chat_completion_sources.ZAI:
                default:
                    result = tryParse(text);
                    if (!result && returnInvalidJson) {
                        return text;
                    }
                    break;
            }
        } break;
    }

    return JSON.stringify(result ?? {});
}

/**
 * Extracts multiswipe swipes from the response data.
 * @param {Object} data Response data
 * @param {string} type Type of generation
 * @returns {string[]} Array of extra swipes
 */
export function extractMultiSwipes(data, type) {
    const swipes = [];

    if (!data) {
        return swipes;
    }

    if (type === 'continue' || type === 'impersonate' || type === 'quiet') {
        return swipes;
    }

    if (main_api === 'textgenerationwebui' && textgen_settings.type === textgen_types.LLAMACPP) {
        if (!Array.isArray(data)) {
            return swipes;
        }

        const multiSwipeCount = data.length - 1;
        if (multiSwipeCount <= 0) {
            return swipes;
        }

        for (let i = 1; i < data.length; i++) {
            const text = data?.[i]?.content ?? '';
            swipes.push(text);
        }
    }

    if (main_api === 'openai' || (main_api === 'textgenerationwebui' && [textgen_types.MANCER, textgen_types.VLLM, textgen_types.APHRODITE, textgen_types.TABBY, textgen_types.INFERMATICAI].includes(textgen_settings.type))) {
        if (!Array.isArray(data.choices)) {
            return swipes;
        }

        const multiSwipeCount = data.choices.length - 1;

        if (multiSwipeCount <= 0) {
            return swipes;
        }

        for (let i = 1; i < data.choices.length; i++) {
            const text = data?.choices[i]?.message?.content ?? data?.choices[i]?.text ?? '';
            swipes.push(text);
        }
    }

    const cleanedSwipes = swipes.map(text => cleanUpMessage({
        getMessage: text,
        isImpersonate: false,
        isContinue: false,
        displayIncompleteSentences: false,
    }));

    return cleanedSwipes;
}

/**
 * Formats a message according to user settings
 * @param {object} [options] - Additional options.
 * @param {string} [options.getMessage] The message to clean up
 * @param {boolean} [options.isImpersonate] Whether this is an impersonated message
 * @param {boolean} [options.isContinue] Whether this is a continued message
 * @param {boolean} [options.displayIncompleteSentences] Whether to keep incomplete sentences at the end.
 * @param {array} [options.stoppingStrings] Array of stopping strings.
 * @param {boolean} [options.includeUserPromptBias] Whether to permit prepending the user prompt bias at the beginning.
 * @param {boolean} [options.trimNames] Whether to allow trimming "{{char}}:" or "{{user}}:" from the beginning.
 * @param {boolean} [options.trimWrongNames] Whether to allow deleting responses prefixed by the incorrect name, depending on isImpersonate
 *
 * @returns {string} The formatted message
 */
export function cleanUpMessage({ getMessage, isImpersonate, isContinue, displayIncompleteSentences = false, stoppingStrings = null, includeUserPromptBias = true, trimNames = true, trimWrongNames = true } = {}) {
    if (arguments.length > 0 && typeof arguments[0] !== 'object') {
        console.trace('cleanUpMessage called with positional arguments. Please use an object instead.');
        [getMessage, isImpersonate, isContinue, displayIncompleteSentences, stoppingStrings, includeUserPromptBias, trimNames, trimWrongNames] = arguments;
    }

    if (!getMessage) {
        return '';
    }

    // Add the prompt bias before anything else
    if (
        includeUserPromptBias &&
        power_user.user_prompt_bias &&
        !isImpersonate &&
        !isContinue &&
        power_user.user_prompt_bias.length !== 0
    ) {
        getMessage = substituteParams(power_user.user_prompt_bias) + getMessage;
    }

    // Allow for caching of stopping strings. getStoppingStrings is an expensive function, especially with macros
    // enabled, so for streaming, we call it once and then pass it into each cleanUpMessage call.
    if (!stoppingStrings) {
        stoppingStrings = getStoppingStrings(isImpersonate, isContinue, main_api);
    }

    for (const stoppingString of stoppingStrings) {
        if (stoppingString.length) {
            for (let j = stoppingString.length; j > 0; j--) {
                if (getMessage.slice(-j) === stoppingString.slice(0, j)) {
                    getMessage = getMessage.slice(0, -j);
                    break;
                }
            }
        }
    }

    // Regex uses vars, so add before formatting
    getMessage = getRegexedString(getMessage, isImpersonate ? regex_placement.USER_INPUT : regex_placement.AI_OUTPUT);

    if (power_user.collapse_newlines) {
        getMessage = collapseNewlines(getMessage);
    }

    // trailing invisible whitespace before every newlines, on a multiline string
    // "trailing whitespace on newlines       \nevery line of the string    \n?sample text" ->
    // "trailing whitespace on newlines\nevery line of the string\nsample text"
    getMessage = getMessage.replace(/[^\S\r\n]+$/gm, '');

    if (trimWrongNames) {
        // If this is an impersonation, delete the entire response if it starts with "{{char}}:"
        // If this isn't an impersonation, delete the entire response if it starts with "{{user}}:"
        // Also delete any trailing text that starts with the wrong name.
        // This only occurs if the corresponding "power_user.allow_nameX_display" is false.

        let wrongName = isImpersonate
            ? (!power_user.allow_name2_display ? name2 : '')  // char
            : (!power_user.allow_name1_display ? name1 : '');  // user

        if (wrongName) {
            // If the message starts with the wrong name, delete the entire response
            let startIndex = getMessage.indexOf(`${wrongName}:`);
            if (startIndex === 0) {
                getMessage = '';
                console.debug(`Message started with the wrong name: "${wrongName}" - response was deleted.`);
            }

            // If there is trailing text starting with the wrong name, trim it off.
            startIndex = getMessage.indexOf(`\n${wrongName}:`);
            if (startIndex >= 0) {
                getMessage = getMessage.substring(0, startIndex);
            }
        }
    }

    if (getMessage.indexOf('<|endoftext|>') != -1) {
        getMessage = getMessage.substring(0, getMessage.indexOf('<|endoftext|>'));
    }
    const isInstruct = power_user.instruct.enabled && main_api !== 'openai';
    const isNotEmpty = (str) => str && str.trim() !== '';
    if (isInstruct && power_user.instruct.stop_sequence) {
        if (getMessage.indexOf(power_user.instruct.stop_sequence) != -1) {
            getMessage = getMessage.substring(0, getMessage.indexOf(power_user.instruct.stop_sequence));
        }
    }
    // Hana: Only use the first sequence (should be <|model|>)
    // of the prompt before <|user|> (as KoboldAI Lite does it).
    if (isInstruct && isNotEmpty(power_user.instruct.input_sequence)) {
        if (getMessage.indexOf(power_user.instruct.input_sequence) != -1) {
            getMessage = getMessage.substring(0, getMessage.indexOf(power_user.instruct.input_sequence));
        }
    }

    // Remove instruct sequences leaking to the output
    if (isInstruct && power_user.instruct.sequences_as_stop_strings) {
        const sequences = [
            { value: power_user.instruct.input_sequence, apply: isImpersonate && isNotEmpty(power_user.instruct.input_sequence) },
            { value: power_user.instruct.output_sequence, apply: !isImpersonate && isNotEmpty(power_user.instruct.output_sequence) },
            { value: power_user.instruct.last_output_sequence, apply: !isImpersonate && isNotEmpty(power_user.instruct.last_output_sequence) },
        ];
        for (const seq of sequences.filter(s => s.apply)) {
            seq.value.split('\n').filter(line => line.trim() !== '').forEach(line => { getMessage = getMessage.replaceAll(line, ''); });
        }
    }

    // clean-up group message from excessive generations
    if (selected_group) {
        getMessage = cleanGroupMessage(getMessage);
    }

    if (!power_user.allow_name2_display) {
        const name2Escaped = escapeRegex(name2);
        getMessage = getMessage.replace(new RegExp(`(^|\n)${name2Escaped}:\\s*`, 'g'), '$1');
    }

    if (isImpersonate) {
        getMessage = getMessage.trim();
    }

    if (trimNames) {
        // If this is an impersonation, trim "{{user}}:" from the beginning
        // If this isn't an impersonation, trim "{{char}}:" from the beginning.
        // Only applied when the corresponding "power_user.allow_nameX_display" is false.
        const nameToTrim2 = isImpersonate
            ? (!power_user.allow_name1_display ? name1 : '')  // user
            : (!power_user.allow_name2_display ? name2 : '');  // char

        if (nameToTrim2 && getMessage.startsWith(nameToTrim2 + ':')) {
            getMessage = getMessage.replace(nameToTrim2 + ':', '');
            getMessage = getMessage.trimStart();
        }
    }

    if (isImpersonate) {
        getMessage = getMessage.trim();
    }

    if (!displayIncompleteSentences && power_user.trim_sentences) {
        getMessage = trimToEndSentence(getMessage);
    }

    if (power_user.trim_spaces && !PromptReasoning.getLatestPrefix()) {
        getMessage = getMessage.trim();
    }

    return getMessage;
}

/**
 * Adds an image to the message.
 * @param {object} message Message object
 * @param {object} sources Image sources
 * @param {string[]} [sources.imageUrls] Image URLs
 *
 * @returns {Promise<void>}
 */
async function processImageAttachment(message, { imageUrls }) {
    if (!Array.isArray(imageUrls) || imageUrls.length === 0) {
        return;
    }

    for (const [index, imageUrl] of imageUrls.filter(onlyUnique).entries()) {
        if (!imageUrl) {
            continue;
        }

        let url = imageUrl;
        if (isDataURL(url)) {
            const fileName = `inline_image_${Date.now().toString()}_${index}`;
            const [mime, base64] = /^data:(.*?);base64,(.*)$/.exec(imageUrl).slice(1);
            url = await saveBase64AsFile(base64, message.name, fileName, mime.split('/')[1]);
        }
        saveImageToMessage({ image: url, inline: true }, message);
    }
}

/**
 * Saves a resulting message to the chat.
 * @param {SaveReplyParams} params
 * @returns {Promise<SaveReplyResult>} Promise when the message is saved
 *
 * @typedef {object} SaveReplyParams
 * @property {string} type Type of generation
 * @property {string} getMessage Generated message
 * @property {boolean} [fromStreaming] If the message is from streaming
 * @property {string} [title] Message tooltip
 * @property {string[]} [swipes] Extra swipes
 * @property {string} [reasoning] Message reasoning
 * @property {string[]} [imageUrls] Links to images
 * @property {string?} [reasoningSignature] Encrypted signature of the reasoning text
 *
 * @typedef {object} SaveReplyResult
 * @property {string} type Type of generation
 * @property {string} getMessage Generated message
 */
export async function saveReply({ type, getMessage, fromStreaming = false, title = '', swipes = [], reasoning = '', imageUrls = [], reasoningSignature = null }) {
    // Backward compatibility
    if (arguments.length > 1 && typeof arguments[0] !== 'object') {
        console.trace('saveReply called with positional arguments. Please use an object instead.');
        [type, getMessage, fromStreaming, title, swipes, reasoning, imageUrls, reasoningSignature] = arguments;
    }

    let lastMessage = chat[chat.length - 1];
    const lastMesId = chat.length - 1;

    if (type != 'append' && type != 'continue' && type != 'appendFinal' && chat.length && (lastMessage.swipe_id === undefined ||
        lastMessage.is_user)) {
        type = 'normal';
    }

    if (chat.length && (!lastMessage.extra || typeof lastMessage.extra !== 'object')) {
        updateMessage(lastMesId, { extra: {} });
        lastMessage = chat[lastMesId];
    }

    // Coerce null/undefined to empty string
    if (chat.length && !lastMessage.extra.reasoning) {
        updateMessage(lastMesId, { extra: { ...lastMessage.extra, reasoning: '' } });
        lastMessage = chat[lastMesId];
    }

    if (!reasoning) {
        reasoning = '';
    }

    let oldMessage = '';
    const generationFinished = new Date();
    if (type === 'swipe') {
        oldMessage = lastMessage.mes;
        // Empty string, not undefined - a non-string slot made ensureSwipes warn/repair on every generation.
        const newSwipes = [...(lastMessage.swipes || []), ''];
        const newSwipeInfo = [...(lastMessage.swipe_info || []), {
            send_date: getMessageTimeStamp(),
            gen_started: generation_started,
            gen_finished: undefined,
            extra: {},
        }];
        updateMessage(lastMesId, { swipes: newSwipes, swipe_info: newSwipeInfo });
        lastMessage = chat[lastMesId];

        if (lastMessage.swipe_id === lastMessage.swipes.length - 1) {
            const newExtra = {
                ...lastMessage.extra,
                api: getGeneratingApi(), model: getGeneratingModel(),
                reasoning, reasoning_duration: null, reasoning_signature: reasoningSignature,
            };
            updateMessage(lastMesId, {
                title, mes: getMessage,
                gen_started: generation_started, gen_finished: generationFinished,
                send_date: getMessageTimeStamp(), extra: newExtra,
            });
            lastMessage = chat[lastMesId];
            // processImageAttachment mutates — clone, process, apply back
            if (imageUrls?.length) {
                const mutableMsg = structuredClone(lastMessage);
                await processImageAttachment(mutableMsg, { imageUrls });
                updateMessage(lastMesId, { extra: mutableMsg.extra });
                lastMessage = chat[lastMesId];
            }
            if (power_user.message_token_count_enabled) {
                const tokenCountText = (reasoning || '') + chat[lastMesId].mes;
                updateMessage(lastMesId, { extra: { ...chat[lastMesId].extra, token_count: await getTokenCountAsync(tokenCountText, 0) } });
                lastMessage = chat[lastMesId];
            }
            const chat_id = lastMesId;
            !fromStreaming && await eventSource.emit(event_types.MESSAGE_RECEIVED, chat_id, type);
            addOneMessage(chat[chat_id], { type: 'swipe' });
            !fromStreaming && await eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, chat_id, type);
        } else {
            updateMessage(lastMesId, { mes: getMessage });
            lastMessage = chat[lastMesId];
        }
    } else if (type === 'append' || type === 'continue') {
        console.debug('Trying to append.');
        oldMessage = lastMessage.mes;
        const newExtra = {
            ...lastMessage.extra,
            api: getGeneratingApi(), model: getGeneratingModel(),
            reasoning, reasoning_duration: null, reasoning_signature: reasoningSignature,
        };
        updateMessage(lastMesId, {
            title, mes: lastMessage.mes + getMessage,
            gen_started: generation_started, gen_finished: generationFinished,
            send_date: getMessageTimeStamp(), extra: newExtra,
        });
        lastMessage = chat[lastMesId];
        if (imageUrls?.length) {
            const mutableMsg = structuredClone(lastMessage);
            await processImageAttachment(mutableMsg, { imageUrls });
            updateMessage(lastMesId, { extra: mutableMsg.extra });
            lastMessage = chat[lastMesId];
        }
        if (power_user.message_token_count_enabled) {
            const tokenCountText = (reasoning || '') + chat[lastMesId].mes;
            updateMessage(lastMesId, { extra: { ...chat[lastMesId].extra, token_count: await getTokenCountAsync(tokenCountText, 0) } });
            lastMessage = chat[lastMesId];
        }
        const chat_id = lastMesId;
        !fromStreaming && await eventSource.emit(event_types.MESSAGE_RECEIVED, chat_id, type);
        addOneMessage(chat[chat_id], { type: 'swipe' });
        !fromStreaming && await eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, chat_id, type);
    } else if (type === 'appendFinal') {
        oldMessage = lastMessage.mes;
        console.debug('Trying to appendFinal.');
        const newExtra = {
            ...lastMessage.extra,
            api: getGeneratingApi(), model: getGeneratingModel(),
            reasoning: (lastMessage.extra.reasoning || '') + reasoning,
            reasoning_signature: reasoningSignature,
        };
        updateMessage(lastMesId, {
            title, mes: getMessage,
            gen_started: generation_started, gen_finished: generationFinished,
            send_date: getMessageTimeStamp(), extra: newExtra,
        });
        lastMessage = chat[lastMesId];
        if (imageUrls?.length) {
            const mutableMsg = structuredClone(lastMessage);
            await processImageAttachment(mutableMsg, { imageUrls });
            updateMessage(lastMesId, { extra: mutableMsg.extra });
            lastMessage = chat[lastMesId];
        }
        // We don't know if the reasoning duration extended, so we don't update it here on purpose.
        if (power_user.message_token_count_enabled) {
            const tokenCountText = (reasoning || '') + chat[lastMesId].mes;
            updateMessage(lastMesId, { extra: { ...chat[lastMesId].extra, token_count: await getTokenCountAsync(tokenCountText, 0) } });
            lastMessage = chat[lastMesId];
        }
        const chat_id = lastMesId;
        !fromStreaming && await eventSource.emit(event_types.MESSAGE_RECEIVED, chat_id, type);
        addOneMessage(chat[chat_id], { type: 'swipe' });
        !fromStreaming && await eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, chat_id, type);
    } else {
        console.debug('entering chat update routine for non-swipe post');
        const newMessage = {};
        chat.push(newMessage);
        newMessage.extra = {};
        newMessage.name = name2;
        newMessage.is_user = false;
        newMessage.send_date = getMessageTimeStamp();
        newMessage.extra.api = getGeneratingApi();
        newMessage.extra.model = getGeneratingModel();
        newMessage.extra.reasoning = reasoning;
        newMessage.extra.reasoning_duration = null;
        newMessage.extra.reasoning_signature = reasoningSignature;
        if (power_user.trim_spaces) {
            getMessage = getMessage.trim();
        }
        newMessage.mes = getMessage;
        newMessage.title = title;
        newMessage.gen_started = generation_started;
        newMessage.gen_finished = generationFinished;

        if (power_user.message_token_count_enabled) {
            const tokenCountText = (reasoning || '') + newMessage.mes;
            newMessage.extra.token_count = await getTokenCountAsync(tokenCountText, 0);
        }

        if (selected_group) {
            console.debug('entering chat update for groups');
            let avatarImg = 'img/ai4.png';
            if (getCurrentCharacter().avatar != 'none') {
                avatarImg = getThumbnailUrl('avatar', getCurrentCharacter().avatar);
            }
            newMessage.force_avatar = avatarImg;
            newMessage.original_avatar = getCurrentCharacter().avatar;
            newMessage.extra.gen_id = group_generation_id;
        }

        await processImageAttachment(newMessage, { imageUrls });
        const chat_id = (chat.length - 1);

        !fromStreaming && await eventSource.emit(event_types.MESSAGE_RECEIVED, chat_id, type);
        addOneMessage(chat[chat_id]);
        !fromStreaming && await eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, chat_id, type);
    }

    const itemId = chat.length - 1;
    let item = chat[itemId];

    if (item.swipe_info === undefined) {
        if (item.swipe_id !== undefined) {
            const swipeId = item.swipe_id;
            const newSwipes = [...(item.swipes || [])];
            newSwipes[swipeId] = item.mes;
            const newSwipeInfo = [];
            newSwipeInfo[swipeId] = {
                send_date: item.send_date, gen_started: item.gen_started,
                gen_finished: item.gen_finished, extra: structuredClone(item.extra),
            };
            updateMessage(itemId, { swipes: newSwipes, swipe_info: newSwipeInfo });
        } else {
            updateMessage(itemId, {
                swipe_id: 0,
                swipes: [item.mes],
                swipe_info: [{
                    send_date: item.send_date, gen_started: item.gen_started,
                    gen_finished: item.gen_finished, extra: structuredClone(item.extra),
                }],
            });
        }
        item = chat[itemId];
    } else if (item.swipe_id !== undefined) {
        const swipeId = item.swipe_id;
        const newSwipes = [...item.swipes];
        newSwipes[swipeId] = item.mes;
        const newSwipeInfo = [...item.swipe_info];
        newSwipeInfo[swipeId] = {
            send_date: item.send_date, gen_started: item.gen_started,
            gen_finished: item.gen_finished, extra: structuredClone(item.extra),
        };
        updateMessage(itemId, { swipes: newSwipes, swipe_info: newSwipeInfo });
        item = chat[itemId];
    }

    if (Array.isArray(swipes) && swipes.length > 0) {
        const swipeInfoExtra = structuredClone(item.extra ?? {});
        delete swipeInfoExtra.token_count;
        delete swipeInfoExtra.reasoning;
        delete swipeInfoExtra.reasoning_duration;
        const swipeInfo = {
            send_date: item.send_date, gen_started: item.gen_started,
            gen_finished: item.gen_finished, extra: swipeInfoExtra,
        };
        const swipeInfoArray = Array(swipes.length).fill().map(() => structuredClone(swipeInfo));
        parseReasoningInSwipes(swipes, swipeInfoArray, item.extra?.reasoning_duration);
        updateMessage(itemId, {
            swipes: [...(item.swipes || []), ...swipes],
            swipe_info: [...(item.swipe_info || []), ...swipeInfoArray],
        });
        item = chat[itemId];
    }

    statMesProcess(item, type, getCurrentCharacter(), oldMessage);
    return { type, getMessage };
}

/**
 * Creates a message's `swipes`, `swipe_id` and `swipe_info` if necessary.
 * @param {ChatMessage} message
 * @returns {boolean} true if the message was updated.
 */
export function ensureSwipes(message, mesId = undefined) {
    let updated = false;

    if (!message || typeof message !== 'object') {
        console.trace(`[ensureSwipes] failed. '${message}' is not an object.`);
        return updated;
    }

    //Small system messages should not have swipes.
    if (message?.extra?.isSmallSys) {
        return updated;
    }

    /** @type {() => SwipeInfo} */
    const createSwipeInfo = () => ({
        send_date: message.send_date,
        gen_started: message.gen_started,
        gen_finished: message.gen_finished,
        extra: {},
    });

    // Collect all needed updates, apply once at the end
    const updates = {};

    let swipes = Array.isArray(message.swipes) ? [...message.swipes] : null;
    if (!swipes) {
        swipes = [message.mes ?? ''];
        updated = true;
    }

    if (typeof message.swipe_id !== 'number') {
        updates.swipe_id = 0;
        updated = true;
    }

    let swipeInfo = Array.isArray(message.swipe_info) ? [...message.swipe_info] : null;
    if (!swipeInfo) {
        swipeInfo = swipes.map(_ => createSwipeInfo());
        updated = true;
    }

    let swipesDirty = !Array.isArray(message.swipes);
    let swipeInfoDirty = !Array.isArray(message.swipe_info);

    // A tree-backed message can have null holes (unfetched alternatives) among its swipes - left alone here, belongs to hydrateSwipes() instead.
    const hasHoles = !!message.node_id;

    for (let i = 0; i < swipes.length; i++) {
        const isHole = hasHoles && swipes[i] === null;

        if (typeof swipes[i] !== 'string' && !isHole) {
            updated = true;
            swipesDirty = true;
            console.warn('The message had a swipe that is not a string. It has has been set to \'\'.', message);
            swipes[i] = '';
        }
        if ((!swipeInfo[i] || typeof swipeInfo[i] !== 'object') && !isHole) {
            updated = true;
            swipeInfoDirty = true;
            console.warn('The message had missing or invalid swipe_info for a swipe. It has been backfilled.', message);
            swipeInfo[i] = createSwipeInfo();
        }
    }

    // Stamps the selected slot with this message's node_id, except a still-blank overswipe slot, or when another slot already carries this node_id.
    const selectedSlot = updates.swipe_id ?? message.swipe_id ?? 0;
    const slotIsBlank = typeof swipes[selectedSlot] === 'string' && swipes[selectedSlot].length === 0;
    const nodeIdClaimedElsewhere = message.node_id
        && swipeInfo.some((info, i) => i !== selectedSlot && info?.node_id === message.node_id);
    if (message.node_id && !slotIsBlank && !nodeIdClaimedElsewhere && swipeInfo[selectedSlot] && !swipeInfo[selectedSlot].node_id) {
        swipeInfo[selectedSlot] = { ...swipeInfo[selectedSlot], node_id: message.node_id };
        swipeInfoDirty = true;
        updated = true;
    }

    if (swipesDirty) updates.swipes = swipes;
    if (swipeInfoDirty) updates.swipe_info = swipeInfo;

    if (updated) {
        mesId ??= chat.indexOf(message);
        if (mesId >= 0) {
            // Backfilling missing swipe arrays isn't an edit; restore the snapshot so it doesn't read as changed.
            const wasClean = _messageSnapshots.get(message.node_id) === message;
            updateMessage(mesId, updates);
            if (wasClean && chat[mesId]?.node_id) {
                _messageSnapshots.set(chat[mesId].node_id, chat[mesId]);
            }
        } else if (!Object.isFrozen(message)) {
            // Not in the chat array and not frozen (e.g., newly created message) — mutate directly
            Object.assign(message, updates);
        }
    }

    return updated;
}

/**
 * Syncs the current message and all its data into the swipe data at the given message ID (or the last message if no ID is given).
 *
 * If the swipe data is invalid in some way, this function will exit out without doing anything.
 * @param {number?} [messageId=null] - The ID of the message to sync with the swipe data. If no ID is given, the last message is used.
 * @returns {boolean} Whether the message was successfully synced
 */
export function syncMesToSwipe(messageId = null) {
    if (!chat.length) {
        return false;
    }

    const targetMessageId = messageId ?? chat.length - 1;
    if (targetMessageId >= chat.length || targetMessageId < 0) {
        console.warn(`[syncMesToSwipe] Invalid message ID: ${messageId}`);
        return false;
    }

    const targetMessage = chat[targetMessageId];
    if (!targetMessage) {
        return false;
    }

    // No swipe data there yet, exit out
    if (typeof targetMessage.swipe_id !== 'number') {
        return false;
    }
    // If swipes structure is invalid, exit out (for now?)
    if (!Array.isArray(targetMessage.swipe_info) || !Array.isArray(targetMessage.swipes)) {
        return false;
    }
    // If the swipe is not present yet, exit out (will likely be copied later)
    // "" is falsy. An empty string is a valid message.
    if (typeof targetMessage.swipes[targetMessage.swipe_id] !== 'string' || !targetMessage.swipe_info[targetMessage.swipe_id]) {
        return false;
    }

    const targetSwipeInfo = targetMessage.swipe_info[targetMessage.swipe_id];
    if (typeof targetSwipeInfo !== 'object') {
        return false;
    }

    // Only sync swipes if the chat is not pristine, so that macros in the greeting can resolve again on swipe
    const updates = {};
    if (chat_metadata.tainted || chat.length > 1) {
        const newSwipes = [...targetMessage.swipes];
        newSwipes[targetMessage.swipe_id] = targetMessage.mes;
        updates.swipes = newSwipes;
    }

    const newSwipeInfo = [...targetMessage.swipe_info];
    newSwipeInfo[targetMessage.swipe_id] = {
        ...(newSwipeInfo[targetMessage.swipe_id] || {}),
        send_date: targetMessage.send_date,
        gen_started: targetMessage.gen_started,
        gen_finished: targetMessage.gen_finished,
        extra: structuredClone(targetMessage.extra),
    };
    updates.swipe_info = newSwipeInfo;

    updateMessage(targetMessageId, updates);
    return true;
}

// Matches the window the server sends inline, so stepping onward stays instant.
const ALTERNATIVE_FETCH_WINDOW = 25;

/**
 * A tree-backed load leaves unfetched alternatives as `null` holes rather than empty strings; this fills them in on demand.
 * @param {number} mesId
 * @param {{ index?: number|null, all?: boolean }} [options]
 * @returns {Promise<boolean>}
 */
export async function hydrateSwipes(mesId, { index = null, all = false } = {}) {
    const message = chat[mesId];
    if (!message || !Array.isArray(message.swipes)) {
        return false;
    }

    const isHole = i => typeof message.swipes[i] !== 'string';
    const wanted = all
        ? message.swipes.some((_, i) => isHole(i))
        : (index !== null && index >= 0 && index < message.swipes.length && isHole(index));
    if (!wanted) {
        return true;
    }

    // Filling holes isn't an edit, so a clean message should stay clean afterward.
    const wasClean = _messageSnapshots.get(message.node_id) === message;

    if (!message.node_id) {
        return false;
    }

    // The opening's alternatives are stored openings plus card-only greetings; /alternatives only knows the stored half.
    const isOpening = mesId === 0;
    const character = isOpening ? getCurrentCharacter() : null;
    if (isOpening && !character?.avatar) {
        return false;
    }
    if (!isOpening && !isStoredNodeId(message.node_id)) {
        return false;
    }

    const body = isOpening
        ? { avatar_url: character.avatar }
        : { node_id: message.node_id };
    if (!all) {
        body.offset = Math.max(0, index - ALTERNATIVE_FETCH_WINDOW);
        body.limit = ALTERNATIVE_FETCH_WINDOW * 2 + 1;
    } else if (isOpening) {
        // The openings endpoint windows by default, so "every hole" needs an explicit range.
        body.offset = 0;
        body.limit = message.swipes.length;
    }

    let payload;
    try {
        const response = await fetch(isOpening ? '/api/chats/openings' : '/api/chats/alternatives', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(body),
        });
        if (!response.ok) {
            console.warn(`[hydrateSwipes] Failed to fetch alternatives for message ${mesId}: HTTP ${response.status}`);
            return false;
        }
        payload = await response.json();
    } catch (error) {
        console.warn(`[hydrateSwipes] Failed to fetch alternatives for message ${mesId}:`, error);
        return false;
    }

    // Re-read: an await means the message may have been replaced while the fetch was in flight.
    const current = chat[mesId];
    if (!current || current.node_id !== message.node_id || !Array.isArray(current.swipes)) {
        return false;
    }

    const swipes = [...current.swipes];
    const swipeInfo = Array.isArray(current.swipe_info) ? [...current.swipe_info] : new Array(swipes.length).fill(null);
    // The openings endpoint answers with the window it actually served, which it is free to clamp.
    const from = (isOpening ? payload.offset : undefined) ?? body.offset ?? 0;

    payload.alternatives.forEach((alt, i) => {
        const at = from + i;
        if (at >= swipes.length) return;
        // Never overwrite an already-hydrated slot - a local edit could otherwise be clobbered by the stored copy.
        if (typeof swipes[at] === 'string') return;
        swipes[at] = alt.mes ?? '';
        // An id marks this slot as settled; without one the save path reads it as a brand new alternative forever.
        swipeInfo[at] = {
            send_date: alt.send_date,
            extra: alt.extra ?? {},
            name: alt.name,
            is_user: alt.is_user,
            node_id: alt.node_id ?? (isOpening ? provisionalNodeId(alt.name ?? character.name ?? message.name, alt.mes ?? '') : undefined),
        };
    });

    updateMessage(mesId, { swipes, swipe_info: swipeInfo });

    // Hydrating only fills in what was already stored, so it does not make the message unsaved.
    if (wasClean && chat[mesId]?.node_id) {
        _messageSnapshots.set(chat[mesId].node_id, chat[mesId]);
    }

    return all ? true : typeof chat[mesId].swipes[index] === 'string';
}

/**
 * Syncs swipe data back to the message data at the given message ID (or the last message if no ID is given).
 * If the swipe ID is not provided, the current swipe ID in the message object is used.
 *
 * If the swipe data is invalid in some way, this function will exit out without doing anything.
 * @param {number?} [messageId=null] - The ID of the message to sync with the swipe data. If no ID is given, the last message is used.
 * @param {number?} [swipeId=null] - The ID of the swipe to sync. If no ID is given, the current swipe ID in the message object is used.
 * @param {ChatMessage?} [targetMessage=null] - The message object to sync instead of resolving one from `chat`.
 * @returns {boolean} Whether the swipe data was successfully synced to the message
 */
export function syncSwipeToMes(messageId = null, swipeId = null, targetMessage = null) {
    if (!targetMessage && !chat.length) {
        return false;
    }

    // False when called with an external targetMessage (e.g. a cloned snapshot) that can be mutated directly.
    const isChatResident = !targetMessage;
    const resolvedMessageId = messageId ?? chat.length - 1;

    if (!targetMessage) {
        if (resolvedMessageId >= chat.length || resolvedMessageId < 0) {
            console.warn(`[syncSwipeToMes] Invalid message ID: ${messageId}`);
            return false;
        }

        targetMessage = chat[resolvedMessageId];
    }

    if (!targetMessage) {
        return false;
    }

    if (swipeId !== null) {
        if (isNaN(swipeId) || swipeId < 0) {
            console.warn(`[syncSwipeToMes] Invalid swipe ID: ${swipeId}`);
            return false;
        }
        if (isChatResident) {
            updateMessage(resolvedMessageId, { swipe_id: swipeId });
            targetMessage = chat[resolvedMessageId];
        } else {
            targetMessage.swipe_id = swipeId;
        }
    }

    // No swipe data there yet, exit out
    if (typeof targetMessage.swipe_id !== 'number') {
        return false;
    }
    // If swipes structure is invalid, exit out
    if (!Array.isArray(targetMessage.swipes)) {
        return false;
    }

    // Backfill swipe_info if missing.
    if (!Array.isArray(targetMessage.swipe_info)) {
        const backfilledSwipeInfo = targetMessage.swipes.map(_ => ({
            send_date: targetMessage.send_date,
            gen_started: void 0,
            gen_finished: void 0,
            extra: {},
        }));
        if (isChatResident) {
            updateMessage(resolvedMessageId, { swipe_info: backfilledSwipeInfo });
            targetMessage = chat[resolvedMessageId];
        } else {
            targetMessage.swipe_info = backfilledSwipeInfo;
        }
    }

    const targetSwipeId = targetMessage.swipe_id;
    if (typeof targetMessage.swipes[targetSwipeId] !== 'string') {
        console.warn(`[syncSwipeToMes] Invalid swipe ID: ${targetSwipeId}`);
        return false;
    }

    const targetSwipeInfo = targetMessage?.swipe_info?.[targetSwipeId];
    if (typeof targetSwipeInfo !== 'object') {
        console.warn(`[syncSwipeToMes] Invalid swipe info: ${targetSwipeId}`);
    }

    const syncUpdates = {
        mes: targetMessage.swipes[targetSwipeId],
        send_date: targetSwipeInfo?.send_date,
        gen_started: targetSwipeInfo?.gen_started,
        gen_finished: targetSwipeInfo?.gen_finished,
        extra: structuredClone(targetSwipeInfo?.extra) ?? {},
    };

    if (isChatResident) {
        updateMessage(resolvedMessageId, syncUpdates);
    } else {
        Object.assign(targetMessage, syncUpdates);
    }

    return true;
}

/**
 * Saves the image to the message object.
 * @param {ParsedImage} img Image object
 * @param {ChatMessage} mes Chat message object
 * @typedef {{ image?: string, title?: string, inline?: boolean }} ParsedImage
 */
function saveImageToMessage(img, mes) {
    if (mes && img.image) {
        const extra = { ...(typeof mes.extra === 'object' && mes.extra !== null ? mes.extra : {}) };
        extra.media = Array.isArray(extra.media) ? [...extra.media] : [];
        extra.media.push({ url: img.image, type: MEDIA_TYPE.IMAGE, title: img.title, source: MEDIA_SOURCE.API });
        extra.inline_image = img.inline;

        const mesId = chat.indexOf(mes);
        if (mesId >= 0) {
            updateIn(mesId, ['extra'], extra);
        } else {
            mes.extra = extra;
        }
    }
}

export function getGeneratingApi() {
    switch (main_api) {
        case 'openai':
            return oai_settings.chat_completion_source || 'openai';
        case 'textgenerationwebui':
            return textgen_settings.type === textgen_types.OOBA ? 'textgenerationwebui' : textgen_settings.type;
        default:
            return main_api;
    }
}

export function getGeneratingModel(mes) {
    let model = '';
    switch (main_api) {
        case 'kobold':
            model = online_status;
            break;
        case 'novel':
            model = nai_settings.model_novel;
            break;
        case 'openai':
            model = getChatCompletionModel();
            break;
        case 'textgenerationwebui':
            model = online_status;
            break;
        case 'koboldhorde':
            model = kobold_horde_model;
            break;
    }
    return model;
}

/**
 * A function mainly used to switch 'generating' state - setting it to false and activating the buttons again
 */
export function activateSendButtons() {
    is_send_press = false;
    hideStopButton();
    showSwipeButtons();
    delete document.body.dataset.generating;
    if (online_status !== 'no_connection') {
        $('#send_but, #mes_continue, #mes_impersonate').removeClass('displayNone');
    }
}

/**
 * A function mainly used to switch 'generating' state - setting it to true and deactivating the buttons
 */
export function deactivateSendButtons() {
    showStopButton();
    hideSwipeButtons();
    document.body.dataset.generating = 'true';
}

export function resetChatState() {
    // replaces deleted charcter name with system user since it will be displayed next.
    name2 = (getSelectionState().type !== 'character' && neutralCharacterName) ? neutralCharacterName : systemUserName;
    //unsets the expected selection before reloading (related to getCharacters/printCharacters from using old arrays)
    setCharacterId(undefined);
    // sets up system user to tell user about having deleted a character
    chat.splice(0, chat.length, ...SAFETY_CHAT);
    // resets chat metadata
    setChatMetadata({});
    _resetMetadataSaveSnapshot();
}

/**
 *
 * @param {'characters' | 'character_edit' | 'create' | 'group_edit' | 'group_create'} value
 */
export function setMenuType(value) {
    menu_type = value;
    // Allow custom CSS to see which menu type is active
    document.getElementById('right-nav-panel').dataset.menuType = menu_type;
}

export function setExternalAbortController(controller) {
    setAbortController(controller);
}

export function setCharacterName(value) {
    name2 = value;
}

/**
 * Sets the API connection status of the application
 * @param {string|'no_connection'} value Connection status value
 */
export function setOnlineStatus(value) {
    const previousStatus = online_status;
    online_status = value;
    displayOnlineStatus();
    if (previousStatus !== online_status) {
        eventSource.emitAndWait(event_types.ONLINE_STATUS_CHANGED, online_status);
    }
}

export function setEditedMessageId(value) {
    this_edit_mes_id = value;
}

export function setSendButtonState(value) {
    is_send_press = value;
}

/**
 * Renames the currently selected character, updating relevant references and optionally renaming past chats.
 *
 * If no name is provided, a popup prompts for a new name. If the new name matches the current name,
 * the renaming process is aborted. The function sends a request to the server to rename the character
 * and handles updates to other related fields such as tags, lore, and author notes.
 *
 * If the renaming is successful, the character list is reloaded and the renamed character is selected.
 * Optionally, past chats can be renamed to reflect the new character name.
 *
 * @param {string?} [name=null] - The new name for the character. If not provided, a popup will prompt for it.
 * @param {object} [options] - Additional options.
 * @param {boolean} [options.silent=false] - If true, suppresses popups and warnings.
 * @param {boolean?} [options.renameChats=null] - If true, renames past chats to reflect the new character name.
 * @returns {Promise<boolean>} - Returns true if the character was successfully renamed, false otherwise.
 */

export async function renameCharacter(name = null, { silent = false, renameChats = null } = {}) {
    if (blockWhileFieldEditing()) {
        return false;
    }
    if (!name && silent) {
        toastr.warning(t`No character name provided.`, t`Rename Character`);
        return false;
    }
    if (getSelectionState().type !== 'character') {
        toastr.warning(t`No character selected.`, t`Rename Character`);
        return false;
    }

    const oldAvatar = getCurrentCharacter().avatar;
    const newValue = name || await callGenericPopup('<h3>' + t`New name:` + '</h3>', POPUP_TYPE.INPUT, getCurrentCharacter().name);

    if (!newValue) {
        toastr.warning(t`No character name provided.`, t`Rename Character`);
        return false;
    }
    if (newValue === getCurrentCharacter().name) {
        toastr.info(t`Same character name provided, so name did not change.`, t`Rename Character`);
        return false;
    }

    const body = JSON.stringify({ avatar_url: oldAvatar, new_name: newValue });
    const response = await fetch('/api/characters/rename', {
        method: 'POST',
        headers: getRequestHeaders(),
        body,
    });

    try {
        if (response.ok) {
            const data = await response.json();
            const newAvatar = data.avatar;

            const oldName = getCharaFilename(null, { manualAvatarKey: oldAvatar });
            const newName = getCharaFilename(null, { manualAvatarKey: newAvatar });

            // Tag assignments live on the character's own tag_ids, carried forward by the server's rename
            // route and picked up fresh by the getCharacters() reload below - nothing to do here.

            // Additional lore books
            const charLore = world_info.charLore?.find(x => x.name == oldName);
            if (charLore) {
                charLore.name = newName;
                saveSettingsDebounced('world_info_settings');
            }

            // Char-bound Author's Notes
            const charNote = extension_settings.note.chara?.find(x => x.name == oldName);
            if (charNote) {
                charNote.name = newName;
                saveSettingsDebounced('extension_settings');
            }

            // Update active character, if the current one was the currently active one
            if (active_character === oldAvatar) {
                setActiveCharacter(newAvatar);
                saveSettingsDebounced('active_character');
            }

            await eventSource.emit(event_types.CHARACTER_RENAMED, oldAvatar, newAvatar);

            // Unload current character
            setCharacterId(undefined);
            // Reload characters list
            await getCharacters({ silent: true, skipPrint: true });
            // A sync only refreshes characters the page already holds; the renamed one comes in under its new key.
            if (!charactersStore.has(newAvatar)) {
                const { characterRepository } = await import('./scripts/character-repository.js');
                const renamed = await characterRepository.full(newAvatar);
                if (renamed) holdCharacter(renamed);
            }
            charactersStore.reportRenamed(oldAvatar, newAvatar);
            renameCharacterListRow(oldAvatar, newAvatar);

            // Find newly renamed character
            const renamedEntity = charactersStore.get(data.avatar);

            if (renamedEntity) {
                // Select the character after the renaming
                await selectCharacterByAvatar(data.avatar);

                // Async delay to update UI
                await delay(1);

                if (getSelectionState().type !== 'character') {
                    throw new Error('New character not selected');
                }

                // Also rename as a group member
                await renameGroupMember(oldAvatar, newAvatar, newValue.toString());
                const renamePastChatsConfirm = renameChats !== null
                    ? renameChats
                    : silent
                        ? false
                        : await Popup.show.confirm(
                            t`Character renamed!`,
                            `<p>${t`Past chats will still contain the old character name. Would you like to update the character name in previous chats as well?`}</p>
                            <i><b>${t`Sprites folder (if any) should be renamed manually.`}</b></i>`,
                        ) == POPUP_RESULT.AFFIRMATIVE;

                if (renamePastChatsConfirm) {
                    await renamePastChats(oldAvatar, newAvatar, newValue);
                    await reloadCurrentChat();
                    toastr.success(t`Character renamed and past chats updated!`, t`Rename Character`);
                } else {
                    toastr.success(t`Character renamed!`, t`Rename Character`);
                }
            } else {
                throw new Error('Newly renamed character was lost?');
            }
        } else {
            throw new Error('Could not rename the character');
        }
    } catch (error) {
        // Reloading to prevent data corruption
        if (!silent) await Popup.show.text(t`Rename Character`, t`Something went wrong. The page will be reloaded.`);
        else toastr.error(t`Something went wrong. The page will be reloaded.`, t`Rename Character`);

        console.log('Renaming character error:', error);
        location.reload();
        return false;
    }

    return true;
}

async function renamePastChats(oldAvatar, newAvatar, newName) {
    // Single server-side UPDATE instead of fetching and re-saving every chat file
    try {
        const result = await fetch('/api/chats/tree/rename-in-content', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ avatar_url: newAvatar, new_name: newName }),
        });
        if (!result.ok) {
            throw new Error('Server-side rename failed');
        }
        const data = await result.json();
        if (data.noSavedChats) {
            // Nothing to rename - the character has no saved chats yet. Not a failure.
            console.debug('[renamePastChats] Tree DB: no saved chats, nothing to rename');
            return false;
        }
        console.debug(`[renamePastChats] Tree DB: renamed ${data.updated} messages`);
        return true;
    } catch (error) {
        toastr.error(t`Past chats could not be renamed`);
        console.error(error);
        return false;
    }
}

export function saveChatDebounced() {
    const avatar = this_avatar;
    const selectedGroup = selected_group;

    cancelDebouncedChatSave();

    chatSaveTimeout = setTimeout(async () => {
        if (selectedGroup !== selected_group) {
            console.warn('Chat save timeout triggered, but group changed. Aborting.');
            return;
        }

        if (avatar !== this_avatar) {
            console.warn('Chat save timeout triggered, but the selected character changed. Aborting.');
            return;
        }

        console.debug('Chat save timeout triggered');
        // eslint-disable-next-line no-restricted-syntax -- this IS saveChatDebounced()'s own definition.
        await saveChatConditional();
        console.debug('Chat saved');
    }, DEFAULT_SAVE_EDIT_TIMEOUT);
}

/**
 * Processes the avatar image from the input element, allowing the user to crop it if necessary.
 * @param {HTMLInputElement} input - The input element containing the avatar file.
 * @returns {Promise<void>}
 */
async function read_avatar_load(input) {
    if (input.files && input.files[0]) {
        if (selected_button == 'create') {
            create_save.avatar = input.files;
        }

        crop_data = undefined;
        const file = input.files[0];
        const fileData = await getBase64Async(file);

        if (!power_user.never_resize_avatars) {
            const dlg = new Popup('Set the crop position of the avatar image', POPUP_TYPE.CROP, '', { cropImage: fileData });
            const croppedImage = await dlg.show();

            if (!croppedImage) {
                return;
            }

            crop_data = dlg.cropData;
            $('#avatar_load_preview').attr('src', String(croppedImage));
        } else {
            $('#avatar_load_preview').attr('src', fileData);
        }

        if (menu_type == 'create') {
            return;
        }

        const avatarKey = getEditorCharacterAvatar();
        if (!await saveCharacterAvatar(avatarKey, file)) {
            return;
        }

        // Bust cache for the avatar thumbnail and character image
        const thumbnailUrl = getThumbnailUrl('avatar', avatarKey);
        await fetch(thumbnailUrl, { method: 'GET', cache: 'reload' });
        await fetch(`/characters/${avatarKey}`, { method: 'GET', cache: 'reload' });

        // Refresh all visible avatar images that use this thumbnail URL
        // This handles messages, character list, and any other place using the thumbnail
        const avatarImages = document.querySelectorAll(`img[src^="${thumbnailUrl}"]`);
        for (const img of avatarImages) {
            if (img instanceof HTMLImageElement) {
                const originalSrc = img.src;
                img.src = '';
                img.src = originalSrc;
            }
        }
        console.debug(`Refreshed ${avatarImages.length} avatar images for ${avatarKey}`);

        console.log('Avatar refreshed');
    }
}

// Thumbnail versions known ahead of a request, so getThumbnailUrl() can emit `?v=` on the first request instead of taking the no-cache redirect detour. Best-effort; self-correcting if stale.
const thumbnailVersionCache = new Map();

/**
 * @param {import('../src/endpoints/thumbnails.js').ThumbnailType} type
 * @param {string} file
 * @param {string|number|null|undefined} version
 */
export function setThumbnailVersion(type, file, version) {
    if (version === null || version === undefined || version === '') return;
    thumbnailVersionCache.set(`${type}:${file}`, String(version));
}

/**
 * Gets the URL for a thumbnail of a specific type and file.
 * @param {import('../src/endpoints/thumbnails.js').ThumbnailType} type The type of the thumbnail to get
 * @param {string} file The file name or path for which to get the thumbnail URL
 * @param {boolean} [t=false] Whether to add a cache-busting timestamp to the URL
 * @returns {string} The URL for the thumbnail
 */
export function getThumbnailUrl(type, file, t = false) {
    const version = !t && thumbnailVersionCache.get(`${type}:${file}`);
    const versionParam = version ? `&v=${encodeURIComponent(version)}` : '';
    return `/thumbnail?type=${type}&file=${encodeURIComponent(file)}${versionParam}${t ? `&t=${Date.now()}` : ''}`;
}

export function buildAvatarList(block, entities, { templateId = 'inline_avatar_template', empty = true, interactable = false, highlightFavs = true } = {}) {
    if (empty) {
        block.empty();
    }

    for (const entity of entities) {
        const id = entity.id;

        // Populate the template
        const avatarTemplate = $(`#${templateId} .avatar`).clone();

        let this_avatar = default_avatar;
        if (entity.item.avatar !== undefined && entity.item.avatar != 'none') {
            this_avatar = getThumbnailUrl('avatar', entity.item.avatar);
        }

        avatarTemplate.attr('data-type', entity.type);
        if (entity.type === 'character') {
            avatarTemplate.attr('data-avatar', entity.item.avatar);
        }
        // loading="lazy": avoids a request storm when this list is the whole library (group member/candidate pickers).
        avatarTemplate.find('img').attr('src', this_avatar).attr('loading', 'lazy').attr('alt', entity.item.name);
        avatarTemplate.attr('title', `[Character] ${entity.item.name}\nFile: ${entity.item.avatar}`);
        if (highlightFavs) {
            const isFav = normalizeFav(entity.item.fav);
            avatarTemplate.toggleClass('is_fav', isFav);
            avatarTemplate.find('.ch_fav').val(String(isFav));
        }

        // If this is a group, we need to hack slightly. We still want to keep most of the css classes and layout, but use a group avatar instead.
        if (entity.type === 'group') {
            const grpTemplate = getGroupAvatar(entity.item);

            avatarTemplate.addClass(grpTemplate.attr('class'));
            avatarTemplate.empty();
            avatarTemplate.append(grpTemplate.children());
            avatarTemplate.attr({ 'data-grid': id });
            avatarTemplate.attr('title', `[Group] ${entity.item.name}`);
        } else if (entity.type === 'persona') {
            avatarTemplate.attr({ 'data-pid': id });
            avatarTemplate.find('img').attr('src', getThumbnailUrl('persona', entity.item.avatar));
            avatarTemplate.attr('title', `[Persona] ${entity.item.name}\nFile: ${entity.item.avatar}`);
        }

        if (interactable) {
            avatarTemplate.addClass(INTERACTABLE_CONTROL_CLASS);
            avatarTemplate.toggleClass('character_select', entity.type === 'character');
            avatarTemplate.toggleClass('group_select', entity.type === 'group');
        }

        block.append(avatarTemplate);
    }
}

/**
 * Loads all the data of a shallow character. Kept for upstream callers: every character the page holds is already
 * a full card, so for those this does nothing.
 * @param {string|number|undefined} characterId An index into `getContext().characters`, or an avatar key
 * @returns {Promise<void>} Promise that resolves when the character is unshallowed
 */
export async function unshallowCharacter(characterId) {
    const character = resolveCharacterRef(characterId);

    if (characterId === undefined) {
        console.debug('Undefined character cannot be unshallowed');
        return;
    }

    if (!character) {
        console.debug('Character not found:', characterId);
        return;
    }

    // Character is not shallow
    if (!character.shallow) {
        return;
    }

    await getOneCharacter(character.avatar);
}

/**
 * @param {object} [options]
 * @param {boolean} [options.isNewChat] True when the filename has never been saved, so a 404 is expected rather than a deleted-chat resurrection.
 */
export async function getChat({ isNewChat = false } = {}) {
    try {
        await unshallowCharacter(getCurrentCharacter()?.avatar);

        if (!isNewChat && !getCurrentCharacter().chat) {
            // No chat pointer at all yet - nothing on disk could possibly match, so don't burn
            // a request finding that out. Go straight to the same resolution a 404 would trigger.
            await replaceCurrentChat();
            return;
        }

        const response = await fetch('/api/chats/get', {
            method: 'POST',
            headers: getRequestHeaders(),
            cache: 'no-cache',
            body: JSON.stringify({
                ch_name: getCurrentCharacter().name,
                file_name: getCurrentCharacter().chat,
                avatar_url: getCurrentCharacter().avatar,
            }),
        });

        if (response.status === 404 && !isNewChat) {
            // The persisted "current chat" pointer names a file gone from disk; fall back the same way delChat() does.
            console.warn(`Chat file not found for ${getCurrentCharacter()?.chat}, replacing with an existing or new chat`);
            await replaceCurrentChat();
            return;
        }

        if (!response.ok && !(isNewChat && response.status === 404)) {
            throw new Error('Chat could not be loaded');
        }

        // A brand-new, never-yet-saved chat file legitimately 404s - treat like the "empty/corrupted chat" case below.
        const data = response.ok ? await response.json() : [];
        if (Array.isArray(data) && data.length > 0) {
            /** @type {ChatHeader} */
            const chatHeader = data.shift();
            setChatMetadata(chatHeader?.chat_metadata ?? {});
            _setCurrentTarget(getCurrentCharacter().chat, chat_metadata.integrity ?? null);
            _resetMetadataSaveSnapshot();
            chat.splice(0, chat.length, ...data);
            chat.forEach(ensureMessageMediaIsArray);
            // Freeze messages loaded from tree DB: immutable values, replaced only via updateMessage()
            for (let i = 0; i < chat.length; i++) {
                chat[i] = deepFreeze(chat[i]);
            }
            _snapshotMessages();
            await _mergeCardGreetingsIntoOpening();
        } else {
            // An empty/corrupted chat file
            chat.splice(0, chat.length);
            setChatMetadata({});
            _setCurrentTarget(getCurrentCharacter().chat, null);
            _resetMetadataSaveSnapshot();
        }
        await getChatResult();

        // printMessages() -> ensureSwipes() synthesizes missing swipe shape via updateMessage(); re-snapshot so that alone doesn't queue an edit.
        _snapshotMessages();

        eventSource.emit(event_types.CHAT_LOADED, { detail: { character: getCurrentCharacter() } });

        // Focus on the textarea if not already focused on a visible text input
        delay(debounce_timeout.short).then(() => {
            if ($(document.activeElement).is('input:visible, textarea:visible')) {
                return;
            }
            $('#send_textarea').trigger('click').trigger('focus');
        });
    } catch (error) {
        await getChatResult();
        console.log(error);
    }
}

/**
 * Puts the character's greeting into an empty chat as message 0. The caller prints the chat afterwards.
 * @returns {Promise<boolean>} Whether a message was pushed.
 */
async function pushFirstMessageIntoEmptyChat() {
    if (chat.length !== 0) {
        return false;
    }
    let pushed = false;
    const message = await getFirstMessage();
    if (message.mes) {
        if (power_user.message_token_count_enabled) {
            message.extra.token_count = await getTokenCountAsync(message.mes, 0);
        }
        chat.push(message);
        pushed = true;
    }

    if (message?.node_id) {
        _snapshotMessages();
    }
    return pushed;
}

async function getChatResult() {
    name2 = getCurrentCharacter().name;
    const freshChat = await pushFirstMessageIntoEmptyChat();
    await loadItemizedPrompts(getCurrentChatId());
    await printMessages();
    select_selected_character(getCurrentCharacter()?.avatar);

    await eventSource.emit(event_types.CHAT_CHANGED, (getCurrentChatId()));
    if (freshChat) await eventSource.emit(event_types.CHAT_CREATED);

    if (chat.length === 1) {
        const chat_id = (chat.length - 1);
        await eventSource.emit(event_types.MESSAGE_RECEIVED, chat_id, 'first_message');
        await eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, chat_id, 'first_message');
    }
}

// _openingFromTree() is the only builder of a real greeting; its null return means the card itself
// has no greeting text (not a failure - see that function's own doc comment), which callers treat as
// "nothing to open on" via the empty `mes` below.
async function getFirstMessage() {
    const character = getCurrentCharacter();
    const { greetings, defaultIndex } = cardToGreetingsModel(character);
    const swipeId = defaultIndex ?? 0;

    // Raw greetings, not regexed: identity is the message as stored, and regex is a display transform.
    const fromTree = await _openingFromTree(greetings, swipeId);
    if (fromTree) return fromTree;

    return {
        name: name2,
        is_user: false,
        is_system: false,
        send_date: getMessageTimeStamp(),
        mes: '',
        extra: {},
    };
}

// Builds the opening from existing opening nodes so it carries a real node_id - the only place a
// greeting is ever built. A null return means the card genuinely has no greeting text; a failure to
// resolve the character or reach the store is a thrown error, not a silent, less-correct fallback.
async function _openingFromTree(cardGreetings, preferredIndex) {
    const character = getCurrentCharacter();
    if (!character?.avatar) throw new Error('_openingFromTree: no resolvable character avatar');

    const post = async (path, body) => {
        const response = await fetch(path, {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ avatar_url: character.avatar, ...body }),
        });
        if (!response.ok) throw new Error(`_openingFromTree: ${path} responded ${response.status}`);
        return response.json().catch(() => null);
    };

    const sendDate = getMessageTimeStamp();
    const speaker = character.name ?? name2;
    const asMessage = text => ({
        name: speaker,
        is_user: false,
        is_system: false,
        send_date: sendDate,
        mes: text,
        extra: {},
    });

    // Used only locally for the preferred-index fallback match; the server merges the card's greetings at read time.
    const contents = (cardGreetings ?? [])
        .filter(text => typeof text === 'string' && text.length > 0)
        .map(asMessage);

    // A malformed (non-JSON) response is a real failure too, same as the request itself not being ok -
    // neither means "no chat history yet" or "no openings yet".
    const openings = await post('/api/chats/openings', {});
    if (!openings) throw new Error('_openingFromTree: /api/chats/openings returned no usable body');

    const windowStart = openings.offset ?? 0;
    const preferredText = contents[preferredIndex]?.mes;
    let chosenOffset = openings.default_chosen === true ? (openings.default_index ?? -1) - windowStart : -1;
    if (chosenOffset >= openings.alternatives.length) chosenOffset = -1;
    if (chosenOffset < 0) chosenOffset = openings.alternatives.findIndex(a => a.node_id && a.node_id === openings.default_node_id);
    if (chosenOffset < 0 && preferredText !== undefined) {
        chosenOffset = openings.alternatives.findIndex(a => a.mes === preferredText);
    }
    if (chosenOffset < 0) chosenOffset = 0;

    // Nothing to open on only happens when the card itself has no greeting.
    const chosen = openings.alternatives[chosenOffset]
        ?? (preferredText !== undefined ? { node_id: null, mes: preferredText, name: speaker, is_user: false, send_date: sendDate, extra: {} } : null);
    if (!chosen) return null;

    // Showing a greeting is not using it: a greeting with no row gets a provisional id, minted for real only when needed.
    const chosenNodeId = chosen.node_id ?? provisionalNodeId(chosen.name ?? speaker, chosen.mes);

    const message = {
        name: chosen.name ?? speaker,
        is_user: !!chosen.is_user,
        is_system: !!chosen.is_system,
        send_date: chosen.send_date ?? sendDate,
        mes: chosen.mes,
        extra: chosen.extra ?? {},
        node_id: chosenNodeId,
    };

    if (openings.total > 1) {
        // Same holed shape a chat load produces: a slot with no node_id is a card-only greeting.
        const swipes = new Array(openings.total).fill(null);
        const swipeInfo = new Array(openings.total).fill(null);
        openings.alternatives.forEach((alt, k) => {
            const at = windowStart + k;
            if (at >= openings.total) return;
            swipes[at] = alt.mes;
            // Every slot carries an id, real or provisional, rather than a separate card_only flag to keep in step.
            const nodeId = alt.node_id ?? provisionalNodeId(alt.name ?? speaker, alt.mes);
            swipeInfo[at] = {
                send_date: alt.send_date, extra: alt.extra ?? {},
                name: alt.name, is_user: alt.is_user,
                node_id: nodeId,
            };
        });
        message.swipes = swipes;
        message.swipe_info = swipeInfo;
        message.swipe_id = windowStart + chosenOffset;
    }

    return message;
}

/**
 * A targeted metadata-only write, instead of rewriting the whole character card - doesn't defeat reflink sharing on its PNG.
 * @param {string} avatar
 * @param {string} chat
 * @returns {Promise<boolean>} Whether it was saved.
 */
export async function saveActiveChat(avatar, chat) {
    try {
        const response = await fetch('/api/characters/chat', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ avatar, chat }),
        });
        if (!response.ok) throw new Error(String(response.status));
        return true;
    } catch (error) {
        console.error('Failed to save active chat', error);
        toastr.error(t`Failed to save active chat.`);
        return false;
    }
}

export async function openCharacterChat(file_name) {
    await waitUntilCondition(() => !isChatSaving, debounce_timeout.extended, 10);
    await clearChat({ clearData: true });
    setChatMetadata({});
    _setCurrentTarget(file_name, null);
    _resetMetadataSaveSnapshot();

    // Must run even if getChat fails, or "which chat was open" is lost on reload.
    try {
        await getChat();
    } finally {
        $('#selected_chat_pole').val(file_name);
        setFormBaseline('#selected_chat_pole', String($('#selected_chat_pole').val()));
        await saveActiveChat(getCurrentCharacter().avatar, file_name);
    }
}

////////// OPTIMZED MAIN API CHANGE FUNCTION ////////////

export function changeMainAPI(api = null) {
    const selectedVal = api ?? $('#main_api').val();
    //console.log(selectedVal);
    const apiElements = {
        'koboldhorde': {
            apiStreaming: $('#NULL_SELECTOR'),
            apiSettings: $('#kobold_api-settings'),
            apiConnector: $('#kobold_horde'),
            apiPresets: $('#kobold_api-presets'),
            apiRanges: $('#range_block'),
            maxContextElem: $('#max_context_block'),
            amountGenElem: $('#amount_gen_block'),
        },
        'kobold': {
            apiStreaming: $('#streaming_kobold_block'),
            apiSettings: $('#kobold_api-settings'),
            apiConnector: $('#kobold_api'),
            apiPresets: $('#kobold_api-presets'),
            apiRanges: $('#range_block'),
            maxContextElem: $('#max_context_block'),
            amountGenElem: $('#amount_gen_block'),
        },
        'textgenerationwebui': {
            apiStreaming: $('#streaming_textgenerationwebui_block'),
            apiSettings: $('#textgenerationwebui_api-settings'),
            apiConnector: $('#textgenerationwebui_api'),
            apiPresets: $('#textgenerationwebui_api-presets'),
            apiRanges: $('#range_block_textgenerationwebui'),
            maxContextElem: $('#max_context_block'),
            amountGenElem: $('#amount_gen_block'),
        },
        'novel': {
            apiStreaming: $('#streaming_novel_block'),
            apiSettings: $('#novel_api-settings'),
            apiConnector: $('#novel_api'),
            apiPresets: $('#novel_api-presets'),
            apiRanges: $('#range_block_novel'),
            maxContextElem: $('#max_context_block'),
            amountGenElem: $('#amount_gen_block'),
        },
        'openai': {
            apiStreaming: $('#NULL_SELECTOR'),
            apiSettings: $('#openai_settings'),
            apiConnector: $('#openai_api'),
            apiPresets: $('#openai_api-presets'),
            apiRanges: $('#range_block_openai'),
            maxContextElem: $('#max_context_block'),
            amountGenElem: $('#amount_gen_block'),
        },
    };
    //console.log('--- apiElements--- ');
    //console.log(apiElements);

    //first, disable everything so the old elements stop showing
    for (const apiName in apiElements) {
        const apiObj = apiElements[apiName];
        //do not hide items to then proceed to immediately show them.
        if (selectedVal === apiName) {
            continue;
        }
        apiObj.apiSettings.css('display', 'none');
        apiObj.apiConnector.css('display', 'none');
        apiObj.apiRanges.css('display', 'none');
        apiObj.apiPresets.css('display', 'none');
        apiObj.apiStreaming.css('display', 'none');
    }

    //then, find and enable the active item.
    //This is split out of the loop so that different apis can share settings divs
    let activeItem = apiElements[selectedVal];

    activeItem.apiStreaming.css('display', 'block');
    activeItem.apiSettings.css('display', 'block');
    activeItem.apiConnector.css('display', 'block');
    activeItem.apiRanges.css('display', 'block');
    activeItem.apiPresets.css('display', 'block');

    if (selectedVal === 'openai') {
        activeItem.apiPresets.css('display', 'flex');
    }

    if (selectedVal === 'textgenerationwebui' || selectedVal === 'novel') {
        console.debug('enabling amount_gen for ooba/novel');
        activeItem.amountGenElem.find('input').prop('disabled', false);
        activeItem.amountGenElem.css('opacity', 1.0);
    }

    //custom because streaming has been moved up under response tokens, which exists inside common settings block
    if (selectedVal === 'novel') {
        $('#ai_module_block_novel').css('display', 'block');
    } else {
        $('#ai_module_block_novel').css('display', 'none');
    }

    $('#prompt_cost_block').toggle(selectedVal === 'textgenerationwebui' && textgen_settings.type === textgen_types.OPENROUTER);

    // Hide common settings for OpenAI
    console.debug('value?', selectedVal);
    if (selectedVal == 'openai') {
        console.debug('hiding settings?');
        $('#common-gen-settings-block').css('display', 'none');
    } else {
        $('#common-gen-settings-block').css('display', 'block');
    }

    $('body').toggleClass('chat-completion-selected', selectedVal === 'openai');

    setMainApi(selectedVal);
    setOnlineStatus('no_connection');

    if (main_api == 'koboldhorde') {
        getStatusHorde();
        getHordeModels(true);
    }
    validateDisabledSamplers();
    setupChatCompletionPromptManager(oai_settings);
    markCharacterEditorCountsStale();
}

export function setUserName(value, { toastPersonaNameChange = true } = {}) {
    setName1Raw(value === undefined || value == '' ? default_user_name : value);
    console.log(`User name changed to ${name1}`);
    $('#your_name').text(name1);
    if (toastPersonaNameChange && power_user.persona_show_notifications && !isPersonaPanelOpen()) {
        toastr.success(t`Your messages will now be sent as ${name1}`, t`Persona Changed`);
    }
    saveSettingsDebounced('username');
}

async function doOnboarding(avatarId) {
    const template = $('#onboarding_template .onboarding');
    let userName = await callGenericPopup(template, POPUP_TYPE.INPUT, currentUser?.name || name1, { wider: true, cancelButton: false });

    if (userName) {
        userName = String(userName).replace('\n', ' ');
        setUserName(userName);
        console.log(`Binding persona ${avatarId} to name ${userName}`);
        personaStore.create(avatarId, {
            name: userName,
            description: '',
            position: persona_description_positions.IN_PROMPT,
            depth: PERSONA_DEFAULT_DEPTH,
            role: PERSONA_DEFAULT_ROLE,
            lorebook: '',
            title: '',
            connections: [],
        });
        saveSettingsDebounced('power_user.persona_data');
    }
}

function reloadLoop() {
    const MAX_RELOADS = 5;
    let reloads = Number(sessionStorage.getItem('reloads') || 0);
    if (reloads < MAX_RELOADS) {
        reloads++;
        sessionStorage.setItem('reloads', String(reloads));
        window.location.reload();
    }
}

/**
 * Cached result of the last successful POST /api/settings/get, and the in-flight request for one
 * currently underway (if any). getSettings() itself is the only caller that runs at a point where
 * this data can actually be stale (after a save conflict), and it always passes `force: true`.
 * Every other caller - including extensions like quick-reply, which activate synchronously inside
 * getSettings()'s own call chain (getSettings -> loadExtensionSettings -> activateExtensions ->
 * an extension's init()) and so want the exact response getSettings() just fetched - can safely
 * reuse this cache instead of issuing their own separate ~60KB POST for identical data.
 * @type {{data: any}|null}
 */
let rawSettingsCache = null;
/** @type {Promise<any>|null} */
let rawSettingsFetchPromise = null;

/**
 * Fetches the raw POST /api/settings/get payload (settings.json plus companion catalogs like
 * world_names, quickReplyPresets, presets, etc).
 * @param {object} [options]
 * @param {boolean} [options.force=false] Bypass the cache and fetch fresh data (for callers that
 * know the cached copy may be stale, e.g. after a save conflict).
 * @returns {Promise<any>} Parsed JSON response body
 */
export function fetchRawSettings({ force = false } = {}) {
    if (force) {
        rawSettingsCache = null;
    }

    if (rawSettingsCache) {
        return Promise.resolve(rawSettingsCache.data);
    }

    if (rawSettingsFetchPromise) {
        return rawSettingsFetchPromise;
    }

    rawSettingsFetchPromise = (async () => {
        try {
            const response = await fetch('/api/settings/get', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({}),
                cache: 'no-cache',
            });

            if (!response.ok) {
                throw new Error('Error getting settings');
            }

            const data = await response.json();
            rawSettingsCache = { data };
            return data;
        } finally {
            rawSettingsFetchPromise = null;
        }
    })();

    return rawSettingsFetchPromise;
}

//MARK: getSettings()
///////////////////////////////////////////
export async function getSettings(initLoaderHandle = null, onStageChange = null, { force = false } = {}) {
    let data;
    try {
        data = await fetchRawSettings({ force });
    } catch (error) {
        reloadLoop();
        toastr.error(t`Settings could not be loaded after multiple attempts. Please try again later.`);
        throw error;
    }
    return await applySettings(data, initLoaderHandle, onStageChange);
}

async function applySettings(data, initLoaderHandle = null, onStageChange = null) {
    let onboarded = false;
    if (data.result != 'file not find' && data.settings) {
        knownServerSettingsHash = data.settingsHash;
        settings = JSON.parse(data.settings);
        Object.assign(serverKeyHashes, data.keyHashes);
        if (settings.username !== undefined && settings.username !== '') {
            setName1Raw(settings.username);
            $('#your_name').text(name1);
        }

        accountStorage.init(settings?.accountStorage);
        await setUserControls(data.enable_accounts);
        setRequestCompressionConfig(data.request_compression);

        // Allow subscribers to mutate settings
        await eventSource.emit(event_types.SETTINGS_LOADED_BEFORE, settings);

        //Load AI model config settings
        setAmountGen(settings.amount_gen);
        if (settings.max_context !== undefined)
            setMaxContext(parseInt(settings.max_context));

        swipes = settings.swipes !== undefined ? !!settings.swipes : true;  // enable swipes by default
        $('#swipes-checkbox').prop('checked', swipes); /// swipecode
        refreshSwipeButtons();

        // Kobold
        loadKoboldSettings(data, settings.kai_settings ?? settings, settings);

        // Novel
        loadNovelSettings(data, settings.nai_settings ?? settings);

        // TextGen
        await loadTextGenSettings(data, settings);

        // OpenAI
        loadOpenAISettings(data, settings.oai_settings ?? settings);

        // Horde
        loadHordeSettings(settings);

        // Load power user settings
        await loadPowerUserSettings(settings, data);

        // Apply theme toggles from power user settings
        applyPowerUserSettings();

        // Load character tags
        await loadTagsSettings();

        // Load background
        loadBackgroundSettings(settings);

        // Load proxy presets
        loadProxyPresets(settings);

        // Allow subscribers to mutate settings
        await eventSource.emit(event_types.SETTINGS_LOADED_AFTER, settings);

        // Set context size after loading power user (may override the max value)
        $('#max_context').val(max_context);
        $('#max_context_counter').val(max_context);

        $('#amount_gen').val(amount_gen);
        $('#amount_gen_counter').val(amount_gen);

        //Load which API we are using
        if (settings.main_api == undefined) {
            settings.main_api = 'kobold';
        }

        if (settings.main_api == 'poe') {
            settings.main_api = 'openai';
        }

        setMainApi(settings.main_api);
        $('#main_api').val(main_api);
        $(`#main_api option[value=${main_api}]`).attr('selected', 'true');
        changeMainAPI();

        //Load User's Name and Avatar
        initUserAvatar(settings.user_avatar);
        setPersonaDescription();

        //Load the active character and group
        setActiveCharacterAndGroupFromSettings(settings.active_character, settings.active_group);

        setWorldInfoSettings(settings.world_info_settings ?? settings, data);

        selected_button = settings.selected_button;

        // TODO: Move me into firstLoadInit when experimental toggle is removed
        // power_user.experimental_macro_engine
        initMacros();

        onStageChange?.('Activating extensions');

        if (data.enable_extensions) {
            const enableAutoUpdate = Boolean(data.enable_extensions_auto_update);
            const isVersionChanged = settings.currentVersion !== currentVersion;
            await loadExtensionSettings(settings, isVersionChanged, enableAutoUpdate);
            await eventSource.emit(event_types.EXTENSION_SETTINGS_LOADED);
        } else {
            Object.assign(extension_settings, (settings.extension_settings ?? {}));
            $('#third_party_extension_button').addClass('disabled');
            $('#extensions_details').addClass('disabled');
            $('#extensions_connect').addClass('disabled');
            $('#extensions_notify_updates').attr('disabled', 'disabled');
            $('#extensions_autoconnect').attr('disabled', 'disabled');
            $('#extensions_url').attr('disabled', 'disabled');
            $('#extensions_api_key').attr('disabled', 'disabled');
        }

        firstRun = !!settings.firstRun;

        if (firstRun) {
            await initLoaderHandle?.hide();
            await doOnboarding(user_avatar);
            firstRun = false;
            saveSettingsDebounced('firstRun');
            onboarded = true;
        }
    }
    await validateDisabledSamplers();

    // Seeds the dirty-check baseline so the first saveSettings() doesn't re-write the exact payload it just received.
    // Not after onboarding: its changes aren't in that payload, and a baseline that included them would skip their save.
    if (!onboarded) {
        const bootPayload = JSON.stringify({
            firstRun: firstRun,
            currentVersion: currentVersion,
            username: name1,
            active_character: active_character,
            active_group: active_group,
            user_avatar: user_avatar,
            amount_gen: amount_gen,
            max_context: max_context,
            main_api: main_api,
            world_info_settings: getWorldInfoSettings(),
            textgenerationwebui_settings: textgen_settings,
            swipes: swipes,
            horde_settings: horde_settings,
            power_user: power_user,
            extension_settings: extension_settings,
            nai_settings: nai_settings,
            kai_settings: kai_settings,
            oai_settings: oai_settings,
            background: background_settings,
            proxies: proxies,
            selected_proxy: selected_proxy,
        });
        lastSavedSettingsHash = getStringHash(bootPayload);
    }

    settingsReady = true;
    await eventSource.emit(event_types.SETTINGS_LOADED);
}

//MARK: saveSettings()
/**
 * Saves settings now. A string first argument is a keyed partial save of the string arguments;
 * anything else (a number, or no argument) is a full save, which also includes any pending keys.
 * @param {number|string} [loopCounter] Retry count of a full save, or the first key of a keyed save.
 * @param {...string} keys Further settings keys to save.
 */
export async function saveSettings(loopCounter, ...keys) {
    noteTagExportsMayHaveChanged();
    const save = readSettingsSaveArgs(loopCounter, keys);
    // This save sends the pending keys, leaving a keyed window nothing to send; a full window must still run.
    if (!save.full && !_settingsSaveWindow.full) {
        // debounce()'s returned function has no .cancel of its own; cancelDebounce() finds it via the WeakMap.
        cancelDebounce(_debouncedSaveImpl);
        _settingsSaveWindow = { full: false, count: 0 };
    }
    return runSettingsSave(save);
}

/**
 * Marks the string keys pending and returns the save's kind and count.
 * A non-string first argument is the count as passed, so the retry compares it exactly as saveSettings(loopCounter = 0) would.
 * @param {any} loopCounter The first argument.
 * @param {any[]} keys The remaining arguments.
 * @returns {{ full: boolean, count: any }}
 */
function readSettingsSaveArgs(loopCounter, keys) {
    const keyed = typeof loopCounter === 'string';
    for (const key of keyed ? [loopCounter, ...keys] : keys) {
        if (typeof key === 'string') pendingSettingsKeys.add(key);
    }
    return { full: !keyed, count: keyed || loopCounter === undefined ? 0 : loopCounter };
}

/**
 * A rescheduled save keeps its kind, and a keyed save's keys stay pending for it.
 * @param {{ full: boolean, count: any }} save The save's kind and count.
 */
async function runSettingsSave({ full, count }) {
    if (!settingsReady) {
        console.warn('Settings not ready, scheduling another save');
        scheduleSettingsSave({ full, count: 0 });
        return;
    }

    const MAX_RETRIES = 3;
    if (TempResponseLength.isCustomized()) {
        if (count < MAX_RETRIES) {
            console.warn('Response length is currently being overridden, scheduling another save');
            scheduleSettingsSave({ full, count: ++count });
            return;
        }
        console.error('Response length is currently being overridden, but the save loop has reached the maximum number of retries');
        TempResponseLength.restore(null);
    }

    // Upstream's settings save stores `tags`; here what an extension changed in it goes out as its own requests.
    storeTagChangesMadeThroughExport();

    // Queue behind any save already in flight, so overlapping calls can't race on a stale serverKeyHashes snapshot.
    const run = () => performSave({ full });
    const queued = _saveQueue.then(run, run);
    _saveQueue = queued.catch(() => {});
    return queued;
}

/**
 * The body of a save, pulled out so it can be queued behind _saveQueue instead of running concurrently.
 * @param {{ full: boolean }} save A full save includes the pending keys in its blob; a keyed save sends only them.
 */
async function performSave({ full }) {
    // Drain accumulated keys before the async gap - anything added after this point belongs to the next save.
    const dirtyKeys = full ? null : [...pendingSettingsKeys];
    pendingSettingsKeys.clear();
    // An earlier save already sent this keyed save's keys; it must not become a full save.
    if (dirtyKeys && dirtyKeys.length === 0) {
        return;
    }

    const payload = {
        firstRun: firstRun,
        currentVersion: currentVersion,
        username: name1,
        active_character: active_character,
        active_group: active_group,
        user_avatar: user_avatar,
        amount_gen: amount_gen,
        max_context: max_context,
        main_api: main_api,
        world_info_settings: getWorldInfoSettings(),
        textgenerationwebui_settings: textgen_settings,
        swipes: swipes,
        horde_settings: horde_settings,
        power_user: power_user,
        extension_settings: extension_settings,
        nai_settings: nai_settings,
        kai_settings: kai_settings,
        oai_settings: oai_settings,
        background: background_settings,
        proxies: proxies,
        selected_proxy: selected_proxy,
    };

    const payloadString = JSON.stringify(payload);
    const payloadHash = getStringHash(payloadString);

    if (dirtyKeys) {
        // Partial save path: send only the keys that were explicitly marked dirty.
        const partialPayload = {};
        for (const key of dirtyKeys) {
            if (key.includes('.')) {
                // Dotted path: extract just the addressed sub-field from the payload.
                const topLevel = key.split('.')[0];
                if (topLevel in payload) {
                    // Skip undefined: JSON.stringify would drop it while it still asserted an absence in expectedHashes.
                    const value = getAtPath(payload, key);
                    if (value !== undefined) {
                        partialPayload[key] = value;
                    }
                }
            } else if (key in payload && payload[key] !== undefined) {
                partialPayload[key] = payload[key];
            }
        }

        if (Object.keys(partialPayload).length === 0) {
            return;
        }

        // A key with no cached hash was never observed by this client - omit it rather than assert a fabricated 0.
        const expectedHashes = {};
        for (const key of Object.keys(partialPayload)) {
            if (key in serverKeyHashes) {
                expectedHashes[key] = serverKeyHashes[key];
            }
        }

        try {
            const result = await fetch('/api/settings/save-partial', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ keys: partialPayload, expectedHashes }),
                cache: 'no-cache',
            });

            if (result.status === 409) {
                const data = await result.json().catch(() => ({}));
                console.warn('Partial settings save rejected, conflicting keys:', data.conflictingKeys);
                toastr.warning(t`Settings were changed in another tab or device. Refreshing - please reapply your change.`, t`Settings save rejected`);
                await getSettings(null, null, { force: true });
                return;
            }

            if (!result.ok) {
                throw new Error(`Failed to save partial settings: ${result.statusText}`);
            }

            for (const key of Object.keys(partialPayload)) {
                seedKeyHashes(serverKeyHashes, partialPayload[key], key);
            }
            // Not lastSavedSettingsHash: it only ever means "this exact full payload reached the server", and a keyed save sent only part of it.
            // Server-returned hash keeps knownServerSettingsHash in sync without a full copy of the settings content.
            const partialSaveResponse = await result.json().catch(() => ({}));
            if (partialSaveResponse.settingsHash != null) {
                knownServerSettingsHash = partialSaveResponse.settingsHash;
            }
            await eventSource.emit(event_types.SETTINGS_UPDATED);
        } catch (error) {
            console.error('Error saving settings:', error);
            toastr.error(t`Check the server connection and reload the page to prevent data loss.`, t`Settings could not be saved`);
        }
    } else {
        // Full save path (backward compat for callers that didn't specify keys).
        // Keyed saves skip this check: the hash only means "this exact full payload reached the server".
        if (payloadHash === lastSavedSettingsHash) {
            return;
        }
        try {
            const headers = getRequestHeaders();
            if (knownServerSettingsHash !== null) {
                headers['X-Settings-Hash'] = String(knownServerSettingsHash);
            }
            const saveSettingsRequest = await compressRequest({
                method: 'POST',
                headers: headers,
                body: payloadString,
                cache: 'no-cache',
            });
            const result = await fetch('/api/settings/save', saveSettingsRequest);

            if (result.status === 409) {
                console.warn('Settings save rejected: local view of settings was stale, refreshing from server.');
                toastr.warning(t`Settings were changed in another tab or device. Refreshing - please reapply your change.`, t`Settings save rejected`);
                await getSettings(null, null, { force: true });
                return;
            }

            if (!result.ok) {
                throw new Error(`Failed to save settings: ${result.statusText}`);
            }

            // Update per-key hashes from the full payload (recursively - see seedKeyHashes()).
            seedKeyHashes(serverKeyHashes, payload);
            lastSavedSettingsHash = payloadHash;
            // Server-returned hash, not a local JSON.stringify(payload) computation.
            const saveResponse = await result.json().catch(() => ({}));
            if (saveResponse.settingsHash != null) {
                knownServerSettingsHash = saveResponse.settingsHash;
            }
            await eventSource.emit(event_types.SETTINGS_UPDATED);
        } catch (error) {
            console.error('Error saving settings:', error);
            toastr.error(t`Check the server connection and reload the page to prevent data loss.`, t`Settings could not be saved`);
        }
    }
}

//MARK: savePartialSettings()
/**
 * Sends only the given top-level settings keys to be merged into settings.json, instead of the full blob saveSettings() sends.
 * Conflict check is per-key (via serverKeyHashes), not saveSettings()'s whole-file hash - two concurrent updates to disjoint keys can both succeed.
 * @param {Record<string, unknown>} partialSettings Top-level settings keys to merge; only these keys change.
 * @returns {Promise<boolean>} True if the update was applied, false if it was rejected due to a conflict.
 */
export async function savePartialSettings(partialSettings) {
    const keys = Object.keys(partialSettings).filter(key => partialSettings[key] !== undefined);
    if (!keys.length) return true;
    const expectedHashes = {};
    for (const key of keys) {
        if (key in serverKeyHashes) {
            expectedHashes[key] = serverKeyHashes[key];
        }
    }

    const result = await fetch('/api/settings/save-partial', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ keys: partialSettings, expectedHashes }),
        cache: 'no-cache',
    });

    if (result.status === 409) {
        const data = await result.json().catch(() => ({}));
        // Refetch and let the caller/user redo the change, rather than risk re-clobbering the other session's write.
        console.warn('Partial settings save rejected, conflicting keys:', data.conflictingKeys);
        toastr.warning(t`Settings were changed in another tab or device. Refreshing - please reapply your change.`, t`Settings save rejected`);
        await getSettings(null, null, { force: true });
        return false;
    }

    if (!result.ok) {
        throw new Error(`Failed to save partial settings: ${result.statusText}`);
    }

    for (const key of Object.keys(partialSettings)) {
        seedKeyHashes(serverKeyHashes, partialSettings[key], key);
    }
    return true;
}

/**
 * Sets the generation parameters from a preset object.
 * @param {{ genamt?: number, max_length?: number }} preset Preset object
 */
export function setGenerationParamsFromPreset(preset) {
    const needsUnlock = (preset.max_length ?? max_context) > MAX_CONTEXT_DEFAULT || (preset.genamt ?? amount_gen) > MAX_RESPONSE_DEFAULT;
    $('#max_context_unlocked').prop('checked', needsUnlock).trigger('change');

    if (preset.genamt !== undefined) {
        setAmountGen(preset.genamt);
        $('#amount_gen').val(amount_gen);
        $('#amount_gen_counter').val(amount_gen);
    }

    if (preset.max_length !== undefined) {
        setMaxContext(preset.max_length);
        $('#max_context').val(max_context);
        $('#max_context_counter').val(max_context);
    }
}

// Common code for message editor done and auto-save
function applyMessageEdit(div) {
    const mesBlock = div.closest('.mes_block');
    let text = mesBlock.find('.edit_textarea').val()
        ?? mesBlock.find('.mes_text').text();
    const mesElement = div.closest('.mes');
    const mesId = Number(mesElement.attr('mesid'));
    let mes = chat[mesId];

    // editing old messages — ensure extra exists via immutable update if needed
    if (!mes.extra || typeof mes.extra !== 'object') {
        updateMessage(mesId, { extra: {} });
        mes = chat[mesId];
    }

    let regexPlacement;
    if (mes?.is_user) {
        regexPlacement = regex_placement.USER_INPUT;
    } else if (mes.extra?.type === 'narrator') {
        regexPlacement = regex_placement.SLASH_COMMAND;
    } else {
        regexPlacement = regex_placement.AI_OUTPUT;
    }

    // Ignore character override if sent as system
    text = getRegexedString(
        text,
        regexPlacement,
        {
            characterOverride: mes.extra?.type === 'narrator' ? undefined : mes.name,
            isEdit: true,
        },
    );


    if (power_user.trim_spaces) {
        text = text.trim();
    }

    const bias = substituteParams(extractMessageBias(text));
    text = substituteParams(text);
    if (bias) {
        text = removeMacros(text);
    }

    const editUpdates = { mes: text };
    if (mes.swipe_id !== undefined) {
        ensureSwipes(mes, mesId);
        const newSwipes = [...mes.swipes];
        newSwipes[mes.swipe_id] = text;
        editUpdates.swipes = newSwipes;
    }

    // Set bias on extra (must be included in the same updateMessage call since extra is frozen)
    const biasValue = (mes?.is_system || mes?.is_user || mes.extra?.type === system_message_types.NARRATOR)
        ? (bias ?? null) : null;
    editUpdates.extra = { ...(mes.extra || {}), bias: biasValue };

    updateMessage(mesId, editUpdates);
    mes = chat[mesId];
    syncMesToSwipe(mesId);

    chat_metadata.tainted = true;

    return { mesBlock, text, mes, bias };
}

function openMessageDelete(fromSlashCommand, deleteToolCalls = true) {
    closeMessageEditor();
    hideSwipeButtons();
    if (fromSlashCommand || (!is_send_press) || (selected_group && !is_group_generating)) {
        $('#dialogue_del_mes').css('display', 'block');
        $('#send_form').css('display', 'none');
        $('.del_checkbox').each(function () {
            $(this).css('display', 'grid');
            $(this).parent().children('.for_checkbox').css('display', 'none');
        });
    } else {
        console.debug(`
            ERR -- could not enter del mode
            this_avatar: ${this_avatar}
            is_send_press: ${is_send_press}
            selected_group: ${selected_group}
            is_group_generating: ${is_group_generating}`);
    }
    this_del_mes = -1;
    deleteToolCallsInDeleteMode = deleteToolCalls;
    is_delete_mode = true;
}

// A single shared debounce instance is fine: only one message is ever in edit mode at a time
// (this_edit_mes_id). messageEditDone() cancels this before its own save to avoid a double write.
const messageEditAutoSaveDebounced = debounce((mesId) => {
    chatOpEdit(mesId).catch(error =>
        console.error('Could not save the edited message:', error));
}, DEFAULT_SAVE_EDIT_TIMEOUT);

function messageEditAuto(div) {
    const { mesBlock, text, mes, bias } = applyMessageEdit(div);

    mesBlock.find('.mes_text').val('');
    mesBlock.find('.mes_text').val(messageFormatting(
        text,
        this_edit_mes_chname,
        mes.is_system,
        mes.is_user,
        this_edit_mes_id,
        {},
        false,
    ));
    mesBlock.find('.mes_bias').empty();
    mesBlock.find('.mes_bias').append(messageFormatting(bias, '', false, false, -1, {}, false));
    messageEditAutoSaveDebounced(this_edit_mes_id);
}

/**
 * Create the message edit UI.
 * @param {number} editMessageId The ID of the message to edit
 */
export async function messageEdit(editMessageId) {
    const editMessage = chat[editMessageId];
    if (!editMessage) {
        console.warn(`Message with id ${editMessageId} not found in chat array.`);
        return;
    }

    const messageElement = chatElement.find(`.mes[mesid="${editMessageId}"]`);
    if (messageElement.length === 0) {
        console.warn(`Message element with id ${editMessageId} not found in DOM.`);
        return;
    }

    if (blockWhileFieldEditing()) {
        return;
    }

    this_edit_mes_id = editMessageId;
    this_edit_mes_chname = editMessage.name || (editMessage.is_user ? name1 : name2);

    refreshSwipeButtons();

    const chatScrollPosition = chatElement.scrollTop();
    const messageBlock = messageElement.find('.mes_block');
    const messageText = messageBlock.find('.mes_text');

    messageText.empty();
    messageBlock.find('.mes_buttons').css('display', 'none');
    messageBlock.find('.mes_edit_buttons').css('display', 'inline-flex');

    // Also edit reasoning, if it exists
    const reasoningEdit = messageBlock.find('.mes_reasoning_edit:visible');
    if (reasoningEdit.length > 0) {
        reasoningEdit.trigger('click');
    }

    const editTextArea = document.createElement('textarea');
    editTextArea.id = 'curEditTextarea';
    editTextArea.className = 'edit_textarea mdHotkeys';
    editTextArea.dataset.macros = '';
    messageText.append(editTextArea);

    const text = trimSpaces(editMessage.mes || '');
    const $editTextArea = $(editTextArea);
    $editTextArea.val(text);

    const cssAutofit = CSS.supports('field-sizing', 'content');
    if (!cssAutofit) {
        $editTextArea.height(0);
        $editTextArea.height(editTextArea.scrollHeight);
    }

    $editTextArea.trigger('focus');

    // Sets the cursor at the end of the text
    editTextArea.setSelectionRange(text.length, text.length);

    if (Number(this_edit_mes_id) === chat.length - 1) {
        chatElement.scrollTop(chatScrollPosition);
    }

    updateEditArrowClasses();
}

/**
 * Close the open message editor.
 * This deletes the user's unsaved changes.
 * @param {number} [messageId=this_edit_mes_id]
 */
async function messageEditCancel(messageId = this_edit_mes_id) {
    // Cancelling an overswipe's untyped blank slot removes it rather than leaving an empty alternative behind; anything stored stays.
    const editing = chat[messageId];
    if (_isBlankUnwrittenSwipe(editing) && Array.isArray(editing.swipes) && editing.swipes.length > 1) {
        const at = editing.swipe_id ?? 0;
        if (at === editing.swipes.length - 1) {
            const swipes = editing.swipes.slice(0, -1);
            const swipeInfo = Array.isArray(editing.swipe_info) ? editing.swipe_info.slice(0, -1) : undefined;
            const back = Math.max(0, at - 1);
            updateMessage(messageId, {
                swipes,
                ...(swipeInfo ? { swipe_info: swipeInfo } : {}),
                swipe_id: back,
            });
            syncSwipeToMes(messageId, back);
            // The blank truncated the view; giving up on it puts back what followed.
            await _restoreContinuation(messageId);
        }
    }

    let text = chat[messageId].mes;
    let thisMesDiv;
    // If this is the button then select it's parent. Otherwise, select by messageId.
    if (this?.classList?.contains('mes_edit_cancel')) {
        thisMesDiv = $(this).closest('.mes');
    } else {
        thisMesDiv = chatElement.children('.mes').filter(`[mesid="${messageId}"]`);
    }

    const thisMesBlock = thisMesDiv.find('.mes_block');
    thisMesBlock.find('.mes_text').empty();
    thisMesDiv.find('.mes_edit_buttons').css('display', 'none');
    thisMesBlock.find('.mes_buttons').css('display', '');
    thisMesBlock.find('.mes_text')
        .append(messageFormatting(
            text,
            this_edit_mes_chname,
            chat[messageId].is_system,
            chat[messageId].is_user,
            messageId,
            {},
            false,
        ));
    appendMediaToMessage(chat[messageId], thisMesDiv);
    addCopyToCodeBlocks(thisMesDiv);

    const reasoningEditDone = thisMesBlock.find('.mes_reasoning_edit_cancel:visible');
    if (reasoningEditDone.length > 0) {
        reasoningEditDone.trigger('click');
    }

    await eventSource.emit(event_types.MESSAGE_UPDATED, messageId);
    if (messageId == this_edit_mes_id) {
        this_edit_mes_id = undefined;
    } else {
        console.warn(`The message editor was closed on message #${messageId} while #${this_edit_mes_id} is being edited.`);
    }

    showSwipeButtons();
}

/**
 * Swaps chat[sourceId] with chat[targetId]. They must be adjacent.
 * @param {number} sourceId Index of the message to move
 * @param {number} targetId Index of the target message
 * @returns {Promise<boolean>} True if the messages were moved, false otherwise
 */
async function messageEditMove(sourceId, targetId) {
    if (is_send_press) {
        console.warn(`The message #${sourceId} was not moved to #${targetId} because a generation is in progress.`);
        return false;
    }

    if (Math.abs(sourceId - targetId) !== 1) {
        console.error(`Message #${sourceId} and #${targetId} are not adjacent.`);
        return false;
    }

    const targetMessageDiv = chatElement.find(`.mes[mesid="${targetId}"]`);
    const sourceMessageDiv = chatElement.find(`.mes[mesid="${sourceId}"]`);

    if (sourceMessageDiv.length === 0 || targetMessageDiv.length === 0) {
        console.error(`Message #${sourceId} or #${targetId} were not found.`);
        return false;
    }

    if (sourceId <= targetId) {
        sourceMessageDiv.insertAfter(targetMessageDiv);
    } else {
        sourceMessageDiv.insertBefore(targetMessageDiv);
    }

    //Swap Ids.
    targetMessageDiv.attr('mesid', sourceId);
    sourceMessageDiv.attr('mesid', targetId);

    await chatOpSwapAdjacent(sourceId, targetId).catch(error =>
        console.error('Could not save the reordered messages:', error));

    // Update edited message id
    if (this_edit_mes_id === sourceId) {
        this_edit_mes_id = targetId;
    }

    swapItemizedPrompts(sourceId, targetId);
    updateViewMessageIds();
    refreshSwipeButtons();
    return true;
}

async function messageEditDone(div) {
    if (!(this_edit_mes_id >= 0)) {
        console.trace('this_edit_mes_id cannot be blank when calling messageEditDone.');
        return;
    }

    let { mesBlock, text, mes, bias } = applyMessageEdit(div);

    await eventSource.emit(event_types.MESSAGE_EDITED, this_edit_mes_id);
    text = chat[this_edit_mes_id]?.mes ?? text;
    mesBlock.find('.mes_text').empty();
    mesBlock.find('.mes_edit_buttons').css('display', 'none');
    mesBlock.find('.mes_buttons').css('display', '');
    mesBlock.find('.mes_text').append(
        messageFormatting(
            text,
            this_edit_mes_chname,
            mes.is_system,
            mes.is_user,
            this_edit_mes_id,
            {},
            false,
        ),
    );
    mesBlock.find('.mes_bias').empty();
    mesBlock.find('.mes_bias').append(messageFormatting(bias, '', false, false, -1, {}, false));
    appendMediaToMessage(mes, div.closest('.mes'));
    addCopyToCodeBlocks(div.closest('.mes'));

    const reasoningEditDone = mesBlock.find('.mes_reasoning_edit_done:visible');
    if (reasoningEditDone.length > 0) {
        reasoningEditDone.trigger('click');
    }

    await eventSource.emit(event_types.MESSAGE_UPDATED, this_edit_mes_id);
    const editedMesId = this_edit_mes_id;
    this_edit_mes_id = undefined;
    // Cancel a pending keystroke-driven autosave (messageEditAutoSaveDebounced) so it can't fire a
    // stale write after this call's own save lands.
    cancelDebounce(messageEditAutoSaveDebounced);
    // Says the edit directly rather than letting the fallback save infer it from a snapshot diff.
    // chatOpEdit() already retries transient failures itself (chat-store.js's _chatOpPost).
    try {
        await chatOpEdit(editedMesId);
    } catch (error) {
        console.error('Could not save the edited message:', error);
        toastr.error(t`Could not save the edited message. Check your connection and try again.`, t`Save failed`);
    }
    showSwipeButtons();
}

/**
 * Fetches the chat content for each chat file from the server and compiles them into a dictionary.
 * The function iterates over a provided list of chat metadata and requests the actual chat content
 * for each chat, either as an individual chat or a group chat based on the context.
 *
 * @param {Array} data - An array containing metadata about each chat such as file_name.
 * @param {boolean} isGroupChat - A flag indicating if the chat is a group chat.
 * @returns {Promise<Object>} chat_dict - A dictionary where each key is a file_name and the value is the
 * corresponding chat content fetched from the server.
 */
export async function getChatsFromFiles(data, isGroupChat) {
    let chat_dict = {};
    let chat_list = Object.values(data).sort((a, b) => a.file_name.localeCompare(b.file_name)).reverse();

    let chat_promise = chat_list.map(({ file_name }) => {
        return new Promise(async (res, rej) => {
            try {
                const endpoint = isGroupChat ? '/api/chats/group/get' : '/api/chats/get';
                const requestBody = isGroupChat
                    ? JSON.stringify({ id: file_name })
                    : JSON.stringify({
                        ch_name: getCurrentCharacter().name,
                        file_name: file_name.replace('.jsonl', ''),
                        avatar_url: getCurrentCharacter().avatar,
                    });

                const chatResponse = await fetch(endpoint, {
                    method: 'POST',
                    headers: getRequestHeaders(),
                    body: requestBody,
                    cache: 'no-cache',
                });

                if (!chatResponse.ok) {
                    return res();
                    // continue;
                }

                const currentChat = await chatResponse.json();
                if (!isGroupChat) {
                    // remove the first message, which is metadata, only for individual chats
                    currentChat.shift();
                }
                chat_dict[file_name] = currentChat;
            } catch (error) {
                console.error(error);
            }

            return res();
        });
    });

    await Promise.all(chat_promise);

    return chat_dict;
}

/**
 * Fetches the metadata of all past chats related to a specific character based on its avatar URL.
 * The function sends a POST request to the server to retrieve all chats for the character. It then
 * processes the received data, sorts it by the file name, and returns the sorted data.
 *
 * @param {null|string|number} [characterId=null] - An index into `getContext().characters`, or an avatar key.
 * When null or undefined, the current character.
 *
 * @returns {Promise<Array>} - An array containing metadata of all past chats of the character, sorted
 * in descending order by file name. Returns an empty array if the fetch request is unsuccessful or the
 * response is an object with an `error` property set to `true`.
 */
export async function getPastCharacterChats(characterId = null) {
    const character = resolveCharacterRef(characterId ?? this_avatar);
    if (!character) return [];

    const response = await fetch('/api/characters/chats', {
        method: 'POST',
        body: JSON.stringify({ avatar_url: character.avatar }),
        headers: getRequestHeaders(),
    });

    if (!response.ok) {
        return [];
    }

    const data = await response.json();
    if (typeof data === 'object' && data.error === true) {
        return [];
    }

    const chats = Object.values(data);
    return chats.sort((a, b) => a.file_name.localeCompare(b.file_name)).reverse();
}

/**
 * Helper for `displayPastChats`, to make the same info consistently available for other functions
 */
export function getCurrentChatDetails() {
    if (!getCurrentCharacter() && !selected_group) {
        return { sessionName: '', group: null, characterName: '', avatarImgURL: '' };
    }

    const group = selected_group ? groupsStore.get(selected_group) : null;
    const currentChat = selected_group ? group?.chat_id : getCurrentCharacter().chat;
    const displayName = selected_group ? group?.name : getCurrentCharacter().name;
    const avatarImg = selected_group ? group?.avatar_url : getThumbnailUrl('avatar', getCurrentCharacter().avatar);
    return { sessionName: currentChat, group: group, characterName: displayName, avatarImgURL: avatarImg };
}

/**
 * Displays the past chats for a character or a group based on the selected context.
 * The function first fetches the chats, processes them, and then displays them in
 * the HTML. It also has a built-in search functionality that allows filtering the
 * displayed chats based on a search query.
 * @param {string[]} hightlightNames - An array of chat names to highlight
 */
export async function displayPastChats(hightlightNames = []) {
    $('#select_chat_div').empty();
    $('#select_chat_search').val('').off('input');

    const chatDetails = getCurrentChatDetails();
    const currentChat = chatDetails.sessionName;
    const displayName = chatDetails.characterName;
    const avatarImg = chatDetails.avatarImgURL;

    await displayChats('', currentChat, displayName, avatarImg, selected_group, hightlightNames);

    const debouncedDisplay = debounce((searchQuery) => {
        displayChats(searchQuery, currentChat, displayName, avatarImg, selected_group, []);
    });

    // Define the search input listener
    $('#select_chat_search').off('input').on('input', function () {
        const searchQuery = $(this).val();
        debouncedDisplay(searchQuery);
    });

    // UX convenience: Focus the search field when the bookmark list opens.
    setTimeout(function () {
        const textSearchElement = $('#select_chat_search');
        textSearchElement.trigger('click').trigger('focus').trigger('select');
    }, 200);

    addChatBackupsBrowser();
}

async function displayChats(searchQuery, currentChat, displayName, avatarImg, selected_group, highlightNames) {
    try {
        const response = await fetch('/api/chats/search', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                query: searchQuery,
                avatar_url: selected_group ? null : getCurrentCharacter().avatar,
                group_id: selected_group || null,
            }),
        });

        if (!response.ok) {
            throw new Error('Search failed');
        }

        const filteredData = await response.json();
        // Resolved once and reused for every clone/append/scroll below, instead of re-running the selectors per iteration.
        const $chatDiv = $('#select_chat_div');
        const $chatTemplate = $('#past_chat_template .select_chat_block_wrapper');
        $chatDiv.empty();

        filteredData.sort((a, b) => sortMoments(timestampToMoment(a.last_mes), timestampToMoment(b.last_mes)));

        for (const chat of filteredData) {
            // The node_id identifies a chat uniquely; the name is only for display and the file-backed path.
            const isSelected = currentChat === chat.file_name || (!!chat.node_id && currentChat === chat.node_id);
            const template = $chatTemplate.clone();
            template.find('.select_chat_block').attr('file_name', chat.file_name);
            if (chat.node_id) {
                template.find('.select_chat_block').attr('node_id', chat.node_id);
            }
            template.find('.avatar img').attr('src', avatarImg);
            template.find('.select_chat_block_filename').text(chat.file_name);
            template.find('.chat_file_size').text(chat.file_size ? `(${chat.file_size},` : '(');
            template.find('.chat_messages_num').text(`${chat.message_count} 💬)`);
            template.find('.select_chat_block_mes').text(chat.preview_message);
            template.find('.PastChat_cross').attr('file_name', chat.file_name);
            if (chat.node_id) {
                template.find('.PastChat_cross').attr('node_id', chat.node_id);
                template.find('.renameChatButton').attr('node_id', chat.node_id);
            }
            template.find('.chat_messages_date').text(timestampToMoment(chat.last_mes).format('lll'));

            if (isSelected) {
                template.find('.select_chat_block').attr('highlight', String(true));
            }

            $chatDiv.append(template);

            if (Array.isArray(highlightNames) && highlightNames.includes(chat.file_name)) {
                const templateOffset = template.offset().top - template.parent().offset().top;
                $chatDiv.scrollTop(templateOffset);
                flashHighlight(template, debounce_timeout.extended);
            }
        }
    } catch (error) {
        console.error('Error loading chats:', error);
        toastr.error('Could not load chat data. Try reloading the page.');
    }
}

// Only pinnable drawers can stay open behind another drawer: opening or bringing forward a drawer closes every
// unpinned one (closeUnpinnedDrawersFor). With stacked drawers on (body.stackedDrawers), the drawer fronted last is
// on top and cuts away what it covers under it (drawer-stack.js); with it off, a pinned drawer stays visible under the
// front one.

// accountStorage keys holding whether each pinnable panel was open, so a reload can restore it.
const PANEL_OPEN_STATE_KEYS = {
    'right-nav-panel': 'NavOpened',
    'char-info-panel': 'CharInfoNavOpened',
    'left-nav-panel': 'LNavOpened',
    'WorldInfo': 'WINavOpened',
};
// Startup can open and close drawers before the saved state is read; recording is held off until then.
let panelOpenStatesRead = false;

/**
 * Reads which pinnable panels were open when the page was last left, and starts recording changes from here on.
 * @returns {Record<string, boolean>} Open state by panel id.
 */
export function readSavedPanelOpenStates() {
    const states = Object.fromEntries(Object.entries(PANEL_OPEN_STATE_KEYS).map(([id, key]) => [id, accountStorage.getItem(key) === 'true']));
    panelOpenStatesRead = true;
    return states;
}

/** After a drawer opens, closes or comes forward: recomputes the stack, records open panels, runs the shown hooks. */
function onDrawersChanged() {
    updateDrawerStack();
    if (panelOpenStatesRead) {
        for (const [id, key] of Object.entries(PANEL_OPEN_STATE_KEYS)) {
            accountStorage.setItem(key, String(Boolean(document.getElementById(id)?.classList.contains('openDrawer'))));
        }
    }
    onDrawerVisibilityChanged();
}

/** The character list and editor load what they show when they become visible, including by being uncovered. */
function onDrawerVisibilityChanged() {
    onCharacterEditorMaybeShown();
    onCharacterListMaybeShown();
}

function onCharacterListMaybeShown() {
    const showing = isCharacterListShowing();
    const becameShown = showing && !characterListWasShowing;
    characterListWasShowing = showing;
    if (!becameShown || characterListShowHandledByCaller) return;
    if (_charactersDirty) {
        syncDirtyCharacterList(false);
    } else {
        onCharacterListShown();
    }
}

/**
 * Puts a drawer on top of everything it overlaps. Every path that opens or re-fronts a drawer calls this.
 * @param {string} contentId The .drawer-content element's id.
 */
export function frontDrawer(contentId) {
    const content = document.getElementById(contentId);
    if (content) raiseDrawer(content);
    if (content?.classList.contains('fillRight')) {
        accountStorage.setItem('FillRightFront', contentId);
    }
    onDrawersChanged();
    autosizeTextareas(document.getElementById(contentId) ?? document);
}

function closeDrawerContent(content) {
    content.classList.replace('openDrawer', 'closedDrawer');
    onDrawersChanged();
}

/** @param {Element} content A .drawer-content. @returns {Element|null} Its navbar icon. */
function getDrawerIcon(content) {
    return content.parentElement?.querySelector(':scope > .drawer-toggle .drawer-icon') ?? null;
}

/**
 * Closes every unpinned open drawer other than `content`, as opening or bringing forward `content` requires.
 * With stacked drawers on, the two .fillRight panels coexist, so one never closes the other. With it off only one
 * right-side panel is open at a time: opening either .fillRight panel closes the other, pinned or not.
 * @param {Element} content The .drawer-content being opened or brought forward.
 * @returns {number} How many drawers were closed.
 */
function closeUnpinnedDrawersFor(content) {
    const isFillRight = content.classList.contains('fillRight');
    const stacked = Boolean(power_user.stacked_drawers);
    const ownIcon = getDrawerIcon(content);
    document.querySelectorAll('.openIcon:not(.drawerPinnedOpen)').forEach(el => {
        if (el === ownIcon || (isFillRight && stacked && el.classList.contains('fillRightIcon'))) return;
        el.classList.replace('openIcon', 'closedIcon');
    });
    let closed = 0;
    document.querySelectorAll('.openDrawer:not(.pinnedOpen)').forEach(el => {
        if (el === content || (isFillRight && stacked && el.classList.contains('fillRight'))) return;
        closeDrawerContent(el);
        closed++;
    });
    if (isFillRight && !stacked) {
        document.querySelectorAll('.fillRight.openDrawer.pinnedOpen').forEach(el => {
            if (el === content) return;
            getDrawerIcon(el)?.classList.replace('openIcon', 'closedIcon');
            closeDrawerContent(el);
            closed++;
        });
    }
    return closed;
}

/** With stacked drawers off, closes every open .fillRight panel but the front one. */
export function keepOneRightPanelOpen() {
    if (power_user.stacked_drawers) return;
    const open = Array.from(document.querySelectorAll('.fillRight.openDrawer'));
    if (open.length < 2) return;
    const front = frontmostOf(open);
    for (const el of open) {
        if (el === front) continue;
        getDrawerIcon(el)?.classList.replace('openIcon', 'closedIcon');
        closeDrawerContent(el);
    }
}

/**
 * Brings an already open drawer to the front. Every path that does so goes through here, so it closes
 * unpinned drawers exactly as opening would.
 * @param {Element} content The open .drawer-content.
 */
function bringOpenDrawerForward(content) {
    closeUnpinnedDrawersFor(content);
    frontDrawer(content.id);
}

function ensureDrawerOpen(drawerId) {
    const drawer = document.getElementById(drawerId);
    const content = drawer?.querySelector('.drawer-content');
    if (!content) return;
    if (content.classList.contains('openDrawer')) {
        bringOpenDrawerForward(content);
        return;
    }
    closeUnpinnedDrawersFor(content);
    content.classList.replace('closedDrawer', 'openDrawer');
    drawer.querySelector('.drawer-icon')?.classList.replace('closedIcon', 'openIcon');
    frontDrawer(content.id);
}

/**
 * Switches which menu is visible; hiding a menu here doesn't close it (only closeRightMenu() does).
 * @param {string} selectedMenuId The menu to show, e.g. 'rm_ch_create_block'.
 */
export function selectRightMenuWithAnimation(selectedMenuId) {
    const displayModes = {
        'rm_group_chats_block': 'flex',
        'rm_api_block': 'grid',
        'rm_characters_block': 'flex',
    };
    const normalizedId = selectedMenuId ? selectedMenuId.replace('#', '') : null;
    $('#result_info').toggle(normalizedId === 'rm_ch_create_block');
    // Only hide/show menus within the panel that contains the target menu, not the other panel's.
    const targetMenu = normalizedId ? document.getElementById(normalizedId) : null;
    const targetPanel = targetMenu?.closest('#right-nav-panel, #char-info-panel');
    if (targetPanel) {
        targetPanel.setAttribute('data-active-menu', normalizedId || '');
    }
    const charInfoMenus = ['rm_ch_create_block', 'rm_group_chats_block'];
    if (charInfoMenus.includes(normalizedId)) {
        ensureDrawerOpen('charInfoHolder');
    } else if (normalizedId === 'rm_characters_block') {
        ensureDrawerOpen('rightNavHolder');
    }
    // #right-nav-panel only has one real menu - it never needs the hide-all-then-show-one dance.
    if (targetPanel?.id === 'right-nav-panel') {
        const charBlock = document.getElementById('rm_characters_block');
        if (charBlock) {
            openRightMenu('rm_characters_block');
            $(charBlock).css('display', displayModes.rm_characters_block ?? 'flex');
        }
    }
    const panelSelector = targetPanel?.id === 'char-info-panel' ? '#char-info-panel .right_menu' : null;
    panelSelector && document.querySelectorAll(panelSelector).forEach((menu) => {
        $(menu).css('display', 'none');

        if (normalizedId && normalizedId === menu.id) {
            openRightMenu(normalizedId);
            const mode = displayModes[menu.id] ?? 'block';
            $(menu).css('display', mode);
            $(menu).css('opacity', 0.0);
            $(menu).transition({
                opacity: 1.0,
                duration: animation_duration,
                easing: animation_easing,
                complete: function () { },
            });
        }
    });
    onCharacterEditorMaybeShown();
}

export function select_rm_info(type, charId, previousCharId = null, displayName = null) {
    if (!type) {
        toastr.error(t`Invalid process (no 'type')`);
        return;
    }
    // charId is not a friendly display value (especially with uuidv7 file names); callers with the real name should pass displayName.
    if (type !== 'group_create' && displayName === null) {
        displayName = String(charId).replace('.png', '');
    }

    if (type === 'char_delete') {
        toastr.warning(t`Character Deleted: ${displayName}`);
    }
    if (type === 'char_create') {
        toastr.success(t`Character Created: ${displayName}`);
    }
    if (type === 'group_create') {
        toastr.success(t`Group Created`);
    }
    if (type === 'group_delete') {
        toastr.warning(t`Group Deleted`);
    }

    if (type === 'char_import') {
        toastr.success(t`Character Imported: ${displayName}`);
    }

    selectRightMenuWithAnimation('rm_characters_block');

    // Set a timeout so multiple flashes don't overlap
    clearTimeout(importFlashTimeout);
    importFlashTimeout = setTimeout(async function () {
        if (type === 'char_import' || type === 'char_create' || type === 'char_import_no_toast') {
            // Find the page at which the character is located
            const avatarFileName = charId;
            const perPage = Number(accountStorage.getItem('Characters_PerPage')) || per_page_default;
            const page = await findCharacterListPage((x) => x?.item?.avatar?.startsWith(avatarFileName), perPage);

            if (page === -1) {
                console.log(`Could not find character ${charId} in the list`);
                return;
            }

            try {
                const selector = `#rm_print_characters_block [title*="${avatarFileName}"]`;
                $('#rm_print_characters_pagination').pagination('go', page);

                waitUntilCondition(() => document.querySelector(selector) !== null).then(() => {
                    const element = $(selector).parent();

                    if (element.length === 0) {
                        console.log(`Could not find element for character ${charId}`);
                        return;
                    }

                    const scrollOffset = element.offset().top - element.parent().offset().top;
                    element.parent().scrollTop(scrollOffset);
                    flashHighlight(element, 5000);
                });
            } catch (e) {
                console.error(e);
            }
        }

        if (type === 'group_create') {
            // Find the page at which the group is located
            const perPage = Number(accountStorage.getItem('Characters_PerPage')) || per_page_default;
            const page = await findCharacterListPage((x) => x?.type === 'group' && String(x?.item?.id) === String(charId), perPage);

            if (page === -1) {
                console.log(`Could not find group ${charId} in the list`);
                return;
            }

            $('#rm_print_characters_pagination').pagination('go', page);
            const selector = `#rm_print_characters_block [grid="${charId}"]`;
            try {
                waitUntilCondition(() => document.querySelector(selector) !== null).then(() => {
                    const element = $(selector);
                    const scrollOffset = element.offset().top - element.parent().offset().top;
                    element.parent().scrollTop(scrollOffset);
                    flashHighlight(element, 5000);
                });
            } catch (e) {
                console.error(e);
            }
        }
    }, 250);

    if (previousCharId && charactersStore.has(previousCharId)) {
        setCharacterId(previousCharId);
    }
}

/**
 * Selects the right menu for displaying the character editor.
 * @param {string|number} chid An index into `getContext().characters`, or an avatar key
 * @param {object} [param1] Options for the switch
 * @param {boolean} [param1.switchMenu=true] Whether to switch the menu
 */
export function select_selected_character(chid, { switchMenu = true } = {}) {
    //character select
    const character = resolveCharacterRef(chid);
    if (character == null) {
        throw new TypeError(`select_selected_character: no character found for ${JSON.stringify(chid)}`);
    }
    const avatar = character?.avatar;
    select_rm_create({ switchMenu });
    switchMenu && setMenuType('character_edit');
    $('#delete_button').css('display', 'flex');
    $('#export_button').css('display', 'flex');

    //create text poles
    $('#rm_button_back').css('display', 'none');
    //$("#character_import_button").css("display", "none");
    $('#create_button').attr('value', 'Save');              // what is the use case for this?
    $('#dupe_button').show();
    $('#create_button_label').css('display', 'none');
    $('#char_connections_button').show();

    // Hide the chat scenario button if we're peeking the group member defs
    $('#set_chat_character_settings').toggle(!selected_group);

    // Don't update the navbar name if we're peeking the group member defs
    if (!selected_group) {
        $('#rm_button_selected_ch').children('h2').text(character.name);
    }

    $('#add_avatar_button').val('');

    $('#character_name_pole').val(characterFormValue(character, '#character_name_pole'));
    setFieldValue('description_textarea', characterFormValue(character, '#description_textarea'));
    $('#character_world').val(characterFormValue(character, '#character_world'));
    setFieldValue('creator_notes_textarea', characterFormValue(character, '#creator_notes_textarea'));
    $('#character_version_textarea').val(characterFormValue(character, '#character_version_textarea'));
    setFieldValue('system_prompt_textarea', characterFormValue(character, '#system_prompt_textarea'));
    setFieldValue('post_history_instructions_textarea', characterFormValue(character, '#post_history_instructions_textarea'));
    $('#tags_textarea').val(characterFormValue(character, '#tags_textarea'));
    $('#creator_textarea').val(characterFormValue(character, '#creator_textarea'));
    $('#character_version_textarea').val(characterFormValue(character, '#character_version_textarea'));
    setFieldValue('personality_textarea', characterFormValue(character, '#personality_textarea'));
    const greetingModel = cardToGreetingsModel(character);
    setGreetingPagerGreetings(greetingModel.greetings, greetingModel.defaultIndex, greetingModel.greetings.map(hashGreetingText));
    setFieldValue('scenario_pole', characterFormValue(character, '#scenario_pole'));
    setFieldValue('depth_prompt_prompt', characterFormValue(character, '#depth_prompt_prompt'));
    $('#depth_prompt_depth').val(characterFormValue(character, '#depth_prompt_depth'));
    $('#depth_prompt_role').val(characterFormValue(character, '#depth_prompt_role'));
    $('#talkativeness_slider').val(characterFormValue(character, '#talkativeness_slider'));
    setFieldValue('mes_example_textarea', characterFormValue(character, '#mes_example_textarea'));
    refreshCharInfoTabDimming();
    $('#selected_chat_pole').val(character.chat);
    setFormBaseline('#selected_chat_pole', String($('#selected_chat_pole').val()));
    $('#create_date_pole').val(timestampToMoment(character.create_date).toISOString());
    setFormBaseline('#create_date_pole', String($('#create_date_pole').val()));
    $('#avatar_url_pole').val(character.avatar);
    $('#chat_import_avatar_url').val(character.avatar);
    $('#chat_import_character_name').val(character.name);
    $('#character_json_data').val(character.json_data);
    setFormBaseline('#character_json_data', String($('#character_json_data').val()));
    $('#character_book_json').val(characterFormValue(character, '#character_book_json'));

    updateFavButtonState(normalizeFav(character.fav));

    const avatarUrl = character.avatar != 'none' ? getThumbnailUrl('avatar', character.avatar) : default_avatar;
    $('#avatar_load_preview').attr('src', avatarUrl);
    $('.open_alternate_greetings').data('avatar', character?.avatar ?? null);
    $('#set_character_world').data('avatar', character?.avatar ?? null);
    setWorldInfoButtonClass(avatar);
    checkEmbeddedWorld(avatar);

    $('#name_div').removeClass('displayBlock');
    $('#name_div').addClass('displayNone');
    $('#renameCharButton').css('display', '');

    $('#form_create').attr('actiontype', 'editcharacter');

    snapshotLoadedCharacterFieldHashes(character);
    $('.form_create_bottom_buttons_block .chat_lorebook_button').show();

    const externalMediaState = isExternalMediaAllowed();
    $('#character_open_media_overrides').toggle(!selected_group);
    $('#character_media_allowed_icon').toggle(externalMediaState);
    $('#character_media_forbidden_icon').toggle(!externalMediaState);

    // Update some stuff about the char management dropdown
    $('#character_source').attr('disabled', !getCharacterSource(character) ? '' : null);

    // An index is emitted as passed. The avatar and object forms emit `this_chid` only when they resolve to the
    // current character (`this_avatar`), and undefined otherwise, so a wrong index is never emitted.
    const editorOpenedChid = exposedCharacters[chid] !== undefined ? chid : (avatar === this_avatar ? this_chid : undefined);
    eventSource.emit(event_types.CHARACTER_EDITOR_OPENED, editorOpenedChid);

    // Only populates DOM fields from already-persisted data; nothing here needs saving.
}

/**
 * Selects the right menu for creating a new character.
 * @param {object} [options] Options for the switch
 * @param {boolean} [options.switchMenu=true] Whether to switch the menu
 */
function select_rm_create({ switchMenu = true } = {}) {
    // Must start before the editor is repopulated: a pending field save reads its conflict baseline
    // from the character currently loaded.
    void flushCharacterFieldSaves();
    switchMenu && setMenuType('create');

    //console.log('select_rm_Create() -- selected button: '+selected_button);
    if (selected_button == 'create' && create_save.avatar) {
        const addAvatarInput = /** @type {HTMLInputElement} */ ($('#add_avatar_button').get(0));
        addAvatarInput.files = create_save.avatar;
        read_avatar_load(addAvatarInput);
    }

    switchMenu && selectRightMenuWithAnimation('rm_ch_create_block');

    $('#set_chat_character_settings').hide();
    $('#delete_button_div').css('display', 'none');
    $('#delete_button').css('display', 'none');
    $('#export_button').css('display', 'none');
    $('#create_button_label').css('display', '');
    $('#create_button').attr('value', 'Create');
    $('#dupe_button').hide();
    $('#char_connections_button').hide();

    //create text poles
    $('#rm_button_back').css('display', '');
    $('#character_import_button').css('display', '');
    $('#character_name_pole').val(create_save.name);
    setFieldValue('description_textarea', create_save.description);
    $('#character_world').val(create_save.world);
    setFieldValue('creator_notes_textarea', create_save.creator_notes);
    setFieldValue('post_history_instructions_textarea', create_save.post_history_instructions);
    setFieldValue('system_prompt_textarea', create_save.system_prompt);
    $('#tags_textarea').val(create_save.tags);
    $('#creator_textarea').val(create_save.creator);
    $('#character_version_textarea').val(create_save.character_version);
    setFieldValue('personality_textarea', create_save.personality);
    const greetingModel = cardToGreetingsModel({ first_mes: create_save.first_message, data: { alternate_greetings: create_save.alternate_greetings, extensions: create_save.extensions } });
    setGreetingPagerGreetings(greetingModel.greetings, greetingModel.defaultIndex, greetingModel.greetings.map(hashGreetingText));
    $('#talkativeness_slider').val(create_save.talkativeness);
    setFieldValue('scenario_pole', create_save.scenario);
    setFieldValue('depth_prompt_prompt', create_save.depth_prompt_prompt);
    $('#depth_prompt_depth').val(create_save.depth_prompt_depth);
    $('#depth_prompt_role').val(create_save.depth_prompt_role);
    setFieldValue('mes_example_textarea', create_save.mes_example);
    refreshCharInfoTabDimming();
    autosizeTextareas(document.getElementById('form_create'));
    $('#character_json_data').val('');
    setFormBaseline('#character_json_data', String($('#character_json_data').val()));
    $('#character_book_json').val('');
    $('#avatar_div').css('display', 'flex');
    $('#avatar_load_preview').attr('src', default_avatar);
    $('#renameCharButton').css('display', 'none');
    $('#name_div').removeClass('displayNone');
    $('#name_div').addClass('displayBlock');
    $('.open_alternate_greetings').data('avatar', null);
    $('#set_character_world').data('avatar', null);
    updateCharacterWorldButton();
    updateFavButtonState(false);
    checkEmbeddedWorld();

    $('#form_create').attr('actiontype', 'createcharacter');
    _loadedCharacterFieldHashes.clear();
    _loadedCharacterFieldHashesAvatar = null;
    $('.form_create_bottom_buttons_block .chat_lorebook_button').hide();
    $('#character_open_media_overrides').hide();
}

function select_rm_characters() {
    const doFullRefresh = menu_type === 'characters';
    setMenuType('characters');
    // Both branches below re-query the list, so showing it here mustn't fetch it a second time.
    characterListShowHandledByCaller = true;
    try {
        selectRightMenuWithAnimation('rm_characters_block');
    } finally {
        characterListShowHandledByCaller = false;
    }
    if (_charactersDirty) {
        syncDirtyCharacterList(doFullRefresh);
    } else {
        printCharacters(doFullRefresh);
    }
}

/**
 * Runs the change sync that a change message arriving while the list was hidden left pending, and reprints the list.
 * @param {boolean} doFullRefresh Passed to printCharacters(): false keeps the list's page and scroll distance.
 */
function syncDirtyCharacterList(doFullRefresh) {
    _charactersDirty = false;
    if (hasActiveCharacterSearch()) {
        // Only the page fetch, without getCharacters()' extra search query.
        getCharacters({ skipPrint: true }).then(() => printCharacters(doFullRefresh));
    } else {
        getCharacters({ keepListPosition: !doFullRefresh });
    }
}

/**
 * Sets a prompt injection to insert custom text into any outgoing prompt. For use in UI extensions.
 * @param {string} key Prompt injection id.
 * @param {string} value Prompt injection value.
 * @param {number} position Insertion position. 0 is after story string, 1 is in-chat with custom depth.
 * @param {number} depth Insertion depth. 0 represets the last message in context. Expected values up to MAX_INJECTION_DEPTH.
 * @param {number} role Extension prompt role. Defaults to SYSTEM.
 * @param {boolean} scan Should the prompt be included in the world info scan.
 * @param {(function(): Promise<boolean>|boolean)} filter Filter function to determine if the prompt should be injected.
 */
export function setExtensionPrompt(key, value, position, depth, scan = false, role = extension_prompt_roles.SYSTEM, filter = null) {
    extension_prompts[key] = {
        value: String(value),
        position: Number(position),
        depth: Number(depth),
        scan: !!scan,
        role: Number(role ?? extension_prompt_roles.SYSTEM),
        filter: filter,
    };
}

/**
 * Gets a enum value of the extension prompt role by its name.
 * @param {string} roleName The name of the extension prompt role.
 * @returns {number} The role id of the extension prompt.
 */
export function getExtensionPromptRoleByName(roleName) {
    // If the role is already a valid number, return it
    if (typeof roleName === 'number' && Object.values(extension_prompt_roles).includes(roleName)) {
        return roleName;
    }

    switch (roleName) {
        case 'system':
            return extension_prompt_roles.SYSTEM;
        case 'user':
            return extension_prompt_roles.USER;
        case 'assistant':
            return extension_prompt_roles.ASSISTANT;
    }

    // Skill issue?
    return extension_prompt_roles.SYSTEM;
}

/**
 * Removes all char A/N prompt injections from the chat.
 * To clean up when switching from groups to solo and vice versa.
 */
export function removeDepthPrompts() {
    for (const key of Object.keys(extension_prompts)) {
        if (key.startsWith(inject_ids.DEPTH_PROMPT)) {
            delete extension_prompts[key];
        }
    }
}

/**
 * Adds or updates the metadata for the currently active chat.
 * @param {Object} newValues An object with collection of new values to be added into the metadata.
 * @param {boolean} reset Should a metadata be reset by this call.
 */
export function updateChatMetadata(newValues, reset) {
    setChatMetadata(reset ? { ...newValues } : { ...chat_metadata, ...newValues });
    if (reset) {
        // A wholesale replace (chat switch, import, group-chat metadata load) - the previous
        // save snapshot no longer describes what the server has for this metadata object.
        _resetMetadataSaveSnapshot();
    }
}


/**
 * Updates the state of the favorite button based on the provided state.
 * @param {boolean} state Whether the favorite button should be on or off.
 */
function updateFavButtonState(state) {
    // Update global state of the flag
    // TODO: This is bad and needs to be refactored.
    fav_ch_checked = state;
    $('#fav_checkbox').prop('checked', state);
    $('#favorite_button').toggleClass('fav_on', state);
    $('#favorite_button').toggleClass('fav_off', !state);
}

export async function setCharacterSettingsOverrides() {
    const selection = getSelectionState();
    if (selection.type !== 'group' && (selection.type !== 'character' || !getCurrentCharacter())) {
        console.warn('setCharacterSettingsOverrides() -- no selected group or character');
        return;
    }

    const scenarioOverrideValue = chat_metadata.scenario || '';
    const exampleMessagesValue = chat_metadata.mes_example || '';
    const systemPromptValue = chat_metadata.system_prompt || '';
    const isGroup = !!selected_group;

    const $template = $(await renderTemplateAsync('scenarioOverride'));
    $template.find('[data-group="true"]').toggle(isGroup);
    $template.find('[data-character="true"]').toggle(!isGroup);
    const pendingChanges = {
        scenario: scenarioOverrideValue,
        examples: exampleMessagesValue,
        system_prompt: systemPromptValue,
    };

    // Keep edits local until the popup is closed/confirmed
    const $scenario = $template.find('.chat_scenario');
    $scenario.val(scenarioOverrideValue).on('input', function () {
        pendingChanges.scenario = String($(this).val());
    });
    const $examples = $template.find('.chat_examples');
    $examples.val(exampleMessagesValue).on('input', function () {
        pendingChanges.examples = String($(this).val());
    });
    const $systemPrompt = $template.find('.chat_system_prompt');
    $systemPrompt.val(systemPromptValue).on('input', function () {
        pendingChanges.system_prompt = String($(this).val());
    });

    $template.find('.remove_scenario_override').on('click', async function () {
        const confirm = await Popup.show.confirm(t`Are you sure you want to remove all overrides?`, t`This action cannot be undone.`);
        if (!confirm) {
            return;
        }

        $scenario.val('');
        pendingChanges.scenario = '';
        $examples.val('');
        pendingChanges.examples = '';
        $systemPrompt.val('');
        pendingChanges.system_prompt = '';
    });

    // Wait for popup close/confirm.
    await callGenericPopup($template, POPUP_TYPE.TEXT, '', {
        wide: true,
        large: true,
        allowVerticalScrolling: true,
    });

    chat_metadata.scenario = pendingChanges.scenario;
    chat_metadata.mes_example = pendingChanges.examples;
    chat_metadata.system_prompt = pendingChanges.system_prompt;
    await saveMetadata();
}

/**
 * Displays a blocking popup with a given text and type.
 * @param {JQuery<HTMLElement>|string|Element} text - Text to display in the popup.
 * @param {string} type
 * @param {string} inputValue - Value to set the input to.
 * @param {PopupOptions} options - Options for the popup.
 * @typedef {{okButton?: string, rows?: number, wide?: boolean, wider?: boolean, large?: boolean, allowHorizontalScrolling?: boolean, allowVerticalScrolling?: boolean, cropAspect?: number }} PopupOptions - Options for the popup.
 * @returns {Promise<any>} A promise that resolves when the popup is closed.
 * @deprecated Use `callGenericPopup` instead.
 */
export function callPopup(text, type, inputValue = '', { okButton, rows, wide, wider, large, allowHorizontalScrolling, allowVerticalScrolling, cropAspect } = {}) {
    function getOkButtonText() {
        if (['text', 'char_not_selected'].includes(popup_type)) {
            $dialoguePopupCancel.css('display', 'none');
            return okButton ?? t`Ok`;
        } else if (['delete_extension'].includes(popup_type)) {
            return okButton ?? t`Ok`;
        } else if (['new_chat', 'confirm'].includes(popup_type)) {
            return okButton ?? t`Yes`;
        } else if (['input'].includes(popup_type)) {
            return okButton ?? t`Save`;
        }
        return okButton ?? t`Delete`;
    }

    dialogueCloseStop = true;
    if (type) {
        popup_type = type;
    }

    const $dialoguePopup = $('#dialogue_popup');
    const $dialoguePopupCancel = $('#dialogue_popup_cancel');
    const $dialoguePopupOk = $('#dialogue_popup_ok');
    const $dialoguePopupInput = $('#dialogue_popup_input');
    const $dialoguePopupText = $('#dialogue_popup_text');
    const $shadowPopup = $('#shadow_popup');

    $dialoguePopup.toggleClass('wide_dialogue_popup', !!wide)
        .toggleClass('wider_dialogue_popup', !!wider)
        .toggleClass('large_dialogue_popup', !!large)
        .toggleClass('horizontal_scrolling_dialogue_popup', !!allowHorizontalScrolling)
        .toggleClass('vertical_scrolling_dialogue_popup', !!allowVerticalScrolling);

    $dialoguePopupCancel.css('display', 'inline-block');
    $dialoguePopupOk.text(getOkButtonText());
    $dialoguePopupInput.toggle(popup_type === 'input').val(inputValue).attr('rows', rows ?? 1);
    $dialoguePopupText.empty().append(text);
    $shadowPopup.css('display', 'block');

    if (popup_type == 'input') {
        $dialoguePopupInput.trigger('focus');
    }

    $shadowPopup.transition({
        opacity: 1,
        duration: animation_duration,
        easing: animation_easing,
    });

    return new Promise((resolve) => {
        dialogueResolve = resolve;
    });
}

/**
 * Update the swipe counter for mesId.
 * By default, the swipe counter's opacity will appear greyed out. The opacity is changed with CSS.
 * @param {Number} mesId
 * @param {object} [options] Options
 * @param {ChatMessage} [options.message=undefined] Swipe numbers from this message will be used instead of mesId.
 * @param {JQuery<HTMLElement>} [options.messageElement=undefined] Target Element. Passing in the message's element will save a DOM query.
 */
export async function updateSwipeCounter(mesId, { message = undefined, messageElement = undefined } = {}) {
    message ??= chat[mesId];
    messageElement ??= chatElement.children('.mes').filter(`[mesid="${mesId}"]`);

    //If the message does not have swipes, create them.
    if (ensureSwipes(message, mesId)) {
        syncMesToSwipe(mesId);
    }

    const currentNum = (message?.swipe_id ?? 0) + 1;
    const totalNum = message?.swipes?.length ?? 1;
    const swipeCounter = messageElement.find('.swipes-counter');
    const swipePickerButton = messageElement.find('.mes_swipe_picker');
    const canOpenSwipePicker = canOpenSwipePickerForMessage(mesId);
    const canJumpToSwipe = canJumpToSwipeForMessage(mesId);

    swipeCounter.text(formatSwipeCounter(currentNum, totalNum));

    swipeCounter
        .prop('hidden', false)
        .toggleClass('swipe-picker-enabled', canOpenSwipePicker)
        .toggleClass(INTERACTABLE_CONTROL_CLASS, canOpenSwipePicker)
        .attr('role', canOpenSwipePicker ? 'button' : null)
        .attr('title', canJumpToSwipe ? t`Click to jump to a swipe` : canOpenSwipePicker ? t`Click to view swipe history` : null);
    swipePickerButton.toggle(canOpenSwipePicker);

    if (!canOpenSwipePicker) {
        swipeCounter.removeAttr('tabindex');
    }
}

/**
 * Returns true if messages are generally swipeable.
 * @returns {boolean}
 */
export function isSwipingAllowed() {
    return (
        //Swipe cannot be called on an empty chat.
        chat.length !== 0 &&
        //The swipes setting must be enabled, and swipes can't be hidden.
        swipes && !swipesHidden &&
        //Cannot swipe while generating.
        !isGenerating() &&
        //If mid-swipe, the message cannot be swiped.
        swipeState === SWIPE_STATE.NONE
    );
}

/**
 * Returns true if the message is swipeable.
 * This does not check if messages are generally swipeable. See isSwipingAllowed().
 * This does not check if the swipes exist or are valid.
 * @param {number} messageId The message Id to check.
 * @param {ChatMessage} [message=undefined] If undefined, then the message checks will be skipped.
 * @returns {boolean}
 */
export function isMessageSwipeable(messageId, message = undefined) {
    message ??= chat[messageId];

    //If the message does not have swipes, create them.
    if (ensureSwipes(message, messageId)) {
        syncMesToSwipe(messageId);
    }

    if (
        //Only messages below the currently edited message can be swiped, if it's not mid-swipe edit.
        ((messageId > (this_edit_mes_id ?? -1)) && (swipeState != SWIPE_STATE.EDITING)) &&

        //Any message can be swiped now, not just the last - each carries its own sibling set (see getOverswipeBehavior() for the generate-on-overswipe rule).
        (message &&
            //Small system messages cannot be swiped.
            !(message?.extra?.isSmallSys) &&
            //Some messages, like the welcome screen, are not swipeable.
            !(message?.extra?.swipeable === false)
        )
    ) {
        // The message is swipeable.
        return true;
    } else {
        // The message is not swipeable.
        return false;
    }
}

/**
 * Returns the message's behavior when swiped past it's last branch.
 * This does not check if the message can currently be swiped. See isMessageSwipeable().
 * This does not check if messages are generally swipeable. See isSwipingAllowed().
 * This does not check if the swipes exist or are valid.
 * @param {number} messageId The message Id to check.
 * @param {ChatMessage} [message=undefined] If defined, this will be used instead of chat[messageId].
 * @returns {OVERSWIPE_BEHAVIOR}
 */
export function getOverswipeBehavior(messageId, message = undefined) {
    message ??= chat[messageId];

    // Every branch below is a property of the message, not of where it sits - generating mid-conversation just forks a new sibling.
    const isGreeting = messageId === 0;

    //Do not override explicitly set overswipe_behavior.
    if (typeof message?.extra?.overswipe_behavior == 'string') return message.extra.overswipe_behavior;
    //Some messages, like the welcome screen, are not swipeable.
    else if (message?.extra?.swipeable === false) return OVERSWIPE_BEHAVIOR.NONE;
    //Small System messages can't be swiped.
    else if (message?.extra?.isSmallSys) return OVERSWIPE_BEHAVIOR.NONE;
    //Greetings are user-authored card data, never LLM output, so overswiping one opens the editor instead of generating.
    else if (isGreeting) return OVERSWIPE_BEHAVIOR.EDIT_GENERATE;
    //Non-user and non-prompt hidden messages will regenerate.
    else if (!message?.is_user && !message?.is_system) return OVERSWIPE_BEHAVIOR.REGENERATE;
    //User messages will open the editor on a new, empty swipe.
    else if (message?.is_user) return OVERSWIPE_BEHAVIOR.EDIT_GENERATE;
    //By default, all other messages will loop. Their swipe chevrons will only be shown if there is more than one swipe.
    else { return OVERSWIPE_BEHAVIOR.LOOP; }
}

/**
 * Refreshes all swipe buttons and updates their swipe counters.
 * This has been optimized for bulk updates by minimizing DOM queries.
 * @param {boolean} updateCounters When true, the swipe counters will also be updated. Typically redundant because addOneMessage updates the counters.
 * @param {boolean} fade By default, the chevrons fade in and out.
 * @returns
 */
export function refreshSwipeButtons(updateCounters = false, fade = true) {
    //Never show swipe buttons on an empty chat.
    if (chat?.length === 0) return false;

    //If swipes are disabled or hidden, hide all swipe buttons.
    if (!isSwipingAllowed()) {
        $('body').addClass('hideAllSwipeButtons');
        return;
        //Don't hide all swipe buttons.
    } else {
        //CSS will hide all messages.
        $('body').removeClass('hideAllSwipeButtons');
    }
    //Non-messages can appear in chat. '.mes' is required.
    const messageElements = chatElement.children('.mes[mesid]');

    const firstDisplayedMesId = Number(messageElements.first().attr('mesid'));

    //Group each message.
    messageElements.each((index, div) => {
        //This assumes the messages are in order and their Id's are accurate.
        const messageId = firstDisplayedMesId + index;
        //Number($(div).attr('mesid')); Would not misscount due to a missing div, but is much slower.

        const message = chat[messageId];

        //Chevrons should not fade-in during printMessages. //https://github.com/SillyTavern/SillyTavern/pull/4712#issuecomment-3539315919
        div.classList.toggle('fade', fade);

        if (isMessageSwipeable(messageId, message)) {
            //If a right swipe would trigger a generation or loop to the first swipe.
            const isLastSwipe = (message?.swipes?.length ?? 1) - 1 <= (message?.swipe_id ?? 0);
            const hasSwipes = (message?.swipes?.length > 1);
            const overswipe = getOverswipeBehavior(messageId, message);
            const swipePickerButton = $(div).find('.mes_swipe_picker');
            const canOpenSwipePicker = canOpenSwipePickerForMessage(messageId);

            //The swipe button will be shown if an overswipe would trigger REGENERATE or EDIT_GENERATE.
            const isOverswipeable = isLastSwipe &&
                overswipe == OVERSWIPE_BEHAVIOR.REGENERATE ||
                overswipe == OVERSWIPE_BEHAVIOR.EDIT_GENERATE;

            div.classList.toggle('last_swipe', isOverswipeable);

            //Shown for a single swipe too when an overswipe is still meaningful (e.g. a single-greeting card can still add a second).
            div.classList.toggle('swipes_visible', hasSwipes || isOverswipeable);
            swipePickerButton.toggle(canOpenSwipePicker);

            //updateSwipeCounter does not need to be awaited, It can run a bit later.
            if (updateCounters) updateSwipeCounter(messageId, { message, messageElement: $(div) });
        } else {
            //Hide all messages that are not swipeable.
            div.classList.remove('swipes_visible', 'last_swipe');
            $(div).find('.mes_swipe_picker').toggle(canOpenSwipePickerForMessage(messageId));
        }
    });
}
/**
 * This function is misleadingly named. It allows generation then refreshes the swipe buttons and counters.
 */
export function showSwipeButtons() {
    swipesHidden = false;
    refreshSwipeButtons();
}

/**
 * This function is misleadingly named. It blocks generation then refreshes the swipe buttons and counters.
 * @param {object} [options] Options
 * @param {boolean} [options.hideCounters=false] Also hide the swipes counter.
 */
export function hideSwipeButtons({ hideCounters = false } = {}) {
    swipesHidden = true;
    refreshSwipeButtons();

    if (hideCounters === true) {
        chatElement.find('.last_mes .swipes-counter').prop('hidden', true);
    }
}

/**
 * Deletes a swipe from the chat.
 *
 * @param {number?} [swipeId = null] - The ID of the swipe to delete. If not provided, the current swipe will be deleted.
 * @param {number?} [messageId = chat.length - 1] - The ID of the message to delete from. If not provided, the last message will be targeted.
 * @returns {Promise<number>|undefined} - The ID of the new swipe after deletion.
 */
export async function deleteSwipe(swipeId = null, messageId = chat.length - 1) {
    if (swipeId != null) {
        swipeId = Number(swipeId);
        if (!Number.isInteger(swipeId) || swipeId < 0) {
            toastr.warning(t`Invalid swipe ID.`);
            return;
        }
    }

    const message = chat[messageId];
    if (!message || !Array.isArray(message.swipes) || !message.swipes.length) {
        toastr.warning(t`No messages to delete swipes from.`);
        return;
    }

    if (message.swipes.length <= 1) {
        toastr.warning(t`Can't delete the last swipe.`);
        return;
    }

    swipeId = Number(swipeId ?? message.swipe_id);
    const currentSwipeId = clamp(Number(message.swipe_id ?? 0), 0, message.swipes.length - 1);

    if (swipeId < 0 || swipeId >= message.swipes.length) {
        toastr.warning(t`Invalid swipe ID: ${swipeId + 1}`);
        return;
    }

    // Clone arrays before splicing (originals are frozen)
    const newSwipes = [...message.swipes];
    newSwipes.splice(swipeId, 1);

    const newSwipeInfo = Array.isArray(message.swipe_info) ? [...message.swipe_info] : [];
    if (newSwipeInfo.length) {
        newSwipeInfo.splice(swipeId, 1);
    }

    let newSwipeId;
    if (swipeId < currentSwipeId) {
        newSwipeId = currentSwipeId - 1;
    } else if (swipeId > currentSwipeId) {
        newSwipeId = currentSwipeId;
    } else {
        // Select the next swipe, or the one before if it was the last one.
        newSwipeId = Math.min(swipeId, newSwipes.length - 1);
    }

    chat_metadata.tainted = true;

    messageId = Number(messageId);
    swipeId = Number(swipeId);

    // The shown-swipe branch below already persists the SELECTION change correctly via swipe() -> the
    // selection-change path — but until now it never deleted the old node's row afterward, leaving it
    // orphaned (deselected but still in the DB). Both branches need the deleted alternative's own
    // node_id read off `chat[]` BEFORE updateMessage() below replaces its swipe_info with the
    // already-spliced copy. For the shown case this is `message.node_id` itself (swipeId ===
    // currentSwipeId here, so it names the same node as `message.swipe_info[swipeId].node_id`) —
    // captured now because chatOpDeleteAlternativeNode() can only run AFTER swipe() moves the
    // selection off of it (deleteAlternative()'s own "is default" refusal, src/message-tree-db.js,
    // otherwise applies), by which point chat[messageId].node_id has already been overwritten.
    const isShownSwipe = swipeId === currentSwipeId;
    const deletedNodeId = isShownSwipe ? message.node_id : undefined;
    if (!isShownSwipe) {
        await chatOpDeleteAlternative(messageId, swipeId).catch(error =>
            console.error('Could not remove the deleted alternative from the tree:', error));
    }

    updateMessage(messageId, { swipe_id: newSwipeId, swipes: newSwipes, swipe_info: newSwipeInfo });
    await eventSource.emit(event_types.MESSAGE_SWIPE_DELETED, { messageId, swipeId, newSwipeId });

    if (isShownSwipe) {
        const direction = (swipeId <= newSwipeId) ? SWIPE_DIRECTION.RIGHT : SWIPE_DIRECTION.LEFT;
        // Animate swipe and swap displayed message when the currently visible swipe was deleted.
        await swipe(null, direction, { source: SWIPE_SOURCE.DELETE, repeated: false, forceMesId: messageId, forceSwipeId: newSwipeId });
        // Only now — after swipe() has (attempted to) move the selection to newSwipeId's node — is the
        // old node no longer the current default child. If swipe() bailed out early for any reason
        // (chat[messageId] is still on deletedNodeId), chatOpDeleteAlternativeNode() refuses locally
        // without a server round-trip, same as chatOpDeleteAlternative() does for the non-shown case.
        await chatOpDeleteAlternativeNode(deletedNodeId, chat[messageId]?.node_id).catch(error =>
            console.error('Could not remove the deleted alternative from the tree:', error));
    } else {
        await updateSwipeCounter(messageId);
        if (messageId !== chat.length - 1) {
            await updateSwipeCounter(chat.length - 1);
        }
        refreshSwipeButtons();
    }

    return newSwipeId;
}

/**
 * Saves the chat to the server.
 * @param {FormData} formData Form data to send to the server.
 * @param {object} [options={}] Options for the import
 * @param {boolean} [options.refresh] Whether to refresh the group chat list after import
 * @returns {Promise<string[]>} List of imported file names.
 */
export async function importCharacterChat(formData, { refresh = true } = {}) {
    const fetchResult = await fetch('/api/chats/import', {
        method: 'POST',
        body: formData,
        headers: getRequestHeaders({ omitContentType: true }),
        cache: 'no-cache',
    });

    if (fetchResult.ok) {
        const data = await fetchResult.json();
        if (data.res && refresh) {
            await displayPastChats();
        }
        return data?.fileNames || [];
    }

    return [];
}

export function updateViewMessageIds(startIndex = null) {
    const minId = startIndex ?? getFirstDisplayedMessageId();

    chatElement.find('.mes').each(function (index, element) {
        $(element).attr('mesid', minId + index);
        $(element).find('.mesIDDisplay').text(`#${minId + index}`);
    });

    chatElement.find('.mes').removeClass('last_mes');
    chatElement.find('.mes').last().addClass('last_mes');

    updateEditArrowClasses();
}

export function getFirstDisplayedMessageId() {
    const allIds = Array.from(document.querySelectorAll('#chat .mes')).map(el => Number(el.getAttribute('mesid'))).filter(x => !isNaN(x));
    const minId = Math.min(...allIds);
    return minId;
}

export function updateEditArrowClasses() {
    if (!(this_edit_mes_id >= 0)) {
        return;
    }

    const message = chatElement.children('.mes').filter(`.mes[mesid="${this_edit_mes_id}"]`);

    const downButton = message.find('.mes_edit_down');
    const upButton = message.find('.mes_edit_up');
    const copyButton = message.find('.mes_edit_copy');
    const deleteButton = message.find('.mes_edit_delete');
    const lastId = Number(chatElement.find('.mes').last().attr('mesid'));
    const firstId = Number(chatElement.find('.mes').first().attr('mesid'));

    copyButton.removeClass('disabled');
    deleteButton.removeClass('disabled');

    // The last message cannot be moved down.
    downButton.toggleClass('disabled', lastId === Number(this_edit_mes_id));
    // The first message cannot be moved up.
    upButton.toggleClass('disabled', firstId === Number(this_edit_mes_id));
}

/**
 * Closes the message editor.
 * @param {'message'|'reasoning'|'all'} what What to close. Default is 'all'.
 */
export function closeMessageEditor(what = 'all') {
    if (what === 'message' || what === 'all') {
        if (this_edit_mes_id >= 0) {
            chatElement.find(`.mes[mesid="${this_edit_mes_id}"] .mes_edit_cancel`).trigger('click');
        }
    }
    if (what === 'reasoning' || what === 'all') {
        document.querySelectorAll('.reasoning_edit_textarea').forEach((el) => {
            const cancelButton = el.closest('.mes')?.querySelector('.mes_reasoning_edit_cancel');
            if (cancelButton instanceof HTMLElement) {
                cancelButton.click();
            }
        });
    }
}

export function setGenerationProgress(progress) {
    if (!progress) {
        $('#send_textarea').css({ 'background': '', 'transition': '' });
    } else {
        $('#send_textarea').css({
            'background': `linear-gradient(90deg, #008000d6 ${progress}%, transparent ${progress}%)`,
            'transition': '0.25s ease-in-out',
        });
    }
}

export function cancelTtsPlay() {
    if ('speechSynthesis' in window) {
        speechSynthesis.cancel();
    }
}

function updateAlternateGreetingsHintVisibility(root) {
    const numberOfGreetings = root.find('.alternate_greetings_list .alternate_greeting').length;
    $(root).find('.alternate_grettings_hint').toggle(numberOfGreetings == 0);
}

async function openCharacterWorldPopup() {
    const avatar = $('#set_character_world').data('avatar');
    if (menu_type != 'create' && avatar === undefined) {
        toastr.error('Does not have an Id for this character in world select menu.');
        return;
    }

    const worldCharacter = charactersStore.get(avatar);

    // Explicit undefined when unresolved, distinct from getCharaFilename()'s own "no avatar given" fallback to the currently selected character.
    // TODO: Maybe make this utility function not use the window context?
    const fileName = worldCharacter ? getCharaFilename(avatar) : undefined;
    const charName = (menu_type == 'create' ? create_save.name : worldCharacter?.data?.name) || 'Nameless';
    const worldId = (menu_type == 'create' ? create_save.world : worldCharacter?.data?.extensions?.world) || '';
    // A name with no World file, on a card with its own embedded lorebook, links that embedded book.
    const linksEmbeddedBook = menu_type != 'create' && getCharacterWorldLink(worldCharacter) === character_world_link.EMBEDDED;
    const embeddedBookValue = 'embedded';
    // Any other name with no World file gets its own option too, so the link shows as set and choosing "None" clears it.
    const linksUnlistedName = worldId !== '' && !linksEmbeddedBook && !world_names.includes(worldId);
    const unlistedNameValue = 'unlisted';
    const template = $('#character_world_template .character_world').clone();
    template.find('.character_name').text(charName);

    // --- Event Handlers ---
    async function handlePrimaryWorldSelect() {
        const selectedValue = $(this).val();
        if ((linksEmbeddedBook && selectedValue === embeddedBookValue) || (linksUnlistedName && selectedValue === unlistedNameValue)) {
            await charUpdatePrimaryWorld(worldId);
            return;
        }
        const worldIndex = selectedValue !== '' ? Number(selectedValue) : NaN;
        const name = !isNaN(worldIndex) ? world_names[worldIndex] : '';
        await charUpdatePrimaryWorld(name);
    }

    function handleExtrasWorldSelect(evt) {
        const el = evt?.currentTarget ?? this;
        const selectedValues = $(el).val();
        const selected = Array.isArray(selectedValues) ? selectedValues : [];
        const fileName = getCharaFilename(null, {});
        const nextList = selected.map(i => world_names[i]).filter(Boolean);
        charSetAuxWorlds(fileName, nextList);
    }

    // --- Populate Dropdowns ---
    // Append to primary dropdown.
    const primarySelect = template.find('.character_world_info_selector');
    if (linksEmbeddedBook) {
        primarySelect.append(new Option(t`${worldId} (Embedded Lore)`, embeddedBookValue, true, true));
    }
    if (linksUnlistedName) {
        // A shallow card carries no character_book, so its link may still be to an embedded book: shown by name only.
        const label = worldCharacter?.shallow === true ? worldId : t`${worldId} (not found)`;
        primarySelect.append(new Option(label, unlistedNameValue, true, true));
    }
    world_names.forEach((item, i) => {
        primarySelect.append(new Option(item, String(i), item === worldId, item === worldId));
    });

    // Append to extras dropdown.
    const extrasSelect = template.find('.character_extra_world_info_selector');
    const existingCharLore = world_info.charLore?.find((e) => e.name === fileName);
    world_names.forEach((item, i) => {
        const array = (menu_type == 'create' ? create_save.extra_books : existingCharLore?.extraBooks);
        const isSelected = !!array?.includes(item);
        extrasSelect.append(new Option(item, String(i), isSelected, isSelected));
    });

    const popup = new Popup(template, POPUP_TYPE.TEXT, '', {
        onOpen: function (popup) {
            const popupDialog = $(popup.dlg);

            primarySelect.on('change', handlePrimaryWorldSelect);
            extrasSelect.on('change', handleExtrasWorldSelect);

            // Not needed on mobile.
            if (!isMobile()) {
                extrasSelect.select2({
                    width: '100%',
                    placeholder: t`No auxiliary Lorebooks set. Click here to select.`,
                    allowClear: true,
                    closeOnSelect: false,
                    dropdownParent: popupDialog,
                });
            }
        },
    });

    await popup.show();
}

// Records the default greeting's stable-order position separately, so picking a new default doesn't reorder the list.
const GREETING_DEFAULT_POSITION_KEY = 'greeting_default_position';

/**
 * @typedef {{greetings: string[], defaultIndex: number|null}} GreetingsModel Ordered greeting list,
 *   independent of which one (if any) is the default; `defaultIndex` is where the default sits in
 *   that order, or null when the card has no default greeting at all.
 */

/**
 * Reads a character (or a create-mode-shaped equivalent) into a {@link GreetingsModel}.
 * @param {{first_mes?: string, data?: {alternate_greetings?: string[], extensions?: Record<string, any>}}} card
 * @returns {GreetingsModel}
 */
export function cardToGreetingsModel(card) {
    const firstMes = card?.first_mes ?? '';
    const altGreetings = Array.isArray(card?.data?.alternate_greetings) ? card.data.alternate_greetings : [];

    if (firstMes === '') {
        // Empty first_mes means "no default" - alternate_greetings holds the entire list, in order.
        return { greetings: altGreetings.slice(), defaultIndex: null };
    }

    const recordedPosition = card?.data?.extensions?.[GREETING_DEFAULT_POSITION_KEY];
    if (Number.isInteger(recordedPosition) && recordedPosition >= 0 && recordedPosition <= altGreetings.length) {
        const greetings = altGreetings.slice();
        greetings.splice(recordedPosition, 0, firstMes);
        return { greetings, defaultIndex: recordedPosition };
    }

    // No usable recorded position - fall back to the pre-existing behavior: the default leads the list.
    return { greetings: [firstMes, ...altGreetings], defaultIndex: 0 };
}

/**
 * Inverse of {@link cardToGreetingsModel}. Callers still run `alternateGreetings` through stripEmptyAlternateGreetings() themselves before writing.
 * @param {GreetingsModel} model
 * @returns {{firstMes: string, alternateGreetings: string[], greetingDefaultPosition: number|null}}
 */
function greetingsModelToCardFields({ greetings, defaultIndex }) {
    if (defaultIndex === null || defaultIndex === undefined) {
        return { firstMes: '', alternateGreetings: greetings.slice(), greetingDefaultPosition: null };
    }
    const clampedIndex = Math.max(0, Math.min(defaultIndex, greetings.length - 1));
    const firstMes = greetings[clampedIndex] ?? '';
    const alternateGreetings = greetings.filter((_, i) => i !== clampedIndex);
    return { firstMes, alternateGreetings, greetingDefaultPosition: clampedIndex };
}

/**
 * Removing the default itself clears it (returns null) rather than guessing which neighbor should inherit default status.
 * @param {number|null} defaultIndex
 * @param {number} removedIndex
 */
function reindexDefaultAfterRemoval(defaultIndex, removedIndex) {
    if (defaultIndex === null) return null;
    if (removedIndex === defaultIndex) return null;
    return removedIndex < defaultIndex ? defaultIndex - 1 : defaultIndex;
}

/**
 * `finalTargetIndex` is already adjusted for the removal - the exact position passed to the reinserting splice.
 * @param {number|null} defaultIndex
 * @param {number} sourceIndex
 * @param {number} finalTargetIndex
 */
function reindexDefaultAfterMove(defaultIndex, sourceIndex, finalTargetIndex) {
    if (defaultIndex === null) return null;
    if (defaultIndex === sourceIndex) return finalTargetIndex;
    let result = defaultIndex;
    if (sourceIndex < result) result -= 1;
    if (finalTargetIndex <= result) result += 1;
    return result;
}

/**
 * Only used to seed the initial per-position hash list after a fresh load; every hash after that comes verbatim from a greeting-op response, never recomputed from what the client has typed.
 * @param {string} text
 * @returns {number}
 */
function hashGreetingText(text) {
    return getStringHash(JSON.stringify(text));
}

/**
 * @typedef {object} GreetingOpResult A confirmed greeting op: the character's greeting list as the server holds it after the op.
 * @property {true} ok
 * @property {string[]} greetings
 * @property {number[]} hashes Position-aligned with `greetings`.
 * @property {number|null} defaultPosition
 * @property {number} [position] Where an edit, delete, set-default or appending add acted.
 */

/**
 * Posts one named greeting-list operation; resolves to a result object rather than throwing, even for a refused op (409) or network failure.
 * @param {string} opName The path segment after `/greetings/`, e.g. `'add'`, `'default/set'`.
 * @param {object} body
 * @returns {Promise<GreetingOpResult|{ok: false, status?: number, reason?: string}>}
 */
async function postGreetingOp(opName, body) {
    try {
        const response = await fetch(`/api/characters/greetings/${opName}`, {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(body),
        });
        let payload = null;
        try { payload = await response.json(); } catch { /* no body, or not JSON */ }
        if (response.ok && payload?.ok) {
            return { ok: true, greetings: payload.greetings, hashes: payload.hashes, defaultPosition: payload.default_position, position: payload.position };
        }
        return { ok: false, status: response.status, reason: payload?.reason };
    } catch (error) {
        console.error(`Greeting op "${opName}" request failed`, error);
        return { ok: false, reason: 'network error' };
    }
}

/**
 * Writes a GreetingsModel onto an in-memory character object, and refreshes the digest caches other UI reads off it.
 * @param {object} character
 * @param {import('../src/greeting-list.js').GreetingsModel} model
 */
function applyGreetingsModelToCharacter(character, model) {
    const fields = greetingsModelToCardFields(model);
    const alternateGreetings = stripEmptyAlternateGreetings(fields.alternateGreetings, 'greeting op sync');
    character.first_mes = fields.firstMes;
    character.data = character.data ?? {};
    character.data.first_mes = fields.firstMes;
    character.data.alternate_greetings = alternateGreetings;
    character.data.extensions = character.data.extensions ?? {};
    if (fields.greetingDefaultPosition === null) {
        delete character.data.extensions[GREETING_DEFAULT_POSITION_KEY];
    } else {
        character.data.extensions[GREETING_DEFAULT_POSITION_KEY] = fields.greetingDefaultPosition;
    }
    character._fieldsHash = characterDigestFieldsHash(character);
    character._bodyHash = characterDigestCardBodyHash(character);
}

/**
 * Gives the character and the pager the greeting list the server returned for a confirmed op, which also carries
 * whatever other sessions changed. Call it only from inside {@link queueGreetingSave}: the save's CHARACTER_EDITED
 * fires once the save has released its queue slot.
 * @param {object} character
 * @param {GreetingOpResult} result
 * @param {{expectedHash: number, text: string}} [edit] For an edit op: the edited greeting's hash before the edit, and the text sent.
 * Only this is recorded as a text change for the save's CHARACTER_EDITED: the list before and after can also differ by
 * other sessions' changes, which aren't this page's to announce.
 */
function applyGreetingOpSuccess(character, result, edit) {
    const run = greetingSaveRuns.get(character?.avatar);
    if (!run) {
        throw new Error(`applyGreetingOpSuccess: no queued greeting save for ${character?.avatar} is running`);
    }
    const before = cardToGreetingsModel(character).greetings;
    applyGreetingsModelToCharacter(character, { greetings: result.greetings, defaultIndex: result.defaultPosition });
    setGreetingPagerGreetings(result.greetings, result.defaultPosition, result.hashes);
    run.character = character;
    if (!edit) return;
    const from = before.find(text => hashGreetingText(text) === edit.expectedHash);
    if (from !== undefined && from !== edit.text && Number.isInteger(result.position)) {
        run.edits.push({ from, to: edit.text, index: result.position });
    }
}

/**
 * Fires the one CHARACTER_EDITED for a greeting save that applied anything. `greetingEdits` lists the text edits
 * this save made, in order; `greetingEdit` is its one text edit, null when it made none or more than one. Neither
 * ever carries another session's change.
 * @param {GreetingSaveRun} run
 * @returns {Promise<void>}
 */
function emitGreetingSaveEdited(run) {
    if (!run.character) return Promise.resolve();
    const greetingEdit = run.edits.length === 1 ? run.edits[0] : null;
    return eventSource.emit(event_types.CHARACTER_EDITED, { detail: { id: characterEditedId(run.character.avatar), character: run.character, greetingEdit, greetingEdits: run.edits } });
}

/**
 * @typedef {object} GreetingSaveRun What one queued greeting save applied.
 * @property {object|null} character Null until the save applies an op.
 * @property {{from: string, to: string, index: number}[]} edits Each text edit the save made, in order; `index` is where it landed.
 */

/** @type {Map<string, Promise<void>>} Per character avatar, the tail of its queue of greeting saves; only held while one is queued or in flight. */
const greetingSaveQueues = new Map();

/** @type {Map<string, GreetingSaveRun>} Per character avatar, the greeting save holding its queue slot. */
const greetingSaveRuns = new Map();

/** @type {Map<string, Promise<void>>} Per character avatar, settles once the newest queued save's CHARACTER_EDITED has started, or it had none to fire. */
const greetingEventStarts = new Map();

/**
 * Keeps `promise` under `key` until it settles, unless something newer has replaced it by then.
 * @param {Map<string, Promise<void>>} map
 * @param {string} key
 * @param {Promise<void>} promise
 */
function holdUntilSettled(map, key, promise) {
    map.set(key, promise);
    void promise.then(() => {
        if (map.get(key) === promise) {
            map.delete(key);
        }
    });
}

/**
 * Runs a greeting save once every earlier greeting save for the same character has finished (and had its result
 * applied), so it reads the preconditions and the confirmed list those left behind rather than the ones before them.
 * The slot covers only the server writes and the local state update. The save's CHARACTER_EDITED fires after the
 * slot is released, and starts after the earlier saves' ones have started, so a listener that starts a greeting
 * save of its own and waits for it queues behind rather than waiting on itself. The returned promise settles once
 * that event's listeners have finished.
 * @template T
 * @param {string} avatar
 * @param {() => Promise<T>} save
 * @returns {Promise<T>}
 */
function queueGreetingSave(avatar, save) {
    const previous = greetingSaveQueues.get(avatar) ?? Promise.resolve();
    /** @type {GreetingSaveRun} */
    const record = { character: null, edits: [] };
    const run = previous.then(async () => {
        greetingSaveRuns.set(avatar, record);
        try {
            return await save();
        } finally {
            greetingSaveRuns.delete(avatar);
        }
    });
    const tail = run.then(() => { }, () => { });
    holdUntilSettled(greetingSaveQueues, avatar, tail);

    const earlierEventsStarted = greetingEventStarts.get(avatar) ?? Promise.resolve();
    /** @type {Promise<void>} */
    let emitted = Promise.resolve();
    const started = Promise.all([tail, earlierEventsStarted]).then(() => { emitted = emitGreetingSaveEdited(record); });
    holdUntilSettled(greetingEventStarts, avatar, started.then(() => { }, () => { }));
    const fired = started.then(() => emitted);
    return run.then(result => fired.then(() => result), error => fired.then(() => { throw error; }));
}

// In-memory state for the sidebar greeting pager; `hashes` is the post-op per-position precondition hash list.
// `committed[i] === false` marks a just-added, still-blank slot from the New Greeting button - not yet a real
// array entry server-side, mirroring the Alternate Greetings drawer's pending-row behavior (see addAlternateGreeting()).
const greetingPagerState = {
    greetings: [''],
    defaultIndex: 0,
    hashes: [],
    committed: [true],
    index: 0,
};

/**
 * @typedef {object} GreetingPagerEdit The greeting `greeting_field` is editing, from the moment its edit starts until it ends.
 * @property {number} position Where the greeting is: the pager position when the edit started, then wherever the edit's own saves landed.
 * @property {boolean} committed False while the greeting is a still-pending New Greeting slot that no add has saved yet.
 * @property {number|undefined} hash Precondition hash of the greeting: the one the pager held when the edit started, then the one the server returned for the edit's last save.
 * @property {{greetings: string[], defaultIndex: number|null, hashes: number[]}|null} pending The newest pager state that arrived during the edit, applied when it ends.
 */

/** @type {GreetingPagerEdit|null} */
let greetingPagerEdit = null;

/** Starts tracking the greeting `greeting_field` now edits; the pager state stays as it is until the edit ends. */
function beginGreetingPagerEdit() {
    const { index, committed, hashes } = greetingPagerState;
    greetingPagerEdit = { position: index, committed: committed[index] !== false, hash: hashes[index], pending: null };
}

/**
 * Applies the newest pager state that arrived during the edit, if any, showing the edited greeting where it now is:
 * at its position if the hash there matches, else at the one position holding its hash; otherwise the index is clamped.
 */
function endGreetingPagerEdit() {
    const edit = greetingPagerEdit;
    greetingPagerEdit = null;
    if (!edit?.pending) return;
    const { greetings, defaultIndex, hashes } = edit.pending;
    if (edit.committed && Number.isFinite(edit.hash)) {
        if (hashes[edit.position] === edit.hash) {
            greetingPagerState.index = edit.position;
        } else {
            const matches = hashes.flatMap((hash, i) => (hash === edit.hash ? [i] : []));
            if (matches.length === 1) greetingPagerState.index = matches[0];
        }
    }
    setGreetingPagerGreetings(greetings, defaultIndex, hashes);
}

/**
 * @typedef {object} GreetingsPopupSession
 * @property {Set<HTMLElement>} editing Rows being edited: focused, open in the maximize editor, or with a save scheduled or in flight.
 * @property {() => void} editEnded Called when a row stops being edited.
 * @property {(avatar: string) => Promise<boolean>} [showCurrentAfterConflict] Shows the server's current greetings after a refused op.
 * @property {(row: HTMLElement) => void} removeRow Marks the row this popup is removing, so the next list shown takes it out
 * even when another row has the same text.
 * @property {(row: HTMLElement, insertIndex: number) => void} moveRow Marks the row this popup is moving, and where it lands.
 * @property {(defaultIndex: number|null) => void} showLocal Create mode only: shows `model.greetings` with this default.
 */

/**
 * What the popup can do with one of its rows without rebuilding it.
 * @typedef {object} GreetingRow
 * @property {(index: number) => boolean} setIndex Moves the row to this position; returns whether it changed.
 * @property {() => void} refreshDefault Shows whether the row is the default.
 * @property {() => boolean} isCommitted False for a new row that has no text yet.
 * @property {() => boolean} isEditing Focused, open in the maximize editor, or with a save scheduled or in flight.
 */

/**
 * An edit the server refused because the greeting changed elsewhere, kept until the user applies or discards it.
 * @typedef {object} GreetingConflictDraft
 * @property {number} position The greeting the edit was for.
 * @property {string} text What the user had typed.
 */

/**
 * @param {string} avatar
 * @returns {string}
 */
function greetingConflictDraftsKey(avatar) {
    return `GreetingConflictDrafts:${avatar}`;
}

/**
 * @param {string} avatar
 * @returns {GreetingConflictDraft[]}
 */
function readGreetingConflictDrafts(avatar) {
    try {
        const drafts = JSON.parse(accountStorage.getItem(greetingConflictDraftsKey(avatar)) ?? '[]');
        return Array.isArray(drafts) ? drafts.filter(draft => Number.isInteger(draft?.position) && typeof draft?.text === 'string') : [];
    } catch {
        return [];
    }
}

/**
 * @param {string} avatar
 * @param {GreetingConflictDraft[]} drafts
 */
function writeGreetingConflictDrafts(avatar, drafts) {
    if (drafts.length > 0) {
        accountStorage.setItem(greetingConflictDraftsKey(avatar), JSON.stringify(drafts));
    } else {
        accountStorage.removeItem(greetingConflictDraftsKey(avatar));
    }
}

/**
 * Keeps a refused edit. A newer refused edit to the same greeting replaces the older one.
 * @param {string} avatar
 * @param {GreetingConflictDraft} draft
 */
function addGreetingConflictDraft(avatar, draft) {
    const drafts = readGreetingConflictDrafts(avatar).filter(existing => existing.position !== draft.position);
    drafts.push(draft);
    writeGreetingConflictDrafts(avatar, drafts);
}

/**
 * @param {string} avatar
 * @param {GreetingConflictDraft} draft
 */
function removeGreetingConflictDraft(avatar, draft) {
    writeGreetingConflictDrafts(avatar, readGreetingConflictDrafts(avatar).filter(existing => existing.position !== draft.position || existing.text !== draft.text));
}

/**
 * Shows the character's refused edits above the list, each with Apply (save it over the greeting's current text,
 * or as a new greeting if that greeting is gone) and Discard.
 * @param {JQuery<HTMLElement>} template
 * @param {string} avatar
 * @param {GreetingsModel} model
 * @param {(avatar: string) => Promise<boolean>} showCurrentAfterConflict
 */
function renderGreetingConflictDrafts(template, avatar, model, showCurrentAfterConflict) {
    const container = template.find('.greeting-conflict-drafts');
    const drafts = readGreetingConflictDrafts(avatar);
    const keyOf = (/** @type {GreetingConflictDraft} */ draft) => `${draft.position}\u0000${draft.text}`;
    const wanted = new Set(drafts.map(keyOf));
    container.children('.greeting-conflict-draft').each(function () {
        if (!wanted.has(this.dataset.draftKey)) $(this).remove();
    });
    for (const draft of drafts) {
        const key = keyOf(draft);
        const existing = container.children('.greeting-conflict-draft').filter(function () { return this.dataset.draftKey === key; });
        if (existing.length) {
            labelGreetingConflictDraft(existing, draft, model);
            continue;
        }
        const block = $('<div class="greeting-conflict-draft flexFlowColumn flex-container wide100p"></div>');
        block[0].dataset.draftKey = key;
        block.append($('<small class="greeting-conflict-draft-note"></small>'));
        block.append($('<textarea class="text_pole textarea_compact greeting-conflict-draft-text" readonly></textarea>').val(draft.text));
        const buttons = $('<div class="flex-container"></div>');
        const apply = $('<div class="menu_button greeting-conflict-draft-apply"></div>');
        const discard = $('<div class="menu_button greeting-conflict-draft-discard"></div>').text(t`Discard`);
        buttons.append(apply, discard);
        block.append(buttons);
        container.append(block);
        labelGreetingConflictDraft(block, draft, model);

        discard.on('click', () => {
            removeGreetingConflictDraft(avatar, draft);
            block.remove();
        });
        apply.on('click', async () => {
            if (apply.hasClass('disabled')) return;
            const character = charactersStore.get(avatar);
            if (!character) return;
            apply.addClass('disabled');
            const exists = draft.position < model.greetings.length;
            await queueGreetingSave(avatar, async () => {
                const row = /** @type {any} */ (template.find(`.alternate_greetings_list .alternate_greeting[data-index="${draft.position}"]`)[0]);
                const result = exists && Number.isFinite(row?.greetingHash)
                    ? await postGreetingOp('edit', { avatar_url: avatar, position: draft.position, expected_hash: row.greetingHash, text: draft.text })
                    : await postGreetingOp('add', { avatar_url: avatar, append: true, text: draft.text });
                if (result.ok) {
                    applyGreetingOpSuccess(character, result);
                    removeGreetingConflictDraft(avatar, draft);
                    await showCurrentAfterConflict(avatar);
                    return;
                }
                console.error('Applying a kept greeting edit failed', { avatar, position: draft.position, status: result.status, reason: result.reason });
                if (result.status === 409 && await showCurrentAfterConflict(avatar)) {
                    toastr.warning(t`Someone else changed this greeting again, so your edit wasn't applied. Showing the current version; your edit is still kept.`, t`Greeting not saved`);
                    return;
                }
                apply.removeClass('disabled');
                toastr.error(t`Failed to apply your kept edit. It's still kept.`, t`Greeting not saved`);
            });
        });
    }
}

/**
 * Words a kept edit's note and Apply button for whether its greeting still exists.
 * @param {JQuery<HTMLElement>} block
 * @param {GreetingConflictDraft} draft
 * @param {GreetingsModel} model
 */
function labelGreetingConflictDraft(block, draft, model) {
    const exists = draft.position < model.greetings.length;
    block.find('.greeting-conflict-draft-note').text(exists
        ? t`Your edit to greeting #${draft.position + 1} wasn't saved because someone else changed it. It's kept here until you apply or discard it.`
        : t`Your edit to greeting #${draft.position + 1} wasn't saved, and that greeting no longer exists. It's kept here until you apply or discard it.`);
    block.find('.greeting-conflict-draft-apply').text(exists ? t`Replace greeting #${draft.position + 1} with this` : t`Add as a new greeting`);
}

/** @type {((greetings: string[], defaultIndex: number|null) => void)|null} The open greetings popup's re-render, told whenever the pager's greetings are replaced. */
let greetingsPopupListener = null;

/**
 * Replaces the pager's greetings, default pointer, and precondition hashes, and clamps the current index in case the list shrank.
 * Every position here is confirmed by the server (or is the pre-load placeholder), so all are marked committed.
 * While `greeting_field` is being edited nothing is replaced: the state is kept and applied when the edit ends, so
 * the edit's saves keep targeting the greeting it started on.
 * @param {string[]} greetings Stable-order greeting list.
 * @param {number|null} defaultIndex
 * @param {number[]} hashes Position-aligned with `greetings`.
 */
function setGreetingPagerGreetings(greetings, defaultIndex, hashes) {
    if (greetingPagerEdit) {
        greetingPagerEdit.pending = { greetings: greetings.slice(), defaultIndex, hashes: hashes.slice() };
        return;
    }
    greetingPagerState.greetings = greetings.length > 0 ? greetings.slice() : [''];
    greetingPagerState.defaultIndex = greetings.length > 0 ? defaultIndex : 0;
    greetingPagerState.hashes = greetings.length > 0 ? hashes.slice() : [];
    greetingPagerState.committed = greetingPagerState.greetings.map(() => true);
    greetingPagerState.index = Math.max(0, Math.min(greetingPagerState.index, greetingPagerState.greetings.length - 1));
    renderGreetingPager();
    $('#firstmessage_textarea').val(greetings.length > 0 && defaultIndex !== null ? greetings[defaultIndex] ?? '' : '');
    greetingsPopupListener?.(greetings.slice(), greetings.length > 0 ? defaultIndex : null);
}

/** Redraws the pager controls and the visible greeting field from the current pager state. */
function renderGreetingPager() {
    const { greetings, index } = greetingPagerState;
    setFieldValue('greeting_field', greetings[index] ?? '');
    autosizeTextareas(document.getElementById('greeting_field'));
    $('.greeting-pager-input').val(index + 1);
    $('.greeting-pager-total').text(`/${greetings.length}`);
    // .val() above doesn't fire a native input event, so the token counter needs an explicit nudge.
    countCharTokensWhenShown();
}

/**
 * Commits the visible field into the greetings array before stepping to a wrapped index.
 * @param {number} newIndex
 */
function navigateGreetingPager(newIndex) {
    const { greetings, index } = greetingPagerState;
    greetings[index] = String($('#greeting_field').val());
    greetingPagerState.index = ((newIndex % greetings.length) + greetings.length) % greetings.length;
    renderGreetingPager();
}

/**
 * Saves an edit to an already-committed pager greeting. Call it only from inside {@link queueGreetingSave}.
 * The server edits the greeting at `position` if it still has `expectedHash`, else the one greeting that has it.
 * @param {string} avatar
 * @param {object} character
 * @param {number} position
 * @param {number|undefined} expectedHash
 * @param {string} text
 * @returns {Promise<{position: number, hash: number}|null>} Where the edit landed and the greeting's new hash there; null if it wasn't saved.
 */
async function saveGreetingPagerEdit(avatar, character, position, expectedHash, text) {
    if (!Number.isFinite(expectedHash)) return null; // Position out of range of what the server last confirmed.

    const result = await postGreetingOp('edit', { avatar_url: avatar, position, expected_hash: expectedHash, text });
    if (result.ok) {
        const landed = Number.isInteger(result.position) ? result.position : position;
        applyGreetingOpSuccess(character, result, { expectedHash, text });
        return { position: landed, hash: result.hashes[landed] };
    }
    console.error('Greeting save failed', { avatar, position, status: result.status, reason: result.reason });
    if (result.status === 409) {
        toastr.error(t`This character was changed in another session, so this greeting change was not saved. Reopen the character to see the current version.`, t`Greeting not saved`);
        return null;
    }
    toastr.error(t`Failed to save the greeting. Your edit is still shown here, but it was not saved.`, t`Greeting not saved`);
    return null;
}

/**
 * Commits a value for the greeting currently shown in the pager: a still-pending (uncommitted) slot is
 * added once it has text, a committed one is edited in place; in create mode it goes to `create_save`.
 * @param {string} value
 * @returns {Promise<boolean>} Whether the value was saved.
 */
async function commitGreetingFieldValue(value) {
    const { index, defaultIndex } = greetingPagerState;
    greetingPagerState.greetings[index] = value;
    if (menu_type === 'create') {
        const fields = greetingsModelToCardFields({ greetings: greetingPagerState.greetings, defaultIndex });
        create_save.first_message = fields.firstMes;
        create_save.alternate_greetings = stripEmptyAlternateGreetings(fields.alternateGreetings, 'greeting pager create-mode input');
        return true;
    }
    const avatar = $('.open_alternate_greetings').data('avatar');
    const character = avatar ? charactersStore.get(avatar) : null;
    if (!character) return false;
    // The target is read once the earlier saves are done: an add still in flight commits the slot, and an edit's
    // earlier saves move its target to where they landed. While `greeting_field` is being edited the target is the
    // greeting the edit started on; otherwise it is the pager's current greeting.
    return await queueGreetingSave(avatar, async () => {
        const edit = greetingPagerEdit;
        const target = edit ?? { position: index, committed: greetingPagerState.committed[index] !== false, hash: greetingPagerState.hashes[index] };
        if (target.committed) {
            const landed = await saveGreetingPagerEdit(avatar, character, target.position, target.hash, value);
            if (!landed) return false;
            if (edit && greetingPagerEdit === edit) {
                edit.position = landed.position;
                edit.hash = landed.hash;
            }
            return true;
        }
        if (value === '') return false;
        const result = await postGreetingOp('add', { avatar_url: avatar, position: target.position, expected_length: greetingPagerState.hashes.length, text: value });
        if (result.ok) {
            applyGreetingOpSuccess(character, result);
            if (edit && greetingPagerEdit === edit) {
                edit.committed = true;
                edit.hash = result.hashes[target.position];
            }
            return true;
        }
        console.error('Greeting add failed', { avatar, position: target.position, status: result.status, reason: result.reason });
        toastr.error(t`Failed to save the new greeting. It's still shown here - confirm it again to retry.`, t`Greeting not saved`);
        return false;
    });
}

/**
 * Saves the greeting currently shown in the pager with this value.
 * @param {string} value
 * @returns {Promise<boolean>} Whether the value was saved.
 */
export async function saveGreetingField(value) {
    return await commitGreetingFieldValue(value);
}

/** @type {{value: string}|null} A write to `#firstmessage_textarea` queued behind an earlier save, not yet sent. */
let queuedFirstMessageWrite = null;

/**
 * Saves what code wrote into `#firstmessage_textarea`, upstream's first message field, as the default greeting:
 * its text is replaced; with no default, the value is added and made the default; an empty value clears the default
 * and keeps the greeting. Writes made while one is waiting to be sent replace its value, so only the latest is sent.
 */
function onFirstMessageFieldInput() {
    const value = String($('#firstmessage_textarea').val());
    if (queuedFirstMessageWrite) {
        queuedFirstMessageWrite.value = value;
        return;
    }
    if (menu_type === 'create') {
        setCreateModeFirstMessage(value);
        return;
    }
    const avatar = $('.open_alternate_greetings').data('avatar');
    const character = avatar ? charactersStore.get(avatar) : null;
    if (!character) return;
    const write = { value };
    queuedFirstMessageWrite = write;
    void queueGreetingSave(avatar, async () => {
        if (queuedFirstMessageWrite === write) queuedFirstMessageWrite = null;
        const result = await saveFirstMessage(avatar, character, write.value);
        if (result.ok) return;
        console.error('First message save failed', { avatar, status: result.status, reason: result.reason });
        toastr.error(result.status === 409
            ? t`The greetings were changed in another session, so the first message written by an extension was not saved.`
            : t`Failed to save the first message written by an extension.`, t`First message not saved`);
        const stored = cardToGreetingsModel(character);
        $('#firstmessage_textarea').val(stored.defaultIndex === null ? '' : stored.greetings[stored.defaultIndex]);
    });
}

/**
 * Sends the ops that make `value` the default greeting. Call it only from inside {@link queueGreetingSave}.
 * @param {string} avatar
 * @param {object} character
 * @param {string} value
 * @returns {Promise<{ok: boolean, status?: number, reason?: string}>}
 */
async function saveFirstMessage(avatar, character, value) {
    const { greetings, defaultIndex } = cardToGreetingsModel(character);
    const current = defaultIndex === null ? '' : greetings[defaultIndex];
    if (value === current) return { ok: true };
    if (defaultIndex !== null) {
        const expectedHash = hashGreetingText(current);
        if (value === '') {
            const result = await postGreetingOp('default/unset', { avatar_url: avatar, expected_default_hash: expectedHash });
            if (result.ok) applyGreetingOpSuccess(character, result);
            return result;
        }
        const result = await postGreetingOp('edit', { avatar_url: avatar, position: defaultIndex, expected_hash: expectedHash, text: value });
        if (result.ok) applyGreetingOpSuccess(character, result, { expectedHash, text: value });
        return result;
    }
    const added = await postGreetingOp('add', { avatar_url: avatar, append: true, text: value });
    if (!added.ok) return added;
    applyGreetingOpSuccess(character, added);
    const result = await postGreetingOp('default/set', { avatar_url: avatar, position: added.position, expected_hash: added.hashes[added.position] });
    if (result.ok) applyGreetingOpSuccess(character, result);
    return result;
}

/**
 * Create mode: makes `value` the default greeting of the character being created, by the same rules as
 * {@link onFirstMessageFieldInput}.
 * @param {string} value
 */
function setCreateModeFirstMessage(value) {
    const greetings = greetingPagerState.greetings.slice();
    let defaultIndex = greetingPagerState.defaultIndex;
    if (value === '') {
        defaultIndex = null;
    } else if (defaultIndex === null || defaultIndex >= greetings.length) {
        greetings.push(value);
        defaultIndex = greetings.length - 1;
    } else {
        greetings[defaultIndex] = value;
    }
    const fields = greetingsModelToCardFields({ greetings, defaultIndex });
    create_save.first_message = fields.firstMes;
    create_save.alternate_greetings = stripEmptyAlternateGreetings(fields.alternateGreetings, 'first message field (create mode)');
    if (!create_save.extensions) create_save.extensions = {};
    create_save.extensions[GREETING_DEFAULT_POSITION_KEY] = fields.greetingDefaultPosition;
    setGreetingPagerGreetings(greetings, defaultIndex, greetings.map(hashGreetingText));
}

/**
 * Final safety net for the "no empty string ever lands in alternate_greetings" invariant.
 * @param {string[]} alternateGreetings
 * @param {string} context Short label identifying which write path this ran in, for the log.
 */
function stripEmptyAlternateGreetings(alternateGreetings, context) {
    const filtered = alternateGreetings.filter(greeting => greeting !== '');
    const dropped = alternateGreetings.length - filtered.length;
    if (dropped > 0) {
        console.warn(`[alternate_greetings] Dropped ${dropped} empty entr${dropped === 1 ? 'y' : 'ies'} before writing (${context}). An empty string should never reach alternate_greetings - something upstream let one through.`);
    }
    return filtered;
}

function openAlternateGreetings() {
    if (blockWhileFieldEditing()) {
        return;
    }
    const avatar = $('.open_alternate_greetings').data('avatar');
    // Every use below reads/mutates this character's own fields directly - no index required.
    const greetingsCharacter = charactersStore.get(avatar);

    if (menu_type != 'create' && avatar === undefined) {
        toastr.error('Does not have an Id for this character in editor menu.');
        return;
    } else {
        // If the character does not have alternate greetings, create an empty array
        if (greetingsCharacter && !Array.isArray(greetingsCharacter.data.alternate_greetings)) {
            greetingsCharacter.data.alternate_greetings = [];
        }
    }

    const initialModel = menu_type == 'create'
        ? cardToGreetingsModel({ first_mes: create_save.first_message ?? '', data: { alternate_greetings: create_save.alternate_greetings, extensions: create_save.extensions } })
        : cardToGreetingsModel(greetingsCharacter);

    // Live working copy for this popup instance; only mutated after a row handler's server op is confirmed, except in create mode (no server side to confirm against).
    const model = { greetings: initialModel.greetings.slice(), defaultIndex: initialModel.defaultIndex };

    const getArray = () => model.greetings;

    const template = $('#alternate_greetings_template .alternate_grettings').clone();

    // Create-mode-only: real characters land each op's result via applyGreetingOpSuccess() as it happens, so there's nothing to flush at close.
    function syncCreateModeFromUnified() {
        const fields = greetingsModelToCardFields(model);
        const newAltGreetings = stripEmptyAlternateGreetings(fields.alternateGreetings, 'alt greetings popup (create mode)');
        create_save.first_message = fields.firstMes;
        create_save.alternate_greetings = newAltGreetings;
        if (!create_save.extensions) create_save.extensions = {};
        create_save.extensions[GREETING_DEFAULT_POSITION_KEY] = fields.greetingDefaultPosition;
        setGreetingPagerGreetings(model.greetings, model.defaultIndex, model.greetings.map(hashGreetingText));
    }

    /** @type {{greetings: string[], defaultIndex: number|null}|null} A list shown while a row being edited had to stay; shown again when no row is being edited. */
    let pendingRender = null;
    /** @type {{row: HTMLElement, insertIndex?: number}|null} The row this popup's own op removed or moved, for the next list shown. */
    let rowHint = null;
    /** @type {GreetingsPopupSession} */
    const session = {
        editing: new Set(),
        // Checked a task later: focus moving from one row to another blurs the first before it focuses the second.
        editEnded: () => setTimeout(() => {
            if (session.editing.size > 0 || !pendingRender) return;
            const { greetings, defaultIndex } = pendingRender;
            pendingRender = null;
            showRows(greetings, defaultIndex);
        }),
        removeRow: (row) => { rowHint = { row }; },
        moveRow: (row, insertIndex) => { rowHint = { row, insertIndex }; },
        showLocal: (defaultIndex) => showRows(model.greetings, defaultIndex, { positional: true }),
    };

    /**
     * @param {string[]} greetings
     * @param {number|null} defaultIndex
     */
    const onGreetingsReplaced = (greetings, defaultIndex) => showRows(greetings, defaultIndex);

    const popup = new Popup(template, POPUP_TYPE.TEXT, '', {
        wide: true,
        large: true,
        allowVerticalScrolling: true,
        onClose: async () => {
            if (greetingsPopupListener === onGreetingsReplaced) {
                greetingsPopupListener = null;
            }
            if (menu_type === 'create') {
                syncCreateModeFromUnified();
            }
        },
    });

    // Set when a reload after a refused move failed: this popup's copy is stale until a retry reloads it.
    let movesBlocked = false;

    async function reloadGreetingsFromServer(avatar) {
        let ok = false;
        try {
            ok = await getOneCharacter(avatar);
        } catch (error) {
            console.error('Greeting list reload failed', error);
        }
        if (!ok) return false;
        const fresh = cardToGreetingsModel(charactersStore.get(avatar));
        setGreetingPagerGreetings(fresh.greetings, fresh.defaultIndex, fresh.greetings.map(hashGreetingText));
        movesBlocked = false;
        template.find('.greeting-refresh-failed').hide();
        template.find('.pick_up_greeting').removeClass('disabled');
        renderGreetingConflictDrafts(template, avatar, model, showCurrentAfterConflict);
        return true;
    }

    function blockMoves() {
        movesBlocked = true;
        picker.cancel();
        template.find('.pick_up_greeting').addClass('disabled');
        template.find('.greeting-refresh-failed').show();
    }

    /**
     * After an op was refused because the greetings changed elsewhere: shows the server's current list in place.
     * If that reload fails, the list is marked stale and moves are blocked until a retry reloads it.
     * @param {string} avatar
     * @returns {Promise<boolean>} Whether the current list is now shown.
     */
    async function showCurrentAfterConflict(avatar) {
        if (await reloadGreetingsFromServer(avatar)) return true;
        blockMoves();
        return false;
    }
    session.showCurrentAfterConflict = showCurrentAfterConflict;

    if (menu_type !== 'create' && avatar !== undefined) {
        renderGreetingConflictDrafts(template, avatar, model, showCurrentAfterConflict);
    }

    const picker = new PickAndPlace({
        container: template[0],
        // Draft rows aren't in the array yet, so they can be neither picked nor used as an anchor.
        getItems: () => template.find('.alternate_greetings_list .alternate_greeting:not(.greeting-draft):not(.greeting-stale)').toArray().map(row => ({
            key: Number(row.getAttribute('data-index')),
            element: row,
            // The filter's .toggle() is the only thing that hides rows.
            visible: row.style.display !== 'none',
        })),
        onPickChange: (key) => {
            template.find('.pick_up_greeting i').removeClass('fa-xmark').addClass('fa-arrows-up-down');
            template.find('.pick_up_greeting').attr('title', 'Pick up to move');
            if (key !== null) {
                const button = template.find(`.alternate_greeting[data-index="${key}"] .pick_up_greeting`);
                button.find('i').removeClass('fa-arrows-up-down').addClass('fa-xmark');
                button.attr('title', 'Cancel move');
            }
        },
        onPlace: async ({ key: sourceIndex, side, anchorKey: targetIndex }) => {
            if (movesBlocked) return;
            const array = getArray();
            // The landing index, computed the way the server's opMove computes it.
            const anchor = targetIndex > sourceIndex ? targetIndex - 1 : targetIndex;
            const insertIndex = side === 'before' ? anchor : anchor + 1;
            const sourceRow = rowAt(sourceIndex);

            if (menu_type === 'create') {
                const [moved] = array.splice(sourceIndex, 1);
                array.splice(insertIndex, 0, moved);
                session.moveRow(sourceRow, insertIndex);
                session.showLocal(reindexDefaultAfterMove(model.defaultIndex, sourceIndex, insertIndex));
                return;
            }

            const avatar = $('.open_alternate_greetings').data('avatar');
            const character = avatar ? charactersStore.get(avatar) : null;
            if (!character) return;
            const rowHash = (key) => /** @type {any} */ (template.find(`.alternate_greetings_list .alternate_greeting[data-index="${key}"]`)[0])?.greetingHash;
            await queueGreetingSave(avatar, async () => {
                const expectedHash = rowHash(sourceIndex);
                const targetExpectedHash = rowHash(targetIndex);
                if (!Number.isFinite(expectedHash) || !Number.isFinite(targetExpectedHash)) return;
                const result = await postGreetingOp('move', { avatar_url: avatar, source_position: sourceIndex, expected_hash: expectedHash, side, target_position: targetIndex, target_expected_hash: targetExpectedHash });
                if (!result.ok) {
                    console.error('Greeting move failed', { avatar, sourceIndex, side, targetIndex, status: result.status, reason: result.reason });
                    picker.cancel();
                    if (result.status === 409) {
                        if (await reloadGreetingsFromServer(avatar)) {
                            toastr.warning(t`The greetings were changed in another session, so this move was not made. The list has been reloaded.`, t`Greeting not moved`);
                        } else {
                            blockMoves();
                            toastr.error(t`The greetings were changed in another session, so this move was not made, and the list couldn't be refreshed.`, t`Greeting not moved`);
                        }
                        return;
                    }
                    toastr.error(t`Failed to move the greeting.`, t`Greeting not moved`);
                    return;
                }
                session.moveRow(sourceRow, insertIndex);
                applyGreetingOpSuccess(character, result);
            });
        },
    });

    /**
     * @param {number} index
     * @returns {HTMLElement|undefined}
     */
    function rowAt(index) {
        return template.find(`.alternate_greetings_list .alternate_greeting:not(.greeting-draft):not(.greeting-stale)[data-index="${index}"]`)[0];
    }

    /**
     * @param {HTMLElement} row
     * @returns {GreetingRow}
     */
    const rowApi = (row) => /** @type {any} */ (row).greetingRow;

    /**
     * Shows this list by updating the rows already there: a row whose saved text is still in the list stays, with its
     * typing, focus and scroll, and only moves; a row whose text is gone is removed; a new greeting gets a new row.
     * A row being edited is never removed: it stays, marked stale, until its edit ends, and then the list is shown again.
     * @param {string[]} greetings
     * @param {number|null} defaultIndex
     * @param {{positional?: boolean}} [options] `positional`: create mode, where rows have no saved text; the rows
     * in their order are the list.
     */
    function showRows(greetings, defaultIndex, { positional = false } = {}) {
        const list = template.find('.alternate_greetings_list')[0];
        let rows = Array.from(list.querySelectorAll(':scope > .alternate_greeting'));
        const hint = rowHint;
        rowHint = null;
        if (hint && rows.includes(hint.row)) {
            rows.splice(rows.indexOf(hint.row), 1);
            if (hint.insertIndex === undefined) {
                hint.row.remove();
                session.editing.delete(hint.row);
            } else {
                const listed = rows.filter(row => rowApi(row).isCommitted() && !row.classList.contains('greeting-stale'));
                const anchor = listed[hint.insertIndex];
                const lastListed = listed.at(-1);
                rows.splice(anchor ? rows.indexOf(anchor) : (lastListed ? rows.indexOf(lastListed) + 1 : 0), 0, hint.row);
            }
        }
        model.greetings = greetings.slice();
        model.defaultIndex = defaultIndex;

        const candidates = rows.filter(row => rowApi(row).isCommitted());
        const drafts = rows.filter(row => !rowApi(row).isCommitted());
        /** @type {HTMLElement[]} */
        const listed = [];
        const used = new Set();
        for (let index = 0; index < greetings.length; index++) {
            const hash = hashGreetingText(greetings[index]);
            const row = positional
                ? candidates[index]
                : candidates.find(candidate => !used.has(candidate) && /** @type {any} */ (candidate).greetingHash === hash);
            if (row) {
                used.add(row);
                listed.push(row);
            } else {
                const created = addAlternateGreeting(template, greetings[index], index, getArray, popup, model, index + 1, false, picker, session);
                if (movesBlocked) $(created).find('.pick_up_greeting').addClass('disabled');
                listed.push(created);
            }
        }

        let keptStale = false;
        const desired = listed.slice();
        for (const row of candidates) {
            if (used.has(row)) continue;
            if (!rowApi(row).isEditing()) {
                row.remove();
                continue;
            }
            keptStale = true;
            row.classList.add('greeting-stale');
            row.removeAttribute('data-index');
            const before = candidates.slice(0, candidates.indexOf(row)).reverse().find(candidate => desired.includes(candidate));
            desired.splice(before ? desired.indexOf(before) + 1 : 0, 0, row);
        }
        desired.push(...drafts);

        let moved = false;
        listed.forEach((row, index) => {
            row.classList.remove('greeting-stale');
            moved = rowApi(row).setIndex(index) || moved;
        });
        drafts.forEach((row, offset) => rowApi(row).setIndex(greetings.length + offset));
        for (const row of desired) rowApi(row).refreshDefault();
        placeRowsInOrder(list, desired);
        if (moved && picker.pickedKey !== null) picker.cancel();
        pendingRender = keptStale ? { greetings: greetings.slice(), defaultIndex } : null;

        template.find('.greeting-filter-input').trigger('input');
        updateAlternateGreetingsHintVisibility(template);
    }

    for (let index = 0; index < model.greetings.length; index++) {
        addAlternateGreeting(template, model.greetings[index], index, getArray, popup, model, index + 1, false, picker, session);
    }
    if (menu_type !== 'create') {
        greetingsPopupListener = onGreetingsReplaced;
    }

    // Filter input handler
    template.find('.greeting-filter-input').on('input', function () {
        const filterText = $(this).val().toLowerCase();
        template.find('.alternate_greetings_list .alternate_greeting').each(function () {
            const content = $(this).find('.alternate_greeting_text').val().toLowerCase();
            $(this).toggle(!filterText || content.includes(filterText));
        });
        picker.refresh();
    });

    template.find('.add_alternate_greeting').on('click', function () {
        const array = getArray();
        // The new row is UI-only until it has text - not pushed into the array here (see addAlternateGreeting()'s `pending` handling).
        const index = array.length;
        addAlternateGreeting(template, '', index, getArray, popup, model, index + 1, true, picker, session);
        if (movesBlocked) {
            template.find('.alternate_greetings_list .alternate_greeting').last().find('.pick_up_greeting').addClass('disabled');
        }
        updateAlternateGreetingsHintVisibility(template);
        const list = template.find('.alternate_greetings_list');
        list.scrollTop(list.prop('scrollHeight'));
    });

    template.find('.greeting_refresh_retry').on('click', async function () {
        const retryButton = $(this);
        if (retryButton.hasClass('disabled')) return;
        retryButton.addClass('disabled');
        const avatar = $('.open_alternate_greetings').data('avatar');
        const refreshed = await reloadGreetingsFromServer(avatar);
        retryButton.removeClass('disabled');
        if (!refreshed) toastr.error(t`Couldn't refresh the greeting list.`, t`Greeting list not refreshed`);
    });

    popup.show();
    updateAlternateGreetingsHintVisibility(template);
}

/**
 * Puts the list's children in this order, moving as few as it can. A row holding focus is never moved, since moving
 * an element blurs it and resets its scroll.
 * @param {HTMLElement} list
 * @param {HTMLElement[]} desired Every child the list should hold, in order.
 */
function placeRowsInOrder(list, desired) {
    const current = Array.from(list.children);
    const position = desired.map(element => current.indexOf(element));
    const active = document.activeElement;
    const weight = desired.map(element => (active && element.contains(active)) ? desired.length + 1 : 1);
    // The heaviest run of rows already in order stays put; the focused row outweighs all others together.
    const best = desired.map(() => 0);
    const previous = desired.map(() => -1);
    let end = -1;
    for (let i = 0; i < desired.length; i++) {
        if (position[i] < 0) continue;
        best[i] = weight[i];
        for (let j = 0; j < i; j++) {
            if (position[j] >= 0 && position[j] < position[i] && best[j] + weight[i] > best[i]) {
                best[i] = best[j] + weight[i];
                previous[i] = j;
            }
        }
        if (end < 0 || best[i] > best[end]) end = i;
    }
    const stay = new Set();
    for (let i = end; i >= 0; i = previous[i]) stay.add(desired[i]);
    let next = null;
    for (let i = desired.length - 1; i >= 0; i--) {
        if (!stay.has(desired[i])) list.insertBefore(desired[i], next);
        next = desired[i];
    }
}

/**
 * @param {JQuery<HTMLElement>} template
 * @param {string} greeting
 * @param {number} index Position in the stable-order greetings array; for a `pending` row, only a prediction until it has text.
 * @param {() => any[]} getArray
 * @param {Popup} popup
 * @param {GreetingsModel} model Live working model; `model.defaultIndex` is reassigned by the set/demote handlers below.
 * @param {number} [displayPosition] 1-based slot number to show the user; defaults to index + 1.
 * @param {boolean} [pending] True for a just-added, still-blank row - not yet a real array entry, so a write while blank never sees it.
 * @param {PickAndPlace} [picker] The popup's pick-and-place, which this row's pick-up button drives.
 * @param {GreetingsPopupSession} [session] The popup's record of which rows are being edited.
 * @returns {HTMLElement} The row, appended to the list.
 */
function addAlternateGreeting(template, greeting, index, getArray, popup, model, displayPosition = index + 1, pending = false, picker, session) {
    const greetingBlock = $('#alternate_greeting_form_template .alternate_greeting').clone();
    const row = /** @type {HTMLElement & {greetingHash?: number}} */ (greetingBlock[0]);
    let committed = !pending;
    // The hash of the text this row shows as saved: every op on the row targets the greeting with it.
    row.greetingHash = pending ? undefined : hashGreetingText(greeting);
    greetingBlock.attr('data-index', index);
    if (pending) {
        greetingBlock.addClass('greeting-draft');
    }

    let focused = false;
    let maximized = false;
    let saveScheduled = false;
    let savesInFlight = 0;
    const updateEditing = () => {
        if (!session) return;
        if (focused || maximized || saveScheduled || savesInFlight > 0) {
            session.editing.add(row);
        } else if (session.editing.delete(row)) {
            session.editEnded();
        }
    };

    // Per-row debounce, so typing in a different row doesn't reset this one's pending save. Never fires in create mode.
    const debouncedRowEdit = debounce(async (rowIndex, text) => {
        saveScheduled = false;
        savesInFlight++;
        try {
            const avatar = $('.open_alternate_greetings').data('avatar');
            const character = avatar ? charactersStore.get(avatar) : null;
            if (!character) return;
            await queueGreetingSave(avatar, async () => {
                const expectedHash = row.greetingHash;
                if (!Number.isFinite(expectedHash)) return;

                const result = await postGreetingOp('edit', { avatar_url: avatar, position: rowIndex, expected_hash: expectedHash, text });
                if (result.ok) {
                    row.greetingHash = Number.isInteger(result.position) ? result.hashes[result.position] : hashGreetingText(text);
                    applyGreetingOpSuccess(character, result, { expectedHash, text });
                    return;
                }
                console.error('Greeting edit failed', { avatar, position: rowIndex, status: result.status, reason: result.reason });
                if (result.status === 409) {
                    // What the row shows now, which may be newer than the text this save sent.
                    const typed = String(greetingBlock.find('.alternate_greeting_text').val());
                    addGreetingConflictDraft(avatar, { position: rowIndex, text: typed });
                    if (await session?.showCurrentAfterConflict(avatar)) {
                        toastr.warning(t`Someone else changed this greeting, so your edit wasn't saved. Showing the current version; your edit is kept at the top of the list.`, t`Greeting not saved`);
                    } else {
                        toastr.error(t`Someone else changed this greeting, so your edit wasn't saved, and the list couldn't be refreshed. Your edit is kept and will be shown when the list is refreshed.`, t`Greeting not saved`);
                    }
                    return;
                }
                toastr.error(t`Failed to save the greeting. Your edit is still shown here, but it was not saved.`, t`Greeting not saved`);
            });
        } finally {
            savesInFlight--;
            updateEditing();
        }
    }, DEFAULT_SAVE_EDIT_TIMEOUT);

    greetingBlock.find('.alternate_greeting_text')
        .attr('id', `alternate_greeting_${index}`)
        .on('focus', () => {
            focused = true;
            updateEditing();
        })
        .on('blur', () => {
            focused = false;
            updateEditing();
        })
        .on('input', async function () {
            const value = String($(this).val());
            const array = getArray();
            if (!committed) {
                if (value === '') {
                    // Still nothing authored - stays UI-only.
                    return;
                }
                array.push(value);
                committed = true;
                greetingBlock.removeClass('greeting-draft');
                setIndex(array.length - 1);
                refreshDefault();
                greetingBlock.find('.pick_up_greeting').show();

                if (menu_type === 'create') return; // synced at popup close, same as every other create-mode field

                const addedIndex = index;
                const avatar = $('.open_alternate_greetings').data('avatar');
                const character = avatar ? charactersStore.get(avatar) : null;
                if (!character) return;
                savesInFlight++;
                updateEditing();
                let result;
                try {
                    result = await queueGreetingSave(avatar, async () => {
                        const added = await postGreetingOp('add', { avatar_url: avatar, append: true, text: value });
                        if (added.ok) {
                            row.greetingHash = Number.isInteger(added.position) ? added.hashes[added.position] : hashGreetingText(value);
                            applyGreetingOpSuccess(character, added);
                        }
                        return added;
                    });
                } finally {
                    savesInFlight--;
                    updateEditing();
                }
                if (result.ok) {
                    return;
                }
                console.error('Greeting add failed', { avatar, position: addedIndex, status: result.status, reason: result.reason });
                toastr.error(t`Failed to save the new greeting. It's still shown here - keep typing in it to retry.`, t`Greeting not saved`);
                // Wasn't actually saved - revert to an uncommitted draft so the next keystroke retries.
                array.splice(addedIndex, 1);
                committed = false;
                return;
            }
            array[index] = value;
            if (menu_type !== 'create') {
                saveScheduled = true;
                updateEditing();
                debouncedRowEdit(index, value);
            }
        }).val(greeting);
    greetingBlock.find('.editor_maximize').attr('data-for', `alternate_greeting_${index}`);
    greetingBlock.find('.greeting_index').text(displayPosition);

    /**
     * Moves the row to another position in the list: what its ops target, its id and its shown number.
     * @param {number} newIndex
     * @returns {boolean} Whether the position changed.
     */
    const setIndex = (newIndex) => {
        const changed = newIndex !== index;
        index = newIndex;
        greetingBlock.attr('data-index', newIndex);
        greetingBlock.find('.alternate_greeting_text').attr('id', `alternate_greeting_${newIndex}`);
        greetingBlock.find('.editor_maximize').attr('data-for', `alternate_greeting_${newIndex}`);
        greetingBlock.find('.greeting_index').text(newIndex + 1);
        return changed;
    };
    /** Shows the default badge and the set/clear buttons for whether this row is now the default. */
    const refreshDefault = () => {
        const isDefault = committed && index === model.defaultIndex;
        greetingBlock.find('.greeting_default_badge').toggle(isDefault);
        greetingBlock.find('.demote_default_greeting').toggle(isDefault);
        greetingBlock.find('.set_default_greeting').toggle(committed && !isDefault);
    };
    /** @type {GreetingRow} */
    (/** @type {any} */ (row)).greetingRow = {
        setIndex,
        refreshDefault,
        isCommitted: () => committed,
        isEditing: () => focused || maximized || saveScheduled || savesInFlight > 0,
    };

    // The maximize editor (opened by a document-level handler after this one) edits this row until its popup closes.
    greetingBlock.find('.editor_maximize').on('click', function () {
        const textareaId = String($(this).attr('data-for'));
        maximized = true;
        updateEditing();
        setTimeout(() => {
            const dialog = Array.from(document.querySelectorAll('textarea.maximized_textarea'))
                .find(editor => /** @type {HTMLElement} */ (editor).dataset.for === textareaId)?.closest('dialog');
            if (!dialog) {
                maximized = false;
                updateEditing();
                return;
            }
            dialog.addEventListener('close', () => {
                maximized = false;
                updateEditing();
            }, { once: true });
        });
    });

    refreshDefault();
    if (pending) {
        greetingBlock.find('.pick_up_greeting').hide();
    }

    greetingBlock.find('.delete_alternate_greeting').on('click', async function (event) {
        event.preventDefault();
        event.stopPropagation();

        if (!committed) {
            // Nothing's been written to the array yet - just drop the empty draft row.
            greetingBlock.remove();
            updateAlternateGreetingsHintVisibility(template);
            return;
        }

        const array = getArray();
        const label = index === model.defaultIndex ? 'the default greeting' : 'this greeting';
        const confirm = await callGenericPopup(t`Are you sure you want to delete ${label}?`, POPUP_TYPE.CONFIRM);
        if (!confirm) {
            return;
        }

        if (menu_type === 'create') {
            array.splice(index, 1);
            session.removeRow(row);
            session.showLocal(reindexDefaultAfterRemoval(model.defaultIndex, index));
            return;
        }

        const avatar = $('.open_alternate_greetings').data('avatar');
        const character = avatar ? charactersStore.get(avatar) : null;
        if (!character) return;
        await queueGreetingSave(avatar, async () => {
            const expectedHash = row.greetingHash;
            if (!Number.isFinite(expectedHash)) return;
            const result = await postGreetingOp('delete', { avatar_url: avatar, position: index, expected_hash: expectedHash });
            if (!result.ok) {
                console.error('Greeting delete failed', { avatar, position: index, status: result.status, reason: result.reason });
                if (result.status === 409) {
                    if (await session?.showCurrentAfterConflict(avatar)) {
                        toastr.warning(t`Someone else changed these greetings, so nothing was deleted. Showing the current version.`, t`Greeting not deleted`);
                    } else {
                        toastr.error(t`Someone else changed these greetings, so nothing was deleted, and the list couldn't be refreshed.`, t`Greeting not deleted`);
                    }
                    return;
                }
                toastr.error(t`Failed to delete the greeting.`, t`Greeting not deleted`);
                return;
            }
            session.removeRow(row);
            applyGreetingOpSuccess(character, result);
        });
    });

    // Pick up to move (pick-and-place reordering)
    greetingBlock.find('.pick_up_greeting').on('click', function (event) {
        event.preventDefault();
        event.stopPropagation();

        // Disabled while the popup's list is stale (a reload after a refused move failed).
        if ($(this).hasClass('disabled')) {
            return;
        }

        if (!committed) {
            // Draft row isn't in the array - nothing to move.
            return;
        }

        picker.pickedKey === index ? picker.cancel() : picker.pick(index);
    });

    // Set as default greeting - pointer move only, the stable order never changes.
    greetingBlock.find('.set_default_greeting').on('click', async function (event) {
        event.preventDefault();
        event.stopPropagation();

        if (!committed) {
            // Draft row isn't in the array - nothing to promote.
            return;
        }

        if (menu_type === 'create') {
            session.showLocal(index);
            return;
        }

        const avatar = $('.open_alternate_greetings').data('avatar');
        const character = avatar ? charactersStore.get(avatar) : null;
        if (!character) return;
        await queueGreetingSave(avatar, async () => {
            const expectedHash = row.greetingHash;
            if (!Number.isFinite(expectedHash)) return;
            const result = await postGreetingOp('default/set', { avatar_url: avatar, position: index, expected_hash: expectedHash });
            if (!result.ok) {
                console.error('Set default greeting failed', { avatar, position: index, status: result.status, reason: result.reason });
                if (result.status === 409) {
                    if (await session?.showCurrentAfterConflict(avatar)) {
                        toastr.warning(t`Someone else changed these greetings, so the default wasn't changed. Showing the current version.`, t`Default not changed`);
                    } else {
                        toastr.error(t`Someone else changed these greetings, so the default wasn't changed, and the list couldn't be refreshed.`, t`Default not changed`);
                    }
                    return;
                }
                toastr.error(t`Failed to set the default greeting.`, t`Default not changed`);
                return;
            }
            applyGreetingOpSuccess(character, result);
        });
    });

    // Clears the default entirely - a card can have no default at all.
    greetingBlock.find('.demote_default_greeting').on('click', async function (event) {
        event.preventDefault();
        event.stopPropagation();

        if (menu_type === 'create') {
            session.showLocal(null);
            return;
        }

        const avatar = $('.open_alternate_greetings').data('avatar');
        const character = avatar ? charactersStore.get(avatar) : null;
        if (!character) return;
        await queueGreetingSave(avatar, async () => {
            const expectedDefaultHash = row.greetingHash;
            if (!Number.isFinite(expectedDefaultHash)) return;
            const result = await postGreetingOp('default/unset', { avatar_url: avatar, expected_default_hash: expectedDefaultHash });
            if (!result.ok) {
                console.error('Unset default greeting failed', { avatar, status: result.status, reason: result.reason });
                if (result.status === 409) {
                    if (await session?.showCurrentAfterConflict(avatar)) {
                        toastr.warning(t`Someone else changed these greetings, so the default wasn't cleared. Showing the current version.`, t`Default not changed`);
                    } else {
                        toastr.error(t`Someone else changed these greetings, so the default wasn't cleared, and the list couldn't be refreshed.`, t`Default not changed`);
                    }
                    return;
                }
                toastr.error(t`Failed to clear the default greeting.`, t`Default not changed`);
                return;
            }
            applyGreetingOpSuccess(character, result);
        });
    });

    template.find('.alternate_greetings_list').append(greetingBlock);
    return row;
}

/**
 * Builds the `/api/characters/create` request body from the confirmed create-mode values in `create_save`.
 * @param {string} [jsonData] Card JSON the new card starts from; `create_save`'s values are written over it.
 * @returns {Promise<FormData>}
 */
async function createSaveToFormData(jsonData) {
    const formData = new FormData();
    formData.set('ch_name', create_save.name);
    formData.set('description', create_save.description);
    formData.set('personality', create_save.personality);
    formData.set('scenario', create_save.scenario);
    formData.set('first_mes', create_save.first_message);
    for (const value of stripEmptyAlternateGreetings(create_save.alternate_greetings, 'create character')) {
        formData.append('alternate_greetings', value);
    }
    formData.set('mes_example', create_save.mes_example);
    formData.set('creator_notes', create_save.creator_notes);
    formData.set('system_prompt', create_save.system_prompt);
    formData.set('post_history_instructions', create_save.post_history_instructions);
    formData.set('creator', create_save.creator);
    formData.set('character_version', create_save.character_version);
    formData.set('tags', create_save.tags);
    formData.set('talkativeness', String(create_save.talkativeness));
    formData.set('world', create_save.world);
    formData.set('depth_prompt_prompt', create_save.depth_prompt_prompt);
    formData.set('depth_prompt_depth', String(create_save.depth_prompt_depth));
    formData.set('depth_prompt_role', create_save.depth_prompt_role);
    formData.set('fav', String(fav_ch_checked));
    formData.set('extensions', JSON.stringify(create_save.extensions));
    if (jsonData !== undefined) {
        formData.set('json_data', jsonData);
    }
    const avatarFile = create_save.avatar?.[0];
    if (avatarFile) {
        formData.set('avatar', await ensureImageFormatSupported(avatarFile));
    }
    return formData;
}

/**
 * Creates a new character from the confirmed create-mode values in `create_save`.
 * @param {object} [options]
 * @param {string} [options.jsonData] Card JSON the new card starts from; `create_save`'s values are written over it.
 */
export async function createCharacterFromCreateSave({ jsonData } = {}) {
    if (blockWhileFieldEditing()) {
        return;
    }
    if (!settingsReady) {
        console.warn('Settings not ready, aborting character creation.');
        return;
    }

    $('#rm_info_avatar').html('');
    // Captured before the post-save field-clearing loop resets create_save.name to '', for the "Character Created" toast.
    const newCharacterName = create_save.name;
    const headers = getRequestHeaders({ omitContentType: true });

    if (newCharacterName.length === 0) {
        toastr.error(t`Name is required`);
        return;
    }
    if (is_group_generating || is_send_press) {
        toastr.error(t`Cannot create characters while generating. Stop the request and try again.`, t`Creation aborted`);
        return;
    }
    try {
        //if the character name text area isn't empty (only posible when creating a new character)
        let url = '/api/characters/create';

        if (crop_data != undefined) {
            url += `?crop=${encodeURIComponent(JSON.stringify(crop_data))}`;
        }

        const fetchResult = await fetch(url, {
            method: 'POST',
            headers: headers,
            body: await createSaveToFormData(jsonData),
            cache: 'no-cache',
        });

        if (!fetchResult.ok) {
            throw new Error('Fetch result is not ok');
        }

        const avatarId = await fetchResult.text();

        const fields = [
            { id: '#character_name_pole', callback: value => create_save.name = value },
            { id: '#description_textarea', callback: value => create_save.description = value },
            { id: '#creator_notes_textarea', callback: value => create_save.creator_notes = value },
            { id: '#character_version_textarea', callback: value => create_save.character_version = value },
            { id: '#post_history_instructions_textarea', callback: value => create_save.post_history_instructions = value },
            { id: '#system_prompt_textarea', callback: value => create_save.system_prompt = value },
            { id: '#tags_textarea', callback: value => create_save.tags = value },
            { id: '#creator_textarea', callback: value => create_save.creator = value },
            { id: '#personality_textarea', callback: value => create_save.personality = value },
            { id: '#alternate_greetings_template', callback: value => create_save.alternate_greetings = value, defaultValue: [] },
            { id: '#talkativeness_slider', callback: value => create_save.talkativeness = value, defaultValue: talkativeness_default },
            { id: '#scenario_pole', callback: value => create_save.scenario = value },
            { id: '#depth_prompt_prompt', callback: value => create_save.depth_prompt_prompt = value },
            { id: '#depth_prompt_depth', callback: value => create_save.depth_prompt_depth = value, defaultValue: depth_prompt_depth_default },
            { id: '#depth_prompt_role', callback: value => create_save.depth_prompt_role = value, defaultValue: depth_prompt_role_default },
            { id: '#mes_example_textarea', callback: value => create_save.mes_example = value },
            { id: '#character_json_data', callback: () => setFormBaseline('#character_json_data', String($('#character_json_data').val())) },
            { id: '#character_world', callback: value => create_save.world = value },
            { id: '#_character_extensions_fake', callback: value => create_save.extensions = {} },
        ];

        fields.forEach(field => {
            const fieldValue = field.defaultValue !== undefined ? field.defaultValue : '';
            $(field.id).val(fieldValue);
            field.callback && field.callback(fieldValue);
        });
        create_save.first_message = ''; // was reset via the #firstmessage_textarea fields-loop entry above
        setGreetingPagerGreetings([''], 0, []);

        if (Array.isArray(create_save.extra_books) && create_save.extra_books.length > 0) {
            const fileName = getCharaFilename(null, { manualAvatarKey: avatarId });
            const charLore = world_info.charLore ?? [];
            charLore.push({ name: fileName, extraBooks: create_save.extra_books });
            Object.assign(world_info, { charLore: charLore });
            saveSettingsDebounced('world_info_settings');
        }
        create_save.extra_books = [];

        create_save.avatar = null;

        $('#add_avatar_button').replaceWith(
            $('#add_avatar_button').val('').clone(true),
        );

        let oldSelectedChar = null;
        if (getSelectionState().type === 'character') {
            oldSelectedChar = getCurrentCharacter().avatar;
        }

        console.log(`new avatar id: ${avatarId}`);
        createTagMapFromList('#tagList', avatarId);
        // select_rm_info() below does its own real, targeted lookup+page-navigation for 'char_create' (see
        // its own body) - no separate list refresh needed here first.
        await getCharacters({ silent: true, skipPrint: true });
        charactersStore.reportCreated(avatarId);

        select_rm_info('char_create', avatarId, oldSelectedChar, newCharacterName);

        crop_data = undefined;
    } catch (error) {
        console.error('Error creating character', error);
        toastr.error(t`Failed to create character`);
    }
}

// Upstream's whole-form save, kept for third-party extensions: they write a `#form_create` input, then call
// createOrEditCharacter() or saveCharacterDebounced(). First-party code saves the one field it changed instead
// (.eslintrc.cjs forbids importing these two). Edit mode writes only what differs, each through the fork's own
// conflict-checked path.

/** Create-mode inputs and the `create_save` key each one's input handler keeps in sync. */
const CREATE_SAVE_INPUTS = {
    '#character_name_pole': 'name',
    '#description_textarea': 'description',
    '#character_world': 'world',
    '#creator_notes_textarea': 'creator_notes',
    '#post_history_instructions_textarea': 'post_history_instructions',
    '#system_prompt_textarea': 'system_prompt',
    '#tags_textarea': 'tags',
    '#creator_textarea': 'creator',
    '#character_version_textarea': 'character_version',
    '#personality_textarea': 'personality',
    '#talkativeness_slider': 'talkativeness',
    '#scenario_pole': 'scenario',
    '#depth_prompt_prompt': 'depth_prompt_prompt',
    '#depth_prompt_depth': 'depth_prompt_depth',
    '#depth_prompt_role': 'depth_prompt_role',
    '#mes_example_textarea': 'mes_example',
};
const NUMERIC_CREATE_SAVE_KEYS = new Set(['talkativeness', 'depth_prompt_depth']);

/** Card paths only the /greetings/* operations may change. */
const GREETING_CARD_PATHS = [['first_mes'], ['data', 'first_mes'], ['alternate_greetings'], ['data', 'alternate_greetings'], ['data', 'extensions', GREETING_DEFAULT_POSITION_KEY]];
/** merge-attributes reads these as request fields, not card paths. */
const MERGE_REQUEST_PATHS = [['avatar'], ['_loadedFieldHashes']];

let createOrEditCharacterTail = Promise.resolve();

/**
 * Upstream's save of the whole character form. Create mode creates the character; edit mode saves each
 * form value that differs from what is stored, then redraws the first message the way upstream regenerated it.
 * @param {Event} [e] A `newChat` CustomEvent skips the first-message redraw.
 * @returns {Promise<void>} Resolves undefined, never rejects; failures are toasted.
 */
export async function createOrEditCharacter(e) {
    const run = createOrEditCharacterTail.then(() => runCreateOrEditCharacter(e));
    createOrEditCharacterTail = run;
    await run;
}

/** Upstream's debounced {@link createOrEditCharacter}. */
export const saveCharacterDebounced = debounce(() => { void createOrEditCharacter(); }, DEFAULT_SAVE_EDIT_TIMEOUT);

/** @param {Event} [e] */
async function runCreateOrEditCharacter(e) {
    try {
        if ($('#form_create').attr('actiontype') === 'createcharacter') {
            await createFromForm();
        } else {
            await saveEditedCharacterFromForm(e instanceof CustomEvent && e.type === 'newChat');
        }
    } catch (error) {
        console.error('createOrEditCharacter failed', error);
        toastr.error(t`Something went wrong while saving the character.`);
    }
}

async function createFromForm() {
    for (const [formId, key] of Object.entries(CREATE_SAVE_INPUTS)) {
        if (isFieldInEdit(formId.slice(1))) continue;
        const value = String($(formId).val() ?? '');
        if (value !== String(create_save[key] ?? '')) {
            create_save[key] = NUMERIC_CREATE_SAVE_KEYS.has(key) ? Number(value) : value;
        }
    }
    const greeting = String($('#greeting_field').val() ?? '');
    if (!isFieldInEdit('greeting_field') && greeting !== (greetingPagerState.greetings[greetingPagerState.index] ?? '')) {
        await commitGreetingFieldValue(greeting);
    }
    await createCharacterFromCreateSave({ jsonData: createModeJsonData() });
}

/**
 * The card JSON a form-driven create starts from: `#character_json_data`, with `#character_book_json` as its
 * embedded lorebook, kept as-is like an imported card's.
 * @returns {string|undefined}
 */
function createModeJsonData() {
    let card;
    const raw = String($('#character_json_data').val() ?? '');
    if (raw !== '') {
        card = parseJsonObject(raw);
        if (!card) {
            console.warn('createOrEditCharacter: #character_json_data is not a JSON object, creating without it');
        }
    }
    const bookRaw = String($('#character_book_json').val() ?? '');
    if (bookRaw !== '') {
        try {
            const book = JSON.parse(bookRaw);
            card = card ?? {};
            lodash.set(card, ['data', 'character_book'], book);
        } catch (error) {
            console.warn('createOrEditCharacter: #character_book_json is not JSON, creating without it', error);
        }
    }
    if (!card) {
        return undefined;
    }
    // The greetings come from create_save; a position recorded against the JSON's own greetings would misplace the default.
    lodash.unset(card, ['data', 'extensions', GREETING_DEFAULT_POSITION_KEY]);
    return JSON.stringify(card);
}

/** @param {boolean} isNewChat */
async function saveEditedCharacterFromForm(isNewChat) {
    const avatar = getEditorCharacterAvatar();
    if (!avatar || !charactersStore.get(avatar)) {
        return;
    }
    await flushCharacterFieldSaves();

    /** @type {string[][]} Card paths a changed form input writes; `#character_json_data` leaves them alone. */
    const formPaths = [];

    const changedFields = [];
    for (const [formId, mapping] of Object.entries(FORM_TO_CARD)) {
        if (isFieldInEdit(formId.slice(1))) continue;
        const value = String($(formId).val() ?? '');
        if (formValuesMatch(formId, mapping, value, characterFormValue(charactersStore.get(avatar), formId))) continue;
        changedFields.push({ formId, value });
        formPaths.push(lodash.toPath(mapping.v2));
        if (mapping.v1) formPaths.push(lodash.toPath(mapping.v1));
    }

    const createDate = String($('#create_date_pole').val() ?? '');
    const createDateBaseline = getFormBaseline('#create_date_pole');
    const createDateChanged = createDateBaseline !== undefined && createDate !== createDateBaseline;
    if (createDateChanged) formPaths.push(['create_date']);

    const chatPointer = String($('#selected_chat_pole').val() ?? '');
    const chatBaseline = getFormBaseline('#selected_chat_pole');
    const chatChanged = chatBaseline !== undefined && chatPointer !== chatBaseline;
    if (chatChanged) formPaths.push(['chat']);

    for (const { formId, value } of changedFields) {
        await saveCharacterField(avatar, formId, value);
    }

    await saveJsonDataFromForm(avatar, formPaths);

    if (createDateChanged && await mergeCharacterPaths(avatar, [{ path: ['create_date'], value: createDate }])) {
        setFormBaseline('#create_date_pole', createDate);
    }

    if (chatChanged && await saveActiveChat(avatar, chatPointer)) {
        setFormBaseline('#selected_chat_pole', chatPointer);
    }

    if (!isNewChat) {
        await redrawFirstMessage(avatar);
    }
}

/**
 * Whether a form input's value means the same card value as the stored card's.
 * @param {string} formId
 * @param {{transform?: string}} mapping
 * @param {string} value The input's value.
 * @param {string} storedValue {@link characterFormValue} of the stored card.
 */
function formValuesMatch(formId, mapping, value, storedValue) {
    if (value === storedValue) return true;
    const converted = characterFieldValueToCardValue(formId, mapping, value);
    const stored = characterFieldValueToCardValue(formId, mapping, storedValue);
    return converted.ok && stored.ok && lodash.isEqual(converted.value, stored.value);
}

/**
 * Saves what an outside writer changed in `#character_json_data` since the fork last wrote it.
 * @param {string} avatar
 * @param {string[][]} formPaths Paths a changed form input already writes.
 */
async function saveJsonDataFromForm(avatar, formPaths) {
    const raw = String($('#character_json_data').val() ?? '');
    const baselineRaw = getFormBaseline('#character_json_data');
    if (baselineRaw === undefined || raw === baselineRaw) {
        return;
    }
    const card = parseJsonObject(raw);
    const baselineCard = parseJsonObject(baselineRaw);
    if (!card || !baselineCard) {
        console.warn('createOrEditCharacter: #character_json_data (or what the editor last loaded into it) is not a JSON object, so it was not saved');
        return;
    }

    const changes = diffJsonPaths(baselineCard, card).filter(({ path }) =>
        !pathsOverlap(path, GREETING_CARD_PATHS) && !pathsOverlap(path, MERGE_REQUEST_PATHS) && !pathsOverlap(path, formPaths));
    if (changes.length > 0) {
        if (!await mergeCharacterPaths(avatar, changes)) return;
        refreshEditorFieldsAfterMerge(avatar, changes);
    }
    if (!await saveGreetingsFromForm(avatar, baselineCard, card)) return;
    setFormBaseline('#character_json_data', raw);
}

/**
 * @param {string} raw
 * @returns {Record<string, any>|null}
 */
function parseJsonObject(raw) {
    try {
        const value = JSON.parse(raw);
        return lodash.isPlainObject(value) ? value : null;
    } catch {
        return null;
    }
}

/**
 * Every leaf path whose value differs between two JSON objects. Arrays are compared whole.
 * @param {Record<string, any>} before
 * @param {Record<string, any>} after
 * @param {string[]} [prefix]
 * @param {{path: string[], value?: any, removed?: boolean}[]} [out]
 */
function diffJsonPaths(before, after, prefix = [], out = []) {
    for (const key of Object.keys(before)) {
        if (!Object.hasOwn(after, key)) out.push({ path: [...prefix, key], removed: true });
    }
    for (const key of Object.keys(after)) {
        const path = [...prefix, key];
        if (!Object.hasOwn(before, key)) {
            out.push({ path, value: after[key] });
        } else if (lodash.isPlainObject(before[key]) && lodash.isPlainObject(after[key])) {
            diffJsonPaths(before[key], after[key], path, out);
        } else if (!lodash.isEqual(before[key], after[key])) {
            out.push({ path, value: after[key] });
        }
    }
    return out;
}

/**
 * Whether `path` is, contains or sits inside any of `paths`.
 * @param {string[]} path
 * @param {string[][]} paths
 */
function pathsOverlap(path, paths) {
    return paths.some(other => {
        const length = Math.min(path.length, other.length);
        for (let i = 0; i < length; i++) {
            if (path[i] !== other[i]) return false;
        }
        return true;
    });
}

/**
 * Writes card paths through merge-attributes. A removed path is unset.
 * @param {string} avatar
 * @param {{path: string[], value?: any, removed?: boolean}[]} changes
 * @returns {Promise<boolean>} Whether they were saved.
 */
async function mergeCharacterPaths(avatar, changes) {
    const mergeData = { avatar };
    for (const { path, value, removed } of changes) {
        lodash.set(mergeData, path, removed ? UNSET_VALUE : value);
    }
    try {
        const response = await fetch('/api/characters/merge-attributes', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(mergeData),
        });
        if (!response.ok) {
            throw new Error(`merge-attributes answered ${response.status}`);
        }
        await getOneCharacter(avatar);
        await eventSource.emit(event_types.CHARACTER_EDITED, { detail: { id: characterEditedId(avatar), character: charactersStore.get(avatar) } });
        updateCharacterListRow(avatar);
        return true;
    } catch (error) {
        console.error(`Failed to save ${avatar}`, error);
        toastr.error(t`Something went wrong while saving the character.`);
        return false;
    }
}

/**
 * A merge changed stored fields the editor shows: show the stored value and take it as the conflict baseline,
 * except in a field being edited or with a save pending, whose own save then meets the change as a conflict.
 * @param {string} avatar
 * @param {{path: string[]}[]} changes
 */
function refreshEditorFieldsAfterMerge(avatar, changes) {
    if (_loadedCharacterFieldHashesAvatar !== avatar) return;
    const character = charactersStore.get(avatar);
    const changedPaths = changes.map(change => change.path);
    for (const [formId, mapping] of Object.entries(FORM_TO_CARD)) {
        const fieldPaths = [mapping.v2, mapping.v1].filter(Boolean).map(p => lodash.toPath(p));
        if (!fieldPaths.some(p => pathsOverlap(p, changedPaths))) continue;
        const id = formId.slice(1);
        if (isFieldInEdit(id) || pendingCharacterFieldSaves.has(characterFieldSaveKey(avatar, formId)) || characterFieldSaveChains.has(characterFieldSaveKey(avatar, formId))) continue;
        setFieldValue(id, characterFormValue(character, formId));
        _loadedCharacterFieldHashes.set(mapping.v2, hashCharacterFieldValue(character, mapping.v2));
    }
}

/**
 * Drops empty greetings other than the default, as stripEmptyAlternateGreetings() does, keeping the
 * default's place among the rest.
 * @param {GreetingsModel} model
 * @returns {GreetingsModel}
 */
function withoutEmptyGreetings(model) {
    const greetings = [];
    let defaultIndex = null;
    model.greetings.forEach((greeting, index) => {
        if (index === model.defaultIndex) {
            defaultIndex = greetings.length;
            greetings.push(greeting);
        } else if (greeting !== '') {
            greetings.push(greeting);
        }
    });
    return { greetings, defaultIndex };
}

/**
 * Makes the stored greetings equal the JSON's, through the greeting operations. Every edit, delete and default
 * change is checked against the greetings as the fork last loaded them (with this run's own saved ops applied), so a
 * greeting another session changed since then is refused, not overwritten; clearing the default is checked against
 * the default greeting's text, not its position. A refused op is skipped and the rest of
 * the run still goes through; a warning then lists each change that wasn't saved, with its text. An op that fails
 * any other way stops the run: the warning then also lists it and every change after it, none of them sent. Adds can't
 * overwrite anything, so they are appended to the list as currently stored, with no length check.
 * @param {string} avatar
 * @param {object} baselineCard
 * @param {object} card
 * @returns {Promise<boolean>} False when an op failed other than by being refused; the ones after it were not sent.
 */
async function saveGreetingsFromForm(avatar, baselineCard, card) {
    const start = cardToGreetingsModel(baselineCard);
    const target = withoutEmptyGreetings(cardToGreetingsModel(card));
    if (lodash.isEqual(start, target)) {
        return true;
    }

    // One queued save for the whole run: its ops never overlap another greeting write for this character.
    return await queueGreetingSave(avatar, async () => {
        // The greetings as loaded, with this run's saved ops applied: every precondition is read from here.
        const planned = start.greetings.slice();
        let plannedDefault = start.defaultIndex;
        /** @type {string[]} Changes refused because another session changed their greeting. */
        const refused = [];
        /** @type {string[]} The change whose op failed otherwise, and every change after it, none of them sent. */
        const notSent = [];
        // Set by an op that failed other than by being refused: no op after it is sent.
        let stopped = false;

        const warnNotSaved = () => {
            if (refused.length === 0 && notSent.length === 0) return;
            const section = (intro, items) => (items.length === 0 ? '' : `${escapeHtml(intro)}<ul>${items.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`);
            toastr.warning(
                section(t`These greetings were changed in another session, so these changes to them were not saved. Redo them if you still want them:`, refused)
                + section(t`Saving failed, so these changes were not saved. Redo them if you still want them:`, notSent),
                t`Some greeting changes not saved`,
                { escapeHtml: false, timeOut: 0, extendedTimeOut: 0 },
            );
        };

        /**
         * @param {string} opName
         * @param {object} body
         * @param {string} description What the change was, for the warning if it isn't saved.
         * @returns {Promise<'saved'|'not saved'>}
         */
        const runOp = async (opName, body, description) => {
            if (stopped) {
                notSent.push(description);
                return 'not saved';
            }
            const result = await postGreetingOp(opName, { avatar_url: avatar, ...body });
            if (!result.ok) {
                console.error('Greeting save failed', { avatar, opName, status: result.status, reason: result.reason });
                if (result.status === 409) {
                    refused.push(description);
                    return 'not saved';
                }
                toastr.error(t`Failed to save the greeting. Your edit is still shown here, but it was not saved.`, t`Greeting not saved`);
                stopped = true;
                notSent.push(description);
                return 'not saved';
            }
            const character = charactersStore.get(avatar);
            if (character) {
                applyGreetingOpSuccess(character, result, opName === 'edit' ? { expectedHash: body.expected_hash, text: body.text } : undefined);
            }
            return 'saved';
        };

        const run = async () => {
            const shared = Math.min(planned.length, target.greetings.length);
            for (let position = 0; position < shared; position++) {
                const text = target.greetings[position];
                if (planned[position] === text) continue;
                const outcome = await runOp('edit', { position, expected_hash: hashGreetingText(planned[position]), text }, t`Greeting ${position + 1} changed to: ${text}`);
                if (outcome === 'saved') planned[position] = text;
            }
            for (let index = planned.length; index < target.greetings.length; index++) {
                const text = target.greetings[index];
                const outcome = await runOp('add', { append: true, text }, t`New greeting: ${text}`);
                if (outcome === 'saved') planned.push(text);
            }
            for (let position = planned.length - 1; position >= target.greetings.length; position--) {
                const text = planned[position];
                const outcome = await runOp('delete', { position, expected_hash: hashGreetingText(text) }, t`Greeting ${position + 1} deleted: ${text}`);
                if (outcome === 'saved') {
                    planned.splice(position, 1);
                    plannedDefault = reindexDefaultAfterRemoval(plannedDefault, position);
                }
            }
            if (plannedDefault !== target.defaultIndex) {
                if (target.defaultIndex === null) {
                    await runOp('default/unset', { expected_default_hash: hashGreetingText(planned[plannedDefault]) }, t`Default greeting cleared`);
                } else {
                    const text = target.greetings[target.defaultIndex];
                    const description = t`Default greeting set to: ${text}`;
                    if (planned[target.defaultIndex] !== text) {
                        // The change that would have put this greeting there wasn't saved.
                        (stopped ? notSent : refused).push(description);
                    } else {
                        await runOp('default/set', { position: target.defaultIndex, expected_hash: hashGreetingText(text) }, description);
                    }
                }
            }
            return !stopped;
        };

        const ok = await run();
        warnNotSaved();
        return ok;
    });
}

/**
 * Upstream regenerated message 0 on save when the chat had not started. The fork never rewrites stored rows,
 * so it shows message 0 from the current card and persona and fires the events upstream fired.
 * @param {string} avatar
 */
async function redrawFirstMessage(avatar) {
    if (selected_group || chat_metadata.tainted || getCurrentCharacter()?.avatar !== avatar) {
        return;
    }
    if (chat.length === 0) {
        if (!await pushFirstMessageIntoEmptyChat()) return;
        await printMessages();
    } else if (chat.length === 1 && !chat[0].is_user && !chat[0].is_system) {
        updateMessageBlock(0, chat[0]);
    } else {
        return;
    }
    await eventSource.emit(event_types.MESSAGE_RECEIVED, 0, 'first_message');
    await eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, 0, 'first_message');
}

/**
 * Saves a new avatar image for an existing character - only the image, through `/api/characters/edit-avatar`.
 * @param {string} avatar Avatar filename of the character.
 * @param {File} file The picked image; cropped server-side by the current `crop_data`, if any.
 * @returns {Promise<boolean>} Whether the image was saved.
 */
async function saveCharacterAvatar(avatar, file) {
    try {
        let avatarEditUrl = '/api/characters/edit-avatar';
        if (crop_data != undefined) {
            avatarEditUrl += `?crop=${encodeURIComponent(JSON.stringify(crop_data))}`;
        }

        const avatarFormData = new FormData();
        avatarFormData.append('avatar', await ensureImageFormatSupported(file));
        avatarFormData.append('avatar_url', avatar);

        const avatarFetchResult = await fetch(avatarEditUrl, {
            method: 'POST',
            headers: getRequestHeaders({ omitContentType: true }),
            body: avatarFormData,
            cache: 'no-cache',
        });

        if (!avatarFetchResult.ok) {
            toastr.error(t`Failed to upload the new avatar image.`, t`Avatar not saved`);
            return false;
        }

        $('#add_avatar_button').replaceWith(
            $('#add_avatar_button').val('').clone(true),
        );
        crop_data = undefined;

        await getOneCharacter(avatar);
        await eventSource.emit(event_types.CHARACTER_EDITED, { detail: { id: characterEditedId(avatar), character: charactersStore.get(avatar) } });
        updateCharacterListRow(avatar);
        return true;
    } catch (error) {
        console.error('Failed to save the avatar image', error);
        toastr.error(t`Something went wrong while saving the avatar, or the image file provided was in an invalid format. Double check that the image is not a webp.`);
        return false;
    }
}

/**
 * Formats a counter for a swipe view.
 * @param {number} current The current number of items.
 * @param {number} total The total number of items.
 * @returns {string} The formatted counter.
 */
function formatSwipeCounter(current, total) {
    if (isNaN(current) && isNaN(total)) {
        return '';
    }
    return `${!isNaN(current) ? current : '?'}\u200b/\u200b${!isNaN(total) ? total : '?'}`;
}

/**
 * Handles the swipe event.
 * @param {SwipeEvent} event Event.
 * @param {SWIPE_DIRECTION} direction The direction to swipe.
 * @param {object} params Additional parameters.
 * @param {import('./scripts/constants.js').SWIPE_SOURCE} [params.source]  The source of the swipe event.
 * @param {boolean} [params.repeated] Is the swipe event repeated.
 * @param {ChatMessage} [params.message=chat[chat.length - 1]] The chat message to swipe.
 * @param {number} [params.forceMesId] The message id to swipe.
 * @param {number} [params.forceSwipeId] The target swipe_id. When out of range, it will be looped or clamped.
 * @param {number} [params.forceDuration] Overwrites the default swipe duration.
 */
export async function swipe(event, direction, { source, repeated, message = chat[chat.length - 1], forceMesId, forceSwipeId, forceDuration } = {}) {
    if (chat.length === 0) {
        console.warn('Swipe was called on an empty chat.');
        return;
    }

    let messageIndex;

    //Only set messageIndex if message exists because -1 is truthy.
    if (message) {
        messageIndex = chat.indexOf(message);
        if (messageIndex === -1 && typeof (forceMesId) != 'number') {
            console.error(`The message must exist in chat. ${message};`);
            return;
        }
    }

    const mesId = Number(forceMesId ?? event?.currentTarget?.closest('.mes')?.getAttribute('mesid') ?? messageIndex ?? chat.length - 1);

    //`message` defaults to the last message; without this an arrow on an earlier message would be checked against the wrong one.
    if (forceMesId == null && event?.currentTarget?.closest('.mes')?.getAttribute('mesid') != null && chat[mesId]) {
        message = chat[mesId];
        messageIndex = mesId;
    }

    if ([SWIPE_SOURCE.DELETE, SWIPE_SOURCE.BACK, SWIPE_SOURCE.AUTO_SWIPE, SWIPE_SOURCE.SLASH_COMMAND, SWIPE_SOURCE.SWIPE_PICKER].includes(source)) {
        console.info(`The ${direction} swipe source on message #${mesId} is ${source}, Most checks have been bypassed. `);
    } else {
        //Only show an error if swipes are not hidden and a message is generating.
        if (isGenerating() && (swipes && !swipesHidden && (swipeState === SWIPE_STATE.NONE))) {
            toastr.warning(t`Cannot swipe while generating. Stop the request and try again.`, t`Swipe aborted`);
            return;
        }
        //Only allow one concurrent swipe.
        if (!isSwipingAllowed()) {
            console.info('The swipe has been ignored messages cannot currently be swiped.');
            return;
        }
        if (!isMessageSwipeable(mesId, message)) {
            console.info(`Message #${mesId} cannot be swiped. ${message}`);
            return;
        }
    }

    // Cancel pending save to prevent accidental swipe_id overwrites.
    cancelDebouncedChatSave();

    swipeState = SWIPE_STATE.SWIPING;
    let generation;

    // Reassigned after loadFromSwipeId() below, which can redraw the DOM out from under mesId.
    let thisMesDiv = chatElement.children('.mes').filter(`[mesid="${mesId}"]`);
    let thisMesText = thisMesDiv.find('.mes_block .mes_text');
    const thisMesDivHeight = thisMesDiv[0]?.scrollHeight;
    const thisMesTextHeight = thisMesText[0]?.scrollHeight;
    if (![thisMesDiv.length, thisMesText.length].every(num => num > 0)) {
        console.error(`Message #${mesId}'s DOM element is not valid.`);
        return;
    }
    const originalSwipeId = Number(chat[mesId]?.swipe_id ?? 0);
    let newSwipeId = Number(forceSwipeId ?? originalSwipeId);

    /**
     * Calculates the next swipe duration with how many swipes have been repeated.
     * @param {number} animation_duration
     * @returns {number} The adjusted swipe duration.
     */
    function getSwipeDuration(animation_duration) {
        const now = performance.now();
        const resetTime = animation_duration * 2 + 300;

        //Reset the counter if the last swipe was more than half a second ago.
        if (now - lastSwipeInfo.now >= resetTime || direction !== lastSwipeInfo.direction) recentSwipes = 0;
        recentSwipes++;
        lastSwipeInfo = { now, direction };

        //At 4 swipes, animation_duration will be halved.
        const sigmoid = 1 / (1 + Math.exp(recentSwipes - 4));

        return animation_duration * sigmoid;
    }

    const swipeDuration = forceDuration ?? getSwipeDuration(animation_duration);

    //The offscreen messages may be visible if the user resizes the viewport during a swipe.
    const thisMesDivWidth = thisMesDiv.width() + 30;
    let swipeRange = (direction === SWIPE_DIRECTION.RIGHT) ? -thisMesDivWidth : thisMesDivWidth;

    /**
     * Waits for the generation to end, reverts the swipe if swipe_id has not changed.
     * @param {boolean} revert Attept to revert the swipe without saving.
     */
    async function endSwipe(revert = false) {
        //Wait for the generation to end.
        try {
            //`mes_buttons` need to be hidden until the animation completes.
            if (generation) {
                document.body.dataset.swiping = 'true';
                await generation;
            }
        } catch (error) {
            console.warn(`Swipe failed, Swiping back. ${error}`);
        }

        //Clamp Id between swipes.
        let clampedId = clamp(chat[mesId].swipe_id, 0, Math.max(0, chat[mesId].swipes.length - 1));

        await updateSwipeCounter(mesId);
        //Fallback.
        if (mesId != chat.length - 1) {
            await updateSwipeCounter(chat.length - 1);
        }

        // If swipe_id has not changed, give the user feedback.
        if (clampedId == originalSwipeId && source != SWIPE_SOURCE.DELETE) {
            try {
                //Shake 700/140=5px
                shakeElement(thisMesDiv, -swipeRange / 140, animation_duration, 'ease-in');
                //Flash red.
                const flashTime = Math.max(animation_duration * 2, 100);
                await Promise.race([thisMesDiv.find('.swipes-counter').animate({ color: 'red' }, flashTime).animate({ color: '' }).promise(), createTimeout(flashTime * 4, `The shake animation did not end within ${flashTime * 4}ms`)].filter(Boolean));
            } catch (error) {
                console.warn(error);
            }
        }

        //If the id is not within bounds, Swipe back.
        if (chat[mesId]?.swipe_id !== clampedId || revert) {
            // Prevent recursion.
            if (source != SWIPE_SOURCE.BACK) {
                source = SWIPE_SOURCE.BACK;
                updateMessage(mesId, { swipe_id: clampedId });

                //Update the chat.
                await loadFromSwipeId(mesId, clampedId);
                await redisplayChat({ startIndex: mesId });
            } else {
                await Popup.show.confirm(
                    t`ERROR: <code>syncSwipeToMes</code> has failed to revert the failed ${direction} swipe on message #${mesId}.`,
                    t`<p>After you click OK, the chat will be reloaded to prevent data corruption.</p>`,
                    { okButton: 'OK', cancelButton: false },
                );
                console.trace(`Error! Recursion detected when reverting failed ${direction} swipe on message #${mesId}. Something has broken.`);
                await reloadCurrentChat();
            }
        }

        //Allow for another swipe.
        swipeState = SWIPE_STATE.NONE;
        delete document.body.dataset.swiping;
        showSwipeButtons();
    }

    async function standardSwipe(newSwipeId) {
        //If swipe_id has changed, or the source is being deleted.
        if (newSwipeId !== originalSwipeId || source == SWIPE_SOURCE.DELETE || source == SWIPE_SOURCE.BACK) {
            //Update the chat.
            await loadFromSwipeId(mesId, newSwipeId);
            // loadFromSwipeId() may have just replaced mesId's element via redisplayChat() - reacquire the live one.
            thisMesDiv = chatElement.children('.mes').filter(`[mesid="${mesId}"]`);
            thisMesText = thisMesDiv.find('.mes_block .mes_text');
            //Transition to the new chat.
            await animateSwipe();
        }
        await endSwipe();
    }

    /**
     * Builds the updates that clear a message's extra and gen times.
     * @param {ChatMessage} message
     * @returns {Partial<ChatMessage>} Updates to pass to updateMessage.
     */
    function clearMessageData(message) {
        const updates = { gen_started: undefined, gen_finished: undefined };
        if (message.extra && typeof message.extra === 'object') {
            const extra = { ...message.extra };
            delete extra.memory;
            delete extra.display_text;
            delete extra.media;
            delete extra.inline_image;
            delete extra.files;
            delete extra.fileLength;
            delete extra.generationType;
            delete extra.negative;
            delete extra.title;
            delete extra.append_title;
            updates.extra = extra;
        }
        return updates;
    }

    /**
     * Sets the message to the newSwipeId and loads it.
     * @param {number} mesId
     * @param {number} newSwipeId
     */
    async function loadFromSwipeId(mesId, newSwipeId) {
        // Leaving a blank slot means the truncation it caused is over, so what followed comes back. Checked before the switch, since the slot stops being current afterwards.
        const leavingBlank = _isBlankSlot(chat[mesId], chat[mesId]?.swipe_id ?? 0)
            && newSwipeId !== (chat[mesId]?.swipe_id ?? 0);

        // A wide fork point arrives with most alternatives as holes; fetch this one first so the swipe never lands on empty.
        await hydrateSwipes(mesId, { index: newSwipeId });

        //Update the swipe_id and clear stale generation data.
        updateMessage(mesId, { swipe_id: newSwipeId, ...clearMessageData(chat[mesId]) });

        //Load from swipes.
        if (syncSwipeToMes(mesId, newSwipeId) == false) {
            let errorMessage = t`When swiping ${direction} on message ${mesId}, syncSwipeToMes has returned false. Attempting to swipe back!`;
            toastr.error(errorMessage);

            updateMessage(mesId, { swipe_id: originalSwipeId });
            await endSwipe(true);
            return true;
        }

        //Moving to a different alternative means adopting its node and loading what follows it.
        const switched = await switchToAlternativePath(mesId, newSwipeId);

        // Swiping back onto the same slot doesn't change node, so the switch above is a no-op - restore explicitly.
        if (leavingBlank && !switched) {
            await _restoreContinuation(mesId);
        }
        return true;
    }

    /**
     * Animates a swipe for all messages >= mesId.
     * @param {number} mesId
     * @param {object} params
     * @param {string} [params.xStart='opx']
     * @param {string} [params.xEnd='0px']
     * @param {number} [params.duration=animation_duration]
     * @param {string} [params.classes=''] Additional CSS classes to target during the swipe.
     * @param {boolean} [params.freeze=true] When true, do not remove the class from the animation, leaving it stuck at xEnd.
     * @returns {Promise<boolean|Function>} endSlide unfreezes the messages from xEnd.
     */
    async function animateSwipeTransition(mesId, { xStart = '0px', xEnd = '0px', duration = animation_duration, classes = '', freeze = false } = {}) {
        // If the animation_duration is zero, the 'animationend' promise will never resolve.
        //Skip the animation if it's faster than 50ms.
        if (duration <= 50) return;

        //Select MAXIMUM_ANIMATED messages after mesId. Ideally, only visible messages would be animated.
        const MAXIMUM_ANIMATED = 100;

        const messages = chatElement.children('.mes');
        const firstDisplayedMesId = Number(messages.first().attr('mesid'));

        const swipedMessagesDiv = messages.filter((index, div) => {
            // const messageId = Number($(div).attr('mesid')); //Slower.
            //This assumes the messages are in order and their Id's are accurate.
            const divMessageId = firstDisplayedMesId + index;

            return (divMessageId < mesId + MAXIMUM_ANIMATED && divMessageId >= mesId);
        });
        if (swipedMessagesDiv.length > 0) {
            let swipeClasses = '.mes_block, .mesAvatarWrapper';
            swipeClasses += classes;

            //Select only the target classes.
            const swipedElementsDiv = swipedMessagesDiv.children(swipeClasses);
            if (swipedElementsDiv.length > 0) {
                //This is a global variable, only one swipe transition can occur concurrently.
                document.documentElement.style.setProperty('--slide-mes-x-start', xStart);
                document.documentElement.style.setProperty('--slide-mes-x-end', xEnd);
                document.documentElement.style.setProperty('--slide-mes-x-duration', `${duration}ms`);

                //The class must be removed to unfreze previous slides.
                swipedElementsDiv.removeClass('slide');
                //CSS starts the animation.
                void swipedElementsDiv[0].offsetWidth;
                swipedElementsDiv.addClass('slide');

                const endSlide = () => {
                    //Remove the style when done.
                    swipedElementsDiv.removeClass('slide');

                    document.documentElement.style.setProperty('--slide-mes-x-start', '');
                    document.documentElement.style.setProperty('--slide-mes-x-end', '');
                    document.documentElement.style.setProperty('--slide-mes-duration', '');
                    return true;
                };
                //Wait for the animation's end. https://developer.mozilla.org/en-US/docs/Web/API/Animation/finished
                const animations = swipedElementsDiv[0]?.getAnimations() ?? [];
                const animation = animations.filter((a) => a instanceof globalThis.CSSAnimation && a.animationName == 'slide')[0];
                try {
                    await Promise.race([animation?.finished, createTimeout(duration * 2, `The ${duration}ms swipe animation has not ended after ${duration * 2}ms. It has been skipped.`)].filter(Boolean));
                } catch (error) {
                    console.warn(error);
                }

                //If not frozen, end the slide now.
                return freeze ? endSlide : endSlide();
            }
        }
        console.warn(`No animatable messages were found after message #${mesId}.`);
        return false;
    }

    /**
     * @returns {number|null} The scrollTop that pins mesId's live element's bottom to the chat's visible bottom, or null if it has no live on-screen element.
     */
    function getMessageBottomHeight() {
        // Resolved fresh against mesId every call, never a held reference - the element can be replaced mid-swipe by redisplayChat().
        const liveMesDiv = chatElement.children('.mes').filter(`[mesid="${mesId}"]`);
        if (!liveMesDiv[0]?.isConnected) {
            return null;
        }
        // Viewport-relative rects must anchor to chatElement's own rect before combining with its content-relative scrollTop().
        const containerRect = chatElement[0].getBoundingClientRect();
        const thisMesRect = liveMesDiv[0].getBoundingClientRect();
        const overflow = thisMesRect.bottom - containerRect.bottom;
        return chatElement.scrollTop() + overflow;
    }

    function expandNewMessage(thisMesDiv) {
        //Only scroll if the view is not near the bottom.
        const is_animation_scroll = (chatElement.scrollTop() >= (chatElement.prop('scrollHeight') - chatElement.outerHeight()) - 10);

        let new_height = thisMesDivHeight - (thisMesTextHeight - thisMesText[0].scrollHeight);
        if (new_height < 103) new_height = 103;

        //Keep the swipe buttons at the same height when scrolling is finished.

        /** @param {number|null} target */
        const applyScrollPin = target => {
            if (is_animation_scroll && target !== null) chatElement.scrollTop(target);
        };

        // thisMesDiv only drives the height tween; the scroll pin is a separate, always-live concern (getMessageBottomHeight()).
        //Expand new message.
        thisMesDiv.animate({ height: new_height + 'px' }, {
            duration: 0, //used to be 100 //Disabled on Cohee's request. https://github.com/SillyTavern/SillyTavern/pull/4610/files#r2408731744
            queue: false,
            progress: function (animation, progress, remainingMs) {
                applyScrollPin(getMessageBottomHeight());
            },
            complete: function () {
                thisMesDiv.css('height', 'auto');
                //Correct height auto offset.
                applyScrollPin(getMessageBottomHeight());
            },
        });
    }

    /**
     * Anime a swipe, optionally running a generation.
     * @param {boolean} run_generate
     * @param {boolean} [skipSwipeOut=false]
     */
    async function animateSwipe(run_generate = false, skipSwipeOut = false) {
        if (!skipSwipeOut) {
            //Swipe out.
            await animateSwipeTransition(mesId, { xEnd: `${swipeRange}px`, duration: swipeDuration });
        }


        if (run_generate) {
            await updateSwipeCounter(mesId);
            //shows "..." while generating
            thisMesDiv.find('.mes_text').html('...');
            // resets the timer
            thisMesDiv.find('.mes_timer').html('');
            thisMesDiv.find('.tokenCounterDisplay').text('');
            updateReasoningUI(thisMesDiv, { reset: true });
        } else {
            //console.log('showing previously generated swipe candidate, or "..."');
            //console.log('onclick right swipe calling addOneMessage');

            // Scrolling here raced with expandNewMessage()'s own scroll pin, causing a visible double-jump; expandNewMessage() is now the single source of truth for scroll position during a swipe.
            //The swipe buttons will be refreshed in endSwipe(), refreshing them now will cause flickering.
            addOneMessage(chat[mesId], { type: 'swipe', forceId: mesId, scroll: false, showSwipes: false });

            if (power_user.message_token_count_enabled) {
                const tokenCountText = (chat[mesId]?.extra?.reasoning || '') + chat[mesId].mes;
                const tokenCount = await getTokenCountAsync(tokenCountText, 0);
                updateMessage(mesId, { extra: { ...chat[mesId].extra, token_count: tokenCount } });
                thisMesDiv.find('.tokenCounterDisplay').text(`${tokenCount}t`);
            }
        }

        //Animate expanding to the new message height.
        thisMesDiv.css('height', thisMesDivHeight);
        expandNewMessage(thisMesDiv);

        if (run_generate) {
            appendMediaToMessage(chat[mesId], thisMesDiv);
        }

        await eventSource.emit(event_types.MESSAGE_SWIPED, (mesId));

        if (run_generate && !is_send_press) {
            is_send_press = true;
            generation = Generate('swipe');
        }

        //Swipe in from the opposite side.
        await animateSwipeTransition(mesId, { xStart: `${-swipeRange}px`, xEnd: `${0}px`, duration: swipeDuration });
    }

    if (mesId === Number(this_edit_mes_id)) {
        closeMessageEditor();
    }
    if (isStreamingEnabled() && streamingProcessor) {
        streamingProcessor.onStopStreaming();
    }

    if (isHordeGenerationNotAllowed()) {
        return unblockGeneration();
    }

    //If the swipe is not being deleted.
    if (source != SWIPE_SOURCE.DELETE && source != SWIPE_SOURCE.BACK) {
        // Make sure ad-hoc changes to extras are saved before swiping away
        syncMesToSwipe(mesId);

        if (chat[mesId].swipe_id === undefined) {              // if there is no swipe-message in the last spot of the chat array
            updateMessage(mesId, {
                swipe_id: 0,                                  // set it to id 0
                swipes: [chat[mesId].mes],                    // assign swipe array with last chat[mesId] from chat
                swipe_info: [{
                    'send_date': chat[mesId].send_date,
                    'gen_started': chat[mesId].gen_started,
                    'gen_finished': chat[mesId].gen_finished,
                    'extra': structuredClone(chat[mesId].extra),
                }],
            });
        }
        // If the user is holding down the key and we're at the last or first swipe, don't do anything.
        let isLastSwipe = (direction === SWIPE_DIRECTION.RIGHT) ? (chat[mesId].swipe_id === Math.max(0, chat[mesId].swipes.length - 1)) : chat[mesId].swipe_id === 0;
        if (source === SWIPE_SOURCE.KEYBOARD && repeated && isLastSwipe) {
            await endSwipe();
            return;
        }
    } else if (source == SWIPE_SOURCE.DELETE || source == SWIPE_SOURCE.BACK) {
        //If the swipe is being deleted or reverted.
        await standardSwipe(newSwipeId);
        return;
    }

    //If swiping left.
    if (direction === SWIPE_DIRECTION.LEFT) {
        if (forceSwipeId == null) newSwipeId--;
        //Loop to last swipe if negative.
        if (newSwipeId < 0) {
            newSwipeId = Math.max(0, chat[mesId].swipes.length - 1);
        }
        //Limit swipe_id to swipes.
        if (newSwipeId > chat[mesId].swipes.length - 1) {
            toastr.warning(`The swipe_id for message #${mesId} was ${newSwipeId}. It has been reset to ${chat[mesId].swipes.length - 1}.`);
            updateMessage(mesId, { swipe_id: chat[mesId].swipes.length - 1 });
            await endSwipe();
            return;
        }
        await standardSwipe(newSwipeId);
        return;
    } else if (direction === SWIPE_DIRECTION.RIGHT) {
        //If swiping right.
        // make new slot in array
        if (forceSwipeId == null) newSwipeId++;

        //Minimum of zero.
        if (newSwipeId < 0) {
            toastr.warning(`The swipe_id for message #${mesId} was ${newSwipeId}. It has been reset to zero.`);
            updateMessage(mesId, { swipe_id: 0 });
            await endSwipe();
            return;
        }

        //If overswiping.
        if (newSwipeId >= chat[mesId].swipes.length) {
            newSwipeId = chat[mesId].swipes.length;

            //Update the swipe_id.
            updateMessage(mesId, { swipe_id: newSwipeId });

            const overswipe = getOverswipeBehavior(mesId);

            //Cancel the generation.
            if (overswipe == OVERSWIPE_BEHAVIOR.NONE) {
                //Cancel swipe.
                updateMessage(mesId, { swipe_id: originalSwipeId });
                await endSwipe();
                return;
            } else if (overswipe == OVERSWIPE_BEHAVIOR.REGENERATE) {
                // Truncates rather than deletes: what followed belonged to the previous alternative and comes back on swiping back to it.
                // Also makes the generation target the right message - every part of the generate path answers "which message is this for" with chat.length - 1.
                if (chat.length > mesId + 1) {
                    chat.splice(mesId + 1);
                    await redisplayChat({ startIndex: mesId + 1 });
                    updateViewMessageIds();
                }

                //Regenerate the message
                updateMessage(mesId, clearMessageData(chat[mesId]));
                let run_generate = true;
                //Generate.
                await animateSwipe(run_generate);
                await endSwipe();
                return;
            } else if (overswipe == OVERSWIPE_BEHAVIOR.EDIT_GENERATE) {
                //Create a new, empty swipe and open the editor for the user to fill in, instead of generating.
                const newSwipes = [...chat[mesId].swipes, ''];
                const newSwipeInfo = [...(chat[mesId].swipe_info || []), {
                    send_date: getMessageTimeStamp(),
                    gen_started: undefined,
                    gen_finished: undefined,
                    extra: {},
                }];
                updateMessage(mesId, { swipes: newSwipes, swipe_info: newSwipeInfo });
                await standardSwipe(newSwipeId);

                // Truncates the view, not the tree - typing here appends under this node, forking; leaving the blank slot restores the old continuation.
                if (chat.length > mesId + 1) {
                    chat.splice(mesId + 1);
                    await redisplayChat({ startIndex: mesId });
                    updateViewMessageIds();
                }

                // Open the message editor on the new empty swipe.
                await messageEdit(mesId);
                return;
            } else if (overswipe == OVERSWIPE_BEHAVIOR.LOOP || overswipe == OVERSWIPE_BEHAVIOR.PRISTINE_GREETING) {
                // Loop to the first swipe.
                newSwipeId = 0;
            }
        }
        await standardSwipe(newSwipeId);
        return;
    }
}

/**
 * @deprecated Use `swipe` instead.
 * Handles the swipe to the left event.
 * @param {SwipeEvent} [event] Event.
 * @param {object} params Additional parameters.
 * @param {import('./scripts/constants.js').SWIPE_SOURCE} [params.source]  The source of the swipe event.
 * @param {boolean} [params.repeated] Is the swipe event repeated.
 * @param {object} [params.message] The chat message to swipe.
 */
export async function swipe_left(event, { source, repeated, message } = {}) {
    await swipe.call(this, event, SWIPE_DIRECTION.LEFT, { source: source, repeated: repeated, message: message });
}

/**
 * @deprecated Use `swipe` instead.
 * Handles the swipe to the right event.
 * @param {SwipeEvent} [event] Event.
 * @param {object} params Additional parameters.
 * @param {import('./scripts/constants.js').SWIPE_SOURCE} [params.source] The source of the swipe event.
 * @param {boolean} [params.repeated] Is the swipe event repeated.
 * @param {object} [params.message] The chat message to swipe.
 */
//MARK: swipe_right
export async function swipe_right(event = null, { source, repeated, message } = {}) {
    await swipe.call(this, event, SWIPE_DIRECTION.RIGHT, { source: source, repeated: repeated, message: message });
}

/**
 * Imports supported files dropped into the app window. Each file is imported, applied to charactersStore, and (per `power_user.tag_import_setting`) has its tags imported before moving to the next file.
 * @param {File[]} files Array of files to process
 * @param {Map<File, string>} [data] Extra data to pass to the import function
 * @param {object} [options]
 * @param {Map<File, string>} [options.sourceUrls] URL or id each file was downloaded from, named in import errors
 * @returns {Promise<string[]>} Avatar filenames of the characters actually imported (skips duplicates), in import order
 */
export async function processDroppedFiles(files, data = new Map(), { sourceUrls = new Map() } = {}) {
    const allowedMimeTypes = [
        'application/json',
        'image/png',
        'application/yaml',
        'application/x-yaml',
        'text/yaml',
        'text/x-yaml',
    ];

    const allowedExtensions = [
        'charx',
        'byaf',
    ];

    const importable = files.filter(file => {
        const extension = file.name.split('.').pop().toLowerCase();
        if (allowedMimeTypes.some(x => file.type.startsWith(x)) || allowedExtensions.includes(extension)) {
            return true;
        }
        toastr.warning(t`Unsupported file type: ` + file.name);
        return false;
    });

    if (importable.length === 0) {
        return;
    }

    // Batch mode buffers metadata-store writes and suspends the directory watcher - gated on more than one file, since a single-file drop's own unbuffered write is already cheap.
    const useBatchImportMode = importable.length > 1;
    if (useBatchImportMode) {
        await beginMetadataBatchImport();
    }

    const avatarFileNames = [];
    let duplicateCount = 0;

    try {
        for (const file of importable) {
            const preservedName = data instanceof Map && data.get(file);
            const result = await importCharacter(file, { preserveFileName: preservedName, sourceUrl: sourceUrls.get(file) });

            if (!result) {
                continue;
            }

            if (result.duplicate) {
                duplicateCount++;
                continue;
            }

            applyImportedCharacter(result.character);
            avatarFileNames.push(result.avatarFileName);

            let tagsAdded = false;
            if (result.serverHandledTags) {
                // ALL/ONLY_EXISTING: the server already resolved and assigned tags atomically as part of the import - no separate assign round trip needed.
                mergeServerTagDefinitions(result.tagDefinitions);
                tagsAdded = Array.isArray(result.character?.tag_ids) && result.character.tag_ids.length > 0;
            } else if (power_user.tag_import_setting !== tag_import_setting.NONE) {
                tagsAdded = await importTags(result.character, { suppressSuccessToast: true });
            }

            // One toast per character for the whole create/replace + tag-import outcome, instead of a separate popup for each.
            const charName = result.character?.name || String(result.avatarFileName).replace('.png', '');
            const toastMessage = result.replaced
                ? (tagsAdded ? t`Replaced character '${charName}' (tags imported)` : t`Replaced character '${charName}'`)
                : (tagsAdded ? t`Imported character '${charName}' (tags imported)` : t`Imported character '${charName}'`);
            toastr.success(toastMessage);
            if (result.pendingTags?.length > 0) {
                toastr.warning(t`Tags ${result.pendingTags.join(', ')} will be added to '${charName}' once the tag upgrade finishes.`, t`Tags not added yet`);
            }
        }
    } finally {
        // Always ends batch mode, even on a mid-loop throw - an un-ended batch leaves writes silently buffered well past this request.
        if (useBatchImportMode) {
            await endMetadataBatchImport();
        }
    }

    if (avatarFileNames.length > 0) {
        // selectImportedChar() -> select_rm_info('char_import_no_toast', ...) does its own real, targeted
        // lookup+page-navigation - no separate list refresh needed here first.
        selectImportedChar(avatarFileNames[avatarFileNames.length - 1]);
    }

    if (duplicateCount > 0) {
        toastr.info(t`Skipped ${duplicateCount} duplicate character(s) already in your library.`, t`Import`);
    }

    return avatarFileNames;
}

// Never throws - a failure here just means writes for this batch go through the normal unbuffered path instead.
async function beginMetadataBatchImport() {
    try {
        const result = await fetch('/api/characters/metadata/batch-import/begin', {
            method: 'POST',
            headers: getRequestHeaders(),
        });
        if (!result.ok) {
            throw new Error(`Failed to begin batch-import mode: ${result.statusText}`);
        }
    } catch (error) {
        console.error('Error beginning metadata batch-import mode', error);
    }
}

// Always called even after a begin failure - the server treats begin/end as idempotent no-ops when batch mode was never entered.
async function endMetadataBatchImport() {
    try {
        const result = await fetch('/api/characters/metadata/batch-import/end', {
            method: 'POST',
            headers: getRequestHeaders(),
        });
        if (!result.ok) {
            throw new Error(`Failed to end batch-import mode: ${result.statusText}`);
        }
    } catch (error) {
        console.error('Error ending metadata batch-import mode', error);
    }
}

// Must run before importTags() for the same character - getTagKeyForEntity() can't resolve a key for an avatar not yet in charactersStore.
function applyImportedCharacter(character) {
    if (!character?.avatar) {
        return;
    }
    // The import answer is the whole card.
    character.shallow = false;
    if (charactersStore.has(character.avatar)) {
        charactersStore.update(character.avatar, character);
    } else {
        holdCharacter(character);
    }
}

/**
 * Whether a character with this avatar exists. A check the server can't answer counts as no: it only decides how
 * the import is reported and whether a cached thumbnail is reloaded.
 * @param {string} avatar
 * @returns {Promise<boolean>}
 */
async function characterExistsOnServer(avatar) {
    if (charactersStore.has(avatar)) return true;
    const { checkCharactersExistOrNull } = await import('./scripts/character-existence-check.js');
    const result = await checkCharactersExistOrNull([avatar]);
    return result?.[avatar] === true;
}

/**
 * Selects the given imported char
 * @param {string} charId char to select
 */
function selectImportedChar(charId) {
    let oldSelectedChar = null;
    if (getSelectionState().type === 'character') {
        oldSelectedChar = getCurrentCharacter().avatar;
    }
    select_rm_info('char_import_no_toast', charId, oldSelectedChar);
}

/**
 * @param {File} file File to import
 * @param {object} [options] - Options
 * @param {string} [options.preserveFileName] Whether to preserve original file name
 * @param {string} [options.sourceUrl] URL or id the file was downloaded from, named in import errors
 * @returns {Promise<{ avatarFileName: string, replaced: boolean, character: object } | { duplicate: true } | undefined>} undefined for an unsupported extension or a hard failure (already toasted); `{ duplicate: true }` for exact byte-identical dedup.
 */
async function importCharacter(file, { preserveFileName = '', sourceUrl = '' } = {}) {
    if (is_group_generating || is_send_press) {
        toastr.error(t`Cannot import characters while generating. Stop the request and try again.`, t`Import aborted`);
        throw new Error('Cannot import character while generating');
    }

    const ext = file.name.match(/\.(\w+)$/);
    if (!ext || !(['json', 'png', 'yaml', 'yml', 'charx', 'byaf'].includes(ext[1].toLowerCase()))) {
        return;
    }

    // Whether the import replaces a character: asked of the server, since the page holds only some characters.
    const exists = preserveFileName ? await characterExistsOnServer(preserveFileName) : false;

    const format = ext[1].toLowerCase();
    $('#character_import_file_type').val(format);
    const formData = new FormData();
    formData.append('avatar', file);
    formData.append('file_type', format);
    formData.append('user_name', name1);
    if (preserveFileName) formData.append('preserved_name', preserveFileName);
    if (sourceUrl) formData.append('source_url', sourceUrl);

    // ALL/ONLY_EXISTING have no interactive decision to make (unlike ASK), so tell the server the mode up front to seed tags atomically in the same request.
    const effectiveTagSetting = Object.values(tag_import_setting).find(setting => setting === power_user.tag_import_setting) ?? tag_import_setting.ASK;
    if (effectiveTagSetting === tag_import_setting.ALL) {
        formData.append('tagImportMode', 'all');
    } else if (effectiveTagSetting === tag_import_setting.ONLY_EXISTING) {
        formData.append('tagImportMode', 'existing');
    }

    try {
        const result = await fetch('/api/characters/import', {
            method: 'POST',
            body: formData,
            headers: getRequestHeaders({ omitContentType: true }),
            cache: 'no-cache',
        });

        const data = await result.json().catch(() => ({}));

        if (!result.ok || data.error) {
            const message = typeof data.error === 'string' ? data.error : `Failed to import "${file.name}": ${result.statusText}`;
            console.error('Error importing character', message);
            toastr.error(message, t`Could not import character`);
            return;
        }

        if (data.duplicate) {
            return { duplicate: true };
        }

        if (data.file_name !== undefined) {
            let avatarFileName = `${data.file_name}.png`;

            // Refresh existing thumbnail
            if (exists && getSelectionState().type === 'character') {
                await fetch(getThumbnailUrl('avatar', avatarFileName), { cache: 'reload' });
            }

            $('#character_search_bar').val('').trigger('input');

            // No toast here - processDroppedFiles() folds this into one combined notification per character.
            return {
                avatarFileName, replaced: exists, character: data.character,
                serverHandledTags: effectiveTagSetting === tag_import_setting.ALL || effectiveTagSetting === tag_import_setting.ONLY_EXISTING,
                tagDefinitions: Array.isArray(data.tagDefinitions) ? data.tagDefinitions : [],
                pendingTags: Array.isArray(data.pendingTags) ? data.pendingTags : [],
            };
        }
    } catch (error) {
        console.error('Error importing character', error);
        toastr.error(`Failed to import "${file.name}": ${error.message}`, t`Could not import character`);
    }
}

async function importFromURL(items, files) {
    for (const item of items) {
        if (item.type === 'text/uri-list') {
            const uriList = await new Promise((resolve) => {
                item.getAsString((uriList) => { resolve(uriList); });
            });
            const uris = uriList.split('\n').filter(uri => uri.trim() !== '');
            try {
                for (const uri of uris) {
                    const request = await fetch(uri);
                    const data = await request.blob();
                    const fileName = request.headers.get('Content-Disposition')?.split('filename=')[1]?.replace(/"/g, '') || uri.split('/').pop() || 'file.png';
                    const file = new File([data], fileName, { type: data.type });
                    files.push(file);
                }
            } catch (error) {
                console.error('Failed to import from URL', error);
            }
        }
    }
}

export async function doNewChat({ deleteCurrentChat = false } = {}) {
    //Make a new chat for selected character
    if (getSelectionState().type === 'none' || menu_type == 'create') {
        return;
    }

    //Fix it; New chat doesn't create while open create character menu
    await waitUntilCondition(() => !isChatSaving, debounce_timeout.extended, 10);
    await clearChat({ clearData: true });

    chat_file_for_del = getCurrentChatDetails()?.sessionName;

    if (deleteCurrentChat) {
        if (selected_group) {
            // Every message already persisted itself directly via chatOp*() at its own call site - this
            // chat isn't being resaved, just stamped as recently active, same as the solo branch below.
            await saveGroupField(selected_group, { date_last_chat: Date.now() }, true, false);
        } else {
            charactersStore.update(getCurrentCharacter().avatar, { date_last_chat: Date.now() });
        }
    }

    if (selected_group) {
        await createNewGroupChat(selected_group);
        if (deleteCurrentChat) await deleteGroupChat(selected_group, chat_file_for_del, { jumpToNewChat: false }); // don't jump, new chat was already created and jumped to above
    } else {
        // Workstream 6: a brand-new conversation needs no name-minting step at all, client- or
        // server-side - it's just an empty tree under this character's anchor until the user
        // sends a message (which mints a real row) or explicitly labels a point in it. See
        // pointToFreshChat() for how the pointer is (or isn't) actually resolved.
        setChatMetadata({});
        _resetMetadataSaveSnapshot();
        await pointToFreshChat();
        if (deleteCurrentChat) await delChat(chat_file_for_del + '.jsonl');
    }
}

/**
 * Renames a group or character chat.
 * @param {object} param Parameters for renaming chat
 * @param {number|string} [param.characterId] Character to rename chat for: an index into `getContext().characters`, or an avatar key
 * @param {string} [param.characterAvatar] Character avatar (identity) to rename chat for, used when `characterId` is null or undefined. Without `groupId`, both naming different characters renames nothing.
 * @param {string} [param.groupId] Group ID to rename chat for
 * @param {string} param.oldFileName Old name of the chat (no JSONL extension)
 * @param {string} param.newFileName New name for the chat (no JSONL extension)
 * @param {boolean} [param.loader=true] Whether to show loader during the operation
 */
export async function renameGroupOrCharacterChat({ characterId, characterAvatar, groupId, oldFileName, newFileName, loader: showLoader, byNode = false }) {
    const currentChatId = getCurrentChatId();
    let avatarUrl;
    if (characterId == null) {
        avatarUrl = characterAvatar;
    } else if (characterAvatar !== undefined && !groupId) {
        const resolved = resolveCharacterRefPair(characterId, characterAvatar);
        avatarUrl = resolved === CHARACTER_REF_MISMATCH ? undefined : resolved.avatar;
    } else {
        avatarUrl = resolveCharacterRef(characterId)?.avatar;
    }
    const body = {
        is_group: !!groupId,
        avatar_url: avatarUrl,
        // A node id isn't a file, so no .jsonl extension gets glued on.
        original_file: byNode ? oldFileName : `${oldFileName}.jsonl`,
        renamed_file: `${newFileName.trim()}.jsonl`,
    };

    if (body.original_file === body.renamed_file) {
        console.debug('Chat rename cancelled, old and new names are the same');
        return;
    }
    if (equalsIgnoreCaseAndAccents(body.original_file, body.renamed_file)) {
        toastr.warning(t`Name not accepted, as it is the same as before (ignoring case and accents).`, t`Rename Chat`);
        return;
    }

    const loaderHandle = showLoader ? loader.show({
        slug: 'chat-rename',
        title: t`Rename Chat`,
        message: t`Renaming chat…`,
        toastMode: loader.ToastMode.STATIC,
    }) : null;

    try {
        const response = await fetch('/api/chats/rename', {
            method: 'POST',
            body: JSON.stringify(body),
            headers: getRequestHeaders(),
        });

        if (!response.ok) {
            throw new Error('Unsuccessful request.');
        }

        const data = await response.json();

        if (data.error) {
            throw new Error('Server returned an error.');
        }

        if (data.sanitizedFileName) {
            newFileName = data.sanitizedFileName;
        }

        if (groupId) {
            await renameGroupChat(groupId, oldFileName, newFileName);
        // Only a name-addressed pointer has to follow the rename - a node-addressed one already names that node.
        } else if (!byNode && avatarUrl !== undefined && avatarUrl === this_avatar && charactersStore.get(avatarUrl)?.chat === oldFileName) {
            // Same node under a new label, not a different node - carry the current integrity forward
            // rather than clearing to unknown (see _setCurrentTarget()'s own doc comment).
            _setCurrentTarget(newFileName, chat_metadata.integrity);
            $('#selected_chat_pole').val(charactersStore.get(avatarUrl).chat);
            setFormBaseline('#selected_chat_pole', String($('#selected_chat_pole').val()));
            await fetch('/api/characters/merge-attributes', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ avatar: avatarUrl, chat: newFileName }),
            });
        }

        if (currentChatId) {
            await reloadCurrentChat();
        }

        const eventData = { avatarId: body.avatar_url, groupId, oldFileName: body.original_file, newFileName: body.renamed_file };
        await eventSource.emit(event_types.CHAT_RENAMED, eventData);
    } catch {
        await delay(500);
        await callGenericPopup('An error has occurred. Chat was not renamed.', POPUP_TYPE.TEXT);
    } finally {
        await loaderHandle?.hide();
    }
}

/**
 * Renames the currently selected chat.
 * @param {string} oldFileName Old name of the chat (no JSONL extension)
 * @param {string} newName New name for the chat (no JSONL extension)
 */
export async function renameChat(oldFileName, newName, { byNode = false } = {}) {
    return await renameGroupOrCharacterChat({
        characterAvatar: this_avatar,
        groupId: selected_group,
        oldFileName: oldFileName,
        newFileName: newName,
        loader: true,
        byNode,
    });
}

/**
 * Closes the current chat, clearing all associated data and resetting the UI.
 * If a message generation is in progress, it prompts the user to stop it first.
 * @returns {Promise<boolean>} True if the chat was successfully closed, false otherwise.
 */
export async function closeCurrentChat() {
    if (blockWhileFieldEditing()) {
        return false;
    }
    if (is_send_press == false) {
        await waitUntilCondition(() => !isChatSaving, debounce_timeout.extended, 10);
        await clearChat({ clearData: true });
        resetSelectedGroup();
        setCharacterId(undefined);
        setCharacterName('');
        setActiveCharacter(null);
        setActiveGroup(null);
        this_edit_mes_id = undefined;
        setChatMetadata({});
        _resetMetadataSaveSnapshot();
        selected_button = 'characters';
        $('#rm_button_selected_ch').children('h2').text('');
        // A real close, not just switching the visible menu away - the panel's character/chat no longer applies.
        closeRightMenu('rm_ch_create_block');
        select_rm_characters();
        await eventSource.emit(event_types.CHAT_CHANGED, getCurrentChatId());
        return true;
    } else {
        toastr.info(t`Please stop the message generation first.`);
        return false;
    }
}

/**
 * Forces the update of a character's stored active-chat pointer.
 * @param {string|number} characterId An index into `getContext().characters`, or an avatar key
 * @param {string} newName New pointer value (a node id, a legacy chat name, or '' to clear it - "no active chat" is a valid state)
 * @returns {Promise<void>}
 */
export async function updateRemoteChatName(characterId, newName) {
    const character = resolveCharacterRef(characterId);
    if (!character) {
        console.warn(`Character not found: ${characterId}`);
        return;
    }
    character.chat = newName;
    await saveActiveChat(character.avatar, newName);
}


function doCharListDisplaySwitch() {
    power_user.charListGrid = !power_user.charListGrid;
    document.body.classList.toggle('charListGrid', power_user.charListGrid);
    saveSettingsDebounced('power_user.charListGrid');
}

/**
 * Option of {@link deleteCharacter} carrying the CHARACTER_DELETED `id`. A symbol, so no outside caller's options
 * can set it: upstream's `deleteCharacter` ignores every option but `deleteChats`.
 */
const DELETED_CHARACTER_INDEX = Symbol('deletedCharacterIndex');

/**
 * Function to handle the deletion of a character, given a specific popup type and character ID.
 * If popup type equals "del_ch", it will proceed with deletion otherwise it will exit the function.
 * It fetches the delete character route, sending necessary parameters, and in case of success,
 * it proceeds to delete character from UI and saves settings.
 * In case of error during the fetch request, it logs the error details.
 *
 * @param {string|number} this_chid - An index into `getContext().characters`, or an avatar key. Shadows the
 * module's `this_chid` to keep upstream's parameter name.
 * @param {boolean} delete_chats - Whether to delete chats or not.
 */
export async function handleDeleteCharacter(this_chid, delete_chats) {
    const character = resolveCharacterRef(this_chid);
    if (!character) {
        return;
    }

    // CHARACTER_DELETED's `id` is the deleted character's index, known only when the argument is that index.
    // The property key, not `String()`, which throws on a symbol.
    const key = Reflect.ownKeys({ [this_chid]: 0 })[0];
    const index = typeof key === 'string' ? Number(key) : NaN;
    const isIndex = Number.isInteger(index) && index >= 0 && String(index) === key && resolveCharacterRef(key) === character;

    await deleteCharacter(character.avatar, { deleteChats: delete_chats, [DELETED_CHARACTER_INDEX]: isIndex ? index : undefined });
}

/**
 * Deletes a character completely, including associated chats if specified
 *
 * @param {string|string[]} characterKey - The key (avatar) of the character to be deleted
 * @param {{deleteChats?: boolean, [DELETED_CHARACTER_INDEX]?: number}} [options] - Optional parameters for the
 * deletion. `deleteChats` (default true): whether to delete associated chats or not
 * @return {Promise<boolean>} - A promise that resolves when the character is successfully deleted
 */
export async function deleteCharacter(characterKey, { deleteChats = true, [DELETED_CHARACTER_INDEX]: deletedIndex = undefined } = {}) {
    if (blockWhileFieldEditing()) {
        return false;
    }
    if (!Array.isArray(characterKey)) {
        characterKey = [characterKey];
    }

    const inTempChat = getSelectionState().type === 'none' && name2 === neutralCharacterName;
    if (inTempChat) {
        const confirmClose = await Popup.show.confirm(
            t`You are currently in a temporary chat.`,
            t`Deleting this character will close the chat and you will lose any unsaved messages. Do you want to proceed?`,
        );
        if (!confirmClose) {
            return false;
        }
    }

    const closeChatResult = await closeCurrentChat();
    if (!closeChatResult) {
        return false;
    }

    let deleted = false;
    /** @type {{avatar: string, entity: object}[]} */
    const removedCharacters = [];

    // Resolved through the repository, not charactersStore: a character the page doesn't hold still gets deleted.
    let resolved;
    try {
        const { characterRepository } = await import('./scripts/character-repository.js');
        resolved = await characterRepository.getMany(characterKey);
    } catch (error) {
        console.error('Could not look up the characters to delete:', error);
        toastr.error(t`Could not look up the characters to delete. Nothing was deleted.`);
        await removeCharacterFromUI(removedCharacters);
        return deleted;
    }

    /** @type {object[]} */
    const characters = [];
    for (const key of characterKey) {
        const character = resolved.get(key);
        if (!character) {
            toastr.warning(t`Character ${key} not found. Skipping deletion.`);
            continue;
        }
        characters.push(character);
    }

    if (characters.length === 0) {
        await removeCharacterFromUI(removedCharacters);
        return deleted;
    }

    // Only needed when chats are actually being deleted (to fire per-chat CHAT_DELETED events below),
    // so skip the fetch entirely otherwise. Fetched in parallel across characters since there's no batch endpoint for it.
    const pastChatsByAvatar = new Map();
    if (deleteChats) {
        const pastChatsResults = await Promise.all(characters.map(character => getPastCharacterChats(character.avatar)));
        characters.forEach((character, index) => pastChatsByAvatar.set(character.avatar, pastChatsResults[index]));
    }

    const response = await fetch('/api/characters/delete', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ avatar_urls: characters.map(character => character.avatar), delete_chats: deleteChats }),
        cache: 'no-cache',
    });

    if (!response.ok) {
        toastr.error(`${response.status} ${response.statusText}`, t`Failed to delete characters`);
        await removeCharacterFromUI(removedCharacters);
        return deleted;
    }

    const data = await response.json();
    const okAvatars = new Set((data.results ?? []).filter(entry => entry.ok).map(entry => entry.avatar_url));

    for (const character of characters) {
        if (!okAvatars.has(character.avatar)) {
            toastr.error(t`Failed to delete character ${character.name}`);
            continue;
        }

        accountStorage.removeItem(`AlertRegex_${character.avatar}`);
        accountStorage.removeItem(`mediaWarningShown:${character.avatar}`);
        removeEntityTags(character.avatar);
        select_rm_info('char_delete', character.name);

        if (deleteChats) {
            const pastChats = pastChatsByAvatar.get(character.avatar) ?? [];
            for (const chat of pastChats) {
                const name = chat.file_name.replace('.jsonl', '');
                await eventSource.emit(event_types.CHAT_DELETED, name);
            }
        }

        // `undefined` unless handleDeleteCharacter passed an index: an avatar → index lookup would be a scan.
        await eventSource.emit(event_types.CHARACTER_DELETED, { id: deletedIndex, character: character });
        removedCharacters.push({ avatar: character.avatar, entity: character });
        deleted = true;
    }

    await removeCharacterFromUI(removedCharacters);
    return deleted;
}

/**
 * Function to delete a character from UI after character deletion API success.
 * It manages necessary UI changes such as unsetting
 * character ID, resetting chat metadata, deselecting character's tab
 * panel, removing character name from navigation tabs, clearing chat, fetching updated list of characters.
 * It also ensures to save the settings after all the operations.
 * @param {{avatar: string, entity: object}[]} [removedCharacters] The just-deleted characters, so charactersStore can report exactly what happened instead of a generic reset.
 */
export async function removeCharacterFromUI(removedCharacters = []) {
    preserveNeutralChat();
    await clearChat();
    resetChatState();
    // A real close, not just switching the visible menu away - the panel's character no longer exists.
    closeRightMenu('rm_ch_create_block');
    $(document.getElementById('rm_button_selected_ch')).children('h2').text('');
    restoreNeutralChat();
    // Known exactly which rows to drop when the deletes themselves succeeded - skip getCharacters()'s own
    // reprint and remove just those rows. On a failed/empty delete, fall back to its full resync instead.
    const knownRemovals = removedCharacters.length > 0;
    await getCharacters({ silent: knownRemovals, skipPrint: knownRemovals });
    for (const { avatar, entity } of removedCharacters) {
        charactersStore.reportRemoved(avatar, entity);
        removeCharacterListRow(avatar);
    }
    await printMessages();
    await eventSource.emit(event_types.CHAT_CHANGED, getCurrentChatId());
}

/**
 * Creates a new assistant chat.
 * @param {object} params - Parameters for the new assistant chat
 * @param {boolean} [params.temporary=false] I need a temporary secretary
 * @returns {Promise<void>} - A promise that resolves when the new assistant chat is created
 */
export async function newAssistantChat({ temporary = false } = {}) {
    await clearChat();
    if (!temporary) {
        return openPermanentAssistantChat();
    }
    chat.splice(0, chat.length);
    setChatMetadata({});
    _resetMetadataSaveSnapshot();
    setCharacterName(neutralCharacterName);
    sendSystemMessage(system_message_types.ASSISTANT_NOTE);
}

/**
 * Event handler to open a navbar drawer when a drawer open button is clicked.
 * Handles click events on .drawer-opener elements.
 * Opens the drawer associated with the clicked button according to the data-target attribute.
 * @returns {void}
 */
function doDrawerOpenClick() {
    const targetDrawerID = $(this).attr('data-target');
    const drawer = $(`#${targetDrawerID}`);
    const drawerToggle = drawer.find('.drawer-toggle');
    const content = drawerToggle.parent().find('.drawer-content')[0];
    const drawerIsShown = content?.classList.contains('openDrawer') && getComputedStyle(content).visibility !== 'hidden';
    if (drawerIsShown || drawer.hasClass('resizing')) { return; }
    doNavbarIconClick.call(drawerToggle);
}

/**
 * Event handler to open or close a navbar drawer when a navbar icon is clicked.
 * Handles click events on .drawer-toggle elements.
 * @returns {Promise<void>}
 */
export async function doNavbarIconClick() {
    // The chat has no drawer to open or close; its icon only brings it forward.
    if ($(this).parent().is('#chat-button')) {
        bringChatForward();
        return;
    }
    const icon = $(this).find('.drawer-icon');
    const drawer = $(this).parent().find('.drawer-content');
    const drawerWasOpenAlready = $(this).parent().find('.drawer-content').hasClass('openDrawer');
    const targetDrawerID = $(this).parent().find('.drawer-content').attr('id');

    if (!drawerWasOpenAlready) {
        const closedCount = closeUnpinnedDrawersFor(drawer[0]);
        if (closedCount && animation_duration) {
            await delay(animation_duration);
        }
        icon.toggleClass('openIcon closedIcon');
        drawer.toggleClass('openDrawer closedDrawer');

        if (targetDrawerID === 'right-nav-panel') {
            favsToHotswap();
            $('#rm_print_characters_block').trigger('scroll');
        }

        if (targetDrawerID === 'char-info-panel' && getSelectionState().type === 'none') {
            select_rm_create();
        }

        frontDrawer(targetDrawerID);
    } else if (drawerWasOpenAlready) {
        // Open but partly or wholly under another drawer (only with stacked drawers on): the click brings it forward
        // rather than closing it.
        if (isDrawerCovered(drawer[0])) {
            bringOpenDrawerForward(drawer[0]);
            return;
        }
        icon.toggleClass('closedIcon openIcon');
        closeDrawerContent(drawer[0]);
    }
}

function addDebugFunctions() {
    const doBackfill = async () => {
        const editedIds = [];
        for (let i = 0; i < chat.length; i++) {
            const message = chat[i];

            // System messages are not counted
            if (message.is_system) {
                continue;
            }

            const tokenCountText = (message?.extra?.reasoning || '') + message.mes;
            const tokenCount = await getTokenCountAsync(tokenCountText, 0);
            updateMessage(i, { extra: { ...(chat[i].extra || {}), token_count: tokenCount } });
            editedIds.push(i);
        }

        // One batch edit rather than something the fallback save has to work out from a diff.
        // chatOpEditMany() already retries transient failures itself (chat-store.js's _chatOpPost).
        // silent: true - this catch already reports failure with its own, more specific message, so the
        // generic one _chatOpPost() would otherwise show for the same failure is suppressed instead of
        // shown alongside it.
        if (editedIds.length) {
            try {
                await chatOpEditMany(editedIds, true);
            } catch (error) {
                console.error('Could not save the token count backfill:', error);
                toastr.error(t`Could not save the token count backfill. Check your connection and try again.`, t`Save failed`);
            }
        }
        await reloadCurrentChat();
    };

    registerDebugFunction('forceOnboarding', 'Force onboarding', 'Forces the onboarding process to restart.', async () => {
        firstRun = true;
        await saveSettings();
        location.reload();
    });

    registerDebugFunction('backfillTokenCounts', 'Backfill token counters',
        `Recalculates token counts of all messages in the current chat to refresh the counters.
        Useful when you switch between models that have different tokenizers.
        This is a visual change only. Your chat will be reloaded.`, doBackfill);

    registerDebugFunction('generationTest', 'Send a generation request', 'Generates text using the currently selected API.', async () => {
        const text = prompt('Input text:', 'Hello');
        toastr.info('Working on it...');
        const message = await generateRaw({ prompt: text });
        alert(message);
    });
    registerDebugFunction('toggleEventTracing', 'Toggle event tracing', 'Useful to see what triggered a certain event.', () => {
        localStorage.setItem('eventTracing', localStorage.getItem('eventTracing') === 'true' ? 'false' : 'true');
        toastr.info('Event tracing is now ' + (localStorage.getItem('eventTracing') === 'true' ? 'enabled' : 'disabled'));
    });

    registerDebugFunction('toggleRegenerateWarning', 'Toggle Ctrl+Enter regeneration confirmation', 'Toggle the warning when regenerating a message with a Ctrl+Enter hotkey.', () => {
        accountStorage.setItem('RegenerateWithCtrlEnter', accountStorage.getItem('RegenerateWithCtrlEnter') === 'true' ? 'false' : 'true');
        toastr.info('Regenerate warning is now ' + (accountStorage.getItem('RegenerateWithCtrlEnter') === 'true' ? 'disabled' : 'enabled'));
    });

    registerDebugFunction('copySetup', 'Copy ST setup to clipboard [WIP]', 'Useful data when reporting bugs', async () => {
        const getContextContents = getContext();
        const getSettingsContents = settings;
        //console.log(getSettingsContents);
        const logMessage = `
\`\`\`
API: ${getSettingsContents.main_api}
API Type: ${getSettingsContents[getSettingsContents.main_api + '_settings'].type}
API server: ${getSettingsContents.api_server}
Model: ${getContextContents.onlineStatus}
Context Template: ${power_user.context.preset}
Instruct Template: ${power_user.instruct.preset}
API Settings: ${JSON.stringify(getSettingsContents[getSettingsContents.main_api + '_settings'], null, 2)}
\`\`\`
    `;

        //console.log(getSettingsContents)
        //console.log(logMessage);

        try {
            await copyText(logMessage);
            toastr.info('Your ST API setup data has been copied to the clipboard.');
        } catch (error) {
            toastr.error('Failed to copy ST Setup to clipboard:', error);
        }
    });
}


// MARK: DOM Handlers Start
jQuery(async function () {
    setTimeout(function () {
        $('#groupControlsToggle').trigger('click');
        $('#groupCurrentMemberListToggle .inline-drawer-icon').trigger('click');
    }, 200);

    $(document).on('click', '.api_loading', () => cancelStatusCheck('Canceled because connecting was manually canceled'));

    //////////DRAFT PERSISTENCE LOGIC/////////////
    // Debounced save on every keystroke, including programmatic ones (e.g. slash commands filling the box).
    $('#send_textarea').on('input', () => saveDraftDebounced());

    // Editing a greeting changes the card, and an open chat's openings are the union of stored rows and the card's current greetings.
    eventSource.on(event_types.CHARACTER_EDITED, async (event) => {
        const edited = event?.detail?.character?.avatar;
        if (!edited || edited !== getCurrentCharacter()?.avatar) return;
        await _mergeCardGreetingsIntoOpening({ greetingEdit: event.detail.greetingEdit, greetingEdits: event.detail.greetingEdits });
    });

    // Restores the draft for whatever chat just became current; no-op when none exists for this exact context.
    eventSource.on(event_types.CHAT_CHANGED, () => {
        if (queuedSend && queuedSend.chatId !== getCurrentChatId()) {
            cancelQueuedSend(t`The queued send was cancelled because the chat changed. Your text is kept as that chat's draft.`);
        }
        const context = getCurrentDraftContext();
        if (!context) {
            return;
        }
        const draft = loadDraft(localStorage, context);
        if (draft) {
            $('#send_textarea').val(draft)[0].dispatchEvent(new Event('input', { bubbles: true }));
        }
    });

    //////////INPUT BAR FOCUS-KEEPING LOGIC/////////////
    let S_TAPreviouslyFocused = false;
    $('#send_textarea').on('focusin focus click', () => {
        S_TAPreviouslyFocused = true;
    });
    $('#send_but, #option_regenerate, #option_continue, #mes_continue, #mes_impersonate').on('click', () => {
        if (S_TAPreviouslyFocused) {
            $('#send_textarea').trigger('focus');
        }
    });
    $(document).on('click', event => {
        if ($(':focus').attr('id') !== 'send_textarea') {
            var validIDs = ['options_button', 'send_but', 'mes_impersonate', 'mes_continue', 'send_textarea', 'option_regenerate', 'option_continue'];
            if (!validIDs.includes($(event.target).attr('id'))) {
                S_TAPreviouslyFocused = false;
            }
        } else {
            S_TAPreviouslyFocused = true;
        }
    });

    /////////////////

    $('#swipes-checkbox').on('change', function () {
        swipes = !!$('#swipes-checkbox').prop('checked');
        if (swipes) {
            //console.log('toggle change calling showswipebtns');
            showSwipeButtons();
        } else {
            hideSwipeButtons();
        }
        saveSettingsDebounced('swipes');
    });

    ///// SWIPE BUTTON CLICKS ///////

    //limit swiping to only last message clicks
    $(document).on('click', '.mes .swipe_right', async (e, data) => await swipe(e, SWIPE_DIRECTION.RIGHT, data));
    $(document).on('click', '.mes .swipe_left', async (e, data) => await swipe(e, SWIPE_DIRECTION.LEFT, data));

    initCharacterSearch();

    $('#mes_impersonate').on('click', function () {
        $('#option_impersonate').trigger('click');
    });

    $('#mes_continue').on('click', function () {
        $('#option_continue').trigger('click');
    });

    $('#send_but').on('click', async function () {
        await requestTextareaSend('button');
    });

    //menu buttons setup

    $('#rm_button_settings').on('click', function () {
        selected_button = 'settings';
        selectRightMenuWithAnimation('rm_api_block');
    });
    $('#rm_button_back').on('click', function () {
        if (blockWhileFieldEditing()) {
            return;
        }
        selected_button = 'characters';
        select_rm_characters();
    });
    $('#rm_button_create').on('click', function () {
        if (blockWhileFieldEditing()) {
            return;
        }
        selected_button = 'create';
        select_rm_create();
    });
    $('#rm_button_selected_ch').on('click', function () {
        if (selected_group) {
            select_group_chats(selected_group, false);
        } else {
            selected_button = 'character_edit';
            select_selected_character(getCurrentCharacter()?.avatar);
        }
    });

    $(document).on('click', '.character_select', async function () {
        const avatar = $(this).attr('data-avatar');
        await selectCharacterByAvatar(avatar);
    });

    $(document).on('click', '.bogus_folder_select', function () {
        const tagId = $(this).attr('tagid');
        console.debug('Bogus folder clicked', tagId);
        chooseBogusFolder($(this), tagId);
    });

    const cssAutofit = CSS.supports('field-sizing', 'content');
    if (!cssAutofit) {
        /**
         * Sets the scroll height of the edit textarea to fit the content.
         * @param {HTMLTextAreaElement} e Textarea element to auto-fit
         */
        function autoFitEditTextArea(e) {
            const scrollTop = chatElement.scrollTop();
            e.style.height = '0px';
            const newHeight = e.scrollHeight + 4;
            e.style.height = `${newHeight}px`;
            chatElement.scrollTop(scrollTop);
        }
        const autoFitEditTextAreaDebounced = debounce(autoFitEditTextArea, debounce_timeout.short);
        document.addEventListener('input', e => {
            if (e.target instanceof HTMLTextAreaElement && e.target.classList.contains('edit_textarea')) {
                const scrollbarShown = e.target.clientWidth < e.target.offsetWidth && e.target.offsetHeight >= window.innerHeight * 0.75;
                const immediately = (e.target.scrollHeight > e.target.offsetHeight && !scrollbarShown) || e.target.value === '';
                immediately ? autoFitEditTextArea(e.target) : autoFitEditTextAreaDebounced(e.target);
            }
        });
    }

    const chatElementScroll = document.getElementById('chat');
    const chatScrollHandler = function () {
        if (power_user.waifuMode) {
            scrollLock = true;
            return;
        }

        const scrollIsAtBottom = Math.abs(chatElementScroll.scrollHeight - chatElementScroll.clientHeight - chatElementScroll.scrollTop) < 5;

        // Resume autoscroll if the user scrolls to the bottom
        if (scrollLock && scrollIsAtBottom) {
            scrollLock = false;
        }

        // Cancel autoscroll if the user scrolls up
        if (!scrollLock && !scrollIsAtBottom) {
            scrollLock = true;
        }
    };
    chatElementScroll.addEventListener('scroll', chatScrollHandler, { passive: true });

    $(document).on('click', '.mes', function () {
        //when a 'delete message' parent div is clicked
        // and we are in delete mode and del_checkbox is visible
        if (!is_delete_mode || !$(this).children('.del_checkbox').is(':visible')) {
            return;
        }
        $('.mes').children('.del_checkbox').each(function () {
            $(this).prop('checked', false);
            $(this).parent().removeClass('selected');
        });
        $(this).addClass('selected'); //sets the bg of the mes selected for deletion
        var i = Number($(this).attr('mesid')); //checks the message ID in the chat
        i = getMessageDeletionStartId(i, deleteToolCallsInDeleteMode);
        this_del_mes = i;
        //as long as the current message ID is less than the total chat length
        while (i < chat.length) {
            //sets the bg of the all msgs BELOW the selected .mes
            $(`.mes[mesid="${i}"]`).addClass('selected');
            $(`.mes[mesid="${i}"]`).children('.del_checkbox').prop('checked', true);
            i++;
        }
    });

    /**
     * Deleting a chat that isn't the one currently loaded only removes its row from the already-open modal, rather than a full refetch-and-rebuild. Deleting the *active* chat still needs the full-refresh path.
     * @param {string} chatFile - The name of the chat file to delete.
     * @param {object} group - The group object if the chat is part of a group.
     * @param {boolean} [fromSlashCommand=false] - Whether the deletion was triggered from a slash command.
     * @param {JQuery<HTMLElement>} [row] - The modal row element for this chat, if deleting from an open modal.
     * @returns {Promise<void>}
     */
    async function handleDeleteChat(chatFile, group, fromSlashCommand = false, row = null) {
        const isActiveChat = group
            ? groupsStore.get(group)?.chat_id === chatFile
            : getCurrentCharacter()?.chat === chatFile;

        if (row && row.length && !isActiveChat && !fromSlashCommand) {
            const loaderHandle = loader.show({
                slug: 'chat-delete',
                title: t`Delete Chat`,
                message: t`Deleting chat…`,
                toastMode: loader.ToastMode.STATIC,
            });

            try {
                if (group) {
                    await deleteGroupChat(group, chatFile);
                } else {
                    await delChat(`${chatFile}.jsonl`);
                }
            } catch (error) {
                loaderHandle.hide();
                throw error;
            }

            row.remove();
            await loaderHandle.hide();
            return;
        }

        // Close past chat popup.
        $('#select_chat_cross').trigger('click');

        const loaderHandle = loader.show({
            slug: 'chat-delete',
            title: t`Delete Chat`,
            message: t`Deleting chat…`,
            toastMode: loader.ToastMode.STATIC,
        });

        try {
            if (group) {
                await deleteGroupChat(group, chatFile);
            } else {
                await delChat(`${chatFile}.jsonl`);
            }
        } catch (error) {
            loaderHandle.hide();
            throw error;
        }

        if (fromSlashCommand) {  // When called from `/delchat` command, don't re-open the history view.
            $('#options').hide();  // Hide option popup menu.
            await loaderHandle.hide();
        } else {  // Open the history view again after 2 seconds (delay to avoid edge cases for deleting last chat).
            setTimeout(async function () {
                $('#option_select_chat').trigger('click');
                $('#options').hide();  // Hide option popup menu.
                await loaderHandle.hide();
            }, 2000);
        }
    }

    $(document).on('click', '.PastChat_cross', async function (e, { fromSlashCommand = false } = {}) {
        e.stopPropagation();
        // Prefer the node id - a name would only find whichever row sorted first.
        const deleteFileName = $(this).attr('node_id') || $(this).attr('file_name');
        const row = $(this).closest('.select_chat_block_wrapper');
        console.debug('detected cross click for' + deleteFileName);

        // Skip confirmation if called from a slash command.
        if (fromSlashCommand) {
            await handleDeleteChat(deleteFileName, selected_group, true);
            return;
        }

        const result = await callGenericPopup('<h3>' + t`Delete the Chat File?` + '</h3>', POPUP_TYPE.CONFIRM);
        if (result === POPUP_RESULT.AFFIRMATIVE) {
            await handleDeleteChat(deleteFileName, selected_group, false, row);
        }
    });

    $('#dialogue_popup_ok').on('click', async function (_e) {
        dialogueCloseStop = false;
        $('#shadow_popup').transition({
            opacity: 0,
            duration: animation_duration,
            easing: animation_easing,
        });
        setTimeout(function () {
            if (dialogueCloseStop) return;
            $('#shadow_popup').css('display', 'none');
            $('#dialogue_popup').removeClass('large_dialogue_popup');
            $('#dialogue_popup').removeClass('wide_dialogue_popup');
        }, animation_duration);

        if (dialogueResolve) {
            if (popup_type == 'input') {
                dialogueResolve($('#dialogue_popup_input').val());
                $('#dialogue_popup_input').val('');
            } else {
                dialogueResolve(true);
            }

            dialogueResolve = null;
        }
    });

    $('#dialogue_popup_cancel').on('click', function (e) {
        dialogueCloseStop = false;
        $('#shadow_popup').transition({
            opacity: 0,
            duration: animation_duration,
            easing: animation_easing,
        });
        setTimeout(function () {
            if (dialogueCloseStop) return;
            $('#shadow_popup').css('display', 'none');
            $('#dialogue_popup').removeClass('large_dialogue_popup');
        }, animation_duration);

        popup_type = '';

        if (dialogueResolve) {
            dialogueResolve(false);
            dialogueResolve = null;
        }
    });

    $('#add_avatar_button').on('change', function () {
        const inputElement = /** @type {HTMLInputElement} */ (this);
        read_avatar_load(inputElement);
    });

    // Whether the click that submits the form next came from the user rather than from a script.
    let createButtonClickedByUser = false;
    $('#create_button').on('click', (e) => {
        createButtonClickedByUser = e.originalEvent?.isTrusted === true;
        // A click that doesn't submit (the form failed validation) mustn't vouch for a later scripted submit.
        setTimeout(() => { createButtonClickedByUser = false; });
    });

    $('#form_create').on('submit', (e) => {
        const byUser = createButtonClickedByUser;
        createButtonClickedByUser = false;
        if (!byUser) {
            // An extension's `.val()` write, then a scripted click or submit: upstream's whole-form save.
            void createOrEditCharacter(e.originalEvent);
            return;
        }
        // The user's own Create builds from confirmed values only; an existing character's fields save themselves.
        if ($('#form_create').attr('actiontype') === 'createcharacter') {
            createCharacterFromCreateSave();
        }
    });

    $('#delete_button').on('click', async function () {
        if (!getCurrentCharacter()) {
            toastr.warning('No character selected.');
            return;
        }

        let deleteChats = false;

        const confirm = await Popup.show.confirm(t`Delete the character?`, await renderTemplateAsync('deleteConfirm'), {
            onClose: () => { deleteChats = !!$('#del_char_checkbox').prop('checked'); },
        });
        if (!confirm) {
            return;
        }

        await deleteCharacter(getCurrentCharacter().avatar, { deleteChats: deleteChats });
    });

    //////// OPTIMIZED ALL CHAR CREATION/EDITING TEXTAREA LISTENERS ///////////////

    $('#character_name_pole').on('input', function () {
        if (menu_type == 'create') {
            create_save.name = String($('#character_name_pole').val());
        }
    });

    const elementsToUpdate = {
        '#character_version_textarea': function () { create_save.character_version = String($('#character_version_textarea').val()); },
        '#creator_textarea': function () { create_save.creator = String($('#creator_textarea').val()); },
        '#tags_textarea': function () { create_save.tags = String($('#tags_textarea').val()); },
        '#talkativeness_slider': function () { create_save.talkativeness = Number($('#talkativeness_slider').val()); },
        '#depth_prompt_depth': function () { create_save.depth_prompt_depth = Number($('#depth_prompt_depth').val()); },
        '#depth_prompt_role': function () { create_save.depth_prompt_role = String($('#depth_prompt_role').val()); },
    };

    // The previewed text fields are saved by character-field-editor.js, including values written by code.
    Object.keys(elementsToUpdate).forEach(function (id) {
        $(id).on('input', function () {
            if (menu_type == 'create') {
                elementsToUpdate[id]();
            } else {
                saveCharacterFieldDebounced(getEditorCharacterAvatar(), id, String($(id).val()));
            }
        });
    });

    // Greeting pager: steps through the stable-order greeting list in the sidebar, editing whichever one is currently shown.
    $('.greeting-pager-prev').on('click', function () {
        navigateGreetingPager(greetingPagerState.index - 1);
    });

    $('.greeting-pager-next').on('click', function () {
        navigateGreetingPager(greetingPagerState.index + 1);
    });

    $('.greeting-pager-add').on('click', function () {
        if (blockFieldEditStart()) {
            return;
        }
        const { greetings, committed, index } = greetingPagerState;
        greetings[index] = String($('#greeting_field').val());
        const newIndex = greetings.length;
        greetings.push('');
        committed[newIndex] = false;
        greetingPagerState.index = newIndex;
        renderGreetingPager();
        beginEdit('greeting_field');
    });

    function jumpGreetingPager() {
        const requested = parseInt(String($('.greeting-pager-input').val()), 10);
        if (Number.isNaN(requested)) {
            renderGreetingPager(); // reset the invalid input display back to the current index
            return;
        }
        navigateGreetingPager(requested - 1);
    }

    $('.greeting-pager-input').on('keydown', function (e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            jumpGreetingPager();
        }
    });

    $('.greeting-pager-input').on('blur', function () {
        jumpGreetingPager();
    });

    $('#firstmessage_textarea').on('input', onFirstMessageFieldInput);

    $('#favorite_button').on('click', async function () {
        const newState = !fav_ch_checked;
        updateFavButtonState(newState);
        if (menu_type == 'create') {
            // No row exists yet - rides along in the create request's own `fav` field instead.
            return;
        }
        // A pure metadata-store mutation now, not a card-file edit - its own immediate, targeted write.
        const character = getCurrentCharacter();
        if (!character?.avatar) return;
        try {
            const response = await fetch('/api/characters/fav', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ avatar: character.avatar, fav: newState }),
            });
            if (!response.ok) throw new Error(String(response.status));
            await getOneCharacter(character.avatar);
            printCharactersDebounced();
            favsToHotswap();
        } catch (error) {
            console.error('Failed to update favorite status', error);
            toastr.error(t`Failed to update favorite status.`);
            updateFavButtonState(!newState);
        }
    });

    {
        const talkativenessButton = document.getElementById('talkativeness_button');
        const talkativenessPopover = document.getElementById('talkativeness_div');
        const useCssAnchor = CSS.supports('anchor-name: --x');

        if (useCssAnchor) {
            talkativenessButton.classList.add('talkativeness_anchor');
            talkativenessPopover.classList.add('talkativeness_anchored');
        }

        const positionTalkativenessPopover = () => {
            const rect = talkativenessButton.getBoundingClientRect();
            talkativenessPopover.style.top = `${rect.bottom}px`;
            talkativenessPopover.style.right = `${document.documentElement.clientWidth - rect.right}px`;
        };

        // Light dismiss closes the popover on the pointerup that precedes this click, so the open state is read at pointerdown.
        let wasOpenAtPointerDown = false;
        talkativenessButton.addEventListener('pointerdown', () => {
            wasOpenAtPointerDown = talkativenessPopover.matches(':popover-open');
        });
        talkativenessButton.addEventListener('click', () => {
            talkativenessPopover.togglePopover(!wasOpenAtPointerDown);
            wasOpenAtPointerDown = false;
        });

        talkativenessPopover.addEventListener('beforetoggle', (/** @type {ToggleEvent} */ e) => {
            if (useCssAnchor) return;
            if (e.newState === 'open') {
                positionTalkativenessPopover();
                window.addEventListener('resize', positionTalkativenessPopover);
                window.addEventListener('scroll', positionTalkativenessPopover, true);
            } else {
                window.removeEventListener('resize', positionTalkativenessPopover);
                window.removeEventListener('scroll', positionTalkativenessPopover, true);
            }
        });

        // Runs before the document-level Escape handler so an Escape that closes the popover does nothing else.
        window.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape' || e.isComposing || !talkativenessPopover.matches(':popover-open')) return;
            e.stopPropagation();
            talkativenessPopover.hidePopover();
        }, true);
    }

    /* $("#renameCharButton").on('click', renameCharacter); */

    $(document).on('click', '.renameChatButton', async function (e) {
        e.stopPropagation();
        const oldFileName = $(this).closest('.select_chat_block_wrapper').find('.select_chat_block_filename').text();
        const nodeId = $(this).attr('node_id');

        const popupText = await renderTemplateAsync('chatRename');
        const newName = await callGenericPopup(popupText, POPUP_TYPE.INPUT, oldFileName);

        if (!newName || typeof newName !== 'string' || newName == oldFileName) {
            console.log('no new name found, aborting');
            return;
        }

        // Rename the bookmark on its node. The displayed name is only what the box starts with.
        await renameChat(nodeId || oldFileName, newName, { byNode: !!nodeId });

        await delay(250);
        $('#option_select_chat').trigger('click');
        $('#options').hide();
    });

    $(document).on('click', '.exportChatButton, .exportRawChatButton', async function (e) {
        e.stopPropagation();
        const format = $(this).data('format') || 'txt';
        // Exporting is a pure read of the currently-displayed chat - only flush a save first if
        // there's actually something unsaved that the export would otherwise miss.
        if (isChatSaveScheduled()) {
            // eslint-disable-next-line no-restricted-syntax -- flushes whatever a debounced generic save already had pending; not a new op.
            await saveChatConditional();
        }
        const filename = $(this).closest('.select_chat_block_wrapper').find('.select_chat_block_filename').text();
        console.log(`exporting ${filename} in ${format} format`);

        const body = {
            is_group: !!selected_group,
            avatar_url: getCurrentCharacter()?.avatar,
            file: `${filename}.jsonl`,
            exportfilename: `${filename}.${format}`,
            format: format,
        };
        console.log(body);
        try {
            const response = await fetch('/api/chats/export', {
                method: 'POST',
                body: JSON.stringify(body),
                headers: getRequestHeaders(),
            });
            const data = await response.json();
            if (!response.ok) {
                // display error message
                console.log(data.message);
                await delay(250);
                toastr.error(`Error: ${data.message}`);
                return;
            } else {
                const mimeType = format == 'txt' ? 'text/plain' : 'application/octet-stream';
                // success, handle response data
                console.log(data);
                await delay(250);
                toastr.success(data.message);
                download(data.result, body.exportfilename, mimeType);
            }
        } catch (error) {
            // display error message
            console.log(`An error has occurred: ${error.message}`);
            await delay(250);
            toastr.error(`Error: ${error.message}`);
        }
    });


    const button = $('#options_button');
    const menu = $('#options');
    let isOptionsMenuVisible = false;

    function showMenu() {
        showBookmarksButtons();
        menu.fadeIn(animation_duration);
        optionsPopper.update();
        isOptionsMenuVisible = true;
    }

    function hideMenu() {
        menu.fadeOut(animation_duration);
        optionsPopper.update();
        isOptionsMenuVisible = false;
    }

    function isMouseOverButtonOrMenu() {
        return menu.is(':hover, :focus-within') || button.is(':hover, :focus');
    }

    button.on('click', function () {
        if (isOptionsMenuVisible) {
            hideMenu();
        } else {
            showMenu();
        }
    });
    $(document).on('click', function () {
        if (!isOptionsMenuVisible) return;
        if (!isMouseOverButtonOrMenu()) { hideMenu(); }
    });

    /* $('#set_chat_character_settings').on('click', setScenarioOverride); */

    ///////////// OPTIMIZED LISTENERS FOR LEFT SIDE OPTIONS POPUP MENU //////////////////////
    $('#options [id]').on('click', async function (event, customData) {
        const fromSlashCommand = customData?.fromSlashCommand || false;
        const deleteToolCalls = customData?.deleteToolCalls ?? true;
        var id = $(this).attr('id');

        // Check whether a custom prompt was provided via custom data (for example through a slash command)
        const additionalPrompt = customData?.additionalPrompt?.trim() || undefined;
        const buildOrFillAdditionalArgs = (args = {}) => ({
            ...args,
            ...(additionalPrompt !== undefined && { quiet_prompt: additionalPrompt, quietToLoud: true }),
        });

        if (id == 'option_select_chat') {
            if (getSelectionState().type === 'none' && !is_send_press) {
                await openPermanentAssistantCard();
            }
            const selectionAfterAssistantCard = getSelectionState();
            if ((selectionAfterAssistantCard.type === 'group' && !is_group_generating) || (selectionAfterAssistantCard.type === 'character' && !is_send_press) || fromSlashCommand) {
                await displayPastChats();
                //this is just to avoid the shadow for past chat view when using /delchat
                //however, the dialog popup still gets one..
                if (!fromSlashCommand) {
                    console.log('displaying shadow');
                    $('#shadow_select_chat_popup').css('display', 'block');
                    $('#shadow_select_chat_popup').css('opacity', 0.0);
                    $('#shadow_select_chat_popup').transition({
                        opacity: 1.0,
                        duration: animation_duration,
                        easing: animation_easing,
                    });
                }
            }
        } else if (id == 'option_regenerate') {
            //Attempting to regenerate a user message will instead generate a new message.
            if (chat.length && chat.length - 1 === this_edit_mes_id && chat[this_edit_mes_id]?.is_user == false) {
                toastr.warning(t`Finish the edit before starting a generation.`, t`You cannot regenerate the message you are editing.`);
                return;
            }
            if (is_send_press == false) {
                if (selected_group) {
                    regenerateGroup();
                } else {
                    is_send_press = true;
                    Generate('regenerate', buildOrFillAdditionalArgs());
                }
            }
        } else if (id == 'option_impersonate') {
            if (is_send_press == false || fromSlashCommand) {
                is_send_press = true;
                Generate('impersonate', buildOrFillAdditionalArgs());
            }
        } else if (id == 'option_continue') {
            if (swipeState == SWIPE_STATE.EDITING) {
                toastr.warning(t`Confirm the edit to start a generation.`, t`You cannot send a message during a swipe-edit.`);
                return;
            }
            if (chat.length && chat.length - 1 === this_edit_mes_id) {
                toastr.warning(t`Finish the edit before starting a generation.`, t`You cannot continue the message you are editing.`);
                return;
            }

            if (is_send_press == false || fromSlashCommand) {
                is_send_press = true;
                Generate('continue', buildOrFillAdditionalArgs());
            }
        } else if (id == 'option_preview_prompt') {
            if (is_send_press == false) {
                await previewFullPrompt();
            }
        } else if (id === 'option_help') {
            const { openHelp } = await import('./scripts/help-menu.js');
            openHelp();
        } else if (id == 'option_delete_mes') {
            setTimeout(() => openMessageDelete(fromSlashCommand, deleteToolCalls), animation_duration);
        } else if (id === 'option_settings') {
            //var checkBox = document.getElementById("waifuMode");
            var topBar = document.getElementById('top-bar');
            var topSettingsHolder = document.getElementById('top-settings-holder');
            var divchat = document.getElementById('chat');

            //if (checkBox.checked) {
            if (topBar.style.display === 'none') {
                topBar.style.display = ''; // or "inline-block" if that's the original display value
                topSettingsHolder.style.display = ''; // or "inline-block" if that's the original display value

                divchat.style.borderRadius = '';
                divchat.style.backgroundColor = '';
            } else {
                divchat.style.borderRadius = '10px'; // Adjust the value to control the roundness of the corners
                divchat.style.backgroundColor = ''; // Set the background color to your preference

                topBar.style.display = 'none';
                topSettingsHolder.style.display = 'none';
            }
            //}
        }
        hideMenu();
    });

    $('#newChatFromManageScreenButton').on('click', async function () {
        await doNewChat({ deleteCurrentChat: false });
        $('#select_chat_cross').trigger('click');
    });

    //////////////////////////////////////////////////////////////////////////////////////////////

    //functionality for the cancel delete messages button, reverts to normal display of input form
    $('#dialogue_del_mes_cancel').on('click', function () {
        $('#dialogue_del_mes').css('display', 'none');
        $('#send_form').css('display', css_send_form_display);
        $('.del_checkbox').each(function () {
            $(this).css('display', 'none');
            $(this).parent().children('.for_checkbox').css('display', 'block');
            $(this).parent().removeClass('selected');
            $(this).prop('checked', false);
        });
        showSwipeButtons();
        this_del_mes = -1;
        is_delete_mode = false;
    });

    //confirms message deletion with the "ok" button
    $('#dialogue_del_mes_ok').on('click', async function () {
        $('#dialogue_del_mes').css('display', 'none');
        $('#send_form').css('display', css_send_form_display);
        $('.del_checkbox').each(function () {
            $(this).css('display', 'none');
            $(this).parent().children('.for_checkbox').css('display', 'block');
            $(this).parent().removeClass('selected');
            $(this).prop('checked', false);
        });

        if (this_del_mes >= 0) {
            for (let i = (chat.length - 1); i >= this_del_mes; i--) {
                deleteItemizedPromptForMessage(i);
            }
            chatElement.find(`.mes[mesid="${this_del_mes}"]`).nextAll('div').remove();
            chatElement.find(`.mes[mesid="${this_del_mes}"]`).remove();
            chat.length = this_del_mes;
            chat_metadata.tainted = true;
            // Removed messages keep their rows and continuations; selecting one again brings the whole thing back.
            if (chat.length > 0) {
                await chatOpEndPath(chat.length - 1).catch(error =>
                    console.error('Could not cut the conversation back:', error));
            } else {
                await chatOpEndPathAtAnchor().catch(error =>
                    console.error('Could not cut the conversation back:', error));
            }
            chatElement.scrollTop(chatElement[0].scrollHeight);
            await eventSource.emit(event_types.MESSAGE_DELETED, chat.length);
            chatElement.find('.mes').removeClass('last_mes');
            chatElement.find('.mes').last().addClass('last_mes');
        } else {
            console.log('this_del_mes is not >= 0, not deleting');
        }

        showSwipeButtons();
        this_del_mes = -1;
        is_delete_mode = false;
    });

    $('#main_api').on('change', async function () {
        cancelStatusCheck('Canceled because main api changed');
        changeMainAPI();
        saveSettingsDebounced('main_api');
        await eventSource.emit(event_types.MAIN_API_CHANGED, { apiId: main_api });
    });

    ////////////////// OPTIMIZED RANGE SLIDER LISTENERS////////////////

    var sliderLocked = true;
    var sliderTimer;

    $('input[type=\'range\']').on('touchstart', function () {
        // Unlock the slider after 300ms
        setTimeout(function () {
            sliderLocked = false;
            $(this).css('background-color', 'var(--SmartThemeQuoteColor)');
        }.bind(this), 300);
    });

    $('input[type=\'range\']').on('touchend', function () {
        clearTimeout(sliderTimer);
        $(this).css('background-color', '');
        sliderLocked = true;
    });

    $('input[type=\'range\']').on('touchmove', function (event) {
        if (sliderLocked) {
            event.preventDefault();
        }
    });

    const sliders = [
        {
            sliderId: '#amount_gen',
            counterId: '#amount_gen_counter',
            format: (val) => `${val}`,
            setValue: (val) => { setAmountGen(Number(val)); },
        },
        {
            sliderId: '#max_context',
            counterId: '#max_context_counter',
            format: (val) => `${val}`,
            setValue: (val) => { setMaxContext(Number(val)); },
        },
    ];

    sliders.forEach(slider => {
        $(document).on('input', slider.sliderId, function () {
            const value = $(this).val();
            const formattedValue = slider.format(value);
            slider.setValue(value);
            $(slider.counterId).val(formattedValue);
            saveSettingsDebounced('amount_gen', 'max_context');
        });
    });

    //////////////////////////////////////////////////////////////

    $('#select_chat_cross').on('click', function () {
        $('#shadow_select_chat_popup').transition({
            opacity: 0,
            duration: animation_duration,
            easing: animation_easing,
        });
        setTimeout(function () { $('#shadow_select_chat_popup').css('display', 'none'); }, animation_duration);
    });

    $(document).on('pointerup', '.mes_copy', async function () {
        if (getSelectionState().type !== 'none' || name2 === neutralCharacterName) {
            try {
                const messageId = $(this).closest('.mes').attr('mesid');
                const text = chat[messageId].mes;
                await copyText(text);
                toastr.info('Copied!', '', { timeOut: 2000 });
            } catch (err) {
                console.error('Failed to copy: ', err);
            }
        }
    });

    //********************
    //***Message Editor***
    $(document).on('click', '.mes_edit', async function () {
        if (is_delete_mode) {
            return;
        }
        if (getSelectionState().type !== 'none' || name2 === neutralCharacterName) {
            // Previously system messages we're allowed to be edited
            /*const message = $(this).closest(".mes");

            if (message.data("isSystem")) {
                return;
            }*/

            if (this_edit_mes_id >= 0) {
                let mes_edited = chatElement.find(`[mesid="${this_edit_mes_id}"]`).find('.mes_edit_done');
                if (Number(edit_mes_id) == chat.length - 1) { //if the generating swipe (...)
                    let run_edit = true;
                    if (chat[edit_mes_id].swipe_id !== undefined) {
                        if (chat[edit_mes_id].swipes.length === chat[edit_mes_id].swipe_id) {
                            run_edit = false;
                        }
                    }
                    if (run_edit) {
                        hideSwipeButtons();
                    }
                }
                await messageEditDone(mes_edited);
            }
            var edit_mes_id = Number($(this).closest('.mes').attr('mesid'));

            await messageEdit(edit_mes_id);
        }
    });

    $(document).on('input', '#curEditTextarea', function () {
        if (power_user.auto_save_msg_edits === true) {
            messageEditAuto($(this));
        }
    });

    $(document).on('click', '.extraMesButtonsHint', function (e) {
        const $hint = $(e.target);
        const $buttons = $hint.siblings('.extraMesButtons');

        $hint.transition({
            opacity: 0,
            duration: animation_duration,
            easing: animation_easing,
            complete: function () {
                $hint.hide();
                $buttons
                    .addClass('visible')
                    .css({
                        opacity: 0,
                        display: 'flex',
                    })
                    .transition({
                        opacity: 1,
                        duration: animation_duration,
                        easing: animation_easing,
                    });
            },
        });
    });

    $(document).on('click', function (e) {
        // Expanded options don't need to be closed
        if (power_user.expand_message_actions) {
            return;
        }

        // Check if the click was outside the relevant elements
        if (!$(e.target).closest('.extraMesButtons, .extraMesButtonsHint').length) {
            const $visibleButtons = $('.extraMesButtons.visible');

            if (!$visibleButtons.length) {
                return;
            }

            const $hiddenHints = $('.extraMesButtonsHint:hidden');

            // Transition out the .extraMesButtons first
            $visibleButtons.transition({
                opacity: 0,
                duration: animation_duration,
                easing: animation_easing,
                complete: function () {
                    // Hide the .extraMesButtons after the transition
                    $(this)
                        .hide()
                        .removeClass('visible');

                    // Transition the .extraMesButtonsHint back in
                    $hiddenHints
                        .show()
                        .transition({
                            opacity: 0.3,
                            duration: animation_duration,
                            easing: animation_easing,
                            complete: function () {
                                $(this).css('opacity', '');
                            },
                        });
                },
            });
        }
    });

    // Saves as a new alternative rather than over the original - the original keeps its row and children.
    $(document).on('click', '.mes_edit_duplicate', async function () {
        const mesElement = $(this).closest('.mes');
        const mesId = Number(mesElement.attr('mesid'));
        const message = chat[mesId];

        // Needs a row to sit alongside. A file-backed chat has no nodes to fork between.
        if (!message?.node_id) {
            toastr.info(t`This chat does not support alternatives.`);
            return;
        }

        const text = $(this).closest('.mes_block').find('.edit_textarea').val();
        if (typeof text !== 'string' || !text.length) {
            return;
        }

        // Forking beside a card-only greeting is one of the things that earns it a row - the new alternative needs a sibling.
        const siblingNodeId = await ensureOpeningRow(mesId);
        if (isProvisionalNodeId(message.node_id) && !siblingNodeId) {
            toastr.error(t`Could not create the alternative.`);
            return;
        }

        // Re-read: ensureOpeningRow() above may have replaced the message with one carrying its new id.
        const content = { ...(chat[mesId] ?? message), mes: text };
        delete content.swipes;
        delete content.swipe_info;
        delete content.swipe_id;
        delete content.swipe_speaker_default;
        delete content.node_id;

        let createdId = null;
        try {
            const response = await fetch('/api/chats/message/alternative', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({
                    avatar_url: getCurrentCharacter()?.avatar,
                    sibling_node_id: siblingNodeId,
                    contents: [content],
                }),
            });
            const made = response.ok ? await response.json().catch(() => null) : null;
            createdId = made?.node_ids?.[0] ?? null;
        } catch (error) {
            console.warn('[duplicate] Could not create the alternative:', error);
        }

        if (!createdId) {
            toastr.error(t`Could not create the alternative.`);
            return;
        }

        // Re-read: the fetch above awaited, so chat[mesId] may have been replaced since.
        const current = chat[mesId] ?? message;
        const swipes = Array.isArray(current.swipes) ? [...current.swipes] : [current.mes ?? ''];
        const swipeInfo = Array.isArray(current.swipe_info)
            ? [...current.swipe_info]
            : [{ send_date: current.send_date, extra: current.extra ?? {}, node_id: current.node_id }];

        // Already there (identical text) - just move onto it rather than adding a duplicate slot.
        let at = swipeInfo.findIndex(info => info?.node_id === createdId);
        if (at < 0) {
            swipes.push(text);
            swipeInfo.push({
                send_date: content.send_date, extra: content.extra ?? {},
                name: content.name, is_user: !!content.is_user, node_id: createdId,
            });
            at = swipes.length - 1;
        }
        // `mes` must move onto the new text too - switchToAlternativePath() adopts the node and swipe index but never touches text, and messageEditCancel() redraws from `mes`.
        updateMessage(mesId, { swipes, swipe_info: swipeInfo, mes: text });

        await messageEditCancel(mesId);
        await switchToAlternativePath(mesId, at);
    });

    $(document).on('click', '.mes_edit_cancel', async function () {
        await messageEditCancel.call(this, this_edit_mes_id);
    });

    $(document).on('click', '.mes_edit_up', async function () {
        if (this_edit_mes_id <= 0) {
            return;
        }
        const targetId = Number(this_edit_mes_id) - 1;
        await messageEditMove(this_edit_mes_id, targetId);
    });

    $(document).on('click', '.mes_edit_down', async function () {
        if (this_edit_mes_id >= chat.length - 1) {
            return;
        }

        const targetId = Number(this_edit_mes_id) + 1;
        await messageEditMove(this_edit_mes_id, targetId);
    });

    $(document).on('click', '.mes_edit_copy', async function () {
        const confirmation = await callGenericPopup(t`Create a copy of this message?`, POPUP_TYPE.CONFIRM);
        if (!confirmation) {
            return;
        }

        hideSwipeButtons();
        const oldScroll = chatElement[0].scrollTop;
        const clone = structuredClone(chat[this_edit_mes_id]);
        clone.send_date = Date.now();
        const this_edit_mes_element = $(this).closest('.mes');
        clone.mes = this_edit_mes_element.find('.edit_textarea').val().toString();

        if (power_user.trim_spaces) {
            clone.mes = clone.mes.trim();
        }

        const targetId = Number(this_edit_mes_id) + 1;
        chat.splice(targetId, 0, clone);
        const newMessageElement = updateMessageElement(clone);
        this_edit_mes_element.after(newMessageElement);

        updateViewMessageIds();
        await chatOpGraft(targetId).catch(error =>
            console.error('Could not save the copied message:', error));
        chatElement[0].scrollTop = oldScroll;
        showSwipeButtons();
    });

    $(document).on('click', '.mes_edit_delete', async function (event, customData) {
        const fromSlashCommand = customData?.fromSlashCommand || false;
        const message = chat[this_edit_mes_id];
        const selectedSwipe = message.swipe_id ?? undefined;
        const swipesArray = Array.isArray(message.swipes) ? message.swipes : [];
        const canDeleteSwipe = power_user.confirm_message_delete && !fromSlashCommand && !message.is_user && swipesArray.length > 1 && this_edit_mes_id === chat.length - 1 && selectedSwipe !== undefined;
        await deleteMessage(Number(this_edit_mes_id), canDeleteSwipe ? selectedSwipe : undefined, power_user.confirm_message_delete && fromSlashCommand !== true);
    });

    $(document).on('click', '.mes_edit_done', async function () {
        await messageEditDone($(this));
    });

    //Select chat

    //**************************CHARACTER IMPORT EXPORT*************************//
    $('#character_import_button').on('click', function () {
        $('#character_import_file').trigger('click');
    });

    $('#character_import_file').on('change', async function (e) {
        $('#rm_info_avatar').html('');

        if (!(e.target instanceof HTMLInputElement)) {
            return;
        }

        if (!e.target.files.length) {
            return;
        }

        // Same bulk-import shape as a drag-and-drop, just a different trigger.
        await processDroppedFiles(Array.from(e.target.files));

        // Clear the file input value to allow re-uploading the same file
        e.target.value = '';
    });

    $('#export_button').on('click', function () {
        isExportPopupOpen = !isExportPopupOpen;
        $('#export_format_popup').toggle(isExportPopupOpen);
        exportPopper.update();
    });

    $(document).on('click', '.export_format', async function () {
        const format = $(this).data('format');

        if (!format) {
            return;
        }

        $('#export_format_popup').hide();
        isExportPopupOpen = false;
        exportPopper.update();

        await flushCharacterFieldSaves();
        const body = { format, avatar_url: getCurrentCharacter().avatar };

        const response = await fetch('/api/characters/export', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(body),
        });

        if (response.ok) {
            const filename = getCurrentCharacter().avatar.replace('.png', `.${format}`);
            const blob = await response.blob();
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.setAttribute('download', filename);
            document.body.appendChild(a);
            a.click();
            URL.revokeObjectURL(a.href);
            document.body.removeChild(a);
        }
    });
    //**************************CHAT IMPORT EXPORT*************************//
    $('#chat_import_button').on('click', function () {
        $('#chat_import_file').trigger('click');
    });

    $('#chat_import_file').on('change', async function (e) {
        const targetElement = e.target;
        const formElement = document.getElementById('form_import_chat');
        if (!(targetElement instanceof HTMLInputElement) || !(formElement instanceof HTMLFormElement)) {
            return;
        }

        const importedFileNames = [];

        for (const file of targetElement.files) {
            const ext = file.name.match(/\.(\w+)$/);
            const format = ext?.[1]?.toLowerCase();

            if (!['json', 'jsonl'].includes(format)) {
                toastr.warning(t`Only JSON and JSONL files are supported for chat imports.`);
                continue;
            }

            if (selected_group && format === 'json') {
                toastr.warning(t`Only SillyTavern's own format is supported for group chat imports. Sorry!`);
                continue;
            }

            const formData = new FormData(formElement);
            formData.set('file_type', format);
            formData.set('avatar', file);
            formData.set('user_name', name1);

            const importFn = selected_group ? importGroupChat : importCharacterChat;
            const result = await importFn(formData, { refresh: false });
            importedFileNames.push(...result);
        }

        if (importedFileNames.length > 0) {
            toastr.success(t`Successfully imported ${importedFileNames.length} chat(s).`);
        }

        await displayPastChats(importedFileNames);

        targetElement.value = '';
    });

    $('#rm_button_group_chats').on('click', function () {
        selected_button = 'group_chats';
        select_group_chats(null, false);
    });

    $('#rm_button_back_from_group').on('click', function () {
        selected_button = 'characters';
        select_rm_characters();
    });

    $('#dupe_button').on('click', async function () {
        await duplicateCharacter();
    });

    $(document).on('click', '.mes_stop', function () {
        stopGeneration();
    });

    $(document).on('click', '#form_sheld .stscript_continue', function () {
        pauseScriptExecution();
    });

    $(document).on('click', '#form_sheld .stscript_pause', function () {
        pauseScriptExecution();
    });

    $(document).on('click', '#form_sheld .stscript_stop', function () {
        stopScriptExecution();
    });

    $(document).on('click', '.drawer-opener', doDrawerOpenClick);

    $('.drawer-toggle').on('click', doNavbarIconClick);

    $('html').on('touchstart mousedown', async function (e) {
        const clickTarget = $(e.target);

        if (isExportPopupOpen
            && clickTarget.closest('#export_button').length == 0
            && clickTarget.closest('#export_format_popup').length == 0) {
            $('#export_format_popup').hide();
            isExportPopupOpen = false;
            exportPopper.update();
        }

        const forbiddenTargets = [
            '#avatar-and-name-block',
            '#shadow_popup',
            '.popup',
            '.editorLayer',
            '#world_popup',
            '.ui-widget',
            '.text_pole',
            '#toast-container',
            '.select2-results',
        ];

        for (const id of forbiddenTargets) {
            if (clickTarget.closest(id).length > 0) {
                return;
            }
        }

        // This autocloses open drawers that are not pinned if a click happens inside the app which does not target them.
        const targetParentHasOpenDrawer = clickTarget.parents('.openDrawer').length;
        if (!clickTarget.hasClass('drawer-icon') && !clickTarget.hasClass('openDrawer')) {
            const $openDrawers = $('.openDrawer').not('.pinnedOpen');
            if ($openDrawers.length && targetParentHasOpenDrawer === 0) {
                // Toggle icon and drawer classes
                $('.openIcon').not('.drawerPinnedOpen').toggleClass('closedIcon openIcon');
                for (const el of $openDrawers) {
                    closeDrawerContent(el);
                }
            }
        }
    });

    $(document).on('click', '.inline-drawer-toggle', async function (e) {
        if ($(e.target).hasClass('text_pole')) {
            return;
        }
        const drawer = $(this).closest('.inline-drawer');
        const icon = drawer.find('>.inline-drawer-header .inline-drawer-icon');
        const drawerContent = drawer.find('>.inline-drawer-content');
        icon.toggleClass('down up');
        icon.toggleClass('fa-circle-chevron-down fa-circle-chevron-up');
        drawer.trigger('inline-drawer-toggle');

        if (drawer.attr('id') === 'tags_div') {
            return;
        }

        drawerContent.stop().slideToggle({
            complete: () => {
                $(this).css('height', '');
            },
        });

        autosizeTextareas(drawerContent[0]);
    });

    $(document).on('click', '.inline-drawer-maximize', function () {
        const icon = $(this).find('.inline-drawer-icon, .floating_panel_maximize');
        icon.toggleClass('fa-window-maximize fa-window-restore');
        const drawerContent = $(this).closest('.drawer-content');
        drawerContent.toggleClass('maximized');
        const drawerId = drawerContent.attr('id');
        resetMovableStyles(drawerId);
    });

    $(document).on('click', '.mes .avatar', async function () {
        const messageElement = $(this).closest('.mes');
        const thumbURL = $(this).children('img').attr('src');
        const charsPath = '/characters/';
        // Pull the `file=` query param specifically - a trailing `&v=`/`&t=` cache-buster would otherwise win the "last =" slice.
        let targetAvatarImg;
        try {
            const fileParam = new URL(thumbURL, window.location.origin).searchParams.get('file');
            targetAvatarImg = fileParam !== null ? encodeURIComponent(fileParam) : thumbURL.substring(thumbURL.lastIndexOf('=') + 1);
        } catch {
            targetAvatarImg = thumbURL.substring(thumbURL.lastIndexOf('=') + 1);
        }
        const charname = targetAvatarImg.replace('.png', '');
        // Only a system message's avatar can be either a character's or a persona's.
        let isValidCharacter = false;
        if (messageElement.attr('is_system') == 'true') {
            const avatarKey = decodeURIComponent(targetAvatarImg);
            isValidCharacter = charactersStore.has(avatarKey);
            if (!isValidCharacter) {
                const { checkCharactersExistOrNull } = await import('./scripts/character-existence-check.js');
                isValidCharacter = (await checkCharactersExistOrNull([avatarKey]))?.[avatarKey] === true;
            }
        }

        // Remove existing zoomed avatars for characters that are not the clicked character when moving UI is not enabled
        if (!power_user.movingUI) {
            $('.zoomed_avatar').each(function () {
                const currentForChar = $(this).attr('forChar');
                if (currentForChar !== charname && typeof currentForChar !== 'undefined') {
                    console.debug(`Removing zoomed avatar for character: ${currentForChar}`);
                    $(this).remove();
                }
            });
        }

        const avatarSrc = (isDataURL(thumbURL) || /^\/?img\/(?:.+)/.test(thumbURL)) ? thumbURL : charsPath + targetAvatarImg;
        if ($(`.zoomed_avatar[forChar="${charname}"]`).length) {
            console.debug('removing container as it already existed');
            $(`.zoomed_avatar[forChar="${charname}"]`).fadeOut(animation_duration, () => {
                $(`.zoomed_avatar[forChar="${charname}"]`).remove();
            });
        } else {
            console.debug('making new container from template');
            const template = $('#zoomed_avatar_template').html();
            const newElement = $(template);
            newElement.attr('forChar', charname);
            newElement.attr('id', `zoomFor_${charname}`);
            newElement.addClass('draggable');
            newElement.find('.drag-grabber').attr('id', `zoomFor_${charname}header`);

            $('body').append(newElement);
            newElement.fadeIn(animation_duration);
            const zoomedAvatarImgElement = $(`.zoomed_avatar[forChar="${charname}"] img`);
            if (messageElement.attr('is_user') == 'true' || (messageElement.attr('is_system') == 'true' && !isValidCharacter)) {
                //handle user and system avatars
                const isValidPersona = personaStore.has(decodeURIComponent(targetAvatarImg));
                if (isValidPersona) {
                    const personaSrc = getUserAvatar(targetAvatarImg);
                    zoomedAvatarImgElement.attr('src', personaSrc);
                    zoomedAvatarImgElement.attr('data-izoomify-url', personaSrc);
                } else {
                    zoomedAvatarImgElement.attr('src', thumbURL);
                    zoomedAvatarImgElement.attr('data-izoomify-url', thumbURL);
                }
            } else if (messageElement.attr('is_user') == 'false') { //handle char avatars
                zoomedAvatarImgElement.attr('src', avatarSrc);
                zoomedAvatarImgElement.attr('data-izoomify-url', avatarSrc);
            }
            loadMovingUIState();
            $(`.zoomed_avatar[forChar="${charname}"]`).css('display', 'flex');
            dragElement(newElement);

            if (power_user.zoomed_avatar_magnification) {
                $('.zoomed_avatar_container').izoomify();
            }

            $('.zoomed_avatar, .zoomed_avatar .dragClose').on('click touchend', (e) => {
                if (e.target.closest('.dragClose')) {
                    $(`.zoomed_avatar[forChar="${charname}"]`).fadeOut(animation_duration, () => {
                        $(`.zoomed_avatar[forChar="${charname}"]`).remove();
                    });
                }
            });

            zoomedAvatarImgElement.on('dragstart', (e) => {
                console.log('saw drag on avatar!');
                e.preventDefault();
                return false;
            });
        }
    });

    // Clicking a zoomed avatar opens its image in the lightbox. The control bar (drag handle, close) keeps its own behavior.
    $(document).on('click', '.zoomed_avatar', function (e) {
        if (e.target.closest('.panelControlBar')) {
            return;
        }
        const image = this.querySelector('.zoomed_avatar_img');
        const url = image?.getAttribute('src');
        if (!url) {
            return;
        }
        showMediaLightbox(url, image.alt || '');
    });

    document.addEventListener('click', function (e) {
        if (!(e.target instanceof HTMLElement)) return;
        if (e.target.matches('#OpenAllWIEntries')) {
            document.querySelectorAll('#world_popup_entries_list .inline-drawer').forEach((/** @type {HTMLElement} */ drawer) => {
                delay(0).then(() => toggleDrawer(drawer, true));
            });
        } else if (e.target.matches('#CloseAllWIEntries')) {
            document.querySelectorAll('#world_popup_entries_list .inline-drawer').forEach((/** @type {HTMLElement} */ drawer) => {
                toggleDrawer(drawer, false);
            });
        }
    });

    $(document).on('click', '.open_alternate_greetings', openAlternateGreetings);
    /* $('#set_character_world').on('click', openCharacterWorldPopup); */

    $(document).on('focus', 'input.auto-select, textarea.auto-select', function () {
        if (!power_user.enable_auto_select_input) return;
        const control = $(this)[0];
        if (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement) {
            control.select();
            console.debug('Auto-selecting content of input control', control);
        }
    });

    $(document).on('keydown', function (e) {
        if (e.key === 'Escape' && !e.originalEvent.isComposing && !e.isDefaultPrevented()) {
            const isEditVisible = $('#curEditTextarea').is(':visible') || $('.reasoning_edit_textarea').length > 0;
            if (isEditVisible && power_user.auto_save_msg_edits === false) {
                closeMessageEditor('all');
                $('#send_textarea').trigger('focus');
                return;
            }
            if (isEditVisible && power_user.auto_save_msg_edits === true) {
                chatElement.find(`.mes[mesid="${this_edit_mes_id}"] .mes_edit_done`).trigger('click');
                closeMessageEditor('reasoning');
                $('#send_textarea').trigger('focus');
                return;
            }
            if (this_edit_mes_id === undefined && $('#mes_stop').is(':visible')) {
                $('#mes_stop').trigger('click');
                if (chat.length === 0) return;
                const lastMessage = chat[chat.length - 1];
                if (Array.isArray(lastMessage.swipes) && lastMessage.swipe_id == lastMessage.swipes.length) {
                    $('.last_mes .swipe_left').trigger('click');
                }
            }
        }
    });

    $('#char-management-dropdown').on('change', async (e) => {
        const targetElement = /** @type {HTMLSelectElement} */ (e.target);
        const target = $(targetElement.selectedOptions).attr('id');
        switch (target) {
            case 'set_character_world':
                await openCharacterWorldPopup();
                break;
            case 'set_chat_character_settings':
                await setCharacterSettingsOverrides();
                break;
            case 'renameCharButton':
                await renameCharacter();
                break;
            case 'import_character_info':
                await importEmbeddedWorldInfo();
                break;
            case 'edit_embedded_lore':
                await openEmbeddedLoreEditor();
                break;
            case 'character_source': {
                const source = getCharacterSource(getCurrentCharacter());
                if (source && isValidUrl(source)) {
                    const url = new URL(source);
                    const confirm = await Popup.show.confirm('Open Source', `<span>Do you want to open the link to ${url.hostname} in a new tab?</span><var>${url}</var>`);
                    if (confirm) {
                        window.open(source, '_blank');
                    }
                } else {
                    toastr.info('This character doesn\'t seem to have a source.');
                }
            } break;
            case 'replace_update': {
                let onlineUrl = getCharacterSource(getCurrentCharacter());

                const POPUP_RESULT_URL = POPUP_RESULT.CUSTOM1, POPUP_RESULT_FILE = POPUP_RESULT.CUSTOM2;
                const result = await Popup.show.confirm(t`Replace Character`,
                    `<p>${t`Choose a new character card to replace this character with.`}</p>` +
                    `<p>${t`You can also replace this character with the one from the online source.`}${onlineUrl ? `<br />This character was downloaded from: <var>${onlineUrl}</var>` : ''}</p>` +
                    `<p>${t`All chats, assets and group memberships will be preserved, but local changes to the character data will be lost.`}<br />${t`Proceed?`}</p>`,
                    {
                        okButton: false,
                        customButtons: [{
                            text: t`Replace with URL`,
                            result: POPUP_RESULT_URL,
                            classes: ['popup-button-ok'],
                        }, {
                            text: t`Replace with File`,
                            result: POPUP_RESULT_FILE,
                            classes: ['popup-button-ok'],
                        }],
                        defaultResult: onlineUrl ? POPUP_RESULT_URL : POPUP_RESULT_FILE,
                    });

                // Remember the chat currently selected, so we can reload it after the replacement
                const currentChatFile = getCurrentCharacter().chat;
                async function postReplace() {
                    await openCharacterChat(currentChatFile);
                }

                switch (result) {
                    case POPUP_RESULT_FILE: {
                        async function uploadReplacementCard(e) {
                            const file = e.target.files[0];
                            if (!file) {
                                return;
                            }

                            try {
                                const data = new Map();
                                data.set(file, getCurrentCharacter().avatar);
                                await processDroppedFiles([file], data);
                                await postReplace();
                            } catch {
                                toastr.error('Failed to replace the character card.', 'Something went wrong');
                            }
                        }
                        $('#character_replace_file').off('change').on('change', uploadReplacementCard).trigger('click');
                        break;
                    }
                    case POPUP_RESULT_URL: {
                        const inputUrl = await Popup.show.input(t`Replace Character from URL`,
                            `<p>${t`Enter the URL of the character card to replace this character with.`}</p>` +
                            (onlineUrl ? `<p>${t`This character was downloaded from: <var>${onlineUrl}</var>`}</p>` : ''),
                            onlineUrl);
                        if (!inputUrl) {
                            break;
                        }
                        onlineUrl = inputUrl;
                        await importFromExternalUrl(onlineUrl, { preserveFileName: getCurrentCharacter().avatar });
                        await postReplace();
                        break;
                    }
                }
            } break;
            case 'import_tags': {
                await importTags(getCurrentCharacter(), { importSetting: tag_import_setting.ASK });
            } break;
            /*case 'delete_button':
                popup_type = "del_ch";
                callPopup(`
                        <h3>Delete the character?</h3>
                        <b>THIS IS PERMANENT!<br><br>
                        THIS WILL ALSO DELETE ALL<br>
                        OF THE CHARACTER'S CHAT FILES.<br><br></b>`
                );
                break;*/
            default:
                await eventSource.emit(event_types.CHARACTER_MANAGEMENT_DROPDOWN, target);
        }
        $('#char-management-dropdown').prop('selectedIndex', 0);
    });

    $(window).on('beforeunload', () => {
        cancelTtsPlay();
        if (streamingProcessor) {
            console.log('Page reloaded. Aborting streaming...');
            streamingProcessor.onStopStreaming();
        }
    });


    var isManualInput = false;
    var valueBeforeManualInput;

    $(document).on('input', '.range-block-counter input, .neo-range-input', function () {
        valueBeforeManualInput = $(this).val();
        console.log(valueBeforeManualInput);
    });

    $(document).on('change', '.range-block-counter input, .neo-range-input', function (e) {
        if (!(e.target instanceof HTMLElement)) {
            return;
        }
        e.target.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
    });

    $(document).on('keydown', '.range-block-counter input, .neo-range-input', function (e) {
        const masterSelector = '#' + $(this).data('for');
        const masterElement = $(masterSelector);
        if (e.key === 'Enter') {
            let manualInput = Number($(this).val());
            if (isManualInput) {
                //disallow manual inputs outside acceptable range
                if (manualInput >= Number($(this).attr('min')) && manualInput <= Number($(this).attr('max'))) {
                    //if value is ok, assign to slider and update handle text and position
                    //newSlider.val(manualInput)
                    //handleSlideEvent.call(newSlider, null, { value: parseFloat(manualInput) }, 'manual');
                    valueBeforeManualInput = manualInput;
                    $(masterElement).val($(this).val()).trigger('input', { forced: true });
                } else {
                    //if value not ok, warn and reset to last known valid value
                    toastr.warning(`Invalid value. Must be between ${$(this).attr('min')} and ${$(this).attr('max')}`);
                    //newSlider.val(valueBeforeManualInput)
                    $(this).val(valueBeforeManualInput);
                }
            }
        }
    });

    $(document).on('keyup', '.range-block-counter input, .neo-range-input', function () {
        valueBeforeManualInput = $(this).val();
        isManualInput = true;
    });

    //trigger slider changes when user clicks away
    $(document).on('mouseup blur', '.range-block-counter input, .neo-range-input', function () {
        const masterSelector = '#' + $(this).data('for');
        const masterElement = $(masterSelector);
        let manualInput = Number($(this).val());
        if (isManualInput) {
            //if value is between correct range for the slider
            if (manualInput >= Number($(this).attr('min')) && manualInput <= Number($(this).attr('max'))) {
                valueBeforeManualInput = manualInput;
                //set the slider value to input value
                $(masterElement).val($(this).val()).trigger('input', { forced: true });
            } else {
                //if value not ok, warn and reset to last known valid value
                toastr.warning(`Invalid value. Must be between ${$(this).attr('min')} and ${$(this).attr('max')}`);
                $(this).val(valueBeforeManualInput);
            }
        }
        isManualInput = false;
    });

    $('.user_stats_button').on('click', function () {
        userStatsHandler();
    });

    $(document).on('click', '.external_import_button, #external_import_button', async () => {
        const html = await renderTemplateAsync('importCharacters');
        const input = await callGenericPopup(html, POPUP_TYPE.INPUT, '', { allowVerticalScrolling: true, wider: true, okButton: $('#popup_template').attr('popup-button-import'), rows: 4 });

        if (!input) {
            console.debug('Custom content import cancelled');
            return;
        }

        // break input into one input per line
        const inputs = String(input).split('\n').map(x => x.trim()).filter(x => x.length > 0);

        for (const url of inputs) {
            await importFromExternalUrl(url);
        }
    });

    charDragDropHandler = new DragAndDropHandler('body', async (files, event) => {
        if (!files.length) {
            await importFromURL(event.originalEvent.dataTransfer.items, files);
        }
        await processDroppedFiles(files);
    }, { noAnimation: true });

    chatDragDropHandler = new DragAndDropHandler('#select_chat_popup', async (_, event) => {
        const importFile = document.getElementById('chat_import_file');
        if (importFile instanceof HTMLInputElement) {
            importFile.files = event.originalEvent.dataTransfer.files;
            $(importFile).trigger('change');
        }
    });

    // Grid/list toggle: in fullscreen mode, toggles charGalleryGrid (body class + setting).
    // In sidebar mode, toggles charListGrid (existing behavior).
    $('#charListGridToggle').on('click', async () => {
        const panel = document.getElementById('right-nav-panel');
        const isFullscreen = panel && panel.classList.contains('galleryFullscreen');
        if (isFullscreen) {
            power_user.charGalleryGrid = !power_user.charGalleryGrid;
            document.body.classList.toggle('charGalleryGrid', power_user.charGalleryGrid);
        } else {
            doCharListDisplaySwitch();
        }
        saveSettingsDebounced('power_user.charGalleryGrid');
    });

    $('#galleryFullscreenToggle').on('click', () => {
        const panel = document.getElementById('right-nav-panel');
        if (panel) {
            power_user.charGalleryFullscreen = !power_user.charGalleryFullscreen;
            panel.classList.toggle('galleryFullscreen', power_user.charGalleryFullscreen);
            const btn = document.getElementById('galleryFullscreenToggle');
            if (btn) {
                btn.classList.toggle('fa-expand', !power_user.charGalleryFullscreen);
                btn.classList.toggle('fa-compress', power_user.charGalleryFullscreen);
            }
            // Fullscreen changes which drawers this panel covers.
            if (panel.classList.contains('openDrawer')) bringOpenDrawerForward(panel);
            saveSettingsDebounced('power_user.charGalleryFullscreen');
        }
    });

    initDrawerStack(onDrawerVisibilityChanged, content => frontDrawer(content.id));

    $('#charInfoFullscreenToggle').on('click', () => {
        const panel = document.getElementById('char-info-panel');
        if (panel) {
            power_user.charInfoFullscreen = !power_user.charInfoFullscreen;
            panel.classList.toggle('charInfoFullscreen', power_user.charInfoFullscreen);
            const btn = document.getElementById('charInfoFullscreenToggle');
            if (btn) {
                btn.classList.toggle('fa-expand', !power_user.charInfoFullscreen);
                btn.classList.toggle('fa-compress', power_user.charInfoFullscreen);
            }
            // Fullscreen changes which drawers this panel covers.
            if (panel.classList.contains('openDrawer')) bringOpenDrawerForward(panel);
            saveSettingsDebounced('power_user.charInfoFullscreen');
        }
    });

    $('#hideCharPanelAvatarButton').on('click', () => {
        $('#avatar-and-name-block').slideToggle();
    });

    $(document).on('click', '#show_more_messages', async function (event) {
        event.stopPropagation();
        event.preventDefault();
        await showMoreMessages();
    });

    $(document).on('click', '.open_characters_library', async function () {
        await getCharacters();
        await eventSource.emit(event_types.OPEN_CHARACTER_LIBRARY);
    });

    // Added here to prevent execution before script.js is loaded and get rid of quirky timeouts
    await firstLoadInit();

    window.addEventListener('beforeunload', (e) => {
        if (isChatSaving || this_edit_mes_id >= 0) {
            e.preventDefault();
            e.returnValue = true;
        }
    });
});
