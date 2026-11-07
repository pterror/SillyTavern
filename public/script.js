import {
    moment,
    DOMPurify,
    hljs,
    Handlebars,
    Popper,
} from './lib.js';

import { getMessageTimeStamp, dragElement, isMobile, initRossMods, countCharTokensWhenShown, onCharacterEditorMaybeShown } from './scripts/RossAscends-mods.js';
import { characters, charactersStore, this_avatar, setCharacterId, holdCharacter, keepHeldCharacters } from './scripts/character-store.js';
import { printCharacters, printCharactersDebounced, findCharacterListPage, getOneCharacter, getCharacterSource, startLibraryChangesAt, getCharacters, showCharacterSyncFailedToast, initCharacterSearch, updateCharacterListRow, removeCharacterListRow, renameCharacterListRow, refreshCharacterListCurrentPage, isCharacterListShowing, onCharacterListShown, entitiesFilter } from './scripts/character-list.js';
import { onSavedViewsChanged } from './scripts/saved-views.js';
export { entitiesFilter };
import { userStatsHandler, initStats } from './scripts/stats.js';
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
    bindTextGenSettings,
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
    sendAuxBooksOp,
    takeAuxBooks,
    updateWorldInfoList,
} from './scripts/world-info.js';
import { character_world_link } from './scripts/character-world-link.js';
import { holdGroup } from './scripts/group-store.js';

import {
    groupsStore,
    selected_group,
    is_group_generating,
    resetSelectedGroup,
    select_group_chats,
    regenerateGroup,
    group_generation_id,
    getGroupChat,
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
    getCustomStoppingStrings,
    switchMaxContextSize,
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
    bindChatCompletionSettings,
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
    initHorde,
} from './scripts/horde.js';

import {
    debounce,
    delay,
    trimToEndSentence,
    countOccurrences,
    isOdd,
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
import { getAtPath, seedKeyHashes, setAtPath, settingsWithoutCharLore, normalizeFav } from './scripts/hash-utils.js';
import { countedCardFieldValue, isCountedCardField } from './scripts/card-token-texts.js';
import { chatOpenAsks, takeChatOpenParts } from './scripts/chat-open-parts.js';
import { debounce_timeout, IGNORE_SYMBOL, inject_ids, MEDIA_DISPLAY, MEDIA_TYPE, OVERSWIPE_BEHAVIOR, SCROLL_BEHAVIOR, SWIPE_DIRECTION, SWIPE_SOURCE, SWIPE_STATE, UNSET_VALUE } from './scripts/constants.js';

import { extension_settings } from './scripts/extension-settings.js';
import { executeSlashCommandsOnChatInput, initDefaultSlashCommands, initSlashCommandAutoComplete, isExecutingCommandsFromChatInput, pauseScriptExecution, stopScriptExecution } from './scripts/slash-commands.js';
import { initMacroAutoComplete } from './scripts/autocomplete/MacroAutoComplete.js';
import {
    chooseBogusFolder,
    loadTagsFromServer,
    reindexTagAssignments,
    tagsStore,
    importTags,
    mergeServerTagDefinitions,
    initTags,
    tag_import_setting,
    applyCharacterTagsToMessageDivs,
    removeEntityTags,
    onTagsChanged,
    onEntityTagsChanged,
} from './scripts/tags.js';
import { checkOpenRouterAuth, initSecrets, readSecretState } from './scripts/secrets.js';
import { reloadMarkedProcessor } from './scripts/marked-processor.js';
import { NOTE_MODULE_NAME, initAuthorsNote, metadata_keys, shouldWIAddPrompt } from './scripts/authors-note.js';
import { registerPromptManagerMigration } from './scripts/PromptManager.js';
import { initLogprobs, saveLogprobsForActiveMessage } from './scripts/logprobs.js';
import { openRightMenu, closeRightMenu } from './scripts/right-menu-state.js';
import { initCfg } from './scripts/cfg-scale.js';
import {
    formatInstructModeChat,
    formatInstructModePrompt,
    formatInstructModeStoryString,
    getInstructStoppingSequences,
} from './scripts/instruct-mode.js';
import { initLocales, t } from './scripts/i18n.js';
import { getMessageTokenCounts, getTokenCount, initTokenizers } from './scripts/tokenizers.js';
import {
    user_avatar,
    getUserAvatars,
    getUserAvatar,
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
    personaAvatar,
    personaCrop,
    personaThumbnail,
} from './scripts/personas.js';
import { frameImage, shownThumbnail } from './scripts/shown-thumbnail.js';
import { startNewUi, takeViews, chatClosed, newUi, newUiStarted } from './scripts/new-ui.js';
import { loader } from './scripts/action-loader.js';
import { BulkEditOverlay } from './scripts/BulkEditOverlay.js';
import { initTextGenModels } from './scripts/textgen-models.js';
import { hasPendingFileAttachment, populateFileAttachment, isExternalMediaAllowed, preserveNeutralChat, restoreNeutralChat, formatCreatorNotes, initChatUtilities, addDOMPurifyHooks, initMessageMediaVolume, showMediaLightbox } from './scripts/chats.js';
import { getFocusedField, getMountedTextarea } from './scripts/live-editor/registry.js';
import { initChatBoxEditor, initChatLiveEditor, mountChatEditor, unmountChatEditor } from './scripts/chat-live-editor.js';
import { beginEdit, blockFieldEditStart, blockWhileFieldEditing, initCharacterFieldEditor, isFieldBeingEdited, setFieldValue } from './scripts/character-field-editor.js';
import { initCharInfoTabDimming, refreshCharInfoTabDimming } from './scripts/char-info-tab-dimming.js';
import { initPresetManager } from './scripts/preset-manager.js';
import { getLastMessageId, initMacros } from './scripts/macros.js';
import { currentUser, setUserControls } from './scripts/user.js';
import { POPUP_RESULT, POPUP_TYPE, Popup, callGenericPopup, fixToastrForDialogs } from './scripts/popup.js';
import { initMacroColorsEditor } from './scripts/macro-colors-editor.js';
import { applyMacroColors, macroColorsOf } from './scripts/macro-colors.js';
import { renderTemplateAsync } from './scripts/templates.js';
import { assetUrl } from './scripts/asset-url.js';
import { DragAndDropHandler } from './scripts/dragdrop.js';
import { INTERACTABLE_CONTROL_CLASS, initKeyboard } from './scripts/keyboard.js';
import { initDynamicStyles } from './scripts/dynamic-styles.js';
import { initInputMarkdown } from './scripts/input-md-formatting.js';
import { autosizeTextareas, initAutosizeTextareas } from './scripts/autosize-textareas.js';
import { AbortReason } from './scripts/util/AbortReason.js';
import { initDrawerStack, isDrawerCovered, frontmostOf, raiseDrawer, drawerStackChanged, drawerLayersChanged, addLayer, bringChatForward, restoreLayerOrder } from './scripts/drawer-stack.js';
import { initSystemPrompts } from './scripts/sysprompt.js';
import { ToolManager } from './scripts/tool-calling.js';
import { applyBrowserFixes } from './scripts/browser-fixes.js';
import { initServerHistory } from './scripts/server-history.js';
import { initSettingsSearch } from './scripts/setting-search.js';
import { initBulkEdit } from './scripts/bulk-edit.js';
import { initReasoning, parseReasoningInSwipes, PromptReasoning, ReasoningHandler, removeReasoningFromString, updateReasoningUI } from './scripts/reasoning.js';
import { accountStorage } from './scripts/util/AccountStorage.js';
import { initWelcomeScreen, openPermanentAssistantChat, openPermanentAssistantCard } from './scripts/welcome-screen.js';
import { initDataMaid } from './scripts/data-maid.js';
import { saveDraft, loadDraft, isDraftHeld } from './scripts/chat-draft.js';
import { initFailedSends, keepFailedSend, recordSend, keptSendKeys, forgetStoredSends } from './scripts/failed-sends.js';
import { initItemizedPrompts, ITEMIZED_PROMPT_FLAG, itemizedPrompts } from './scripts/itemized-prompts.js';
import { getSystemMessageByType, initSystemMessages, SAFETY_CHAT, sendSystemMessage, system_message_types } from './scripts/system-messages.js';
import { event_types, eventSource } from './scripts/events.js';
import { token, setToken, getRequestHeaders } from './scripts/request-headers.js';
import { observeSessionAnswers, onChangeStream, prepareTabSession } from './scripts/tab-session.js';
import { beginServerGeneration, endServerGeneration, takeStopResult } from './scripts/generation-stop.js';
import { chat, chat_metadata, setChatMetadata } from './scripts/chat-state.js';
import { active_character, active_group, name1, default_user_name, setActiveCharacter, setActiveGroup, setActiveCharacterAndGroupFromSettings, setName1Raw } from './scripts/app-selection-state.js';
import { amount_gen, max_context, main_api, setAmountGen, setMaxContext, setMainApi } from './scripts/generation-params.js';
export { getRequestHeaders, chat, chat_metadata, name1 };
import { initAccessibility } from './scripts/a11y.js';
import { applyStreamFadeIn } from './scripts/util/stream-fadein.js';
import { initDomHandlers } from './scripts/dom-handlers.js';
import { SimpleMutex } from './scripts/util/SimpleMutex.js';
import { AudioPlayer } from './scripts/audio-player.js';
import { MacroEnvBuilder } from './scripts/macros/engine/MacroEnvBuilder.js';
import { messageFormatting } from './scripts/message-formatting.js';
import { reportStoredHeader } from './scripts/stored-report.js';
export { messageFormatting };
import {
    updateMessage,
    updateIn,
    ensureOpeningRow,
    chatOpEdit,
    chatOpEditMany,
    chatOpAppend,
    chatOpAddAlternative,
    chatOpCut,
    chatOpGraft,
    chatOpReadyAlternativeDelete,
    chatOpDeleteAlternativeNode,
    _mergeCardGreetingsIntoOpening,
    isComposedSlot,
    chatOpStoreComposed,
    _setCurrentTarget,
    setStoreRef,
    storeRefOf,
    adoptStored,
    chatOpAppendAfter,
    setSendStoredListener,
    openingForRequest,
    setUnstoredExtra,
} from './scripts/chat-store.js';
export {
    updateMessage,
    updateIn,
    adoptStored,
    openingForRequest,
    chatOpEdit,
    chatOpEditMany,
    chatOpAppend,
    chatOpAddAlternative,
    chatOpCut,
};
import { isStoredNodeId, isProvisionalNodeId, provisionalNodeId } from './scripts/node-identity.js';
export { isStoredNodeId, isProvisionalNodeId, provisionalNodeId };
import { saveMetadata, _resetMetadataSaveSnapshot, takePushedState, openChatMacroScope, cancelDebouncedMetadataSave } from './scripts/metadata-store.js';
export { openChatMacroScope };
export { saveMetadata };
import { switchToNode, switchToAlternativePath } from './scripts/node-navigation.js';
export { switchToNode };
import {
    Generate, stopGeneration,
    streamingProcessor, abortController, setAbortController, kobold_horde_model, generation_started,
    _messageSnapshots, _snapshotMessages, markStoredAs, isAsStored, forgetStored, finishStreamedReplyPersistence, applyStoredReply,
    stampReplyNode, beginSwipeReply, isReplyGenerating,
} from './scripts/generation.js';
import { takeStoredReply } from './scripts/llamacpp-compact-stream.js';
export {
    Generate,
    stopGeneration,
    _messageSnapshots,
    _snapshotMessages,
    markStoredAs,
    isAsStored,
    forgetStored,
    isReplyGenerating,
};
import { MacroEngine } from './scripts/macros/engine/MacroEngine.js';
import { addChatBackupsBrowser } from './scripts/chat-backups.js';
import { compressRequest, setRequestCompressionConfig } from './scripts/request-compression.js';
import { alternativesOldPage, canJumpToSwipeForMessage, canOpenSwipePickerForMessage, initSwipePicker } from './scripts/alternatives.js';
import { activationsOldPage, chatMessageHtml, initLoreMarks, updateLoreMark } from './scripts/activations.js';

export {
    user_avatar,
    nai_settings,
    koboldai_settings,
    koboldai_setting_names,
    novelai_settings,
    novelai_setting_names,
    system_message_types,
    sendSystemMessage,
    getSystemMessageByType,
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
        fixToastrForDialogs();
    },
};

toastr.subscribe(function (args) {
    drawerLayersChanged();
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

// array for prompt token calculations

export const systemUserName = 'SillyTavern System';
export const neutralCharacterName = 'Assistant';
export let name2 = systemUserName;

/**
 * @type {import('./scripts/constants.js').SWIPE_STATE}
 */
export let swipeState = SWIPE_STATE.NONE;
let importFlashTimeout;
let firstRun = false;
let settingsReady = false;
let currentVersion = '0.0.0';
export let displayVersion = 'SillyTavern';

charactersStore.onChange(() => invalidateCharactersFuseIndex());
export function getCurrentCharacter() {
    return this_avatar !== undefined ? charactersStore.get(this_avatar) : undefined;
}

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
    '#character_book_json': { v2: 'data.character_book', transform: 'json' },
};

/**
 * @param {object} character
 * @param {string} formId
 * @returns {string}
 */
function characterFormValue(character, formId) {
    if (isCountedCardField(formId)) return countedCardFieldValue(character, formId);
    const data = character.data;
    switch (formId) {
        case '#creator_notes_textarea': return String(data?.creator_notes || character.creatorcomment || '');
        case '#tags_textarea': return Array.isArray(data?.tags) ? data.tags.join(', ') : '';
        case '#creator_textarea': return String(data?.creator ?? '');
        case '#character_version_textarea': return String(data?.character_version || '');
        case '#talkativeness_slider': return String(character.talkativeness || talkativeness_default);
        case '#depth_prompt_depth': return String(data?.extensions?.depth_prompt?.depth ?? depth_prompt_depth_default);
        case '#depth_prompt_role': return String(data?.extensions?.depth_prompt?.role ?? depth_prompt_role_default);
        case '#character_world': return String(data?.extensions?.world || '');
        case '#character_book_json': return data?.character_book ? JSON.stringify(data.character_book) : '';
        default: throw new Error(`characterFormValue: ${formId} is not a character card field`);
    }
}

/** @type {Map<string, number>} */
const _loadedCharacterFieldHashes = new Map();
/** @type {string|null} */
let _loadedCharacterFieldHashesAvatar = null;

/**
 * @param {object} character
 * @param {string} v2Path
 * @returns {number}
 */
function hashCharacterFieldValue(character, v2Path) {
    const value = getAtPath(character, v2Path);
    return getStringHash(JSON.stringify(value !== undefined ? value : null));
}

/**
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
 * @param {object} character
 * @param {string} formId
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

/** @type {Map<string, {timer: ReturnType<typeof setTimeout>, avatar: string, formId: string, value: string}>} */
const pendingCharacterFieldSaves = new Map();

/** @type {Map<string, {tail: Promise<boolean>, hash: number|undefined}>} */
const characterFieldSaveChains = new Map();

/**
 * @param {string} avatar
 * @param {string} formId
 */
function characterFieldSaveKey(avatar, formId) {
    return `${avatar}\n${formId}`;
}

keepHeldCharacters(() => {
    const avatars = [...characterFieldSaveChains.keys(), ...pendingCharacterFieldSaves.keys()].map(key => key.split('\n')[0]);
    if (_loadedCharacterFieldHashesAvatar) avatars.push(_loadedCharacterFieldHashesAvatar);
    return avatars;
});

/**
 * @param {string} avatar
 * @param {string} formId
 * @param {string} value
 * @param {{hash: number|undefined}} [baseline]
 * @returns {Promise<boolean>}
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
        if (mapping.v1) setAtPath(mergeData, mapping.v1, converted.value);
        setAtPath(mergeData, mapping.v2, converted.value);
        mergeData._loadedFieldHashes = { [mapping.v2]: chain.hash };

        try {
            const fetchResult = await fetch('/api/characters/merge-attributes', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify(mergeData),
            });

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

            chain.hash = Number.isFinite(savedHash) ? savedHash : hashCharacterFieldValue(character, mapping.v2);
            if (_loadedCharacterFieldHashesAvatar === avatar) {
                _loadedCharacterFieldHashes.set(mapping.v2, chain.hash);
            }
            if (baseline) {
                baseline.hash = chain.hash;
            }

            await eventSource.emit(event_types.CHARACTER_EDITED, { detail: { character } });
            updateCharacterListRow(avatar);
            return true;
        } catch (error) {
            console.error(`Failed to save ${formId} for ${avatar}`, error);
            const fieldName = mapping.v2.replace(/^data\.extensions\.depth_prompt\./, 'Depth Prompt ')
                .replace(/^data\.extensions\./, '')
                .replace(/^data\./, '')
                .replace(/_/g, ' ');
            const characterName = String(charactersStore.get(avatar)?.name ?? avatar);
            toastr.error(t`${fieldName} of ${characterName} was not saved. What you typed is still in the field, and is kept if you reload.`, t`Not saved`, { timeOut: 0, extendedTimeOut: 0 });
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

/** @returns {string} */
function getEditorCharacterAvatar() {
    return String($('#avatar_url_pole').val() ?? '');
}

/**
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

/**
 * @param {string} value
 * @returns {Promise<boolean>}
 */
function saveCreatorNotesField(value) {
    return saveTextField('#creator_notes_textarea', 'creator_notes', value);
}

/**
 * @param {string} value
 * @returns {Promise<boolean>}
 */
function saveDescriptionField(value) {
    return saveTextField('#description_textarea', 'description', value);
}

/**
 * @param {string} value
 * @returns {Promise<boolean>}
 */
export function saveSystemPromptField(value) {
    return saveTextField('#system_prompt_textarea', 'system_prompt', value);
}

/**
 * @param {string} value
 * @returns {Promise<boolean>}
 */
function savePostHistoryInstructionsField(value) {
    return saveTextField('#post_history_instructions_textarea', 'post_history_instructions', value);
}

/**
 * @param {string} value
 * @returns {Promise<boolean>}
 */
function savePersonalityField(value) {
    return saveTextField('#personality_textarea', 'personality', value);
}

/**
 * @param {string} value
 * @returns {Promise<boolean>}
 */
function saveScenarioField(value) {
    return saveTextField('#scenario_pole', 'scenario', value);
}

/**
 * @param {string} value
 * @returns {Promise<boolean>}
 */
function saveCharacterNoteField(value) {
    return saveTextField('#depth_prompt_prompt', 'depth_prompt_prompt', value);
}

/**
 * @param {string} value
 * @returns {Promise<boolean>}
 */
function saveExampleMessagesField(value) {
    return saveTextField('#mes_example_textarea', 'mes_example', value);
}

let is_delete_mode = false;
let fav_ch_checked = false;
let scrollLock = false;
export let abortStatusCheck = new AbortController();
/** @type {debounce_timeout} The debounce timeout used for chat/settings save. debounce_timeout.long: 1.000 ms */
export const DEFAULT_SAVE_EDIT_TIMEOUT = debounce_timeout.relaxed;

const _debouncedSaveImpl = debounce(() => {
    const { full } = _settingsSaveWindow;
    _settingsSaveWindow = { full: false };
    return runSettingsSave({ full });
}, DEFAULT_SAVE_EDIT_TIMEOUT);

/**
 * A full request anywhere in the window makes its run a full save, so it is never dropped.
 * @param {{ full: boolean }} save The call's kind.
 */
function scheduleSettingsSave({ full }) {
    _settingsSaveWindow = { full: _settingsSaveWindow.full || full };
    _debouncedSaveImpl();
}

/**
 * @param {...string} keys The settings that changed; none makes it a full save.
 */
export function saveSettingsDebounced(...keys) {
    scheduleSettingsSave(noteSettingsKeys(keys));
}

const getCharactersDebounced = debounce(() => getCharacters({ keepListPosition: true, skipPrint: !isCharacterListShowing() }), 2000);

/**
 * The warning for a queued tag move the server couldn't apply.
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

const CHANGE_STREAM_NOTICE_AFTER_MS = 10000;

function onCharacterChangeMessage() {
    getCharactersDebounced();
}

function setupCharacterChangeStream() {
    if (typeof EventSource === 'undefined') return;
    let hadError = false;
    let notice = null;
    let noticeTimer = null;
    const startNoticeTimer = () => {
        if (noticeTimer !== null || notice) return;
        noticeTimer = setTimeout(() => {
            noticeTimer = null;
            notice = toastr.warning(t`Live updates are disconnected. Retrying...`, '', { timeOut: 0, extendedTimeOut: 0 });
        }, CHANGE_STREAM_NOTICE_AFTER_MS);
    };

    startNoticeTimer();
    onChangeStream({
        message: (message) => {
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
            if (message?.type === 'views-changed') {
                void onSavedViewsChanged();
                return;
            }
            if (message?.type === 'state') {
                takePushedState({ tree: message.tree, at: message.at ?? null, state: message.state });
                return;
            }
            if (message !== null && typeof message === 'object' && message.type === undefined) onCharacterChangeMessage();
        },
        open: () => {
            clearTimeout(noticeTimer);
            noticeTimer = null;
            if (notice) {
                toastr.clear(notice);
                notice = null;
            }
            if (!hadError) return;
            hadError = false;
            onCharacterChangeMessage();
            onEntityTagsChanged();
            onTagsChanged();
        },
        error: () => {
            hadError = true;
            startNoticeTimer();
        },
    });
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
    reloadMarkedProcessor(power_user.markdown_escape_strings, substituteParams);
}

export function getCurrentChatId() {
    const selection = getSelectionState();
    if (selection.type === 'group') {
        return groupsStore.get(selection.groupId)?.chat_id;
    } else if (selection.type === 'character') {
        return getCurrentCharacter()?.chat;
    }
}

/** @returns {import('./scripts/chat-draft.js').DraftContext|null} */
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

/**
 * @returns {import('./scripts/chat-draft.js').DraftContext|null}
 */
function getCurrentChatContext() {
    const selection = getSelectionState();
    const chatId = getCurrentChatId() ?? '';
    if (selection.type === 'group') {
        return { type: 'group', id: selection.groupId, chatId };
    }
    if (selection.type === 'character') {
        return { type: 'character', id: selection.avatar, chatId };
    }
    return null;
}

function flushDraftSave() {
    const context = getCurrentDraftContext();
    if (!context) {
        return;
    }
    const text = String($('#send_textarea').val());
    if (!text.trim() && isDraftHeld(context)) {
        return;
    }
    saveDraft(localStorage, context, text);
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

let characterListWasShowing = false;
let characterListShowHandledByCaller = false;

let selected_button = ''; //which button pressed

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
let animation_easing = 'ease-in-out';
let popup_type = '';
let chat_file_for_del = '';
export let online_status = 'no_connection';

export let is_send_press = false; //Send generation
const isGenerating = () => (is_send_press || is_group_generating);

let this_del_mes = -1;
let deleteToolCallsInDeleteMode = true;

/** @type {string} */
let this_edit_mes_chname = '';
/** @type {number|undefined} */
let this_edit_mes_id = undefined;

//settings
let settings;
/** @type {number|null} */
let lastSavedSettingsHash = null;
/** @type {number|null} */
let knownServerSettingsHash = null;
const pendingSettingsKeys = new Set();
/** @type {Record<string, number>} */
const serverKeyHashes = {};

/**
 * @param {unknown} value
 * @param {string} [key]
 */
function seedSettingsHashes(value, key = '') {
    const { value: hashed, skip } = settingsWithoutCharLore(key, value);
    if (!skip) seedKeyHashes(serverKeyHashes, hashed, key);
}

/**
 * @param {Record<string, number> | undefined} keyHashes
 * @param {string[] | null} tops
 * @returns {boolean}
 */
function takeServerKeyHashes(keyHashes, tops) {
    if (!keyHashes || typeof keyHashes !== 'object') return false;
    for (const key of Object.keys(serverKeyHashes)) {
        if (!tops || tops.some(top => key === top || key.startsWith(`${top}.`))) delete serverKeyHashes[key];
    }
    Object.assign(serverKeyHashes, keyHashes);
    return true;
}
/** @type {{ full: boolean }} */
let _settingsSaveWindow = { full: false };
let _saveQueue = Promise.resolve();
/** User preference for swipeable messages */
let swipes = true;
/** Forcefully hide swipes. */
let swipesHidden = false;
/** @type {{ now: number, direction: string }} */
let lastSwipeInfo = { now: performance.now(), direction: SWIPE_DIRECTION.RIGHT };
let recentSwipes = 0;

export let extension_prompts = {};

//css
var css_send_form_display = $('<div id=send_form></div>').css('display');


$.ajaxPrefilter((options, originalOptions, xhr) => {
    xhr.setRequestHeader('X-CSRF-Token', token);
});

//MARK: firstLoadInit
async function firstLoadInit() {
    observeSessionAnswers();
    try {
        const tokenResponse = await fetch('/csrf-token');
        const tokenData = await tokenResponse.json();
        setToken(tokenData.token);
    } catch {
        toastr.error(t`Couldn't get CSRF token. Please refresh the page.`, t`Error`, { timeOut: 0, extendedTimeOut: 0, preventDuplicates: true });
        throw new Error('Initialization failed');
    }
    try {
        await prepareTabSession(getRequestHeaders);
    } catch {
        toastr.error(t`Couldn't open this tab's session. Please refresh the page.`, t`Error`, { timeOut: 0, extendedTimeOut: 0, preventDuplicates: true });
        throw new Error('Initialization failed');
    }

    const initLoaderOverlay = loader.createOverlay();
    initLoaderOverlay.classList.add('splash-screen');

    const splashLogo = document.createElement('img');
    splashLogo.src = assetUrl('/img/logo.png');
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
    addDOMPurifyHooks();
    initMessageMediaVolume();
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
        macroScope: () => (menu_type === 'create' ? {} : { ...openChatMacroScope(), avatar_url: getEditorCharacterAvatar() }),
        messageFormatting,
        formatCreatorNotes: (text, valueOf, styleScope) => formatCreatorNotes(text, menu_type === 'create' ? '' : getCurrentCharacter()?.avatar, { valueOf, styleScope }),
        power_user,
        t,
        macroPerson: macroName => macroPerson(macroName, { avatar: menu_type === 'create' ? '' : getEditorCharacterAvatar(), name: String($('#character_name_pole').val() ?? '') }),
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
        uploadImage: uploadEditorImage,
        onEditStart: id => { if (id === 'greeting_field') beginGreetingPagerEdit(); },
        onEditEnd: id => { if (id === 'greeting_field') endGreetingPagerEdit(); },
        editorKey: () => (menu_type === 'create' ? '' : getEditorCharacterAvatar()),
    });
    initChatLiveEditor({
        messageFormatting,
        macroScope: openChatMacroScope,
        power_user,
        uploadImage: uploadEditorImage,
        userName: () => name1,
        nextMessageId: () => chat.length,
        macroPerson: (macroName, characterName) => macroPerson(macroName, { name: characterName }),
    });
    initChatBoxEditor(/** @type {HTMLTextAreaElement} */ (document.getElementById('send_textarea')));
    initMacroColorsEditor({
        getColors: () => macroColorsOf(power_user.macro_colors),
        setColors: (colors) => {
            power_user.macro_colors = colors;
            applyMacroColors(colors);
            saveSettingsDebounced('power_user.macro_colors');
        },
        t,
        showPopup: content => callGenericPopup(content, POPUP_TYPE.TEXT, '', { wide: true, allowVerticalScrolling: true }),
    }, document.getElementById('macro_colors_button'));
    initCharInfoTabDimming(() => greetingPagerState.greetings.some((greeting, i) => i !== greetingPagerState.index && greeting !== ''));
    initDefaultSlashCommands();
    initTextGenModels();
    initOpenAI();
    initTextGenSettings();
    initKoboldSettings();
    initNovelAISettings();
    initSystemPrompts();
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

    let residencySettled = false;
    const characterResidencyPromise = (async () => {
        await getCharacters();
        await reindexTagAssignments();
    })();
    characterResidencyPromise.then(() => { residencySettled = true; }, () => { residencySettled = true; });

    setStage('Rendering characters');
    await printCharacters(true);
    setupCharacterChangeStream();

    setStage('Loading assets');
    startNewUi({
        quietPrompt: prompt => generateQuietPrompt({ quietPrompt: prompt }),
        currentChat: () => {
            if (selected_group != null) return { group: String(selected_group) };
            const avatar = getCurrentCharacter()?.avatar;
            return typeof avatar === 'string' && avatar !== '' && chat.length > 0 ? { avatar } : null;
        },
        alternatives: alternativesOldPage,
        activations: activationsOldPage,
    });
    bindChatCompletionSettings(newUi().settings);
    bindTextGenSettings(newUi().settings);
    bindSharedSettings(newUi().settings);
    await initTokenizers();
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
    initDataMaid();
    initFailedSends({
        addOneMessage, deleteMessage, getCurrentChatContext, redisplayChat, reloadCurrentChat, updateViewMessageIds,
        switchToNode, chatOpAppendAfter, chatOpGraft, ensureOpeningRow, setSendStoredListener, setStoreRef, storeRefOf,
        isStoredNodeId, isProvisionalNodeId, provisionalNodeId, t,
        confirmDiscard: async (text) => await callGenericPopup(text, POPUP_TYPE.CONFIRM, '', { okButton: t`Discard`, cancelButton: t`Keep it` }) === POPUP_RESULT.AFFIRMATIVE,
    });
    initItemizedPrompts();
    initAccessibility();
    initSwipePicker();
    initLoreMarks({
        rerender: messageId => updateMessageBlock(messageId, chat[messageId]),
        editing: () => this_edit_mes_id,
        save: key => saveSettingsDebounced(key),
    });
    addDebugFunctions();

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

function displayOnlineStatus() {
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

function stopStatusLoading() {
    $('.api_loading').hide();
    $('.api_button').removeClass('disabled');
}

export function resultCheckStatus() {
    displayOnlineStatus();
    stopStatusLoading();
}

/**
 * @param {string} avatar
 * @param {{ switchMenu?: boolean, toastMissing?: boolean }} [options]
 * @returns {Promise<boolean>} false when there is no such character
 */
export async function selectCharacterByAvatar(avatar, { switchMenu = true, toastMissing = true } = {}) {
    if (selected_group && is_group_generating) {
        return true;
    }

    if (selected_group || String(this_avatar) !== String(avatar)) {
        //if clicked on a different character from what was currently selected
        if (blockWhileFieldEditing()) {
            return true;
        }
        if (is_send_press) {
            toastr.info(t`Please wait until the current generation finishes before switching characters.`, t`Generation in progress...`);
            return true;
        }
        /** @type {ChatOpenAnswer|null} */
        let opened = null;
        let entity = charactersStore.get(avatar);
        if (!entity) {
            try {
                opened = await requestChatOpen({ avatar_url: avatar, chat: null, make_current: false, fresh: false, with_character: true });
                if (opened.character) {
                    entity = charactersStore.get(avatar) ?? charactersStore.create({ ...opened.character, chat: opened.character.chat ? String(opened.character.chat) : '', shallow: false })?.entity;
                }
            } catch (error) {
                if (error?.status !== 404) {
                    console.error('Could not open the character:', avatar, error);
                    toastr.error(t`The chat could not be opened. Check the server connection and try again.`, t`Chat not opened`);
                    return true;
                }
            }
            if (!entity) {
                if (toastMissing) toastr.error(t`Character ${avatar} not found`, t`Error`, { timeOut: 5000, preventDuplicates: true });
                return false;
            }
        }
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
        await openCharacterConversation({ opened });
    } else {
        //if clicked on character that was already selected
        switchMenu && (selected_button = 'character_edit');
        select_selected_character(avatar, { switchMenu });
    }
    return true;
}


async function delChat(chatfile) {
    const name = chatfile.replace('.jsonl', '');
    const avatar = getCurrentCharacter().avatar;
    const isCurrent = name === getCurrentCharacter().chat;
    const response = await fetch('/api/chats/delete', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            chatfile: chatfile,
            avatar_url: avatar,
            ...(isCurrent ? { open: true, ...chatOpenAsk({ avatar_url: avatar }) } : {}),
        }),
    });
    if (response.ok === true) {
        const answer = await response.json().catch(() => null);
        if (isCurrent) {
            setChatMetadata({});
            _resetMetadataSaveSnapshot();
            await clearChat({ clearData: true });
            const opened = answer?.opened ? takeChatOpenAnswer({ avatar_url: avatar }, answer.opened) : null;
            await openCharacterConversation({ opened });
        }
        await eventSource.emit(event_types.CHAT_DELETED, name);
    }
}

/**
 * Deletes a character chat by its name.
 * @param {string} avatar The character's avatar
 * @param {string} fileName Name of the chat file to delete (without .jsonl extension)
 * @returns {Promise<void>} A promise that resolves when the chat is deleted.
 */
export async function deleteCharacterChatByName(avatar, fileName) {
    const character = charactersStore.get(avatar);
    if (!character) {
        console.warn(`Character ${avatar} not found.`);
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

    const data = await response.json().catch(() => null);
    if (data && typeof data.activeChat === 'string') {
        character.chat = data.activeChat;
    }

    await eventSource.emit(event_types.CHAT_DELETED, fileName);
}

async function pointToFreshChat(replace = null) {
    _setCurrentTarget('', null);
    await openCharacterConversation({ fresh: true });
    const openingNodeId = chat[0]?.node_id;
    const opening = isStoredNodeId(openingNodeId) ? openingNodeId : '';
    let current = getCurrentChatId() ?? '';
    try {
        const response = await fetch('/api/chats/new', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ avatar_url: getCurrentCharacter().avatar, chat: opening, ...(replace ? { replace } : {}) }),
        });
        if (!response.ok) throw new Error(String(response.status));
        const answer = await response.json();
        if (typeof answer.chat === 'string') current = answer.chat;
        for (const name of answer.deleted ?? []) await eventSource.emit(event_types.CHAT_DELETED, name);
    } catch (error) {
        console.error('Failed to start the new chat', error);
        toastr.error(t`Failed to save active chat.`);
    }
    _setCurrentTarget(current, chat_metadata.integrity ?? null);
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

        applyCharacterTagsToMessageDivs({ mesIds: Array.from({ length: Math.max(0, targetChat.length - startIndex) }, (_, i) => startIndex + i) });
    }

    refreshSwipeButtons(false, fade);
    applyStylePins();
    updateEditArrowClasses();
}

function scrollOnMediaLoad() {
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
 * Visually removes all chat message elements.
 * @param {object} [options] Options
 * @param {boolean} [options.clearData=false] Optionally clear the chat array's contents.
 */
export async function clearChat({ clearData = false } = {}) {
    cancelDebouncedMetadataSave();
    closeMessageEditor();
    extension_prompts = {};
    if (is_delete_mode) {
        $('#dialogue_del_mes_cancel').trigger('click');
    }
    //This will also remove non '.mes' elements, e.g. '<div id="show_more_messages">Show more messages</div>'.
    chatElement.children().remove();
    $('.zoomed_avatar[forChar]').remove();

    itemizedPrompts.length = 0;

    if (clearData) {
        chat.length = 0;
        _messageSnapshots.clear();
    }
}

export async function dropLastMessage() {
    forgetStored([chat[chat.length - 1]?.node_id]);
    await deleteLastMessage();
}

async function deleteLastMessage() {
    if (this_edit_mes_id !== undefined && Number(this_edit_mes_id) === chat.length - 1) {
        closeMessageEditor();
    }
    chat.length = chat.length - 1;
    chatElement.children('.mes').last().remove();
    await eventSource.emit(event_types.MESSAGE_DELETED, chat.length);
}

/**
 * @param {number} id
 * @param {boolean} [deleteToolCalls=true]
 * @returns {number}
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
 * @param {boolean} [persist=true] Whether to persist this deletion to the tree (chatOpCut).
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
        await deleteSwipe(swipeDeletionIndex, id, { ask: askConfirmation });
        return;
    }

    const firstMessageId = getMessageDeletionStartId(id, deleteToolCalls);
    const messageIds = Array.from({ length: id - firstMessageId + 1 }, (_, index) => id - index);

    if (persist) {
        const cut = await chatOpCut(firstMessageId, id, { ask: askConfirmation }).catch(error => {
            console.error('Could not remove the deleted message(s) from the tree:', error);
            return null;
        });
        if (cut === false) return;
    }

    if (this_edit_mes_id !== undefined && messageIds.includes(Number(this_edit_mes_id))) {
        closeMessageEditor();
    }

    // Delete from the end so earlier indices remain stable.
    for (const messageId of messageIds) {
        chat.splice(messageId, 1);
        chatElement.find(`.mes[mesid="${messageId}"]`).remove();
    }

    chat_metadata.tainted = true;

    const startIndex = firstMessageId <= minId ? firstMessageId : null;
    updateViewMessageIds(startIndex);

    refreshSwipeButtons();

    await eventSource.emit(event_types.MESSAGE_DELETED, chat.length);
}

const reloadChatMutex = new SimpleMutex(reloadCurrentChatUnsafe);
export const reloadCurrentChat = reloadChatMutex.update.bind(reloadChatMutex);

export const userInputGenerateMutex = new SimpleMutex(sendTextareaMessage);

const QUEUED_SEND_POLL_MS = 50;
/** @type {{ chat: string, timer: ReturnType<typeof setInterval> } | null} */
let queuedSend = null;

/**
 * @param {'button'|'enter'} source
 */
export async function requestTextareaSend(source) {
    if (queuedSend) {
        if (source === 'button') cancelQueuedSend();
        return;
    }
    const inGap = (userInputGenerateMutex.isBusy && !isGenerating() || swipeState === SWIPE_STATE.SWIPING) && $('#send_but').is(':visible');
    if (!inGap) {
        await userInputGenerateMutex.update();
        return;
    }
    flushDraftSave();
    queuedSend = {
        chat: JSON.stringify(getCurrentDraftContext()),
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
 * @param {string} [reason]
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
async function reloadCurrentChatUnsafe() {
    preserveNeutralChat();
    await clearChat({ clearData: true });

    const selection = getSelectionState();
    if (selection.type === 'group') {
        await getGroupChat(selection.groupId, true);
    } else if (selection.type === 'character') {
        await openCharacterConversation({ chat: getCurrentCharacter().chat || null });
    } else {
        resetChatState();
        restoreNeutralChat();
        await getCharacters();
        await printMessages();
        await eventSource.emit(event_types.CHAT_CHANGED, getCurrentChatId());
    }

    refreshSwipeButtons();
}

async function sendTextareaMessage() {
    if (swipeState == SWIPE_STATE.EDITING) {
        toastr.warning(t`Confirm the edit to start a generation.`, t`You cannot send a message during a swipe-edit.`);
        return;
    }
    if (swipeState !== SWIPE_STATE.NONE) return; // don't proceed if mid-swipe.
    if (is_send_press) return;

    const lastIndex = chat.length - 1;
    if (lastIndex >= 0 && lastIndex === Number(this_edit_mes_id) && isComposedSlot(chat[lastIndex])) {
        toastr.warning(t`Press Done to keep the new alternative, or cancel it, first.`, t`Not sent`);
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

    void modelIconSvg(apiName).then(svg => {
        if (!svg) return;
        const place = (/** @type {string} */ className, /** @type {string} */ targetSelector, insertBefore = false) => {
            const icon = /** @type {SVGSVGElement} */ (svg.cloneNode(true));
            icon.classList.add('icon-svg', className);
            const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
            title.textContent = extra?.model ? `${apiName} - ${extra.model}` : apiName;
            icon.prepend(title);
            const target = mes.find(targetSelector);
            const existing = insertBefore ? target.prev(`.${className}`) : target.next(`.${className}`);
            if (existing.length) existing.replaceWith(icon);
            else if (insertBefore) target.before(icon);
            else target.after(icon);
        };
        place('timestamp-icon', '.timestamp');
        place('thinking-icon', '.mes_reasoning_header_title', true);
    });
}

/** @type {Map<string, Promise<SVGSVGElement|null>>} */
const modelIconSvgs = new Map();

/**
 * @param {string} apiName
 * @returns {Promise<SVGSVGElement|null>}
 */
function modelIconSvg(apiName) {
    let svg = modelIconSvgs.get(apiName);
    if (!svg) {
        svg = fetch(`/img/${apiName}.svg`)
            .then(response => (response.ok ? response.text() : null))
            .then(text => {
                const root = text ? new DOMParser().parseFromString(text, 'image/svg+xml').documentElement : null;
                return root instanceof SVGSVGElement ? root : null;
            })
            .catch(() => null);
        modelIconSvgs.set(apiName, svg);
    }
    return svg;
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
        messageElement.find('.mes_text').html(chatMessageHtml(message, text,
            shown => messageFormatting(shown, message.name, message.is_system, message.is_user, messageId, {}, false)));
    }

    updateReasoningUI(messageElement);
    updateMessageItemizedPromptButton(message, { messageId, messageElement });
    updateLoreMark(message, messageElement);

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

        audio.get(0).dataset.userVolume = '';
        new AudioPlayer(audio.get(0), template.get(0), { volume: Math.max(0, Math.min(100, Number(power_user.media_volume) || 0)) / 100 });

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
export function updateMessageItemizedPromptButton(message, { messageId = chat.indexOf(message), messageElement = chatElement.find(`.mes[mesid="${messageId}"]`) }) {
    messageElement.find('.mes_prompt').toggle(!message.is_user && message.extra?.[ITEMIZED_PROMPT_FLAG] === true);
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

    return chatMessageHtml(message, message.extra?.display_text || message.mes, shown => messageFormatting(
        shown,
        message.name,
        message.is_system,
        message.is_user,
        messageId,
        sanitizerOverrides,
        false,
    ));
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

/** @type {Set<number>} */
const uncountedShownMessages = new Set();
/** @type {ReturnType<typeof setTimeout>|null} */
let shownCountsTimer = null;
const SHOWN_COUNTS_DELAY_MS = 30;

/**
 * @param {number} mesId
 */
function countShownMessage(mesId) {
    if (!power_user.message_token_count_enabled) return;
    uncountedShownMessages.add(mesId);
    shownCountsTimer ??= setTimeout(() => {
        shownCountsTimer = null;
        const mesIds = [...uncountedShownMessages];
        uncountedShownMessages.clear();
        fillTokenCounters(mesIds).catch(error => console.error('Could not count the shown messages:', error));
    }, SHOWN_COUNTS_DELAY_MS);
}

/**
 * @param {number[]} mesIds
 * @param {{ recount?: boolean }} [options]
 */
async function fillTokenCounters(mesIds, { recount = false } = {}) {
    const shown = mesIds
        .map(mesId => ({ mesId, message: chat[mesId] }))
        .filter(({ message }) => message && !message.is_system);
    const texts = shown.map(({ message }) => (message.extra?.reasoning || '') + message.mes);
    if (!texts.some(text => text.length > 0)) return;
    const counts = await getMessageTokenCounts(texts, { recount });
    shown.forEach(({ mesId }, k) => {
        const current = chat[mesId];
        if (!current || !counts[k] || (current.extra?.reasoning || '') + current.mes !== texts[k]) return;
        setUnstoredExtra(mesId, { token_count: counts[k] });
        const element = chatElement.find(`.mes[mesid="${mesId}"]`);
        element.find('.tokenCounterDisplay').text(`${counts[k]}t`);
        const { timerValue, timerTitle } = formatGenerationTimer(current.gen_started, current.gen_finished, counts[k], current.extra?.reasoning_duration, current.extra?.time_to_first_token);
        if (timerValue) element.find('.mes_timer').attr('title', timerTitle).text(timerValue);
    });
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
    let avatarImg = personaThumbnail(user_avatar);

    //for non-user messages
    if (!mes.is_user) {
        if (mes.force_avatar) {
            avatarImg = shownAvatar(mes);
        } else if (getSelectionState().type !== 'character') {
            avatarImg = system_avatar;
        } else {
            avatarImg = characterThumbnail(getCurrentCharacter());
        }
        //old processing:
        //if message is from system, use the name provided in the message JSONL to proceed,
        //if not system message, use name2 (char's name) to proceed
        //characterName = mes.is_system || mes.force_avatar ? mes.name : name2;
    } else if (mes.is_user && mes.force_avatar) {
        // Special case for persona images.
        avatarImg = shownAvatar(mes);
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
    updateLoreMark(mes, messageElement);

    messageElement.find('.avatar img').on('error', function () {
        $(this).hide();
        $(this).parent().html('<div class="missing-avatar fa-solid fa-user-slash"></div>');
    });

    appendMediaToMessage(mes, messageElement, adjustMediaScroll);
    messageElement.find('.mes_text').html(messageHTML);
    addCopyToCodeBlocks(messageElement);

    updateSwipeCounter(messageId, { message: mes, messageElement });
    countShownMessage(messageId);

    return messageElement;
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
 * @deprecated Use substituteParams(content, options).
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
function substituteParamsLegacy(content, _name1, _name2, _original, _group, _replaceCharacterCard = true, additionalMacro = {}, postProcessFn = (x) => x) {
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

    const isOptionsObject = options && typeof options === 'object' && !Array.isArray(options);
    if (!isOptionsObject) {
        return substituteParamsLegacy.call(this, ...arguments);
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
 * @prop {string} [forceAvatar] Avatar key of the character to use for this generation run. Works in groups only.
 * @prop {object} [jsonSchema] JSON schema to use for the structured generation. Usually requires a special instruction.
 * @prop {boolean} [removeReasoning] Parses and removes the reasoning block according to reasoning format preferences
 * @prop {boolean} [trimToSentence] Whether to trim the response to the last complete sentence
 * @param {GenerateQuietPromptParams} params Parameters for the quiet prompt generation
 * @returns {Promise<string>} Generated text. If using structured output, will contain a serialized JSON object.
 */
export async function generateQuietPrompt({ quietPrompt = '', quietToLoud = false, skipWIAN = false, quietImage = null, quietName = null, responseLength = null, forceAvatar = null, jsonSchema = null, removeReasoning = true, trimToSentence = false } = {}) {
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
            force_avatar: forceAvatar,
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
    const INJECT_TAG = inject_ids.PERSONA_DESCRIPTION;
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
 * @param {string} [options.avatar] Optional character avatar. Falls back to the current character when undefined.
 * @returns {CharacterCardFields} Character card fields with lazy evaluation
 */
export function getCharacterCardFieldsLazy({ avatar = undefined } = {}) {
    const character = avatar !== undefined ? charactersStore.get(avatar) : getCurrentCharacter();

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
 * @param {string} [options.avatar] Optional character avatar, as for {@link getCharacterCardFieldsLazy}
 * @returns {CharacterCardFields} Character card fields
 */
export function getCharacterCardFields({ avatar = undefined } = {}) {
    const lazy = getCharacterCardFieldsLazy({ avatar });

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
        this.toolCallAborted = false;
        /** @type {string?} */
        this.assistantNodeId = null;
        /** @type {unknown} */
        this.adoptedStored = null;
        // Initialize reasoning in its own handler
        this.reasoningHandler = new ReasoningHandler(timeStarted);
        /** @type {PromptReasoning} */
        this.promptReasoning = promptReasoning;
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

            updateMessage(messageId, {
                mes: processedText,
                gen_started: this.timeStarted,
                gen_finished: currentTime,
                extra: { ...(chat[messageId].extra || {}), time_to_first_token: this.timeToFirstToken },
            });

            await this.reasoningHandler.process(messageId, mesChanged, this.promptReasoning);
            processedText = chat[messageId].mes;

            if (isFinal) countShownMessage(messageId);

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

            const timePassed = formatGenerationTimer(this.timeStarted, currentTime, 0, this.reasoningHandler.getDuration(), this.timeToFirstToken);
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
            message = chat[messageId];
        }

        syncMesToSwipe(messageId);
        saveLogprobsForActiveMessage(this.messageLogprobs.filter(Boolean), this.continueMessage);

        // Store reasoning signature for models that support multi-turn context
        if (this.reasoningSignature) {
            updateMessage(messageId, {
                extra: { ...(chat[messageId].extra || {}), reasoning_signature: this.reasoningSignature },
            });
            message = chat[messageId];
        }

        if (unlockUI && this.type !== 'impersonate' && isStoredNodeId(this.assistantNodeId)) {
            stampReplyNode(messageId, /** @type {string} */ (this.assistantNodeId));
            message = chat[messageId];
        }

        if (unlockUI) {
            this.markUIGenStopped();
        }

        if (this.type !== 'impersonate') {
            const shown = applyStoredReply(messageId, takeStoredReply(this.assistantNodeId), { received: true });
            if (shown) {
                message = shown;
                updateMessageBlock(messageId, shown);
                if (Array.isArray(shown.extra?.media) && shown.extra.media.length) appendMediaToMessage(shown, $(this.messageDom));
            }
            if (isStoredNodeId(chat[messageId]?.node_id) && chat[messageId].node_id === this.assistantNodeId) {
                markStoredAs(chat[messageId].node_id, chat[messageId]);
            }
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
        await finishStreamedReplyPersistence({ assistantNodeId: this.assistantNodeId });

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

        const interval = new Stopwatch(1000 / power_user.streaming_fps).interval;
        let lastDraw = Date.now();
        /** @type {ReturnType<typeof setTimeout>|null} */
        let trailingDraw = null;
        let drawing = Promise.resolve();
        const draw = () => {
            if (trailingDraw) {
                clearTimeout(trailingDraw);
                trailingDraw = null;
            }
            lastDraw = Date.now();
            drawing = drawing.then(() => this.onProgressStreaming(this.messageId, this.continueMessage + this.result));
            return drawing;
        };
        const requestDraw = async () => {
            const wait = interval - (Date.now() - lastDraw);
            if (wait <= 0) {
                await draw();
            } else if (!trailingDraw) {
                trailingDraw = setTimeout(() => {
                    trailingDraw = null;
                    if (!this.isStopped && !this.isFinished && !this.abortController.signal.aborted) void draw();
                }, wait);
            }
        };

        try {
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
                this.toolCallHandoff = state?.toolCallHandoff ?? this.toolCallHandoff;
                this.toolCallAborted = state?.toolCallAborted ?? this.toolCallAborted;
                this.assistantNodeId = state?.assistantNodeId ?? this.assistantNodeId;
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
                this.reasoningSignature = state?.signature ?? null;
                await requestDraw();
            }
            if (trailingDraw) {
                clearTimeout(trailingDraw);
                trailingDraw = null;
            }
            await drawing;
            const seconds = (timestamps[timestamps.length - 1] - timestamps[0]) / 1000;
            console.warn(`Stream stats: ${timestamps.length} tokens, ${seconds.toFixed(2)} seconds, rate: ${Number(timestamps.length / seconds).toFixed(2)} TPS`);
        } catch (err) {
            if (trailingDraw) {
                clearTimeout(trailingDraw);
                trailingDraw = null;
            }
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
function createRawPrompt(prompt, api, instructOverride, quietToLoud, systemPrompt, prefill) {
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
async function generateRawData({ prompt = '', api = null, instructOverride = false, quietToLoud = false, systemPrompt = '', responseLength = null, prefill = '', jsonSchema = null } = {}) {
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
                    generateData = { prompt: prompt, gui_settings: true, max_length: responseLengthFor(api), max_context_length: max_context, api_server: kai_settings.api_server };
                } else {
                    const isHorde = api === 'koboldhorde';
                    const koboldSettings = koboldai_settings[koboldai_setting_names[kai_settings.preset_settings]];
                    generateData = getKoboldGenerationData(prompt.toString(), koboldSettings, responseLengthFor(api), max_context, isHorde, 'quiet');
                }
                TempResponseLength.restore(api);
                break;
            case 'novel': {
                const novelSettings = novelai_settings[novelai_setting_names[nai_settings.preset_settings_novel]];
                generateData = getNovelGenerationData(prompt, novelSettings, responseLengthFor(api), false, false, null, 'quiet');
                TempResponseLength.restore(api);
                break;
            }
            case 'textgenerationwebui':
                generateData = await getTextGenGenerationData(prompt, responseLengthFor(api), false, false, null, 'quiet');
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
    /** @type {number | null} */
    static #length = null;

    static isCustomized() {
        return this.#length !== null;
    }

    /**
     * Asks for this response length.
     * @param {string} _api API identifier
     * @param {number} responseLength New response length
     */
    static save(_api, responseLength) {
        this.#length = responseLength;
    }

    /**
     * Back to the setting's.
     * @param {string|null} [_api] API identifier
     * @returns {void}
     */
    static restore(_api) {
        this.#length = null;
    }

    static get length() {
        return this.#length;
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
async function previewFullPrompt() {
    if (is_send_press) {
        toastr.warning(t`Cannot preview the prompt while a generation is in progress.`);
        return;
    }

    if (getSelectionState().type === 'none') {
        toastr.warning(t`Select a character or group first.`);
        return;
    }

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
 * @param {object[]} messages
 * @param {boolean} isContinue
 * @returns {Promise<number[]>}
 */
export async function doChatInject(messages, isContinue) {
    const injectedMessages = [];
    let totalInsertedMessages = 0;
    messages.reverse();

    const maxDepth = getExtensionPromptMaxDepth();
    for (let i = 0; i <= maxDepth; i++) {
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
 * @param {string} [type]
 */
export function unblockGeneration(type) {
    if (type === 'quiet' && streamingProcessor && !streamingProcessor.isFinished) {
        return;
    }

    is_send_press = false;
    activateSendButtons();
    setGenerationProgress(0);
    flushEphemeralStoppingStrings();
    flushWIInjections();
}

/**
 * Determines if the message should be auto-continued.
 * @param {string} messageChunk Current message chunk
 * @param {boolean} isImpersonate Is the user impersonation
 * @returns {boolean} Whether the message should be auto-continued
 */
export function shouldAutoContinue(messageChunk, isImpersonate) {
    if (!power_user.auto_continue.enabled) {
        return false;
    }

    if (typeof messageChunk !== 'string') {
        return false;
    }

    if (isImpersonate) {
        return false;
    }

    if (is_send_press) {
        return false;
    }

    if (abortController && abortController.signal.aborted) {
        return false;
    }

    if (power_user.auto_continue.target_length <= 0) {
        return false;
    }

    if (main_api === 'openai' && !power_user.auto_continue.allow_chat_completions) {
        return false;
    }

    const textareaText = String($('#send_textarea').val());
    const USABLE_LENGTH = 5;

    if (textareaText.length > 0) {
        return false;
    }

    if (messageChunk.trim().length > USABLE_LENGTH && chat.length) {
        const lastMessage = chat[chat.length - 1];
        // eslint-disable-next-line no-restricted-syntax -- counted on the page from before the ban: to move to the server (thin-client step 10, unfinished)
        const messageLength = getTokenCount(lastMessage.mes);
        const shouldAutoContinue = messageLength < power_user.auto_continue.target_length;

        if (shouldAutoContinue) {
            return true;
        } else {
            return false;
        }
    } else {
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
 *  (src/chat-engine.js) - see Generate()'s own `willUseRawAction` local for the full rationale.
 * @returns {Promise<any>} A promise that resolves to the message when it is inserted.
 */
export async function sendMessageAsUser(messageText, messageBias, insertAt = null, compact = false, name = name1, avatar = user_avatar, skipTreePersistence = false) {
    const message = {
        name: name,
        is_user: true,
        is_system: false,
        send_date: getMessageTimeStamp(),
        mes: substituteParams(messageText),
        persona: avatar,
        extra: {
            isSmallSys: compact,
        },
    };

    // Lock user avatar to a persona.
    if (personaStore.has(avatar)) {
        Object.assign(message, personaAvatar(avatar));
    }

    if (messageBias) {
        message.extra.bias = messageBias;
        message.mes = removeMacros(message.mes);
    }

    await populateFileAttachment(message);
    setStoreRef(message, uuidv4());

    chat_metadata.tainted = true;

    if (typeof insertAt === 'number' && insertAt >= 0 && insertAt <= chat.length) {
        chat.splice(insertAt, 0, message);
        recordSend({ key: storeRefOf(message), kind: 'graft' });
        if (!skipTreePersistence) {
            const nodeId = await chatOpGraft(insertAt, { silent: true }).catch(() => null);
            if (!isStoredNodeId(nodeId)) keepFailedSend({ key: storeRefOf(message), kind: 'graft' });
        }
        await reloadCurrentChat();
    } else {
        chat.push(message);
        const chat_id = (chat.length - 1);
        recordSend({ key: storeRefOf(message), kind: 'append' });

        addOneMessage(message);

        if (!skipTreePersistence) {
            const nodeIds = await chatOpAppend(chat_id, undefined, { silent: true }).catch(() => []);
            if (!isStoredNodeId(nodeIds[0])) keepFailedSend({ key: storeRefOf(message), kind: 'append' });
        }
    }

    return message;
}

/**
 * @param {number} index
 * @param {object} [options]
 * @param {boolean} [options.graft]
 */
export async function storeSentMessage(index, { graft = false } = {}) {
    const message = chat[index];
    if (!message) return;
    if (storeRefOf(message) === undefined) setStoreRef(message, uuidv4());
    const key = storeRefOf(message);
    const kind = graft ? 'graft' : 'append';
    recordSend({ key, kind });
    const nodeId = graft
        ? await chatOpGraft(index, { silent: true }).catch(() => null)
        : (await chatOpAppend(index, undefined, { silent: true }).catch(() => []))[0];
    if (!isStoredNodeId(nodeId)) keepFailedSend({ key, kind });
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
    return responseLengthFor(main_api);
}

/**
 * @param {string} api
 * @returns {number}
 */
export function responseLengthFor(api) {
    if (TempResponseLength.length !== null) return TempResponseLength.length;
    if (api == 'kobold' || api == 'koboldhorde' || api == 'textgenerationwebui' || api == 'novel') {
        return amount_gen;
    }
    if (api == 'openai') {
        return oai_settings.openai_max_tokens;
    }
    return 0;
}

export function requestedResponseLength() {
    return TempResponseLength.length ?? undefined;
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
    await getCharacters({ silent: true, skipPrint: true });
    charactersStore.reportCreated(data.path);
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
 * @param {object} initialData
 * @param {object} rawAction
 * @returns {Promise<object>}
 * @throws {Error}
 */
export async function resolveClientToolHandoffLoop(initialData, rawAction) {
    let data = initialData;

    for (let round = 0; round < ToolManager.RECURSE_LIMIT && Array.isArray(data?.pending_tool_calls) && data.pending_tool_calls.length; round++) {
        const pending = data.pending_tool_calls;
        const nodeId = pending[0]?.node_id;

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

        const tool_results = pending.map(call => {
            const invocation = invocationsById.get(call.tool_call_id);
            return {
                id: call.tool_call_id,
                result: invocation ? (typeof invocation.result === 'string' ? invocation.result : String(invocation.result)) : 'This tool call could not be resolved on the client (no invocation result was produced).',
                error: invocation ? !!invocation.error : true,
            };
        });

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
        return await sendOpenAIRequest(type, data.prompt, abortController.signal, { ...options, rawAction: data.rawAction });
    }

    if (main_api === 'koboldhorde') {
        if (data.owner_id) {
            return await generateHordeRawAction(data, abortController.signal, true);
        }
        return await generateHorde(data.prompt, data, abortController.signal, true);
    }

    const generationId = main_api === 'textgenerationwebui' ? beginServerGeneration('/api/backends/text-completions') : null;
    try {
        const response = await fetch(getGenerateUrl(main_api), {
            method: 'POST',
            headers: { ...getRequestHeaders(), ...(generationId ? { 'X-Generation-Id': generationId } : {}) },
            cache: 'no-cache',
            body: JSON.stringify(data),
            signal: abortController.signal,
        });

        reportStoredHeader(response);
        if (!response.ok) {
            const error = await response.json();
            adoptStored(error?.stored);
            throw error;
        }

        const answer = await response.json();
        adoptStored(answer?.stored);
        return answer;
    } catch (error) {
        if (generationId) takeInStoppedReply(generationId);
        throw error;
    } finally {
        if (generationId) endServerGeneration(generationId);
    }
}

/**
 * @param {string} generationId
 */
export function takeInStoppedReply(generationId) {
    takeStopResult(generationId)?.then(stop => {
        if (stop && isStoredNodeId(stop.node_id)) void reloadCurrentChat();
    });
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
function getGenerateUrl(api) {
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
 * @property {string?} [reasoningSignature] Encrypted signature of the reasoning text
 * @property {{mes: string, extra?: Record<string, any>}|null} [storedReply] The reply as the server stored it (its
 * reasoning split off), shown in place of the text and reasoning given here.
 * @property {string|null} [storedNodeId] The node the server stored the reply at: the message takes it before its
 * events are emitted.
 *
 * @typedef {object} SaveReplyResult
 * @property {string} type Type of generation
 * @property {string} getMessage Generated message
 */
export async function saveReply({ type, getMessage, fromStreaming = false, title = '', swipes = [], reasoning = '', reasoningSignature = null, storedReply = null, storedNodeId = null }) {
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

    if (!reasoning) {
        reasoning = '';
    }

    const generationFinished = new Date();
    if (type === 'swipe') {
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
                api: getGeneratingApi(), model: getGeneratingModel(),
                reasoning, reasoning_duration: null, reasoning_signature: reasoningSignature,
            };
            updateMessage(lastMesId, {
                title, mes: getMessage,
                gen_started: generation_started, gen_finished: generationFinished,
                send_date: getMessageTimeStamp(), extra: newExtra,
            });
            lastMessage = chat[lastMesId];
            const chat_id = lastMesId;
            if (storedNodeId !== null) stampReplyNode(chat_id, storedNodeId);
            applyStoredReply(chat_id, storedReply, { received: !fromStreaming });
            if (storedNodeId !== null) markStoredAs(storedNodeId, chat[chat_id]);
            !fromStreaming && await eventSource.emit(event_types.MESSAGE_RECEIVED, chat_id, type);
            addOneMessage(chat[chat_id], { type: 'swipe' });
            !fromStreaming && await eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, chat_id, type);
        } else {
            updateMessage(lastMesId, { mes: getMessage });
            lastMessage = chat[lastMesId];
        }
    } else if (type === 'append' || type === 'continue') {
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
        const chat_id = lastMesId;
        if (storedNodeId !== null) stampReplyNode(chat_id, storedNodeId);
        applyStoredReply(chat_id, storedReply, { received: !fromStreaming });
        if (storedNodeId !== null) markStoredAs(storedNodeId, chat[chat_id]);
        !fromStreaming && await eventSource.emit(event_types.MESSAGE_RECEIVED, chat_id, type);
        addOneMessage(chat[chat_id], { type: 'swipe' });
        !fromStreaming && await eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, chat_id, type);
    } else if (type === 'appendFinal') {
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
        const chat_id = lastMesId;
        if (storedNodeId !== null) stampReplyNode(chat_id, storedNodeId);
        applyStoredReply(chat_id, storedReply, { received: !fromStreaming });
        if (storedNodeId !== null) markStoredAs(storedNodeId, chat[chat_id]);
        !fromStreaming && await eventSource.emit(event_types.MESSAGE_RECEIVED, chat_id, type);
        addOneMessage(chat[chat_id], { type: 'swipe' });
        !fromStreaming && await eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, chat_id, type);
    } else {
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

        if (selected_group) {
            Object.assign(newMessage, characterAvatar(getCurrentCharacter()));
            newMessage.original_avatar = getCurrentCharacter().avatar;
            newMessage.extra.gen_id = group_generation_id;
        }

        const chat_id = (chat.length - 1);
        if (storedNodeId !== null) stampReplyNode(chat_id, storedNodeId);
        applyStoredReply(chat_id, storedReply, { received: !fromStreaming });
        if (storedNodeId !== null) markStoredAs(storedNodeId, chat[chat_id]);

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

    const hasHoles = !!message.node_id || (Array.isArray(message.swipe_info) && message.swipe_info.some(info => isStoredNodeId(info?.node_id)));

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
            const wasClean = isAsStored(message);
            updateMessage(mesId, updates);
            if (wasClean && chat[mesId]?.node_id) {
                markStoredAs(chat[mesId].node_id, chat[mesId]);
            }
        } else if (!Object.isFrozen(message)) {
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

const ALTERNATIVE_FETCH_WINDOW = 25;

/**
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

    const wasClean = isAsStored(message);

    if (!message.node_id) {
        return false;
    }

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

    const current = chat[mesId];
    if (!current || current.node_id !== message.node_id || !Array.isArray(current.swipes)) {
        return false;
    }

    const swipes = [...current.swipes];
    const swipeInfo = Array.isArray(current.swipe_info) ? [...current.swipe_info] : new Array(swipes.length).fill(null);
    const from = (isOpening ? payload.offset : undefined) ?? body.offset ?? 0;

    payload.alternatives.forEach((alt, i) => {
        const at = from + i;
        if (at >= swipes.length) return;
        if (typeof swipes[at] === 'string') return;
        swipes[at] = alt.mes ?? '';
        swipeInfo[at] = {
            send_date: alt.send_date,
            extra: alt.extra ?? {},
            name: alt.name,
            is_user: alt.is_user,
            node_id: alt.node_id ?? (isOpening ? provisionalNodeId(alt.name ?? character.name ?? message.name, alt.mes ?? '') : undefined),
        };
    });

    updateMessage(mesId, { swipes, swipe_info: swipeInfo });

    if (wasClean && chat[mesId]?.node_id) {
        markStoredAs(chat[mesId].node_id, chat[mesId]);
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
function syncSwipeToMes(messageId = null, swipeId = null, targetMessage = null) {
    if (!targetMessage && !chat.length) {
        return false;
    }

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
    setCharacterId(undefined);
    // sets up system user to tell user about having deleted a character
    chat.splice(0, chat.length, ...SAFETY_CHAT);
    // resets chat metadata
    setChatMetadata({});
    _resetMetadataSaveSnapshot();
    chatClosed();
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
    if (online_status !== 'no_connection') void modelIconSvg(getGeneratingApi());
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
 * Turns the character's name at the top of its info into a text box: Enter, or leaving it, renames the character
 * (renameCharacter()); Escape leaves the name as it was.
 */
function beginInlineCharacterRename() {
    if (getSelectionState().type !== 'character' || blockWhileFieldEditing()) return;
    const heading = $('#rm_button_selected_ch h2');
    if (heading.find('input').length) return;
    const current = getCurrentCharacter().name;
    const input = $('<input type="text" class="text_pole character_rename_input" autocomplete="off">').val(current);
    input.attr('aria-label', t`Character name`);
    heading.empty().append(input);
    input.trigger('focus').trigger('select');
    let done = false;
    const finish = async (/** @type {boolean} */ rename) => {
        if (done) return;
        done = true;
        const value = String(input.val() ?? '').trim();
        heading.text(current);
        if (rename && value && value !== current) await renameCharacter(value);
    };
    input.on('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            void finish(true);
        } else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            void finish(false);
        }
    });
    input.on('blur', () => void finish(true));
    input.on('click dblclick mousedown', event => event.stopPropagation());
}

/**
 * Renames the currently selected character, updating relevant references. Its messages in every chat show the new
 * name; with `renameChats: false`, a message sent before the rename keeps the name the character had then. Its
 * sprites need nothing: their folder is named by its avatar, which a rename keeps.
 *
 * If no name is provided, a popup prompts for a new name. If the new name matches the current name,
 * the renaming process is aborted.
 *
 * If the renaming is successful, the character list is reloaded and the renamed character is selected.
 *
 * @param {string?} [name=null] - The new name for the character. If not provided, a popup will prompt for it.
 * @param {object} [options] - Additional options.
 * @param {boolean} [options.silent=false] - If true, suppresses popups and warnings.
 * @param {boolean?} [options.renameChats=null] - False keeps the old name on messages sent before the rename.
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
        return false;
    }

    const renamePastChats = renameChats ?? true;
    const body = JSON.stringify({ avatar_url: oldAvatar, new_name: newValue, rename_past_chats: renamePastChats });
    const response = await fetch('/api/characters/rename', {
        method: 'POST',
        headers: getRequestHeaders(),
        body,
    });

    try {
        if (response.ok) {
            const data = await response.json();
            const newAvatar = data.avatar;

            const oldName = getCharaFilename(oldAvatar);
            const newName = getCharaFilename(newAvatar);


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

            // Unload current character
            setCharacterId(undefined);
            // Reload characters list
            await getCharacters({ silent: true, skipPrint: true });
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

                if (renamePastChats) {
                    await reloadCurrentChat();
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

        const dlg = new Popup('Set the crop position of the avatar image', POPUP_TYPE.CROP, '', { cropImage: fileData });
        const croppedImage = await dlg.show();
        if (!croppedImage) {
            return;
        }
        crop_data = dlg.cropData;
        $('#avatar_load_preview').attr('src', String(croppedImage));

        if (menu_type == 'create') {
            return;
        }

        const avatarKey = getEditorCharacterAvatar();
        const before = characterThumbnail(avatarKey);
        if (!await saveCharacterAvatar(avatarKey, file)) {
            return;
        }
        await fetch(`/characters/${avatarKey}`, { method: 'GET', cache: 'reload' });
        replaceShownImage(before, characterThumbnail(avatarKey));
    }
}

/**
 * @param {string} before
 * @param {string} after
 */
export function replaceShownImage(before, after) {
    if (before === after) return;
    for (const img of document.querySelectorAll('img')) {
        if (img.getAttribute('src') === before) img.setAttribute('src', after);
    }
}

/**
 * @param {string | { avatar?: string, thumbnail?: string | null, thumbnail_still?: string | null } | undefined | null} character
 * @returns {{ thumbnail: string, thumbnail_still: string | undefined }}
 */
function characterThumbnails(character) {
    const avatar = typeof character === 'string' ? character : character?.avatar;
    if (!avatar || avatar === 'none') return { thumbnail: default_avatar, thumbnail_still: undefined };
    const own = typeof character === 'object' && character?.thumbnail ? character : charactersStore.get(avatar);
    return { thumbnail: own?.thumbnail ?? default_avatar, thumbnail_still: own?.thumbnail ? own?.thumbnail_still ?? undefined : undefined };
}

/**
 * @param {string | { avatar?: string, thumbnail?: string | null, thumbnail_still?: string | null } | undefined | null} character
 * @returns {string}
 */
export function characterThumbnail(character) {
    const { thumbnail, thumbnail_still } = characterThumbnails(character);
    return shownThumbnail(thumbnail, thumbnail_still) ?? default_avatar;
}

/**
 * @param {string | { avatar?: string, avatar_ref?: string, thumbnail?: string | null, thumbnail_still?: string | null } | undefined | null} character
 * @returns {{ force_avatar: string, force_avatar_url: string | undefined, force_avatar_url_still?: string }}
 */
export function characterAvatar(character) {
    const avatar = typeof character === 'string' ? character : character?.avatar;
    const own = typeof character === 'object' ? character?.avatar_ref : undefined;
    const ref = own ?? (avatar && avatar !== 'none' ? charactersStore.get(avatar)?.avatar_ref : undefined);
    if (!ref) return { force_avatar: default_avatar, force_avatar_url: undefined };
    const { thumbnail, thumbnail_still } = characterThumbnails(character);
    return { force_avatar: ref, force_avatar_url: thumbnail, ...(thumbnail_still ? { force_avatar_url_still: thumbnail_still } : {}) };
}

/**
 * @param {{ force_avatar?: string, force_avatar_url?: string, force_avatar_url_still?: string }} mes
 * @returns {string | undefined}
 */
function shownAvatar(mes) {
    return typeof mes?.force_avatar_url === 'string' ? shownThumbnail(mes.force_avatar_url, mes.force_avatar_url_still) ?? undefined : mes?.force_avatar;
}

/**
 * @param {string} macroName
 * @param {{ avatar?: string, name?: string }} character
 * @returns {import('./scripts/macro-pill.js').MacroPerson | null}
 */
export function macroPerson(macroName, { avatar, name } = {}) {
    const which = macroName.toLowerCase();
    if (which === 'user') {
        return { name: name1, avatarUrl: personaThumbnail(user_avatar), about: getPersonaDescription() };
    }
    if (which !== 'char' && which !== 'charifnotgroup') return null;
    const found = (avatar ? charactersStore.get(avatar) : undefined)
        ?? (name ? characters.find(c => c?.name === name) : undefined)
        ?? getCurrentCharacter();
    if (!found) return null;
    return { name: name || found.name, avatarUrl: characterThumbnail(found), about: String(found.data?.creator_notes ?? found.creatorcomment ?? '') };
}

export function buildAvatarList(block, entities, { templateId = 'inline_avatar_template', empty = true, interactable = false, highlightFavs = true } = {}) {
    if (empty) {
        block.empty();
    }

    for (const entity of entities) {
        const id = entity.id;

        // Populate the template
        const avatarTemplate = $(`#${templateId} .avatar`).clone();

        const this_avatar = characterThumbnail(entity.item);

        avatarTemplate.attr('data-type', entity.type);
        if (entity.type === 'character') {
            avatarTemplate.attr('data-avatar', entity.item.avatar);
        }
        avatarTemplate.find('img').attr('src', this_avatar).attr('loading', 'lazy').attr('alt', entity.item.name);
        avatarTemplate.attr('title', `${entity.item.name}\nFile: ${entity.item.avatar}`);
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
            avatarTemplate.attr('title', entity.item.name);
        } else if (entity.type === 'persona') {
            avatarTemplate.attr({ 'data-pid': id });
            avatarTemplate.find('img').attr('src', personaThumbnail(entity.item.avatar));
            avatarTemplate.attr('title', `${entity.item.name}\nFile: ${entity.item.avatar}`);
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
 * @typedef {object} ChatOpenAnswer
 * @property {string} chat
 * @property {ChatMetadata} chat_metadata
 * @property {ChatMessage[]} messages
 * @property {import('./scripts/chat-store.js').OpeningsResponse|null} openings
 * @property {import('./scripts/chat-store.js').OpeningsResponse|null} card_openings
 * @property {string[]} [chats]
 * @property {number} [date_last_chat]
 * @property {Group} [group] The whole group, when the open asked `with_group`.
 * @property {Character} [character] The whole card, when the open asked `with_character`.
 * @property {Record<string, unknown>} [parts]
 * @property {string|null} active_character
 * @property {string|null} active_group
 * @property {number} [settings_hash]
 * @property {string[]} [stored_sends]
 * @property {{ key: string, version: number, value: unknown }[]} [ui_views]
 */

/**
 * @param {{ avatar_url?: string, group_id?: string, chat?: string|null, make_current?: boolean, fresh?: boolean, with_group?: boolean, with_character?: boolean }} body
 * @returns {Promise<ChatOpenAnswer>}
 */
export async function requestChatOpen(body) {
    const response = await fetch('/api/chats/open', {
        method: 'POST',
        headers: getRequestHeaders(),
        cache: 'no-cache',
        body: JSON.stringify({ ...body, ...chatOpenAsk(body) }),
    });
    if (!response.ok) throw Object.assign(new Error(`/api/chats/open responded ${response.status}`), { status: response.status });
    return takeChatOpenAnswer(body, await response.json());
}

/**
 * @param {{ avatar_url?: string, group_id?: string }} body
 * @returns {{ type: 'character'|'group', id: string }}
 */
function chatOpenOwner(body) {
    return body.group_id ? { type: 'group', id: body.group_id } : { type: 'character', id: String(body.avatar_url) };
}

/**
 * @param {{ avatar_url?: string, group_id?: string }} body
 * @returns {{ send_keys: string[], parts: Record<string, unknown> }}
 */
export function chatOpenAsk(body) {
    const owner = chatOpenOwner(body);
    return { send_keys: keptSendKeys(owner), parts: chatOpenAsks(owner) };
}

/**
 * @param {{ avatar_url?: string, group_id?: string }} body
 * @param {ChatOpenAnswer} answer
 * @returns {ChatOpenAnswer}
 */
export function takeChatOpenAnswer(body, answer) {
    if (answer.group) holdGroup(answer.group);
    takeChatOpenParts(answer.chat, answer.parts);
    takeViews(answer.ui_views);
    forgetStoredSends(chatOpenOwner(body), Array.isArray(answer.stored_sends) ? answer.stored_sends : []);
    setActiveCharacter(answer.active_character);
    setActiveGroup(answer.active_group);
    seedKeyHashes(serverKeyHashes, answer.active_character, 'active_character');
    seedKeyHashes(serverKeyHashes, answer.active_group, 'active_group');
    if (answer.settings_hash != null) knownServerSettingsHash = answer.settings_hash;
    return answer;
}

/**
 * @param {Record<string, unknown>} values
 * @param {number} [settingsHash]
 */
export function takeServerSettings(values, settingsHash) {
    for (const [key, value] of Object.entries(values)) seedSettingsHashes(value, key);
    if (settingsHash != null) knownServerSettingsHash = settingsHash;
}

/**
 * @param {{ chat?: string|null, makeCurrent?: boolean, fresh?: boolean, opened?: ChatOpenAnswer|null }} [options]
 */
async function openCharacterConversation({ chat: requested = null, makeCurrent = false, fresh = false, opened = null } = {}) {
    /** @type {ChatOpenAnswer|null} */
    let answer = opened;
    try {
        answer ??= await requestChatOpen({ avatar_url: getCurrentCharacter().avatar, chat: requested, make_current: makeCurrent, fresh });
    } catch (error) {
        console.error('Could not open the chat:', error);
        toastr.error(t`The chat could not be opened. Check the server connection and try again.`, t`Chat not opened`);
        await getChatResult();
        return;
    }

    setChatMetadata(answer.chat_metadata ?? {});
    _setCurrentTarget(answer.chat, chat_metadata.integrity ?? null);
    _resetMetadataSaveSnapshot();
    chat.splice(0, chat.length, ...answer.messages);
    chat.forEach(ensureMessageMediaIsArray);
    _snapshotMessages();
    const openings = { openings: answer.openings, card_openings: answer.card_openings };
    if (chat.length) await _mergeCardGreetingsIntoOpening({ openings });
    await getChatResult({ openings });

    _snapshotMessages();

    eventSource.emit(event_types.CHAT_LOADED, { detail: { character: getCurrentCharacter() } });

    delay(debounce_timeout.short).then(() => {
        if (getMountedTextarea(document.activeElement) || $(document.activeElement).is('input:visible, textarea:visible')) {
            return;
        }
        $('#send_textarea').trigger('click').trigger('focus');
    });
}

/**
 * @returns {Promise<boolean>}
 */
/**
 * @param {{ openings?: import('./scripts/chat-store.js').OpeningsResponse|null }} [options]
 */
async function pushFirstMessageIntoEmptyChat({ openings = null } = {}) {
    if (chat.length !== 0) {
        return false;
    }
    let pushed = false;
    const message = await getFirstMessage({ openings });
    if (message.mes) {
        chat.push(message);
        pushed = true;
    }

    if (message?.node_id) {
        _snapshotMessages();
    }
    return pushed;
}

/**
 * @param {{ openings?: { openings: import('./scripts/chat-store.js').OpeningsResponse|null } }} [options]
 */
async function getChatResult({ openings = undefined } = {}) {
    name2 = getCurrentCharacter().name;
    await pushFirstMessageIntoEmptyChat({ openings: openings?.openings ?? null });
    await printMessages();
    select_selected_character(getCurrentCharacter()?.avatar);

    await eventSource.emit(event_types.CHAT_CHANGED, (getCurrentChatId()));

    if (chat.length === 1) {
        const chat_id = (chat.length - 1);
        await eventSource.emit(event_types.MESSAGE_RECEIVED, chat_id, 'first_message');
        await eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, chat_id, 'first_message');
    }
}

/**
 * @param {{ openings?: import('./scripts/chat-store.js').OpeningsResponse|null }} [options]
 */
async function getFirstMessage({ openings = null } = {}) {
    const character = getCurrentCharacter();
    const { greetings, defaultIndex } = cardToGreetingsModel(character);
    const swipeId = defaultIndex ?? 0;

    const fromTree = await _openingFromTree(greetings, swipeId, openings);
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

/**
 * @param {string[]} cardGreetings
 * @param {number} preferredIndex
 * @param {import('./scripts/chat-store.js').OpeningsResponse|null} [prefetched]
 */
async function _openingFromTree(cardGreetings, preferredIndex, prefetched = null) {
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

    const contents = (cardGreetings ?? [])
        .filter(text => typeof text === 'string' && text.length > 0)
        .map(asMessage);

    const openings = prefetched ?? await post('/api/chats/openings', {});
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

    const chosen = openings.alternatives[chosenOffset]
        ?? (preferredText !== undefined ? { node_id: null, mes: preferredText, name: speaker, is_user: false, send_date: sendDate, extra: {} } : null);
    if (!chosen) return null;

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
        const swipes = new Array(openings.total).fill(null);
        const swipeInfo = new Array(openings.total).fill(null);
        openings.alternatives.forEach((alt, k) => {
            const at = windowStart + k;
            if (at >= openings.total) return;
            swipes[at] = alt.mes;
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
 * @param {string} avatar
 * @param {string} chat
 * @returns {Promise<{ chat: string } | false>}
 */
async function saveActiveChat(avatar, chat) {
    try {
        const response = await fetch('/api/characters/chat', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ avatar, chat }),
        });
        if (!response.ok) throw new Error(String(response.status));
        /** @type {{ chat: string }} */
        const answer = await response.json();
        return answer;
    } catch (error) {
        console.error('Failed to save active chat', error);
        toastr.error(t`Failed to save active chat.`);
        return false;
    }
}

/**
 * @param {string} file_name
 * @param {{ opened?: ChatOpenAnswer|null }} [options]
 */
export async function openCharacterChat(file_name, { opened = null } = {}) {
    await clearChat({ clearData: true });
    setChatMetadata({});
    _resetMetadataSaveSnapshot();
    await openCharacterConversation({ chat: file_name, makeCurrent: true, opened });
}

////////// OPTIMZED MAIN API CHANGE FUNCTION ////////////

function changeMainAPI(api = null) {
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

/** @type {{data: any}|null} */
let rawSettingsCache = null;
/** @type {Promise<any>|null} */
let rawSettingsFetchPromise = null;

/**
 * @param {object} [options]
 * @param {boolean} [options.force=false]
 * @returns {Promise<any>}
 */
function fetchRawSettings({ force = false } = {}) {
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
async function getSettings(initLoaderHandle = null, onStageChange = null, { force = false } = {}) {
    let data;
    try {
        data = await fetchRawSettings({ force });
        startLibraryChangesAt(Number(data?.libraryChangesSeq));
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

        if (!newUiStarted()) {
            setAmountGen(settings.amount_gen);
            if (settings.max_context !== undefined)
                setMaxContext(parseInt(settings.max_context));
        }

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
        await loadTagsFromServer();

        // Load proxy presets
        loadProxyPresets(settings);

        // Allow subscribers to mutate settings

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

        initMacros();

        Object.assign(extension_settings, settings.extension_settings ?? {});

        firstRun = !!settings.firstRun;

        if (firstRun) {
            await initLoaderHandle?.hide();
            await doOnboarding(user_avatar);
            firstRun = false;
            saveSettingsDebounced('firstRun');
            onboarded = true;
        }
    }

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
 * @param {...string} keys The settings that changed; none makes it a full save.
 */
export async function saveSettings(...keys) {
    const save = noteSettingsKeys(keys);
    if (!save.full && !_settingsSaveWindow.full) {
        cancelDebounce(_debouncedSaveImpl);
        _settingsSaveWindow = { full: false };
    }
    return runSettingsSave(save);
}

/**
 * @param {string[]} keys
 * @returns {{ full: boolean }}
 */
function noteSettingsKeys(keys) {
    for (const key of keys) pendingSettingsKeys.add(key);
    return { full: keys.length === 0 };
}

/**
 * @param {{ full: boolean }} save
 */
async function runSettingsSave({ full }) {
    if (!settingsReady) {
        console.warn('Settings not ready, scheduling another save');
        scheduleSettingsSave({ full });
        return;
    }

    const run = () => performSave({ full });
    const queued = _saveQueue.then(run, run);
    _saveQueue = queued.catch(() => {});
    return queued;
}

/**
 * @param {{ full: boolean }} save
 */
async function performSave({ full }) {
    const dirtyKeys = full ? null : [...pendingSettingsKeys];
    pendingSettingsKeys.clear();
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
        proxies: proxies,
        selected_proxy: selected_proxy,
    };

    const payloadString = JSON.stringify(payload);
    const payloadHash = getStringHash(payloadString);

    if (dirtyKeys) {
        const partialPayload = {};
        for (const key of dirtyKeys) {
            if (key.includes('.')) {
                const topLevel = key.split('.')[0];
                if (topLevel in payload) {
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

            const partialSaveResponse = await result.json().catch(() => ({}));
            if (!takeServerKeyHashes(partialSaveResponse.keyHashes, Object.keys(partialPayload).map(key => key.split('.')[0]))) {
                for (const key of Object.keys(partialPayload)) {
                    seedSettingsHashes(partialPayload[key], key);
                }
            }
            if (partialSaveResponse.settingsHash != null) {
                knownServerSettingsHash = partialSaveResponse.settingsHash;
            }
            await eventSource.emit(event_types.SETTINGS_UPDATED);
        } catch (error) {
            console.error('Error saving settings:', error);
            toastr.error(t`Check the server connection and reload the page to prevent data loss.`, t`Settings could not be saved`);
        }
    } else {
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

            lastSavedSettingsHash = payloadHash;
            const saveResponse = await result.json().catch(() => ({}));
            if (!takeServerKeyHashes(saveResponse.keyHashes, null)) seedSettingsHashes(payload);
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

/**
 * Sets the response length and context size from a preset or a model's limits (upstream's; extensions call it).
 * They're the server's: the context is fitted to the size (unlocked past the locked limit) and the length set;
 * resolves once the server has them.
 * @param {{ genamt?: number, max_length?: number }} preset Preset object
 * @returns {Promise<void>}
 */
export function setGenerationParamsFromPreset(preset) {
    return (async () => {
        if (preset.max_length !== undefined) await newUi().settings.fitContext(Number(preset.max_length));
        if (preset.genamt !== undefined) await newUi().settings.setValue('amount_gen', Number(preset.genamt));
    })();
}

/**
 * @param {import('/ui/entry.js').NewUi['settings']} settings
 */
function bindSharedSettings(settings) {
    settings.bind(power_user, 'power_user');
    settings.bind(kai_settings, 'kai_settings');
    settings.bind(nai_settings, 'nai_settings');
    settings.mirror('amount_gen', value => setAmountGen(Number(value)));
    settings.mirror('max_context', value => setMaxContext(Number(value)));
    settings.watch(['power_user.max_context_unlocked'], () => switchMaxContextSize());
}

// Common code for message editor done and auto-save
function applyMessageEdit(div) {
    const mesBlock = div.closest('.mes_block');
    let text = mesBlock.find('.edit_textarea').val()
        ?? mesBlock.find('.mes_text').text();
    const mesElement = div.closest('.mes');
    const mesId = Number(mesElement.attr('mesid'));
    let mes = chat[mesId];

    if (!mes.extra || typeof mes.extra !== 'object') {
        updateMessage(mesId, { extra: {} });
        mes = chat[mesId];
    }

    const cardGreeting = cardGreetingOfEditedOpening(mesId, mes, String(text));
    if (cardGreeting !== null) {
        return finishMessageEdit(mesBlock, mesId, mes, cardGreeting, '');
    }

    if (power_user.trim_spaces) {
        text = text.trim();
    }

    const keepsMacros = mesId === 0 && !mes.is_user && !mes.is_system;
    const bias = substituteParams(extractMessageBias(text));
    if (!keepsMacros) {
        text = substituteParams(text);
        if (bias) {
            text = removeMacros(text);
        }
    }

    return finishMessageEdit(mesBlock, mesId, mes, text, bias);
}

/**
 * @param {number} mesId
 * @param {ChatMessage} mes
 * @param {string} text
 * @returns {string|null}
 */
function cardGreetingOfEditedOpening(mesId, mes, text) {
    if (mesId !== 0 || mes.is_user || mes.is_system || (selected_group != null && selected_group !== '')) return null;
    const character = getCurrentCharacter();
    if (!character) return null;
    const same = power_user.trim_spaces
        ? (/** @type {string} */ greeting) => greeting.trim() === text.trim()
        : (/** @type {string} */ greeting) => greeting === text;
    const greeting = cardToGreetingsModel(character).greetings.find(g => typeof g === 'string' && g !== '' && same(g));
    return greeting ?? null;
}

/**
 * @param {JQuery<HTMLElement>} mesBlock
 * @param {number} mesId
 * @param {ChatMessage} mes
 * @param {string} text
 * @param {string} bias
 */
function finishMessageEdit(mesBlock, mesId, mes, text, bias) {
    const editUpdates = { mes: text };
    if (mes.swipe_id !== undefined) {
        ensureSwipes(mes, mesId);
        const newSwipes = [...mes.swipes];
        newSwipes[mes.swipe_id] = text;
        editUpdates.swipes = newSwipes;
    }

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

const messageEditAutoSaveDebounced = debounce((mesId) => {
    if (isComposedSlot(chat[mesId])) return;
    chatOpEdit(mesId).catch(error =>
        console.error('Could not save the edited message:', error));
}, DEFAULT_SAVE_EDIT_TIMEOUT);

/**
 * @param {File} file
 * @returns {Promise<string>}
 */
async function uploadEditorImage(file) {
    const extension = /\.[a-z0-9]+$/i.exec(file.name)?.[0] ?? '';
    const response = await fetch('/api/files/upload', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ name: `${Date.now()}_${getStringHash(file.name)}${extension}`, data: (await getBase64Async(file)).split(',')[1] }),
    });
    if (!response.ok) throw new Error(await response.text());
    return (await response.json()).path;
}

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

    if (isReplyGenerating(editMessageId)) {
        toastr.info(t`This message is still being generated. Edit it once it is done.`, t`Not editable yet`, { preventDuplicates: true });
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

    void mountChatEditor(editTextArea, {
        name: this_edit_mes_chname,
        isSystem: Boolean(editMessage.is_system),
        isUser: Boolean(editMessage.is_user),
        messageId: editMessageId,
    });

    if (Number(this_edit_mes_id) === chat.length - 1) {
        chatElement.scrollTop(chatScrollPosition);
    }

    updateEditArrowClasses();
}

/**
 * @param {number} mesId
 * @returns {Promise<boolean>}
 */
async function leaveComposedSlot(mesId) {
    const message = chat[mesId];
    if (!isComposedSlot(message) || message.swipes.length < 2) return false;
    const at = message.swipe_id ?? 0;
    const back = Math.max(0, at - 1);
    const swipes = message.swipes.filter((_, i) => i !== at);
    const swipeInfo = Array.isArray(message.swipe_info) ? message.swipe_info.filter((_, i) => i !== at) : undefined;
    updateMessage(mesId, { swipes, ...(swipeInfo ? { swipe_info: swipeInfo } : {}), swipe_id: back });
    syncSwipeToMes(mesId, back);
    await switchToAlternativePath(mesId, back);
    return true;
}

/**
 * Close the open message editor.
 * This deletes the user's unsaved changes.
 * @param {number} [messageId=this_edit_mes_id]
 */
async function messageEditCancel(messageId = this_edit_mes_id) {
    await leaveComposedSlot(messageId);

    let text = chat[messageId].mes;
    let thisMesDiv;
    // If this is the button then select it's parent. Otherwise, select by messageId.
    if (this?.classList?.contains('mes_edit_cancel')) {
        thisMesDiv = $(this).closest('.mes');
    } else {
        thisMesDiv = chatElement.children('.mes').filter(`[mesid="${messageId}"]`);
    }

    const thisMesBlock = thisMesDiv.find('.mes_block');
    unmountChatEditor(thisMesBlock.find('#curEditTextarea')[0]);
    thisMesBlock.find('.mes_text').empty();
    thisMesDiv.find('.mes_edit_buttons').css('display', 'none');
    thisMesBlock.find('.mes_buttons').css('display', '');
    thisMesBlock.find('.mes_text')
        .append(chatMessageHtml(chat[messageId], text, shown => messageFormatting(
            shown,
            this_edit_mes_chname,
            chat[messageId].is_system,
            chat[messageId].is_user,
            messageId,
            {},
            false,
        )));
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

async function messageEditDone(div) {
    if (!(this_edit_mes_id >= 0)) {
        console.trace('this_edit_mes_id cannot be blank when calling messageEditDone.');
        return;
    }

    if (isReplyGenerating(Number(this_edit_mes_id))) {
        toastr.warning(t`This message is still being generated, so the edit wasn't saved. Press Done again once it is.`, t`Not saved yet`, { preventDuplicates: true });
        return;
    }

    const composed = isComposedSlot(chat[this_edit_mes_id]);
    let { mesBlock, text, mes, bias } = applyMessageEdit(div);
    if (composed && !String(chat[this_edit_mes_id]?.mes ?? '').length) {
        await messageEditCancel(this_edit_mes_id);
        return;
    }

    await eventSource.emit(event_types.MESSAGE_EDITED, this_edit_mes_id);
    text = chat[this_edit_mes_id]?.mes ?? text;
    unmountChatEditor(mesBlock.find('#curEditTextarea')[0]);
    mesBlock.find('.mes_text').empty();
    mesBlock.find('.mes_edit_buttons').css('display', 'none');
    mesBlock.find('.mes_buttons').css('display', '');
    mesBlock.find('.mes_text').append(
        chatMessageHtml(mes, text, shown => messageFormatting(
            shown,
            this_edit_mes_chname,
            mes.is_system,
            mes.is_user,
            this_edit_mes_id,
            {},
            false,
        )),
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
    cancelDebounce(messageEditAutoSaveDebounced);
    try {
        if (composed && isComposedSlot(chat[editedMesId])) {
            if (await chatOpStoreComposed(editedMesId) === null) throw new Error('The new alternative was not stored.');
            refreshSwipeButtons(true);
        } else {
            await chatOpEdit(editedMesId);
        }
    } catch (error) {
        console.error('Could not save the edited message:', error);
        toastr.error(t`Could not save the edited message. Check your connection and try again.`, t`Save failed`);
    }
    showSwipeButtons();
}

/**
 * Fetches the metadata of all past chats related to a specific character based on its avatar URL.
 * The function sends a POST request to the server to retrieve all chats for the character. It then
 * processes the received data, sorts it by the file name, and returns the sorted data.
 *
 * @param {string|null} [avatar=null] - The character's avatar. When null or undefined, the current character.
 *
 * @returns {Promise<Array>} - An array containing metadata of all past chats of the character, sorted
 * in descending order by file name. Returns an empty array if the fetch request is unsuccessful or the
 * response is an object with an `error` property set to `true`.
 */
export async function getPastCharacterChats(avatar = null) {
    const character = charactersStore.get(avatar ?? this_avatar);
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
    const avatarImg = selected_group ? group?.avatar_url : characterThumbnail(getCurrentCharacter());
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

    setTimeout(function () {
        const textSearchElement = $('#select_chat_search');
        textSearchElement.trigger('click').trigger('focus').trigger('select');
    }, 200);

    addChatBackupsBrowser();
}

const CHAT_PICKER_PAGE = 50;
let chatPickerList = 0;

async function displayChats(searchQuery, currentChat, displayName, avatarImg, selected_group, highlightNames) {
    const list = ++chatPickerList;
    const $chatDiv = $('#select_chat_div');
    const $chatTemplate = $('#past_chat_template .select_chat_block_wrapper');
    $chatDiv.empty().off('scroll.chatPicker');
    /** @type {string|null} */
    let cursor = null;
    /** @type {string|null} */
    let scanCursor = null;
    const shown = new Set();
    let reading = false;
    let ended = false;

    const readPage = async () => {
        if (reading || ended) return;
        reading = true;
        const readingChats = cursor !== null;
        try {
            const response = await fetch('/api/chats/search', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({
                    query: searchQuery,
                    avatar_url: selected_group ? null : getCurrentCharacter().avatar,
                    group_id: selected_group || null,
                    limit: CHAT_PICKER_PAGE,
                    ...(cursor ? { cursor } : scanCursor ? { scan_cursor: scanCursor } : {}),
                }),
            });
            if (!response.ok) {
                throw new Error('Search failed');
            }
            const page = await response.json();
            if (list !== chatPickerList) return;
            for (const chat of page.results) {
                if (shown.has(chat.file_name)) continue;
                shown.add(chat.file_name);
                const isSelected = currentChat === chat.file_name;
                const template = $chatTemplate.clone();
                template.find('.select_chat_block').attr('file_name', chat.file_name).attr('chat_label', chat.label ?? '');
                if (chat.node_id) {
                    template.find('.select_chat_block').attr('node_id', chat.node_id);
                }
                template.find('.avatar img').attr('src', avatarImg);
                template.find('.select_chat_block_filename').text(chat.label ?? chat.file_name);
                template.find('.chat_file_size').text(chat.file_size ? `(${chat.file_size},` : '(');
                template.find('.chat_messages_num').text(`${chat.message_count} 💬)`);
                template.find('.select_chat_block_mes').text(chat.preview_message);
                template.find('.PastChat_cross').attr('file_name', chat.file_name);
                template.find('.chat_messages_date').text(chat.last_mes ? timestampToMoment(chat.last_mes).format('lll') : '');

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
            cursor = page.cursor;
            if (!readingChats) scanCursor = page.scan_cursor ?? null;
            ended = !cursor && !scanCursor;
            if (ended && page.exact === false) {
                $chatDiv.append($('<div class="select_chat_incomplete"></div>').text(t`The search stopped before reading every chat; some matches may be missing.`));
            }
        } catch (error) {
            console.error('Error loading chats:', error);
            toastr.error('Could not load chat data. Try reloading the page.');
            ended = true;
        } finally {
            reading = false;
        }
        const div = $chatDiv[0];
        if (!ended && list === chatPickerList && div && div.scrollHeight <= div.clientHeight) await readPage();
    };

    $chatDiv.on('scroll.chatPicker', () => {
        const div = $chatDiv[0];
        if (div.scrollTop + div.clientHeight >= div.scrollHeight - div.clientHeight) void readPage();
    });
    await readPage();
}


const PANEL_OPEN_STATE_KEYS = {
    'right-nav-panel': 'NavOpened',
    'char-info-panel': 'CharInfoNavOpened',
    'left-nav-panel': 'LNavOpened',
    'WorldInfo': 'WINavOpened',
};
let panelOpenStatesRead = false;

/**
 * @returns {Record<string, boolean>}
 */
export function readSavedPanelOpenStates() {
    const states = Object.fromEntries(Object.entries(PANEL_OPEN_STATE_KEYS).map(([id, key]) => [id, accountStorage.getItem(key) === 'true']));
    panelOpenStatesRead = true;
    return states;
}

function onDrawersChanged() {
    drawerStackChanged();
    if (panelOpenStatesRead) {
        for (const [id, key] of Object.entries(PANEL_OPEN_STATE_KEYS)) {
            accountStorage.setItem(key, String(Boolean(document.getElementById(id)?.classList.contains('openDrawer'))));
        }
    }
    onDrawerVisibilityChanged();
}

function onDrawerVisibilityChanged() {
    onCharacterEditorMaybeShown();
    onCharacterListMaybeShown();
}

function onCharacterListMaybeShown() {
    const showing = isCharacterListShowing();
    const becameShown = showing && !characterListWasShowing;
    characterListWasShowing = showing;
    if (!becameShown || characterListShowHandledByCaller) return;
    onCharacterListShown();
}

/**
 * @param {string} contentId
 */
export function frontDrawer(contentId) {
    const content = document.getElementById(contentId);
    if (content) raiseDrawer(content);
    onDrawersChanged();
    autosizeTextareas(document.getElementById(contentId) ?? document);
}

export function restoreDrawerOrder() {
    restoreLayerOrder();
    onDrawersChanged();
}

function closeDrawerContent(content) {
    content.classList.replace('openDrawer', 'closedDrawer');
    onDrawersChanged();
}

/**
 * @param {Element} content
 * @returns {Element|null}
 */
function getDrawerIcon(content) {
    return content.parentElement?.querySelector(':scope > .drawer-toggle .drawer-icon') ?? null;
}

/**
 * @param {Element} content
 * @returns {number}
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
 * @param {Element} content
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
 * @param {string} selectedMenuId
 */
export function selectRightMenuWithAnimation(selectedMenuId) {
    const displayModes = {
        'rm_group_chats_block': 'flex',
        'rm_api_block': 'grid',
        'rm_characters_block': 'flex',
    };
    const normalizedId = selectedMenuId ? selectedMenuId.replace('#', '') : null;
    $('#result_info').toggle(normalizedId === 'rm_ch_create_block');
    const targetMenu = normalizedId ? document.getElementById(normalizedId) : null;
    const targetPanel = targetMenu?.closest('#right-nav-panel, #char-info-panel');
    if (targetPanel) {
        targetPanel.setAttribute('data-active-menu', normalizedId || '');
        drawerStackChanged();
    }
    const charInfoMenus = ['rm_ch_create_block', 'rm_group_chats_block'];
    if (charInfoMenus.includes(normalizedId)) {
        ensureDrawerOpen('charInfoHolder');
    } else if (normalizedId === 'rm_characters_block') {
        ensureDrawerOpen('rightNavHolder');
    }
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
 * @param {string} avatar The character's avatar
 * @param {object} [param1] Options for the switch
 * @param {boolean} [param1.switchMenu=true] Whether to switch the menu
 */
export function select_selected_character(avatar, { switchMenu = true } = {}) {
    const character = charactersStore.get(avatar);
    if (character == null) {
        throw new TypeError(`select_selected_character: no character found for ${JSON.stringify(avatar)}`);
    }
    select_rm_create({ switchMenu, show: false });
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
    $('#avatar_url_pole').val(character.avatar);

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
    $('#avatar_url_pole').val(character.avatar);
    $('#chat_import_avatar_url').val(character.avatar);
    $('#chat_import_character_name').val(character.name);
    $('#character_book_json').val(characterFormValue(character, '#character_book_json'));

    updateFavButtonState(normalizeFav(character.fav));

    const avatarUrl = characterThumbnail(character);
    $('#avatar_load_preview').attr('src', avatarUrl);
    setGreetingsButton(character?.avatar ?? null);
    $('#set_character_world').data('avatar', character?.avatar ?? null);
    setWorldInfoButtonClass(avatar);
    checkEmbeddedWorld(avatar);

    $('#name_div').removeClass('displayBlock');
    $('#name_div').addClass('displayNone');

    $('#form_create').attr('actiontype', 'editcharacter');

    snapshotLoadedCharacterFieldHashes(character);
    $('.form_create_bottom_buttons_block .chat_lorebook_button').show();

    const externalMediaState = isExternalMediaAllowed();
    $('#character_open_media_overrides').toggle(!selected_group);
    $('#creators_note_styles_button').show();
    $('#character_media_allowed_icon').toggle(externalMediaState);
    $('#character_media_forbidden_icon').toggle(!externalMediaState);

    // Update some stuff about the char management dropdown
    $('#char-management-dropdown option').not('[value="default"]').prop('disabled', false);
    $('#character_source').attr('disabled', !getCharacterSource(character) ? '' : null);

    switchMenu && selectRightMenuWithAnimation('rm_ch_create_block');

    eventSource.emit(event_types.CHARACTER_EDITOR_OPENED);
}

/**
 * Selects the right menu for creating a new character.
 * @param {object} [options] Options for the switch
 * @param {boolean} [options.switchMenu=true] Whether to switch the menu
 * @param {boolean} [options.show=true] false: the caller fills the editor and shows it after
 */
function select_rm_create({ switchMenu = true, show = true } = {}) {
    void flushCharacterFieldSaves();
    switchMenu && setMenuType('create');

    //console.log('select_rm_Create() -- selected button: '+selected_button);
    if (selected_button == 'create' && create_save.avatar) {
        const addAvatarInput = /** @type {HTMLInputElement} */ ($('#add_avatar_button').get(0));
        addAvatarInput.files = create_save.avatar;
        read_avatar_load(addAvatarInput);
    }

    switchMenu && show && selectRightMenuWithAnimation('rm_ch_create_block');

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
    $('#character_book_json').val('');
    $('#avatar_div').css('display', 'flex');
    $('#avatar_load_preview').attr('src', default_avatar);
    $('#name_div').removeClass('displayNone');
    $('#name_div').addClass('displayBlock');
    setGreetingsButton(null);
    $('#set_character_world').data('avatar', null);
    updateCharacterWorldButton();
    updateFavButtonState(false);
    checkEmbeddedWorld();

    $('#form_create').attr('actiontype', 'createcharacter');
    _loadedCharacterFieldHashes.clear();
    _loadedCharacterFieldHashesAvatar = null;
    $('.form_create_bottom_buttons_block .chat_lorebook_button').hide();
    $('#character_open_media_overrides').hide();
    $('#creators_note_styles_button').hide();
    $('#char-management-dropdown option').not('[value="default"], #set_character_world').prop('disabled', true);
}

function select_rm_characters() {
    const doFullRefresh = menu_type === 'characters';
    setMenuType('characters');
    characterListShowHandledByCaller = true;
    try {
        selectRightMenuWithAnimation('rm_characters_block');
    } finally {
        characterListShowHandledByCaller = false;
    }
    printCharacters(doFullRefresh);
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

    const result = await callGenericPopup($template, POPUP_TYPE.TEXT, '', {
        wide: true,
        large: true,
        allowVerticalScrolling: true,
    });
    if (result !== POPUP_RESULT.AFFIRMATIVE) return;
    if (pendingChanges.scenario === scenarioOverrideValue && pendingChanges.examples === exampleMessagesValue && pendingChanges.system_prompt === systemPromptValue) return;

    chat_metadata.scenario = pendingChanges.scenario;
    chat_metadata.mes_example = pendingChanges.examples;
    chat_metadata.system_prompt = pendingChanges.system_prompt;
    await saveMetadata();
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
    swipeCounter.attr('data-alternatives', totalNum);

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
function getOverswipeBehavior(messageId, message = undefined) {
    message ??= chat[messageId];

    const isGreeting = messageId === 0;

    //Do not override explicitly set overswipe_behavior.
    if (typeof message?.extra?.overswipe_behavior == 'string') return message.extra.overswipe_behavior;
    //Some messages, like the welcome screen, are not swipeable.
    else if (message?.extra?.swipeable === false) return OVERSWIPE_BEHAVIOR.NONE;
    //Small System messages can't be swiped.
    else if (message?.extra?.isSmallSys) return OVERSWIPE_BEHAVIOR.NONE;
    else if (isGreeting) return OVERSWIPE_BEHAVIOR.EDIT_GENERATE;
    //Non-user and non-prompt hidden messages will regenerate.
    else if (!message?.is_user && !message?.is_system) return OVERSWIPE_BEHAVIOR.REGENERATE;
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
                (overswipe == OVERSWIPE_BEHAVIOR.REGENERATE || overswipe == OVERSWIPE_BEHAVIOR.EDIT_GENERATE);

            div.classList.toggle('last_swipe', isOverswipeable);

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
 * @param {object} [options]
 * @param {boolean} [options.ask=false] A delete the user asked for here: what else it drops (bookmarks, state changes
 * below the swipe) is asked about first, and saying no calls it off. Otherwise that is applied and shown as a warning.
 * @returns {Promise<number>|undefined} - The ID of the new swipe after deletion.
 */
export async function deleteSwipe(swipeId = null, messageId = chat.length - 1, { ask = false } = {}) {
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

    messageId = Number(messageId);
    swipeId = Number(swipeId);

    const isShownSwipe = swipeId === currentSwipeId;
    const deletedNodeId = isShownSwipe ? message.node_id : message.swipe_info?.[swipeId]?.node_id;
    let ticket = null;
    if (isStoredNodeId(deletedNodeId)) {
        ticket = await chatOpReadyAlternativeDelete(deletedNodeId, { ask }).catch(error => {
            console.error('Could not ask the tree about the deleted alternative:', error);
            return undefined;
        });
        if (ticket === null) return;
    }

    if (!isShownSwipe && ticket) {
        const deleted = await chatOpDeleteAlternativeNode(deletedNodeId, message.node_id, ticket, { ask }).catch(error => {
            console.error('Could not remove the deleted alternative from the tree:', error);
            return true;
        });
        if (!deleted) return;
    }
    chat_metadata.tainted = true;

    updateMessage(messageId, { swipe_id: newSwipeId, swipes: newSwipes, swipe_info: newSwipeInfo });

    if (isShownSwipe) {
        const direction = (swipeId <= newSwipeId) ? SWIPE_DIRECTION.RIGHT : SWIPE_DIRECTION.LEFT;
        // Animate swipe and swap displayed message when the currently visible swipe was deleted.
        await swipe(null, direction, { source: SWIPE_SOURCE.DELETE, repeated: false, forceMesId: messageId, forceSwipeId: newSwipeId });
        if (ticket) {
            await chatOpDeleteAlternativeNode(deletedNodeId, chat[messageId]?.node_id, ticket, { ask }).catch(error =>
                console.error('Could not remove the deleted alternative from the tree:', error));
        }
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
        if (data.error) {
            toastr.error(typeof data.message === 'string' ? data.message : t`The chat could not be imported.`, t`Import failed`, { timeOut: 0, extendedTimeOut: 0 });
        }
        if ((data.res || data.fileNames?.length) && refresh) {
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

function updateEditArrowClasses() {
    if (!(this_edit_mes_id >= 0)) {
        return;
    }

    const message = chatElement.children('.mes').filter(`.mes[mesid="${this_edit_mes_id}"]`);

    const copyButton = message.find('.mes_edit_copy');
    const deleteButton = message.find('.mes_edit_delete');

    copyButton.removeClass('disabled');
    deleteButton.removeClass('disabled');
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

async function openCharacterWorldPopup() {
    const avatar = $('#set_character_world').data('avatar');
    if (menu_type != 'create' && avatar === undefined) {
        toastr.error('Does not have an Id for this character in world select menu.');
        return;
    }

    const worldCharacter = charactersStore.get(avatar);

    // TODO: Maybe make this utility function not use the window context?
    const fileName = worldCharacter ? getCharaFilename(avatar) : undefined;
    const charName = (menu_type == 'create' ? create_save.name : worldCharacter?.data?.name) || 'Nameless';
    const worldId = (menu_type == 'create' ? create_save.world : worldCharacter?.data?.extensions?.world) || '';
    const linksEmbeddedBook = menu_type != 'create' && getCharacterWorldLink(worldCharacter) === character_world_link.EMBEDDED;
    const embeddedBookValue = 'embedded';
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

const GREETING_DEFAULT_POSITION_KEY = 'greeting_default_position';

/** @typedef {{greetings: string[], defaultIndex: number|null}} GreetingsModel */

/**
 * @param {{first_mes?: string, data?: {alternate_greetings?: string[], extensions?: Record<string, any>}}} card
 * @returns {GreetingsModel}
 */
export function cardToGreetingsModel(card) {
    const firstMes = card?.first_mes ?? '';
    const altGreetings = Array.isArray(card?.data?.alternate_greetings) ? card.data.alternate_greetings : [];

    if (firstMes === '') {
        return { greetings: altGreetings.slice(), defaultIndex: null };
    }

    const recordedPosition = card?.data?.extensions?.[GREETING_DEFAULT_POSITION_KEY];
    if (Number.isInteger(recordedPosition) && recordedPosition >= 0 && recordedPosition <= altGreetings.length) {
        const greetings = altGreetings.slice();
        greetings.splice(recordedPosition, 0, firstMes);
        return { greetings, defaultIndex: recordedPosition };
    }

    return { greetings: [firstMes, ...altGreetings], defaultIndex: 0 };
}

/**
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
 * @param {number|null} defaultIndex
 * @param {number} removedIndex
 */
function reindexDefaultAfterRemoval(defaultIndex, removedIndex) {
    if (defaultIndex === null) return null;
    if (removedIndex === defaultIndex) return null;
    return removedIndex < defaultIndex ? defaultIndex - 1 : defaultIndex;
}

/**
 * @param {string} text
 * @returns {number}
 */
function hashGreetingText(text) {
    return getStringHash(JSON.stringify(text));
}

/**
 * @typedef {object} GreetingOpResult
 * @property {true} ok
 * @property {string[]} greetings
 * @property {number[]} hashes
 * @property {number|null} defaultPosition
 * @property {number} [position]
 */

/**
 * @param {string} opName
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
}

/**
 * @param {object} character
 * @param {GreetingOpResult} result
 * @param {{expectedHash: number, text: string}} [edit]
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
        run.edit = { from, to: edit.text, index: result.position };
    }
}

/**
 * @param {GreetingSaveRun} run
 * @returns {Promise<void>}
 */
function emitGreetingSaveEdited(run) {
    if (!run.character) return Promise.resolve();
    return eventSource.emit(event_types.CHARACTER_EDITED, { detail: { character: run.character, greetingEdit: run.edit } });
}

/**
 * @typedef {object} GreetingSaveRun
 * @property {object|null} character
 * @property {{from: string, to: string, index: number}|null} edit
 */

/** @type {Map<string, Promise<void>>} */
const greetingSaveQueues = new Map();

/** @type {Map<string, GreetingSaveRun>} */
const greetingSaveRuns = new Map();

/** @type {Map<string, Promise<void>>} */
const greetingEventStarts = new Map();

/**
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
 * @template T
 * @param {string} avatar
 * @param {() => Promise<T>} save
 * @returns {Promise<T>}
 */
function queueGreetingSave(avatar, save) {
    const previous = greetingSaveQueues.get(avatar) ?? Promise.resolve();
    /** @type {GreetingSaveRun} */
    const record = { character: null, edit: null };
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

const greetingPagerState = {
    greetings: [''],
    defaultIndex: 0,
    hashes: [],
    committed: [false],
    index: 0,
};

/**
 * @typedef {object} GreetingPagerEdit
 * @property {number} position
 * @property {boolean} committed
 * @property {number|undefined} hash
 * @property {{greetings: string[], defaultIndex: number|null, hashes: number[]}|null} pending
 */

/** @type {GreetingPagerEdit|null} */
let greetingPagerEdit = null;

function beginGreetingPagerEdit() {
    const { index, committed, hashes } = greetingPagerState;
    greetingPagerEdit = { position: index, committed: committed[index] !== false, hash: hashes[index], pending: null };
}

function endGreetingPagerEdit() {
    const edit = greetingPagerEdit;
    greetingPagerEdit = null;
    if (!edit) return;
    if (!edit.pending) {
        if (!edit.committed && greetingPagerState.greetings.length > 1 && String($('#greeting_field').val() ?? '') === '') {
            dropUncommittedPagerSlot(edit.position);
        }
        return;
    }
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
 * @param {number} position
 */
function dropUncommittedPagerSlot(position) {
    const { greetings, committed, defaultIndex } = greetingPagerState;
    greetings.splice(position, 1);
    committed.splice(position, 1);
    greetingPagerState.defaultIndex = reindexDefaultAfterRemoval(defaultIndex, position);
    greetingPagerState.index = Math.min(greetingPagerState.index, greetings.length - 1);
    if (menu_type === 'create') {
        const fields = greetingsModelToCardFields({ greetings, defaultIndex: greetingPagerState.defaultIndex });
        create_save.first_message = fields.firstMes;
        create_save.alternate_greetings = stripEmptyAlternateGreetings(fields.alternateGreetings, 'greeting pager slot dropped (create mode)');
        if (!create_save.extensions) create_save.extensions = {};
        create_save.extensions[GREETING_DEFAULT_POSITION_KEY] = fields.greetingDefaultPosition;
    }
    renderGreetingPager();
}

/**
 * @param {string[]} greetings
 * @param {number|null} defaultIndex
 * @param {number[]} hashes
 */
function setGreetingPagerGreetings(greetings, defaultIndex, hashes) {
    if (greetingPagerEdit) {
        greetingPagerEdit.pending = { greetings: greetings.slice(), defaultIndex, hashes: hashes.slice() };
        return;
    }
    greetingPagerState.greetings = greetings.length > 0 ? greetings.slice() : [''];
    greetingPagerState.defaultIndex = greetings.length > 0 ? defaultIndex : 0;
    greetingPagerState.hashes = greetings.length > 0 ? hashes.slice() : [];
    greetingPagerState.committed = greetings.length > 0 ? greetingPagerState.greetings.map(() => true) : [false];
    greetingPagerState.index = Math.max(0, Math.min(greetingPagerState.index, greetingPagerState.greetings.length - 1));
    renderGreetingPager();
}

function renderGreetingPager() {
    const { greetings, index } = greetingPagerState;
    setFieldValue('greeting_field', greetings[index] ?? '');
    autosizeTextareas(document.getElementById('greeting_field'));
    $('.greeting-pager-input').val(index + 1).css('--greeting-pager-digits', String(String(greetings.length).length));
    $('.greeting-pager-total').text(`/${greetings.length}`);
    $('.greeting-pager-delete').toggleClass('disabled', greetings.length === 1 && greetings[0] === '');
    countCharTokensWhenShown();
}

/**
 * @param {number} newIndex
 */
function navigateGreetingPager(newIndex) {
    const { greetings, index } = greetingPagerState;
    greetings[index] = String($('#greeting_field').val());
    greetingPagerState.index = ((newIndex % greetings.length) + greetings.length) % greetings.length;
    renderGreetingPager();
}

/**
 * @param {string} avatar
 * @param {object} character
 * @param {number} position
 * @param {number|undefined} expectedHash
 * @param {string} text
 * @returns {Promise<{position: number, hash: number}|null>}
 */
async function saveGreetingPagerEdit(avatar, character, position, expectedHash, text) {
    if (!Number.isFinite(expectedHash)) return null;

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
 * @param {string} value
 * @param {{ confirmed?: boolean }} [options]
 * @returns {Promise<boolean>}
 */
async function commitGreetingFieldValue(value, { confirmed = false } = {}) {
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
    return await queueGreetingSave(avatar, async () => {
        const edit = greetingPagerEdit;
        const target = edit ?? { position: index, committed: greetingPagerState.committed[index] !== false, hash: greetingPagerState.hashes[index] };
        if (target.committed && value === '') {
            if (!confirmed || !Number.isFinite(target.hash)) return false;
            const removed = await postGreetingOp('delete', { avatar_url: avatar, position: target.position, expected_hash: target.hash });
            if (removed.ok) {
                applyGreetingOpSuccess(character, removed);
                if (edit && greetingPagerEdit === edit) {
                    edit.committed = false;
                    edit.hash = undefined;
                }
                return true;
            }
            console.error('Greeting delete failed', { avatar, position: target.position, status: removed.status, reason: removed.reason });
            toastr.error(removed.status === 409
                ? t`This character was changed in another session, so the greeting was not deleted. Reopen the character to see the current version.`
                : t`Failed to delete the greeting.`, t`Greeting not deleted`);
            return false;
        }
        if (target.committed) {
            const landed = await saveGreetingPagerEdit(avatar, character, target.position, target.hash, value);
            if (!landed) return false;
            if (edit && greetingPagerEdit === edit) {
                edit.position = landed.position;
                edit.hash = landed.hash;
            }
            return true;
        }
        if (value === '') return confirmed;
        const expectedLength = greetingPagerState.hashes.length;
        const result = await postGreetingOp('add', { avatar_url: avatar, position: target.position, expected_length: expectedLength, text: value });
        if (result.ok) {
            applyGreetingOpSuccess(character, result);
            if (edit && greetingPagerEdit === edit) {
                edit.committed = true;
                edit.hash = result.hashes[target.position];
            }
            if (expectedLength === 0 && result.defaultPosition === null) {
                const made = await postGreetingOp('default/set', { avatar_url: avatar, position: target.position, expected_hash: result.hashes[target.position] });
                if (made.ok) {
                    applyGreetingOpSuccess(character, made);
                } else {
                    console.error('Making the first greeting the default failed', { avatar, status: made.status, reason: made.reason });
                    toastr.warning(t`The greeting was added, but couldn't be made the default greeting.`, t`Default not set`);
                }
            }
            return true;
        }
        console.error('Greeting add failed', { avatar, position: target.position, status: result.status, reason: result.reason });
        toastr.error(t`Failed to save the new greeting. It's still shown here - confirm it again to retry.`, t`Greeting not saved`);
        return false;
    });
}

async function deleteGreetingPagerGreeting() {
    const { greetings, committed, index, defaultIndex, hashes } = greetingPagerState;
    if (greetings.length === 1 && greetings[0] === '') return;
    const expectedHash = hashes[index];
    if (committed[index] === false && menu_type !== 'create') {
        dropUncommittedPagerSlot(index);
        return;
    }

    const label = index === defaultIndex ? 'the default greeting' : 'this greeting';
    const confirm = await callGenericPopup(t`Are you sure you want to delete ${label}?`, POPUP_TYPE.CONFIRM);
    if (!confirm) return;

    if (menu_type === 'create') {
        const remaining = greetings.filter((_, i) => i !== index);
        const remainingDefault = reindexDefaultAfterRemoval(defaultIndex, index);
        const fields = greetingsModelToCardFields({ greetings: remaining, defaultIndex: remainingDefault });
        create_save.first_message = fields.firstMes;
        create_save.alternate_greetings = stripEmptyAlternateGreetings(fields.alternateGreetings, 'greeting pager delete (create mode)');
        if (!create_save.extensions) create_save.extensions = {};
        create_save.extensions[GREETING_DEFAULT_POSITION_KEY] = fields.greetingDefaultPosition;
        setGreetingPagerGreetings(remaining, remainingDefault, remaining.map(hashGreetingText));
        return;
    }

    const avatar = $('.open_alternate_greetings').data('avatar');
    const character = avatar ? charactersStore.get(avatar) : null;
    if (!character) return;
    if (!Number.isFinite(expectedHash)) return;
    await queueGreetingSave(avatar, async () => {
        const result = await postGreetingOp('delete', { avatar_url: avatar, position: index, expected_hash: expectedHash });
        if (result.ok) {
            applyGreetingOpSuccess(character, result);
            return;
        }
        console.error('Greeting delete failed', { avatar, position: index, status: result.status, reason: result.reason });
        toastr.error(result.status === 409
            ? t`This character was changed in another session, so the greeting was not deleted. Reopen the character to see the current version.`
            : t`Failed to delete the greeting.`, t`Greeting not deleted`);
    });
}

/**
 * @param {string} value
 * @param {{ confirmed?: boolean }} [options]
 * @returns {Promise<boolean>}
 */
export async function saveGreetingField(value, { confirmed = false } = {}) {
    return await commitGreetingFieldValue(value, { confirmed });
}

/**
 * @param {string[]} alternateGreetings
 * @param {string} context
 */
function stripEmptyAlternateGreetings(alternateGreetings, context) {
    const filtered = alternateGreetings.filter(greeting => greeting !== '');
    const dropped = alternateGreetings.length - filtered.length;
    if (dropped > 0) {
        console.warn(`[alternate_greetings] Dropped ${dropped} empty entr${dropped === 1 ? 'y' : 'ies'} before writing (${context}). An empty string should never reach alternate_greetings - something upstream let one through.`);
    }
    return filtered;
}

/**
 * @param {string|null} avatar
 */
function setGreetingsButton(avatar) {
    $('.open_alternate_greetings')
        .data('avatar', avatar)
        .toggleClass('disabled', !avatar)
        .attr('aria-disabled', String(!avatar));
}

function openGreetingsList() {
    if (blockWhileFieldEditing()) {
        return;
    }
    const avatar = $('.open_alternate_greetings').data('avatar');
    if (!avatar) {
        toastr.info(t`The character isn't saved yet: its greetings are edited here, with the greeting field, until it is.`);
        return;
    }
    newUi().alternatives.openGreetings(avatar, charactersStore.get(avatar)?.name ?? '');
}

/**
 * @param {string} avatar
 * @param {{ greetings: string[], hashes: number[], defaultPosition: number|null }} card
 * @param {{ hash: number, text: string } | null} edit
 * @returns {Promise<void>}
 */
export function applyServerGreetings(avatar, card, edit) {
    const character = charactersStore.get(avatar);
    if (!character) return Promise.resolve();
    return queueGreetingSave(avatar, async () => {
        const position = edit ? card.greetings.indexOf(edit.text) : -1;
        applyGreetingOpSuccess(character, {
            ok: true,
            greetings: card.greetings,
            hashes: card.hashes,
            defaultPosition: card.defaultPosition,
            ...(position >= 0 ? { position } : {}),
        }, edit ? { expectedHash: edit.hash, text: edit.text } : undefined);
    });
}

/**
 * @param {string} [jsonData]
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
    for (const tagId of $('#tagList').find('.tag').map((_, el) => $(el).attr('id')).get()) {
        if (tagId) formData.append('tag_ids', tagId);
    }
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
 * @param {string|null} header
 */
function warnUnassignedCreateTags(header) {
    if (!header) return;
    let ids = [];
    try {
        ids = JSON.parse(header);
    } catch {
        return;
    }
    if (!Array.isArray(ids) || ids.length === 0) return;
    const names = ids.map(id => tagsStore.get(id)?.name ?? id);
    toastr.warning(t`The character was created without these tags:` + ` ${names.join(', ')}`, t`Tags not added`);
}

/**
 * @param {object} [options]
 * @param {string} [options.jsonData]
 */
async function createCharacterFromCreateSave({ jsonData } = {}) {
    if (blockWhileFieldEditing()) {
        return;
    }
    if (!settingsReady) {
        console.warn('Settings not ready, aborting character creation.');
        return;
    }

    $('#rm_info_avatar').html('');
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
            { id: '#_alternate_greetings_fake', callback: value => create_save.alternate_greetings = value, defaultValue: [] },
            { id: '#talkativeness_slider', callback: value => create_save.talkativeness = value, defaultValue: talkativeness_default },
            { id: '#scenario_pole', callback: value => create_save.scenario = value },
            { id: '#depth_prompt_prompt', callback: value => create_save.depth_prompt_prompt = value },
            { id: '#depth_prompt_depth', callback: value => create_save.depth_prompt_depth = value, defaultValue: depth_prompt_depth_default },
            { id: '#depth_prompt_role', callback: value => create_save.depth_prompt_role = value, defaultValue: depth_prompt_role_default },
            { id: '#mes_example_textarea', callback: value => create_save.mes_example = value },
            { id: '#character_world', callback: value => create_save.world = value },
            { id: '#_character_extensions_fake', callback: value => create_save.extensions = {} },
        ];

        fields.forEach(field => {
            const fieldValue = field.defaultValue !== undefined ? field.defaultValue : '';
            $(field.id).val(fieldValue);
            field.callback && field.callback(fieldValue);
        });
        create_save.first_message = '';
        setGreetingPagerGreetings([''], 0, []);

        if (Array.isArray(create_save.extra_books) && create_save.extra_books.length > 0) {
            await sendAuxBooksOp(getCharaFilename(avatarId), 'set', create_save.extra_books);
        }
        create_save.extra_books = [];

        create_save.avatar = null;

        $('#add_avatar_button').replaceWith(
            $('#add_avatar_button').val('').clone(true),
        );

        console.log(`new avatar id: ${avatarId}`);
        warnUnassignedCreateTags(fetchResult.headers.get('X-Unassigned-Tag-Ids'));
        crop_data = undefined;

        await selectCharacterByAvatar(avatarId);
    } catch (error) {
        console.error('Error creating character', error);
        toastr.error(t`Failed to create character`);
    }
}

/**
 * @param {string} avatar
 * @param {File} file
 * @returns {Promise<boolean>}
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
        await eventSource.emit(event_types.CHARACTER_EDITED, { detail: { character: charactersStore.get(avatar) } });
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

    if (forceMesId == null && event?.currentTarget?.closest('.mes')?.getAttribute('mesid') != null && chat[mesId]) {
        message = chat[mesId];
        messageIndex = mesId;
    }

    if (![SWIPE_SOURCE.DELETE, SWIPE_SOURCE.BACK, SWIPE_SOURCE.AUTO_SWIPE, SWIPE_SOURCE.SLASH_COMMAND, SWIPE_SOURCE.SWIPE_PICKER].includes(source)) {
        if (isGenerating() && (swipes && !swipesHidden && (swipeState === SWIPE_STATE.NONE))) {
            toastr.warning(t`Cannot swipe while generating. Stop the request and try again.`, t`Swipe aborted`);
            return;
        }
        if (!isSwipingAllowed()) {
            console.info('The swipe has been ignored messages cannot currently be swiped.');
            return;
        }
        if (!isMessageSwipeable(mesId, message)) {
            console.info(`Message #${mesId} cannot be swiped. ${message}`);
            return;
        }
    }

    swipeState = SWIPE_STATE.SWIPING;
    try {
        let generation;

        let thisMesDiv = chatElement.children('.mes').filter(`[mesid="${mesId}"]`);
        let thisMesText = thisMesDiv.find('.mes_block .mes_text');
        if (![thisMesDiv.length, thisMesText.length].every(num => num > 0)) {
            console.error(`Message #${mesId}'s DOM element is not valid.`);
            return;
        }
        const originalSwipeId = Number(chat[mesId]?.swipe_id ?? 0);
        let newSwipeId = Number(forceSwipeId ?? originalSwipeId);

        /**
         * @param {number} animation_duration
         * @returns {number}
         */
        function getSwipeDuration(animation_duration) {
            const now = performance.now();
            const resetTime = animation_duration * 2 + 300;

            if (now - lastSwipeInfo.now >= resetTime || direction !== lastSwipeInfo.direction) recentSwipes = 0;
            recentSwipes++;
            lastSwipeInfo = { now, direction };

            const sigmoid = 1 / (1 + Math.exp(recentSwipes - 4));

            return animation_duration * sigmoid;
        }

        const swipeDuration = forceDuration ?? getSwipeDuration(animation_duration);
        let continuationChanged = false;

        const thisMesDivWidth = thisMesDiv.width() + 30;
        let swipeRange = (direction === SWIPE_DIRECTION.RIGHT) ? -thisMesDivWidth : thisMesDivWidth;

        /**
         * @param {boolean} revert
         */
        async function endSwipe(revert = false) {
            try {
                if (generation) {
                    document.body.dataset.swiping = 'true';
                    await generation;
                }
            } catch (error) {
                console.warn(`Swipe failed, Swiping back. ${error}`);
            }

            let clampedId = clamp(chat[mesId].swipe_id, 0, Math.max(0, chat[mesId].swipes.length - 1));

            await updateSwipeCounter(mesId);
            if (mesId != chat.length - 1) {
                await updateSwipeCounter(chat.length - 1);
            }

            if (clampedId == originalSwipeId && source != SWIPE_SOURCE.DELETE) {
                try {
                    shakeElement(thisMesDiv, -swipeRange / 140, animation_duration, 'ease-in');
                    const flashTime = Math.max(animation_duration * 2, 100);
                    await Promise.race([thisMesDiv.find('.swipes-counter').animate({ color: 'red' }, flashTime).animate({ color: '' }).promise(), createTimeout(flashTime * 4, `The shake animation did not end within ${flashTime * 4}ms`)].filter(Boolean));
                } catch (error) {
                    console.warn(error);
                }
            }

            if (chat[mesId]?.swipe_id !== clampedId || revert) {
                if (source != SWIPE_SOURCE.BACK) {
                    source = SWIPE_SOURCE.BACK;
                    updateMessage(mesId, { swipe_id: clampedId });

                    await loadFromSwipeId(mesId, clampedId);
                    continuationChanged = false;
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

            await redrawSwipedContinuation();
        }

        async function standardSwipe(newSwipeId) {
            if (newSwipeId !== originalSwipeId || source == SWIPE_SOURCE.DELETE || source == SWIPE_SOURCE.BACK) {
                await loadFromSwipeId(mesId, newSwipeId);
                thisMesDiv = chatElement.children('.mes').filter(`[mesid="${mesId}"]`);
                thisMesText = thisMesDiv.find('.mes_block .mes_text');
                await animateSwipe();
            }
            await endSwipe();
        }

        /**
         * @param {number} mesId
         * @param {number} newSwipeId
         */
        async function loadFromSwipeId(mesId, newSwipeId) {
            const leaving = chat[mesId];
            const leftAt = originalSwipeId;
            if (leftAt !== newSwipeId && leaving?.node_id != null && leaving.swipe_info?.[leftAt] && leaving.swipe_info[leftAt].node_id == null) {
                const swipeInfo = [...leaving.swipe_info];
                swipeInfo[leftAt] = { ...swipeInfo[leftAt], node_id: leaving.node_id };
                updateMessage(mesId, { swipe_info: swipeInfo });
            }

            await hydrateSwipes(mesId, { index: newSwipeId });

            updateMessage(mesId, { swipe_id: newSwipeId });

            if (syncSwipeToMes(mesId, newSwipeId) == false) {
                let errorMessage = t`When swiping ${direction} on message ${mesId}, syncSwipeToMes has returned false. Attempting to swipe back!`;
                toastr.error(errorMessage);

                updateMessage(mesId, { swipe_id: originalSwipeId });
                await endSwipe(true);
                return true;
            }

            const switched = await switchToAlternativePath(mesId, newSwipeId, { redraw: false });
            if (switched) {
                continuationChanged = true;
            } else if (chat[mesId].swipe_info?.[newSwipeId] && chat[mesId].swipe_info[newSwipeId].node_id == null) {
                updateMessage(mesId, { node_id: undefined });
            }
            return true;
        }

        async function redrawSwipedContinuation() {
            if (!continuationChanged) return;
            continuationChanged = false;
            await redisplayChat({ startIndex: mesId + 1 });
            if (chat.length === mesId + 1) {
                chatElement.children('.mes').filter(`[mesid="${mesId}"]`).addClass('last_mes');
            }
            updateViewMessageIds();
        }

        /**
         * @param {number} mesId
         * @param {object} params
         * @param {string} [params.xStart='opx']
         * @param {string} [params.xEnd='0px']
         * @param {number} [params.duration=animation_duration]
         * @param {string} [params.classes='']
         * @param {boolean} [params.freeze=true]
         * @returns {Promise<boolean|Function>}
         */
        async function animateSwipeTransition(mesId, { xStart = '0px', xEnd = '0px', duration = animation_duration, classes = '', freeze = false } = {}) {
            if (duration <= 50) return;

            const MAXIMUM_ANIMATED = 100;

            const messages = chatElement.children('.mes');
            const firstDisplayedMesId = Number(messages.first().attr('mesid'));

            const swipedMessagesDiv = messages.filter((index, div) => {
                const divMessageId = firstDisplayedMesId + index;

                return (divMessageId < mesId + MAXIMUM_ANIMATED && divMessageId >= mesId);
            });
            if (swipedMessagesDiv.length > 0) {
                let swipeClasses = '.mes_block, .mesAvatarWrapper';
                swipeClasses += classes;

                const swipedElementsDiv = swipedMessagesDiv.children(swipeClasses);
                if (swipedElementsDiv.length > 0) {
                    document.documentElement.style.setProperty('--slide-mes-x-start', xStart);
                    document.documentElement.style.setProperty('--slide-mes-x-end', xEnd);
                    document.documentElement.style.setProperty('--slide-mes-x-duration', `${duration}ms`);

                    swipedElementsDiv.removeClass('slide');
                    void swipedElementsDiv[0].offsetWidth;
                    swipedElementsDiv.addClass('slide');

                    const endSlide = () => {
                        swipedElementsDiv.removeClass('slide');

                        document.documentElement.style.setProperty('--slide-mes-x-start', '');
                        document.documentElement.style.setProperty('--slide-mes-x-end', '');
                        document.documentElement.style.setProperty('--slide-mes-duration', '');
                        return true;
                    };
                    const animations = swipedElementsDiv[0]?.getAnimations() ?? [];
                    const animation = animations.filter((a) => a instanceof globalThis.CSSAnimation && a.animationName == 'slide')[0];
                    try {
                        await Promise.race([animation?.finished, createTimeout(duration * 2, `The ${duration}ms swipe animation has not ended after ${duration * 2}ms. It has been skipped.`)].filter(Boolean));
                    } catch (error) {
                        console.warn(error);
                    }

                    return freeze ? endSlide : endSlide();
                }
            }
            console.warn(`No animatable messages were found after message #${mesId}.`);
            return false;
        }

        /**
         * @returns {number|null}
         */
        function getMessageBottomHeight() {
            const liveMesDiv = chatElement.children('.mes').filter(`[mesid="${mesId}"]`);
            if (!liveMesDiv[0]?.isConnected) {
                return null;
            }
            const containerRect = chatElement[0].getBoundingClientRect();
            const thisMesRect = liveMesDiv[0].getBoundingClientRect();
            const overflow = thisMesRect.bottom - containerRect.bottom;
            return chatElement.scrollTop() + overflow;
        }

        /**
         * @returns {boolean}
         */
        function isChatAtBottom() {
            return chatElement.scrollTop() >= (chatElement.prop('scrollHeight') - chatElement.outerHeight()) - 10;
        }

        /**
         * @param {boolean} run_generate
         * @param {boolean} [skipSwipeOut=false]
         */
        async function animateSwipe(run_generate = false, skipSwipeOut = false) {
            if (!skipSwipeOut) {
                await animateSwipeTransition(mesId, { xEnd: `${swipeRange}px`, duration: swipeDuration });
            }

            const wasAtBottom = isChatAtBottom();

            if (run_generate) {
                addOneMessage(chat[mesId], { type: 'swipe', forceId: mesId, scroll: false, showSwipes: false });
                thisMesDiv = chatElement.children('.mes').filter(`[mesid="${mesId}"]`);
                thisMesText = thisMesDiv.find('.mes_block .mes_text');
                await updateSwipeCounter(mesId);
                thisMesDiv.find('.mes_text').html('...');
                thisMesDiv.find('.mes_timer').html('');
                thisMesDiv.find('.tokenCounterDisplay').text('');
            } else {
                addOneMessage(chat[mesId], { type: 'swipe', forceId: mesId, scroll: false, showSwipes: false });
                await redrawSwipedContinuation();
            }

            const pinned = wasAtBottom ? getMessageBottomHeight() : null;
            if (pinned !== null) chatElement.scrollTop(pinned);

            await eventSource.emit(event_types.MESSAGE_SWIPED, (mesId));

            if (run_generate && !is_send_press) {
                is_send_press = true;
                generation = Generate('swipe');
            }

            await animateSwipeTransition(mesId, { xStart: `${-swipeRange}px`, xEnd: `${0}px`, duration: swipeDuration });
        }

        if (mesId === Number(this_edit_mes_id)) {
            closeMessageEditor();
        }
        if (isStreamingEnabled() && streamingProcessor) {
            streamingProcessor.onStopStreaming();
        }

        if (source != SWIPE_SOURCE.DELETE && source != SWIPE_SOURCE.BACK) {
            syncMesToSwipe(mesId);

            if (chat[mesId].swipe_id === undefined) {
                updateMessage(mesId, {
                    swipe_id: 0,
                    swipes: [chat[mesId].mes],
                    swipe_info: [{
                        'send_date': chat[mesId].send_date,
                        'gen_started': chat[mesId].gen_started,
                        'gen_finished': chat[mesId].gen_finished,
                        'extra': structuredClone(chat[mesId].extra),
                    }],
                });
            }
            let isLastSwipe = (direction === SWIPE_DIRECTION.RIGHT) ? (chat[mesId].swipe_id === Math.max(0, chat[mesId].swipes.length - 1)) : chat[mesId].swipe_id === 0;
            if (source === SWIPE_SOURCE.KEYBOARD && repeated && isLastSwipe) {
                await endSwipe();
                return;
            }
        } else if (source == SWIPE_SOURCE.DELETE || source == SWIPE_SOURCE.BACK) {
            await standardSwipe(newSwipeId);
            return;
        }

        if (direction === SWIPE_DIRECTION.LEFT) {
            if (forceSwipeId == null) newSwipeId--;
            if (newSwipeId < 0) {
                newSwipeId = Math.max(0, chat[mesId].swipes.length - 1);
            }
            if (newSwipeId > chat[mesId].swipes.length - 1) {
                toastr.warning(`The swipe_id for message #${mesId} was ${newSwipeId}. It has been reset to ${chat[mesId].swipes.length - 1}.`);
                updateMessage(mesId, { swipe_id: chat[mesId].swipes.length - 1 });
                await endSwipe();
                return;
            }
            await standardSwipe(newSwipeId);
            return;
        } else if (direction === SWIPE_DIRECTION.RIGHT) {
            if (forceSwipeId == null) newSwipeId++;

            if (newSwipeId < 0) {
                toastr.warning(`The swipe_id for message #${mesId} was ${newSwipeId}. It has been reset to zero.`);
                updateMessage(mesId, { swipe_id: 0 });
                await endSwipe();
                return;
            }

            if (newSwipeId >= chat[mesId].swipes.length) {
                newSwipeId = chat[mesId].swipes.length;

                updateMessage(mesId, { swipe_id: newSwipeId });

                const overswipe = getOverswipeBehavior(mesId);

                if (overswipe == OVERSWIPE_BEHAVIOR.NONE) {
                    updateMessage(mesId, { swipe_id: originalSwipeId });
                    await endSwipe();
                    return;
                } else if (overswipe == OVERSWIPE_BEHAVIOR.REGENERATE) {
                    if (chat.length > mesId + 1) {
                        forgetStored(chat.splice(mesId + 1).map(m => m.node_id));
                        await redisplayChat({ startIndex: mesId + 1 });
                        updateViewMessageIds();
                    }

                    const swipedFrom = chat[mesId].node_id;
                    /** @type {Partial<ChatMessage>} */
                    const inFlight = { extra: {}, gen_started: undefined, gen_finished: undefined, node_id: undefined };
                    if (isStoredNodeId(swipedFrom)) {
                        const swipeInfo = [...(chat[mesId].swipe_info ?? [])];
                        if (swipeInfo[originalSwipeId] && !isStoredNodeId(swipeInfo[originalSwipeId].node_id)) {
                            swipeInfo[originalSwipeId] = { ...swipeInfo[originalSwipeId], node_id: swipedFrom };
                            inFlight.swipe_info = swipeInfo;
                        }
                        beginSwipeReply(mesId, swipedFrom);
                    }
                    updateMessage(mesId, inFlight);
                    let run_generate = true;
                    await animateSwipe(run_generate);
                    await endSwipe();
                    return;
                } else if (overswipe == OVERSWIPE_BEHAVIOR.EDIT_GENERATE) {
                    const newSwipes = [...chat[mesId].swipes, ''];
                    const newSwipeInfo = [...(chat[mesId].swipe_info || []), {
                        send_date: getMessageTimeStamp(),
                        gen_started: undefined,
                        gen_finished: undefined,
                        extra: {},
                    }];
                    updateMessage(mesId, { swipes: newSwipes, swipe_info: newSwipeInfo });
                    await standardSwipe(newSwipeId);

                    if (chat.length > mesId + 1) {
                        forgetStored(chat.splice(mesId + 1).map(m => m.node_id));
                        await redisplayChat({ startIndex: mesId });
                        updateViewMessageIds();
                    }

                    await messageEdit(mesId);
                    return;
                } else if (overswipe == OVERSWIPE_BEHAVIOR.LOOP || overswipe == OVERSWIPE_BEHAVIOR.PRISTINE_GREETING) {
                    newSwipeId = 0;
                }
            }
            await standardSwipe(newSwipeId);
            return;
        }
    } finally {
        swipeState = SWIPE_STATE.NONE;
        delete document.body.dataset.swiping;
        showSwipeButtons();
    }
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
const IMPORTS_IN_FLIGHT = 4;

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

    const useBatchImportMode = importable.length > 1;
    if (useBatchImportMode) {
        await beginMetadataBatchImport();
    }

    const avatarFileNames = [];
    let duplicateCount = 0;

    const ahead = useBatchImportMode ? IMPORTS_IN_FLIGHT : 1;
    /** @type {ReturnType<typeof importCharacter>[]} */
    const started = [];
    const start = (/** @type {number} */ i) => {
        if (i >= importable.length) return;
        const file = importable[i];
        const preservedName = data instanceof Map && data.get(file);
        started[i] = importCharacter(file, { preserveFileName: preservedName, sourceUrl: sourceUrls.get(file) });
        started[i].catch(() => {});
    };

    try {
        for (let i = 0; i < ahead; i++) start(i);
        for (let i = 0; i < importable.length; i++) {
            const result = await started[i];
            start(i + ahead);

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
                mergeServerTagDefinitions(result.tagDefinitions);
                tagsAdded = Array.isArray(result.character?.tag_ids) && result.character.tag_ids.length > 0;
            } else if (power_user.tag_import_setting !== tag_import_setting.NONE) {
                tagsAdded = await importTags(result.character, { suppressSuccessToast: true });
            }

            const charName = result.character?.name || String(result.avatarFileName).replace('.png', '');
            const toastMessage = result.replaced
                ? (tagsAdded ? t`Replaced character '${charName}' (tags imported)` : t`Replaced character '${charName}'`)
                : (tagsAdded ? t`Imported character '${charName}' (tags imported)` : t`Imported character '${charName}'`);
            toastr.success(toastMessage);
        }
    } finally {
        if (useBatchImportMode) {
            await endMetadataBatchImport();
        }
    }

    if (avatarFileNames.length > 0) {
        selectImportedChar(avatarFileNames[avatarFileNames.length - 1]);
    }

    if (duplicateCount > 0) {
        toastr.info(t`Skipped ${duplicateCount} duplicate character(s) already in your library.`, t`Import`);
    }

    return avatarFileNames;
}

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

function applyImportedCharacter(character) {
    if (!character?.avatar) {
        return;
    }
    character.shallow = false;
    if (charactersStore.has(character.avatar)) {
        charactersStore.update(character.avatar, character);
    } else {
        holdCharacter(character);
    }
}

/**
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

    const exists = preserveFileName ? await characterExistsOnServer(preserveFileName) : false;

    const format = ext[1].toLowerCase();
    $('#character_import_file_type').val(format);
    const formData = new FormData();
    formData.append('avatar', file);
    formData.append('file_type', format);
    formData.append('user_name', name1);
    if (preserveFileName) formData.append('preserved_name', preserveFileName);
    if (sourceUrl) formData.append('source_url', sourceUrl);

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
            const avatarFileName = `${data.file_name}.png`;
            if (Array.isArray(data.extra_books)) {
                takeAuxBooks(data.file_name, data.extra_books);
                await updateWorldInfoList();
                toastr.success(t`Imported the lorebooks this character links to`);
            }

            $('#character_search_bar').val('').trigger('input');

            return {
                avatarFileName, replaced: exists, character: data.character,
                serverHandledTags: effectiveTagSetting === tag_import_setting.ALL || effectiveTagSetting === tag_import_setting.ONLY_EXISTING,
                tagDefinitions: Array.isArray(data.tagDefinitions) ? data.tagDefinitions : [],
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

    await clearChat({ clearData: true });

    chat_file_for_del = getCurrentChatDetails()?.sessionName;

    if (deleteCurrentChat && !selected_group) {
        charactersStore.update(getCurrentCharacter().avatar, { date_last_chat: Date.now() });
    }

    if (selected_group) {
        await createNewGroupChat(selected_group, { replace: deleteCurrentChat ? chat_file_for_del : null });
    } else {
        setChatMetadata({});
        _resetMetadataSaveSnapshot();
        await pointToFreshChat(deleteCurrentChat ? chat_file_for_del : null);
    }
}

/**
 * Renames a group or character chat.
 * @param {object} param Parameters for renaming chat
 * @param {string} [param.characterAvatar] Character avatar (identity) to rename chat for
 * @param {string} [param.groupId] Group ID to rename chat for
 * @param {string} param.oldFileName Old name of the chat (no JSONL extension)
 * @param {string} param.newFileName New name for the chat (no JSONL extension)
 * @param {boolean} [param.loader=true] Whether to show loader during the operation
 */
export async function renameGroupOrCharacterChat({ characterAvatar, groupId, oldFileName, newFileName, loader: showLoader }) {
    const currentChatId = getCurrentChatId();
    const avatarUrl = characterAvatar;
    const body = {
        is_group: !!groupId,
        ...(groupId ? { group_id: groupId } : {}),
        avatar_url: avatarUrl,
        original_file: `${oldFileName}.jsonl`,
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

        const idChanged = newFileName !== oldFileName;
        if (idChanged && groupId) {
            await renameGroupChat(groupId, oldFileName, newFileName);
        } else if (idChanged && avatarUrl !== undefined && avatarUrl === this_avatar && charactersStore.get(avatarUrl)?.chat === oldFileName) {
            _setCurrentTarget(newFileName, chat_metadata.integrity);
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
export async function renameChat(oldFileName, newName) {
    return await renameGroupOrCharacterChat({
        characterAvatar: this_avatar,
        groupId: selected_group,
        oldFileName: oldFileName,
        newFileName: newName,
        loader: true,
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
        await clearChat({ clearData: true });
        resetSelectedGroup();
        setCharacterId(undefined);
        setCharacterName('');
        setActiveCharacter(null);
        setActiveGroup(null);
        this_edit_mes_id = undefined;
        setChatMetadata({});
        _resetMetadataSaveSnapshot();
        chatClosed();
        selected_button = 'characters';
        $('#rm_button_selected_ch').children('h2').text('');
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
 * @param {string} avatar The character's avatar
 * @param {string} newName New pointer value (a node id, a legacy chat name, or '' to clear it - "no active chat" is a valid state)
 * @returns {Promise<void>}
 */
export async function updateRemoteChatName(avatar, newName) {
    const character = charactersStore.get(avatar);
    if (!character) {
        console.warn(`Character not found: ${avatar}`);
        return;
    }
    const answer = await saveActiveChat(character.avatar, newName);
    if (answer) charactersStore.update(character.avatar, { chat: answer.chat });
}


function doCharListDisplaySwitch() {
    power_user.charListGrid = !power_user.charListGrid;
    document.body.classList.toggle('charListGrid', power_user.charListGrid);
    saveSettingsDebounced('power_user.charListGrid');
}

/**
 * Deletes a character completely, including associated chats if specified
 *
 * @param {string|string[]} characterKey - The key (avatar) of the character to be deleted
 * @param {{deleteChats?: boolean}} [options] - `deleteChats` (default true): whether to delete associated chats or not
 * @return {Promise<boolean>} - A promise that resolves when the character is successfully deleted
 */
export async function deleteCharacter(characterKey, { deleteChats = true } = {}) {
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
    /** @type {Map<string, string[]>} */
    const deletedChats = new Map((data.results ?? []).filter(entry => entry.ok).map(entry => [entry.avatar_url, Array.isArray(entry.chats) ? entry.chats : []]));

    for (const character of characters) {
        if (!okAvatars.has(character.avatar)) {
            toastr.error(t`Failed to delete character ${character.name}`);
            continue;
        }

        accountStorage.removeItem(`mediaWarningShown:${character.avatar}`);
        removeEntityTags(character.avatar);
        select_rm_info('char_delete', character.name);

        if (deleteChats) {
            for (const name of deletedChats.get(character.avatar) ?? []) {
                await eventSource.emit(event_types.CHAT_DELETED, name);
            }
        }

        await eventSource.emit(event_types.CHARACTER_DELETED, { character: character });
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
    closeRightMenu('rm_ch_create_block');
    $(document.getElementById('rm_button_selected_ch')).children('h2').text('');
    restoreNeutralChat();
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
    chatClosed();
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
    if ($(this).parent().is('#chat-button')) {
        bringChatForward();
        return;
    }
    const icon = $(this).find('.drawer-icon');
    const drawer = $(this).parent().find('.drawer-content');
    const drawerWasOpenAlready = $(this).parent().find('.drawer-content').hasClass('openDrawer');
    const targetDrawerID = $(this).parent().find('.drawer-content').attr('id');
    const pickingRefused = targetDrawerID === 'right-nav-panel' && isFieldBeingEdited();

    if (!drawerWasOpenAlready) {
        if (pickingRefused) {
            blockWhileFieldEditing();
            return;
        }
        const closedCount = closeUnpinnedDrawersFor(drawer[0]);
        if (closedCount && animation_duration) {
            await delay(animation_duration);
        }
        icon.toggleClass('openIcon closedIcon');
        drawer.toggleClass('openDrawer closedDrawer');

        if (targetDrawerID === 'right-nav-panel') {
            $('#rm_print_characters_block').trigger('scroll');
        }

        if (targetDrawerID === 'char-info-panel' && getSelectionState().type === 'none') {
            select_rm_create();
        }

        frontDrawer(targetDrawerID);
    } else if (drawerWasOpenAlready) {
        if (!pickingRefused && isDrawerCovered(drawer[0])) {
            bringOpenDrawerForward(drawer[0]);
            return;
        }
        icon.toggleClass('closedIcon openIcon');
        closeDrawerContent(drawer[0]);
    }
}

function addDebugFunctions() {
    const doBackfill = async () => {
        await fillTokenCounters(chat.map((_, mesId) => mesId), { recount: true });
    };

    registerDebugFunction('forceOnboarding', 'Force onboarding', 'Forces the onboarding process to restart.', async () => {
        firstRun = true;
        await saveSettings();
        location.reload();
    });

    registerDebugFunction('backfillTokenCounts', 'Backfill token counters',
        `Counts the messages of the current chat again with the current tokenizer, replacing the stored counts.
        This is a visual change only.`, doBackfill);

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
        const getSettingsContents = settings;
        //console.log(getSettingsContents);
        const logMessage = `
\`\`\`
API: ${getSettingsContents.main_api}
API Type: ${getSettingsContents[getSettingsContents.main_api + '_settings'].type}
API server: ${getSettingsContents.api_server}
Model: ${online_status}
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

    $('#send_textarea').on('input', () => saveDraftDebounced());

    eventSource.on(event_types.CHARACTER_EDITED, async (event) => {
        const edited = event?.detail?.character?.avatar;
        if (!edited || edited !== getCurrentCharacter()?.avatar) return;
        await _mergeCardGreetingsIntoOpening({ greetingEdit: event.detail.greetingEdit });
    });

    eventSource.on(event_types.CHAT_CHANGED, () => {
        if (queuedSend && queuedSend.chat !== JSON.stringify(getCurrentDraftContext())) {
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
        if (getFocusedField()?.id !== 'send_textarea') {
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
        if (!selected_group && menu_type === 'character_edit') {
            beginInlineCharacterRename();
            return;
        }
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
        if (!selected_group && String(this_avatar) === String(avatar)) bringChatForward();
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
        const deleteFileName = $(this).attr('file_name');
        const row = $(this).closest('.select_chat_block_wrapper');

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

    $('#form_create').on('submit', () => {
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

    Object.keys(elementsToUpdate).forEach(function (id) {
        $(id).on('input', function () {
            if (menu_type == 'create') {
                elementsToUpdate[id]();
            } else {
                saveCharacterFieldDebounced(getEditorCharacterAvatar(), id, String($(id).val()));
            }
        });
    });

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
        if (committed[index] === false && greetings[index] === '') {
            beginEdit('greeting_field');
            return;
        }
        const newIndex = greetings.length;
        greetings.push('');
        committed[newIndex] = false;
        greetingPagerState.index = newIndex;
        renderGreetingPager();
        beginEdit('greeting_field');
    });

    $('.greeting-pager-delete').on('click', function () {
        if (blockWhileFieldEditing()) {
            return;
        }
        void deleteGreetingPagerGreeting();
    });

    function jumpGreetingPager() {
        const requested = parseInt(String($('.greeting-pager-input').val()), 10);
        if (Number.isNaN(requested)) {
            renderGreetingPager();
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


    $('#favorite_button').on('click', async function () {
        const newState = !fav_ch_checked;
        updateFavButtonState(newState);
        if (menu_type == 'create') {
            return;
        }
        const character = getCurrentCharacter();
        if (!character?.avatar) return;
        try {
            const response = await fetch('/api/characters/fav', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ avatar: character.avatar, fav: newState }),
            });
            if (!response.ok) throw new Error(String(response.status));
            character.fav = newState;
            if (character.data?.extensions) character.data.extensions.fav = newState;
            updateCharacterListRow(character.avatar);
            await getOneCharacter(character.avatar);
            printCharactersDebounced();
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

        window.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape' || e.isComposing || !talkativenessPopover.matches(':popover-open')) return;
            e.stopPropagation();
            talkativenessPopover.hidePopover();
        }, true);
    }

    const nameHeading = document.querySelector('#rm_button_selected_ch h2');
    const showRenameButton = () => $('#character_rename_inline').toggle(getSelectionState().type === 'character' && Boolean(nameHeading?.textContent));
    // eslint-disable-next-line no-restricted-syntax -- watches the page from before the ban: whatever changes it is to say so
    if (nameHeading) new MutationObserver(showRenameButton).observe(nameHeading, { childList: true, characterData: true, subtree: true });
    eventSource.on(event_types.CHAT_CHANGED, showRenameButton);
    $(document).on('click', '#character_rename_inline', () => beginInlineCharacterRename());

    $(document).on('click', '.renameChatButton', async function (e) {
        e.stopPropagation();
        const block = $(this).closest('.select_chat_block_wrapper').find('.select_chat_block');
        const chatId = block.attr('file_name');
        const oldLabel = block.attr('chat_label') ?? '';

        const popupText = await renderTemplateAsync('chatRename');
        const newName = await callGenericPopup(popupText, POPUP_TYPE.INPUT, oldLabel);

        if (!newName || typeof newName !== 'string' || newName == oldLabel) {
            console.log('no new name found, aborting');
            return;
        }

        await renameChat(chatId, newName);

        await delay(250);
        $('#option_select_chat').trigger('click');
        $('#options').hide();
    });

    $(document).on('click', '.exportChatButton, .exportRawChatButton', async function (e) {
        e.stopPropagation();
        const format = $(this).data('format') || 'txt';
        const block = $(this).closest('.select_chat_block_wrapper').find('.select_chat_block');
        const chatId = block.attr('file_name');
        const filename = block.attr('chat_label') || chatId;
        console.log(`exporting ${filename} in ${format} format`);

        const body = {
            is_group: !!selected_group,
            ...(selected_group ? { group_id: selected_group } : {}),
            avatar_url: getCurrentCharacter()?.avatar,
            file: `${chatId}.jsonl`,
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

        const cut = this_del_mes >= 0
            ? await chatOpCut(this_del_mes, chat.length - 1, { ask: true }).catch(error => {
                console.error('Could not cut the conversation back:', error);
                return null;
            })
            : null;
        if (this_del_mes >= 0 && cut !== false) {
            chatElement.find(`.mes[mesid="${this_del_mes}"]`).nextAll('div').remove();
            chatElement.find(`.mes[mesid="${this_del_mes}"]`).remove();
            chat.length = this_del_mes;
            chat_metadata.tainted = true;
            chatElement.scrollTop(chatElement[0].scrollHeight);
            await eventSource.emit(event_types.MESSAGE_DELETED, chat.length);
            chatElement.find('.mes').removeClass('last_mes');
            chatElement.find('.mes').last().addClass('last_mes');
        } else if (this_del_mes < 0) {
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

    $(document).on('click', '.mes_edit_duplicate', async function () {
        const mesElement = $(this).closest('.mes');
        const mesId = Number(mesElement.attr('mesid'));
        const message = chat[mesId];

        if (isComposedSlot(message)) {
            await messageEditDone($(this));
            return;
        }

        if (!message?.node_id) {
            toastr.info(t`This chat does not support alternatives.`);
            return;
        }

        const text = $(this).closest('.mes_block').find('.edit_textarea').val();
        if (typeof text !== 'string' || !text.length) {
            return;
        }

        const siblingNodeId = await ensureOpeningRow(mesId);
        if (isProvisionalNodeId(message.node_id) && !siblingNodeId) {
            toastr.error(t`Could not create the alternative.`);
            return;
        }

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

        const current = chat[mesId] ?? message;
        const swipes = Array.isArray(current.swipes) ? [...current.swipes] : [current.mes ?? ''];
        const swipeInfo = Array.isArray(current.swipe_info)
            ? [...current.swipe_info]
            : [{ send_date: current.send_date, extra: current.extra ?? {}, node_id: current.node_id }];

        let at = swipeInfo.findIndex(info => info?.node_id === createdId);
        if (at < 0) {
            swipes.push(text);
            swipeInfo.push({
                send_date: content.send_date, extra: content.extra ?? {},
                name: content.name, is_user: !!content.is_user, node_id: createdId,
            });
            at = swipes.length - 1;
        }
        updateMessage(mesId, { swipes, swipe_info: swipeInfo, mes: text });

        await messageEditCancel(mesId);
        await switchToAlternativePath(mesId, at);
    });

    $(document).on('click', '.mes_edit_cancel', async function () {
        await messageEditCancel.call(this, this_edit_mes_id);
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
            '.view_pill_popover',
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
        const message = chat[Number(messageElement.attr('mesid'))];
        const avatarKey = messageElement.attr('is_user') == 'true'
            ? (message?.persona ?? user_avatar)
            : (message?.original_avatar ?? (messageElement.attr('is_system') == 'true' ? '' : getCurrentCharacter()?.avatar ?? ''));
        const targetAvatarImg = avatarKey ? encodeURIComponent(avatarKey) : thumbURL;
        const charname = targetAvatarImg.replace('.png', '');
        let isValidCharacter = false;
        if (messageElement.attr('is_system') == 'true') {
            const avatarKey = decodeURIComponent(targetAvatarImg);
            isValidCharacter = charactersStore.has(avatarKey);
            if (!isValidCharacter) {
                const { checkCharactersExistOrNull } = await import('./scripts/character-existence-check.js');
                isValidCharacter = (await checkCharactersExistOrNull([avatarKey]))?.[avatarKey] === true;
            }
        }

        $('.zoomed_avatar').each(function () {
            const currentForChar = $(this).attr('forChar');
            if (currentForChar !== charname && typeof currentForChar !== 'undefined') {
                $(this).remove();
            }
        });

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

            addLayer(newElement[0]);
            newElement.fadeIn(animation_duration);
            const zoomedAvatarImgElement = $(`.zoomed_avatar[forChar="${charname}"] img`);
            if (messageElement.attr('is_user') == 'true' || (messageElement.attr('is_system') == 'true' && !isValidCharacter)) {
                //handle user and system avatars
                const isValidPersona = personaStore.has(decodeURIComponent(targetAvatarImg));
                if (isValidPersona) {
                    const personaSrc = getUserAvatar(targetAvatarImg);
                    zoomedAvatarImgElement.attr('src', personaSrc);
                    zoomedAvatarImgElement.attr('data-izoomify-url', personaSrc);
                    frameImage(zoomedAvatarImgElement[0], personaCrop(decodeURIComponent(targetAvatarImg)));
                } else {
                    zoomedAvatarImgElement.attr('src', thumbURL);
                    zoomedAvatarImgElement.attr('data-izoomify-url', thumbURL);
                }
            } else if (messageElement.attr('is_user') == 'false') { //handle char avatars
                zoomedAvatarImgElement.attr('src', avatarSrc);
                zoomedAvatarImgElement.attr('data-izoomify-url', avatarSrc);
                frameImage(zoomedAvatarImgElement[0], charactersStore.get(decodeURIComponent(targetAvatarImg))?.data?.extensions?.avatar_crop);
            }
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

    $(document).on('click', '.open_alternate_greetings', openGreetingsList);
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
        try {
            switch (target) {
                case 'set_character_world':
                    await openCharacterWorldPopup();
                    break;
                case 'set_chat_character_settings':
                    await setCharacterSettingsOverrides();
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
                default:
                    await eventSource.emit(event_types.CHARACTER_MANAGEMENT_DROPDOWN, target);
            }
        } finally {
            $('#char-management-dropdown').prop('selectedIndex', 0);
        }
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
    const counterInputs = '.range-block-counter input:not([data-field] input), .neo-range-input';

    $(document).on('input', counterInputs, function () {
        valueBeforeManualInput = $(this).val();
        console.log(valueBeforeManualInput);
    });

    $(document).on('change', counterInputs, function (e) {
        if (!(e.target instanceof HTMLElement)) {
            return;
        }
        e.target.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
    });

    $(document).on('keydown', counterInputs, function (e) {
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

    $(document).on('keyup', counterInputs, function () {
        valueBeforeManualInput = $(this).val();
        isManualInput = true;
    });

    //trigger slider changes when user clicks away
    $(document).on('mouseup blur', counterInputs, function () {
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

    new DragAndDropHandler('body', async (files, event) => {
        if (!files.length) {
            await importFromURL(event.originalEvent.dataTransfer.items, files);
        }
        await processDroppedFiles(files);
    }, { noAnimation: true });

    new DragAndDropHandler('#select_chat_popup', async (_, event) => {
        const importFile = document.getElementById('chat_import_file');
        if (importFile instanceof HTMLInputElement) {
            importFile.files = event.originalEvent.dataTransfer.files;
            $(importFile).trigger('change');
        }
    });

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

    // Added here to prevent execution before script.js is loaded and get rid of quirky timeouts
    await firstLoadInit();

    window.addEventListener('beforeunload', (e) => {
        if (this_edit_mes_id >= 0) {
            e.preventDefault();
            e.returnValue = true;
        }
    });
});
