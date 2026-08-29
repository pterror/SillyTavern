import { DOMPurify } from '../lib.js';

import {
    characters,
    charactersStore,
    getCurrentCharacter,
    getSelectionState,
    saveSettingsDebounced,
    menu_type,
    entitiesFilter,
    printCharactersDebounced,
    buildAvatarList,
    eventSource,
    event_types,
    DEFAULT_PRINT_TIMEOUT,
    printCharacters,
    getRequestHeaders,
    fetchServerCharacterSearchResults,
} from '../script.js';
import { FILTER_TYPES, FILTER_STATES, DEFAULT_FILTER_STATE, isFilterState, FilterHelper } from './filters.js';

import { groupCandidatesFilter, groupMembersFilter, groups, groupsStore, selected_group } from './group-chats.js';
import { download, onlyUnique, parseJsonFile, uuidv4, getSortableDelay, flashHighlight, equalsIgnoreCaseAndAccents, includesIgnoreCaseAndAccents, removeFromArray, getFreeName, debounce, findChar, escapeHtml } from './utils.js';
import { power_user, invalidateCharactersFuseIndex, invalidateGroupsFuseIndex, invalidateTagsFuseIndex } from './power-user.js';
import { EntityStore, RelationStore } from './entity-store.js';
import { SlashCommandParser } from './slash-commands/SlashCommandParser.js';
import { SlashCommand } from './slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from './slash-commands/SlashCommandArgument.js';
import { isMobile } from './RossAscends-mods.js';
import { POPUP_RESULT, POPUP_TYPE, Popup, callGenericPopup } from './popup.js';
import { debounce_timeout } from './constants.js';
import { INTERACTABLE_CONTROL_CLASS } from './keyboard.js';
import { commonEnumProviders } from './slash-commands/SlashCommandCommonEnumsProvider.js';
import { renderTemplateAsync } from './templates.js';
import { t, translate } from './i18n.js';
import { accountStorage } from './util/AccountStorage.js';
import { enumTypes, SlashCommandEnumValue } from './slash-commands/SlashCommandEnumValue.js';
import { getCachedTags, setCachedTags } from './tags-cache.js';
import { checkCharactersExistOrNull } from './character-existence-check.js';

export {
    TAG_FOLDER_TYPES,
    TAG_FOLDER_DEFAULT_TYPE,
    tags,
    tag_map,
    filterByTagState,
    isBogusFolder,
    isBogusFolderOpen,
    chooseBogusFolder,
    getTagBlock,
    loadTagsSettings,
    seedTagMapFromRecords,
    printTagFilters,
    getTagsList,
    printTagList,
    appendTagToList,
    createTagMapFromList,
    renameTagKey,
    importTags,
    sortTags,
    compareTagsForSort,
    removeTagFromMap,
    invalidateAssignedTagIdsCache,
    getAssignedTagIds,
    tagsStore,
};

const CHARACTER_FILTER_SELECTOR = '#rm_characters_block .rm_tag_filter';
const GROUP_FILTER_SELECTOR = '#rm_group_add_members_header ~ .rm_tag_controls .rm_tag_filter';
const GROUP_MEMBERS_FILTER_SELECTOR = '#rm_group_members_header ~ .rm_tag_controls .rm_tag_filter';
const TAG_TEMPLATE = $('#tag_template .tag');
const FOLDER_TEMPLATE = $('#bogus_folder_template .bogus_folder_select');
const VIEW_TAG_TEMPLATE = $('#tag_view_template .tag_view_item');

/**
 * Gets the context information (selector and search input) for a filter helper.
 * Used to reduce code duplication when working with different filter contexts.
 * @param {FilterHelper} filterHelper - The filter helper instance
 * @returns {{selector: string, searchInput: string}|null} Context info or null if unknown
 */
function getFilterContext(filterHelper) {
    if (filterHelper === entitiesFilter) {
        return {
            selector: CHARACTER_FILTER_SELECTOR,
            searchInput: '#character_search_bar',
        };
    } else if (filterHelper === groupCandidatesFilter) {
        return {
            selector: GROUP_FILTER_SELECTOR,
            searchInput: '#rm_group_filter',
        };
    } else if (filterHelper === groupMembersFilter) {
        return {
            selector: GROUP_MEMBERS_FILTER_SELECTOR,
            searchInput: '#rm_group_members_filter',
        };
    }
    return null;
}

/**
 * Get the filter helper for a given list selector.
 * @param {string|JQuery<HTMLElement>} listSelector - jQuery selector for the list
 * @returns {FilterHelper} The appropriate filter helper instance
 */
function getFilterHelper(listSelector) {
    const $element = typeof listSelector === 'string' ? $(listSelector) : listSelector;

    // Check if this filter is in the group members section
    if ($element.closest('#currentGroupMembers').length > 0) {
        return groupMembersFilter;
    }

    // Check if this filter is in the group candidates (add members) section
    if ($element.closest('#unaddedCharList').length > 0) {
        return groupCandidatesFilter;
    }

    // Default to character list filter
    return entitiesFilter;
}

/**
 * Checks if the given type is a group context.
 * @param {tag_filter_type} type - The filter type to check
 * @returns {boolean} True if this is a group context
 */
function isGroupContext(type) {
    return [tag_filter_type.group_candidates_list, tag_filter_type.group_members_list].includes(type);
}

/**
 * Gets visible character avatars for a group context.
 * @param {tag_filter_type} type - The filter type
 * @param {object} currentGroup - The current group object
 * @returns {string[]} Array of visible character avatars
 */
function getVisibleAvatarsForGroupContext(type, currentGroup) {
    if (!currentGroup || !Array.isArray(currentGroup.members)) {
        return [];
    }

    switch (type) {
        case tag_filter_type.group_members_list:
            return currentGroup.members;
        case tag_filter_type.group_candidates_list:
            return characters
                .filter(c => !currentGroup.members.includes(c.avatar))
                .map(c => c.avatar);
        default:
            console.warn('getVisibleAvatarsForGroupContext got invalid type, expected 1 or 2, got ', type);
            return [];
    }
}

/**
 * Filters actionable tags for group contexts.
 * In group contexts, hide GROUP and FOLDER filters but keep Favorites and utility buttons.
 * @param {object[]} actionTags - Array of actionable tag objects
 * @returns {object[]} Filtered array of actionable tags
 */
function filterActionableTagsForGroupContext(actionTags) {
    return actionTags.filter(tag => {
        // Always show Favorites
        if (tag.id === ACTIONABLE_TAGS.FAV.id) {
            return true;
        }
        // Hide GROUP and FOLDER filters in group contexts (not relevant)
        if (tag.id === ACTIONABLE_TAGS.GROUP.id || tag.id === ACTIONABLE_TAGS.FOLDER.id) {
            return false;
        }
        // Show utility buttons (VIEW, HINT, UNFILTER)
        return true;
    });
}

const ACTIONABLE_FILTER_STORAGE_KEYS = Object.freeze({
    GROUP: 'TagFilterState_GROUP',
    FAV: 'TagFilterState_FAV',
    FOLDER: 'TagFilterState_FOLDER',
});

/**
 * Gets the storage key prefix for a filter helper to enable persistence.
 * @param {FilterHelper} filterHelper - The filter helper to check
 * @returns {string|null} Storage key prefix or null if no persistence
 */
function getFilterStorageKey(filterHelper) {
    if (filterHelper === entitiesFilter) {
        return 'CharacterList';
    } else if (filterHelper === groupCandidatesFilter) {
        return 'GroupCandidates';
    } else if (filterHelper === groupMembersFilter) {
        return 'GroupMembers';
    }
    return null;
}

/**
 * Checks if the given filter helper is the main character list filter.
 * @param {FilterHelper} filterHelper - The filter helper to check
 * @returns {boolean} True if this is the main character list
 */
function isMainCharacterList(filterHelper) {
    return filterHelper === entitiesFilter;
}

/** @enum {number} */
export const tag_filter_type = {
    character: 0,
    /** @deprecated use `group_candidates_list` instead */
    group_member: 1,
    group_candidates_list: 1,
    group_members_list: 2,
};

/**
 * Gets the power_user setting key for tag filter visibility for a given context.
 * @param {number} type - The tag_filter_type
 * @returns {string} The power_user setting key
 */
function getTagFilterVisibilitySetting(type) {
    switch (type) {
        case tag_filter_type.character:
            return 'show_tag_filters';
        case tag_filter_type.group_candidates_list:
            return 'show_tag_filters_group_candidates';
        case tag_filter_type.group_members_list:
            return 'show_tag_filters_group_members';
        default:
            return 'show_tag_filters';
    }
}

/**
 * Gets the tag filter visibility state for a given context.
 * @param {number} type - The tag_filter_type
 * @returns {boolean} Whether tag filters should be shown
 */
function getTagFilterVisibility(type) {
    const settingKey = getTagFilterVisibilitySetting(type);
    return power_user[settingKey] ?? false;
}

/**
 * Sets the tag filter visibility state for a given context.
 * @param {number} type - The tag_filter_type
 * @param {boolean} visible - Whether tag filters should be shown
 */
function setTagFilterVisibility(type, visible) {
    const settingKey = getTagFilterVisibilitySetting(type);
    if (power_user[settingKey] === visible) return;
    power_user[settingKey] = visible;
    saveSettingsDebounced(`power_user.${settingKey}`);
}

/** @enum {number} */
export const tag_import_setting = {
    ASK: 1,
    NONE: 2,
    ALL: 3,
    ONLY_EXISTING: 4,
};

/** @enum {string} */
export const tag_sort_mode = {
    MANUAL: 'manual',
    ALPHABETICAL: 'alphabetical',
    BY_ENTRIES: 'by_entries',
};

/**
 * A collection of global actionable tags for the filter panel.
 *
 * Tags with `filter_state` property (FAV, GROUP, FOLDER) maintain persistent state:
 * - Each context (character list, group candidates, group members) saves state independently
 * - Main character list also maintains tag.filter_state for backward compatibility
 *
 * Tags without `filter_state` (VIEW, HINT, UNFILTER) are action buttons only.
 */
const ACTIONABLE_TAGS = {
    FAV: { id: '1', sort_order: 1, name: 'Show only favorites', color: 'rgba(255, 255, 0, 0.5)', filter_state: undefined, action: filterByFav, icon: 'fa-solid fa-star', class: 'filterByFavorites' },
    GROUP: { id: '0', sort_order: 2, name: 'Show only groups', color: 'rgba(100, 100, 100, 0.5)', filter_state: undefined, action: filterByGroups, icon: 'fa-solid fa-users', class: 'filterByGroups' },
    FOLDER: { id: '4', sort_order: 3, name: 'Show only folders', color: 'rgba(120, 120, 120, 0.5)', filter_state: undefined, action: filterByFolder, icon: 'fa-solid fa-folder-plus', class: 'filterByFolder' },
    VIEW: { id: '2', sort_order: 4, name: 'Manage tags', color: 'rgba(150, 100, 100, 0.5)', action: onViewTagsListClick, icon: 'fa-solid fa-gear', class: 'manageTags' },
    HINT: { id: '3', sort_order: 5, name: 'Show Tag List', color: 'rgba(150, 100, 100, 0.5)', action: onTagListHintClick, icon: 'fa-solid fa-tags', class: 'showTagList' },
    UNFILTER: { id: '5', sort_order: 6, name: 'Clear all filters', action: onClearAllFiltersClick, icon: 'fa-solid fa-filter-circle-xmark', class: 'clearAllFilters' },
};

/**
 * Map of tag IDs to their corresponding filter types.
 * Used for actionable tags (Favorites, Groups, Folders).
 *
 * Built lazily on first use rather than at module-eval time: tags.js and filters.js
 * import each other (filters.js needs tag_map, tags.js needs FILTER_TYPES), so a
 * top-level `FILTER_TYPES.FAV` reference here can run while filters.js is still mid
 * import-resolution, before its `export const FILTER_TYPES` has initialized.
 * @type {Map<string, string>|null}
 */
let TAG_ID_TO_FILTER_TYPE = null;

/**
 * @returns {Map<string, string>} Map of tag IDs to their corresponding filter types.
 */
function getTagIdToFilterType() {
    if (TAG_ID_TO_FILTER_TYPE === null) {
        TAG_ID_TO_FILTER_TYPE = new Map([
            [ACTIONABLE_TAGS.FAV.id, FILTER_TYPES.FAV],
            [ACTIONABLE_TAGS.GROUP.id, FILTER_TYPES.GROUP],
            [ACTIONABLE_TAGS.FOLDER.id, FILTER_TYPES.FOLDER],
        ]);
    }
    return TAG_ID_TO_FILTER_TYPE;
}

/** @type {{[key: string]: Tag}} An optional list of actionables that can be utilized by extensions */
const InListActionable = {
};

/** @type {Tag[]} A list of default tags */
const DEFAULT_TAGS = [
    { id: uuidv4(), name: 'Plain Text', create_date: Date.now() },
    { id: uuidv4(), name: 'OpenAI', create_date: Date.now() },
    { id: uuidv4(), name: 'W++', create_date: Date.now() },
    { id: uuidv4(), name: 'Boostyle', create_date: Date.now() },
    { id: uuidv4(), name: 'PList', create_date: Date.now() },
    { id: uuidv4(), name: 'AliChat', create_date: Date.now() },
];

/**
 * @typedef FolderType Bogus folder type
 * @property {string} icon - The icon as a string representation / character
 * @property {string} class - The class to apply to the folder type element
 * @property {string} [fa_icon] - Optional font-awesome icon class representing the folder type element
 * @property {string} [tooltip] - Optional tooltip for the folder type element
 * @property {string} [color] - Optional color for the folder type element
 * @property {string} [size] - A string representation of the size that the folder type element should be
 */

/**
 * @type {{ OPEN: FolderType, CLOSED: FolderType, NONE: FolderType, [key: string]: FolderType }}
 * The list of all possible tag folder types
 */
const TAG_FOLDER_TYPES = {
    OPEN: { icon: '✔', class: 'folder_open', fa_icon: 'fa-folder-open', tooltip: 'Open Folder (Show all characters even if not selected)', color: 'green', size: '1' },
    CLOSED: { icon: '👁', class: 'folder_closed', fa_icon: 'fa-eye-slash', tooltip: 'Closed Folder (Hide all characters unless selected)', color: 'lightgoldenrodyellow', size: '0.7' },
    NONE: { icon: '✕', class: 'no_folder', tooltip: 'No Folder', color: 'red', size: '1' },
};
const TAG_FOLDER_DEFAULT_TYPE = 'NONE';

/**
 * @typedef {object} Tag - Object representing a tag
 * @property {string} id - The id of the tag (As a kind of has string. This is used whenever the tag is referenced or linked, as the name might change)
 * @property {string} name - The name of the tag
 * @property {string} [folder_type] - The bogus folder type of this tag (based on `TAG_FOLDER_TYPES`)
 * @property {string} [filter_state] - The saved state of the filter chosen of this tag (based on `FILTER_STATES`)
 * @property {number} [sort_order] - A custom integer representing the sort order if tags are sorted
 * @property {string} [color] - The background color of the tag
 * @property {string} [color2] - The foreground color of the tag
 * @property {number} [create_date] - A number representing the date when this tag was created
 * @property {boolean} [is_hidden_on_character_card] - Whether this tag is hidden on the character card
 *
 * @property {function} [action] - An optional function that gets executed when this tag is an actionable tag and is clicked on.
 * @property {string} [class] - An optional css class added to the control representing this tag when printed. Used for custom tags in the filters.
 * @property {string} [icon] - An optional css class of an icon representing this tag when printed. This will replace the tag name with the icon. Used for custom tags in the filters.
 * @property {string} [title] - An optional title for the tooltip of this tag. If there is no tooltip specified, and "icon" is chosen, the tooltip will be the "name" property.
 */

/**
 * An list of all tags that are available
 * @type {Tag[]}
 */
let tags = [];

/**
 * A map representing the key of an entity (character avatar, group id, etc) with a corresponding array of tags this entity has assigned. The array might not exist if no tags were assigned yet.
 * @type {{[identifier: string]: string[]?}}
 */
let tag_map = {};

/** Server-loaded set of tag IDs assigned to at least one entity (from tag_usage table, fetched with tag definitions). */
let serverAssignedTagIds = new Set();

/**
 * A cache of all cut-off tag lists that got expanded until the last reload. They will be printed expanded again.
 * It contains the key of the entity.
 * @type {string[]} ids
 */
let expanded_tags_cache = [];

/**
 * The tags -> entity-store migration (see entity-store.js): these two stores back `tags`/`tag_map` internally.
 * They still wrap the *same* `tags` array / `tag_map` object in place, so every other read call site in this
 * file (and in every other file that imports `tags`/`tag_map` directly) keeps working completely unchanged.
 * Nearly every mutation site in this file now goes through these stores' own ops instead of touching `tags`/
 * `tag_map` directly (a few genuinely-bulk, rare operations - the manual tag drag-reorder, the tags-backup
 * restore flow - are deliberately still direct mutations followed by a bulk reindex, see their own comments).
 * @type {EntityStore<Tag>}
 */
let tagsStore = new EntityStore(tags, tag => tag.id);

/** @type {RelationStore} */
let tagMapStore = new RelationStore(tag_map);

/**
 * Reconstructs `tagsStore`/`tagMapStore` to wrap the current `tags`/`tag_map` references, and (re)registers the
 * search-index-invalidation subscribers on them. Called from `loadTagsSettings` (which reassigns `tags`/
 * `tag_map` themselves, e.g. to `settings.tags`), since a store constructed against the *old* array/object
 * reference would otherwise keep indexing stale, orphaned data - and since a new store instance has no
 * listeners of its own, subscriptions on the previous instance don't carry over.
 */
function rebuildTagStores() {
    tagsStore = new EntityStore(tags, tag => tag.id);
    tagMapStore = new RelationStore(tag_map);

    // A tag's own identity changing (create/delete/rename, or any other field edit) can affect what a text
    // search over tags should match, and - since a character/group's `#tags` search field is built from tag
    // *names* - can also affect character/group search matches. Slightly conservative on purpose (e.g. this
    // also fires for a folder_type-only change, which doesn't actually affect any indexed text) rather than
    // trying to special-case exactly which field changed: the cost of an unnecessary index rebuild on the next
    // search after a rare tag-management action is a single ~80ms rebuild, not the "every keystroke" cost this
    // was originally built to eliminate - so being precise here isn't worth the risk of under-invalidating and
    // serving stale search results instead.
    tagsStore.onChange(() => {
        invalidateTagsFuseIndex();
        invalidateCharactersFuseIndex();
        invalidateGroupsFuseIndex();
    });

    // Any tag_map change can affect a character/group's `#tags` search field content.
    tagMapStore.onChange(() => {
        invalidateCharactersFuseIndex();
        invalidateGroupsFuseIndex();
    });

    // Debounced whole-array save of tag *definitions* (POST /api/tags/save) - every mutation site in this file
    // keeps calling tagsStore's own ops exactly as before and doesn't know this save exists.
    tagsStore.onChange(saveTagsDebounced);

    // Tag *assignments* are no longer a blob to save wholesale - phase 3 (character-data-residency redesign)
    // moved them to per-user sqlite, mutated one row at a time via POST /api/tags/assign|unassign. Each
    // tagMapStore op reports exactly what changed (RelationChange), so persistTagMapChange() below translates
    // that directly into the matching network call(s) instead of re-uploading the whole tag_map on every change.
    tagMapStore.onChange(persistTagMapChange);

    // Keep serverAssignedTagIds in sync with in-session tag mutations so the filter sidebar
    // stays correct without a full re-fetch.
    tagMapStore.onChange((change) => {
        if (change.op === 'unassigned' && change.wasLastUse) {
            serverAssignedTagIds.delete(change.relatedId);
        }
        if (change.op === 'assigned' && change.wasFirstUse) {
            serverAssignedTagIds.add(change.relatedId);
        }
    });
}

/**
 * POSTs the current tag *definitions* array to the server (POST /api/tags/save) - assignments are never part of
 * this payload anymore (see persistTagMapChange()). Shared by the debounced mutation-triggered save
 * (saveTagsDebounced) and the one-shot seed save in loadTagsSettings.
 */
async function saveTagsNow() {
    try {
        const response = await fetch('/api/tags/save', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ tags }),
            cache: 'no-cache',
        });

        if (!response.ok) {
            throw new Error(`Failed to save tags: ${response.statusText}`);
        }

        // Keep the client's tags cache (tags-cache.js, consulted by loadTagsSettings() on the next boot) in sync
        // with what the server now has. Re-fetch the revision rather than guess at it - and any drift here is
        // correctness-safe either way (it would just cost one extra full /api/tags/get fetch next boot instead
        // of a cache hit, not stale data).
        const manifestResponse = await fetch('/api/tags/manifest', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({}),
            cache: 'no-cache',
        });
        if (manifestResponse.ok) {
            const { hash } = await manifestResponse.json();
            if (hash !== null && hash !== undefined) {
                await setCachedTags(hash, tags, [...serverAssignedTagIds]);
            }
        } else {
            console.error(`Failed to refresh tags manifest after save: ${manifestResponse.statusText}`);
        }
    } catch (error) {
        console.error('Error saving tags:', error);
    }
}

/**
 * Debounced save of the tag *definitions* array (POST /api/tags/save). Registered as tagsStore's onChange
 * subscriber (rebuildTagStores()) - every definition mutation site in this file keeps calling its store op
 * exactly as before and doesn't know this save exists.
 */
const saveTagsDebounced = debounce(saveTagsNow, debounce_timeout.relaxed);

/**
 * Runs `worker` over `items` in fixed-size chunks, awaiting each chunk (via Promise.all) before starting the
 * next - bounded concurrency without either extreme (fully serial, or unbounded-parallel). Used by
 * persistTagMapChange() below for the bulk-fanout ops (relatedRemoved in particular can mean one network call
 * per affected character/group in a large library).
 * @template T
 * @param {T[]} items
 * @param {(item: T) => Promise<any>} worker
 * @param {number} [chunkSize=8]
 * @returns {Promise<void>}
 */
async function runWithConcurrency(items, worker, chunkSize = 8) {
    for (let i = 0; i < items.length; i += chunkSize) {
        const chunk = items.slice(i, i + chunkSize);
        await Promise.all(chunk.map(worker));
    }
}

/**
 * Single-row POST /api/tags/assign. Fire-and-forget - see persistTagMapChange()'s doc comment for the failure
 * tolerance (matches the old debounced-whole-file-save's: a failed fetch is logged, never retried or rolled
 * back, same gap as before just at finer grain now).
 * @param {string} id Character avatar or group id (a tagMapStore key)
 * @param {string} tagId
 * @returns {Promise<void>}
 */
async function assignTagOnServer(id, tagId) {
    try {
        const response = await fetch('/api/tags/assign', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ id, tagId }),
            cache: 'no-cache',
        });
        if (!response.ok) {
            throw new Error(`Failed to assign tag: ${response.statusText}`);
        }
    } catch (error) {
        console.error(`Error assigning tag ${tagId} to ${id}:`, error);
    }
}

/**
 * Single-row POST /api/tags/unassign. Same fire-and-forget tolerance as assignTagOnServer() - unassigning an
 * unknown/already-untagged id is a harmless server-side no-op, so this is also safe to call redundantly (e.g.
 * when the underlying character/group is itself mid-deletion and the server's own delete cascade already
 * removed the row).
 * @param {string} id Character avatar or group id (a tagMapStore key)
 * @param {string} tagId
 * @returns {Promise<void>}
 */
async function unassignTagOnServer(id, tagId) {
    try {
        const response = await fetch('/api/tags/unassign', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ id, tagId }),
            cache: 'no-cache',
        });
        if (!response.ok) {
            throw new Error(`Failed to unassign tag: ${response.statusText}`);
        }
    } catch (error) {
        console.error(`Error unassigning tag ${tagId} from ${id}:`, error);
    }
}

/**
 * Translates one tagMapStore RelationChange into the matching /api/tags/assign|unassign network call(s) - the
 * tagMapStore.onChange subscriber registered in rebuildTagStores(). Every tag_map mutation call site in this
 * file already funnels through tagMapStore's own ops (assign/unassign/setKey/copyKey/removeKey/
 * removeRelatedIdEverywhere/renameKey), so this one place persists all of them - a mutation site never talks to
 * the network directly.
 *
 * Fire-and-forget, no rollback on failure: matches the exact failure tolerance the old debounced-whole-tags.json
 * write already had (a failed save there was also just logged, never retried or rolled back) - this is the same
 * gap, just at finer (per-assignment) grain instead of per-batch.
 *
 * `keyRenamed` is deliberately a NO-OP here, unlike every other case: it only ever fires from renameTagKey(),
 * itself only ever called from script.js on a character rename - and the server's own `/characters/rename`
 * route already carries that character's tag assignments forward from the old id to the new one, atomically,
 * server-side, with no client action needed (character-metadata-db.js's renameCharacterRow() unions old-avatar's
 * tag rows into new-avatar's before deleting the old row). Firing assign/unassign calls here too would be
 * redundant work at best and a race against a rename that's already complete server-side at worst.
 * tagMapStore.renameKey() itself still runs in renameTagKey() (unconditionally, before this subscriber ever
 * sees the change) so the *local* cache's key is correct immediately, without waiting on a fresh /for fetch.
 * @param {import('./entity-store.js').RelationChange} change
 */
function persistTagMapChange(change) {
    switch (change.op) {
        case 'assigned':
            assignTagOnServer(change.key, change.relatedId);
            break;
        case 'unassigned':
            unassignTagOnServer(change.key, change.relatedId);
            break;
        case 'keySet': {
            const key = change.key;
            const tasks = [
                ...change.addedIds.map(tagId => () => assignTagOnServer(key, tagId)),
                ...change.removedIds.map(tagId => () => unassignTagOnServer(key, tagId)),
            ];
            runWithConcurrency(tasks, task => task());
            break;
        }
        case 'keyCopied':
            runWithConcurrency(change.addedIds, tagId => assignTagOnServer(change.toKey, tagId));
            break;
        case 'keyRemoved':
            // The character/group deletion path (deleteCharacterRow()/deleteGroupRow()) already cascades and
            // removes these rows server-side, so these calls are typically redundant-but-harmless in that case -
            // not worth detecting and skipping, per the design decision to just let them fire (unassign
            // tolerates unknown ids).
            runWithConcurrency(change.removedIds, tagId => unassignTagOnServer(change.key, tagId));
            break;
        case 'relatedRemoved': {
            const tasks = [];
            for (const key of change.affectedKeys) {
                tasks.push(() => unassignTagOnServer(key, change.relatedId));
                if (change.replacedWithId) {
                    tasks.push(() => assignTagOnServer(key, change.replacedWithId));
                }
            }
            runWithConcurrency(tasks, task => task());
            break;
        }
        case 'keyRenamed':
            // Deliberately a no-op - see this function's doc comment above.
            break;
    }
}

/**
 * Forces `tagMapStore`'s usage-count index to be recomputed from the current contents of `tag_map`. Needed
 * because a few other modules (BulkEditOverlay.js, group-chats.js, script.js) still write into `tag_map`
 * directly rather than through `tagMapStore`'s own ops (that migration is still to come) - this is the bridge
 * that keeps the store's incremental bookkeeping correct in the meantime. Also invalidates the persistent
 * character/group search indexes (power-user.js), since their `#tags` field depends on tag_map content.
 */
function invalidateAssignedTagIdsCache() {
    tagMapStore.reindex();
    invalidateCharactersFuseIndex();
    invalidateGroupsFuseIndex();
}

/**
 * Gets a `.has(id)`-checkable collection of all tag ids that are currently assigned to at least one entity in
 * `tag_map`. Returns `tagMapStore`'s live usage-count Map directly (not a copy) - every current caller only
 * needs `.has()`, which a Map supports natively, so there's no need to materialize a fresh Set on every call
 * (that would turn an O(1) lookup back into an O(k) allocation each time this is called, which is often -
 * multiple times per printTagFilters(), which itself runs on every render).
 * @returns {{ has(id: string): boolean }}
 */
function getAssignedTagIds() {
    if (serverAssignedTagIds.size === 0) {
        return tagMapStore.usageCounts;
    }
    return {
        has(id) {
            return serverAssignedTagIds.has(id) || tagMapStore.usageCounts.has(id);
        },
    };
}

/**
 * Applies the basic filter for the current state of the tags and their selection on an entity list.
 * @param {Array<Object>} entities List of entities for display, consisting of tags, characters and groups.
 * @param {Object} param1 Optional parameters, explained below.
 * @param {Boolean} [param1.globalDisplayFilters] When enabled, applies the final filter for the global list. Icludes filtering out entities in closed/hidden folders and empty folders.
 * @param {Object} [param1.subForEntity] When given an entity, the list of entities gets filtered specifically for that one as a "sub list", filtering out other tags, elements not tagged for this and hidden elements.
 * @param {Boolean} [param1.filterHidden] Optional switch with which filtering out hidden items (from closed folders) can be disabled.
 * @returns The filtered list of entities
 */
function filterByTagState(entities, { globalDisplayFilters = false, subForEntity = undefined, filterHidden = true } = {}) {
    const filterData = structuredClone(entitiesFilter.getFilterData(FILTER_TYPES.TAG));

    entities = entities.filter(entity => {
        if (entity.type === 'tag') {
            // Remove folders that are already filtered on
            if (filterData.selected.includes(entity.id) || filterData.excluded.includes(entity.id)) {
                return false;
            }
        }

        return true;
    });

    if (globalDisplayFilters) {
        // Prepare some data for caching and performance
        const closedFolders = entities.filter(x => x.type === 'tag' && TAG_FOLDER_TYPES[x.item.folder_type] === TAG_FOLDER_TYPES.CLOSED);

        entities = entities.filter(entity => {
            // Hide entities that are in a closed folder, unless that one is opened
            if (filterHidden && entity.type !== 'tag' && closedFolders.some(f => entitiesFilter.isElementTagged(entity, f.id) && !filterData.selected.includes(f.id))) {
                return false;
            }

            // Hide folders that have 0 visible sub entities after the first filtering round, unless we are inside a search via search term.
            // Then we want to display folders that mach too, even if the chars inside don't match the search.
            if (entity.type === 'tag') {
                return entity.entities.length > 0 || entitiesFilter.getFilterData(FILTER_TYPES.SEARCH);
            }

            return true;
        });
    }

    if (subForEntity !== undefined && subForEntity.type === 'tag') {
        entities = filterTagSubEntities(subForEntity.item, entities, { filterHidden: filterHidden });
    }

    return entities;
}

/**
 * Filter a a list of entities based on a given tag, returning all entities that represent "sub entities"
 *
 * @param {Tag} tag - The to filter the entities for
 * @param {object[]} entities - The list of possible entities (tag, group, folder) that should get filtered
 * @param {object} param2 - optional parameteres
 * @param {boolean} [param2.filterHidden] - Whether hidden entities should be filtered out too
 * @returns {object[]} The filtered list of entities that apply to the given tag
 */
function filterTagSubEntities(tag, entities, { filterHidden = true } = {}) {
    const filterData = structuredClone(entitiesFilter.getFilterData(FILTER_TYPES.TAG));

    const closedFolders = entities.filter(x => x.type === 'tag' && TAG_FOLDER_TYPES[x.item.folder_type] === TAG_FOLDER_TYPES.CLOSED);

    entities = entities.filter(sub => {
        // Filter out all tags and and all who isn't tagged for this item
        if (sub.type === 'tag' || !entitiesFilter.isElementTagged(sub, tag.id)) {
            return false;
        }

        // Hide entities that are in a closed folder, unless the closed folder is opened or we display a closed folder
        if (filterHidden && sub.type !== 'tag' && TAG_FOLDER_TYPES[tag.folder_type] !== TAG_FOLDER_TYPES.CLOSED && closedFolders.some(f => entitiesFilter.isElementTagged(sub, f.id) && !filterData.selected.includes(f.id))) {
            return false;
        }

        return true;
    });

    return entities;
}

/**
 * Indicates whether a given tag is defined as a folder. Meaning it's neither undefined nor 'NONE'.
 *
 * @param {Tag} tag - The tag to check
 * @returns {boolean} Whether it's a tag folder
 */
function isBogusFolder(tag) {
    return tag?.folder_type !== undefined && tag.folder_type !== TAG_FOLDER_DEFAULT_TYPE;
}

/**
 * Retrieves all currently open bogus folders
 *
 * @return {Tag[]} An array of open bogus folders
 */
function getOpenBogusFolders() {
    return entitiesFilter.getFilterData(FILTER_TYPES.TAG)?.selected
        .map(tagId => tagsStore.get(tagId))
        .filter(isBogusFolder) ?? [];
}

/**
 * Indicates whether a user is currently in a bogus folder
 *
 * @returns {boolean} If currently viewing a folder
 */
function isBogusFolderOpen() {
    return getOpenBogusFolders().length > 0;
}

/**
 * Function to be called when a specific tag/folder is chosen to "drill down".
 *
 * @param {*} source The jQuery element clicked when choosing the folder
 * @param {string} tagId The tag id that is behind the chosen folder
 * @param {boolean} remove Whether the given tag should be removed (otherwise it is added/chosen)
 */
function chooseBogusFolder(source, tagId, remove = false) {
    // If we are here via the 'back' action, we implicitly take the last filtered folder as one to remove
    const isBack = tagId === 'back';
    if (isBack) {
        const drilldown = $(source).closest('#rm_characters_block').find('.rm_tag_bogus_drilldown');
        const lastTag = drilldown.find('.tag:last').last();
        tagId = lastTag.attr('id');
        remove = true;
    }

    // Instead of manually updating the filter conditions, we just "click" on the filter tag
    // We search inside which filter block we are located in and use that one
    const FILTER_SELECTOR = ($(source).closest('#rm_characters_block') ?? $(source).closest('#rm_group_chats_block')).find('.rm_tag_filter');
    const tagElement = $(FILTER_SELECTOR).find(`.tag[id=${tagId}]`);

    toggleTagThreeState(tagElement, { stateOverride: !remove ? FILTER_STATES.SELECTED : DEFAULT_FILTER_STATE, simulateClick: true });
}

/**
 * Builds the tag block for the specified item.
 *
 * @param {Tag} tag The tag item
 * @param {any[]} entities The list ob sub items for this tag
 * @param {number} hidden A count of how many sub items are hidden
 * @param {boolean} isUseless Whether the tag is useless (should be displayed greyed out)
 * @returns The html for the tag block
 */
function getTagBlock(tag, entities, hidden = 0, isUseless = false) {
    let count = entities.length;

    const tagFolder = TAG_FOLDER_TYPES[tag.folder_type];

    const template = FOLDER_TEMPLATE.clone();
    template.addClass(tagFolder.class);
    template.attr({ 'tagid': tag.id, 'id': `BogusFolder${tag.id}` });
    template.find('.avatar').css({ 'background-color': tag.color, 'color': tag.color2 }).attr('title', `[Folder] ${tag.name}`);
    template.find('.ch_name').text(tag.name).attr('title', `[Folder] ${tag.name}`);
    template.find('.bogus_folder_hidden_counter').text(hidden > 0 ? `${hidden} hidden` : '');
    template.find('.bogus_folder_counter').text(`${count} ` + (count != 1 ? t`characters` : t`character`));
    template.find('.bogus_folder_icon').addClass(tagFolder.fa_icon);
    if (isUseless) template.addClass('useless');

    // Fill inline character images
    buildAvatarList(template.find('.bogus_folder_avatars_block'), entities);

    return template;
}

/**
 * Common logic for applying actionable tag filters (Favorites, Groups, Folders).
 * Persists state to storage for all filter contexts.
 * @param {FilterHelper} filterHelper - Instance of FilterHelper class
 * @param {object} tag - The actionable tag object
 * @param {string} filterType - The filter type constant
 * @param {string} storageKey - The storage key base for persistence
 */
function applyActionableTagFilter(filterHelper, tag, filterType, storageKey) {
    const state = toggleTagThreeState($(this));

    // Persist to storage for all contexts
    const storagePrefix = getFilterStorageKey(filterHelper);
    if (storagePrefix) {
        const contextStorageKey = `${storagePrefix}_${storageKey}`;
        accountStorage.setItem(contextStorageKey, state);
    }

    // Also update global state for main character list (backward compatibility)
    if (isMainCharacterList(filterHelper)) {
        tag.filter_state = state;
    }

    // Update the filter helper for the current context
    filterHelper.setFilterData(filterType, state);
}

/**
 * Determines the filter state for a tag based on context.
 * For actionable tags: reads from persisted state via filter helper.
 * For regular tags: reads from the filter helper's TAG filter data.
 * @param {FilterHelper} filterHelper - The filter helper for the current context
 * @param {object} tag - The tag object
 * @param {boolean} isFilterActionable - Whether the tag is an actionable filter tag
 * @returns {string} The filter state
 */
function determineTagFilterState(filterHelper, tag, isFilterActionable) {
    if (isFilterActionable) {
        // For actionable tags: read from filter helper (which is loaded from storage)
        const filterType = getTagIdToFilterType().get(tag.id) || null;
        if (filterType) {
            return filterHelper.getFilterData(filterType) || DEFAULT_FILTER_STATE;
        }
    } else {
        // For regular tags: read from the filter helper's TAG filter data
        const tagFilterData = filterHelper.getFilterData(FILTER_TYPES.TAG);
        if (tagFilterData.excluded.includes(tag.id)) {
            return 'EXCLUDED';
        }
        if (tagFilterData.selected.includes(tag.id)) {
            return 'SELECTED';
        }
    }

    return DEFAULT_FILTER_STATE;
}

/**
 * Applies the favorite filter to the character list.
 * @param {FilterHelper} filterHelper Instance of FilterHelper class.
 */
function filterByFav(filterHelper) {
    applyActionableTagFilter.call(this, filterHelper, ACTIONABLE_TAGS.FAV, FILTER_TYPES.FAV, ACTIONABLE_FILTER_STORAGE_KEYS.FAV);

    // applyActionableTagFilter() above already triggered a render via setFilterData(), but for the main
    // character list that render reused whatever server search results (fetchServerCharacterSearchResults(),
    // script.js) were last fetched for the *previous* fav filter state - see FilterHelper.setServerSearchResults()'s
    // doc comment (filters.js) for why a stale favOnly value there can't just be patched over client-side: the
    // server's search index page is capped by relevance alone, so a favorited match can be missing from it
    // entirely regardless of what the client's own favFilter() does afterward. If a search is currently active,
    // re-fetch with the new fav state and re-render once the (now favorites-aware, if applicable) results land.
    if (isMainCharacterList(filterHelper)) {
        const searchTerm = filterHelper.getFilterData(FILTER_TYPES.SEARCH);
        if (searchTerm) {
            fetchServerCharacterSearchResults(searchTerm).then(() => printCharactersDebounced());
        }
    }
}

/**
 * Applies the "is group" filter to the character list.
 * @param {FilterHelper} filterHelper Instance of FilterHelper class.
 */
function filterByGroups(filterHelper) {
    applyActionableTagFilter.call(this, filterHelper, ACTIONABLE_TAGS.GROUP, FILTER_TYPES.GROUP, ACTIONABLE_FILTER_STORAGE_KEYS.GROUP);
}

/**
 * Applies the "only folder" filter to the character list.
 * @param {FilterHelper} filterHelper Instance of FilterHelper class.
 */
function filterByFolder(filterHelper) {
    if (!power_user.bogus_folders) {
        $('#bogus_folders').prop('checked', true).trigger('input');
        onViewTagsListClick();
        flashHighlight($('#tag_view_list .tag_as_folder, #tag_view_list .tag_folder_indicator'));
        return;
    }

    applyActionableTagFilter.call(this, filterHelper, ACTIONABLE_TAGS.FOLDER, FILTER_TYPES.FOLDER, ACTIONABLE_FILTER_STORAGE_KEYS.FOLDER);
}

/**
 * Loads tag *definitions* (`tags` - name/color/folder_type/sort_order/...) from the server's per-user metadata
 * store (POST /api/tags/get).
 *
 * Two different "no tags from the server" cases are handled differently, because they mean different things:
 *   - The server responds but explicitly has none (`{ tags: null }` - the metadata store is unavailable, or a
 *     genuinely fresh install with nothing seeded yet) - falls back to DEFAULT_TAGS and unconditionally seeds/
 *     refreshes the server's definitions with it (see below), same as always.
 *   - The request itself failed (network error, non-2xx response) - the server might still have real
 *     definitions, we just don't know what they are right now. Falling back to DEFAULT_TAGS here and then
 *     seed-saving it (the old unconditional save-on-any-fallback did exactly this) would silently overwrite the
 *     user's actual tag definitions with the six built-in defaults via /api/tags/save's replace-all semantics -
 *     a real, silent data-loss path this function used to invite on any transient network hiccup, not a
 *     hypothetical. So a fetch failure instead reuses the last-known-good tags-cache.js entry (if any) for
 *     display purposes only, and never calls saveTagsNow() - nothing gets pushed back to the server without
 *     actually knowing what's there. (There used to also be a `settings.tags` fallback here, from before the
 *     tags.json split - settings.json has never carried tag data since that split finished, so it was always
 *     `undefined` and never actually reachable; removed rather than kept as dead scaffolding.)
 *
 * `tag_map` (assignments) is NOT loaded here anymore - phase 3 of the character-data-residency redesign moved
 * assignments off any single fetchable blob entirely, onto per-user sqlite rows keyed by character avatar/group
 * id. There is nothing to seed it *from* until `characters`/`groups` are actually populated (this runs during
 * settings load, before either of those exist yet) - `tag_map` is left empty here and gets its real content from
 * a single compact whole-library fetch, see seedTagMapFromRecords() below (called from script.js's boot sequence
 * right after `getCharacters()`).
 */
async function loadTagsSettings() {
    let tagsFile = null;
    let fetchFailed = false;

    // Cheap freshness check before paying for the full (potentially very large) /api/tags/get response: if
    // tags_rev matches what's cached, reuse the cached `tags` and skip the fetch (and the seed/normalize save
    // below) entirely. A `null` revision means the metadata store is unavailable - nothing to be cache-fresh
    // against, so that always falls through to the full path.
    try {
        const manifestResponse = await fetch('/api/tags/manifest', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({}),
            cache: 'no-cache',
        });
        if (manifestResponse.ok) {
            const { hash } = await manifestResponse.json();
            if (hash !== null && hash !== undefined) {
                const cached = await getCachedTags();
                if (cached && cached.hash === hash) {
                    tags = cached.tags;
                    tag_map = Object.create(null);
                    serverAssignedTagIds = new Set(cached.assignedTagIds ?? []);
                    rebuildTagStores();
                    invalidateCharactersFuseIndex();
                    invalidateGroupsFuseIndex();
                    return;
                }
            }
        } else {
            console.error(`Failed to load tags manifest: ${manifestResponse.statusText}`);
        }
    } catch (error) {
        console.error('Error loading tags manifest:', error);
    }

    try {
        const response = await fetch('/api/tags/get', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({}),
            cache: 'no-cache',
        });
        if (response.ok) {
            const data = await response.json();
            if (data && data.tags !== null && data.tags !== undefined) {
                tagsFile = data;
            }
        } else {
            console.error(`Failed to load tags: ${response.statusText}`);
            fetchFailed = true;
        }
    } catch (error) {
        console.error('Error loading tags:', error);
        fetchFailed = true;
    }

    let seedSave = false;
    if (tagsFile) {
        tags = tagsFile.tags;
    } else if (fetchFailed) {
        // Don't know the server's actual state - reuse the last-known-good cache rather than guessing, and
        // don't seed-save it back (see doc comment above).
        const cached = await getCachedTags();
        tags = cached ? cached.tags : DEFAULT_TAGS;
        if (!cached) {
            console.warn('Could not load tag definitions and no cached copy exists - showing built-in defaults locally without saving them.');
        }
    } else {
        // The server responded and explicitly has nothing (fresh install / metadata store unavailable) - this
        // is the one case where seeding the built-in defaults back to the server is actually correct.
        tags = DEFAULT_TAGS;
        seedSave = true;
    }
    tag_map = Object.create(null);

    rebuildTagStores();
    if (tagsFile && Array.isArray(tagsFile.assignedTagIds)) {
        serverAssignedTagIds = new Set(tagsFile.assignedTagIds);
    }
    invalidateCharactersFuseIndex();
    invalidateGroupsFuseIndex();

    if (seedSave) {
        // Closes the gap between "the server has no definitions yet" and "the next definitions save happens":
        // without this, a page load that fell back to DEFAULT_TAGS but never triggers a definition mutation
        // could otherwise end up with the definitions living only in memory.
        await saveTagsNow();
    }
}

/**
 * Builds the local tag_map from character records (which now carry tag_ids in their shallow projection,
 * part of the field-granular sync migration) and a lightweight group-tag fetch. Replaces the old
 * seedTagMapCompact() which fetched ALL assignments (characters + groups) via /api/tags/for-all -
 * character tags now flow through the delta sync's field-level change path instead.
 *
 * Must run after both `characters` and `groups` are populated - called from script.js's boot sequence
 * right after `await getCharacters()`.
 */
async function seedTagMapFromRecords() {
    try {
        // Build tag_map for characters from their tag_ids field (now part of shallow_json,
        // synced via the field-granular delta path instead of a separate bulk fetch).
        tag_map = Object.create(null);
        for (const char of characters) {
            if (char.avatar && Array.isArray(char.tag_ids)) {
                tag_map[char.avatar] = char.tag_ids;
            }
        }

        // Fetch group tag assignments separately - groups don't carry tag_ids in their records
        // (they're a small user-curated set, not the 300k+ character corpus this optimization
        // targets), so a single /api/tags/for call with all group ids is cheap.
        const groupIds = groups.map(g => g.id).filter(Boolean);
        if (groupIds.length > 0) {
            const response = await fetch('/api/tags/for', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ ids: groupIds }),
                cache: 'no-cache',
            });
            if (response.ok) {
                const groupTags = await response.json();
                for (const [id, tagIds] of Object.entries(groupTags)) {
                    if (Array.isArray(tagIds) && tagIds.length > 0) {
                        tag_map[id] = tagIds;
                    }
                }
            }
        }

        rebuildTagStores();
        invalidateCharactersFuseIndex();
        invalidateGroupsFuseIndex();

        // The initial printCharacters(true) already ran with an empty tag_map (this seed runs after it,
        // by construction) - redraw now that real assignments are known, so tag pills/filters aren't stuck
        // empty until some unrelated re-render happens to fire.
        printCharactersDebounced();
        printTagFilters(tag_filter_type.character);
        printTagFilters(tag_filter_type.group_members_list);
        printTagFilters(tag_filter_type.group_candidates_list);
    } catch (error) {
        console.error('Error building tag map from records:', error);
        toastr.warning('Could not load tag data. Tags may be missing.', 'Tag Loading Error', { timeOut: 10000 });
    }
}

/**
 * The sole caller is script.js on a character rename. Only updates the *local* tagMapStore key - deliberately
 * fires no network call of its own (persistTagMapChange()'s 'keyRenamed' case is a no-op; see its doc comment):
 * the server's own `/characters/rename` route already carries that character's tag assignments forward from the
 * old avatar to the new one atomically, server-side, before this ever runs. This just keeps the client's local
 * cache key in sync immediately, without waiting on a fresh /api/tags/for fetch.
 */
function renameTagKey(oldKey, newKey) {
    // Fuse-index invalidation is handled by the tagMapStore.onChange subscriber (rebuildTagStores()).
    tagMapStore.renameKey(oldKey, newKey);
    saveSettingsDebounced('power_user.tag_map');
}

function createTagMapFromList(listElement, key) {
    const tagIds = [...($(listElement).find('.tag').map((_, el) => $(el).attr('id')))];
    // Fuse-index invalidation is handled by the tagMapStore.onChange subscriber (rebuildTagStores()).
    tagMapStore.setKey(key, tagIds);
    saveSettingsDebounced('power_user.tag_map');
}

/**
 * Gets a list of all tags for a given entity key.
 * If you have an entity, you can get it's key easily via `getTagKeyForEntity(entity)`.
 *
 * @param {string} key - The key for which to get tags via the tag map
 * @param {boolean} [sort=true] - Whether the tag list should be sorted
 * @returns {Tag[]} A list of tags
 */
function getTagsList(key, sort = true) {
    if (key === null || key === undefined) {
        return [];
    }

    if (!Array.isArray(tag_map[key])) {
        tag_map[key] = [];
        return [];
    }

    const list = tag_map[key]
        .map(x => tagsStore.get(x))
        .filter(x => x);
    if (sort) list.sort(compareTagsForSort);
    return list;
}

function getInlineListSelector() {
    if (selected_group && menu_type === 'group_edit') {
        return `.group_select[grid="${selected_group}"] .tags`;
    }

    if (getSelectionState().type === 'character' && menu_type === 'character_edit') {
        return `.character_select[data-avatar="${CSS.escape(getCurrentCharacter().avatar)}"] .tags`;
    }

    return null;
}

/**
 * Gets the current tag key based on the currently selected character or group
 */
function getTagKey() {
    if (selected_group && menu_type === 'group_edit') {
        return selected_group;
    }

    if (getSelectionState().type === 'character' && menu_type === 'character_edit') {
        return getCurrentCharacter().avatar;
    }

    return null;
}

/**
 * Gets the tag key for any provided entity/id/key. If a valid tag key is provided, it just returns this.
 * Robust method to find a valid tag key for any entity.
 *
 * @param {object|number|string} entityOrKey An entity with id property (character, group, tag), or directly an id or tag key.
 * @returns {string|undefined} The tag key that can be found.
 */
export function getTagKeyForEntity(entityOrKey) {
    let x = entityOrKey;

    // If it's an object and has an 'id' property, we take this for further processing
    if (typeof x === 'object' && x !== null && 'id' in x) {
        x = x.id;
    }

    // Next lets check if its a valid character or character id, so we can swith it to its tag
    let character;
    if (!character && characters.indexOf(x) >= 0) character = x; // Check for char object
    if (!character && !isNaN(parseInt(entityOrKey))) character = characters[x]; // check if its a char id
    if (!character) character = charactersStore.get(x); // check if its a char key

    if (character) {
        x = character.avatar;
    }

    // Uninitialized character tag map. Guard against `character.avatar` itself being falsy (seen on at least one
    // malformed/legacy character on this install) - `tag_map[undefined] = []` silently creates a real,
    // permanent `"undefined"` string key (JS coerces object keys to strings), which then shows up as a bogus
    // entry in every "which tag_map keys point to real entities" scan.
    if (character && x && !(x in tag_map)) {
        tag_map[x] = [];
        return x;
    }

    // We should hopefully have a key now. Let's check
    if (x in tag_map) {
        return x;
    }

    // If none of the above, we cannot find a valid tag key
    return undefined;
}

/**
 * Checks for a tag key based on an entity for a given element.
 * It checks the given element and upwards parents for a set character id (chid) or group id (grid), and if there is any, returns its unique entity key.
 *
 * @param {JQuery<HTMLElement>|string} element - The element to search the entity id on
 * @returns {string|undefined} The tag key that can be found.
 */
export function getTagKeyForEntityElement(element) {
    if (typeof element === 'string') {
        element = $(element);
    }
    // Start with the given element and traverse up the DOM tree
    while (element.length && element.parent().length) {
        const avatar = element.attr('data-avatar');
        const grid = element.attr('data-grid');
        if (avatar || grid) {
            const id = avatar || grid;
            return getTagKeyForEntity(id);
        }

        // Move up to the parent element
        element = element.parent();
    }

    return undefined;
}

/**
 * Gets the key for char/group by searching based on the name or avatar. If none can be found, a toastr will be shown and null returned.
 * This function is mostly used in slash commands.
 *
 * @param {string?} [charName] The optionally provided char name
 * @param {object} [options] - Optional arguments
 * @param {boolean} [options.suppressLogging=false] - Whether to suppress the toastr warning
 * @returns {string?} - The char/group key, or null if none found
 */
export function searchCharByName(charName, { suppressLogging = false } = {}) {
    const entity = charName
        ? (findChar({ name: charName }) || groups.find(x => equalsIgnoreCaseAndAccents(x.name, charName)))
        : (selected_group ? groupsStore.get(selected_group) : getCurrentCharacter());
    const key = getTagKeyForEntity(entity);
    if (!key) {
        if (!suppressLogging) toastr.warning(`Character ${charName} not found.`);
        return null;
    }
    return key;
}

/**
 * Adds one or more tags to a given entity
 *
 * @param {Tag|Tag[]} tag - The tag or tags to add
 * @param {string|string[]} entityId - The entity or entities to add this tag to. Has to be the entity key (e.g. `addTagToEntity`).
 * @param {object} [options={}] - Optional arguments
 * @param {JQuery<HTMLElement>|string?} [options.tagListSelector=null] - An optional selector if a specific list should be updated with the new tag too (for example because the add was triggered for that function)
 * @param {PrintTagListOptions} [options.tagListOptions] - Optional parameters for printing the tag list. Can be set to be consistent with the expected behavior of tags in the list that was defined before.
 * @returns {boolean} Whether at least one tag was added
 */
export function addTagsToEntity(tag, entityId, { tagListSelector = null, tagListOptions = {} } = {}) {
    const tags = Array.isArray(tag) ? tag : [tag];
    const entityIds = Array.isArray(entityId) ? entityId : [entityId];

    let result = false;

    /** @type {Set<string>} The resolved tag_map keys (avatar / group id) actually touched by this call */
    const affectedKeys = new Set();
    /** @type {Map<string, boolean>} Per tag id, whether *any* assignment in this batch was that tag's first use
     * anywhere - read directly off tagMapStore.assign()'s own return value, no before/after snapshot needed. */
    const usageFlips = new Map();

    // Add tags to the map
    entityIds.forEach((id) => {
        const key = id !== null && id !== undefined ? getTagKeyForEntity(id) : getTagKey();
        if (!key) return;
        affectedKeys.add(key);
        tags.forEach((tag) => {
            const change = tagMapStore.assign(key, tag.id);
            if (change) {
                result = true;
                if (change.wasFirstUse) usageFlips.set(tag.id, true);
            }
        });
    });

    // Save and redraw. A tag toggle only needs a full list re-render (getEntitiesList + rebuild of up to
    // hundreds of rows) if the current view could actually change as a result - otherwise just patch the
    // affected row(s) and the tag filter buttons in place.
    redrawAfterTagChange(tags.map(t => t.id), affectedKeys, usageFlips);
    saveSettingsDebounced('power_user.tag_map');

    // We should manually add the selected tag to the print tag function, so we cover places where the tag list did not automatically include it
    tagListOptions.addTag = tags;

    // add tag to the UI and internal map - we reprint so sorting and new markup is done correctly
    if (tagListSelector) printTagList(tagListSelector, tagListOptions);
    const inlineSelector = getInlineListSelector();
    if (inlineSelector) {
        printTagList($(inlineSelector), tagListOptions);
    }

    return result;
}

/**
 * Checks whether a tag mutation (affecting the given tag ids) could change what the currently displayed
 * character/group list looks like - i.e. whether a full `printCharactersDebounced()` re-render is actually
 * needed, or whether it's enough to patch the affected row(s) in place.
 *
 * The current list view depends on tag content when:
 * - "Tags as folders" is enabled, since folders are themselves derived from tags (a tag change can create,
 *   empty, or change the contents of a folder, at any nesting level currently in view).
 * - There's an active search term, since the Fuse index used for fuzzy search includes each entity's tag
 *   names as a searchable field (see `getTagsList` usage in the `#tags` key getter for `fuzzySearchCharacters`).
 * - There's an active tag filter (selected/excluded) that references one of the tags being changed.
 *
 * @param {string[]} tagIds - The ids of the tags being added/removed
 * @returns {boolean} Whether the current view depends on this change
 */
function tagChangeAffectsCurrentView(tagIds) {
    if (power_user.bogus_folders) {
        return true;
    }

    if (entitiesFilter.getFilterData(FILTER_TYPES.SEARCH)) {
        return true;
    }

    const tagFilter = entitiesFilter.getFilterData(FILTER_TYPES.TAG);
    const relevantTagIds = [...(tagFilter?.selected ?? []), ...(tagFilter?.excluded ?? [])];
    if (relevantTagIds.length && tagIds.some(id => relevantTagIds.includes(id))) {
        return true;
    }

    return false;
}

/**
 * Redraws whatever needs to be redrawn after a tag_map mutation for the given tag ids / entity keys.
 * See `tagChangeAffectsCurrentView` for what "needs a full re-render" means here.
 * @param {string[]} tagIds - The ids of the tags that were added/removed
 * @param {Set<string>} affectedKeys - The tag_map keys (avatar / group id) that were actually touched
 * @param {Map<string, boolean>} [usageFlips] - For each tag id, whether this mutation flipped its overall
 * used/unused status (read directly off tagMapStore.assign()/.unassign()'s wasFirstUse/wasLastUse - not
 * re-derived by comparing before/after snapshots). Used to skip reprinting the tag filter buttons when a tag's
 * overall status didn't actually change (the common case - toggling a tag that's already used elsewhere).
 */
function redrawAfterTagChange(tagIds, affectedKeys, usageFlips = new Map()) {
    if (tagChangeAffectsCurrentView(tagIds)) {
        printCharactersDebounced();
        return;
    }

    // Tag filter buttons only need reprinting if a tag actually became used/unused as a whole (it's now the
    // *only* place, or *no longer any* place, this tag is assigned) - not on every toggle of an already-shared tag.
    // Reprinting is cheap now (id-indexed lookups), but still means rebuilding potentially thousands of tag
    // pill DOM elements, so it's worth skipping when nothing in the filter bar would actually change.
    const usageChanged = tagIds.some(id => usageFlips.get(id));
    if (usageChanged) {
        printTagFilters(tag_filter_type.character);
        printTagFilters(tag_filter_type.group_members_list);
        printTagFilters(tag_filter_type.group_candidates_list);
    }

    updateEntityRowTags(affectedKeys);
}

/**
 * Patches the tag pills of any currently-rendered character/group list rows for the given tag_map keys, without
 * touching the rest of the list.
 * @param {Iterable<string>} keys - tag_map keys (character avatar or group id)
 */
function updateEntityRowTags(keys) {
    for (const key of keys) {
        // Match character rows by data-avatar (the stable id) directly, rather than resolving a charIndex and
        // matching data-chid - the row's data-chid was baked in at whatever time it last rendered, which can
        // mismatch a freshly-computed index if the characters array reordered since.
        const isCharacter = characters.some(c => c.avatar === key);
        const $row = isCharacter
            ? $(`#rm_print_characters_block .character_select[data-avatar="${CSS.escape(String(key))}"]`)
            : $(`#rm_print_characters_block .group_select[data-grid="${CSS.escape(String(key))}"]`);

        if (!$row.length) {
            continue; // Row isn't currently rendered (different page, filtered out, etc) - nothing to patch.
        }

        printTagList($row.find('.tags'), { forEntityOrKey: key, tagOptions: { isCharacterList: true } });
    }
}

/**
 * Removes a tag from a given entity
 * @param {Tag} tag - The tag to remove
 * @param {string|string[]} entityId - The entity to remove this tag from. Has to be the entity key (e.g. `addTagToEntity`). (Also allows multiple entities to be passed in)
 * @param {object} [options={}] - Optional arguments
 * @param {JQuery<HTMLElement>|string?} [options.tagListSelector=null] - An optional selector if a specific list should be updated with the tag removed too (for example because the add was triggered for that function)
 * @param {JQuery<HTMLElement>?} [options.tagElement=null] - Optionally a direct html element of the tag to be removed, so it can be removed from the UI
 * @returns {boolean} Whether at least one tag was removed
 */
export function removeTagFromEntity(tag, entityId, { tagListSelector = null, tagElement = null } = {}) {
    let result = false;
    const entityIds = Array.isArray(entityId) ? entityId : [entityId];

    /** @type {Set<string>} The resolved tag_map keys (avatar / group id) actually touched by this call */
    const affectedKeys = new Set();
    // Whether *any* removal in this batch was this tag's last use anywhere - read directly off
    // tagMapStore.unassign()'s own return value, no before/after snapshot needed.
    let wasLastUse = false;

    // Remove tag from the map
    entityIds.forEach((id) => {
        const key = id !== null && id !== undefined ? getTagKeyForEntity(id) : getTagKey();
        if (!key) return;
        affectedKeys.add(key);
        const change = tagMapStore.unassign(key, tag.id);
        if (change) {
            result = true;
            if (change.wasLastUse) wasLastUse = true;
        }
    });

    // Save and redraw
    redrawAfterTagChange([tag.id], affectedKeys, new Map([[tag.id, wasLastUse]]));
    saveSettingsDebounced('power_user.tag_map');

    // We don't reprint the lists, we can just remove the html elements from them.
    if (tagListSelector) {
        const $selector = (typeof tagListSelector === 'string') ? $(tagListSelector) : tagListSelector;
        $selector.find(`.tag[id="${tag.id}"]`).remove();
    }
    if (tagElement) tagElement.remove();
    $(`${getInlineListSelector()} .tag[id="${tag.id}"]`).remove();

    return result;
}

/**
 * Removes a tag from a given character. If no character is provided, removes it from the currently active one.
 * @param {string} tagId - The id of the tag
 * @param {string} characterId - The id/key of the character or group
 * @returns {boolean} Whether the tag was removed or not
 */
function removeTagFromMap(tagId, characterId = null) {
    const key = characterId !== null && characterId !== undefined ? getTagKeyForEntity(characterId) : getTagKey();

    if (!key) {
        return false;
    }

    // Fuse-index invalidation (only if this actually changed something) is handled by the tagMapStore.onChange
    // subscriber (rebuildTagStores()).
    return !!tagMapStore.unassign(key, tagId);
}

/**
 * Above this many matches, jquery-ui's stock autocomplete `_renderMenu` (no cap of its own, and this app doesn't
 * override it) builds one `<li>` per match - on this install, focusing the tag-add input triggers a search for
 * '' (minLength: 0 + onTagInputFocus), which matches nearly every one of the ~9700 tags, so an uncapped result
 * here means rendering thousands of DOM nodes on every single focus. The underlying filter itself isn't the slow
 * part (sub-few-ms even over the full list) - it's specifically how many list items get built from the result.
 */
const FIND_TAG_RESULT_LIMIT = 50;

function findTag(request, resolve, listSelector) {
    const skipIds = [...($(listSelector).find('.tag').map((_, el) => $(el).attr('id')))];
    const haystack = tags.filter(t => !skipIds.includes(t.id)).sort(compareTagsForSort).map(t => t.name);
    const needle = request.term;
    const hasExactMatch = haystack.findIndex(x => equalsIgnoreCaseAndAccents(x, needle)) !== -1;
    const result = haystack.filter(x => includesIgnoreCaseAndAccents(x, needle)).slice(0, FIND_TAG_RESULT_LIMIT);

    if (request.term && !hasExactMatch) {
        result.unshift(request.term);
    }

    resolve(result);
}

/**
 * Select a tag and add it to the list. This function is (mostly) used as an event handler for the tag selector control.
 *
 * @param {*} event - The event that fired on autocomplete select
 * @param {*} ui - An Object with label and value properties for the selected option
 * @param {*} listSelector - The selector of the list to print/add to
 * @param {object} param1 - Optional parameters for this method call
 * @param {PrintTagListOptions} [param1.tagListOptions] - Optional parameters for printing the tag list. Can be set to be consistent with the expected behavior of tags in the list that was defined before.
 * @returns {boolean} <c>false</c>, to keep the input clear
 */
function selectTag(event, ui, listSelector, { tagListOptions = {} } = {}) {
    let tagName = ui.item.value;
    let tag = getTag(tagName);

    // create new tag if it doesn't exist
    if (!tag) {
        tag = createNewTag(tagName);
    }

    // unfocus and clear the input
    $(event.target).val('').trigger('input');

    // Optional, check for multiple character ids being present.
    const characterData = event.target.closest('#bulk_tags_div')?.dataset.characters;
    const characterIds = characterData ? JSON.parse(characterData).characterIds : null;

    addTagsToEntity(tag, characterIds, { tagListSelector: listSelector, tagListOptions: tagListOptions });

    applyCharacterTagsToMessageDivs();

    // need to return false to keep the input clear
    return false;
}

/**
 * Get a list of existing tags matching a list of provided new tag names
 *
 * @param {string[]} newTags - A list of strings representing tag names
 * @returns {Tag[]} List of existing tags
 */
function getExistingTags(newTags) {
    let existingTags = [];
    for (let tagName of newTags) {
        let foundTag = getTag(tagName);
        if (foundTag) {
            existingTags.push(foundTag);
        }
    }
    return existingTags;
}

const IMPORT_EXLCUDED_TAGS = ['ROOT', 'TAVERN'];
const ANTI_TROLL_MAX_TAGS = 50;

/**
 * Imports tags for a given character
 *
 * @param {Character} character - The character
 * @param {object} [options] - Options
 * @param {tag_import_setting} [options.importSetting=null] - Force a tag import setting
 * @param {boolean} [options.suppressSuccessToast=false] - Skip this function's own success toast (used when a
 * caller - e.g. the character-import flow - folds a successful result into a single combined notification
 * instead). The error toast still fires on failure, since that's a real problem the combined notification
 * doesn't otherwise surface.
 * @returns {Promise<boolean>} Boolean indicating whether any tag was imported
 */
async function importTags(character, { importSetting = null, suppressSuccessToast = false } = {}) {
    // Gather the tags to import based on the selected setting
    const tagNamesToImport = await handleTagImport(character, { importSetting });
    if (!tagNamesToImport?.length) {
        console.debug('No tags to import');
        return;
    }

    const tagsToImport = tagNamesToImport.map(tag => getTag(tag, { createNew: true }));
    const added = addTagsToEntity(tagsToImport, character.avatar);
    const tagNames = tagsToImport.map(x => escapeHtml(x.name)).join(', ');

    if (added) {
        if (!suppressSuccessToast) {
            toastr.success(t`Imported tags:` + `<br />${tagNames}`, t`Importing Tags`, { escapeHtml: false });
        }
    } else {
        toastr.error(t`Couldn't import tags:` + `<br />${tagNames}`, t`Importing Tags`, { escapeHtml: false });
    }

    return added;
}

/**
 * Handles the import of tags for a given character and returns the resulting list of tags to add
 *
 * @param {Character} character - The character
 * @param {object} [options] - Options
 * @param {tag_import_setting} [options.importSetting=null] - Force a tag import setting
 * @returns {Promise<string[]>} Array of strings representing the tags to import
 */
async function handleTagImport(character, { importSetting = null } = {}) {
    /** @type {string[]} */
    const alreadyAssignedTags = tag_map[character.avatar] ?? [];
    const importTags = character.tags.map(t => t.trim()).filter(t => t)
        .filter(t => !IMPORT_EXLCUDED_TAGS.includes(t))
        .filter(t => {
            const existingTag = getTag(t);
            return !existingTag || !alreadyAssignedTags.includes(existingTag.id);
        })
        .slice(0, ANTI_TROLL_MAX_TAGS);
    const existingTags = getExistingTags(importTags);
    const newTags = importTags.filter(t => !existingTags.some(existingTag => existingTag.name.toLowerCase() === t.toLowerCase()))
        .map(newTag);
    const folderTags = getOpenBogusFolders();

    // Choose the setting for this dialog. First check override, then saved setting or finally use "ASK".
    const setting = importSetting ? importSetting :
        Object.values(tag_import_setting).find(setting => setting === power_user.tag_import_setting) ?? tag_import_setting.ASK;

    switch (setting) {
        case tag_import_setting.ALL:
            return [...existingTags, ...newTags, ...folderTags].map(t => t.name);
        case tag_import_setting.ONLY_EXISTING:
            return [...existingTags, ...folderTags].map(t => t.name);
        case tag_import_setting.ASK: {
            if (!existingTags.length && !newTags.length && !folderTags.length) {
                return [];
            }
            return await showTagImportPopup(character, existingTags, newTags, folderTags);
        }
        case tag_import_setting.NONE:
            return [];
        default: throw new Error(`Invalid tag import setting: ${setting}`);
    }
}

/**
 * Shows a popup to import tags for a given character and returns the resulting list of tags to add
 *
 * @param {Character} character - The character
 * @param {Tag[]} existingTags - List of existing tags
 * @param {Tag[]} newTags - List of new tags
 * @param {Tag[]} folderTags - List of tags in the current folder
 * @returns {Promise<string[]>} Array of strings representing the tags to import
 */
async function showTagImportPopup(character, existingTags, newTags, folderTags) {
    /** @type {{[key: string]: import('./popup.js').CustomPopupButton}} */
    const importButtons = {
        NONE: { result: 2, text: 'Import None' },
        ALL: { result: 3, text: 'Import All' },
        EXISTING: { result: 4, text: 'Import Existing' },
    };
    const buttonSettingsMap = {
        [POPUP_RESULT.AFFIRMATIVE]: tag_import_setting.ASK,
        [importButtons.NONE.result]: tag_import_setting.NONE,
        [importButtons.ALL.result]: tag_import_setting.ALL,
        [importButtons.EXISTING.result]: tag_import_setting.ONLY_EXISTING,
    };

    const popupContent = $(await renderTemplateAsync('charTagImport', { charName: character.name }));

    // Print tags after popup is shown, so that events can be added
    printTagList(popupContent.find('#import_existing_tags_list'), { tags: existingTags, tagOptions: { removable: true, removeAction: tag => removeFromArray(existingTags, tag) } });
    printTagList(popupContent.find('#import_new_tags_list'), { tags: newTags, tagOptions: { removable: true, removeAction: tag => removeFromArray(newTags, tag) } });
    printTagList(popupContent.find('#import_folder_tags_list'), { tags: folderTags, tagOptions: { removable: true, removeAction: tag => removeFromArray(folderTags, tag) } });

    if (folderTags.length === 0) popupContent.find('#folder_tags_block').hide();

    function onCloseRemember(/** @type {Popup} */ popup) {
        if (popup.result && popup.inputResults.get('import_remember_option')) {
            const setting = buttonSettingsMap[popup.result];
            if (!setting) return;
            power_user.tag_import_setting = setting;
            $('#tag_import_setting').val(power_user.tag_import_setting);
            saveSettingsDebounced('power_user.tag_import_setting');
            console.log('Remembered tag import setting:', Object.entries(tag_import_setting).find(x => x[1] === setting)[0], setting);
        }
    }

    const result = await callGenericPopup(popupContent, POPUP_TYPE.TEXT, null, {
        wider: true, okButton: 'Import', cancelButton: true,
        customButtons: Object.values(importButtons),
        customInputs: [{ id: 'import_remember_option', label: 'Remember my choice', tooltip: 'Remember the chosen import option\nIf anything besides \'Cancel\' is selected, this dialog will not show up anymore.\nTo change this, go to the settings and modify "Tag Import Option".\n\nIf the "Import" option is chosen, the global setting will stay on "Ask".' }],
        onClose: onCloseRemember,
    });
    if (!result) {
        return [];
    }

    switch (result) {
        case POPUP_RESULT.AFFIRMATIVE: // Default 'Import' option where it imports all selected
        case importButtons.ALL.result:
            return [...existingTags, ...newTags, ...folderTags].map(t => t.name);
        case importButtons.EXISTING.result:
            return [...existingTags, ...folderTags].map(t => t.name);
        case importButtons.NONE.result:
        default:
            return [];
    }
}

/**
 * Gets a tag from the tags array based on the provided tag name (insensitive soft matching)
 * Optionally creates the tag if it doesn't exist
 *
 * @param {string} tagName - The name of the tag to search for
 * @param {object} [options={}] - Optional parameters
 * @param {boolean} [options.createNew=false] - Whether to create the tag if it doesn't exist
 * @returns {Tag?} The tag object that matches the provided tag name, or undefined if no match is found
 */
function getTag(tagName, { createNew = false } = {}) {
    let tag = tags.find(t => equalsIgnoreCaseAndAccents(t.name, tagName));
    if (!tag && createNew) {
        tag = createNewTag(tagName);
    }
    return tag;
}

/**
 * Creates a new tag with default properties and a randomly generated id
 *
 * Does **not** trigger a save, so it's up to the caller to do that
 *
 * @param {string} tagName - name of the tag
 * @returns {Tag} the newly created tag, or the existing tag if it already exists (with a logged warning)
 */
function createNewTag(tagName) {
    const existing = getTag(tagName);
    if (existing) {
        toastr.warning(`Cannot create new tag. A tag with the name already exists:<br />${escapeHtml(existing.name)}`, 'Creating Tag', { escapeHtml: false });
        return existing;
    }

    const tag = newTag(tagName);
    // Fuse-index invalidation is handled by the tagsStore.onChange subscriber (rebuildTagStores()).
    tagsStore.create(tag);
    console.debug('Created new tag', tag.name, 'with id', tag.id);
    return tag;
}

/**
 * Creates a new tag object with the given tag name and default properties
 *
 * Not to be confused with `createNewTag`, which actually creates the tag and adds it to the existing list of tags.
 * Use this one to create temporary tag objects, for example for drawing.
 *
 * @param {string} tagName - The name of the tag
 * @return {Tag} The newly created tag object
 */
function newTag(tagName) {
    return {
        id: uuidv4(),
        name: tagName,
        folder_type: TAG_FOLDER_DEFAULT_TYPE,
        filter_state: DEFAULT_FILTER_STATE,
        sort_order: Math.max(0, ...tags.map(t => t.sort_order)) + 1,
        is_hidden_on_character_card: false,
        color: '',
        color2: '',
        create_date: Date.now(),
    };
}

/**
 * @typedef {object} TagOptions - Options for tag behavior. (Same object will be passed into "appendTagToList")
 * @property {boolean} [removable=false] - Whether tags can be removed.
 * @property {boolean} [isFilter=false] - Whether tags can be selected as a filter.
 * @property {function} [action=undefined] - Action to perform on tag interaction.
 * @property {(tag: Tag)=>boolean} [removeAction=undefined] - Action to perform on tag removal instead of the default remove action. If the action returns false, the tag will not be removed.
 * @property {boolean} [isGeneralList=false] - If true, indicates that this is the general list of tags.
 * @property {boolean} [skipExistsCheck=false] - If true, the tag gets added even if a tag with the same id already exists.
 * @property {boolean} [isCharacterList=false] - If true, indicates that this is the character's list of tags.
 * @property {boolean} [isInactive=false] - If true, indicates that the tag is inactive (for styling purposes).
 */

/**
 * @typedef {object} PrintTagListOptions - Optional parameters for printing the tag list.
 * @property {Tag[]|function(): Tag[]} [tags=undefined] - Optional override of tags that should be printed. Those will not be sorted. If no supplied, tags for the relevant character are printed. Can also be a function that returns the tags.
 * @property {Tag|Tag[]} [addTag=undefined] - Optionally provide one or multiple tags that should be manually added to this print. Either to the overridden tag list or the found tags based on the entity/key. Will respect the tag exists check.
 * @property {object|number|string} [forEntityOrKey=undefined] - Optional override for the chosen entity, otherwise the currently selected is chosen. Can be an entity with id property (character, group, tag), or directly an id or tag key.
 * @property {boolean|string} [empty=true] - Whether the list should be initially empty. If a string string is provided, 'always' will always empty the list, otherwise it'll evaluate to a boolean.
 * @property {boolean} [sort=true] - Whether the tags should be sorted via the sort function, or kept as is.
 * @property {function(object): function} [tagActionSelector=undefined] - An optional override for the action property that can be assigned to each tag via tagOptions.
 * If set, the selector is executed on each tag as input argument. This allows a list of tags to be provided and each tag can have it's action based on the tag object itself.
 * @property {TagOptions} [tagOptions={}] - Options for tag behavior. (Same object will be passed into "appendTagToList")
 * @property {string[]} [inactiveTags=[]] - List of tag IDs that are considered inactive (for styling purposes).
 */

/**
 * Prints the list of tags
 *
 * @param {JQuery<HTMLElement>|string} element - The container element where the tags are to be printed. (Optionally can also be a string selector for the element, which will then be resolved)
 * @param {PrintTagListOptions} [options] - Optional parameters for printing the tag list.
 */
function printTagList(element, { tags = undefined, addTag = undefined, forEntityOrKey = undefined, empty = true, sort = true, tagActionSelector = undefined, tagOptions = {}, inactiveTags = [] } = {}) {
    const $element = (typeof element === 'string') ? $(element) : element;
    const key = forEntityOrKey !== undefined ? getTagKeyForEntity(forEntityOrKey) : getTagKey();
    let printableTags = tags ? (typeof tags === 'function' ? tags() : tags) : getTagsList(key, sort);

    if (tagOptions.isCharacterList) {
        printableTags = printableTags.filter(tag => !tag.is_hidden_on_character_card);
    }

    if (empty === 'always' || (empty && (printableTags?.length > 0 || key))) {
        $element.empty();
    }

    if (addTag) {
        const addTags = Array.isArray(addTag) ? addTag : [addTag];
        printableTags = printableTags.concat(addTags.filter(tag => tagOptions.skipExistsCheck || !printableTags.some(t => t.id === tag.id)));
    }

    // one last sort, because we might have modified the tag list or manually retrieved it from a function
    if (sort) printableTags = printableTags.sort(compareTagsForSort);

    const customAction = typeof tagActionSelector === 'function' ? tagActionSelector : null;

    // Well, lets check if the tag list was expanded. Based on either a css class, or when any expand was clicked yet, then we search whether this element id matches
    const expanded = $element.hasClass('tags-expanded') || (expanded_tags_cache.length && expanded_tags_cache.indexOf(key ?? getTagKeyForEntityElement(element)) >= 0);

    // We prepare some stuff. No matter which list we have, there is a maximum value of tags we are going to display
    // Constants to define tag printing limits
    const DEFAULT_TAGS_LIMIT = 50;
    const tagsDisplayLimit = expanded ? Number.MAX_SAFE_INTEGER : DEFAULT_TAGS_LIMIT;

    // Functions to determine tag properties
    const isFilterActive = (/** @type {Tag} */ tag) => tag.filter_state && !isFilterState(tag.filter_state, FILTER_STATES.UNDEFINED);
    const shouldPrintTag = (/** @type {Tag} */ tag) => isBogusFolder(tag) || isFilterActive(tag);

    // Calculating the number of tags to print
    const mandatoryPrintTagsCount = printableTags.filter(shouldPrintTag).length;
    const availableSlotsForAdditionalTags = Math.max(tagsDisplayLimit - mandatoryPrintTagsCount, 0);

    // Counters for printed and hidden tags
    let additionalTagsPrinted = 0;
    let tagsSkipped = 0;

    for (const tag of printableTags) {
        // If we have a custom action selector, we override that tag options for each tag
        if (customAction) {
            const action = customAction(tag);
            if (action && typeof action !== 'function') {
                console.error('The action parameter must return a function for tag.', tag);
            } else {
                tagOptions.action = action;
            }
        }

        // Check if we should print this tag
        if (shouldPrintTag(tag) || additionalTagsPrinted++ < availableSlotsForAdditionalTags) {
            // Check if this tag is in the inactive list
            const isInactive = inactiveTags.includes(tag.id);
            appendTagToList($element, tag, { ...tagOptions, isInactive });
        } else {
            tagsSkipped++;
        }
    }

    // After the loop, check if we need to add the placeholder.
    // The placehold if clicked expands the tags and remembers either via class or cache array which was expanded, so it'll stay expanded until the next reload.
    if (tagsSkipped > 0) {
        const id = 'placeholder_' + uuidv4();

        // Add click event
        const showHiddenTags = (_, event) => {
            const elementKey = key ?? getTagKeyForEntityElement($element);
            console.log(`Hidden tags shown for element ${elementKey}`);

            // Mark the current char/group as expanded if we were in any. This will be kept in memory until reload
            $element.addClass('tags-expanded');
            expanded_tags_cache.push(elementKey);

            // Do not bubble further, we are just expanding
            event.stopPropagation();
            printTagList($element, { tags: tags, addTag: addTag, forEntityOrKey: forEntityOrKey, empty: empty, tagActionSelector: tagActionSelector, tagOptions: tagOptions, inactiveTags: inactiveTags });
        };

        // Print the placeholder object with its styling and action to show the remaining tags
        /** @type {Tag} */
        const placeholderTag = { id: id, name: '...', title: `${tagsSkipped} tags not displayed.\n\nClick to expand remaining tags.`, color: 'transparent', action: showHiddenTags, class: 'placeholder-expander' };
        // It should never be marked as a removable tag, because it's just an expander action
        /** @type {TagOptions} */
        const placeholderTagOptions = { ...tagOptions, removable: false };
        appendTagToList($element, placeholderTag, placeholderTagOptions);
    }
}

/**
 * Appends a tag to the list element
 *
 * @param {JQuery<HTMLElement>} listElement - List element
 * @param {Tag} tag - Tag object to append
 * @param {TagOptions} [options={}] - Options for tag behavior
 * @returns {void}
 */
function appendTagToList(listElement, tag, { removable = false, isFilter = false, action = undefined, removeAction = undefined, isGeneralList = false, skipExistsCheck = false, isInactive = false } = {}) {
    if (!listElement) {
        return;
    }
    if (!skipExistsCheck && $(listElement).find(`.tag[id="${tag.id}"]`).length > 0) {
        return;
    }

    let tagElement = TAG_TEMPLATE.clone();
    tagElement.attr('id', tag.id);

    //tagElement.css('color', 'var(--SmartThemeBodyColor)');
    tagElement.css('background-color', tag.color);
    tagElement.css('color', tag.color2);

    tagElement.find('.tag_name').text(tag.name);
    const removeButton = tagElement.find('.tag_remove');
    removable ? removeButton.show() : removeButton.hide();
    if (removable && removeAction) {
        tagElement.attr('custom-remove-action', String(true));
        removeButton.on('click', () => {
            const result = removeAction(tag);
            if (result !== false) tagElement.remove();
        });
    }

    if (tag.class) {
        tagElement.addClass(tag.class);
    }
    if (tag.title) {
        tagElement.attr('title', tag.title);
    }
    if (tag.icon) {
        tagElement.find('.tag_name').text('').attr('title', `${translate(tag.name)} ${tag.title || ''}`.trim()).addClass(tag.icon);
        tagElement.addClass('actionable');
    }
    if (isInactive) {
        tagElement.addClass('tag-absent');
    }

    // We could have multiple ways of actions passed in. The manual arguments have precendence in front of a specified tag action
    const clickableAction = action ?? tag.action;

    // If this is a tag for a general list and its either a filter or actionable, lets mark its current state
    if ((isFilter || clickableAction) && isGeneralList) {
        const filterHelper = getFilterHelper($(listElement));
        const isFilterActionable = clickableAction && 'filter_state' in tag;

        if (isFilter || isFilterActionable) {
            const filterState = determineTagFilterState(filterHelper, tag, isFilterActionable);
            toggleTagThreeState(tagElement, { stateOverride: filterState });
        }
    }

    if (isFilter) {
        tagElement.on('click', () => onTagFilterClick.bind(tagElement)(listElement));
        tagElement.addClass(INTERACTABLE_CONTROL_CLASS);
    }

    if (clickableAction) {
        const filter = getFilterHelper($(listElement));
        tagElement.on('click', (e) => clickableAction.bind(tagElement)(filter, e));
        tagElement.addClass('clickable-action').addClass(INTERACTABLE_CONTROL_CLASS);
    }

    $(listElement).append(tagElement);
}

function onTagFilterClick(listElement) {
    const tagId = $(this).attr('id');
    const existingTag = tagsStore.get(tagId);
    const parent = $(this).parents('.tags');

    let state = toggleTagThreeState($(this));

    const filterHelper = getFilterHelper($(listElement));

    // Update the tag's filter_state for the main character list (backward compatibility).
    // Deliberately NOT calling saveSettingsDebounced() here: the actual (accountStorage-backed) persistence for
    // this is done a few lines below, and settings.json on this install is 11MB+ (tags + tag_map), so forcing a
    // full settings resave on every single tag filter click was the actual freeze - not just tag_map/tags being
    // large in memory, but re-serializing and re-uploading the whole blob per click. This field will still get
    // flushed to disk the next time something else triggers a real settings save.
    if (existingTag && isMainCharacterList(filterHelper)) {
        existingTag.filter_state = state;
    }

    // Persist to storage for all contexts
    const storagePrefix = getFilterStorageKey(filterHelper);
    if (storagePrefix && existingTag) {
        const storageKey = `${storagePrefix}_tag_${tagId}`;
        accountStorage.setItem(storageKey, state);
    }

    // Apply all tag filters by reading from DOM state (this triggers the filter helper update)
    runTagFilters(listElement);

    // Focus the tag again we were at, if possible. To improve keyboard navigation
    setTimeout(() => parent.find(`.tag[id="${tagId}"]`).trigger('focus'), DEFAULT_PRINT_TIMEOUT + 1);

    updateTagFilterIndicator(listElement);
}

/**
 * Loads persisted filter states for a given filter context.
 * @param {FilterHelper} filterHelper - The filter helper instance
 * @param {string} storagePrefix - The storage key prefix for this context
 */
function loadFilterStatesForContext(filterHelper, storagePrefix) {
    const validStates = new Set(Object.keys(FILTER_STATES));
    const readState = (/** @type {string} */ storageKey) => {
        const v = accountStorage.getItem(storageKey);
        return v && validStates.has(v) ? v : null;
    };

    // Load actionable tag states (Favorites, Groups, Folders)
    const favState = readState(`${storagePrefix}_${ACTIONABLE_FILTER_STORAGE_KEYS.FAV}`);
    if (favState) {
        filterHelper.setFilterData(FILTER_TYPES.FAV, favState, true);
    }

    const groupState = readState(`${storagePrefix}_${ACTIONABLE_FILTER_STORAGE_KEYS.GROUP}`);
    if (groupState) {
        filterHelper.setFilterData(FILTER_TYPES.GROUP, groupState, true);
    }

    const folderState = readState(`${storagePrefix}_${ACTIONABLE_FILTER_STORAGE_KEYS.FOLDER}`);
    if (folderState) {
        filterHelper.setFilterData(FILTER_TYPES.FOLDER, folderState, true);
    }

    // Load regular tag filter states
    const tagFilterData = filterHelper.getFilterData(FILTER_TYPES.TAG);
    for (const tag of tags) {
        const storageKey = `${storagePrefix}_tag_${tag.id}`;
        const state = readState(storageKey);

        if (state) {
            if (state === 'SELECTED') {
                if (!tagFilterData.selected.includes(tag.id)) {
                    tagFilterData.selected.push(tag.id);
                }
            } else if (state === 'EXCLUDED') {
                if (!tagFilterData.excluded.includes(tag.id)) {
                    tagFilterData.excluded.push(tag.id);
                }
            }
        }
    }
    filterHelper.setFilterData(FILTER_TYPES.TAG, tagFilterData, true);
}

/**
 * Toggle the filter state of a given tag element
 *
 * @param {JQuery<HTMLElement>} element - The jquery element representing the tag for which the state should be toggled
 * @param {object} param1 - Optional parameters
 * @param {import('./filters.js').FilterState|string} [param1.stateOverride] - Optional state override to which the state should be toggled to. If not set, the state will move to the next one in the chain.
 * @param {boolean} [param1.simulateClick] - Optionally specify that the state should not just be set on the html element, but actually achieved via triggering the "click" on it, which follows up with the general click handlers and reprinting
 * @returns {string} The string representing the new state
 */
function toggleTagThreeState(element, { stateOverride = undefined, simulateClick = false } = {}) {
    const states = Object.keys(FILTER_STATES);

    // Make it clear we're getting indexes and handling the 'not found' case in one place
    function getStateIndex(key, fallback) {
        const index = states.indexOf(key);
        return index !== -1 ? index : states.indexOf(fallback);
    }

    const overrideKey = typeof stateOverride == 'string' && states.includes(stateOverride) ? stateOverride : Object.keys(FILTER_STATES).find(key => FILTER_STATES[key] === stateOverride);

    const currentStateIndex = getStateIndex(element.attr('data-toggle-state'), DEFAULT_FILTER_STATE);
    const targetStateIndex = overrideKey !== undefined ? getStateIndex(overrideKey, DEFAULT_FILTER_STATE) : (currentStateIndex + 1) % states.length;

    if (simulateClick) {
        // Calculate how many clicks are needed to go from the current state to the target state
        let clickCount = 0;
        if (targetStateIndex >= currentStateIndex) {
            clickCount = targetStateIndex - currentStateIndex;
        } else {
            clickCount = (states.length - currentStateIndex) + targetStateIndex;
        }

        for (let i = 0; i < clickCount; i++) {
            $(element).trigger('click');
        }

        console.debug('manually click-toggle three-way filter from', states[currentStateIndex], 'to', states[targetStateIndex], 'on', element);
    } else {
        element.attr('data-toggle-state', states[targetStateIndex]);

        // Update css class and remove all others
        states.forEach(state => {
            element.toggleClass(FILTER_STATES[state].class, state === states[targetStateIndex]);
        });

        if (states[currentStateIndex] !== states[targetStateIndex]) {
            console.debug('toggle three-way filter from', states[currentStateIndex], 'to', states[targetStateIndex], 'on', element);
        }
    }


    return states[targetStateIndex];
}

function runTagFilters(listElement) {
    const tagIds = [...($(listElement).find('.tag.selected:not(.actionable)').map((_, el) => $(el).attr('id')))];
    const excludedTagIds = [...($(listElement).find('.tag.excluded:not(.actionable)').map((_, el) => $(el).attr('id')))];
    const filterHelper = getFilterHelper($(listElement));
    filterHelper.setFilterData(FILTER_TYPES.TAG, { excluded: excludedTagIds, selected: tagIds });
}

/**
 * Cache of the last-rendered tag-pill set per filter type, so printTagFilters() can skip rebuilding the
 * (potentially thousands of, on this install - almost every one of ~9700 tags is assigned to something)
 * tag filter pills via jQuery clone/append when the set of tags to display hasn't actually changed since the
 * last render, and *patch just the delta* (add/remove/re-mark-inactive individual pills) when it has changed
 * by a small amount - e.g. a single tag flipping from unused to used or vice versa. printTagFilters() runs on
 * *every* printCharacters() call - every search-bar keystroke, every tag filter chip click, every page nav - so
 * without this, that whole pill list gets torn down and rebuilt from scratch every single time.
 * @type {Map<string, { ids: Set<string>, inactiveIds: Set<string> }>}
 */
const tagFilterRenderCache = new Map();

/**
 * Above this many changed pills (added + removed + re-marked-inactive), just do the normal full rebuild instead
 * of diff-patching - finding each new pill's sorted insertion point is a small linear scan per pill, fine for a
 * handful of tags but not worth it (and not necessary - see below) for a big batch of changes.
 */
const TAG_FILTER_DIFF_PATCH_MAX_DELTA = 25;

function printTagFilters(type = tag_filter_type.character) {
    removeMissingTagFilters();

    let FILTER_SELECTOR;
    switch (type) {
        case tag_filter_type.character:
            FILTER_SELECTOR = CHARACTER_FILTER_SELECTOR;
            break;
        case tag_filter_type.group_candidates_list:
            FILTER_SELECTOR = GROUP_FILTER_SELECTOR;
            break;
        case tag_filter_type.group_members_list:
            FILTER_SELECTOR = GROUP_MEMBERS_FILTER_SELECTOR;
            break;
        default:
            FILTER_SELECTOR = CHARACTER_FILTER_SELECTOR;
            break;
    }

    // Determine which character tags to display based on context. Done *before* touching the DOM, so we can bail
    // out below without having already torn down the existing pills.
    let tagsToDisplay;
    let inactiveTags = [];

    if (isGroupContext(type)) {
        // For group contexts, show all tags but mark ones without presence in current context as inactive
        // CAUTION: when called by openGroupById, the selected_group variable might not yet be updated
        const currentGroup = selected_group ? groupsStore.get(selected_group) : null;
        const visibleAvatars = getVisibleAvatarsForGroupContext(type, currentGroup);

        if (visibleAvatars.length > 0) {
            // Get tags that are assigned to at least one visible character
            const activeCharacterTagIds = visibleAvatars
                .map(avatar => tag_map[avatar] || [])
                .flat()
                .filter(onlyUnique);

            // Show all tags that exist in the tag_map
            const allCharacterTagIds = getAssignedTagIds();
            const activeCharacterTagIdSet = new Set(activeCharacterTagIds);
            tagsToDisplay = tags.filter(x => allCharacterTagIds.has(x.id)).sort(compareTagsForSort);

            // Mark tags that are not in the active set as inactive
            inactiveTags = tagsToDisplay
                .filter(x => !activeCharacterTagIdSet.has(x.id))
                .map(x => x.id);
        } else {
            // No group selected, show no tags
            tagsToDisplay = [];
        }
    } else {
        // For main character list, show all tags as before
        const characterTagIds = getAssignedTagIds();
        tagsToDisplay = tags.filter(x => characterTagIds.has(x.id)).sort(compareTagsForSort);
    }

    // Print all action tags. (Rework 'Folder' button to some kind of onboarding if no folders are enabled yet)
    let actionTags = Object.values(ACTIONABLE_TAGS);
    actionTags.find(x => x == ACTIONABLE_TAGS.FOLDER).name = power_user.bogus_folders ? 'Show only folders' : 'Enable \'Tags as Folder\'\n\nAllows characters to be grouped in folders by their assigned tags.\nTags have to be explicitly chosen as folder to show up.\n\nClick here to start';

    // For group contexts, filter actionable tags to only show relevant ones
    if (isGroupContext(type)) {
        actionTags = filterActionableTagsForGroupContext(actionTags);
    }

    const inListActionTags = Object.values(InListActionable);

    // Remove just the action/inList-action pills from any previous render (by their known, fixed ids) instead
    // of the old unconditional $(FILTER_SELECTOR).empty() - that would also wipe out the (potentially huge) real
    // tag pill list below, which is exactly the rebuild we're trying to avoid doing on every render.
    const actionAndInListTags = [...actionTags, ...inListActionTags];
    for (const tag of actionAndInListTags) {
        $(FILTER_SELECTOR).find(`.tag[id="${tag.id}"]`).remove();
    }

    // Build them directly into the real (attached) container - appendTagToList/getFilterHelper resolve the
    // correct FilterHelper (group members/candidates vs main list) by walking up from the element at build time,
    // which only works if it's actually attached under its real ancestor when built, not a detached scratch div.
    printTagList($(FILTER_SELECTOR), { empty: false, sort: false, tags: actionTags, tagActionSelector: tag => tag.action, tagOptions: { isGeneralList: true } });
    printTagList($(FILTER_SELECTOR), { empty: false, sort: false, tags: inListActionTags, tagActionSelector: tag => tag.action, tagOptions: { isGeneralList: true } });

    // They just got appended at the end (after whatever real tag pills are still there) - move them back to the
    // front as a block, preserving their relative order, same position as the old always-rebuilt version had.
    for (const tag of [...actionAndInListTags].reverse()) {
        $(FILTER_SELECTOR).find(`.tag[id="${tag.id}"]`).prependTo($(FILTER_SELECTOR));
    }

    printBigTagFilterList(type, FILTER_SELECTOR, tagsToDisplay, inactiveTags);

    // Print bogus folder navigation
    const bogusDrilldown = $(FILTER_SELECTOR).siblings('.rm_tag_bogus_drilldown');
    bogusDrilldown.empty();
    if (power_user.bogus_folders && bogusDrilldown.length > 0) {
        const navigatedTags = getOpenBogusFolders();
        printTagList(bogusDrilldown, { tags: navigatedTags, tagOptions: { removable: true } });
    }

    // Don't call runTagFilters here - it would overwrite the loaded filter states with the DOM state.
    // The visual state (CSS classes) already matches the filter helper state set by loadFilterStatesForContext.
    // runTagFilters is only needed when user clicks a tag (handled in onTagFilterClick).

    updateTagFilterVisibility(type, FILTER_SELECTOR);
}

/**
 * Prints (or incrementally patches) the "big" block of real tag filter pills within a tag filter bar - the part
 * that's expensive at this install's scale (up to ~9700 pills once the "show more" cap has been expanded).
 *
 * Three cases:
 * 1. Nothing changed since last render for this filter type -> no DOM work at all.
 * 2. Something changed, but the container isn't currently expanded past the default 50-tag cap -> that cap means
 *    there's at most ~50-60 pills to draw anyway, so just let printTagList() do its normal full (cheap at that
 *    size) rebuild, including its own cap/placeholder/mandatory-tag logic.
 * 3. Something changed, the container *is* expanded (so printTagList would otherwise redraw everything, cap
 *    logic doesn't apply since it's disabled while expanded), and the change is small -> diff-patch just the
 *    pills that actually differ (add/remove/re-mark-inactive), preserving sort order via insertion, instead of
 *    tearing down and rebuilding the whole thing.
 * Falls back to the normal full rebuild for any case not covered above (first render, big batches of changes,
 * anything under bogus_folders since tag-as-folder pills interact with the drilldown in ways not modeled here).
 *
 * @param {tag_filter_type} type
 * @param {string} FILTER_SELECTOR
 * @param {Tag[]} tagsToDisplay - already sorted via compareTagsForSort
 * @param {string[]} inactiveTags - ids of tags in tagsToDisplay that should be marked inactive
 */
function printBigTagFilterList(type, FILTER_SELECTOR, tagsToDisplay, inactiveTags) {
    const newIds = new Set(tagsToDisplay.map(t => t.id));
    const newInactiveIds = new Set(inactiveTags);
    const cached = tagFilterRenderCache.get(type);

    const fullRebuild = () => {
        // There's no top-level $(FILTER_SELECTOR).empty() anymore (that would nuke the action tag pills too, see
        // printTagFilters above), so any pills from a previous render need to be explicitly cleared here first -
        // printTagList({empty: false, ...}) only appends, it never removes stale ones that dropped out of
        // tagsToDisplay.
        if (cached) {
            for (const id of cached.ids) {
                $(FILTER_SELECTOR).find(`.tag[id="${id}"]`).remove();
            }
        }
        printTagList($(FILTER_SELECTOR), { empty: false, tags: tagsToDisplay, tagOptions: { isFilter: true, isGeneralList: true }, inactiveTags: inactiveTags });
        tagFilterRenderCache.set(type, { ids: newIds, inactiveIds: newInactiveIds });
    };

    // Case 1: nothing changed. Bogus folders aren't covered by this cache (tag-as-folder pills can need
    // re-rendering for reasons other than membership/inactive changes), so always fall through there.
    if (cached && !power_user.bogus_folders) {
        let sameInactive = cached.inactiveIds.size === newInactiveIds.size;
        if (sameInactive) for (const id of newInactiveIds) if (!cached.inactiveIds.has(id)) { sameInactive = false; break; }
        let sameIds = sameInactive && cached.ids.size === newIds.size;
        if (sameIds) for (const id of newIds) if (!cached.ids.has(id)) { sameIds = false; break; }

        if (sameIds && sameInactive) {
            return;
        }
    }

    const $container = $(FILTER_SELECTOR);
    const isExpanded = $container.hasClass('tags-expanded');

    // Case 2: capped, cheap regardless - let printTagList do its normal thing (also handles the mandatory-tag/
    // placeholder bookkeeping we don't want to reimplement here).
    if (!isExpanded || power_user.bogus_folders || !cached) {
        fullRebuild();
        return;
    }

    const toRemove = [...cached.ids].filter(id => !newIds.has(id));
    const toAdd = tagsToDisplay.filter(t => !cached.ids.has(t.id));
    const toToggleInactive = tagsToDisplay.filter(t => cached.ids.has(t.id) && cached.inactiveIds.has(t.id) !== newInactiveIds.has(t.id));

    // Case 3 only for small deltas - see TAG_FILTER_DIFF_PATCH_MAX_DELTA doc.
    if (toRemove.length + toAdd.length + toToggleInactive.length > TAG_FILTER_DIFF_PATCH_MAX_DELTA) {
        fullRebuild();
        return;
    }

    for (const id of toRemove) {
        $container.find(`.tag[id="${id}"]`).remove();
    }

    for (const tag of toAdd) {
        appendTagToList($container, tag, { isFilter: true, isGeneralList: true, isInactive: newInactiveIds.has(tag.id), skipExistsCheck: true });
        // appendTagToList always appends at the end - move it to its correct sorted position by finding the
        // next tag (in sort order) that's already present as a pill, and inserting just before that one.
        const sortedIndex = tagsToDisplay.indexOf(tag);
        for (let i = sortedIndex + 1; i < tagsToDisplay.length; i++) {
            const $next = $container.find(`.tag[id="${tagsToDisplay[i].id}"]`);
            if ($next.length) {
                $container.find(`.tag[id="${tag.id}"]`).insertBefore($next);
                break;
            }
        }
    }

    for (const tag of toToggleInactive) {
        $container.find(`.tag[id="${tag.id}"]`).toggleClass('tag-absent', newInactiveIds.has(tag.id));
    }

    tagFilterRenderCache.set(type, { ids: newIds, inactiveIds: newInactiveIds });
}

/**
 * Applies the saved tag-list-visibility setting for a filter context to its DOM (the "show tag list" toggle),
 * and refreshes the filter indicator. Split out from printTagFilters() so the tagFilterRenderCache early-return
 * can still keep this bit up to date without needing to rebuild any tag pills.
 * @param {tag_filter_type} type - The filter type
 * @param {string} FILTER_SELECTOR - The resolved selector for this filter type's tag list container
 */
function updateTagFilterVisibility(type, FILTER_SELECTOR) {
    const shouldShowTags = getTagFilterVisibility(type);
    const showTagListButton = $(FILTER_SELECTOR).closest('.rm_tag_controls').find('.showTagList');

    // Update button state to match the saved setting
    showTagListButton.toggleClass('selected', shouldShowTags);

    if (shouldShowTags) {
        $(FILTER_SELECTOR).find('.tag:not(.actionable)').show();
    } else {
        $(FILTER_SELECTOR).find('.tag:not(.actionable)').hide();
    }

    updateTagFilterIndicator(FILTER_SELECTOR);
}

/**
 * Updates the tag filter indicator based on the selected/excluded tags in the given filter selector
 * @param {string|JQuery<HTMLElement>} filterSelector - The selector or jQuery element for the tag filter container
 */
function updateTagFilterIndicator(filterSelector) {
    const selector = filterSelector || CHARACTER_FILTER_SELECTOR;
    const tagFilter = typeof selector === 'string' ? $(selector) : selector;
    const showTagListButton = tagFilter.closest('.rm_tag_controls').find('.showTagList');
    const hasActiveTags = tagFilter.find('.tag:not(.actionable)').is('.selected, .excluded');
    showTagListButton.toggleClass('indicator', hasActiveTags);
}

function onTagRemoveClick(event) {
    event.stopPropagation();
    const tagElement = $(this).closest('.tag');
    const tagId = tagElement.attr('id');

    // If we have a custom remove action, we are not executing anything here in the default handler
    if (tagElement.attr('custom-remove-action')) {
        console.debug('Custom remove action', tagId);
        return;
    }

    // Check if we are inside the drilldown. If so, we call remove on the bogus folder
    if ($(this).closest('.rm_tag_bogus_drilldown').length > 0) {
        console.debug('Bogus drilldown remove', tagId);
        chooseBogusFolder($(this), tagId, true);
        return;
    }

    const tag = tagsStore.get(tagId);

    // Optional, check for multiple character ids being present.
    const characterData = event.target.closest('#bulk_tags_div')?.dataset.characters;
    const characterIds = characterData ? JSON.parse(characterData).characterIds : null;

    removeTagFromEntity(tag, characterIds, { tagElement: tagElement });

    applyCharacterTagsToMessageDivs();
}

// @ts-ignore
function onTagInput(event) {
    let val = $(this).val();
    if (getTag(String(val))) return;
    // @ts-ignore
    $(this).autocomplete('search', val);
}

function onTagInputFocus() {
    // @ts-ignore
    $(this).autocomplete('search', $(this).val());
}

function onCharacterCreateClick() {
    $('#tagList').empty();
}

function onGroupCreateClick() {
    $('#groupTagList').empty();
}

export function applyTagsOnCharacterSelect(chid = null) {
    // If we are in create window, we cannot simply redraw, as there are no real persisted tags. Grab them, and pass them in
    if (menu_type === 'create') {
        const currentTagIds = $('#tagList').find('.tag').map((_, el) => $(el).attr('id')).get();
        const currentTags = tags.filter(x => currentTagIds.includes(x.id));
        printTagList($('#tagList'), { forEntityOrKey: undefined, tags: currentTags, tagOptions: { removable: true } });
        return;
    }

    chid = chid ?? getCurrentCharacter()?.avatar;
    printTagList($('#tagList'), { forEntityOrKey: chid, tagOptions: { removable: true } });
}

export function applyTagsOnGroupSelect(groupId = null) {
    // If we are in create window, we explicitly have to tell the system to print for the new group, not the one selected in the background
    if (menu_type === 'group_create') {
        const currentTagIds = $('#groupTagList').find('.tag').map((_, el) => $(el).attr('id')).get();
        const currentTags = tags.filter(x => currentTagIds.includes(x.id));
        printTagList($('#groupTagList'), { forEntityOrKey: undefined, tags: currentTags, tagOptions: { removable: true } });
        return;
    }

    groupId = groupId ?? (selected_group ? Number(selected_group) : undefined);
    printTagList($('#groupTagList'), { forEntityOrKey: groupId, tagOptions: { removable: true } });
    printTagFilters(tag_filter_type.group_candidates_list);
    printTagFilters(tag_filter_type.group_members_list);
}

/**
 * Create a tag input by enabling the autocomplete feature of a given input element. Tags will be added to the given list.
 *
 * @param {string} inputSelector - the selector for the tag input control
 * @param {string} listSelector - the selector for the list of the tags modified by the input control
 * @param {PrintTagListOptions} [tagListOptions] - Optional parameters for printing the tag list. Can be set to be consistent with the expected behavior of tags in the list that was defined before.
 */
export function createTagInput(inputSelector, listSelector, tagListOptions = {}) {
    $(inputSelector)
        // @ts-ignore
        .autocomplete({
            source: (i, o) => findTag(i, o, listSelector),
            select: (e, u) => selectTag(e, u, listSelector, { tagListOptions: tagListOptions }),
            minLength: 0,
        })
        .on('focus', onTagInputFocus); // <== show tag list on click
}

async function onViewTagsListClick() {
    const html = $(document.createElement('div'));
    html.attr('id', 'tag_view_list');
    html.append(await renderTemplateAsync('tagManagement', { bogus_folders: power_user.bogus_folders }));

    const tagContainer = $('<div class="tag_view_list_tags ui-sortable"></div>');
    html.append(tagContainer);

    const $sortModeSelect = html.find('#tag_sort_mode_select');
    $sortModeSelect.val(power_user.tag_sort_mode);
    $sortModeSelect.on('change', function () {
        const newMode = $(this).val().toString();
        power_user.tag_sort_mode = newMode;
        saveSettingsDebounced('power_user.tag_sort_mode');
        printViewTagList(tagContainer);
    });

    printViewTagList(tagContainer);
    makeTagListDraggable(tagContainer);

    await callGenericPopup(html, POPUP_TYPE.TEXT, null, { allowVerticalScrolling: true, wide: true, large: true });
}

function makeTagListDraggable(tagContainer) {
    const onTagsSort = () => {
        // Still a direct field mutation per tag, not a tagsStore.update() per tag - this can touch every tag in
        // the list (drag-reordering with ~9700 tags), and firing one store change event per tag here would be
        // wasteful, and doesn't affect tagsStore's id index since neither ids nor array positions change, just
        // the sort_order field value on each existing tag object. What was missing (the "later chunk" this
        // comment used to point at) was any event firing at all - now emits a single tagsStore.reset() after
        // the loop, so the existing tagsStore.onChange subscribers (fuse-index invalidation, saveTagsDebounced)
        // fire exactly once for the whole drag instead of not knowing sort_order changed.
        tagContainer.find('.tag_view_item').each(function (i, tagElement) {
            const id = $(tagElement).attr('id');
            const tag = tagsStore.get(id);

            // Update the sort order
            tag.sort_order = i;
        });
        tagsStore.reset();

        // If tags were dragged manually, we have to disable auto sorting
        if (power_user.tag_sort_mode !== tag_sort_mode.MANUAL) {
            power_user.tag_sort_mode = tag_sort_mode.MANUAL;
            $('#tag_sort_mode_select').val(tag_sort_mode.MANUAL);
            toastr.info('Switched to Manual sorting mode.');
        }

        // If the order of tags in display has changed, we need to redraw some UI elements. Do it debounced so it doesn't block and you can drag multiple tags.
        printCharactersDebounced();
        saveSettingsDebounced('power_user.tag_sort_mode');
    };

    // @ts-ignore
    $(tagContainer).sortable({
        delay: getSortableDelay(),
        stop: () => onTagsSort(),
        handle: '.drag-handle',
    });
}

/**
 * Sorts the given tags, returning a shallow copy of it
 *
 * @param {Tag[]} tags - The tags
 * @param {Map<string, number>} [counts=null] - Optional map of tag ID to usage count
 * @returns {Tag[]} The sorted tags
 */
function sortTags(tags, counts = null) {
    return tags.slice().sort((a, b) => compareTagsForSort(a, b, counts));
}

/**
 * Compares two given tags and returns the compare result
 *
 * @param {Tag} a - First tag
 * @param {Tag} b - Second tag
 * @param {Map<string, number>} [counts=null] - Optional map of tag ID to usage count
 * @returns {number} The compare result
 */
function compareTagsForSort(a, b, counts = null) {
    // default sort: alphabetical, case insensitive
    const defaultSort = a.name.toLowerCase().localeCompare(b.name.toLowerCase());

    // sort on number of entries
    if (power_user.tag_sort_mode === tag_sort_mode.BY_ENTRIES) {
        const aCount = counts instanceof Map ? (counts.get(a.id) || 0) : 0;
        const bCount = counts instanceof Map ? (counts.get(b.id) || 0) : 0;
        return (bCount - aCount) || defaultSort;
    }

    // alphabetical sort
    if (power_user.tag_sort_mode === tag_sort_mode.ALPHABETICAL) {
        return defaultSort;
    }

    // manual sort
    if (a.sort_order !== undefined && b.sort_order !== undefined) {
        return a.sort_order - b.sort_order;
    } else if (a.sort_order !== undefined) {
        return -1;
    } else if (b.sort_order !== undefined) {
        return 1;
    } else {
        return defaultSort;
    }
}

/**
 * Deliberately still direct `tags`/`tag_map` mutations (tags.push/removeFromArray, tag_map[key]=...) rather than
 * migrated to per-item tagsStore/tagMapStore ops, same reasoning as makeTagListDraggable's onTagsSort: this is a
 * bulk, rare (user explicitly restoring a tags backup file), all-or-nothing operation with its own id-remapping
 * logic (existing tags can get overwritten with a *different* id than the imported one, tracked via
 * idToActualTagIdMap) - forcing that through per-item store calls would mean either replicating the remapping
 * logic twice or risking getting it subtly wrong translating it, for an operation that already gets a single
 * `tagsStore.reindex()` + `invalidateAssignedTagIdsCache()` (which itself does `tagMapStore.reindex()`) right
 * after this whole function's mutations are done - the stores end up fully consistent either way, just via a
 * single bulk resync instead of many individual op calls with no current consumer for the events they'd fire.
 */
async function onTagRestoreFileSelect(e) {
    const file = e.target.files[0];

    if (!file) {
        console.log('Tag restore: No file selected.');
        return;
    }

    const data = await parseJsonFile(file);

    if (!data) {
        toastr.warning('Empty file data', 'Tag Restore');
        console.log('Tag restore: File data empty.');
        return;
    }

    if (!data.tags || !data.tag_map || !Array.isArray(data.tags) || typeof data.tag_map !== 'object') {
        toastr.warning('Invalid file format', 'Tag Restore');
        console.log('Tag restore: Invalid file format.');
        return;
    }

    // Prompt user if they want to overwrite existing tags
    let overwrite = false;
    if (tags.length > 0) {
        const result = await Popup.show.confirm('Tag Restore', 'You have existing tags. If the backup contains any of those tags, do you want the backup to overwrite their settings (Name, color, folder state, etc)?',
            { okButton: 'Overwrite', cancelButton: 'Keep Existing' });
        overwrite = result === POPUP_RESULT.AFFIRMATIVE;
    }

    const warnings = [];
    /** @type {Map<string, string>} Map import tag ids with existing ids on overwrite */
    const idToActualTagIdMap = new Map();

    // Import tags
    for (const tag of data.tags) {
        if (!tag.id || !tag.name) {
            warnings.push(`Tag object is invalid: ${JSON.stringify(tag)}.`);
            continue;
        }

        // Check against both existing id (direct match) and tag with the same name, which is not allowed.
        let existingTag = tagsStore.get(tag.id);
        if (existingTag && !overwrite) {
            warnings.push(`Tag '${tag.name}' with id ${tag.id} already exists.`);
            continue;
        }
        existingTag = getTag(tag.name);
        if (existingTag && !overwrite) {
            warnings.push(`Tag with name '${tag.name}' already exists.`);
            // Remember the tag id, so we can still import the tag map entries for this
            idToActualTagIdMap.set(tag.id, existingTag.id);
            continue;
        }

        if (existingTag) {
            // On overwrite, we remove and re-add the tag
            removeFromArray(tags, existingTag);
            // And remember the ID if it was different, so we can update the tag map accordingly
            if (existingTag.id !== tag.id) {
                idToActualTagIdMap.set(existingTag.id, tag.id);
            }
        }

        tags.push(tag);
    }

    // Import tag_map
    const tagMapKeys = Object.keys(data.tag_map);
    // Batch every key's character-existence answer in one call rather than one `exists()` round-trip per key
    // (design doc §4.2). `null` means the check itself failed - see checkCharactersExistOrNull()'s doc comment for
    // why that must not be read as "none of these exist": this is a warn-and-skip flow, not a delete, so on a
    // failed check we fail open (treat every key as possibly-a-character) rather than mass-warning below.
    const characterKeyExistence = await checkCharactersExistOrNull(tagMapKeys);
    if (characterKeyExistence === null) {
        toastr.error(t`Could not verify character existence against the server. Tag map keys could not be validated this run.`, 'Tag Restore');
    }

    for (const key of tagMapKeys) {
        const tagIds = data.tag_map[key];

        if (!Array.isArray(tagIds)) {
            warnings.push(`Tag map for key ${key} is invalid: ${JSON.stringify(tagIds)}.`);
            continue;
        }

        // Verify that the key points to a valid character or group.
        const characterExists = characterKeyExistence === null ? true : characterKeyExistence[key] === true;
        const groupExists = groups.some(x => String(x.id) === String(key));

        if (!characterExists && !groupExists) {
            warnings.push(`Tag map key ${key} does not exist as character or group.`);
            continue;
        }

        // Get existing tag ids for this key or empty array.
        const existingTagIds = tag_map[key] || [];

        // Merge existing and new tag ids. Replace the ones mapped to a new id. Remove duplicates.
        const combinedTags = existingTagIds.concat(tagIds)
            .map(tagId => (idToActualTagIdMap.has(tagId)) ? idToActualTagIdMap.get(tagId) : tagId)
            .filter(onlyUnique);

        // Verify that all tags exist. Remove tags that don't exist.
        tag_map[key] = combinedTags.filter(tagId => tags.some(y => String(y.id) === String(tagId)));
    }

    if (warnings.length) {
        toastr.warning('Tags restored with warnings. Check console or click on this message for details.', 'Tag Restore', {
            timeOut: toastr.options.timeOut * 2, // Display double the time
            onclick: () => Popup.show.text('Tag Restore Warnings', `<samp class="justifyLeft">${DOMPurify.sanitize(warnings.join('\n'))}<samp>`, { allowVerticalScrolling: true }),
        });
        console.warn(`TAG RESTORE REPORT\n====================\n${warnings.join('\n')}`);
    } else {
        toastr.success('Tags restored successfully.', 'Tag Restore');
    }

    tagsStore.reindex();
    invalidateAssignedTagIdsCache();
    invalidateTagsFuseIndex();

    $('#tag_view_restore_input').val('');
    printCharactersDebounced();
    saveSettingsDebounced('power_user.tag_map');

    // Reprint the tag management popup, without having it to be opened again
    const tagContainer = $('#tag_view_list .tag_view_list_tags');
    printViewTagList(tagContainer);
}

function onBackupRestoreClick() {
    $('#tag_view_restore_input')
        .off('change')
        .on('change', onTagRestoreFileSelect)
        .trigger('click');
}

function onTagsBackupClick() {
    const timestamp = new Date().toISOString().split('T')[0].replace(/-/g, '');
    const filename = `tags_${timestamp}.json`;
    const data = {
        tags: tags,
        tag_map: tag_map,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    download(blob, filename, 'application/json');
}

async function onTagsPruneClick() {
    // Get tags which have zero tag map entries
    const allTagsInTagMaps = getAssignedTagIds();
    const tagsToPrune = tags.filter(tag => !allTagsInTagMaps.has(tag.id));

    // Get tag maps referring to deleted entities. Group ids are always fully resident and cheap to check
    // locally; character-shaped keys go through the authoritative `characterRepository.exists()` (design doc
    // §4.2) instead of a resident-array scan, since this path actually deletes tag_map entries.
    const groupEntityIds = new Set(groups.map(g => String(g.id)));
    const candidateCharacterKeys = Object.keys(tag_map).filter(key => !groupEntityIds.has(key));
    const characterKeyExistence = await checkCharactersExistOrNull(candidateCharacterKeys);

    let tagMapsToPrune;
    if (characterKeyExistence === null) {
        // §4.2: a failed/partial existence check must abort the prune for the affected keys, never fall
        // through to "prune it". Only the character-shaped candidates are affected; nothing here deletes yet.
        toastr.error(t`Could not verify character existence against the server. Skipping pruning of stale character tag references this run.`, 'Prune Tags');
        tagMapsToPrune = [];
    } else {
        tagMapsToPrune = candidateCharacterKeys.filter(key => !characterKeyExistence[key]);
    }

    if (!tagsToPrune.length && !tagMapsToPrune.length) {
        toastr.info(t`No unused tags or references found.`);
        return;
    }

    const confirm = await Popup.show.confirm(t`Prune ${tagsToPrune.length} tags and ${tagMapsToPrune.length} references`, t`Are you sure you want to remove all unused tags and references to missing or deleted characters and groups?`);

    if (!confirm) {
        return;
    }

    // Fuse-index invalidation (per removal) is handled by the tagsStore/tagMapStore.onChange subscribers
    // (rebuildTagStores()) - firing once per pruned item here is fine, it's just setting dirty flags.
    for (const tag of tagsToPrune) {
        tagsStore.remove(tag.id);
    }

    for (const key of tagMapsToPrune) {
        tagMapStore.removeKey(key);
    }

    printCharactersDebounced();
    saveSettingsDebounced('power_user.tag_map');

    // Reprint the tag management popup, without having it to be opened again
    const tagContainer = $('#tag_view_list .tag_view_list_tags');
    printViewTagList(tagContainer);

    toastr.success(t`Unused tags pruned successfully.`);
}

function onTagCreateClick() {
    const tagName = getFreeName('New Tag', tags.map(x => x.name));
    const tag = createNewTag(tagName);
    printViewTagList($('#tag_view_list .tag_view_list_tags'));

    const tagElement = ($('#tag_view_list .tag_view_list_tags')).find(`.tag_view_item[id="${tag.id}"]`);
    tagElement[0]?.scrollIntoView();
    flashHighlight(tagElement);

    printCharactersDebounced();

    toastr.success('Tag created', 'Create Tag');
}

/**
 * Appends a tag to the view tag list.
 * @param {JQuery<HTMLElement>} list List element
 * @param {Tag} tag Tag object
 * @param {number} count Count of characters/groups using this tag
 */
function appendViewTagToList(list, tag, count) {
    const template = VIEW_TAG_TEMPLATE.clone();
    template.attr('id', tag.id);
    template.find('.tag_view_counter_value').text(count);
    template.find('.tag_view_name').text(tag.name);
    template.find('.tag_view_name').addClass('tag');

    template.find('.tag_view_name').css('background-color', tag.color);
    template.find('.tag_view_name').css('color', tag.color2);

    const tagAsFolderId = tag.id + '-tag-folder';
    const colorPickerId = tag.id + '-tag-color';
    const colorPicker2Id = tag.id + '-tag-color2';

    if (!power_user.bogus_folders) {
        template.find('.tag_as_folder').hide();
    }

    const primaryColorPicker = $('<toolcool-color-picker></toolcool-color-picker>')
        .addClass('tag-color')
        .attr({ id: colorPickerId, color: tag.color || 'rgba(0, 0, 0, 0.5)', 'data-default-color': 'rgba(0, 0, 0, 0.5)' });

    const secondaryColorPicker = $('<toolcool-color-picker></toolcool-color-picker>')
        .addClass('tag-color2')
        .attr({ id: colorPicker2Id, color: tag.color2 || power_user.main_text_color, 'data-default-color': power_user.main_text_color });

    template.find('.tag_view_color_picker[data-value="color"]').append(primaryColorPicker)
        .append($('<div class="fas fa-link fa-xs link_icon right_menu_button" title="Link to theme color"></div>'));
    template.find('.tag_view_color_picker[data-value="color2"]').append(secondaryColorPicker)
        .append($('<div class="fas fa-link fa-xs link_icon right_menu_button" title="Link to theme color"></div>'));

    template.find('.tag_as_folder').attr('id', tagAsFolderId);

    primaryColorPicker.on('change', (evt) => onTagColorize(evt, 'color', 'background-color'));
    secondaryColorPicker.on('change', (evt) => onTagColorize(evt, 'color2', 'color'));
    template.find('.tag_view_color_picker .link_icon').on('click', (evt) => {
        const colorPicker = $(evt.target).closest('.tag_view_color_picker').find('toolcool-color-picker');
        const defaultColor = colorPicker.attr('data-default-color');
        // @ts-ignore
        colorPicker[0].color = defaultColor;
    });

    const getHideTooltip = () => tag.is_hidden_on_character_card ? t`Hide on character card` : t`Show on character card`;
    const hideToggle = template.find('.eye-toggle');
    hideToggle.toggleClass('fa-eye-slash', tag.is_hidden_on_character_card);
    hideToggle.toggleClass('fa-eye', !tag.is_hidden_on_character_card);
    hideToggle.attr('title', getHideTooltip());

    hideToggle.on('click', () => {
        tag.is_hidden_on_character_card = !tag.is_hidden_on_character_card;
        hideToggle.toggleClass('fa-eye-slash', tag.is_hidden_on_character_card);
        hideToggle.toggleClass('fa-eye', !tag.is_hidden_on_character_card);
        hideToggle.attr('title', getHideTooltip());
        printCharactersDebounced();
        saveSettingsDebounced('power_user');
    });

    list.append(template);

    // We prevent the popup from auto-close on Escape press on the color pickups. If the user really wants to, he can hit it again
    // Not the "cleanest" way, that would be actually using and observer, remembering whether the popup was open just before, but eh
    // Not gonna invest too much time into this small control here
    let lastHit = 0;
    template.on('keydown', (evt) => {
        if (evt.key === 'Escape') {
            if (evt.target === primaryColorPicker[0] || evt.target === secondaryColorPicker[0]) {
                if (Date.now() - lastHit < 5000) // If user hits it twice in five seconds
                    return;
                lastHit = Date.now();
                evt.stopPropagation();
                evt.preventDefault();
            }
        }
    });

    updateDrawTagFolder(template, tag);
}

function onTagAsFolderClick() {
    const element = $(this).closest('.tag_view_item');
    const id = element.attr('id');
    const tag = tagsStore.get(id);

    // Cycle through folder types
    const types = Object.keys(TAG_FOLDER_TYPES);
    const currentTypeIndex = types.indexOf(tag.folder_type);
    tagsStore.update(id, { folder_type: types[(currentTypeIndex + 1) % types.length] });

    updateDrawTagFolder(element, tag);

    // If folder display has changed, we have to redraw the character list, otherwise this folders state would not change
    printCharactersDebounced();
}

function updateDrawTagFolder(element, tag) {
    const tagFolder = TAG_FOLDER_TYPES[tag.folder_type] || TAG_FOLDER_TYPES[TAG_FOLDER_DEFAULT_TYPE];
    const folderElement = element.find('.tag_as_folder');

    // Update css class and remove all others
    Object.keys(TAG_FOLDER_TYPES).forEach(x => {
        folderElement.toggleClass(TAG_FOLDER_TYPES[x].class, TAG_FOLDER_TYPES[x] === tagFolder);
    });

    // Draw/update css attributes for this class
    folderElement.attr('title', tagFolder.tooltip);
    folderElement.attr('data-i18n', '[title]' + tagFolder.tooltip);
    const indicator = folderElement.find('.tag_folder_indicator');
    indicator.text(tagFolder.icon);
    indicator.css('color', tagFolder.color);
    indicator.css('font-size', `calc(var(--mainFontSize) * ${tagFolder.size})`);
}

async function onTagDeleteClick() {
    const id = $(this).closest('.tag_view_item').attr('id');
    const tag = tagsStore.get(id);
    const otherTags = sortTags(tags.filter(x => x.id !== id).map(x => ({ id: x.id, name: x.name })));

    const popupContent = $(await renderTemplateAsync('deleteTag', { otherTags }));

    appendTagToList(popupContent.find('#tag_to_delete'), tag);

    // Make the select control more fancy on not mobile
    if (!isMobile()) {
        // Delete the empty option in the dropdown, and make the select2 be empty by default
        popupContent.find('#merge_tag_select option[value=""]').remove();
        popupContent.find('#merge_tag_select').select2({
            width: '50%',
            placeholder: 'Select tag to merge into',
            allowClear: true,
        }).val(null).trigger('change');
    }

    const result = await callGenericPopup(popupContent, POPUP_TYPE.CONFIRM);
    if (result !== POPUP_RESULT.AFFIRMATIVE) {
        return;
    }

    const mergeTagId = $('#merge_tag_select').val() ? String($('#merge_tag_select').val()) : null;

    // Remove the tag from all entities that use it. If we have a replacement tag, add that one instead.
    // Fuse-index invalidation is handled by the tagsStore/tagMapStore.onChange subscribers (rebuildTagStores()).
    tagMapStore.removeRelatedIdEverywhere(id, { replaceWithId: mergeTagId });

    tagsStore.remove(id);
    $(`.tag[id="${id}"]`).remove();
    $(`.tag_view_item[id="${id}"]`).remove();

    toastr.success(`'${tag.name}' deleted${mergeTagId ? ` and merged into '${tagsStore.get(mergeTagId).name}'` : ''}`, 'Delete Tag');

    printCharactersDebounced();
    saveSettingsDebounced('power_user.tag_map');

    applyCharacterTagsToMessageDivs();
}

function onTagRenameInput() {
    const id = $(this).closest('.tag_view_item').attr('id');
    const newName = $(this).text();
    // Fuse-index invalidation is handled by the tagsStore.onChange subscriber (rebuildTagStores()).
    tagsStore.update(id, { name: newName });
    $(this).attr('dirty', '');
    $(`.tag[id="${id}"] .tag_name`).text(newName);

    applyCharacterTagsToMessageDivs();
}

/**
 * Handles the colorization of a tag when the user interacts with the color picker
 *
 * @param {*} evt - The custom colorize event object
 * @param {'color'|'color2'} colorField - Which field on the tag object this picker controls
 * @param {string} cssProperty - The CSS property to apply the color to
 *
 * Now routed through tagsStore.update() (previously a direct field mutation, since the old shared callback
 * mutated the tag object in place rather than returning a patch) - the two picker call sites now pass the
 * field name directly instead of a mutator function, so this can build a `{[colorField]: newColor}` patch and
 * go through the store like onTagRenameInput/onTagAsFolderClick already do. Picks up the existing
 * tagsStore.onChange subscribers (fuse-index invalidation, saveTagsDebounced) for free - color changes weren't
 * persisted to tags.json promptly before this, only via the manual saveSettingsDebounced() call below (which
 * saves settings.json, not tags.json).
 */
function onTagColorize(evt, colorField, cssProperty) {
    const isDefaultColor = $(evt.target).data('default-color') === evt.detail.rgba;
    $(evt.target).closest('.tag_view_color_picker').find('.link_icon').toggle(!isDefaultColor);

    const id = $(evt.target).closest('.tag_view_item').attr('id');
    let newColor = evt.detail.rgba;
    if (isDefaultColor) newColor = '';

    $(evt.target).closest('.tag_view_item').find('.tag_view_name').css(cssProperty, newColor);
    tagsStore.update(id, { [colorField]: newColor });

    // Debounce redrawing color of the tag in other elements
    debouncedTagColoring(id, cssProperty, newColor);
}

const debouncedTagColoring = debounce((tagId, cssProperty, newColor) => {
    $(`.tag[id="${tagId}"]`).css(cssProperty, newColor);
    $(`.bogus_folder_select[tagid="${tagId}"] .avatar`).css(cssProperty, newColor);
}, debounce_timeout.quick);

function onTagListHintClick() {
    $(this).toggleClass('selected');

    const $tagSiblings = $(this).siblings('.tag:not(.actionable)');

    if ($(this).hasClass('selected')) {
        $tagSiblings.show();
    } else {
        $tagSiblings.hide();
    }

    $(this).siblings('.innerActionable').toggleClass('hidden');

    // Determine which context this button belongs to and save the setting
    let filterType = tag_filter_type.character;

    // Check which section we're in by looking at the sibling header
    const $tagControls = $(this).closest('.rm_tag_controls');
    if ($tagControls.prev().is('#rm_group_add_members_header')) {
        filterType = tag_filter_type.group_candidates_list;
    } else if ($tagControls.prev().is('#rm_group_members_header')) {
        filterType = tag_filter_type.group_members_list;
    }

    const isSelected = $(this).hasClass('selected');
    setTagFilterVisibility(filterType, isSelected);
    console.debug('show_tag_filters for type', filterType, ':', isSelected);
}

/**
 * Clears all filters for the current list context.
 * @param {FilterHelper} filterHelper - The filter helper for the current context
 */
function onClearAllFiltersClick(filterHelper) {
    console.debug('clear all filters clicked');

    const context = getFilterContext(filterHelper);
    if (!context) {
        console.warn('Unknown filter helper in onClearAllFiltersClick');
        return;
    }

    // We have to manually go through the elements and unfilter by clicking...
    // Thankfully nearly all filter controls are three-state-toggles
    const filterTags = $(context.selector).find('.tag');
    for (const tag of filterTags) {
        const toggleState = $(tag).attr('data-toggle-state');
        if (toggleState !== undefined && !isFilterState(toggleState ?? FILTER_STATES.UNDEFINED, FILTER_STATES.UNDEFINED)) {
            toggleTagThreeState($(tag), { stateOverride: FILTER_STATES.UNDEFINED, simulateClick: true });
        }
    }

    // Reset search input for this context
    $(context.searchInput).val('').trigger('input');
}

/**
 * Copy tags from one character to another.
 * @param {{oldAvatar: string, newAvatar: string}} data Event data
 */
function copyTags(data) {
    // Fuse-index invalidation is handled by the tagMapStore.onChange subscriber (rebuildTagStores()).
    tagMapStore.copyKey(data.oldAvatar, data.newAvatar);
}

/**
 * Clears all tags assigned to a given entity key, without removing the tag_map entry itself.
 * Exported so other modules (BulkEditOverlay.js) don't need to write into `tag_map` directly.
 * @param {string} key - tag_map key (character avatar or group id)
 */
export function clearEntityTags(key) {
    tagMapStore.setKey(key, []);
}

/**
 * Removes a tag_map entry entirely for a given entity key (e.g. the character/group was deleted).
 * Exported so other modules (group-chats.js, script.js) don't need to write into `tag_map` directly.
 * @param {string} key - tag_map key (character avatar or group id)
 */
export function removeEntityTags(key) {
    tagMapStore.removeKey(key);
}

/**
 * Prints the tag list in the view tags popup.
 * @param {JQuery<HTMLElement>} tagContainer Container element
 * @param {boolean} empty Whether to empty the container before printing
 */
function printViewTagList(tagContainer, empty = true) {
    if (empty) tagContainer.empty();
    const counts = new Map(tags.map(tag => [tag.id, 0]));
    for (const tagId of Object.values(tag_map).flat()) {
        if (counts.has(tagId)) counts.set(tagId, counts.get(tagId) + 1);
    }
    const sortedTags = sortTags(tags, counts);
    for (const tag of sortedTags) {
        const count = counts.get(tag.id) || 0;
        appendViewTagToList(tagContainer, tag, count);
    }
}

function removeMissingTagFilters() {
    const tagIds = new Set(tags.map(tag => tag.id));
    const assignedTagIds = getAssignedTagIds();
    // Filter lists only print tags that are assigned to at least one entity. A filter on an unassigned
    // tag therefore has no element to toggle, and "Clear all filters" can't reset it either, because it
    // works by clicking the printed elements. Drop those filters instead of leaving them stuck.
    const isUnclearable = (tagId) => !tagIds.has(tagId) || !assignedTagIds.has(tagId);

    for (const helper of [groupCandidatesFilter, groupMembersFilter, entitiesFilter]) {
        const { selected, excluded } = helper.getFilterData(FILTER_TYPES.TAG);
        const storagePrefix = getFilterStorageKey(helper);
        let anyRemoved = false;

        for (const tagIdList of [selected, excluded]) {
            if (!Array.isArray(tagIdList)) {
                continue;
            }

            for (let i = tagIdList.length - 1; i >= 0; i--) {
                if (!isUnclearable(tagIdList[i])) {
                    continue;
                }

                if (storagePrefix) {
                    accountStorage.removeItem(`${storagePrefix}_tag_${tagIdList[i]}`);
                }

                tagIdList.splice(i, 1);
                anyRemoved = true;
            }
        }

        if (anyRemoved) {
            helper.setFilterData(FILTER_TYPES.TAG, { selected, excluded });
        }
    }
}

function registerTagsSlashCommands() {
    /**
     * Gets a tag by its name. Optionally can create the tag if it does not exist.
     * @param {string} tagName - The name of the tag
     * @param {object} options - Optional arguments
     * @param {boolean} [options.allowCreate=false] - Whether a new tag should be created if no tag with the name exists
     * @returns {Tag?} The tag, or null if not found
     */
    function paraGetTag(tagName, { allowCreate = false } = {}) {
        if (!tagName) {
            toastr.warning('Tag name must be provided.');
            return null;
        }
        let tag = getTag(tagName);
        if (allowCreate && !tag) {
            tag = createNewTag(tagName);
        }
        if (!tag) {
            toastr.warning(`Tag ${tagName} not found.`);
            return null;
        }
        return tag;
    }

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'tag-add',
        returns: 'true/false - Whether the tag was added or was assigned already',
        /** @param {{name: string}} namedArgs @param {string} tagName @returns {string} */
        callback: ({ name }, tagName) => {
            const key = searchCharByName(name);
            if (!key) return 'false';
            const tag = paraGetTag(tagName, { allowCreate: true });
            if (!tag) return 'false';
            const result = addTagsToEntity(tag, key);
            printCharacters();
            return String(result);
        },
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'name',
                description: 'Character name - or unique character identifier (avatar key)',
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: '{{char}}',
                enumProvider: commonEnumProviders.characters(),
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'tag name',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                enumProvider: commonEnumProviders.tagsForChar('not-existing'),
                forceEnum: false,
            }),
        ],
        helpString: `
        <div>
            Adds a tag to the character. If no character is provided, it adds it to the current character (<code>{{char}}</code>).
            If the tag doesn't exist, it is created.
        </div>
        <div>
            <strong>Example:</strong>
            <ul>
                <li>
                    <pre><code>/tag-add name="Chloe" scenario</code></pre>
                    will add the tag "scenario" to the character named Chloe.
                </li>
            </ul>
        </div>
    `,
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'tag-remove',
        returns: 'true/false - Whether the tag was removed or wasn\'t assigned already',
        /** @param {{name: string}} namedArgs @param {string} tagName @returns {string} */
        callback: ({ name }, tagName) => {
            const key = searchCharByName(name);
            if (!key) return 'false';
            const tag = paraGetTag(tagName);
            if (!tag) return 'false';
            const result = removeTagFromEntity(tag, key);
            printCharacters();
            return String(result);
        },
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'name',
                description: 'Character name - or unique character identifier (avatar key)',
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: '{{char}}',
                enumProvider: commonEnumProviders.characters(),
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'tag name',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                /**@param {SlashCommandExecutor} executor */
                enumProvider: commonEnumProviders.tagsForChar('existing'),
            }),
        ],
        helpString: `
        <div>
            Removes a tag from the character. If no character is provided, it removes it from the current character (<code>{{char}}</code>).
        </div>
        <div>
            <strong>Example:</strong>
            <ul>
                <li>
                    <pre><code>/tag-remove name="Chloe" scenario</code></pre>
                    will remove the tag "scenario" from the character named Chloe.
                </li>
            </ul>
        </div>
    `,
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'tag-exists',
        returns: 'true/false - Whether the given tag name is assigned to the character',
        /** @param {{name: string}} namedArgs @param {string} tagName @returns {string} */
        callback: ({ name }, tagName) => {
            const key = searchCharByName(name);
            if (!key) return 'false';
            const tag = paraGetTag(tagName);
            if (!tag) return 'false';
            return String(tag_map[key].includes(tag.id));
        },
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'name',
                description: 'Character name - or unique character identifier (avatar key)',
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: '{{char}}',
                enumProvider: commonEnumProviders.characters(),
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'tag name',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                /**@param {SlashCommandExecutor} executor */
                enumProvider: commonEnumProviders.tagsForChar('all'),
            }),
        ],
        helpString: `
        <div>
            Checks whether the given tag is assigned to the character. If no character is provided, it checks the current character (<code>{{char}}</code>).
        </div>
        <div>
            <strong>Example:</strong>
            <ul>
                <li>
                    <pre><code>/tag-exists name="Chloe" scenario</code></pre>
                    will return true if the character named Chloe has the tag "scenario".
                </li>
            </ul>
        </div>
    `,
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'tag-list',
        returns: 'Comma-separated list of all assigned tags',
        /** @param {{name: string}} namedArgs @returns {string} */
        callback: ({ name }) => {
            const key = searchCharByName(name);
            if (!key) return '';
            const tags = getTagsList(key);
            return tags.map(x => x.name).join(', ');
        },
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'name',
                description: 'Character name - or unique character identifier (avatar key)',
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: '{{char}}',
                enumProvider: commonEnumProviders.characters(),
            }),
        ],
        helpString: `
        <div>
            Lists all assigned tags of the character. If no character is provided, it uses the current character (<code>{{char}}</code>).
            <br />
            Note that there is no special handling for tags containing commas, they will be printed as-is.
        </div>
        <div>
            <strong>Example:</strong>
            <ul>
                <li>
                    <pre><code>/tag-list name="Chloe"</code></pre>
                    could return something like <code>OC, scenario, edited, funny</code>
                </li>
            </ul>
        </div>
    `,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'tag-import',
        /** @param {{name: string, mode: 'all'|'existing'|'none'|'ask'}} namedArgs @returns {Promise<string>} */
        callback: async ({ name, mode }) => {
            if (selected_group !== null) {
                toastr.warning(t`Tag import does not support group chats.`);
                return 'false';
            }
            const key = searchCharByName(name);
            if (!key) return 'false';

            // Map mode argument to tag_import_setting
            const modeMap = {
                'all': tag_import_setting.ALL,
                'existing': tag_import_setting.ONLY_EXISTING,
                'none': tag_import_setting.NONE,
                'ask': tag_import_setting.ASK,
            };
            if (mode && !modeMap[mode]) {
                toastr.warning(`Invalid tag import mode: ${mode}. Valid modes are: ${Object.keys(modeMap).join(', ')}`);
                return 'false';
            }

            const importSetting = mode ? modeMap[mode] : null;
            const character = findChar({ name: key });

            const result = await importTags(character, { importSetting });
            return result ? 'true' : 'false';
        },
        returns: t`true if any tags were imported, false otherwise`,
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'name',
                description: 'Character name - or unique character identifier (avatar key)',
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: '{{char}}',
                enumProvider: commonEnumProviders.characters(),
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'mode',
                description: t`Import mode: "all" imports all tags, "existing" imports only existing ST tags, "none" skips import, "ask" shows the import popup (default: uses your saved setting)`,
                typeList: [ARGUMENT_TYPE.STRING],
                enumList: [
                    new SlashCommandEnumValue('all', t`Import all tags (create new ones if needed)`, enumTypes.enum),
                    new SlashCommandEnumValue('existing', t`Import only existing ST tags`, enumTypes.enum),
                    new SlashCommandEnumValue('none', t`Skip import`, enumTypes.enum),
                    new SlashCommandEnumValue('ask', t`Show the import popup`, enumTypes.enum),
                ],
            }),
        ],
        helpString: `
        <div>
            ${t`Imports character card tags as SillyTavern tags for folder/filter use.`}
        </div>
        <div>
            ${t`Character cards can have embedded tags (set via <code>tags</code> argument in <code>/char-create</code> or <code>/char-update</code>). This command imports those embedded tags as ST tags that can be used for filtering and organizing characters.`}
        </div>
        <div>
            ${t`If no mode is specified, uses your saved tag import setting from preferences.`}
        </div>
        <div>
            <strong>${t`Example:`}</strong>
            <ul>
                <li>
                    <pre><code>/tag-import</code></pre>
                    ${t`Imports tags for the current character using your default setting.`}
                </li>
                <li>
                    <pre><code>/tag-import name="Alice" mode=all</code></pre>
                    ${t`Imports all of Alice's card tags, creating new ST tags if needed.`}
                </li>
            </ul>
        </div>
        `,
    }));
}

/**
 * Function to apply character tags to message divs when rendering the chat
 * @param {object} options Options for applying character tags
 * @param {number|number[]} [options.mesIds=[]] An id or array of message IDs to filter by.
 * If empty, all messages will be processed.
 * @returns {void}
 * @description This function iterates through the chat messages and applies character tags
 */
export function applyCharacterTagsToMessageDivs({ mesIds = [] } = {}) {
    try {
        const messagesFilter = buildMessagesFilter(mesIds);
        const messages = $('#chat').children(messagesFilter);

        // Clear existing tags
        messages.each(function () {
            const element = this; // Get the raw DOM element

            for (const attr of [...element.attributes]) {
                if (attr.name.startsWith('data-char-tag-') || attr.name === 'data-char-tags') {
                    element.removeAttribute(attr.name);
                }
            }
        });

        const tagsList = tags, characterTagData = tag_map;

        if (!tagsList?.length || !characterTagData) {
            return;
        }

        const tagNamesById = tagsList.reduce((acc, tag) => {
            acc[tag.id] = tag.name;
            return acc;
        }, {});

        const characterTagsCache = new Map();

        // Iterate each message div
        messages.each(function () {
            const $this = $(this); // Store the jQuery object
            const avatarFileName = extractCharacterAvatar($this.find('.avatar img').attr('src'));

            if (!avatarFileName) {
                return;
            }

            let tagsForCharacter = characterTagsCache.get(avatarFileName);

            // If tags are NOT in the cache, compute and store them
            if (!tagsForCharacter) {
                const tagIds = characterTagData[avatarFileName];
                if (tagIds?.length) {
                    const tagNames = tagIds
                        .map(id => tagNamesById[id])
                        .filter(Boolean);

                    if (tagNames.length) {
                        tagsForCharacter = {
                            tagNames,
                            joinedTagNames: tagNames
                                .map(name => name?.replace(/,/g, ' ')) // replace commas with spaces to avoid issues with tag names containing commas
                                .join(','),
                        };
                        // Add the newly computed tags to the cache
                        characterTagsCache.set(avatarFileName, tagsForCharacter);
                    }
                }
            }

            // If we have tags (either from cache or newly computed), apply them
            if (tagsForCharacter) {
                applyTags($this, tagsForCharacter);
            }
        });
    } catch (error) {
        console.error('Error applying character tags to message divs:', error);
    }
}

/**
 * Builds a jQuery selector string to filter messages by their IDs.
 * @param {number|number[]} mesIds - An id or array of message IDs to filter by.
 * @returns {string} A jQuery selector string that matches messages with the specified IDs.
 * If mesIds is empty, it returns '.mes' to select all messages.
 * @example
 * buildMessagesFilter([1, 5]); // Returns '.mes[mesid="1"],.mes[mesid="5"]'
 * buildMessagesFilter([]); // Returns '.mes'
 */
function buildMessagesFilter(mesIds) {
    const allMessages = '.mes';

    if (!mesIds) {
        return allMessages; // If no mesIds provided, select all messages
    }

    const mesIdsArray = Array.isArray(mesIds) ? mesIds : [mesIds];

    if (mesIdsArray?.length) {
        // Create a valid jQuery selector for multiple attribute values.
        // Example output: '.mes[mesid="1"],.mes[mesid="5"]'
        return mesIdsArray.map(id => `.mes[mesid="${id}"]`).join(',');
    }

    // If mesIds is empty, select all messages.
    return allMessages;
}

/**
 * Helper function to apply all necessary data attributes to a DOM element.
 * @param {JQuery<HTMLElement>} $element - The jQuery object for the message div.
 * @param {object} tagData - An object containing tag information.
 * @param {string[]} tagData.tagNames - An array of tag names.
 * @param {string} tagData.joinedTagNames - A comma-separated string of tag names.
 */
function applyTags($element, tagData) {
    $element.attr('data-char-tags', tagData.joinedTagNames);
    tagData.tagNames.forEach(tagName => {
        const normalizedTagName = normalizeTagName(tagName);

        if (!normalizedTagName) {
            return; // Skip empty tag names
        }

        $element.attr(`data-char-tag-${normalizedTagName}`, '');
    });
}

/**
 * Normalizes a tag name by trimming, converting spaces to hyphens, replacing accented characters,
 * removing special characters, and converting to lowercase.
 * @param {string} name The tag name to normalize.
 * @returns {string} The normalized tag name.
 */
function normalizeTagName(name) {
    if (!name?.trim()) {
        return '';
    }

    // Normalize the tag name by trimming, converting spaces to hyphens, replacing accented characters, removing special characters, and converting to lowercase
    return name.trim()
        .normalize('NFD') // Normalize accented characters
        .replace(/[\u0300-\u036f]/g, '') // Remove diacritical marks
        .replace(/[^a-zA-Z0-9\s_-]/g, '') // Remove special characters except spaces, underscores, and hyphens
        .replace(/[\s_]+/g, '-') // Replace spaces and underscores with hyphens
        .toLowerCase();
}

/**
 * Extracts the character avatar file name from the avatar source URL.
 * @param {string} avatarSrc The source URL of the character avatar.
 * @returns {string|null} The normalized avatar file name, or null if the input is falsy or doesn't contain a valid file name.
 */
function extractCharacterAvatar(avatarSrc) {
    if (!avatarSrc) {
        return null;
    }

    try {
        const url = new URL(avatarSrc, window.location.origin);
        return url?.searchParams.get('file');
    } catch (error) {
        console.error('Unable to parse character avatar using avatarSrc', avatarSrc, error);
        return null;
    }
}

function restoreSavedTagFilters() {
    try {
        // Load persisted filter states for all contexts (including character list)
        loadFilterStatesForContext(entitiesFilter, 'CharacterList');
        loadFilterStatesForContext(groupCandidatesFilter, 'GroupCandidates');
        loadFilterStatesForContext(groupMembersFilter, 'GroupMembers');
    } catch (e) {
        console.warn('Failed to restore actionable filter states from account storage', e);
    }
}

export function initTags() {
    createTagInput('#tagInput', '#tagList', { tagOptions: { removable: true } });
    createTagInput('#groupTagInput', '#groupTagList', { tagOptions: { removable: true } });

    $(document).on('click', '#rm_button_create', onCharacterCreateClick);
    $(document).on('click', '#rm_button_group_chats', onGroupCreateClick);
    $(document).on('click', '.tag_remove', onTagRemoveClick);
    $(document).on('input', '.tag_input', onTagInput);
    $(document).on('click', '.tags_view', function (event) {
        // 1. Prevent the label from toggling the checkbox
        event.preventDefault();
        // 2. Open the tag view list dialog
        onViewTagsListClick();
    });
    $(document).on('click', '.tag_delete', onTagDeleteClick);
    $(document).on('click', '.tag_as_folder', onTagAsFolderClick);
    $(document).on('input', '.tag_view_name', onTagRenameInput);
    $(document).on('click', '.tag_view_create', onTagCreateClick);
    $(document).on('click', '.tag_view_backup', onTagsBackupClick);
    $(document).on('click', '.tag_view_restore', onBackupRestoreClick);
    $(document).on('click', '.tag_view_prune', onTagsPruneClick);
    eventSource.on(event_types.CHARACTER_DUPLICATED, copyTags);
    eventSource.makeFirst(event_types.CHAT_CHANGED, () => selected_group ? applyTagsOnGroupSelect() : applyTagsOnCharacterSelect());

    $(document).on('focusout', '#tag_view_list .tag_view_name', (evt) => {
        // Reorder/reprint tags, but only if the name actually has changed
        if (!$(evt.target).is('[dirty]')) return;

        // Remember the order, so we can flash highlight if it changed after reprinting
        const tagId = ($(evt.target).closest('.tag_view_item')).attr('id');
        const oldOrder = $('#tag_view_list .tag_view_item').map((_, el) => el.id).get();

        printViewTagList($('#tag_view_list .tag_view_list_tags'));

        // If the new focus would've been inside the now redrawn tag list, we should at least move back the focus to the current name
        // Otherwise tab-navigation gets a bit weird
        if (evt.relatedTarget instanceof HTMLElement && $(evt.relatedTarget).closest('#tag_view_list')) {
            $(`#tag_view_list .tag_view_item[id="${tagId}"] .tag_view_name`)[0]?.focus();
        }

        const newOrder = $('#tag_view_list .tag_view_item').map((_, el) => el.id).get();
        const orderChanged = !oldOrder.every((id, index) => id === newOrder[index]);
        if (orderChanged) {
            flashHighlight($(`#tag_view_list .tag_view_item[id="${tagId}"]`));
        }
    });

    registerTagsSlashCommands();
    restoreSavedTagFilters();
}
