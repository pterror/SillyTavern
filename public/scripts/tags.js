import { DOMPurify } from '../lib.js';

import {
    getCurrentCharacter,
    getSelectionState,
    saveSettingsDebounced,
    menu_type,
    buildAvatarList,
} from '../script.js';
import { entitiesFilter, printCharactersDebounced, DEFAULT_PRINT_TIMEOUT, printCharacters, setFilterDataFromUser, getUnheldRowTagIds, setUnheldRowTagIds, redrawUnheldRows } from './character-list.js';
import { getRequestHeaders } from './request-headers.js';
import { eventSource, event_types } from './events.js';
import { characters, charactersStore, exposedCharacters, exposedGroups, onExposedEntitiesChange } from './character-store.js';
import { FILTER_TYPES, FILTER_STATES, DEFAULT_FILTER_STATE, isFilterState, FilterHelper } from './filters.js';

import { groupCandidatesFilter, groupMembersFilter, selected_group } from './group-chats.js';
import { groups, groupsStore } from './group-store.js';
import { download, onlyUnique, parseJsonFile, uuidv4, getSortableDelay, flashHighlight, equalsIgnoreCaseAndAccents, includesIgnoreCaseAndAccents, removeFromArray, debounce, findChar, findCharAsync, escapeHtml } from './utils.js';
import { power_user, invalidateCharactersFuseIndex, invalidateGroupsFuseIndex, invalidateTagsFuseIndex } from './power-user.js';
import { EntityStore, onAnyEntityStoreChange } from './entity-store.js';
import { SlashCommandParser } from './slash-commands/SlashCommandParser.js';
import { SlashCommand } from './slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from './slash-commands/SlashCommandArgument.js';
import { POPUP_RESULT, POPUP_TYPE, Popup, callGenericPopup } from './popup.js';
import { debounce_timeout } from './constants.js';
import { INTERACTABLE_CONTROL_CLASS } from './keyboard.js';
import { commonEnumProviders } from './slash-commands/SlashCommandCommonEnumsProvider.js';
import { renderTemplateAsync } from './templates.js';
import { t, translate } from './i18n.js';
import { accountStorage } from './util/AccountStorage.js';
import { enumTypes, SlashCommandEnumValue } from './slash-commands/SlashCommandEnumValue.js';
import { contentHashOf } from './hash-utils.js';
import { refreshUnderlayClips, registerUnderlayClip, scrollContainerOf, underlayClip } from './util/underlay-clip.js';
import { dropOldTagsCache } from './tags-cache.js';
import { beginLocalTagChange, isFetchedTagIdsCurrent, tagFetchStamp } from './tag-fetch-stamps.js';
import { characterRepository, parseQueryTotal } from './character-repository.js';

export {
    TAG_FOLDER_TYPES,
    TAG_FOLDER_DEFAULT_TYPE,
    exportedTags as tags,
    filterByTagState,
    isBogusFolder,
    isBogusFolderOpen,
    chooseBogusFolder,
    getTagBlock,
    loadTagsSettings,
    renameTagKey,
    reindexTagAssignments,
    printTagFilters,
    getTagsList,
    printTagList,
    appendTagToList,
    createTagMapFromList,
    importTags,
    sortTags,
    compareTagsForSort,
    removeTagFromMap,
    getHeldAssignedTagIds,
    tag_map,
    tagsStore,
    isTagAssignedToKey,
    mergeServerTagDefinitions,
    rereadResidentEntityTagIds,
};

const CHARACTER_FILTER_SELECTOR = '#rm_characters_block .rm_tag_filter';
const GROUP_FILTER_SELECTOR = '#rm_group_add_members_header ~ .rm_tag_controls .rm_tag_filter';
const GROUP_MEMBERS_FILTER_SELECTOR = '#rm_group_members_header ~ .rm_tag_controls .rm_tag_filter';
const TAG_TEMPLATE = $('#tag_template .tag');
const FOLDER_TEMPLATE = $('#bogus_folder_template .bogus_folder_select');
const VIEW_TAG_TEMPLATE = $('#tag_view_template .tag_view_item');

/**
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

    if ($element.closest('#currentGroupMembers').length > 0) {
        return groupMembersFilter;
    }

    if ($element.closest('#unaddedCharList').length > 0) {
        return groupCandidatesFilter;
    }

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
        if (tag.id === ACTIONABLE_TAGS.FAV.id) {
            return true;
        }
        if (tag.id === ACTIONABLE_TAGS.GROUP.id || tag.id === ACTIONABLE_TAGS.FOLDER.id) {
            return false;
        }
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
 * Keeps the name of a tag a list is filtered by next to the saved filter, so the filter can still be named to the
 * user when the tag was deleted while this browser had no tab open to see it.
 * @param {string} storagePrefix
 * @param {string} tagId
 * @param {string} state The filter's state; a state that filters nothing drops the name.
 * @param {string} [name]
 */
function saveTagFilterName(storagePrefix, tagId, state, name) {
    const key = `${storagePrefix}_tagname_${tagId}`;
    if (state !== 'SELECTED' && state !== 'EXCLUDED') {
        accountStorage.removeItem(key);
    } else if (typeof name === 'string') {
        accountStorage.setItem(key, name);
    }
}

/**
 * Checks if the given filter helper is the main character list filter.
 * @param {FilterHelper} filterHelper - The filter helper to check
 * @returns {boolean} True if this is the main character list
 */
function isMainCharacterList(filterHelper) {
    return filterHelper === entitiesFilter;
}

/**
 * What this file last put in each held tag's `filter_state`: the filter this browser has saved for the tag on the
 * main character list. A different value on the object is a change an extension made.
 * @type {WeakMap<Tag, string>}
 */
const tagFilterStatesShown = new WeakMap();

/**
 * @param {string} tagId
 * @returns {string} the filter this browser has saved for the tag on the main character list
 */
function savedMainListTagFilterState(tagId) {
    const state = accountStorage.getItem(`${getFilterStorageKey(entitiesFilter)}_tag_${tagId}`);
    return state && Object.hasOwn(FILTER_STATES, state) ? state : DEFAULT_FILTER_STATE;
}

/** @param {Tag} tag @param {string} state */
function setTagFilterState(tag, state) {
    tag.filter_state = state;
    tagFilterStatesShown.set(tag, state);
}

/**
 * Gives a tag object this browser's saved filter. A `filter_state` that came with the object is not this browser's:
 * upstream stores the field with the definition, which every browser shares.
 * @param {Tag} tag
 */
function showSavedTagFilterState(tag) {
    setTagFilterState(tag, savedMainListTagFilterState(tag.id));
}

/**
 * Takes in a change an extension made to a held tag's `filter_state`: it becomes the tag's filter on the main
 * character list, as a click on the tag there does.
 * @param {Tag} tag
 */
function takeInTagFilterState(tag) {
    const shown = tagFilterStatesShown.get(tag);
    if (shown === undefined) {
        // An object an extension put in place of the one this file held.
        showSavedTagFilterState(tag);
        return;
    }
    const state = tag.filter_state ?? DEFAULT_FILTER_STATE;
    if (state === shown) return;
    tagFilterStatesShown.set(tag, state);
    if (!Object.hasOwn(FILTER_STATES, state)) return;

    accountStorage.setItem(`${getFilterStorageKey(entitiesFilter)}_tag_${tag.id}`, state);
    saveTagFilterName(getFilterStorageKey(entitiesFilter), tag.id, state, tag.name);
    $(CHARACTER_FILTER_SELECTOR).find('.tag:not(.actionable)').filter((_, element) => element.id === tag.id)
        .each((_, element) => { toggleTagThreeState($(element), { stateOverride: state }); });
    const { selected, excluded } = entitiesFilter.getFilterData(FILTER_TYPES.TAG);
    const others = (/** @type {string[]} */ ids) => (Array.isArray(ids) ? ids : []).filter(id => id !== tag.id);
    setFilterDataFromUser(entitiesFilter, FILTER_TYPES.TAG, {
        excluded: state === 'EXCLUDED' ? [...others(excluded), tag.id] : others(excluded),
        selected: state === 'SELECTED' ? [...others(selected), tag.id] : others(selected),
    });
}

/**
 * @param {Tag} tag
 * @returns {Tag} `tag` as the server is given it. `filter_state` is left out: it is this browser's, and a stored
 *   definition is every browser's.
 */
function tagDefinitionToStore(tag) {
    const definition = { ...tag };
    delete definition.filter_state;
    return definition;
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
 * Built lazily: tags.js and filters.js import each other, so a top-level reference here
 * could run before filters.js's own exports have initialized.
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
 * The tag definitions this tab holds: those something on screen or a held character or group needs (see
 * sweepHeldTags()). Always the same array.
 * @type {Tag[]}
 */
const tags = [];

/**
 * Upstream's export `tags`, and a plain array like upstream's, so it can be cloned, posted to a worker or put in
 * IndexedDB. Here it holds the tags of the characters and groups extensions are shown (the current character, or the
 * open group and its members, as `tag_map` and `getContext().characters` do), and the tags an extension put into it.
 * Always the same array: it is refilled in place, with the same objects `tags` holds.
 *
 * Extensions change it directly, and a plain array can't report that. What they changed is found by comparing it
 * with exportedIndex, what this file last put in it (see takeInTagsExportWrites()). That comparison runs when a
 * settings save is asked for, which is how upstream's extensions get `tags` stored, whenever `tag_map` is read or
 * written, and before every refill. A tag put in is then created on the server, and a changed field is stored with
 * the settings save itself (see storeTagChangesMadeThroughExport()). A tag taken out is not deleted: deleting a tag
 * on the server also takes it off every character and group, which upstream's removal from this array doesn't, so a
 * tag put back later would have lost them. It is put back instead, with a warning.
 * @type {Tag[]}
 */
const exportedTags = [];

/**
 * What this file last put in `exportedTags`, by id. A difference from it is an extension's change.
 * @type {Map<string, Tag>}
 */
const exportedIndex = new Map();

/**
 * A tag an extension put into the exported `tags` is not in the index until it is taken in. Lookups by id find it all
 * the same.
 * @extends {EntityStore<Tag>}
 */
class TagStore extends EntityStore {
    /** @param {Tag[]} array */
    constructor(array) {
        super(array, tag => tag.id);
    }

    /** @param {string} id @returns {Tag|undefined} */
    get(id) {
        const indexed = super.get(id);
        if (indexed) return indexed;
        const exported = exportedTags.find(tag => isTagObject(tag) && tag.id === id);
        if (exported || this.array.length === this.byId.size) return exported;
        return this.array.find(tag => isTagObject(tag) && tag.id === id);
    }

    /** @param {string} id @returns {boolean} */
    has(id) {
        return this.get(id) !== undefined;
    }
}

/**
 * A cache of all cut-off tag lists that got expanded until the last reload. They will be printed expanded again.
 * It contains the key of the entity.
 * @type {string[]} ids
 */
let expanded_tags_cache = [];

/**
 * Wraps the same `tags` array in place, so other call sites reading `tags` directly keep working unchanged.
 * @type {EntityStore<Tag>}
 */
let tagsStore = new TagStore(tags);

/**
 * Resolves an entity key (character avatar or group id) to that entity's own, resident `tag_ids` array -
 * both characters and groups carry their tag assignments as a server-stamped field on the entity itself (see
 * `stampDbTagIds()` in characters.js and its group-side counterpart in groups.js), so there's no separate map
 * for this to keep in sync with.
 * @param {string} key
 * @returns {string[]|undefined} undefined if `key` isn't a currently-resident character or group
 */
function resolveTagIdsArray(key) {
    const character = charactersStore.get(key);
    if (character) {
        if (!Array.isArray(character.tag_ids)) character.tag_ids = [];
        return character.tag_ids;
    }
    const group = groupsStore.get(key);
    if (group) {
        if (!Array.isArray(group.tag_ids)) group.tag_ids = [];
        return group.tag_ids;
    }
    return undefined;
}

/** Every currently-resident character/group key paired with its live `tag_ids` array. */
function* allTagIdsEntries() {
    for (const character of charactersStore.getAll()) {
        if (!character.avatar) continue;
        if (!Array.isArray(character.tag_ids)) character.tag_ids = [];
        yield /** @type {[string, string[]]} */ ([character.avatar, character.tag_ids]);
    }
    for (const group of groupsStore.getAll()) {
        if (!group.id) continue;
        if (!Array.isArray(group.tag_ids)) group.tag_ids = [];
        yield /** @type {[string, string[]]} */ ([String(group.id), group.tag_ids]);
    }
}

/**
 * The keys of the characters and groups whose tags something on screen may show: every one the page holds, and the
 * character rows on screen the page doesn't hold.
 * @param {Map<string, string[]>} unheldRows - getUnheldRowTagIds()
 * @returns {string[]}
 */
function onScreenEntityKeys(unheldRows) {
    const keys = [];
    for (const [key] of allTagIdsEntries()) keys.push(key);
    for (const key of unheldRows.keys()) keys.push(key);
    return keys;
}

/** @param {string} key @returns {string[]} */
function getTagIdsForKey(key) {
    return resolveTagIdsArray(key) ?? [];
}

/** @param {string} key @param {string} tagId @returns {boolean} */
function isTagAssignedToKey(key, tagId) {
    return getTagIdsForKey(key).includes(tagId);
}

/**
 * The last tag save started for each entity key, so the saves of one entity reach the server in the order they were
 * made: an assign and an unassign of the same tag sent side by side could land in either order.
 * @type {Map<string, Promise<void>>}
 */
const tagSaveChains = new Map();

/** Tag saves started and not yet answered. */
let tagSavesPending = 0;

/**
 * Assigns and unassigns the server did not store, kept until every pending save is answered so they are reported
 * together.
 * @type {{ key: string, tagId: string, assign: boolean }[]}
 */
const tagSavesNotStored = [];

/**
 * Marks a local tag change on `key` as unsaved right away (see tag-fetch-stamps.js), and returns the task that
 * saves it. The task waits for the saves queued for `key` before it.
 * @template T
 * @param {string} key
 * @param {() => Promise<T>} save
 * @returns {() => Promise<T>} the task, answering what `save` answered
 */
function queueTagSave(key, save) {
    const saved = beginLocalTagChange(key);
    tagSavesPending++;
    const before = tagSaveChains.get(key) ?? Promise.resolve();
    /** @type {() => void} */
    let finished;
    const done = /** @type {Promise<void>} */ (new Promise(resolve => { finished = () => resolve(); }));
    tagSaveChains.set(key, done);
    return async () => {
        try {
            await before;
            return await save();
        } finally {
            saved();
            finished();
            if (tagSaveChains.get(key) === done) tagSaveChains.delete(key);
            if (--tagSavesPending === 0) {
                reportTagSavesNotStored();
                rereadEntitiesLeftWaiting();
                refreshUsedTagBars();
            }
        }
    };
}

/**
 * Assigns of a tag the server turned out not to have any more, because someone else deleted it: the entity got the
 * tag it was merged into (`assigned`), nothing (null), or the tag's id with no tag behind it (`tagId`). Kept until
 * every pending save is answered so they are reported together.
 * @type {{ key: string, tagId: string, tagName: string, assigned: string | null }[]}
 */
const tagAssignsNotAsAsked = [];

/** @param {string} key @returns {string} the name of the character or group, or `key` when this tab doesn't hold it */
function nameOfKey(key) {
    return charactersStore.get(key)?.name ?? groupsStore.get(key)?.name ?? key;
}

/**
 * Tells the user which assigns named a tag that was deleted, and what the entity got instead. Drops those tags
 * from this tab and re-reads the entities' tags first, so this tab shows what the server has and the message can
 * name the tag they got.
 */
async function reportTagAssignsNotAsAsked() {
    const notAsAsked = tagAssignsNotAsAsked.splice(0);
    if (!notAsAsked.length) return;

    for (const { tagId, assigned } of notAsAsked) {
        if (!tagsStore.has(tagId)) continue;
        if (assigned !== null && assigned !== tagId) await dropTagLocally(tagId, { replaceWithId: assigned });
        else await resyncRefusedTag(tagId);
    }
    await rereadResidentEntityTagIds(notAsAsked.map(x => x.key).filter(onlyUnique));

    const lines = notAsAsked.map(({ key, tagId, tagName, assigned }) => {
        const tag = escapeHtml(tagName);
        const entityName = escapeHtml(String(nameOfKey(key)));
        if (assigned === null) return t`'${tag}' was not added to ${entityName}: the tag was deleted.`;
        if (assigned === tagId) return t`'${tag}' was deleted, so it does not show on ${entityName}.`;
        const target = escapeHtml(String(tagsStore.get(assigned)?.name ?? assigned));
        return t`'${tag}' was deleted and merged into '${target}', so ${entityName} got '${target}'.`;
    });
    toastr.warning(lines.join('<br />'), t`Tag was deleted`, { escapeHtml: false, timeOut: 0, extendedTimeOut: 0 });
}

/**
 * Tells the user which assigns and unassigns the server did not store, then re-reads the tags of the entities they
 * were for. Each has already been undone in this tab, which stands if the re-read fails too.
 */
function reportTagSavesNotStored() {
    reportTagAssignsNotAsAsked().catch(error => console.error('Could not report assigns of deleted tags:', error));
    const notStored = tagSavesNotStored.splice(0);
    if (!notStored.length) return;

    const lines = notStored.map(({ key, tagId, assign }) => {
        const tagName = escapeHtml(String(tagsStore.get(tagId)?.name ?? tagId));
        const entityName = escapeHtml(String(nameOfKey(key)));
        return assign ? t`'${tagName}' was not added to ${entityName}` : t`'${tagName}' was not removed from ${entityName}`;
    });
    toastr.error(lines.join('<br />'), t`Tags could not be saved`, { escapeHtml: false, timeOut: 0, extendedTimeOut: 0 });

    rereadResidentEntityTagIds(notStored.map(x => x.key).filter(onlyUnique))
        .catch(error => console.error('Could not re-read tags after a failed save:', error));
}

/**
 * Gives `key` the tag in this tab only.
 * @param {string} key @param {string} tagId
 * @returns {boolean} false if `key` doesn't resolve, or it already had `tagId`
 */
function assignTagLocally(key, tagId) {
    const ids = resolveTagIdsArray(key);
    if (!ids || ids.includes(tagId)) return false;
    ids.push(tagId);
    noteOwnTagIdsChange(ids, stored => stored.includes(tagId) ? stored : [...stored, tagId]);
    invalidateCharactersFuseIndex();
    invalidateGroupsFuseIndex();
    return true;
}

/**
 * Takes the tag off `key` in this tab only.
 * @param {string} key @param {string} tagId
 * @returns {boolean} false if `key` doesn't resolve, or it didn't have `tagId`
 */
function unassignTagLocally(key, tagId) {
    const ids = resolveTagIdsArray(key);
    if (!ids) return false;
    const idx = ids.indexOf(tagId);
    if (idx === -1) return false;
    ids.splice(idx, 1);
    noteOwnTagIdsChange(ids, stored => stored.filter(id => id !== tagId));
    invalidateCharactersFuseIndex();
    invalidateGroupsFuseIndex();
    return true;
}

/**
 * Redraws everything that shows the tags of `key` after tag `tagId` was put on it or taken off it outside a user
 * action's own redraw.
 * @param {string} key @param {string} tagId
 */
function redrawTagsOfKey(key, tagId) {
    redrawAfterTagChange([tagId], new Set([key]));
    if (getTagKey() === key) {
        if (selected_group) applyTagsOnGroupSelect(); else applyTagsOnCharacterSelect();
    }
    applyCharacterTagsToMessageDivs();
}

/**
 * Sends the assign of `tagId` to `key`. If the server doesn't store it, the tag is taken off `key` in this tab
 * again and the failure is reported once every pending save is answered.
 * @param {string} key @param {string} tagId
 * @returns {() => Promise<boolean>} the task, answering whether the server gave `key` the tag as asked
 */
function queueAssignSave(key, tagId) {
    return queueTagSave(key, async () => {
        const answer = await assignTagOnServer(key, tagId);
        if (answer?.assigned === tagId) {
            // A tag this tab took for stored, that the server has no definition of: it was deleted. The assignment is
            // stored all the same, so it is not undone here.
            if (!answer.defined && storedTagFields.has(tagId)) {
                tagAssignsNotAsAsked.push({ key, tagId, tagName: String(tagsStore.get(tagId)?.name ?? tagId), assigned: tagId });
            }
            return true;
        }
        if (answer) {
            tagAssignsNotAsAsked.push({ key, tagId, tagName: String(tagsStore.get(tagId)?.name ?? tagId), assigned: answer.assigned });
        } else {
            tagSavesNotStored.push({ key, tagId, assign: true });
        }
        if (!resolveTagIdsArray(key)) {
            // An entity this tab doesn't hold, given the tag through `tag_map`: a failed assign is sent again with the
            // next take-in.
            if (answer) return false;
            const sent = unheldTagMapSent.get(key);
            if (sent?.includes(tagId)) sent.splice(sent.indexOf(tagId), 1);
            return false;
        }
        if (unassignTagLocally(key, tagId)) redrawTagsOfKey(key, tagId);
        return false;
    });
}

/**
 * Sends the unassign of `tagId` from `key`. If the server doesn't store it, the tag is put back on `key` in this
 * tab and the failure is reported once every pending save is answered.
 * @param {string} key @param {string} tagId
 * @returns {() => Promise<boolean>} the task, answering whether the server stored it
 */
function queueUnassignSave(key, tagId) {
    return queueTagSave(key, async () => {
        if (await unassignTagOnServer(key, tagId)) return true;
        tagSavesNotStored.push({ key, tagId, assign: false });
        // The tag may be gone from this tab by now, deleted along with its assignments.
        if (!tagsStore.has(tagId)) return false;
        if (assignTagLocally(key, tagId)) redrawTagsOfKey(key, tagId);
        return false;
    });
}

/**
 * The tag ids of a character or group, held or not: a held one's own `tag_ids`, else the server's.
 * @param {string} key
 * @returns {Promise<string[] | null>} null if the server could not be asked
 */
async function readEntityTagIds(key) {
    const held = resolveTagIdsArray(key);
    if (held) return [...held];
    const answer = await postTagsRead('/api/tags/for', { ids: [key] });
    if (!answer) return null;
    const ids = answer[key];
    return Array.isArray(ids) ? ids.filter(id => typeof id === 'string') : [];
}

/**
 * The tag ids of characters and groups, held or not: held ones' own `tag_ids`, the rest from the server.
 * @param {string[]} keys
 * @returns {Promise<Map<string, string[]> | null>} by key; a key the server doesn't know has no entry. null if the
 *   server could not be asked.
 */
export async function readEntitiesTagIds(keys) {
    /** @type {Map<string, string[]>} */
    const found = new Map();
    const unheld = [];
    for (const key of new Set(keys)) {
        const held = resolveTagIdsArray(key);
        if (held) found.set(key, [...held]);
        else unheld.push(key);
    }
    for (let i = 0; i < unheld.length; i += TAG_READ_MAX_IDS) {
        const answer = await postTagsRead('/api/tags/for', { ids: unheld.slice(i, i + TAG_READ_MAX_IDS) });
        if (!answer) return null;
        for (const [key, ids] of Object.entries(answer)) {
            if (Array.isArray(ids)) found.set(key, ids.filter(id => typeof id === 'string'));
        }
    }
    return found;
}

/**
 * Puts tags on, or takes them off, characters and groups, held or not. A held one changes here at once and is saved
 * as addTagsToEntity() and removeTagFromEntity() save; one this tab doesn't hold is changed on the server only.
 * @param {string[]} keys
 * @param {string[]} tagIds
 * @param {boolean} assign
 * @returns {Promise<void>} settled once every save is answered
 */
export async function saveTagsOnKeys(keys, tagIds, assign) {
    /** @type {Set<string>} */
    const heldKeys = new Set();
    /** @type {(() => Promise<boolean>)[]} */
    const heldSaves = [];
    const unheldKeys = [];
    for (const key of new Set(keys)) {
        if (!resolveTagIdsArray(key)) {
            unheldKeys.push(key);
            continue;
        }
        for (const tagId of tagIds) {
            const changed = assign ? assignTagLocally(key, tagId) : unassignTagLocally(key, tagId);
            if (!changed) continue;
            heldKeys.add(key);
            heldSaves.push(assign ? queueAssignSave(key, tagId) : queueUnassignSave(key, tagId));
        }
    }
    if (heldKeys.size) {
        redrawAfterTagChange(tagIds, heldKeys);
        const openKey = getTagKey();
        if (openKey !== null && heldKeys.has(String(openKey))) {
            if (selected_group) applyTagsOnGroupSelect(); else applyTagsOnCharacterSelect();
        }
        applyCharacterTagsToMessageDivs();
    }
    await Promise.all([
        runWithConcurrency(heldSaves, save => save()),
        runWithConcurrency(unheldKeys, key => saveTagsOnUnheldKey(key, tagIds, assign)),
    ]);
}

/**
 * Puts tags on, or takes them off, a character or group this tab doesn't hold, on the server only, one tag at a
 * time. The character list's page is drawn again once the saves are answered.
 * @param {string} key
 * @param {string[]} tagIds
 * @param {boolean} assign
 * @returns {Promise<boolean>} whether the server stored at least one change as asked
 */
async function saveTagsOnUnheldKey(key, tagIds, assign) {
    const current = await readEntityTagIds(key);
    if (!current) {
        toastr.error(t`The server could not be asked which tags it has.`, t`Tags could not be saved`);
        return false;
    }
    let storedAny = false;
    for (const tagId of tagIds) {
        if (current.includes(tagId) === assign) continue;
        const task = assign ? queueAssignSave(key, tagId) : queueUnassignSave(key, tagId);
        if (await task()) storedAny = true;
    }
    if (storedAny) printCharactersDebounced();
    return storedAny;
}

/**
 * Assigns `tagId` to `key` in this tab at once and sends it to the server.
 * @param {string} key @param {string} tagId
 * @returns {boolean} false if `key` doesn't resolve, or it already had `tagId` (no-op)
 */
function assignTagToKey(key, tagId) {
    const change = assignTagLocally(key, tagId);
    if (change) queueAssignSave(key, tagId)();
    return change;
}

/**
 * Unassigns `tagId` from `key` in this tab at once and sends it to the server.
 * @param {string} key @param {string} tagId
 * @returns {boolean} false if `key` doesn't resolve, or it didn't have `tagId` (no-op)
 */
function unassignTagFromKey(key, tagId) {
    const change = unassignTagLocally(key, tagId);
    if (change) queueUnassignSave(key, tagId)();
    return change;
}

/** Replaces the full set of tag ids for `key`, persisting exactly the delta server-side. No-op if `key` doesn't resolve. */
function setKeyTagIds(key, tagIds) {
    const ids = resolveTagIdsArray(key);
    if (!ids) return;
    const oldSet = new Set(ids);
    const newSet = new Set(tagIds);
    const addedIds = tagIds.filter(id => !oldSet.has(id));
    const removedIds = ids.filter(id => !newSet.has(id));
    ids.length = 0;
    ids.push(...tagIds);
    noteOwnTagIdsChange(ids, () => [...tagIds]);
    invalidateCharactersFuseIndex();
    invalidateGroupsFuseIndex();
    const tasks = [
        ...addedIds.map(tagId => queueAssignSave(key, tagId)),
        ...removedIds.map(tagId => queueUnassignSave(key, tagId)),
    ];
    runWithConcurrency(tasks, task => task());
}

/** Clears `key`'s tag ids (the entity itself isn't removed). No-op if `key` doesn't resolve. */
function removeKeyTagIds(key) {
    const ids = resolveTagIdsArray(key);
    if (!ids) return;
    const removedIds = [...ids];
    ids.length = 0;
    noteOwnTagIdsChange(ids, () => []);
    invalidateCharactersFuseIndex();
    invalidateGroupsFuseIndex();
    // Usually redundant with the server's own deletion cascade, but harmless (unassign tolerates unknown ids).
    runWithConcurrency(removedIds.map(tagId => queueUnassignSave(key, tagId)), task => task());
}

/**
 * Upstream's export of the same name: entity key to tag ids. A plain object of plain arrays like upstream's, so it
 * can be cloned, posted to a worker or put in IndexedDB. Here it has an entry only for the characters and groups
 * extensions are shown (the current character, or the open group and its members: see exposedTagKeys()). Each of
 * those entries is a getter and setter handing out the entity's own tag id array.
 *
 * Extensions change it directly. Reading or assigning an entry is noticed, and what changed in the arrays handed
 * out is sent once the code that did it has finished its turn. A plain object can't report a key being added or
 * deleted; those are found when a settings save is asked for, which is how upstream's extensions get `tag_map`
 * stored, and whenever the characters or groups shown change. A key the extension was given no entry for only ever
 * adds tags, since the extension never saw what that entity has. A change goes to the server as one assign or
 * unassign per tag id that actually changed.
 * @type {{[key: string]: string[]}}
 */
const tag_map = {};

/**
 * The getter of each entry of `tag_map` this file made, by key: the characters and groups the page held when it
 * last looked. A key in here that `tag_map` no longer has, or has with something else in its place, was changed by
 * an extension.
 * @type {Map<string, () => string[]|undefined>}
 */
const tagMapEntryGetters = new Map();

/**
 * The tag id arrays handed out through `tag_map`, each with the entity it belongs to and what it held when this
 * file last wrote it. A difference from that is an extension's change.
 * @type {Map<string[], {key: string, stored: string[]}>}
 */
const tagMapHandedOut = new Map();

/**
 * For each key an extension gave `tag_map` that the page doesn't hold, the tag ids already sent for it. The page
 * doesn't know what the server has for such a key, so its tags are only ever added.
 * @type {Map<string, string[]>}
 */
const unheldTagMapSent = new Map();

let tagExportTakeInQueued = false;
let tagMapKeysToCheck = false;

/**
 * Records a change this file made to `ids` itself, so it isn't taken for an extension's.
 * @param {string[]} ids
 * @param {(stored: string[]) => string[]} change
 */
function noteOwnTagIdsChange(ids, change) {
    const handed = tagMapHandedOut.get(ids);
    if (handed) handed.stored = change(handed.stored);
    // Which tags the exported `tags` holds may change with it.
    queueTagExportTakeIn(false);
}

/** @param {boolean} checkKeys - whether keys may have been added to `tag_map` or deleted from it */
function queueTagExportTakeIn(checkKeys) {
    tagMapKeysToCheck ||= checkKeys;
    if (tagExportTakeInQueued) return;
    tagExportTakeInQueued = true;
    queueMicrotask(takeInTagExportWrites);
}

/**
 * To call when `tags` or `tag_map` may have been changed from outside this file: what changed is found and sent
 * once the calling code has finished its turn.
 */
export function noteTagExportsMayHaveChanged() {
    queueTagExportTakeIn(true);
}

// groupsStore is rebuilt on every refetch, so a listener on the store itself would be lost.
onAnyEntityStoreChange(store => {
    if (store === tagsStore) return;
    queueTagExportTakeIn(true);
    scheduleTagSweep();
});
onExposedEntitiesChange(() => {
    queueTagExportTakeIn(true);
    scheduleTagSweep();
});

/**
 * The keys `tag_map` has an entry for: the characters and groups extensions are shown (D17), the same ones
 * `getContext().characters` and `groups` hold.
 * @returns {string[]}
 */
function exposedTagKeys() {
    return [
        ...exposedCharacters.map(character => character.avatar).filter(Boolean),
        ...exposedGroups.map(group => String(group.id)).filter(Boolean),
    ];
}

function takeInTagExportWrites() {
    tagExportTakeInQueued = false;
    takeInTagsExportWrites();
    takeInTagMapWrites();
    refillExportedTags();
}

/**
 * Takes tags the server no longer has out of the exported `tags`, after taking in what an extension changed in it, so
 * their going is not taken for an extension removing them.
 * @param {Set<string>} ids
 */
function dropFromExportedTags(ids) {
    takeInTagsExportWrites();
    let write = 0;
    for (const tag of exportedTags) {
        if (!isTagObject(tag) || !ids.has(tag.id)) exportedTags[write++] = tag;
    }
    exportedTags.length = write;
    for (const id of ids) {
        exportedIndex.delete(id);
        tagIdsPutInByExtension.delete(id);
    }
}

/**
 * Refills the exported `tags` in place with what it holds now (see exportedTags), after taking in what an extension
 * changed in it.
 */
function refillExportedTags() {
    takeInTagsExportWrites();
    /** @type {Set<string>} */
    const wanted = new Set(tagIdsPutInByExtension);
    for (const key of exposedTagKeys()) {
        for (const id of resolveTagIdsArray(key) ?? []) wanted.add(id);
    }
    const next = tags.filter(tag => isTagObject(tag) && wanted.has(tag.id));
    if (next.length === exportedTags.length && next.every((tag, i) => exportedTags[i] === tag)) return;
    exportedTags.length = 0;
    exportedIndex.clear();
    for (const tag of next) {
        exportedTags.push(tag);
        exportedIndex.set(tag.id, tag);
    }
}

function takeInTagMapWrites() {
    // A tag put into `tags` has to exist on the server before it is assigned.
    if (tagCreatesInFlight.size) {
        Promise.allSettled([...tagCreatesInFlight]).then(takeInTagMapWrites);
        return;
    }
    if (tagMapKeysToCheck) {
        tagMapKeysToCheck = false;
        takeInTagMapKeys();
    }
    sendTagMapChanges();
}

/** @param {string} key @param {string[]} ids */
function noteTagIdsHandedOut(key, ids) {
    if (!tagMapHandedOut.has(ids)) tagMapHandedOut.set(ids, { key, stored: [...ids] });
}

/**
 * Gives `tag_map` its entry for a character or group the page holds.
 * @param {string} key
 */
function defineTagMapEntry(key) {
    const get = () => {
        const ids = resolveTagIdsArray(key);
        if (ids) {
            noteTagIdsHandedOut(key, ids);
            queueTagExportTakeIn(false);
        }
        return ids;
    };
    Object.defineProperty(tag_map, key, {
        get,
        set(value) {
            const ids = resolveTagIdsArray(key);
            if (!ids) {
                // The page no longer holds it, so this is now a key an extension gave.
                tagMapEntryGetters.delete(key);
                Object.defineProperty(tag_map, key, { value, writable: true, enumerable: true, configurable: true });
                queueTagExportTakeIn(true);
                return;
            }
            const next = Array.isArray(value) ? [...value] : [];
            noteTagIdsHandedOut(key, ids);
            ids.length = 0;
            ids.push(...next);
            queueTagExportTakeIn(false);
        },
        enumerable: true,
        configurable: true,
    });
    tagMapEntryGetters.set(key, get);
}

/**
 * Takes in the keys an extension added to `tag_map`, replaced in it or deleted from it, then gives an entry to each
 * character and group the page holds and drops the entries of those it no longer holds.
 */
function takeInTagMapKeys() {
    /** @type {(() => Promise<void>)[]} */
    const unheldSaves = [];

    for (const key of Object.getOwnPropertyNames(tag_map)) {
        const ownGetter = tagMapEntryGetters.get(key);
        if (ownGetter && Object.getOwnPropertyDescriptor(tag_map, key)?.get === ownGetter) continue;

        const written = tag_map[key];
        const wanted = (Array.isArray(written) ? written : []).filter(id => typeof id === 'string').filter(onlyUnique);
        const held = resolveTagIdsArray(key);
        if (!held) {
            tagMapEntryGetters.delete(key);
            let sent = unheldTagMapSent.get(key);
            if (!sent) {
                sent = [];
                unheldTagMapSent.set(key, sent);
            }
            for (const id of wanted) {
                if (sent.includes(id)) continue;
                sent.push(id);
                unheldSaves.push(queueAssignSave(key, id));
            }
            continue;
        }

        unheldTagMapSent.delete(key);
        if (ownGetter) {
            // The extension could read what the entity had, so what it put in its place is the whole set.
            noteTagIdsHandedOut(key, held);
            held.length = 0;
            held.push(...wanted);
        } else {
            // `tag_map` had no entry for it, so the extension never saw what the entity has: its tags only add.
            for (const id of wanted) assignTagToKey(key, id);
        }
        defineTagMapEntry(key);
    }

    for (const key of [...tagMapEntryGetters.keys()]) {
        if (Object.hasOwn(tag_map, key)) continue;
        // Deleted by an extension, which in upstream leaves the entity with no tags.
        tagMapEntryGetters.delete(key);
        const held = resolveTagIdsArray(key);
        if (held) {
            noteTagIdsHandedOut(key, held);
            held.length = 0;
        }
    }
    for (const key of [...unheldTagMapSent.keys()]) {
        if (!Object.hasOwn(tag_map, key)) unheldTagMapSent.delete(key);
    }

    const exposedKeys = new Set();
    for (const key of exposedTagKeys()) {
        exposedKeys.add(key);
        if (!tagMapEntryGetters.has(key)) defineTagMapEntry(key);
    }
    for (const key of [...tagMapEntryGetters.keys()]) {
        if (exposedKeys.has(key)) continue;
        delete tag_map[key];
        tagMapEntryGetters.delete(key);
    }

    if (unheldSaves.length) runWithConcurrency(unheldSaves, save => save());
}

/**
 * Sends what an extension changed in the arrays handed out through `tag_map`, as one assign or unassign per tag id
 * that actually changed, so a clear followed by a refill sends only the difference.
 */
function sendTagMapChanges() {
    /** @type {(() => Promise<void>)[]} */
    const unheldSaves = [];
    for (const [ids, { key, stored }] of [...tagMapHandedOut]) {
        const held = resolveTagIdsArray(key);
        // The entity got another array, or the page no longer holds it: nothing reads this one any more.
        if (held !== ids) tagMapHandedOut.delete(ids);

        const after = ids.filter(id => typeof id === 'string').filter(onlyUnique);
        const added = after.filter(id => !stored.includes(id));
        const removed = stored.filter(id => !after.includes(id));
        if (!added.length && !removed.length) continue;

        if (held === ids) {
            // The assign and unassign below make the change themselves, from what the array held before it.
            ids.length = 0;
            ids.push(...stored);
        }
        if (held) {
            for (const id of added) assignTagToKey(key, id);
            for (const id of removed) unassignTagFromKey(key, id);
        } else {
            for (const id of added) unheldSaves.push(queueAssignSave(key, id));
        }
    }
    if (unheldSaves.length) runWithConcurrency(unheldSaves, save => save());
}

/**
 * What this tab last knew the server to store for each tag it holds, by id. `filter_state` belongs to this browser
 * and is left out. A tag's fields are compared against this to find what an extension changed on the object.
 * @type {Map<string, Record<string, any>>}
 */
const storedTagFields = new Map();

/** @param {any} tag @returns {tag is Tag} */
function isTagObject(tag) {
    return !!tag && typeof tag === 'object' && typeof tag.id === 'string' && tag.id !== '';
}

/** @param {any} value @returns {boolean} whether a settings save could carry it */
function isStorableTagValue(value) {
    return value !== undefined && typeof value !== 'function' && typeof value !== 'symbol';
}

/** @param {any} a @param {any} b */
function sameTagValue(a, b) {
    if (a === b) return true;
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
    return JSON.stringify(a) === JSON.stringify(b);
}

/** @param {Record<string, any>} fields @returns {Record<string, any>} */
function copyTagFields(fields) {
    /** @type {Record<string, any>} */
    const copy = {};
    for (const [key, value] of Object.entries(fields)) {
        if (key === 'filter_state' || !isStorableTagValue(value)) continue;
        copy[key] = value !== null && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : value;
    }
    return copy;
}

/** @param {Tag} tag - as the server stores it */
function noteStoredTag(tag) {
    if (isTagObject(tag)) storedTagFields.set(tag.id, copyTagFields(tag));
}

/**
 * Puts a tag the server stores into `tags`, indexed at once so it isn't taken for one an extension put in.
 * @param {Tag} tag
 */
function addStoredTag(tag) {
    tags.push(tag);
    tagsStore.byId.set(tag.id, tag);
    noteStoredTag(tag);
    showSavedTagFilterState(tag);
    scheduleTagSweep();
    queueTagExportTakeIn(false);
}

/**
 * Ids of the tags an extension put into `tags` in this tab. They stay held: an extension that put a tag in expects
 * to find it there.
 * @type {Set<string>}
 */
const tagIdsPutInByExtension = new Set();

/** How long after the last take-in or change of what is on screen the held tags are swept. */
const TAG_SWEEP_DELAY_MS = 2000;
/** @type {ReturnType<typeof setTimeout> | null} */
let tagSweepTimer = null;

/** Sweeps the held tags (sweepHeldTags()) once things have settled. */
function scheduleTagSweep() {
    if (tagSweepTimer !== null) return;
    tagSweepTimer = setTimeout(() => {
        tagSweepTimer = null;
        sweepHeldTags();
    }, TAG_SWEEP_DELAY_MS);
}

/**
 * The ids of the tags something needs held: the tags of the characters and groups the page holds; every tag drawn
 * on screen (pills, Manage Tags rows, folder tiles); the tags the filters are set on; and the tags an extension put
 * into `tags`, or that are being created.
 * @returns {Set<string>}
 */
function tagIdsInUse() {
    /** @type {Set<string>} */
    const ids = new Set();
    for (const [, tagIds] of allTagIdsEntries()) {
        for (const id of tagIds) ids.add(id);
    }
    document.querySelectorAll('.tag[id], .tag_view_item[id], [tagid]').forEach((el) => {
        const id = el.getAttribute('tagid') ?? el.id;
        if (id) ids.add(id);
    });
    for (const helper of [groupCandidatesFilter, groupMembersFilter, entitiesFilter]) {
        const data = helper.getFilterData(FILTER_TYPES.TAG);
        for (const id of [...(data?.selected ?? []), ...(data?.excluded ?? [])]) ids.add(id);
    }
    for (const id of tagIdsPutInByExtension) ids.add(id);
    for (const id of tagIdsBeingCreated) ids.add(id);
    for (const id of tagsAddedThroughExport.keys()) ids.add(id);
    return ids;
}

/**
 * Lets go of the held tags nothing needs (tagIdsInUse()), keeping one an extension changed and hasn't stored yet.
 * `tags` and its index change in the same turn, so letting go is never taken for an extension removing a tag.
 */
function sweepHeldTags() {
    // What an extension changed in `tags` is taken in first.
    takeInTagsExportWrites();
    const inUse = tagIdsInUse();
    /** @type {string[]} */
    const letGo = [];
    let write = 0;
    for (const tag of tags) {
        const keep = !isTagObject(tag) || inUse.has(tag.id) || !storedTagFields.has(tag.id) || tagFieldsChangedOnObject(tag).patch !== null;
        if (keep) tags[write++] = tag;
        else letGo.push(tag.id);
    }
    if (!letGo.length) return;
    tags.length = write;
    for (const id of letGo) storedTagFields.delete(id);
    tagsStore.reindex();
    invalidateTagsFuseIndex();
    invalidateCharactersFuseIndex();
    invalidateGroupsFuseIndex();
    refillExportedTags();
}

/** @param {string} id @param {Record<string, any>} fields - the fields the server now stores */
function noteStoredTagFields(id, fields) {
    const stored = storedTagFields.get(id);
    if (stored) Object.assign(stored, copyTagFields(fields));
}

/**
 * @param {Tag} tag
 * @returns {{ patch: Record<string, any> | null, lacksStoredField: boolean }} patch: the fields of `tag` that differ
 *   from what the server stores. A field `tag` doesn't have is never part of it: the server keeps its own.
 */
function tagFieldsChangedOnObject(tag) {
    const stored = storedTagFields.get(tag.id);
    /** @type {Record<string, any> | null} */
    let patch = null;
    for (const key of Object.keys(tag)) {
        const value = tag[key];
        if (key === 'id' || key === 'filter_state' || !isStorableTagValue(value)) continue;
        if (sameTagValue(value, stored[key])) continue;
        patch ??= {};
        patch[key] = value;
    }
    const lacksStoredField = Object.keys(stored).some(key => !Object.hasOwn(tag, key));
    return { patch, lacksStoredField };
}

/**
 * Tags put into `tags` through the export whose create the server hasn't stored yet.
 * @type {Map<string, Tag>}
 */
const tagsAddedThroughExport = new Map();

/** @type {Set<Promise<void>>} */
const tagCreatesInFlight = new Set();
/** @type {Set<string>} */
const tagIdsBeingCreated = new Set();

/**
 * Works out what an extension put into the exported `tags` and took out of it, by comparing it with exportedIndex,
 * what this file last put in. A tag put in joins the held tags and, unless the server has it, is created. A tag taken
 * out is put back. A clear followed by a refill takes out only the tags the refill left out, and a tag put back as a
 * new object with the same id takes that object's place.
 */
function takeInTagsExportWrites() {
    let differs = exportedTags.length !== exportedIndex.size;
    for (let i = 0; !differs && i < exportedTags.length; i++) {
        differs = exportedIndex.get(exportedTags[i]?.id) !== exportedTags[i];
    }
    if (!differs) return;

    const afterIds = new Set();
    let heldChanged = false;
    for (const tag of exportedTags) {
        if (!isTagObject(tag)) continue;
        afterIds.add(tag.id);
        if (exportedIndex.get(tag.id) === tag) continue;
        tagIdsPutInByExtension.add(tag.id);
        const held = tagsStore.byId.get(tag.id);
        if (held !== tag) {
            if (held) {
                const at = tags.indexOf(held);
                if (at !== -1) tags[at] = tag; else tags.push(tag);
            } else {
                tags.push(tag);
            }
            heldChanged = true;
        }
        if (!storedTagFields.has(tag.id)) tagsAddedThroughExport.set(tag.id, tag);
    }
    /** @type {Tag[]} */
    const putBack = [];
    for (const [id, tag] of exportedIndex) {
        if (afterIds.has(id)) continue;
        tagsAddedThroughExport.delete(id);
        if (storedTagFields.has(id) || tagIdsBeingCreated.has(id)) putBack.push(tag);
    }
    for (const tag of putBack) exportedTags.push(tag);
    if (putBack.length) {
        toastr.warning(
            `${putBack.map(tag => `'${escapeHtml(String(tag.name ?? tag.id))}'`).join(', ')}<br />${t`Delete a tag in Manage Tags.`}`,
            t`An extension removed these tags from the tag list. They were not deleted.`,
            { escapeHtml: false, timeOut: 0, extendedTimeOut: 0 },
        );
    }

    exportedIndex.clear();
    for (const tag of exportedTags) {
        if (isTagObject(tag)) exportedIndex.set(tag.id, tag);
    }
    if (heldChanged) {
        tagsStore.reindex();
        invalidateTagsFuseIndex();
        invalidateCharactersFuseIndex();
        invalidateGroupsFuseIndex();
    }
    sendTagsAddedThroughExport();
}

/**
 * @param {string} path
 * @param {object} body
 * @returns {Promise<{ id: string, reason: string }[] | null>} what the server refused, or null if the request failed
 */
async function postTagWrite(path, body) {
    try {
        const response = await fetch(path, {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(body),
            cache: 'no-cache',
        });
        if (!response.ok) throw new Error(response.statusText);
        const { refused } = await response.json();
        return refused ?? [];
    } catch (error) {
        console.error(`${path} failed:`, error);
        return null;
    }
}

/**
 * @param {string} title
 * @param {{ name: string, reason: string }[]} refused
 */
function warnRefusedExportTagChanges(title, refused) {
    if (!refused.length) return;
    const lines = refused.map(r => `${escapeHtml(r.name)}: ${TAG_REFUSAL_REASONS[r.reason] ?? escapeHtml(r.reason)}`);
    toastr.warning(lines.join('<br />'), title, { escapeHtml: false, timeOut: 0, extendedTimeOut: 0 });
}

/**
 * Sends a create for every tag added through the export that isn't being created already. A failed create stays
 * in tagsAddedThroughExport and is sent again with the next settings save.
 */
function sendTagsAddedThroughExport() {
    /** @type {Tag[]} */
    const toCreate = [];
    for (const [id, tag] of tagsAddedThroughExport) {
        if (tagsStore.get(id) !== tag) tagsAddedThroughExport.delete(id);
        else if (!tagIdsBeingCreated.has(id)) toCreate.push(tag);
    }
    if (!toCreate.length) return;
    for (const tag of toCreate) tagIdsBeingCreated.add(tag.id);

    const run = (async () => {
        /** @type {string[]} */
        const storedIds = [];
        /** @type {{ id: string, name: string, reason: string }[]} */
        const refused = [];
        await runWithConcurrency(toCreate, async (tag) => {
            const answer = await postTagWrite('/api/tags/create', { tag: tagDefinitionToStore(tag) });
            tagIdsBeingCreated.delete(tag.id);
            if (!answer) return;
            if (tagsAddedThroughExport.get(tag.id) === tag) tagsAddedThroughExport.delete(tag.id);
            if (answer.length) {
                refused.push({ id: tag.id, name: String(tag.name ?? tag.id), reason: answer[0].reason });
            } else {
                noteStoredTag(tag);
                showSavedTagFilterState(tag);
                storedIds.push(tag.id);
            }
        });

        warnRefusedExportTagChanges(t`Tags an extension added were not saved`, refused);
        for (const { id } of refused) await resyncRefusedTag(id);
        if (!storedIds.length) return;
        // The server gave each new tag its sort_order.
        await takeStoredFieldsTagsLack(storedIds);
        await eventSource.emit(event_types.SETTINGS_UPDATED);
    })().catch(error => console.error('Error storing tags added through the tags export:', error));

    tagCreatesInFlight.add(run);
    run.finally(() => tagCreatesInFlight.delete(run));
}

/**
 * Gives each of the tags `ids` the fields the server stores for it that its object here doesn't have. Fields the
 * object does have are left as they are, so a change an extension has made since isn't undone.
 * @param {string[]} ids
 */
async function takeStoredFieldsTagsLack(ids) {
    for (let i = 0; i < ids.length; i += TAG_READ_MAX_IDS) {
        const answer = await postTagsRead('/api/tags/by-ids', { ids: ids.slice(i, i + TAG_READ_MAX_IDS) });
        if (!answer || !Array.isArray(answer.tags)) return;
        for (const serverTag of answer.tags) {
            const local = isTagObject(serverTag) ? tagsStore.get(serverTag.id) : undefined;
            if (!local) continue;
            for (const [key, value] of Object.entries(serverTag)) {
                if (key !== 'filter_state' && !Object.hasOwn(local, key)) local[key] = value;
            }
            noteStoredTag(serverTag);
        }
    }
}

let storingTagExportChanges = false;
let tagExportChangesArrivedWhileStoring = false;

/**
 * Stores the fields extensions changed on the objects in the exported `tags` since the last settings save, as edits
 * of just those fields. Upstream stores `tags` with the settings, so this runs with every settings save.
 */
export async function storeTagChangesMadeThroughExport() {
    if (storingTagExportChanges) {
        tagExportChangesArrivedWhileStoring = true;
        return;
    }
    storingTagExportChanges = true;
    try {
        do {
            tagExportChangesArrivedWhileStoring = false;
            await storeTagExportChangesOnce();
        } while (tagExportChangesArrivedWhileStoring);
    } catch (error) {
        console.error('Error storing tag changes made through the tags export:', error);
    } finally {
        storingTagExportChanges = false;
    }
}

async function storeTagExportChangesOnce() {
    tagMapKeysToCheck = true;
    takeInTagExportWrites();
    sendTagsAddedThroughExport();
    if (tagCreatesInFlight.size) await Promise.allSettled([...tagCreatesInFlight]);

    /** @type {{ tag: Tag, patch: Record<string, any> }[]} */
    const edits = [];
    /** @type {string[]} */
    const toReread = [];
    for (const tag of tags) {
        if (!isTagObject(tag) || !storedTagFields.has(tag.id)) continue;
        takeInTagFilterState(tag);
        const { patch, lacksStoredField } = tagFieldsChangedOnObject(tag);
        if (patch) edits.push({ tag, patch });
        if (lacksStoredField) toReread.push(tag.id);
    }

    let storedAny = false;
    let failedAny = false;
    /** @type {{ id: string, name: string, reason: string }[]} */
    const refused = [];
    await runWithConcurrency(edits, async ({ tag, patch }) => {
        const answer = await postTagWrite('/api/tags/edit', { id: tag.id, patch });
        if (!answer) {
            failedAny = true;
        } else if (answer.length) {
            refused.push({ id: tag.id, name: String(tag.name ?? tag.id), reason: answer[0].reason });
        } else {
            noteStoredTagFields(tag.id, patch);
            storedAny = true;
        }
    });
    warnRefusedExportTagChanges(t`Tag changes an extension made were not saved`, refused);
    for (const { id } of refused) await resyncRefusedTag(id);

    if (failedAny) {
        toastr.error(t`They are sent again with the next settings save.`, t`Some tag changes an extension made could not be saved`);
    }

    // A tag object an extension put in place of another may lack fields the server stores.
    await takeStoredFieldsTagsLack(toReread);

    if (storedAny) {
        await eventSource.emit(event_types.SETTINGS_UPDATED);
    }
}

/**
 * Removes `tagId` from every resident key, putting `replaceWithId` in its place when given. Sends nothing to the
 * server.
 * @param {string} tagId @param {{replaceWithId?: string}} [options]
 * @returns {string[]} Every key that had `tagId` removed
 */
function removeTagIdLocally(tagId, { replaceWithId } = {}) {
    const affectedKeys = [];
    for (const [key, ids] of allTagIdsEntries()) {
        const idx = ids.indexOf(tagId);
        if (idx === -1) continue;
        ids.splice(idx, 1);
        affectedKeys.push(key);
        if (replaceWithId && !ids.includes(replaceWithId)) ids.push(replaceWithId);
        noteOwnTagIdsChange(ids, () => [...ids]);
    }
    invalidateCharactersFuseIndex();
    invalidateGroupsFuseIndex();
    return affectedKeys;
}

/**
 * Rebuilds `tagsStore` to wrap the current `tags` reference and re-registers its subscribers - needed whenever
 * that reference is reassigned (e.g. `loadTagsSettings`), since a store built against the old reference would
 * keep indexing stale data and a fresh instance carries no subscribers of its own.
 */
function rebuildTagStores() {
    tagsStore = new TagStore(tags);

    tagsStore.onChange(() => {
        invalidateTagsFuseIndex();
        invalidateCharactersFuseIndex();
        invalidateGroupsFuseIndex();
    });

    storedTagFields.clear();
    for (const tag of tags) {
        if (!isTagObject(tag)) continue;
        noteStoredTag(tag);
        showSavedTagFilterState(tag);
    }
}

const TAG_REFUSAL_REASONS = {
    exists: 'already exists',
    deleted: 'was deleted',
    missing: 'no longer exists',
    unreadable: 'stored copy is unreadable',
    same: 'is the tag itself',
};

/**
 * @param {{ id: string, reason: string }[]} refused - from /api/tags/create or /api/tags/edit
 * @param {Tag} tag - the tag the request was about; refused entries carry only its id
 * @param {string} title
 */
function warnRefusedTags(refused, tag, title) {
    if (!refused?.length) return;
    const lines = refused.map(r => `${escapeHtml(tag.name)}: ${TAG_REFUSAL_REASONS[r.reason]}`);
    toastr.warning(`Tag not saved:<br />${lines.join('<br />')}`, title, { escapeHtml: false });
}

/**
 * Asks the server to create `tag`, which this tab doesn't have yet, and puts it into `tags` once the server has
 * stored it.
 * @param {Tag} tag
 * @param {object} [options]
 * @param {boolean} [options.freeName] `tag.name` is only a base: the server picks a name no other tag has, and
 *   `tag` takes that name and the rest of what the server stored.
 * @returns {Promise<'stored' | 'refused' | 'failed'>} 'refused': the user has been told why. If the server already
 *   has a tag with that id, this tab now has the server's copy of it.
 */
async function createTagOnServer(tag, { freeName = false } = {}) {
    // Until this answers, the tag changes feed leaves the id alone: the tag is put into `tags` here.
    tagIdsBeingCreated.add(tag.id);
    try {
        const response = await fetch('/api/tags/create', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(freeName ? { tag: tagDefinitionToStore(tag), freeName } : { tag: tagDefinitionToStore(tag) }),
            cache: 'no-cache',
        });

        if (response.status === 503 && (await response.clone().json().catch(() => null))?.reason === 'tag-names-not-indexed') {
            toastr.warning(t`Tag names are still being indexed after an update. No tag was created. Try again in a moment.`, t`Creating Tag`);
            return 'refused';
        }
        if (!response.ok) {
            throw new Error(`Failed to create tag: ${response.statusText}`);
        }

        const { refused, tag: stored } = await response.json();
        const reason = refused?.[0]?.reason;
        if (!reason && isTagObject(stored)) Object.assign(tag, stored);
        if (!reason || reason === 'exists') {
            addStoredTag(tag);
            invalidateTagsFuseIndex();
            invalidateCharactersFuseIndex();
            invalidateGroupsFuseIndex();
        }
        if (!reason) return 'stored';
        warnRefusedTags(refused, tag, t`Creating Tag`);
        if (reason === 'exists') await resyncRefusedTag(tag.id);
        return 'refused';
    } catch (error) {
        console.error(`Error creating tag ${tag?.id}:`, error);
        return 'failed';
    } finally {
        tagIdsBeingCreated.delete(tag.id);
    }
}

/**
 * Field edits made in this tab's own UI that the server hasn't answered yet, by `${id}\n${field}`. `wanted` is the
 * latest value asked for.
 * @type {Map<string, { wanted: any }>}
 */
const tagFieldEditsInFlight = new Map();

/**
 * Stores `value` as `field` of tag `id`, for an edit made in this tab's own UI. The tag's copy here takes the value
 * only once the server has stored it. A value given while an earlier one is on its way replaces any other waiting
 * and is sent once that one is answered, so edits of one field reach the server in order and one at a time.
 * @param {string} id
 * @param {string} field
 * @param {any} value
 * @param {(stored: any) => void} [onStored] - run with each value the server stored, before it is drawn
 * @returns {Promise<'stored' | 'refused' | 'failed' | 'unchanged' | 'waiting'>} what became of the last value sent.
 *   'unchanged': the tag already had the value, so nothing was sent. 'refused': the user has been told why and this
 *   tab's copy has been made to match the server's. 'failed' is the caller's to tell. 'waiting': an earlier call is
 *   still sending and will send this value after; that call gets the outcome.
 */
async function storeTagField(id, field, value, onStored) {
    const key = `${id}\n${field}`;
    const inFlight = tagFieldEditsInFlight.get(key);
    if (inFlight) {
        inFlight.wanted = value;
        return 'waiting';
    }

    const state = { wanted: value };
    tagFieldEditsInFlight.set(key, state);
    try {
        /** @type {'stored' | 'refused' | 'failed' | 'unchanged'} */
        let outcome = 'unchanged';
        for (;;) {
            const tag = tagsStore.get(id);
            const sending = state.wanted;
            if (!tag || sameTagValue(sending, tag[field])) return outcome;
            outcome = await editTagOnServer(id, { [field]: sending }, tag, () => {
                const current = tagsStore.get(id);
                if (!current) return;
                current[field] = sending;
                noteStoredTagFields(id, { [field]: sending });
                onStored?.(sending);
                TAG_FIELD_REDRAWS[field]?.(current);
            });
            if (outcome !== 'stored') return outcome;
        }
    } finally {
        tagFieldEditsInFlight.delete(key);
    }
}

/**
 * @param {string} id
 * @param {string} notSaved - what was not saved, as a sentence
 */
function tellTagEditFailed(id, notSaved) {
    const name = tagsStore.get(id)?.name ?? id;
    toastr.error(`${escapeHtml(String(name))}: ${escapeHtml(notSaved)}<br />${t`Check the server connection and try again.`}`, t`Tag could not be saved`, { escapeHtml: false });
}

/**
 * Upstream keeps tags in the settings, so extensions hear of a stored tag change through SETTINGS_UPDATED; it is
 * emitted here once the server has stored one.
 * @param {string} id
 * @param {Partial<Tag>} patch - only the changed fields
 * @param {Tag} tag - for its name in a refusal warning
 * @param {() => void} [applyStored] - run once the server has stored the patch, before this tab's copy is cached
 * @returns {Promise<'stored' | 'refused' | 'failed'>} 'refused': this tab's copy has been made to match the server's.
 */
async function editTagOnServer(id, patch, tag, applyStored) {
    try {
        const response = await fetch('/api/tags/edit', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ id, patch }),
            cache: 'no-cache',
        });

        if (!response.ok) {
            throw new Error(`Failed to edit tag: ${response.statusText}`);
        }

        const { refused } = await response.json();
        if (!refused?.length) applyStored?.();
        warnRefusedTags(refused, tag, 'Editing Tag');
        if (refused?.length) {
            await resyncRefusedTag(id);
            return 'refused';
        }
        await eventSource.emit(event_types.SETTINGS_UPDATED);
        refreshUsedTagBars();
        return 'stored';
    } catch (error) {
        console.error(`Error editing tag ${id}:`, error);
        return 'failed';
    }
}

/** At most this many distinct ids per /api/tags/for and /api/tags/by-ids request; more is a 400. */
const TAG_READ_MAX_IDS = 500;

/** Whether the last /api/tags/query answer was that the server can't page tags yet, after an update. */
/** @type {'tag-query-not-ready' | null} Why the last tag query was refused as not ready. */
let tagQueryNotReady = null;

/**
 * One read of /api/tags/query.
 * @param {object} body
 * @returns {Promise<{ rows?: Tag[], cursor?: string | null, more?: boolean, counts?: Record<string, number>, approximate?: string[], hash?: string, unchanged?: boolean, rest?: { count: number, more: boolean } } | 'invalid-cursor' | null>}
 *   null if the request failed. 'invalid-cursor': the server no longer takes the cursor. `unchanged` (only with
 *   `ifHash` in the body): the page is what it was, and the answer has no rows.
 */
async function postTagQuery(body) {
    try {
        const response = await fetch('/api/tags/query', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(body),
            cache: 'no-cache',
        });
        const reason = response.ok ? null : (await response.clone().json().catch(() => null))?.reason;
        tagQueryNotReady = response.status === 503 && reason === 'tag-query-not-ready' ? reason : null;
        if (response.status === 400 && reason === 'invalid-cursor') return 'invalid-cursor';
        if (!response.ok) throw new Error(response.statusText);
        const answer = await response.json();
        if (answer?.unchanged !== true && !Array.isArray(answer?.rows)) throw new Error('no rows in the answer');
        return answer;
    } catch (error) {
        console.error('Error reading a page of tags:', error);
        return null;
    }
}

/**
 * For extensions: one page of the whole tag list from the server, since `tags` and `tag_map` are partial. The body is /api/tags/query's (sort mode, filter, page size,
 * `cursor` from the previous answer).
 * @param {object} query
 * @returns {Promise<{ rows: Tag[], cursor: string | null, more: boolean, counts?: Record<string, number>, approximate?: string[] }>}
 * @throws {Error} if the server can't answer or no longer takes the cursor
 */
export async function queryTags(query) {
    const answer = await postTagQuery({ ...query, ifHash: undefined });
    if (answer === null || answer === 'invalid-cursor' || !Array.isArray(answer.rows)) {
        throw new Error(answer === 'invalid-cursor' ? 'The tag list changed; start again without a cursor.' : 'Could not read the tag list.');
    }
    return /** @type {any} */ (answer);
}

/**
 * @param {string} path
 * @param {object} body
 * @returns {Promise<any>} the parsed answer, or null if the request failed
 */
async function postTagsRead(path, body) {
    const response = await fetch(path, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(body),
        cache: 'no-cache',
    });
    if (!response.ok) {
        console.error(`${path} failed: ${response.statusText}`);
        return null;
    }
    return response.json();
}

/** Tag fields whose value is drawn on screen, each with what redraws it. */
const TAG_FIELD_REDRAWS = {
    /** @param {Tag} tag */
    name: (tag) => {
        $(`.tag[id="${tag.id}"] .tag_name`).text(tag.name);
        drawTagViewName($(`.tag_view_item[id="${tag.id}"] .tag_view_name`), tag);
    },
    /** @param {Tag} tag */
    color: (tag) => redrawTagColorField(tag, 'color', 'background-color'),
    /** @param {Tag} tag */
    color2: (tag) => redrawTagColorField(tag, 'color2', 'color'),
    /** @param {Tag} tag */
    folder_type: (tag) => {
        updateDrawTagFolder($(`.tag_view_item[id="${tag.id}"]`), tag);
        printCharactersDebounced();
    },
    /** @param {Tag} tag */
    is_hidden_on_character_card: (tag) => {
        drawTagHideToggle($(`.tag_view_item[id="${tag.id}"] .eye-toggle`), tag);
        redrawRowsAfterTagHiddenChange(tag.id);
    },
    sort_order: () => redrawAfterTagSortOrderChange(),
};

/**
 * @param {Tag} tag
 * @param {'color'|'color2'} colorField
 * @param {string} cssProperty
 */
function redrawTagColorField(tag, colorField, cssProperty) {
    const newColor = tag[colorField] ?? '';
    const $row = $(`.tag_view_item[id="${tag.id}"]`);
    $row.find('.tag_view_name').css(cssProperty, newColor);
    const $picker = $row.find(`.tag_view_color_picker[data-value="${colorField}"]`);
    if ($picker.length) {
        const defaultColor = $picker.find('toolcool-color-picker').attr('data-default-color');
        $picker.find('.link_icon').toggle(!!newColor && newColor !== defaultColor);
    }
    applyTagColoring(tag.id, cssProperty, newColor);
}

/**
 * After the server refused a create or edit of tag `id`, makes this tab's copy match the server's again: replaces
 * it with the stored definition, or drops it if the server no longer has one.
 * @param {string} id
 */
async function resyncRefusedTag(id) {
    const answer = await postTagsRead('/api/tags/by-ids', { ids: [id] });
    if (!answer || !Array.isArray(answer.tags)) {
        console.error(`Could not re-read refused tag ${id}`);
        return;
    }

    const serverTag = answer.tags.find(t => t?.id === id);
    if (serverTag) {
        await replaceTagFromServer(id, serverTag);
    } else {
        await dropTagLocally(id);
    }
}

/**
 * Makes `local` hold the server's definition, in place. filter_state belongs to this browser, not to the stored
 * definition, so `local` keeps its own.
 * @param {Tag} local
 * @param {Tag} serverTag
 */
function takeServerTagFields(local, serverTag) {
    const hadFilterState = Object.hasOwn(local, 'filter_state');
    const filterState = local.filter_state;
    for (const key of Object.keys(local)) {
        if (!Object.hasOwn(serverTag, key)) delete local[key];
    }
    Object.assign(local, serverTag);
    if (hadFilterState) local.filter_state = filterState; else delete local.filter_state;
    if (!tagFilterStatesShown.has(local)) showSavedTagFilterState(local);
    noteStoredTag(local);
}

/**
 * Reads the definitions of `ids` from the server into `tags`: a tag this tab has takes the server's fields, one it
 * doesn't is added. Draws nothing.
 * @param {string[]} ids
 * @returns {Promise<boolean>} false if a read failed; what was read before it is kept.
 */
async function readTagDefinitionsFromServer(ids) {
    let changed = false;
    try {
        for (let i = 0; i < ids.length; i += TAG_READ_MAX_IDS) {
            const answer = await postTagsRead('/api/tags/by-ids', { ids: ids.slice(i, i + TAG_READ_MAX_IDS) });
            if (!answer || !Array.isArray(answer.tags)) return false;
            for (const serverTag of answer.tags) {
                if (!serverTag || typeof serverTag.id !== 'string') continue;
                const local = tagsStore.get(serverTag.id);
                if (local) {
                    takeServerTagFields(local, serverTag);
                } else {
                    addStoredTag(serverTag);
                }
                changed = true;
            }
            // Per chunk: the next chunk's tagsStore.get() must see the tags this one added.
            tagsStore.reindex();
        }
        return true;
    } finally {
        if (changed) {
            invalidateTagsFuseIndex();
            invalidateCharactersFuseIndex();
            invalidateGroupsFuseIndex();
        }
    }
}

/**
 * @param {string} id
 * @param {Tag} serverTag
 */
async function replaceTagFromServer(id, serverTag) {
    const local = tagsStore.get(id);
    if (!local) return;

    const old = { ...local };
    takeServerTagFields(local, serverTag);

    invalidateTagsFuseIndex();
    invalidateCharactersFuseIndex();
    invalidateGroupsFuseIndex();

    let anyDiffered = false;
    for (const [field, redraw] of Object.entries(TAG_FIELD_REDRAWS)) {
        if (old[field] === local[field]) continue;
        anyDiffered = true;
        redraw(local);
    }
    if (anyDiffered) applyCharacterTagsToMessageDivs();
}

/**
 * Takes tag `fromId` out of every tag filter holding it. With `toId`, that tag takes its place and state, unless it
 * already has a state of its own in that filter.
 * @param {string} fromId
 * @param {string} [toId]
 * @returns {{ held: boolean, moved: boolean }} held: a filter held `fromId`. moved: every filter that did now holds
 *   `toId` in the same state.
 */
function moveTagFilters(fromId, toId) {
    let held = false;
    let moved = true;
    for (const helper of [groupCandidatesFilter, groupMembersFilter, entitiesFilter]) {
        const { selected, excluded } = helper.getFilterData(FILTER_TYPES.TAG);
        const storagePrefix = getFilterStorageKey(helper);
        if (storagePrefix) {
            accountStorage.removeItem(`${storagePrefix}_tag_${fromId}`);
            accountStorage.removeItem(`${storagePrefix}_tagname_${fromId}`);
        }

        let changed = false;
        for (const [state, list] of /** @type {[string, string[]][]} */ ([['SELECTED', selected], ['EXCLUDED', excluded]])) {
            if (!Array.isArray(list)) continue;
            const index = list.indexOf(fromId);
            if (index === -1) continue;
            list.splice(index, 1);
            changed = true;
            if (!toId || selected?.includes(toId) || excluded?.includes(toId)) {
                moved = false;
                continue;
            }
            list.push(toId);
            const target = tagsStore.get(toId);
            if (storagePrefix) {
                accountStorage.setItem(`${storagePrefix}_tag_${toId}`, state);
                saveTagFilterName(storagePrefix, toId, state, target?.name);
            }
            if (target && isMainCharacterList(helper)) setTagFilterState(target, state);
        }
        if (changed) {
            held = true;
            helper.setFilterData(FILTER_TYPES.TAG, { selected, excluded });
        }
    }
    return { held, moved: held && moved };
}

/**
 * Removes tags from this tab only (the server already has no such tags), then re-reads the tags of the characters
 * and groups that carried them, so what the server gave them in their place shows up.
 * @param {{ id: string, replaceWithId?: string }[]} drops - replaceWithId: the tag the server merged `id` into.
 *   Resident entities and tag filters get it in `id`'s place at once, ahead of the re-read.
 * @returns {Promise<Map<string, { held: boolean, moved: boolean }>>} by id, what became of the tag filters on it
 *   (moveTagFilters())
 */
async function dropTagsLocally(drops) {
    /** @type {Map<string, { held: boolean, moved: boolean }>} */
    const filters = new Map();
    if (!drops.length) return filters;
    const needsFullRedraw = tagChangeAffectsCurrentView(drops.flatMap(({ id, replaceWithId }) => replaceWithId ? [id, replaceWithId] : [id]));
    const affectedRowKeys = needsFullRedraw ? null : getRenderedKeysWithAnyTag(new Set(drops.map(({ id }) => id)));

    const dropped = new Set(drops.map(({ id }) => id));
    /** @type {Set<string>} Characters and groups on screen that carried a dropped tag: their tags are read again. */
    const carriers = new Set(getRenderedKeysWithAnyTag(dropped));
    let heldDefinition = false;
    for (const { id, replaceWithId } of drops) {
        for (const key of removeTagIdLocally(id, { replaceWithId })) carriers.add(key);
        filters.set(id, moveTagFilters(id, replaceWithId));
        storedTagFields.delete(id);
        tagsAddedThroughExport.delete(id);
        if (tagsStore.has(id)) heldDefinition = true;
    }

    if (heldDefinition) {
        let write = 0;
        for (const tag of tags) {
            if (!dropped.has(tag.id)) tags[write++] = tag;
        }
        tags.length = write;
        dropFromExportedTags(dropped);
        tagsStore.reindex();
        invalidateTagsFuseIndex();
        invalidateCharactersFuseIndex();
        invalidateGroupsFuseIndex();
    }

    for (const { id } of drops) {
        // An unsaved name has no tag left to go to.
        writeTagNameDraft(id, null);
        $(`.tag[id="${id}"]`).remove();
        $(`.tag_view_item[id="${id}"]`).remove();
    }
    refreshUsedTagBars();
    printTagFilters(tag_filter_type.character);
    printTagFilters(tag_filter_type.group_members_list);
    printTagFilters(tag_filter_type.group_candidates_list);
    if (needsFullRedraw) {
        printCharactersDebounced();
    } else {
        updateEntityRowTags(affectedRowKeys);
    }
    applyCharacterTagsToMessageDivs();

    if (carriers.size) await rereadResidentEntityTagIds([...carriers]);
    return filters;
}

/**
 * dropTagsLocally() for one tag.
 * @param {string} id
 * @param {{ replaceWithId?: string }} [options]
 * @returns {Promise<{ held: boolean, moved: boolean }>} what became of the tag filters on `id` (moveTagFilters())
 */
async function dropTagLocally(id, { replaceWithId } = {}) {
    return (await dropTagsLocally([{ id, replaceWithId }])).get(id);
}

/**
 * Entities whose re-read tags were not taken because a tag save of this tab's for them was unanswered, or was
 * answered after the read began. They are re-read once every pending save is answered.
 * @type {Set<string>}
 */
const tagRereadsWaiting = new Set();

/** Re-reads the entities a re-read left out while this tab's own tag saves for them were pending. */
function rereadEntitiesLeftWaiting() {
    if (!tagRereadsWaiting.size) return;
    const keys = [...tagRereadsWaiting];
    tagRereadsWaiting.clear();
    rereadResidentEntityTagIds(keys).catch(error => console.error('Could not re-read tags after saving:', error));
}

/**
 * Replaces the tag ids of characters and groups on screen with the server's where they differ, and fetches any tag
 * definition the new ids need that this tab doesn't have: a held entity's own, and a character row on screen the
 * page doesn't hold (drawn again with them). Stops at the first failed request, keeping what it already applied.
 * An entity with a tag save of this tab's still unanswered keeps what it shows and is re-read once the saves are
 * answered.
 * @param {string[]} [onlyKeys] - the entities to re-read; every one on screen (onScreenEntityKeys()) when left out
 * @returns {Promise<boolean>} false if a request failed
 */
async function rereadResidentEntityTagIds(onlyKeys) {
    // What an extension changed through `tag_map` is sent before the server's copy is read over it.
    tagMapKeysToCheck = true;
    takeInTagExportWrites();
    const unheldRows = getUnheldRowTagIds();
    const keys = onlyKeys
        ? onlyKeys.filter(key => resolveTagIdsArray(key) || unheldRows.has(key))
        : onScreenEntityKeys(unheldRows);

    /** @type {Set<string>} */
    const changedTagIds = new Set();
    /** @type {Set<string>} */
    const changedKeys = new Set();
    /** @type {Set<string>} */
    const unknownTagIds = new Set();
    /** @type {Map<string, { serverIds: string[], fetchStamp: number }>} */
    const unheldRowsToRedraw = new Map();

    try {
        for (let i = 0; i < keys.length; i += TAG_READ_MAX_IDS) {
            const fetchStamp = tagFetchStamp();
            const answer = await postTagsRead('/api/tags/for', { ids: keys.slice(i, i + TAG_READ_MAX_IDS) });
            if (!answer) {
                console.error('Could not re-read the tags of resident characters and groups');
                return false;
            }
            for (const [key, serverIds] of Object.entries(answer)) {
                if (!Array.isArray(serverIds)) continue;
                const ids = resolveTagIdsArray(key);
                const rowIds = ids ? undefined : unheldRows.get(key);
                if (!ids && !rowIds) continue;
                if (!isFetchedTagIdsCurrent(key, fetchStamp)) {
                    tagRereadsWaiting.add(key);
                    continue;
                }
                for (const tagId of serverIds) {
                    if (!tagsStore.has(tagId)) unknownTagIds.add(tagId);
                }
                if (rowIds) {
                    if (rowIds.length === serverIds.length && rowIds.every((tagId, i) => tagId === serverIds[i])) continue;
                    unheldRowsToRedraw.set(key, { serverIds, fetchStamp });
                    for (const tagId of [...rowIds, ...serverIds]) changedTagIds.add(tagId);
                    continue;
                }
                if (ids.length === serverIds.length && ids.every((tagId, i) => tagId === serverIds[i])) continue;

                const serverSet = new Set(serverIds);
                const localSet = new Set(ids);
                const added = serverIds.filter(tagId => !localSet.has(tagId));
                const removed = ids.filter(tagId => !serverSet.has(tagId));
                ids.splice(0, ids.length, ...serverIds);
                noteOwnTagIdsChange(ids, () => [...serverIds]);
                // The same tags in another order draw the same.
                if (!added.length && !removed.length) continue;
                changedKeys.add(key);
                for (const tagId of [...added, ...removed]) changedTagIds.add(tagId);
            }
        }

        const toFetch = [...unknownTagIds];
        for (let i = 0; i < toFetch.length; i += TAG_READ_MAX_IDS) {
            const answer = await postTagsRead('/api/tags/by-ids', { ids: toFetch.slice(i, i + TAG_READ_MAX_IDS) });
            if (!answer || !Array.isArray(answer.tags)) {
                console.error('Could not read the definitions of tags resident characters and groups now carry');
                return false;
            }
            mergeServerTagDefinitions(answer.tags);
        }
        return true;
    } finally {
        // Drawn once the definitions they need are read, or with what there is when that read failed.
        for (const [key, { serverIds, fetchStamp }] of unheldRowsToRedraw) setUnheldRowTagIds(key, serverIds, fetchStamp);
        if (unheldRowsToRedraw.size && !changedKeys.size) {
            if (tagChangeAffectsCurrentView([...changedTagIds])) printCharactersDebounced();
            refreshUsedTagBars();
        }
        if (changedKeys.size) {
            invalidateCharactersFuseIndex();
            invalidateGroupsFuseIndex();
            redrawAfterTagChange([...changedTagIds], changedKeys);
            // Which tags are used may have changed with them.
            refreshUsedTagBars();
            const openKey = getTagKey();
            if (openKey !== null && changedKeys.has(String(openKey))) {
                if (selected_group) applyTagsOnGroupSelect(); else applyTagsOnCharacterSelect();
            }
            applyCharacterTagsToMessageDivs();
        }
        if (tagSavesPending === 0) rereadEntitiesLeftWaiting();
    }
}

/**
 * Where this tab's characters' and groups' tags are current to in the server's two logs (/api/tags/assignment-changes).
 * null: not known, so the next ask is answered with a re-read.
 * @type {{ sinceSeq: number, sinceGroupsVersion: number } | null}
 */
let entityTagChangesCursor = null;
let entityTagChangesAskQueued = false;
/** @type {Promise<void>} */
let entityTagChangesChain = Promise.resolve();

/**
 * Brings the tags of the characters and groups this tab holds up to the server's: asks which entities' tags may
 * have changed past this tab's cursors, page by page, and re-reads those it holds. When the server can't say, or more
 * log rows remain than this tab holds entities, re-reads the tags of everything it holds instead. A failed request
 * leaves the cursors where they were, so the next ask covers the same changes.
 */
async function takeInEntityTagChanges() {
    for (;;) {
        const page = await postTagsRead('/api/tags/assignment-changes', entityTagChangesCursor ?? {});
        if (!page || typeof page.seq !== 'number' || typeof page.groupsVersion !== 'number') return;

        const rowsLeft = (page.endSeq - page.seq) + (page.endGroupsVersion - page.groupsVersion);
        if (page.reset || (page.hasMore && rowsLeft > onScreenEntityKeys(getUnheldRowTagIds()).length)) {
            // The logs' ends as read before the tags are, so nothing written while they are read is missed.
            if (await rereadResidentEntityTagIds()) {
                entityTagChangesCursor = { sinceSeq: page.endSeq, sinceGroupsVersion: page.endGroupsVersion };
            }
            refreshViewTagList();
            refreshUsedTagBars();
            return;
        }

        const unheldRows = getUnheldRowTagIds();
        const held = (Array.isArray(page.ids) ? page.ids : []).filter(key => typeof key === 'string' && (resolveTagIdsArray(key) || unheldRows.has(key)));
        if (held.length && !await rereadResidentEntityTagIds(held)) return;
        entityTagChangesCursor = { sinceSeq: page.seq, sinceGroupsVersion: page.groupsVersion };
        // Manage Tags shows counts and the filter bars the used tags, which cover the characters and groups this tab
        // doesn't hold too.
        if (Array.isArray(page.ids) && page.ids.length) {
            refreshViewTagList();
            refreshUsedTagBars();
        }
        if (!page.hasMore) return;
    }
}

/**
 * The tags of characters or groups may have changed on the server (a character change message or 'groups-changed' on
 * the changes stream), or the stream is back after a break that may have swallowed such a message. Any number of
 * calls while one ask is waiting its turn make one ask.
 */
export function onEntityTagsChanged() {
    if (!tagsLoadedOnce || entityTagChangesAskQueued) return;
    entityTagChangesAskQueued = true;
    entityTagChangesChain = entityTagChangesChain.then(() => {
        entityTagChangesAskQueued = false;
        return takeInEntityTagChanges();
    }).catch(error => console.error('Error taking in tag assignment changes:', error));
}

/**
 * Asks the server to delete one tag definition by id, giving `mergeInto` to every entity carrying the tag. Changes
 * nothing in this tab.
 * @param {string} id
 * @param {string | null} mergeInto
 * @returns {Promise<{ refused: { id: string, reason: string }[], mergedInto: string | null, target: Tag | null } | null>}
 *   the server's answer (see /api/tags/delete), or null if the request failed
 */
async function deleteTagOnServer(id, mergeInto) {
    try {
        const response = await fetch('/api/tags/delete', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ id, mergeInto }),
            cache: 'no-cache',
        });

        if (!response.ok) {
            throw new Error(`Failed to delete tag: ${response.statusText}`);
        }

        const { refused, mergedInto, target } = await response.json();
        return { refused: refused ?? [], mergedInto: mergedInto ?? null, target: target ?? null };
    } catch (error) {
        console.error(`Error deleting tag ${id}:`, error);
        return null;
    }
}

/**
 * Runs `worker` over `items` in fixed-size chunks, awaiting each chunk before starting the next.
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
 * Patches the row on completion because this races a concurrent `/api/characters/query` re-render: a non-resident
 * row (common under `lazyLoadCharacters`) has no other source of truth and would otherwise permanently show as
 * untagged if the redraw wins the race.
 * @param {string} id Character avatar or group id (an entity key)
 * @param {string} tagId
 * @returns {Promise<{ assigned: string | null, defined: boolean } | null>} null if the request failed; else the
 *   server's answer (see /api/tags/assign): the tag the entity got, and whether the server has a tag with that id
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
        const answer = await response.json();
        updateEntityRowTags([id]);
        return { assigned: answer.assigned ?? null, defined: answer.defined !== false };
    } catch (error) {
        console.error(`Error assigning tag ${tagId} to ${id}:`, error);
        return null;
    }
}

/**
 * Same race-patching behavior as assignTagOnServer(). Unassigning an unknown/already-untagged id is a harmless
 * server-side no-op, so this is also safe to call redundantly.
 * @param {string} id Character avatar or group id (an entity key)
 * @param {string} tagId
 * @returns {Promise<boolean>} whether the server stored it
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
        updateEntityRowTags([id]);
        return true;
    } catch (error) {
        console.error(`Error unassigning tag ${tagId} from ${id}:`, error);
        return false;
    }
}

/**
 * The tags some character or group this tab holds carries. Not every used tag: the server knows those
 * (`/api/tags/query` with `filter.used`).
 * @returns {Set<string>}
 */
function getHeldAssignedTagIds() {
    const ids = new Set();
    for (const [, tagIds] of allTagIdsEntries()) {
        for (const id of tagIds) ids.add(id);
    }
    return ids;
}

/**
 * Autocomplete options for used tags whose names hold the typed text, from the server, for the tags this tab
 * doesn't hold.
 * @param {(tag: Tag) => any} toOption
 * @returns {(typed: string) => Promise<any[]>}
 */
export function searchUsedTagOptions(toOption) {
    return searchTagOptions(toOption, { used: true });
}

/**
 * Autocomplete options for tags whose names hold the typed text, from the server, for the tags this tab doesn't hold.
 * @param {(tag: Tag) => any} toOption
 * @param {object} [options]
 * @param {boolean} [options.used] - only tags some character or group carries
 * @returns {(typed: string) => Promise<any[]>}
 */
export function searchTagOptions(toOption, { used = false } = {}) {
    return async (typed) => {
        const page = await searchTagsByName(typed, { used });
        return (page?.rows ?? []).map(toOption);
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
    const shownCase = readShownFolderCase();
    return getOpenBogusFolders().length > 0 || (shownCase !== null && shownCase !== 'none');
}

/** Set by the character list: shows a closed-folder case ('none' or a closed folder's tag id). */
let showFolderCase = /** @type {((folderCase: string) => void) | null} */ (null);
/** Set by the character list: the closed-folder case shown, null while "Tags as Folders" is off. */
let readShownFolderCase = /** @type {() => string | null} */ (() => null);

/**
 * Lets chooseBogusFolder() and isBogusFolderOpen() reach the character list's folder switcher, which this module
 * can't import.
 * @param {{ show: (folderCase: string) => void, read: () => string | null }} handlers
 */
export function registerFolderCaseHandlers({ show, read }) {
    showFolderCase = show;
    readShownFolderCase = read;
}

/**
 * Function to be called when a specific tag/folder is chosen to "drill down".
 *
 * @param {*} source The jQuery element clicked when choosing the folder
 * @param {string} tagId The tag id that is behind the chosen folder
 * @param {boolean} remove Whether the given tag should be removed (otherwise it is added/chosen)
 */
function chooseBogusFolder(source, tagId, remove = false) {
    // A closed folder is a case of the list's folder switcher, not a tag filter.
    const shownCase = readShownFolderCase();
    if (showFolderCase && tagId === 'back' && shownCase !== null && shownCase !== 'none') {
        showFolderCase('none');
        return;
    }
    if (showFolderCase && shownCase !== null && tagId !== 'back' && !tagsStore.get(tagId)) {
        // The page holds only the tags on screen: read this one to tell a closed folder from an open one.
        void readTagsForIds([tagId]).then(answer => {
            if (answer?.tags.get(tagId)?.folder_type === 'CLOSED') showFolderCase?.(remove ? 'none' : tagId);
            else chooseTagFilterFolder(source, tagId, remove);
        });
        return;
    }
    if (showFolderCase && tagsStore.get(tagId)?.folder_type === 'CLOSED') {
        showFolderCase(remove ? 'none' : tagId);
        return;
    }
    chooseTagFilterFolder(source, tagId, remove);
}

/**
 * Opens or closes an open folder: selects or clears its tag in the tag filter bar.
 * @param {*} source The jQuery element clicked when choosing the folder
 * @param {string} tagId The tag id that is behind the chosen folder, or 'back'
 * @param {boolean} remove Whether the given tag should be removed (otherwise it is added/chosen)
 */
function chooseTagFilterFolder(source, tagId, remove) {
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
    let tagElement = $(FILTER_SELECTOR).find(`.tag[id=${tagId}]`);
    // The bar draws a page of the used tags, which this folder's tag may not be on.
    const tag = tagsStore.get(tagId);
    if (!tagElement.length && tag) {
        appendTagToList($(FILTER_SELECTOR), tag, { isFilter: true, isGeneralList: true });
        tagElement = $(FILTER_SELECTOR).find(`.tag[id=${tagId}]`);
    }

    toggleTagThreeState(tagElement, { stateOverride: !remove ? FILTER_STATES.SELECTED : DEFAULT_FILTER_STATE, simulateClick: true });
}

/**
 * Builds the tag block for the specified item.
 *
 * @param {Tag} tag The tag item
 * @param {any[]} entities The list ob sub items for this tag
 * @param {number} hidden A count of how many sub items are hidden
 * @param {boolean} isUseless Whether the tag is useless (should be displayed greyed out)
 * @param {number|string} [total] How many sub items there are when `entities` holds only the first of them; the
 *   rest show as a "+N" marker. `hidden` and this are `~`-prefixed strings when approximate.
 * @returns The html for the tag block
 */
function getTagBlock(tag, entities, hidden = 0, isUseless = false, total = undefined) {
    const count = parseQueryTotal(total ?? entities.length);
    const hiddenCount = parseQueryTotal(hidden);
    const approx = count.approx ? '~' : '';

    const tagFolder = TAG_FOLDER_TYPES[tag.folder_type];

    const template = FOLDER_TEMPLATE.clone();
    template.addClass(tagFolder.class);
    template.attr({ 'tagid': tag.id, 'id': `BogusFolder${tag.id}` });
    template.find('.avatar').css({ 'background-color': tag.color, 'color': tag.color2 }).attr('title', `[Folder] ${tag.name}`);
    template.find('.ch_name').text(tag.name).attr('title', `[Folder] ${tag.name}`);
    template.find('.bogus_folder_hidden_counter').text(hiddenCount.value > 0 ? `${hiddenCount.approx ? '~' : ''}${hiddenCount.value} hidden` : '');
    template.find('.bogus_folder_counter').text(`${approx}${count.value} ` + (count.value != 1 ? t`characters` : t`character`));
    template.find('.bogus_folder_icon').addClass(tagFolder.fa_icon);
    if (isUseless) template.addClass('useless');

    // Fill inline character images
    const avatarsBlock = template.find('.bogus_folder_avatars_block');
    buildAvatarList(avatarsBlock, entities);
    const more = count.value - entities.length;
    if (more > 0) {
        const marker = `+${approx}${more}`;
        avatarsBlock.append($('<small class="bogus_folder_more"></small>').text(marker).attr('title', t`${marker} more`));
    }

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

    setFilterDataFromUser(filterHelper, filterType, state);
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
        const filterType = getTagIdToFilterType().get(tag.id) || null;
        if (filterType) {
            return filterHelper.getFilterData(filterType) || DEFAULT_FILTER_STATE;
        }
    } else {
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
 * Loads tag *definitions* from the server (POST /api/tags/get). A fetch failure reuses the last-known-good
 * cache. The server adds upstream's default tags to a new store, so the page never makes up tags. Assignments aren't loaded separately - they live on each character/
 * group's own `tag_ids` field, already resident by the time `characters`/`groups` are populated.
 */
/**
 * With neither `tags` nor `tag_map` in `settings`, reads the tag definitions from the server.
 *
 * Upstream passes the settings object and takes both from it. Given here, they are taken in as an extension's
 * writes to `tags` and `tag_map` are, and `tags` holds the given tags when this returns. The given `tag_map` only
 * adds: upstream's replaces the whole map, which would take every tag off each character it doesn't name.
 * @param {{ tags?: Tag[], tag_map?: Record<string, string[]> }} [settings]
 * @returns {Promise<void>}
 */
function loadTagsSettings(settings) {
    const givenTags = Array.isArray(settings?.tags) ? [...settings.tags] : null;
    const givenMap = settings?.tag_map !== null && typeof settings?.tag_map === 'object' ? settings.tag_map : null;
    if (!givenTags && !givenMap) return loadTagsFromServer();

    if (givenTags) {
        // As an extension's clear and refill of the exported `tags`.
        exportedTags.length = 0;
        for (const tag of givenTags) exportedTags.push(tag);
    }
    if (givenMap) {
        for (const [key, ids] of Object.entries(givenMap)) {
            if (!Array.isArray(ids)) continue;
            const entry = tag_map[key];
            if (!Array.isArray(entry)) {
                tag_map[key] = [...ids];
                continue;
            }
            for (const id of ids) {
                if (!entry.includes(id)) entry.push(id);
            }
        }
    }
    return storeTagChangesMadeThroughExport();
}

async function loadTagsFromServer() {
    try {
        await loadTagDefinitionsFromServer();
    } finally {
        // What changed between the manifest read, which set the cursor, and now.
        tagsLoadedOnce = true;
        onTagsChanged();
    }
}

/**
 * Reads where this tab's tags are current to in the server's change logs, before anything is drawn, so nothing that
 * changes from here on is missed. No tag definition is read: each is read by id when something on screen shows it
 * (heldTagsForIds()).
 */
async function loadTagDefinitionsFromServer() {
    if (!tagStoresBuilt) {
        rebuildTagStores();
        tagStoresBuilt = true;
        dropOldTagsCache();
    }
    try {
        const manifestResponse = await fetch('/api/tags/manifest', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({}),
            cache: 'no-cache',
        });
        if (!manifestResponse.ok) {
            console.error(`Failed to read the tag change cursors: ${manifestResponse.statusText}`);
            return;
        }
        const { changesSeq, assignmentChanges } = await manifestResponse.json();
        tagChangesSeq = typeof changesSeq === 'number' ? changesSeq : null;
        // Only the first one, read before the characters and groups are: a later one would skip what changed
        // since this tab last asked.
        if (!entityTagChangesCursor && typeof assignmentChanges?.seq === 'number' && typeof assignmentChanges?.groupsVersion === 'number') {
            entityTagChangesCursor = { sinceSeq: assignmentChanges.seq, sinceGroupsVersion: assignmentChanges.groupsVersion };
        }
    } catch (error) {
        console.error('Error reading the tag change cursors:', error);
    }
}

/** Whether rebuildTagStores() has given `tagsStore` its subscribers. */
let tagStoresBuilt = false;

/**
 * Each entity carries its own `tag_ids` (server-stamped, see `resolveTagIdsArray()`), so there's nothing to
 * reindex here. This redraws now that real assignments are visible: the initial render ran before
 * `characters`/`groups` were populated.
 * Must run after both `characters` and `groups` are populated.
 */
async function reindexTagAssignments() {
    try {
        invalidateCharactersFuseIndex();
        invalidateGroupsFuseIndex();

        // The initial render already ran before real assignments were resident - redraw now that they are.
        printCharactersDebounced();
        printTagFilters(tag_filter_type.character);
        printTagFilters(tag_filter_type.group_members_list);
        printTagFilters(tag_filter_type.group_candidates_list);
    } catch (error) {
        console.error('Error reindexing tag assignments:', error);
        toastr.warning('Could not load tag data. Tags may be missing.', 'Tag Loading Error', { timeOut: 10000 });
    }
}

function createTagMapFromList(listElement, key) {
    const tagIds = [...($(listElement).find('.tag').map((_, el) => $(el).attr('id')))];
    setKeyTagIds(key, tagIds);
}

/**
 * Resolves tag ids to tag objects via `tagsStore`, dropping unknown ids.
 * @param {string[]} tagIds
 * @param {boolean} sort
 * @returns {Tag[]}
 */
function tagIdsToTagList(tagIds, sort) {
    const list = heldTagsForIds(tagIds);
    if (sort) list.sort(compareTagsForSort);
    return list;
}

/**
 * Gets a list of all tags for a given entity key.
 * If you have an entity, you can get it's key easily via `getTagKeyForEntity(entity)`.
 *
 * @param {string} key - The key for which to get tags via the tag map
 * @param {boolean} [sort=true] - Whether the tag list should be sorted
 * @param {string[]} [residencyFallbackTagIds] - Tag ids to use when `key` isn't a `charactersStore`-resident
 * character. Only consulted on a residency miss; a resident character's own `tag_ids` always wins.
 * @returns {Tag[]} A list of tags
 */
function getTagsList(key, sort = true, residencyFallbackTagIds = undefined) {
    if (key === null || key === undefined) {
        return [];
    }

    // A resident character or group carries its own live, server-stamped tag_ids field.
    const character = charactersStore.get(key);
    if (character) {
        const tagIds = Array.isArray(character.tag_ids) ? character.tag_ids : [];
        return tagIdsToTagList(tagIds, sort);
    }
    const group = groupsStore.get(key);
    if (group) {
        const tagIds = Array.isArray(group.tag_ids) ? group.tag_ids : [];
        return tagIdsToTagList(tagIds, sort);
    }

    // Under lazyLoadCharacters, most list/search rows are non-resident query rows with their own correct
    // tag_ids - a caller already holding such a row's tag_ids passes it here instead.
    if (Array.isArray(residencyFallbackTagIds)) {
        return tagIdsToTagList(residencyFallbackTagIds, sort);
    }

    return [];
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
    if (!character && !isNaN(parseInt(entityOrKey))) character = exposedCharacters[x]; // check if its a char id
    if (!character) character = charactersStore.get(x); // check if its a char key

    if (character) {
        x = character.avatar;
    }

    // A resolvable key is one resolveTagIdsArray() can find a live tag_ids array for - a resident character
    // (guarded against a falsy avatar here first) or group.
    if (x && resolveTagIdsArray(x)) {
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

    /** @type {Set<string>} The resolved entity keys (avatar / group id) actually touched by this call */
    const affectedKeys = new Set();

    // Add tags to the map
    entityIds.forEach((id) => {
        const key = id !== null && id !== undefined ? getTagKeyForEntity(id) : getTagKey();
        if (!key) return;
        affectedKeys.add(key);
        tags.forEach((tag) => {
            if (assignTagToKey(key, tag.id)) result = true;
        });
    });

    redrawAfterTagChange(tags.map(t => t.id), affectedKeys);
    tagListOptions.addTag = tags;

    // add tag to the UI and internal map - we reprint so sorting and new markup is done correctly
    if (tagListSelector) printTagList(tagListSelector, tagListOptions);
    const inlineSelector = getInlineListSelector();
    if (inlineSelector) {
        // Reprint with its own read-only tagOptions so an edit-panel affordance (e.g. remove) doesn't leak
        // onto the read-only list row.
        printTagList($(inlineSelector), { ...tagListOptions, tagOptions: { isCharacterList: true } });
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
 * Redraws whatever needs to be redrawn after a tag assignment change for the given tag ids / entity keys.
 * See `tagChangeAffectsCurrentView` for what "needs a full re-render" means here.
 * @param {string[]} tagIds - The ids of the tags that were added/removed
 * @param {Set<string>} affectedKeys - The entity keys (avatar / group id) that were actually touched
 *
 * The filter bars are not redrawn here: which tags are used is the server's to say, and the bars read it again once
 * this tab's tag saves are answered (queueTagSave()).
 */
export function redrawAfterTagChange(tagIds, affectedKeys) {
    if (tagChangeAffectsCurrentView(tagIds)) {
        printCharactersDebounced();
        return;
    }

    updateEntityRowTags(affectedKeys);
}

/**
 * Patches the tag pills of any currently-rendered character/group list rows for the given entity keys, without
 * touching the rest of the list.
 * @param {Iterable<string>} keys - entity keys (character avatar or group id)
 */
function updateEntityRowTags(keys) {
    for (const key of keys) {
        // A key is either a character's avatar or a group's id, and only rows of its own kind carry it, so both
        // selectors can be tried without first asking which kind it is.
        const escapedKey = CSS.escape(String(key));
        const $row = $(`#rm_print_characters_block .character_select[data-avatar="${escapedKey}"], #rm_print_characters_block .group_select[data-grid="${escapedKey}"]`);

        if ($row.length) {
            printTagList($row.find('.tags'), { forEntityOrKey: key, tagOptions: { isCharacterList: true } });
        }

        // The group editor's member and candidate rows of the character.
        $(`.group_member[data-avatar="${escapedKey}"] .tags`).each((_, element) => {
            printTagList($(element), { forEntityOrKey: key, tagOptions: { isCharacterList: true } });
        });
    }
}

/**
 * Entity keys of currently-rendered character/group list rows carrying the given tag - for a tag-level change
 * (the tag itself was edited or deleted) where the affected entities aren't already known, unlike
 * `redrawAfterTagChange`'s per-entity assign/unassign callers.
 * @param {string} tagId
 * @returns {string[]}
 */
function getRenderedKeysWithTag(tagId) {
    return getRenderedKeysWithAnyTag(new Set([tagId]));
}

/**
 * @param {Set<string>} tagIds
 * @returns {string[]} the key of every currently-rendered character/group list row carrying any of `tagIds`
 */
function getRenderedKeysWithAnyTag(tagIds) {
    const keys = [];
    const unheldRows = getUnheldRowTagIds();
    document.querySelectorAll('#rm_print_characters_block [data-avatar], #rm_print_characters_block [data-grid]').forEach(el => {
        const key = el.getAttribute('data-avatar') ?? el.getAttribute('data-grid');
        const ids = resolveTagIdsArray(key) ?? unheldRows.get(key) ?? [];
        if (ids.some(id => tagIds.has(id))) {
            keys.push(key);
        }
    });
    return keys;
}

/**
 * Entity keys of every currently-rendered character/group list row, for a change that can touch any row's own
 * tag pills (e.g. tag display order) without changing which rows are shown - so patching all of them in place
 * is enough, and still bounded to the current page rather than the whole list.
 * @returns {string[]}
 */
function getAllRenderedEntityKeys() {
    return Array.from(
        document.querySelectorAll('#rm_print_characters_block [data-avatar], #rm_print_characters_block [data-grid]'),
        el => el.getAttribute('data-avatar') ?? el.getAttribute('data-grid'),
    );
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

    /** @type {Set<string>} The resolved entity keys (avatar / group id) actually touched by this call */
    const affectedKeys = new Set();

    // Remove tag from the map
    entityIds.forEach((id) => {
        const key = id !== null && id !== undefined ? getTagKeyForEntity(id) : getTagKey();
        if (!key) return;
        affectedKeys.add(key);
        if (unassignTagFromKey(key, tag.id)) result = true;
    });

    // Save and redraw
    redrawAfterTagChange([tag.id], affectedKeys);
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

    return !!unassignTagFromKey(key, tagId);
}

/**
 * Caps how many tag rows get rendered for a single search term, in the tag input autocomplete and the tag
 * management view list - both render one DOM element per match with no cap of their own, and an empty
 * search term matches nearly every tag, so an uncapped result renders thousands of DOM nodes at once.
 */
const FIND_TAG_RESULT_LIMIT = 50;

/**
 * The tag input's suggestions: names holding what was typed, in the tag sort mode's order, leaving out the tags
 * already on the list. The typed text itself comes first when no tag has that name, so it can be created; when the
 * tag with that name is already on the list, nothing is offered for it.
 * @param {{ term: string }} request
 * @param {(names: string[]) => void} resolve
 * @param {string} listSelector
 */
function findTag(request, resolve, listSelector) {
    const skipIds = new Set($(listSelector).find('.tag').map((_, el) => $(el).attr('id')).get());
    const needle = String(request.term ?? '');
    const pageSize = Math.min(FIND_TAG_RESULT_LIMIT + skipIds.size, TAG_READ_MAX_IDS);

    Promise.all([
        searchTagsByName(needle, { pageSize }),
        needle.trim() ? findTagByName(needle) : null,
    ]).then(([page, exact]) => {
        const rows = page?.rows
            ?? tags.filter(t => includesIgnoreCaseAndAccents(t.name, needle)).sort(compareTagsForSort);
        const result = rows.filter(t => !skipIds.has(t.id)).map(t => tagsStore.get(t.id)?.name ?? t.name).slice(0, FIND_TAG_RESULT_LIMIT);
        if (exact && !skipIds.has(exact.id) && !result.some(name => equalsIgnoreCaseAndAccents(name, exact.name))) {
            result.unshift(exact.name);
        }
        if (needle && !exact) result.unshift(needle);
        resolve(result);
    });
}

/**
 * Select a tag and add it to the list. This function is (mostly) used as an event handler for the tag selector control.
 *
 * @param {*} event - The event that fired on autocomplete select
 * @param {*} ui - An Object with label and value properties for the selected option
 * @param {*} listSelector - The selector of the list to print/add to
 * @param {object} param1 - Optional parameters for this method call
 * @param {PrintTagListOptions} [param1.tagListOptions] - Optional parameters for printing the tag list. Can be set to be consistent with the expected behavior of tags in the list that was defined before.
 * @param {((tag: Tag) => void) | null} [param1.onTagChosen] - Given, the chosen tag (created first if it is new) goes
 *   to it instead of being put on an entity.
 * @returns {boolean} <c>false</c>, to keep the input clear
 */
function selectTag(event, ui, listSelector, { tagListOptions = {}, onTagChosen = null } = {}) {
    const tagName = ui.item.value;

    if (onTagChosen) {
        $(event.target).val('').trigger('input');
        createNewTags([tagName]).then(([tag]) => {
            if (tag) onTagChosen(tag);
        });
        return false;
    }

    // Optional, check for multiple character ids being present.
    const characterData = event.target.closest('#bulk_tags_div')?.dataset.characters;
    // Settled now: a new tag is added once the server has stored it, and another entity may be open by then.
    const entityIds = characterData ? JSON.parse(characterData).characterIds : getTagKey();

    // unfocus and clear the input
    $(event.target).val('').trigger('input');

    /** @param {Tag} tag */
    const add = (tag) => {
        addTagsToEntity(tag, entityIds, { tagListSelector: listSelector, tagListOptions: tagListOptions });
        applyCharacterTagsToMessageDivs();
    };

    createNewTags([tagName]).then(([tag]) => {
        if (tag) add(tag);
    });

    // need to return false to keep the input clear
    return false;
}

/**
 * Merges tag definitions the server resolved on the client's behalf into the local `tagsStore`, for any id
 * this client doesn't already have a definition for - otherwise a server-minted tag would render invisible
 * until some unrelated future refetch pulled it in.
 * @param {object[]} tagDefinitions
 */
function mergeServerTagDefinitions(tagDefinitions) {
    if (!Array.isArray(tagDefinitions) || tagDefinitions.length === 0) return;

    let addedAny = false;
    for (const tag of tagDefinitions) {
        if (!tag || typeof tag.id !== 'string' || tagsStore.has(tag.id)) continue;
        addStoredTag(tag);
        addedAny = true;
    }
    if (addedAny) {
        tagsStore.reindex();
        invalidateTagsFuseIndex();
        invalidateCharactersFuseIndex();
    }
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

    const tagsToImport = await createNewTags(tagNamesToImport);
    if (!tagsToImport.length) return false;
    const added = resolveTagIdsArray(character.avatar)
        ? addTagsToEntity(tagsToImport, character.avatar)
        : await saveTagsOnUnheldKey(character.avatar, tagsToImport.map(tag => tag.id), true);
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
    const alreadyAssignedTags = (await readEntityTagIds(character.avatar)) ?? [];
    // Enough names that the first ANTI_TROLL_MAX_TAGS not assigned yet are among them.
    const candidateNames = character.tags.map(t => t.trim()).filter(t => t)
        .filter(t => !IMPORT_EXLCUDED_TAGS.includes(t))
        .slice(0, ANTI_TROLL_MAX_TAGS + alreadyAssignedTags.length);
    const found = await findTagsByNames(candidateNames);
    const importTags = candidateNames
        .filter(t => {
            const existingTag = found.get(t);
            return !existingTag || !alreadyAssignedTags.includes(existingTag.id);
        })
        .slice(0, ANTI_TROLL_MAX_TAGS);
    const existingTags = importTags.map(t => found.get(t)).filter(Boolean);
    const newTags = importTags.filter(t => !found.get(t)).map(newTagWithoutOrder);
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
 *
 * @param {string} tagName - The name of the tag to search for
 * @returns {Tag?} The tag object that matches the provided tag name, or undefined if no match is found
 */
function getTag(tagName) {
    return tags.find(t => equalsIgnoreCaseAndAccents(t.name, tagName));
}

/** At most this many distinct names per /api/tags/by-names request; more is a 400. */
const TAG_BY_NAMES_MAX = 100;

/**
 * The tag each name stands for on the server, as getTag() matches names, and a tag being deleted with a merge target
 * standing for that target. A tag found that this tab doesn't have is added to `tags`. If the server can't be asked,
 * the names are looked up in the tags this tab has.
 * @param {string[]} names
 * @returns {Promise<Map<string, Tag | null>>} for each name as given
 */
export async function findTagsByNames(names) {
    /** @type {Map<string, Tag | null>} */
    const found = new Map();
    const distinct = [...new Set(names)];
    for (let i = 0; i < distinct.length; i += TAG_BY_NAMES_MAX) {
        const slice = distinct.slice(i, i + TAG_BY_NAMES_MAX);
        let answer = null;
        try {
            answer = await postTagsRead('/api/tags/by-names', { names: slice });
        } catch (error) {
            console.error('Could not look up tags by name:', error);
        }
        if (!Array.isArray(answer?.tags)) {
            for (const name of slice) found.set(name, getTag(name) ?? null);
            continue;
        }
        mergeServerTagDefinitions(answer.tags.map(entry => entry?.tag).filter(isTagObject));
        for (const { name, tag } of answer.tags) {
            found.set(name, isTagObject(tag) ? (tagsStore.get(tag.id) ?? null) : null);
        }
    }
    return found;
}

/**
 * @param {string} name
 * @returns {Promise<Tag | null>} the tag the name stands for (findTagsByNames())
 */
async function findTagByName(name) {
    return (await findTagsByNames([name])).get(name) ?? null;
}

/**
 * The definitions of `ids`: the ones this tab has, and the rest read from the server into `tags`.
 * @param {string[]} ids
 * @returns {Promise<{ tags: Map<string, Tag>, gone: Set<string> } | null>} `gone`: ids no tag has. An id in neither is a
 *   tag whose stored definition can't be read. null if a read failed.
 */
export async function readTagsForIds(ids) {
    /** @type {Map<string, Tag>} */
    const found = new Map();
    /** @type {Set<string>} */
    const gone = new Set();
    const missing = [];
    for (const id of new Set(ids)) {
        const held = tagsStore.get(id);
        if (held) found.set(id, held);
        else missing.push(id);
    }
    for (let i = 0; i < missing.length; i += TAG_READ_MAX_IDS) {
        const answer = await postTagsRead('/api/tags/by-ids', { ids: missing.slice(i, i + TAG_READ_MAX_IDS) }).catch((error) => {
            console.error('Could not read tags by id:', error);
            return null;
        });
        if (!answer || !Array.isArray(answer.tags) || !Array.isArray(answer.gone)) return null;
        mergeServerTagDefinitions(answer.tags);
        for (const id of answer.gone) gone.add(String(id));
    }
    for (const id of missing) {
        const tag = tagsStore.get(id);
        if (tag) found.set(id, tag);
    }
    return { tags: found, gone };
}

/**
 * Ids of tags the server has no readable definition for (no tag has the id, or its stored copy can't be read). A draw
 * that meets one doesn't ask for it again.
 * @type {Set<string>}
 */
const tagIdsWithoutDefinition = new Set();

/**
 * Tag ids something on screen was drawn without, because this tab has no definition for them yet. Read together once
 * the turn that drew them has finished.
 * @type {Set<string>}
 */
const missingTagIds = new Set();
let missingTagReadQueued = false;
/** @type {Promise<void>} */
let missingTagReads = Promise.resolve();

/**
 * The definitions this tab holds of `tagIds`, in that order. An id it has none for is read from the server: every
 * draw in the same turn joins one request, and what was drawn is drawn again once the definitions arrive.
 * @param {string[]} tagIds
 * @returns {Tag[]}
 */
export function heldTagsForIds(tagIds) {
    /** @type {Tag[]} */
    const found = [];
    for (const id of tagIds) {
        const tag = tagsStore.get(id);
        if (tag) found.push(tag);
        else noteMissingTagDefinition(id);
    }
    return found;
}

/** @param {string} id */
function noteMissingTagDefinition(id) {
    if (typeof id !== 'string' || id === '' || tagIdsWithoutDefinition.has(id)) return;
    missingTagIds.add(id);
    if (missingTagReadQueued) return;
    missingTagReadQueued = true;
    queueMicrotask(() => {
        missingTagReads = missingTagReads.then(readMissingTagDefinitions)
            .catch(error => console.error('Could not read the definitions of tags on screen:', error));
    });
}

/** Reads the definitions noteMissingTagDefinition() collected, and draws again what shows tags. */
async function readMissingTagDefinitions() {
    missingTagReadQueued = false;
    const ids = [...missingTagIds].filter(id => !tagsStore.has(id));
    missingTagIds.clear();
    let readAny = false;
    for (let i = 0; i < ids.length; i += TAG_READ_MAX_IDS) {
        const chunk = ids.slice(i, i + TAG_READ_MAX_IDS);
        const answer = await postTagsRead('/api/tags/by-ids', { ids: chunk });
        // Not marked: the next draw asks again.
        if (!answer || !Array.isArray(answer.tags)) break;
        const answered = new Set(answer.tags.filter(isTagObject).map(tag => tag.id));
        for (const id of chunk) {
            if (!answered.has(id)) tagIdsWithoutDefinition.add(id);
        }
        if (answered.size) {
            mergeServerTagDefinitions(answer.tags);
            readAny = true;
        }
    }
    if (readAny) redrawTagsOnScreen();
}

/**
 * Draws again everything on screen that shows the tags of a character or group: the list's rows, the group editor's
 * member rows, the open character's or group's tag list and the chat's messages.
 */
function redrawTagsOnScreen() {
    const keys = new Set(getAllRenderedEntityKeys());
    document.querySelectorAll('.group_member[data-avatar]').forEach(el => keys.add(el.getAttribute('data-avatar')));
    const unheldRows = getUnheldRowTagIds();
    updateEntityRowTags([...keys].filter(key => !unheldRows.has(key)));
    redrawUnheldRows();
    if (getTagKey() !== null) {
        if (selected_group) applyTagsOnGroupSelect(); else applyTagsOnCharacterSelect();
    }
    applyCharacterTagsToMessageDivs();
}

/** The order tag suggestions and pickers list tags in: the tag sort mode's. */
function tagQuerySortField() {
    const mode = power_user.tag_sort_mode;
    return Object.values(tag_sort_mode).includes(mode) ? mode : tag_sort_mode.MANUAL;
}

/**
 * One page of the tags whose names hold `term` anywhere, in the tag sort mode's order. The tags are not added to
 * `tags`.
 * @param {string} term - empty: every tag
 * @param {object} [options]
 * @param {number} [options.pageSize]
 * @param {string | null} [options.cursor] - where an earlier page said the next one starts
 * @param {boolean} [options.used] - only tags some character or group carries
 * @param {'OPEN'|'CLOSED'} [options.folderType] - only folders of this type
 * @returns {Promise<{ rows: Tag[], cursor: string | null } | null>} null if the read failed
 */
export async function searchTagsByName(term, { pageSize = FIND_TAG_RESULT_LIMIT, cursor = null, used = false, folderType = undefined } = {}) {
    const contains = String(term ?? '').trim();
    const filter = contains ? { contains } : {};
    if (used) filter.used = true;
    if (folderType) filter.folderType = folderType;
    const answer = await postTagQuery({
        filter,
        sort: { field: tagQuerySortField() },
        pageSize,
        cursor,
    });
    if (!answer || answer === 'invalid-cursor' || !Array.isArray(answer.rows)) return null;
    return { rows: answer.rows.filter(isTagObject), cursor: answer.cursor ?? null };
}

/** Reads a name search may make when the server's work cap keeps cutting its pages short. */
const TAG_SEARCH_READS_MAX = 5;

/**
 * The tag `/random` picks from: a tag some character or group carries whose name is `name`, else one whose name
 * starts with it, else one whose name holds it; the first in the tag sort mode's order, ignoring case and accents.
 * @param {string} name
 * @returns {Promise<string | undefined>} its id; undefined when no used tag matches or the server can't be read
 */
export async function findUsedTagIdByName(name) {
    const term = String(name ?? '').trim();
    if (!term) return undefined;
    const field = tagQuerySortField();
    for (const match of [{ name: term }, { search: term }, { contains: term }]) {
        /** @type {string | null} */
        let cursor = null;
        for (let reads = 0; reads < TAG_SEARCH_READS_MAX; reads++) {
            const answer = await postTagQuery({ filter: { used: true, ...match }, sort: { field }, pageSize: 1, cursor });
            if (!answer || answer === 'invalid-cursor' || !Array.isArray(answer.rows)) return undefined;
            const row = answer.rows.find(isTagObject);
            if (row) return row.id;
            cursor = answer.cursor ?? null;
            if (cursor === null || !answer.more) break;
        }
    }
    return undefined;
}

/**
 * Makes a single-choice select a search over tag names (searchTagsByName()), with more results loaded as its list is
 * scrolled. An option's value is the tag's id and its text the tag's name.
 * @param {JQuery<HTMLElement>} select
 * @param {object} options
 * @param {string} options.placeholder
 * @param {JQuery<HTMLElement>} [options.dropdownParent]
 * @param {string} [options.leaveOut] - a tag id not to offer
 */
function initTagSearchSelect(select, { placeholder, dropdownParent, leaveOut }) {
    /** Where each search's next page starts, by page number and search text. */
    const pageCursors = new Map();
    select.select2({
        width: '50%',
        placeholder,
        allowClear: true,
        dropdownParent,
        ajax: {
            delay: 250,
            data: (params) => ({ term: params.term ?? '', page: params.page ?? 1 }),
            transport: (params, success, failure) => {
                const { term, page } = params.data;
                // A search typed over is aborted; its answer must not replace the newer one's.
                let aborted = false;
                searchTagsByName(term, { cursor: pageCursors.get(`${page}\n${term}`) ?? null }).then((answer) => {
                    if (aborted) return;
                    if (!answer) {
                        failure();
                        return;
                    }
                    if (answer.cursor) pageCursors.set(`${page + 1}\n${term}`, answer.cursor);
                    success({
                        results: answer.rows.filter(x => x.id !== leaveOut).map(x => ({ id: x.id, text: x.name })),
                        pagination: { more: answer.cursor !== null },
                    });
                });
                return { abort: () => { aborted = true; } };
            },
        },
    });
}

/**
 * Creates of tags by name that the server hasn't answered yet, so a second request for a name waits for the first
 * instead of making another tag with it.
 * @type {{ name: string, created: Promise<Tag | null> }[]}
 */
const tagNamesBeingCreated = [];

/**
 * Gets the tag for each name, creating those no tag on the server has. A new tag is in `tags` only once the server
 * has stored it. Names that could not be created are left out, and listed to the user in one message.
 *
 * @param {string[]} tagNames
 * @returns {Promise<Tag[]>} one tag per name that has a tag now, in the order given
 */
async function createNewTags(tagNames) {
    let storedAny = false;
    /** @type {string[]} */
    const failedNames = [];
    const found = await findTagsByNames(tagNames);

    const results = await Promise.all(tagNames.map(async (tagName) => {
        const existing = found.get(tagName) ?? getTag(tagName);
        if (existing) return existing;

        const inFlight = tagNamesBeingCreated.find(x => equalsIgnoreCaseAndAccents(x.name, tagName));
        if (inFlight) return inFlight.created;

        const entry = { name: tagName, created: /** @type {Promise<Tag | null>} */ (null) };
        entry.created = (async () => {
            const tag = newTagWithoutOrder(tagName);
            const outcome = await createTagOnServer(tag);
            if (outcome === 'failed') failedNames.push(tagName);
            if (outcome !== 'stored') return null;
            storedAny = true;
            console.debug('Created new tag', tag.name, 'with id', tag.id);
            return tag;
        })().finally(() => removeFromArray(tagNamesBeingCreated, entry));
        tagNamesBeingCreated.push(entry);
        return entry.created;
    }));

    if (failedNames.length) {
        toastr.error(
            `${failedNames.map(name => escapeHtml(name)).join('<br />')}<br />${t`Check the server connection and try again.`}`,
            t`Tags could not be created`,
            { escapeHtml: false },
        );
    }
    // Upstream's callers save the settings after creating a tag, which is how extensions hear of it.
    if (storedAny) await eventSource.emit(event_types.SETTINGS_UPDATED);

    return results.filter(Boolean);
}

/**
 * Creates a tag named `tagName` with default properties and a randomly generated id. The tag is in `tags` only once
 * the server has stored it.
 *
 * @param {string} tagName - name of the tag
 * @returns {Promise<Tag | null>} the new tag, or the tag that already has the name (with a warning). null if it could
 *   not be created, which the user has been told.
 */
async function createNewTag(tagName) {
    const existing = await findTagByName(tagName);
    if (existing) {
        toastr.warning(`Cannot create new tag. A tag with the name already exists:<br />${escapeHtml(existing.name)}`, 'Creating Tag', { escapeHtml: false });
        return existing;
    }
    const [tag] = await createNewTags([tagName]);
    return tag ?? null;
}

/**
 * A new tag object with default properties and no place in the manual order: the server gives it one when it creates
 * the tag. Not to be confused with `createNewTag`, which creates the tag.
 * @param {string} tagName
 * @returns {Tag}
 */
function newTagWithoutOrder(tagName) {
    return {
        id: uuidv4(),
        name: tagName,
        folder_type: TAG_FOLDER_DEFAULT_TYPE,
        filter_state: DEFAULT_FILTER_STATE,
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
 * @property {string[]} [entityTagIds=undefined] - The entity's own `tag_ids`, if the caller already has them in
 * hand (e.g. a character row's server-fetched data) - used by `getTagsList()` as a fallback source of truth when
 * `forEntityOrKey` doesn't resolve to a `charactersStore`-resident character (see that function's doc comment on
 * why a non-resident id still legitimately needs this - `lazyLoadCharacters` installs render most of their list/
 * search view straight from non-resident `/query` rows). Ignored when `tags` is also passed.
 */

/**
 * Prints the list of tags
 *
 * @param {JQuery<HTMLElement>|string} element - The container element where the tags are to be printed. (Optionally can also be a string selector for the element, which will then be resolved)
 * @param {PrintTagListOptions} [options] - Optional parameters for printing the tag list.
 */
function printTagList(element, { tags = undefined, addTag = undefined, forEntityOrKey = undefined, empty = true, sort = true, tagActionSelector = undefined, tagOptions = {}, inactiveTags = [], entityTagIds = undefined } = {}) {
    const $element = (typeof element === 'string') ? $(element) : element;
    const key = forEntityOrKey !== undefined ? getTagKeyForEntity(forEntityOrKey) : getTagKey();
    let printableTags = tags ? (typeof tags === 'function' ? tags() : tags) : getTagsList(key, sort, entityTagIds);

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

    // Deliberately not calling saveSettingsDebounced() here - persistence is via accountStorage below.
    // A full settings resave on every tag filter click is a real perf cost once there are lots of tags/entities.
    if (existingTag && isMainCharacterList(filterHelper)) {
        setTagFilterState(existingTag, state);
    }

    const storagePrefix = getFilterStorageKey(filterHelper);
    if (storagePrefix && existingTag) {
        const storageKey = `${storagePrefix}_tag_${tagId}`;
        accountStorage.setItem(storageKey, state);
        saveTagFilterName(storagePrefix, tagId, state, existingTag.name);
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
    // Found from the saved keys, not from the tags this tab holds: a saved filter doesn't depend on its tag having
    // been read.
    const tagFilterData = filterHelper.getFilterData(FILTER_TYPES.TAG);
    const keyPrefix = `${storagePrefix}_tag_`;
    for (const storageKey of accountStorage.keysWithPrefix(keyPrefix)) {
        const tagId = storageKey.slice(keyPrefix.length);
        const state = readState(storageKey);
        if (state === 'SELECTED' && !tagFilterData.selected.includes(tagId)) {
            tagFilterData.selected.push(tagId);
        } else if (state === 'EXCLUDED' && !tagFilterData.excluded.includes(tagId)) {
            tagFilterData.excluded.push(tagId);
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
    } else {
        element.attr('data-toggle-state', states[targetStateIndex]);

        // Update css class and remove all others
        states.forEach(state => {
            element.toggleClass(FILTER_STATES[state].class, state === states[targetStateIndex]);
        });
    }


    return states[targetStateIndex];
}

function runTagFilters(listElement) {
    const tagIds = [...($(listElement).find('.tag.selected:not(.actionable)').map((_, el) => $(el).attr('id')))];
    const excludedTagIds = [...($(listElement).find('.tag.excluded:not(.actionable)').map((_, el) => $(el).attr('id')))];
    const filterHelper = getFilterHelper($(listElement));
    // A filter whose tag has no pill here (its definition isn't read yet, or can't be) is not one the pills can
    // speak for: it stays as it is.
    const drawn = new Set($(listElement).find('.tag:not(.actionable)').map((_, el) => $(el).attr('id')).get());
    const current = filterHelper.getFilterData(FILTER_TYPES.TAG);
    const undrawn = (/** @type {string[]} */ ids) => (Array.isArray(ids) ? ids : []).filter(id => !drawn.has(id));
    setFilterDataFromUser(filterHelper, FILTER_TYPES.TAG, {
        excluded: [...excludedTagIds, ...undrawn(current?.excluded)],
        selected: [...tagIds, ...undrawn(current?.selected)],
    });
}

/** How many used tags a filter bar draws until it is expanded, and how many the first read asks for. */
const USED_TAG_BAR_FIRST = 50;
/** How many more used tags a click on a bar's "more" pill reads. */
const USED_TAG_BAR_MORE = 100;
/** After a read for the filter bars failed, redraws don't ask again for this long. A click on the pill that says so does. */
const USED_TAG_BAR_RETRY_MS = 10000;

/**
 * @typedef {object} UsedTagChunk One answer of /api/tags/query for the filter bars.
 * @property {string | null} from The cursor it was read from.
 * @property {number} size The page size asked for.
 * @property {string[]} ids The tags on it, in the server's order.
 * @property {string | null} cursor Where the next chunk starts; null at the end of the list.
 * @property {string} hash The server's hash of the answer, sent back so an unchanged chunk isn't downloaded again.
 */

/**
 * The tags some character or group carries, as far as they have been read, in the tag sort mode. The three filter
 * bars draw the same list, so it is read once for all of them, and only while one of them is on screen.
 */
const usedTagBar = {
    /** @type {string | null} The tag_sort_mode `chunks` are in. */
    sort: null,
    /** @type {UsedTagChunk[]} */
    chunks: [],
    /** The server may have something else by now. */
    stale: true,
    /** The next read also reads one chunk past the last. */
    wantMore: false,
    queued: false,
    /** When the last read failed, 0 if it didn't. */
    failedAt: 0,
    /** @type {Promise<void>} */
    chain: Promise.resolve(),
};

/** @returns {Tag[]} the used tags read so far, in the server's order */
function usedTagsRead() {
    const seen = new Set();
    const list = [];
    for (const chunk of usedTagBar.chunks) {
        for (const id of chunk.ids) {
            const tag = seen.has(id) ? null : tagsStore.get(id);
            if (!tag) continue;
            seen.add(id);
            list.push(tag);
        }
    }
    return list;
}

/** @returns {boolean} whether a filter bar that shows its tags is on screen */
function isUsedTagBarOnScreen() {
    return [
        [tag_filter_type.character, CHARACTER_FILTER_SELECTOR],
        [tag_filter_type.group_candidates_list, GROUP_FILTER_SELECTOR],
        [tag_filter_type.group_members_list, GROUP_MEMBERS_FILTER_SELECTOR],
    ].some(([type, selector]) => getTagFilterVisibility(Number(type)) && $(String(selector)).is(':visible'));
}

function printAllTagFilters() {
    printTagFilters(tag_filter_type.character);
    printTagFilters(tag_filter_type.group_members_list);
    printTagFilters(tag_filter_type.group_candidates_list);
}

/**
 * Reads the used tags again, chunk by chunk as far as they were read before, and one chunk further when asked to.
 * @returns {Promise<boolean>} whether what the bars draw may have changed
 */
async function readUsedTags() {
    const sort = power_user.tag_sort_mode;
    let old = usedTagBar.sort === sort ? usedTagBar.chunks : [];
    const sizes = old.length ? old.map(chunk => chunk.size) : [USED_TAG_BAR_FIRST];
    if (usedTagBar.wantMore && old.length) sizes.push(USED_TAG_BAR_MORE);
    const hadFailed = usedTagBar.failedAt !== 0;
    usedTagBar.stale = false;
    usedTagBar.wantMore = false;

    let changed = usedTagBar.sort !== sort;
    let restarted = false;
    /** @type {UsedTagChunk[]} */
    const chunks = [];
    /** @type {string | null} */
    let cursor = null;
    for (let i = 0; i < sizes.length; i++) {
        const before = old[i]?.from === cursor && old[i].size === sizes[i] ? old[i] : null;
        const answer = await postTagQuery({
            filter: { used: true },
            sort: { field: sort },
            pageSize: sizes[i],
            cursor,
            ifHash: before?.hash ?? '',
        });
        if (answer === 'invalid-cursor' && !restarted) {
            // The manual order the cursors were made in is being rewritten: read from the start.
            restarted = true;
            old = [];
            chunks.length = 0;
            cursor = null;
            i = -1;
            continue;
        }
        if (!answer || answer === 'invalid-cursor' || typeof answer.hash !== 'string') {
            usedTagBar.stale = true;
            usedTagBar.failedAt = Date.now();
            return !hadFailed;
        }
        if (answer.unchanged && before) {
            chunks.push(before);
        } else {
            const rows = (answer.rows ?? []).filter(isTagObject);
            mergeServerTagDefinitions(rows.filter(row => !tagIdsBeingCreated.has(row.id)));
            chunks.push({ from: cursor, size: sizes[i], ids: rows.map(row => row.id), cursor: answer.cursor ?? null, hash: answer.hash });
            changed = true;
        }
        cursor = chunks[chunks.length - 1].cursor;
        if (cursor === null) break;
    }

    if (chunks.length !== usedTagBar.chunks.length) changed = true;
    usedTagBar.sort = sort;
    usedTagBar.chunks = chunks;
    usedTagBar.failedAt = 0;
    return changed || hadFailed;
}

/**
 * Reads the used tags if what is held is stale, in another sort mode, or a further chunk was asked for, and a bar is
 * on screen to draw them. Any number of calls while one read is waiting its turn make one read.
 */
function readUsedTagsIfNeeded() {
    if (usedTagBar.queued) return;
    if (!usedTagBar.stale && !usedTagBar.wantMore && usedTagBar.sort === power_user.tag_sort_mode) return;
    if (usedTagBar.failedAt && Date.now() - usedTagBar.failedAt < USED_TAG_BAR_RETRY_MS) return;
    if (!isUsedTagBarOnScreen()) return;

    usedTagBar.queued = true;
    usedTagBar.chain = usedTagBar.chain.then(async () => {
        usedTagBar.queued = false;
        if (await readUsedTags()) printAllTagFilters();
    }).catch(error => console.error('Error reading the used tags for the filter bars:', error));
}

const readUsedTagsSoon = debounce(() => readUsedTagsIfNeeded(), debounce_timeout.standard);

/** Which tags are used, their order or what they look like may have changed on the server. */
function refreshUsedTagBars() {
    usedTagBar.stale = true;
    usedTagBar.failedAt = 0;
    readUsedTagsSoon();
}

/** A bar coming on screen reads the used tags if they are stale: they are not read for a bar nobody sees. */
function watchTagFilterBars() {
    const observer = new IntersectionObserver((entries) => {
        if (entries.some(entry => entry.isIntersecting)) readUsedTagsIfNeeded();
    });
    for (const selector of [CHARACTER_FILTER_SELECTOR, GROUP_FILTER_SELECTOR, GROUP_MEMBERS_FILTER_SELECTOR]) {
        const bar = document.querySelector(selector);
        if (bar) observer.observe(bar);
    }
}

/** The click on a bar's "more" pill: draws the used tags already read that the bar leaves out, or reads further. */
function onUsedTagBarMoreClick(_filterHelper, event) {
    event.stopPropagation();
    const bar = $(this).closest('.rm_tag_filter');
    const wasExpanded = bar.hasClass('tags-expanded');
    bar.addClass('tags-expanded');
    if (!wasExpanded && usedTagsRead().length > USED_TAG_BAR_FIRST) {
        printAllTagFilters();
        return;
    }
    usedTagBar.wantMore = true;
    readUsedTagsIfNeeded();
}

/** The click on the pill that says the tags could not be loaded. */
function onUsedTagBarRetryClick(_filterHelper, event) {
    event.stopPropagation();
    usedTagBar.failedAt = 0;
    savedFilterTagReads.failedAt = 0;
    usedTagBar.stale = true;
    readUsedTagsIfNeeded();
    readSavedFilterTagsIfNeeded();
}

/**
 * The saved tag filters whose tag this tab doesn't hold are read by id, so each has a pill.
 */
const savedFilterTagReads = {
    /** @type {Set<string>} Ids of tags the server has but can't read the definition of: not asked for again. */
    unreadable: new Set(),
    reading: false,
    /** When the last read failed, 0 if it didn't. */
    failedAt: 0,
};

/**
 * Reads the tags of saved filters this tab doesn't hold. A filter is removed only when the server says its tag is
 * gone, never because the tag is unused or a read failed.
 */
function readSavedFilterTagsIfNeeded() {
    const reads = savedFilterTagReads;
    if (reads.reading) return;
    if (reads.failedAt && Date.now() - reads.failedAt < USED_TAG_BAR_RETRY_MS) return;

    /** @type {Set<string>} */
    const ids = new Set();
    for (const helper of [groupCandidatesFilter, groupMembersFilter, entitiesFilter]) {
        const data = helper.getFilterData(FILTER_TYPES.TAG);
        for (const id of [...(data?.selected ?? []), ...(data?.excluded ?? [])]) {
            if (!tagsStore.has(id) && !reads.unreadable.has(id) && !tagIdsBeingCreated.has(id)) ids.add(id);
        }
    }
    if (!ids.size) return;

    reads.reading = true;
    readSavedFilterTags([...ids])
        .catch(error => {
            console.error('Error reading the tags of saved filters:', error);
            reads.failedAt = Date.now();
        })
        .finally(() => { reads.reading = false; });
}

/** @param {string[]} ids */
async function readSavedFilterTags(ids) {
    const reads = savedFilterTagReads;
    /** @type {string[]} */
    const gone = [];
    let failed = false;
    for (let i = 0; i < ids.length && !failed; i += TAG_READ_MAX_IDS) {
        const slice = ids.slice(i, i + TAG_READ_MAX_IDS);
        const answer = await postTagsRead('/api/tags/by-ids', { ids: slice });
        if (!answer || !Array.isArray(answer.tags) || !Array.isArray(answer.gone)) {
            failed = true;
            break;
        }
        mergeServerTagDefinitions(answer.tags);
        const goneHere = new Set(answer.gone.map(String));
        for (const id of slice) {
            if (goneHere.has(id)) gone.push(id);
            else if (!tagsStore.has(id)) reads.unreadable.add(id);
        }
    }
    reads.failedAt = failed ? Date.now() : 0;
    removeGoneTagFilters(gone);
    printAllTagFilters();
}

/**
 * Removes the saved filters on tags the server says are gone, and tells the user which.
 * @param {string[]} goneIds
 */
function removeGoneTagFilters(goneIds) {
    if (!goneIds.length) return;
    const gone = new Set(goneIds);
    const bars = /** @type {[FilterHelper, string][]} */ ([
        [entitiesFilter, t`the character list`],
        [groupCandidatesFilter, t`the characters to add to a group`],
        [groupMembersFilter, t`a group's members`],
    ]);
    /** @type {string[]} */
    const lines = [];
    for (const [helper, barName] of bars) {
        const data = helper.getFilterData(FILTER_TYPES.TAG);
        const storagePrefix = getFilterStorageKey(helper);
        let removedAny = false;
        /** @param {string[]} list */
        const kept = (list) => (Array.isArray(list) ? list : []).filter(id => {
            if (!gone.has(id)) return true;
            removedAny = true;
            const name = accountStorage.getItem(`${storagePrefix}_tagname_${id}`);
            lines.push(name !== null
                ? t`'${escapeHtml(name)}', which filtered ${barName}`
                : t`a tag whose name was not kept (id ${escapeHtml(id)}), which filtered ${barName}`);
            accountStorage.removeItem(`${storagePrefix}_tag_${id}`);
            accountStorage.removeItem(`${storagePrefix}_tagname_${id}`);
            return false;
        });
        // New lists, so the helper sees the change and the list it filters is drawn again.
        const next = { selected: kept(data?.selected), excluded: kept(data?.excluded) };
        if (removedAny) helper.setFilterData(FILTER_TYPES.TAG, next);
    }
    if (!lines.length) return;
    toastr.warning(
        `${t`These tags no longer exist, so the filters on them were removed:`}<br />${lines.join('<br />')}`,
        t`Tag filters removed`,
        { escapeHtml: false, timeOut: 0, extendedTimeOut: 0 },
    );
}

/**
 * What a saved filter's pill shows while this tab has no definition of its tag (it hasn't been read, or a read
 * failed): the name kept with the filter, or the tag's id when none was kept. Not put in `tags`.
 * @param {string|undefined} storagePrefix
 * @param {string} id
 * @returns {Tag}
 */
function savedFilterStandIn(storagePrefix, id) {
    const name = storagePrefix ? accountStorage.getItem(`${storagePrefix}_tagname_${id}`) : null;
    return { id, name: name ?? id, folder_type: TAG_FOLDER_DEFAULT_TYPE, color: '', color2: '' };
}

/**
 * @param {Tag[]} shown The used tags a bar draws.
 * @param {FilterHelper} filterHelper The bar's filter.
 * @returns {Tag[]} `shown`, followed by the tags the bar is filtered by that aren't among them: a filter always has
 *   a pill, which is how it is seen and cleared.
 */
function withSavedFilterTags(shown, filterHelper) {
    const data = filterHelper.getFilterData(FILTER_TYPES.TAG);
    const storagePrefix = getFilterStorageKey(filterHelper);
    const shownIds = new Set(shown.map(tag => tag.id));
    /** @type {Tag[]} */
    const extra = [];
    for (const [state, ids] of /** @type {[string, string[]][]} */ ([['SELECTED', data?.selected], ['EXCLUDED', data?.excluded]])) {
        for (const id of Array.isArray(ids) ? ids : []) {
            const held = tagsStore.get(id);
            // The name kept with the filter follows a rename.
            if (held && storagePrefix) saveTagFilterName(storagePrefix, id, state, held.name);
            const tag = held ?? savedFilterStandIn(storagePrefix, id);
            if (shownIds.has(id)) continue;
            shownIds.add(id);
            extra.push(tag);
        }
    }
    return extra.length ? [...shown, ...extra.sort(compareTagsForSort)] : shown;
}

/**
 * What each filter bar last drew, so printTagFilters(), which runs on every render, redraws the pills only when they
 * differ.
 * @type {Map<number, string>}
 */
const tagFilterRenderCache = new Map();

function printTagFilters(type = tag_filter_type.character) {
    readUsedTagsIfNeeded();
    readSavedFilterTagsIfNeeded();

    let FILTER_SELECTOR;
    let filterHelper;
    switch (type) {
        case tag_filter_type.group_candidates_list:
            FILTER_SELECTOR = GROUP_FILTER_SELECTOR;
            filterHelper = groupCandidatesFilter;
            break;
        case tag_filter_type.group_members_list:
            FILTER_SELECTOR = GROUP_MEMBERS_FILTER_SELECTOR;
            filterHelper = groupMembersFilter;
            break;
        case tag_filter_type.character:
        default:
            FILTER_SELECTOR = CHARACTER_FILTER_SELECTOR;
            filterHelper = entitiesFilter;
            break;
    }

    const $filterContainer = $(FILTER_SELECTOR);
    const expanded = $filterContainer.hasClass('tags-expanded');
    const used = usedTagsRead();
    const moreToRead = usedTagBar.chunks.length > 0 && usedTagBar.chunks[usedTagBar.chunks.length - 1].cursor !== null;

    let tagsToDisplay = withSavedFilterTags(expanded ? used : used.slice(0, USED_TAG_BAR_FIRST), filterHelper);
    let inactiveTags = [];
    /** @type {'more' | 'failed' | null} */
    let tail = usedTagBar.failedAt || savedFilterTagReads.failedAt ? 'failed'
        : (moreToRead || (!expanded && used.length > USED_TAG_BAR_FIRST)) ? 'more' : null;

    if (isGroupContext(type)) {
        // CAUTION: when called by openGroupById, the selected_group variable might not yet be updated
        const currentGroup = selected_group ? groupsStore.get(selected_group) : null;
        const visibleAvatars = getVisibleAvatarsForGroupContext(type, currentGroup);

        if (visibleAvatars.length > 0) {
            const activeCharacterTagIdSet = new Set(visibleAvatars.flatMap(avatar => getTagIdsForKey(avatar)));
            inactiveTags = tagsToDisplay
                .filter(x => !activeCharacterTagIdSet.has(x.id))
                .map(x => x.id);
        } else {
            tagsToDisplay = [];
            tail = null;
        }
    }

    // With folders on, the list has no folder rows for "Show only folders" to keep, so the pill is left out;
    // with them off it stays as the way to turn folders on.
    let actionTags = Object.values(ACTIONABLE_TAGS);
    if (power_user.bogus_folders) {
        actionTags = actionTags.filter(x => x !== ACTIONABLE_TAGS.FOLDER);
    } else {
        ACTIONABLE_TAGS.FOLDER.name = 'Enable \'Tags as Folder\'\n\nAllows characters to be grouped in folders by their assigned tags.\nTags have to be explicitly chosen as folder to show up.\n\nClick here to start';
    }

    if (isGroupContext(type)) {
        actionTags = filterActionableTagsForGroupContext(actionTags);
    }

    const inListActionTags = Object.values(InListActionable);

    // Only the action pills are removed and drawn again here; the tag pills are printBigTagFilterList()'s.
    const actionAndInListTags = [...Object.values(ACTIONABLE_TAGS), ...inListActionTags];
    for (const tag of actionAndInListTags) {
        $filterContainer.find(`.tag[id="${tag.id}"]`).remove();
    }

    // Built into the real attached container, not a detached scratch div - getFilterHelper() resolves the
    // correct FilterHelper by walking up from the element at build time, which needs a real ancestor.
    printTagList($filterContainer, { empty: false, sort: false, tags: actionTags, tagActionSelector: tag => tag.action, tagOptions: { isGeneralList: true } });
    printTagList($filterContainer, { empty: false, sort: false, tags: inListActionTags, tagActionSelector: tag => tag.action, tagOptions: { isGeneralList: true } });

    // Move them from the end (where appending puts them) back to the front, preserving relative order.
    for (const tag of [...actionAndInListTags].reverse()) {
        $filterContainer.find(`.tag[id="${tag.id}"]`).prependTo($filterContainer);
    }

    printBigTagFilterList(type, FILTER_SELECTOR, tagsToDisplay, inactiveTags, tail);

    const bogusDrilldown = $filterContainer.siblings('.rm_tag_bogus_drilldown');
    bogusDrilldown.empty();
    if (power_user.bogus_folders && bogusDrilldown.length > 0) {
        const navigatedTags = getOpenBogusFolders();
        printTagList(bogusDrilldown, { tags: navigatedTags, tagOptions: { removable: true } });
    }

    // Not calling runTagFilters here: it would overwrite the loaded filter states with current DOM state,
    // which already matches from loadFilterStatesForContext.
    updateTagFilterVisibility(type, FILTER_SELECTOR);
}

/**
 * Draws a filter bar's tag pills, in the order given, unless they are what the bar drew last.
 * @param {tag_filter_type} type
 * @param {string} FILTER_SELECTOR
 * @param {Tag[]} tagsToDisplay
 * @param {string[]} inactiveTags - ids of tags in tagsToDisplay that should be marked inactive
 * @param {'more' | 'failed' | null} tail - the pill after the tags: more can be shown, or they could not be loaded
 */
function printBigTagFilterList(type, FILTER_SELECTOR, tagsToDisplay, inactiveTags, tail) {
    const $container = $(FILTER_SELECTOR);
    const drawn = JSON.stringify([tagsToDisplay.map(tag => tag.id), inactiveTags, tail]);
    // Folder pills can need drawing again for other reasons than which tags are shown, so with folders on the bar
    // is always drawn again.
    if (!power_user.bogus_folders && tagFilterRenderCache.get(type) === drawn && $container.find('.tag:not(.actionable)').length) return;

    $container.find('.tag:not(.actionable)').remove();
    const inactive = new Set(inactiveTags);
    for (const tag of tagsToDisplay) {
        appendTagToList($container, tag, { isFilter: true, isGeneralList: true, isInactive: inactive.has(tag.id), skipExistsCheck: true });
    }
    if (tail === 'more') {
        /** @type {Tag} */
        const pill = { id: `placeholder_${uuidv4()}`, name: '...', title: t`More tags are not displayed.` + '\n\n' + t`Click to show more.`, color: 'transparent', class: 'placeholder-expander', action: onUsedTagBarMoreClick };
        appendTagToList($container, pill, { skipExistsCheck: true });
    } else if (tail === 'failed') {
        /** @type {Tag} */
        const name = tagQueryNotReady === 'tag-query-not-ready' ? t`Tags are still being indexed after an update. Try again`
            : t`Tags could not be loaded. Try again`;
        const pill = { id: `placeholder_${uuidv4()}`, name, color: 'transparent', class: 'placeholder-expander', action: onUsedTagBarRetryClick };
        appendTagToList($container, pill, { skipExistsCheck: true });
    }
    tagFilterRenderCache.set(type, drawn);
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
        const currentTags = heldTagsForIds(currentTagIds);
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
        const currentTags = heldTagsForIds(currentTagIds);
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
 * @param {object} [options]
 * @param {((tag: Tag) => void) | null} [options.onTagChosen] - Given, a chosen tag goes to it instead of being put on
 *   the open character or group; the caller adds it where it belongs.
 */
export function createTagInput(inputSelector, listSelector, tagListOptions = {}, { onTagChosen = null } = {}) {
    $(inputSelector)
        // @ts-ignore
        .autocomplete({
            source: (i, o) => findTag(i, o, listSelector),
            select: (e, u) => selectTag(e, u, listSelector, { tagListOptions: tagListOptions, onTagChosen }),
            minLength: 0,
        })
        .on('focus', onTagInputFocus); // <== show tag list on click
}

async function onViewTagsListClick() {
    const html = $(document.createElement('div'));
    html.attr('id', 'tag_view_list');
    html.append(await renderTemplateAsync('tagManagement', { bogus_folders: power_user.bogus_folders }));

    const topEdge = $('<div class="tag_view_list_edge"></div>');
    const tagContainer = $('<div class="tag_view_list_tags ui-sortable"></div>');
    const status = $('<div class="tag_view_list_status"></div>');
    html.append(topEdge, tagContainer, status);

    /** @type {ViewTagList} */
    const state = {
        container: tagContainer,
        topEdge,
        status,
        sort: power_user.tag_sort_mode,
        contains: '',
        beforeFirstId: null,
        trail: [],
        trailCut: false,
        endCursor: undefined,
        emptyReads: 0,
        ownIds: new Set(),
        dragging: false,
        stale: false,
        queued: new Set(),
        chain: Promise.resolve(),
        observer: null,
    };
    viewTagList = state;

    const $sortModeSelect = html.find('#tag_sort_mode_select');
    $sortModeSelect.val(power_user.tag_sort_mode);
    $sortModeSelect.on('change', function () {
        const newMode = $(this).val().toString();
        power_user.tag_sort_mode = newMode;
        saveSettingsDebounced('power_user.tag_sort_mode');
        reloadViewTagList();
        refreshUsedTagBars();
    });

    const $search = html.find('#tag_view_search');
    $search.on('input', debounce(() => reloadViewTagList(), debounce_timeout.standard));

    // A re-read that waited for the user to finish typing into a row runs once the focus has left the rows.
    tagContainer.on('focusout', (evt) => {
        if (state.stale && !(evt.relatedTarget instanceof Node && tagContainer[0].contains(evt.relatedTarget))) {
            setTimeout(refreshViewTagList, 0);
        }
    });

    reloadViewTagList();
    makeTagListDraggable(tagContainer);

    await callGenericPopup(html, POPUP_TYPE.TEXT, null, {
        allowVerticalScrolling: true,
        wide: true,
        large: true,
        onOpen: () => watchViewTagEdges(state),
    });
    state.observer?.disconnect();
    if (viewTagList === state) viewTagList = null;
    scheduleTagSweep();
}

function redrawAfterTagSortOrderChange() {
    // Sort order only changes pill order within a row (and the filter bar), never which rows/folders are
    // shown, so patching every currently-rendered row's own pills covers it without a full reprint.
    printTagFilters(tag_filter_type.character);
    printTagFilters(tag_filter_type.group_members_list);
    printTagFilters(tag_filter_type.group_candidates_list);
    updateEntityRowTags(getAllRenderedEntityKeys());
}

/** @param {string} id */
function tagNameForWarning(id) {
    return tagsStore.get(id)?.name ?? id;
}

/**
 * The warning for a tag move the server refused. Says what public/script.js's tagMoveFailedText() says for the same
 * refusal of a queued move.
 * @param {string} id The moved tag.
 * @param {string} anchorId
 * @param {{ id: string, reason: string }} refusal
 */
function tagMoveRefusedText(id, anchorId, refusal) {
    const tag = tagNameForWarning(id);
    const anchor = tagNameForWarning(anchorId);
    const prefix = `Couldn't move tag "${tag}" next to "${anchor}": `;
    const refused = tagNameForWarning(refusal.id);
    switch (refusal.reason) {
        case 'deleted':
        case 'missing': return `${prefix}"${refused}" was deleted.`;
        case 'unreadable': return `${prefix}the stored data of "${refused}" couldn't be read.`;
        case 'unordered': return `${prefix}"${anchor}" is too far into the tags with no order.`;
        case 'no-room': return `${prefix}there was no room left in the order.`;
        default: return `${prefix}${refusal.reason}.`;
    }
}

// Tag moves go to the server one at a time, in the order made: each anchor means a place in the order the move
// before it left. A re-read of the tags joins the same chain, so it never lands in the middle of a move.
let tagOrderChain = Promise.resolve();

/**
 * Sends one reorder as an action and shows the server's answer. In Manual the tag is moved; in another sort mode the
 * server first makes that mode's order the manual one, then moves it.
 * @param {string} id The moved tag.
 * @param {{ before: string } | { after: string }} placement The tag it was put next to.
 * @param {string} mode The tag sort mode the move was made in.
 */
async function moveTagOnServer(id, placement, mode) {
    const manual = mode === tag_sort_mode.MANUAL;
    const anchorId = 'before' in placement ? placement.before : placement.after;
    let answer;
    try {
        const response = await fetch(manual ? '/api/tags/move' : '/api/tags/reorder', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(manual ? { id, ...placement } : { id, ...placement, mode }),
            cache: 'no-cache',
        });
        if (!response.ok) {
            throw new Error(`Failed to move tag: ${response.statusText}`);
        }
        answer = await response.json();
    } catch (error) {
        console.error(`Error moving tag ${id}:`, error);
        toastr.error(`Couldn't move tag "${tagNameForWarning(id)}": the request failed. The order is unchanged.`, 'Moving Tag');
        refreshViewTagList();
        return;
    }

    if (answer.refused?.length) {
        toastr.warning(answer.refused.map(r => escapeHtml(tagMoveRefusedText(id, anchorId, r))).join('<br />'), 'Moving Tag', { escapeHtml: false });
        refreshViewTagList();
        for (const refusal of answer.refused) {
            if (refusal.reason === 'deleted' || refusal.reason === 'missing') await resyncRefusedTag(refusal.id);
        }
        return;
    }

    if (!manual && power_user.tag_sort_mode !== tag_sort_mode.MANUAL) {
        power_user.tag_sort_mode = tag_sort_mode.MANUAL;
        $('#tag_sort_mode_select').val(tag_sort_mode.MANUAL);
        toastr.info('Switched to Manual sorting mode.');
        saveSettingsDebounced('power_user.tag_sort_mode');
    }

    // The rows are where the user put them. Manage Tags reads on in the manual order, from its last row: the move
    // may have renumbered the tags around it.
    if (viewTagList) {
        viewTagList.sort = tag_sort_mode.MANUAL;
        viewTagList.endCursor = undefined;
    }

    refreshUsedTagBars();

    // A queued move has written no sort_order yet; the tag changes feed brings the order once it is applied.
    if (answer.queued) return;

    let changed = false;
    for (const { id: writtenId, sort_order } of answer.written ?? []) {
        const tag = tagsStore.get(writtenId);
        if (!tag || tag.sort_order === sort_order) continue;
        tag.sort_order = sort_order;
        noteStoredTagFields(writtenId, { sort_order });
        changed = true;
    }
    if (changed) {
        redrawAfterTagSortOrderChange();
    }
}

/**
 * Takes the server's definitions of `serverTags` into the tags this tab holds, in place: a held tag keeps its object
 * and takes the server's fields. A tag it doesn't hold is left out, unless something was drawn without it because the
 * server had none (it is taken in and drawn now); whatever else shows it reads it when drawn. Redraws
 * each drawn field that changed except the order. Left as they are: a field an extension changed on the object that
 * hasn't been stored yet.
 * @param {Tag[]} serverTags
 * @returns {{ anyChanged: boolean, sortOrderChanged: boolean }}
 */
function takeInServerTagDefinitions(serverTags) {
    let sortOrderChanged = false;
    let anyChanged = false;
    let drawnWithout = false;
    for (const serverTag of serverTags) {
        if (!isTagObject(serverTag)) continue;
        const local = tagsStore.get(serverTag.id);
        if (local === serverTag) continue;
        if (!local) {
            // Something was drawn without it while the server had none: it is taken in and drawn now. Any other tag
            // this tab doesn't hold is left out; a draw that meets it reads it then.
            if (tagIdsWithoutDefinition.delete(serverTag.id)) {
                addStoredTag(serverTag);
                anyChanged = true;
                drawnWithout = true;
            }
            continue;
        }
        if (!storedTagFields.has(local.id)) continue;
        const old = { ...local };
        const unstored = tagFieldsChangedOnObject(local).patch;
        takeServerTagFields(local, serverTag);
        if (unstored) Object.assign(local, unstored);
        for (const [field, redraw] of Object.entries(TAG_FIELD_REDRAWS)) {
            if (old[field] === local[field]) continue;
            anyChanged = true;
            if (field === 'sort_order') sortOrderChanged = true; else redraw(local);
        }
    }
    tagsStore.reindex();
    if (anyChanged) {
        invalidateTagsFuseIndex();
        invalidateCharactersFuseIndex();
        invalidateGroupsFuseIndex();
        applyCharacterTagsToMessageDivs();
    }
    if (drawnWithout) redrawTagsOnScreen();
    return { anyChanged, sortOrderChanged };
}

/**
 * Makes the tag definitions this tab holds match the server's, in place: `tags` stays the same array and a tag that
 * is still there stays the same object. Each held tag is read by id, sending a hash of the copy held, so only what
 * changed is downloaded; a tag the server no longer has is dropped.
 * @returns {Promise<boolean>} false if the server couldn't be read; what was read before that is kept.
 */
async function rereadTagDefinitions() {
    const ids = tags.filter(tag => isTagObject(tag) && storedTagFields.has(tag.id)).map(tag => tag.id);
    let sortOrderChanged = false;
    /** @type {{ id: string }[]} */
    const gone = [];
    let readAll = true;
    for (let i = 0; i < ids.length; i += TAG_READ_MAX_IDS) {
        const chunk = ids.slice(i, i + TAG_READ_MAX_IDS);
        /** @type {Record<string, string>} */
        const known = {};
        for (const id of chunk) known[id] = contentHashOf(storedTagFields.get(id));
        const answer = await postTagsRead('/api/tags/by-ids', { ids: chunk, known });
        if (!answer || !Array.isArray(answer.tags) || !Array.isArray(answer.gone)) {
            readAll = false;
            break;
        }
        if (takeInServerTagDefinitions(answer.tags).sortOrderChanged) sortOrderChanged = true;
        for (const id of answer.gone) gone.push({ id: String(id) });
    }
    await dropTagsLocally(gone);
    if (sortOrderChanged) redrawAfterTagSortOrderChange();
    refreshViewTagList();
    refreshUsedTagBars();
    return readAll;
}

/**
 * Where in the server's tag change log (/api/tags/changes) this tab's tags are current to. null: not known, so the
 * next ask is answered with a re-read.
 * @type {number | null}
 */
let tagChangesSeq = null;
// Set once loadTagsFromServer() has filled `tags`; until then the feed is not asked, and the load asks once it ends.
let tagsLoadedOnce = false;
let tagChangesAskQueued = false;

/**
 * Brings this tab's tags up to the server's tag change log: asks what changed past this tab's cursor, page by page,
 * and takes each changed tag's definition in or drops it. When the server can't say what changed (a background
 * pass or a reorder rewrote many, or the cursor is of no use to it), re-reads the tags this tab holds instead. A
 * failed request leaves the cursor where it was, so the next ask covers the same changes.
 */
async function takeInTagChanges() {
    for (;;) {
        const page = await postTagsRead('/api/tags/changes', { sinceSeq: tagChangesSeq });
        if (!page || typeof page.seq !== 'number') return;
        if (page.reset) {
            if (await rereadTagDefinitions()) tagChangesSeq = page.seq;
            return;
        }

        const changedTags = Array.isArray(page.tags) ? page.tags : [];
        const removed = Array.isArray(page.removed) ? page.removed : [];
        const { sortOrderChanged } = takeInServerTagDefinitions(changedTags);
        const drops = removed
            .filter(removal => typeof removal?.id === 'string' && tagsStore.has(removal.id))
            .map(({ id, mergedInto }) => ({ id, replaceWithId: typeof mergedInto === 'string' ? mergedInto : undefined }));
        await dropTagsLocally(drops);
        if (sortOrderChanged) redrawAfterTagSortOrderChange();
        // Manage Tags and the filter bars show tags this tab may not hold.
        if (changedTags.length || removed.length) {
            refreshViewTagList();
            refreshUsedTagBars();
        }
        tagChangesSeq = page.seq;
        if (!page.hasMore) return;
    }
}

/**
 * The server's tag definitions changed ('tags-changed' or 'tag-order-settled' on the changes stream), or the stream
 * is back after a break that may have swallowed such a message. Any number of calls while one ask is waiting its
 * turn make one ask.
 */
export function onTagsChanged() {
    if (!tagsLoadedOnce || tagChangesAskQueued) return;
    tagChangesAskQueued = true;
    tagOrderChain = tagOrderChain.then(() => {
        tagChangesAskQueued = false;
        return takeInTagChanges();
    }).catch(error => console.error('Error taking in tag changes:', error));
}

function makeTagListDraggable(tagContainer) {
    // @ts-ignore
    $(tagContainer).sortable({
        delay: getSortableDelay(),
        // 'update', not 'stop': a row dropped back where it was changed nothing, so nothing is sent.
        update: (_event, ui) => {
            const id = ui.item.attr('id');
            const next = ui.item.next('.tag_view_item').attr('id');
            const previous = ui.item.prev('.tag_view_item').attr('id');
            const placement = next ? { before: next } : previous ? { after: previous } : null;
            if (!id || !placement) return;
            const mode = power_user.tag_sort_mode;
            tagOrderChain = tagOrderChain.then(() => moveTagOnServer(id, placement, mode))
                .catch(error => console.error(`Error moving tag ${id}:`, error));
        },
        handle: '.drag-handle',
        items: '> .tag_view_item',
        start: () => {
            if (viewTagList) viewTagList.dragging = true;
        },
        // Reads that waited for the drag to end run now.
        stop: () => {
            const state = viewTagList;
            if (!state) return;
            state.dragging = false;
            if (state.stale) refreshViewTagList();
            recheckViewTagEdges(state);
        },
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
 * @param {object} result - the answer of /api/tags/restore
 * @returns {string[]} one line per thing the restore did not apply
 */
function tagRestoreReportLines(result) {
    const lines = [];
    for (const json of result.invalidTags) {
        lines.push(`Tag object is invalid: ${json}.`);
    }
    for (const { id, name, existingId } of result.keptTags) {
        lines.push(existingId === id ? `Tag '${name}' with id ${id} already exists.` : `Tag with name '${name}' already exists.`);
    }
    for (const { id, name } of result.namesTaken) {
        lines.push(`Tag with id ${id} was not renamed to '${name}': another tag already has that name. Its other settings were restored.`);
    }
    for (const { id, name } of result.unreadableTags) {
        lines.push(`Tag '${name}' with id ${id} was not overwritten: its stored copy is unreadable.`);
    }
    for (const { key, value } of result.invalidKeys) {
        lines.push(`Tag map for key ${key} is invalid: ${value}.`);
    }
    for (const key of result.missingKeys) {
        lines.push(`Tag map key ${key || JSON.stringify(key)} does not exist as character or group.`);
    }
    for (const { key, tagIds } of result.undefinedTagIds) {
        lines.push(`Tag map key ${key}: not assigned, no such tag: ${tagIds.map(tagId => JSON.stringify(tagId)).join(', ')}.`);
    }
    for (const { key, tagIds } of result.deletedTagIds) {
        lines.push(`Tag map key ${key}: not assigned, the tag was deleted: ${tagIds.join(', ')}.`);
    }
    for (const { key, message } of result.failedKeys) {
        lines.push(`Tag map key ${key}: nothing assigned, its stored data couldn't be read: ${message}.`);
    }
    return lines;
}

/** Sends the chosen backup to the server, which restores it, then reads back what the restore changed. */
async function onTagRestoreFileSelect(e) {
    const file = e.target.files[0];

    if (!file) {
        return;
    }

    $('#tag_view_restore_input').val('');
    const data = await parseJsonFile(file);

    if (!data) {
        toastr.warning('Empty file data', 'Tag Restore');
        return;
    }

    if (!data.tags || !data.tag_map || !Array.isArray(data.tags) || typeof data.tag_map !== 'object') {
        toastr.warning('Invalid file format', 'Tag Restore');
        return;
    }

    // Prompt user if they want to overwrite existing tags. The page holds only some of the tags, so the server is
    // asked whether it has any; when it can't say, the question is asked.
    const firstPage = await postTagQuery({ sort: { field: tagQuerySortField() }, pageSize: 1 });
    const serverHasTags = firstPage === null || firstPage === 'invalid-cursor' || (firstPage.rows?.length ?? 0) > 0 || firstPage.more === true;
    let overwrite = false;
    if (serverHasTags) {
        const result = await Popup.show.confirm('Tag Restore', 'You have existing tags. If the backup contains any of those tags, do you want the backup to overwrite their settings (Name, color, folder state, etc)?',
            { okButton: 'Overwrite', cancelButton: 'Keep Existing' });
        overwrite = result === POPUP_RESULT.AFFIRMATIVE;
    }

    /** @type {any} */
    let result = null;
    try {
        const response = await fetch('/api/tags/restore', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ tags: data.tags, tagMap: data.tag_map, overwrite }),
            cache: 'no-cache',
        });
        if (response.status === 503 && (await response.clone().json().catch(() => null))?.reason === 'tag-names-not-indexed') {
            toastr.warning('Tag names are still being indexed after an update. Nothing was restored. Try again in a moment.', 'Tag Restore');
            return;
        }
        if (!response.ok) {
            throw new Error(`Failed to restore the tag backup: ${response.statusText}`);
        }
        result = await response.json();
    } catch (error) {
        console.error('Error restoring the tag backup:', error);
        toastr.error('The restore failed. Part of the backup may have been restored. Restoring it again is safe.', 'Tag Restore');
    }

    const warnings = result ? tagRestoreReportLines(result) : [];
    if (result && !await readTagDefinitionsFromServer([...result.createdTagIds, ...result.updatedTagIds])) {
        warnings.push('Could not read the restored tags back from the server. Reload the page to see them.');
    }

    if (warnings.length) {
        toastr.warning('Tags restored with warnings. Check console or click on this message for details.', 'Tag Restore', {
            timeOut: toastr.options.timeOut * 2, // Display double the time
            onclick: () => Popup.show.text('Tag Restore Warnings', `<samp class="justifyLeft">${DOMPurify.sanitize(warnings.join('\n'))}<samp>`, { allowVerticalScrolling: true }),
        });
        console.warn(`TAG RESTORE REPORT\n====================\n${warnings.join('\n')}`);
    } else if (result) {
        toastr.success('Tags restored successfully.', 'Tag Restore');
    }

    await rereadResidentEntityTagIds();

    // A restore can touch an arbitrary number of tags across an arbitrary number of characters/groups - not a
    // known small set, so there's no smaller-than-full update to target here.
    printCharactersDebounced();
    refreshViewTagList();
    refreshUsedTagBars();
}

function onBackupRestoreClick() {
    $('#tag_view_restore_input')
        .off('change')
        .on('change', onTagRestoreFileSelect)
        .trigger('click');
}

/** Downloads the server's tag backup file: every tag and every character's and group's tags. */
async function onTagsBackupClick() {
    const timestamp = new Date().toISOString().split('T')[0].replace(/-/g, '');
    const filename = `tags_${timestamp}.json`;
    try {
        const response = await fetch('/api/tags/backup', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({}),
            cache: 'no-cache',
        });
        if (!response.ok) throw new Error(response.statusText);
        const blob = await response.blob();
        // A backup cut off mid-stream doesn't parse: it is not handed out as if it were whole.
        JSON.parse(await blob.text());
        download(blob, filename, 'application/json');
    } catch (error) {
        console.error('Could not make the tag backup:', error);
        toastr.error(t`The tag backup could not be made.`, t`Tag Backup`);
    }
}

/** Server-side cap on /api/tags/prune's `limit`. */
const TAG_PRUNE_BATCH_SIZE = 500;

async function onTagsPruneClick() {
    // Only the server can say a tag is unused: this page may not have every card loaded, may not have synced
    // other clients' assignments, and its own usage counts may have failed to load.
    let unusedCount;
    try {
        const response = await fetch('/api/tags/unused-count', { method: 'POST', headers: getRequestHeaders(), body: '{}', cache: 'no-cache' });
        if (!response.ok) throw new Error(response.statusText);
        unusedCount = Number((await response.json()).count);
    } catch (error) {
        console.error('Error counting unused tags:', error);
        toastr.error(t`Could not check which tags are unused. Nothing was pruned.`);
        return;
    }

    if (!unusedCount) {
        toastr.info(t`No unused tags found.`);
        return;
    }

    const confirm = await Popup.show.confirm(t`Prune ${unusedCount} tags`, t`Are you sure you want to remove all unused tags?`);

    if (!confirm) {
        return;
    }

    // The server re-checks usage as it deletes; never delete more than the user confirmed.
    let remaining = unusedCount;
    let failed = false;
    const prunedIds = new Set();
    try {
        while (remaining > 0) {
            const response = await fetch('/api/tags/prune', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ limit: Math.min(remaining, TAG_PRUNE_BATCH_SIZE) }),
                cache: 'no-cache',
            });
            if (!response.ok) throw new Error(response.statusText);
            const { deleted, more } = await response.json();
            for (const id of deleted) prunedIds.add(id);
            remaining -= deleted.length;
            if (!more) break;
        }
    } catch (error) {
        console.error('Error pruning unused tags:', error);
        toastr.error(t`Pruning unused tags failed partway. Some unused tags may remain.`);
        failed = true;
    }

    // Already deleted server-side, so they only need dropping here.
    if (prunedIds.size) {
        let write = 0;
        for (const tag of tags) {
            if (!prunedIds.has(tag.id)) tags[write++] = tag;
        }
        tags.length = write;
        dropFromExportedTags(prunedIds);
        for (const id of prunedIds) {
            storedTagFields.delete(id);
            writeTagNameDraft(id, null);
        }
        tagsStore.reindex();
        invalidateTagsFuseIndex();
        invalidateCharactersFuseIndex();
        invalidateGroupsFuseIndex();
    }

    // Pruned tags are unused by definition - no character/group row displays one, so only the filter buttons
    // (which a pruned tag could still be sitting in) need to drop them, not the character list itself.
    printTagFilters(tag_filter_type.character);
    printTagFilters(tag_filter_type.group_members_list);
    printTagFilters(tag_filter_type.group_candidates_list);
    refreshViewTagList();

    if (!failed) {
        toastr.success(t`Unused tags pruned successfully.`);
    }
}

async function onTagCreateClick() {
    // The server names it: only it knows which names are taken, and it gives the tag its place in the manual order.
    const tag = newTagWithoutOrder('New Tag');
    const outcome = await createTagOnServer(tag, { freeName: true });
    if (outcome === 'failed') {
        toastr.error(t`Check the server connection and try again.`, t`Tags could not be created`);
    }
    if (outcome !== 'stored') return;
    // Upstream's create saves the settings, which is how extensions hear of the new tag.
    await eventSource.emit(event_types.SETTINGS_UPDATED);
    await showOwnTagInViewList(tag.id, { scrollTo: true });

    // A brand new tag isn't assigned to any character/group yet - nothing in the character list can show it.
    printTagFilters(tag_filter_type.character);
    printTagFilters(tag_filter_type.group_members_list);
    printTagFilters(tag_filter_type.group_candidates_list);

    toastr.success('Tag created', 'Create Tag');
}

/**
 * Appends a tag to the view tag list.
 * @param {JQuery<HTMLElement>} list List element
 * @param {Tag} tag Tag object
 * @param {string} count How many characters and groups carry the tag, as shown (viewTagCountText())
 */
function appendViewTagToList(list, tag, count) {
    const template = VIEW_TAG_TEMPLATE.clone();
    template.attr('id', tag.id);
    template.find('.tag_view_counter_value').text(count);
    drawTagViewName(template.find('.tag_view_name'), tag);
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

    const hideToggle = template.find('.eye-toggle');
    drawTagHideToggle(hideToggle, tag);

    hideToggle.on('click', () => onTagHideToggleClick(tag.id));

    list.append(template);

    // Prevents Escape on the color pickers from also closing the popup, unless hit twice.
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

/** @param {string} id */
async function onTagHideToggleClick(id) {
    const tag = tagsStore.get(id);
    if (!tag) return;
    const hidden = !tag.is_hidden_on_character_card;
    const outcome = await storeTagField(id, 'is_hidden_on_character_card', hidden);
    if (outcome === 'failed') {
        tellTagEditFailed(id, hidden ? t`It was not hidden on character cards.` : t`It was not shown on character cards.`);
    }
}

/** @param {JQuery<HTMLElement>} hideToggle @param {Tag} tag */
function drawTagHideToggle(hideToggle, tag) {
    hideToggle.toggleClass('fa-eye-slash', tag.is_hidden_on_character_card);
    hideToggle.toggleClass('fa-eye', !tag.is_hidden_on_character_card);
    hideToggle.attr('title', tag.is_hidden_on_character_card ? t`Hide on character card` : t`Show on character card`);
}

/** @param {string} tagId */
function redrawRowsAfterTagHiddenChange(tagId) {
    if (tagChangeAffectsCurrentView([tagId])) {
        printCharactersDebounced();
    } else {
        updateEntityRowTags(getRenderedKeysWithTag(tagId));
    }
}

async function onTagAsFolderClick() {
    const id = $(this).closest('.tag_view_item').attr('id');
    const tag = tagsStore.get(id);
    if (!tag) return;

    const types = Object.keys(TAG_FOLDER_TYPES);
    const currentTypeIndex = types.indexOf(tag.folder_type);
    const outcome = await storeTagField(id, 'folder_type', types[(currentTypeIndex + 1) % types.length]);
    if (outcome === 'failed') tellTagEditFailed(id, t`Its folder type was not changed.`);
}

function updateDrawTagFolder(element, tag) {
    const tagFolder = TAG_FOLDER_TYPES[tag.folder_type] || TAG_FOLDER_TYPES[TAG_FOLDER_DEFAULT_TYPE];
    const folderElement = element.find('.tag_as_folder');

    Object.keys(TAG_FOLDER_TYPES).forEach(x => {
        folderElement.toggleClass(TAG_FOLDER_TYPES[x].class, TAG_FOLDER_TYPES[x] === tagFolder);
    });

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

    const popupContent = $(await renderTemplateAsync('deleteTag', {}));

    appendTagToList(popupContent.find('#tag_to_delete'), tag);
    // Read from popupContent, not the document: the popup has left the DOM by the time its promise resolves. The
    // select is one of popupContent's own top-level nodes, which find() alone doesn't search.
    const mergeSelect = popupContent.find('#merge_tag_select').addBack('#merge_tag_select');

    const result = await callGenericPopup(popupContent, POPUP_TYPE.CONFIRM, '', {
        // The popup is a modal dialog: a picker list put anywhere else would be drawn under it.
        onOpen: (popup) => initTagSearchSelect(mergeSelect, {
            placeholder: t`Search for a tag to merge into`,
            dropdownParent: $(popup.dlg),
            leaveOut: id,
        }),
    });
    if (result !== POPUP_RESULT.AFFIRMATIVE) {
        return;
    }

    const mergeTagId = mergeSelect.val() ? String(mergeSelect.val()) : null;

    const title = t`Delete Tag`;
    // The name the picker showed: this tab may have dropped the tag since.
    const mergeTagName = mergeTagId ? (mergeSelect.find('option:selected').text() || mergeTagId) : null;

    const answer = await deleteTagOnServer(id, mergeTagId);
    if (!answer) {
        toastr.error(t`'${tag.name}' could not be deleted.`, title);
        return;
    }

    const refusal = answer.refused[0];
    if (refusal) {
        const reason = TAG_REFUSAL_REASONS[refusal.reason] ?? refusal.reason;
        if (refusal.id === mergeTagId) {
            toastr.warning(t`'${tag.name}' was not deleted: '${mergeTagName}', the tag to merge it into, ${reason}.`, title);
        } else {
            toastr.warning(t`'${tag.name}' ${reason}.`, title);
        }
        await resyncRefusedTag(refusal.id);
        return;
    }

    const { mergedInto, target } = answer;
    if (target) mergeServerTagDefinitions([target]);
    const filters = await dropTagLocally(id, { replaceWithId: mergedInto ?? undefined });
    await eventSource.emit(event_types.SETTINGS_UPDATED);
    // The merge target now counts what carried the deleted tag.
    refreshViewTagList();

    const lines = [mergedInto ? t`'${tag.name}' deleted and merged into '${target.name}'.` : t`'${tag.name}' deleted.`];
    if (mergedInto && mergedInto !== mergeTagId) {
        lines.push(t`'${mergeTagName}' had itself been merged into '${target.name}'.`);
    }
    if (filters.held) {
        if (filters.moved) lines.push(t`The filter on it now filters by '${target.name}'.`);
        else if (mergedInto) lines.push(t`The filter on it was removed: '${target.name}' keeps its own.`);
        else lines.push(t`The filter on it was removed.`);
    }
    toastr.success(lines.join(' '), title);
}

const TAG_NAME_DRAFT_KEY_PREFIX = 'TagNameDraft:';

/**
 * A name typed into a tag's row in Manage Tags that the server hasn't stored, kept so it survives a reload. In plain
 * localStorage, not accountStorage, whose write is a debounced network save that may not land before a reload.
 * @param {string} id
 * @returns {string | null} null if the tag has no unsaved name
 */
function readTagNameDraft(id) {
    try {
        return localStorage.getItem(TAG_NAME_DRAFT_KEY_PREFIX + id);
    } catch {
        return null;
    }
}

/** @param {string} id @param {string | null} name - null: the tag has no unsaved name any more */
function writeTagNameDraft(id, name) {
    try {
        if (name === null) localStorage.removeItem(TAG_NAME_DRAFT_KEY_PREFIX + id);
        else localStorage.setItem(TAG_NAME_DRAFT_KEY_PREFIX + id, name);
    } catch (error) {
        console.error(`Could not keep the unsaved name of tag ${id}:`, error);
    }
}

/**
 * Draws a tag's name field in Manage Tags: its unsaved name if it has one, marked as unsaved, else its stored name.
 * Text the field already shows is not set again, which would move the cursor.
 * @param {JQuery<HTMLElement>} nameElement
 * @param {Tag} tag
 */
function drawTagViewName(nameElement, tag) {
    const draft = readTagNameDraft(tag.id);
    const unsaved = draft !== null && draft !== tag.name;
    const shown = unsaved ? draft : tag.name;
    if (nameElement.text() !== shown) nameElement.text(shown);
    nameElement.toggleClass('tag_view_name_unsaved', unsaved);
    if (unsaved) {
        nameElement.attr('title', t`This name is not saved yet. Click it and press Enter to save it.`);
    } else {
        nameElement.removeAttr('title');
    }
}

/** Typing only changes the field: the name is sent when the field is left or Enter is pressed (commitTagRename()). */
function onTagRenameInput() {
    const id = $(this).closest('.tag_view_item').attr('id');
    const tag = tagsStore.get(id);
    if (!tag) return;
    const typed = $(this).text();
    writeTagNameDraft(id, typed === tag.name ? null : typed);
    drawTagViewName($(this), tag);
}

/** @param {JQuery.KeyDownEvent} evt */
function onTagRenameKeydown(evt) {
    // An Enter that confirms an input method's composition is not the user finishing the name.
    if (evt.key !== 'Enter' || evt.originalEvent?.isComposing) return;
    evt.preventDefault();
    const nameElement = /** @type {HTMLElement} */ (evt.currentTarget);
    if (document.activeElement === nameElement) nameElement.blur();
    else commitTagRename(nameElement);
}

/**
 * Sends the name typed into a tag's row in Manage Tags. If it isn't stored, the field keeps what was typed, marked
 * as unsaved, and leaving the field or pressing Enter in it sends it again.
 * @param {HTMLElement} nameElement
 */
async function commitTagRename(nameElement) {
    const id = $(nameElement).closest('.tag_view_item').attr('id');
    const tag = tagsStore.get(id);
    if (!tag) return;
    const name = readTagNameDraft(id);
    if (name === null) return;

    const outcome = await storeTagField(id, 'name', name, (stored) => {
        // Typed further since this name was sent: that text is still unsaved.
        if (readTagNameDraft(id) === stored) writeTagNameDraft(id, null);
    });
    if (outcome === 'failed') {
        tellTagEditFailed(id, t`It was not renamed. The new name is kept in its field: press Enter there to try again.`);
        return;
    }
    if (outcome !== 'stored') return;

    applyCharacterTagsToMessageDivs();
    await showOwnTagInViewList(id);
}

/**
 * Handles the colorization of a tag when the user interacts with the color picker
 *
 * @param {*} evt - The custom colorize event object
 * @param {'color'|'color2'} colorField - Which field on the tag object this picker controls
 * @param {string} cssProperty - The CSS property to apply the color to
 */
function onTagColorize(evt, colorField, cssProperty) {
    const isDefaultColor = isSameCssColor(String($(evt.target).data('default-color') ?? ''), evt.detail.rgba);
    $(evt.target).closest('.tag_view_color_picker').find('.link_icon').toggle(!isDefaultColor);

    const id = $(evt.target).closest('.tag_view_item').attr('id');
    let newColor = evt.detail.rgba;
    if (isDefaultColor) newColor = '';

    // The picker also fires `change` when it is first given its colour, in its own `rgba(...)` spelling.
    const waiting = tagFieldEditsInFlight.get(`${id}\n${colorField}`);
    const currentColor = waiting ? waiting.wanted : (tagsStore.get(id)?.[colorField] ?? '');
    if (isSameCssColor(currentColor, newColor)) return;

    // The row previews the colour being picked; the tag takes it everywhere else once the server has stored it.
    $(evt.target).closest('.tag_view_item').find('.tag_view_name').css(cssProperty, newColor);
    storeTagColor(id, colorField, newColor);
}

/**
 * @param {string} id
 * @param {'color'|'color2'} colorField
 * @param {string} newColor
 */
async function storeTagColor(id, colorField, newColor) {
    const outcome = await storeTagField(id, colorField, newColor);
    if (outcome !== 'refused' && outcome !== 'failed') return;

    // Not stored: the row and its picker go back to the colour the server has.
    const tag = tagsStore.get(id);
    if (!tag) return;
    TAG_FIELD_REDRAWS[colorField](tag);
    const picker = $(`.tag_view_item[id="${id}"] .tag_view_color_picker[data-value="${colorField}"] toolcool-color-picker`);
    if (picker.length) {
        // @ts-ignore
        picker[0].color = tag[colorField] || picker.attr('data-default-color');
    }
    if (outcome === 'failed') tellTagEditFailed(id, t`Its colour was not changed.`);
}

/**
 * Whether two CSS colour strings are the same colour, whatever notation each is written in. An empty string is
 * "no colour" and only equals another empty string.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function isSameCssColor(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    const context = document.createElement('canvas').getContext('2d');
    const canonical = (color) => {
        // An invalid colour leaves fillStyle at whatever it was, so reset it to a known value first.
        context.fillStyle = '#000000';
        context.fillStyle = color;
        return context.fillStyle;
    };
    return canonical(a) === canonical(b);
}

function applyTagColoring(tagId, cssProperty, newColor) {
    $(`.tag[id="${tagId}"]`).css(cssProperty, newColor);
    $(`.bogus_folder_select[tagid="${tagId}"] .avatar`).css(cssProperty, newColor);
}

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
    readUsedTagsIfNeeded();
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
 * Asks the server to add the original's tags to its duplicate.
 * @param {{oldAvatar: string, newAvatar: string}} data Event data
 */
async function copyTags(data) {
    try {
        const response = await fetch('/api/tags/copy', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ from: data.oldAvatar, to: data.newAvatar }),
            cache: 'no-cache',
        });
        if (!response.ok) {
            throw new Error(`Failed to copy tags: ${response.status}`);
        }
    } catch (error) {
        console.error(`Error copying tags from ${data.oldAvatar} to ${data.newAvatar}:`, error);
        toastr.error(t`Tags could not be copied to the duplicate.`);
        return;
    }
    // The duplicate is usually not held yet; one that is takes the server's tags.
    if (resolveTagIdsArray(data.newAvatar) !== undefined) await rereadResidentEntityTagIds([data.newAvatar]);
}

/**
 * Moves the tags of `oldKey` to `newKey`. Upstream's puts what the page holds for `oldKey` in place of what
 * `newKey` had; here the server adds what it has for `oldKey` to what `newKey` has, so nothing `newKey` has is
 * removed, and takes them off `oldKey`.
 * @param {string} oldKey - entity key (character avatar or group id)
 * @param {string} newKey - entity key (character avatar or group id)
 */
function renameTagKey(oldKey, newKey) {
    moveTagsToKey(String(oldKey), String(newKey))
        .catch(error => console.error(`Error moving tags from ${oldKey} to ${newKey}:`, error));
}

/** @param {string} oldKey @param {string} newKey */
async function moveTagsToKey(oldKey, newKey) {
    // What an extension changed through `tag_map` is sent before the server moves what it has.
    tagMapKeysToCheck = true;
    takeInTagExportWrites();
    if (tagCreatesInFlight.size) await Promise.allSettled([...tagCreatesInFlight]);
    await Promise.all([tagSaveChains.get(oldKey), tagSaveChains.get(newKey)]);

    let moved;
    try {
        const response = await fetch('/api/tags/rename-key', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ from: oldKey, to: newKey }),
            cache: 'no-cache',
        });
        if (!response.ok) {
            throw new Error(`Failed to move tags: ${response.status}`);
        }
        ({ moved } = await response.json());
    } catch (error) {
        console.error(`Error moving tags from ${oldKey} to ${newKey}:`, error);
        const nameOfKey = (/** @type {string} */ key) => escapeHtml(String(charactersStore.get(key)?.name ?? groupsStore.get(key)?.name ?? key));
        toastr.error(t`The tags of ${nameOfKey(oldKey)} could not be moved to ${nameOfKey(newKey)}.`, t`Tags could not be saved`, { escapeHtml: false });
        // The server adds before it takes off, so a move that failed part way has lost nothing.
        await rereadResidentEntityTagIds([oldKey, newKey]);
        return;
    }

    // An entry an extension gave `tag_map` for a key the page doesn't hold: upstream's rename deletes it.
    if (!resolveTagIdsArray(oldKey) && Object.hasOwn(tag_map, oldKey)) {
        delete tag_map[oldKey];
        unheldTagMapSent.delete(oldKey);
    }
    await rereadResidentEntityTagIds([oldKey, newKey]);
    if (Array.isArray(moved) && moved.length) await eventSource.emit(event_types.SETTINGS_UPDATED);
}

/**
 * Clears all tags assigned to a given entity key.
 * Exported so other modules (BulkEditOverlay.js) don't need to reach into `setKeyTagIds()` directly.
 * @param {string} key - entity key (character avatar or group id)
 */
export function clearEntityTags(key) {
    setKeyTagIds(key, []);
}

/**
 * Clears all tags assigned to a given entity key (e.g. the character/group was deleted, so there's nothing
 * left to keep them assigned to).
 * Exported so other modules (group-chats.js, script.js) don't need to reach into `removeKeyTagIds()` directly.
 * @param {string} key - entity key (character avatar or group id)
 */
export function removeEntityTags(key) {
    removeKeyTagIds(key);
}

/** How many tags Manage Tags asks the server for at a time. */
const VIEW_TAG_PAGE_SIZE = 100;
/** The most list rows Manage Tags keeps drawn: scrolling on removes the rows furthest behind. */
const VIEW_TAG_MAX_ROWS = 300;
/** The most one /api/tags/query request may ask for. */
const VIEW_TAG_MAX_PAGE_SIZE = 500;
/** How many removed stretches of rows Manage Tags can scroll back through one by one; further back starts at the top. */
const VIEW_TAG_TRAIL_MAX = 100;
/** How many reads in a row may come back cut short by the server's work cap with no tag found before the user is asked whether to go on. */
const VIEW_TAG_EMPTY_READS = 5;
/** The most tags created or renamed in Manage Tags that are kept in view at the top when their place is elsewhere. */
const VIEW_TAG_KEPT_MAX = 50;

/**
 * The open Manage Tags popup's list. Its list rows are a run of the server's tag list (/api/tags/query) in the sort
 * mode and under the search text, at most VIEW_TAG_MAX_ROWS of them. Above them sit the kept rows: tags created or
 * renamed here whose place is outside the run.
 * @typedef {object} ViewTagList
 * @property {JQuery<HTMLElement>} container Holds the rows.
 * @property {JQuery<HTMLElement>} topEdge Right above the container; coming into view asks for the rows before.
 * @property {JQuery<HTMLElement>} status Right below the container; coming into view asks for the rows after. Says
 *   what the list is waiting for.
 * @property {string} sort The tag_sort_mode the rows are in.
 * @property {string} contains The search text the rows match.
 * @property {string | null} beforeFirstId The tag right before the first list row in the server's list; null when
 *   the first list row is the list's first.
 * @property {(string | null)[]} trail For each stretch of rows removed from the top, oldest first, what
 *   `beforeFirstId` was while that stretch was the first drawn.
 * @property {boolean} trailCut The trail's oldest entries were dropped.
 * @property {string | null | undefined} endCursor The cursor after the last list row. null: the list ends there.
 *   undefined: not known, and read by that row's id when needed.
 * @property {number} emptyReads Reads in a row that the server's work cap cut short with nothing found.
 * @property {Set<string>} ownIds Tags created or renamed here since the list was last loaded from its start.
 * @property {boolean} dragging A row is being dragged.
 * @property {boolean} stale The rows need re-reading, which waits until the user is done typing or dragging.
 * @property {Set<string>} queued The kinds of read waiting their turn; a kind waits at most once.
 * @property {Promise<void>} chain Reads run one at a time, in the order asked.
 * @property {IntersectionObserver | null} observer
 */

/** @type {ViewTagList | null} null while Manage Tags is closed. */
let viewTagList = null;

/** @param {ViewTagList} state @returns {JQuery<HTMLElement>} the list rows, without the kept rows */
function viewTagListRows(state) {
    return state.container.children('.tag_view_item:not(.tag_view_item_kept)');
}

/** @param {ViewTagList} state @returns {HTMLElement | null} the element Manage Tags scrolls in */
function viewTagScroller(state) {
    for (let element = state.container[0]?.parentElement; element; element = element.parentElement) {
        const overflowY = getComputedStyle(element).overflowY;
        if (overflowY === 'auto' || overflowY === 'scroll') return element;
    }
    return null;
}

/**
 * Changes the rows while `anchorRow` stays where it is on screen.
 * @param {ViewTagList} state
 * @param {HTMLElement | undefined} anchorRow A row the change leaves in the list.
 * @param {() => void} change
 */
function changeViewTagRowsInPlace(state, anchorRow, change) {
    const topBefore = anchorRow?.isConnected ? anchorRow.getBoundingClientRect().top : null;
    change();
    const scroller = viewTagScroller(state);
    if (topBefore === null || !scroller || !anchorRow.isConnected) return;
    const moved = anchorRow.getBoundingClientRect().top - topBefore;
    if (moved) scroller.scrollTop += moved;
}

/**
 * @param {ViewTagList} state
 * @param {'' | 'loading' | 'failed' | 'paused' | 'end'} kind
 */
function setViewTagStatus(state, kind) {
    const status = state.status.empty().attr('data-status', kind);
    /** @param {string} label @param {string} read */
    const button = (label, read) => $('<div class="menu_button menu_button_icon"></div>').text(label).on('click', () => askForViewTags(read));
    switch (kind) {
        case 'loading':
            status.text(t`Loading tags...`);
            break;
        case 'failed':
            status.append($('<span></span>').text(tagQueryNotReady === 'tag-query-not-ready' ? t`Tags are still being indexed after an update.`
                : t`The tags could not be loaded.`), button(t`Try again`, viewTagListRows(state).length ? 'after' : 'reload'));
            break;
        case 'paused':
            status.append($('<span></span>').text(t`No tag found yet among the ones looked at so far.`), button(t`Keep looking`, 'after'));
            break;
        case 'end':
            if (!state.container.children('.tag_view_item').length) status.text(state.contains ? t`No tags match the search.` : t`There are no tags yet.`);
            break;
    }
}

/**
 * One read of /api/tags/query in the list's sort mode.
 * @param {ViewTagList} state
 * @param {object} read
 * @param {string | null} [read.cursor]
 * @param {number} read.pageSize
 * @param {string[]} [read.ids] Only these tags, whatever the search text; else the tags matching it.
 * @param {boolean} [read.counts]
 * @returns {Promise<{ rows: Tag[], cursor: string | null, more: boolean, counts?: Record<string, number>, approximate?: string[] } | 'invalid-cursor' | null>}
 *   null if the request failed. 'invalid-cursor': the server no longer takes the cursor.
 */
async function queryViewTags(state, { cursor = null, pageSize, ids, counts = true }) {
    const filter = ids ? { ids } : state.contains ? { contains: state.contains } : {};
    return postTagQuery({ filter, sort: { field: state.sort }, pageSize, cursor, counts });
}

/**
 * @param {ViewTagList} state
 * @param {string} id
 * @returns {Promise<string | null | undefined>} the cursor right after tag `id` in the list's sort mode. null: the
 *   server has no such tag. undefined: it could not be read.
 */
async function viewTagCursorAfter(state, id) {
    // A page the tag fills comes back with the cursor at the tag's own place.
    const answer = await queryViewTags(state, { ids: [id], pageSize: 1, counts: false });
    if (!answer || answer === 'invalid-cursor') return undefined;
    return answer.rows.length && typeof answer.cursor === 'string' ? answer.cursor : null;
}

/**
 * Makes rows for the tags of a query answer, after taking the ones this tab doesn't hold into `tags`: a row's
 * controls work on the tag this tab holds.
 * @param {{ rows: Tag[], counts?: Record<string, number>, approximate?: string[] }} answer
 * @param {(id: string) => boolean} [wanted]
 * @returns {HTMLElement[]}
 */
function makeViewTagRows(answer, wanted = () => true) {
    mergeServerTagDefinitions(answer.rows.filter(row => isTagObject(row) && !tagIdsBeingCreated.has(row.id)));
    const holder = $('<div></div>');
    for (const row of answer.rows) {
        const tag = isTagObject(row) && wanted(row.id) ? tagsStore.get(row.id) : null;
        if (tag) appendViewTagToList(holder, tag, viewTagCountText(answer, tag.id));
    }
    return holder.children().toArray();
}

/**
 * @param {{ counts?: Record<string, number>, approximate?: string[] }} answer
 * @param {string} id
 * @returns {string} how many characters and groups carry the tag; `~` marks a count that may be too high.
 */
function viewTagCountText(answer, id) {
    const count = answer.counts?.[id] ?? 0;
    return answer.approximate?.includes(id) ? `~${count}` : String(count);
}

/**
 * Draws a kept row for each tag created or renamed here that has no list row, and removes the kept row of each that
 * has one or is gone.
 * @param {ViewTagList} state
 */
async function syncKeptViewTags(state) {
    const listed = new Set(viewTagListRows(state).map((_, el) => el.id).get());
    for (const id of [...state.ownIds]) {
        if (!tagsStore.has(id)) state.ownIds.delete(id);
    }
    const kept = [...state.ownIds].filter(id => !listed.has(id));
    state.container.children('.tag_view_item_kept').each((_, el) => {
        if (!kept.includes(el.id)) el.remove();
    });
    const missing = kept.filter(id => !state.container.children(`.tag_view_item_kept[id="${id}"]`).length);
    if (!missing.length) return;

    const answer = await queryViewTags(state, { ids: missing, pageSize: missing.length });
    if (!answer || answer === 'invalid-cursor') return;
    const stillListed = new Set(viewTagListRows(state).map((_, el) => el.id).get());
    const rows = makeViewTagRows(answer, id => !stillListed.has(id));
    for (const row of rows) {
        row.classList.add('tag_view_item_kept');
        row.title = t`Kept at the top so you can go on working with it. Its own place in the list is further on.`;
    }
    const firstListRow = viewTagListRows(state)[0];
    changeViewTagRowsInPlace(state, firstListRow, () => {
        if (firstListRow) $(firstListRow).before(rows); else state.container.append(rows);
    });
}

/** @param {ViewTagList} state @returns {boolean} whether the user is typing into a row or dragging one */
function isViewTagListInUse(state) {
    return state.dragging || (!!document.activeElement && state.container[0].contains(document.activeElement));
}

/**
 * Reads the list from its start in the current sort mode and under the search box's text, and draws that.
 * @param {ViewTagList} state
 * @returns {Promise<boolean>} whether rows were drawn
 */
async function reloadViewTags(state) {
    state.sort = power_user.tag_sort_mode;
    state.contains = $('#tag_view_search').val()?.toString().trim() ?? '';
    setViewTagStatus(state, 'loading');
    const answer = await queryViewTags(state, { pageSize: VIEW_TAG_PAGE_SIZE });
    if (!answer || answer === 'invalid-cursor') {
        setViewTagStatus(state, 'failed');
        return false;
    }

    const rows = makeViewTagRows(answer);
    viewTagListRows(state).remove();
    state.container.append(rows);
    state.beforeFirstId = null;
    state.trail = [];
    state.trailCut = false;
    state.endCursor = answer.cursor;
    state.emptyReads = 0;
    state.stale = false;
    await syncKeptViewTags(state);
    setViewTagStatus(state, answer.cursor === null ? 'end' : '');
    return true;
}

/**
 * Reads the rows after the last list row and draws them. Past VIEW_TAG_MAX_ROWS, the rows at the top are removed.
 * @param {ViewTagList} state
 * @returns {Promise<boolean>} whether there may be more to read right away
 */
async function loadViewTagsAfter(state) {
    if (state.endCursor === null || state.dragging) return false;
    setViewTagStatus(state, 'loading');

    let cursor = state.endCursor;
    /** @type {Awaited<ReturnType<typeof queryViewTags>>} */
    let answer = null;
    for (let attempt = 0; attempt < 2; attempt++) {
        if (cursor === undefined) {
            const lastId = viewTagListRows(state).last().attr('id');
            if (!lastId) return reloadViewTags(state);
            cursor = await viewTagCursorAfter(state, lastId);
            // The last row's tag is gone: the rows no longer say where the list goes on.
            if (cursor === null) {
                setViewTagStatus(state, '');
                return refreshViewTags(state);
            }
            if (cursor === undefined) break;
        }
        answer = await queryViewTags(state, { cursor, pageSize: VIEW_TAG_PAGE_SIZE });
        if (answer !== 'invalid-cursor') break;
        cursor = undefined;
    }
    if (!answer || answer === 'invalid-cursor') {
        setViewTagStatus(state, 'failed');
        return false;
    }

    const listed = new Set(viewTagListRows(state).map((_, el) => el.id).get());
    const rows = makeViewTagRows(answer, id => !listed.has(id));
    state.container.append(rows);
    state.endCursor = answer.cursor;
    state.emptyReads = answer.rows.length === 0 && answer.more ? state.emptyReads + 1 : 0;

    const listRows = viewTagListRows(state);
    const extra = listRows.length - VIEW_TAG_MAX_ROWS;
    if (extra > 0) {
        const removed = listRows.slice(0, extra);
        state.trail.push(state.beforeFirstId);
        if (state.trail.length > VIEW_TAG_TRAIL_MAX) {
            state.trail.shift();
            state.trailCut = true;
        }
        state.beforeFirstId = removed.last().attr('id');
        changeViewTagRowsInPlace(state, listRows[extra], () => removed.remove());
    }
    await syncKeptViewTags(state);

    if (answer.cursor === null) {
        setViewTagStatus(state, 'end');
        return false;
    }
    if (state.emptyReads >= VIEW_TAG_EMPTY_READS) {
        state.emptyReads = 0;
        setViewTagStatus(state, 'paused');
        return false;
    }
    setViewTagStatus(state, '');
    return true;
}

/**
 * Reads the stretch of rows before the first list row and draws it. Past VIEW_TAG_MAX_ROWS, the rows at the bottom
 * are removed.
 * @param {ViewTagList} state
 * @returns {Promise<boolean>} whether there may be more to read right away
 */
async function loadViewTagsBefore(state) {
    if (state.beforeFirstId === null || state.dragging) return false;

    /** @type {string | null} */
    let afterId = null;
    /** @type {string | null} */
    let cursor = null;
    for (;;) {
        if (!state.trail.length) {
            if (state.trailCut) return reloadViewTags(state);
            break;
        }
        afterId = state.trail[state.trail.length - 1];
        if (afterId === null) break;
        const found = await viewTagCursorAfter(state, afterId);
        if (found === undefined) return false;
        if (found !== null) {
            cursor = found;
            break;
        }
        // That tag is gone: the stretch before it is read together with this one.
        state.trail.pop();
        afterId = null;
    }

    const answer = await queryViewTags(state, { cursor, pageSize: VIEW_TAG_PAGE_SIZE });
    if (!answer || answer === 'invalid-cursor') return false;
    state.trail.pop();

    const listRows = viewTagListRows(state);
    const listed = new Set(listRows.map((_, el) => el.id).get());
    const reachesRows = answer.rows.findIndex(row => listed.has(row?.id));
    const reachesFirst = reachesRows !== -1 || answer.rows.at(-1)?.id === state.beforeFirstId;
    state.beforeFirstId = afterId;
    if (!reachesFirst) {
        // What was read stops short of the rows drawn: the rows read take their place.
        const rows = makeViewTagRows(answer);
        listRows.remove();
        state.container.append(rows);
        state.endCursor = answer.cursor;
    } else {
        const before = reachesRows === -1 ? answer.rows : answer.rows.slice(0, reachesRows);
        const rows = makeViewTagRows({ ...answer, rows: before }, id => !listed.has(id));
        changeViewTagRowsInPlace(state, listRows[0], () => {
            if (listRows.length) listRows.first().before(rows); else state.container.append(rows);
        });
        const all = viewTagListRows(state);
        if (all.length > VIEW_TAG_MAX_ROWS) {
            all.slice(VIEW_TAG_MAX_ROWS).remove();
            state.endCursor = undefined;
        }
    }
    await syncKeptViewTags(state);
    setViewTagStatus(state, state.endCursor === null ? 'end' : '');
    return true;
}

/**
 * Reads the rows drawn again from the server and draws what it answers: the same stretch of the list, as it is now.
 * Waits while the user is typing into a row or dragging one, so neither is cut off.
 * @param {ViewTagList} state
 * @returns {Promise<boolean>} whether rows were read
 */
async function refreshViewTags(state) {
    if (isViewTagListInUse(state)) {
        state.stale = true;
        return false;
    }

    /** @type {string | null} */
    let cursor = null;
    if (state.beforeFirstId !== null) {
        const found = await viewTagCursorAfter(state, state.beforeFirstId);
        if (found === undefined) return false;
        // The tag the rows started after is gone.
        if (found === null) return reloadViewTags(state);
        cursor = found;
    }
    const shown = viewTagListRows(state).map((_, el) => el.id).get();
    const pageSize = Math.min(VIEW_TAG_MAX_PAGE_SIZE, Math.max(VIEW_TAG_PAGE_SIZE, shown.length));
    const answer = await queryViewTags(state, { cursor, pageSize });
    if (!answer || answer === 'invalid-cursor') return false;
    if (isViewTagListInUse(state)) {
        state.stale = true;
        return false;
    }
    state.stale = false;

    mergeServerTagDefinitions(answer.rows.filter(row => isTagObject(row) && !tagIdsBeingCreated.has(row.id)));
    const wanted = answer.rows.filter(row => isTagObject(row) && tagsStore.has(row.id)).map(row => row.id);
    if (wanted.length === shown.length && wanted.every((id, i) => id === shown[i])) {
        for (const id of wanted) {
            state.container.children(`.tag_view_item[id="${id}"]`).find('.tag_view_counter_value').text(viewTagCountText(answer, id));
        }
    } else {
        const scroller = viewTagScroller(state);
        const scrollTop = scroller?.scrollTop;
        const rows = makeViewTagRows(answer);
        viewTagListRows(state).remove();
        state.container.append(rows);
        if (scroller) scroller.scrollTop = scrollTop;
    }
    state.endCursor = answer.cursor;
    state.emptyReads = 0;
    await syncKeptViewTags(state);
    setViewTagStatus(state, answer.cursor === null ? 'end' : '');
    return true;
}

/**
 * Asks for one read of the open Manage Tags list. Reads run one at a time in the order asked, and a kind of read
 * that is already waiting its turn is not asked for twice.
 * @param {string} kind 'reload', 'refresh', 'after' or 'before'
 * @returns {Promise<void>} settles once the read has run; at once if Manage Tags is closed
 */
function askForViewTags(kind) {
    const state = viewTagList;
    if (!state) return Promise.resolve();
    if (state.queued.has(kind)) return state.chain;
    state.queued.add(kind);
    state.chain = state.chain.then(async () => {
        state.queued.delete(kind);
        if (viewTagList !== state) return;
        const reads = { reload: reloadViewTags, refresh: refreshViewTags, after: loadViewTagsAfter, before: loadViewTagsBefore };
        const mayHaveMore = await reads[kind](state);
        if (mayHaveMore && viewTagList === state) recheckViewTagEdges(state);
    }).catch(error => console.error('Error reading tags for Manage Tags:', error));
    return state.chain;
}

/**
 * Has the edges report again whether they are in view: an edge that stayed in view through a read reports nothing
 * on its own.
 * @param {ViewTagList} state
 */
function recheckViewTagEdges(state) {
    if (!state.observer) return;
    for (const edge of [state.topEdge[0], state.status[0]]) {
        state.observer.unobserve(edge);
        state.observer.observe(edge);
    }
}

/**
 * Starts reading more rows whenever an end of the drawn rows comes near the part of the list in view.
 * @param {ViewTagList} state
 */
function watchViewTagEdges(state) {
    if (state.observer || viewTagList !== state) return;
    state.observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            askForViewTags(entry.target === state.status[0] ? 'after' : 'before');
        }
    }, { root: viewTagScroller(state), rootMargin: '600px 0px' });
    state.observer.observe(state.topEdge[0]);
    state.observer.observe(state.status[0]);
}

/** Reads the open Manage Tags list from its start: the sort mode or the search text changed. */
function reloadViewTagList() {
    viewTagList?.ownIds.clear();
    return askForViewTags('reload');
}

/** Reads the rows of the open Manage Tags list again: tags or their counts changed on the server. */
function refreshViewTagList() {
    return askForViewTags('refresh');
}

/**
 * A tag was created or renamed in Manage Tags: reads its rows again and keeps the tag in view, as a kept row at the
 * top if its place in the list is not among the rows drawn.
 * @param {string} id
 * @param {object} [options]
 * @param {boolean} [options.scrollTo] Scroll the tag's row into view.
 */
async function showOwnTagInViewList(id, { scrollTo = false } = {}) {
    const state = viewTagList;
    if (!state) return;
    const rowOf = () => state.container.children(`.tag_view_item[id="${id}"]`);
    const placeBefore = rowOf().index();
    state.ownIds.add(id);
    if (state.ownIds.size > VIEW_TAG_KEPT_MAX) state.ownIds.delete(state.ownIds.values().next().value);
    await refreshViewTagList();
    if (viewTagList !== state) return;

    const row = rowOf();
    if (scrollTo) row[0]?.scrollIntoView({ block: 'nearest' });
    if (row.length && row.index() !== placeBefore) flashHighlight(row);
}

/**
 * The id of a group with `name`, matched ignoring case and accents, asked of the server.
 * @param {string} name
 * @returns {Promise<string|null>} null when there is none or the server could not be asked
 */
async function findGroupIdByName(name) {
    const answer = await postTagsRead('/api/characters/find', { type: 'group', name });
    const id = Array.isArray(answer?.ids) ? answer.ids[0] : undefined;
    return typeof id === 'string' ? id : null;
}

/**
 * The key of the character or group a tag command's `name` argument names, held or not: with no name, the open group
 * or the current character; else a character with that name or avatar key, else a group with that name. Warns when
 * there is none.
 * @param {string?} name
 * @returns {Promise<string|null>}
 */
async function findTagCommandEntityKey(name) {
    if (!name) return searchCharByName(name);
    const character = await findCharAsync({ name });
    if (character?.avatar) return character.avatar;
    const heldGroup = groups.find(x => equalsIgnoreCaseAndAccents(x.name, name));
    if (heldGroup) return String(heldGroup.id);
    const groupId = await findGroupIdByName(name);
    if (groupId) return groupId;
    toastr.warning(`Character ${name} not found.`);
    return null;
}

function registerTagsSlashCommands() {
    /**
     * Gets a tag by its name. Optionally can create the tag if it does not exist.
     * @param {string} tagName - The name of the tag
     * @param {object} options - Optional arguments
     * @param {boolean} [options.allowCreate=false] - Whether a new tag should be created if no tag with the name exists
     * @returns {Promise<Tag?>} The tag, or null if not found, or if it could not be created (the user has been told)
     */
    async function paraGetTag(tagName, { allowCreate = false } = {}) {
        if (!tagName) {
            toastr.warning('Tag name must be provided.');
            return null;
        }
        const tag = await findTagByName(tagName);
        if (tag) return tag;
        if (allowCreate) return createNewTag(tagName);
        toastr.warning(`Tag ${tagName} not found.`);
        return null;
    }

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'tag-add',
        returns: 'true/false - Whether the tag was added or was assigned already',
        /** @param {{name: string}} namedArgs @param {string} tagName @returns {Promise<string>} */
        callback: async ({ name }, tagName) => {
            const key = await findTagCommandEntityKey(name);
            if (!key) return 'false';
            const tag = await paraGetTag(tagName, { allowCreate: true });
            if (!tag) return 'false';
            if (!resolveTagIdsArray(key)) return String(await saveTagsOnUnheldKey(key, [tag.id], true));
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
        /** @param {{name: string}} namedArgs @param {string} tagName @returns {Promise<string>} */
        callback: async ({ name }, tagName) => {
            const key = await findTagCommandEntityKey(name);
            if (!key) return 'false';
            const tag = await paraGetTag(tagName);
            if (!tag) return 'false';
            if (!resolveTagIdsArray(key)) return String(await saveTagsOnUnheldKey(key, [tag.id], false));
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
        /** @param {{name: string}} namedArgs @param {string} tagName @returns {Promise<string>} */
        callback: async ({ name }, tagName) => {
            const key = await findTagCommandEntityKey(name);
            if (!key) return 'false';
            const tag = await paraGetTag(tagName);
            if (!tag) return 'false';
            const ids = await readEntityTagIds(key);
            if (!ids) {
                toastr.error(t`The server could not be asked which tags it has.`);
                return 'false';
            }
            return String(ids.includes(tag.id));
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
        /** @param {{name: string}} namedArgs @returns {Promise<string>} */
        callback: async ({ name }) => {
            const key = await findTagCommandEntityKey(name);
            if (!key) return '';
            const ids = await readEntityTagIds(key);
            if (!ids) {
                toastr.error(t`The server could not be asked which tags it has.`);
                return '';
            }
            const read = await readTagsForIds(ids);
            if (!read) {
                toastr.error(t`The server could not be asked which tags it has.`);
                return '';
            }
            const tags = [...read.tags.values()].sort(compareTagsForSort);
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
            const key = await findTagCommandEntityKey(name);
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
            const character = charactersStore.get(key) ?? await characterRepository.full(key);
            if (!character) {
                toastr.warning(t`Tag import does not support groups.`);
                return 'false';
            }

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
                const tagIds = getTagIdsForKey(avatarFileName);
                if (tagIds?.length) {
                    const tagNames = heldTagsForIds(tagIds).map(tag => tag.name).filter(Boolean);

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

function updateTagsDivPreview() {
    const preview = $('#tags_div_preview').empty();
    for (const tag of $('#tagList').children('.tag')) {
        const clone = $(tag).clone();
        clone.find('.tag_remove, .tag_delete').remove();
        preview.append(clone);
    }
}

/**
 * Resolves a computed `inset()` clip-path into pixel insets for a box of the given size.
 * @param {string} clipPath Computed clip-path value
 * @param {number} width Border-box width
 * @param {number} height Border-box height
 * @returns {{top: number, right: number, bottom: number, left: number}}
 */
function resolveInsetClipPath(clipPath, width, height) {
    const match = /^inset\(([^)]*)\)/.exec(clipPath);
    if (!match) {
        return { top: 0, right: 0, bottom: 0, left: 0 };
    }
    const values = match[1].trim().split(/\s+/);
    const [top, right = top, bottom = top, left = right] = values;
    const resolve = (/** @type {string} */ value, /** @type {number} */ basis) =>
        value.endsWith('%') ? parseFloat(value) / 100 * basis : parseFloat(value) || 0;
    return {
        top: resolve(top, height),
        right: resolve(right, width),
        bottom: resolve(bottom, height),
        left: resolve(left, width),
    };
}

/** Re-applies the tags panel's and the tag dropdowns' underlay clipping after power_user.stacked_drawers changes. */
export function refreshTagsDrawerUnderlayClip() {
    refreshUnderlayClips();
}

/**
 * The open tags panel overlays the form without reflowing it and is see-through. With stacked drawers on,
 * everything it covers is clipped away by cutting the panel's currently visible rectangle out of each covered
 * element - frame by frame while the panel's clip-path transition runs.
 */
function initTagsDrawerUnderlayClip() {
    const drawer = document.getElementById('tags_div');
    const panel = drawer?.querySelector(':scope > .inline-drawer-content');
    const icon = drawer?.querySelector(':scope > .inline-drawer-header .inline-drawer-icon');
    if (!(panel instanceof HTMLElement) || !icon) {
        return;
    }

    const clip = underlayClip('tags-panel');
    const scrollContainer = scrollContainerOf(drawer);
    let frame = 0;

    function update() {
        if (!power_user.stacked_drawers) {
            clip.clear();
            return;
        }
        const box = panel.getBoundingClientRect();
        const inset = resolveInsetClipPath(getComputedStyle(panel).clipPath, box.width, box.height);
        clip.cover({
            top: box.top + inset.top,
            right: box.right - inset.right,
            bottom: box.bottom - inset.bottom,
            left: box.left + inset.left,
        }, panel, scrollContainer);
    }

    function track() {
        cancelAnimationFrame(frame);
        const step = () => {
            update();
            frame = panel.getAnimations().length > 0 ? requestAnimationFrame(step) : 0;
        };
        frame = requestAnimationFrame(step);
    }

    registerUnderlayClip(update);
    new MutationObserver(track).observe(icon, { attributes: true, attributeFilter: ['class'] });
    const resizeObserver = new ResizeObserver(() => icon.classList.contains('up') && update());
    resizeObserver.observe(panel);
    resizeObserver.observe(scrollContainer);
}


export function initTags() {
    // A page of the list may show fewer tags than the one before it.
    eventSource.on(event_types.CHARACTER_PAGE_LOADED, scheduleTagSweep);
    initTagsDrawerUnderlayClip();
    createTagInput('#tagInput', '#tagList', { tagOptions: { removable: true } });
    createTagInput('#groupTagInput', '#groupTagList', { tagOptions: { removable: true } });

    new MutationObserver(updateTagsDivPreview).observe(document.getElementById('tagList'), { childList: true });
    updateTagsDivPreview();

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
    $(document).on('keydown', '.tag_view_name', onTagRenameKeydown);
    $(document).on('focusout', '.tag_view_name', (evt) => {
        commitTagRename(evt.target);
    });
    $(document).on('click', '.tag_view_create', onTagCreateClick);
    $(document).on('click', '.tag_view_backup', onTagsBackupClick);
    $(document).on('click', '.tag_view_restore', onBackupRestoreClick);
    $(document).on('click', '.tag_view_prune', onTagsPruneClick);
    eventSource.on(event_types.CHARACTER_DUPLICATED, copyTags);
    eventSource.makeFirst(event_types.CHAT_CHANGED, () => selected_group ? applyTagsOnGroupSelect() : applyTagsOnCharacterSelect());

    registerTagsSlashCommands();
    restoreSavedTagFilters();
    watchTagFilterBars();
}
