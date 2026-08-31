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

import { humanizedDateTime, favsToHotswap, getMessageTimeStamp, dragElement, isMobile, initRossMods, RA_CountCharTokens } from './scripts/RossAscends-mods.js';
import { EntityStore } from './scripts/entity-store.js';
import { userStatsHandler, statMesProcess, initStats } from './scripts/stats.js';
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
    getWorldInfoPrompt,
    getWorldInfoSettings,
    setWorldInfoSettings,
    world_names,
    importEmbeddedWorldInfo,
    checkEmbeddedWorld,
    setWorldInfoButtonClass,
    wi_anchor_position,
    world_info_include_names,
    initWorldInfo,
    charUpdatePrimaryWorld,
    charSetAuxWorlds,
} from './scripts/world-info.js';

import {
    groups,
    groupsStore,
    selected_group,
    saveGroupChat,
    getGroups,
    generateGroupWrapper,
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
    getGroupBlock,
    getGroupCharacterCardsLazy,
    getGroupDepthPrompts,
} from './scripts/group-chats.js';

import {
    collapseNewlines,
    loadPowerUserSettings,
    playMessageSound,
    fixMarkdown,
    power_user,
    persona_description_positions,
    personaStore,
    loadMovingUIState,
    getCustomStoppingStrings,
    MAX_CONTEXT_DEFAULT,
    MAX_RESPONSE_DEFAULT,
    renderStoryString,
    sortEntitiesList,
    registerDebugFunction,
    flushEphemeralStoppingStrings,
    resetMovableStyles,
    forceCharacterEditorTokenize,
    applyPowerUserSettings,
    generatedTextFiltered,
    applyStylePins,
    invalidateCharactersFuseIndex,
} from './scripts/power-user.js';

import {
    setOpenAIMessageExamples,
    setOpenAIMessages,
    setupChatCompletionPromptManager,
    prepareOpenAIMessages,
    sendOpenAIRequest,
    loadOpenAISettings,
    oai_settings,
    openai_messages_count,
    chat_completion_sources,
    getChatCompletionModel,
    proxies,
    loadProxyPresets,
    selected_proxy,
    initOpenAI,
} from './scripts/openai.js';

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
    getStatusHorde,
    getHordeModels,
    adjustHordeGenerationParams,
    isHordeGenerationNotAllowed,
    MIN_LENGTH,
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
    PAGINATION_TEMPLATE,
    waitUntilCondition,
    escapeRegex,
    resetScrollHeight,
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
    uuidv4,
    equalsIgnoreCaseAndAccents,
    localizePagination,
    renderPaginationDropdown,
    paginationDropdownChangeHandler,
    importFromExternalUrl,
    shiftUpByOne,
    shiftDownByOne,
    canUseNegativeLookbehind,
    trimSpaces,
    clamp,
    shakeElement,
    createTimeout,
    getStringHash,
    cancelDebounce,
} from './scripts/utils.js';
// Imported directly from hash-utils.js (not re-exported via utils.js like getStringHash) so this doesn't widen
// utils.js's re-export surface - a mocked utils.js in tests/utils-findchar.test.js stubs hash-utils.js with only
// getStringHash, and this stays independent of that.
import { getAtPath, treeNodeAt, digestsEqual128, foldDigests128, emptyDigest128, DEFAULT_TREE_BRANCHING, characterDigestFieldsHash, characterDigestCardBodyHash, combineDigest128, characterDigestFavHash, characterDigestTagIdsHash } from './scripts/hash-utils.js';
import { debounce_timeout, GENERATION_TYPE_TRIGGERS, IGNORE_SYMBOL, inject_ids, MEDIA_DISPLAY, MEDIA_SOURCE, MEDIA_TYPE, OVERSWIPE_BEHAVIOR, SCROLL_BEHAVIOR, SWIPE_DIRECTION, SWIPE_SOURCE, SWIPE_STATE } from './scripts/constants.js';

import { cancelDebouncedMetadataSave, doDailyExtensionUpdatesCheck, extension_settings, initExtensions, loadExtensionSettings, runGenerationInterceptors } from './scripts/extensions.js';
import { COMMENT_NAME_DEFAULT, CONNECT_API_MAP, executeSlashCommandsOnChatInput, initDefaultSlashCommands, initSlashCommandAutoComplete, isExecutingCommandsFromChatInput, pauseScriptExecution, stopScriptExecution, UNIQUE_APIS } from './scripts/slash-commands.js';
import { initMacroAutoComplete } from './scripts/autocomplete/MacroAutoComplete.js';
import {
    tags,
    filterByTagState,
    isBogusFolder,
    isBogusFolderOpen,
    chooseBogusFolder,
    getTagBlock,
    loadTagsSettings,
    seedTagMapFromRecords,
    printTagFilters,
    getTagKeyForEntity,
    printTagList,
    createTagMapFromList,
    renameTagKey,
    importTags,
    tag_filter_type,
    compareTagsForSort,
    initTags,
    applyTagsOnCharacterSelect,
    applyTagsOnGroupSelect,
    tag_import_setting,
    applyCharacterTagsToMessageDivs,
    removeEntityTags,
} from './scripts/tags.js';
import { checkOpenRouterAuth, initSecrets, readSecretState } from './scripts/secrets.js';
import { markdownExclusionExt } from './scripts/showdown-exclusion.js';
import { markdownUnderscoreExt } from './scripts/showdown-underscore.js';
import { NOTE_MODULE_NAME, initAuthorsNote, metadata_keys, setFloatingPrompt, shouldWIAddPrompt } from './scripts/authors-note.js';
import { registerPromptManagerMigration } from './scripts/PromptManager.js';
import { getRegexedString, regex_placement } from './scripts/extensions/regex/engine.js';
import { initLogprobs, saveLogprobsForActiveMessage } from './scripts/logprobs.js';
import { FILTER_STATES, FILTER_TYPES, FilterHelper, isFilterState } from './scripts/filters.js';
import { characterRepository, buildCharacterQuery, isServerQueryableSort, isInvalidSortFieldError, normalizeQueryRow } from './scripts/character-repository.js';
import { getRandomSortSeed } from './scripts/random-sort.js';
import { openRightMenu, closeRightMenu } from './scripts/right-menu-state.js';
import { getCfgPrompt, getGuidanceScale, initCfg } from './scripts/cfg-scale.js';
import {
    force_output_sequence,
    formatInstructModeChat,
    formatInstructModePrompt,
    formatInstructModeExamples,
    formatInstructModeStoryString,
    getInstructStoppingSequences,
} from './scripts/instruct-mode.js';
import { initLocales, t } from './scripts/i18n.js';
import { getFriendlyTokenizerName, getTokenCount, getTokenCountAsync, initTokenizers, saveTokenCache } from './scripts/tokenizers.js';
import {
    user_avatar,
    getUserAvatars,
    getUserAvatar,
    setUserAvatar,
    initPersonas,
    setPersonaDescription,
    initUserAvatar,
    updatePersonaConnectionsAvatarList,
    isPersonaPanelOpen,
    DEFAULT_DEPTH as PERSONA_DEFAULT_DEPTH,
    DEFAULT_ROLE as PERSONA_DEFAULT_ROLE,
} from './scripts/personas.js';
import { getBackgrounds, initBackgrounds, loadBackgroundSettings, background_settings } from './scripts/backgrounds.js';
import { loader } from './scripts/action-loader.js';
import { BulkEditOverlay } from './scripts/BulkEditOverlay.js';
import { initTextGenModels } from './scripts/textgen-models.js';
import { appendFileContent, hasPendingFileAttachment, populateFileAttachment, decodeStyleTags, encodeStyleTags, isExternalMediaAllowed, preserveNeutralChat, restoreNeutralChat, formatCreatorNotes, initChatUtilities, addDOMPurifyHooks } from './scripts/chats.js';
import { getPresetManager, initPresetManager } from './scripts/preset-manager.js';
import { evaluateMacros, getLastMessageId, initMacros } from './scripts/macros.js';
import { currentUser, setUserControls } from './scripts/user.js';
import { getCachedCursor, setCachedCursor, getAllCachedCharacters, getAllCachedHashes, saveCachedCharacters, removeCachedCharacters, clearCharacterCache, getLastVerifiedDigest, setLastVerifiedDigest, getCachedHashesByIds, getWriteFailures, setWriteFailures } from './scripts/character-cache.js';
import { POPUP_RESULT, POPUP_TYPE, Popup, callGenericPopup, fixToastrForDialogs } from './scripts/popup.js';
import { renderTemplate, renderTemplateAsync } from './scripts/templates.js';
import { initScrapers } from './scripts/scrapers.js';
import { initCustomSelectedSamplers, validateDisabledSamplers } from './scripts/samplerSelect.js';
import { DragAndDropHandler } from './scripts/dragdrop.js';
import { INTERACTABLE_CONTROL_CLASS, initKeyboard } from './scripts/keyboard.js';
import { initDynamicStyles } from './scripts/dynamic-styles.js';
import { initInputMarkdown } from './scripts/input-md-formatting.js';
import { AbortReason } from './scripts/util/AbortReason.js';
import { initSystemPrompts } from './scripts/sysprompt.js';
import { registerExtensionSlashCommands as initExtensionSlashCommands } from './scripts/extensions-slashcommands.js';
import { ToolManager } from './scripts/tool-calling.js';
import { addShowdownPatch } from './scripts/util/showdown-patch.js';
import { applyBrowserFixes } from './scripts/browser-fixes.js';
import { initServerHistory } from './scripts/server-history.js';
import { initSettingsSearch } from './scripts/setting-search.js';
import { initBulkEdit } from './scripts/bulk-edit.js';
import { getContext } from './scripts/st-context.js';
import { extractReasoningFromData, extractReasoningSignatureFromData, initReasoning, parseReasoningInSwipes, PromptReasoning, ReasoningHandler, removeReasoningFromString, updateReasoningUI } from './scripts/reasoning.js';
import { accountStorage } from './scripts/util/AccountStorage.js';
import { initWelcomeScreen, openPermanentAssistantChat, openPermanentAssistantCard, getPermanentAssistantAvatar } from './scripts/welcome-screen.js';
import { initDataMaid } from './scripts/data-maid.js';
import { saveDraft, loadDraft, clearDraft } from './scripts/chat-draft.js';
import { clearItemizedPrompts, deleteItemizedPromptForMessage, deleteItemizedPrompts, findItemizedPromptSet, initItemizedPrompts, itemizedParams, itemizedPrompts, loadItemizedPrompts, promptItemize, replaceItemizedPromptText, saveItemizedPrompts, swapItemizedPrompts } from './scripts/itemized-prompts.js';
import { getSystemMessageByType, initSystemMessages, SAFETY_CHAT, sendSystemMessage, system_message_types, system_messages } from './scripts/system-messages.js';
import { event_types, eventSource } from './scripts/events.js';
import { initAccessibility } from './scripts/a11y.js';
import { applyStreamFadeIn } from './scripts/util/stream-fadein.js';
import { initDomHandlers } from './scripts/dom-handlers.js';
import { SimpleMutex } from './scripts/util/SimpleMutex.js';
import { AudioPlayer } from './scripts/audio-player.js';
import { MacroEnvBuilder } from './scripts/macros/engine/MacroEnvBuilder.js';
import { MessageFormatter } from './scripts/message-formatter.js';
import { MacroEngine } from './scripts/macros/engine/MacroEngine.js';
import { addChatBackupsBrowser } from './scripts/chat-backups.js';
import { onboardingExperimentalMacroEngine } from './scripts/macros/engine/MacroDiagnostics.js';
import { compressRequest, setRequestCompressionConfig } from './scripts/request-compression.js';
import { canJumpToSwipeForMessage, canOpenSwipePickerForMessage, initSwipePicker } from './scripts/swipe-picker.js';

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
    event_types,
    eventSource,
    /** @deprecated Use setCharacterSettingsOverrides instead. */
    setCharacterSettingsOverrides as setScenarioOverride,
    /** @deprecated Use appendMediaToMessage instead. */
    appendMediaToMessage as appendImageToMessage,
    /** @deprecated Use getMaxPromptTokens instead. */
    getMaxPromptTokens as getMaxContextSize,
};

/**
 * Wait for page to load before continuing the app initialization.
 */
await new Promise((resolve) => {
    if (document.readyState === 'complete') {
        resolve();
    } else {
        window.addEventListener('load', resolve);
    }
});

// Configure toast library:
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
        // If we have any dialog still open, the last "hidden" toastr will remove the toastr-container. We need to keep it alive inside the dialog though
        // so the toasts still show up inside there.
        fixToastrForDialogs();
    },
};

// Run once during startup
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
/** @type {import('showdown').Converter} */
export let converter;

// array for prompt token calculations

export const systemUserName = 'SillyTavern System';
export const neutralCharacterName = 'Assistant';
let default_user_name = 'User';
export let name1 = default_user_name;
export let name2 = systemUserName;
/** @type {ChatMessage[]} */
export let chat = [];

// ---------------------------------------------------------------------------
//  Immutable messages + slim wire protocol.
//
//  Messages in the chat array are frozen (Object.freeze) after loading from the
//  server or after creation. Every mutation goes through updateMessage(), which
//  replaces the array element with a new frozen object. This makes change detection
//  for the slim wire protocol trivial: reference equality (msg === snapshot) means
//  unchanged, different reference means changed. No hashing, no dirty flags.
//
//  The slim wire protocol replaces unchanged messages with lightweight stubs
//  ({ node_id, _unchanged: true }) on save, reducing payload from O(total messages)
//  to O(changed messages) — measured: 765KB → ~2KB for a 700-message chat.
// ---------------------------------------------------------------------------

/**
 * Deep-freezes an object and all nested objects/arrays. After freezing, any attempt
 * to mutate a property at any level throws a TypeError, enforcing the immutable-message
 * contract all the way down — no nested mutation site can silently bypass updateMessage().
 * @param {*} obj
 * @returns {*} The same object, now frozen
 */
function deepFreeze(obj) {
    if (obj === null || typeof obj !== 'object') return obj;
    if (Object.isFrozen(obj)) return obj;
    Object.freeze(obj);
    for (const val of Object.values(obj)) {
        if (val !== null && typeof val === 'object') {
            deepFreeze(val);
        }
    }
    return obj;
}

/**
 * The single write path for chat messages. Replaces the message at `mesId` with a
 * new deep-frozen object incorporating the given updates. Any attempt to mutate the
 * message at any nesting level throws TypeError — this is the only correct way to
 * change a message.
 *
 * @param {number} mesId Index in the chat array
 * @param {object} updates Partial message to shallow-merge (use spread for nested objects)
 * @returns {object} The new frozen message
 */
export function updateMessage(mesId, updates) {
    const old = chat[mesId];
    if (!old) return old;
    const result = deepFreeze({ ...old, ...updates });
    chat[mesId] = result;
    return result;
}

/**
 * The write path for nested fields. `updateMessage` shallow-merges, so it can only replace
 * whole top-level properties - `{ ...old }` leaves `extra` pointing at the original frozen
 * object, and touching it throws.
 *
 * This copies only the nodes along `path` and shares every other subtree with the old message,
 * so the cost is the depth of the write, not the size of the message. `deepFreeze` stops at
 * anything already frozen, so the freeze walk is the same few nodes.
 *
 *   updateIn(id, ['extra', 'media_index'], 3);
 *   updateIn(id, ['extra', 'media'], list => [...(list ?? []), item]);
 *
 * @param {number} mesId Index in the chat array
 * @param {(string|number)[]} path Property path to write, from the message root
 * @param {*|((current: *) => *)} value New value, or a function from the current value to it
 * @returns {object} The new frozen message, or the existing value if there is no such message
 */
export function updateIn(mesId, path, value) {
    const old = chat[mesId];
    if (!old) return old;

    const rebuild = (node, depth) => {
        if (depth === path.length) {
            return typeof value === 'function' ? value(node) : value;
        }
        const key = path[depth];
        // A missing level is created as an object, matching what the old mutating code did
        // when it wrote through an absent `extra`.
        const src = (node === null || typeof node !== 'object') ? {} : node;
        const copy = Array.isArray(src) ? src.slice() : { ...src };
        copy[key] = rebuild(src[key], depth + 1);
        return copy;
    };

    const result = deepFreeze(rebuild(old, 0));
    chat[mesId] = result;
    return result;
}

/**
 * Snapshot: maps node_id -> message reference, taken after load/save.
 * Reference equality against the snapshot is the change-detection mechanism.
 * With deep-frozen messages, in-place mutation is impossible (throws TypeError),
 * so reference equality is sufficient — no hash safety net needed.
 * @type {Map<string, object>}
 */
/** @type {((mesId: number, message?: object) => boolean) | null} */
let _hasForkBranches = null;
import('./scripts/bookmarks.js').then(m => { _hasForkBranches = m.hasForkBranches; });

const _messageSnapshots = new Map();

/**
 * Takes a snapshot of all messages with node_id.
 * Called after loading a chat and after each successful save.
 */
function _snapshotMessages() {
    _messageSnapshots.clear();
    for (const msg of chat) {
        if (msg.node_id) {
            _messageSnapshots.set(msg.node_id, msg);
        }
    }
}

/**
 * Builds a slim payload: unchanged messages (same reference as snapshot) become stubs,
 * changed/new messages are sent with full content. With deep-frozen messages, in-place
 * mutation is impossible, so reference equality is a complete change-detection mechanism.
 * @param {object[]} messages
 * @returns {object[]}
 */
function _buildSlimPayload(messages) {
    return messages.map(msg => {
        if (msg.node_id && _messageSnapshots.get(msg.node_id) === msg) {
            return { node_id: msg.node_id, _unchanged: true };
        }
        return msg;
    });
}

// ---------------------------------------------------------------------------
//  Provisional node ids.
//
//  A greeting that lives on the character card and has never been used has no row in the tree - and
//  it should not get one just for being looked at, or a card with a thousand greetings mints a
//  thousand rows the moment someone swipes through them.
//
//  The obvious encoding of that is a missing node_id, and it is what this used to do. It meant every
//  reader of chat[0].node_id had to know whether the opening was "real yet", and each one answered
//  differently: the hole repair read it as "not tree-backed", the merge read it as "card text", the
//  save read it as "brand new alternative to create". One absent field standing for three different
//  facts is what made greeting handling fragile.
//
//  So an unstored greeting carries an id too - one derived from its own content, so it is stable
//  across reloads and identical wherever the same greeting appears. Every consumer can then just use
//  the id it is handed: as a map key, an equality check, a slot marker. Only the handful of places
//  that genuinely need a ROW (appending after it, labelling it, forking at it, editing it) have to
//  ask, and they all go through ensureOpeningRow(), which is the single writer that turns a
//  provisional id into a real one.
//
//  The scheme mirrors the server's own message identity (nodeIdentityKey in message-tree-db.js):
//  speaker plus text, nothing else. It deliberately does NOT reproduce the server's hash - nothing
//  looks a provisional id up server-side, and cyrb53 is available synchronously here where sha1 is
//  not. The prefix is what makes "is this a real row" a total, local question.
// ---------------------------------------------------------------------------

const PROVISIONAL_NODE_PREFIX = 'card:';

/**
 * The id an unstored card greeting carries. Content-derived, so the same greeting is the same id in
 * every chat and across reloads.
 * @param {string} speaker who says it - part of identity, same as server-side
 * @param {string} mes the greeting text
 * @returns {string}
 */
function provisionalNodeId(speaker, mes) {
    return PROVISIONAL_NODE_PREFIX + getStringHash(`c${speaker ?? ''} ${mes ?? ''}`);
}

/** True when this id names a row that actually exists in the tree. */
export function isStoredNodeId(nodeId) {
    return typeof nodeId === 'string' && nodeId.length > 0 && !nodeId.startsWith(PROVISIONAL_NODE_PREFIX);
}

/** True when this id stands for a greeting the card has and the tree does not. */
export function isProvisionalNodeId(nodeId) {
    return typeof nodeId === 'string' && nodeId.startsWith(PROVISIONAL_NODE_PREFIX);
}

/**
 * @type {import('./scripts/constants.js').SWIPE_STATE}
 */
export let swipeState = SWIPE_STATE.NONE;
let chatSaveTimeout;
let importFlashTimeout;
export let isChatSaving = false;
let firstRun = false;
export let settingsReady = false;
let currentVersion = '0.0.0';
export let displayVersion = 'SillyTavern';

let generation_started = new Date();
/** @type {Character[]} */
export let characters = [];
/**
 * Read-path backing store for `characters` (see entity-store.js) - wraps the same array in place, so every
 * other read call site in this file (and every other file that imports `characters` directly) keeps working
 * completely unchanged. `characters` itself is never reassigned to a new array reference (unlike `tags` during
 * settings load), so this doesn't need a rebuild-on-reassignment hook the way tagsStore does.
 *
 * Unlike tags, character lifecycle mutations (create/delete/rename/duplicate) are not targeted array
 * push/splice-by-id - they're all implemented (server-side and client-side) as a bulk refetch-and-merge via
 * getCharacters(). getCharacters() itself merges the refetched data field-by-field into the existing array in
 * place (adding/removing entries as needed, but never wholesale-replacing an existing entity - see its own
 * comment) and calls charactersStore.reindex()/reset() as appropriate; callers that know a specific
 * create/delete/rename happened report it via
 * charactersStore.reportCreated()/.reportRemoved()/.reportRenamed() instead of the generic reset(), so
 * consumers hear the specific thing that happened rather than "something changed, go re-scan".
 * @type {EntityStore<Character>}
 */
export const charactersStore = new EntityStore(characters, c => c.avatar);
// Consumer side of the characters migration (mutation side landed in the commits referenced above): the
// persistent character search index (power-user.js) needs invalidating after any character data change, same
// as tags.js already does for tagsStore/tagMapStore. One subscriber here replaces what used to be manual
// invalidateCharactersFuseIndex() calls at each individual mutation site (getOneCharacter, getCharacters).
// Deliberately not narrowed to specific ops/fields - invalidateCharactersFuseIndex() just sets a dirty flag,
// the actual rebuild is lazy on next search, so over-invalidating on e.g. a `.chat`-only update() costs nothing.
charactersStore.onChange(() => invalidateCharactersFuseIndex());
/**
 * Avatar (stable id, see charactersStore) of the currently selected character. This is the source of truth for
 * character selection. Never assign this directly - go through setCharacterId().
 * @type {string|undefined}
 */
let this_avatar;

/**
 * Resolves the currently selected character by identity (this_avatar), not by array position. Forward-looking:
 * once the `characters` array can stop being a full resident copy of every character (server-side list
 * pagination), the *selected* character still needs to resolve correctly regardless of what page the list UI
 * is showing. No pagination has landed yet, so `characters` is still the full array.
 * @returns {Character|undefined}
 */
export function getCurrentCharacter() {
    return this_avatar !== undefined ? charactersStore.get(this_avatar) : undefined;
}

/**
 * Resolves what is currently selected: a character, a group, or neither (the neutral/temp-chat state,
 * `name2 === neutralCharacterName`). Selection is a tristate, not a boolean - see
 * docs/design/character-data-residency-redesign.md §2.3 - and this is the one place that classifies it,
 * replacing the `this_chid === undefined && !selected_group` conjunction that used to be repeated at every
 * call site needing to know which of the three states is live. Callers that also need to confirm the
 * neutral-chat name2 invariant (rather than just "no character and no group") still check that themselves -
 * it's an orthogonal signal, not folded in here.
 * @returns {{ type: 'character', avatar: string } | { type: 'group', groupId: string } | { type: 'none' }}
 */
export function getSelectionState() {
    if (selected_group) {
        return { type: 'group', groupId: selected_group };
    }
    if (this_avatar !== undefined) {
        return { type: 'character', avatar: this_avatar };
    }
    return { type: 'none' };
}

let saveCharactersPage = 0;

// Last known match total for the server-paginated character list (design doc §6's dynamic-total branch below) -
// mirrors saveCharactersPage's "survive a full .pagination({...}) reconstruction" job, but for the total instead
// of the page. Needed because pagination.js's own dynamic-total-number boot path (public/lib/pagination.js's
// observer(), `validTotalPage = Math.max(self.getTotalPage(), 1)`) has no way to know the real total before its
// first ajax response lands - self.getTotalNumber() falls through to 0 at construction time whenever
// totalNumberLocator is set and no `attributes.totalNumber` was supplied. With no seed, EVERY re-render
// (printCharactersDebounced() on a search keystroke, tag toggle, sort/filter change - any of which reconstructs
// this plugin from scratch) clamps `Math.min(defaultPageNumber, validTotalPage)` down to 1 regardless of
// `pageNumber: saveCharactersPage || 1`, so a user mid-way through the list gets silently bounced back to a page-1
// request, and - worse - the synchronous `render(true)` boot shell (built before that request even fires) briefly
// shows the "0 of 0" empty state on the currently-rendered page until the real response arrives. That gap is
// normally too fast to see, but it's exactly what surfaces when the server is busy (e.g. a concurrent local-import
// batch competing for the event loop/SQLite) and the response is slow enough to notice. Seeding `totalNumber` here
// keeps `validTotalPage` honest from the very first synchronous render, so a reconstruction re-requests the page
// the user was actually on instead of quietly resetting to 1 (see the `resetPageNumberOnInit: false` pairing
// below - the seed alone isn't enough, since resetPageNumberOnInit's own force-to-1 branch fires independently).
let saveCharactersTotal = 0;
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
/** @type {ChatMetadata} */
export let chat_metadata = {};
/** @type {StreamingProcessor} */
export let streamingProcessor = null;
let crop_data = undefined;

/**
 * Snapshot of form field values captured when the character editor is populated.
 * Used by createOrEditCharacter() to detect whether any field actually changed,
 * preventing spurious saves that trigger shouldRegenerateMessage and corrupt chat state.
 * @type {Object<string, string>|null}
 */
let _characterFormSnapshot = null;

/** The form field IDs that make up the character card content (excludes db-authoritative
 *  fields like the chat pointer, which are handled through dedicated APIs). */
const CHARACTER_FORM_FIELDS = [
    '#character_name_pole', '#description_textarea', '#personality_textarea',
    '#scenario_pole', '#mes_example_textarea',
    '#creator_notes_textarea', '#system_prompt_textarea', '#post_history_instructions_textarea',
    '#tags_textarea', '#creator_textarea', '#character_version_textarea',
    '#talkativeness_slider', '#depth_prompt_prompt', '#depth_prompt_depth',
    '#depth_prompt_role', '#character_world',
];

/**
 * Maps form field IDs to their card paths. Used to build merge-attributes payloads
 * with only the fields the user actually changed, and to compute per-field loaded-value
 * hashes for conflict detection.
 * @type {Object<string, {v1?: string, v2: string, transform?: string}>}
 */
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
};

let is_delete_mode = false;
let fav_ch_checked = false;
let scrollLock = false;
export let abortStatusCheck = new AbortController();
export let charDragDropHandler = null;
export let chatDragDropHandler = null;

/** @type {debounce_timeout} The debounce timeout used for chat/settings save. debounce_timeout.long: 1.000 ms */
export const DEFAULT_SAVE_EDIT_TIMEOUT = debounce_timeout.relaxed;
/** @type {debounce_timeout} The debounce timeout used for printing. debounce_timeout.quick: 100 ms */
export const DEFAULT_PRINT_TIMEOUT = debounce_timeout.quick;

const _debouncedSaveImpl = debounce(() => saveSettings(), DEFAULT_SAVE_EDIT_TIMEOUT);
/**
 * Debounced settings save. When called with top-level settings key name(s) (the keys of the settings payload
 * object that the surrounding code just mutated), accumulates them and fires a partial save via
 * /api/settings/save-partial when the debounce triggers - sending only the named keys instead of the full
 * ~148KB blob. When called with no arguments (backward compat for unmigrated call sites or direct
 * saveSettings() callers), triggers a full save via /api/settings/save as before.
 *
 * Multiple calls within the debounce window merge their keys: saveSettingsDebounced('power_user') followed by
 * saveSettingsDebounced('oai_settings') within the same window sends both keys in a single partial save.
 * @param {...string} keys Top-level payload key name(s) that were mutated (e.g. 'power_user', 'oai_settings')
 */
export function saveSettingsDebounced(...keys) {
    for (const key of keys) {
        if (typeof key === 'string') pendingSettingsKeys.add(key);
    }
    _debouncedSaveImpl();
}
export const saveCharacterDebounced = debounce(() => $('#create_button').trigger('click'), DEFAULT_SAVE_EDIT_TIMEOUT);

/**
 * Prints the character list in a debounced fashion without blocking, with a delay of 100 milliseconds.
 * Use this function instead of a direct `printCharacters()` whenever the reprinting of the character list is not the primary focus.
 *
 * The printing will also always reprint all filter options of the global list, to keep them up to date.
 */
export const printCharactersDebounced = debounce(() => { printCharacters(false); }, DEFAULT_PRINT_TIMEOUT);

const getCharactersDebounced = debounce(() => getCharacters(), 2000);

function setupCharacterChangeStream() {
    if (typeof EventSource === 'undefined') return;
    const source = new EventSource('/api/characters/changes/stream');
    source.onmessage = () => {
        if (menu_type === 'characters') {
            getCharactersDebounced();
        } else {
            _charactersDirty = true;
        }
    };
    source.onerror = () => {
        // EventSource auto-reconnects on error; nothing to do
    };
}

/**
 * Keeps an SSE connection open for as long as this tab is alive, so the server can tell (at its next boot)
 * that a browser tab is already open and skip auto-launching a new one. `EventSource` auto-reconnects on
 * its own, which is what lets this tab "still count" through a server restart.
 */
function setupBrowserHeartbeat() {
    if (typeof EventSource === 'undefined') return;
    new EventSource('/api/browser-heartbeat');
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

/**
 * Builds the chat-draft context for whatever chat is currently loaded, for use with chat-draft.js's
 * saveDraft/loadDraft/clearDraft. Returns null when there's no fully-resolved chat to scope a draft to (e.g.
 * no character/group selected yet, or a group with no chat_id) - callers must treat that as "don't
 * save/load/clear anything", not fall back to some shared key that unrelated chats could collide on.
 * @returns {{type: 'character'|'group', id: string, chatId: string}|null} The current draft context, or null.
 */
function getCurrentDraftContext() {
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
 * Saves the current `#send_textarea` content as the draft for whatever chat is currently loaded. Synchronous
 * (localStorage.setItem doesn't wait on anything), so it's safe to call directly - not just through the
 * debounced wrapper - right before an unavoidable page reload (see the chat-integrity-conflict path below),
 * where waiting for the debounce to fire on its own is not guaranteed.
 */
function flushDraftSave() {
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
const per_page_default = 50;

var is_advanced_char_open = false;

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
/**
 * Hash of the JSON-stringified payload from the most recent successful /api/settings/save call, or null before
 * the first one this session. saveSettings() rebuilds its payload object from scratch on every call (679 call
 * sites share saveSettingsDebounced(), several of which fire on blur/focusout/change with no dirty-check of
 * their own), so a fresh object each time makes reference-equality useless - this lets saveSettings() skip the
 * POST (and the write-file-atomic disk write it triggers server-side) when nothing in the payload actually
 * changed since the last save, without requiring every call site to remember to check itself.
 * @type {number|null}
 */
let lastSavedSettingsHash = null;
/**
 * Hash of the settings content this client currently believes is persisted on the server, in the exact string
 * form the server itself reads/writes (JSON.stringify(..., null, 4) - see /api/settings/save in settings.js).
 * Set from the raw string /api/settings/get returns (that string IS the on-disk content verbatim), and updated
 * again after each successful save to the string this client just wrote. Sent back on the next save as
 * X-Settings-Hash so the server can detect whether some other tab/device wrote in between and reject the save
 * instead of silently clobbering that write - see checkSettingsConflict() server-side.
 *
 * Deliberately distinct from lastSavedSettingsHash above: that one hashes a *compact*, same-session-only string
 * purely to skip redundant same-tab POSTs, and is never set from a /get. This one has to match the server's
 * on-disk byte format exactly (since it's compared against a hash of those exact bytes) and has to exist before
 * this tab's first save of the session, seeded from /get.
 * @type {number|null}
 */
let knownServerSettingsHash = null;
/**
 * Top-level settings keys accumulated since the last debounced save fired. When saveSettingsDebounced() is
 * called with key name(s), they're collected here; when the debounce triggers, saveSettings() drains this set
 * and sends only those keys via /api/settings/save-partial instead of the full ~148KB blob. Empty means no
 * caller specified keys (backward compat / unmigrated call site), which falls through to the full /save path.
 */
const pendingSettingsKeys = new Set();
/**
 * Per-key content hashes of what this client believes the server currently has. Keyed by top-level
 * settings key or dotted sub-path (e.g. 'power_user.font_scale'). Used for two things in the
 * partial save path: (1) diffing live values against the server to find which sub-fields actually
 * changed, and (2) sending expectedHashes to the server for conflict detection. Populated from the
 * parsed settings in getSettings(), updated with hashes (not values) after each successful save.
 *
 * This replaces the old approach of maintaining `settings` as a value mirror - storing just hashes
 * means the save path never needs a second copy of the actual state, so the aliasing between
 * `settings.power_user` and the live `power_user` export that caused spurious 409s can't happen.
 * @type {Record<string, number>}
 */
const serverKeyHashes = {};
/** Module-scope retry counter for TempResponseLength customization, replacing the old loopCounter parameter. */
let _saveRetryCounter = 0;
export let amount_gen = 80; //default max length of AI generated responses
export let max_context = 2048;

/** User preference for swipeable messages */
let swipes = true;
/** Forcefully hide swipes. */
export let swipesHidden = false;
/** @type {{ now: number, direction: string }} */
export let lastSwipeInfo = { now: performance.now(), direction: SWIPE_DIRECTION.RIGHT };
export let recentSwipes = 0;

export let extension_prompts = {};

export let main_api;// = "kobold";
let abortController = new AbortController();

//css
var css_send_form_display = $('<div id=send_form></div>').css('display');

var kobold_horde_model = '';

export let token;


/** The tag of the active character. (NOT the id) */
export let active_character = '';
/** The tag of the active group. (Coincidentally also the id) */
export let active_group = '';

export const entitiesFilter = new FilterHelper(printCharactersDebounced);

export function getRequestHeaders({ omitContentType = false } = {}) {
    const headers = {
        'Content-Type': 'application/json',
        'X-CSRF-Token': token,
    };

    if (omitContentType) {
        delete headers['Content-Type'];
    }

    return headers;
}

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
        token = tokenData.token;
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

    // Boot stage timing
    const bootStart = performance.now();
    /** @type {{stage: string, ms: number}[]} */
    const stageTimings = [];
    let stageStart = bootStart;
    let currentStageLabel = 'Init';

    function setStage(label) {
        const now = performance.now();
        const elapsed = now - stageStart;
        stageTimings.push({ stage: currentStageLabel, ms: elapsed });

        // Add completed stage to the on-screen log
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

    // Boot-residency decoupling (docs/design/boot-residency-decoupling.md): the full character/group fetch no
    // longer gates first paint. `printCharacters(true)` right below this renders via the server-query path
    // (`canUseServerQueryForEntitiesList()`) whenever eligible - the common boot case (no restored search, a
    // queryable sort field) - which needs no local `characters`/`groups` residency at all, so it's safe to call
    // before either array is populated. This promise is awaited later, right before APP_READY, so nothing that
    // genuinely assumes full residency by the time APP_READY fires (extensions included - see the design doc's
    // §5 "what this doc does not know" on extension compatibility) observes any behavior change; only the visual
    // first paint moves earlier. `getCharacters()` (via its own trailing `printCharacters(true)`) already redraws
    // itself once real data lands, so the ineligible-boot-state case (an active search restored from session, or
    // a non-server-queryable sort field - design doc §3) still converges to a correct render, just not the very
    // first one. Tag assignments are seeded via `seedTagMapFromRecords()` (tags.js), called right after
    // `getCharacters()` inside this promise — character tags are derived from each character's `tag_ids`
    // field (already part of the shallow record), and group tags are fetched separately in one small
    // `/api/tags/for` call, not blocking first paint since this promise runs concurrently with the initial render.
    let residencyResolved = false;
    const characterResidencyPromise = (async () => {
        await getCharacters();
        // Must run after getCharacters() (which also awaits getGroups() internally), since building the
        // tag_map needs both the populated `characters` array and the group ids to fetch group tags for.
        await seedTagMapFromRecords();
    })();
    characterResidencyPromise.then(() => { residencyResolved = true; });

    setStage('Rendering characters');
    await printCharacters(true);
    setupCharacterChangeStream();
    setupBrowserHeartbeat();

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

    // Record final stage timing and stop the live elapsed display
    stageTimings.push({ stage: currentStageLabel, ms: performance.now() - stageStart });
    clearInterval(elapsedInterval);

    // Log boot timing summary to console
    const totalMs = performance.now() - bootStart;
    console.groupCollapsed(`[Boot] Completed in ${(totalMs / 1000).toFixed(2)}s`);
    console.table(stageTimings.map(s => ({ Stage: s.stage, Duration: `${(s.ms / 1000).toFixed(2)}s` })));
    console.groupEnd();

    await initLoaderHandle.hide();
    await fixViewport();
    // Full character/group residency (and the tag-map seed that depends on it) is awaited here rather than
    // earlier - see this function's own comment above `characterResidencyPromise` - so APP_READY keeps its
    // pre-existing guarantee (full residency by the time it fires) even though the splash screen itself no
    // longer waits on it.
    if (!residencyResolved) {
        const residencyWaitStart = performance.now();
        await characterResidencyPromise;
        console.log(`[Boot] Character residency resolved ${((performance.now() - residencyWaitStart) / 1000).toFixed(2)}s after splash`);
    } else {
        await characterResidencyPromise;
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

/**
 * Sets the currently active character
 * @param {object|number|string} [entityOrKey] - An entity with id property (character, group, tag), or directly an id or tag key. If not provided, the active character is reset to `null`.
 */
export function setActiveCharacter(entityOrKey) {
    active_character = entityOrKey ? getTagKeyForEntity(entityOrKey) : null;
    if (active_character) active_group = null;
}

/**
 * Sets the currently active group.
 * @param {object|number|string} [entityOrKey] - An entity with id property (character, group, tag), or directly an id or tag key. If not provided, the active group is reset to `null`.
 */
export function setActiveGroup(entityOrKey) {
    active_group = entityOrKey ? getTagKeyForEntity(entityOrKey) : null;
    if (active_group) active_character = null;
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

/**
 * Switches the currently selected character to the one with the given avatar (stable id). This is the primary
 * selection logic - prefer this over selectCharacterById() everywhere internally, since avatar is the source
 * of truth (this_avatar - see setCharacterId()'s doc comment) and this needs no array-index lookup at all.
 *
 * If the character doesn't exist, if the chat is being saved, or if a group is being generated, this function
 * does nothing. If the character is different from the currently selected one, it will clear the chat and
 * reset any selected character or group.
 * @param {string} avatar The avatar (stable id) of the character to switch to.
 * @param {object} [options] Options for the switch.
 * @param {boolean} [options.switchMenu=true] Whether to switch the right menu to the character edit menu if the character is already selected.
 * @returns {Promise<void>} A promise that resolves when the character is switched.
 */
export async function selectCharacterByAvatar(avatar, { switchMenu = true } = {}) {
    const entity = charactersStore.get(avatar);
    if (!entity) {
        return;
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
        if (!is_send_press) {
            setCharacterId(undefined);
            setCharacterName('');
            resetSelectedGroup();
            await clearChat({ clearData: true });
            cancelTtsPlay();
            this_edit_mes_id = undefined;
            selected_button = 'character_edit';
            setCharacterId(entity);
            chat_metadata = {};
            await getChat();
        }
    } else {
        //if clicked on character that was already selected
        switchMenu && (selected_button = 'character_edit');
        await unshallowCharacter(avatar);
        select_selected_character(avatar, { switchMenu });
    }
}

/**
 * Switches the currently selected character to the one with the given ID. (character index, not the character key!)
 * Thin wrapper around selectCharacterByAvatar() kept only for the public extension API
 * (context.selectCharacterById, st-context.js) - the DOM no longer carries a data-chid to read an index from,
 * and no internal caller uses this anymore. Internal code should call selectCharacterByAvatar() directly.
 * @param {number} id The ID of the character to switch to.
 * @param {object} [options] Options for the switch.
 * @param {boolean} [options.switchMenu=true] Whether to switch the right menu to the character edit menu if the character is already selected.
 * @returns {Promise<void>} A promise that resolves when the character is switched.
 */
export async function selectCharacterById(id, { switchMenu = true } = {}) {
    const avatar = characters[id]?.avatar;
    if (avatar === undefined) {
        return;
    }
    await selectCharacterByAvatar(avatar, { switchMenu });
}

function getBackBlock() {
    const template = $('#bogus_folder_back_template .bogus_folder_select').clone();
    return template;
}

async function getEmptyBlock() {
    const icons = ['fa-dragon', 'fa-otter', 'fa-kiwi-bird', 'fa-crow', 'fa-frog'];
    const texts = [t`Here be dragons`, t`Otterly empty`, t`Kiwibunga`, t`Pump-a-Rum`, t`Croak it`];
    const roll = new Date().getMinutes() % icons.length;
    const params = {
        text: texts[roll],
        icon: icons[roll],
    };
    const emptyBlock = await renderTemplateAsync('emptyBlock', params);
    return $(emptyBlock);
}

/**
 * @param {number} hidden Number of hidden characters
 */
async function getHiddenBlock(hidden) {
    const params = {
        text: (hidden > 1 ? t`${hidden} characters hidden.` : t`${hidden} character hidden.`),
    };
    const hiddenBlock = await renderTemplateAsync('hiddenBlock', params);
    return $(hiddenBlock);
}

/**
 * Populates a `.character_select` template (freshly cloned, or an existing row being reused across a
 * re-render - see `printCharacters`'s keyed diff) with a character's current data.
 * @param {JQuery<HTMLElement>} template The `.character_select` element to populate, already in the DOM tree
 * or detached
 * @param {object} item Character entity data
 * @param {string} id Character id (the avatar)
 */
function renderCharacterBlock(template, item, id) {
    let this_avatar = default_avatar;
    if (item.avatar && item.avatar != 'none') {
        // The gallery-style browsing view displays card art at a size where the 96x144 thumbnail would be
        // visibly upscaled, so always use the original image via /characters/<file> (the same path the
        // zoomed-avatar viewer uses). Lazy loading (loading="lazy" below) ensures only visible cards fetch.
        this_avatar = `/characters/${encodeURIComponent(item.avatar)}`;
    }
    template.attr({ 'data-avatar': item.avatar });
    // loading="lazy": without this, every rendered card's <img> starts fetching its thumbnail immediately -
    // on an install with Characters_PerPage bumped up (the size-changer dropdown goes up to 1000) or a broad
    // search match, that's hundreds of simultaneous GET requests firing the instant the list re-renders. HTTP/1.1
    // caps this browser to ~6 concurrent connections per origin (see server-startup.js - this server is plain
    // http.createServer(), not http2), so the excess queues - and *any other request issued during that window*
    // (including the very next debounced search-as-you-type fetch) queues right behind them, showing up in
    // devtools as many seconds of "Blocked" even though the server itself answered in tens of milliseconds.
    // Native lazy loading defers off-screen images until they're about to scroll into view, so only the
    // actually-visible rows fire immediately - confirmed via CDP repro against this install's real 24,171-
    // character library: a broad search rendered 500 cards and 500 concurrent thumbnail requests, which is
    // exactly the request-storm this fixes.
    template.find('img').attr('src', this_avatar).attr('loading', 'lazy').attr('alt', item.name);
    template.find('.avatar').attr('title', `[Character] ${item.name}\nFile: ${item.avatar}`);
    template.find('.ch_name').text(item.name).attr('title', `[Character] ${item.name}`);
    template.find('.ch_avatar_url').text(power_user.show_card_avatar_urls ? item.avatar : '');
    template.find('.ch_fav_icon').css('display', 'none');
    template.toggleClass('is_fav', item.fav || item.fav == 'true');
    template.find('.ch_fav').val(item.fav);

    // .toggle() rather than the original one-shot .remove(), so this stays correct when re-run against a
    // row that's being reused in place instead of freshly cloned (see printCharacters).
    const isAssistant = item.avatar === getPermanentAssistantAvatar();
    template.find('.ch_assistant').toggle(isAssistant);

    // .toggleClass('displayNone', ...) rather than .toggle(bool): jQuery's .toggle()/.show() implement
    // "visible" by writing an inline style="display: block" onto the element (not by clearing a class), which
    // outranks any class-based CSS selector - including toggle-dependent.css's
    // `body.charListGrid #rm_print_characters_block .ch_description`/`.character_version` grid-view-hide
    // rules. Once a row's description/version had been shown at all, that inline style stuck around
    // (persisting across grid<->list toggles and, with the keyed-diff reuse in printCharacters, across
    // re-renders too) and permanently defeated the grid-view hide rule for that row. Toggling a class instead
    // never writes an inline style, so the grid rule (and any future view mode) stays free to hide these
    // purely through the cascade.
    const description = item.data?.creator_notes || '';
    template.find('.ch_description').text(description).toggleClass('displayNone', !description);

    const auxFieldName = power_user.aux_field || 'character_version';
    const auxFieldValue = (item.data && item.data[auxFieldName]) || '';
    template.find('.character_version').text(auxFieldValue).toggleClass('displayNone', !auxFieldValue);

    // Display inline tags. printTagList() clears and rebuilds this container itself, so it's already
    // safe to call against a reused row.
    const tagsElement = template.find('.tags');
    printTagList(tagsElement, { forEntityOrKey: id, tagOptions: { isCharacterList: true } });
}

function getCharacterBlock(item, id) {
    const template = $('#character_template .character_select').clone();
    renderCharacterBlock(template, item, id);
    return template;
}

/**
 * Updates an existing character row in place with fresh data, instead of tearing it down and rebuilding
 * it from the template. Used by printCharacters's keyed diff for rows whose avatar is still on the page.
 * @param {HTMLElement} node The existing `.character_select` element for this avatar
 * @param {object} item Character entity data
 * @param {string} id Character id (the avatar)
 * @returns {HTMLElement} The same node, updated
 */
function updateCharacterBlock(node, item, id) {
    renderCharacterBlock($(node), item, id);
    return node;
}

/**
 * Prints the global character list, optionally doing a full refresh of the list
 * Use this function whenever the reprinting of the character list is the primary focus, otherwise using `printCharactersDebounced` is preferred for a cleaner, non-blocking experience.
 *
 * The printing will also always reprint all filter options of the global list, to keep them up to date.
 *
 * @param {boolean} fullRefresh - If true, the list is fully refreshed and the navigation is being reset
 */
/**
 * The `dataSource`+`ajaxFunction` combination is what actually gets a real per-page server request out of
 * pagination.js (`public/lib/pagination.js`), not its literal "dataSource as a function" form - that form
 * (`parseDataSource`) only defers the *initial* fetch by one tick and then re-enters the plain-array branch, so
 * every later page turn still slices a fully materialized local array. `dataSource` as a *string* instead flips
 * the plugin into `isAsync` mode, and every `go()` (page turn, size-changer change, `.pagination('go', n)`) then
 * calls `ajaxFunction` fresh with that page's `pageNumber`/`pageSize` - a real request per page turn, which is
 * what design doc §6 ("printCharacters()'s pagination becomes a controller... instead of a slicer") asks for.
 * The string value itself is never fetched (see below); it only has to be a string to select this code path.
 */
const SERVER_PAGINATED_DATA_SOURCE = '/api/characters/query';

export async function printCharacters(fullRefresh = false) {
    const storageKey = 'Characters_PerPage';
    const listId = '#rm_print_characters_block';

    let currentScrollTop = $(listId).scrollTop();

    if (fullRefresh) {
        saveCharactersPage = 0;
        saveCharactersTotal = 0;
        currentScrollTop = 0;
        await delay(1);
    }

    // Before printing the personas, we check if we should enable/disable search sorting
    verifyCharactersSearchSortRule();

    // We are actually always reprinting filters, as it "doesn't hurt", and this way they are always up to date
    printTagFilters(tag_filter_type.character);
    printTagFilters(tag_filter_type.group_members_list);
    printTagFilters(tag_filter_type.group_candidates_list);

    // We are also always reprinting the lists on character/group edit window, as these ones doesn't get updated otherwise
    applyTagsOnCharacterSelect();
    applyTagsOnGroupSelect();

    const pageSize = Number(accountStorage.getItem(storageKey)) || per_page_default;
    const sizeChangerOptions = [10, 25, 50, 100, 250, 500, 1000];

    /**
     * Shared page-render callback, parameterized over how the caller knows the current match-count-for-the-
     * "N hidden"-badge (design doc §4.1) - the two `printCharacters()` paths below know that differently (one
     * has the whole filtered array resident, the other only ever holds one page), but the DOM diff / back-block
     * / empty-block / hidden-badge rendering itself must not drift between them.
     * @param {() => number} getMatchTotal
     */
    function makePageCallback(getMatchTotal) {
        return async function (/** @type {Entity[]} */ data) {
            const list = $(listId).get(0);

            // Keyed diff for character rows: index the currently-rendered rows by avatar *before* touching
            // the DOM. A row whose avatar is still present on the new page gets moved into the new fragment
            // and updated in place (updateCharacterBlock) instead of being torn down and rebuilt from the
            // template - this used to happen to every visible card on every debounced search keystroke, even
            // though most of the time the underlying character list hadn't actually changed, only the
            // filter/sort/page had. Groups and tags aren't keyed here (out of scope for this pass;
            // they're far fewer per page than character rows) and keep being rebuilt every render, same as
            // before.
            const existingCharacterRows = new Map();
            for (const child of list.children) {
                if (child instanceof HTMLElement && child.hasAttribute('data-avatar')) {
                    existingCharacterRows.set(child.getAttribute('data-avatar'), child);
                }
            }

            // Build all rows into a detached DocumentFragment first, and append it once. Appending elements
            // one by one into the live (attached, display:flex) list forces a reflow per row; batching this
            // way costs one reflow for the whole page instead of one per row (up to 500/page on this install).
            // Moving a still-attached node into this fragment (fragment.appendChild) detaches it from `list`
            // automatically, which is what makes the plain `list.replaceChildren()` below safe: by the time
            // it runs, every row worth keeping has already been moved out into the fragment.
            const fragment = document.createDocumentFragment();
            for (const i of data) {
                switch (i.type) {
                    case 'character': {
                        const existingRow = existingCharacterRows.get(i.item.avatar);
                        if (existingRow) {
                            existingCharacterRows.delete(i.item.avatar);
                            fragment.appendChild(updateCharacterBlock(existingRow, i.item, i.id));
                        } else {
                            fragment.appendChild(getCharacterBlock(i.item, i.id).get(0));
                        }
                        break;
                    }
                    case 'group':
                        fragment.appendChild(getGroupBlock(i.item).get(0));
                        break;
                    case 'tag':
                        fragment.appendChild(getTagBlock(i.item, i.entities, i.hidden, i.isUseless).get(0));
                        break;
                }
            }

            // Whatever's left in `list` now is either a structural row from the previous render (back-block
            // /empty-block/hidden-block) or a character row that fell off this page (filtered out, or paged
            // away) - none of it survives into the new render, so a full clear here is correct, not wasteful.
            list.replaceChildren();
            if (power_user.bogus_folders && isBogusFolderOpen()) {
                $(list).append(getBackBlock());
            }
            if (!data.length) {
                const emptyBlock = await getEmptyBlock();
                $(list).append(emptyBlock);
            }
            list.appendChild(fragment);

            // design doc §4.1: this used to be `(characters.length + groups.length) - displayCount`, which
            // conflated "filtered out by the active filter" with "not on this page" - a multi-page result with
            // an active filter would show a nonsensical "N hidden" count that was really just every item on
            // every *other* page. `getMatchTotal()` is the real match count for the active filter, independent
            // of which page is currently showing - the library-wide total minus that is the real "hidden by
            // filter" count.
            const hidden = (characters.length + groups.length) - getMatchTotal();
            if (hidden > 0 && entitiesFilter.hasAnyFilter()) {
                const hiddenBlock = await getHiddenBlock(hidden);
                $(listId).append(hiddenBlock);
            }
            localizePagination($('#rm_print_characters_pagination'));

            eventSource.emit(event_types.CHARACTER_PAGE_LOADED);
        };
    }

    const sharedPaginationOptions = {
        pageSize,
        pageRange: 1,
        pageNumber: saveCharactersPage || 1,
        position: 'top',
        showPageNumbers: false,
        showSizeChanger: true,
        prevText: '<',
        nextText: '>',
        formatNavigator: PAGINATION_TEMPLATE,
        formatSizeChanger: renderPaginationDropdown(pageSize, sizeChangerOptions),
        showNavigator: true,
        afterSizeSelectorChange: function (e, size) {
            accountStorage.setItem(storageKey, e.target.value);
            paginationDropdownChangeHandler(e, size);
        },
        afterPaging: function (e) {
            saveCharactersPage = e;
        },
        afterRender: function () {
            $(listId).scrollTop(currentScrollTop);
        },
    };

    // Pre-existing fully-local path, preserved exactly: an active search term with no queryable state, an
    // `isInvalidSortFieldError()` rejection from the server branch below (a sort field the server genuinely
    // doesn't have a column for), or any other case `canUseServerQueryForEntitiesList()` declines - the whole
    // filtered/sorted candidate set is materialized client-side and the plugin slices it in memory on page turn.
    async function renderLocalPaginated() {
        const entities = await getEntitiesList({ doFilter: true });

        // When a search term is active, `entities` was narrowed by `entitiesFilter.serverSearchResults`
        // (searchFilter(), filters.js), which is itself capped at the server's page-fetch limit
        // (POST /api/characters/all's `DEFAULT_PAGE_LIMIT`, characters.js) - so `entities.length` here can be
        // far smaller than the real match count. Without this override the navigator would render e.g.
        // "1-500 .. 500" - individually correct against the capped `entities` array, but silently wrong against
        // the real match count `entitiesFilter.serverSearchResults` (fetchServerCharacterSearchResults()) already
        // knows. `entities.length` still drives the actual page-turn math (`pageSize`/`totalPage` derive from it,
        // unaffected by this override) - only the displayed total number changes, since paging itself genuinely
        // can't go past what the server actually sent down. (2026-08: this list used to also carry its own
        // separate "Showing X of Y matches" text next to the navigator, computed by a second independent fetch -
        // removed as pure duplication of what this navigator already shows.)
        const searchResults = entitiesFilter.serverSearchResults;
        const searchTerm = entitiesFilter.getFilterData(FILTER_TYPES.SEARCH);
        const realMatchTotal = searchTerm && searchResults?.searchValue === searchTerm && searchResults.total > entities.length
            ? searchResults.total
            : undefined;

        $('#rm_print_characters_pagination').pagination({
            ...sharedPaginationOptions,
            dataSource: entities,
            formatNavigator: realMatchTotal === undefined
                ? PAGINATION_TEMPLATE
                : function (currentPage, _totalPage, totalNumber) {
                    const rangeStart = (currentPage - 1) * pageSize + 1;
                    const rangeEnd = Math.min(currentPage * pageSize, totalNumber);
                    return `${rangeStart}-${rangeEnd} .. ${realMatchTotal}`;
                },
            callback: makePageCallback(() => entities.length),
        });
    }

    if (canUseServerQueryForEntitiesList()) {
        // Real server-side pagination (design doc §6/§9 phase 5): the character+group rows for the visible
        // page come from one `/query` request per page turn, not from re-slicing a fully materialized array.
        // Bogus-folder tag tiles are the one deliberate exception - they're computed locally, once per
        // full render, and prepended only to page 1 rather than forced through the server query. Two reasons:
        // folders are pinned to a fixed small prefix by `sortEntitiesList()` (never part of the sortable
        // character+group continuum §5 describes, so there's no "page 2 of folders" to ask the server for),
        // and their member counts/nesting already require the local tag-membership computation
        // `getFolderTileEntities()` shares with `getEntitiesList()`. Net effect, disclosed rather than hidden:
        // when folders are open, page 1 shows `pageSize` characters/groups *plus* however many folder tiles
        // matched, i.e. folders no longer eat into the page-size budget the way the old static-array slice
        // silently did (a folder tile used to occupy one of the `pageSize` slots on whichever page it landed
        // on). "Open a folder" itself needs no special-casing here: an open bogus folder is just a selected tag
        // in `entitiesFilter`'s TAG filter data, which `buildCharacterQueryFromCurrentFilterState()` already
        // threads into `filter.tags.include` - so it composes with `includeGroups` and paginates for free,
        // including group folder members (`group_tags`), instead of the old "dump every member of the open
        // folder into the static dataSource regardless of the outer pagination" behavior.
        const { filter, sort } = buildCharacterQueryFromCurrentFilterState({ includeGroups: true });

        // `canUseServerQueryForEntitiesList()` above is only an "attempt" signal now (see its doc comment) - it
        // no longer guarantees the server actually has a column for the current sort field. Rather than let a
        // rejection surface per page-turn deep inside pagination.js's `ajaxFunction` (where the only thing this
        // code could do about it is show an error state - a real regression from the old pre-check, which never
        // attempted a field it didn't already know was safe), probe with the page-1 request up front: if the
        // server accepts it, hand that already-fetched page straight to `ajaxFunction` below (so this probe
        // never costs a second, wasted round-trip on the common path) and build the server-paginated widget; if
        // it rejects with `isInvalidSortFieldError()`, fall back to `renderLocalPaginated()` before ever touching
        // the pagination.js plugin, exactly like `getEntitiesList()`'s own fallback. A rejection on a *later*
        // page turn (filter/sort didn't change between page 1 and then) would mean the server's answer changed
        // out from under an already-committed widget - not the drift scenario this fallback exists for - so that
        // case still just surfaces as an error, unchanged from before.
        const folderTiles = await getFolderTileEntities();
        /** @type {Awaited<ReturnType<typeof characterRepository.query>>|undefined} */
        let firstPage;
        /** @type {unknown} */
        let firstPageError;
        try {
            firstPage = await characterRepository.query(filter, sort, 1, pageSize, ['rows', 'total']);
        } catch (error) {
            if (!isInvalidSortFieldError(error)) throw error;
            firstPageError = error;
        }

        if (firstPageError !== undefined) {
            await renderLocalPaginated();
        } else {
            // Server total for the character+group match set (may be an approximate `~`-prefixed count - design
            // doc §5 decision 6 - which is fine for the "N hidden" badge and for pagination.js's own page-count
            // math, both of which only need an honest approximation, never a bare-but-truncated number). Updated
            // by `ajaxFunction` on every page fetch; read by the callback's `getMatchTotal` and by
            // `totalNumberLocator`. Folder tiles are added back in because the pre-existing formula's `entities`
            // array (see the fallback branch below) always included them too.
            let matchTotal = 0;
            // Serves the already-fetched probe result to `ajaxFunction`'s very first call instead of
            // re-fetching - consumed (set to `undefined`) after that one use; every later call (page turn, size
            // change) fetches for real.
            let pendingFirstPage = firstPage;

            // Same single-source rule as renderLocalPaginated()'s own `realMatchTotal` above: when the active
            // search term's own fetch (fetchServerCharacterSearchResults(), entitiesFilter.serverSearchResults)
            // reports a higher total than this render's own just-fetched page, defer to that shared total for
            // the *displayed* navigator text rather than trusting this render's own number - the two no longer
            // computed their own independent totals for the same search (2026-08 "500 of 501" investigation).
            // `matchTotal` (closed over by `callback`/`totalNumberLocator` above) still drives the actual
            // page-turn math from this render's own fetch, unaffected - paging still can't go past what this
            // request actually returned, exactly like the fallback path's own disclosed compromise.
            const searchTerm = entitiesFilter.getFilterData(FILTER_TYPES.SEARCH);
            $('#rm_print_characters_pagination').pagination({
                ...sharedPaginationOptions,
                dataSource: SERVER_PAGINATED_DATA_SOURCE,
                locator: 'rows',
                formatNavigator: function (currentPage, _totalPage, totalNumber) {
                    const searchResults = entitiesFilter.serverSearchResults;
                    const realMatchTotal = searchTerm && searchResults?.searchValue === searchTerm && searchResults.total > totalNumber
                        ? searchResults.total
                        : totalNumber;
                    const rangeStart = (currentPage - 1) * pageSize + 1;
                    const rangeEnd = Math.min(currentPage * pageSize, totalNumber);
                    return `${rangeStart}-${rangeEnd} .. ${realMatchTotal}`;
                },
                // Seed pagination.js's dynamic-total boot math with the last real total we saw (see
                // saveCharactersTotal's own doc comment above) - without this, `self.getTotalNumber()` reads 0
                // until the first ajax response of *this* reconstruction lands, which clamps the boot page
                // request (and the synchronous pre-ajax render) down to page 1 / "0 of 0" no matter what
                // `pageNumber` says. `resetPageNumberOnInit: false` is the other half: pagination.js's own init
                // path force-overwrites the requested page to 1 whenever a `totalNumberLocator` is present,
                // independent of the totalNumber seed. Together they let a debounced re-render (search
                // keystroke, tag toggle, sort/filter change - anything that reconstructs this plugin without an
                // explicit fullRefresh) re-request the page the user was actually on instead of silently
                // bouncing them back to page 1 with a momentary empty flash.
                totalNumber: saveCharactersTotal || undefined,
                resetPageNumberOnInit: false,
                totalNumberLocator: function (/** @type {{total: number|string}} */ response) {
                    const parsed = Number(String(response.total).replace(/^~/, ''));
                    return Number.isFinite(parsed) ? parsed : 0;
                },
                ajaxFunction: function (ajaxParams) {
                    const page = ajaxParams.data.pageNumber;
                    const requestedPageSize = ajaxParams.data.pageSize;
                    const resultPromise = (page === 1 && requestedPageSize === pageSize && pendingFirstPage)
                        ? Promise.resolve(pendingFirstPage)
                        : characterRepository.query(filter, sort, page, requestedPageSize, ['rows', 'total']);
                    pendingFirstPage = undefined;
                    resultPromise
                        .then(result => {
                            const rows = Array.isArray(result.rows) ? result.rows : [];
                            const pageEntities = rows.map(row => queryRowToEntity(row));
                            const parsedTotal = Number(String(result.total ?? 0).replace(/^~/, ''));
                            saveCharactersTotal = Number.isFinite(parsedTotal) ? parsedTotal : 0;
                            matchTotal = saveCharactersTotal + folderTiles.length;
                            const combined = page === 1 ? [...folderTiles, ...pageEntities] : pageEntities;
                            ajaxParams.success({ rows: combined, total: result.total });
                        })
                        .catch(error => {
                            console.error('[printCharacters] server-paginated /query failed:', error);
                            ajaxParams.error(error);
                        });
                },
                callback: makePageCallback(() => matchTotal),
            });
        }
    } else {
        await renderLocalPaginated();
    }

    favsToHotswap();
    updatePersonaConnectionsAvatarList();
}

/**
 * Shows/hides the "Search" sort option depending on whether a search term is active - it's meaningless
 * without one, since it sorts by search relevance score. Auto-selects it when the search term first becomes
 * active (the option going from hidden to visible), but does not re-force it on every render afterward - so a
 * user who manually switches away from it while still searching keeps their choice.
 */
function verifyCharactersSearchSortRule() {
    const searchTerm = entitiesFilter.getFilterData(FILTER_TYPES.SEARCH);
    const searchOption = $('#character_sort_order option[data-field="search"]');
    const isHidden = searchOption.attr('hidden') !== undefined;

    // If we have a search term, we are displaying the sorting option for it, and selecting it since it just became active
    if (searchTerm && isHidden) {
        searchOption.removeAttr('hidden');
        searchOption.prop('selected', true);
    }
    // If search got cleared, hide the option, and fall back to the last real sort if it was the selected one
    // (it's no longer a valid choice with nothing to rank by).
    if (!searchTerm && !isHidden) {
        searchOption.attr('hidden', '');
        if (searchOption.is(':selected')) {
            $(`#character_sort_order option[data-order="${power_user.sort_order}"][data-field="${power_user.sort_field}"]`).prop('selected', true);
        }
    }
}

/**
 * @typedef {object} Entity - Object representing a display entity
 * @property {Character|Group|import('./scripts/tags.js').Tag|*} item - The item
 * @property {string|number} id - The id
 * @property {'character'|'group'|'tag'} type - The type of this entity (character, group, tag)
 * @property {Entity[]?} [entities=null] - An optional list of entities relevant for this item
 * @property {number?} [hidden=null] - An optional number representing how many hidden entities this entity contains
 * @property {boolean?} [isUseless=null] - Specifies if the entity is useless (not relevant, but should still be displayed for consistency) and should be displayed greyed out
 */

/**
 * Converts the given character to its entity representation
 *
 * @param {Character} character - The character
 * @returns {Entity} The entity for this character
 */
export function characterToEntity(character) {
    return { item: character, id: character?.avatar, type: 'character' };
}

/**
 * Converts the given group to its entity representation
 *
 * @param {Group} group - The group
 * @returns {Entity} The entity for this group
 */
export function groupToEntity(group) {
    return { item: group, id: group.id, type: 'group' };
}

/**
 * Converts the given tag to its entity representation
 *
 * @param {import('./scripts/tags.js').Tag} tag - The tag
 * @returns {Entity} The entity for this tag
 */
export function tagToEntity(tag) {
    return { item: structuredClone(tag), id: tag.id, type: 'tag', entities: [] };
}

/**
 * Whether the current sort selection is the "Search" relevance option (`#character_sort_order`'s hidden-unless-
 * searching entry) - the one case `power_user.sort_field`/`sort_order` alone can't express, since that option
 * overrides both while selected (mirrors sortEntitiesList()'s own `isSearch` check, power-user.js).
 * @returns {boolean}
 */
function isSearchSortSelected() {
    return $('#character_sort_order option[data-field="search"]').is(':selected');
}

/**
 * Whether the character+group candidate set (`getEntitiesList()`) and the visible page
 * (`printCharacters()`'s pagination controller) should even ATTEMPT the server `/query` endpoint (design doc
 * §5/§6, `filter.includeGroups: true`) instead of going straight to the fully-local `characters`/`groups`
 * arrays. This is no longer "can", in the sense of a guaranteed-safe pre-check - it's "should try": the actual
 * answer to whether the server supports the current `sort.field` comes back from the server itself (a real
 * `400 { reason: 'invalid-sort-field' }` response), not from anything predicted here. See
 * `isServerQueryableSort()`'s doc comment (character-repository.js) for why the client stopped keeping its own
 * copy of that knowledge. Every caller of this function attempts the server query when it returns `true` and
 * catches that specific rejection (`isInvalidSortFieldError()`) to fall back to the pre-existing local path -
 * see `getEntitiesList()` below and `printCharacters()`'s server-paginated branch.
 *
 * Groups being queryable through the same endpoint (`includeGroups`) doesn't change *when* this returns true,
 * only what the caller does with a `true` answer - the eligibility conditions below are about the sort/search
 * state, which is orthogonal to whether groups are merged in.
 *
 * An active search term no longer excludes this path (it used to - see git history around this comment for the
 * old rationale, and the `/query` route's own doc comment in characters.js for why it stopped applying): this
 * app previously had a *separate* server search integration (`fetchServerCharacterSearchResults()` /
 * `entitiesFilter.serverSearchResults`, both in this file/filters.js) that scored characters AND groups
 * together via `/api/characters/all`, on the theory that `/query`'s own `filter.search` used a different index
 * that might disagree with it or (for groups) not cover them at all. That gap is closed - groups now have their
 * own full-text index wired into `/query`'s `filter.search` + `filter.includeGroups` handling (see that route's
 * doc comment), so `filter.search` here and the old `/all`-based search are the exact same underlying indexes,
 * not two that could silently diverge. `fetchServerCharacterSearchResults()`/`serverSearchResults` still exist -
 * they now call `/query` themselves (see that function's doc comment) - but only matter for a caller that
 * caught an `isInvalidSortFieldError()` rejection for its sort field (independent of search), which still needs
 * the pre-existing fully-local fallback and its own score cache.
 *
 * `isSearchSortSelected()` is still checked, but no longer disqualifies outright - `sort.field: 'search'`
 * requires a non-empty search term (mirrors the `/query` route's own "requires, doesn't merely permit" rule),
 * which `verifyCharactersSearchSortRule()` already guarantees by hiding the option otherwise, but this function
 * doesn't get to assume UI state stayed in sync, so it re-checks directly.
 * @returns {boolean}
 */
function canUseServerQueryForEntitiesList() {
    if (isSearchSortSelected()) return String(entitiesFilter.getFilterData(FILTER_TYPES.SEARCH) ?? '').trim().length > 0;
    const sortField = power_user.sort_order === 'random' ? 'random' : power_user.sort_field;
    return isServerQueryableSort(sortField);
}

/**
 * Maps the current tag-filter/fav-filter/sort UI state (`entitiesFilter`, `power_user`) into the normalized
 * input `buildCharacterQuery()` (character-repository.js) expects, and calls it. Kept as its own function so
 * the state-reading side (this) stays separate from the pure mapping (that), matching the pure/impure split the
 * design doc's client data model section (§6) asks for.
 *
 * `tagFilterData.selected` doubles as "which bogus folder is currently open" (`isBogusFolderOpen()`,
 * `chooseBogusFolder()`/`toggleTagThreeState()` in tags.js just add/remove the folder's tag id from this same
 * TAG filter selection) - so passing it through as `filter.tags.include` is *already* item 3's "open folder
 * becomes a real /query-style paginated filter", no separate wiring needed at the folder-click site. A folder
 * can contain groups too (`group_tags`), which is exactly what `includeGroups` composes with.
 * @param {object} [param0]
 * @param {boolean} [param0.includeGroups] - see `CharacterQueryFilter.includeGroups` (character-repository.js).
 * @returns {{filter: import('./scripts/character-repository.js').CharacterQueryFilter, sort: import('./scripts/character-repository.js').CharacterQuerySort|undefined}}
 */
function buildCharacterQueryFromCurrentFilterState({ includeGroups = false } = {}) {
    const tagFilterData = entitiesFilter.getFilterData(FILTER_TYPES.TAG) ?? { selected: [], excluded: [] };
    const favState = entitiesFilter.getFilterData(FILTER_TYPES.FAV);
    let fav;
    if (isFilterState(favState, FILTER_STATES.SELECTED)) fav = true;
    else if (isFilterState(favState, FILTER_STATES.EXCLUDED)) fav = false;

    const isSearchSort = isSearchSortSelected();
    const isRandom = !isSearchSort && power_user.sort_order === 'random';
    return buildCharacterQuery({
        searchTerm: entitiesFilter.getFilterData(FILTER_TYPES.SEARCH) ?? '',
        tagsInclude: tagFilterData.selected ?? [],
        tagsExclude: tagFilterData.excluded ?? [],
        fav,
        sortField: isSearchSort ? 'search' : (isRandom ? 'random' : power_user.sort_field),
        sortOrder: power_user.sort_order === 'desc' ? 'desc' : 'asc',
        randomSeed: isRandom ? getRandomSortSeed(accountStorage) : undefined,
        includeGroups,
    });
}

/**
 * Maps one normalized `/query` row (design doc §5, `filter.includeGroups: true`) to its `Entity` form -
 * `characterToEntity()` for a character row, `groupToEntity()` for a group row. The one place that combination
 * happens, so `getEntitiesList()` and `printCharacters()`'s server-paginated controller can't drift apart on it.
 * @param {Character|{type: 'character'|'group', item: Character|Group}} row
 * @returns {Entity}
 */
function queryRowToEntity(row) {
    const { type, item } = normalizeQueryRow(row);
    return type === 'group' ? groupToEntity(item) : characterToEntity(item);
}

/**
 * Runs the shared tag/fav/folder filter pipeline and the final sort over an already-assembled raw entity list
 * (characters + groups + bogus-folder tag tiles, unfiltered). Factored out of `getEntitiesList()` so
 * `getFolderTileEntities()` below can reuse the exact same filtering - including the closed-folder/empty-folder/
 * "isUseless" logic - without a second, divergence-prone copy of it.
 *
 * We need to do multiple filter runs in a specific order, otherwise different settings might override each
 * other and screw up tags and search filter, sub lists or similar. The specific filters are written inside the
 * "filterByTagState" method and its different parameters. Generally what we do is the following:
 *   1. First swipe over the list to remove the most obvious things
 *   2. Build sub entity lists for all folders, filtering them similarly to the second swipe
 *   3. We do the last run, where global filters are applied, and the search filters last
 * @param {Entity[]} rawEntities
 * @param {object} param1
 * @param {boolean} [param1.doFilter]
 * @param {boolean} [param1.doSort]
 * @returns {Entity[]}
 */
function filterAndSortEntities(rawEntities, { doFilter = false, doSort = true } = {}) {
    let entities = rawEntities;

    // First run filters, that will hide what should never be displayed
    if (doFilter) {
        entities = filterByTagState(entities);
    }

    // Run over all entities between first and second filter to save some states
    for (const entity of entities) {
        // For folders, we remember the sub entities so they can be displayed later, even if they might be filtered
        // Those sub entities should be filtered and have the search filters applied too
        if (entity.type === 'tag') {
            let subEntities = filterByTagState(entities, { subForEntity: entity, filterHidden: false });
            const subCount = subEntities.length;
            subEntities = filterByTagState(entities, { subForEntity: entity });
            if (doFilter) {
                // sub entities filter "hacked" because folder filter should not be applied there, so even in "only folders" mode characters show up
                subEntities = entitiesFilter.applyFilters(subEntities, { clearScoreCache: false, tempOverrides: { [FILTER_TYPES.FOLDER]: FILTER_STATES.UNDEFINED }, clearFuzzySearchCaches: false });
            }
            if (doSort) {
                sortEntitiesList(subEntities, false);
            }
            entity.entities = subEntities;
            entity.hidden = subCount - subEntities.length;
        }
    }

    // Second run filters, hiding whatever should be filtered later
    if (doFilter) {
        const beforeFinalEntities = filterByTagState(entities, { globalDisplayFilters: true });
        entities = entitiesFilter.applyFilters(beforeFinalEntities, { clearFuzzySearchCaches: false });

        // Magic for folder filter. If that one is enabled, and no folders are display anymore, we remove that filter to actually show the characters.
        if (isFilterState(entitiesFilter.getFilterData(FILTER_TYPES.FOLDER), FILTER_STATES.SELECTED) && entities.filter(x => x.type == 'tag').length == 0) {
            entities = entitiesFilter.applyFilters(beforeFinalEntities, { tempOverrides: { [FILTER_TYPES.FOLDER]: FILTER_STATES.UNDEFINED }, clearFuzzySearchCaches: false });
        }
    }

    // Final step, updating some properties after the last filter run
    const nonTagEntitiesCount = entities.filter(entity => entity.type !== 'tag').length;
    for (const entity of entities) {
        if (entity.type === 'tag') {
            if (entity.entities?.length == nonTagEntitiesCount) entity.isUseless = true;
        }
    }

    // Sort before returning if requested
    if (doSort) {
        sortEntitiesList(entities, false);
    }
    entitiesFilter.clearFuzzySearchCaches();
    return entities;
}

/**
 * Builds the full list of all entities available
 *
 * They will be correctly marked and filtered.
 *
 * The character+group portion of the candidate set is built two ways depending on `doFilter` and the current
 * filter/sort state (design doc §6, phase 5):
 * - `doFilter: true` and `canUseServerQueryForEntitiesList()` says to attempt it: one merged call -
 *   `characterRepository.queryAll(filter, sort)` with `filter.includeGroups: true` - already narrowed by the
 *   active tag/fav filters (including an open bogus folder, since that's just a selected tag - see
 *   `buildCharacterQueryFromCurrentFilterState()`'s doc comment) and in the active sort order, straight from the
 *   server, characters and groups already merged and sorted together. The rest of this function's filter
 *   pipeline (tag/fav/folder filtering, the final sort) still runs over the result same as always; that's a
 *   redundant but harmless second pass (server and client agree on tag/fav membership, since both read the same
 *   underlying tag_map/fav data), and it's the pass that does real work for the bogus-folder tag tiles, which
 *   `/query` does not and cannot answer (design doc §5: folders aren't part of the sortable character+group
 *   continuum at all - `sortEntitiesList()` always pins them to the top in their own order, independent of
 *   `sort_field`/`sort_order`).
 *   If that call rejects with `isInvalidSortFieldError()` - the current sort field genuinely has no server
 *   column - this falls back to the local path below instead of throwing; any other failure (network error, a
 *   500, ...) propagates normally, same as it always has.
 * - Otherwise (an active search term-less non-eligible state, `doFilter: false`, or a caught
 *   `isInvalidSortFieldError()`): the pre-existing fully-local path - `characters.map(...)` + `groups.map(...)`
 *   over the whole resident arrays, filtered/sorted entirely client-side exactly as before this change.
 * @param {object} param0 - Optional parameters
 * @param {boolean} [param0.doFilter] - Whether this entity list should already be filtered based on the global filters
 * @param {boolean} [param0.doSort] - Whether the entity list should be sorted when returned
 * @returns {Promise<Entity[]>} All entities
 */
export async function getEntitiesList({ doFilter = false, doSort = true } = {}) {
    let characterAndGroupEntities;
    if (doFilter && canUseServerQueryForEntitiesList()) {
        try {
            const { filter, sort } = buildCharacterQueryFromCurrentFilterState({ includeGroups: true });
            const rows = await characterRepository.queryAll(filter, sort);
            characterAndGroupEntities = rows.map(row => queryRowToEntity(row));
        } catch (error) {
            if (!isInvalidSortFieldError(error)) throw error;
            characterAndGroupEntities = undefined;
        }
    }
    if (characterAndGroupEntities === undefined) {
        characterAndGroupEntities = [
            ...characters.map(item => characterToEntity(item)),
            ...groups.map(item => groupToEntity(item)),
        ];
    }

    const rawEntities = [
        ...characterAndGroupEntities,
        ...(power_user.bogus_folders ? tags.filter(isBogusFolder).sort(compareTagsForSort).map(item => tagToEntity(item)) : []),
    ];

    return filterAndSortEntities(rawEntities, { doFilter, doSort });
}

/**
 * The bogus-folder tag tiles for the current filter state, fully filtered/annotated (`entity.entities`,
 * `entity.hidden`, `entity.isUseless`) exactly as `getEntitiesList()` would compute them - via the same
 * `filterAndSortEntities()` pipeline, just fed the fully-resident local candidate set (`characters`/`groups`
 * arrays) rather than a server page, since folder tiles are pinned to a fixed small prefix (design doc §5,
 * `sortEntitiesList()`) and are never part of what `printCharacters()`'s server-paginated controller pages
 * through - see that function's doc comment for the "unpaginated addendum on page 1" call. `characters`/`groups`
 * stay fully client-resident regardless of that controller (phase 5's residency bounding is a later phase, §9),
 * so this costs exactly what the pre-existing fully-local `getEntitiesList()` path already cost whenever
 * `power_user.bogus_folders` was on - not a new scan, just no longer gated behind the character/group portion
 * of the same call.
 * @returns {Promise<Entity[]>} tag-type entities only, in `sortEntitiesList()`'s pinned-folder order.
 */
async function getFolderTileEntities() {
    if (!power_user.bogus_folders) return [];

    const rawEntities = [
        ...characters.map(item => characterToEntity(item)),
        ...groups.map(item => groupToEntity(item)),
        ...tags.filter(isBogusFolder).sort(compareTagsForSort).map(item => tagToEntity(item)),
    ];

    const entities = filterAndSortEntities(rawEntities, { doFilter: true, doSort: true });
    return entities.filter(entity => entity.type === 'tag');
}

export async function getOneCharacter(avatarUrl) {
    const response = await fetch('/api/characters/get', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            avatar_url: avatarUrl,
        }),
    });

    if (response.ok) {
        const getData = await response.json();
        getData.chat = String(getData.chat);
        // /api/characters/get always processes with `shallow: false` server-side (see characters.js), so this
        // response is unconditionally full data - but processCharacter() only ever sets a `shallow: true` key
        // on the *shallow* branch's output; the full-data branch never sets `shallow: false` explicitly, so
        // getData here simply lacks a `shallow` key. Object.assign() below (via charactersStore.update()) only
        // overwrites keys that are actually present in the patch, so without this explicit reset, an entity
        // that started shallow (lazyLoadCharacters) keeps `shallow: true` forever, no matter how many times it
        // gets unshallowed - making unshallowCharacter() (script.js) treat it as still-shallow and refetch (and
        // Object.assign-clobber any pending in-memory edit, e.g. doNewChat()'s chat rename) on every single call
        // instead of just the first.
        getData.shallow = false;

        if (charactersStore.has(avatarUrl)) {
            // Was `characters[indexOf] = getData` (a full reference swap) - now goes through
            // charactersStore.update(), which Object.assign()s getData's fields onto the *existing* entity
            // object instead of replacing it. Since getData is a full character object, the end state is the
            // same either way - the difference is that any other code holding a reference to the old character
            // object (rather than re-reading `characters[indexOf]`) now sees the update too, instead of quietly
            // going stale. No known caller relied on the old "distinct object after edit" behavior.
            // Fuse-index invalidation is handled by the charactersStore.onChange subscriber above.
            charactersStore.update(avatarUrl, getData);
        } else {
            toastr.error(t`Character ${avatarUrl} not found in the list`, t`Error`, { timeOut: 5000, preventDuplicates: true });
        }
    }
}

export function getCharacterSource(character = getCurrentCharacter()) {
    if (!character) {
        return '';
    }

    const chubId = character.data?.extensions?.chub?.full_path;

    if (chubId) {
        return `https://chub.ai/characters/${chubId}`;
    }

    const pygmalionId = character.data?.extensions?.pygmalion_id;

    if (pygmalionId) {
        return `https://pygmalion.chat/${pygmalionId}`;
    }

    const githubRepo = character.data?.extensions?.github_repo;

    if (githubRepo) {
        return `https://github.com/${githubRepo}`;
    }

    const sourceUrl = character.data?.extensions?.source_url;

    if (sourceUrl) {
        return sourceUrl;
    }

    const risuId = character.data?.extensions?.risuai?.source;

    if (Array.isArray(risuId) && risuId.length && typeof risuId[0] === 'string' && risuId[0].startsWith('risurealm:')) {
        const realmId = risuId[0].split(':')[1];
        return `https://realm.risuai.net/character/${realmId}`;
    }

    const perchanceSlug = character.data?.extensions?.perchance_data?.slug;

    if (perchanceSlug) {
        return `https://perchance.org/ai-character-chat?data=${perchanceSlug}`;
    }

    return '';
}

/**
 * Refetches the full character list from the server and rebuilds `characters` in place. Also refetches the
 * full group list (getGroups()) as a side effect, since the character/group lists are shown as one combined
 * UI list and several group-mutation call sites in group-chats.js piggyback on this function to also trigger
 * their reload/re-render, rather than calling getGroups() directly.
 * @param {object} [options]
 * @param {boolean} [options.silent=false] - If true, skips charactersStore's generic reset() notification -
 * pass this when the caller already knows the specific create/delete/rename that this reload happened for,
 * and will report it itself via charactersStore.reportCreated()/.reportRemoved()/.reportRenamed() once this
 * returns (which need the post-reload id index, so charactersStore.reindex() still runs either way - only
 * the emitted change differs). Leave false for reloads with no more specific intent than "resync".
 * @param {boolean} [options.silentGroups=false] - Same as `silent`, but for the internal getGroups() reload's
 * groupsStore notification - independent of `silent`, since a reload can know the specific thing that
 * happened to *one* of the two collections without knowing anything specific about the other (e.g. a pure
 * group edit doesn't want charactersStore to fire a redundant reset(), and a character delete doesn't
 * necessarily know whether server-side cleanup removed that character from any group's member list, so it
 * should NOT default to silencing groupsStore just because it's silencing charactersStore).
 */
// A single /api/characters/batch request is kept bounded to this many avatars, same motivation as
// DEFAULT_PAGE_LIMIT server-side (characters.js) - a boot where most/all of a very large library changed at
// once (e.g. first-ever boot, nothing cached yet) shouldn't turn into one giant response any more than a
// paginated search should.
const CHARACTER_BATCH_CHUNK_SIZE = 500;

/**
 * Sanitizes/defaults a single character object exactly as getCharacters() has always done to every character in
 * the response, in place. Only meant to be called on freshly-fetched data - a cache hit already has this
 * applied (see character-cache.js), applying it twice would be harmless but wasted work.
 * @param {object} character
 */
function finalizeFetchedCharacter(character) {
    // For dropped-in cards
    if (!character.chat) {
        character.chat = `${character.name} - ${humanizedDateTime()}`;
    }

    character.chat = String(character.chat);
}

/**
 * Fetches the current character list via the change-feed/delta-cache path: `POST /api/characters/changes` for
 * a cheap `{ seq, changes: [{id, op, fields}], truncated }` since this cache's last-synced revision (character-cache.js's
 * `getCachedCursor()`), applied on top of whatever's already cached so only characters that are genuinely new or
 * changed (`op: 'upsert'`) get fetched (via `/api/characters/batch`) and re-processed (DOMPurify/chat-default) -
 * deleted characters (`op: 'delete'`) are dropped from the cache directly, by id, rather than inferred from
 * absence in a full snapshot. Replaces the old `/api/characters/manifest` full-library scan entirely: every
 * real mutation (create/rename/delete/edit) already writes a `changes` row server-side (character-metadata-db.js
 * `writeRowSync()`, called unconditionally by every write path including the one-time bootstrap backfill - see
 * that function's own doc comment), so a `sinceSeq: 0` cold sync's change list already IS the full current
 * library, with no separate ground-truth listing needed to know what's been deleted since.
 *
 * Throws on any failure (network, non-OK response, etc.) - callers should fall back to the unconditional
 * full-fetch path (fetchAllCharacters()) rather than partially apply a broken delta.
 *
 * Note on ordering: unlike the old manifest-diff scheme (which preserved the server's readdir order), the
 * returned list's order is cache insertion order, not any particular library order - nothing downstream should
 * be relying on `characters` array order as meaningful (display always goes through sortEntitiesList()).
 *
 * Note on thumbnails: the old `/manifest` response's `thumbnailVersion` field let getThumbnailUrl() skip a
 * no-cache redirect hop for every character in the library, up front. `/changes` doesn't carry that (it only
 * knows what changed, not a thumbnail cache-bust token), and `/batch` doesn't return it either - this is a real,
 * accepted perf regression for cache-hit characters (they fall back to the pre-existing "no cached version"
 * path getThumbnailUrl() already had before this field existed), not a correctness issue.
 * @returns {Promise<object[]>} The full character list, cache order (see note above).
 */
async function fetchCharactersDelta() {
    const sinceSeq = await getCachedCursor();
    const changesResponse = await fetch('/api/characters/changes', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ sinceSeq }),
    });

    if (!changesResponse.ok) {
        throw new Error(`Failed to fetch character changes: ${changesResponse.statusText}`);
    }

    /** @type {{seq: number, changes: {id: string, op: 'upsert'|'delete', fields?: string[]|null}[], truncated: boolean}} */
    const { seq, changes, truncated } = await changesResponse.json();

    if (truncated) {
        // sinceSeq predates anything the server's change log still has - this cache can no longer be trusted
        // to catch up incrementally. Wipe it and retry as a fresh sinceSeq: 0 sync, whose change list is the
        // full current library (see this function's own doc comment).
        await clearCharacterCache();
        return fetchCharactersDelta();
    }

    const deleteIds = [];
    const wholeRecordIds = [];
    // Group field-level changes by their field set so each distinct set becomes one batched /batch
    // call with that `fields` filter, rather than one call per changed character.
    /** @type {Map<string, { fields: string[], ids: string[] }>} */
    const fieldGroupMap = new Map();

    for (const { id, op, fields } of changes) {
        if (op === 'delete') {
            deleteIds.push(id);
        } else if (!fields) {
            // null/undefined fields = whole record changed (full card edit, import, rename, etc.)
            wholeRecordIds.push(id);
        } else {
            // Field-level change - group by the same field set to batch efficiently.
            const key = JSON.stringify([...fields].sort());
            if (!fieldGroupMap.has(key)) {
                fieldGroupMap.set(key, { fields, ids: [] });
            }
            fieldGroupMap.get(key).ids.push(id);
        }
    }

    // Re-fetch records that failed to write on a previous sync (event-driven retry: the write
    // failure itself is the trigger, not a periodic verification sweep).
    const previousFailures = await getWriteFailures();
    if (previousFailures.length > 0) {
        const deleteSet = new Set(deleteIds);
        for (const id of previousFailures) {
            if (!deleteSet.has(id) && !wholeRecordIds.includes(id)) {
                wholeRecordIds.push(id);
            }
        }
        console.log(`[sync] Re-fetching ${previousFailures.length} record(s) from previous write failure(s)`);
    }

    // --- Incremental digest maintenance (catch-up path) ---
    // Read old hashes BEFORE any IDB mutations so the incremental update can XOR-out old
    // contributions and XOR-in new ones. The stored digest gets updated at the end so that
    // the deferred verify's fast-path comparison (server root vs stored digest) succeeds
    // without a full O(library) client-side recomputation.
    const storedDigest = await getLastVerifiedDigest();
    const allAffectedIds = [...deleteIds, ...wholeRecordIds];
    for (const { ids } of fieldGroupMap.values()) {
        allAffectedIds.push(...ids);
    }
    const oldHashesMap = (storedDigest && allAffectedIds.length > 0)
        ? await getCachedHashesByIds(allAffectedIds)
        : new Map();

    if (deleteIds.length > 0) {
        await removeCachedCharacters(deleteIds);
    }

    /** @type {Map<string, object>} fresh/updated records to save back to the cache */
    const fresh = new Map();

    // Whole-record fetches: same as before - full processCharacter() on the server, full record back.
    for (let i = 0; i < wholeRecordIds.length; i += CHARACTER_BATCH_CHUNK_SIZE) {
        const chunk = wholeRecordIds.slice(i, i + CHARACTER_BATCH_CHUNK_SIZE);
        const batchResponse = await fetch('/api/characters/batch', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ avatars: chunk }),
        });

        if (!batchResponse.ok) {
            throw new Error(`Failed to fetch character batch: ${batchResponse.statusText}`);
        }

        const batchData = await batchResponse.json();
        for (const character of batchData) {
            finalizeFetchedCharacter(character);
            fresh.set(character.avatar, character);
        }
    }

    // Field-level fetches: request only the changed fields from the metadata store's shallow_json
    // (no PNG read server-side), then merge into the existing cached record. This is the key
    // optimization: a tag_ids change on 314k records transfers ~11.5MB instead of ~314MB.
    if (fieldGroupMap.size > 0) {
        // Read the full cache once up front - cheaper than N individual IndexedDB reads for large
        // field-level fills (e.g. the one-time tag_ids backfill across 314k records).
        const allCachedBefore = await getAllCachedCharacters();

        for (const { fields, ids } of fieldGroupMap.values()) {
            for (let i = 0; i < ids.length; i += CHARACTER_BATCH_CHUNK_SIZE) {
                const chunk = ids.slice(i, i + CHARACTER_BATCH_CHUNK_SIZE);
                const batchResponse = await fetch('/api/characters/batch', {
                    method: 'POST',
                    headers: getRequestHeaders(),
                    body: JSON.stringify({ avatars: chunk, fields }),
                });

                if (!batchResponse.ok) {
                    throw new Error(`Failed to fetch character batch (fields): ${batchResponse.statusText}`);
                }

                const batchData = await batchResponse.json();
                const batchMerged = [];
                for (const partial of batchData) {
                    const avatar = partial.avatar;
                    // Merge: overlay fetched fields onto the existing cached record, keyed by
                    // avatar - never positionally. Check `fresh` first (a whole-record fetch in
                    // this same sync supersedes any prior cached version), then fall back to the
                    // pre-sync cache.
                    const existing = fresh.get(avatar) || allCachedBefore.get(avatar);
                    if (existing) {
                        for (const field of fields) {
                            if (field in partial) {
                                existing[field] = partial[field];
                            }
                        }
                        fresh.set(avatar, existing);
                        batchMerged.push({ avatar, character: existing });
                    }
                    // If no existing record to merge into (field-level change for a record not in
                    // cache - shouldn't happen normally), skip - the anti-entropy check or next
                    // full sync will catch it.
                }
                // Save field-level merges incrementally per batch to avoid accumulating
                // hundreds of thousands of entries for one bulk IndexedDB write at the end.
                if (batchMerged.length > 0) {
                    await saveCachedCharacters(batchMerged);
                }
            }
        }
    }

    let writeFailures = [];
    if (fresh.size > 0) {
        writeFailures = await saveCachedCharacters(Array.from(fresh, ([avatar, character]) => ({ avatar, character })));
    }
    await setCachedCursor(seq);
    // Persist any write failures for retry on next boot; clear if all succeeded.
    // This replaces the per-boot verify with event-driven failure tracking.
    await setWriteFailures(writeFailures);

    // Incremental digest maintenance: update the stored digest to reflect applied changes,
    // so the deferred verify's fast-path (which compares server root to stored digest) succeeds
    // without needing a full O(library) client-side recomputation. The decision "am I up to date"
    // still comes from comparing content hashes (verify's server-root vs stored-root comparison),
    // not from trusting the seq cursor.
    if (storedDigest && (fresh.size > 0 || deleteIds.length > 0)) {
        let runningDigest = { ...storedDigest };

        // XOR-out deleted records' old contributions (XOR is self-inverse)
        for (const id of deleteIds) {
            const old = oldHashesMap.get(id);
            if (old) {
                runningDigest = combineDigest128(runningDigest, id, old.fav, old.tagIds, old.content);
            }
        }

        // XOR-out old + XOR-in new for upserted records
        for (const [avatar, character] of fresh) {
            const old = oldHashesMap.get(avatar);
            if (old) {
                // XOR-out old contribution
                runningDigest = combineDigest128(runningDigest, avatar, old.fav, old.tagIds, old.content);
            }
            // XOR-in new contribution (same hash computation as saveCachedCharacters)
            const newFav = characterDigestFavHash(character) % 4294967296;
            const newTagIds = characterDigestTagIdsHash(character);
            const newContent = characterDigestFieldsHash(character) % 4294967296;
            runningDigest = combineDigest128(runningDigest, avatar, newFav, newTagIds, newContent);
        }

        await setLastVerifiedDigest(runningDigest);
        console.log('[sync] Stored digest updated incrementally for', fresh.size, 'upsert(s) and', deleteIds.length, 'delete(s)');
    }

    // The cache is now caught up: everything still in it, plus whatever this pass upserted, minus whatever it
    // deleted, IS the current library (see this function's own doc comment on why no separate ground-truth
    // listing is needed). Re-read rather than reconstruct in place so a character that failed
    // processCharacter() server-side (corrupt file etc., filtered out of the batch response, matching /all's
    // own `.filter(c => c.name)` behavior) correctly stays absent instead of resurfacing from a stale local var.
    const allCached = await getAllCachedCharacters();

    // `changed` tells getCharacters() whether this sync actually touched anything - `changes` already covers
    // both upserts and deletes (op: 'upsert'|'delete'), and `previousFailures` covers the retry-refetch path
    // (a record this function re-pulled even though the server-reported delta for THIS call was empty). An
    // empty delta with no retries means the cache genuinely didn't move, which is what lets getCharacters() skip
    // its O(library) merge-and-reindex pass instead of unconditionally repeating it (2026-08 repeated-`/query`
    // investigation) on every boot/nav/SSE-triggered call, most of which find nothing new.
    return { list: Array.from(allCached.values()), changed: changes.length > 0 || previousFailures.length > 0 };
}

// Only run the state-digest anti-entropy check once per page session (see verifyCharacterCacheDigest()'s own
// doc comment on why this doesn't need to run on every getCharacters() call to still catch real drift promptly)
// - getCharacters() is called far more often than once (boot, chat-reset-to-neutral, every create/rename/
// duplicate/delete, every character-library nav open per fetchCharactersDelta()'s own header), and re-running a
// full bucket-digest comparison on every one of those would be pure waste for a check whose whole point is that
// real drift is rare.
let hasVerifiedCharacterCacheDigestThisSession = false;

/** Local cache entries sent to character-digest-worker.js per 'chunk' message - see that worker's own header.
 * Small enough that even a single chunk's `postMessage` structured-clone doesn't itself become a long
 * synchronous stretch on this thread, large enough to keep message-passing overhead a small fraction of total
 * time for a real multi-hundred-thousand-character library. */
const DIGEST_WORKER_SEND_CHUNK_SIZE = 2000;

/**
 * Starts a persistent character-digest-worker.js worker (see that module's own header for the full protocol/
 * rationale), sends it `localHashes` in chunks off this (the browser's main) thread, and resolves once the
 * worker's initial level-0 tree is ready - WITHOUT terminating the worker, unlike the fixed-depth-2 approach this
 * replaces. The worker stays alive so the recursive descent in verifyCharacterCacheDigest() can keep asking it
 * (via workerComputeDigests() below) for children digests at whatever deeper tree nodes the server's own descent
 * turns up as mismatched - the caller owns terminating it once the descent is done.
 * @param {Map<string, {fav: number, tagIds: number, content: number}>} localHashes Pre-computed per-field hashes from getAllCachedHashes()
 * @param {number} branching
 * @returns {Promise<{ children: {digest: {a:number,b:number,c:number,d:number}}[], localHashes: Map<string, {fav:number,tagIds:number,content:number}>, worker: Worker }>}
 */
function computeLocalCharacterDigest(localHashes, branching) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./scripts/character-digest-worker.js', import.meta.url), { type: 'module' });
        worker.onerror = (event) => {
            worker.terminate();
            reject(new Error(event.message ?? 'character-digest-worker.js failed'));
        };
        worker.onmessage = (event) => {
            if (event.data.type === 'ready') {
                // Don't terminate - the worker stays alive for follow-up 'compute-digests' requests as the
                // descent goes deeper. The caller is responsible for terminate()'ing it when done.
                const t_mapBuild = performance.now();
                const computedHashes = new Map(event.data.localHashes);
                console.log(`[digest-timing] new Map(localHashes): ${(performance.now() - t_mapBuild).toFixed(1)}ms (${computedHashes.size} entries, localHashes array length: ${event.data.localHashes?.length})`);
                resolve({
                    children: event.data.children,
                    localHashes: computedHashes,
                    worker,
                });
            }
        };

        (async () => {
            worker.postMessage({ type: 'init', branching });
            const t_arrayFrom = performance.now();
            const entries = Array.from(localHashes.entries());
            console.log(`[digest-timing] Array.from(entries): ${(performance.now() - t_arrayFrom).toFixed(1)}ms (${entries.length} entries)`);
            const t_chunksStart = performance.now();
            let chunkCount = 0;
            for (let i = 0; i < entries.length; i += DIGEST_WORKER_SEND_CHUNK_SIZE) {
                worker.postMessage({ type: 'chunk', entries: entries.slice(i, i + DIGEST_WORKER_SEND_CHUNK_SIZE) });
                chunkCount++;
                // eslint-disable-next-line no-undef
                await new Promise((r) => setTimeout(r, 0));
            }
            console.log(`[digest-timing] postMessage chunks: ${(performance.now() - t_chunksStart).toFixed(1)}ms (${chunkCount} chunks of ${DIGEST_WORKER_SEND_CHUNK_SIZE})`);
            worker.postMessage({ type: 'end' });
        })();
    });
}

/**
 * Asks the still-alive character-digest-worker.js worker (from computeLocalCharacterDigest()) to compute
 * children digests for specific tree nodes, one level deeper than whatever it's already computed - used by
 * verifyCharacterCacheDigest()'s recursive descent once the server's own `/tree-descend` response says a node
 * needs expanding beyond level 0.
 * @param {Worker} worker
 * @param {{ path: number[] }[]} nodes
 * @returns {Promise<{ path: number[], children: { fav: {hi:number,lo:number}, fields: {hi:number,lo:number} }[] }[]>}
 */
function workerComputeDigests(worker, nodes) {
    return new Promise((resolve, reject) => {
        const handler = (event) => {
            if (event.data.type === 'digests') {
                worker.removeEventListener('message', handler);
                resolve(event.data.results);
            }
        };
        worker.addEventListener('message', handler);
        worker.onerror = (event) => {
            worker.removeEventListener('message', handler);
            reject(new Error(event.message ?? 'worker compute-digests failed'));
        };
        worker.postMessage({ type: 'compute-digests', nodes });
    });
}

/**
 * Decodes a binary tree-descend response into the same JS structure as the JSON path.
 * See serializeTreeDescendBinary() server-side for the matching encoder and format spec.
 * @param {ArrayBuffer} buffer
 * @returns {{ results: { path: number[], type: string, children?: {digest:{a:number,b:number,c:number,d:number}}[], members?: {id:string,favHash:number,tagIdsHash:number,contentHash:number,fav:boolean}[] }[] }}
 */
function deserializeTreeDescendBinary(buffer) {
    const view = new DataView(buffer);
    let offset = 0;

    const resultCount = view.getUint16(offset, true); offset += 2;
    const results = [];

    for (let r = 0; r < resultCount; r++) {
        const pathLength = view.getUint8(offset); offset += 1;
        const path = [];
        for (let p = 0; p < pathLength; p++) {
            path.push(view.getUint8(offset)); offset += 1;
        }
        const typeFlag = view.getUint8(offset); offset += 1;

        if (typeFlag === 0) {
            // children
            const childCount = view.getUint16(offset, true); offset += 2;
            const children = [];
            for (let ci = 0; ci < childCount; ci++) {
                const a = view.getUint32(offset, true); offset += 4;
                const b = view.getUint32(offset, true); offset += 4;
                const c = view.getUint32(offset, true); offset += 4;
                const d = view.getUint32(offset, true); offset += 4;
                children.push({ digest: { a, b, c, d } });
            }
            results.push({ path, type: 'children', children });
        } else {
            // leaves
            const memberCount = view.getUint16(offset, true); offset += 2;
            const members = [];
            const decoder = new TextDecoder();
            for (let mi = 0; mi < memberCount; mi++) {
                const idLen = view.getUint16(offset, true); offset += 2;
                const idBytes = new Uint8Array(buffer, offset, idLen);
                const id = decoder.decode(idBytes);
                offset += idLen;
                const favHash = view.getUint32(offset, true); offset += 4;
                const tagIdsHash = view.getUint32(offset, true); offset += 4;
                const contentHash = view.getUint32(offset, true); offset += 4;
                const fav = view.getUint8(offset) !== 0; offset += 1;
                members.push({ id, favHash, tagIdsHash, contentHash, fav });
            }
            results.push({ path, type: 'leaves', members });
        }
    }

    return { results };
}

/**
 * Anti-entropy check for the character cache (see character-metadata-digest-worker.js's own header for the
 * server-side recursive hash-tree shape, and character-metadata-db.js's treeDescend() for the server half).
 * `/api/characters/changes`'s seq cursor tells a client what's mutated SINCE it last synced, but has no way to
 * notice a cursor that LOOKS caught-up while the actual cached content has quietly diverged - e.g. a
 * character-cache.js write that silently failed (saveCachedCharacters() logs and swallows per-entry errors
 * rather than aborting the sync), or a browser evicting part of this origin's IndexedDB under storage pressure.
 *
 * Deliberately built on content hashes (hash-utils.js's `contentHashOf()`), computed fresh from whatever's
 * actually sitting in the cache right now (getAllCachedCharacters()), never from a separately-stored per-record
 * value this function would otherwise have to trust.
 *
 * GENUINELY RECURSIVE DESCENT, not a fixed 2-level tree: the client calls `/api/characters/tree-descend`
 * repeatedly, once per descent level, expanding whichever nodes mismatched at the previous level, until every
 * mismatch is either resolved to individual records (`type: 'leaves'`) or the loop runs out of nodes to expand.
 * RT 1 asks for the root (`path: []`); the server replies with either `children` (if the corpus is bigger than
 * leafThreshold) or `leaves` directly. Every subsequent RT expands exactly the child indices whose digests
 * disagreed with this client's own locally-computed digests for that node - level 0 comes for free from
 * computeLocalCharacterDigest()'s initial pass, and any deeper level is computed on demand by asking the still-
 * alive worker (workerComputeDigests()) rather than recomputing from scratch. The number of round trips this
 * takes is NOT fixed - it adapts to how deep the actual divergence sits, and to corpus size (see
 * character-metadata-digest-worker.js's own header on the O(log_N(corpusSize / leafThreshold)) depth).
 *
 * LEAF RESPONSES ARE HASH-ONLY: `type: 'leaves'` members carry just `{id, favHash, fieldsHash}` (~40 bytes per
 * record), not fingerprint values - see character-metadata-digest-worker.js's own header on why. After the
 * descent loop below finishes, drifted ids (those whose local hash disagrees) are collected, and their actual
 * fingerprint field values are fetched in one targeted follow-up call to `/api/characters/fingerprint-values`
 * (resolveFingerprints() server-side) - never inline with the leaf response itself.
 *
 * NO ABORT CAP: with hash-only leaf responses and leafThreshold derived from the branching factor's per-record
 * vs per-children-digest crossover (see DEFAULT_TREE_BRANCHING in hash-utils.js), the tree's total cost at
 * any corruption level is structurally ≤ a flat full digest (transferring per-record hashes for every record).
 * At low corruption, the tree prunes matching subtrees and costs far less. At high corruption, the tree
 * converges to exactly the flat digest cost as every subtree is expanded. There is no corruption level where
 * the tree costs MORE than the simplest possible alternative, so no abort/fallback is needed.
 *
 * Never awaited by its caller (fetchCharactersDelta()) - runs after the delta sync has already returned, so it
 * never adds latency to boot or any other getCharacters() call.
 * @returns {Promise<void>}
 */
async function verifyCharacterCacheDigest() {
    if (hasVerifiedCharacterCacheDigestThisSession) return;
    hasVerifiedCharacterCacheDigestThisSession = true;

    const branching = DEFAULT_TREE_BRANCHING;
    const leafThreshold = Math.ceil(branching * 1.5);

    console.log('[digest-timing] verifyCharacterCacheDigest starting');
    const t_start = performance.now();

    // Step 1: Fetch server's root-level children (one HTTP call, triggers a server-side table scan
    // on the digest worker thread - not on the Node event loop). This is the cheapest possible way
    // to learn the server's current state without any client-side computation.
    const rootResponse = await fetch('/api/characters/tree-descend', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ branching, leafThreshold, nodes: [{ path: [] }], binary: true }),
    });
    if (!rootResponse.ok) {
        throw new Error(`Tree-descend root fetch failed: ${rootResponse.statusText}`);
    }
    const { results: rootResults } = deserializeTreeDescendBinary(await rootResponse.arrayBuffer());
    const rootResult = rootResults?.[0];

    // Step 2: Fast-path - compare server's root aggregate against stored digest from the last
    // successful verification. Both are 128-bit content-derived hashes (XOR-fold of per-record
    // per-field hashes), not counters. If they match, the server hasn't changed since the last
    // full verification, so the expensive O(library) client-side computation can be skipped.
    if (rootResult?.type === 'children') {
        let serverRoot = emptyDigest128();
        for (const child of rootResult.children) {
            serverRoot = foldDigests128(serverRoot, child.digest ?? emptyDigest128());
        }

        const storedDigest = await getLastVerifiedDigest();
        if (storedDigest && digestsEqual128(serverRoot, storedDigest)) {
            console.log(`[digest-timing] fast-path skip: server root digest unchanged (${(performance.now() - t_start).toFixed(1)}ms)`);
            return;
        }
        console.log('[digest-timing] server root changed or no stored digest, proceeding with full verification');
    }

    // Step 3: Full verification - expensive client-side computation only runs when the server's
    // root actually differs from what was last verified.
    const t_cache = performance.now();
    const localHashes = await getAllCachedHashes();
    console.log(`[digest-timing] getAllCachedHashes: ${(performance.now() - t_cache).toFixed(1)}ms (${localHashes.size} entries)`);

    const t_compute = performance.now();
    const { children: localChildren, localHashes: localPerRecordHashes, worker } =
        await computeLocalCharacterDigest(localHashes, branching);
    console.log(`[digest-timing] computeLocalCharacterDigest total: ${(performance.now() - t_compute).toFixed(1)}ms`);

    try {
        // Reuse the root response from step 1 (don't re-fetch). Process it the same way the
        // descent loop would, but inline since we already have the data.
        let currentNodes = [];
        const allLeaves = [];

        if (rootResult?.type === 'children') {
            for (let i = 0; i < branching; i++) {
                const sd = rootResult.children[i]?.digest ?? emptyDigest128();
                const ld = localChildren[i]?.digest ?? emptyDigest128();
                if (!digestsEqual128(sd, ld)) {
                    currentNodes.push({ path: [i] });
                }
            }
        } else if (rootResult?.type === 'leaves') {
            allLeaves.push(rootResult);
        }

        const t_descent = performance.now();

        // Continue descent for any mismatched children (same loop as before, just starting
        // from level 1 since level 0 was already processed above from the reused root response).
        while (currentNodes.length > 0) {
            const response = await fetch('/api/characters/tree-descend', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ branching, leafThreshold, nodes: currentNodes, binary: true }),
            });
            if (!response.ok) {
                throw new Error(`Tree-descend failed: ${response.statusText}`);
            }
            const { results: allResults } = deserializeTreeDescendBinary(await response.arrayBuffer());

            const nextNodes = [];

            // Collect all children-type results that need local digest comparison. For nodes deeper than level
            // 0, batch the workerComputeDigests calls to avoid one message-round-trip per node.
            const childrenResults = allResults.filter(r => r.type !== 'leaves');
            for (const result of allResults) {
                if (result.type === 'leaves') {
                    allLeaves.push(result);
                }
            }

            if (childrenResults.length > 0) {
                // Compute local digests for all non-root children results in one worker call
                const deeperNodes = childrenResults.filter(r => r.path.length > 0);
                let localDigestsByPath = new Map();
                if (deeperNodes.length > 0) {
                    const workerResults = await workerComputeDigests(worker, deeperNodes.map(r => ({ path: r.path })));
                    for (const wr of workerResults) {
                        localDigestsByPath.set(wr.path.join(','), wr.children);
                    }
                }

                for (const result of childrenResults) {
                    const localDigests = result.path.length === 0
                        ? localChildren
                        : localDigestsByPath.get(result.path.join(','));

                    if (!localDigests) continue;

                    for (let i = 0; i < branching; i++) {
                        const sd = result.children[i]?.digest ?? emptyDigest128();
                        const ld = localDigests[i]?.digest ?? emptyDigest128();
                        if (!digestsEqual128(sd, ld)) {
                            nextNodes.push({ path: [...result.path, i] });
                        }
                    }
                }
            }

            if (nextNodes.length > 0) {
                console.warn(`Tree descent: ${nextNodes.length} mismatched node(s) at depth ${nextNodes[0].path.length}, descending further.`);
            }

            currentNodes = nextNodes;
        }
        console.log(`[digest-timing] tree descent total: ${(performance.now() - t_descent).toFixed(1)}ms, leaves: ${allLeaves.length}`);
        const t_repair = performance.now();

        // Process all collected leaf results: compare per-record hashes, identify drift by id. Leaf members are
        // hash-only ({id, favHash, fieldsHash}) - no fingerprint values are carried here (see this function's own
        // doc comment) - so this pass only decides WHICH ids drifted; their actual field values are fetched in a
        // single targeted follow-up call below, not per-leaf.
        const toRemove = [];
        /** @type {Map<string, string[]>} id -> drifted field groups */
        const driftedById = new Map();
        /** @type {Map<string, boolean>} id -> server fav value (for direct fav repair) */
        const serverFavValues = new Map();
        /** @type {string[]} ids in collision leaves (32-bit per-field all agree, 128-bit aggregate disagrees) */
        const collisionIds = [];

        for (const leaf of allLeaves) {
            const serverIdsInLeaf = new Set();
            let leafHasFieldDrift = false;

            for (const member of leaf.members) {
                serverIdsInLeaf.add(member.id);
                if (!localHashes.has(member.id)) {
                    // Record exists on server but not locally - genuine set-difference drift
                    // (a new import the change feed will sync), NOT a per-field collision.
                    // Must set leafHasFieldDrift so the collision fallback doesn't fire for
                    // the entire leaf's other members.
                    leafHasFieldDrift = true;
                    continue;
                }

                const local = localPerRecordHashes.get(member.id);
                if (!local) {
                    leafHasFieldDrift = true;
                    continue;
                }

                const fields = [];
                if (local.fav !== member.favHash) fields.push('fav');
                if (local.tagIds !== member.tagIdsHash) fields.push('tag_ids');
                if (local.content !== member.contentHash) fields.push('content');

                if (fields.length > 0) {
                    driftedById.set(member.id, fields);
                    leafHasFieldDrift = true;
                    if (fields.includes('fav')) {
                        serverFavValues.set(member.id, member.fav);
                    }
                }
            }

            // Collision handling: this leaf was reached because a parent's 128-bit aggregate
            // disagreed, but no per-field 32-bit hash mismatches were found. A 32-bit collision
            // is hiding a real difference. Fall back to value comparison for all members.
            if (!leafHasFieldDrift) {
                for (const member of leaf.members) {
                    if (localHashes.has(member.id)) {
                        collisionIds.push(member.id);
                    }
                }
            }

            // Detect locally-cached records that the server doesn't have in this leaf group
            for (const [id] of localHashes) {
                let inSubtree = true;
                for (let l = 0; l < leaf.path.length; l++) {
                    if (treeNodeAt(id, l, branching) !== leaf.path[l]) {
                        inSubtree = false;
                        break;
                    }
                }
                if (inSubtree && !serverIdsInLeaf.has(id)) {
                    toRemove.push(id);
                }
            }
        }

        if (toRemove.length > 0) {
            await removeCachedCharacters(toRemove);
        }

        /** @type {Map<string, object>} avatar -> patched character */
        const patched = new Map();

        // Direct fav repair (no fetch needed - value carried in leaf response)
        for (const [id, fav] of serverFavValues) {
            const character = charactersStore.get(id);
            if (!character) continue;
            character.fav = fav;
            if (character.data?.extensions) {
                character.data.extensions.fav = fav;
            }
            patched.set(id, character);
        }

        // tag_ids repair via fields-filtered batch
        const tagIdsDrifted = [...driftedById.entries()]
            .filter(([, fields]) => fields.includes('tag_ids'))
            .map(([id]) => id);
        if (tagIdsDrifted.length > 0) {
            const batchResponse = await fetch('/api/characters/batch', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ avatars: tagIdsDrifted, fields: ['tag_ids'] }),
            });
            if (batchResponse.ok) {
                const batchData = await batchResponse.json();
                for (const partial of batchData) {
                    const character = patched.get(partial.avatar) || charactersStore.get(partial.avatar);
                    if (character && 'tag_ids' in partial) {
                        character.tag_ids = partial.tag_ids;
                        patched.set(partial.avatar, character);
                    }
                }
            }
        }

        // Content repair via fields-filtered batch
        const contentDrifted = [...driftedById.entries()]
            .filter(([, fields]) => fields.includes('content'))
            .map(([id]) => id);
        if (contentDrifted.length > 0) {
            const batchResponse = await fetch('/api/characters/batch', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ avatars: contentDrifted, fields: ['name', 'tags', 'data'] }),
            });
            if (batchResponse.ok) {
                const batchData = await batchResponse.json();
                for (const partial of batchData) {
                    const character = patched.get(partial.avatar) || charactersStore.get(partial.avatar);
                    if (!character) continue;
                    if ('name' in partial) character.name = partial.name;
                    if ('tags' in partial) character.tags = partial.tags;
                    if ('data' in partial) character.data = partial.data;
                    patched.set(partial.avatar, character);
                }
            }
        }

        // Collision repair: 128-bit aggregate disagreed but every 32-bit per-field hash agreed.
        // Fall back to value comparison using the fingerprint-values endpoint.
        if (collisionIds.length > 0) {
            console.warn(`Tree descent: ${collisionIds.length} record(s) in collision leaf, falling back to value comparison.`);
            const fpResponse = await fetch('/api/characters/fingerprint-values', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ ids: collisionIds }),
            });
            if (fpResponse.ok) {
                const { records: fpRecords } = await fpResponse.json();
                for (const record of fpRecords) {
                    const character = patched.get(record.id) || charactersStore.get(record.id);
                    if (!character) continue;
                    const fp = record.fingerprint;
                    character.name = fp.name;
                    character.fav = fp.fav;
                    character.tags = fp.tags;
                    character.tag_ids = fp.tag_ids;
                    character.data = character.data || {};
                    character.data.name = fp.data?.name;
                    character.data.character_version = fp.data?.character_version;
                    character.data.creator = fp.data?.creator;
                    character.data.tags = fp.data?.tags;
                    character.data.creator_notes = fp.data?.creator_notes;
                    character.data.extensions = character.data.extensions || {};
                    character.data.extensions.fav = fp.data?.extensions?.fav;
                    character.data.extensions.world = fp.data?.extensions?.world;
                    patched.set(record.id, character);
                }
            }
        }

        if (patched.size > 0) {
            await saveCachedCharacters(Array.from(patched, ([avatar, character]) => ({ avatar, character })));
        }

        if (patched.size > 0 || toRemove.length > 0) {
            for (const id of toRemove) {
                const index = characters.findIndex(c => c.avatar === id);
                if (index !== -1) characters.splice(index, 1);
            }
            for (const [avatar, character] of patched) {
                const index = characters.findIndex(c => c.avatar === avatar);
                if (index !== -1) characters[index] = character;
                else characters.push(character);
            }
            charactersStore.reindex();
            await printCharacters(true);
        }
        console.log(`[digest-timing] repair total: ${(performance.now() - t_repair).toFixed(1)}ms, patched: ${patched.size}, removed: ${toRemove.length}, collisions: ${collisionIds.length}`);

        // Store the server's root digest for next session's fast-path. Content-derived (XOR-fold
        // of all per-record per-field hashes), not a counter.
        if (rootResult?.type === 'children') {
            let serverRoot = emptyDigest128();
            for (const child of rootResult.children) {
                serverRoot = foldDigests128(serverRoot, child.digest ?? emptyDigest128());
            }
            await setLastVerifiedDigest(serverRoot);
            console.log('[digest-timing] stored server root digest for fast-path');
        }

        console.log(`[digest-timing] verifyCharacterCacheDigest total: ${(performance.now() - t_start).toFixed(1)}ms`);
    } finally {
        worker.terminate();
    }
}

/**
 * Fetches the full character list unconditionally via `/api/characters/all`, with no caching involved. This is
 * the pre-delta-cache behavior, kept as-is as the fallback path for when fetchCharactersDelta() fails for any
 * reason (e.g. the manifest/batch endpoints being unreachable) - always correct, just without the bandwidth
 * savings.
 * @returns {Promise<object[]|undefined>} The full character list, or undefined if the fetch failed (in which
 * case this function has already reported the failure itself, same as the old inline getCharacters() body did).
 */
async function fetchAllCharacters() {
    const response = await fetch('/api/characters/all', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({}),
    });

    if (!response.ok) {
        console.error('Failed to fetch characters:', response.statusText);
        const errorData = await response.json();
        if (errorData?.overflow) {
            await Popup.show.text(t`Character data length limit reached`, t`To resolve this, set "performance.lazyLoadCharacters" to "true" in config.yaml and restart the server.`);
        }
        return undefined;
    }

    const getData = await response.json();
    for (const character of getData) {
        finalizeFetchedCharacter(character);
    }
    return getData;
}

/**
 * Customizer for lodash's mergeWith(), used to merge a shallow character payload onto a resident one (see
 * getCharacters() below). Plain lodash merge() would be right for objects (recurse field-by-field, key absent
 * from source leaves the destination's value untouched) but wrong for arrays (it merges them index-by-index,
 * e.g. a shorter incoming array would only overwrite the leading elements and leave trailing ones from the old
 * array behind) - toShallow()'s projection nests thin objects under `data`/`data.extensions`, and any of those
 * fields (e.g. `data.tags`) can be an array that's meant to replace wholesale, including replacing with an
 * empty one. Returning the incoming array as-is here (rather than undefined, which would fall through to
 * mergeWith's default per-index merge) makes arrays and everything else that isn't a plain object replace
 * wholesale, while plain objects still keep recursing via the default behavior.
 * @param {*} _objValue
 * @param {*} srcValue
 * @returns {*} the replacement value, or undefined to let mergeWith apply its default behavior
 */
function mergeShallowCharacterCustomizer(_objValue, srcValue) {
    if (Array.isArray(srcValue)) {
        return srcValue;
    }
    return undefined;
}

export async function getCharacters({ silent = false, silentGroups = false } = {}) {
    let newCharacters;
    // Whether the character sync actually found anything to apply - drives whether the O(library) merge below
    // (and the reindex/this_avatar-reselect work that follows it) runs at all. `fetchAllCharacters()`'s full-list
    // fallback has no cheap way to know this (it always returns the whole library, not a delta), so that path
    // stays conservative and always reports a change - this optimization only targets the common
    // fetchCharactersDelta() path, which already knows (2026-08 repeated-`/query` investigation: getCharacters()
    // used to pay this merge and an unconditional trailing printCharacters(true) on every call, even the many
    // that fetchCharactersDelta() itself found nothing to sync).
    let charactersChanged = true;
    try {
        const delta = await fetchCharactersDelta();
        newCharacters = delta.list;
        charactersChanged = delta.changed;
    } catch (error) {
        console.error('Character manifest/delta fetch failed, falling back to a full character list fetch:', error);
        newCharacters = await fetchAllCharacters();
    }

    if (newCharacters === undefined) {
        // Both paths already reported the failure (fetchAllCharacters shows the overflow popup itself); nothing
        // further to do - same as the old code's implicit no-op on a failed response.
        return;
    }

    if (charactersChanged) {
    // Merge newCharacters into the existing `characters` array in place rather than wholesale-replacing it.
    // newCharacters can legitimately be a *shallow* projection of the library (toShallow() / useShallowCharacters)
    // that simply omits heavy fields like data.alternate_greetings - that omission means "not included in this
    // projection", not "this field is now gone". A full splice-replace was treating it as the latter: a
    // character that had already been unshallowed (e.g. by the autoload path during boot, which races this
    // still-in-flight fetch) would get its full entity swapped out for the thinner shallow one, silently losing
    // alternate_greetings and anything else the projection doesn't carry. Merging field-by-field onto the
    // existing object (incoming fields overwrite, fields the incoming payload doesn't carry are left alone)
    // keeps already-resident heavy data intact while still picking up whatever did change upstream. The merge
    // has to be deep, not a shallow Object.assign: toShallow() nests its own thin projection under a `data` key
    // (and `data.extensions` under that), so `data` itself is a key *present* on the incoming payload - a
    // shallow assign would replace the whole `data` object, alternate_greetings included, reproducing the same
    // clobber one level down. lodash's mergeWith() (with a customizer that keeps arrays replacing wholesale
    // rather than merging index-by-index - see mergeShallowCharacterCustomizer() above) recurses into plain
    // objects instead, so a key absent from the incoming payload is left untouched at any depth, while a key
    // that IS present - including an array or an empty value - still overwrites. Characters no longer present
    // upstream are removed (this is also how deletions propagate - a
    // merge that only ever added/updated would leave deleted characters resident forever), and characters newly
    // present are added.
    const newByAvatar = new Map(newCharacters.map(c => [c.avatar, c]));
    for (const existing of characters) {
        const incoming = newByAvatar.get(existing.avatar);
        if (!incoming) continue;
        // getOneCharacter() (above) explicitly resets `shallow` to false when it fetches full data, because
        // processCharacter()'s full-data branch never sets `shallow: false` itself, and the merge below only
        // overwrites keys actually present in the patch - so without that reset, an entity that was ever shallow
        // would keep reading as shallow forever. The same asymmetry applies here in reverse: `incoming.shallow
        // === true` is a true statement about *this* fetched payload, but not about `existing` if it was already
        // unshallowed - it still holds the earlier full data underneath these fresher shallow fields. Letting the
        // merge downgrade it back to `shallow: true` would make unshallowCharacter() treat an already-full
        // character as needing a redundant re-fetch, so that one field is preserved rather than merged.
        const wasUnshallowed = existing.shallow === false;
        lodash.mergeWith(existing, incoming, mergeShallowCharacterCustomizer);
        if (wasUnshallowed && incoming.shallow === true) {
            existing.shallow = false;
        }
    }
    for (let i = characters.length - 1; i >= 0; i--) {
        if (!newByAvatar.has(characters[i].avatar)) {
            characters.splice(i, 1);
        }
    }
    const existingAvatars = new Set(characters.map(c => c.avatar));
    for (const incoming of newCharacters) {
        if (!existingAvatars.has(incoming.avatar)) {
            characters.push(incoming);
        }
    }

    // Fuse-index invalidation is handled by the charactersStore.onChange subscriber (see charactersStore's
    // definition above) - reset() emits directly, and reindex()'s silent callers all follow up with a
    // reportCreated()/reportRemoved()/reportRenamed() of their own right after this call returns. The merge
    // above is still a bulk refetch-and-rebuild with no single more-specific create/delete/rename intent (see
    // EntityStore's own reset() doc comment), so it still fits reset()'s "the whole collection may have
    // changed" semantics - one summary event, not a flood of per-entity ones.
    if (silent) {
        charactersStore.reindex();
    } else {
        charactersStore.reset();
    }

    if (this_avatar) {
        // this_avatar is untouched by the merge/reload above (it's a separate variable, not derived from
        // the array), so it's still exactly the avatar that was selected before this reload - selecting by
        // avatar directly needs no index lookup.
        if (charactersStore.get(this_avatar)) {
            await selectCharacterByAvatar(this_avatar, { switchMenu: false });
        } else {
            await Popup.show.text(t`ERROR: The active character is no longer available.`, t`The page will be refreshed to prevent data loss. Press "OK" to continue.`);
            return location.reload();
        }
    }
    } // end if (charactersChanged)

    await getGroups({ silent: silentGroups });
    await printCharacters(true);
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
            chat_metadata = {};
            await replaceCurrentChat();
        }
        await eventSource.emit(event_types.CHAT_DELETED, name);
    }
}

/**
 * Deletes a character chat by its name.
 * @param {string} avatar Character avatar to delete chat for
 * @param {string} fileName Name of the chat file to delete (without .jsonl extension)
 * @returns {Promise<void>} A promise that resolves when the chat is deleted.
 */
export async function deleteCharacterChatByName(avatar, fileName) {
    /** @type {Character} */
    const character = charactersStore.get(avatar);

    // Make sure all the data is loaded.
    await unshallowCharacter(character?.avatar);

    if (!character) {
        console.warn(`Character with avatar ${avatar} not found.`);
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

    if (fileName === character.chat) {
        const chatsResponse = await fetch('/api/characters/chats', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ avatar_url: character.avatar }),
        });
        const chats = Object.values(await chatsResponse.json());
        chats.sort((a, b) => sortMoments(timestampToMoment(a.last_mes), timestampToMoment(b.last_mes)));
        const newChatName = chats.length && typeof chats[0] === 'object' ? chats[0].file_name.replace('.jsonl', '') : `${character.name} - ${humanizedDateTime()}`;
        await updateRemoteChatName(character.avatar, newChatName);
    }

    await eventSource.emit(event_types.CHAT_DELETED, fileName);
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
            // pick existing chat
            charactersStore.update(getCurrentCharacter().avatar, { chat: chats[0].file_name.replace('.jsonl', '') });
            $('#selected_chat_pole').val(getCurrentCharacter().chat);
            await saveActiveChat(getCurrentCharacter().avatar, getCurrentCharacter().chat);
            await getChat();
        } else {
            // start new chat
            charactersStore.update(getCurrentCharacter().avatar, { chat: `${name2} - ${humanizedDateTime()}` });
            $('#selected_chat_pole').val(getCurrentCharacter().chat);
            await saveActiveChat(getCurrentCharacter().avatar, getCurrentCharacter().chat);
            await getChat({ isNewChat: true });
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

function getMessageDeletionStartId(id, deleteToolCalls = true) {
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
 */
export async function deleteMessage(id, swipeDeletionIndex = undefined, askConfirmation = false, deleteToolCalls = true) {
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

    // If the message being edited is about to be removed, close the editor first while its
    // DOM element and chat entry still exist, so the editor UI gets restored properly.
    if (this_edit_mes_id !== undefined && messageIds.includes(Number(this_edit_mes_id))) {
        closeMessageEditor();
    }

    // Delete from the end so earlier indices remain stable.
    for (const messageId of messageIds) {
        chat.splice(messageId, 1);
        chatElement.find(`.mes[mesid="${messageId}"]`).remove();
        deleteItemizedPromptForMessage(messageId);
    }

    chat_metadata.tainted = true;

    // Removing the tail of a conversation is the store's "this ends here", said on the message it now
    // ends at. Without it the comparison-driven save had nothing to send: it walks the messages it was
    // handed and writes them, and a message no longer in the array is simply never mentioned, so the
    // deletion showed on screen and came back on the next load.
    //
    // Only for a removal that reaches the end. Taking one out of the middle cannot be said this way -
    // the conversation is read off the last message's chain of parents, so a node in the middle of
    // that chain is not something a selection can step around - and it is still unhandled.
    if (chat_metadata?._tree_stored && chat.length > 0 && Math.min(...messageIds) === chat.length) {
        await chatOpEndPath(chat.length - 1).catch(error =>
            console.error('Could not end the conversation at the last remaining message:', error));
    }

    const startIndex = firstMessageId <= minId ? firstMessageId : null;
    updateViewMessageIds(startIndex);
    saveChatDebounced();

    refreshSwipeButtons();

    await eventSource.emit(event_types.MESSAGE_DELETED, chat.length);
}

export const reloadChatMutex = new SimpleMutex(reloadCurrentChatUnsafe);
export const reloadCurrentChat = reloadChatMutex.update.bind(reloadChatMutex);

export const userInputGenerateMutex = new SimpleMutex(sendTextareaMessage);

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

/**
 * Send the message currently typed into the chat box.
 */
export async function sendTextareaMessage() {
    // don't proceed during swipeGenerate()
    if (swipeState == SWIPE_STATE.EDITING) {
        toastr.warning(t`Confirm the edit to start a generation.`, t`You cannot send a message during a swipe-edit.`);
        return;
    }
    if (swipeState !== SWIPE_STATE.NONE) return; // don't proceed if mid-swipe.
    if (is_send_press) return;

    // Overswiping a user message opens a blank slot at the end to type into, and truncates the view to
    // it. Nothing has been written yet, so there is nothing to send - generating from here puts an empty
    // user turn at the end of the prompt.
    //
    // Asked of the slot rather than of a flag. The SWIPE_STATE.EDITING check above was meant to cover
    // this, but nothing in the client ever assigns that state, so it can never fire (option_continue
    // survives only because it also checks this_edit_mes_id, which is genuinely maintained). A state
    // nobody sets is the same hazard as one nobody clears; the slot's own emptiness cannot get stuck.
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
 * Formats raw message text into an HTML string ready for DOM insertion.
 *
 * The pipeline is, in order:
 *   1. Prompt-bias stripping (message 0 only)
 *   2. Comment / hidden-message normalisation
 *   3. `beforeRegex` extension hooks (see {@link MessageFormatter})
 *   4. Custom regex rules (`getRegexedString`)
 *   5. `afterRegex` extension hooks
 *   6. Markdown auto-fix (`fixMarkdown`)
 *   7. HTML tag encoding (`encode_tags`)
 *   8. Showdown Markdown → HTML conversion
 *   9. `afterMarkdown` extension hooks
 *  10. Name-prefix stripping (`allow_name2_display`)
 *  11. DOMPurify sanitization
 *
 * All extension hooks run **before** DOMPurify (steps 3, 5, 9) so their
 * output is always sanitised.
 *
 * @param {string} mes - Raw message text.
 * @param {string} ch_name - Character name associated with the message.
 * @param {boolean} isSystem - Whether the message is a system message.
 * @param {boolean} isUser - Whether the message was sent by the user.
 * @param {number} messageId - Index of the message in the chat array, or -1
 *   for transient messages (e.g. streaming previews).
 * @param {Partial<DOMPurify.Config>} [sanitizerOverrides] - DOMPurify option
 *   overrides. Merged on top of the default config.
 * @param {boolean} [isReasoning=false] - Whether the message is reasoning/thinking
 *   output (affects regex placement and some display rules).
 * @returns {string} Sanitized HTML string ready to assign to `innerHTML`.
 */
export function messageFormatting(mes, ch_name, isSystem, isUser, messageId, sanitizerOverrides = {}, isReasoning = false) {
    if (!mes) {
        return '';
    }

    if (Number(messageId) === 0 && !isSystem && !isUser && !isReasoning) {
        const mesBeforeReplace = mes;
        const chatMessage = chat[messageId];
        mes = substituteParams(mes, undefined, ch_name);
        if (chatMessage && chatMessage.mes === mesBeforeReplace && chatMessage.extra?.display_text !== mesBeforeReplace) {
            updateMessage(Number(messageId), { mes });
        }
    }

    mesForShowdownParse = mes;

    // Force isSystem = false on comment messages so they get formatted properly
    if (ch_name === COMMENT_NAME_DEFAULT && isSystem && !isUser) {
        isSystem = false;
    }

    // Let hidden messages have markdown
    if (isSystem && ch_name !== systemUserName) {
        isSystem = false;
    }

    // Prompt bias replacement should be applied on the raw message
    const replacedPromptBias = power_user.user_prompt_bias && substituteParams(power_user.user_prompt_bias);
    if (!power_user.show_user_prompt_bias && ch_name && !isUser && !isSystem && replacedPromptBias && mes.startsWith(replacedPromptBias)) {
        mes = mes.slice(replacedPromptBias.length);
    }

    if (!isSystem) {
        function getRegexPlacement() {
            try {
                if (isReasoning) {
                    return regex_placement.REASONING;
                }
                if (isUser) {
                    return regex_placement.USER_INPUT;
                } else if (chat[messageId]?.extra?.type === 'narrator') {
                    return regex_placement.SLASH_COMMAND;
                } else {
                    return regex_placement.AI_OUTPUT;
                }
            } catch {
                return regex_placement.AI_OUTPUT;
            }
        }

        const regexPlacement = getRegexPlacement();
        const usableMessages = chat.map((x, index) => ({ message: x, index: index })).filter(x => !x.message.is_system);
        const indexOf = usableMessages.findIndex(x => x.index === Number(messageId));
        const depth = messageId >= 0 && indexOf !== -1 ? (usableMessages.length - indexOf - 1) : undefined;

        mes = MessageFormatter.runStage(MessageFormatter.stage.BEFORE_REGEX, mes,
            { ch_name, isSystem, isUser, messageId, isReasoning },
        );

        // Always override the character name
        mes = getRegexedString(mes, regexPlacement, {
            characterOverride: ch_name,
            isMarkdown: true,
            depth: depth,
        });

        mes = MessageFormatter.runStage(MessageFormatter.stage.AFTER_REGEX, mes,
            { ch_name, isSystem, isUser, messageId, isReasoning },
        );
    }

    if (power_user.auto_fix_generated_markdown) {
        mes = fixMarkdown(mes, true);
    }

    if (!isSystem && power_user.encode_tags) {
        mes = canUseNegativeLookbehind()
            ? mes.replaceAll('<', '&lt;').replace(new RegExp('(?<!^|\\n\\s*)>', 'g'), '&gt;')
            : mes.replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    }

    // Make sure reasoning strings are always shown, even if they include "<" or ">"
    [power_user.reasoning.prefix, power_user.reasoning.suffix].forEach((reasoningString) => {
        if (!reasoningString || !reasoningString.trim().length) {
            return;
        }
        // Only replace the first occurrence of the reasoning string
        if (mes.includes(reasoningString)) {
            mes = mes.replace(reasoningString, escapeHtml(reasoningString));
        }
    });

    if (!isSystem) {
        // Save double quotes in tags as a special character to prevent them from being encoded
        if (!power_user.encode_tags) {
            mes = mes.replace(/<([^>]+)>/g, function (_, contents) {
                return '<' + contents.replace(/"/g, '\ufffe') + '>';
            });
        }

        mes = mes.replace(
            /<style>[\s\S]*?<\/style>|```[\s\S]*?```|~~~[\s\S]*?~~~|``[\s\S]*?``|`[\s\S]*?`|(".*?")|(\u201C.*?\u201D)|(\u00AB.*?\u00BB)|(\u300C.*?\u300D)|(\u300E.*?\u300F)|(\uFF02.*?\uFF02)/gim,
            function (match, p1, p2, p3, p4, p5, p6) {
                if (p1) {
                    // English double quotes
                    return `<q>"${p1.slice(1, -1)}"</q>`;
                } else if (p2) {
                    // Curly double quotes “ ”
                    return `<q>“${p2.slice(1, -1)}”</q>`;
                } else if (p3) {
                    // Guillemets « »
                    return `<q>«${p3.slice(1, -1)}»</q>`;
                } else if (p4) {
                    // Corner brackets 「 」
                    return `<q>「${p4.slice(1, -1)}」</q>`;
                } else if (p5) {
                    // White corner brackets 『 』
                    return `<q>『${p5.slice(1, -1)}』</q>`;
                } else if (p6) {
                    // Fullwidth quotes ＂ ＂
                    return `<q>＂${p6.slice(1, -1)}＂</q>`;
                } else {
                    // Return the original match if no quotes are found
                    return match;
                }
            },
        );

        // Restore double quotes in tags
        if (!power_user.encode_tags) {
            mes = mes.replace(/\ufffe/g, '"');
        }

        mes = mes.replaceAll('\\begin{align*}', '$$');
        mes = mes.replaceAll('\\end{align*}', '$$');
        mes = converter.makeHtml(mes);

        mes = mes.replace(/<code(.*)>[\s\S]*?<\/code>/g, function (match) {
            // Firefox creates extra newlines from <br>s in code blocks, so we replace them before converting newlines to <br>s.
            return match.replace(/\n/gm, '\u0000');
        });
        mes = mes.replace(/\u0000/g, '\n'); // Restore converted newlines
        mes = mes.trim();

        mes = mes.replace(/<code(.*)>[\s\S]*?<\/code>/g, function (match) {
            return match.replace(/&amp;/g, '&');
        });

        mes = MessageFormatter.runStage(MessageFormatter.stage.AFTER_MARKDOWN, mes,
            { ch_name, isSystem, isUser, messageId, isReasoning },
        );
    }

    if (!power_user.allow_name2_display && ch_name && !isUser && !isSystem) {
        mes = mes.replace(new RegExp(`(^|\n)${escapeRegex(ch_name)}:`, 'g'), '$1');
    }

    /** @type {DOMPurify.Config} */
    const config = {
        RETURN_DOM: false,
        RETURN_DOM_FRAGMENT: false,
        RETURN_TRUSTED_TYPE: false,
        MESSAGE_SANITIZE: true,
        ADD_TAGS: ['custom-style'],
        ...sanitizerOverrides,
    };
    mes = encodeStyleTags(mes);
    mes = DOMPurify.sanitize(mes, config);
    mes = decodeStyleTags(mes, { prefix: '.mes_text ' });

    return mes;
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

        // Frozen objects (deep-frozen messages) can't have properties defined on them.
        // The wrappers were set up pre-freeze during initial load; skip for frozen objects.
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
        for (let index = 0; index < mes.extra.files.length; index++) {
            const file = mes.extra.files[index];
            const template = $('#message_file_template .mes_file_container').clone();
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

    // Set the swipes counter for all non-user messages.
    if (!mes.is_user) {
        updateSwipeCounter(messageId, { message: mes, messageElement });
    }

    return messageElement;
}

/**
 * Returns the URL of the avatar for the given character.
 * @param {string} avatar Character avatar
 * @returns {string} Avatar URL
 */
export function getCharacterAvatar(avatar) {
    const character = charactersStore.get(avatar);
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
 * @prop {object} [jsonSchema] JSON schema to use for the structured generation. Usually requires a special instruction.
 * @prop {boolean} [removeReasoning] Parses and removes the reasoning block according to reasoning format preferences
 * @prop {boolean} [trimToSentence] Whether to trim the response to the last complete sentence
 * @param {GenerateQuietPromptParams} params Parameters for the quiet prompt generation
 * @returns {Promise<string>} Generated text. If using structured output, will contain a serialized JSON object.
 */
export async function generateQuietPrompt({ quietPrompt = '', quietToLoud = false, skipWIAN = false, quietImage = null, quietName = null, responseLength = null, forceChId = null, jsonSchema = null, removeReasoning = true, trimToSentence = false } = {}) {
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
            // forceChId is the public compat surface (numeric legacy character id) - translated to an avatar
            // right here, so everything downstream of this point (Generate(), generateGroupWrapper()) is
            // avatar-shaped internally.
            force_avatar: (forceChId !== null && forceChId !== undefined) ? characters[forceChId]?.avatar ?? null : null,
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

function addPersonaDescriptionExtensionPrompt() {
    const INJECT_TAG = 'PERSONA_DESCRIPTION';
    setExtensionPrompt(INJECT_TAG, '', extension_prompt_types.IN_PROMPT, 0);

    if (!power_user.persona_description || power_user.persona_description_position === persona_description_positions.NONE) {
        return;
    }

    const promptPositions = [persona_description_positions.BOTTOM_AN, persona_description_positions.TOP_AN];

    if (promptPositions.includes(power_user.persona_description_position) && shouldWIAddPrompt) {
        const originalAN = extension_prompts[NOTE_MODULE_NAME].value;
        const ANWithDesc = power_user.persona_description_position === persona_description_positions.TOP_AN
            ? `${power_user.persona_description}\n${originalAN}`
            : `${originalAN}\n${power_user.persona_description}`;

        setExtensionPrompt(NOTE_MODULE_NAME, ANWithDesc, chat_metadata[metadata_keys.position], chat_metadata[metadata_keys.depth], extension_settings.note.allowWIScan, chat_metadata[metadata_keys.role]);
    }

    if (power_user.persona_description_position === persona_description_positions.AT_DEPTH) {
        setExtensionPrompt(INJECT_TAG, power_user.persona_description, extension_prompt_types.IN_CHAT, power_user.persona_description_depth, true, power_user.persona_description_role);
    }
}

/**
 * Returns all extension prompts combined.
 * @returns {Promise<string>} Combined extension prompts
 */
async function getAllExtensionPrompts() {
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
 * @param {string} [options.avatar] Optional character avatar. Falls back to the current character when omitted.
 * @returns {CharacterCardFields} Character card fields with lazy evaluation
 */
export function getCharacterCardFieldsLazy({ avatar = undefined } = {}) {
    const character = avatar !== undefined ? charactersStore.get(avatar) : getCurrentCharacter();

    // For group chats, we need to check if group cards should be used
    const useGroupCards = selected_group && character;
    const groupCardsLazy = useGroupCards ? getGroupCharacterCardsLazy(selected_group, character.avatar) : null;

    /** @type {Record<string, () => string|string[]>} */
    const resolvers = {
        persona: () => baseChatReplace(power_user.persona_description?.trim()),
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
 * @param {string} [options.avatar] Optional character avatar
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

function showStopButton() {
    $('#mes_stop').css({ 'display': 'flex' });
}

function hideStopButton() {
    // prevent NOOP, because hideStopButton() gets called multiple times
    if ($('#mes_stop').css('display') !== 'none') {
        $('#mes_stop').css({ 'display': 'none' });
        eventSource.emit(event_types.GENERATION_ENDED, chat.length);
    }
}

class StreamingProcessor {
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
            // processImageAttachment mutates the message object; clone so the frozen original isn't touched,
            // then apply the changed extra back via updateMessage.
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
        await saveChatConditional();

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
            amount_gen = responseLength;
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
            amount_gen = this.#originalResponseLength;
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
function removeLastMessage() {
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
 * MARK:Generate()
 * Runs a generation using the current chat context.
 * @param {string} type Generation type
 * @param {GenerateOptions} options Generation options
 * @param {boolean} dryRun Whether to actually generate a message or just assemble the prompt
 * @returns {Promise<any>} Returns a promise that resolves when the text is done generating.
 */
export async function Generate(type, { automatic_trigger, force_name2, quiet_prompt, quietToLoud, skipWIAN, force_avatar, signal, quietImage, quietName, jsonSchema = null, depth = 0 } = {}, dryRun = false) {
    console.log('Generate entered');
    setGenerationProgress(0);
    generation_started = new Date();

    // Prevent generation from shallow characters
    await unshallowCharacter(getCurrentCharacter()?.avatar);

    // Occurs every time, even if the generation is aborted due to slash commands execution
    await eventSource.emit(event_types.GENERATION_STARTED, type, { automatic_trigger, force_name2, quiet_prompt, quietToLoud, skipWIAN, force_avatar, signal, quietImage }, dryRun);

    // Don't recreate abort controller if signal is passed
    if (!(abortController && signal)) {
        abortController = new AbortController();
    }

    // OpenAI doesn't need instruct mode. Use OAI main prompt instead.
    const isInstruct = power_user.instruct.enabled && main_api !== 'openai';
    const isImpersonate = type == 'impersonate';

    if (!(dryRun || depth || type == 'regenerate' || type == 'swipe' || type == 'quiet')) {
        const interruptedByCommand = await processCommands(String($('#send_textarea').val()));

        if (interruptedByCommand) {
            //$("#send_textarea").val('')[0].dispatchEvent(new Event('input', { bubbles:true }));
            unblockGeneration(type);
            return Promise.resolve();
        }
    }

    // Occurs only if the generation is not aborted due to slash commands execution
    await eventSource.emit(event_types.GENERATION_AFTER_COMMANDS, type, { automatic_trigger, force_name2, quiet_prompt, quietToLoud, skipWIAN, force_avatar, signal, quietImage }, dryRun);

    if (main_api == 'kobold' && kai_settings.streaming_kobold && !kai_flags.can_use_streaming) {
        toastr.error(t`Streaming is enabled, but the version of Kobold used does not support token streaming.`, undefined, { timeOut: 10000, preventDuplicates: true });
        unblockGeneration(type);
        return Promise.resolve();
    }

    if (isHordeGenerationNotAllowed()) {
        unblockGeneration(type);
        return Promise.resolve();
    }

    if (!dryRun) {
        // Ping server to make sure it is still alive
        const pingResult = await pingServer();

        if (!pingResult) {
            unblockGeneration(type);
            toastr.error(t`Verify that the server is running and accessible.`, t`ST Server cannot be reached`);
            throw new Error('Server unreachable');
        }

        // Hide swipes if not in a dry run.
        hideSwipeButtons();
        // If generated any message, set the flag to indicate it can't be recreated again.
        chat_metadata.tainted = true;
    }

    if (selected_group && !is_group_generating) {
        if (!dryRun) {
            // Returns the promise that generateGroupWrapper returns; resolves when generation is done
            return generateGroupWrapper(false, type, { quiet_prompt, force_avatar, signal: abortController.signal, quietImage, jsonSchema });
        }

        const group = groupsStore.get(selected_group);

        const enabledMembers = group.members.reduce((acc, member) => {
            if (!group.disabled_members.includes(member) && !acc.includes(member)) {
                acc.push(member);
            }
            return acc;
        }, []);

        if (enabledMembers.length > 0) {
            if (menu_type != 'character_edit') setCharacterId(enabledMembers[0]);
            setCharacterName('');
        } else {
            console.log('No enabled members found');
            unblockGeneration(type);
            return Promise.resolve();
        }
    }

    //#########QUIET PROMPT STUFF##############
    //this function just gives special care to novel quiet instruction prompts
    if (quiet_prompt) {
        quiet_prompt = substituteParams(quiet_prompt);
        quiet_prompt = main_api == 'novel' && !quietToLoud ? adjustNovelInstructionPrompt(quiet_prompt) : quiet_prompt;
    }

    const hasBackendConnection = online_status !== 'no_connection';

    // We can't do anything because we're not in a chat right now. (Unless it's a dry run, in which case we need to
    // assemble the prompt so we can count its tokens regardless of whether a chat is active.)
    if (!dryRun && !hasBackendConnection) {
        is_send_press = false;
        return Promise.resolve();
    }

    const lastMessage = chat[chat.length - 1];

    let textareaText;
    if (type !== 'regenerate' && type !== 'swipe' && type !== 'quiet' && !isImpersonate && !dryRun && !depth) {
        is_send_press = true;
        textareaText = String($('#send_textarea').val());
        $('#send_textarea').val('')[0].dispatchEvent(new Event('input', { bubbles: true }));
        // Explicit, synchronous clear (not just relying on the debounced input-triggered save eventually
        // observing the now-empty box) - a message that was just sent must not be resurrectable as a "draft"
        // by a reload that happens to land in the gap before the debounce fires.
        const sentDraftContext = getCurrentDraftContext();
        if (sentDraftContext) {
            clearDraft(localStorage, sentDraftContext);
        }
    } else {
        textareaText = '';
        if (chat.length && lastMessage.is_user) {
            //do nothing? why does this check exist?
        } else if (type !== 'quiet' && type !== 'swipe' && !isImpersonate && !dryRun && !depth && chat.length) {
            deleteItemizedPromptForMessage(chat.length - 1);
            chat.length = chat.length - 1;
            await removeLastMessage();
            await eventSource.emit(event_types.MESSAGE_DELETED, chat.length);
        }
    }

    const isContinue = type == 'continue';

    // Rewrite the generation timer to account for the time passed for all the continuations.
    if (isContinue && chat.length) {
        const prevFinished = lastMessage.gen_finished;
        const prevStarted = lastMessage.gen_started;

        if (prevFinished && prevStarted) {
            const timePassed = Number(prevFinished) - Number(prevStarted);
            generation_started = new Date(Date.now() - timePassed);
            updateMessage(chat.length - 1, { gen_started: generation_started });
        }
    }

    if (!dryRun) {
        deactivateSendButtons();
    }

    let { messageBias, promptBias, isUserPromptBias } = getBiasStrings(textareaText, type);

    //*********************************
    //PRE FORMATING STRING
    //*********************************

    // These generation types should not attach pending files to the chat
    const noAttachTypes = [
        'regenerate',
        'swipe',
        'impersonate',
        'quiet',
        'continue',
    ];
    //for normal messages sent from user..
    if ((textareaText != '' || (hasPendingFileAttachment() && !noAttachTypes.includes(type))) && !automatic_trigger && type !== 'quiet' && !dryRun && !depth) {
        // If user message contains no text other than bias - send as a system message
        if (messageBias && !removeMacros(textareaText)) {
            sendSystemMessage(system_message_types.GENERIC, ' ', { bias: messageBias });
        } else {
            await sendMessageAsUser(textareaText, messageBias);
        }
    } else if (textareaText == '' && !automatic_trigger && !dryRun && [undefined, 'normal'].includes(type) && main_api == 'openai' && oai_settings.send_if_empty.trim().length > 0 && !depth) {
        // Use send_if_empty if set and the user message is empty. Only when sending messages normally
        await sendMessageAsUser(oai_settings.send_if_empty.trim(), messageBias);
    }

    let {
        description,
        personality,
        persona,
        scenario,
        mesExamples,
        system,
        jailbreak,
        charDepthPrompt,
        creatorNotes,
    } = getCharacterCardFields();

    // Depth prompt (character-specific A/N)
    removeDepthPrompts();
    const groupDepthPrompts = getGroupDepthPrompts(selected_group, getCurrentCharacter()?.avatar);

    if (selected_group && Array.isArray(groupDepthPrompts) && groupDepthPrompts.length > 0) {
        groupDepthPrompts.forEach((value, index) => {
            const role = getExtensionPromptRoleByName(value.role);
            setExtensionPrompt(inject_ids.DEPTH_PROMPT_INDEX(index), value.text, extension_prompt_types.IN_CHAT, value.depth, extension_settings.note.allowWIScan, role);
        });
    } else {
        const depthPromptText = charDepthPrompt || '';
        const depthPromptDepth = getCurrentCharacter()?.data?.extensions?.depth_prompt?.depth ?? depth_prompt_depth_default;
        const depthPromptRole = getExtensionPromptRoleByName(getCurrentCharacter()?.data?.extensions?.depth_prompt?.role ?? depth_prompt_role_default);
        setExtensionPrompt(inject_ids.DEPTH_PROMPT, depthPromptText, extension_prompt_types.IN_CHAT, depthPromptDepth, extension_settings.note.allowWIScan, depthPromptRole);
    }

    // First message in fresh 1-on-1 chat reacts to user/character settings changes
    if (chat.length) {
        updateMessage(0, { mes: substituteParams(chat[0].mes) });
    }

    // Collect messages with usable content
    const canUseTools = ToolManager.isToolCallingSupported();
    const canPerformToolCalls = !dryRun && ToolManager.canPerformToolCalls(type) && depth < ToolManager.RECURSE_LIMIT;
    let coreChat = chat.filter(x => !x.is_system || (canUseTools && Array.isArray(x.extra?.tool_invocations)));
    if (type === 'swipe') {
        coreChat.pop();
    }

    coreChat = await Promise.all(coreChat.map(async (/** @type {ChatMessage} */ chatItem, index) => {
        let message = chatItem.mes;
        let regexType = chatItem.is_user ? regex_placement.USER_INPUT : regex_placement.AI_OUTPUT;
        let options = { isPrompt: true, depth: (coreChat.length - index - (isContinue ? 2 : 1)) };

        let regexedMessage = getRegexedString(message, regexType, options);
        const residentId = chat.indexOf(chatItem);
        regexedMessage = await appendFileContent(chatItem, regexedMessage);
        if (residentId >= 0) {
            chatItem = chat[residentId];
        }

        const titles = [];
        if (chatItem?.extra?.append_title && chatItem?.extra?.title) {
            titles.push(chatItem.extra.title);
        }
        if (Array.isArray(chatItem?.extra?.media)) {
            for (const mediaItem of chatItem.extra.media) {
                if (mediaItem?.title && mediaItem?.append_title) {
                    titles.push(mediaItem.title);
                }
            }
        }
        if (titles.length > 0) {
            regexedMessage = `${regexedMessage}\n\n${titles.join('\n\n')}`;
        }

        return {
            ...chatItem,
            mes: regexedMessage,
            index,
        };
    }));

    const promptReasoning = new PromptReasoning();
    for (let i = coreChat.length - 1; i >= 0; i--) {
        const depth = coreChat.length - i - (isContinue ? 2 : 1);
        const isPrefix = isContinue && i === coreChat.length - 1;

        // In group chats, only include reasoning from the currently generating character
        const isOtherGroupMember = selected_group && coreChat[i].name !== name2;

        coreChat[i] = {
            ...coreChat[i],
            mes: isOtherGroupMember
                ? coreChat[i].mes
                : promptReasoning.addToMessage(
                    coreChat[i].mes,
                    getRegexedString(
                        String(coreChat[i].extra?.reasoning ?? ''),
                        regex_placement.REASONING,
                        { isPrompt: true, depth: depth },
                    ),
                    isPrefix,
                    coreChat[i].extra?.reasoning_duration,
                ),
        };
        if (promptReasoning.isLimitReached()) {
            break;
        }
    }

    // Determine token limit
    let this_max_context = getMaxPromptTokens();

    if (!dryRun) {
        console.debug('Running extension interceptors');
        const aborted = await runGenerationInterceptors(coreChat, this_max_context, type);

        if (aborted) {
            console.debug('Generation aborted by extension interceptors');
            unblockGeneration(type);
            return Promise.resolve();
        }
    } else {
        console.debug('Skipping extension interceptors for dry run');
    }

    // Adjust token limit for Horde
    let adjustedParams;
    if (main_api == 'koboldhorde' && (horde_settings.auto_adjust_context_length || horde_settings.auto_adjust_response_length)) {
        try {
            adjustedParams = await adjustHordeGenerationParams(max_context, amount_gen);
        } catch {
            unblockGeneration(type);
            return Promise.resolve();
        }
        if (horde_settings.auto_adjust_context_length) {
            this_max_context = (adjustedParams.maxContextLength - adjustedParams.maxLength);
        }
    }

    // Fetches the combined prompt for both negative and positive prompts
    const cfgGuidanceScale = getGuidanceScale();
    const useCfgPrompt = cfgGuidanceScale && cfgGuidanceScale.value !== 1;

    // Adjust max context based on CFG prompt to prevent overfitting
    if (useCfgPrompt) {
        const negativePrompt = getCfgPrompt(cfgGuidanceScale, true, true)?.value || '';
        const positivePrompt = getCfgPrompt(cfgGuidanceScale, false, true)?.value || '';
        if (negativePrompt || positivePrompt) {
            const previousMaxContext = this_max_context;
            const [negativePromptTokenCount, positivePromptTokenCount] = await Promise.all([getTokenCountAsync(negativePrompt), getTokenCountAsync(positivePrompt)]);
            const decrement = Math.max(negativePromptTokenCount, positivePromptTokenCount);
            this_max_context -= decrement;
            console.log(`Max context reduced by ${decrement} tokens of CFG prompt (${previousMaxContext} -> ${this_max_context})`);
        }
    }

    console.log(`Core/all messages: ${coreChat.length}/${chat.length}`);

    if ((promptBias && !isUserPromptBias) || power_user.always_force_name2 || main_api == 'novel') {
        force_name2 = true;
    }

    if (isImpersonate) {
        force_name2 = false;
    }

    let mesExamplesArray = parseMesExamples(mesExamples, isInstruct);

    // Set non-WI AN
    setFloatingPrompt();

    // Add WI to prompt (and also inject WI to AN value via hijack)
    // Make quiet prompt available for WIAN
    setExtensionPrompt(inject_ids.QUIET_PROMPT, quiet_prompt || '', extension_prompt_types.IN_PROMPT, 0, true);
    const chatForWI = coreChat.map(x => world_info_include_names ? `${x.name}: ${x.mes}` : x.mes).reverse();
    /** @type {import('./scripts/world-info.js').WIGlobalScanData} */
    const globalScanData = {
        personaDescription: persona,
        characterDescription: description,
        characterPersonality: personality,
        characterDepthPrompt: charDepthPrompt,
        scenario: scenario,
        creatorNotes: creatorNotes,
        trigger: GENERATION_TYPE_TRIGGERS.includes(type) ? type : 'normal',
    };
    const { worldInfoString, worldInfoBefore, worldInfoAfter, worldInfoExamples, worldInfoDepth, outletEntries } = await getWorldInfoPrompt(chatForWI, this_max_context, dryRun, globalScanData);
    setExtensionPrompt(inject_ids.QUIET_PROMPT, '', extension_prompt_types.IN_PROMPT, 0, true);

    // Add message example WI
    for (const example of worldInfoExamples) {
        const exampleMessage = example.content;

        if (exampleMessage.length === 0) {
            continue;
        }

        const formattedExample = baseChatReplace(exampleMessage);
        const cleanedExample = parseMesExamples(formattedExample, isInstruct);

        // Insert depending on before or after position
        if (example.position === wi_anchor_position.before) {
            mesExamplesArray.unshift(...cleanedExample);
        } else {
            mesExamplesArray.push(...cleanedExample);
        }
    }

    // At this point, the raw message examples can be created
    const mesExamplesRawArray = [...mesExamplesArray];

    if (mesExamplesArray && isInstruct) {
        mesExamplesArray = formatInstructModeExamples(mesExamplesArray, name1, name2);
    }

    if (skipWIAN !== true) {
        console.log('skipWIAN not active, adding WIAN');
        // Add all depth WI entries to prompt
        flushWIInjections();
        if (Array.isArray(worldInfoDepth)) {
            worldInfoDepth.forEach((e) => {
                const joinedEntries = e.entries.join('\n');
                setExtensionPrompt(inject_ids.CUSTOM_WI_DEPTH_ROLE(e.depth, e.role), joinedEntries, extension_prompt_types.IN_CHAT, e.depth, false, e.role);
            });
        }
        if (outletEntries && typeof outletEntries === 'object' && Object.keys(outletEntries).length > 0) {
            Object.entries(outletEntries).forEach(([key, value]) => {
                setExtensionPrompt(inject_ids.CUSTOM_WI_OUTLET(key), value.join('\n'), extension_prompt_types.NONE, 0);
            });
        }
    } else {
        console.log('skipping WIAN');
    }

    // Add persona description to prompt
    addPersonaDescriptionExtensionPrompt();

    // Prepare the system prompt for Text Completion APIs
    if (main_api !== 'openai') {
        if (power_user.sysprompt.enabled) {
            system = power_user.prefer_character_prompt && system
                ? substituteParams(system, { original: power_user.sysprompt.content ?? '' })
                : baseChatReplace(power_user.sysprompt.content);
            system = isInstruct ? substituteParams(system, { original: power_user.sysprompt.content ?? '' }) : system;
        } else {
            // Nullify if it's not enabled
            system = '';
        }
    }

    // Collect before / after story string injections
    const beforeScenarioAnchor = await getExtensionPrompt(extension_prompt_types.BEFORE_PROMPT);
    const afterScenarioAnchor = await getExtensionPrompt(extension_prompt_types.IN_PROMPT);

    const storyStringParams = {
        description: description,
        personality: personality,
        persona: power_user.persona_description_position == persona_description_positions.IN_PROMPT ? persona : '',
        scenario: scenario,
        system: system,
        char: name2,
        user: name1,
        wiBefore: worldInfoBefore,
        wiAfter: worldInfoAfter,
        loreBefore: worldInfoBefore,
        loreAfter: worldInfoAfter,
        anchorBefore: beforeScenarioAnchor.trim(),
        anchorAfter: afterScenarioAnchor.trim(),
        mesExamples: mesExamplesArray.join(''),
        mesExamplesRaw: mesExamplesRawArray.join(''),
    };

    // Render the story string and combine with injections
    const storyString = renderStoryString(storyStringParams);
    let combinedStoryString = isInstruct ? formatInstructModeStoryString(storyString) : storyString;

    // Inject the story string as in-chat prompt (if needed)
    const applyStoryStringInject = main_api !== 'openai' && power_user.context.story_string_position === extension_prompt_types.IN_CHAT;
    if (applyStoryStringInject) {
        const depth = power_user.context.story_string_depth ?? 1;
        const role = power_user.context.story_string_role ?? extension_prompt_roles.SYSTEM;
        setExtensionPrompt(inject_ids.STORY_STRING, combinedStoryString, extension_prompt_types.IN_CHAT, depth, false, role);
        // Remove to prevent duplication
        combinedStoryString = '';
    } else {
        setExtensionPrompt(inject_ids.STORY_STRING, '', extension_prompt_types.IN_CHAT, 0);
    }

    // Story string rendered, safe to remove
    if (power_user.strip_examples) {
        mesExamplesArray = [];
    }

    // Inject all Depth prompts. Chat Completion does it separately
    let injectedIndices = [];
    if (main_api !== 'openai') {
        injectedIndices = await doChatInject(coreChat, isContinue);
    }

    if (main_api !== 'openai' && power_user.sysprompt.enabled) {
        jailbreak = power_user.prefer_character_jailbreak && jailbreak
            ? substituteParams(jailbreak, { original: power_user.sysprompt.post_history ?? '' })
            : baseChatReplace(power_user.sysprompt.post_history);

        // Only inject the jb if there is one
        if (jailbreak) {
            // When continuing generation of previous output, last user message precedes the message to continue
            if (isContinue) {
                coreChat.splice(coreChat.length - 1, 0, { mes: jailbreak, is_user: true });
            } else {
                // This operation will result in the injectedIndices indexes being off by one
                coreChat.push({ mes: jailbreak, is_user: true });
                // Add +1 to the elements to correct for the new PHI/Jailbreak message.
                injectedIndices.forEach(shiftUpByOne);
            }
        }
    }

    let chat2 = [];
    let continue_mag = '';
    let userMessageIndices = [];
    const lastUserMessageIndex = coreChat.findLastIndex(x => x.is_user);

    for (let i = coreChat.length - 1, j = 0; i >= 0; i--, j++) {
        if (main_api == 'openai') {
            chat2[i] = coreChat[j].mes;
            if (i === 0 && isContinue) {
                chat2[i] = chat2[i].slice(0, chat2[i].lastIndexOf(coreChat[j].mes) + coreChat[j].mes.length);
                continue_mag = coreChat[j].mes;
            }
            continue;
        }

        chat2[i] = formatMessageHistoryItem(coreChat[j], isInstruct, false);

        if (j === 0 && isInstruct) {
            // Reformat with the first output sequence (if any)
            chat2[i] = formatMessageHistoryItem(coreChat[j], isInstruct, force_output_sequence.FIRST);
        }

        if (lastUserMessageIndex >= 0 && j === lastUserMessageIndex && isInstruct && !isImpersonate) {
            // Reformat with the last input sequence (if any)
            chat2[i] = formatMessageHistoryItem(coreChat[j], isInstruct, force_output_sequence.LAST);
        }

        // Do not suffix the message for continuation
        if (i === 0 && isContinue) {
            // Pick something that's very unlikely to be in a message
            const FORMAT_TOKEN = '\u0000\ufffc\u0000\ufffd';

            if (isInstruct) {
                const originalMessage = String(coreChat[j].mes ?? '');
                // Work on a temporary shallow copy so we don't mutate the (possibly frozen) original
                const tempMsg = { ...coreChat[j], mes: originalMessage.replaceAll(FORMAT_TOKEN, '') + FORMAT_TOKEN };
                // Reformat with the last output sequence (if any)
                chat2[i] = formatMessageHistoryItem(tempMsg, isInstruct, force_output_sequence.LAST);
            }

            chat2[i] = chat2[i].includes(FORMAT_TOKEN)
                ? chat2[i].slice(0, chat2[i].lastIndexOf(FORMAT_TOKEN))
                : chat2[i].slice(0, chat2[i].lastIndexOf(coreChat[j].mes) + coreChat[j].mes.length);
            continue_mag = coreChat[j].mes;
        }

        if (coreChat[j].is_user) {
            userMessageIndices.push(i);
        }
    }

    let addUserAlignment = isInstruct && power_user.instruct.user_alignment_message;
    let userAlignmentMessage = '';

    if (addUserAlignment) {
        const alignmentMessage = {
            name: name1,
            mes: substituteParams(power_user.instruct.user_alignment_message),
            is_user: true,
        };
        userAlignmentMessage = formatMessageHistoryItem(alignmentMessage, isInstruct, force_output_sequence.FIRST);
    }

    let oaiMessages = [];
    let oaiMessageExamples = [];

    if (main_api === 'openai') {
        oaiMessages = setOpenAIMessages(coreChat);
        oaiMessageExamples = setOpenAIMessageExamples(mesExamplesArray);
    }

    // hack for regeneration of the first message
    if (chat2.length == 0) {
        chat2.push('');
    }

    let examplesString = '';
    let chatString = addChatsPreamble(addChatsSeparator(''));
    let cyclePrompt = '';

    async function getMessagesTokenCount() {
        const encodeString = [
            combinedStoryString,
            examplesString,
            userAlignmentMessage,
            chatString,
            modifyLastPromptLine(''),
            cyclePrompt,
        ].join('').replace(/\r/gm, '');
        return getTokenCountAsync(encodeString, power_user.token_padding);
    }

    // Force pinned examples into the context
    let pinExmString;
    if (power_user.pin_examples) {
        pinExmString = examplesString = mesExamplesArray.join('');
    }

    // Only add the chat in context if past the greeting message
    if (isContinue && (chat2.length > 1 || main_api === 'openai')) {
        cyclePrompt = chat2.shift();
        // Adjust indices to account for the shift
        injectedIndices = injectedIndices.map(shiftDownByOne).filter(x => x >= 0);
        userMessageIndices = userMessageIndices.map(shiftDownByOne).filter(x => x >= 0);
    }

    // Collect enough messages to fill the context
    let arrMes = new Array(chat2.length);
    let tokenCount = await getMessagesTokenCount();
    let lastAddedIndex = 0;

    // Pre-allocate all injections first.
    // If it doesn't fit - user shot himself in the foot
    for (const index of injectedIndices) {
        // not needed for OAI prompting
        if (main_api == 'openai') {
            break;
        }

        const item = chat2[index];

        if (typeof item !== 'string') {
            continue;
        }

        tokenCount += await getTokenCountAsync(item.replace(/\r/gm, ''));
        if (tokenCount < this_max_context) {
            chatString = chatString + item;
            arrMes[index] = item;
            lastAddedIndex = Math.max(lastAddedIndex, index);
        } else {
            break;
        }
    }

    for (let i = 0; i < chat2.length; i++) {
        // not needed for OAI prompting
        if (main_api == 'openai') {
            break;
        }

        // Skip already injected messages
        if (arrMes[i] !== undefined) {
            continue;
        }

        const item = chat2[i];

        if (typeof item !== 'string') {
            continue;
        }

        tokenCount += await getTokenCountAsync(item.replace(/\r/gm, ''));
        if (tokenCount < this_max_context) {
            chatString = chatString + item;
            arrMes[i] = item;
            lastAddedIndex = Math.max(lastAddedIndex, i);
        } else {
            break;
        }
    }

    // Add user alignment message if last message is not a user message
    const stoppedAtUser = userMessageIndices.includes(lastAddedIndex);
    if (addUserAlignment && !stoppedAtUser) {
        tokenCount += await getTokenCountAsync(userAlignmentMessage.replace(/\r/gm, ''));
        chatString = userAlignmentMessage + chatString;
        arrMes.push(userAlignmentMessage);
        injectedIndices.push(arrMes.length - 1);
    }

    // Unsparse the array. Adjust injected indices
    const newArrMes = [];
    const newInjectedIndices = [];
    for (let i = 0; i < arrMes.length; i++) {
        if (arrMes[i] !== undefined) {
            newArrMes.push(arrMes[i]);
            if (injectedIndices.includes(i)) {
                newInjectedIndices.push(newArrMes.length - 1);
            }
        }
    }

    arrMes = newArrMes;
    injectedIndices = newInjectedIndices;

    if (main_api !== 'openai') {
        setInContextMessages(arrMes.length - injectedIndices.length, type);
    }

    // Estimate how many unpinned example messages fit in the context
    tokenCount = await getMessagesTokenCount();
    let count_exm_add = 0;
    if (!power_user.pin_examples) {
        for (let example of mesExamplesArray) {
            tokenCount += await getTokenCountAsync(example.replace(/\r/gm, ''));
            examplesString += example;
            if (tokenCount < this_max_context) {
                count_exm_add++;
            } else {
                break;
            }
        }
    }

    let mesSend = [];
    console.debug('calling runGenerate');

    if (isContinue) {
        // Coping mechanism for OAI spacing
        if (main_api === 'openai' && !cyclePrompt.endsWith(' ')) {
            cyclePrompt += oai_settings.continue_postfix;
            continue_mag += oai_settings.continue_postfix;
        }
    }

    const originalType = type;

    if (!dryRun) {
        is_send_press = true;
    }

    let generatedPromptCache = cyclePrompt || '';
    if (generatedPromptCache.length == 0 || type === 'continue') {
        console.debug('generating prompt');
        chatString = '';
        arrMes = arrMes.reverse();
        arrMes.forEach(function (item, i, arr) {
            // OAI doesn't need all of this
            if (main_api === 'openai') {
                return;
            }

            // Cohee: This removes a newline from the end of the last message in the context
            // Last prompt line will add a newline if it's not a continuation
            // In instruct mode it only removes it if wrap is enabled and it's not a quiet generation
            if (i === arrMes.length - 1 && type !== 'continue') {
                if (!isInstruct || (power_user.instruct.wrap && type !== 'quiet')) {
                    item = item.replace(/\n?$/, '');
                }
            }

            mesSend[mesSend.length] = { message: item, extensionPrompts: [] };
        });
    }

    let mesExmString = '';

    function setPromptString() {
        if (main_api == 'openai') {
            return;
        }

        console.debug('--setting Prompt string');
        mesExmString = pinExmString ?? mesExamplesArray.slice(0, count_exm_add).join('');

        if (mesSend.length) {
            mesSend[mesSend.length - 1].message = modifyLastPromptLine(mesSend[mesSend.length - 1].message);
        }
    }

    function modifyLastPromptLine(lastMesString) {
        //#########QUIET PROMPT STUFF PT2##############

        // Add quiet generation prompt at depth 0
        if (quiet_prompt && quiet_prompt.length) {
            // here name1 is forced for all quiet prompts..why?
            const name = name1;
            //checks if we are in instruct, if so, formats the chat as such, otherwise just adds the quiet prompt
            const quietAppend = isInstruct ? formatInstructModeChat(name, quiet_prompt, false, true, '', name1, name2, false) : `\n${quiet_prompt}`;

            //This begins to fix quietPrompts (particularly /sysgen) for instruct
            //previously instruct input sequence was being appended to the last chat message w/o '\n'
            //and no output sequence was added after the input's content.
            //TODO: respect output_sequence vs last_output_sequence settings
            //TODO: decide how to prompt this to clarify who is talking 'Narrator', 'System', etc.
            if (isInstruct) {
                lastMesString += quietAppend; // + power_user.instruct.output_sequence + '\n';
            } else {
                lastMesString += quietAppend;
            }


            // Ross: bailing out early prevents quiet prompts from respecting other instruct prompt toggles
            // for sysgen, SD, and summary this is desireable as it prevents the AI from responding as char..
            // but for idle prompting, we want the flexibility of the other prompt toggles, and to respect them as per settings in the extension
            // need a detection for what the quiet prompt is being asked for...

            // Bail out early?
            if (!isInstruct && !quietToLoud) {
                return lastMesString;
            }
        }


        // Get instruct mode line
        if (isInstruct && !isContinue) {
            const name = (quiet_prompt && !quietToLoud && !isImpersonate) ? (quietName ?? 'System') : (isImpersonate ? name1 : name2);
            const isQuiet = quiet_prompt && type == 'quiet';
            lastMesString += formatInstructModePrompt(name, isImpersonate, promptBias, name1, name2, isQuiet, quietToLoud);
        }

        // Get non-instruct impersonation line
        if (!isInstruct && isImpersonate && !isContinue) {
            const name = name1;
            if (!lastMesString.endsWith('\n')) {
                lastMesString += '\n';
            }
            lastMesString += name + ':';
        }

        // Add character's name
        // Force name append on continue (if not continuing on user message or first message)
        const isContinuingOnFirstMessage = chat.length === 1 && isContinue;
        if (!isInstruct && force_name2 && !isContinuingOnFirstMessage) {
            if (!lastMesString.endsWith('\n')) {
                lastMesString += '\n';
            }
            if (!isContinue || !(chat[chat.length - 1]?.is_user)) {
                lastMesString += `${name2}:`;
            }
        }

        return lastMesString;
    }

    async function checkPromptSize() {
        console.debug('---checking Prompt size');
        setPromptString();
        const jointMessages = mesSend.map((e) => `${e.extensionPrompts.join('')}${e.message}`).join('');
        const prompt = [
            combinedStoryString,
            mesExmString,
            addChatsPreamble(addChatsSeparator(jointMessages)),
            '\n',
            modifyLastPromptLine(''),
            generatedPromptCache,
        ].join('').replace(/\r/gm, '');
        let thisPromptContextSize = await getTokenCountAsync(prompt, power_user.token_padding);

        if (thisPromptContextSize > this_max_context) {        //if the prepared prompt is larger than the max context size...
            if (count_exm_add > 0) {                            // ..and we have example messages..
                count_exm_add--;                            // remove the example messages...
                await checkPromptSize();                            // and try agin...
            } else if (mesSend.length > 0) {                    // if the chat history is longer than 0
                mesSend.shift();                            // remove the first (oldest) chat entry..
                await checkPromptSize();                            // and check size again..
            } else {
                //end
                console.debug(`---mesSend.length = ${mesSend.length}`);
            }
        }
    }

    if (generatedPromptCache.length > 0 && main_api !== 'openai') {
        console.debug('---Generated Prompt Cache length: ' + generatedPromptCache.length);
        await checkPromptSize();
    } else {
        console.debug('---calling setPromptString ' + generatedPromptCache.length);
        setPromptString();
    }

    // For prompt bit itemization
    let mesSendString = '';

    async function getCombinedPrompt(isNegative) {
        // Only return if the guidance scale doesn't exist or the value is 1
        // Also don't return if constructing the neutral prompt
        if (isNegative && !useCfgPrompt) {
            return;
        }

        // OAI has its own prompt manager. No need to do anything here
        if (main_api === 'openai') {
            return '';
        }

        // Deep clone
        let finalMesSend = structuredClone(mesSend);

        if (useCfgPrompt) {
            const cfgPrompt = getCfgPrompt(cfgGuidanceScale, isNegative);
            if (cfgPrompt.value) {
                if (cfgPrompt.depth === 0) {
                    finalMesSend[finalMesSend.length - 1].message +=
                        /\s/.test(finalMesSend[finalMesSend.length - 1].message.slice(-1))
                            ? cfgPrompt.value
                            : ` ${cfgPrompt.value}`;
                } else {
                    // TODO: Make all extension prompts use an array/splice method
                    const lengthDiff = mesSend.length - cfgPrompt.depth;
                    const cfgDepth = lengthDiff >= 0 ? lengthDiff : 0;
                    const cfgMessage = finalMesSend[cfgDepth];
                    if (cfgMessage) {
                        if (!Array.isArray(finalMesSend[cfgDepth].extensionPrompts)) {
                            finalMesSend[cfgDepth].extensionPrompts = [];
                        }
                        finalMesSend[cfgDepth].extensionPrompts.push(`${cfgPrompt.value}\n`);
                    }
                }
            }
        }

        // Add prompt bias after everything else
        // Always run with continue
        if (!isInstruct && !isImpersonate) {
            if (promptBias.trim().length !== 0) {
                finalMesSend[finalMesSend.length - 1].message +=
                    /\s/.test(finalMesSend[finalMesSend.length - 1].message.slice(-1))
                        ? promptBias.trimStart()
                        : ` ${promptBias.trimStart()}`;
            }
        }

        // Flattens the multiple prompt objects to a string.
        const combine = () => {
            // Right now, everything is suffixed with a newline
            mesSendString = finalMesSend.map((e) => `${e.extensionPrompts.join('')}${e.message}`).join('');

            // add a custom dingus (if defined)
            mesSendString = addChatsSeparator(mesSendString);

            // add chat preamble
            mesSendString = addChatsPreamble(mesSendString);

            let combinedPrompt = [
                combinedStoryString,
                mesExmString,
                mesSendString,
                generatedPromptCache,
            ].join('').replace(/\r/gm, '');

            if (power_user.collapse_newlines) {
                combinedPrompt = collapseNewlines(combinedPrompt);
            }

            return combinedPrompt;
        };

        finalMesSend.forEach((item, i) => {
            item.injected = injectedIndices.includes(finalMesSend.length - i - 1);
        });

        let data = {
            api: main_api,
            combinedPrompt: null,
            description,
            personality,
            persona,
            scenario,
            char: name2,
            user: name1,
            worldInfoBefore,
            worldInfoAfter,
            beforeScenarioAnchor,
            afterScenarioAnchor,
            storyString,
            mesExmString,
            mesSendString,
            finalMesSend,
            generatedPromptCache,
            main: system,
            jailbreak,
            naiPreamble: nai_settings.preamble,
        };

        // Before returning the combined prompt, give available context related information to all subscribers.
        await eventSource.emit(event_types.GENERATE_BEFORE_COMBINE_PROMPTS, data);

        // If one or multiple subscribers return a value, forfeit the responsibillity of flattening the context.
        return !data.combinedPrompt ? combine() : data.combinedPrompt;
    }

    let finalPrompt = await getCombinedPrompt(false);

    const eventData = { prompt: finalPrompt, dryRun: dryRun };
    await eventSource.emit(event_types.GENERATE_AFTER_COMBINE_PROMPTS, eventData);
    finalPrompt = eventData.prompt;

    let maxLength = Number(amount_gen); // how many tokens the AI will be requested to generate
    let thisPromptBits = [];

    let generate_data;
    switch (main_api) {
        case 'koboldhorde':
        case 'kobold':
            if (main_api == 'koboldhorde' && horde_settings.auto_adjust_response_length) {
                maxLength = Math.min(maxLength, adjustedParams.maxLength);
                maxLength = Math.max(maxLength, MIN_LENGTH); // prevent validation errors
            }

            generate_data = {
                prompt: finalPrompt,
                gui_settings: true,
                max_length: maxLength,
                max_context_length: max_context,
                api_server: kai_settings.api_server,
            };

            if (kai_settings.preset_settings != 'gui') {
                const isHorde = main_api == 'koboldhorde';
                const presetSettings = koboldai_settings[koboldai_setting_names[kai_settings.preset_settings]];
                const maxContext = (adjustedParams && horde_settings.auto_adjust_context_length) ? adjustedParams.maxContextLength : max_context;
                generate_data = getKoboldGenerationData(finalPrompt, presetSettings, maxLength, maxContext, isHorde, type);
            }
            break;
        case 'textgenerationwebui': {
            const cfgValues = useCfgPrompt ? { guidanceScale: cfgGuidanceScale, negativePrompt: await getCombinedPrompt(true) } : null;
            generate_data = await getTextGenGenerationData(finalPrompt, maxLength, isImpersonate, isContinue, cfgValues, type);
            break;
        }
        case 'novel': {
            const cfgValues = useCfgPrompt ? { guidanceScale: cfgGuidanceScale } : null;
            const presetSettings = novelai_settings[novelai_setting_names[nai_settings.preset_settings_novel]];
            generate_data = getNovelGenerationData(finalPrompt, presetSettings, maxLength, isImpersonate, isContinue, cfgValues, type);
            break;
        }
        case 'openai': {
            let [prompt, counts] = await prepareOpenAIMessages({
                name2: name2,
                charDescription: description,
                charPersonality: personality,
                scenario: scenario,
                worldInfoBefore: worldInfoBefore,
                worldInfoAfter: worldInfoAfter,
                extensionPrompts: extension_prompts,
                bias: promptBias,
                type: type,
                quietPrompt: quiet_prompt,
                quietImage: quietImage,
                cyclePrompt: cyclePrompt,
                systemPromptOverride: system,
                jailbreakPromptOverride: jailbreak,
                messages: oaiMessages,
                messageExamples: oaiMessageExamples,
            }, dryRun);
            generate_data = { prompt: prompt };

            // TODO: move these side-effects somewhere else, so this switch-case solely sets generate_data
            // counts will return false if the user has not enabled the token breakdown feature
            if (counts) {
                parseTokenCounts(counts, thisPromptBits);
            }

            if (!dryRun) {
                setInContextMessages(openai_messages_count, type);
            }
            break;
        }
    }

    await eventSource.emit(event_types.GENERATE_AFTER_DATA, generate_data, dryRun);

    if (dryRun) {
        return Promise.resolve();
    }

    /**
     * Saves itemized prompt bits and calls streaming or non-streaming generation API.
     * @returns {Promise<void|*|Awaited<*>|String|{fromStream}|string|undefined|Object>}
     * @throws {Error|object} Error with message text, or Error with response JSON (OAI/Horde), or the actual response JSON (novel|textgenerationwebui|kobold)
     */
    async function finishGenerating() {
        if (power_user.console_log_prompts) {
            console.log(generate_data.prompt);
        }

        console.debug('rungenerate calling API');

        showStopButton();

        //set array object for prompt token itemization of this message
        let currentArrayEntry = Number(thisPromptBits.length - 1);
        let additionalPromptStuff = {
            ...thisPromptBits[currentArrayEntry],
            rawPrompt: generate_data.prompt || generate_data.input,
            mesId: getNextMessageId(type),
            allAnchors: await getAllExtensionPrompts(),
            chatInjects: injectedIndices?.map(index => arrMes[arrMes.length - index - 1])?.join('') || '',
            summarizeString: (extension_prompts['1_memory']?.value || ''),
            authorsNoteString: (extension_prompts['2_floating_prompt']?.value || ''),
            smartContextString: (extension_prompts.chromadb?.value || ''),
            chatVectorsString: (extension_prompts['3_vectors']?.value || ''),
            dataBankVectorsString: (extension_prompts['4_vectors_data_bank']?.value || ''),
            worldInfoString: worldInfoString,
            storyString: storyString,
            beforeScenarioAnchor: beforeScenarioAnchor,
            afterScenarioAnchor: afterScenarioAnchor,
            examplesString: examplesString,
            mesSendString: mesSendString,
            generatedPromptCache: generatedPromptCache,
            promptBias: promptBias,
            finalPrompt: finalPrompt,
            charDescription: description,
            charPersonality: personality,
            scenarioText: scenario,
            this_max_context: this_max_context,
            padding: power_user.token_padding,
            main_api: main_api,
            instruction: main_api !== 'openai' && power_user.sysprompt.enabled ? substituteParams(power_user.prefer_character_prompt && system ? system : power_user.sysprompt.content) : '',
            userPersona: (power_user.persona_description_position == persona_description_positions.IN_PROMPT ? (persona || '') : ''),
            tokenizer: getFriendlyTokenizerName(main_api).tokenizerName || '',
            presetName: getPresetManager()?.getSelectedPresetName() || '',
            messagesCount: main_api !== 'openai' ? mesSend.length : oaiMessages.length,
            examplesCount: main_api !== 'openai' ? (pinExmString ? mesExamplesArray.length : count_exm_add) : oaiMessageExamples.length,
        };

        //console.log(additionalPromptStuff);
        const itemizedIndex = itemizedPrompts.findIndex((item) => item.mesId === additionalPromptStuff.mesId);

        if (itemizedIndex !== -1) {
            itemizedPrompts[itemizedIndex] = additionalPromptStuff;
        } else {
            itemizedPrompts.push(additionalPromptStuff);
        }

        console.debug(`pushed prompt bits to itemizedPrompts array. Length is now: ${itemizedPrompts.length}`);

        if (isStreamingEnabled() && type !== 'quiet') {
            continue_mag = promptReasoning.removePrefix(continue_mag);
            streamingProcessor = new StreamingProcessor(type, force_name2, generation_started, continue_mag, promptReasoning);
            if (isContinue) {
                // Save reply does add cycle text to the prompt, so it's not needed here
                streamingProcessor.firstMessageText = '';
            }

            streamingProcessor.generator = await sendStreamingRequest(type, generate_data, { jsonSchema });

            hideSwipeButtons();
            let getMessage = await streamingProcessor.generate();
            let messageChunk = cleanUpMessage({
                getMessage: getMessage,
                isImpersonate: isImpersonate,
                isContinue: isContinue,
                displayIncompleteSentences: false,
            });

            if (isContinue) {
                getMessage = continue_mag + getMessage;
            }

            const isStreamFinished = streamingProcessor && !streamingProcessor.isStopped && streamingProcessor.isFinished;
            const isStreamWithToolCalls = streamingProcessor && Array.isArray(streamingProcessor.toolCalls) && streamingProcessor.toolCalls.length;
            if (canPerformToolCalls && isStreamFinished && isStreamWithToolCalls) {
                const lastMessage = chat[chat.length - 1];
                const hasToolCalls = ToolManager.hasToolCalls(streamingProcessor.toolCalls);
                const shouldDeleteMessage = type !== 'swipe' && ['', '...'].includes(lastMessage?.mes) && !lastMessage?.extra?.reasoning && ['', '...'].includes(streamingProcessor?.result);
                hasToolCalls && shouldDeleteMessage && await deleteLastMessage();
                if (hasToolCalls && !shouldDeleteMessage) {
                    await streamingProcessor.finalizeIntermediaryMessage(streamingProcessor.messageId, getMessage, { unlockUI: false });
                }
                const invocationResult = await ToolManager.invokeFunctionTools(streamingProcessor.toolCalls, {
                    reasoningText: streamingProcessor.reasoningHandler.reasoning,
                });
                const shouldStopGeneration = (!invocationResult.invocations.length && shouldDeleteMessage) || invocationResult.stealthCalls.length;
                if (hasToolCalls) {
                    if (shouldStopGeneration) {
                        if (Array.isArray(invocationResult.errors) && invocationResult.errors.length) {
                            ToolManager.showToolCallError(invocationResult.errors);
                        }
                        unblockGeneration(type);
                        streamingProcessor = null;
                        return;
                    }

                    streamingProcessor = null;
                    depth = depth + 1;
                    await ToolManager.saveFunctionToolInvocations(invocationResult.invocations);
                    return Generate('normal', { automatic_trigger, force_name2, quiet_prompt, quietToLoud, skipWIAN, force_avatar, signal, quietImage, quietName, depth }, dryRun);
                }
            }

            if (isStreamFinished) {
                await streamingProcessor.onFinishStreaming(streamingProcessor.messageId, getMessage);
                streamingProcessor = null;
                triggerAutoContinue(messageChunk, isImpersonate);
                return Object.defineProperties(new String(getMessage), {
                    'messageChunk': { value: messageChunk },
                    'fromStream': { value: true },
                });
            }
        } else {
            return await sendGenerationRequest(type, generate_data, { jsonSchema });
        }
    }

    return finishGenerating().then(onSuccess, onError);

    /**
     * Handles the successful response from the generation API.
     * @param data
     * @returns {Promise<String|{fromStream}|*|string|string|void|Awaited<*>|undefined>}
     * @throws {Error} Throws an error if the response data contains an error message
     */
    async function onSuccess(data) {
        if (!data) return;

        if (data?.fromStream) {
            return data;
        }

        let messageChunk = '';

        // if an error was returned in data (textgenwebui), show it and throw it
        if (data.error) {
            unblockGeneration(type);

            if (data?.response) {
                toastr.error(data.response, t`API Error`, { preventDuplicates: true });
            }
            throw new Error(data?.response);
        }

        if (jsonSchema) {
            unblockGeneration(type);
            return extractJsonFromData(data, { returnInvalidJson: jsonSchema.returnInvalid ?? false });
        }

        //const getData = await response.json();
        let getMessage = extractMessageFromData(data);
        let title = extractTitleFromData(data);
        let reasoning = extractReasoningFromData(data);
        let imageUrls = extractImagesFromData(data);
        const reasoningSignature = extractReasoningSignatureFromData(data);
        kobold_horde_model = title;

        const swipes = extractMultiSwipes(data, type);

        messageChunk = cleanUpMessage({
            getMessage: getMessage,
            isImpersonate: isImpersonate,
            isContinue: isContinue,
            displayIncompleteSentences: false,
        });


        reasoning = getRegexedString(reasoning, regex_placement.REASONING);

        if (power_user.trim_spaces) {
            reasoning = reasoning.trim();
        }

        if (isContinue) {
            continue_mag = promptReasoning.removePrefix(continue_mag);
            getMessage = continue_mag + getMessage;
        }

        //Formating
        const displayIncomplete = type === 'quiet' && !quietToLoud;
        getMessage = cleanUpMessage({
            getMessage: getMessage,
            isImpersonate: isImpersonate,
            isContinue: isContinue,
            displayIncompleteSentences: displayIncomplete,
        });

        if (isImpersonate) {
            $('#send_textarea').val(getMessage)[0].dispatchEvent(new Event('input', { bubbles: true }));
            await eventSource.emit(event_types.IMPERSONATE_READY, getMessage);
        } else if (type == 'quiet') {
            unblockGeneration(type);
            return getMessage;
        } else {
            // Without streaming we'll be having a full message on continuation. Treat it as a last chunk.
            if (originalType !== 'continue') {
                ({ type, getMessage } = await saveReply({ type, getMessage, title, swipes, reasoning, imageUrls, reasoningSignature }));
            } else {
                ({ type, getMessage } = await saveReply({ type: 'appendFinal', getMessage, title, swipes, reasoning, imageUrls, reasoningSignature }));
            }

            // This relies on `saveReply` having been called to add the message to the chat, so it must be last.
            parseAndSaveLogprobs(data, continue_mag);
        }

        if (canPerformToolCalls) {
            const hasToolCalls = ToolManager.hasToolCalls(data);
            const shouldDeleteMessage = type !== 'swipe' && ['', '...'].includes(getMessage) && !reasoning;
            hasToolCalls && shouldDeleteMessage && await deleteLastMessage();
            const invocationResult = await ToolManager.invokeFunctionTools(data, { reasoningText: reasoning });
            const shouldStopGeneration = (!invocationResult.invocations.length && shouldDeleteMessage) || invocationResult.stealthCalls.length;
            if (hasToolCalls) {
                if (shouldStopGeneration) {
                    if (Array.isArray(invocationResult.errors) && invocationResult.errors.length) {
                        ToolManager.showToolCallError(invocationResult.errors);
                    }
                    unblockGeneration(type);
                    return;
                }

                depth = depth + 1;
                await ToolManager.saveFunctionToolInvocations(invocationResult.invocations);
                return Generate('normal', { automatic_trigger, force_name2, quiet_prompt, quietToLoud, skipWIAN, force_avatar, signal, quietImage, quietName, depth }, dryRun);
            }
        }

        if (type !== 'quiet') {
            playMessageSound();
        }

        const isAborted = abortController && abortController.signal.aborted;
        if (!isAborted && power_user.auto_swipe && generatedTextFiltered(getMessage)) {
            is_send_press = false;
            return await swipe(null, SWIPE_DIRECTION.RIGHT, { source: SWIPE_SOURCE.AUTO_SWIPE, repeated: true, forceMesId: chat.length - 1 });
        }

        console.debug('/api/chats/save called by /Generate');
        await saveChatConditional();
        unblockGeneration(type);
        streamingProcessor = null;

        if (type !== 'quiet') {
            triggerAutoContinue(messageChunk, isImpersonate);
        }

        // Don't break the API chain that expects a single string in return
        return Object.defineProperty(new String(getMessage), 'messageChunk', { value: messageChunk });
    }

    /**
     * Exception handler for finishGenerating
     * @param {Error|object} exception Error or response JSON
     * @throws {Error|object} Re-throws the exception
     */
    function onError(exception) {
        // if the response JSON was thrown (novel|textgenerationwebui|kobold), show the error message
        if (typeof exception?.error?.message === 'string') {
            toastr.error(exception.error.message, t`Text generation error`, { timeOut: 10000, extendedTimeOut: 20000 });
        }

        unblockGeneration(type);
        console.log(exception);
        streamingProcessor = null;
        throw exception;
    }
}
//MARK: Generate() ends

/**
 * Stops the generation and any streaming if it is currently running.
 */
export function stopGeneration() {
    let stopped = false;
    if (streamingProcessor) {
        streamingProcessor.onStopStreaming();
        stopped = true;
    }
    if (abortController) {
        abortController.abort('Clicked stop button');
        hideStopButton();
        stopped = true;
    }
    eventSource.emit(event_types.GENERATION_STOPPED);
    return stopped;
}

/**
 * Injects extension prompts into chat messages.
 * @param {object[]} messages Array of chat messages
 * @param {boolean} isContinue Whether the generation is a continuation. If true, the extension prompts of depth 0 are injected at position 1.
 * @returns {Promise<number[]>} Array of indices where the extension prompts were injected
 */
async function doChatInject(messages, isContinue) {
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

function flushWIInjections() {
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
function unblockGeneration(type) {
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
function formatMessageHistoryItem(chatItem, isInstruct, forceOutputSequence) {
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
 * @returns {Promise<any>} A promise that resolves to the message when it is inserted.
 */
export async function sendMessageAsUser(messageText, messageBias, insertAt = null, compact = false, name = name1, avatar = user_avatar) {
    messageText = getRegexedString(messageText, regex_placement.USER_INPUT);

    const message = {
        name: name,
        is_user: true,
        is_system: false,
        send_date: getMessageTimeStamp(),
        mes: substituteParams(messageText),
        // Who this was said as. This is the speaker for identity purposes: the same words under the
        // same parent said as two different personas are two different messages. The avatar id rather
        // than the display name, because the name drifts on rename and the id doesn't.
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

    chat_metadata.tainted = true;

    if (typeof insertAt === 'number' && insertAt >= 0 && insertAt <= chat.length) {
        chat.splice(insertAt, 0, message);
        await saveChatConditional();
        await eventSource.emit(event_types.MESSAGE_SENT, insertAt);
        await reloadCurrentChat();
        await eventSource.emit(event_types.USER_MESSAGE_RENDERED, insertAt);
    } else {
        chat.push(message);
        const chat_id = (chat.length - 1);

        // Render the message immediately so the user sees it before the save round-trip.
        addOneMessage(message);
        await eventSource.emit(event_types.MESSAGE_SENT, chat_id);
        await eventSource.emit(event_types.USER_MESSAGE_RENDERED, chat_id);

        // Save is awaited (not fire-and-forget) to guarantee persistence before generation
        // starts and to avoid a timeout race where save #2 (after AI response) could miss
        // the isChatSaving window and silently drop the AI message.
        await saveChatConditional();
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

function parseTokenCounts(counts, thisPromptBits) {
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

function addChatsPreamble(mesSendString) {
    return main_api === 'novel'
        ? substituteParams(nai_settings.preamble) + '\n' + mesSendString
        : mesSendString;
}

function addChatsSeparator(mesSendString) {
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
        const character = charactersStore.get(avatar);
        if (!character) {
            toastr.warning(t`Character not found: ${avatar}`);
            return '';
        }
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
    await getCharacters({ silent: true });
    charactersStore.reportCreated(data.path);

    return data.path;
}

function setInContextMessages(msgInContextCount, type) {
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
 * Sends a non-streaming request to the API.
 * @param {string} type Generation type
 * @param {object} data Generation data
 * @param {AdditionalRequestOptions} [options] Additional options for the generation request
 * @returns {Promise<object>} Response data from the API
 * @throws {Error|object}
 */
export async function sendGenerationRequest(type, data, options = {}) {
    if (main_api === 'openai') {
        return await sendOpenAIRequest(type, data.prompt, abortController.signal, options);
    }

    if (main_api === 'koboldhorde') {
        return await generateHorde(data.prompt, data, abortController.signal, true);
    }

    const response = await fetch(getGenerateUrl(main_api), {
        method: 'POST',
        headers: getRequestHeaders(),
        cache: 'no-cache',
        body: JSON.stringify(data),
        signal: abortController.signal,
    });

    if (!response.ok) {
        throw await response.json();
    }

    return await response.json();
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
            return await sendOpenAIRequest(type, data.prompt, streamingProcessor.abortController.signal, options);
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

function extractTitleFromData(data) {
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
function extractImagesFromData(data, { mainApi = null, chatCompletionSource = null } = {}) {
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
function parseAndSaveLogprobs(data, continueFrom) {
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
function extractMultiSwipes(data, type) {
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

    if (power_user.auto_fix_generated_markdown) {
        getMessage = fixMarkdown(getMessage, false);
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
        // Make room for the incoming swipe. The slot is an empty string rather than `undefined`, and
        // swipe_info gets a matching entry: leaving a genuine non-string here (and leaving the two
        // arrays different lengths) is what made ensureSwipes warn and "repair" on every single
        // generation. It was papering over a placeholder that gets filled moments later.
        //
        // Empty is also the honest value for it. Nothing has been written into this slot yet, and the
        // save path deliberately ignores an empty slot that carries no node_id, so a save landing
        // mid-generation writes nothing instead of trying to store a blank message.
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

    // A tree-backed message arrives with a window of alternatives filled in and the rest as null
    // HOLES, meaning "this exists, it just wasn't sent". Repairing a hole into '' (or fabricating
    // swipe_info for it) turns "not loaded" into "empty", and a save then writes that emptiness over
    // real stored text. Holes belong to hydrateSwipes(); leave them be. A message with no node_id
    // isn't tree-backed and always arrives complete, so a non-string there is genuine corruption and
    // still gets repaired exactly as before.
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

    // The selected slot IS this message - same row, same text. Saying so matters: the save path reads
    // a slot with text and no node_id as a brand new alternative, so a synthesised entry made this
    // message look like it had one, on every message in the chat, on every save. The server deduped
    // each back onto the row it came from and the client asked again next time.
    // Unless the slot is the blank one an overswipe just opened. That slot is not this message - it is
    // an empty place to write something new, and it has no row precisely because nothing has been
    // written into it yet. Stamping it with this message's row made it look like a real alternative,
    // and everything that asks "has anything been written here" then answered yes: cancelling the
    // editor stopped removing it, so the blank stayed selected with the conversation below it still
    // detached, and the message kept an empty alternative to swipe past forever after.
    //
    // isMessageSwipeable() runs this on the way past, so simply asking whether the arrows should be
    // shown was enough to do it.
    const selectedSlot = updates.swipe_id ?? message.swipe_id ?? 0;
    const slotIsBlank = typeof swipes[selectedSlot] === 'string' && swipes[selectedSlot].length === 0;
    if (message.node_id && !slotIsBlank && swipeInfo[selectedSlot] && !swipeInfo[selectedSlot].node_id) {
        swipeInfo[selectedSlot] = { ...swipeInfo[selectedSlot], node_id: message.node_id };
        swipeInfoDirty = true;
        updated = true;
    }

    if (swipesDirty) updates.swipes = swipes;
    if (swipeInfoDirty) updates.swipe_info = swipeInfo;

    if (updated) {
        mesId ??= chat.indexOf(message);
        if (mesId >= 0) {
            // Giving a message the swipe arrays it was missing is not an edit to it. The text is
            // untouched; this only fills in shape the loader does not send, and a user message never
            // has any, so a chat full of them arrives needing this on every single one.
            //
            // updateMessage() replaces the object, and a message that is not the object the snapshot
            // holds reads as changed - so without saying otherwise, merely opening a chat left every
            // message dirty and the next save rewrote every row with the content it already had. One
            // full rewrite of the conversation per load, which is what the write amplification looked
            // like from the outside.
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

/**
 * How many alternatives either side of a requested one to pull in when filling holes, matching the
 * window the server sends inline so stepping onward stays instant.
 */
const ALTERNATIVE_FETCH_WINDOW = 25;

/**
 * Fills in alternatives that a chat load left as holes.
 *
 * A tree-backed load sends a window of alternatives around the selected one and `null` everywhere
 * else, because a wide fork point can carry well over a thousand and their text runs to hundreds of
 * KB that nothing reads. `null` rather than an empty string on purpose: a hole has to be
 * distinguishable from a genuinely empty message, so anything indexing into it fails visibly instead
 * of quietly rendering blank text as though it were real.
 *
 * Anything that needs an alternative at an arbitrary index awaits this first. Messages are
 * deep-frozen, so the filled arrays go back through updateMessage rather than being written in place.
 *
 * @param {number} mesId Index into `chat`
 * @param {{ index?: number|null, all?: boolean }} [options] Which holes to fill: a single index (plus
 *   a window around it), or every hole in the message.
 * @returns {Promise<boolean>} true when the requested alternatives are present afterwards
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

    // Whether this message had unsaved changes BEFORE hydrating. Filling in holes is not an edit -
    // the text comes from the server - so a message that was clean should stay clean afterwards.
    // Checked up front so a genuine pending edit is never marked saved by accident.
    const wasClean = _messageSnapshots.get(message.node_id) === message;

    // Chats that aren't tree-backed always arrive complete, so a hole there is not something a fetch
    // can repair.
    if (!message.node_id) {
        return false;
    }

    // The opening is not addressed like the rest of the chat.
    //
    // Its alternatives are the UNION of the character's stored openings and the greetings that only
    // exist on the card, computed by the openings endpoint - which is what sized this swipe array in
    // the first place. Asking /alternatives for siblings of the opening's row returns only the stored
    // half, in a different order past the stored prefix, so the text landing in each hole would be the
    // wrong greeting. It also cannot answer at all for an opening that has no row yet, which under
    // provisional ids is the ordinary case rather than an edge one.
    const isOpening = mesId === 0 && !!chat_metadata?._tree_stored;
    const { character, contents } = isOpening ? _cardGreetingContents() : { character: null, contents: [] };
    if (isOpening && !character) {
        return false;
    }
    if (!isOpening && !isStoredNodeId(message.node_id)) {
        return false;
    }

    const body = isOpening
        ? { avatar_url: character.avatar, card_greetings: contents }
        : { node_id: message.node_id };
    if (!all) {
        body.offset = Math.max(0, index - ALTERNATIVE_FETCH_WINDOW);
        body.limit = ALTERNATIVE_FETCH_WINDOW * 2 + 1;
    } else if (isOpening) {
        // The openings endpoint windows by default (a character here has over 1,500 of them), so
        // "every hole" has to be asked for as a range rather than by leaving the range off.
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
        // Never overwrite something already in hand - a locally edited alternative that hasn't been
        // saved yet would otherwise be clobbered by the stored copy.
        if (typeof swipes[at] === 'string') return;
        swipes[at] = alt.mes ?? '';
        // An id is what marks this slot as settled. Without one the save path reads a hydrated slot as
        // a brand new alternative forever: it posts a create for every one on every save (harmless,
        // since adding is idempotent, but endless) and selects the shown one on top. A card-only
        // opening has no row to name, so it gets its provisional id here for the same reason.
        swipeInfo[at] = {
            send_date: alt.send_date,
            extra: alt.extra ?? {},
            name: alt.name,
            is_user: alt.is_user,
            node_id: alt.node_id ?? (isOpening ? provisionalNodeId(alt.name ?? character.name ?? message.name, alt.mes ?? '') : undefined),
        };
    });

    updateMessage(mesId, { swipes, swipe_info: swipeInfo });

    // Hydrating only fills in what was already stored, so it does not make the message unsaved. Left
    // dirty, every hole filled would earn the message an edit on the next save, re-sending content the
    // server had just sent.
    if (wasClean && chat[mesId]?.node_id) {
        _messageSnapshots.set(chat[mesId].node_id, chat[mesId]);
    }

    return all ? true : typeof chat[mesId].swipes[index] === 'string';
}

/**
 * Moves the client onto a different alternative's path.
 *
 * Switching message N to a sibling means the conversation below N is that sibling's continuation,
 * not the old one's. So N's node_id becomes the sibling's actual row, everything after N is dropped
 * from the in-memory chat, and the sibling's own default_child_id chain is fetched and put in its
 * place - the same walk a fresh chat load does.
 *
 * Nothing is removed from the database by any of this. The old alternative keeps its children
 * exactly as they were, and swiping back reaches them again.
 *
 * @param {number} mesId
 * @param {number} swipeId Index of the alternative being switched to
 * @returns {Promise<boolean>} true when the path was switched
 */
export async function switchToAlternativePath(mesId, swipeId) {
    const message = chat[mesId];
    const targetNodeId = message?.swipe_info?.[swipeId]?.node_id;

    // Nothing to move onto. Either this isn't tree-backed (a JSONL chat, where swipes are just an
    // array on the message and there is no separate path), or the slot is a blank one that overswiping
    // opened to type into and nothing has been written yet.
    if (!targetNodeId || message.node_id === targetNodeId) {
        return false;
    }

    // Moving onto a greeting the tree has no row for. Showing it is not using it, so no row is minted
    // here - it gets one from ensureOpeningRow() when something actually needs one. That also settles
    // what follows it: a greeting nothing has ever been said to has no continuation, which is a fact,
    // not a failed lookup. Asking the server would only turn it into a 404 that reads as an error and
    // aborts the switch.
    const unstored = isProvisionalNodeId(targetNodeId);
    let payload = { messages: [] };
    if (!unstored) {
        try {
            const response = await fetch('/api/chats/continuation', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ node_id: targetNodeId, chat_name: getCurrentChatId() }),
            });
            if (!response.ok) {
                console.warn(`[switchToAlternativePath] HTTP ${response.status} fetching continuation for ${targetNodeId}`);
                return false;
            }
            payload = await response.json();
        } catch (error) {
            console.warn('[switchToAlternativePath] Failed to fetch continuation:', error);
            return false;
        }
    }

    // Re-check: the await means the chat may have moved on while the fetch was in flight.
    if (chat[mesId] !== message) {
        return false;
    }

    updateMessage(mesId, { node_id: targetNodeId, swipe_id: swipeId });
    chat.splice(mesId + 1, chat.length - (mesId + 1), ...(payload.messages ?? []));

    // Persist the choice, and move the pointer onto the node now being shown.
    //
    // select() records which child this fork shows. On its own that was never enough: a reload
    // resolved the character's chat pointer, and while that pointer named a position on the OLD
    // alternative's path, walking up from it returned the old alternative every time. The choice was
    // being written somewhere the reload never consulted.
    //
    // The pointer is where you are. Switching alternatives moves you, so it moves too. It does not
    // need updating as the conversation grows, since a load descends default_child_id from wherever
    // it points down to the leaf.
    //
    // An unstored greeting has nothing to persist and nothing to point at: naming it as the selected
    // child or as the character's position would write an id no row answers to, and the next load
    // would resolve it to nowhere. It becomes persistable the moment ensureOpeningRow() gives it a
    // row, which is also the moment there is something worth coming back to.
    const avatar = getCurrentCharacter()?.avatar;
    if (!unstored) {
        try {
            await fetch('/api/chats/message/select', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ avatar_url: avatar, node_id: targetNodeId }),
            });
            if (avatar) {
                charactersStore.update(avatar, { chat: targetNodeId });
                await saveActiveChat(avatar, targetNodeId);
            }
        } catch (error) {
            console.warn('[switchToAlternativePath] Failed to persist the selection:', error);
        }
    }

    // Everything in the chat now matches what is stored: the messages below came straight from the
    // server, and the switch itself was persisted above. Without saying so they are fresh objects the
    // snapshot has never seen, so the next save reads every one as changed and posts an edit for it -
    // one per message, on every switch, re-sending content the server just handed over.
    _snapshotMessages();

    await redisplayChat({ startIndex: mesId });
    updateViewMessageIds();
    refreshSwipeButtons(true);
    return true;
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

    // isChatResident: true when operating on the live chat array (use updateMessage for frozen
    // messages), false when called with an external targetMessage (e.g. a cloned snapshot in
    // getBranchChatSnapshot) that can be mutated directly.
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
    chat_metadata = {};
    // resets the characters array, forcing getcharacters to reset
    characters.length = 0;
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
    abortController = controller;
}

/**
 * Sets the currently selected character, keyed by avatar (`this_avatar`, the source of truth).
 * @param {string|object|undefined} value A character avatar, a character object, or undefined to clear.
 */
export function setCharacterId(value) {
    switch (typeof value) {
        case 'string':
            this_avatar = charactersStore.has(value) ? value : undefined;
            break;
        case 'object': {
            // Identify by avatar rather than by object reference - the object may be a fresh reload of the
            // same character (different reference, same avatar), which should still resolve.
            const avatar = value?.avatar;
            this_avatar = (avatar !== undefined && charactersStore.has(avatar)) ? avatar : undefined;
            break;
        }
        case 'undefined':
            this_avatar = undefined;
            break;
        default:
            console.error('Invalid character ID type:', value);
            break;
    }
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

            // Replace other auxiliary fields where was referenced by avatar key
            // Tag List
            renameTagKey(oldAvatar, newAvatar);

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
                active_character = newAvatar;
                saveSettingsDebounced('active_character');
            }

            await eventSource.emit(event_types.CHARACTER_RENAMED, oldAvatar, newAvatar);

            // Unload current character
            setCharacterId(undefined);
            // Reload characters list
            await getCharacters({ silent: true });
            charactersStore.reportRenamed(oldAvatar, newAvatar);

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
    // Tree DB path: single server-side UPDATE instead of fetching and re-saving every chat file
    if (chat_metadata?._tree_stored) {
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
            console.debug(`[renamePastChats] Tree DB: renamed ${data.updated} messages`);
        } catch (error) {
            toastr.error(t`Past chats could not be renamed`);
            console.error(error);
        }
        return;
    }

    // JSONL fallback: fetch and re-save each chat file individually
    const pastChats = await getPastCharacterChats();

    for (const { file_name } of pastChats) {
        try {
            const fileNameWithoutExtension = file_name.replace('.jsonl', '');
            const getChatResponse = await fetch('/api/chats/get', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({
                    ch_name: newName,
                    file_name: fileNameWithoutExtension,
                    avatar_url: newAvatar,
                }),
                cache: 'no-cache',
            });

            if (getChatResponse.ok) {
                const currentChat = await getChatResponse.json();

                for (const message of currentChat) {
                    if (message.is_user || message.is_system || message.extra?.type == system_message_types.NARRATOR) {
                        continue;
                    }

                    if (message.name !== undefined) {
                        message.name = newName;
                    }
                }

                await eventSource.emit(event_types.CHARACTER_RENAMED_IN_PAST_CHAT, currentChat, oldAvatar, newAvatar);

                const saveChatRequest = await compressRequest({
                    method: 'POST',
                    headers: getRequestHeaders(),
                    body: JSON.stringify({
                        ch_name: newName,
                        file_name: fileNameWithoutExtension,
                        chat: currentChat,
                        avatar_url: newAvatar,
                    }),
                    cache: 'no-cache',
                });
                const saveChatResponse = await fetch('/api/chats/save', saveChatRequest);

                if (!saveChatResponse.ok) {
                    throw new Error('Could not save chat');
                }
            }
        } catch (error) {
            toastr.error(t`Past chat could not be updated: ${file_name}`);
            console.error(error);
        }
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
        await saveChatConditional();
        console.debug('Chat saved');
    }, DEFAULT_SAVE_EDIT_TIMEOUT);
}


/**
 * True when the message is sitting on a swipe slot that is blank and has never been written.
 *
 * Overswiping opens an empty slot for the user to type into. Nothing exists for it yet, so there is
 * nothing to save - and trying anyway means asking the server to blank the row the message still
 * names, which it refuses.
 *
 * @param {object} message
 */
function _isBlankUnwrittenSwipe(message) {
    if (!Array.isArray(message?.swipes)) return false;
    const at = message.swipe_id ?? 0;
    if (typeof message.swipes[at] !== 'string' || message.swipes[at].length > 0) return false;
    return !message.swipe_info?.[at]?.node_id;
}

/**
 * The card's greetings in the shape the openings endpoint merges against.
 *
 * Every caller that asks for openings has to send the SAME set, because the union's ordering and
 * total are computed from it: ask with a different set and the offsets no longer line up with the
 * swipe array they are meant to fill.
 *
 * Raw card text, deliberately unregexed, and the speaker taken from the card rather than name2 -
 * identity is the message as stored, and a regexed body or a persona name makes every stored greeting
 * compare as new.
 *
 * @returns {{ character: object|null, speaker: string, contents: object[] }}
 */
function _cardGreetingContents() {
    const character = getCurrentCharacter();
    if (!character?.avatar) return { character: null, speaker: '', contents: [] };
    const { greetings } = cardToGreetingsModel(character);
    const speaker = character.name ?? name2;
    const sendDate = getMessageTimeStamp();
    const contents = (greetings ?? [])
        .filter(text => typeof text === 'string' && text.length > 0)
        .map(text => ({
            name: speaker,
            is_user: false,
            is_system: false,
            send_date: sendDate,
            mes: text,
            extra: {},
        }));
    return { character, speaker, contents };
}

/** In-flight ensureOpeningRow() calls, keyed by provisional id, so two callers make one row. */
const _openingRowInFlight = new Map();

/**
 * Turns the opening's provisional id into a real row, and is the ONLY thing that ever writes
 * chat[0].node_id.
 *
 * A greeting earns a row by being used, not by being shown, so the row is minted here - at the
 * moment something genuinely needs one: replying into the chat, labelling the node, forking at it,
 * or saving an edit to it. Everywhere else is happy with the provisional id.
 *
 * Being the single writer is the point. When several places could each mint one, they raced: two
 * rows for one greeting, two ideas of which was the opening, and a swipe_info still naming a third.
 * Here the id, the slot bookkeeping and the snapshot all move together, so there is no window in
 * which they disagree.
 *
 * @param {number} [mesId] index into `chat`; only an opening can be provisional
 * @returns {Promise<string|null>} the real node id, or null when there cannot be one
 */
export async function ensureOpeningRow(mesId = 0) {
    const message = chat[mesId];
    if (!message) return null;
    if (isStoredNodeId(message.node_id)) return message.node_id;
    // No id at all means this is not a tree-backed opening (a JSONL chat, or a message that has
    // simply never been saved); minting an opening for it would be inventing one.
    if (!isProvisionalNodeId(message.node_id)) return null;

    const character = getCurrentCharacter();
    const text = typeof message.mes === 'string' ? message.mes : '';
    // An opening with no text is not a greeting - the server refuses to store one, so asking is only
    // a round trip that comes back null.
    if (!character?.avatar || !text.trim()) return null;

    const provisional = message.node_id;
    const wasClean = _messageSnapshots.get(provisional) === message;

    let pending = _openingRowInFlight.get(provisional);
    if (!pending) {
        pending = (async () => {
            const response = await fetch('/api/chats/openings/ensure', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({
                    avatar_url: character.avatar,
                    contents: [{
                        name: message.name ?? character.name ?? name2,
                        is_user: !!message.is_user,
                        is_system: false,
                        send_date: message.send_date ?? getMessageTimeStamp(),
                        mes: text,
                        extra: message.extra ?? {},
                    }],
                }),
            });
            const made = response.ok ? await response.json().catch(() => null) : null;
            return made?.node_ids?.[0] ?? null;
        })().finally(() => _openingRowInFlight.delete(provisional));
        _openingRowInFlight.set(provisional, pending);
    }

    let realId = null;
    try {
        realId = await pending;
    } catch (error) {
        console.warn('[greetings] Could not give this greeting a row:', error);
        return null;
    }
    if (!realId) return null;

    // Re-read: the await means the opening may have been replaced or the chat moved on.
    const current = chat[mesId];
    if (!current || current.node_id !== provisional) {
        return isStoredNodeId(chat[mesId]?.node_id) ? chat[mesId].node_id : null;
    }

    // The slot that is showing IS this row now, so it stops being card-only in the same breath as the
    // message adopting the id. Leaving the slot behind is what let the save path read the shown
    // greeting as an alternative still waiting to be created.
    const at = current.swipe_id ?? 0;
    const updates = { node_id: realId };
    if (Array.isArray(current.swipe_info)) {
        const swipeInfo = [...current.swipe_info];
        swipeInfo[at] = { ...(swipeInfo[at] ?? {}), node_id: realId };
        updates.swipe_info = swipeInfo;
    }
    updateMessage(mesId, updates);

    // The row now holds exactly what the message holds, so an opening that was in step with storage
    // still is - under its new key. Dropping the old key keeps the map from carrying an entry nothing
    // can ever match again.
    _messageSnapshots.delete(provisional);
    if (wasClean && chat[mesId]?.node_id === realId) {
        _messageSnapshots.set(realId, chat[mesId]);
    }

    // Now that there is a row, there is somewhere to stand, and this is the only moment at which that
    // becomes true - so recording it belongs here rather than at the swipe.
    //
    // Swiping onto a card-only greeting deliberately persists nothing: there is no id a reload could
    // resolve. But the moment the greeting earns a row, the character is still pointing at whichever
    // opening it was on before, and a load descends from the pointer - so the conversation being
    // started here would come back under a greeting nobody chose, with the reply hanging off a
    // sibling the load never visits.
    try {
        await fetch('/api/chats/message/select', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ avatar_url: character.avatar, node_id: realId }),
        });
        charactersStore.update(character.avatar, { chat: realId });
        await saveActiveChat(character.avatar, realId);
    } catch (error) {
        console.warn('[greetings] The greeting has a row, but the position could not be recorded:', error);
    }

    return realId;
}

/**
 * Brings the card's current greetings into an already-open chat's opening alternatives.
 *
 * A loaded chat builds its opening swipes from stored siblings, so a greeting that has never been
 * used has no row and would not appear at all - which is why editing one showed nothing, even after a
 * reload. The openings endpoint computes the union, and card-only entries sort after the stored ones,
 * so exactly those can be asked for once their count is known.
 *
 * Nothing is written. An appended slot carries a provisional id, which is what marks it as text that
 * lives on the card and nowhere else; it gains a row if someone uses it.
 */
async function _mergeCardGreetingsIntoOpening() {
    if (!chat_metadata?._tree_stored) return;

    const opening = chat[0];
    const character = getCurrentCharacter();
    if (!opening?.node_id || !character?.avatar) return;

    // Raw card text, deliberately unregexed. Identity is the message as stored, and stored openings
    // hold the card's own text - regex is a display transform applied on the way to the screen. Sending
    // the transformed version made every already-stored greeting look brand new, which on this card
    // meant 927 phantom alternatives appearing out of nowhere.
    const { greetings } = cardToGreetingsModel(character);
    // The speaker is the CHARACTER, taken from the card rather than from name2 - which tracks the
    // active persona and produced "n-n" here. Speaker is part of identity, so getting it wrong made
    // all 929 stored greetings compare as new: 1511 + 929 phantom alternatives.
    const speaker = character.name ?? opening.name ?? name2;
    const contents = (greetings ?? [])
        .filter(text => typeof text === 'string' && text.length > 0)
        .map(text => ({
            name: speaker,
            is_user: false,
            is_system: false,
            send_date: opening.send_date,
            mes: text,
            extra: {},
        }));
    if (!contents.length) return;

    const ask = async (body) => {
        try {
            const response = await fetch('/api/chats/openings', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ avatar_url: character.avatar, card_greetings: contents, ...body }),
            });
            return response.ok ? await response.json().catch(() => null) : null;
        } catch (error) {
            console.warn('[greetings] Could not read openings:', error);
            return null;
        }
    };

    // Same reasoning as _openingFromTree: this used to bail unless the character had chat history,
    // which has nothing to do with whether its card's greetings belong in this opening.
    const head = await ask({});
    if (!head) return;

    const cardOnlyCount = (head.total ?? 0) - (head.stored ?? 0);
    if (cardOnlyCount <= 0) return;

    const tail = await ask({ offset: head.stored, limit: cardOnlyCount });
    const extras = (tail?.alternatives ?? []).filter(a => !a.node_id);
    if (!extras.length) return;

    const current = chat[0];
    if (!current?.node_id || current.node_id !== opening.node_id) return;

    const swipes = Array.isArray(current.swipes) ? [...current.swipes] : [current.mes ?? ''];
    const swipeInfo = Array.isArray(current.swipe_info)
        ? [...current.swipe_info]
        : [{ send_date: current.send_date, extra: current.extra ?? {}, node_id: current.node_id }];

    // Rebuild the card-only tail rather than appending to it. A slot with a node_id is a real row and
    // stays untouched; a slot without one is card text, and editing a greeting means the old text is
    // no longer on the card. Appending alone would leave the old version sitting there forever.
    const keptSwipes = [];
    const keptInfo = [];
    for (let k = 0; k < swipes.length; k++) {
        const isStored = isStoredNodeId(swipeInfo[k]?.node_id);
        const isHole = typeof swipes[k] !== 'string';
        if (isStored || isHole) {
            keptSwipes.push(swipes[k]);
            keptInfo.push(swipeInfo[k] ?? null);
        }
    }

    const known = new Set(keptSwipes.filter(x => typeof x === 'string'));
    for (const extra of extras) {
        if (known.has(extra.mes)) continue;
        known.add(extra.mes);
        keptSwipes.push(extra.mes);
        // A provisional id, not a bare absent one: the save path reads a slot with no id at all as a
        // new alternative to create, which is the opposite of what a card greeting means.
        keptInfo.push({
            send_date: extra.send_date, extra: extra.extra ?? {},
            name: extra.name, is_user: extra.is_user,
            node_id: provisionalNodeId(extra.name ?? speaker, extra.mes),
        });
    }

    const unchanged = keptSwipes.length === swipes.length
        && keptSwipes.every((x, k) => x === swipes[k]);
    if (unchanged) return;

    swipes.length = 0;
    swipes.push(...keptSwipes);
    swipeInfo.length = 0;
    swipeInfo.push(...keptInfo);

    // Whatever is being shown must survive the rebuild.
    const shownWas = current.swipe_id ?? 0;
    const shownText = current.swipes?.[shownWas];
    let shownAt = swipes.indexOf(shownText);

    const updates = { swipes, swipe_info: swipeInfo };

    if (shownAt >= 0) {
        updates.swipe_id = shownAt;
    } else if (!isStoredNodeId(current.node_id) && swipes.length) {
        // The greeting on screen was card-only and the card no longer says it - it was edited or
        // removed while this chat sat open. Nothing was ever stored for it, so there is nothing to
        // lose, but the message cannot be left pointing at a slot that now holds different text: `mes`
        // said one greeting, the slot said another, and the chat log showed the mismatch.
        //
        // The card gives no way to tell an edit from a deletion-plus-addition, so this does not try to
        // guess which new greeting the old one became. It keeps the position and makes the three
        // agree.
        shownAt = Math.min(shownWas, swipes.length - 1);
        if (typeof swipes[shownAt] === 'string') {
            updates.swipe_id = shownAt;
            updates.mes = swipes[shownAt];
            updates.name = swipeInfo[shownAt]?.name ?? speaker;
            updates.node_id = swipeInfo[shownAt]?.node_id
                ?? provisionalNodeId(updates.name, swipes[shownAt]);
        }
    }

    // Reading is not an edit, so a message that was saved stays saved. An opening that merely followed
    // the card is not an edit either: it has no row and asking for one is exactly what showing a
    // greeting must not do.
    const wasClean = _messageSnapshots.get(current.node_id) === current;
    updateMessage(0, updates);
    if (updates.node_id && updates.node_id !== current.node_id) {
        _messageSnapshots.delete(current.node_id);
    }
    if ((wasClean || updates.node_id) && chat[0]?.node_id) {
        _messageSnapshots.set(chat[0].node_id, chat[0]);
    }
    // Changing which greeting the opening holds has to reach the screen. Only the swipe buttons were
    // being refreshed, so editing the greeting a chat was sitting on updated `mes`, the slot list and
    // the id, and left the message on screen still reading the text from before the edit - which looked
    // exactly like the edit having done nothing at all.
    if (updates.mes !== undefined && chat[0]) {
        updateMessageBlock(0, chat[0]);
    }
    refreshSwipeButtons(true);
}

/**
 * Puts back what follows a message, re-derived from the tree.
 *
 * Overswiping a message truncates the visible conversation to it, so you are sitting at that point
 * ready to say something else. Leaving that blank slot has to restore what was there. It is fetched
 * rather than remembered: the nodes never went anywhere, only the client's view of them.
 *
 * @param {number} mesId
 */
async function _restoreContinuation(mesId) {
    const message = chat[mesId];
    if (!chat_metadata?._tree_stored) return;
    // An opening with only a provisional id has no row, so nothing can follow it and there is nothing
    // to put back. Asking would be a lookup for an id no row answers to.
    if (!isStoredNodeId(message?.node_id)) return;

    let payload;
    try {
        const response = await fetch('/api/chats/continuation', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ node_id: message.node_id, chat_name: getCurrentChatId() }),
        });
        if (!response.ok) return;
        payload = await response.json();
    } catch (error) {
        console.warn('[restore] Could not fetch what follows:', error);
        return;
    }

    const following = payload?.messages ?? [];
    if (!following.length && chat.length === mesId + 1) return;

    chat.splice(mesId + 1, chat.length - (mesId + 1), ...following);
    await redisplayChat({ startIndex: mesId });
    updateViewMessageIds();
    refreshSwipeButtons(true);
}

/** Whether a given slot on a message is a blank nobody has typed into yet. */
function _isBlankSlot(message, at) {
    if (!Array.isArray(message?.swipes)) return false;
    if (typeof message.swipes[at] !== 'string' || message.swipes[at].length > 0) return false;
    return !message.swipe_info?.[at]?.node_id;
}

// ---------------------------------------------------------------------------
//  The writes a chat can make.
//
//  One function per thing that can happen to a conversation, each naming the row it acts on and
//  owning the bookkeeping that goes with it: the id the message ends up carrying, and recording it as
//  in step with storage. Call one at the moment the thing happens and there is nothing to work out
//  afterwards.
//
//  This is where the knowledge belongs. A save that compares the conversation against a snapshot can
//  only guess which of these took place, and guesses wrong in a way that costs writes - see
//  _saveTreeChat below, which is now a compatibility path for callers that mutate `chat` and ask for
//  a save without saying what they did. Our own code should call these directly and never go near it.
// ---------------------------------------------------------------------------

/** Posts one operation. Throws on refusal, so a caller cannot mistake a refusal for a write. */
async function _chatOpPost(path, body) {
    const avatar = getCurrentCharacter()?.avatar;
    if (!avatar) throw new Error('no character is selected');
    const response = await fetch(path, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ avatar_url: avatar, ...body }),
    });
    if (!response.ok) throw new Error(`${path} responded ${response.status}`);
    return response.json().catch(() => ({}));
}

/**
 * Records that this message is in step with the row it names.
 *
 * Reads the live object rather than a caller's copy, since updateMessage() may have replaced it.
 */
function _markMessageSaved(mesId, nodeId) {
    const live = mesId < chat.length ? chat[mesId] : null;
    if (live?.node_id && live.node_id === nodeId) {
        _messageSnapshots.set(live.node_id, live);
    }
}

/** Content for one alternative, with the swipe machinery stripped - it is a message, not a set. */
function _alternativeContent(msg, text) {
    const alt = { ...msg, mes: text };
    delete alt.swipes;
    delete alt.swipe_info;
    delete alt.swipe_id;
    delete alt.swipe_speaker_default;
    return alt;
}

/**
 * This message's text changed. Writes it to the row the message names.
 *
 * Never sends an edit that would empty a message: the route refuses one outright, so posting it can
 * only come back 409, and mirroring the rule here means no client state can produce the request.
 *
 * @returns {Promise<boolean>} true when the row now holds this message's content
 */
export async function chatOpEdit(mesId) {
    const msg = chat[mesId];
    if (!isStoredNodeId(msg?.node_id)) return false;
    if (typeof msg.mes === 'string' && msg.mes.length === 0) return false;

    await _chatOpPost('/api/chats/message/edit', { node_id: msg.node_id, content: msg });
    _markMessageSaved(mesId, msg.node_id);
    return true;
}

/**
 * One change that spans many messages, sent as one thing.
 *
 * Attributing a run of messages to a persona, or hiding a range, is a single act the reader took, and
 * goes as a single request. Sending it as one edit per message is N round trips for one decision, and
 * N chances to end up half applied.
 *
 * @param {number[]} mesIds the messages whose current content should be written
 * @returns {Promise<number>} how many the store accepted
 */
export async function chatOpEditMany(mesIds) {
    const edits = [];
    for (const mesId of mesIds) {
        const msg = chat[mesId];
        if (!isStoredNodeId(msg?.node_id)) continue;
        if (typeof msg.mes === 'string' && msg.mes.length === 0) continue;
        edits.push({ node_id: msg.node_id, content: msg, _mesId: mesId });
    }
    if (!edits.length) return 0;

    const result = await _chatOpPost('/api/chats/message/edit-batch', {
        edits: edits.map(({ node_id, content }) => ({ node_id, content })),
    });

    // Only the ones the store took are in step with it. A refusal is named, so the rest stay dirty
    // rather than every message being marked saved because the request as a whole came back ok.
    const refused = new Set((result.refused ?? []).map(r => r.node_id));
    for (const edit of edits) {
        if (!refused.has(edit.node_id)) _markMessageSaved(edit._mesId, edit.node_id);
    }
    if (refused.size) {
        console.warn('[chat] Some messages were not changed:', result.refused);
    }
    return result.applied ?? 0;
}

/**
 * These messages are new and follow what is already there. Appends them after the last stored node
 * above them.
 *
 * An opening that has no row yet earns one here, because an append has to name the row it attaches
 * to - that is the one moment a greeting being replied to becomes a greeting that was used.
 *
 * @param {number} fromIndex first of the new messages
 * @returns {Promise<string[]>} the ids they were given
 */
export async function chatOpAppend(fromIndex) {
    let after = null;
    for (let i = fromIndex - 1; i >= 0; i--) {
        if (isProvisionalNodeId(chat[i]?.node_id)) await ensureOpeningRow(i);
        if (isStoredNodeId(chat[i]?.node_id)) { after = chat[i].node_id; break; }
    }
    if (!after) return [];

    const result = await _chatOpPost('/api/chats/message/append', {
        after_node_id: after,
        messages: chat.slice(fromIndex),
    });
    const ids = result.node_ids ?? [];
    ids.forEach((node_id, offset) => {
        const index = fromIndex + offset;
        if (index < chat.length) updateMessage(index, { node_id });
        _markMessageSaved(index, node_id);
    });
    return ids;
}

/**
 * Another alternative belongs alongside this message. Adds it as a sibling and tells the caller which
 * row it turned out to be - which may be one that already existed, since asserting the same
 * alternative twice is the same statement made twice.
 *
 * @returns {Promise<string|null>} the sibling's row id
 */
export async function chatOpAddAlternative(mesId, text) {
    const msg = chat[mesId];
    if (!isStoredNodeId(msg?.node_id) || typeof text !== 'string' || !text.length) return null;

    const created = await _chatOpPost('/api/chats/message/alternative', {
        sibling_node_id: msg.node_id,
        contents: [_alternativeContent(msg, text)],
    });
    return created?.node_ids?.[0] ?? null;
}

/**
 * The conversation ends at this message. Whatever followed stops being shown.
 *
 * This is what cutting a chat back to a point is, and what deleting from the end is. Nothing is
 * removed: the messages below keep their rows and their own continuations, and swiping or selecting
 * back onto one brings all of it back.
 *
 * It has to be said on the message rather than by moving the chat's position, because a load descends
 * from wherever the chat points down to a leaf and reads the conversation off that leaf's parents. A
 * position part-way up is walked straight past, which is why truncating by moving it did nothing.
 *
 * @returns {Promise<boolean>} true when the conversation now ends here
 */
export async function chatOpEndPath(mesId) {
    const msg = chat[mesId];
    if (!isStoredNodeId(msg?.node_id)) return false;

    await _chatOpPost('/api/chats/message/end-path', { node_id: msg.node_id });
    return true;
}

/**
 * This alternative is the one being shown. Points the fork at it and moves the message onto its row.
 *
 * @returns {Promise<boolean>} true when the selection was recorded
 */
export async function chatOpSelect(mesId, swipeId) {
    const msg = chat[mesId];
    const nodeId = msg?.swipe_info?.[swipeId]?.node_id;
    if (!isStoredNodeId(nodeId)) return false;

    await _chatOpPost('/api/chats/message/select', { node_id: nodeId });
    if (msg.node_id !== nodeId) updateMessage(mesId, { node_id: nodeId });
    _markMessageSaved(mesId, nodeId);
    return true;
}

/**
 * Saves a tree-backed chat by RECONSTRUCTING operations from a before-and-after comparison, and
 * sending those.
 *
 * It used to say it saved "the operations it actually is", which is not what it does and is worth
 * being blunt about, because the difference is the whole problem. It has no idea what the user did.
 * It walks the conversation, asks of each message "is this the same object the last snapshot held",
 * and turns every answer of no into an edit.
 *
 * Reference equality is standing in for "the content changed", and it is not that. updateMessage()
 * replaces a message for plenty of reasons that are not edits: moving to a different swipe, clearing
 * generation data, filling in a hole that was fetched, recording the id a slot turned out to have. So
 * swiping produces edits that re-send text nobody touched, which is the write amplification, and it
 * is inherent to guessing after the fact rather than a flaw in how the guess is made.
 *
 * The operations themselves are the right shape - edit this node, append after this node, add an
 * alternative alongside this node, each naming a row, so a row the client never received cannot be
 * touched. What is wrong is deriving which one happened instead of being told. The client knows at
 * the time: a message was typed, an edit was confirmed, a swipe was chosen. Every caller here has
 * already thrown that away by the time it asks for a save.
 *
 * Untangling that reaches past this function - roughly fifty callers ask for a save with no
 * operation attached, extensions among them, through a context API whose whole contract is "I
 * changed `chat`, please persist it".
 *
 * Returns null when the chat has nothing persisted yet (a brand new chat), because "create this
 * conversation" genuinely is a whole-array operation and there is no node to hang anything off.
 *
 * @param {string} fileName
 * @param {object} metadata
 * @param {object[]} messages the chat slice being saved
 * @returns {Promise<{ integrity?: string } | null>}
 */
async function _saveTreeChat(fileName, metadata, messages, addressedByName = false) {
    const avatar = getCurrentCharacter()?.avatar;
    if (!avatar) return null;

    const post = async (path, body) => {
        const response = await fetch(path, {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ avatar_url: avatar, ...body }),
        });
        if (!response.ok) {
            throw new Error(`${path} responded ${response.status}`);
        }
        return response.json().catch(() => ({}));
    };

    let lastPersisted = null;
    let firstNewIndex = -1;

    // Each operation records its own message as saved the moment its write lands, rather than leaving
    // all of it to the single _snapshotMessages() the caller runs after the whole save succeeds. One
    // message failing used to abort the rest before that snapshot ever ran, so every message still
    // compared as unsaved next time - including the ones whose writes did land - and the save re-sent
    // the entire chat, growing by one per exchange.

    for (let i = 0; i < messages.length; i++) {
        let msg = messages[i];

        if (!msg.node_id) {
            if (firstNewIndex < 0) firstNewIndex = i;
            continue;
        }

        // A provisional id is a greeting the card has and the tree does not. This is the seam where it
        // stops being that - and the only one, so there is exactly one moment at which the opening's
        // id, its slot bookkeeping and its snapshot all change, together.
        //
        // Two questions cover everything that needs a row: was something written into the opening, and
        // does anything follow it. Neither of them is "the greeting was shown", which is the whole
        // point - a card of a thousand greetings swiped through end to end still writes nothing.
        let justEnsured = false;
        if (isProvisionalNodeId(msg.node_id)) {
            // "Was something written into this greeting" is answerable from the message alone, because
            // the provisional id is derived from the text it stands for: text that still hashes to its
            // own id is text nobody has changed. That is deliberately not the same question as "is this
            // object different from the last snapshot" - a message gets replaced for all sorts of
            // reasons (holes filled, swipe arrays normalised, a slot's bookkeeping learned) and none of
            // those is a reason to write a row.
            const at = msg.swipe_id ?? 0;
            const said = msg.swipe_info?.[at]?.name ?? msg.name;
            const written = msg.node_id !== provisionalNodeId(said, msg.mes);
            const followed = messages.length > i + 1;
            if (written || followed) {
                const realId = await ensureOpeningRow(i);
                if (realId && chat[i]?.node_id === realId) {
                    msg = chat[i];
                    justEnsured = true;
                }
            }
        }

        // Still card-only: nothing is stored for it, so there is nothing to edit and nothing an
        // append could attach to. Leaving lastPersisted alone is what says so.
        if (!isStoredNodeId(msg.node_id)) continue;

        lastPersisted = msg.node_id;

        // Reference equality against the snapshot is the change detector; messages are frozen, so an
        // unchanged message is literally the same object.
        const seen = _messageSnapshots.get(msg.node_id);
        if (seen === msg) continue;

        // A different object is not the same thing as different content, and this is where that
        // distinction was being lost. Plenty replaces a message without changing it - the loader fills
        // in swipe arrays a user message never has, a slot learns the id it turned out to be - and
        // every one of those made the message compare as changed. Measured: opening a chat and saving
        // it, having touched nothing, sent an edit for every message in it, each carrying content
        // byte-identical to the row it was rewriting.
        //
        // Comparing the content itself only ever suppresses a write that provably changes nothing, so
        // it cannot lose an edit: anything that differs at all still goes. It is not an attempt to
        // work out what the caller did - that question belongs to the operations above, which are told
        // rather than left to guess.
        if (seen && JSON.stringify(seen) === JSON.stringify(msg)) {
            _markMessageSaved(i, msg.node_id);
            continue;
        }

        // One rule for every slot: no node_id means no row yet, so it is new. Holes are skipped
        // (never loaded, nothing to say about them) and so are empty slots (overswiping opens a blank
        // one, and a blank nobody has typed into is not an alternative yet).
        //
        // The selected slot used to be exempt here, which was wrong and is why writing a new greeting
        // over an overswipe edited the PREVIOUS greeting's row instead of making a sibling - the
        // message still named the old node, so the "new" greeting inherited its children and looked
        // like an identical tree.
        const hasSlots = Array.isArray(msg.swipes) && Array.isArray(msg.swipe_info);
        const selected = msg.swipe_id ?? 0;

        if (hasSlots
            && typeof msg.swipes[selected] === 'string'
            && msg.swipes[selected].length === 0
            && !msg.swipe_info[selected]?.node_id) {
            // Sitting on a blank slot that has never been written. Nothing exists to save.
            continue;
        }

        let newSelectedId = null;
        let learnedIds = null;
        if (hasSlots) {
            for (let k = 0; k < msg.swipes.length; k++) {
                if (typeof msg.swipes[k] !== 'string') continue;
                if (msg.swipes[k].length === 0) continue;
                // Any id at all, real or provisional, means this slot is not something to create. A
                // provisional one is card text the union injected for display (see
                // _mergeCardGreetingsIntoOpening): deliberately not a row, because a greeting earns
                // one by being used rather than by being on the card. Reading those as "new" minted an
                // opening for every greeting on the card, on every save of message 0.
                if (msg.swipe_info[k]?.node_id) continue;

                const createdId = await chatOpAddAlternative(i, msg.swipes[k]);
                if (!createdId) continue;

                // Remember the row this slot turned out to be. Without this the slot stays id-less and
                // gets posted again on every subsequent save - harmless, since adding is idempotent,
                // but it never stops.
                learnedIds = learnedIds ?? [...msg.swipe_info];
                learnedIds[k] = { ...(learnedIds[k] || {}), node_id: createdId };
                if (k === selected) newSelectedId = createdId;
            }
        }
        if (learnedIds && i < chat.length) {
            updateMessage(i, { swipe_info: learnedIds });
        }

        if (newSelectedId) {
            // The slot being shown is itself brand new, so it becomes this message's node rather than
            // the old one being rewritten underneath it. The slot already learned its id just above,
            // which is what lets the select name it.
            await chatOpSelect(i, selected);
            lastPersisted = newSelectedId;
        } else {
            // Never send an edit that empties a message. The route refuses one outright
            // (wouldBlankStoredText: "no legitimate edit empties a message that has text"), so posting
            // it can only ever come back 409 - and post() throws on that, aborting the rest of the
            // save. Overswiping a greeting reaches exactly this state: the blank slot empties `mes`
            // while the message still names the previous greeting's row, so the save tries to write
            // the blank over it. Mirroring the server's own rule here means no client state can
            // produce the request, rather than guarding the one shape that was found producing it.
            if (typeof msg.mes === 'string' && msg.mes.length === 0) {
                continue;
            }

            // The row this opening just earned was created FROM this message, so it already holds
            // what an edit would send. Posting one anyway asks the server to rewrite a row into the
            // content it was made from, which collides with its own identity and comes back 409 -
            // and a 409 aborts the rest of the save.
            if (justEnsured) {
                _markMessageSaved(i, msg.node_id);
                continue;
            }

            await chatOpEdit(i);
        }
    }

    if (!lastPersisted) return null;

    if (firstNewIndex >= 0) {
        await chatOpAppend(firstNewIndex);
    }

    // Address the chat by where it actually IS, re-read now rather than taken from the name this save
    // was handed before it ran.
    //
    // Metadata is stored on the node the chat is positioned at, so it needs something that resolves to
    // one. A freshly minted chat name does not: nothing in the tree carries it. A brand new chat on a
    // character that isn't in the tree yet gets away with it, because its first save goes through the
    // whole-array route and that labels a node with the name on the way past - but a new chat on a
    // character ALREADY in the tree is tree-backed from its very first save, never takes that route,
    // and so its name labels nothing at all. The position, meanwhile, is a real node the entire time.
    //
    // Only when the caller didn't name a specific chat: an explicit chatName is a deliberate target
    // (a rename, a branch) and is not ours to second-guess.
    // The opening is the fallback because of WHEN a brand new chat first saves: that save runs before
    // the character has been pointed anywhere, so there is no position to read yet - but the node the
    // chat starts from is right here, and it is the very node the pointer is about to be set to.
    // "Names a row", not "isn't provisional". isStoredNodeId() answers the second question, and a
    // minted chat name passes it - it is a string and it has no card: prefix - which is precisely the
    // value that resolves to nothing. Asking whether the conversation in hand actually holds a message
    // by that id answers the first question exactly, with no guessing at the shape of an id.
    const position = getCurrentCharacter()?.chat;
    const opening = chat[0]?.node_id;
    const target = addressedByName
        ? fileName
        : (chat.some(m => m.node_id === position) ? position
            : (isStoredNodeId(opening) ? opening : fileName));

    // A metadata write that fails must not take the save down with it.
    //
    // This is the last step, and by now every message write has landed and been recorded. Letting a
    // refusal here throw discarded the caller's snapshot pass, so every message compared as unsaved
    // next time and the save re-sent the whole conversation - and kept doing it, growing by one
    // message per exchange, for as long as the underlying cause persisted. The edit amplification was
    // never a change detector believing content changed; it was bookkeeping thrown away wholesale
    // because of an unrelated failure at the end.
    try {
        const meta = await post('/api/chats/metadata', { file_name: target, metadata });
        return { integrity: meta.integrity };
    } catch (error) {
        console.warn('[saveChat] The messages are saved; their chat metadata is not:', error);
        return {};
    }
}

/**
 * Saves the chat to the server.
 * @param {object} [options] - Additional options.
 * @param {string} [options.chatName] The name of the chat file to save to
 * @param {object} [options.withMetadata] Additional metadata to save with the chat
 * @param {number} [options.mesId] The message ID to save the chat up to
 * @param {boolean} [options.force] Force the saving despite the integrity check result
 * @param {ChatMessage[]} [options.chatData] Chat snapshot to save instead of the current in-memory chat
 *
 * @returns {Promise<void>}
 */
export async function saveChat({ chatName, withMetadata, mesId, force = false, chatData = undefined } = {}) {
    if (selected_group) {
        toastr.error(t`Operation was aborted to prevent data corruption.`, t`saveChat called for a group chat`);
        throw new Error('saveChat called for a group chat');
    }

    if (arguments.length > 0 && typeof arguments[0] !== 'object') {
        console.trace('saveChat called with positional arguments. Please use an object instead.');
        [chatName, withMetadata, mesId, force] = arguments;
    }

    const metadata = { ...chat_metadata, ...(withMetadata || {}) };
    const fileName = chatName ?? getCurrentCharacter()?.chat;

    if (!fileName && name2 === neutralCharacterName) {
        // TODO: Do something for a temporary chat with no character.
        return;
    }

    if (!fileName) {
        console.warn('saveChat called without chat_name and no chat file found');
        return;
    }

    charactersStore.update(getCurrentCharacter().avatar, { date_last_chat: Date.now() });

    const trimmedChat = Array.isArray(chatData)
        ? chatData
        : (mesId !== undefined && mesId >= 0 && mesId < chat.length)
            ? chat.slice(0, Number(mesId) + 1)
            : chat.slice();

    /** @type {ChatHeader} */
    const chatHeader = {
        chat_metadata: metadata,
        user_name: 'unused',
        character_name: 'unused',
    };

    try {
        const isTreeChat = !!metadata?._tree_stored && !Array.isArray(chatData);

        // A tree-backed chat saves as operations against rows that already exist. The whole-array
        // path below is only for what genuinely is a whole array: a chat with nothing persisted yet,
        // a custom snapshot (branch creation), or a chat that isn't tree-stored at all.
        if (isTreeChat) {
            const treeResult = await _saveTreeChat(fileName, metadata, trimmedChat, chatName !== undefined);
            if (treeResult) {
                if (typeof treeResult.integrity === 'string') {
                    chat_metadata.integrity = treeResult.integrity;
                }
                _snapshotMessages();
            } else {
                // Nothing persisted to hang operations off. A chat whose opening message has no
                // node_id has never touched the tree, and there is nothing to save yet - the greeting
                // it sits on already exists under the character's anchor, so starting a chat is a
                // selection rather than a write. It stops being a no-op the moment the opening
                // message carries the id of the alternative it is on.
                console.debug('[saveChat] Tree chat has no persisted opening; nothing to save yet.');
            }
            return;
        }

        // Slim wire protocol: unchanged messages become lightweight stubs to minimize wire payload.
        const payloadMessages = isTreeChat ? _buildSlimPayload(trimmedChat) : trimmedChat;

        const bodyJson = JSON.stringify({
            ch_name: getCurrentCharacter().name,
            file_name: fileName,
            chat: [chatHeader, ...payloadMessages],
            avatar_url: getCurrentCharacter().avatar,
            force: force,
        });
        const saveChatRequest = await compressRequest({
            method: 'POST',
            cache: 'no-cache',
            headers: getRequestHeaders(),
            body: bodyJson,
        });
        const result = await fetch('/api/chats/save', saveChatRequest);

        if (result.ok) {
            const data = await result.json().catch(() => null);
            if (data && typeof data.integrity === 'string') {
                chat_metadata.integrity = data.integrity;
            }

            // Write assigned node_ids back into the chat array so subsequent saves
            // can identify these messages as existing (prevents duplicate inserts).
            // Uses updateMessage() since messages may be frozen (immutable). The index
            // from assigned_node_ids maps directly to the chat array position (both are
            // derived from the same 0-based message array). Using the index directly
            // instead of chat.indexOf() avoids stale-reference mismatches when
            // updateMessage() replaced the object between chat.slice() and now.
            if (Array.isArray(data?.assigned_node_ids)) {
                for (const { index, node_id } of data.assigned_node_ids) {
                    if (index < chat.length) {
                        updateMessage(index, { node_id });
                    }
                }

                // Rows came back, so this chat lives in the tree - learn that from the answer rather
                // than from what was known when the chat was opened.
                //
                // A character with no chat history used to be read as not having tree storage at all,
                // so the chat began on a plain card greeting and was marked as not tree-backed. Its
                // very first save put it in the tree anyway, and from that moment the chat IS
                // tree-backed - but nothing said so until the next reload, so for the rest of the
                // session the client kept treating it as a file: every save handed the whole array
                // over (the route our frontend is not supposed to use, and where a save can speak for
                // rows it never received), and the card's greetings were never merged into the opening,
                // so editing one changed nothing on screen.
                chat_metadata._tree_stored = true;
            }

            // Update content snapshots for next save's change detection
            if (isTreeChat) {
                _snapshotMessages();
            }
            return;
        }

        const errorData = await result.json();
        const isIntegrityError = errorData?.error === 'integrity' && !force;
        if (!isIntegrityError) {
            throw new Error(result.statusText);
        }

        const popupResult = await Popup.show.input(
            t`ERROR: Chat integrity check failed while saving the file.`,
            t`<p>After you click OK, the page will be reloaded to prevent data corruption.</p>
              <p>To confirm an overwrite (and potentially <b>LOSE YOUR DATA</b>), enter <code>OVERWRITE</code> (in all caps) in the box below before clicking OK.</p>`,
            '',
            { okButton: 'OK', cancelButton: false },
        );

        const forceSaveConfirmed = popupResult === 'OVERWRITE';

        if (!forceSaveConfirmed) {
            console.warn('Chat integrity check failed, and user did not confirm the overwrite. Reloading the page.');
            // Flush the draft synchronously before reloading - this reload happens on a forced/error path,
            // not through the normal debounced-on-input save, so whatever's sitting unsent in the textarea
            // right now would otherwise be destroyed with no chance for the debounce timer to have fired.
            flushDraftSave();
            window.location.reload();
            return;
        }

        await saveChat({ chatName, withMetadata, mesId, force: true });
    } catch (error) {
        console.error(error);
        toastr.error(t`Check the server connection and reload the page to prevent data loss.`, t`Chat could not be saved`);
    }
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

        await createOrEditCharacter();

        const formData = new FormData(/** @type {HTMLFormElement} */($('#form_create').get(0)));
        const avatarKey = formData.get('avatar_url').toString();

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

/**
 * Cache of thumbnail versions known ahead of a request, keyed by `${type}:${file}`. Populated by the list
 * endpoints that already know a file's cached-thumbnail mtime (character manifest, background list, persona
 * list - see fetchCharactersDelta(), backgrounds.js's getBackgrounds(), personas.js's getUserAvatars()) via
 * setThumbnailVersion(), so getThumbnailUrl() below can emit the thumbnail route's `?v=` on the very first
 * request instead of always taking its no-cache redirect detour (src/endpoints/thumbnails.js).
 *
 * Best-effort only: a missing or stale entry just means that one request rides the redirect once, same as
 * before this cache existed - the thumbnail route's version check is self-correcting regardless.
 * @type {Map<string, string>}
 */
const thumbnailVersionCache = new Map();

/**
 * Records a known thumbnail version for a type+file pair (see thumbnailVersionCache above). No-op if version
 * is null/undefined/empty.
 * @param {import('../src/endpoints/thumbnails.js').ThumbnailType} type The type of the thumbnail
 * @param {string} file The file name or path the version applies to
 * @param {string|number|null|undefined} version The cached thumbnail's version, if known
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
        // loading="lazy" - see the matching comment in getCharacterBlock() above; same request-storm risk
        // applies here (group member/candidate pickers can list the whole library).
        avatarTemplate.find('img').attr('src', this_avatar).attr('loading', 'lazy').attr('alt', entity.item.name);
        avatarTemplate.attr('title', `[Character] ${entity.item.name}\nFile: ${entity.item.avatar}`);
        if (highlightFavs) {
            avatarTemplate.toggleClass('is_fav', entity.item.fav || entity.item.fav == 'true');
            avatarTemplate.find('.ch_fav').val(entity.item.fav);
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
 * Loads all the data of a shallow character.
 * @param {string|undefined} avatar Character avatar filename
 * @returns {Promise<void>} Promise that resolves when the character is unshallowed
 */
export async function unshallowCharacter(avatar) {
    if (avatar === undefined) {
        console.debug('Undefined character cannot be unshallowed');
        return;
    }

    /** @type {Character} */
    const character = charactersStore.get(avatar);
    if (!character) {
        console.debug('Character not found:', avatar);
        return;
    }

    // Character is not shallow
    if (!character.shallow) {
        return;
    }

    await getOneCharacter(avatar);
}

/**
 * Fetches the current character's chat from the server and renders it.
 * @param {object} [options] Additional options.
 * @param {boolean} [options.isNewChat] True when the caller just assigned a freshly-generated chat
 * filename that has never been saved (e.g. doNewChat(), or replaceCurrentChat()'s "start new chat"
 * fallback). Such a filename is *expected* to 404 - it's not a deleted chat being resurrected, it's
 * a chat that doesn't exist yet - so the "resurrection guard" below must not treat it as one.
 */
export async function getChat({ isNewChat = false } = {}) {
    try {
        await unshallowCharacter(getCurrentCharacter()?.avatar);

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
            // This character's persisted "current chat" pointer names a file that's gone from disk -
            // most likely deleted from another tab/session (or from the chat-select modal while this
            // character was loaded elsewhere) after this session last synced. Falling through to the
            // normal empty-chat path below would push a fresh first-message save right back out under
            // that same filename, silently resurrecting the chat the user just deleted. Route through
            // the same "pick another existing chat, or genuinely start a new one" logic delChat() uses
            // when it deletes the active chat itself, instead of reviving the old name.
            console.warn(`Chat file not found for ${getCurrentCharacter()?.chat}, replacing with an existing or new chat`);
            await replaceCurrentChat();
            return;
        }

        if (!response.ok && !(isNewChat && response.status === 404)) {
            throw new Error('Chat could not be loaded');
        }

        // A brand-new, never-yet-saved chat file legitimately 404s (see the isNewChat check above) -
        // treat that the same as the "empty/corrupted chat" case below instead of parsing a 404 body.
        const data = response.ok ? await response.json() : [];
        if (Array.isArray(data) && data.length > 0) {
            /** @type {ChatHeader} */
            const chatHeader = data.shift();
            chat_metadata = chatHeader?.chat_metadata ?? {};
            chat.splice(0, chat.length, ...data);
            chat.forEach(ensureMessageMediaIsArray);
            // Freeze messages loaded from tree DB: immutable values, replaced only via updateMessage()
            if (chat_metadata?._tree_stored) {
                for (let i = 0; i < chat.length; i++) {
                    chat[i] = deepFreeze(chat[i]);
                }
                _snapshotMessages();
                // The card's greetings are not rows until used, so an already-open chat has to be
                // told about them or an edited greeting would never show up.
                await _mergeCardGreetingsIntoOpening();
            }
        } else {
            // An empty/corrupted chat file
            chat.splice(0, chat.length);
            chat_metadata = {};
        }
        if (!chat_metadata.integrity) {
            chat_metadata.integrity = uuidv4();
        }
        await getChatResult();

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

async function getChatResult() {
    name2 = getCurrentCharacter().name;
    let freshChat = false;
    if (chat.length === 0) {
        const message = await getFirstMessage();
        if (message.mes) {
            if (power_user.message_token_count_enabled) {
                message.extra.token_count = await getTokenCountAsync(message.mes, 0);
            }
            chat.push(message);
            freshChat = true;
        }

        // A chat with no stored messages arrives with no header, so getChat() leaves chat_metadata
        // empty and _tree_stored unset. Every save this chat then makes reads as non-tree and takes
        // the whole-array legacy route, which re-sends rows that already exist - including the
        // greeting, which already has one. That is what was tripping the identity constraint on an
        // ordinary chat open, and it happened on every fresh chat, not in some edge case.
        //
        // The opening coming back carrying a node_id is what says this chat lives in the tree:
        // _openingFromTree() returns one whenever the store can be reached, real or provisional.
        if (message?.node_id) {
            chat_metadata._tree_stored = true;
            // The opening arrived from storage (or from the card, unchanged either way), so it is
            // already in step with what the server holds. Saying so is what stops the very first save
            // of a fresh chat from posting an edit that rewrites a row into the content it was just
            // read from.
            _snapshotMessages();
        }

        // Make sure the chat appears on the server
        await saveChatConditional();
    }
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

async function getFirstMessage() {
    const character = getCurrentCharacter();
    const { greetings, defaultIndex } = cardToGreetingsModel(character);
    const regexedGreetings = greetings.map(greeting => getRegexedString(greeting, regex_placement.AI_OUTPUT));
    const swipeId = defaultIndex ?? 0;

    // A tree-backed character's openings already exist as nodes. Starting here means SELECTING one of
    // them and holding its id, not copying a greeting off the card into a brand new message - the
    // copy was a file-era necessity (a file couldn't reference a shared node) and it is why the
    // opening message had no node_id and nothing could be anchored to it.
    // Raw greetings, not the regexed ones: identity is the message as stored, and stored openings hold
    // the card's own text. Regex is a display transform, and sending it makes every existing greeting
    // look new.
    const fromTree = await _openingFromTree(greetings, swipeId);
    if (fromTree) return fromTree;

    const message = {
        name: name2,
        is_user: false,
        is_system: false,
        send_date: getMessageTimeStamp(),
        mes: regexedGreetings[swipeId] ?? '',
        extra: {},
    };

    // Swipes mirror the greeting list in stable order, with swipe_id pointing at the default (or the
    // first greeting when there's no default). Only set when there is more than one to move between;
    // a lone default with no alternates stays a plain, non-swipeable message.
    const hasSwipeableGreetings = regexedGreetings.length > (defaultIndex !== null ? 1 : 0);
    if (hasSwipeableGreetings) {
        message.swipe_id = swipeId;
        message.swipes = regexedGreetings;
        message.swipe_info = regexedGreetings.map(_ => ({
            send_date: message.send_date,
            gen_started: void 0,
            gen_finished: void 0,
            extra: {},
        }));
    }

    return message;
}

/**
 * Builds the opening message from the character's existing opening nodes, so it carries a real
 * node_id from the first moment.
 *
 * Returns null when the character isn't tree-backed, leaving the file-era path to handle it.
 *
 * @param {string[]} cardGreetings the card's greetings, already regexed
 * @param {number} preferredIndex which of them the card considers the default
 */
async function _openingFromTree(cardGreetings, preferredIndex) {
    const character = getCurrentCharacter();
    if (!character?.avatar) return null;

    const post = async (path, body) => {
        const response = await fetch(path, {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ avatar_url: character.avatar, ...body }),
        });
        if (!response.ok) return null;
        return response.json().catch(() => null);
    };

    const sendDate = getMessageTimeStamp();
    // Same reason as above: the speaker is the character on the card, not whatever name2 currently is.
    const speaker = character.name ?? name2;
    const asMessage = text => ({
        name: speaker,
        is_user: false,
        is_system: false,
        send_date: sendDate,
        mes: text,
        extra: {},
    });

    // The card's greetings go along with the read and are merged there. Nothing is copied into the
    // tree: an opening with no node_id is a greeting that lives on the card and has no row yet.
    const contents = (cardGreetings ?? [])
        .filter(text => typeof text === 'string' && text.length > 0)
        .map(asMessage);

    // Only the store being unreachable sends a chat back to the file-era path. It used to also bail on
    // the character having no chat history and on there being no openings yet, and neither of those is
    // a fact about storage. That flag went out as `migrated` back then, which is what made it read
    // like one; it says whether a chat has ever been saved, and a character nobody has chatted with
    // answers no forever, while the save route puts that very character's first chat in the tree
    // regardless.
    //
    // So the chat opened as a file, and only became tree-backed after a save had already gone out the
    // wrong way. There is no such in-between: a greeting with no row is exactly what a provisional id
    // is for, and one earns its row when it is used, same as any other.
    const openings = await post('/api/chats/openings', { card_greetings: contents });
    if (!openings) return null;

    const windowStart = openings.offset ?? 0;
    const preferredText = contents[preferredIndex]?.mes;
    let chosenOffset = openings.alternatives.findIndex(a => a.node_id && a.node_id === openings.default_node_id);
    if (chosenOffset < 0 && preferredText !== undefined) {
        chosenOffset = openings.alternatives.findIndex(a => a.mes === preferredText);
    }
    if (chosenOffset < 0) chosenOffset = 0;

    // A character with nothing stored still has the greetings on its card, and the union is built from
    // both, so the only way there is nothing to open on is the card having no greeting at all - which
    // is the one case the file-era path is still the right answer for.
    const chosen = openings.alternatives[chosenOffset]
        ?? (preferredText !== undefined ? { node_id: null, mes: preferredText, name: speaker, is_user: false, send_date: sendDate, extra: {} } : null);
    if (!chosen) return null;

    // Showing a greeting is not using it, so nothing is written here. A greeting the tree has no row
    // for gets a provisional id instead: stable, content-derived, and enough for everything short of
    // an operation that names a row. ensureOpeningRow() turns it into a real one at the moment
    // something does.
    //
    // Minting here is what this used to do, and it meant simply swiping through a card's greetings
    // wrote a row per greeting seen - on a card with hundreds, hundreds of rows, for a conversation
    // that had not started.
    const chosenNodeId = chosen.node_id ?? provisionalNodeId(chosen.name ?? speaker, chosen.mes);

    const message = {
        // The same speaker the provisional id was derived from. A provisional id is only useful if it
        // can be recomputed from the message, and the speaker is half of what it is computed from.
        name: chosen.name ?? speaker,
        is_user: !!chosen.is_user,
        is_system: false,
        send_date: chosen.send_date ?? sendDate,
        mes: chosen.mes,
        extra: chosen.extra ?? {},
        node_id: chosenNodeId,
    };

    if (openings.total > 1) {
        // Same holed shape a chat load produces. A slot with no node_id is a card-only greeting: its
        // text is known, it simply has no row, and it gains one if selected.
        const swipes = new Array(openings.total).fill(null);
        const swipeInfo = new Array(openings.total).fill(null);
        openings.alternatives.forEach((alt, k) => {
            const at = windowStart + k;
            if (at >= openings.total) return;
            swipes[at] = alt.mes;
            // Every slot carries an id, real or provisional. A card-only slot used to carry none plus
            // a card_only flag, which the save path had to be taught to skip; a provisional id says
            // the same thing without a second field to keep in step.
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
 * Persists a character's active chat pointer as a targeted metadata-only write, instead of rewriting the
 * whole character card (createOrEditCharacter() -> POST /api/characters/edit, or the merge-attributes
 * route) - same idiom as the favorite-status toggle (#favorite_button click handler): a small, dedicated
 * POST that doesn't touch the card file, so it doesn't defeat reflink sharing on its PNG.
 * @param {string} avatar Character avatar to update the chat pointer for
 * @param {string} chat New active chat file name (no .jsonl extension)
 * @returns {Promise<void>}
 */
async function saveActiveChat(avatar, chat) {
    try {
        const response = await fetch('/api/characters/chat', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ avatar, chat }),
        });
        if (!response.ok) throw new Error(String(response.status));
    } catch (error) {
        console.error('Failed to save active chat', error);
        toastr.error(t`Failed to save active chat.`);
    }
}

export async function openCharacterChat(file_name) {
    await waitUntilCondition(() => !isChatSaving, debounce_timeout.extended, 10);
    await clearChat({ clearData: true });
    charactersStore.update(getCurrentCharacter().avatar, { chat: file_name });
    chat_metadata = {};

    // saveActiveChat must run even if getChat fails (rendering errors, tree migration issues,
    // etc.) — otherwise "which chat was open" is lost on reload. The active-chat pointer is
    // the character's own metadata, independent of whether the chat content loaded cleanly.
    try {
        await getChat();
    } finally {
        $('#selected_chat_pole').val(file_name);
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

    main_api = selectedVal;
    setOnlineStatus('no_connection');

    if (main_api == 'koboldhorde') {
        getStatusHorde();
        getHordeModels(true);
    }
    validateDisabledSamplers();
    setupChatCompletionPromptManager(oai_settings);
    forceCharacterEditorTokenize();
}

export function setUserName(value, { toastPersonaNameChange = true } = {}) {
    name1 = value;
    if (name1 === undefined || name1 == '')
        name1 = default_user_name;
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
        // Was previously two hand-written statements (power_user.personas[avatarId] = ...; power_user
        // .persona_descriptions[avatarId] = {...}) that only set `description`/`position`, leaving
        // depth/role/lorebook/title/connections undefined instead of the defaults every other persona-creation
        // path (initPersona()) uses - now goes through the same merged record shape as everywhere else.
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

//MARK: getSettings()
///////////////////////////////////////////
export async function getSettings(initLoaderHandle = null, onStageChange = null) {
    const response = await fetch('/api/settings/get', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({}),
        cache: 'no-cache',
    });

    if (!response.ok) {
        reloadLoop();
        toastr.error(t`Settings could not be loaded after multiple attempts. Please try again later.`);
        throw new Error('Error getting settings');
    }

    const data = await response.json();
    if (data.result != 'file not find' && data.settings) {
        // data.settings is the on-disk settings.json content verbatim - hash it as-received (before parsing) so
        // this matches what the server will hash on the next save. See knownServerSettingsHash's doc comment.
        knownServerSettingsHash = getStringHash(data.settings);
        settings = JSON.parse(data.settings);
        // Seed per-key hashes for partial-save conflict detection.
        for (const key of Object.keys(settings)) {
            serverKeyHashes[key] = getStringHash(JSON.stringify(settings[key], null, 4));
            if (settings[key] != null && typeof settings[key] === 'object' && !Array.isArray(settings[key])) {
                for (const subKey of Object.keys(settings[key])) {
                    serverKeyHashes[`${key}.${subKey}`] = getStringHash(JSON.stringify(settings[key][subKey], null, 4));
                }
            }
        }
        if (settings.username !== undefined && settings.username !== '') {
            name1 = settings.username;
            $('#your_name').text(name1);
        }

        accountStorage.init(settings?.accountStorage);
        await setUserControls(data.enable_accounts);
        setRequestCompressionConfig(data.request_compression);

        // Allow subscribers to mutate settings
        await eventSource.emit(event_types.SETTINGS_LOADED_BEFORE, settings);

        //Load AI model config settings
        amount_gen = settings.amount_gen;
        if (settings.max_context !== undefined)
            max_context = parseInt(settings.max_context);

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

        main_api = settings.main_api;
        $('#main_api').val(main_api);
        $(`#main_api option[value=${main_api}]`).attr('selected', 'true');
        changeMainAPI();

        //Load User's Name and Avatar
        initUserAvatar(settings.user_avatar);
        setPersonaDescription();

        //Load the active character and group
        active_character = settings.active_character;
        active_group = settings.active_group;

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
        }
    }
    await validateDisabledSamplers();

    // Seed the dirty-check baseline from the state we just loaded so the first saveSettings()
    // call doesn't waste a round trip re-writing the exact same payload it just received. If any
    // init code between here and the first save actually mutates a settings variable, the hash
    // will differ and the save will correctly proceed; this only suppresses the no-op case.
    const bootPayload = JSON.stringify({
        firstRun: firstRun,
        accountStorage: accountStorage.getState(),
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

    settingsReady = true;
    await eventSource.emit(event_types.SETTINGS_LOADED);
}

//MARK: saveSettings()
export async function saveSettings(...keys) {
    // Callers that need an immediate (non-debounced) scoped save can pass keys directly:
    // `await saveSettings('extension_settings')` adds the key, cancels any pending debounce
    // (so it won't re-fire with an empty set afterward), and saves immediately.
    if (keys.length > 0) {
        for (const key of keys) {
            if (typeof key === 'string') pendingSettingsKeys.add(key);
        }
        // debounce() returns a plain function and tracks its timer in a WeakMap, so it has no .cancel
        // of its own - calling one threw here every time, before the save it was guarding could run.
        cancelDebounce(_debouncedSaveImpl);
    }
    if (!settingsReady) {
        console.warn('Settings not ready, scheduling another save');
        // eslint-disable-next-line no-restricted-syntax
        saveSettingsDebounced();
        return;
    }

    const MAX_RETRIES = 3;
    if (TempResponseLength.isCustomized()) {
        if (_saveRetryCounter < MAX_RETRIES) {
            console.warn('Response length is currently being overridden, scheduling another save');
            _saveRetryCounter++;
            // eslint-disable-next-line no-restricted-syntax
            saveSettingsDebounced();
            return;
        }
        console.error('Response length is currently being overridden, but the save loop has reached the maximum number of retries');
        TempResponseLength.restore(null);
    }
    _saveRetryCounter = 0;

    // Drain accumulated keys before the async gap - anything added after this point belongs to the next save.
    const dirtyKeys = pendingSettingsKeys.size > 0 ? [...pendingSettingsKeys] : null;
    pendingSettingsKeys.clear();

    const payload = {
        firstRun: firstRun,
        accountStorage: accountStorage.getState(),
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
    if (payloadHash === lastSavedSettingsHash) {
        return;
    }

    if (dirtyKeys) {
        // Partial save path: send only the keys that were explicitly marked dirty.
        const partialPayload = {};
        for (const key of dirtyKeys) {
            if (key.includes('.')) {
                // Dotted path: extract just the addressed sub-field from the payload.
                const topLevel = key.split('.')[0];
                if (topLevel in payload) {
                    // Only when the addressed field actually has a value. JSON.stringify drops an
                    // undefined one, so it would silently vanish from `keys` while still appearing in
                    // expectedHashes below - the client would end up asserting the key is absent on the
                    // server while claiming not to be writing it, and any real value there is a conflict.
                    const value = getAtPath(payload, key);
                    if (value !== undefined) {
                        partialPayload[key] = value;
                    }
                }
            } else if (key in payload && payload[key] !== undefined) {
                // Top-level key: send the whole value. Call sites that want per-field granularity
                // pass a dotted path instead (same pattern as /merge-attributes and /save-partial
                // for quick replies).
                partialPayload[key] = payload[key];
            }
        }

        if (Object.keys(partialPayload).length === 0) {
            return;
        }

        const expectedHashes = {};
        for (const key of Object.keys(partialPayload)) {
            expectedHashes[key] = serverKeyHashes[key] ?? 0;
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
                await getSettings();
                return;
            }

            if (!result.ok) {
                throw new Error(`Failed to save partial settings: ${result.statusText}`);
            }

            // Update per-key hashes for what was just written.
            for (const key of Object.keys(partialPayload)) {
                serverKeyHashes[key] = getStringHash(JSON.stringify(partialPayload[key], null, 4));
            }
            lastSavedSettingsHash = payloadHash;
            // The server returns the whole-file hash so knownServerSettingsHash stays in sync
            // without needing a full copy of the settings content.
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
        const canonicalSettingsString = JSON.stringify(payload, null, 4);

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
                await getSettings();
                return;
            }

            if (!result.ok) {
                throw new Error(`Failed to save settings: ${result.statusText}`);
            }

            // Update per-key hashes from the full payload.
            for (const key of Object.keys(payload)) {
                serverKeyHashes[key] = getStringHash(JSON.stringify(payload[key], null, 4));
                if (payload[key] != null && typeof payload[key] === 'object' && !Array.isArray(payload[key])) {
                    for (const subKey of Object.keys(payload[key])) {
                        serverKeyHashes[`${key}.${subKey}`] = getStringHash(JSON.stringify(payload[key][subKey], null, 4));
                    }
                }
            }
            lastSavedSettingsHash = payloadHash;
            knownServerSettingsHash = getStringHash(canonicalSettingsString);
            await eventSource.emit(event_types.SETTINGS_UPDATED);
        } catch (error) {
            console.error('Error saving settings:', error);
            toastr.error(t`Check the server connection and reload the page to prevent data loss.`, t`Settings could not be saved`);
        }
    }
}

//MARK: savePartialSettings()
/**
 * Sends only the given top-level settings keys to be merged into the server's settings.json (read-modify-write)
 * instead of the full ~148KB blob saveSettings() sends every time. New, additive capability -
 * saveSettings()/saveSettingsDebounced() are unchanged and remain the path virtually every call site uses;
 * nothing is required to migrate to this. No existing call site currently does: saveSettings() rebuilds its
 * whole payload from scratch on every call (see its own doc comment) and doesn't track which key(s) it actually
 * touched, so wiring any of the 679 saveSettingsDebounced() call sites to use this would need each one to start
 * tracking that itself - a separate, larger piece of work than this function's existence, and not done here.
 *
 * Conflict check is per-key (via serverKeyHashes), not saveSettings()'s whole-file
 * knownServerSettingsHash: hashes only the keys actually being sent, looked up from serverKeyHashes
 * (seeded at getSettings() time and updated after each successful save).
 * This means two concurrent partial updates to genuinely disjoint keys can both succeed server-side;
 * only a real overlap on the same key(s) gets rejected - deliberately different from (and better-fitting than)
 * full saves' single whole-file hash, which would reject on any concurrent change regardless of overlap.
 * @param {Record<string, unknown>} partialSettings Top-level settings keys to merge; only these keys change.
 * @returns {Promise<boolean>} True if the update was applied, false if it was rejected due to a conflict.
 */
export async function savePartialSettings(partialSettings) {
    // Same reason as saveSettings()'s dotted-key handling: a key whose value is undefined is dropped
    // by JSON.stringify, so asserting a hash for it claims something about a key this request is not
    // sending.
    const keys = Object.keys(partialSettings).filter(key => partialSettings[key] !== undefined);
    if (!keys.length) return true;
    const expectedHashes = {};
    for (const key of keys) {
        expectedHashes[key] = serverKeyHashes[key] ?? 0;
    }

    const result = await fetch('/api/settings/save-partial', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ keys: partialSettings, expectedHashes }),
        cache: 'no-cache',
    });

    if (result.status === 409) {
        const data = await result.json().catch(() => ({}));
        // Same reasoning as saveSettings()'s 409 handling: don't retry with the same (now-stale) keys, and don't
        // try to auto-reapply anything on top of a refreshed baseline - both risk re-clobbering the other
        // session's write in a subtler way. Refetch and let the caller/user redo the change instead.
        console.warn('Partial settings save rejected, conflicting keys:', data.conflictingKeys);
        toastr.warning(t`Settings were changed in another tab or device. Refreshing - please reapply your change.`, t`Settings save rejected`);
        await getSettings();
        return false;
    }

    if (!result.ok) {
        throw new Error(`Failed to save partial settings: ${result.statusText}`);
    }

    for (const key of Object.keys(partialSettings)) {
        serverKeyHashes[key] = getStringHash(JSON.stringify(partialSettings[key], null, 4));
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
        amount_gen = preset.genamt;
        $('#amount_gen').val(amount_gen);
        $('#amount_gen_counter').val(amount_gen);
    }

    if (preset.max_length !== undefined) {
        max_context = preset.max_length;
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
    saveChatDebounced();
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
    // Overswiping opens a blank slot for something to be typed into. Cancelling means nothing was, so
    // the slot goes away again rather than being left behind as an empty alternative to swipe past.
    // Only the trailing blank is removed, and only when it has no row - anything stored stays.
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

    // Swap chat array entries.
    [chat[sourceId], chat[targetId]] = [chat[targetId], chat[sourceId]];

    // Update edited message id
    if (this_edit_mes_id === sourceId) {
        this_edit_mes_id = targetId;
    }

    swapItemizedPrompts(sourceId, targetId);
    updateViewMessageIds();
    refreshSwipeButtons();
    await saveChatConditional();
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
    this_edit_mes_id = undefined;
    await saveChatConditional();
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
 * @param {null|string} [characterAvatar=null] - When set, the function will use this character avatar instead of this_avatar.
 *
 * @returns {Promise<Array>} - An array containing metadata of all past chats of the character, sorted
 * in descending order by file name. Returns an empty array if the fetch request is unsuccessful or the
 * response is an object with an `error` property set to `true`.
 */
export async function getPastCharacterChats(characterAvatar = null) {
    characterAvatar = characterAvatar ?? this_avatar;
    if (!charactersStore.get(characterAvatar)) return [];

    const response = await fetch('/api/characters/chats', {
        method: 'POST',
        body: JSON.stringify({ avatar_url: characterAvatar }),
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
        $('#select_chat_div').empty();

        filteredData.sort((a, b) => sortMoments(timestampToMoment(a.last_mes), timestampToMoment(b.last_mes)));

        for (const chat of filteredData) {
            // Opening one uses the node it sits on. A name only ever resolved to a position by
            // lookup, and not uniquely, so the id is the thing that actually identifies it. The name
            // stays for display and for the file-backed path, which has no nodes.
            const isSelected = currentChat === chat.file_name || (!!chat.node_id && currentChat === chat.node_id);
            const template = $('#past_chat_template .select_chat_block_wrapper').clone();
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

            $('#select_chat_div').append(template);

            if (Array.isArray(highlightNames) && highlightNames.includes(chat.file_name)) {
                const templateOffset = template.offset().top - template.parent().offset().top;
                $('#select_chat_div').scrollTop(templateOffset);
                flashHighlight(template, debounce_timeout.extended);
            }
        }
    } catch (error) {
        console.error('Error loading chats:', error);
        toastr.error('Could not load chat data. Try reloading the page.');
    }
}

// #right-nav-panel and #char-info-panel are both .fillRight - pinning lets one stay open while the other
// opens alongside it, and with panel translucency enabled two overlapping .fillRight panels would blend into
// an unreadable mess. Only one is ever visually "front" at a time; the other stays logically open (state,
// scroll position, DOM all preserved) but is hidden via the .frontFillRight CSS rule in toggle-dependent.css.
function activateFillRightDrawer(contentId) {
    document.querySelectorAll('.fillRight').forEach(el => el.classList.remove('frontFillRight'));
    document.getElementById(contentId)?.classList.add('frontFillRight');
    accountStorage.setItem('FillRightFront', contentId);
}

function ensureDrawerOpen(drawerId) {
    const drawer = document.getElementById(drawerId);
    if (!drawer) return;
    const content = drawer.querySelector('.drawer-content');
    const icon = drawer.querySelector('.drawer-icon');
    if (content && !content.classList.contains('openDrawer')) {
        // #right-nav-panel and #char-info-panel (both .fillRight) are meant to coexist - opening one
        // shouldn't close the other, pinned or not, since .frontFillRight/.fillRightIcon already keep only
        // one of them visually in front. Opening any other (non-fillRight) drawer still closes both, as before.
        const isFillRight = content.classList.contains('fillRight');
        document.querySelectorAll('.openDrawer:not(.pinnedOpen)').forEach(el => {
            if (isFillRight && el.classList.contains('fillRight')) return;
            el.classList.replace('openDrawer', 'closedDrawer');
        });
        document.querySelectorAll('.openIcon:not(.drawerPinnedOpen)').forEach(el => {
            if (isFillRight && el.classList.contains('fillRightIcon')) return;
            el.classList.replace('openIcon', 'closedIcon');
        });
        content.classList.replace('closedDrawer', 'openDrawer');
        if (icon) icon.classList.replace('closedIcon', 'openIcon');
    }
    if (content && content.classList.contains('fillRight')) {
        activateFillRightDrawer(content.id);
    }
}

/**
 * Switches which #right-nav-panel menu is visible. Only one is ever shown at once - with panel
 * translucency enabled, two overlapping menus would blend into an unreadable mess - but hiding a menu
 * here does not close it: menus other than the one becoming visible keep whatever logical "open" state
 * right-menu-state.js has for them (and keep their DOM state too, since display:none doesn't destroy
 * elements). Only closeRightMenu() actually closes one, for the rarer case where its underlying data
 * stopped being valid.
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
    // Find which panel contains the target menu and only hide/show menus within THAT panel.
    // Now that character-list and character-info live in separate drawers, switching to a menu in
    // one panel must not touch the other panel's menus (that was hiding #rm_characters_block when
    // the user opened a character for editing, then leaving it hidden when they came back).
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
    // #right-nav-panel only has one real menu (rm_characters_block) - it never needs hiding.
    // Only #char-info-panel has multiple menus (rm_ch_create_block, rm_group_chats_block) that
    // need the hide-all-then-show-one dance. For right-nav-panel, just ensure it's visible.
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
}

export function select_rm_info(type, charId, previousCharId = null, displayName = null) {
    if (!type) {
        toastr.error(t`Invalid process (no 'type')`);
        return;
    }
    // charId is the avatar file name, needed below to locate/scroll to the character in the list - it's not a
    // friendly display value (especially now that file names are moving to uuidv7). Callers that know the
    // character's actual name should pass it separately via displayName; this only falls back to deriving one
    // from charId for callers that don't.
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
            const charData = await getEntitiesList({ doFilter: true });
            const charIndex = charData.findIndex((x) => x?.item?.avatar?.startsWith(avatarFileName));

            if (charIndex === -1) {
                console.log(`Could not find character ${charId} in the list`);
                return;
            }

            try {
                const perPage = Number(accountStorage.getItem('Characters_PerPage')) || per_page_default;
                const page = Math.floor(charIndex / perPage) + 1;
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
            // Find the page at which the character is located
            const charData = await getEntitiesList({ doFilter: true });
            const charIndex = charData.findIndex((x) => String(x?.item?.id) === String(charId));

            if (charIndex === -1) {
                console.log(`Could not find group ${charId} in the list`);
                return;
            }

            const perPage = Number(accountStorage.getItem('Characters_PerPage')) || per_page_default;
            const page = Math.floor(charIndex / perPage) + 1;
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
 * @param {string} avatar Character avatar filename
 * @param {object} [param1] Options for the switch
 * @param {boolean} [param1.switchMenu=true] Whether to switch the menu
 */
export function select_selected_character(avatar, { switchMenu = true } = {}) {
    //character select
    const character = charactersStore.get(avatar);
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

    $('#character_popup-button-h3').text(character.name);
    $('#character_name_pole').val(character.name);
    $('#description_textarea').val(character.description);
    $('#character_world').val(character.data?.extensions?.world || '');
    $('#creator_notes_textarea').val(character.data?.creator_notes || character.creatorcomment);
    $('#creator_notes_spoiler').html(formatCreatorNotes(character.data?.creator_notes || character.creatorcomment, character.avatar));
    $('#character_version_textarea').val(character.data?.character_version || '');
    $('#system_prompt_textarea').val(character.data?.system_prompt || '');
    $('#post_history_instructions_textarea').val(character.data?.post_history_instructions || '');
    $('#tags_textarea').val(Array.isArray(character.data?.tags) ? character.data.tags.join(', ') : '');
    $('#creator_textarea').val(character.data?.creator);
    $('#character_version_textarea').val(character.data?.character_version || '');
    $('#personality_textarea').val(character.personality);
    const greetingModel = cardToGreetingsModel(character);
    setGreetingPagerGreetings(greetingModel.greetings, greetingModel.defaultIndex, greetingModel.greetings.map(hashGreetingText));
    $('#scenario_pole').val(character.scenario);
    $('#depth_prompt_prompt').val(character.data?.extensions?.depth_prompt?.prompt ?? '');
    $('#depth_prompt_depth').val(character.data?.extensions?.depth_prompt?.depth ?? depth_prompt_depth_default);
    $('#depth_prompt_role').val(character.data?.extensions?.depth_prompt?.role ?? depth_prompt_role_default);
    $('#talkativeness_slider').val(character.talkativeness || talkativeness_default);
    $('#mes_example_textarea').val(character.mes_example);
    $('#selected_chat_pole').val(character.chat);
    $('#create_date_pole').val(timestampToMoment(character.create_date).toISOString());
    $('#avatar_url_pole').val(character.avatar);
    $('#chat_import_avatar_url').val(character.avatar);
    $('#chat_import_character_name').val(character.name);
    $('#character_json_data').val(character.json_data);

    updateFavButtonState(character.fav || character.fav == 'true');

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

    // Capture form snapshot for no-op detection in createOrEditCharacter() - must be
    // after all .val() population above so it reflects the actual loaded state.
    _characterFormSnapshot = {};
    for (const id of CHARACTER_FORM_FIELDS) {
        _characterFormSnapshot[id] = String($(id).val() ?? '');
    }
    $('.form_create_bottom_buttons_block .chat_lorebook_button').show();

    const externalMediaState = isExternalMediaAllowed();
    $('#character_open_media_overrides').toggle(!selected_group);
    $('#character_media_allowed_icon').toggle(externalMediaState);
    $('#character_media_forbidden_icon').toggle(!externalMediaState);

    // Update some stuff about the char management dropdown
    $('#character_source').attr('disabled', !getCharacterSource(character) ? '' : null);

    // CHARACTER_EDITOR_OPENED is public extension API surface and documents its payload as a chid
    // (array index), so keep emitting that even though this function is avatar-driven internally.
    const editedEntity = charactersStore.get(avatar);
    const chid = editedEntity ? characters.indexOf(editedEntity) : -1;
    eventSource.emit(event_types.CHARACTER_EDITOR_OPENED, chid);

    // This function only populates DOM fields from already-persisted character data and reads/toggles UI
    // state - it never mutates active_character or anything else the settings payload includes, so there's
    // nothing here that needs saving. It runs both when switching to a different character (where the
    // .character_select click handler in RossAscends-mods.js already calls saveSettingsDebounced() after
    // setActiveCharacter()) and, via the "already selected" branch of selectCharacterByAvatar(), on a plain
    // re-click of the character that's already open - which used to unconditionally queue a settings save on
    // every such re-open with nothing new to persist.
}

/**
 * Selects the right menu for creating a new character.
 * @param {object} [options] Options for the switch
 * @param {boolean} [options.switchMenu=true] Whether to switch the menu
 */
function select_rm_create({ switchMenu = true } = {}) {
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
    $('#character_popup-button-h3').text('Create character');
    $('#character_name_pole').val(create_save.name);
    $('#description_textarea').val(create_save.description);
    $('#character_world').val(create_save.world);
    $('#creator_notes_textarea').val(create_save.creator_notes);
    $('#creator_notes_spoiler').html(formatCreatorNotes(create_save.creator_notes, ''));
    $('#post_history_instructions_textarea').val(create_save.post_history_instructions);
    $('#system_prompt_textarea').val(create_save.system_prompt);
    $('#tags_textarea').val(create_save.tags);
    $('#creator_textarea').val(create_save.creator);
    $('#character_version_textarea').val(create_save.character_version);
    $('#personality_textarea').val(create_save.personality);
    const greetingModel = cardToGreetingsModel({ first_mes: create_save.first_message, data: { alternate_greetings: create_save.alternate_greetings, extensions: create_save.extensions } });
    setGreetingPagerGreetings(greetingModel.greetings, greetingModel.defaultIndex, greetingModel.greetings.map(hashGreetingText));
    $('#talkativeness_slider').val(create_save.talkativeness);
    $('#scenario_pole').val(create_save.scenario);
    $('#depth_prompt_prompt').val(create_save.depth_prompt_prompt);
    $('#depth_prompt_depth').val(create_save.depth_prompt_depth);
    $('#depth_prompt_role').val(create_save.depth_prompt_role);
    $('#mes_example_textarea').val(create_save.mes_example);
    $('#character_json_data').val('');
    $('#avatar_div').css('display', 'flex');
    $('#avatar_load_preview').attr('src', default_avatar);
    $('#renameCharButton').css('display', 'none');
    $('#name_div').removeClass('displayNone');
    $('#name_div').addClass('displayBlock');
    $('.open_alternate_greetings').data('avatar', null);
    $('#set_character_world').data('avatar', null);
    setWorldInfoButtonClass(undefined, !!create_save.world);
    updateFavButtonState(false);
    checkEmbeddedWorld();

    $('#form_create').attr('actiontype', 'createcharacter');
    _characterFormSnapshot = null; // No snapshot in create mode
    $('.form_create_bottom_buttons_block .chat_lorebook_button').hide();
    $('#character_open_media_overrides').hide();
}

function select_rm_characters() {
    const doFullRefresh = menu_type === 'characters';
    setMenuType('characters');
    selectRightMenuWithAnimation('rm_characters_block');
    if (_charactersDirty) {
        _charactersDirty = false;
        getCharacters();
    } else {
        printCharacters(doFullRefresh);
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
    chat_metadata = reset ? { ...newValues } : { ...chat_metadata, ...newValues };
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

        //Any message can be swiped, not just the last one: every message on the loaded path carries
        //its own sibling set now, so navigating between an earlier message's alternatives is just
        //moving along that message's own fork. Whether an overswipe past the end GENERATES is a
        //separate question, and that stays last-message-only - see getOverswipeBehavior().
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

    // Every branch below is a property of the MESSAGE, not of where it sits. A position check used to
    // sit in here forcing LOOP for anything but the last message, which overrode all of it: an earlier
    // message could neither generate a new alternative nor, having only one, navigate to anything. So
    // most of a conversation had arrows that did nothing.
    //
    // It was added out of a worry that generating mid-conversation would disturb what follows. In a
    // tree it does not - generating makes a new sibling, and the old one keeps its continuation. That
    // is a fork, which is the point.

    const isGreeting = messageId === 0;

    //Do not override explicitly set overswipe_behavior.
    if (typeof message?.extra?.overswipe_behavior == 'string') return message.extra.overswipe_behavior;
    //Some messages, like the welcome screen, are not swipeable.
    else if (message?.extra?.swipeable === false) return OVERSWIPE_BEHAVIOR.NONE;
    //Small System messages can't be swiped.
    else if (message?.extra?.isSmallSys) return OVERSWIPE_BEHAVIOR.NONE;
    //Greetings are card data the user authors, never something the LLM produces, so overswiping one must never
    //start a generation. It appends an empty greeting slot and opens the editor instead (EDIT_GENERATE does not
    //generate despite its name - see its branch in swipe()). This deliberately covers tainted chats too: the
    //pristine-only check this replaces let a greeting that was the only message in a tainted chat fall through
    //to REGENERATE below and call the LLM. Supersedes the pristine-loop behaviour from
    //https://github.com/SillyTavern/SillyTavern/pull/4712#issuecomment-3557893373
    else if (isGreeting) return OVERSWIPE_BEHAVIOR.EDIT_GENERATE;
    //Non-user and non-prompt hidden messages will regenerate - but only the last one, because that is
    //the only one a generation can currently be aimed at. Generate('swipe') is not told which message
    //it is regenerating; getNextMessageId('swipe') answers that with chat.length - 1, flatly. So
    //overswiping an EARLIER response ran a generation that landed on the last message instead,
    //overwriting the alternative it was showing, while the message actually overswiped got nothing.
    //
    //Nothing above this line prevented that; what did was a bug elsewhere that stopped the branch
    //being reached at all for earlier messages, and fixing that exposed this. Until a generation can
    //be aimed at a message, an earlier one loops rather than firing at the wrong target.
    else if (!message?.is_user && !message?.is_system) {
        return messageId === chat.length - 1 ? OVERSWIPE_BEHAVIOR.REGENERATE : OVERSWIPE_BEHAVIOR.LOOP;
    }
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

            //If there's only one swipe, the left arrow should not be shown - except where an overswipe is
            //meaningful on its own. Greetings now always resolve to EDIT_GENERATE (see getOverswipeBehavior),
            //so a card with a single greeting still needs its chevrons to add a second one. This replaces the
            //narrower pristine-greeting check that used to keep them visible:
            //https://github.com/SillyTavern/SillyTavern/pull/4712#issuecomment-3557893373
            div.classList.toggle('swipes_visible', hasSwipes || isOverswipeable);
            swipePickerButton.toggle(canOpenSwipePicker);

            //updateSwipeCounter does not need to be awaited, It can run a bit later.
            if (updateCounters) updateSwipeCounter(messageId, { message, messageElement: $(div) });
        } else {
            //Hide all messages that are not swipeable.
            div.classList.remove('swipes_visible', 'last_swipe');
            $(div).find('.mes_swipe_picker').toggle(canOpenSwipePickerForMessage(messageId));
        }

        // Branch navigation: mark messages that have fork siblings
        if (typeof _hasForkBranches === 'function') {
            div.classList.toggle('has_branches', _hasForkBranches(messageId, message));
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
    updateMessage(messageId, { swipe_id: newSwipeId, swipes: newSwipes, swipe_info: newSwipeInfo });
    await eventSource.emit(event_types.MESSAGE_SWIPE_DELETED, { messageId, swipeId, newSwipeId });

    if (swipeId === currentSwipeId) {
        const direction = (swipeId <= newSwipeId) ? SWIPE_DIRECTION.RIGHT : SWIPE_DIRECTION.LEFT;
        // Animate swipe and swap displayed message when the currently visible swipe was deleted.
        await swipe(null, direction, { source: SWIPE_SOURCE.DELETE, repeated: false, forceMesId: messageId, forceSwipeId: newSwipeId });
    } else {
        await updateSwipeCounter(messageId);
        if (messageId !== chat.length - 1) {
            await updateSwipeCounter(chat.length - 1);
        }
        refreshSwipeButtons();
        saveChatDebounced();
    }

    await saveChatConditional();

    return newSwipeId;
}

export async function saveMetadata() {
    return await saveChatConditional();
}

export async function saveChatConditional() {
    try {
        await waitUntilCondition(() => !isChatSaving, DEFAULT_SAVE_EDIT_TIMEOUT, 100);
    } catch {
        console.warn('Timeout waiting for chat to save');
        return;
    }

    try {
        cancelDebouncedChatSave();

        isChatSaving = true;

        if (selected_group) {
            await saveGroupChat(selected_group, true);
        } else {
            await saveChat();
        }

        // Save token and prompts cache to IndexedDB storage
        saveTokenCache();
        saveItemizedPrompts(getCurrentChatId());
    } catch (error) {
        console.error('Error saving chat', error);
    } finally {
        isChatSaving = false;
    }
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

    // Explicit undefined when `avatar` doesn't resolve to a real character (including when it's undefined
    // itself, e.g. menu_type === 'create' with no character bound yet) - distinct from getCharaFilename()'s
    // own "no avatar given" fallback to the currently selected character, which isn't what's wanted here.
    // TODO: Maybe make this utility function not use the window context?
    const fileName = worldCharacter ? getCharaFilename(avatar) : undefined;
    const charName = (menu_type == 'create' ? create_save.name : worldCharacter?.data?.name) || 'Nameless';
    const worldId = (menu_type == 'create' ? create_save.world : worldCharacter?.data?.extensions?.world) || '';
    const template = $('#character_world_template .character_world').clone();
    template.find('.character_name').text(charName);

    // --- Event Handlers ---
    async function handlePrimaryWorldSelect() {
        const selectedValue = $(this).val();
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

/**
 * Card <-> stable-order-greetings model, the single source of truth for splitting a character's
 * greetings between `first_mes` (the current default, or '' when there is no default) and
 * `alternate_greetings` (everything else, in stable order) and back. The card format itself can
 * only express "which greeting is default" as leading position in the array, which conflates that
 * with "where it sits in the list" - picking a new default would otherwise permanently reorder the
 * list. `data.extensions.${GREETING_DEFAULT_POSITION_KEY}` records where in the stable order the
 * default came from, so re-reading the card can restore it without ever touching the order. Every
 * site that edits greetings (the sidebar pager, the Alt. Greetings popup, character load/create-mode
 * fill, the full character save) goes through cardToGreetingsModel()/greetingsModelToCardFields()
 * rather than doing its own index arithmetic.
 */
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
function cardToGreetingsModel(card) {
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

    // No usable recorded position (missing, out of range, or a card written/edited by something that
    // doesn't know about it) - fall back to the pre-existing behavior: the default leads the list.
    return { greetings: [firstMes, ...altGreetings], defaultIndex: 0 };
}

/**
 * Inverse of {@link cardToGreetingsModel}. Callers still run the result's `alternateGreetings`
 * through stripEmptyAlternateGreetings() themselves (with their own context label) before writing,
 * same as every other write path.
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
 * Where a tracked index (the default's position) ends up after removing one element at
 * `removedIndex` from the same array. Removing the default itself clears it (returns null) rather
 * than guessing which neighbor should inherit default status.
 * @param {number|null} defaultIndex
 * @param {number} removedIndex
 */
function reindexDefaultAfterRemoval(defaultIndex, removedIndex) {
    if (defaultIndex === null) return null;
    if (removedIndex === defaultIndex) return null;
    return removedIndex < defaultIndex ? defaultIndex - 1 : defaultIndex;
}

/**
 * Where a tracked index (the default's position) ends up after a pick-and-place move: one element
 * removed from `sourceIndex`, then reinserted at `finalTargetIndex` (already adjusted for the
 * removal, i.e. the exact position passed to the reinserting splice).
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
 * Same hashing convention src/greeting-ops.js's hashGreetingText() uses server-side - `getStringHash()`
 * of the value's JSON. Only ever used to seed the *initial* per-position hash list right after a fresh
 * load from the server (the text just came from disk, so hashing it here is hashing the truth). Every
 * hash after that comes verbatim from a greeting-op response's `hashes` array - never recomputed from
 * whatever the client currently has typed, which would make every precondition trivially match itself
 * and silently defeat the mechanism (see src/greeting-ops.js's doc comment - this trap already got hit
 * once in this codebase).
 * @param {string} text
 * @returns {number}
 */
function hashGreetingText(text) {
    return getStringHash(JSON.stringify(text));
}

/**
 * Posts one named greeting-list operation - see src/greeting-ops.js and the six
 * `/api/characters/greetings/*` routes in src/endpoints/characters.js. `opName` is the path segment
 * after `/greetings/` (e.g. `'add'`, `'default/set'`). Resolves to a result object rather than
 * throwing for a refused op (409) or any other non-2xx response; only a network-level failure counts
 * as an exception, and even that is caught and folded into the same shape.
 * @param {string} opName
 * @param {object} body
 * @returns {Promise<{ok: true, hashes: number[], defaultPosition: number|null}|{ok: false, status?: number, reason?: string}>}
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
            return { ok: true, hashes: payload.hashes, defaultPosition: payload.default_position };
        }
        return { ok: false, status: response.status, reason: payload?.reason };
    } catch (error) {
        console.error(`Greeting op "${opName}" request failed`, error);
        return { ok: false, reason: 'network error' };
    }
}

/**
 * Writes a GreetingsModel onto an in-memory character object's first_mes/alternate_greetings/
 * extensions fields (mirrors src/greeting-list.js's applyGreetingsModelToCard() server-side) after a
 * greeting op the client already knows the resulting text for - text is always client-authored, only
 * positions/hashes are server-derived, so this is safe to call with the client's own array. Also
 * refreshes the digest caches other UI (list re-render diffing) reads off the character object.
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
 * Lands a successful greeting op's result everywhere it needs to: the in-memory character object (so
 * other UI - chat greeting selection, digest hashes - sees the new text) and the sidebar pager, whose
 * `hashes` is the one place per-position precondition hashes live (the Alt. Greetings popup reads
 * them from there too on its next open). `greetings`/`defaultIndex` are the caller's own already-known
 * post-op model; `hashes` must be the op response's `hashes`, never recomputed locally.
 * @param {object} character
 * @param {string[]} greetings
 * @param {number|null} defaultIndex
 * @param {number[]} hashes
 */
async function applyGreetingOpSuccess(character, greetings, defaultIndex, hashes) {
    applyGreetingsModelToCharacter(character, { greetings, defaultIndex });
    setGreetingPagerGreetings(greetings, defaultIndex, hashes);
    await eventSource.emit(event_types.CHARACTER_EDITED, { detail: { character: character } });
}

/**
 * In-memory state for the sidebar greeting pager (`< [M]/N >` next to the "First message" field).
 * `greetings` is the stable-order list (see GreetingsModel above), `defaultIndex` mirrors the card's
 * current default, `hashes` is the post-op per-position precondition hash list (see
 * hashGreetingText()'s doc comment - only ever seeded from a fresh load or a server response), and
 * `index` is which slot the pager is currently showing.
 */
const greetingPagerState = {
    greetings: [''],
    defaultIndex: 0,
    hashes: [],
    index: 0,
};

/**
 * Replaces the pager's greetings list, default pointer, and precondition hashes (e.g. on character
 * load, create-mode fill, or after a greeting op succeeds) and clamps the current index in case the
 * list shrank.
 * @param {string[]} greetings Stable-order greeting list.
 * @param {number|null} defaultIndex
 * @param {number[]} hashes Position-aligned with `greetings`.
 */
function setGreetingPagerGreetings(greetings, defaultIndex, hashes) {
    greetingPagerState.greetings = greetings.length > 0 ? greetings.slice() : [''];
    greetingPagerState.defaultIndex = greetings.length > 0 ? defaultIndex : 0;
    greetingPagerState.hashes = greetings.length > 0 ? hashes.slice() : [];
    greetingPagerState.index = Math.max(0, Math.min(greetingPagerState.index, greetingPagerState.greetings.length - 1));
    renderGreetingPager();
}

/** Redraws the pager controls and the visible greeting field from the current pager state. */
function renderGreetingPager() {
    const { greetings, index } = greetingPagerState;
    $('#greeting_field').val(greetings[index] ?? '');
    $('.greeting-pager-input').val(index + 1);
    $('.greeting-pager-total').text(`/${greetings.length}`);
    $('.greeting-pager-prev').toggleClass('disabled', index === 0);
    $('.greeting-pager-next').toggleClass('disabled', index === greetings.length - 1);
    // .val() above doesn't fire a native input event, so the token counter needs an explicit nudge.
    RA_CountCharTokens();
}

/**
 * Steps the pager to a (clamped) index, first committing whatever is currently in the visible
 * field back into the greetings array so it isn't lost.
 * @param {number} newIndex
 */
function navigateGreetingPager(newIndex) {
    const { greetings, index } = greetingPagerState;
    greetings[index] = String($('#greeting_field').val());
    greetingPagerState.index = Math.max(0, Math.min(newIndex, greetings.length - 1));
    renderGreetingPager();
}

/**
 * One debounce instance per pager slot (lazily created, kept for the page's lifetime) - a single
 * shared debounce would let switching slots mid-type (type in slot A, page to slot B before A's timer
 * fires, type in B) cancel slot A's still-pending call outright, silently losing that edit instead of
 * ever sending it as its own op. Keyed by position; a position that later shifts under an add/delete/
 * move just leaves a stale, harmless, never-refired entry - nothing keyed to it fires again.
 * @type {Map<number, (position: number, text: string) => void>}
 */
const greetingPagerEditDebouncers = new Map();

/**
 * Debounced per-position save for the sidebar pager (`< [M]/N >`). Every slot, default included,
 * saves through the same named `edit` operation (src/greeting-ops.js's opEdit()) - there is no more
 * first_mes-specific save path, #firstmessage_textarea is gone.
 * @param {number} position
 * @param {string} text
 */
function saveGreetingPagerEditDebounced(position, text) {
    if (!greetingPagerEditDebouncers.has(position)) {
        greetingPagerEditDebouncers.set(position, debounce(async (pos, txt) => {
            const avatar = $('.open_alternate_greetings').data('avatar');
            const character = avatar ? charactersStore.get(avatar) : null;
            if (!character) return;
            const expectedHash = greetingPagerState.hashes[pos];
            if (!Number.isFinite(expectedHash)) return; // Position out of range of what the server last confirmed.

            const result = await postGreetingOp('edit', { avatar_url: avatar, position: pos, expected_hash: expectedHash, text: txt });
            if (result.ok) {
                await applyGreetingOpSuccess(character, greetingPagerState.greetings.slice(), result.defaultPosition, result.hashes);
                return;
            }
            console.error('Greeting save failed', { avatar, position: pos, status: result.status, reason: result.reason });
            if (result.status === 409) {
                toastr.error(t`This character was changed in another session, so this greeting change was not saved. Reopen the character to see the current version.`, t`Greeting not saved`);
                return;
            }
            toastr.error(t`Failed to save the greeting. Your edit is still shown here, but it was not saved.`, t`Greeting not saved`);
        }, DEFAULT_SAVE_EDIT_TIMEOUT));
    }
    greetingPagerEditDebouncers.get(position)(position, text);
}

/**
 * Final safety net for the "no empty string ever lands in alternate_greetings" invariant. The
 * primary defense is that a greeting row never becomes a real array entry while it's blank (see the
 * `pending`/`committed` handling in addAlternateGreeting) - this just catches anything that slips
 * through regardless, and says so loudly, because at that point some path put an empty in that
 * shouldn't have been able to.
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
    const avatar = $('.open_alternate_greetings').data('avatar');
    // Every use below is a read/mutation of this same character's own fields, never a positional array
    // operation, so the resolved entity itself is all that's needed - no index required.
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

    // Live working copy for this popup instance, read for display and for the pre-op values row
    // handlers need (current text, current default). It's only ever mutated after a row handler's own
    // server op is confirmed (see addAlternateGreeting()) - create mode is the one exception, where
    // there's no server side yet to confirm against, so its handlers mutate this directly, same as
    // before. Nothing here accumulates a diff to flush on close any more for real characters; every
    // mutation is its own named operation (src/greeting-ops.js), fired the moment the user makes it.
    const model = { greetings: initialModel.greetings.slice(), defaultIndex: initialModel.defaultIndex };

    const getArray = () => model.greetings;

    const template = $('#alternate_greetings_template .alternate_grettings').clone();

    /**
     * Create-mode-only: syncs the working model back to create_save's first_message/
     * alternate_greetings/extensions and rebuilds the pager. Real characters never call this - every
     * row handler below already lands its own op's result via applyGreetingOpSuccess() the moment it's
     * confirmed, so there's nothing left to flush at close.
     */
    function syncCreateModeFromUnified() {
        const fields = greetingsModelToCardFields(model);
        const newAltGreetings = stripEmptyAlternateGreetings(fields.alternateGreetings, 'alt greetings popup (create mode)');
        create_save.first_message = fields.firstMes;
        create_save.alternate_greetings = newAltGreetings;
        if (!create_save.extensions) create_save.extensions = {};
        create_save.extensions[GREETING_DEFAULT_POSITION_KEY] = fields.greetingDefaultPosition;
        setGreetingPagerGreetings(model.greetings, model.defaultIndex, model.greetings.map(hashGreetingText));
    }

    const popup = new Popup(template, POPUP_TYPE.TEXT, '', {
        wide: true,
        large: true,
        allowVerticalScrolling: true,
        onClose: async () => {
            if (menu_type === 'create') {
                syncCreateModeFromUnified();
            }
        },
    });

    for (let index = 0; index < model.greetings.length; index++) {
        addAlternateGreeting(template, model.greetings[index], index, getArray, popup, model, index + 1);
    }

    // Filter input handler
    template.find('.greeting-filter-input').on('input', function () {
        const filterText = $(this).val().toLowerCase();
        template.find('.alternate_greetings_list .alternate_greeting').each(function () {
            const content = $(this).find('.alternate_greeting_text').val().toLowerCase();
            $(this).toggle(!filterText || content.includes(filterText));
        });
        // Refresh insertion points if something is picked up
        if (template.hasClass('greeting-inserting')) {
            refreshInsertionPoints(template, getArray);
        }
    });

    template.find('.add_alternate_greeting').on('click', function () {
        const array = getArray();
        // The new row is UI-only until it has text - see the `pending` handling in
        // addAlternateGreeting(). It doesn't get pushed into the array here, so closing the popup
        // (or any other write) without typing into it just never sees it, no filtering needed.
        const index = array.length;
        addAlternateGreeting(template, '', index, getArray, popup, model, index + 1, true);
        updateAlternateGreetingsHintVisibility(template);
        const list = template.find('.alternate_greetings_list');
        list.scrollTop(list.prop('scrollHeight'));
    });

    popup.show();
    updateAlternateGreetingsHintVisibility(template);
}

/**
 * Removes all insertion points and pick state from the greeting container.
 * @param {JQuery<HTMLElement>} template
 */
function clearPickState(template) {
    template.find('.greeting-insert-point').remove();
    template.find('.alternate_greeting.greeting-picked').removeClass('greeting-picked');
    template.removeClass('greeting-inserting');
    // Restore pick-up icons
    template.find('.pick_up_greeting i').removeClass('fa-xmark').addClass('fa-arrows-up-down');
    template.find('.pick_up_greeting').attr('title', 'Pick up to move');
}

/**
 * Recalculates and inserts insertion-point divs between visible greetings,
 * skipping adjacency to the currently picked greeting.
 * @param {JQuery<HTMLElement>} template
 * @param {() => any[]} getArray
 */
function refreshInsertionPoints(template, getArray) {
    template.find('.greeting-insert-point').remove();
    const pickedIndex = Number(template.find('.alternate_greeting.greeting-picked').attr('data-index'));
    const list = template.find('.alternate_greetings_list');
    const visibleGreetings = list.find('.alternate_greeting:visible');
    const array = getArray();

    // Insert point at top of list (before the first visible greeting)
    if (visibleGreetings.length > 0) {
        const firstVisibleIndex = Number(visibleGreetings.first().attr('data-index'));
        if (firstVisibleIndex !== pickedIndex && (firstVisibleIndex !== pickedIndex + 1 || pickedIndex !== 0)) {
            // Position 0 means "insert before whatever is at index firstVisibleIndex"
            const insertPoint = $('<div class="greeting-insert-point"></div>');
            insertPoint.attr('data-insert-position', firstVisibleIndex);
            visibleGreetings.first().before(insertPoint);
        }
    }

    // Insert points between visible greetings and at the bottom
    visibleGreetings.each(function (i) {
        const currentIndex = Number($(this).attr('data-index'));
        const nextVisible = visibleGreetings.eq(i + 1);
        const nextIndex = nextVisible.length ? Number(nextVisible.attr('data-index')) : array.length;
        const isLast = !nextVisible.length;

        // Skip if this greeting or the next is the picked one and they're adjacent
        const directlyAdjacent = (currentIndex === pickedIndex && nextIndex === pickedIndex + 1) ||
                                  (nextIndex === pickedIndex && currentIndex === pickedIndex - 1) ||
                                  currentIndex === pickedIndex;

        if (!directlyAdjacent) {
            const insertPosition = isLast ? array.length : nextIndex;
            const insertPoint = $('<div class="greeting-insert-point"></div>');
            insertPoint.attr('data-insert-position', insertPosition);
            $(this).after(insertPoint);
        }
    });
}

/**
 * Adds a greeting row to the template.
 * @param {JQuery<HTMLElement>} template
 * @param {string} greeting
 * @param {number} index Position in the stable-order greetings array. For a `pending` row this is
 *   only a prediction of where it'll land once it has text - see below.
 * @param {() => any[]} getArray
 * @param {Popup} popup
 * @param {GreetingsModel} model Live working model for this popup instance - `model.defaultIndex` is
 *   read here to decide badge/set-default-vs-demote visibility, and reassigned by the set/demote
 *   handlers below (a pure pointer move - the stable order never changes).
 * @param {number} [displayPosition] 1-based slot number to show the user; defaults to index + 1.
 * @param {boolean} [pending] True for a just-added, still-blank row: it exists only in this DOM
 *   block, not yet as a real entry in the array, so closing the popup (or any other write) while
 *   it's still blank simply never sees it - no entry, nothing to filter out. The very first
 *   non-blank keystroke commits it into the array (at whatever the end is *at that moment*, since
 *   another pending row may have committed first); every keystroke after that is a normal update.
 */
function addAlternateGreeting(template, greeting, index, getArray, popup, model, displayPosition = index + 1, pending = false) {
    const greetingBlock = $('#alternate_greeting_form_template .alternate_greeting').clone();
    let committed = !pending;
    greetingBlock.attr('data-index', index);

    // Per-row debounced `edit` op for keystrokes after the row is committed - one row, one debounce
    // instance, so typing in a different row doesn't reset this one's pending save (unlike a single
    // shared debounced function would). Never fires in create mode - create_save is synced at popup
    // close via syncCreateModeFromUnified(), same as every other create-mode field on this popup.
    const debouncedRowEdit = debounce(async (rowIndex, text) => {
        const avatar = $('.open_alternate_greetings').data('avatar');
        const character = avatar ? charactersStore.get(avatar) : null;
        if (!character) return;
        const expectedHash = greetingPagerState.hashes[rowIndex];
        if (!Number.isFinite(expectedHash)) return;

        const result = await postGreetingOp('edit', { avatar_url: avatar, position: rowIndex, expected_hash: expectedHash, text });
        if (result.ok) {
            await applyGreetingOpSuccess(character, getArray().slice(), result.defaultPosition, result.hashes);
            return;
        }
        console.error('Greeting edit failed', { avatar, position: rowIndex, status: result.status, reason: result.reason });
        if (result.status === 409) {
            toastr.error(t`This greeting was changed in another session, so this edit was not saved. Close and reopen this popup to see the current version.`, t`Greeting not saved`);
            return;
        }
        toastr.error(t`Failed to save the greeting. Your edit is still shown here, but it was not saved.`, t`Greeting not saved`);
    }, DEFAULT_SAVE_EDIT_TIMEOUT);

    greetingBlock.find('.alternate_greeting_text')
        .attr('id', `alternate_greeting_${index}`)
        .on('input', async function () {
            const value = String($(this).val());
            const array = getArray();
            if (!committed) {
                if (value === '') {
                    // Still nothing authored - stays UI-only.
                    return;
                }
                index = array.length;
                array.push(value);
                committed = true;
                greetingBlock.attr('data-index', index);
                greetingBlock.find('.editor_maximize').attr('data-for', `alternate_greeting_${index}`);
                greetingBlock.find('.greeting_index').text(index + 1);
                greetingBlock.find('.set_default_greeting').show();
                greetingBlock.find('.pick_up_greeting').show();

                if (menu_type === 'create') return; // synced at popup close, same as every other create-mode field

                const addedIndex = index;
                const avatar = $('.open_alternate_greetings').data('avatar');
                const character = avatar ? charactersStore.get(avatar) : null;
                if (!character) return;
                const result = await postGreetingOp('add', { avatar_url: avatar, position: addedIndex, text: value });
                if (result.ok) {
                    await applyGreetingOpSuccess(character, array.slice(), result.defaultPosition, result.hashes);
                    return;
                }
                console.error('Greeting add failed', { avatar, position: addedIndex, status: result.status, reason: result.reason });
                toastr.error(t`Failed to save the new greeting. It's still shown here - keep typing in it to retry.`, t`Greeting not saved`);
                // Wasn't actually saved - revert to an uncommitted draft so the next keystroke retries
                // the add, instead of leaving this row looking saved when it isn't.
                array.splice(addedIndex, 1);
                committed = false;
                return;
            }
            array[index] = value;
            if (menu_type !== 'create') debouncedRowEdit(index, value);
        }).val(greeting);
    greetingBlock.find('.editor_maximize').attr('data-for', `alternate_greeting_${index}`);
    greetingBlock.find('.greeting_index').text(displayPosition);

    // Badge and demote-vs-set-as-default are keyed on whether this row IS the current default, not
    // its position - the default can sit anywhere in the stable order now. When model.defaultIndex is
    // null (no default at all), every row falls into the set-as-default branch.
    if (index === model.defaultIndex) {
        greetingBlock.find('.greeting_default_badge').show();
        greetingBlock.find('.demote_default_greeting').show();
    } else if (!pending) {
        greetingBlock.find('.set_default_greeting').show();
    }
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
            model.defaultIndex = reindexDefaultAfterRemoval(model.defaultIndex, index);
            await popup.complete(POPUP_RESULT.AFFIRMATIVE);
            openAlternateGreetings();
            return;
        }

        const avatar = $('.open_alternate_greetings').data('avatar');
        const character = avatar ? charactersStore.get(avatar) : null;
        if (!character) return;
        const expectedHash = greetingPagerState.hashes[index];
        if (!Number.isFinite(expectedHash)) return;
        const result = await postGreetingOp('delete', { avatar_url: avatar, position: index, expected_hash: expectedHash });
        if (!result.ok) {
            console.error('Greeting delete failed', { avatar, position: index, status: result.status, reason: result.reason });
            toastr.error(result.status === 409
                ? t`This character was changed in another session, so this greeting was not deleted. Close and reopen this popup to see the current version.`
                : t`Failed to delete the greeting.`, t`Greeting not deleted`);
            return;
        }
        const newGreetings = array.slice();
        newGreetings.splice(index, 1);
        await applyGreetingOpSuccess(character, newGreetings, result.defaultPosition, result.hashes);

        // Sync and reopen
        await popup.complete(POPUP_RESULT.AFFIRMATIVE);
        openAlternateGreetings();
    });

    // Pick up to move (pick-and-place reordering)
    greetingBlock.find('.pick_up_greeting').on('click', function (event) {
        event.preventDefault();
        event.stopPropagation();

        if (!committed) {
            // Draft row isn't in the array - nothing to move.
            return;
        }

        const isPicked = greetingBlock.hasClass('greeting-picked');
        if (isPicked) {
            // Cancel pick
            clearPickState(template);
            return;
        }

        // Clear any existing pick state first
        clearPickState(template);

        // Enter pick mode
        greetingBlock.addClass('greeting-picked');
        template.addClass('greeting-inserting');
        $(this).find('i').removeClass('fa-arrows-up-down').addClass('fa-xmark');
        $(this).attr('title', 'Cancel move');

        // Create insertion points
        refreshInsertionPoints(template, getArray);

        // Bind click on insertion points
        template.find('.greeting-insert-point').on('click', async function () {
            let targetPosition = Number($(this).attr('data-insert-position'));
            const array = getArray();
            const sourceIndex = index;

            if (menu_type === 'create') {
                const [moved] = array.splice(sourceIndex, 1);
                if (sourceIndex < targetPosition) targetPosition--;
                array.splice(targetPosition, 0, moved);
                model.defaultIndex = reindexDefaultAfterMove(model.defaultIndex, sourceIndex, targetPosition);
                await popup.complete(POPUP_RESULT.AFFIRMATIVE);
                openAlternateGreetings();
                return;
            }

            const avatar = $('.open_alternate_greetings').data('avatar');
            const character = avatar ? charactersStore.get(avatar) : null;
            if (!character) return;
            const expectedHash = greetingPagerState.hashes[sourceIndex];
            if (!Number.isFinite(expectedHash)) return;
            const result = await postGreetingOp('move', { avatar_url: avatar, source_position: sourceIndex, expected_hash: expectedHash, target_position: targetPosition });
            if (!result.ok) {
                console.error('Greeting move failed', { avatar, sourceIndex, targetPosition, status: result.status, reason: result.reason });
                toastr.error(result.status === 409
                    ? t`This character was changed in another session, so this move was not saved. Close and reopen this popup to see the current version.`
                    : t`Failed to move the greeting.`, t`Greeting not moved`);
                return;
            }
            const newGreetings = array.slice();
            const [moved] = newGreetings.splice(sourceIndex, 1);
            const postRemovalTarget = targetPosition > sourceIndex ? targetPosition - 1 : targetPosition;
            newGreetings.splice(postRemovalTarget, 0, moved);
            await applyGreetingOpSuccess(character, newGreetings, result.defaultPosition, result.hashes);

            // Rebuild popup
            await popup.complete(POPUP_RESULT.AFFIRMATIVE);
            openAlternateGreetings();
        });
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
            model.defaultIndex = index;
            await popup.complete(POPUP_RESULT.AFFIRMATIVE);
            openAlternateGreetings();
            return;
        }

        const avatar = $('.open_alternate_greetings').data('avatar');
        const character = avatar ? charactersStore.get(avatar) : null;
        if (!character) return;
        const expectedHash = greetingPagerState.hashes[index];
        if (!Number.isFinite(expectedHash)) return;
        const result = await postGreetingOp('default/set', { avatar_url: avatar, position: index, expected_hash: expectedHash });
        if (!result.ok) {
            console.error('Set default greeting failed', { avatar, position: index, status: result.status, reason: result.reason });
            toastr.error(result.status === 409
                ? t`This character was changed in another session, so the default was not changed. Close and reopen this popup to see the current version.`
                : t`Failed to set the default greeting.`, t`Default not changed`);
            return;
        }
        await applyGreetingOpSuccess(character, getArray().slice(), result.defaultPosition, result.hashes);

        await popup.complete(POPUP_RESULT.AFFIRMATIVE);
        openAlternateGreetings();
    });

    // Demote from default - clears the default entirely (a card can have no default at all); pointer
    // move only, the stable order never changes.
    greetingBlock.find('.demote_default_greeting').on('click', async function (event) {
        event.preventDefault();
        event.stopPropagation();

        if (menu_type === 'create') {
            model.defaultIndex = null;
            await popup.complete(POPUP_RESULT.AFFIRMATIVE);
            openAlternateGreetings();
            return;
        }

        const avatar = $('.open_alternate_greetings').data('avatar');
        const character = avatar ? charactersStore.get(avatar) : null;
        if (!character) return;
        const result = await postGreetingOp('default/unset', { avatar_url: avatar });
        if (!result.ok) {
            console.error('Unset default greeting failed', { avatar, status: result.status, reason: result.reason });
            toastr.error(t`Failed to clear the default greeting.`, t`Default not changed`);
            return;
        }
        await applyGreetingOpSuccess(character, getArray().slice(), result.defaultPosition, result.hashes);

        await popup.complete(POPUP_RESULT.AFFIRMATIVE);
        openAlternateGreetings();
    });

    template.find('.alternate_greetings_list').append(greetingBlock);
}

/**
 * Creates or edits a character based on the form data.
 * @param {Event} [e] Event that triggered the function call.
 */
export async function createOrEditCharacter(e) {
    if (!settingsReady) {
        console.warn('Settings not ready, aborting character creation/editing.');
        return;
    }

    $('#rm_info_avatar').html('');
    const formData = new FormData(/** @type {HTMLFormElement} */($('#form_create').get(0)));
    formData.set('fav', String(fav_ch_checked));
    // Captured now, before the post-save field-clearing loop below resets create_save.name to '' - this is the
    // only point where the just-typed character name is still available for the "Character Created" toast.
    const newCharacterName = String(formData.get('ch_name') || '');
    const isNewChat = e instanceof CustomEvent && e.type === 'newChat';

    const rawFile = formData.get('avatar');
    if (rawFile instanceof File) {
        const convertedFile = await ensureImageFormatSupported(rawFile);
        formData.set('avatar', convertedFile);
    }

    const headers = getRequestHeaders({ omitContentType: true });

    if ($('#form_create').attr('actiontype') == 'createcharacter') {
        if (String($('#character_name_pole').val()).length === 0) {
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

            // #firstmessage_textarea used to carry this via its `name="first_mes"` form field - now that
            // it's gone, create_save.first_message (kept live by the greeting pager/popup in create
            // mode) is the source instead.
            formData.set('first_mes', create_save.first_message);

            formData.delete('alternate_greetings');
            for (const value of stripEmptyAlternateGreetings(create_save.alternate_greetings, 'create character')) {
                formData.append('alternate_greetings', value);
            }

            formData.append('extensions', JSON.stringify(create_save.extensions));

            const fetchResult = await fetch(url, {
                method: 'POST',
                headers: headers,
                body: formData,
                cache: 'no-cache',
            });

            if (!fetchResult.ok) {
                throw new Error('Fetch result is not ok');
            }

            const avatarId = await fetchResult.text();

            $('#character_cross').trigger('click'); //closes the advanced character editing popup
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
                { id: '#character_json_data', callback: () => { } },
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

            $('#character_popup-button-h3').text('Create character');

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
            await getCharacters({ silent: true });
            charactersStore.reportCreated(avatarId);

            select_rm_info('char_create', avatarId, oldSelectedChar, newCharacterName);

            crop_data = undefined;
        } catch (error) {
            console.error('Error creating character', error);
            toastr.error(t`Failed to create character`);
        }
    } else {
        try {
            const previousFav = getCurrentCharacter()?.fav;

            // No-op guard: skip the save entirely if nothing in the form actually changed.
            const avatarInput = formData.get('avatar');
            const hasNewAvatar = avatarInput instanceof File && avatarInput.size > 0;
            if (!hasNewAvatar && _characterFormSnapshot) {
                let hasDirtyFields = false;
                for (const [id, originalValue] of Object.entries(_characterFormSnapshot)) {
                    if (String($(id).val() ?? '') !== originalValue) {
                        hasDirtyFields = true;
                        break;
                    }
                }
                if (!hasDirtyFields) {
                    return;
                }
            }

            const editCharacter = getCurrentCharacter();
            const avatarUrl = String(formData.get('avatar_url'));

            if (!_characterFormSnapshot) {
                // Shouldn't happen: the only place that sets actiontype to 'editcharacter'
                // (selectCharacterById's form population) captures the snapshot immediately
                // after, synchronously, with nothing awaited in between - so by the time this
                // branch can run, a snapshot always exists. If this ever fires, something
                // upstream changed; fail loudly instead of silently falling back to a
                // whole-card save.
                console.error('createOrEditCharacter: editing with no _characterFormSnapshot - refusing to save.');
                toastr.error(t`Could not determine what changed on this character. Please reload it and try again.`, t`Save failed`);
                return;
            }

            // ─── Avatar image upload via edit-avatar ─────────────────────────
            // Independent of the field save below: edit-avatar re-reads the character
            // straight off disk and only ever touches the image and crop, so it can't
            // clobber card fields and needs no conflict detection of its own.
            //
            // Sent first, fields second. The field save below still negotiates the
            // existing merge-attributes 409 conflict popup, which can end with the user
            // discarding their edits and reloading the page. A new avatar the user
            // explicitly picked and cropped isn't part of that conflict - it has nothing
            // to do with "another session changed these fields" - so it shouldn't be at
            // risk of silently not landing depending on how that unrelated conflict gets
            // resolved. Uploading it first means it always lands regardless.
            if (hasNewAvatar) {
                let avatarEditUrl = '/api/characters/edit-avatar';
                if (crop_data != undefined) {
                    avatarEditUrl += `?crop=${encodeURIComponent(JSON.stringify(crop_data))}`;
                }

                const avatarFormData = new FormData();
                avatarFormData.append('avatar', avatarInput);
                avatarFormData.append('avatar_url', avatarUrl);

                const avatarFetchResult = await fetch(avatarEditUrl, {
                    method: 'POST',
                    headers: getRequestHeaders({ omitContentType: true }),
                    body: avatarFormData,
                    cache: 'no-cache',
                });

                if (!avatarFetchResult.ok) {
                    toastr.error(t`Failed to upload the new avatar image. Nothing was saved - your other edits are still shown here, try saving again.`, t`Avatar not saved`);
                    return;
                }
            }

            // ─── Field-granular save via merge-attributes ───────────────────
            // Only sends the fields the user actually changed, with per-field
            // conflict detection that names the exact fields another session
            // modified. No full-card round-trip for text-only edits.
            const mergeData = { avatar: avatarUrl };
            const loadedFieldHashes = {};

            for (const [formId, originalValue] of Object.entries(_characterFormSnapshot)) {
                const currentValue = String($(formId).val() ?? '');
                if (currentValue === originalValue) continue;

                const mapping = FORM_TO_CARD[formId];
                if (!mapping) continue;

                // Transform the form value to match card format
                let cardValue = currentValue;
                if (mapping.transform === 'tags') {
                    cardValue = currentValue.split(',').map(x => x.trim()).filter(x => x);
                } else if (mapping.transform === 'number') {
                    cardValue = Number(currentValue) || 0;
                } else if (mapping.transform === 'int') {
                    const n = Number(currentValue);
                    cardValue = !isNaN(n) ? n : 4;
                }

                // Set both V1 and V2 paths in the merge payload
                if (mapping.v1) lodash.set(mergeData, mapping.v1, cardValue);
                if (mapping.v2) lodash.set(mergeData, mapping.v2, cardValue);

                // Hash the loaded value for per-field conflict detection
                const loadedValue = lodash.get(editCharacter, mapping.v2);
                loadedFieldHashes[mapping.v2] = getStringHash(JSON.stringify(loadedValue !== undefined ? loadedValue : null));
            }

            mergeData._loadedFieldHashes = loadedFieldHashes;

            const fetchResult = await fetch('/api/characters/merge-attributes', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify(mergeData),
            });

            if (fetchResult.status === 409) {
                let errorData;
                try { errorData = await fetchResult.json(); } catch { /* ignore parse errors */ }
                if (errorData?.error === 'conflict' && errorData.conflictingFields) {
                    const fieldNames = errorData.conflictingFields.map(path =>
                        path.replace(/^data\.extensions\.depth_prompt\./, 'Depth Prompt ')
                            .replace(/^data\.extensions\./, '')
                            .replace(/^data\./, '')
                            .replace(/_/g, ' '),
                    );

                    const confirmOverwrite = await callGenericPopup(
                        t`<h3>Character edited in another session</h3>
                          <p>The following fields were changed by another session:</p>
                          <p><strong>${fieldNames.join(', ')}</strong></p>
                          ${hasNewAvatar ? t`<p>The new avatar image has already been saved.</p>` : ''}
                          <p>Overwrite with your version, or discard your changes?</p>`,
                        POPUP_TYPE.CONFIRM,
                        '',
                        { okButton: t`Overwrite with mine`, cancelButton: t`Discard my changes` },
                    );
                    if (confirmOverwrite === POPUP_RESULT.AFFIRMATIVE) {
                        delete mergeData._loadedFieldHashes;
                        const retryResult = await fetch('/api/characters/merge-attributes', {
                            method: 'POST',
                            headers: getRequestHeaders(),
                            body: JSON.stringify(mergeData),
                        });
                        if (!retryResult.ok) {
                            throw new Error('Force save after conflict failed');
                        }
                    } else {
                        window.location.reload();
                        return;
                    }
                }
            } else if (!fetchResult.ok) {
                if (hasNewAvatar) {
                    toastr.error(t`The new avatar image was saved, but your other changes could not be saved. Try saving again.`, t`Save incomplete`);
                    return;
                }
                throw new Error('Fetch result is not ok');
            }

            // ─── Common post-save logic ────────────────────────────────────
            await getOneCharacter(avatarUrl);

            // Re-capture the form snapshot so the next save correctly detects no-op
            if (_characterFormSnapshot) {
                for (const id of CHARACTER_FORM_FIELDS) {
                    _characterFormSnapshot[id] = String($(id).val() ?? '');
                }
            }

            if (Boolean(previousFav) !== Boolean(fav_ch_checked)) {
                favsToHotswap();
            }

            $('#add_avatar_button').replaceWith(
                $('#add_avatar_button').val('').clone(true),
            );
            $('#create_button').attr('value', 'Save');
            crop_data = undefined;
            await eventSource.emit(event_types.CHARACTER_EDITED, { detail: { character: getCurrentCharacter() } });

            // Recreate the chat if it hasn't been used at least once (i.e. with continue).
            const message = await getFirstMessage();
            const shouldRegenerateMessage =
                !isNewChat &&
                message.mes &&
                !selected_group &&
                chat.length === 0;

            if (shouldRegenerateMessage) {
                if (power_user.message_token_count_enabled) {
                    message.extra.token_count = await getTokenCountAsync(message.mes, 0);
                }
                chat.splice(0, chat.length, message);
                const messageId = (chat.length - 1);
                await eventSource.emit(event_types.MESSAGE_RECEIVED, messageId, 'first_message');
                await clearChat();
                await printMessages();
                await eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, messageId, 'first_message');
                await saveChatConditional();
            }
        } catch (error) {
            console.log(error);
            toastr.error(t`Something went wrong while saving the character, or the image file provided was in an invalid format. Double check that the image is not a webp.`);
        }
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

    //A click carries its own message id. `message` defaults to the last message, so without this an
    //arrow on an earlier message would be checked against the wrong one.
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

    const thisMesDiv = chatElement.children('.mes').filter(`[mesid="${mesId}"]`);
    const thisMesText = thisMesDiv.find('.mes_block .mes_text');
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
            //Out of bounds swipes should not be saved.
        } else if (source != SWIPE_SOURCE.BACK && !_isBlankUnwrittenSwipe(chat[mesId])) {
            // A tree-backed chat has already recorded this: switchToAlternativePath() posts the
            // selection against the row it is moving onto, at the moment the move happens. Asking for
            // a whole-conversation save on top of that adds nothing it could write - the choice is
            // already stored - and costs an edit per message, because the comparison it runs sees
            // objects that swiping replaced and reads them as changed. Measured: six swipes sent four
            // edits, every one re-sending text nobody had touched.
            //
            // A file-backed chat has no such op. Its swipe_id lives in the saved array and nowhere
            // else, so there the save IS the persistence.
            if (!chat_metadata?._tree_stored) {
                saveChatDebounced();
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
        // Leaving a blank slot means the truncation it caused is over, so what followed comes back.
        // Checked before the switch, since the slot stops being current afterwards.
        //
        // Reachable via confirming an EMPTY edit: applyMessageEdit has no empty guard, so the slot
        // stays blank while messageEditDone clears this_edit_mes_id and re-enables the buttons. That
        // leaves a blank selected, a truncated view, and the message swipeable again. Cancelling
        // takes the other exit and restores from there instead.
        const leavingBlank = _isBlankSlot(chat[mesId], chat[mesId]?.swipe_id ?? 0)
            && newSwipeId !== (chat[mesId]?.swipe_id ?? 0);

        // A wide fork point arrives with most alternatives as holes; fetch this one before switching
        // to it, so the swipe never lands on empty.
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

        //Moving to a different alternative means moving onto its path: adopt its node, drop what
        //belonged to the old one, and load what actually follows it. This runs after the sync so the
        //message already holds the new text by the time the chat is redrawn.
        const switched = await switchToAlternativePath(mesId, newSwipeId);

        // Swiping back onto the slot we were already on does not change node, so the switch above is
        // a no-op and cannot restore anything. Do it explicitly.
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

    function getMessageBottomHeight(thisMesDiv) {
        const thisMesRect = thisMesDiv[0].getBoundingClientRect();
        //Scroll position + Chat height = Bottom of chat height.
        const chatBottom = chatElement.scrollTop() - chatElement.height();
        //Message offset from viewport top + height = Bottom of message offset.
        const messageBottom = thisMesRect.top + thisMesDiv.height();
        // Bottom of chat + Bottom of message offset = target scroll position.
        const scrollHeight = (chatBottom + messageBottom);
        return scrollHeight;
    }

    function expandNewMessage(thisMesDiv) {
        //Only scroll if the view is not near the bottom.
        const is_animation_scroll = (chatElement.scrollTop() >= (chatElement.prop('scrollHeight') - chatElement.outerHeight()) - 10);

        let new_height = thisMesDivHeight - (thisMesTextHeight - thisMesText[0].scrollHeight);
        if (new_height < 103) new_height = 103;

        //Keep the swipe buttons at the same height when scrolling is finished.

        //Expand new message.
        thisMesDiv.animate({ height: new_height + 'px' }, {
            duration: 0, //used to be 100 //Disabled on Cohee's request. https://github.com/SillyTavern/SillyTavern/pull/4610/files#r2408731744
            queue: false,
            progress: function (animation, progress, remainingMs) {
                if (is_animation_scroll) chatElement.scrollTop(getMessageBottomHeight(thisMesDiv));
            },
            complete: function () {
                thisMesDiv.css('height', 'auto');
                //Correct height auto offset.
                if (is_animation_scroll) chatElement.scrollTop(getMessageBottomHeight(thisMesDiv));
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

            //Only scroll when swiping the last message.
            const scroll = (mesId == chat.length - 1);
            //The swipe buttons will be refreshed in endSwipe(), refreshing them now will cause flickering.
            addOneMessage(chat[mesId], { type: 'swipe', forceId: mesId, scroll: scroll, showSwipes: false });

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

                // Truncate the view to this message. You are now sitting at this point about to say
                // something else, so what currently follows is not what follows any more. Nothing is
                // deleted - there is no DELETE anywhere in the tree - and typing here appends under
                // this node, which forks. Leaving the blank slot restores the old continuation.
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
 * Imports supported files dropped into the app window.
 *
 * Each file is imported, applied to charactersStore, and (per `power_user.tag_import_setting`) has its tags
 * imported, all before moving on to the next file - see importCharacter()'s and applyImportedCharacter()'s own
 * comments for why this no longer needs a second full-library-refetch pass afterward the way it used to.
 * ASK-mode's popup (tags.js's showTagImportPopup(), reached through importTags() below) still runs once per
 * character, still sequentially - that part is unchanged, it just now happens inline in this same loop instead
 * of in a separate one.
 * @param {File[]} files Array of files to process
 * @param {Map<File, string>} [data] Extra data to pass to the import function
 * @returns {Promise<void>}
 */
export async function processDroppedFiles(files, data = new Map()) {
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

    // Explicit batch-import mode (character-metadata-db.js's begin/endBatchImport, wired here for the first
    // time - see this repo's design doc §3.3 item 7) buffers metadata-store writes and suspends its directory
    // watcher, built specifically for bringing in a large corpus without paying one SQLite transaction and one
    // watcher event per file. Gated on more than one file, not every drop: a single-file drop already gets a
    // small, cheap, unbuffered write (its own tiny transaction, one watcher event) - wrapping that in batch mode
    // would only add two extra round trips (begin/end) plus force an end-of-batch reconcile pass, for no
    // benefit, since the entire point of batch mode (avoiding N transactions/watcher events) only pays off once
    // N is actually large. A multi-file drop is unambiguously the case the mechanism exists for.
    const useBatchImportMode = importable.length > 1;
    if (useBatchImportMode) {
        await beginMetadataBatchImport();
    }

    const avatarFileNames = [];
    let duplicateCount = 0;

    try {
        for (const file of importable) {
            const preservedName = data instanceof Map && data.get(file);
            const result = await importCharacter(file, { preserveFileName: preservedName });

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
            if (power_user.tag_import_setting !== tag_import_setting.NONE) {
                tagsAdded = await importTags(result.character, { suppressSuccessToast: true });
            }

            // One toast per character for the whole create/replace + tag-import outcome, instead of a separate
            // "Character Created"/"Importing Tags" popup for each - see this function's own doc comment.
            const charName = result.character?.name || String(result.avatarFileName).replace('.png', '');
            const toastMessage = result.replaced
                ? (tagsAdded ? t`Replaced character '${charName}' (tags imported)` : t`Replaced character '${charName}'`)
                : (tagsAdded ? t`Imported character '${charName}' (tags imported)` : t`Imported character '${charName}'`);
            toastr.success(toastMessage);
        }
    } finally {
        // Always ends batch mode, even if an import threw mid-loop - an un-ended batch would leave every
        // subsequent write for this user silently buffered (and the watcher silently suspended) well past this
        // request, which is worse than any single failed import.
        if (useBatchImportMode) {
            await endMetadataBatchImport();
        }
    }

    if (avatarFileNames.length > 0) {
        await printCharacters(true);
        selectImportedChar(avatarFileNames[avatarFileNames.length - 1]);
    }

    if (duplicateCount > 0) {
        toastr.info(t`Skipped ${duplicateCount} duplicate character(s) already in your library.`, t`Import`);
    }
}

/**
 * Starts the server's metadata-store batch-import mode (see processDroppedFiles()) for the duration of a bulk
 * drop. Never throws - a failure here just means writes for this batch go through the normal unbuffered path
 * instead (still correct, only slower), matching the metadata store's own "never let this block the actual
 * character save" convention elsewhere.
 * @returns {Promise<void>}
 */
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

/**
 * Ends the server's metadata-store batch-import mode (see beginMetadataBatchImport()). Never throws, for the
 * same reason as beginMetadataBatchImport() - but importantly, this is still always called (from
 * processDroppedFiles()'s `finally`) even after a begin failure, since the server itself treats begin/end as
 * idempotent no-ops when batch mode was never actually entered.
 * @returns {Promise<void>}
 */
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

/**
 * Inserts (brand-new avatar) or updates (a preserved-name replace) a just-imported character straight into
 * charactersStore, using the `character` payload `/api/characters/import` now returns directly - the same shape
 * `/batch`/`/all`/`/get` already produce (server-side processCharacter()), so this is exactly as correct as a
 * refetch would have been, without the round trip.
 *
 * Inserting here (rather than deferring to some later printCharacters()/getCharacters() call) matters beyond
 * just avoiding the refetch: tags.js's getTagKeyForEntity() - what addTagsToEntity()/importTags() below actually
 * assigns tags through - only seeds a fresh tag_map entry for an avatar it can resolve via charactersStore (or
 * one already present in tag_map). A character tag-imported before it's in charactersStore would silently fail
 * to record any tag assignment at all. So this must run before importTags() is called for the same character -
 * see processDroppedFiles()'s loop ordering.
 * @param {object} [character] Shape from server processCharacter() - undefined if the import didn't return one
 * @returns {void}
 */
function applyImportedCharacter(character) {
    if (!character?.avatar) {
        return;
    }
    if (charactersStore.has(character.avatar)) {
        charactersStore.update(character.avatar, character);
    } else {
        charactersStore.create(character);
    }
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
 * Imports a character from a file.
 * @param {File} file File to import
 * @param {object} [options] - Options
 * @param {string} [options.preserveFileName] Whether to preserve original file name
 * @returns {Promise<{ avatarFileName: string, replaced: boolean, character: object } | { duplicate: true } | undefined>}
 * `undefined` for an unsupported extension or a hard failure (already toasted). `{ duplicate: true }` when the
 * server recognized the upload's exact bytes as already present in the library (see characters.js's `/import` -
 * exact byte-identical dedup only, no near-duplicate matching) and skipped importing it.
 */
async function importCharacter(file, { preserveFileName = '' } = {}) {
    if (is_group_generating || is_send_press) {
        toastr.error(t`Cannot import characters while generating. Stop the request and try again.`, t`Import aborted`);
        throw new Error('Cannot import character while generating');
    }

    const ext = file.name.match(/\.(\w+)$/);
    if (!ext || !(['json', 'png', 'yaml', 'yml', 'charx', 'byaf'].includes(ext[1].toLowerCase()))) {
        return;
    }

    const exists = preserveFileName ? charactersStore.get(preserveFileName) : undefined;

    const format = ext[1].toLowerCase();
    $('#character_import_file_type').val(format);
    const formData = new FormData();
    formData.append('avatar', file);
    formData.append('file_type', format);
    formData.append('user_name', name1);
    if (preserveFileName) formData.append('preserved_name', preserveFileName);

    try {
        const result = await fetch('/api/characters/import', {
            method: 'POST',
            body: formData,
            headers: getRequestHeaders({ omitContentType: true }),
            cache: 'no-cache',
        });

        if (!result.ok) {
            throw new Error(`Failed to import character: ${result.statusText}`);
        }

        const data = await result.json();

        if (data.error) {
            throw new Error(`Server returned an error: ${data.error}`);
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

            // No toast here - processDroppedFiles() (this function's only caller) folds this result together
            // with the tag-import outcome into a single combined notification per character.
            return { avatarFileName, replaced: exists, character: data.character };
        }
    } catch (error) {
        console.error('Error importing character', error);
        toastr.error(t`The file is likely invalid or corrupted.`, t`Could not import character`);
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

    // Make it easier to find in backups
    if (deleteCurrentChat) {
        await saveChatConditional();
    }

    if (selected_group) {
        await createNewGroupChat(selected_group);
        if (deleteCurrentChat) await deleteGroupChat(selected_group, chat_file_for_del, { jumpToNewChat: false }); // don't jump, new chat was already created and jumped to above
    } else {
        //RossAscends: added character name to new chat filenames and replaced Date.now() with humanizedDateTime;
        chat_metadata = {};
        const newChatName = `${name2} - ${humanizedDateTime()}`;
        charactersStore.update(getCurrentCharacter().avatar, { chat: newChatName });
        $('#selected_chat_pole').val(newChatName);
        await getChat({ isNewChat: true });
        // getChat() can refetch this character from the server (unshallowCharacter() -> getOneCharacter(), for
        // a shallow-loaded entity) and Object.assign the response onto the in-memory entity - since the chat
        // rename above hasn't been persisted server-side yet at this point, that refetch silently clobbers it
        // back to the still-old server value (and select_selected_character(), at the tail of getChat(), then
        // re-syncs #selected_chat_pole from that clobbered entity too). Reapplying both here, right before the
        // save, is what actually makes createOrEditCharacter() below persist the new chat name instead of
        // silently re-saving the old one - without this, "start new chat" looks like it worked (a fresh empty
        // chat renders) but no new chat file is ever created.
        // Point at the opening node itself. Nothing was created here - the greeting already exists as a
        // node, and starting here is moving to one with nothing after it yet. The name above only
        // exists to make the load above find nothing; keeping it as the pointer left it naming
        // something that does not exist, so metadata saves (which resolve node-then-name) failed
        // outright and the position could not be resolved back to anywhere.
        // Only a real row can be a position. An opening still sitting on a card-only greeting has no
        // row to point at, so the chat keeps its name as the pointer until something gives it one -
        // storing the provisional id would leave the character pointing at nothing resolvable.
        const openingNodeId = chat[0]?.node_id;
        const pointer = isStoredNodeId(openingNodeId) ? openingNodeId : newChatName;

        charactersStore.update(getCurrentCharacter().avatar, { chat: pointer });
        $('#selected_chat_pole').val(pointer);
        await saveActiveChat(getCurrentCharacter().avatar, pointer);
        if (deleteCurrentChat) await delChat(chat_file_for_del + '.jsonl');
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
export async function renameGroupOrCharacterChat({ characterAvatar, groupId, oldFileName, newFileName, loader: showLoader, byNode = false }) {
    const currentChatId = getCurrentChatId();
    const body = {
        is_group: !!groupId,
        avatar_url: characterAvatar,
        // A node id is not a file, so it does not get a file extension glued on. It happened to
        // survive because the route strips .jsonl again, but it was only ever describing storage that
        // does not exist for this value. The JSONL path uses original_file as a real filename, so a
        // name-addressed rename still sends one.
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
        // When the target is a node, the pointer already names that node and renaming its bookmark
        // does not move it. Only a name-addressed pointer has to follow the new name.
        } else if (!byNode && characterAvatar !== undefined && characterAvatar === this_avatar && charactersStore.get(characterAvatar)?.chat === oldFileName) {
            charactersStore.update(characterAvatar, { chat: newFileName });
            $('#selected_chat_pole').val(charactersStore.get(characterAvatar).chat);
            // Update the chat pointer through merge-attributes (which routes it to
            // setCharacterActiveChat) instead of createOrEditCharacter(), which would
            // do a full-card save and potentially trigger shouldRegenerateMessage.
            await fetch('/api/characters/merge-attributes', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ avatar: characterAvatar, chat: newFileName }),
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
    if (is_send_press == false) {
        await waitUntilCondition(() => !isChatSaving, debounce_timeout.extended, 10);
        await clearChat({ clearData: true });
        resetSelectedGroup();
        setCharacterId(undefined);
        setCharacterName('');
        setActiveCharacter(null);
        setActiveGroup(null);
        this_edit_mes_id = undefined;
        chat_metadata = {};
        selected_button = 'characters';
        $('#rm_button_selected_ch').children('h2').text('');
        // The character/chat this panel was showing no longer applies once the chat is closed, so this
        // is a real close (not just switching the visible menu away) - see right-menu-state.js.
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
 * Forces the update of the chat name for a remote character.
 * @param {string} avatar Character avatar to update chat name for
 * @param {string} newName New name for the chat
 * @returns {Promise<void>}
 */
export async function updateRemoteChatName(avatar, newName) {
    const character = charactersStore.get(avatar);
    if (!character) {
        console.warn(`Character not found for avatar: ${avatar}`);
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
 * Function to handle the deletion of a character, given a specific popup type and character ID.
 * If popup type equals "del_ch", it will proceed with deletion otherwise it will exit the function.
 * It fetches the delete character route, sending necessary parameters, and in case of success,
 * it proceeds to delete character from UI and saves settings.
 * In case of error during the fetch request, it logs the error details.
 *
 * @param {string} characterId - Unused; the current character (getCurrentCharacter()) is what actually gets deleted.
 * @param {boolean} delete_chats - Whether to delete chats or not.
 */
export async function handleDeleteCharacter(characterId, delete_chats) {
    if (!getCurrentCharacter()) {
        return;
    }

    await deleteCharacter(getCurrentCharacter().avatar, { deleteChats: delete_chats });
}

/**
 * Deletes a character completely, including associated chats if specified
 *
 * @param {string|string[]} characterKey - The key (avatar) of the character to be deleted
 * @param {Object} [options] - Optional parameters for the deletion
 * @param {boolean} [options.deleteChats=true] - Whether to delete associated chats or not
 * @return {Promise<boolean>} - A promise that resolves when the character is successfully deleted
 */
export async function deleteCharacter(characterKey, { deleteChats = true } = {}) {
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

    for (const key of characterKey) {
        const character = charactersStore.get(key);
        if (!character) {
            toastr.warning(t`Character ${key} not found. Skipping deletion.`);
            continue;
        }

        const pastChats = await getPastCharacterChats(character.avatar);

        const msg = { avatar_url: character.avatar, delete_chats: deleteChats };

        const response = await fetch('/api/characters/delete', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(msg),
            cache: 'no-cache',
        });

        if (!response.ok) {
            toastr.error(`${response.status} ${response.statusText}`, t`Failed to delete character`);
            continue;
        }

        accountStorage.removeItem(`AlertRegex_${character.avatar}`);
        accountStorage.removeItem(`mediaWarningShown:${character.avatar}`);
        removeEntityTags(character.avatar);
        select_rm_info('char_delete', character.name);

        if (deleteChats) {
            for (const chat of pastChats) {
                const name = chat.file_name.replace('.jsonl', '');
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
 * It manages necessary UI changes such as closing advanced editing popup, unsetting
 * character ID, resetting characters array and chat metadata, deselecting character's tab
 * panel, removing character name from navigation tabs, clearing chat, fetching updated list of characters.
 * It also ensures to save the settings after all the operations.
 * @param {{avatar: string, entity: object}[]} [removedCharacters] - the characters that were just deleted
 * (avatar + the entity object as it existed before removal), so charactersStore can report exactly what
 * happened instead of a generic reset. Empty/omitted when nothing was actually deleted (deleteCharacter's own
 * "not found, skipping" case can reach here with zero successful deletions).
 */
async function removeCharacterFromUI(removedCharacters = []) {
    preserveNeutralChat();
    await clearChat();
    $('#character_cross').trigger('click');
    resetChatState();
    // The character(s) the create/edit panel may have been showing no longer exist, so this is a real
    // close (not just switching the visible menu away) - see right-menu-state.js.
    closeRightMenu('rm_ch_create_block');
    $(document.getElementById('rm_button_selected_ch')).children('h2').text('');
    restoreNeutralChat();
    await getCharacters({ silent: removedCharacters.length > 0 });
    for (const { avatar, entity } of removedCharacters) {
        charactersStore.reportRemoved(avatar, entity);
    }
    await printMessages();
    // No save: nothing in this function or its call chain writes active_character/active_group - only
    // setActiveCharacter()/setActiveGroup() do, and neither is reached from here.
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
    chat_metadata = {};
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
    const drawerWasOpenAlready = drawerToggle.parent().find('.drawer-content').hasClass('openDrawer');
    if (drawerWasOpenAlready || drawer.hasClass('resizing')) { return; }
    doNavbarIconClick.call(drawerToggle);
}

/**
 * Event handler to open or close a navbar drawer when a navbar icon is clicked.
 * Handles click events on .drawer-toggle elements.
 * @returns {Promise<void>}
 */
export async function doNavbarIconClick() {
    const icon = $(this).find('.drawer-icon');
    const drawer = $(this).parent().find('.drawer-content');
    const drawerWasOpenAlready = $(this).parent().find('.drawer-content').hasClass('openDrawer');
    const targetDrawerID = $(this).parent().find('.drawer-content').attr('id');

    if (!drawerWasOpenAlready) {
        // See ensureDrawerOpen's comment: the two .fillRight drawers coexist, so opening one of them must
        // not sweep-close the other (pinned or not) here either.
        const isFillRight = drawer.hasClass('fillRight');
        const $openDrawers = $('.openDrawer:not(.pinnedOpen)').not(isFillRight ? '.fillRight' : []);
        const $openIcons = $('.openIcon:not(.drawerPinnedOpen)').not(isFillRight ? '.fillRightIcon' : []);
        for (const iconEl of $openIcons) {
            $(iconEl).toggleClass('closedIcon openIcon');
        }
        for (const el of $openDrawers) {
            $(el).toggleClass('closedDrawer openDrawer');
        }
        if ($openDrawers.length && animation_duration) {
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

        if (drawer.hasClass('fillRight')) {
            activateFillRightDrawer(targetDrawerID);
        }

        // Set the height of "autoSetHeight" textareas within the drawer to their scroll height
        if (!CSS.supports('field-sizing', 'content')) {
            const textareas = $(this).closest('.drawer').find('.drawer-content textarea.autoSetHeight');
            for (const textarea of textareas) {
                await resetScrollHeight($(textarea));
            }
        }
    } else if (drawerWasOpenAlready) {
        // For fillRight drawers that are open but behind (not frontFillRight), bring to front
        // instead of closing - the user is switching between the two right-side panels.
        if (drawer.hasClass('fillRight') && !drawer.hasClass('frontFillRight')) {
            activateFillRightDrawer(targetDrawerID);
            return;
        }
        icon.toggleClass('closedIcon openIcon');
        drawer.toggleClass('closedDrawer openDrawer');
    }
}

function addDebugFunctions() {
    const doBackfill = async () => {
        for (let i = 0; i < chat.length; i++) {
            const message = chat[i];

            // System messages are not counted
            if (message.is_system) {
                continue;
            }

            const tokenCountText = (message?.extra?.reasoning || '') + message.mes;
            const tokenCount = await getTokenCountAsync(tokenCountText, 0);
            updateMessage(i, { extra: { ...(chat[i].extra || {}), token_count: tokenCount } });
        }

        await saveChatConditional();
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

/**
 * Per-backend UI info for the persistent `#character_search_backend_indicator` icon - null means "hide it, this
 * backend is fully healthy." See search-engine.js for what each backend actually means; this only decides how
 * loudly to say so. 'tantivy' is the fastest tier (no indicator). 'native'/'wasm' are the SQLite FTS5 fallback
 * chain used when tantivy's native binding isn't usable on this install (see tantivy-engine.js) - same ranking
 * and 'label:query' support as each other, 'wasm' just slower than 'native'; both are a real, if mild, warning
 * now that they're fallback tiers rather than the primary engine. 'unavailable' means the whole chain failed.
 * @type {Record<string, { icon: string, tone: 'warning' | 'error', tooltip: string } | null>}
 */
const SEARCH_BACKEND_INDICATOR = {
    tantivy: null,
    get native() {
        return {
            icon: 'fa-triangle-exclamation',
            tone: 'warning',
            tooltip: t`Character search is running on the SQLite fallback engine because the faster tantivy search backend isn't available on this install - same ranking and 'label:query' filter support as usual, just slower. See the server console for details.`,
        };
    },
    get wasm() {
        return {
            icon: 'fa-triangle-exclamation',
            tone: 'warning',
            tooltip: t`Character search is running on the WebAssembly SQLite engine, two fallback tiers below the primary tantivy backend - same ranking and 'label:query' filter support as usual, just slower. See the server console for details.`,
        };
    },
    get unavailable() {
        return {
            icon: 'fa-circle-exclamation',
            tone: 'error',
            tooltip: t`Character search is unavailable - none of the tantivy, native SQLite, or WebAssembly SQLite search backends could be loaded on this install. See the server console for details.`,
        };
    },
};

/**
 * Tracks the most recent server-side search response's backend, so fetchServerCharacterSearchResults() only
 * pops a transition toast when the backend actually changes rather than on every debounced keystroke while it
 * stays degraded - the persistent `#character_search_backend_indicator` icon (toggled below) is what stays
 * visible for the rest of the time.
 * @type {string | null}
 */
let lastKnownSearchBackend = null;

/**
 * Fetches full-content character/group search results from the server's fast index (`POST /api/characters/query`,
 * `filter.search` + `sort.field: 'search'`) and stores them on entitiesFilter for searchFilter() (filters.js) to
 * use instead of its client-side pass - see FilterHelper.setServerSearchResults()'s JSDoc for why this isn't
 * just a speed optimization.
 *
 * Previously called `POST /api/characters/all` - a second, separate search pipeline from the `/query` endpoint
 * plain browse/sort already used, kept apart specifically because `/query`'s `filter.search` used to answer from
 * a characters-only index and would have silently dropped every group match. That gap is closed now (groups have
 * their own full-text index, groups-search-index.js, wired into `/query`'s `filter.search` + `filter.includeGroups`
 * handling - see that route's own doc comment, characters.js) - `canUseServerQueryForEntitiesList()` no longer
 * excludes an active search term either, so this is genuinely the same query the main list's own server-paginated
 * render path issues, not a parallel one that could disagree with it.
 *
 * Results come back already best-first sorted (relevance order - see the `/query` route's `sort.field === 'search'`
 * handling, characters.js), so this assigns each match a synthetic ascending-is-better score by its position in
 * that order - the endpoint doesn't expose the underlying relevance score directly, and rank alone is enough for
 * both consumers: searchFilter()'s membership check (does a cached score exist at all) and sortEntitiesList()'s
 * ascending sort. This still matters even though the main list itself now renders straight from `/query`'s own
 * rows (not through this scoring path) - it's what keeps a caller whose *sort field* got rejected by the server
 * (a caught `isInvalidSortFieldError()`, not a search one - `canUseServerQueryForEntitiesList()`, script.js)
 * working on its own pre-existing fully-local fallback while a search term is also active.
 *
 * The response also carries `searchBackend` ('tantivy'|'native'|'wasm'|'unavailable' - see the `/query` route and
 * search-engine.js). Previously a degraded backend only ever showed up as a server console warning; this surfaces
 * it as a persistent icon (toggled here, see SEARCH_BACKEND_INDICATOR) plus a one-time toast on the transition
 * into a worse state.
 * Also mirrors the current FILTER_TYPES.FAV filter state into the request (`fav: true` when the main character
 * list's favorites-only filter is active) so the server restricts matches to favorites *inside* the search index
 * query - see the `/query` route's `filter.fav` + `filter.search` composition (characters.js) for why that has to
 * happen there rather than after this function's own results get narrowed client-side: the server only ever
 * returns its top-`pageSize` matches by text relevance, which has no relationship to favorite status, so a
 * favorited character/group can easily rank outside that page and never reach the client at all - no client-side
 * filter, however correct, can recover a result it was never sent.
 * @param {string} searchQuery The current search box value
 * @returns {Promise<void>}
 */
export async function fetchServerCharacterSearchResults(searchQuery) {
    if (!String(searchQuery ?? '').trim()) {
        entitiesFilter.setServerSearchResults(null);
        return;
    }

    const favOnly = isFilterState(entitiesFilter.getFilterData(FILTER_TYPES.FAV), FILTER_STATES.SELECTED);

    try {
        // pageSize mirrors the pre-existing /all-based call's own implicit cap (DEFAULT_PAGE_LIMIT, 500,
        // characters.js) - this is a UI-chrome/local-fallback data source, not the main list's own render (that
        // goes through printCharacters()'s server-paginated branch directly), so it only ever needs a bounded
        // top page, same as before.
        const result = await characterRepository.query(
            { search: searchQuery, includeGroups: true, ...(favOnly ? { fav: true } : {}) },
            { field: 'search' },
            1, 500, ['rows', 'total'],
        );

        const rows = Array.isArray(result.rows) ? result.rows : [];
        // `total` may be `~`-prefixed (design doc §5 decision 6, an approximate count under a capped search
        // candidate set) - stripped to a plain number here since every consumer of `serverSearchResults.total`
        // (printCharacters()'s fallback-path pagination navigator, filters.js) treats it as an ordinary number,
        // same convention printCharacters()'s server-paginated branch already uses for its own
        // `totalNumberLocator`.
        const parsedTotal = Number(String(result.total ?? 0).replace(/^~/, ''));
        const total = Number.isFinite(parsedTotal) ? parsedTotal : rows.length;
        const searchBackend = result.searchBackend;
        const characterScores = new Map();
        const groupScores = new Map();

        rows.forEach(({ type, item }, rank) => {
            if (type === 'character') {
                characterScores.set(item.avatar, rank);
            } else if (type === 'group') {
                groupScores.set(item.id, rank);
            }
        });

        entitiesFilter.setServerSearchResults({ searchValue: searchQuery, favOnly, characterScores, groupScores, total });

        const indicatorInfo = SEARCH_BACKEND_INDICATOR[searchBackend] ?? null;
        const indicator = $('#character_search_backend_indicator');
        indicator.toggle(Boolean(indicatorInfo));
        if (indicatorInfo) {
            indicator
                .attr('class', `fa-solid ${indicatorInfo.icon} ${indicatorInfo.tone}`)
                .attr('title', indicatorInfo.tooltip);
        }
        if (searchBackend !== lastKnownSearchBackend && indicatorInfo) {
            const toastFn = indicatorInfo.tone === 'error' ? toastr.error : toastr.warning;
            toastFn(indicatorInfo.tooltip, t`Search backend changed`, { timeOut: 0, extendedTimeOut: 0 });
        }
        lastKnownSearchBackend = searchBackend;
    } catch (error) {
        console.error('Server-side character search failed, falling back to client-side search', error);
        entitiesFilter.setServerSearchResults(null);
    }
}

/**
 * `label:value` labels recognized purely for turning a completed token into a visual pill in the search box
 * (see initCharacterSearch()) - mirrors the label sets characters-search-index.js's and groups-search-index.js's
 * `FIELD_LABELS` actually accept server-side, so a token only becomes a pill when the server will really treat
 * it as a filter, not for an arbitrary `word:value` (a URL, say) that would just be searched as a literal string
 * either way.
 * @type {Set<string>}
 */
const SEARCH_PILL_LABELS = new Set([
    'name', 'tag', 'tags', 'desc', 'description', 'example', 'scenario', 'personality',
    'greeting', 'notes', 'creator', 'alt', 'alternate', 'member', 'members', 'id',
]);

function initCharacterSearch() {
    /**
     * Completed `label:value` tokens already promoted out of the free-text input into a removable pill -
     * Discord's `from:`/`in:`/`has:` filter-chip interaction. Purely a display/editing convenience: pills are
     * reassembled back into the identical `label:value` text (currentSearchQuery() below) before being sent
     * anywhere, so the server-side parser (search-query.js) never needs to know pills exist.
     * @type {{ label: string, value: string }[]}
     */
    let searchPills = [];

    const debouncedCharacterSearch = debounce(async (searchQuery) => {
        await fetchServerCharacterSearchResults(searchQuery);
        entitiesFilter.setFilterData(FILTER_TYPES.SEARCH, searchQuery);
    });

    const searchForm = $('#form_character_search_form');
    const searchInput = $('#character_search_bar');
    const searchButton = $('#rm_button_search');
    const pillsContainer = $('#character_search_pills');

    const storageKey = 'characterSearchFormVisible';

    /** @returns {string} The full reconstructed `label:value ... freetext` search string. */
    function currentSearchQuery() {
        const pillText = searchPills.map(pill => `${pill.label}:${pill.value}`).join(' ');
        const freeText = String(searchInput.val());
        return [pillText, freeText].filter(Boolean).join(' ');
    }

    function renderPills() {
        pillsContainer.empty();
        searchPills.forEach((pill, index) => {
            const removeIcon = $('<i>').addClass('fa-solid fa-xmark search_pill_remove').attr('title', t`Remove filter`);
            removeIcon.on('click', function (event) {
                event.stopPropagation();
                searchPills.splice(index, 1);
                renderPills();
                debouncedCharacterSearch(currentSearchQuery());
            });
            const pillEl = $('<span>').addClass('search_pill')
                .append($('<span>').addClass('search_pill_label').text(`${pill.label}:`))
                .append($('<span>').addClass('search_pill_value').text(pill.value))
                .append(removeIcon);
            pillEl.on('click', function () {
                searchPills.splice(index, 1);
                const editText = `${pill.label}:${pill.value}`;
                const currentVal = String(searchInput.val());
                searchInput.val(currentVal ? editText + ' ' + currentVal : editText);
                renderPills();
                searchInput.trigger('focus');
                debouncedCharacterSearch(currentSearchQuery());
            });
            pillsContainer.append(pillEl);
        });
    }

    searchInput.on('input', function () {
        const raw = String($(this).val());
        // A trailing space means the token right before it is "completed" - if it's a recognized label:value,
        // promote it to a pill and strip it out of the input, same as Discord's filter-chip typing UX.
        if (raw.endsWith(' ')) {
            const trimmed = raw.slice(0, -1);
            // Match a complete label:value or label:"quoted value" at the end of the string,
            // respecting quotes so a space inside "quoted value" doesn't split the token.
            const pillMatch = trimmed.match(/(?:^|\s)([A-Za-z][A-Za-z0-9_]*):("[^"]*"|\S+)$/);
            if (pillMatch && SEARCH_PILL_LABELS.has(pillMatch[1].toLowerCase())) {
                searchPills.push({ label: pillMatch[1].toLowerCase(), value: pillMatch[2] });
                renderPills();
                // Keep everything before the matched token (pillMatch.index is the start
                // of the full match including the leading space/start-of-string anchor).
                searchInput.val(trimmed.slice(0, pillMatch.index));
            }
        }
        debouncedCharacterSearch(currentSearchQuery());
    });

    // Backspacing from an empty input removes the last pill as a unit, same as Discord's filter chips.
    searchInput.on('keydown', function (event) {
        if (event.key === 'Backspace' && searchInput.val() === '' && searchPills.length > 0) {
            searchPills.pop();
            renderPills();
            debouncedCharacterSearch(currentSearchQuery());
        }
    });

    searchButton.on('click', function () {
        const newVisibility = !searchForm.is(':visible');
        searchForm.toggle(newVisibility);
        searchButton.toggleClass('active', newVisibility);
        accountStorage.setItem(storageKey, String(newVisibility));
        if (newVisibility) {
            searchInput.trigger('focus');
        }
    });

    eventSource.on(event_types.APP_READY, () => {
        const isVisible = accountStorage.getItem(storageKey) === 'true';
        searchForm.toggle(isVisible);
        searchButton.toggleClass('active', isVisible);
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
    // Debounced save on every keystroke (including programmatic `.val(...).dispatchEvent(new Event('input'))`
    // calls elsewhere, e.g. slash commands filling the box) - see chat-draft.js for why an empty/whitespace
    // value clears the draft instead of persisting one, which is what makes this also handle "the draft's
    // chat got closed/emptied out from under it" without any extra code here.
    $('#send_textarea').on('input', () => saveDraftDebounced());

    // Restore whatever draft belongs to the chat that just became current - on first load and on every
    // subsequent chat switch alike, since CHAT_CHANGED fires for both. Only restores when a draft actually
    // exists for the *exact* now-current context, so switching to a chat with no saved draft never pulls in
    // a stale one from wherever the textarea happened to be left.
    // Editing a greeting changes the card, and an open chat's openings are the union of stored rows
    // and the card's current greetings - so it should show up there and then, not on the next load.
    eventSource.on(event_types.CHARACTER_EDITED, async (event) => {
        const edited = event?.detail?.character?.avatar;
        if (!edited || edited !== getCurrentCharacter()?.avatar) return;
        await _mergeCardGreetingsIntoOpening();
    });

    eventSource.on(event_types.CHAT_CHANGED, () => {
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

    $(document).on('click', '.branch_left', async function (e) {
        e.preventDefault();
        e.stopPropagation();
        const mesId = Number($(this).closest('.mes').attr('mesid'));
        const { branchSwipe } = await import('./scripts/bookmarks.js');
        await branchSwipe(mesId, -1);
    });
    $(document).on('click', '.branch_right', async function (e) {
        e.preventDefault();
        e.stopPropagation();
        const mesId = Number($(this).closest('.mes').attr('mesid'));
        const { branchSwipe } = await import('./scripts/bookmarks.js');
        await branchSwipe(mesId, 1);
    });

    initCharacterSearch();

    $('#mes_impersonate').on('click', function () {
        $('#option_impersonate').trigger('click');
    });

    $('#mes_continue').on('click', function () {
        $('#option_continue').trigger('click');
    });

    $('#send_but').on('click', async function () {
        await userInputGenerateMutex.update();
    });

    //menu buttons setup

    $('#rm_button_settings').on('click', function () {
        selected_button = 'settings';
        selectRightMenuWithAnimation('rm_api_block');
    });
    $('#rm_button_characters').on('click', function () {
        selected_button = 'characters';
        select_rm_characters();
    });
    $('#rm_button_back').on('click', function () {
        selected_button = 'characters';
        select_rm_characters();
    });
    $('#rm_button_create').on('click', function () {
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
        $('#character_search_bar').val('').trigger('input');
    });

    $(document).on('click', '.character_select', async function () {
        // Origin point of character selection - resolve by avatar (the stable id), the only identifier a
        // character row carries.
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
     * Handles the deletion of a chat file, including group chats.
     *
     * Deleting a chat that isn't the one currently loaded doesn't change any other on-screen state - the
     * modal's list is the only thing affected, so the deleted row is just removed from the already-open
     * modal instead of tearing the whole thing down and refetching every chat again (that used to close the
     * popup, wait out a flat 2s "edge case" delay, then rebuild the full list from scratch - painful with
     * hundreds/thousands of chats on one character). Deleting the *active* chat is a real exception: the
     * delete call itself swaps in a different chat (or a fresh one), so the main chat view and the modal's
     * highlighted row both genuinely need to reflect that - hence the full-refresh path stays for that case.
     *
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

        // Local removal only applies when a modal row is on hand, the deleted chat isn't loaded anywhere
        // else in the UI, and this isn't the slash-command path (which has its own no-modal handling).
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
        // The node it sits on, when there is one. Deleting removes the bookmark; a name would only
        // find whichever row sorted first.
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

    $('#advanced_div').on('click', function () {
        if (!is_advanced_char_open) {
            is_advanced_char_open = true;
            $('#character_popup').css({ 'display': 'flex', 'opacity': 0.0 }).addClass('open');
            $('#character_popup').transition({
                opacity: 1.0,
                duration: animation_duration,
                easing: animation_easing,
            });
        } else {
            is_advanced_char_open = false;
            $('#character_popup').css('display', 'none').removeClass('open');
        }
    });

    $('#character_cross').on('click', function () {
        is_advanced_char_open = false;
        $('#character_popup').transition({
            opacity: 0,
            duration: animation_duration,
            easing: animation_easing,
        });
        setTimeout(function () { $('#character_popup').css('display', 'none'); }, animation_duration);
    });

    $('#character_popup_ok').on('click', function () {
        is_advanced_char_open = false;
        $('#character_popup').css('display', 'none');
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

    $('#form_create').on('submit', (e) => createOrEditCharacter(e.originalEvent));

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
        '#description_textarea': function () { create_save.description = String($('#description_textarea').val()); },
        '#creator_notes_textarea': function () { create_save.creator_notes = String($('#creator_notes_textarea').val()); },
        '#character_version_textarea': function () { create_save.character_version = String($('#character_version_textarea').val()); },
        '#system_prompt_textarea': function () { create_save.system_prompt = String($('#system_prompt_textarea').val()); },
        '#post_history_instructions_textarea': function () { create_save.post_history_instructions = String($('#post_history_instructions_textarea').val()); },
        '#creator_textarea': function () { create_save.creator = String($('#creator_textarea').val()); },
        '#tags_textarea': function () { create_save.tags = String($('#tags_textarea').val()); },
        '#personality_textarea': function () { create_save.personality = String($('#personality_textarea').val()); },
        '#scenario_pole': function () { create_save.scenario = String($('#scenario_pole').val()); },
        '#mes_example_textarea': function () { create_save.mes_example = String($('#mes_example_textarea').val()); },
        '#talkativeness_slider': function () { create_save.talkativeness = Number($('#talkativeness_slider').val()); },
        '#depth_prompt_prompt': function () { create_save.depth_prompt_prompt = String($('#depth_prompt_prompt').val()); },
        '#depth_prompt_depth': function () { create_save.depth_prompt_depth = Number($('#depth_prompt_depth').val()); },
        '#depth_prompt_role': function () { create_save.depth_prompt_role = String($('#depth_prompt_role').val()); },
    };

    Object.keys(elementsToUpdate).forEach(function (id) {
        $(id).on('input', function () {
            if (menu_type == 'create') {
                elementsToUpdate[id]();
            } else {
                saveCharacterDebounced();
            }
        });
    });

    // Greeting pager: steps through the stable-order greeting list in the sidebar, editing whichever
    // one is currently shown. See setGreetingPagerGreetings() and friends above.
    $('#greeting_field').on('input', function () {
        const value = String($(this).val());
        const { index, defaultIndex } = greetingPagerState;
        greetingPagerState.greetings[index] = value;
        if (menu_type === 'create') {
            const fields = greetingsModelToCardFields({ greetings: greetingPagerState.greetings, defaultIndex });
            create_save.first_message = fields.firstMes;
            create_save.alternate_greetings = stripEmptyAlternateGreetings(fields.alternateGreetings, 'greeting pager create-mode input');
        } else {
            saveGreetingPagerEditDebounced(index, value);
        }
    });

    $('.greeting-pager-prev').on('click', function () {
        if ($(this).hasClass('disabled')) return;
        navigateGreetingPager(greetingPagerState.index - 1);
    });

    $('.greeting-pager-next').on('click', function () {
        if ($(this).hasClass('disabled')) return;
        navigateGreetingPager(greetingPagerState.index + 1);
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

    $('#creator_notes_textarea').on('input', function () {
        const notes = String($('#creator_notes_textarea').val());
        const avatar = menu_type === 'create' ? '' : getCurrentCharacter()?.avatar;
        $('#creator_notes_spoiler').html(formatCreatorNotes(notes, avatar));
    });

    $('#favorite_button').on('click', async function () {
        const newState = !fav_ch_checked;
        updateFavButtonState(newState);
        if (menu_type == 'create') {
            // No row exists yet - the state just toggled here rides along in the create request's own `fav`
            // field (createOrEditCharacter()'s formData.set('fav', ...)) and gets seeded once the row is
            // actually INSERTed - see the server's /create route.
            return;
        }
        // Favorite status is a pure metadata-store mutation now (owner decision - see character-metadata-db.js's
        // setCharacterFav() doc comment), not a card-file edit - this used to fold into the full debounced
        // saveCharacterDebounced() card save; now it's its own immediate, targeted write.
        const character = getCurrentCharacter();
        if (!character?.avatar) return;
        try {
            const response = await fetch('/api/characters/fav', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ avatar: character.avatar, fav: newState }),
            });
            if (!response.ok) throw new Error(String(response.status));
            // Same "refresh this one character" idiom the merge-attributes-based edit flows already use
            // (slash-commands.js's /char-attribute, createOrEditCharacter() above) - keeps charactersStore's
            // copy (and anything derived from it, e.g. the character list) in sync with what the db now has.
            await getOneCharacter(character.avatar);
            printCharactersDebounced();
            favsToHotswap();
        } catch (error) {
            console.error('Failed to update favorite status', error);
            toastr.error(t`Failed to update favorite status.`);
            updateFavButtonState(!newState);
        }
    });

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
        await saveChatConditional();
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
            // Cutting a chat back to a point is the store's "this ends here", said on the message it
            // now ends at. The messages below keep their rows and their own continuations; selecting
            // one again brings the whole thing back.
            if (chat_metadata?._tree_stored && chat.length > 0) {
                await chatOpEndPath(chat.length - 1).catch(error =>
                    console.error('Could not cut the conversation back:', error));
            }
            await saveChatConditional();
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
            setValue: (val) => { amount_gen = Number(val); },
        },
        {
            sliderId: '#max_context',
            counterId: '#max_context_counter',
            format: (val) => `${val}`,
            setValue: (val) => { max_context = Number(val); },
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

    // Save the edit as a NEW alternative instead of over the original. The original keeps its row and
    // its children; the new one starts its own, so continuing from here forks rather than overwrites.
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

        // Forking beside a card-only greeting is one of the things that earns it a row: there has to
        // be something for the new alternative to be a sibling OF.
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
        // `mes` has to move onto the new alternative too, not just the slot bookkeeping. The editor is
        // about to be closed by messageEditCancel(), which redraws from `mes` - and switchToAlternativePath()
        // only adopts the node and the swipe index, it never touches the text. Leaving `mes` on the old
        // wording made the edit look discarded: the new row held it, the screen did not. The swipe-arrow
        // path avoids this by calling syncMesToSwipe() before switching; this one had no equivalent.
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

        chat.splice(Number(this_edit_mes_id) + 1, 0, clone);
        const newMessageElement = updateMessageElement(clone);
        this_edit_mes_element.after(newMessageElement);

        updateViewMessageIds();
        await saveChatConditional();
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

        // Shares processDroppedFiles()'s per-card import+tag-interleave and batch-import-mode gating - this
        // handler (the "Import Character" file-picker button) is the exact same bulk-import shape as a
        // drag-and-drop, just with a different trigger, so it reuses that logic outright instead of keeping a
        // second, independently-drifting copy of it.
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

        // Save before exporting
        await createOrEditCharacter();
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
            '#character_cross',
            '#avatar-and-name-block',
            '#shadow_popup',
            '.popup',
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
                $openDrawers.toggleClass('closedDrawer openDrawer');
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
        drawerContent.stop().slideToggle({
            complete: () => {
                $(this).css('height', '');
            },
        });

        // Set the height of "autoSetHeight" textareas within the inline-drawer to their scroll height
        if (!CSS.supports('field-sizing', 'content')) {
            const textareas = drawerContent.find('textarea.autoSetHeight');
            for (const textarea of textareas) {
                await resetScrollHeight($(textarea));
            }
        }
    });

    $(document).on('click', '.inline-drawer-maximize', function () {
        const icon = $(this).find('.inline-drawer-icon, .floating_panel_maximize');
        icon.toggleClass('fa-window-maximize fa-window-restore');
        const drawerContent = $(this).closest('.drawer-content');
        drawerContent.toggleClass('maximized');
        const drawerId = drawerContent.attr('id');
        resetMovableStyles(drawerId);
    });

    $(document).on('click', '.mes .avatar', function () {
        const messageElement = $(this).closest('.mes');
        const thumbURL = $(this).children('img').attr('src');
        const charsPath = '/characters/';
        // Pull the `file=` query param specifically, not "whatever's after the last =" - getThumbnailUrl()
        // can append a trailing `&v=<version>` or `&t=<timestamp>` after `file=`, and grabbing the last `=`
        // segment would then yield that cache-busting value instead of the avatar filename.
        // URL/URLSearchParams decodes the param value, so re-encode it to keep the same raw-encoded contract
        // downstream code already relies on (decodeURIComponent(targetAvatarImg) calls, charsPath + targetAvatarImg
        // used directly as an <img> src). Falls back to the old last-= slice for non-thumbnail src values
        // (data URLs, plain paths without a file= param).
        let targetAvatarImg;
        try {
            const fileParam = new URL(thumbURL, window.location.origin).searchParams.get('file');
            targetAvatarImg = fileParam !== null ? encodeURIComponent(fileParam) : thumbURL.substring(thumbURL.lastIndexOf('=') + 1);
        } catch {
            targetAvatarImg = thumbURL.substring(thumbURL.lastIndexOf('=') + 1);
        }
        const charname = targetAvatarImg.replace('.png', '');
        const isValidCharacter = characters.some(x => x.avatar === decodeURIComponent(targetAvatarImg));

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
        if (e.key === 'Escape' && !e.originalEvent.isComposing) {
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
                saveCharacterDebounced();
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
            saveSettingsDebounced('power_user.charGalleryFullscreen');
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
