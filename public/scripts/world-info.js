import { Fuse } from '../lib.js';

import { takeServerSettings, saveSettingsDebounced, substituteParams, getCurrentCharacter, saveCharacterField, characterFieldBaseline, menu_type, saveMetadata, getCurrentChatId, extension_prompt_roles, create_save, select_selected_character } from '../script.js';
import { getOneCharacter } from './character-list.js';
import { name1 } from './app-selection-state.js';
import { chat, chat_metadata } from './chat-state.js';
import { getRequestHeaders } from './request-headers.js';
import { charactersStore } from './character-store.js';
import { eventSource, event_types } from './events.js';
import { download, debounce, initScrollHeight, resetScrollHeight, parseJsonFile, extractDataFromPng, getFileBuffer, getCharaFilename, getSortableDelay, PAGINATION_TEMPLATE, navigation_option, waitUntilCondition, isTrueBoolean, setValueByPath, flashHighlight, select2ModifyOptions, getSelect2OptionId, dynamicSelect2DataViaAjax, highlightRegex, select2ChoiceClickSubscribe, isFalseBoolean, getSanitizedFilename, checkOverwriteExistingData, getStringHash, parseStringArray, cancelDebounce, findCharAsync, onlyUnique, equalsIgnoreCaseAndAccents, uuidv4, normalizeArray, logSlashCommandWarn, addLongPressEvent, escapeHtml, setInfoBlock, clearInfoBlock } from './utils.js';
import { selected_group } from './group-chats.js';
import { isMobile } from './RossAscends-mods.js';
import { FILTER_TYPES, FilterHelper } from './filters.js';
import { getTokenCountWithAnswer } from './tokenizers.js';
import { renderCountBasis } from './tokenizer-notices.js';
import { power_user, personaStore } from './power-user.js';
import { findTagsByNames, readTagsForIds, searchTagsByName, tagsStore } from './tags.js';
import { debounce_timeout, GENERATION_TYPE_TRIGGERS } from './constants.js';
import { SlashCommandParser } from './slash-commands/SlashCommandParser.js';
import { SlashCommand } from './slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from './slash-commands/SlashCommandArgument.js';
import { SlashCommandEnumValue, enumTypes } from './slash-commands/SlashCommandEnumValue.js';
import { commonEnumProviders, enumIcons } from './slash-commands/SlashCommandCommonEnumsProvider.js';
import { SlashCommandClosure } from './slash-commands/SlashCommandClosure.js';
import { callGenericPopup, Popup, POPUP_RESULT, POPUP_TYPE } from './popup.js';
import { StructuredCloneMap } from './util/StructuredCloneMap.js';
import { jsonHash } from './hash-utils.js';
import { renderTemplateAsync } from './templates.js';
import { t } from './i18n.js';
import { accountStorage } from './util/AccountStorage.js';
import { getOrCreatePersonaDescriptor, getPersonaDescriptionLorebook, setPersonaDescription, user_avatar } from './personas.js';
import { characterRepository } from './character-repository.js';
import { checkCharactersExistOrNull } from './character-existence-check.js';
import { character_world_link, resolveCharacterWorldLink } from './character-world-link.js';
import { bindFieldDraft, clearDraftsUnder, clearThingDrafts, hasFieldDrafts, readFieldDraft, revertChanges, writeFieldDraft } from './field-drafts.js';
import { isUserEvent } from './live-editor/registry.js';
import { WORLD_INFO_GLOBAL_DEFAULTS } from './world-info-globals.js';

/**
 * @returns {boolean}
 */
function isWorldInfoTracingEnabled() {
    return localStorage.getItem('worldInfoTracing') === 'true';
}

const world_info_insertion_strategy = {
    evenly: 0,
    character_first: 1,
    global_first: 2,
};

const world_info_logic = {
    AND_ANY: 0,
    NOT_ALL: 1,
    NOT_ANY: 2,
    AND_ALL: 3,
};

const WI_ENTRY_HEADER_TEMPLATE = $('#entry_edit_template .world_entry');
const WI_ENTRY_EDIT_TEMPLATE = $('#entry_edit_template .world_entry_edit');

export let world_info = {};
export let selected_world_info = [];
/** @type {string[]} */
export let world_names;
let world_info_depth = WORLD_INFO_GLOBAL_DEFAULTS.world_info_depth;
let world_info_min_activations = WORLD_INFO_GLOBAL_DEFAULTS.world_info_min_activations;
let world_info_min_activations_depth_max = WORLD_INFO_GLOBAL_DEFAULTS.world_info_min_activations_depth_max;

let world_info_budget = WORLD_INFO_GLOBAL_DEFAULTS.world_info_budget;
let world_info_include_names = WORLD_INFO_GLOBAL_DEFAULTS.world_info_include_names;
let world_info_recursive = WORLD_INFO_GLOBAL_DEFAULTS.world_info_recursive;
export let world_info_overflow_alert = WORLD_INFO_GLOBAL_DEFAULTS.world_info_overflow_alert;
let world_info_case_sensitive = WORLD_INFO_GLOBAL_DEFAULTS.world_info_case_sensitive;
let world_info_match_whole_words = WORLD_INFO_GLOBAL_DEFAULTS.world_info_match_whole_words;
let world_info_use_group_scoring = WORLD_INFO_GLOBAL_DEFAULTS.world_info_use_group_scoring;
let world_info_character_strategy = WORLD_INFO_GLOBAL_DEFAULTS.world_info_character_strategy;
let world_info_budget_cap = WORLD_INFO_GLOBAL_DEFAULTS.world_info_budget_cap;
let world_info_max_recursion_steps = WORLD_INFO_GLOBAL_DEFAULTS.world_info_max_recursion_steps;
/** @type {Map<string, {data: any, save: () => void}>} */
const pendingWorldSaves = new Map();

/**
 * @param {string} name
 * @param {any} data
 */
function saveWorldDebounced(name, data) {
    let pending = pendingWorldSaves.get(name);
    if (!pending) {
        const entry = {
            data,
            save: debounce(async () => {
                if (pendingWorldSaves.get(name) === entry) {
                    pendingWorldSaves.delete(name);
                }
                try {
                    await _save(name, entry.data);
                } catch {
                    // _save has already shown and logged the failure.
                }
            }, debounce_timeout.relaxed),
        };
        pending = entry;
        pendingWorldSaves.set(name, pending);
    }
    pending.data = data;
    pending.save();
}

/**
 * @param {string} name
 */
function cancelWorldSaveDebounced(name) {
    const pending = pendingWorldSaves.get(name);
    if (!pending) {
        return;
    }
    cancelDebounce(pending.save);
    pendingWorldSaves.delete(name);
}

/** @type {Map<string, Set<Promise<unknown>>>} */
const worldWritesInFlight = new Map();

/**
 * @template T
 * @param {string} name
 * @param {Promise<T>} request
 * @returns {Promise<T>}
 */
function trackWorldWrite(name, request) {
    let writes = worldWritesInFlight.get(name);
    if (!writes) {
        writes = new Set();
        worldWritesInFlight.set(name, writes);
    }
    writes.add(request);
    const settled = () => {
        writes.delete(request);
        if (writes.size === 0 && worldWritesInFlight.get(name) === writes) {
            worldWritesInFlight.delete(name);
        }
    };
    request.then(settled, settled);
    return request;
}

/**
 * @param {string} name
 * @returns {Promise<void>}
 */
async function worldWritesSettled(name) {
    let writes;
    while ((writes = worldWritesInFlight.get(name))) {
        await Promise.allSettled([...writes]);
    }
}
const sortFn = (a, b) => b.order - a.order;
let updateEditor = (navigation, flashOnNav = true) => { console.debug('Triggered WI navigation', navigation, flashOnNav); };
let worldInfoOneTimeInitDone = false;

// Do not optimize. updateEditor is a function that is updated by the displayWorldEntries with new data.
const worldInfoFilter = new FilterHelper(() => updateEditor());
const SORT_ORDER_KEY = 'world_info_sort_order';
export const METADATA_KEY = 'world_info';

const DEFAULT_DEPTH = 4;
const DEFAULT_WEIGHT = 100;
const MAX_SCAN_DEPTH = 1000;
const MAX_COMMENT_LENGTH = 100;
const KNOWN_DECORATORS = ['@@activate', '@@dont_activate'];

// Typedef area
/**
 * @typedef {object} WIGlobalScanData The chat-independent data to be scanned. Each of
 *     these fields can be enabled for scanning per entry.
 * @property {string} personaDescription User persona description
 * @property {string} characterDescription Character description
 * @property {string} characterPersonality Character personality
 * @property {string} characterDepthPrompt Character depth prompt (sometimes referred to as character notes)
 * @property {string} scenario Character defined scenario
 * @property {string} creatorNotes Character creator notes
 * @property {string} trigger The type that triggered the scan, e.g. 'normal', 'continue', etc.
 */

/**
 * @typedef {object} WIScanEntry The entry that triggered the scan
 * @property {number} [scanDepth] The depth of the scan
 * @property {boolean} [caseSensitive] If the scan is case sensitive
 * @property {boolean} [matchWholeWords] If the scan should match whole words
 * @property {boolean} [useGroupScoring] If the scan should use group scoring
 * @property {boolean} [matchPersonaDescription] If the scan should match against the persona description
 * @property {boolean} [matchCharacterDescription] If the scan should match against the character description
 * @property {boolean} [matchCharacterPersonality] If the scan should match against the character personality
 * @property {boolean} [matchCharacterDepthPrompt] If the scan should match against the character depth prompt
 * @property {boolean} [matchScenario] If the scan should match against the character scenario
 * @property {boolean} [matchCreatorNotes] If the scan should match against the creator notes
 * @property {number} [uid] The UID of the entry that triggered the scan
 * @property {string} [world] The world info book of origin of the entry
 * @property {string[]} [key] The primary keys to scan for
 * @property {string[]} [keysecondary] The secondary keys to scan for
 * @property {number} [selectiveLogic] The logic to use for selective activation
 * @property {number} [sticky] The sticky value of the entry
 * @property {number} [cooldown] The cooldown of the entry
 * @property {number} [delay] The delay of the entry
 * @property {string[]} [decorators] Array of decorators for the entry
 * @property {number} [hash] The hash of the entry
 */

/**
 * @typedef {object} WITimedEffect Timed effect for world info
 * @property {number} hash Hash of the entry that triggered the effect
 * @property {number} start The chat index where the effect starts
 * @property {number} end The chat index where the effect ends
 * @property {boolean} protected The protected effect can't be removed if the chat does not advance
 */

/**
 * @typedef TimedEffectType Type of timed effect
 * @type {'sticky'|'cooldown'|'delay'}
 */

/**
 * @typedef {object} WIPromptResult
 * @property {string} worldInfoString - Complete world info string
 * @property {string} worldInfoBefore - World info that goes before the prompt
 * @property {string} worldInfoAfter - World info that goes after the prompt
 * @property {Array} worldInfoExamples - Array of example entries
 * @property {Array} worldInfoDepth - Array of depth entries
 * @property {Array} anBefore - Array of entries before Author's Note
 * @property {Array} anAfter - Array of entries after Author's Note
 * @property {{[key: string]: string[]}} outletEntries - Array of entries to be added to an outlet
 */

/**
 * @typedef {object} WIActivated
 * @property {string} worldInfoBefore The world info before the chat.
 * @property {string} worldInfoAfter The world info after the chat.
 * @property {any[]} EMEntries The entries for examples.
 * @property {any[]} WIDepthEntries The depth entries.
 * @property {any[]} ANBeforeEntries The entries before Author's Note.
 * @property {any[]} ANAfterEntries The entries after Author's Note.
 * @property {{[key: string]: string[]}} outletEntries - Array of entries to be added to an outlet
 * @property {Set<any>} allActivatedEntries All entries.
 */

/**
 * @typedef {object} WIEntryFieldDefinition
 * @property {any} default - Default value for the field
 * @property {string} type - Type of the field, can be 'string', 'number', 'boolean', 'array', 'enum'
 * @property {boolean} [excludeFromTemplate=false] - Whether to exclude this field from the template
 * @property {(value: any) => boolean} [arrayFilter] - Optional filter function for array fields to filter out unwanted values
 */
// End typedef area

/**
 * Represents a timed effects manager for World Info.
 */
class WorldInfoTimedEffects {
    /**
     * Array of chat messages.
     * @type {string[]}
     */
    #chat = [];

    /**
     * Array of entries.
     * @type {WIScanEntry[]}
     */
    #entries = [];

    /**
     * Is this a dry run?
     * @type {boolean}
     */
    #isDryRun = false;

    /**
     * Buffer for active timed effects.
     * @type {Record<TimedEffectType, WIScanEntry[]>}
     */
    #buffer = {
        'sticky': [],
        'cooldown': [],
        'delay': [],
    };

    /**
     * Callbacks for effect types ending.
     * @type {Record<TimedEffectType, (entry: WIScanEntry) => void>}
     */
    #onEnded = {
        /**
         * Callback for when a sticky entry ends.
         * Sets an entry on cooldown immediately if it has a cooldown.
         * @param {WIScanEntry} entry Entry that ended sticky
         */
        'sticky': (entry) => {
            if (!entry.cooldown) {
                return;
            }

            const key = this.#getEntryKey(entry);
            const effect = this.#getEntryTimedEffect('cooldown', entry, true);
            chat_metadata.timedWorldInfo.cooldown[key] = effect;
            console.log(`[WI] Adding cooldown entry ${key} on ended sticky: start=${effect.start}, end=${effect.end}, protected=${effect.protected}`);
            // Set the cooldown immediately for this evaluation
            this.#buffer.cooldown.push(entry);
        },

        /**
         * Callback for when a cooldown entry ends.
         * No-op, essentially.
         * @param {WIScanEntry} entry Entry that ended cooldown
         */
        'cooldown': (entry) => {
            if (isWorldInfoTracingEnabled()) console.debug('[WI] Cooldown ended for entry', entry.uid);
        },

        'delay': () => { },
    };

    /**
     * Initialize the timed effects with the given messages.
     * @param {string[]} chat Array of chat messages
     * @param {WIScanEntry[]} entries Array of entries
     * @param {boolean} isDryRun Whether the operation is a dry run
     */
    constructor(chat, entries, isDryRun = false) {
        this.#chat = chat;
        this.#entries = entries;
        this.#isDryRun = isDryRun;
        this.#ensureChatMetadata();
    }

    /**
     * Verify correct structure of chat metadata.
     */
    #ensureChatMetadata() {
        if (!chat_metadata.timedWorldInfo) {
            chat_metadata.timedWorldInfo = {};
        }

        ['sticky', 'cooldown'].forEach(type => {
            // Ensure the property exists and is an object
            if (!chat_metadata.timedWorldInfo[type] || typeof chat_metadata.timedWorldInfo[type] !== 'object') {
                chat_metadata.timedWorldInfo[type] = {};
            }

            // Clean up invalid entries
            Object.entries(chat_metadata.timedWorldInfo[type]).forEach(([key, value]) => {
                if (!value || typeof value !== 'object') {
                    delete chat_metadata.timedWorldInfo[type][key];
                }
            });
        });
    }

    /**
    * Gets a hash for a WI entry.
    * @param {WIScanEntry} entry WI entry
    * @returns {number} String hash
    */
    #getEntryHash(entry) {
        return entry.hash;
    }

    /**
     * Gets a unique-ish key for a WI entry.
     * @param {WIScanEntry} entry WI entry
     * @returns {string} String key for the entry
     */
    #getEntryKey(entry) {
        return `${entry.world}.${entry.uid}`;
    }

    /**
     * Gets a timed effect for a WI entry.
     * @param {TimedEffectType} type Type of timed effect
     * @param {WIScanEntry} entry WI entry
     * @param {boolean} isProtected If the effect should be protected
     * @returns {WITimedEffect} Timed effect for the entry
     */
    #getEntryTimedEffect(type, entry, isProtected) {
        return {
            hash: this.#getEntryHash(entry),
            start: this.#chat.length,
            end: this.#chat.length + Number(entry[type]),
            protected: !!isProtected,
        };
    }

    /**
     * Processes entries for a given type of timed effect.
     * @param {TimedEffectType} type Identifier for the type of timed effect
     * @param {WIScanEntry[]} buffer Buffer to store the entries
     * @param {(entry: WIScanEntry) => void} onEnded Callback for when a timed effect ends
     */
    #checkTimedEffectOfType(type, buffer, onEnded) {
        /** @type {[string, WITimedEffect][]} */
        const effects = Object.entries(chat_metadata.timedWorldInfo[type]);
        for (const [key, value] of effects) {
            console.log(`[WI] Processing ${type} entry ${key}`, value);
            const entry = this.#entries.find(x => String(this.#getEntryHash(x)) === String(value.hash));

            if (this.#chat.length <= Number(value.start) && !value.protected) {
                console.log(`[WI] Removing ${type} entry ${key} from timedWorldInfo: chat not advanced`, value);
                delete chat_metadata.timedWorldInfo[type][key];
                continue;
            }

            // Missing entries (they could be from another character's lorebook)
            if (!entry) {
                if (this.#chat.length >= Number(value.end)) {
                    console.log(`[WI] Removing ${type} entry from timedWorldInfo: entry not found and interval passed`, entry);
                    delete chat_metadata.timedWorldInfo[type][key];
                }
                continue;
            }

            // Ignore invalid entries (not configured for timed effects)
            if (!entry[type]) {
                console.log(`[WI] Removing ${type} entry from timedWorldInfo: entry not ${type}`, entry);
                delete chat_metadata.timedWorldInfo[type][key];
                continue;
            }

            if (this.#chat.length >= Number(value.end)) {
                console.log(`[WI] Removing ${type} entry from timedWorldInfo: ${type} interval passed`, entry);
                delete chat_metadata.timedWorldInfo[type][key];
                if (typeof onEnded === 'function') {
                    onEnded(entry);
                }
                continue;
            }

            buffer.push(entry);
            console.log(`[WI] Timed effect "${type}" applied to entry`, entry);
        }
    }

    /**
     * Processes entries for the "delay" timed effect.
     * @param {WIScanEntry[]} buffer Buffer to store the entries
     */
    #checkDelayEffect(buffer) {
        for (const entry of this.#entries) {
            if (!entry.delay) {
                continue;
            }

            if (this.#chat.length < entry.delay) {
                buffer.push(entry);
                console.log('[WI] Timed effect "delay" applied to entry', entry);
            }
        }
    }

    /**
     * Checks for timed effects on chat messages.
     */
    checkTimedEffects() {
        if (!this.#isDryRun) {
            this.#checkTimedEffectOfType('sticky', this.#buffer.sticky, this.#onEnded.sticky.bind(this));
            this.#checkTimedEffectOfType('cooldown', this.#buffer.cooldown, this.#onEnded.cooldown.bind(this));
        }
        this.#checkDelayEffect(this.#buffer.delay);
    }

    /**
     * Gets raw timed effect metadatum for a WI entry.
     * @param {TimedEffectType} type Type of timed effect
     * @param {WIScanEntry} entry WI entry
     * @returns {WITimedEffect} Timed effect for the entry
     */
    getEffectMetadata(type, entry) {
        if (!this.isValidEffectType(type)) {
            return null;
        }

        const key = this.#getEntryKey(entry);
        return chat_metadata.timedWorldInfo[type][key];
    }

    /**
     * Sets a timed effect for a WI entry.
     * @param {TimedEffectType} type Type of timed effect
     * @param {WIScanEntry} entry WI entry to check
     */
    #setTimedEffectOfType(type, entry) {
        // Skip if entry does not have the type (sticky or cooldown)
        if (!entry[type]) {
            return;
        }

        const key = this.#getEntryKey(entry);

        if (!chat_metadata.timedWorldInfo[type][key]) {
            const effect = this.#getEntryTimedEffect(type, entry, false);
            chat_metadata.timedWorldInfo[type][key] = effect;

            console.log(`[WI] Adding ${type} entry ${key}: start=${effect.start}, end=${effect.end}, protected=${effect.protected}`);
        }
    }

    /**
     * Sets timed effects on chat messages.
     * @param {WIScanEntry[]} activatedEntries Entries that were activated
     */
    setTimedEffects(activatedEntries) {
        if (this.#isDryRun) return;
        for (const entry of activatedEntries) {
            this.#setTimedEffectOfType('sticky', entry);
            this.#setTimedEffectOfType('cooldown', entry);
        }
    }

    /**
     * Force set a timed effect for a WI entry.
     * @param {TimedEffectType} type Type of timed effect
     * @param {WIScanEntry} entry WI entry
     * @param {boolean} newState The state of the effect
     */
    setTimedEffect(type, entry, newState) {
        if (!this.isValidEffectType(type)) {
            return;
        }
        if (this.#isDryRun && type !== 'delay') {
            return;
        }

        const key = this.#getEntryKey(entry);
        delete chat_metadata.timedWorldInfo[type][key];

        if (newState) {
            const effect = this.#getEntryTimedEffect(type, entry, false);
            chat_metadata.timedWorldInfo[type][key] = effect;
            console.log(`[WI] Adding ${type} entry ${key}: start=${effect.start}, end=${effect.end}, protected=${effect.protected}`);
        }
    }

    /**
     * Check if the string is a valid timed effect type.
     * @param {string} type Name of the timed effect
     * @returns {boolean} Is recognized type
     */
    isValidEffectType(type) {
        return typeof type === 'string' && ['sticky', 'cooldown', 'delay'].includes(type.trim().toLowerCase());
    }

    /**
     * Check if the current entry is sticky activated.
     * @param {TimedEffectType} type Type of timed effect
     * @param {WIScanEntry} entry WI entry to check
     * @returns {boolean} True if the entry is active
     */
    isEffectActive(type, entry) {
        if (!this.isValidEffectType(type)) {
            return false;
        }

        return this.#buffer[type]?.some(x => this.#getEntryHash(x) === this.#getEntryHash(entry)) ?? false;
    }

    /**
     * Clean-up previously set timed effects.
     */
    cleanUp() {
        for (const buffer of Object.values(this.#buffer)) {
            buffer.splice(0, buffer.length);
        }
    }
}

export function getWorldInfoSettings() {
    return {
        world_info: { ...world_info, globalSelect: selected_world_info },
        world_info_depth,
        world_info_min_activations,
        world_info_min_activations_depth_max,
        world_info_budget,
        world_info_include_names,
        world_info_recursive,
        world_info_overflow_alert,
        world_info_case_sensitive,
        world_info_match_whole_words,
        world_info_character_strategy,
        world_info_budget_cap,
        world_info_use_group_scoring,
        world_info_max_recursion_steps,
    };
}

const world_info_position = {
    before: 0,
    after: 1,
    ANTop: 2,
    ANBottom: 3,
    atDepth: 4,
    EMTop: 5,
    EMBottom: 6,
    outlet: 7,
};

/**
 * The cache of all world info data that was loaded from the backend.
 *
 * Calling `loadWorldInfo` will fill this cache and utilize this cache, so should be the preferred way to load any world info data.
 * Only use the cache directly if you need synchronous access.
 *
 * This will return a deep clone of the data, so no way to modify the data without actually saving it.
 * Should generally be only used for readonly access.
 *
 * @type {StructuredCloneMap<string,object>}
 * */
/**
 * @typedef {{ entries: Map<string, number>, fields: Map<string, number> }} BookVersion
 * @type {Map<string, BookVersion>}
 */
const bookVersions = new Map();

class WorldInfoCache extends StructuredCloneMap {
    /** @param {string} key */
    delete(key) {
        bookVersions.delete(key);
        return super.delete(key);
    }

    clear() {
        bookVersions.clear();
        super.clear();
    }
}

export const worldInfoCache = new WorldInfoCache({ cloneOnGet: true, cloneOnSet: false });

/**
 * @param {any} book
 * @returns {BookVersion}
 */
function versionOf(book) {
    /** @type {BookVersion} */
    const version = { entries: new Map(), fields: new Map() };
    for (const [uid, entry] of Object.entries(book?.entries ?? {})) {
        version.entries.set(uid, jsonHash(entry));
    }
    for (const [key, value] of Object.entries(book ?? {})) {
        if (key !== 'entries' && value !== undefined) version.fields.set(key, jsonHash(value));
    }
    return version;
}

/**
 * @param {string} name
 * @param {string|number} uid
 * @param {any} entry
 */
function noteStoredEntry(name, uid, entry) {
    const version = bookVersions.get(name);
    if (!version) return;
    if (entry == null) version.entries.delete(String(uid));
    else version.entries.set(String(uid), jsonHash(entry));
}

/**
 * @param {string} name
 * @returns {Promise<BookVersion>}
 */
async function fetchBookVersion(name) {
    const response = await fetch('/api/worldinfo/get', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ name }),
        cache: 'no-cache',
    });
    if (!response.ok) throw new Error(`/api/worldinfo/get responded ${response.status}`);
    noteBookId(name, response);
    return versionOf(await response.json());
}

export function setWorldInfoSettings(settings, data) {
    if (settings.world_info_depth !== undefined)
        world_info_depth = Number(settings.world_info_depth);
    if (settings.world_info_min_activations !== undefined)
        world_info_min_activations = Number(settings.world_info_min_activations);
    if (settings.world_info_min_activations_depth_max !== undefined)
        world_info_min_activations_depth_max = Number(settings.world_info_min_activations_depth_max);
    if (settings.world_info_budget !== undefined)
        world_info_budget = Number(settings.world_info_budget);
    if (settings.world_info_include_names !== undefined)
        world_info_include_names = Boolean(settings.world_info_include_names);
    if (settings.world_info_recursive !== undefined)
        world_info_recursive = Boolean(settings.world_info_recursive);
    if (settings.world_info_overflow_alert !== undefined)
        world_info_overflow_alert = Boolean(settings.world_info_overflow_alert);
    if (settings.world_info_case_sensitive !== undefined)
        world_info_case_sensitive = Boolean(settings.world_info_case_sensitive);
    if (settings.world_info_match_whole_words !== undefined)
        world_info_match_whole_words = Boolean(settings.world_info_match_whole_words);
    if (settings.world_info_character_strategy !== undefined)
        world_info_character_strategy = Number(settings.world_info_character_strategy);
    if (settings.world_info_budget_cap !== undefined)
        world_info_budget_cap = Number(settings.world_info_budget_cap);
    if (settings.world_info_use_group_scoring !== undefined)
        world_info_use_group_scoring = Boolean(settings.world_info_use_group_scoring);
    if (settings.world_info_max_recursion_steps !== undefined)
        world_info_max_recursion_steps = Number(settings.world_info_max_recursion_steps);

    // Migrate old settings
    if (world_info_budget > 100) {
        world_info_budget = 25;
    }

    if (world_info_use_group_scoring === undefined) {
        world_info_use_group_scoring = false;
    }

    // Reset selected world from old string and delete old keys
    // TODO: Remove next release
    const existingWorldInfo = settings.world_info;
    if (typeof existingWorldInfo === 'string') {
        delete settings.world_info;
        selected_world_info = [existingWorldInfo];
    } else if (Array.isArray(existingWorldInfo)) {
        delete settings.world_info;
        selected_world_info = existingWorldInfo;
    }

    world_info = settings.world_info ?? {};

    $('#world_info_depth_counter').val(world_info_depth);
    $('#world_info_depth').val(world_info_depth);

    $('#world_info_min_activations_counter').val(world_info_min_activations);
    $('#world_info_min_activations').val(world_info_min_activations);

    $('#world_info_min_activations_depth_max_counter').val(world_info_min_activations_depth_max);
    $('#world_info_min_activations_depth_max').val(world_info_min_activations_depth_max);

    $('#world_info_budget_counter').val(world_info_budget);
    $('#world_info_budget').val(world_info_budget);

    $('#world_info_include_names').prop('checked', world_info_include_names);
    $('#world_info_recursive').prop('checked', world_info_recursive);
    $('#world_info_overflow_alert').prop('checked', world_info_overflow_alert);
    $('#world_info_case_sensitive').prop('checked', world_info_case_sensitive);
    $('#world_info_match_whole_words').prop('checked', world_info_match_whole_words);
    $('#world_info_use_group_scoring').prop('checked', world_info_use_group_scoring);

    $(`#world_info_character_strategy option[value='${world_info_character_strategy}']`).prop('selected', true);
    $('#world_info_character_strategy').val(world_info_character_strategy);

    $('#world_info_budget_cap').val(world_info_budget_cap);
    $('#world_info_budget_cap_counter').val(world_info_budget_cap);

    $('#world_info_max_recursion_steps').val(world_info_max_recursion_steps);
    $('#world_info_max_recursion_steps_counter').val(world_info_max_recursion_steps);

    world_names = data.world_names?.length ? data.world_names : [];

    // Add to existing selected WI if it exists
    selected_world_info = selected_world_info.concat(settings.world_info?.globalSelect?.filter((e) => world_names.includes(e)) ?? []);

    if (world_names.length > 0) {
        $('#world_info').empty();
    }

    world_names.forEach((item, i) => {
        $('#world_info').append(`<option value='${i}'${selected_world_info.includes(item) ? ' selected' : ''}>${item}</option>`);
        $('#world_editor_select').append(`<option value='${i}'>${item}</option>`);
    });

    updateCharacterWorldButton();

    $('#world_info_sort_order').val(accountStorage.getItem(SORT_ORDER_KEY) || '0');
    $('#world_info').trigger('change');

    if (power_user.wi_last_editor_book) {
        const lastBookIndex = world_names.indexOf(power_user.wi_last_editor_book);
        if (lastBookIndex !== -1) {
            $('#world_editor_select').val(lastBookIndex);
        }
    }
    $('#world_editor_select').trigger('change');

    if (!worldInfoOneTimeInitDone) {
        worldInfoOneTimeInitDone = true;

        eventSource.on(event_types.CHAT_CHANGED, async () => {
            const hasWorldInfo = !!chat_metadata[METADATA_KEY] && world_names.includes(chat_metadata[METADATA_KEY]);
            $('.chat_lorebook_button').toggleClass('world_set', hasWorldInfo);
            await getSortedEntries();
        });

        registerWorldInfoSlashCommands();
    }
}

/**
 * Reloads the editor with the specified world info file
 * @param {string} file - The file to load in the editor
 * @param {boolean} [loadIfNotSelected=false] - Indicates whether to load the file even if it's not currently selected
 */
function reloadEditor(file, loadIfNotSelected = false) {
    const currentIndex = Number($('#world_editor_select').val());
    const selectedIndex = world_names.indexOf(file);
    if (selectedIndex !== -1 && (loadIfNotSelected || currentIndex === selectedIndex)) {
        $('#world_editor_select').val(selectedIndex).trigger('change');
    }
}

//MARK: regWISlashCommands
function registerWorldInfoSlashCommands() {
    /**
     * Gets a *rough* approximation of the current chat context.
     * Normally, it is provided externally by the prompt builder.
     * Don't use for anything critical!
     * @returns {string[]}
     */
    function getScanningChat() {
        return chat.filter(x => !x.is_system).map(x => x.mes);
    }

    async function getEntriesFromFile(file, { args = {}, unnamed = null, callbackName = 'getEntriesFromFile' } = {}) {
        if (file === EMBEDDED_WORLD_NAME) {
            const characterBook = getCurrentCharacter()?.data?.character_book;
            const entries = characterBook?.entries?.length ? Object.values(convertCharacterBook(characterBook).entries) : [];

            if (!entries.length) {
                toastr.warning(t`World Info file has no entries`);
                logSlashCommandWarn(`${callbackName}: World Info file has no entries`, args, unnamed);
                return '';
            }

            return entries;
        }

        if (!file || !world_names.includes(file)) {
            toastr.warning(t`Valid World Info file name is required`);
            logSlashCommandWarn(`${callbackName}: Valid World Info file name is required`, args, unnamed);
            return '';
        }

        const data = await loadWorldInfo(file);

        if (!data || !('entries' in data)) {
            toastr.warning(t`World Info file has an invalid format`);
            logSlashCommandWarn(`${callbackName}: World Info file has an invalid format`, args, unnamed);
            return '';
        }

        const entries = Object.values(data.entries);

        if (!entries || entries.length === 0) {
            toastr.warning(t`World Info file has no entries`);
            logSlashCommandWarn(`${callbackName}: World Info file has no entries`, args, unnamed);
            return '';
        }

        return entries;
    }

    /**
     * Gets the name of the persona-bound lorebook.
     * @param {import('./slash-commands/SlashCommand.js').NamedArguments} args Named arguments
     * @param {string} _unnamedArg not used
     * @returns {Promise<string>} The name of the persona-bound lorebook
     */
    async function getPersonaBookCallback({ name, create }, _unnamedArg) {
        let bookName = getPersonaDescriptionLorebook();
        if (bookName) {
            return bookName;
        }

        if (isTrueBoolean(String(create))) {
            const newName = await createWorldWithName(name, `Persona Book ${name1}`.replace(/[^a-z0-9 -]/gi, '_').replace(/_{2,}/g, '_').substring(0, 64));
            getOrCreatePersonaDescriptor();
            personaStore.update(user_avatar, { lorebook: newName });
            setPersonaDescription();
            saveSettingsDebounced('power_user.persona_data');
            return newName;
        }

        return '';
    }

    /**
     * Gets the name of the character-bound lorebook.
     * @param {import('./slash-commands/SlashCommand.js').NamedArguments} args Named arguments
     * @param {string} characterIdentifier Character name
     * @returns {Promise<string>} The name of the character-bound lorebook, a JSON string of the character's lorebooks, or an empty string
     */
    async function getCharBookCallback({ type, name, create }, characterIdentifier) {
        if (selected_group && !characterIdentifier) throw new Error('This command is not available in groups without providing a character name');
        type = String(type ?? '').trim().toLowerCase() || 'primary';
        characterIdentifier = String(characterIdentifier ?? '') || getCurrentCharacter()?.avatar || null;
        const character = await findCharAsync({ name: characterIdentifier });
        if (!character) {
            toastr.error(t`Character not found.`);
            logSlashCommandWarn('getCharBookCallback: Character not found', { type, name, create }, { characterIdentifier });
            return '';
        }
        const books = [];
        if (type === 'all' || type === 'primary' && character.data?.extensions?.world) {
            books.push(character.data.extensions.world);
        }
        if (type === 'all' || type === 'additional') {
            const fileName = getCharaFilename(character.avatar);
            const extraCharLore = world_info.charLore?.find((e) => e.name === fileName);
            if (extraCharLore && Array.isArray(extraCharLore.extraBooks)) {
                books.push(...extraCharLore.extraBooks.filter(onlyUnique).filter(Boolean));
            }
        }

        if (isTrueBoolean(String(create)) && books.length === 0) {
            const newName = await createWorldWithName(name, `Character Book ${character.name}`.replace(/[^a-z0-9 -]/gi, '_').replace(/_{2,}/g, '_').substring(0, 64));
            // Also assign the book now - additional if requested, otherwise as primary
            if (type === 'additional') {
                await charUpdateAddAuxWorld(character.avatar, newName);
            } else {
                await charUpdatePrimaryWorld(newName);
            }
            // Refresh UI, if needed
            setWorldInfoButtonClass(getCurrentCharacter()?.avatar);
            books.push(newName);
        }

        return type === 'primary' ? (books[0] ?? '') : JSON.stringify(books.filter(onlyUnique).filter(Boolean));
    }

    /**
     * Gets the name of the chat-bound lorebook. Creates a new one if it doesn't exist.
     * @param {import('./slash-commands/SlashCommand.js').NamedArguments} args Named arguments
     * @returns {Promise<string>} The name of the chat-bound lorebook
     */
    async function getChatBookCallback(args) {
        const chatId = getCurrentChatId();

        if (!chatId) {
            toastr.warning(t`Open a chat to get a name of the chat-bound lorebook`);
            logSlashCommandWarn('getChatBookCallback: Open a chat to get a name of the chat-bound lorebook', args);
            return '';
        }

        if (chat_metadata[METADATA_KEY] && world_names.includes(chat_metadata[METADATA_KEY])) {
            return chat_metadata[METADATA_KEY];
        }

        if (isFalseBoolean(String(args.create))) {
            return '';
        }

        const name = await createWorldWithName(args.name, `Chat Book ${getCurrentChatId()}`.replace(/[^a-z0-9 -]/gi, '_').replace(/_{2,}/g, '_').substring(0, 64));

        chat_metadata[METADATA_KEY] = name;
        await saveMetadata();
        $('.chat_lorebook_button').addClass('world_set');
        return name;
    }

    async function createWorldWithName(possibleName = undefined, fallbackName = undefined) {
        const hasExplicitName = typeof possibleName === 'string';
        const desiredName = hasExplicitName ? String(possibleName) : (fallbackName ?? `Lorebook (${uuidv4()})`);

        const response = await fetch('/api/worldinfo/create', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ name: desiredName, unique: !hasExplicitName }),
        });

        if (response.status === 409) {
            throw new Error('This World Info file name is already in use');
        }
        if (!response.ok) {
            throw new Error('Failed to create World Info file');
        }

        /** @type {{ name: string }} */
        const { name: newName } = await response.json();

        await updateWorldInfoList();

        const selectedIndex = world_names.indexOf(newName);
        if (selectedIndex !== -1) {
            $('#world_editor_select').val(selectedIndex).trigger('change');
        } else {
            await hideWorldEditor();
        }

        return newName;
    }

    async function findBookEntryCallback(args, value) {
        const file = args.file;
        const field = args.field || 'key';

        const entries = await getEntriesFromFile(file, { args, unnamed: { value }, callbackName: 'findBookEntryCallback' });

        if (!entries) {
            return '';
        }

        if (typeof newWorldInfoEntryTemplate[field] === 'boolean') {
            const isTrue = isTrueBoolean(value);
            const isFalse = isFalseBoolean(value);

            if (isTrue) {
                value = String(true);
            }

            if (isFalse) {
                value = String(false);
            }
        }

        const fuse = new Fuse(entries, {
            keys: [{ name: field, weight: 1 }],
            includeScore: true,
            threshold: 0.3,
        });

        const results = fuse.search(value);

        if (!results || results.length === 0) {
            return '';
        }

        const result = results[0]?.item?.uid;

        if (result === undefined) {
            return '';
        }

        return result;
    }

    async function getEntryFieldCallback(args, uid) {
        const file = args.file;
        const field = args.field || 'content';

        const entries = await getEntriesFromFile(file, { args, unnamed: { uid }, callbackName: 'getEntryFieldCallback' });

        if (!entries) {
            return '';
        }

        const entry = entries.find(x => String(x.uid) === String(uid));

        if (!entry) {
            toastr.warning('Valid UID is required');
            logSlashCommandWarn('getEntryFieldCallback: Valid UID is required', args, { uid });
            console.warn();
            return '';
        }

        if (!Object.hasOwn(newWorldInfoEntryDefinition, field)) {
            toastr.warning('Valid field name is required');
            logSlashCommandWarn('getEntryFieldCallback: Valid field name is required', args, { uid });
            return '';
        }

        // handle special cases, otherwise execute default logic
        let fieldValue;
        switch (field) {
            case 'characterFilterNames':
                if (entry.characterFilter) {
                    fieldValue = entry.characterFilter.names;
                }
                break;
            case 'characterFilterTags':
                if (entry.characterFilter) {
                    if (!entry.characterFilter.tags) {
                        return '';
                    }
                    const read = await readTagsForIds(entry.characterFilter.tags);
                    if (!read) {
                        toastr.error(t`The entry's tags could not be read. Check the server connection and try again.`);
                        return '';
                    }
                    fieldValue = entry.characterFilter.tags.map((id) => read.tags.get(id)?.name).filter((name) => name !== undefined);
                }
                break;
            case 'characterFilterExclude':
                if (entry.characterFilter) {
                    fieldValue = entry.characterFilter.isExclude;
                }
                break;
            default:
                fieldValue = entry[field] ?? newWorldInfoEntryDefinition[field]?.default;
        }

        if (fieldValue === undefined) {
            return '';
        }

        if (Array.isArray(fieldValue)) {
            return JSON.stringify(fieldValue.map(x => substituteParams(x)));
        }

        return substituteParams(String(fieldValue));
    }

    async function createEntryCallback(args, content) {
        const file = args.file;
        const key = args.key;

        const data = await loadWorldInfo(file);

        if (!data || !('entries' in data)) {
            toastr.warning('Valid World Info file name is required');
            logSlashCommandWarn('createEntryCallback: Valid World Info file name is required', args);
            return '';
        }

        const entry = await createWorldInfoEntry(file, data);

        if (!entry) {
            toastr.error('Failed to create a new World Info entry');
            logSlashCommandWarn('createEntryCallback: Failed to create a new World Info entry', args);
            return '';
        }

        if (key) {
            entry.key.push(key);
            entry.addMemo = true;
            entry.comment = key;
        }

        if (content) {
            entry.content = content;
        }

        await saveWorldInfo(file, data);
        reloadEditor(file);

        return String(entry.uid);
    }

    async function setEntryFieldCallback(args, value) {
        const file = args.file;
        const uid = args.uid;
        const field = args.field || 'content';

        // characterFilter is an object with internal fields we need to access, which may also may be null and need to be populated
        const createCharacterFilterFieldObjectIfNeeded = (currentEntry) => {
            if (!currentEntry.characterFilter) {
                Object.assign(
                    currentEntry,
                    {
                        characterFilter: {
                            isExclude: false,
                            names: [],
                            tags: [],
                        },
                    },
                );
            }
        };

        if (value === undefined) {
            toastr.warning('Value is required');
            logSlashCommandWarn('setEntryFieldCallback: Value is required', args, { value });
            return '';
        }

        value = value.replace(/\\([{}|])/g, '$1');

        const data = await loadWorldInfo(file);

        if (!data || !('entries' in data)) {
            toastr.warning('Valid World Info file name is required');
            logSlashCommandWarn('setEntryFieldCallback: Valid World Info file name is required', args, { value });
            return '';
        }

        const entry = data.entries[uid];

        if (!entry) {
            toastr.warning('Valid UID is required');
            logSlashCommandWarn('setEntryFieldCallback: Valid UID is required', args, { value });
            return '';
        }

        if (!Object.hasOwn(newWorldInfoEntryDefinition, field)) {
            toastr.warning('Valid field name is required');
            logSlashCommandWarn('setEntryFieldCallback: Valid field name is required', args, { value });
            return '';
        }

        // Init a default value for the field if it does not exist
        if (!Object.hasOwn(entry, field)) {
            entry[field] = newWorldInfoEntryDefinition[field].default;
        }

        // Use an array filter if it exists for the field
        const arrayFilter = newWorldInfoEntryDefinition[field]?.arrayFilter || (() => true);

        // handle special cases, otherwise execute default logic
        let tagNames;
        let charNames;
        switch (field) {
            case 'characterFilterNames':
                createCharacterFilterFieldObjectIfNeeded(entry);
                charNames = parseStringArray(value);
                entry.characterFilter.names = (await Promise.all(charNames.map(name => findCharAsync({ name, allowAvatar: true, preferCurrentChar: false, quiet: true }))))
                    .map((character) => getCharaFilename(character?.avatar))
                    .filter(Boolean)
                    .filter(onlyUnique);
                setWIOriginalDataValue(data, uid, 'character_filter', entry.characterFilter);
                break;
            case 'characterFilterTags': {
                tagNames = parseStringArray(value);
                const found = await findTagsByNames(tagNames);
                const tagIds = [
                    ...[...found.values()].filter((tag) => tag && tagNames.includes(tag.name)),
                    ...tagsStore.getAll().filter((tag) => tagNames.includes(tag.name)),
                ].map((tag) => tag.id).filter(onlyUnique);
                createCharacterFilterFieldObjectIfNeeded(entry);
                entry.characterFilter.tags = tagIds;
                setWIOriginalDataValue(data, uid, 'character_filter', entry.characterFilter);
                break;
            }
            case 'characterFilterExclude':
                createCharacterFilterFieldObjectIfNeeded(entry);
                entry.characterFilter.isExclude = isTrueBoolean(value);
                setWIOriginalDataValue(data, uid, 'character_filter', entry.characterFilter);
                break;
            default:
                if (Array.isArray(entry[field])) {
                    entry[field] = parseStringArray(value).filter(arrayFilter);
                } else if (typeof entry[field] === 'boolean') {
                    entry[field] = isTrueBoolean(value);
                } else if (typeof entry[field] === 'number') {
                    entry[field] = Number(value);
                } else {
                    entry[field] = value;
                }

                if (originalWIDataKeyMap[field]) {
                    setWIOriginalDataValue(data, uid, originalWIDataKeyMap[field], entry[field]);
                }
        }

        await saveWorldInfo(file, data);
        reloadEditor(file);
        return '';
    }

    async function getTimedEffectCallback(args, value) {
        if (!getCurrentChatId()) {
            throw new Error('This command can only be used in chat');
        }

        const file = args.file;
        const uid = value;
        const effect = args.effect;

        const entries = await getEntriesFromFile(file, { args, unnamed: { uid }, callbackName: 'getTimedEffectCallback' });

        if (!entries) {
            return '';
        }

        /** @type {WIScanEntry} */
        const entry = structuredClone(entries.find(x => String(x.uid) === String(uid)));

        if (!entry) {
            toastr.warning('Valid UID is required');
            logSlashCommandWarn('getTimedEffectCallback: Valid UID is required', args, { uid });
            return '';
        }

        entry.world = file; // Required by the timed effects manager
        const chat = getScanningChat();
        const timedEffects = new WorldInfoTimedEffects(chat, [entry]);

        if (!timedEffects.isValidEffectType(effect)) {
            toastr.warning('Valid effect type is required');
            logSlashCommandWarn('getTimedEffectCallback: Valid effect type is required', args, { uid });
            return '';
        }

        const data = timedEffects.getEffectMetadata(effect, entry);

        if (String(args.format).trim().toLowerCase() === ARGUMENT_TYPE.NUMBER) {
            return String(data ? (data.end - chat.length) : 0);
        }

        return String(!!data);
    }

    async function setTimedEffectCallback(args, value) {
        if (!getCurrentChatId()) {
            throw new Error('This command can only be used in chat');
        }

        const file = args.file;
        const uid = args.uid;
        const effect = args.effect;

        if (value === undefined) {
            toastr.warning('New state is required');
            logSlashCommandWarn('setTimedEffectCallback: New state is required', args, { value });
            return '';
        }

        const entries = await getEntriesFromFile(file, { args, unnamed: { value }, callbackName: 'setTimedEffectCallback' });

        if (!entries) {
            return '';
        }

        /** @type {WIScanEntry} */
        const entry = structuredClone(entries.find(x => String(x.uid) === String(uid)));

        if (!entry) {
            toastr.warning('Valid UID is required');
            logSlashCommandWarn('setTimedEffectCallback: Valid UID is required', args, { value });
            return '';
        }

        entry.world = file; // Required by the timed effects manager
        const chat = getScanningChat();
        const timedEffects = new WorldInfoTimedEffects(chat, [entry]);

        if (!timedEffects.isValidEffectType(effect)) {
            toastr.warning('Valid effect type is required');
            logSlashCommandWarn('setTimedEffectCallback: Valid effect type is required', args, { value });
            return '';
        }

        if (!entry[effect]) {
            toastr.warning('This entry does not have the selected effect. Configure it in the editor first.');
            logSlashCommandWarn('setTimedEffectCallback: This entry does not have the selected effect', args, { value });
            return '';
        }

        const getNewEffectState = () => {
            const currentState = !!timedEffects.getEffectMetadata(effect, entry);

            if (['toggle', 't', ''].includes(value.trim().toLowerCase())) {
                return !currentState;
            }

            if (isTrueBoolean(value)) {
                return true;
            }

            if (isFalseBoolean(value)) {
                return false;
            }

            return currentState;
        };

        const newEffectState = getNewEffectState();
        timedEffects.setTimedEffect(effect, entry, newEffectState);

        await saveMetadata();
        toastr.success(`Timed effect "${effect}" for entry ${entry.uid} is now ${newEffectState ? 'active' : 'inactive'}`);

        return '';
    }

    /** A collection of local enum providers for this context of world info */
    const localEnumProviders = {
        /** All possible fields that can be set in a WI entry */
        wiEntryFields: () => Object.entries(newWorldInfoEntryDefinition).map(([key, value]) =>
            new SlashCommandEnumValue(key, `[${value.type}] default: ${(typeof value.default === 'string' ? `'${value.default}'` : JSON.stringify(value.default))}`,
                enumTypes.enum, enumIcons.getDataTypeIcon(value.type))),

        /** All existing UIDs based on the file argument as world name */
        wiUids: (/** @type {import('./slash-commands/SlashCommandExecutor.js').SlashCommandExecutor} */ executor) => {
            const file = executor.namedArgumentList.find(it => it.name == 'file')?.value;
            if (file instanceof SlashCommandClosure) throw new Error('Argument \'file\' does not support closures');
            // Try find world from cache
            if (!worldInfoCache.has(file)) return [];
            const world = worldInfoCache.get(file);
            if (!world) return [];
            return Object.entries(world.entries).map(([uid, data]) =>
                new SlashCommandEnumValue(uid, `${data.comment ? `${data.comment}: ` : ''}${data.key.join(', ')}${data.keysecondary?.length ? ` [${Object.entries(world_info_logic).find(([_, value]) => value == data.selectiveLogic)[0]}] ${data.keysecondary.join(', ')}` : ''} [${getWiPositionString(data)}]`,
                    enumTypes.enum, enumIcons.getWiStatusIcon(data)));
        },

        timedEffects: () => [
            new SlashCommandEnumValue('sticky', 'Stays active for N messages', enumTypes.enum, '📌'),
            new SlashCommandEnumValue('cooldown', 'Cooldown for N messages', enumTypes.enum, '⌛'),
        ],
    };

    function getWiPositionString(entry) {
        switch (entry.position) {
            case world_info_position.before: return '↑Char';
            case world_info_position.after: return '↓Char';
            case world_info_position.EMTop: return '↑EM';
            case world_info_position.EMBottom: return '↓EM';
            case world_info_position.ANTop: return '↑AT';
            case world_info_position.ANBottom: return '↓AT';
            case world_info_position.atDepth: return `@D${enumIcons.getRoleIcon(entry.role)}`;
            default: return '<Unknown>';
        }
    }

    async function getGlobalBooksCallback() {
        if (!selected_world_info?.length) {
            return JSON.stringify([]);
        }

        let entries = selected_world_info.slice();

        if (isWorldInfoTracingEnabled()) console.debug(`[WI] Selected global world info has ${entries.length} entries`, selected_world_info);

        return JSON.stringify(entries);
    }

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'world',
        callback: onWorldInfoChange,
        namedArgumentList: [
            new SlashCommandNamedArgument(
                'state', 'set world state', [ARGUMENT_TYPE.STRING], false, false, null, commonEnumProviders.boolean('onOffToggle')(),
            ),
            new SlashCommandNamedArgument(
                'silent', 'suppress toast messages', [ARGUMENT_TYPE.BOOLEAN], false,
            ),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'world name',
                typeList: [ARGUMENT_TYPE.STRING],
                enumProvider: commonEnumProviders.worlds,
            }),
        ],
        helpString: `
            <div>
                Sets active World, or unsets if no args provided, use <code>state=off</code> and <code>state=toggle</code> to deactivate or toggle a World, use <code>silent=true</code> to suppress toast messages.
            </div>
        `,
        aliases: [],
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'getchatbook',
        callback: getChatBookCallback,
        returns: 'lorebook name',
        helpString: 'Get a name of the chat-bound lorebook or create a new one if was unbound, and pass it down the pipe.',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'name',
                description: 'lorebook name if creating a new one, will be auto-generated otherwise',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
                acceptsMultiple: false,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'create',
                description: 'create a new lorebook if it doesn\'t exist',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                isRequired: false,
                acceptsMultiple: false,
                enumList: commonEnumProviders.boolean('trueFalse')(),
                defaultValue: 'true',
            }),
        ],
        aliases: ['getchatlore', 'getchatwi'],
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'getglobalbooks',
        callback: getGlobalBooksCallback,
        returns: 'list of selected lorebook names',
        helpString: 'Get a list of names of the selected global lorebooks and pass it down the pipe.',
        aliases: ['getgloballore', 'getglobalwi'],
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'getpersonabook',
        callback: getPersonaBookCallback,
        returns: 'lorebook name',

        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'name',
                description: 'lorebook name if creating a new one, will be auto-generated otherwise',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
                acceptsMultiple: false,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'create',
                description: 'create a new lorebook if it doesn\'t exist',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                isRequired: false,
                acceptsMultiple: false,
                enumList: commonEnumProviders.boolean('trueFalse')(),
                defaultValue: 'false',
            }),
        ],
        helpString: 'Get a name of the current persona-bound lorebook and pass it down the pipe. Returns empty string if persona lorebook is not set.',
        aliases: ['getpersonalore', 'getpersonawi'],
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'getcharbook',
        callback: getCharBookCallback,
        returns: 'lorebook name or a list of lorebook names',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'type',
                description: 'type of the lorebook to get, returns a list for "all" and "additional"',
                typeList: [ARGUMENT_TYPE.STRING],
                enumList: ['primary', 'additional', 'all'],
                defaultValue: 'primary',
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'name',
                description: 'lorebook name if creating a new one, will be auto-generated otherwise',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
                acceptsMultiple: false,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'create',
                description: 'create a new lorebook if it doesn\'t exist',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                isRequired: false,
                acceptsMultiple: false,
                enumList: commonEnumProviders.boolean('trueFalse')(),
                defaultValue: 'false',
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Character name - or unique character identifier (avatar key). If not provided, the current character is used.',
                typeList: [ARGUMENT_TYPE.NUMBER, ARGUMENT_TYPE.STRING],
                isRequired: false,
                enumProvider: commonEnumProviders.characters('character'),
            }),
        ],
        helpString: 'Get a name of the character-bound lorebook and pass it down the pipe. Returns empty string if character lorebook is not set. Does not work in group chats without providing a character avatar name.',
        aliases: ['getcharlore', 'getcharwi'],
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'findentry',
        aliases: ['findlore', 'findwi'],
        returns: 'UID',
        callback: findBookEntryCallback,
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'file',
                description: 'book name',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                enumProvider: commonEnumProviders.worlds,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'field',
                description: 'field value for fuzzy match (default: key)',
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: 'key',
                enumList: localEnumProviders.wiEntryFields(),
            }),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument(
                'texts', ARGUMENT_TYPE.STRING, true, true,
            ),
        ],
        helpString: `
            <div>
                Find a UID of the record from the specified book using the fuzzy match of a field value (default: key) and pass it down the pipe.
            </div>
            <div>
                <strong>Example:</strong>
                <ul>
                    <li>
                        <pre><code>/findentry file=chatLore field=key Shadowfang</code></pre>
                    </li>
                </ul>
            </div>
        `,
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'getentryfield',
        aliases: ['getlorefield', 'getwifield'],
        callback: getEntryFieldCallback,
        returns: 'field value',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'file',
                description: 'book name',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                enumProvider: commonEnumProviders.worlds,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'field',
                description: 'field to retrieve (default: content)',
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: 'content',
                enumList: localEnumProviders.wiEntryFields(),
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'record UID',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                enumProvider: localEnumProviders.wiUids,
            }),
        ],
        helpString: `
            <div>
                Get a field value (default: content) of the record with the UID from the specified book and pass it down the pipe.
            </div>
            <div>
                <strong>Example:</strong>
                <ul>
                    <li>
                        <pre><code>/getentryfield file=chatLore field=content 123</code></pre>
                    </li>
                </ul>
            </div>
        `,
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'createentry',
        callback: createEntryCallback,
        aliases: ['createlore', 'createwi'],
        returns: 'UID of the new record',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'file',
                description: 'book name',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                enumProvider: commonEnumProviders.worlds,
            }),
            new SlashCommandNamedArgument(
                'key', 'record key', [ARGUMENT_TYPE.STRING], false,
            ),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument(
                'content', [ARGUMENT_TYPE.STRING], false,
            ),
        ],
        helpString: `
            <div>
                Create a new record in the specified book with the key and content (both are optional) and pass the UID down the pipe.
            </div>
            <div>
                <strong>Example:</strong>
                <ul>
                    <li>
                        <pre><code>/createentry file=chatLore key=Shadowfang The sword of the king</code></pre>
                    </li>
                </ul>
            </div>
        `,
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'setentryfield',
        callback: setEntryFieldCallback,
        aliases: ['setlorefield', 'setwifield'],
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'file',
                description: 'book name',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                enumProvider: commonEnumProviders.worlds,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'uid',
                description: 'record UID',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                enumProvider: localEnumProviders.wiUids,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'field',
                description: 'field name (default: content)',
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: 'content',
                enumList: localEnumProviders.wiEntryFields(),
            }),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument(
                'value', [ARGUMENT_TYPE.STRING], true,
            ),
        ],
        helpString: `
            <div>
                Set a field value (default: content) of the record with the UID from the specified book. To set multiple values for key fields, use comma-delimited list as a value.
            </div>
            <div>
                <strong>Example:</strong>
                <ul>
                    <li>
                        <pre><code>/setentryfield file=chatLore uid=123 field=key Shadowfang,sword,weapon</code></pre>
                    </li>
                </ul>
            </div>
        `,
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'wi-set-timed-effect',
        callback: setTimedEffectCallback,
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'file',
                description: 'book name',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                enumProvider: commonEnumProviders.worlds,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'uid',
                description: 'record UID',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                enumProvider: localEnumProviders.wiUids,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'effect',
                description: 'effect name',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                enumProvider: localEnumProviders.timedEffects,
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'new state of the effect',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                acceptsMultiple: false,
                enumList: commonEnumProviders.boolean('onOffToggle')(),
            }),
        ],
        helpString: `
            <div>
                Set a timed effect for the record with the UID from the specified book. The duration must be set in the entry itself.
                Will only be applied for the current chat. Enabling an effect that was already active refreshes the duration.
                If the last chat message is swiped or deleted, the effect will be removed.
            </div>
            <div>
                <strong>Example:</strong>
                <ul>
                    <li>
                        <pre><code>/wi-set-timed-effect file=chatLore uid=123 effect=sticky on</code></pre>
                    </li>
                </ul>
            </div>
        `,
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'wi-get-timed-effect',
        callback: getTimedEffectCallback,
        helpString: `
            <div>
                Get the current state of the timed effect for the record with the UID from the specified book.
            </div>
            <div>
                <strong>Example:</strong>
                <ul>
                    <li>
                        <code>/wi-get-timed-effect file=chatLore format=bool effect=sticky 123</code> - returns true or false if the effect is active or not
                    </li>
                    <li>
                        <code>/wi-get-timed-effect file=chatLore format=number effect=sticky 123</code> - returns the remaining duration of the effect, or 0 if inactive
                    </li>
                </ul>
            </div>
        `,
        returns: 'state of the effect',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'file',
                description: 'book name',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                enumProvider: commonEnumProviders.worlds,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'effect',
                description: 'effect name',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                enumProvider: localEnumProviders.timedEffects,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'format',
                description: 'output format',
                isRequired: false,
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: ARGUMENT_TYPE.BOOLEAN,
                enumList: [ARGUMENT_TYPE.BOOLEAN, ARGUMENT_TYPE.NUMBER],
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'record UID',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                enumProvider: localEnumProviders.wiUids,
            }),
        ],
    }));
}


/**
 * Loads the given world into the World Editor.
 *
 * @param {string} name - The name of the world
 * @return {Promise<void>} A promise that resolves when the world editor is loaded
 */
export async function showWorldEditor(name, navigation = navigation_option.none) {
    if (!name) {
        await hideWorldEditor();
        return;
    }

    const wiData = await loadWorldInfo(name);
    await displayWorldEntries(name, wiData, navigation);
}

/**
 * Loads world info from the backend.
 *
 * This function will return from `worldInfoCache` if it has already been loaded before.
 *
 * @param {string} name - The name of the world to load
 * @return {Promise<Object|null>} A promise that resolves to the loaded world information, or null if the request fails.
 */
export async function loadWorldInfo(name) {
    if (!name) {
        return;
    }

    if (worldInfoCache.has(name)) {
        return worldInfoCache.get(name);
    }

    const response = await fetch('/api/worldinfo/get', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ name: name }),
        cache: 'no-cache',
    });

    if (response.ok) {
        const data = await response.json();
        worldInfoCache.set(name, data);
        bookVersions.set(name, versionOf(data));
        noteBookId(name, response);
        return data;
    }

    return null;
}

/**
 * @returns {Promise<boolean>}
 */
export async function updateWorldInfoList() {
    const result = await fetch('/api/settings/get', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({}),
    });

    if (result.ok) {
        const data = await result.json();
        const editorSelected = String($('#world_editor_select').find(':selected').text());
        world_names = data.world_names?.length ? data.world_names : [];
        $('#world_info').find('option[value!=""]').remove();
        $('#world_editor_select').find('option[value!=""]').remove();

        world_names.forEach((item, i) => {
            const globalListOption = new Option(item, i.toString());
            globalListOption.selected = selected_world_info.includes(item);
            const editorListOption = new Option(item, i.toString());
            editorListOption.selected = editorSelected === item;
            $('#world_info').append(globalListOption);
            $('#world_editor_select').append(editorListOption);
        });

        updateCharacterWorldButton();
    }

    return result.ok;
}

async function hideWorldEditor() {
    await displayWorldEntries(null, null);
}

function getWIElement(name) {
    const wiElement = $('#world_info').children().filter(function () {
        return $(this).text().toLowerCase() === name.toLowerCase();
    });

    return wiElement;
}

/**
 * Adds missing fields to WI entries that are present in the entry template, but not in the data.
 * Additionally verify that array/object fields are of the expected type.
 * @param {any[]} data WI entries
 * @returns {any[]} Data with backfilled fields
 */
function addMissingWorldInfoFields(data) {
    data.forEach((entry) => {
        // Add missing fields from the template
        Object.entries(newWorldInfoEntryTemplate).forEach(([key, value]) => {
            if (!Object.hasOwn(entry, key)) {
                entry[key] = structuredClone(value);
            }
        });

        // Ensure that the key is always an array
        if (!Array.isArray(entry.key)) {
            if (isWorldInfoTracingEnabled()) console.debug('[WI] Fixing invalid "key" field for entry', entry);
            entry.key = [];
        }

        // Ensure that the keysecondary is always an array
        if (!Array.isArray(entry.keysecondary)) {
            if (isWorldInfoTracingEnabled()) console.debug('[WI] Fixing invalid "keysecondary" field for entry', entry);
            entry.keysecondary = [];
        }

        // Ensure that the characterFilter is an object with the expected structure
        if (!entry.characterFilter || typeof entry.characterFilter !== 'object' || Array.isArray(entry.characterFilter)) {
            entry.characterFilter = {
                isExclude: false,
                names: [],
                tags: [],
            };
        }
    });

    return data;
}

/**
 * Sorts the given data based on the selected sort option
 *
 * @param {any[]} data WI entries
 * @param {object} [options={}] - Optional arguments
 * @param {{sortField?: string, sortOrder?: string, sortRule?: string}} [options.customSort={}] - Custom sort options, instead of the chosen UI sort
 * @returns {any[]} Sorted data
 */
function sortWorldInfoEntries(data, { customSort = null } = {}) {
    const option = $('#world_info_sort_order').find(':selected');
    const sortField = customSort?.sortField ?? option.data('field');
    const sortOrder = customSort?.sortOrder ?? option.data('order');
    const sortRule = customSort?.sortRule ?? option.data('rule');
    const orderSign = sortOrder === 'asc' ? 1 : -1;

    if (!data.length) return data;

    /** @type {(a: any, b: any) => number} */
    let primarySort;

    // Secondary and tertiary it will always be sorted by Order descending, and last UID ascending
    // This is the most sensible approach for sorts where the primary sort has a lot of equal values
    const secondarySort = (a, b) => b.order - a.order;
    const tertiarySort = (a, b) => a.uid - b.uid;

    // If we have a search term for WI, we are sorting by weighting scores
    if (sortRule === 'search') {
        primarySort = (a, b) => {
            const aScore = worldInfoFilter.getScore(FILTER_TYPES.WORLD_INFO_SEARCH, a.uid);
            const bScore = worldInfoFilter.getScore(FILTER_TYPES.WORLD_INFO_SEARCH, b.uid);
            return aScore - bScore;
        };
    } else if (sortRule === 'custom') {
        // First by display index
        primarySort = (a, b) => {
            const aValue = a.displayIndex;
            const bValue = b.displayIndex;
            return aValue - bValue;
        };
    } else if (sortRule === 'priority') {
        // First constant, then normal, then disabled.
        primarySort = (a, b) => {
            const aValue = a.disable ? 2 : a.constant ? 0 : 1;
            const bValue = b.disable ? 2 : b.constant ? 0 : 1;
            return aValue - bValue;
        };
    } else {
        primarySort = (a, b) => {
            const aValue = a[sortField];
            const bValue = b[sortField];

            // Sort strings
            if (typeof aValue === 'string' && typeof bValue === 'string') {
                if (sortRule === 'length') {
                    // Sort by string length
                    return orderSign * (aValue.length - bValue.length);
                } else {
                    // Sort by A-Z ordinal
                    return orderSign * aValue.localeCompare(bValue);
                }
            }

            // Sort numbers
            return orderSign * (Number(aValue) - Number(bValue));
        };
    }

    data.sort((a, b) => {
        return primarySort(a, b) || secondarySort(a, b) || tertiarySort(a, b);
    });

    return data;
}

function nullWorldInfo() {
    toastr.info('Create or import a new World Info file first.', 'World Info is not set', { timeOut: 10000, preventDuplicates: true });
}

/** @type {Select2Option[]} Cache all keys as selectable dropdown option */
const worldEntryKeyOptionsCache = [];

/**
 * Update the cache and all select options for the keys with new values to display
 * @param {string[]|Select2Option[]} keyOptions - An array of options to update
 * @param {object} options - Optional arguments
 * @param {boolean?} [options.remove=false] - Whether the option was removed, so the count should be reduced - otherwise it'll be increased
 * @param {boolean?} [options.reset=false] - Whether the cache should be reset. Reset will also not trigger update of the controls, as we expect them to be redrawn anyway
 */
function updateWorldEntryKeyOptionsCache(keyOptions, { remove = false, reset = false } = {}) {
    if (!keyOptions.length) return;
    /** @type {Select2Option[]} */
    const options = keyOptions.map(x => typeof x === 'string' ? { id: getSelect2OptionId(x), text: x } : x);
    if (reset) worldEntryKeyOptionsCache.length = 0;
    options.forEach(option => {
        // Update the cache list
        let cachedEntry = worldEntryKeyOptionsCache.find(x => x.id == option.id);
        if (cachedEntry) {
            cachedEntry.count += !remove ? 1 : -1;
        } else if (!remove) {
            worldEntryKeyOptionsCache.push(option);
            cachedEntry = option;
            cachedEntry.count = 1;
        }
    });

    // Sort by count DESC and then alphabetically
    worldEntryKeyOptionsCache.sort((a, b) => b.count - a.count || a.text.localeCompare(b.text));
}

function clearEntryList($list) {
    console.time('clearEntryList');

    // List already empty, skipping cleanup
    if (!$list.children().length) {
        console.timeEnd('clearEntryList');
        return;
    }

    $list.find('[data-wi-draft]').each(function () {
        void entryFieldBindings.get(this)?.handle({ type: 'close' });
        entryFieldBindings.delete(this);
    });

    // Unsubscribe from toggle events, so that mass open won't create new drawers
    $list.find('.inline-drawer').off('inline-drawer-toggle');

    // Step 1: Clean all <option> elements within <select>
    $list.find('option').each(function () {
        const $option = $(this);
        $option.off();
        $.cleanData([$option[0]]);
        $option.remove();
    });

    // Step 2: Clean all <select> elements
    $list.find('select').each(function () {
        const $select = $(this);
        // Remove Select2-related data and container if present
        if ($select.data('select2')) {
            try {
                $select.select2('destroy');
            } catch (e) {
                console.debug('Select2 destroy failed:', e);
            }
        }
        const $container = $select.parent();
        if ($container.length) {
            $container.find('*').off();
            $.cleanData($container.find('*').get());
            $container.remove();
        }

        $select.off();
        $.cleanData([$select[0]]);
    });

    // Step 3: Clean <div>, <span>, <input>
    $list.find('div, span, input').each(function () {
        const $elem = $(this);
        $elem.off();
        $.cleanData([$elem[0]]);
        $elem.remove();
    });

    const totalElementsOfAnyKindLeftInList = $list.children().length;

    // Final cleanup
    if (totalElementsOfAnyKindLeftInList) {
        console.time('empty');
        $list.empty();
        console.timeEnd('empty');
    }

    console.timeEnd('clearEntryList');
}

//MARK: displayWorldEntries
async function displayWorldEntries(name, data, navigation = navigation_option.none, flashOnNav = true) {
    updateEditor = async (navigation, flashOnNav = true) => await displayWorldEntries(name, data, navigation, flashOnNav);

    const worldEntriesList = $('#world_popup_entries_list');
    clearEntryList(worldEntriesList);
    worldEntriesList.show();

    if (!data || !('entries' in data)) {
        $('#world_popup_new').off('click').on('click', nullWorldInfo);
        $('#world_popup_name_button').off('click').on('click', nullWorldInfo);
        $('#world_popup_export').off('click').on('click', nullWorldInfo);
        $('#world_popup_delete').off('click').on('click', nullWorldInfo);
        $('#world_duplicate').off('click').on('click', nullWorldInfo);
        worldEntriesList.hide();
        $('#world_info_pagination').html('');
        return;
    }

    // Regardless of whether success is displayed or not. Make sure the delete button is available.
    // Do not put this code behind.
    $('#world_popup_delete').off('click').on('click', async () => {
        if (name === EMBEDDED_WORLD_NAME) {
            await removeEmbeddedLore(data);
            return;
        }

        const confirmation = await Popup.show.confirm(`Delete the World/Lorebook: "${name}"?`, 'This action is irreversible!');
        if (!confirmation) {
            return;
        }

        await deleteWorldInfo(name);
    });

    // Before printing the WI, we check if we should enable/disable search sorting
    verifyWorldInfoSearchSortRule();

    function getDataArray(callback) {
        // Convert the data.entries object into an array
        let entriesArray = Object.keys(data.entries).map(uid => {
            const entry = data.entries[uid];
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
                return null;
            }
            entry.displayIndex = entry.displayIndex ?? entry.uid;
            return entry;
        }).filter(entry => entry !== null);

        // Apply the filter and do the chosen sorting
        entriesArray = addMissingWorldInfoFields(entriesArray);
        entriesArray = worldInfoFilter.applyFilters(entriesArray);
        entriesArray = sortWorldInfoEntries(entriesArray);

        // Cache keys
        const keys = entriesArray.flatMap(entry => [...entry.key, ...entry.keysecondary]);
        updateWorldEntryKeyOptionsCache(keys, { reset: true });

        // Run the callback for printing this
        typeof callback === 'function' && callback(entriesArray);
        return entriesArray;
    }

    const storageKey = 'WI_PerPage';
    const perPageDefault = 25;
    let startPage = 1;

    if (navigation === navigation_option.previous) {
        startPage = $('#world_info_pagination').pagination('getCurrentPageNum');
    }

    if (typeof navigation === 'number' && Number(navigation) >= 0) {
        const data = getDataArray();
        const uidIndex = data.findIndex(x => x.uid === navigation);
        const perPage = Number(accountStorage.getItem(storageKey)) || perPageDefault;
        startPage = Math.floor(uidIndex / perPage) + 1;
    }

    $('#world_info_pagination').pagination({
        dataSource: getDataArray,
        pageSize: Number(accountStorage.getItem(storageKey)) || perPageDefault,
        sizeChangerOptions: [10, 25, 50, 100, 500, 1000],
        showSizeChanger: true,
        pageRange: 1,
        pageNumber: startPage,
        position: 'top',
        showPageNumbers: false,
        prevText: '<',
        nextText: '>',
        formatNavigator: PAGINATION_TEMPLATE,
        showNavigator: true,
        callback: async function (/** @type {object[]} */ page) {
            try {
                clearEntryList(worldEntriesList);

                const keywordHeaders = await renderTemplateAsync('worldInfoKeywordHeaders');
                const blocks = [];

                for (const entry of page) {
                    try {
                        const block = await getWorldEntry(name, data, entry);
                        if (block) {
                            blocks.push(block);
                        }
                    } catch (error) {
                        console.error(`Error while processing entry ${entry.uid}:`, error);
                    }
                }

                const isCustomOrder = $('#world_info_sort_order').find(':selected').data('rule') === 'custom';
                if (!isCustomOrder) {
                    blocks.forEach(block => {
                        block.find('.drag-handle').remove();
                    });
                }

                worldEntriesList.append(keywordHeaders);
                worldEntriesList.append(blocks);
            } catch (error) {
                console.error('Error while rendering WI entries:', error);
            }
        },
        afterSizeSelectorChange: function (e) {
            accountStorage.setItem(storageKey, e.target.value);
        },
        afterPaging: function () {
            $('#world_popup_entries_list textarea[name="comment"]').each(function () {
                initScrollHeight($(this));
            });
        },
    });

    if (typeof navigation === 'number' && Number(navigation) >= 0) {
        const selector = `#world_popup_entries_list [uid="${navigation}"]`;
        waitUntilCondition(() => document.querySelector(selector) !== null).finally(() => {
            const element = $(selector);

            if (element.length === 0) {
                console.log(`Could not find element for uid ${navigation}`);
                return;
            }

            const elementOffset = element.offset();
            const parentOffset = element.parent().offset();
            const scrollOffset = elementOffset.top - parentOffset.top;
            $('#WorldInfo').scrollTop(scrollOffset);
            if (flashOnNav) flashHighlight(element);
        });
    }

    $('#world_popup_new').off('click').on('click', async () => {
        const entry = await createWorldInfoEntry(name, data);
        if (!entry) return;
        if (name === EMBEDDED_WORLD_NAME) await saveWorldInfoEntry(name, data, entry.uid);
        updateEditor(entry.uid);
    });

    $('#world_popup_name_button').off('click').on('click', async () => {
        if (name === EMBEDDED_WORLD_NAME) {
            return;
        }
        await renameWorldInfo(name, data);
    });

    $('#world_backfill_memos').off('click').on('click', async () => {
        let counter = 0;
        for (const entry of Object.values(data.entries)) {
            if (!entry.comment && Array.isArray(entry.key) && entry.key.length > 0) {
                entry.comment = entry.key.join(', ').slice(0, MAX_COMMENT_LENGTH);
                setWIOriginalDataValue(data, entry.uid, 'comment', entry.comment);
                counter++;
            }
        }

        if (counter > 0) {
            toastr.info(`Backfilled ${counter} titles`);
            await saveWorldInfo(name, data);
            updateEditor(navigation_option.previous);
        }
    });

    $('#world_apply_current_sorting').off('click').on('click', async () => {
        const entryCount = Object.keys(data.entries).length;

        const contentEl = document.createElement('div');

        const heading = document.createElement('h3');
        heading.textContent = t`Apply Current Sorting`;
        contentEl.appendChild(heading);

        const description = document.createElement('span');
        const descriptionText = document.createElement('p');
        descriptionText.innerHTML = t`Assigns Order values to all entries based on their current sort position.`;
        contentEl.appendChild(descriptionText);
        const descriptionDetail = document.createElement('p');
        descriptionDetail.innerHTML = t`Entries are ordered <b>descending</b> by default — the first entry in the list gets the highest value and will be inserted first into the prompt.`;
        contentEl.appendChild(descriptionDetail);
        const entryCountText = document.createElement('small');
        entryCountText.textContent = t`(${entryCount} entries total)`;
        contentEl.appendChild(entryCountText);
        contentEl.appendChild(description);

        const warningEl = document.createElement('div');
        contentEl.appendChild(warningEl);

        /** @type {(startInput: HTMLInputElement, stepInput: HTMLInputElement, ascendingInput: HTMLInputElement) => void} */
        const updateWarning = (startInput, stepInput, ascendingInput) => {
            const startVal = Number(startInput.value);
            const stepVal = Number(stepInput.value);
            const isAscending = ascendingInput.checked;
            if (!isAscending && !isNaN(startVal) && !isNaN(stepVal) && startVal - (entryCount - 1) * stepVal < 0) {
                setInfoBlock(warningEl, t`Some entries will be clamped to Order 0, causing collisions at the bottom. The last entry would reach ${startVal - (entryCount - 1) * stepVal} (${entryCount} entries, step ${stepVal}).`, 'warning');
            } else {
                clearInfoBlock(warningEl);
            }
        };

        /** @type {import('./popup.js').CustomPopupInput[]} */
        const customInputs = [
            {
                id: 'wi_sort_start',
                label: t`Starting value`,
                tooltip: t`The Order value assigned to the first entry. In descending mode, values count down from here; in ascending mode, values count up from here.` + ' ' + t`(${entryCount} entries total)`,
                type: 'number',
                defaultState: '100',
                min: 0,
                step: 1,
                autoFocus: true,
            },
            {
                id: 'wi_sort_step',
                label: t`Step`,
                tooltip: t`The gap between each Order value. For example, a step of 5 produces values like 100, 95, 90... (descending) or 0, 5, 10... (ascending).`,
                type: 'number',
                defaultState: '1',
                min: 1,
                step: 1,
            },
            {
                id: 'wi_sort_ascending',
                label: t`Ascending order`,
                tooltip: t`When checked, Order values count upward from the starting value (first sorted entry gets the lowest Order). When unchecked, values count downward (first sorted entry gets the highest Order).`,
                type: 'checkbox',
                defaultState: false,
            },
        ];

        const popup = new Popup(contentEl, POPUP_TYPE.TEXT, null, {
            okButton: t`Apply`,
            cancelButton: t`Cancel`,
            customInputs,
        });

        const startInput = /** @type {HTMLInputElement} */ (popup.dlg.querySelector('#wi_sort_start'));
        const stepInput = /** @type {HTMLInputElement} */ (popup.dlg.querySelector('#wi_sort_step'));
        const ascendingInput = /** @type {HTMLInputElement} */ (popup.dlg.querySelector('#wi_sort_ascending'));
        startInput.addEventListener('input', () => updateWarning(startInput, stepInput, ascendingInput));
        stepInput.addEventListener('input', () => updateWarning(startInput, stepInput, ascendingInput));
        ascendingInput.addEventListener('change', () => updateWarning(startInput, stepInput, ascendingInput));
        updateWarning(startInput, stepInput, ascendingInput);

        const result = await popup.show();
        if (result !== POPUP_RESULT.AFFIRMATIVE) return;

        const start = Number(popup.inputResults.get('wi_sort_start') ?? '100');
        const step = Number(popup.inputResults.get('wi_sort_step') ?? '1');
        const ascending = Boolean(popup.inputResults.get('wi_sort_ascending'));

        if (isNaN(start) || start < 0) {
            toastr.error(t`Invalid starting value: ${start}`, t`Apply Current Sorting`);
            return;
        }
        if (isNaN(step) || step < 1) {
            toastr.error(t`Invalid step value: ${step}`, t`Apply Current Sorting`);
            return;
        }
        if (!ascending && start < entryCount) {
            toastr.warning(t`A starting value lower than the entry count has been chosen. All entries below that will default to 0.`, t`Apply Current Sorting`);
        }

        // We need to sort the entries here, as the data source isn't sorted
        const entries = Object.values(data.entries);
        sortWorldInfoEntries(entries);

        let updated = 0;
        entries.forEach((entry, index) => {
            const newOrder = ascending
                ? start + index * step
                : Math.max(start - index * step, 0);
            if (entry.order === newOrder) return;

            entry.order = newOrder;
            setWIOriginalDataValue(data, entry.uid, 'order', entry.order);
            updated++;
        });

        if (updated > 0) {
            toastr.info(t`Updated ${updated} Order values`, t`Apply Current Sorting`);
            await saveWorldInfo(name, data, true);
            updateEditor(navigation_option.previous);
        } else {
            toastr.info(t`All values up to date`, t`Apply Current Sorting`);
        }
    });

    $('#world_popup_export').off('click').on('click', () => {
        if (name && data) {
            const jsonValue = JSON.stringify(data);
            const fileName = `${name}.json`;
            download(jsonValue, fileName, 'application/json');
        }
    });

    $('#world_duplicate').off('click').on('click', async () => {
        // Find current name for the world selected
        const selectedIndex = String($('#world_editor_select').find(':selected').val());
        const worldName = world_names[selectedIndex] || null;

        // Use the current name as default input, then ask user for the name
        const tempName = getFreeWorldName(worldName);
        const finalName = await Popup.show.input('Create a new World Info?', 'Enter a name for the new file:', tempName);

        if (finalName) {
            if (refuseEmbeddedWorldName(finalName)) {
                return;
            }
            if (!await duplicateWorldInfo(name, finalName)) {
                return;
            }
            await updateWorldInfoList();

            const selectedIndex = world_names.indexOf(finalName);
            if (selectedIndex !== -1) {
                $('#world_editor_select').val(selectedIndex).trigger('change');
            } else {
                await hideWorldEditor();
            }
        }
    });

    // Check if a sortable instance exists
    if (worldEntriesList.sortable('instance') !== undefined) {
        // Destroy the instance
        worldEntriesList.sortable('destroy');
    }

    worldEntriesList.sortable({
        items: '.world_entry',
        delay: getSortableDelay(),
        handle: '.drag-handle',
        stop: async function (_event, _ui) {
            const firstEntryUid = $('#world_popup_entries_list .world_entry').first().data('uid');
            const minDisplayIndex = data?.entries[firstEntryUid]?.displayIndex ?? 0;
            $('#world_popup_entries_list .world_entry').each(function (index) {
                const uid = $(this).data('uid');

                // Update the display index in the data array
                const item = data.entries[uid];

                if (!item) {
                    console.debug(`Could not find entry with uid ${uid}`);
                    return;
                }

                item.displayIndex = minDisplayIndex + index;
                setWIOriginalDataValue(data, uid, 'extensions.display_index', item.displayIndex);
            });

            console.table(Object.keys(data.entries).map(uid => data.entries[uid]).map(x => ({ uid: x.uid, key: x.key.join(','), displayIndex: x.displayIndex })));

            await saveWorldInfo(name, data);
        },
    });

    //$("#world_popup_entries_list").disableSelection();
}

const originalWIDataKeyMap = {
    'displayIndex': 'extensions.display_index',
    'excludeRecursion': 'extensions.exclude_recursion',
    'preventRecursion': 'extensions.prevent_recursion',
    'delayUntilRecursion': 'extensions.delay_until_recursion',
    'selectiveLogic': 'selectiveLogic',
    'comment': 'comment',
    'constant': 'constant',
    'order': 'insertion_order',
    'depth': 'extensions.depth',
    'probability': 'extensions.probability',
    'position': 'extensions.position',
    'role': 'extensions.role',
    'content': 'content',
    'enabled': 'enabled',
    'key': 'keys',
    'keysecondary': 'secondary_keys',
    'selective': 'selective',
    'matchWholeWords': 'extensions.match_whole_words',
    'useGroupScoring': 'extensions.use_group_scoring',
    'caseSensitive': 'extensions.case_sensitive',
    'matchPersonaDescription': 'extensions.match_persona_description',
    'matchCharacterDescription': 'extensions.match_character_description',
    'matchCharacterPersonality': 'extensions.match_character_personality',
    'matchCharacterDepthPrompt': 'extensions.match_character_depth_prompt',
    'matchScenario': 'extensions.match_scenario',
    'matchCreatorNotes': 'extensions.match_creator_notes',
    'scanDepth': 'extensions.scan_depth',
    'automationId': 'extensions.automation_id',
    'vectorized': 'extensions.vectorized',
    'groupOverride': 'extensions.group_override',
    'groupWeight': 'extensions.group_weight',
    'sticky': 'extensions.sticky',
    'cooldown': 'extensions.cooldown',
    'delay': 'extensions.delay',
    'triggers': 'extensions.triggers',
    'ignoreBudget': 'extensions.ignore_budget',
};

/** Checks the state of the current search, and adds/removes the search sorting option accordingly */
function verifyWorldInfoSearchSortRule() {
    const searchTerm = worldInfoFilter.getFilterData(FILTER_TYPES.WORLD_INFO_SEARCH);
    const searchOption = $('#world_info_sort_order option[data-rule="search"]');
    const selector = $('#world_info_sort_order');
    const isHidden = searchOption.attr('hidden') !== undefined;

    // If we have a search term, we are displaying the sorting option for it
    if (searchTerm && isHidden) {
        searchOption.removeAttr('hidden');
        selector.val(searchOption.attr('value') || '0');
        flashHighlight(selector);
    }
    // If search got cleared, we make sure to hide the option and go back to the one before
    if (!searchTerm && !isHidden) {
        searchOption.attr('hidden', '');
        selector.val(accountStorage.getItem(SORT_ORDER_KEY) || '0');
    }
}

/**
 * Sets the value of a specific key in the original data entry corresponding to the given uid
 * This needs to be called whenever you update JSON data fields.
 * Use `originalWIDataKeyMap` to find the correct value to be set.
 *
 * @param {object} data - The data object containing the original data entries.
 * @param {number} uid - The unique identifier of the data entry.
 * @param {string} key - The key of the value to be set.
 * @param {any} value - The value to be set.
 */
function setWIOriginalDataValue(data, uid, key, value) {
    if (data.originalData && Array.isArray(data.originalData.entries)) {
        let originalEntry = data.originalData.entries.find(x => x.uid === uid);

        if (!originalEntry) {
            return;
        }

        setValueByPath(originalEntry, key, value);
    }
}

/**
 * Deletes the original data entry corresponding to the given uid from the provided data object
 *
 * @param {object} data - The data object containing the original data entries
 * @param {string} uid - The unique identifier of the data entry to be deleted
 */
function deleteWIOriginalDataValue(data, uid) {
    if (data.originalData && Array.isArray(data.originalData.entries)) {
        // Non-strict equality is used here to allow for both string and number comparisons
        // @eslint-disable-next-line eqeqeq
        const originalIndex = data.originalData.entries.findIndex(x => x.uid == uid);

        if (originalIndex >= 0) {
            data.originalData.entries.splice(originalIndex, 1);
        }
    }
}

/** @typedef {import('./utils.js').Select2Option} Select2Option */

/**
 * Splits a given input string that contains one or more keywords or regexes, separated by commas.
 *
 * Each part can be a valid regex following the pattern `/myregex/flags` with optional flags. Commas inside the regex are allowed, slashes have to be escaped like this: `\/`
 * If a regex doesn't stand alone, it is not treated as a regex.
 *
 * @param {string} input - One or multiple keywords or regexes, separated by commas
 * @returns {string[]} An array of keywords and regexes
 */
function splitKeywordsAndRegexes(input) {
    /** @type {string[]} */
    let keywordsAndRegexes = [];

    const addFindCallback = (/** @type {Select2Option} */ item) => {
        keywordsAndRegexes.push(item.text);
    };

    const { term } = customTokenizer({ _type: 'custom_call', term: input }, undefined, addFindCallback);
    const finalTerm = term.trim();
    if (finalTerm) {
        addFindCallback({ id: getSelect2OptionId(finalTerm), text: finalTerm });
    }

    return keywordsAndRegexes;
}

/**
 * Tokenizer parsing input and splitting it into keywords and regexes
 *
 * @param {{_type: string, term: string}} input - The typed input
 * @param {{options: object}} _selection - The selection even object (?)
 * @param {function(Select2Option):void} callback - The original callback function to call if an item should be inserted
 * @returns {{term: string}} - The remaining part that is untokenized in the textbox
 */
function customTokenizer(input, _selection, callback) {
    let current = input.term;

    let insideRegex = false, regexClosed = false;

    for (let i = 0; i < current.length; i++) {
        let char = current[i];

        if (char === '/' && (i === 0 || current[i - 1] !== '\\')) {
            if (!insideRegex) insideRegex = true;
            else if (!regexClosed) regexClosed = true;
        }

        if (char === ',') {
            const token = current.slice(0, i).trim();

            if (insideRegex && !regexClosed) {
                continue;
            }

            if (token) {
                const isRegex = isValidRegex(token);

                if (token.startsWith('/') && !isRegex) {
                    const tokens = token.split(',').map(x => x.trim());
                    tokens.forEach(x => callback({ id: getSelect2OptionId(x), text: x }));
                } else {
                    callback({ id: getSelect2OptionId(token), text: token });
                }
            }

            current = current.slice(i + 1);
            insideRegex = false;
            regexClosed = false;
            i = 0;
        }
    }

    return { term: current };
}

/**
 * Validates if a string is a valid slash-delimited regex, that can be parsed and executed
 *
 * This is a wrapper around `parseRegexFromString`
 *
 * @param {string} input - A delimited regex string
 * @returns {boolean} Whether this would be a valid regex that can be parsed and executed
 */
function isValidRegex(input) {
    return parseRegexFromString(input) !== null;
}

/**
 * Gets a real regex object from a slash-delimited regex string
 *
 * This function works with `/` as delimiter, and each occurance of it inside the regex has to be escaped.
 * Flags are optional, but can only be valid flags supported by JavaScript's `RegExp` (`g`, `i`, `m`, `s`, `u`, `y`).
 *
 * @param {string} input - A delimited regex string
 * @returns {RegExp|null} The regex object, or null if not a valid regex
 */
function parseRegexFromString(input) {
    let match = input.match(/^\/([\w\W]+?)\/([gimsuy]*)$/);
    if (!match) {
        return null;
    }

    let [, pattern, flags] = match;

    if (pattern.match(/(^|[^\\])\//)) {
        return null;
    }

    pattern = pattern.replace('\\/', '/');

    try {
        return new RegExp(pattern, flags);
    } catch (e) {
        return null;
    }
}


const ENTRY_DRAFT_KIND = 'world-entry';

/** @type {Map<string, string>} */
const bookIds = new Map();

/** @type {Map<string, Promise<string|null>>} */
const bookIdRequests = new Map();

/** @type {WeakMap<HTMLElement, import('./field-drafts.js').FieldDraftBinding>} */
const entryFieldBindings = new WeakMap();

/** @type {Set<string>} */
const draftlessBooksWarned = new Set();

/** @type {Set<string>} */
const deletedBookIds = new Set();

/**
 * @param {string|null} thing
 * @returns {boolean}
 */
function isDraftOwnerGone(thing) {
    const match = /^book:([^:]+):/.exec(thing ?? '');
    return Boolean(match) && deletedBookIds.has(match[1]);
}

/** @type {WeakSet<object>} */
const removedEmbeddedLorebooks = new WeakSet();

/**
 * @param {string} bookId
 */
function forgetBookDrafts(bookId) {
    deletedBookIds.add(bookId);
    clearDraftsUnder(localStorage, ENTRY_DRAFT_KIND, `book:${bookId}:`);
}

/**
 * @param {string} name
 * @param {Response} response
 */
function noteBookId(name, response) {
    const id = response.headers.get('X-ST-Book-Id');
    if (id) bookIds.set(name, id);
    else bookIds.delete(name);
}

/**
 * @param {string} name
 * @returns {Promise<string|null>}
 */
function readBookId(name) {
    const known = bookIds.get(name);
    if (known) return Promise.resolve(known);
    let request = bookIdRequests.get(name);
    if (!request) {
        request = fetch('/api/worldinfo/get', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ name }),
            cache: 'no-cache',
        })
            .then((response) => {
                if (!response.ok) return null;
                noteBookId(name, response);
                return bookIds.get(name) ?? null;
            })
            .catch(() => null)
            .finally(() => bookIdRequests.delete(name));
        bookIdRequests.set(name, request);
    }
    return request;
}

/**
 * @param {string} name
 * @param {any} data
 * @param {string|number} uid
 * @returns {Promise<string|null>}
 */
async function entryDraftThing(name, data, uid) {
    let owner = null;
    if (name === EMBEDDED_WORLD_NAME) {
        const avatar = embeddedLoreOwners.get(data)?.avatar;
        owner = avatar ? `card:${avatar}` : null;
    } else {
        const id = await readBookId(name);
        owner = id === null ? null : `book:${id}`;
    }
    if (owner === null) {
        if (!draftlessBooksWarned.has(name)) {
            draftlessBooksWarned.add(name);
            toastr.warning(t`What you type in '${name}' is saved when you leave each field, but until then it won't survive a page reload: the lorebook's id could not be read.`, t`Unsaved edits not kept`);
        }
        return null;
    }
    draftlessBooksWarned.delete(name);
    return `${owner}:${uid}`;
}

/**
 * @param {string} name
 * @param {any} data
 * @param {string|number} uid
 * @param {(entry: any) => void|Promise<void>} apply
 * @returns {Promise<boolean>}
 */
async function commitEntryEdit(name, data, uid, apply) {
    const entry = data.entries?.[uid];
    if (!entry) return false;
    const original = Array.isArray(data.originalData?.entries) ? data.originalData.entries.find(x => x.uid === uid) : null;
    const before = structuredClone(entry);
    const originalBefore = original ? structuredClone(original) : null;
    await apply(entry);
    if (jsonHash(before) === jsonHash(entry)) return true;
    const after = structuredClone(entry);
    const originalAfter = original ? structuredClone(original) : null;
    let saved = false;
    try {
        saved = (await saveWorldInfoEntry(name, data, uid, true)) === true;
    } catch {
        // saveWorldInfoEntry has shown the failure.
    }
    if (!saved) {
        if (data.entries?.[uid]) revertChanges(data.entries[uid], before, after);
        if (original) revertChanges(original, originalBefore, originalAfter);
    }
    return saved;
}

/**
 * @param {import('./field-drafts.js').FieldDraftBinding} binding
 * @param {string} stored
 * @returns {JQuery<HTMLElement>}
 */
function entryDraftConflictNotice(binding, stored) {
    const draft = binding.conflict();
    const notice = $('<div class="wi_draft_conflict"></div>');
    notice.append($('<div></div>').text(t`This was changed elsewhere after your unsaved edit of it started. Which one should it keep?`));
    notice.append($('<small></small>').text(t`Now stored:`), $('<pre class="wi_draft_conflict_value"></pre>').text(stored));
    notice.append($('<small></small>').text(t`Your unsaved edit:`), $('<pre class="wi_draft_conflict_value"></pre>').text(draft?.text ?? ''));
    const keep = $('<button type="button" class="menu_button"></button>').text(t`Keep my edit`);
    const discard = $('<button type="button" class="menu_button"></button>').text(t`Keep the stored one`);
    keep.on('click', () => binding.keep());
    discard.on('click', () => binding.discard());
    notice.append($('<div class="flex-container"></div>').append(keep, discard));
    return notice;
}

/**
 * @param {JQuery<HTMLElement>} control
 * @param {import('./field-drafts.js').FieldDraftBinding} binding
 * @param {() => string} stored
 */
function showEntryFieldState(control, binding, stored) {
    const state = binding.state();
    control.toggleClass('wi_field_draft', state === 'draft');
    control.next('.select2-container').toggleClass('wi_field_draft', state === 'draft');
    const anchor = control.parent('label').length ? control.parent('label') : control;
    const notice = anchor.prev('.wi_draft_conflict');
    const element = control[0];
    if (state === 'conflict') {
        if (!notice.length) anchor.before(entryDraftConflictNotice(binding, stored()));
        if (!control.prop('disabled')) {
            element.dataset.wiDraftDisabled = '';
            control.prop('disabled', true);
        }
    } else {
        notice.remove();
        if (element.dataset.wiDraftDisabled !== undefined) {
            delete element.dataset.wiDraftDisabled;
            control.prop('disabled', false);
        }
    }
}

/**
 * @param {HTMLElement} element
 * @returns {boolean}
 */
function isExpandedEditorOf(element) {
    const active = document.activeElement;
    return Boolean(element.id) && active instanceof HTMLTextAreaElement && active.classList.contains('maximized_textarea') && active.dataset.for === element.id;
}

/**
 * @typedef {object} EntryFieldOptions
 * @property {JQuery<HTMLElement>} control
 * @property {string} field
 * @property {import('./field-drafts.js').FieldType} type
 * @property {string} name
 * @property {any} data
 * @property {string|number} uid
 * @property {string|null} thing
 * @property {(entry: any) => string} stored
 * @property {(entry: any, text: string) => void|Promise<void>} apply
 * @property {() => string} [read]
 * @property {(text: string) => void} [show]
 * @property {(text: string) => void} [live]
 * @property {string} [event]
 */

/**
 * @param {EntryFieldOptions} options
 * @returns {import('./field-drafts.js').FieldDraftBinding|null}
 */
function bindEntryField(options) {
    const { control, field, type, name, data, uid, thing } = options;
    const element = control[0];
    if (!element) return null;
    const read = options.read ?? (() => String(control.val() ?? ''));
    const show = (/** @type {string} */ text) => {
        if (options.show) options.show(text);
        else control.val(text);
        options.live?.(text);
    };
    const stored = () => {
        const entry = data.entries?.[uid];
        return entry ? options.stored(entry) : read();
    };
    /** @type {import('./field-drafts.js').FieldDraftBinding} */
    const drafts = bindFieldDraft({
        storage: localStorage,
        ref: thing ? { kind: ENTRY_DRAFT_KIND, id: thing, field } : null,
        type,
        stored,
        read,
        show,
        commit: text => commitEntryEdit(name, data, uid, entry => options.apply(entry, text)),
        changed: () => showEntryFieldState(control, drafts, stored),
    });
    /** @type {import('./field-drafts.js').FieldDraftBinding} */
    const binding = { ...drafts, handle: event => (isDraftOwnerGone(thing) || removedEmbeddedLorebooks.has(data) ? Promise.resolve(true) : drafts.handle(event)) };
    entryFieldBindings.set(element, binding);
    element.dataset.wiDraft = '';
    show(stored());
    binding.restore();
    showEntryFieldState(control, binding, stored);

    const event = options.event ?? 'input';
    const live = () => entryFieldBindings.get(element) === binding;
    control.on(event, function (e, arg) {
        if (arg?.noSave || !live()) return;
        options.live?.(read());
        const user = isUserEvent(e.originalEvent) || document.activeElement === element || isExpandedEditorOf(element);
        void binding.handle({ type: event === 'change' ? 'change' : 'input', user });
    });
    if (type !== 'toggle') {
        control.on('change', (_e, arg) => {
            if (arg?.noSave || !live()) return;
            void binding.handle({ type: 'change' });
        });
        control.on('focusout', () => live() && void binding.handle({ type: 'blur' }));
        control.on('keydown', e => live() && void binding.handle({ type: 'keydown', key: e.key, shiftKey: e.shiftKey, isComposing: e.originalEvent?.isComposing }));
    }
    return binding;
}

/**
 * Enables the input helper for keys in a World Info entry.
 * @param {object} params - Parameters for enabling the keys input helper.
 * @param {JQuery<HTMLElement>} params.template - The template element containing the input.
 * @param {object} params.entry - The entry object containing the keys.
 * @param {string} params.entryPropName - The property name of the entry that holds the keys.
 * @param {string} params.originalDataValueName - The name of the original data value to be set.
 * @param {string} params.name - The name of the world info entry.
 * @param {object} params.data - The data object containing entries.
 * @param {string|null} params.thing - What the entry's drafts are kept under.
 * @param {JQuery<HTMLElement>} params.header - The entry's header.
 */
function enableKeysInputHelper({ template, entry, entryPropName, originalDataValueName, name, data, thing, header }) {
    const isFancyInput = !isMobile() && !power_user.wi_key_input_plaintext;
    const input = isFancyInput ? template.find(`select[name="${entryPropName}"]`) : template.find(`textarea[name="${entryPropName}"]`);
    const uid = entry.uid;
    input.data('uid', entry.uid);
    const commentInput = () => header.find('textarea[name="comment"]');
    /** @param {string[]} keys */
    const applyKeys = (entryData, keys) => {
        entryData[entryPropName] = keys;
        setWIOriginalDataValue(data, uid, originalDataValueName, keys);
    };
    input[0].dataset.macros = ''; // active
    input.on('click', function (event) {
        event.stopPropagation();
    });

    function templateStyling(item, { searchStyle = false } = {}) {
        const content = $('<span>').addClass('item').text(item.text).attr('title', `${item.text}\n\nClick to edit`);
        const isRegex = isValidRegex(item.text);
        if (isRegex) {
            content.html(highlightRegex(item.text));
            content.addClass('regex_item').prepend($('<span>').addClass('regex_icon').text('•*').attr('title', 'Regex'));
        }
        if (searchStyle && item.count) {
            const wrapper = $('<span>').addClass('result_block').append(content);
            wrapper.append($('<span>').addClass('item_count').text(item.count).attr('title', `Used as a key ${item.count} ${item.count != 1 ? 'times' : 'time'} in this lorebook`));
            return wrapper;
        }
        return content;
    }

    if (isFancyInput) {
        select2ModifyOptions(input, entry[entryPropName], { select: true, changeEventArgs: { skipReset: true, noSave: true } });
        input.select2({
            ajax: dynamicSelect2DataViaAjax(() => worldEntryKeyOptionsCache),
            tags: true,
            tokenSeparators: [','],
            // @ts-ignore
            tokenizer: customTokenizer,
            placeholder: input.attr('placeholder'),
            templateResult: item => templateStyling(item, { searchStyle: true }),
            templateSelection: item => templateStyling(item),
        });

        /** @param {string[]} keys */
        const showKeysAround = (keys) => {
            input.toggleClass('empty', !keys.length);
            if (entryPropName === 'key') setCommentPlaceholder(keys.join(', '), commentInput());
        };
        bindEntryField({
            control: input, field: entryPropName, type: 'toggle', event: 'change', name, data, uid, thing,
            stored: entryData => JSON.stringify(entryData[entryPropName] ?? []),
            read: () => JSON.stringify(input.select2('data').map(x => x.text)),
            show: (text) => {
                const keys = JSON.parse(text);
                if (keys.length) select2ModifyOptions(input, keys, { select: true, changeEventArgs: { skipReset: true, noSave: true } });
                else input.val([]).trigger('change', { skipReset: true, noSave: true });
            },
            live: text => showKeysAround(JSON.parse(text)),
            apply: (entryData, text) => applyKeys(entryData, JSON.parse(text)),
        });
        input.on('change', async function (_event, arg) {
            if (!arg?.skipReset) await resetScrollHeight(this);
        });

        const searchRef = thing ? { kind: ENTRY_DRAFT_KIND, id: thing, field: `${entryPropName}:search` } : null;
        const searchBox = () => input.next('.select2-container').find('.select2-search__field');
        const keepSearch = () => {
            writeFieldDraft(localStorage, searchRef, String(searchBox().val() ?? ''), '');
        };
        const typedKey = readFieldDraft(localStorage, searchRef)?.text;
        if (typedKey) searchBox().val(typedKey);
        input.next('.select2-container').on('input', '.select2-search__field', keepSearch);
        input.on('change select2:close', keepSearch);

        input.on('select2:select', event => updateWorldEntryKeyOptionsCache([event.params.data]));
        input.on('select2:unselect', event => updateWorldEntryKeyOptionsCache([event.params.data], { remove: true }));

        select2ChoiceClickSubscribe(input, target => {
            const key = $(target.closest('.regex-highlight, .item')).text();
            const selected = input.val();
            if (!Array.isArray(selected)) return;
            var index = selected.indexOf(getSelect2OptionId(key));
            if (index > -1) selected.splice(index, 1);
            input.val(selected).trigger('change');
            updateWorldEntryKeyOptionsCache([key], { remove: true });
            input.next('span.select2-container').find('textarea').val(key).trigger('input');
        }, { openDrawer: true });
    } else {
        template.find(`select[name="${entryPropName}"]`).hide();
        input.show();
        bindEntryField({
            control: input, field: entryPropName, type: 'text', name, data, uid, thing,
            stored: entryData => (entryData[entryPropName] ?? []).join(', '),
            live: (text) => {
                input.toggleClass('empty', !splitKeywordsAndRegexes(text).length);
                if (entryPropName === 'key') setCommentPlaceholder(text, commentInput());
            },
            apply: (entryData, text) => applyKeys(entryData, splitKeywordsAndRegexes(text)),
        });
        input.on('change', async function () {
            await resetScrollHeight(this);
        });
        input.trigger('input', { skipReset: true, noSave: true });
    }
    return { isFancy: isFancyInput, control: input };
}

/**
 * Helper to handle match checkboxes for WI entries.
 * @param {object} params - Parameters for handling match checkboxes.
 * @param {JQuery<HTMLElement>} params.template - The template element containing the checkbox.
 * @param {object} params.entry - The entry object containing the checkbox state.
 * @param {string} params.fieldName - The name of the checkbox field.
 * @param {object} params.data - The data object containing entries.
 * @param {string} params.name - The name of the world info to save changes to.
 * @param {string|null} params.thing - What the entry's drafts are kept under.
 */
function handleMatchCheckboxHelper({ template, entry, fieldName, data, name, thing }) {
    const key = originalWIDataKeyMap[fieldName];
    const checkBoxElem = template.find(`input[type="checkbox"][name="${fieldName}"]`);
    checkBoxElem.data('uid', entry.uid);
    bindCheckboxField({
        control: checkBoxElem, field: fieldName, name, data, uid: entry.uid, thing,
        stored: entryData => !!entryData[fieldName],
        apply: (entryData, value) => {
            entryData[fieldName] = value;
            setWIOriginalDataValue(data, entry.uid, key, value);
        },
    });
}

/**
 * @param {Omit<EntryFieldOptions, 'type'|'stored'|'apply'|'read'|'show'> & { stored: (entry: any) => boolean, apply: (entry: any, value: boolean) => void|Promise<void>, onShow?: (value: boolean) => void }} options
 */
function bindCheckboxField({ stored, apply, onShow, ...options }) {
    return bindEntryField({
        ...options,
        type: 'toggle',
        stored: entryData => String(stored(entryData)),
        read: () => String(options.control.prop('checked')),
        show: text => options.control.prop('checked', text === 'true'),
        live: text => onShow?.(text === 'true'),
        apply: (entryData, text) => apply(entryData, text === 'true'),
    });
}

/**
 * Helper to update position/order display.
 * @param {object} params - Parameters for updating position/order display.
 * @param {JQuery<HTMLElement>} params.template - The template element containing the display.
 * @param {object} params.data - The data object containing entries.
 * @param {string} params.uid - The unique identifier of the entry to update.
 */
function updatePosOrdDisplayHelper({ template, data, uid }) {
    let entry = data.entries[uid];
    let posText = entry.position;
    switch (entry.position) {
        case 0: posText = '↑CD'; break;
        case 1: posText = 'CD↓'; break;
        case 2: posText = '↑AN'; break;
        case 3: posText = 'AN↓'; break;
        case 4: posText = `@D${entry.depth}`; break;
    }
    template.find('.world_entry_form_position_value').text(`(${posText} ${entry.order})`);
}

/**
 * Helper to initialize character filter select2.
 * @param {JQuery<HTMLElement>} characterFilter - The select element for character filter.
 */
function initCharacterFilterSelect2Helper(characterFilter) {
    const MAX_RESULTS = 100;
    $(characterFilter).select2({
        width: '100%',
        placeholder: t`Tie this entry to specific characters or characters with specific tags`,
        allowClear: true,
        closeOnSelect: false,
        minimumInputLength: 1,
        ajax: {
            delay: 250,
            transport: function (params, success, failure) {
                const query = params.data?.q?.toLowerCase() ?? '';
                let aborted = false;

                const tagSearch = searchTagsByName(query.replace(/^\[tag\]\s*/, ''), { pageSize: MAX_RESULTS });
                const characterSearch = characterRepository.query({ search: query }, { field: 'search' }, 1, MAX_RESULTS, ['rows'])
                    .catch((error) => {
                        console.error('Character search for the lorebook entry filter failed:', error);
                        return null;
                    });
                Promise.all([tagSearch, characterSearch]).then(([page, characterPage]) => {
                    if (aborted) return;
                    if (!page || !characterPage) {
                        failure();
                        return;
                    }
                    const results = page.rows.map((tag) => ({ id: tag.id, text: `[Tag] ${tag.name}` }));

                    for (const character of characterPage.rows ?? []) {
                        if (results.length >= MAX_RESULTS) break;
                        const name = character.avatar.replace(/\.[^/.]+$/, '');
                        results.push({ id: name, text: name });
                    }

                    success({ results });
                });
                return { abort: () => { aborted = true; } };
            },
        },
    });
}

/**
 * Helper to fill character and tag options for character filter.
 * @param {object} params - Parameters for filling options.
 * @param {JQuery<HTMLElement>} params.characterFilter - The select element to fill with options.
 * @param {object} params.entry - The entry object containing character filter data.
 */
function fillCharacterAndTagOptionsHelper({ characterFilter, entry }) {
    const selectedNames = entry.characterFilter?.names ?? [];
    for (const name of selectedNames) {
        const option = document.createElement('option');
        option.innerText = name;
        option.selected = true;
        characterFilter.append(option);
    }

    const selectedTagIds = entry.characterFilter?.tags ?? [];
    /** @type {Map<string, HTMLOptionElement>} */
    const tagOptions = new Map();
    for (const id of selectedTagIds) {
        const option = document.createElement('option');
        option.innerText = '[Tag] …';
        option.selected = true;
        option.value = id;
        characterFilter.append(option);
        tagOptions.set(id, option);
    }
    if (tagOptions.size === 0) return;
    readTagsForIds(selectedTagIds).then((read) => {
        /** @type {Set<string>} */
        const shown = new Set();
        for (const [id, option] of tagOptions) {
            const tag = read?.tags.get(id);
            const shownId = tag ? String(tag.id) : id;
            if (shown.has(shownId)) {
                option.remove();
                continue;
            }
            shown.add(shownId);
            const named = document.createElement('option');
            named.value = shownId;
            named.selected = option.selected;
            if (tag) named.innerText = `[Tag] ${tag.name}`;
            else if (read?.gone.has(id)) named.innerText = `[Tag] ${t`(deleted tag)`}`;
            else named.innerText = `[Tag] ${id}`;
            option.replaceWith(named);
        }
        characterFilter.trigger('change.select2');
    });
}

/**
 * Helper to handle character filter changes.
 * @param {object} params - Parameters for handling character filter changes.
 * @param {JQuery<HTMLElement>} params.characterFilter - The select element for character filter.
 * @param {object} params.data - The data object containing entries.
 * @param {object} params.entry - The entry object to update.
 * @param {string} params.name - The name of the world info to save changes to.
 * @param {string|null} params.thing - What the entry's drafts are kept under.
 */
function handleCharacterFilterChangeHelper({ characterFilter, data, entry, name, thing }) {
    characterFilter.on('mousedown', function (e) {
        if (world_names.length === 0) {
            e.preventDefault();
        }
    });
    const uid = entry.uid;
    /** @param {{ names?: string[], tags?: unknown[] } | undefined} filter */
    const asText = filter => JSON.stringify({ names: [...(filter?.names ?? [])].sort(), tags: (filter?.tags ?? []).map(String).sort() });
    bindEntryField({
        control: characterFilter, field: 'characterFilter', type: 'toggle', event: 'change', name, data, uid, thing,
        stored: entryData => asText(entryData.characterFilter),
        read: () => {
            /** @type {string[]} */
            const names = [];
            /** @type {string[]} */
            const tags = [];
            characterFilter.find(':selected').each((_, option) => {
                if (!(option instanceof HTMLOptionElement)) return;
                if (option.textContent.startsWith('[Tag] ')) tags.push(option.value);
                else names.push(option.textContent);
            });
            return asText({ names, tags });
        },
        show: (text) => {
            characterFilter.find('option').remove();
            fillCharacterAndTagOptionsHelper({ characterFilter, entry: { characterFilter: JSON.parse(text) } });
            characterFilter.trigger('change.select2');
        },
        apply: (entryData, text) => {
            const { names, tags } = JSON.parse(text);
            if (!names.length && !tags.length && !entryData.characterFilter?.isExclude) {
                delete entryData.characterFilter;
            } else {
                entryData.characterFilter = { isExclude: entryData.characterFilter?.isExclude ?? false, names, tags };
            }
            setWIOriginalDataValue(data, uid, 'character_filter', entryData.characterFilter);
        },
    });
}

/**
 * Helper to handle probability input.
 * @param {object} params - Parameters for handling probability input.
 * @param {JQuery<HTMLElement>} params.probabilityInput - The input element for probability.
 * @param {object} params.data - The data object containing entries.
 * @param {object} params.entry - The entry object to update.
 * @param {string} params.name - The name of the world info to save changes to.
 * @param {string|null} params.thing - What the entry's drafts are kept under.
 */
function handleProbabilityInputHelper({ probabilityInput, data, entry, name, thing }) {
    probabilityInput.data('uid', entry.uid);
    /** @param {string} text */
    const probabilityOf = text => {
        const value = Number(text);
        return !isNaN(value) ? Math.min(100, Math.max(0, value)) : null;
    };
    bindEntryField({
        control: probabilityInput, field: 'probability', type: 'number', name, data, uid: entry.uid, thing,
        stored: entryData => String(entryData.probability ?? ''),
        live: (text) => {
            const value = probabilityOf(text);
            if (value !== null && value !== Number(text)) probabilityInput.val(value);
        },
        apply: (entryData, text) => {
            entryData.probability = probabilityOf(text);
            setWIOriginalDataValue(data, entry.uid, 'extensions.probability', entryData.probability);
        },
    });
    probabilityInput.css('width', 'calc(3em + 15px)');
}

/**
 * Helper to handle probability toggle.
 * @param {object} params - Parameters for handling probability toggle.
 * @param {JQuery<HTMLElement>} params.probabilityToggle - The toggle element for probability.
 * @param {object} params.data - The data object containing entries.
 * @param {object} params.entry - The entry object to update.
 * @param {string} params.name - The name of the world info to save changes to.
 * @param {JQuery<HTMLElement>} params.probabilityInput - The input element for probability.
 * @param {string|null} params.thing - What the entry's drafts are kept under.
 */
function handleProbabilityToggleHelper({ probabilityToggle, data, entry, name, probabilityInput, thing }) {
    probabilityToggle.data('uid', entry.uid);
    const uid = entry.uid;
    /**
     * @param {any} entryData
     * @param {boolean} value
     */
    const setUseProbability = (entryData, value) => {
        entryData.useProbability = value;
        if (value && entryData.probability === null) entryData.probability = 100;
        if (!value) entryData.probability = null;
    };
    setUseProbability(data.entries[uid], true);
    probabilityInput.val(data.entries[uid].probability ?? '');
    bindCheckboxField({
        control: probabilityToggle, field: 'useProbability', name, data, uid, thing,
        stored: entryData => !!entryData.useProbability,
        onShow: (value) => {
            const probabilityContainer = probabilityToggle.closest('.world_entry').find('.probabilityContainer');
            value ? probabilityContainer.show() : probabilityContainer.hide();
        },
        apply: (entryData, value) => {
            setUseProbability(entryData, value);
            probabilityInput.val(entryData.probability ?? '');
        },
    });
    probabilityToggle.parent().hide();
}

/**
 * Helper to handle select2 dropdowns for boolean selects.
 * @param {object} params - Parameters for handling boolean selects.
 * @param {JQuery<HTMLElement>} params.selectElem - The select element for boolean values.
 * @param {object} params.entry - The entry object containing the boolean value.
 * @param {string} params.entryKey - The key in the entry object for the boolean value.
 * @param {object} params.data - The data object containing entries.
 * @param {string} params.name - The name of the world info to save changes to.
 * @param {string|null} params.thing - What the entry's drafts are kept under.
 */
function handleBooleanSelectHelper({ selectElem, entry, entryKey, data, name, thing }) {
    selectElem.data('uid', entry.uid);
    bindEntryField({
        control: selectElem, field: entryKey, type: 'toggle', name, data, uid: entry.uid, thing,
        stored: entryData => (entryData[entryKey] === null || entryData[entryKey] === undefined) ? 'null' : entryData[entryKey] ? 'true' : 'false',
        apply: (entryData, value) => {
            entryData[entryKey] = value === 'null' ? null : value === 'true';
            setWIOriginalDataValue(data, entry.uid, `extensions.${entryKey.replace(/[A-Z]/g, m => `_${m.toLowerCase()}`)}`, entryData[entryKey]);
        },
    });
}

/**
 * Helper to handle input fields for numbers.
 * @param {object} params - Parameters for handling number inputs.
 * @param {JQuery<HTMLElement>} params.inputElem - The input element for the number.
 * @param {object} params.entry - The entry object containing the number value.
 * @param {string} params.entryKey - The key in the entry object for the number value.
 * @param {object} params.data - The data object containing entries.
 * @param {string} params.name - The name of the world info to save changes to.
 * @param {number} params.min - The minimum value for the number input.
 * @param {number} params.max - The maximum value for the number input.
 * @param {boolean} [params.clamp=false] - Whether to clamp the value within the min and max range.
 * @param {string|null} params.thing - What the entry's drafts are kept under.
 */
function handleNumberInputHelper({ inputElem, entry, entryKey, data, name, min, max, clamp = false, thing }) {
    inputElem.data('uid', entry.uid);
    /** @param {string} text */
    const valueOf = (text) => {
        const value = Number(text);
        return clamp ? Math.min(max, Math.max(min, value)) : value;
    };
    bindEntryField({
        control: inputElem, field: entryKey, type: 'number', name, data, uid: entry.uid, thing,
        stored: entryData => String(entryData[entryKey] ?? (clamp ? min : '')),
        live: (text) => {
            const value = valueOf(text);
            if (clamp && value !== Number(text)) inputElem.val(value);
        },
        apply: (entryData, text) => {
            const value = valueOf(text);
            entryData[entryKey] = !isNaN(value) ? value : null;
            setWIOriginalDataValue(data, entry.uid, `extensions.${entryKey.replace(/[A-Z]/g, m => `_${m.toLowerCase()}`)}`, entryData[entryKey]);
        },
    });
}

/**
 * Helper to handle tri-state selector for constant/normal/vectorized.
 * @param {object} params - Parameters for handling the entry state selector.
 * @param {JQuery<HTMLElement>} params.entryStateSelector - The select element for entry state.
 * @param {object} params.entry - The entry object containing the state.
 * @param {object} params.data - The data object containing entries.
 * @param {string} params.name - The name of the world info to save changes to.
 * @param {string|null} params.thing - What the entry's drafts are kept under.
 */
function handleEntryStateSelectorHelper({ entryStateSelector, entry, data, name, thing }) {
    entryStateSelector.data('uid', entry.uid);
    entryStateSelector.on('click', function (event) {
        event.stopPropagation();
    });
    const uid = entry.uid;
    bindEntryField({
        control: entryStateSelector, field: 'entryState', type: 'toggle', name, data, uid, thing,
        stored: entryData => entryData.constant === true ? 'constant' : entryData.vectorized === true ? 'vectorized' : 'normal',
        apply: (entryData, value) => {
            if (!['constant', 'normal', 'vectorized'].includes(value)) return;
            entryData.constant = value === 'constant';
            entryData.vectorized = value === 'vectorized';
            setWIOriginalDataValue(data, uid, 'constant', entryData.constant);
            setWIOriginalDataValue(data, uid, 'extensions.vectorized', entryData.vectorized);
        },
    });
}

/**
 * Helper to handle kill switch toggle.
 * @param {object} params - Parameters for handling the kill switch toggle.
 * @param {JQuery<HTMLElement>} params.entryKillSwitch - The toggle element for the kill switch.
 * @param {object} params.entry - The entry object containing the state.
 * @param {object} params.data - The data object containing entries.
 * @param {string} params.name - The name of the world info to save changes to.
 * @param {JQuery<HTMLElement>} params.template - The template element for the entry.
 * @param {string|null} params.thing - What the entry's drafts are kept under.
 */
function handleEntryKillSwitchHelper({ entryKillSwitch, entry, data, name, template, thing }) {
    entryKillSwitch.data('uid', entry.uid);
    /** @param {string} state */
    const showState = (state) => {
        const isActive = state === 'on';
        template.toggleClass('disabledWIEntry', !isActive);
        entryKillSwitch.toggleClass('fa-toggle-off', !isActive);
        entryKillSwitch.toggleClass('fa-toggle-on', isActive);
    };
    const read = () => (entryKillSwitch.hasClass('fa-toggle-on') ? 'on' : 'off');
    bindEntryField({
        control: entryKillSwitch, field: 'enabled', type: 'toggle', event: 'wi-killswitch', name, data, uid: entry.uid, thing,
        stored: entryData => (entryData.disable ? 'off' : 'on'),
        read,
        show: showState,
        apply: (entryData, state) => {
            entryData.disable = state !== 'on';
            setWIOriginalDataValue(data, entry.uid, 'enabled', !entryData.disable);
        },
    });
    entryKillSwitch.on('click', function () {
        if (entryKillSwitch[0].dataset.wiDraftDisabled !== undefined) return;
        showState(read() === 'on' ? 'off' : 'on');
        entryKillSwitch.trigger('wi-killswitch');
    });
}

/**
 * Update commentInput's placeholder.
 * @param {string} keys Text to display in commentInput's placeholder.
 * @param {JQuery<HTMLElement>} commentInput The comment input element.
 */
function setCommentPlaceholder(keys, commentInput) {
    // Limit placeholder text to avoid performance issues.
    keys = keys.slice(0, MAX_COMMENT_LENGTH);
    commentInput.attr('placeholder', (keys || t`Entry Title/Memo`));
}

/**
 * Main function to build the WI entry editor template.
 * @param {string} name - The name of the world info file.
 * @param {object} data - The world info data object.
 * @param {object} entry - The entry object to be edited.
 */
async function getWorldEntry(name, data, entry) {
    if (!data.entries[entry.uid]) return;

    const thing = await entryDraftThing(name, data, entry.uid);
    if (!data.entries[entry.uid]) return;
    const uid = entry.uid;

    const headerTemplate = WI_ENTRY_HEADER_TEMPLATE.clone();
    headerTemplate.data('uid', entry.uid);
    headerTemplate.attr('uid', entry.uid);
    const header = headerTemplate;

    if (typeof power_user.wi_key_input_plaintext === 'undefined') power_user.wi_key_input_plaintext = true;

    // Comment
    const commentInput = headerTemplate.find('textarea[name="comment"]');

    //Update the commentInput's placeholder.
    const keys = entry.key.join(', ');
    setCommentPlaceholder(keys, commentInput);

    commentInput.data('uid', entry.uid);
    bindEntryField({
        control: commentInput, field: 'comment', type: 'text', name, data, uid, thing,
        stored: entryData => String(entryData.comment ?? ''),
        apply: (entryData, text) => {
            entryData.comment = text;
            setWIOriginalDataValue(data, uid, 'comment', text);
        },
    });
    commentInput.on('input', async function (_, { skipReset = false } = {}) {
        !skipReset && await resetScrollHeight(this);
    });

    // Order
    const orderInput = headerTemplate.find('input[name="order"]');
    orderInput.data('uid', entry.uid);
    bindEntryField({
        control: orderInput, field: 'order', type: 'number', name, data, uid, thing,
        stored: entryData => String(entryData.order ?? ''),
        apply: (entryData, text) => {
            const value = Number(text);
            entryData.order = !isNaN(value) ? value : 0;
            setWIOriginalDataValue(data, uid, 'insertion_order', entryData.order);
            updatePosOrdDisplayHelper({ template: headerTemplate, data, uid });
        },
    });
    orderInput.css('width', 'calc(3em + 15px)');

    // Probability
    handleProbabilityInputHelper({ probabilityInput: headerTemplate.find('input[name="probability"]'), data, entry, name, thing });

    // Depth
    handleNumberInputHelper({
        inputElem: headerTemplate.find('input[name="depth"]'),
        entry, entryKey: 'depth', data, name, min: 0, max: MAX_SCAN_DEPTH, clamp: false, thing,
    });
    headerTemplate.find('input[name="depth"]').css('width', 'calc(3em + 15px)');

    // Position
    if (entry.position === undefined) entry.position = 0;
    const positionInput = headerTemplate.find('select[name="position"]');
    positionInput.data('uid', entry.uid);
    positionInput.on('click', e => e.stopPropagation());
    bindEntryField({
        control: positionInput, field: 'position', type: 'toggle', name, data, uid, thing,
        stored: entryData => `${entryData.position ?? 0}:${entryData.position === world_info_position.atDepth ? String(entryData.role ?? extension_prompt_roles.SYSTEM) : ''}`,
        read: () => {
            const selected = positionInput.find(':selected');
            return `${selected.val()}:${selected.attr('data-role') ?? ''}`;
        },
        show: (text) => {
            const [value, role] = text.split(':');
            positionInput.find(`option[value="${value}"][data-role="${role}"]`).prop('selected', true);
        },
        live: (text) => {
            const atDepth = Number(text.split(':')[0]) === world_info_position.atDepth;
            const depthInput = headerTemplate.find('input[name="depth"]');
            depthInput.prop('disabled', !atDepth);
            depthInput.css('visibility', atDepth ? 'visible' : 'hidden');
        },
        apply: (entryData, text) => {
            const [value, role] = text.split(':');
            entryData.position = !isNaN(Number(value)) ? Number(value) : 0;
            entryData.role = entryData.position === world_info_position.atDepth ? Number(role) : null;
            updatePosOrdDisplayHelper({ template: headerTemplate, data, uid });
            setWIOriginalDataValue(data, uid, 'position', entryData.position == 0 ? 'before_char' : 'after_char');
            setWIOriginalDataValue(data, uid, 'extensions.position', entryData.position);
            setWIOriginalDataValue(data, uid, 'extensions.role', entryData.role);
        },
    });

    // Tri-state selector
    handleEntryStateSelectorHelper({
        entryStateSelector: headerTemplate.find('select[name="entryStateSelector"]'),
        entry, data, name, thing,
    });

    // Kill switch
    handleEntryKillSwitchHelper({
        entryKillSwitch: headerTemplate.find('div[name="entryKillSwitch"]'),
        entry, data, name, template: headerTemplate, thing,
    });

    // Duplicate/delete/move buttons
    headerTemplate.find('.duplicate_entry_button').data('uid', entry.uid).on('click', async function () {
        const uid = $(this).data('uid');
        const entryDup = await duplicateWorldInfoEntry(name, data, uid);
        if (entryDup) {
            await saveWorldInfoEntry(name, data, entryDup.uid);
            updateEditor(entryDup.uid);
        }
    });
    headerTemplate.find('.delete_entry_button').data('uid', entry.uid).on('click', async function (e) {
        e.stopPropagation();
        const uid = $(this).data('uid');
        const deleted = await deleteWorldInfoEntry(data, uid);
        if (!deleted) return;
        deleteWIOriginalDataValue(data, uid);
        const stored = await saveWorldInfo(name, data, true).catch(() => false);
        if (stored === true && thing) clearThingDrafts(localStorage, ENTRY_DRAFT_KIND, thing);
        updateEditor(navigation_option.previous);
    });
    headerTemplate.find('.move_entry_button').attr('data-uid', entry.uid).attr('data-current-world', name).on('click', async function (e) {
        e.stopPropagation();
        const sourceUid = $(this).attr('data-uid');
        const sourceWorld = $(this).attr('data-current-world');
        const sourceWorldInfo = await loadWorldInfo(sourceWorld);
        if (!sourceWorldInfo) return;
        const sourceName = sourceWorldInfo.entries[sourceUid]?.comment;
        if (sourceName === undefined) return;
        const select = document.createElement('select');
        select.id = 'move_entry_target_select';
        select.classList.add('text_pole', 'wide100p', 'marginTop10');
        const defaultOption = document.createElement('option');
        defaultOption.value = '';
        defaultOption.textContent = `-- ${t`Select Target Lorebook`} --`;
        select.appendChild(defaultOption);
        let selectableWorldCount = 0;
        world_names.forEach(worldName => {
            if (worldName !== sourceWorld) {
                const option = document.createElement('option');
                option.value = world_names.indexOf(worldName).toString();
                option.textContent = worldName;
                select.appendChild(option);
                selectableWorldCount++;
            }
        });
        if (selectableWorldCount === 0) {
            toastr.warning(t`There are no other lorebooks to move to.`);
            return;
        }
        const wrapper = document.createElement('div');
        wrapper.textContent = t`Move/Copy '${sourceName}' to:`;
        const container = document.createElement('div');
        container.appendChild(wrapper);
        container.appendChild(select);
        let selectedWorldIndex = -1;
        select.addEventListener('change', function () {
            selectedWorldIndex = this.value === '' ? -1 : Number(this.value);
        });
        const popup = new Popup(container, POPUP_TYPE.CONFIRM, '', {
            cancelButton: t`Cancel`,
            customButtons: [
                { text: t`Move`, result: POPUP_RESULT.CUSTOM1 },
                { text: t`Copy`, result: POPUP_RESULT.CUSTOM2 },
            ],
        });
        popup.okButton.style.display = 'none'; // Hide the default OK button
        const popupConfirm = await popup.show();
        if (!popupConfirm) return;
        if (selectedWorldIndex === -1) return;
        const selectedValue = world_names[selectedWorldIndex];
        if (!selectedValue) {
            toastr.warning(t`Please select a target lorebook.`);
            return;
        }
        const deleteOriginal = popupConfirm === POPUP_RESULT.CUSTOM1;
        if (deleteOriginal) {
            await Promise.all(headerTemplate.find('[data-wi-draft]').get().map(element => entryFieldBindings.get(element)?.handle({ type: 'close' })));
            if (thing && hasFieldDrafts(localStorage, ENTRY_DRAFT_KIND, thing)) {
                toastr.warning(t`'${sourceName}' has edits that aren't saved yet, so it wasn't moved. Save or undo them, then move it.`, t`Entry not moved`);
                return;
            }
        }
        await moveWorldInfoEntry(sourceWorld, selectedValue, sourceUid, { deleteOriginal });
    });

    let drawerInitialized = false;
    let drawerDestroyTimeout = null;
    headerTemplate.find('.inline-drawer').on('inline-drawer-toggle', function () {
        if (drawerDestroyTimeout) {
            clearTimeout(drawerDestroyTimeout);
            drawerDestroyTimeout = null;
        }
        if (drawerInitialized) {
            drawerDestroyTimeout = setTimeout(() => {
                // Drawer was reopened, so we don't destroy it
                if (editOutlet.is(':visible')) {
                    return;
                }
                drawerInitialized = false;
                clearEntryList(editOutlet);
                drawerDestroyTimeout = null;
            }, debounce_timeout.relaxed);
        } else {
            drawerInitialized = true;
            addEditorDrawerContent();
        }
    });

    const editOutlet = headerTemplate.find('.inline-drawer-outlet');

    function addEditorDrawerContent() {
        const editTemplate = WI_ENTRY_EDIT_TEMPLATE.clone();

        // UID display
        editTemplate.find('.world_entry_form_uid_value').text(`(UID: ${entry.uid})`);

        // Key inputs
        const keyInput = enableKeysInputHelper({ template: editTemplate, entry, entryPropName: 'key', originalDataValueName: 'keys', name, data, thing, header });
        const keySecondaryInput = enableKeysInputHelper({ template: editTemplate, entry, entryPropName: 'keysecondary', originalDataValueName: 'secondary_keys', name, data, thing, header });
        if (!keyInput.isFancy) initScrollHeight(keyInput.control);
        if (!keySecondaryInput.isFancy) initScrollHeight(keySecondaryInput.control);

        // Key input switch
        editTemplate.find('.switch_input_type_icon').on('click', function () {
            power_user.wi_key_input_plaintext = !power_user.wi_key_input_plaintext;
            saveSettingsDebounced('power_user.wi_key_input_plaintext');
            const uid = ($(this).parents('.world_entry')).data('uid');
            updateEditor(uid, false);
            $(`.world_entry[uid="${uid}"] .inline-drawer-icon`).trigger('click');
        }).each((_, icon) => {
            $(icon).attr('title', $(icon).data(power_user.wi_key_input_plaintext ? 'tooltip-on' : 'tooltip-off'));
            $(icon).text($(icon).data(power_user.wi_key_input_plaintext ? 'icon-on' : 'icon-off'));
        });

        // Probability toggle
        handleProbabilityToggleHelper({
            probabilityToggle: editTemplate.find('input[name="useProbability"]'),
            data, entry, name, thing,
            probabilityInput: headerTemplate.find('input[name="probability"]'),
        });

        const commentToggle = editTemplate.find('input[name="addMemo"]');
        commentToggle.data('uid', entry.uid);
        data.entries[uid].addMemo = true;
        bindCheckboxField({
            control: commentToggle, field: 'addMemo', name, data, uid, thing,
            stored: entryData => !!entryData.addMemo,
            onShow: (value) => {
                const commentContainer = commentToggle.closest('.world_entry').find('.commentContainer');
                value ? commentContainer.show() : commentContainer.hide();
            },
            apply: (entryData, value) => {
                entryData.addMemo = value;
            },
        });
        commentToggle.parent().hide();

        // Logic AND/NOT
        const selectiveLogicDropdown = editTemplate.find('select[name="entryLogicType"]');
        selectiveLogicDropdown.data('uid', entry.uid);
        selectiveLogicDropdown.on('click', e => e.stopPropagation());
        bindEntryField({
            control: selectiveLogicDropdown, field: 'selectiveLogic', type: 'toggle', name, data, uid, thing,
            stored: entryData => String(entryData.selectiveLogic ?? world_info_logic.AND_ANY),
            apply: (entryData, text) => {
                const value = Number(text);
                entryData.selectiveLogic = !isNaN(value) ? value : world_info_logic.AND_ANY;
                setWIOriginalDataValue(data, uid, 'selectiveLogic', entryData.selectiveLogic);
            },
        });

        const selectiveInput = editTemplate.find('input[name="selective"]');
        selectiveInput.data('uid', entry.uid);
        data.entries[uid].selective = true;
        setWIOriginalDataValue(data, uid, 'selective', true);
        bindCheckboxField({
            control: selectiveInput, field: 'selective', name, data, uid, thing,
            stored: entryData => !!entryData.selective,
            onShow: (value) => {
                const keysecondary = selectiveInput.closest('.world_entry').find('.keysecondary');
                const keysecondarytextpole = selectiveInput.closest('.world_entry').find('.keysecondarytextpole');
                const keyprimaryselect = selectiveInput.closest('.world_entry').find('.keyprimaryselect');
                const keyprimaryHeight = keyprimaryselect.outerHeight();
                keysecondarytextpole.css('height', keyprimaryHeight + 'px');
                value ? keysecondary.show() : keysecondary.hide();
            },
            apply: (entryData, value) => {
                entryData.selective = value;
                setWIOriginalDataValue(data, uid, 'selective', value);
            },
        });
        selectiveInput.parent().hide();

        // Character filter
        const characterFilterLabel = editTemplate.find('label[for="characterFilter"] > small');
        const characterExclusionInput = editTemplate.find('input[name="character_exclusion"]');
        characterExclusionInput.data('uid', entry.uid);
        bindCheckboxField({
            control: characterExclusionInput, field: 'character_exclusion', name, data, uid, thing,
            stored: entryData => entryData.characterFilter?.isExclude ?? false,
            onShow: value => characterFilterLabel.text(value ? 'Exclude Character(s)' : 'Filter to Character(s)'),
            apply: async (entryData, value) => {
                if (entryData.characterFilter) {
                    if (!value && entryData.characterFilter.names.length === 0 && entryData.characterFilter.tags.length === 0) {
                        delete entryData.characterFilter;
                    } else {
                        entryData.characterFilter.isExclude = value;
                    }
                } else if (value) {
                    Object.assign(entryData, { characterFilter: { isExclude: true, names: [], tags: [] } });
                }
                if (entryData.characterFilter?.names?.length > 0) {
                    const namesToCheck = entryData.characterFilter.names;
                    const existence = await checkCharactersExistOrNull(namesToCheck.map(name => `${name}.png`));
                    if (existence === null) {
                        console.warn('World Info: skipping character-filter existence prune this run (check failed).');
                    } else {
                        entryData.characterFilter.names = namesToCheck.filter(name => existence[`${name}.png`]);
                    }
                }
                setWIOriginalDataValue(data, uid, 'character_filter', entryData.characterFilter);
            },
        });

        const characterFilter = editTemplate.find('select[name="characterFilter"]');
        characterFilter.data('uid', entry.uid);
        initCharacterFilterSelect2Helper(characterFilter);
        handleCharacterFilterChangeHelper({ characterFilter, data, entry, name, thing });

        // Content
        const counter = editTemplate.find('.world_entry_form_token_counter');
        const countTokensDebounced = debounce(async function (counter, value) {
            // eslint-disable-next-line no-restricted-syntax -- counted on the page from before the ban: to move to the server (thin-client step 10, unfinished)
            const { count: numberOfTokens, answer } = await getTokenCountWithAnswer(value);
            $(counter).text(numberOfTokens);
            renderCountBasis(counter, answer);
        }, debounce_timeout.relaxed);
        const contentInputId = `world_entry_content_${entry.uid}`;
        const contentInput = editTemplate.find('textarea[name="content"]');
        contentInput.data('uid', entry.uid);
        contentInput.attr('id', contentInputId);
        contentInput[0].dataset.macros = ''; // active
        bindEntryField({
            control: contentInput, field: 'content', type: 'text', name, data, uid, thing,
            stored: entryData => String(entryData.content ?? ''),
            apply: (entryData, text) => {
                entryData.content = text;
                setWIOriginalDataValue(data, uid, 'content', text);
            },
        });
        contentInput.on('input', function (_, { skipCount } = {}) {
            if (!skipCount) countTokensDebounced(counter, $(this).val());
        });
        editTemplate.find('.editor_maximize').attr('data-for', contentInputId);

        // Outlet name
        const outletNameInput = editTemplate.find('input[name="outletName"]');
        outletNameInput.data('uid', entry.uid);
        bindEntryField({
            control: outletNameInput, field: 'outletName', type: 'line', name, data, uid, thing,
            stored: entryData => String(entryData.outletName ?? ''),
            apply: (entryData, text) => {
                entryData.outletName = text;
                setWIOriginalDataValue(data, uid, 'extensions.outlet_name', text);
            },
        });
        setTimeout(() => createEntryInputAutocomplete(outletNameInput, getOutletNameCallback(data), { allowMultiple: true }), 1);

        // Scan depth
        const scanDepthInput = editTemplate.find('input[name="scanDepth"]');
        scanDepthInput.data('uid', entry.uid);
        bindEntryField({
            control: scanDepthInput, field: 'scanDepth', type: 'number', name, data, uid, thing,
            stored: entryData => (entryData.scanDepth === null || entryData.scanDepth === undefined ? '' : String(entryData.scanDepth)),
            live: (text) => {
                const value = Number(text);
                if (value < 0) {
                    scanDepthInput.val(0);
                    toastr.warning('Scan depth cannot be negative');
                } else if (value > MAX_SCAN_DEPTH) {
                    scanDepthInput.val(MAX_SCAN_DEPTH);
                    toastr.warning(`Scan depth cannot exceed ${MAX_SCAN_DEPTH}`);
                }
            },
            apply: (entryData, text) => {
                const value = Number(text);
                entryData.scanDepth = text !== '' && !isNaN(value) && value >= 0 && value <= MAX_SCAN_DEPTH ? Math.floor(value) : null;
                setWIOriginalDataValue(data, uid, 'extensions.scan_depth', entryData.scanDepth);
            },
        });

        // Group
        const groupInput = editTemplate.find('input[name="group"]');
        groupInput.data('uid', entry.uid);
        bindEntryField({
            control: groupInput, field: 'group', type: 'line', name, data, uid, thing,
            stored: entryData => String(entryData.group ?? ''),
            apply: (entryData, text) => {
                entryData.group = text.trim();
                setWIOriginalDataValue(data, uid, 'extensions.group', entryData.group);
            },
        });
        setTimeout(() => createEntryInputAutocomplete(groupInput, getInclusionGroupCallback(data), { allowMultiple: true }), 1);

        // Inclusion priority
        const groupOverrideInput = editTemplate.find('input[name="groupOverride"]');
        groupOverrideInput.data('uid', entry.uid);
        bindCheckboxField({
            control: groupOverrideInput, field: 'groupOverride', name, data, uid, thing,
            stored: entryData => !!entryData.groupOverride,
            apply: (entryData, value) => {
                entryData.groupOverride = value;
                setWIOriginalDataValue(data, uid, 'extensions.group_override', value);
            },
        });

        // Group weight
        handleNumberInputHelper({
            inputElem: editTemplate.find('input[name="groupWeight"]'),
            entry, entryKey: 'groupWeight', data, name, min: 1, max: 10000, clamp: true, thing,
        });

        // Sticky, cooldown, delay
        handleNumberInputHelper({
            inputElem: editTemplate.find('input[name="sticky"]'),
            entry, entryKey: 'sticky', data, name, min: 1, max: 10000, clamp: false, thing,
        });
        handleNumberInputHelper({
            inputElem: editTemplate.find('input[name="cooldown"]'),
            entry, entryKey: 'cooldown', data, name, min: 1, max: 10000, clamp: false, thing,
        });
        handleNumberInputHelper({
            inputElem: editTemplate.find('input[name="delay"]'),
            entry, entryKey: 'delay', data, name, min: 1, max: 10000, clamp: false, thing,
        });

        // Exclude/prevent recursion
        handleMatchCheckboxHelper({ template: editTemplate, entry, fieldName: 'excludeRecursion', data, name, thing });
        handleMatchCheckboxHelper({ template: editTemplate, entry, fieldName: 'preventRecursion', data, name, thing });

        // Delay until recursion
        const delayUntilRecursionInput = editTemplate.find('input[name="delay_until_recursion"]');
        delayUntilRecursionInput.data('uid', entry.uid);
        const delayUntilRecursionLevelInput = editTemplate.find('input[name="delayUntilRecursionLevel"]');
        delayUntilRecursionLevelInput.data('uid', entry.uid);
        bindCheckboxField({
            control: delayUntilRecursionInput, field: 'delay_until_recursion', name, data, uid, thing,
            stored: entryData => !!entryData.delayUntilRecursion,
            apply: (entryData, toggled) => {
                entryData.delayUntilRecursion = toggled ? entryData.delayUntilRecursion || true : false;
                setWIOriginalDataValue(data, uid, 'extensions.delay_until_recursion', entryData.delayUntilRecursion);
            },
        });
        delayUntilRecursionInput.on('input', function () {
            if (!$(this).prop('checked')) delayUntilRecursionLevelInput.val('');
        });
        bindEntryField({
            control: delayUntilRecursionLevelInput, field: 'delayUntilRecursionLevel', type: 'line', name, data, uid, thing,
            stored: entryData => (['number', 'string'].includes(typeof entryData.delayUntilRecursion) ? String(entryData.delayUntilRecursion) : ''),
            apply: (entryData, content) => {
                entryData.delayUntilRecursion = content === '' ? (typeof entryData.delayUntilRecursion === 'boolean' ? entryData.delayUntilRecursion : true)
                    : !isNaN(Number(content)) ? Number(content)
                        : false;
                setWIOriginalDataValue(data, uid, 'extensions.delay_until_recursion', entryData.delayUntilRecursion);
            },
        });

        // Boolean selects
        handleBooleanSelectHelper({ selectElem: editTemplate.find('select[name="caseSensitive"]'), entry, entryKey: 'caseSensitive', data, name, thing });
        handleBooleanSelectHelper({ selectElem: editTemplate.find('select[name="matchWholeWords"]'), entry, entryKey: 'matchWholeWords', data, name, thing });
        handleBooleanSelectHelper({ selectElem: editTemplate.find('select[name="useGroupScoring"]'), entry, entryKey: 'useGroupScoring', data, name, thing });

        // Match checkboxes
        handleMatchCheckboxHelper({ template: editTemplate, entry, fieldName: 'matchPersonaDescription', data, name, thing });
        handleMatchCheckboxHelper({ template: editTemplate, entry, fieldName: 'matchCharacterDescription', data, name, thing });
        handleMatchCheckboxHelper({ template: editTemplate, entry, fieldName: 'matchCharacterPersonality', data, name, thing });
        handleMatchCheckboxHelper({ template: editTemplate, entry, fieldName: 'matchCharacterDepthPrompt', data, name, thing });
        handleMatchCheckboxHelper({ template: editTemplate, entry, fieldName: 'matchScenario', data, name, thing });
        handleMatchCheckboxHelper({ template: editTemplate, entry, fieldName: 'matchCreatorNotes', data, name, thing });

        // Automation ID
        const automationIdInput = editTemplate.find('input[name="automationId"]');
        automationIdInput.data('uid', entry.uid);
        bindEntryField({
            control: automationIdInput, field: 'automationId', type: 'line', name, data, uid, thing,
            stored: entryData => String(entryData.automationId ?? ''),
            apply: (entryData, text) => {
                entryData.automationId = text;
                setWIOriginalDataValue(data, uid, 'extensions.automation_id', text);
            },
        });
        setTimeout(() => createEntryInputAutocomplete(automationIdInput, getAutomationIdCallback(data)), 1);

        // Generation Type Triggers
        const generationTypeTriggers = editTemplate.find('select[name="triggers"]');
        generationTypeTriggers.data('uid', entry.uid);
        if (!isMobile()) {
            generationTypeTriggers.select2({
                placeholder: t`All types (default)`,
                width: '100%',
                closeOnSelect: false,
                allowClear: true,
            });
        }
        bindEntryField({
            control: generationTypeTriggers, field: 'triggers', type: 'toggle', name, data, uid, thing,
            stored: entryData => JSON.stringify(Array.isArray(entryData.triggers) ? entryData.triggers : []),
            read: () => {
                const value = generationTypeTriggers.val();
                return JSON.stringify(Array.isArray(value) ? value : []);
            },
            show: text => generationTypeTriggers.val(JSON.parse(text)).trigger('change'),
            apply: (entryData, text) => {
                entryData.triggers = JSON.parse(text);
                setWIOriginalDataValue(data, uid, 'extensions.triggers', entryData.triggers);
            },
        });

        // Ignore budget
        const ignoreBudgetInput = editTemplate.find('input[name="ignoreBudget"]');
        ignoreBudgetInput.data('uid', entry.uid);
        bindCheckboxField({
            control: ignoreBudgetInput, field: 'ignoreBudget', name, data, uid, thing,
            stored: entryData => entryData.ignoreBudget ?? false,
            apply: (entryData, value) => {
                entryData.ignoreBudget = value;
                setWIOriginalDataValue(data, uid, 'extensions.ignore_budget', value);
            },
        });

        countTokensDebounced(counter, contentInput.val());

        editTemplate.find('.inline-drawer-content').css('display', 'none');
        editOutlet.append(editTemplate);
    }

    headerTemplate.find('.inline-drawer-content').css('display', 'none');

    return headerTemplate;
}


/**
 * Builds a jQuery UI autocomplete callback: (control, request, response) => void
 * @param {object} [opt={}] - Optional arguments
 * @param {{entries: Record<string, any>}} [opt.data]   - Your WI data
 * @param {(entry:any)=>string|string[]|null|undefined} [opt.collectValues] - Extract values from one entry
 * @param {() => Iterable<string>} [opt.includeExtras] - Optional global extras to include
 * @param {(ctx:{result:string[], control:JQuery, input:any, haystack:string[]})=>string[]} [opt.postFilter] - Optional final filter step (for special rules like your "group" de-dupe logic)
 */
function buildAutocompleteCallback({ data, collectValues, includeExtras = () => [], postFilter } = {}) {
    return function (control, input, output) {
        const uid = $(control).data('uid');

        const values = new Set();
        for (const entry of Object.values(data.entries ?? {})) {
            if (entry?.uid == uid) continue;
            const raw = collectValues(entry);
            if (raw == null) continue;
            const arr = Array.isArray(raw) ? raw : [raw];
            for (const v of arr) {
                const s = String(v).trim();
                if (s) values.add(s);
            }
        }

        for (const v of includeExtras()) {
            const s = String(v).trim();
            if (s) values.add(s);
        }

        const haystack = Array.from(values).sort((a, b) => a.localeCompare(b));

        const needle = String(input.term ?? '').toLowerCase();
        let result = haystack.filter(x => x.toLowerCase().includes(needle));

        if (postFilter) {
            result = postFilter({ result, control: $(control), input, haystack });
        }

        output(result);
    };
}

/**
 * Splits a string into an array of strings, separated by commas and trimmed
 * @param {string} s - The string to split
 * @returns {string[]} An array of strings, separated by commas and trimmed
 */
const splitCsv = s => String(s ?? '').split(/,\s*/).filter(Boolean);

/**
 * Get the inclusion groups for the autocomplete.
 * @param {any} data WI data
 * @returns {(input: any, output: any) => any} Callback function for the autocomplete
 */
function getInclusionGroupCallback(data) {
    return buildAutocompleteCallback({
        data,
        collectValues: entry => entry.group ? splitCsv(entry.group) : [],
        postFilter: ({ result, control, input, haystack }) => {
            const thisGroups = splitCsv(String($(control).val()));
            const needle = String(input.term ?? '').toLowerCase();
            const hasExactMatch = haystack.some(x => x.toLowerCase() === needle);

            // include suggestion if it contains the needle AND
            // (not already present OR (exact match typed && appears only once))
            return result.filter(x =>
                !thisGroups.includes(x) ||
                (hasExactMatch && thisGroups.filter(g => g === x).length === 1),
            );
        },
    });
}

function getAutomationIdCallback(data) {
    return buildAutocompleteCallback({
        data,
        collectValues: entry => entry.automationId != null ? [String(entry.automationId)] : [],
        includeExtras: () =>
            ('quickReplyApi' in globalThis && globalThis.quickReplyApi?.listAutomationIds)
                ? globalThis.quickReplyApi.listAutomationIds()
                : [],
    });
}

function getOutletNameCallback(data) {
    return buildAutocompleteCallback({
        data,
        collectValues: entry => entry.position === world_info_position.outlet && entry.outletName ? [entry.outletName] : [],
    });
}

/**
 * Create an autocomplete for an input element.
 * @param {JQuery<HTMLElement>} input - Input element to attach the autocomplete to
 * @param {(control: JQuery<HTMLElement>, input: any, output: any) => any} callback - Source data callbacks
 * @param {object} [options={}] - Optional arguments
 * @param {boolean} [options.allowMultiple=false] - Whether to allow multiple comma-separated values
 */
function createEntryInputAutocomplete(input, callback, { allowMultiple = false } = {}) {
    const handleSelect = (event, ui) => {
        // Prevent default autocomplete select, so we can manually set the value
        event.preventDefault();
        if (!allowMultiple) {
            $(input).val(ui.item.value).trigger('input').trigger('blur');
        } else {
            var terms = String($(input).val()).split(/,\s*/);
            terms.pop(); // remove the current input
            terms.push(ui.item.value); // add the selected item
            $(input).val(terms.filter(x => x).join(', ')).trigger('input').trigger('blur');
        }
    };

    $(input).autocomplete({
        minLength: 0,
        source: function (request, response) {
            if (!allowMultiple) {
                callback(input, request, response);
            } else {
                const term = request.term.split(/,\s*/).pop();
                request.term = term;
                callback(input, request, response);
            }
        },
        select: handleSelect,
    });

    $(input).on('focus click', function () {
        $(input).autocomplete('search', allowMultiple ? String($(input).val()).split(/,\s*/).pop() : String($(input).val()));
    });
}


/**
 * Duplicate a WI entry by copying all of its properties and assigning a new uid
 * @param {string} name - The name of the book
 * @param {*} data - The data of the book
 * @param {number} uid - The uid of the entry to copy in this book
 * @returns {Promise<object | undefined>} The copy, or undefined if it couldn't be created
 */
async function duplicateWorldInfoEntry(name, data, uid) {
    if (!data || !('entries' in data) || !data.entries[uid]) {
        return;
    }
    const copy = structuredClone(data.entries[uid]);
    delete copy.uid;
    const entry = await createWorldInfoEntry(name, data);
    if (!entry) {
        return;
    }
    Object.assign(entry, copy);
    return entry;
}

/**
 * Deletes a WI entry, with a user confirmation dialog
 * @param {*[]} data - The data of the book
 * @param {number} uid - The uid of the entry to copy in this book
 * @param {object} [options={}] - Optional arguments
 * @param {boolean} [options.silent=false] - Whether to prompt the user for deletion or just do it
 * @returns {Promise<boolean>} Whether the entry deletion was successful
 */
async function deleteWorldInfoEntry(data, uid, { silent = false } = {}) {
    if (!data || !('entries' in data)) {
        return;
    }

    const entry = data.entries[uid];
    if (!entry) {
        return false;
    }

    let previewText = '';
    if (entry.comment && entry.comment.trim()) {
        previewText = entry.comment.trim();
    } else if (entry.content) {
        const lines = entry.content.split(/\r?\n/).filter(line => line.trim());
        previewText = lines.slice(0, 2).join('\n');
    }

    const popupHeader = t`Delete world info entry with UID: ${uid}?`;
    const popupText = previewText
        ? `<strong>${t`Entry`}:</strong><br>${escapeHtml(previewText).replace(/\n/g, '<br>')}<br><br>${t`This action is irreversible!`}`
        : t`This action is irreversible!`;

    const confirmation = silent || await Popup.show.confirm(popupHeader, popupText);
    if (!confirmation) {
        return false;
    }

    delete data.entries[uid];
    return true;
}

/**
 * Definitions of types for new WI entries
 *
 * Use `newEntryTemplate` if you just need the template that contains default values
 *
 * @type {{[key: string]: WIEntryFieldDefinition}}
 */
const newWorldInfoEntryDefinition = {
    key: { default: [], type: 'array' },
    keysecondary: { default: [], type: 'array' },
    comment: { default: '', type: 'string' },
    content: { default: '', type: 'string' },
    constant: { default: false, type: 'boolean' },
    vectorized: { default: false, type: 'boolean' },
    selective: { default: true, type: 'boolean' },
    selectiveLogic: { default: world_info_logic.AND_ANY, type: 'enum' },
    addMemo: { default: false, type: 'boolean' },
    order: { default: 100, type: 'number' },
    position: { default: 0, type: 'number' },
    disable: { default: false, type: 'boolean' },
    ignoreBudget: { default: false, type: 'boolean' },
    excludeRecursion: { default: false, type: 'boolean' },
    preventRecursion: { default: false, type: 'boolean' },
    matchPersonaDescription: { default: false, type: 'boolean' },
    matchCharacterDescription: { default: false, type: 'boolean' },
    matchCharacterPersonality: { default: false, type: 'boolean' },
    matchCharacterDepthPrompt: { default: false, type: 'boolean' },
    matchScenario: { default: false, type: 'boolean' },
    matchCreatorNotes: { default: false, type: 'boolean' },
    delayUntilRecursion: { default: 0, type: 'number' },
    probability: { default: 100, type: 'number' },
    useProbability: { default: true, type: 'boolean' },
    depth: { default: DEFAULT_DEPTH, type: 'number' },
    outletName: { default: '', type: 'string' },
    group: { default: '', type: 'string' },
    groupOverride: { default: false, type: 'boolean' },
    groupWeight: { default: DEFAULT_WEIGHT, type: 'number' },
    scanDepth: { default: null, type: 'number?' },
    caseSensitive: { default: null, type: 'boolean?' },
    matchWholeWords: { default: null, type: 'boolean?' },
    useGroupScoring: { default: null, type: 'boolean?' },
    automationId: { default: '', type: 'string' },
    role: { default: 0, type: 'enum' },
    sticky: { default: null, type: 'number?' },
    cooldown: { default: null, type: 'number?' },
    delay: { default: null, type: 'number?' },
    characterFilterNames: { default: [], type: 'array', excludeFromTemplate: true },
    characterFilterTags: { default: [], type: 'array', excludeFromTemplate: true },
    characterFilterExclude: { default: false, type: 'boolean', excludeFromTemplate: true },
    triggers: { default: [], type: 'array', arrayFilter: (value) => GENERATION_TYPE_TRIGGERS.includes(value) },
};

const newWorldInfoEntryTemplate = Object.fromEntries(
    Object.entries(newWorldInfoEntryDefinition).filter(([_, value]) => !value.excludeFromTemplate).map(([key, value]) => [key, value.default]),
);

/**
 * Creates a new world info entry from template, under the lowest uid free in `data` ({@link getFreeWorldEntryUid}).
 *
 * In a book the server has, the entry is also stored there at once (POST /api/worldinfo/entry/create), so another
 * page can't take its uid; the book's saves wait for that. If another page took the uid since this page loaded the
 * book, the server gives the entry the lowest free one and it moves there ({@link moveNewEntry}) before anything of
 * it is saved. A creation the server refuses takes the entry out of `data` again.
 * @param {string} name Name of the WI ({@link EMBEDDED_WORLD_NAME} or none: the entry is only added to `data`)
 * @param {any} data WI data
 * @returns {Promise<object | undefined>} New entry object or undefined if failed
 */
export async function createWorldInfoEntry(name, data) {
    const newUid = getFreeWorldEntryUid(data);

    if (!Number.isInteger(newUid)) {
        console.error('Couldn\'t assign UID to a new entry');
        return;
    }

    const newEntry = { uid: newUid, ...structuredClone(newWorldInfoEntryTemplate) };
    data.entries[newUid] = newEntry;

    if (name && name !== EMBEDDED_WORLD_NAME && world_names?.includes(name) && !await storeNewEntry(name, data, newEntry)) {
        if (data.entries[newEntry.uid] === newEntry) delete data.entries[newEntry.uid];
        return;
    }

    return newEntry;
}

function getFreeWorldEntryUid(data) {
    if (!data || !('entries' in data)) {
        return null;
    }

    const MAX_UID = 1_000_000;
    for (let uid = 0; uid < MAX_UID; uid++) {
        if (uid in data.entries) {
            continue;
        }
        return uid;
    }

    return null;
}

/** @type {Map<string, Promise<void>>} */
const entryCreates = new Map();

/**
 * @param {string} name
 * @param {any} data
 * @param {any} entry
 * @returns {Promise<boolean>}
 */
function storeNewEntry(name, data, entry) {
    const created = (entryCreates.get(name) ?? Promise.resolve()).then(async () => {
        let result;
        try {
            const response = await trackWorldWrite(name, fetch('/api/worldinfo/entry/create', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ name, uid: entry.uid }),
            }));
            if (!response.ok) throw new Error(`Server responded with ${response.status}`);
            result = await response.json();
        } catch (error) {
            console.error(`[WI] Couldn't store new entry ${entry.uid} in '${name}'`, error);
            return false;
        }
        const uid = result?.entry?.uid;
        if (!Number.isInteger(uid)) {
            console.error(`[WI] Couldn't store new entry ${entry.uid} in '${name}': no uid in the answer`);
            return false;
        }
        if (uid !== entry.uid) moveNewEntry(name, data, entry, uid);
        noteStoredEntry(name, uid, result.entry);
        return true;
    });
    const queued = created.then(() => {});
    entryCreates.set(name, queued);
    queued.then(() => {
        if (entryCreates.get(name) === queued) entryCreates.delete(name);
    });
    return created;
}

/**
 * @param {string} name
 * @param {any} data
 * @param {any} entry
 * @param {number} uid
 */
function moveNewEntry(name, data, entry, uid) {
    const from = entry.uid;
    const other = data.entries[uid];
    delete data.entries[from];
    if (other && other !== entry) {
        other.uid = from;
        data.entries[from] = other;
    }
    entry.uid = uid;
    data.entries[uid] = entry;
    const pending = pendingEntrySaves.get(name);
    if (pending) {
        const had = (/** @type {number} */ u) => [pending.delete(u), pending.delete(String(u))].includes(true);
        const [hadFrom, hadTo] = [had(from), had(uid)];
        if (hadFrom) pending.add(uid);
        if (hadTo) pending.add(from);
    }
    console.warn(`[WI] '${name}': uid ${from} was taken elsewhere meanwhile, so the new entry is ${uid}`);
}

/**
 * @param {string} name
 * @param {string|number|null} uid
 * @param {any} entryData
 * @param {Response|unknown} reason
 */
function showWorldInfoSaveFailed(name, uid, entryData, reason) {
    const entryLabel = entryData?.comment ? `${uid} (${entryData.comment})` : String(uid);
    const what = uid === null
        ? t`'${name}' was not saved.`
        : t`Entry ${entryLabel} in '${name}' was not saved.`;
    const hint = reason instanceof Response
        ? t`Check the server console for details.`
        : t`Check the server connection.`;
    console.error(`[WI] ${what}`, reason);
    toastr.error(`${what} ${hint}`, t`World Info could not be saved`);
}

/**
 * @param {string} name
 * @returns {boolean}
 */
function refuseEmbeddedWorldName(name) {
    if (name !== EMBEDDED_WORLD_NAME) {
        return false;
    }
    const what = t`'${name}' was not saved.`;
    console.error(`[WI] ${what} The name is reserved for embedded lorebooks.`);
    toastr.error(`${what} ${t`That name is reserved for embedded lorebooks. Choose another name.`}`, t`World Info could not be saved`);
    return true;
}

/**
 * @param {string} name
 * @param {any} data
 * @returns {Promise<boolean>}
 */
async function _save(name, data) {
    cancelWorldSaveDebounced(name);
    await entryCreates.get(name);

    const create = () => trackWorldWrite(name, fetch('/api/worldinfo/create', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ name, unique: false, data }),
    }));
    const apply = (/** @type {BookVersion} */ version) => {
        bookVersions.set(name, version);
        return trackWorldWrite(name, fetch('/api/worldinfo/entries/apply', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ name, ...changesAgainst(version, data) }),
        }));
    };

    let response;
    try {
        const version = bookVersions.get(name)
            ?? (world_names?.includes(name) ? await trackWorldWrite(name, fetchBookVersion(name)) : null);
        response = version ? await apply(version) : await create();
        if (response.status === 404 && version) {
            response = await create();
        } else if (response.status === 409 && !version) {
            response = await apply(await trackWorldWrite(name, fetchBookVersion(name)));
        }
        if (response.ok && new URL(response.url).pathname.endsWith('/create')) {
            bookVersions.set(name, versionOf(data));
            return true;
        }
    } catch (error) {
        dropUnwrittenBookFromCache(name);
        showWorldInfoSaveFailed(name, null, null, error);
        throw error;
    }

    if (!response.ok) {
        dropUnwrittenBookFromCache(name);
        showWorldInfoSaveFailed(name, null, null, response);
        return false;
    }

    const result = await response.json().catch(() => ({}));
    for (const [uid, entry] of Object.entries(result.entries ?? {})) noteStoredEntry(name, uid, entry);
    const deletedBookId = bookIds.get(name);
    for (const uid of result.deleted ?? []) {
        noteStoredEntry(name, uid, null);
        if (deletedBookId) clearThingDrafts(localStorage, ENTRY_DRAFT_KIND, `book:${deletedBookId}:${uid}`);
    }
    const version = bookVersions.get(name);
    for (const [key, value] of Object.entries(result.fields ?? {})) {
        if (value === null) version?.fields.delete(key); else version?.fields.set(key, jsonHash(value));
    }
    const conflicts = Array.isArray(result.conflicts) ? result.conflicts : [];
    if (conflicts.length) showWorldInfoConflicts(name, data, conflicts);

    return conflicts.length === 0;
}

/**
 * @param {BookVersion} version
 * @param {any} data
 */
function changesAgainst(version, data) {
    const entries = [];
    const present = data?.entries ?? {};
    for (const [uid, entry] of Object.entries(present)) {
        const base = version.entries.get(uid) ?? null;
        if (jsonHash(entry) !== base) entries.push({ uid: entry?.uid ?? uid, base_hash: base, data: entry });
    }
    for (const [uid, base] of version.entries) {
        if (!(uid in present)) entries.push({ uid, base_hash: base, data: null });
    }
    const fields = [];
    const keys = new Set([...Object.keys(data ?? {}), ...version.fields.keys()]);
    keys.delete('entries');
    for (const key of keys) {
        const value = data?.[key];
        const base = version.fields.get(key) ?? null;
        if ((value === undefined ? null : jsonHash(value)) !== base) fields.push({ key, base_hash: base, value: value ?? null });
    }
    return { entries, fields };
}

/**
 * @param {string} name
 * @param {any} data
 * @param {{ uid?: string, key?: string }[]} conflicts
 */
function showWorldInfoConflicts(name, data, conflicts) {
    const names = conflicts.map(conflict => {
        if (conflict.key !== undefined) return escapeHtml(t`the lorebook's ${conflict.key}`);
        const entry = data?.entries?.[conflict.uid];
        const title = entry?.comment || (Array.isArray(entry?.key) ? entry.key.join(', ') : '');
        return escapeHtml(title ? `${title} (#${conflict.uid})` : `#${conflict.uid}`);
    });
    console.warn(`[WI] Changes to '${name}' not stored, changed elsewhere since:`, conflicts);
    toastr.warning(`${t`These were changed elsewhere since you opened '${escapeHtml(name)}', so your changes to them were not saved. Reload the lorebook to see the current version:`}<br />${names.join('<br />')}`,
        t`World Info not saved`, { escapeHtml: false, timeOut: 0, extendedTimeOut: 0 });
}

/**
 * @param {string} name
 */
function dropUnwrittenBookFromCache(name) {
    if (!world_names?.includes(name)) {
        worldInfoCache.delete(name);
    }
}

/** @type {Map<string, Set<string|number>>} */
let pendingEntrySaves = new Map();

const flushEntrySavesDebounced = debounce(async () => {
    const pending = pendingEntrySaves;
    pendingEntrySaves = new Map();
    for (const [bookName, uids] of pending) {
        const data = worldInfoCache.get(bookName);
        for (const uid of uids) {
            const entryData = data?.entries?.[uid];
            if (!entryData) continue;
            try {
                await _saveEntry(bookName, uid, entryData, data);
            } catch {
                // _saveEntry has already shown and logged the failure; the other pending entries still get saved.
            }
        }
    }
}, debounce_timeout.relaxed);

/**
 * @typedef {object} HeldWorldSaves
 * @property {any} [data]
 * @property {Set<string|number>} [entries]
 */

/**
 * @param {string} name
 * @returns {HeldWorldSaves|null}
 */
function holdWorldSaves(name) {
    const book = pendingWorldSaves.get(name);
    const entries = pendingEntrySaves.get(name);
    if (!book && !entries?.size) {
        return null;
    }
    cancelWorldSaveDebounced(name);
    pendingEntrySaves.delete(name);
    return { data: book?.data, entries: entries?.size ? entries : undefined };
}

/**
 * @param {string} name
 * @returns {Promise<HeldWorldSaves|null>}
 */
async function holdWorldSavesUntilSettled(name) {
    let held = holdWorldSaves(name);
    while (worldWritesInFlight.has(name)) {
        await worldWritesSettled(name);
        const more = holdWorldSaves(name);
        if (!more) {
            continue;
        }
        if (!held) {
            held = more;
            continue;
        }
        const entries = new Set([...(held.entries ?? []), ...(more.entries ?? [])]);
        held = {
            data: more.data !== undefined ? more.data : held.data,
            entries: entries.size ? entries : undefined,
        };
    }
    return held;
}

/**
 * @param {string} name
 * @param {HeldWorldSaves|null} held
 */
function resumeWorldSaves(name, held) {
    if (!held) {
        return;
    }
    if (held.data !== undefined && !pendingWorldSaves.has(name)) {
        saveWorldDebounced(name, worldInfoCache.has(name) ? worldInfoCache.get(name) : held.data);
    }
    if (held.entries) {
        const uids = pendingEntrySaves.get(name) ?? new Set();
        held.entries.forEach(uid => uids.add(uid));
        pendingEntrySaves.set(name, uids);
        flushEntrySavesDebounced();
    }
}

/**
 * @param {string} name
 * @param {string|number} uid
 * @param {any} entryData
 * @param {any} data
 * @returns {Promise<boolean>}
 */
async function _saveEntry(name, uid, entryData, data) {
    await entryCreates.get(name);
    if (Number.isInteger(entryData?.uid)) uid = entryData.uid;
    let response;
    try {
        response = await trackWorldWrite(name, fetch('/api/worldinfo/entry/edit', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ name: name, uid: uid, data: entryData }),
        }));
    } catch (error) {
        showWorldInfoSaveFailed(name, uid, entryData, error);
        throw error;
    }

    if (!response.ok) {
        showWorldInfoSaveFailed(name, uid, entryData, response);
        return false;
    }

    noteStoredEntry(name, uid, (await response.json().catch(() => null))?.entry ?? null);
    return true;
}

/**
 * @param {string} name
 * @param {any} data
 * @param {string|number} uid
 * @param {boolean} [immediately=false]
 * @return {Promise<boolean|void>}
 */
export async function saveWorldInfoEntry(name, data, uid, immediately = false) {
    if (!name || !data || uid === undefined || uid === null) {
        return;
    }

    if (name === EMBEDDED_WORLD_NAME) {
        if (immediately) {
            return await saveEmbeddedLore(data);
        }
        return saveEmbeddedLoreDebounced(data);
    }

    worldInfoCache.set(name, data);

    if (immediately) {
        pendingEntrySaves.get(name)?.delete(uid);
        const entryData = data.entries?.[uid];
        if (!entryData) {
            return;
        }
        return await _saveEntry(name, uid, entryData, data);
    }

    if (!pendingEntrySaves.has(name)) {
        pendingEntrySaves.set(name, new Set());
    }
    pendingEntrySaves.get(name).add(uid);
    flushEntrySavesDebounced();
}


/**
 * Saves the world info
 *
 * This will also refresh the `worldInfoCache`.
 * Note, for performance reasons the saved cache will not make a deep clone of the data.
 * It is your responsibility to not modify the saved data object after calling this function, or there will be data inconsistencies.
 * Call `loadWorldInfoData` or query directly from cache if you need the object again.
 *
 * @param {string} name - The name of the world info
 * @param {any} data - The data to be saved
 * @param {boolean} [immediately=false] - Whether to save immediately or use debouncing
 * @return {Promise<boolean|void>} For an immediate save of a World Info file, whether the file was written
 * (a failed write shows an error toast); nothing otherwise. A debounced write that fails shows the same
 * toast when it runs.
 */
export async function saveWorldInfo(name, data, immediately = false) {
    if (!name || !data) {
        return;
    }

    if (name === EMBEDDED_WORLD_NAME) {
        if (immediately) {
            return await saveEmbeddedLore(data);
        }
        return saveEmbeddedLoreDebounced(data);
    }

    // Update cache immediately, so any future call can pull from this
    worldInfoCache.set(name, data);

    if (immediately) {
        return await _save(name, data);
    }

    saveWorldDebounced(name, data);
}

/**
 * @param {string} name
 * @param {string} newName
 * @returns {Promise<boolean>}
 */
async function duplicateWorldInfo(name, newName) {
    await flushWorldSaves(name);
    const response = await fetch('/api/worldinfo/duplicate', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ name, new_name: newName }),
    });
    if (response.status === 409) {
        toastr.error(t`A lorebook named '${newName}' already exists. Choose another name.`, t`World Info not copied`);
        return false;
    }
    if (!response.ok) {
        toastr.error(t`'${name}' could not be copied. Check the server console for details.`, t`World Info not copied`);
        return false;
    }
    return true;
}

async function renameWorldInfo(name, data) {
    const oldName = name;
    const newName = await Popup.show.input('Rename World Info', 'Enter a new name:', oldName);

    if (oldName === newName || !newName) {
        console.debug('World info rename cancelled');
        return;
    }
    if (equalsIgnoreCaseAndAccents(oldName, newName)) {
        toastr.warning(t`Name not accepted, as it is the same as before (ignoring case and accents).`, t`Rename World Info`);
        return;
    }
    if (refuseEmbeddedWorldName(newName)) {
        return;
    }

    let linkedTotal = 0;
    try {
        linkedTotal = Number((await characterRepository.query({ world: oldName }, undefined, 1, 1, ['total'])).total) || 0;
    } catch (error) {
        console.error('Could not count the characters linked to the lorebook', error);
    }
    const relinkCharacters = linkedTotal > 0 && await Popup.show.confirm(
        t`Rename World/Lorebook`,
        `<p>${t`${linkedTotal} character(s) have this lorebook as their primary lorebook. Move their links to the new name as well?`}</p>`,
    ) == POPUP_RESULT.AFFIRMATIVE;

    await flushWorldSaves(oldName);
    const response = await fetch('/api/worldinfo/rename', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ name: oldName, new_name: newName, relink_characters: relinkCharacters }),
    });
    if (response.status === 409) {
        toastr.error(t`A lorebook named '${newName}' already exists. Choose another name.`, t`World Info not renamed`);
        return;
    }
    if (!response.ok) {
        toastr.error(t`'${oldName}' could not be renamed. Check the server console for details.`, t`World Info not renamed`);
        return;
    }
    /** @type {{ characters_updated: string[], characters_failed: string[], settings: Record<string, any>, settings_hash?: number }} */
    const result = await response.json();

    const cached = worldInfoCache.has(oldName) ? worldInfoCache.get(oldName) : data;
    worldInfoCache.delete(oldName);
    worldInfoCache.set(newName, cached);
    bookVersions.set(newName, versionOf(cached));
    await takeRenamedBook(oldName, newName, result);

    await updateWorldInfoList();
    if (linkedTotal > 0 && (!relinkCharacters || result.characters_failed?.length)) {
        await warnCharactersStillLinked(oldName, newName);
    }

    const selectedIndex = world_names.indexOf(newName);
    if (selectedIndex !== -1) {
        $('#world_editor_select').val(selectedIndex).trigger('change');
    }
}

/**
 * @param {string} oldName
 * @param {string} newName
 * @param {{ characters_updated?: string[], characters_failed?: string[], settings?: Record<string, any>, settings_hash?: number }} result
 */
async function takeRenamedBook(oldName, newName, result) {
    const renamedId = bookIds.get(oldName);
    bookIds.delete(oldName);
    if (renamedId) bookIds.set(newName, renamedId);
    takeRenamedBookLinks(oldName, newName, result);

    if (chat_metadata[METADATA_KEY] === oldName) {
        chat_metadata[METADATA_KEY] = newName;
        await saveMetadata();
    }

    for (const avatar of result.characters_failed ?? []) {
        toastr.error(`Failed to update link for ${escapeHtml(String(charactersStore.get(avatar)?.name ?? avatar))}.`, '', { escapeHtml: false });
    }
    if (result.characters_updated?.length) {
        toastr.success(t`Updated primary lorebook links for ${result.characters_updated.length} character(s).`);
        const editorAvatar = String($('#avatar_url_pole').val() ?? '');
        if (menu_type != 'create' && result.characters_updated.includes(editorAvatar) && $('#character_world').val() === oldName) {
            $('#character_world').val(newName);
        }
        let activeCharacterUpdated = false;
        for (const avatar of result.characters_updated) {
            await getOneCharacter(avatar);
            if (avatar === getCurrentCharacter()?.avatar) activeCharacterUpdated = true;
        }
        if (activeCharacterUpdated) {
            const avatar = getCurrentCharacter()?.avatar;
            select_selected_character(avatar, { switchMenu: false });
            setWorldInfoButtonClass(avatar, true);
        }
    }
}

/**
 * @param {string} oldName
 * @param {string} newName
 * @param {{ settings: Record<string, any>, settings_hash?: number }} result
 */
function takeRenamedBookLinks(oldName, newName, result) {
    const rename = (/** @type {string} */ value) => value === oldName ? newName : value;
    for (const charLore of world_info.charLore ?? []) {
        if (charLore.extraBooks?.includes(oldName)) charLore.extraBooks = normalizeArray(charLore.extraBooks.map(rename));
    }
    takeBookChoices(result);

    if (menu_type == 'create') {
        if (create_save.world === oldName) {
            create_save.world = newName;
            $('#character_world').val(newName);
            updateCharacterWorldButton();
        }
        if (Array.isArray(create_save.extra_books) && create_save.extra_books.includes(oldName)) {
            create_save.extra_books = normalizeArray(create_save.extra_books.map((e) => e === oldName ? newName : e));
        }
    }
}

/**
 * @param {{ settings?: Record<string, any>, settings_hash?: number }} result
 */
function takeBookChoices(result) {
    const settings = result.settings ?? {};
    const globalSelect = settings.world_info_settings?.world_info?.globalSelect;
    if (Array.isArray(globalSelect)) {
        selected_world_info.splice(0, selected_world_info.length, ...globalSelect);
    }
    const personas = settings['power_user.persona_data'];
    if (personas && typeof personas === 'object') {
        for (const [avatar, persona] of Object.entries(personas)) {
            const lorebook = String(persona?.lorebook ?? '');
            if (personaStore.has(avatar) && personaStore.get(avatar)?.lorebook !== lorebook) personaStore.update(avatar, { lorebook });
        }
        setPersonaDescription();
    }
    takeServerSettings(settings, result.settings_hash);
}

/**
 * Deletes a world info with the given name
 *
 * @param {string} worldInfoName - The name of the world info to delete
 * @returns {Promise<boolean>} A promise that resolves to true if the world info was successfully deleted, false otherwise
 */
export async function deleteWorldInfo(worldInfoName) {
    let held = null;
    let deleted = false;
    const bookId = await readBookId(worldInfoName);
    try {
        held = await holdWorldSavesUntilSettled(worldInfoName);
        deleted = Boolean(await deleteWorldInfoFile(worldInfoName));
    } finally {
        if (!deleted) {
            resumeWorldSaves(worldInfoName, held);
        }
    }
    if (deleted && bookId) forgetBookDrafts(bookId);
    return deleted;
}

/**
 * @param {string} worldInfoName
 * @returns {Promise<{ characters_updated: string[], chats_updated: object[], settings: Record<string, any>, settings_hash?: number } | null>}
 */
async function deleteWorldInfoFile(worldInfoName) {
    const response = await fetch('/api/worldinfo/delete', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ name: worldInfoName }),
    });

    if (!response.ok) {
        return null;
    }
    const result = await response.json();

    worldInfoCache.delete(worldInfoName);
    bookIds.delete(worldInfoName);
    for (const charLore of world_info.charLore ?? []) {
        if (charLore.extraBooks?.includes(worldInfoName)) charLore.extraBooks = charLore.extraBooks.filter((/** @type {string} */ e) => e !== worldInfoName);
    }
    takeBookChoices(result);
    await updateWorldInfoList();
    $('#world_editor_select').trigger('change');
    clearCreateDraftLink(worldInfoName);

    const updated = result.characters_updated ?? [];
    for (const avatar of updated) {
        await getOneCharacter(avatar);
    }
    const editorAvatar = String($('#avatar_url_pole').val() ?? '');
    if (menu_type != 'create' && updated.includes(editorAvatar)) {
        $('#character_world').val(charactersStore.get(editorAvatar)?.data?.extensions?.world ?? '');
        setWorldInfoButtonClass(editorAvatar);
    }
    if (updated.includes(getCurrentCharacter()?.avatar)) {
        select_selected_character(getCurrentCharacter().avatar, { switchMenu: false });
    }
    return result;
}

/**
 * @param {string} worldInfoName
 */
function clearCreateDraftLink(worldInfoName) {
    if (menu_type != 'create') return;
    if (create_save.world === worldInfoName) {
        create_save.world = '';
        $('#character_world').val('');
        updateCharacterWorldButton();
    }
    if (Array.isArray(create_save.extra_books) && create_save.extra_books.includes(worldInfoName)) {
        create_save.extra_books = create_save.extra_books.filter((e) => e !== worldInfoName);
    }
}

/**
 * @param {string} existingName
 * @param {string} actionName
 * @param {() => Promise<Response>} send
 * @returns {Promise<string|null>}
 */
async function overwriteWorldInfo(existingName, actionName, send) {
    await flushWorldSaves(existingName);
    let response;
    try {
        response = await send();
    } catch (error) {
        console.error(`Could not overwrite the lorebook ${existingName}`, error);
        response = null;
    }
    await dropWorldSavesAfterOverwrite(existingName, actionName);
    worldInfoCache.delete(existingName);
    bookVersions.delete(existingName);
    if (!response?.ok) {
        showWorldInfoSaveFailed(existingName, null, null, response ?? undefined);
        return null;
    }
    const result = await response.json();
    const name = String(result.name);
    if (name !== existingName) {
        await takeRenamedBook(existingName, name, result);
    } else {
        takeBookChoices(result);
    }
    await updateWorldInfoList();
    return name;
}

/**
 * @param {string} name
 * @returns {Promise<void>}
 */
async function flushWorldSaves(name) {
    const held = holdWorldSaves(name);
    if (held?.data !== undefined) {
        try {
            await _save(name, held.data);
        } catch {
            // _save has already shown and logged the failure.
        }
    }
    if (held?.entries) {
        const data = worldInfoCache.get(name);
        for (const uid of held.entries) {
            const entryData = data?.entries?.[uid];
            if (!entryData) continue;
            try {
                await _saveEntry(name, uid, entryData, data);
            } catch {
                // _saveEntry has already shown and logged the failure.
            }
        }
    }
    await worldWritesSettled(name);
}

/**
 * @param {string} name
 * @param {string} actionName
 * @returns {Promise<void>}
 */
async function dropWorldSavesAfterOverwrite(name, actionName) {
    if (holdWorldSaves(name)) {
        worldInfoCache.delete(name);
        const escapedName = escapeHtml(name);
        toastr.warning(t`Changes to lorebook ${escapedName} made while it was being overwritten were not saved.`, `World Info ${actionName}`, { escapeHtml: false });
    }
    await worldWritesSettled(name);
}

const STILL_LINKED_NAMED_LIMIT = 20;

/**
 * @param {string} oldName
 * @param {string} newName
 * @returns {Promise<void>}
 */
async function warnCharactersStillLinked(oldName, newName) {
    const title = t`World Info`;
    const escapedName = escapeHtml(oldName);
    const escapedNewName = escapeHtml(newName);

    let result;
    try {
        result = await characterRepository.query({ world: oldName }, { field: 'name', order: 'asc' }, 1, STILL_LINKED_NAMED_LIMIT, ['rows', 'total']);
    } catch (error) {
        console.error(`Could not look up the characters whose primary lorebook is the renamed ${oldName}`, error);
        toastr.warning(t`Renamed lorebook ${escapedName} to ${escapedNewName}, but could not check which characters still have ${escapedName} as their primary lorebook.`, title, { escapeHtml: false });
        return;
    }

    const rows = /** @type {import('../script.js').Character[]} */ (result.rows ?? []);
    const names = rows.map(row => escapeHtml(String(row.name ?? row.avatar)));
    const total = Math.max(Number(result.total) || 0, names.length);
    if (total === 0) {
        return;
    }

    const rest = total - names.length;
    const message = t`Renamed lorebook ${escapedName} to ${escapedNewName}, but ${total} character(s) still have ${escapedName} as their primary lorebook:`
        + `<br />${names.join(', ')}`
        + (rest > 0 ? `<br />${t`and ${rest} more.`}` : '');
    toastr.warning(message, title, { escapeHtml: false });
}

/**
 * Generates a free world name based on the given input name.
 * If the input name is null, a default name is used.
 * If the input name already exists, a numbered suffix is added.
 *
 * @param {string|null} worldName - The name to base the new world name on. If null, a default name is used.
 * @param {Object} [options={}] - Optional parameters.
 * @param {boolean} [options.stripIndex=true] - Whether to strip any numbered suffix from the input name before generating the new name.
 * @return {string|undefined} The generated free world name, or undefined if no free name could be found after trying 100,000 times.
 */
function getFreeWorldName(worldName = null, { stripIndex = true } = {}) {
    worldName ??= t`New World`;
    if (stripIndex) {
        worldName = worldName.replace(/\s*\(\d+\)$/, '');
    }
    const MAX_FREE_NAME = 100_000;
    for (let index = 1; index < MAX_FREE_NAME; index++) {
        const newName = `${worldName} (${index})`;
        if (world_names.includes(newName)) {
            continue;
        }
        return newName;
    }

    return undefined;
}

/**
 * Creates a new world info/lorebook with the given name.
 * Checks if a world with the same name already exists, providing a warning or optionally a user confirmation dialog.
 *
 * @param {string} worldName - The name of the new world info
 * @param {Object} options - Optional parameters
 * @param {boolean} [options.interactive=false] - Whether to show a confirmation dialog when overwriting an existing world
 * @returns {Promise<boolean>} - True if the world info was successfully created, false otherwise
 */
export async function createNewWorldInfo(worldName, { interactive = false } = {}) {
    const worldInfoTemplate = { entries: {} };

    if (!worldName) {
        return false;
    }

    if (refuseEmbeddedWorldName(worldName)) {
        return false;
    }

    const sanitizedWorldName = await getSanitizedFilename(worldName);

    /** @type {string|null} */
    let existing = null;
    const deleteAction = (/** @type {string} */ existingName) => {
        existing = existingName;
    };
    const allowed = await checkOverwriteExistingData('World Info', world_names, sanitizedWorldName, { interactive: interactive, actionName: 'Create', deleteAction });
    if (!allowed) {
        return false;
    }

    let shownName = worldName;
    if (existing !== null) {
        const replaces = existing;
        const name = await overwriteWorldInfo(replaces, 'Create', () => fetch('/api/worldinfo/create', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ name: worldName, replaces, data: worldInfoTemplate }),
        }));
        if (name === null) {
            await updateWorldInfoList();
            $('#world_editor_select').trigger('change');
            return false;
        }
        shownName = name;
    } else {
        if (!await saveWorldInfo(worldName, worldInfoTemplate, true)) {
            return false;
        }
        await updateWorldInfoList();
    }

    const selectedIndex = world_names.indexOf(shownName);
    if (selectedIndex !== -1) {
        $('#world_editor_select').val(selectedIndex).trigger('change');
    } else {
        await hideWorldEditor();
    }

    return true;
}

async function getCharacterLore() {
    const character = getCurrentCharacter();
    const name = character?.name;
    /** @type {Set<string>} */
    let worldsToSearch = new Set();

    const baseWorldName = character?.data?.extensions?.world;
    if (baseWorldName) {
        worldsToSearch.add(baseWorldName);
    }

    // TODO: Maybe make the utility function not use the window context?
    const fileName = getCharaFilename(character?.avatar);
    const extraCharLore = world_info.charLore?.find((e) => e.name === fileName);
    if (extraCharLore) {
        worldsToSearch = new Set([...worldsToSearch, ...extraCharLore.extraBooks]);
    }

    const worldLink = getCharacterWorldLink(character);

    let entries = [];
    for (const worldName of worldsToSearch) {
        if (selected_world_info.includes(worldName)) {
            if (isWorldInfoTracingEnabled()) console.debug(`[WI] Character ${name}'s world ${worldName} is already activated in global world info! Skipping...`);
            continue;
        }

        if (chat_metadata[METADATA_KEY] === worldName) {
            if (isWorldInfoTracingEnabled()) console.debug(`[WI] Character ${name}'s world ${worldName} is already activated in chat lore! Skipping...`);
            continue;
        }

        if (getPersonaDescriptionLorebook() === worldName) {
            if (isWorldInfoTracingEnabled()) console.debug(`[WI] Character ${name}'s world ${worldName} is already activated in persona lore! Skipping...`);
            continue;
        }

        if (worldName === baseWorldName && worldLink === character_world_link.EMBEDDED) {
            if (isWorldInfoTracingEnabled()) console.debug(`[WI] Character ${name}'s world ${worldName} has no World file, so it links the embedded lorebook. Not requesting it.`);
            continue;
        }

        const data = await loadWorldInfo(worldName);
        const newEntries = data ? Object.keys(data.entries).map((x) => data.entries[x]).map(({ uid, ...rest }) => ({ uid, world: worldName, ...rest })) : [];
        entries = entries.concat(newEntries);

        if (!newEntries.length) {
            if (isWorldInfoTracingEnabled()) console.debug(`[WI] Character ${name}'s world ${worldName} could not be found or is empty`);
        }
    }

    if (worldLink !== character_world_link.FILE && character?.data?.character_book?.entries?.length) {
        const converted = convertCharacterBook(character.data.character_book);
        const embeddedEntries = Object.keys(converted.entries)
            .map(x => converted.entries[x])
            .map(({ uid, ...rest }) => ({ uid, world: EMBEDDED_WORLD_NAME, ...rest }));
        entries = entries.concat(embeddedEntries);
        if (isWorldInfoTracingEnabled()) console.debug(`[WI] Character ${name}'s embedded lorebook has ${embeddedEntries.length} entries (activated directly)`);
    }

    if (isWorldInfoTracingEnabled()) console.debug(`[WI] Character ${name}'s lore has ${entries.length} world info entries`, [...worldsToSearch]);
    return entries;
}

async function getGlobalLore() {
    if (!selected_world_info?.length) {
        return [];
    }

    let entries = [];
    for (const worldName of selected_world_info) {
        const data = await loadWorldInfo(worldName);
        const newEntries = data ? Object.keys(data.entries).map((x) => data.entries[x]).map(({ uid, ...rest }) => ({ uid, world: worldName, ...rest })) : [];
        entries = entries.concat(newEntries);
    }

    if (isWorldInfoTracingEnabled()) console.debug(`[WI] Global world info has ${entries.length} entries`, selected_world_info);

    return entries;
}

async function getChatLore() {
    const chatWorld = chat_metadata[METADATA_KEY];

    if (!chatWorld) {
        return [];
    }

    if (selected_world_info.includes(chatWorld)) {
        if (isWorldInfoTracingEnabled()) console.debug(`[WI] Chat world ${chatWorld} is already activated in global world info! Skipping...`);
        return [];
    }

    const data = await loadWorldInfo(chatWorld);
    const entries = data ? Object.keys(data.entries).map((x) => data.entries[x]).map(({ uid, ...rest }) => ({ uid, world: chatWorld, ...rest })) : [];

    if (isWorldInfoTracingEnabled()) console.debug(`[WI] Chat lore has ${entries.length} entries`, [chatWorld]);

    return entries;
}

async function getPersonaLore() {
    const chatWorld = chat_metadata[METADATA_KEY];
    const personaWorld = getPersonaDescriptionLorebook();

    if (!personaWorld) {
        return [];
    }

    if (chatWorld === personaWorld) {
        if (isWorldInfoTracingEnabled()) console.debug(`[WI] Persona world ${personaWorld} is already activated in chat world! Skipping...`);
        return [];
    }

    if (selected_world_info.includes(personaWorld)) {
        if (isWorldInfoTracingEnabled()) console.debug(`[WI] Persona world ${personaWorld} is already activated in global world info! Skipping...`);
        return [];
    }

    const data = await loadWorldInfo(personaWorld);
    const entries = data ? Object.keys(data.entries).map((x) => data.entries[x]).map(({ uid, ...rest }) => ({ uid, world: personaWorld, ...rest })) : [];

    if (isWorldInfoTracingEnabled()) console.debug(`[WI] Persona lore has ${entries.length} entries`, [personaWorld]);

    return entries;
}

export async function getSortedEntries() {
    try {
        const [
            globalLore,
            characterLore,
            chatLore,
            personaLore,
        ] = await Promise.all([
            getGlobalLore(),
            getCharacterLore(),
            getChatLore(),
            getPersonaLore(),
        ]);

        let entries;

        switch (Number(world_info_character_strategy)) {
            case world_info_insertion_strategy.evenly:
                entries = [...globalLore, ...characterLore].sort(sortFn);
                break;
            case world_info_insertion_strategy.character_first:
                entries = [...characterLore.sort(sortFn), ...globalLore.sort(sortFn)];
                break;
            case world_info_insertion_strategy.global_first:
                entries = [...globalLore.sort(sortFn), ...characterLore.sort(sortFn)];
                break;
            default:
                console.error('[WI] Unknown WI insertion strategy:', world_info_character_strategy, 'defaulting to evenly');
                entries = [...globalLore, ...characterLore].sort(sortFn);
                break;
        }

        // Chat lore always goes first, then persona lore, then the rest
        entries = [...chatLore.sort(sortFn), ...personaLore.sort(sortFn), ...entries];

        // Calculate hash and parse decorators. Split maps to preserve old hashes.
        entries = entries.map((entry) => {
            const [decorators, content] = parseDecorators(entry.content || '');
            return { ...entry, decorators, content };
        }).map((entry) => {
            const hash = getStringHash(JSON.stringify(entry));
            return { ...entry, hash };
        });

        if (isWorldInfoTracingEnabled()) console.debug(`[WI] Found ${entries.length} world lore entries. Sorted by strategy`, Object.entries(world_info_insertion_strategy).find((x) => x[1] === world_info_character_strategy));

        // Need to deep clone the entries to avoid modifying the cached data
        return structuredClone(entries);
    } catch (e) {
        console.error(e);
        return [];
    }
}


/**
 * Parse decorators from worldinfo content
 * @param {string} content The content to parse
 * @returns {[string[],string]} The decorators found in the content and the content without decorators
*/
function parseDecorators(content) {
    /**
     * Check if the decorator is known
     * @param {string} data string to check
     * @returns {boolean} true if the decorator is known
    */
    const isKnownDecorator = (data) => {
        if (data.startsWith('@@@')) {
            data = data.substring(1);
        }

        for (let i = 0; i < KNOWN_DECORATORS.length; i++) {
            if (data.startsWith(KNOWN_DECORATORS[i])) {
                return true;
            }
        }
        return false;
    };

    if (content.startsWith('@@')) {
        let newContent = content;
        const splited = content.split('\n');
        let decorators = [];
        let fallbacked = false;

        for (let i = 0; i < splited.length; i++) {
            if (splited[i].startsWith('@@')) {
                if (splited[i].startsWith('@@@') && !fallbacked) {
                    continue;
                }

                if (isKnownDecorator(splited[i])) {
                    decorators.push(splited[i].startsWith('@@@') ? splited[i].substring(1) : splited[i]);
                    fallbacked = false;
                } else {
                    fallbacked = true;
                }
            } else {
                newContent = splited.slice(i).join('\n');
                break;
            }
        }
        return [decorators, newContent];
    }

    return [[], content];
}

/**
 * Performs a scan on the chat and returns the world info activated.
 * @param {string[]} chat The chat messages to scan, in reverse order.
 * @param {number} maxContext The maximum context size of the generation.
 * @param {boolean} isDryRun Whether to perform a dry run.
 * @param {WIGlobalScanData} globalScanData Chat independent context to be scanned
 * @returns {Promise<WIActivated>} The world info activated.
 */
//MARK: checkWorldInfo

function convertAgnaiMemoryBook(inputObj) {
    const outputObj = { entries: {} };

    inputObj.entries.forEach((entry, index) => {
        outputObj.entries[index] = {
            ...newWorldInfoEntryTemplate,
            uid: index,
            key: entry.keywords,
            keysecondary: [],
            comment: entry.name,
            content: entry.entry,
            constant: false,
            selective: false,
            vectorized: false,
            selectiveLogic: world_info_logic.AND_ANY,
            order: entry.weight,
            position: 0,
            disable: !entry.enabled,
            addMemo: !!entry.name,
            excludeRecursion: false,
            delayUntilRecursion: false,
            displayIndex: index,
            probability: 100,
            useProbability: true,
            outletName: '',
            group: '',
            groupOverride: false,
            groupWeight: DEFAULT_WEIGHT,
            scanDepth: null,
            caseSensitive: null,
            matchWholeWords: null,
            useGroupScoring: null,
            automationId: '',
            role: extension_prompt_roles.SYSTEM,
            sticky: null,
            cooldown: null,
            delay: null,
            triggers: [],
            ignoreBudget: false,
        };
    });

    return outputObj;
}

function convertRisuLorebook(inputObj) {
    const outputObj = { entries: {} };

    inputObj.data.forEach((entry, index) => {
        outputObj.entries[index] = {
            ...newWorldInfoEntryTemplate,
            uid: index,
            key: entry.key.split(',').map(x => x.trim()),
            keysecondary: entry.secondkey ? entry.secondkey.split(',').map(x => x.trim()) : [],
            comment: entry.comment,
            content: entry.content,
            constant: entry.alwaysActive,
            selective: entry.selective,
            vectorized: false,
            selectiveLogic: world_info_logic.AND_ANY,
            order: entry.insertorder,
            position: world_info_position.before,
            disable: false,
            addMemo: true,
            excludeRecursion: false,
            delayUntilRecursion: false,
            displayIndex: index,
            probability: entry.activationPercent ?? 100,
            useProbability: entry.activationPercent ?? true,
            outletName: '',
            group: '',
            groupOverride: false,
            groupWeight: DEFAULT_WEIGHT,
            scanDepth: null,
            caseSensitive: null,
            matchWholeWords: null,
            useGroupScoring: null,
            automationId: '',
            role: extension_prompt_roles.SYSTEM,
            sticky: null,
            cooldown: null,
            delay: null,
            triggers: [],
            ignoreBudget: false,
        };
    });

    return outputObj;
}

function convertNovelLorebook(inputObj) {
    const outputObj = {
        entries: {},
    };

    inputObj.entries.forEach((entry, index) => {
        const displayName = entry.displayName;
        const addMemo = displayName !== undefined && displayName.trim() !== '';

        outputObj.entries[index] = {
            ...newWorldInfoEntryTemplate,
            uid: index,
            key: entry.keys,
            keysecondary: [],
            comment: displayName || '',
            content: entry.text,
            constant: false,
            selective: false,
            vectorized: false,
            selectiveLogic: world_info_logic.AND_ANY,
            order: entry.contextConfig?.budgetPriority ?? 0,
            position: 0,
            disable: !entry.enabled,
            addMemo: addMemo,
            excludeRecursion: false,
            delayUntilRecursion: false,
            displayIndex: index,
            probability: 100,
            useProbability: true,
            outletName: '',
            group: '',
            groupOverride: false,
            groupWeight: DEFAULT_WEIGHT,
            scanDepth: null,
            caseSensitive: null,
            matchWholeWords: null,
            useGroupScoring: null,
            automationId: '',
            role: extension_prompt_roles.SYSTEM,
            sticky: null,
            cooldown: null,
            delay: null,
            triggers: [],
            ignoreBudget: false,
        };
    });

    return outputObj;
}

function convertCharacterBook(characterBook) {
    const result = { entries: {}, originalData: characterBook };

    characterBook.entries.forEach((entry, index) => {
        // Not in the spec, but this is needed to find the entry in the original data
        if (entry.id === undefined) {
            entry.id = index;
        }

        result.entries[entry.id] = {
            ...newWorldInfoEntryTemplate,
            uid: entry.id,
            key: entry.keys,
            keysecondary: entry.secondary_keys || [],
            comment: entry.comment || '',
            content: entry.content,
            constant: entry.constant || false,
            selective: entry.selective || false,
            order: entry.insertion_order,
            position: entry.extensions?.position ?? (entry.position === 'before_char' ? world_info_position.before : world_info_position.after),
            excludeRecursion: entry.extensions?.exclude_recursion ?? false,
            preventRecursion: entry.extensions?.prevent_recursion ?? false,
            delayUntilRecursion: entry.extensions?.delay_until_recursion ?? false,
            disable: !entry.enabled,
            addMemo: !!entry.comment,
            displayIndex: entry.extensions?.display_index ?? index,
            probability: entry.extensions?.probability ?? 100,
            useProbability: entry.extensions?.useProbability ?? true,
            depth: entry.extensions?.depth ?? DEFAULT_DEPTH,
            selectiveLogic: entry.extensions?.selectiveLogic ?? world_info_logic.AND_ANY,
            outletName: entry.extensions?.outlet_name ?? '',
            group: entry.extensions?.group ?? '',
            groupOverride: entry.extensions?.group_override ?? false,
            groupWeight: entry.extensions?.group_weight ?? DEFAULT_WEIGHT,
            scanDepth: entry.extensions?.scan_depth ?? null,
            caseSensitive: entry.extensions?.case_sensitive ?? null,
            matchWholeWords: entry.extensions?.match_whole_words ?? null,
            useGroupScoring: entry.extensions?.use_group_scoring ?? null,
            automationId: entry.extensions?.automation_id ?? '',
            role: entry.extensions?.role ?? extension_prompt_roles.SYSTEM,
            vectorized: entry.extensions?.vectorized ?? false,
            sticky: entry.extensions?.sticky ?? null,
            cooldown: entry.extensions?.cooldown ?? null,
            delay: entry.extensions?.delay ?? null,
            matchPersonaDescription: entry.extensions?.match_persona_description ?? false,
            matchCharacterDescription: entry.extensions?.match_character_description ?? false,
            matchCharacterPersonality: entry.extensions?.match_character_personality ?? false,
            matchCharacterDepthPrompt: entry.extensions?.match_character_depth_prompt ?? false,
            matchScenario: entry.extensions?.match_scenario ?? false,
            matchCreatorNotes: entry.extensions?.match_creator_notes ?? false,
            extensions: entry.extensions ?? {},
            triggers: entry.extensions?.triggers || [],
            ignoreBudget: entry.extensions?.ignore_budget ?? false,
        };
    });

    return result;
}

/**
 * @param {{entries: Record<string, any>, originalData?: object}} data
 * @returns {object}
 */
function convertToCharacterBook(data) {
    const book = structuredClone(data.originalData) || {};

    book.entries = Object.keys(data.entries).map((uid) => {
        const entry = data.entries[uid];
        const extensions = { ...(entry.extensions ?? {}) };

        extensions.position = entry.position;
        extensions.exclude_recursion = entry.excludeRecursion;
        extensions.prevent_recursion = entry.preventRecursion;
        extensions.delay_until_recursion = entry.delayUntilRecursion;
        extensions.display_index = entry.displayIndex;
        extensions.probability = entry.probability;
        extensions.useProbability = entry.useProbability;
        extensions.depth = entry.depth;
        extensions.selectiveLogic = entry.selectiveLogic;
        extensions.outlet_name = entry.outletName;
        extensions.group = entry.group;
        extensions.group_override = entry.groupOverride;
        extensions.group_weight = entry.groupWeight;
        extensions.scan_depth = entry.scanDepth;
        extensions.case_sensitive = entry.caseSensitive;
        extensions.match_whole_words = entry.matchWholeWords;
        extensions.use_group_scoring = entry.useGroupScoring;
        extensions.automation_id = entry.automationId;
        extensions.role = entry.role;
        extensions.vectorized = entry.vectorized;
        extensions.sticky = entry.sticky;
        extensions.cooldown = entry.cooldown;
        extensions.delay = entry.delay;
        extensions.match_persona_description = entry.matchPersonaDescription;
        extensions.match_character_description = entry.matchCharacterDescription;
        extensions.match_character_personality = entry.matchCharacterPersonality;
        extensions.match_character_depth_prompt = entry.matchCharacterDepthPrompt;
        extensions.match_scenario = entry.matchScenario;
        extensions.match_creator_notes = entry.matchCreatorNotes;
        extensions.triggers = entry.triggers ?? [];
        extensions.ignore_budget = entry.ignoreBudget;

        return {
            id: entry.uid,
            keys: entry.key ?? [],
            secondary_keys: entry.keysecondary ?? [],
            comment: entry.comment ?? '',
            content: entry.content ?? '',
            constant: !!entry.constant,
            selective: !!entry.selective,
            insertion_order: entry.order ?? 0,
            enabled: !entry.disable,
            position: entry.position === world_info_position.before ? 'before_char' : 'after_char',
            extensions,
        };
    });

    return book;
}

export const EMBEDDED_WORLD_NAME = '__embedded__';

/** @type {WeakMap<object, {avatar: string, baseline: {hash: number|undefined}, saveDebounced: () => void, savePending: boolean}>} */
const embeddedLoreOwners = new WeakMap();

/**
 * @param {{entries: Record<string, any>, originalData?: object}} data
 */
function saveEmbeddedLoreDebounced(data) {
    const owner = embeddedLoreOwners.get(data);
    if (!owner) {
        return saveEmbeddedLore(data);
    }
    owner.savePending = true;
    owner.saveDebounced();
}

/**
 * @param {{entries: Record<string, any>, originalData?: object}} data
 * @returns {Promise<boolean>}
 */
async function saveEmbeddedLore(data) {
    const owner = embeddedLoreOwners.get(data);
    if (!owner) {
        console.error('[WI] Embedded lorebook edits with no character bound to them were not saved.', data);
        toastr.error(t`These embedded lorebook edits don't belong to any character, so they were not saved.`, t`Embedded lorebook not saved`);
        return false;
    }

    const { avatar, baseline } = owner;
    try {
        const characterBookJson = JSON.stringify(convertToCharacterBook(data));
        if ($('#avatar_url_pole').val() === avatar) {
            $('#character_book_json').val(characterBookJson);
        }
        return await saveCharacterField(avatar, '#character_book_json', characterBookJson, baseline);
    } catch (error) {
        console.error(`[WI] Failed to save embedded lorebook changes for ${avatar}.`, error);
        const characterName = charactersStore.get(avatar)?.name ?? avatar;
        toastr.error(t`Your edits to the embedded lorebook of ${characterName} are still shown in the editor, but they were not saved.`, t`Embedded lorebook not saved`);
        return false;
    }
}

/**
 * @param {{entries: Record<string, any>, originalData?: object}} data
 */
async function removeEmbeddedLore(data) {
    const owner = embeddedLoreOwners.get(data);
    if (!owner) {
        console.error('[WI] Embedded lorebook with no character bound to it was not removed.', data);
        toastr.error(t`This embedded lorebook doesn't belong to any character, so nothing was removed.`, t`Embedded lorebook not removed`);
        return;
    }

    const { avatar, baseline } = owner;
    const characterName = charactersStore.get(avatar)?.name ?? avatar;
    const confirmation = await Popup.show.confirm(t`Remove the embedded lorebook from ${escapeHtml(characterName)}?`, t`This action is irreversible!`);
    if (!confirmation) {
        return;
    }

    const hadPendingSave = owner.savePending;
    cancelDebounce(owner.saveDebounced);
    owner.savePending = false;

    let removed = false;
    try {
        removed = await saveCharacterField(avatar, '#character_book_json', '', baseline);
    } catch (error) {
        console.error(`[WI] Failed to remove the embedded lorebook of ${avatar}.`, error);
    }

    if (!removed) {
        toastr.error(t`The embedded lorebook of ${characterName} was not removed.`, t`Embedded lorebook not removed`);
        if (hadPendingSave) {
            saveEmbeddedLoreDebounced(data);
        }
        return;
    }

    if ($('#avatar_url_pole').val() === avatar) {
        $('#character_book_json').val('');
        setWorldInfoButtonClass(avatar);
    }
    removedEmbeddedLorebooks.add(data);
    clearDraftsUnder(localStorage, ENTRY_DRAFT_KIND, `card:${avatar}:`);
    embeddedLoreOwners.delete(data);
    await hideWorldEditor();
}

/**
 * @param {string} [avatarArg]
 */
export async function openEmbeddedLoreEditor(avatarArg) {
    const avatar = avatarArg ?? $('#edit_embedded_lore').data('avatar');

    if (avatar === undefined || avatar === null) {
        return;
    }

    const character = charactersStore.get(avatar);

    if (!character?.data?.character_book) {
        toastr.info(t`This character doesn't have an embedded lorebook.`);
        return;
    }

    const data = convertCharacterBook(character.data.character_book);
    const owner = {
        avatar,
        baseline: characterFieldBaseline(character, '#character_book_json'),
        saveDebounced: debounce(() => {
            owner.savePending = false;
            return saveEmbeddedLore(data);
        }, debounce_timeout.relaxed),
        savePending: false,
    };
    embeddedLoreOwners.set(data, owner);

    if (!$('#WorldInfo').is(':visible')) {
        $('#WIDrawerIcon').trigger('click');
    }

    await displayWorldEntries(EMBEDDED_WORLD_NAME, data);
}

let worldButtonTitle = null;

/**
 * @param {string|null} missingName
 */
function setWorldButtonMissing(missingName) {
    const button = $('#world_button');
    button.toggleClass('warning', missingName !== null);
    if (missingName !== null) {
        worldButtonTitle ??= button.attr('title') ?? null;
        button.attr('title', t`Linked lorebook "${missingName}" not found`);
    } else if (worldButtonTitle !== null && button.attr('title') !== worldButtonTitle) {
        button.attr('title', worldButtonTitle);
    }
}

/**
 * @param {{shallow?: boolean, data?: {extensions?: {world?: string}, character_book?: object}}|null|undefined} character
 */
function showCharacterWorldLink(character) {
    const worldLink = getCharacterWorldLink(character);
    const worldSet = worldLink === character_world_link.FILE || worldLink === character_world_link.EMBEDDED;
    $('#set_character_world, #world_button').toggleClass('world_set', worldSet);
    const missing = worldLink === character_world_link.MISSING && character?.shallow !== true;
    setWorldButtonMissing(missing ? character.data.extensions.world : null);
}

/**
 * @param {string|undefined} avatar
 * @param {boolean} [forceValue]
 */
export function setWorldInfoButtonClass(avatar, forceValue = undefined) {
    if (forceValue !== undefined) {
        $('#set_character_world, #world_button').toggleClass('world_set', forceValue);
        setWorldButtonMissing(null);
        return;
    }

    if (avatar === undefined) {
        return;
    }

    showCharacterWorldLink(charactersStore.get(avatar));
}

export function updateCharacterWorldButton() {
    if (menu_type == 'create') {
        showCharacterWorldLink({ data: { extensions: { world: create_save.world } } });
        return;
    }

    const avatar = $('#set_character_world').data('avatar');
    if (avatar === undefined || avatar === null) {
        return;
    }

    setWorldInfoButtonClass(avatar);
}

/**
 * @param {{data?: {extensions?: {world?: string}, character_book?: object}}|null|undefined} character
 * @returns {string}
 */
export function getCharacterWorldLink(character) {
    return resolveCharacterWorldLink(character, (name) => world_names.includes(name));
}

/**
 * @param {string} [avatar]
 * @returns {boolean}
 */
export function checkEmbeddedWorld(avatar) {
    $('#edit_embedded_lore').hide();

    if (avatar === undefined) {
        return false;
    }

    const character = charactersStore.get(avatar);

    if (character?.data?.character_book) {
        $('#edit_embedded_lore').data('avatar', character?.avatar ?? null).show();
        return true;
    }

    return false;
}

function onWorldInfoChange(args, text) {
    const previousSelectedWorldInfo = JSON.stringify(selected_world_info);
    if (args !== '__notSlashCommand__') { // if it's a slash command
        const silent = isTrueBoolean(args.silent);
        if (text.trim() !== '') { // and args are provided
            const slashInputSplitText = text.trim().toLowerCase().split(',');

            slashInputSplitText.forEach((worldName) => {
                const wiElement = getWIElement(worldName);
                if (wiElement.length > 0) {
                    const name = wiElement.text();
                    switch (args.state) {
                        case 'off': {
                            if (selected_world_info.includes(name)) {
                                selected_world_info.splice(selected_world_info.indexOf(name), 1);
                                wiElement.prop('selected', false);
                                if (!silent) toastr.success(t`Deactivated world: ${name}`);
                            } else {
                                if (!silent) toastr.error(t`World was not active: ${name}`);
                            }
                            break;
                        }
                        case 'toggle': {
                            if (selected_world_info.includes(name)) {
                                selected_world_info.splice(selected_world_info.indexOf(name), 1);
                                wiElement.prop('selected', false);
                                if (!silent) toastr.success(t`Deactivated world: ${name}`);
                            } else {
                                selected_world_info.push(name);
                                wiElement.prop('selected', true);
                                if (!silent) toastr.success(t`Activated world: ${name}`);
                            }
                            break;
                        }
                        case 'on':
                        default: {
                            selected_world_info.push(name);
                            wiElement.prop('selected', true);
                            if (!silent) toastr.success(t`Activated world: ${name}`);
                        }
                    }
                } else {
                    if (!silent) toastr.error(t`No world found named: ${worldName}`);
                }
            });
            $('#world_info').trigger('change');
        } else { // if no args, unset all worlds
            if (!silent) toastr.success(t`Deactivated all worlds`);
            selected_world_info = [];
            $('#world_info').val(null).trigger('change');
        }
    } else { //if it's a pointer selection
        const tempWorldInfo = [];
        const val = $('#world_info').val();
        const selectedWorlds = (Array.isArray(val) ? val : [val]).map((e) => Number(e)).filter((e) => !isNaN(e));
        if (selectedWorlds.length > 0) {
            selectedWorlds.forEach((worldIndex) => {
                const existingWorldName = world_names[worldIndex];
                if (existingWorldName) {
                    tempWorldInfo.push(existingWorldName);
                } else {
                    const wiElement = getWIElement(existingWorldName);
                    wiElement.prop('selected', false);
                    toastr.error(t`The world with ${existingWorldName} is invalid or corrupted.`);
                }
            });
        }
        selected_world_info = tempWorldInfo;
    }

    if (JSON.stringify(selected_world_info) !== previousSelectedWorldInfo) {
        saveSettingsDebounced('world_info_settings');
    }
    eventSource.emit(event_types.WORLDINFO_SETTINGS_UPDATED);
    return '';
}

/**
 * Imports world info from a file.
 * @param {File} file File to import
 */
/**
 * @param {File} file
 * @param {Object} [options={}]
 * @param {boolean} [options.interactive=true]
 * @returns {Promise<string|false|void>}
 */
export async function importWorldInfo(file, { interactive = true } = {}) {
    if (!file) {
        return;
    }

    const formData = new FormData();
    formData.append('avatar', file);

    try {
        let jsonData;

        if (file.name.endsWith('.png')) {
            const buffer = new Uint8Array(await getFileBuffer(file));
            jsonData = extractDataFromPng(buffer, 'naidata');
        } else {
            // File should be a JSON file
            jsonData = await parseJsonFile(file);
        }

        if (jsonData === undefined || jsonData === null) {
            toastr.error(t`File is not valid: ${file.name}`);
            return;
        }

        // Convert Novel Lorebook
        if (jsonData.lorebookVersion !== undefined) {
            console.log('Converting Novel Lorebook');
            formData.append('convertedData', JSON.stringify(convertNovelLorebook(jsonData)));
        }

        // Convert Agnai Memory Book
        if (jsonData.kind === 'memory') {
            console.log('Converting Agnai Memory Book');
            formData.append('convertedData', JSON.stringify(convertAgnaiMemoryBook(jsonData)));
        }

        // Convert Risu Lorebook
        if (jsonData.type === 'risu') {
            console.log('Converting Risu Lorebook');
            formData.append('convertedData', JSON.stringify(convertRisuLorebook(jsonData)));
        }
    } catch (error) {
        toastr.error(`Error parsing file: ${error}`);
        return;
    }

    const worldName = file.name.substr(0, file.name.lastIndexOf('.'));
    const sanitizedWorldName = await getSanitizedFilename(worldName);
    /** @type {string|null} */
    let existing = null;
    const deleteAction = (/** @type {string} */ existingName) => {
        existing = existingName;
    };
    const allowed = await checkOverwriteExistingData('World Info', world_names, sanitizedWorldName, { interactive, actionName: 'Import', deleteAction });
    if (!allowed) {
        return false;
    }
    const send = () => fetch('/api/worldinfo/import', {
        method: 'POST',
        headers: getRequestHeaders({ omitContentType: true }),
        body: formData,
        cache: 'no-cache',
    });

    if (existing !== null) {
        formData.append('replaces', existing);
        const name = await overwriteWorldInfo(existing, 'Import', send);
        if (name === null) {
            await updateWorldInfoList();
            $('#world_editor_select').trigger('change');
            return;
        }
        if (interactive) {
            const newIndex = world_names.indexOf(name);
            if (newIndex >= 0) {
                $('#world_editor_select').val(newIndex).trigger('change');
            }
        } else if (String($('#world_editor_select').find(':selected').text()) === name) {
            $('#world_editor_select').trigger('change');
        }
        toastr.success(t`World Info "${name}" imported successfully!`);
        return name;
    }

    try {
        const result = await send();

        if (!result.ok) {
            throw new Error(`Failed to import world info: ${result.statusText}`);
        }

        const data = await result.json();

        if (data.name) {
            await updateWorldInfoList();

            if (interactive) {
                const newIndex = world_names.indexOf(data.name);
                if (newIndex >= 0) {
                    $('#world_editor_select').val(newIndex).trigger('change');
                }
            }

            toastr.success(t`World Info "${data.name}" imported successfully!`);
            return data.name;
        }
    } catch (error) {
        console.error('Error importing world info:', error);
        toastr.error(t`Failed to import World Info`);
    }
}

/**
 * Forces the world info editor to open on a specific world.
 * @param {string} worldName The name of the world to open
 */
export function openWorldInfoEditor(worldName) {
    console.log(`Opening lorebook for ${worldName}`);
    if (!$('#WorldInfo').is(':visible')) {
        $('#WIDrawerIcon').trigger('click');
    }
    const index = world_names.indexOf(worldName);
    $('#world_editor_select').val(index).trigger('change');
}

/**
 * @param {string} worldName
 * @param {number} uid
 * @returns {Promise<void>}
 */
export async function openWorldInfoEntry(worldName, uid) {
    if (!$('#WorldInfo').is(':visible')) {
        $('#WIDrawerIcon').trigger('click');
    }
    $('#world_editor_select').val(world_names.indexOf(worldName));
    await selectEditorBook(uid);
}

/**
 * @param {number} [navigation]
 * @returns {Promise<void>}
 */
async function selectEditorBook(navigation = navigation_option.none) {
    $('#world_info_search').val('');
    worldInfoFilter.setFilterData(FILTER_TYPES.WORLD_INFO_SEARCH, '', true);
    const selectedIndex = String($('#world_editor_select').find(':selected').val());

    if (selectedIndex === '') {
        const changed = power_user.wi_last_editor_book !== '';
        power_user.wi_last_editor_book = '';
        if (changed) {
            saveSettingsDebounced('power_user.wi_last_editor_book');
        }
        await hideWorldEditor();
        return;
    }
    const worldName = world_names[selectedIndex];
    const changed = power_user.wi_last_editor_book !== worldName;
    power_user.wi_last_editor_book = worldName;
    if (changed) {
        saveSettingsDebounced('power_user.wi_last_editor_book');
    }
    await showWorldEditor(worldName, navigation);
}

/**
 * Assigns a lorebook to the current chat.
 * @param {Pick<JQuery.ClickEvent, 'shiftKey' | 'altKey'>} event Click event
 * @returns {Promise<void>}
 */
async function assignLorebookToChat({ shiftKey, altKey }) {
    const selectedName = chat_metadata[METADATA_KEY];

    if (selectedName && !shiftKey && !altKey) {
        openWorldInfoEditor(selectedName);
        return;
    }

    const template = $(await renderTemplateAsync('chatLorebook'));

    const worldSelect = template.find('select');
    const chatName = template.find('.chat_name');
    chatName.text(getCurrentChatId());

    for (const worldName of world_names) {
        const option = document.createElement('option');
        option.value = worldName;
        option.innerText = worldName;
        option.selected = selectedName === worldName;
        worldSelect.append(option);
    }

    worldSelect.on('change', function () {
        const worldName = $(this).val();

        if (worldName) {
            chat_metadata[METADATA_KEY] = worldName;
            $('.chat_lorebook_button').addClass('world_set');
        } else {
            delete chat_metadata[METADATA_KEY];
            $('.chat_lorebook_button').removeClass('world_set');
        }

        saveMetadata();
    });

    await callGenericPopup(template, POPUP_TYPE.TEXT);
}

/**
 * Moves a World Info entry from a source lorebook to a target lorebook.
 *
 * @param {string} sourceName - The name of the source lorebook file.
 * @param {string} targetName - The name of the target lorebook file.
 * @param {string|number} uid - The UID of the entry to move from the source lorebook.
 * @param {Object} options - Additional options for the move operation.
 * @param {boolean} [options.deleteOriginal=true] - Whether to delete the original entry from the source lorebook after moving it.
 * @returns {Promise<boolean>} True if the move was successful, false otherwise.
 */
async function moveWorldInfoEntry(sourceName, targetName, uid, { deleteOriginal = true } = {}) {
    if (sourceName === targetName) {
        return false;
    }

    try {
        const response = await fetch('/api/worldinfo/entry/transplant', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                source_name: sourceName,
                target_name: targetName,
                uid: uid,
                delete_original: deleteOriginal,
            }),
        });

        if (!response.ok) {
            const error = await response.json().catch(() => null);
            toastr.error(error?.error ?? t`Failed to move the entry.`);
            console.error(`[WI Move] Transplant request failed for '${sourceName}' -> '${targetName}':`, error);
            return false;
        }

        const result = await response.json();

        const sourceId = bookIds.get(sourceName);
        if (deleteOriginal && sourceId) clearThingDrafts(localStorage, ENTRY_DRAFT_KIND, `book:${sourceId}:${uid}`);

        worldInfoCache.delete(sourceName);
        worldInfoCache.delete(targetName);

        console.log(`[WI Move] ${result.entry?.comment} ${deleteOriginal ? 'moved' : 'copied'} successfully to '${targetName}'.`);

        // Check if the currently viewed book in the editor is the source or target and reload it
        const currentEditorBookIndex = Number($('#world_editor_select').val());
        if (!isNaN(currentEditorBookIndex)) {
            const currentEditorBookName = world_names[currentEditorBookIndex];
            if (currentEditorBookName === sourceName || currentEditorBookName === targetName) {
                reloadEditor(currentEditorBookName);
            }
        }

        toastr.success(deleteOriginal
            ? t`Entry moved successfully from '${sourceName}' to '${targetName}'.`
            : t`Entry copied successfully to '${targetName}'.`);

        return true;
    } catch (error) {
        toastr.error(t`An unexpected error occurred while moving the entry: ${error.message}`);
        console.error('[WI Move] Unexpected error:', error);
        return false;
    }
}


/**
 * Updates the primary world info linked to a character.
 * Can also unset it to null.
 * @param {string} name - The name of the world info to link to the character.
 */
export async function charUpdatePrimaryWorld(name) {
    $('#character_world').val(name);

    console.debug('Character world selected:', name);

    if (menu_type == 'create') {
        create_save.world = name;
        updateCharacterWorldButton();
        return;
    }


    await saveCharacterField(String($('#avatar_url_pole').val()), '#character_world', name);

    updateCharacterWorldButton();
}

/**
 * Adds one or more auxiliary world books to a character.
 * @param {string} characterKey - The key of the character to add auxiliary world books to
 * @param {string|string[]} nameOrNames - The name or names of the auxiliary world books to add
 */
async function charUpdateAddAuxWorld(characterKey, nameOrNames) {
    const fileName = getCharaFilename(characterKey);
    await updateAuxBooks(fileName, 'add', Array.isArray(nameOrNames) ? nameOrNames : [nameOrNames]);
}

/**
 * Replaces the entire list of auxiliary world books for a character.
 * @param {string} fileName - The filename of the character to update
 * @param {string[]} books - The new list of auxiliary world books to replace the existing list with
 */
export async function charSetAuxWorlds(fileName, books) {
    await updateAuxBooks(fileName, 'set', Array.isArray(books) ? books : []);
}

/**
 * @param {Array} charLore
 * @param {string} fileName
 * @param {'add'|'set'|'remove'} op
 * @param {string[]} books
 * @returns {Array}
 */
function applyAuxBooksOp(charLore, fileName, op, books) {
    const idx = charLore.findIndex(e => e.name === fileName);
    const existing = idx !== -1 && Array.isArray(charLore[idx].extraBooks) ? charLore[idx].extraBooks : [];
    const next = op === 'add' ? [...new Set([...existing, ...books])]
        : op === 'remove' ? existing.filter(b => !books.includes(b))
            : [...new Set(books)];

    const result = [...charLore];
    if (next.length === 0) {
        if (idx !== -1) result.splice(idx, 1);
    } else if (idx === -1) {
        result.push({ name: fileName, extraBooks: next });
    } else {
        result[idx] = { ...result[idx], extraBooks: next };
    }
    return result;
}

/**
 * @param {string} fileName
 * @param {'add'|'set'} op
 * @param {string[]} books
 */
async function updateAuxBooks(fileName, op, books) {
    if (menu_type === 'create') {
        const current = create_save.extra_books ?? [];
        const next = op === 'add' ? [...current, ...books] : books;
        create_save.extra_books = normalizeArray(next);
        return;
    }

    if (!fileName) return;

    await sendAuxBooksOp(fileName, op, books);
}

/**
 * @param {string} fileName
 * @param {'add'|'set'|'remove'} op
 * @param {string[]} books
 * @returns {Promise<boolean>}
 */
export async function sendAuxBooksOp(fileName, op, books) {
    const previousCharLore = world_info.charLore ?? [];
    Object.assign(world_info, { charLore: applyAuxBooksOp(previousCharLore, fileName, op, books) });

    try {
        const response = await fetch('/api/worldinfo/additional-books', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ characterAvatar: fileName, op, books }),
        });
        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            Object.assign(world_info, { charLore: previousCharLore });
            toastr.error(data?.error || t`Failed to update additional lorebooks`);
            return false;
        }
        const { extraBooks } = await response.json();
        takeAuxBooks(fileName, extraBooks);
        return true;
    } catch (error) {
        Object.assign(world_info, { charLore: previousCharLore });
        console.error('Failed to update additional lorebooks', error);
        toastr.error(t`Failed to update additional lorebooks`);
        return false;
    }
}

/**
 * Holds a character's additional books as the server answered them.
 * @param {string} fileName The character's file name, without its extension.
 * @param {string[]} extraBooks
 */
export function takeAuxBooks(fileName, extraBooks) {
    const charLore = world_info.charLore ?? [];
    const idx = charLore.findIndex(e => e.name === fileName);
    if (extraBooks.length === 0) {
        if (idx !== -1) charLore.splice(idx, 1);
    } else if (idx === -1) {
        charLore.push({ name: fileName, extraBooks });
    } else {
        charLore[idx] = { ...charLore[idx], extraBooks };
    }
    Object.assign(world_info, { charLore });
}

export function initWorldInfo() {
    charactersStore.onChange((change) => {
        if (change.op === 'reset' || (change.op === 'updated' && change.id === $('#set_character_world').data('avatar'))) {
            updateCharacterWorldButton();
        }
    });

    $('#world_info').on('mousedown change', async function (e) {
        // If there's no world names, don't do anything
        if (world_names.length === 0) {
            e.preventDefault();
            return;
        }

        onWorldInfoChange('__notSlashCommand__');
    });

    //**************************WORLD INFO IMPORT EXPORT*************************//
    $('#world_import_button').on('click', function () {
        $('#world_import_file').trigger('click');
    });

    $('#world_import_file').on('change', async function (e) {
        if (!(e.target instanceof HTMLInputElement)) {
            return;
        }

        const file = e.target.files[0];

        await importWorldInfo(file);

        // Will allow to select the same file twice in a row
        e.target.value = '';
    });

    $('#world_create_button').on('click', async () => {
        const tempName = getFreeWorldName();
        const finalName = await Popup.show.input(t`Create a new World Info`, t`Enter a name for the new file:`, tempName);

        if (finalName) {
            await createNewWorldInfo(finalName, { interactive: true });
        }
    });

    $('#world_editor_select').on('change', () => selectEditorBook());
    $('#world_editor_select').trigger('change');

    const saveSettings = () => {
        saveSettingsDebounced('world_info_settings');
        eventSource.emit(event_types.WORLDINFO_SETTINGS_UPDATED);
    };

    $('#world_info_depth').on('input', function () {
        world_info_depth = Number($(this).val());
        $('#world_info_depth_counter').val($(this).val());
        saveSettings();
    });

    $('#world_info_min_activations').on('input', function () {
        world_info_min_activations = Number($(this).val());
        $('#world_info_min_activations_counter').val(world_info_min_activations);

        if (world_info_min_activations !== 0 && world_info_max_recursion_steps !== 0) {
            $('#world_info_max_recursion_steps').val(0).trigger('input');
            flashHighlight($('#world_info_max_recursion_steps').parent()); // flash the other control to show it has changed
            console.info('[WI] Max recursion steps set to 0, as min activations is set to', world_info_min_activations);
        } else {
            saveSettings();
        }
    });

    $('#world_info_min_activations_depth_max').on('input', function () {
        world_info_min_activations_depth_max = Number($(this).val());
        $('#world_info_min_activations_depth_max_counter').val($(this).val());
        saveSettings();
    });

    $('#world_info_budget').on('input', function () {
        world_info_budget = Number($(this).val());
        $('#world_info_budget_counter').val($(this).val());
        saveSettings();
    });

    $('#world_info_include_names').on('input', function () {
        world_info_include_names = !!$(this).prop('checked');
        saveSettings();
    });

    $('#world_info_recursive').on('input', function () {
        world_info_recursive = !!$(this).prop('checked');
        saveSettings();
    });

    $('#world_info_case_sensitive').on('input', function () {
        world_info_case_sensitive = !!$(this).prop('checked');
        saveSettings();
    });

    $('#world_info_match_whole_words').on('input', function () {
        world_info_match_whole_words = !!$(this).prop('checked');
        saveSettings();
    });

    $('#world_info_character_strategy').on('change', function () {
        world_info_character_strategy = Number($(this).val());
        saveSettings();
    });

    $('#world_info_overflow_alert').on('change', function () {
        world_info_overflow_alert = !!$(this).prop('checked');
        saveSettingsDebounced('world_info_settings');
    });

    $('#world_info_use_group_scoring').on('change', function () {
        world_info_use_group_scoring = !!$(this).prop('checked');
        saveSettingsDebounced('world_info_settings');
    });

    $('#world_info_budget_cap').on('input', function () {
        world_info_budget_cap = Number($(this).val());
        $('#world_info_budget_cap_counter').val(world_info_budget_cap);
        saveSettings();
    });

    $('#world_info_max_recursion_steps').on('input', function () {
        world_info_max_recursion_steps = Number($(this).val());
        $('#world_info_max_recursion_steps_counter').val(world_info_max_recursion_steps);
        if (world_info_max_recursion_steps !== 0 && world_info_min_activations !== 0) {
            $('#world_info_min_activations').val(0).trigger('input');
            flashHighlight($('#world_info_min_activations').parent()); // flash the other control to show it has changed
            console.info('[WI] Min activations set to 0, as max recursion steps is set to', world_info_max_recursion_steps);
        } else {
            saveSettings();
        }
    });

    $('#world_button').on('click', async function (event) {
        const openSetWorldMenu = () => $('#char-management-dropdown').val($('#set_character_world').val()).trigger('change');
        const avatar = $('#set_character_world').data('avatar');

        if (avatar === null) {
            openSetWorldMenu();
            return;
        }

        const character = charactersStore.get(avatar);

        const worldName = character?.data?.extensions?.world;
        if (worldName && world_names.includes(worldName) && !event.shiftKey && !event.altKey) {
            openWorldInfoEditor(worldName);
        } else {
            openSetWorldMenu();
        }
    });
    addLongPressEvent('#world_button', function () {
        $(this).trigger($.Event('click', { shiftKey: true }));
    });

    const debouncedWorldInfoSearch = debounce((searchQuery) => {
        worldInfoFilter.setFilterData(FILTER_TYPES.WORLD_INFO_SEARCH, searchQuery);
    });
    $('#world_info_search').on('input', function () {
        const searchQuery = $(this).val();
        debouncedWorldInfoSearch(searchQuery);
    });

    $('#world_refresh').on('click', () => {
        updateEditor(navigation_option.previous);
    });

    $('#world_info_sort_order').on('change', function () {
        const value = String($(this).find(':selected').val());
        // Save sort order, but do not save search sorting, as this is a temporary sorting option
        if (value !== 'search') accountStorage.setItem(SORT_ORDER_KEY, value);
        updateEditor(navigation_option.none);
    });

    $(document).on('click', '.chat_lorebook_button', assignLorebookToChat);
    addLongPressEvent('.chat_lorebook_button', function () {
        assignLorebookToChat({ shiftKey: true, altKey: false });
    });

    $('#group-chat-lorebook-dropdown').on('change', async function () {
        $(this).prop('selectedIndex', 0);
        await assignLorebookToChat({ shiftKey: true, altKey: false });
    });

    // Not needed on mobile
    if (!isMobile()) {
        $('#world_editor_select').select2({
            placeholder: t`--- Pick to Edit ---`,
            searchInputPlaceholder: t`Search...`,
            allowClear: true,
            closeOnSelect: true,
            multiple: false,
        });

        $('#world_info').select2({
            width: '100%',
            placeholder: t`No Worlds active. Click here to select.`,
            allowClear: true,
            closeOnSelect: false,
        });

        // Subscribe world loading to the select2 multiselect items (We need to target the specific select2 control)
        select2ChoiceClickSubscribe($('#world_info'), target => {
            const name = $(target).text();
            const selectedIndex = world_names.indexOf(name);
            const alreadySelectedInEditor = $('#world_editor_select option:selected').text() === name;
            if (selectedIndex !== -1 && !alreadySelectedInEditor) {
                $('#world_editor_select').val(selectedIndex).trigger('change');
                console.log('Quick selection of world', name);
            } else {
                console.warn('lets not reload an already loaded list yes?');
            }
        }, { buttonStyle: true, closeDrawer: true });
    }

    $('#WorldInfo').on('scroll', () => {
        $('.world_entry input[name="group"], .world_entry input[name="automationId"]').each((_, el) => {
            const instance = $(el).autocomplete('instance');

            if (instance !== undefined) {
                $(el).autocomplete('close');
            }
        });
    });
}
