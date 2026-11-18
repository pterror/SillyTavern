import { showHotswapFavs } from './RossAscends-mods.js';
import { characters, charactersStore, this_avatar } from './character-store.js';
import { getGroupAvatar, takeInHeldGroupChanges } from './group-chats.js';
import { groupsStore } from './group-store.js';
import { power_user, sortEntitiesList } from './power-user.js';
import { normalizeFav } from './hash-utils.js';
import { debounce, delay } from './utils.js';
import { debounce_timeout } from './constants.js';
import { filterByTagState, printTagFilters, printTagList, tag_filter_type, compareTagsForSort, applyTagsOnCharacterSelect, applyTagsOnGroupSelect, heldTagsForIds, searchTagsByName, readTagsForIds, registerFolderCaseHandlers, tagQuerySortField } from './tags.js';
import { tagFetchStamp, isFetchedTagIdsCurrent } from './tag-fetch-stamps.js';
import { FILTER_STATES, FILTER_TYPES, FilterHelper, isFilterState } from './filters.js';
import { characterRepository, buildCharacterQuery, isInvalidSortFieldError, normalizeQueryRow } from './character-repository.js';
import { cleanRanges, parseSearchText, sameView, serializeSearchText, viewToQueryState } from './character-view.js';
import { initViewPills, makeSearchGuide } from './character-view-pills.js';
import { applyKeptView, initSavedViews, refreshSavedViewState, restoreCurrentView } from './saved-views.js';
import { searchReadDivider } from './search-read-progress.js';
import { getRandomSortSeed } from './random-sort.js';
import { t } from './i18n.js';
import { updatePersonaConnectionsAvatarList } from './personas.js';
import { Popup } from './popup.js';
import { accountStorage } from './util/AccountStorage.js';
import { getPermanentAssistantAvatar } from './welcome-screen.js';
import { event_types, eventSource } from './events.js';
import { getRequestHeaders } from './request-headers.js';
import { characterThumbnail, per_page_default, selectCharacterByAvatar } from '../script.js';
import { holdLooks } from './names.js';
import { LIST_LOOKS } from './name-holders.js';
import { newUi, newUiStarted } from './new-ui-page.js';

let saveCharactersPage = 0;

let saveCharactersTotal = 0;

let resetListPositionOnNextPrint = false;

export function resetCharacterListPositionOnNextPrint() {
    resetListPositionOnNextPrint = true;
}

/**
 * @param {FilterHelper} filterHelper
 * @param {string} filterType
 * @param {any} data
 */
export function setFilterDataFromUser(filterHelper, filterType, data) {
    if (filterHelper === entitiesFilter && JSON.stringify(filterHelper.getFilterData(filterType)) !== JSON.stringify(data)) {
        resetListPositionOnNextPrint = true;
    }
    filterHelper.setFilterData(filterType, data);
}

/** @type {debounce_timeout} */
export const DEFAULT_PRINT_TIMEOUT = debounce_timeout.quick;

export const printCharactersDebounced = debounce(() => { printCharacters(false); }, DEFAULT_PRINT_TIMEOUT);

let showViewInSearchBox = () => {};
let drawSearchReadDivider = null;

export const entitiesFilter = new FilterHelper(printCharactersDebounced);

const TAG_MODE_STORAGE_KEY = 'characterListTagMode';
const RANGES_STORAGE_KEY = 'characterListRanges';
const FOLDER_CASE_STORAGE_KEY = 'characterListFolderCase';

function arraysHaveSameMembers(a, b) {
    const setA = new Set(Array.isArray(a) ? a : []);
    const setB = new Set(Array.isArray(b) ? b : []);
    if (setA.size !== setB.size) return false;
    for (const x of setA) {
        if (!setB.has(x)) return false;
    }
    return true;
}

export function updateCharacterListRow(id) {
    const character = charactersStore.get(id);
    if (!character || !renderedPageEntities.some(entity => entity.type === 'character' && entity.id === id)) return false;
    replaceRenderedCharacterEntity(id, character);
    void drawCharacterRows();
    return true;
}

const refreshSavedCharacterList = debounce(() => onCharacterListShown(), 100);

/**
 * Finish a successful character write. Re-query because an edit can change search
 * membership, ordering, counts and favorites, even when its row isn't on this page.
 * Hidden lists are refreshed by onCharacterListShown when opened.
 * @param {Character} character
 * @returns {Promise<void>}
 */
export function characterSaved(character) {
    updateCharacterListRow(character.avatar);
    refreshSavedCharacterList();
    return eventSource.emit(event_types.CHARACTER_EDITED, { detail: { character } });
}

export function renameCharacterListRow(previousId, id) {
    const character = charactersStore.get(id);
    if (!character || !renderedPageEntities.some(entity => entity.type === 'character' && entity.id === previousId)) return false;
    replaceRenderedCharacterEntity(previousId, character);
    void drawCharacterRows();
    return true;
}

/**
 * @param {Entity} entity
 * @returns {boolean}
 */
function isUnheldRow(entity) {
    if (entity.type === 'character') return !charactersStore.has(String(entity.id));
    if (entity.type === 'group') return !groupsStore.has(String(entity.id));
    return false;
}

/**
 * @param {Entity} entity
 * @returns {Element|null}
 */
function listRowOf(entity) {
    const attribute = entity.type === 'group' ? 'data-grid' : 'data-avatar';
    return document.querySelector(`#rm_print_characters_block [${attribute}="${CSS.escape(String(entity.id))}"]`);
}

/**
 * @param {Element} row
 * @param {Entity} entity
 */
/**
 * @returns {Map<string, string[]>}
 */
export function getUnheldRowTagIds() {
    /** @type {Map<string, string[]>} */
    const found = new Map();
    for (const entity of renderedPageEntities) {
        if (!isUnheldRow(entity)) continue;
        found.set(String(entity.id), Array.isArray(entity.item?.tag_ids) ? entity.item.tag_ids : []);
    }
    return found;
}

/**
 * @param {string} key
 * @param {string[]} tagIds
 * @param {number} fetchStamp
 */
export function setUnheldRowTagIds(key, tagIds, fetchStamp) {
    /** @type {Entity|null} */
    let changed = null;
    renderedPageEntities = renderedPageEntities.map((entity) => {
        if ((entity.type !== 'character' && entity.type !== 'group') || String(entity.id) !== key) return entity;
        const item = { ...entity.item, tag_ids: [...tagIds], tagFetchStamp: fetchStamp };
        changed = entity.type === 'group' ? groupToEntity(item) : characterToEntity(item);
        return changed;
    });
    const row = changed && listRowOf(changed);
    if (row) void drawCharacterRows();
}

export function redrawUnheldRows() {
    void drawCharacterRows();
}

export function removeCharacterListRow(id) {
    if (!renderedPageEntities.some(entity => entity.type === 'character' && entity.id === id)) return false;
    renderedPageEntities = renderedPageEntities.filter(entity => !(entity.type === 'character' && entity.id === id));
    void drawCharacterRows();
    return true;
}

export function refreshCharacterListCurrentPage() {
    if (!serverPagedList || !newUiStarted()) return false;
    void loadCharacterPage(saveCharactersPage || 1, listPageSize, { keepScroll: true });
    return true;
}

let listPageSize = 25;
let activeListQuery = null;
let listRequest = 0;
let pageFetchesInFlight = 0;
let shownRefreshPending = false;
let serverPagedList = false;

export function isCharacterListShowing() {
    const panel = document.getElementById('right-nav-panel');
    return Boolean(panel?.classList.contains('openDrawer')) && getComputedStyle(panel).visibility !== 'hidden';
}

export function hasActiveCharacterSearch() {
    return String(entitiesFilter.getFilterData(FILTER_TYPES.SEARCH) ?? '').trim().length > 0;
}

export function onCharacterListShown() {
    if (!isCharacterListShowing()) return;
    if (pageFetchesInFlight > 0) {
        shownRefreshPending = true;
        return;
    }
    if (!serverPagedList) return;
    refreshCharacterListCurrentPage();
}

/** @type {('rows'|'total')[]} */
const PAGE_WANT = ['rows', 'total'];

/** @type {Entity[]} */
let renderedPageEntities = [];

/**
 * @typedef {object} CharacterListPageContext
 * @property {{ filter: object, sort: object|undefined } | null} query
 * @property {string} queryKey
 * @property {number} pageOffset
 * @property {number} total
 * @property {boolean} totalApprox
 */

/** @type {CharacterListPageContext} */
let listPageContext = { query: null, queryKey: '', pageOffset: 0, total: 0, totalApprox: false };

/**
 * @returns {CharacterListPageContext}
 */
export function getCharacterListPageContext() {
    return listPageContext;
}

function replaceRenderedCharacterEntity(previousId, character) {
    renderedPageEntities = renderedPageEntities.map(entity =>
        entity.type === 'character' && entity.id === previousId ? characterToEntity(character) : entity);
}

export async function printCharacters(fullRefresh = false) {
    if (!newUiStarted()) return;
    const reset = fullRefresh || resetListPositionOnNextPrint;
    resetListPositionOnNextPrint = false;
    if (reset) saveCharactersPage = 1;
    verifyCharactersSearchSortRule();
    showViewInSearchBox();
    refreshSavedViewState();
    printTagFilters(tag_filter_type.character);
    printTagFilters(tag_filter_type.group_members_list);
    printTagFilters(tag_filter_type.group_candidates_list);
    applyTagsOnCharacterSelect();
    applyTagsOnGroupSelect();
    listPageSize = Number(accountStorage.getItem('Characters_PerPage')) || per_page_default;
    activeListQuery = buildCharacterQueryFromCurrentFilterState();
    serverPagedList = true;
    await loadCharacterPage(saveCharactersPage || 1, listPageSize, { reset });
    updatePersonaConnectionsAvatarList();
}

/** The repository retains its cache, query pins and fresh-answer callbacks. Solid owns the DOM. */
async function loadCharacterPage(page, size, { reset = false, keepScroll = false } = {}) {
    if (!activeListQuery || !newUiStarted()) return;
    const request = ++listRequest;
    const query = activeListQuery;
    const list = document.getElementById('rm_print_characters_block');
    const oldPage = saveCharactersPage || 1;
    const top = list.scrollTop;
    const bottom = top + list.clientHeight >= list.scrollHeight - 1;
    const scrollTo = reset ? 0 : keepScroll ? top : page > oldPage && bottom ? 'top' : page < oldPage && top <= 1 ? 'bottom' : top;
    let fresh = null;
    let committed = false;
    let resolvedSort = query.sort;
    const commit = async (result, preserveScroll = false) => {
        if (request !== listRequest || query !== activeListQuery) return;
        const scroll = preserveScroll ? list.scrollTop : scrollTo;
        const rows = Array.isArray(result.rows) ? result.rows : [];
        const total = Number(String(result.total ?? 0).replace(/^~/, ''));
        saveCharactersTotal = Number.isFinite(total) ? total : 0;
        const last = Math.max(1, Math.ceil(saveCharactersTotal / size));
        if (page > last && rows.length === 0) {
            await loadCharacterPage(last, size, { keepScroll: true });
            return;
        }
        saveCharactersPage = page;
        listPageSize = size;
        renderedPageEntities = rows.map(queryRowToEntity);
        listPageContext = {
            query: { filter: query.filter, sort: resolvedSort },
            queryKey: JSON.stringify({ filter: query.filter, sort: resolvedSort }),
            pageOffset: (page - 1) * size,
            total: saveCharactersTotal,
            totalApprox: isApproxTotal(result.total),
        };
        if (result.favs) showHotswapFavs(result.favs);
        if (result.looks) holdLooks(LIST_LOOKS, result.looks);
        await drawCharacterRows();
        if (request !== listRequest) return;
        drawSearchReadDivider?.(list, listPageContext.queryKey, listPageContext.pageOffset);
        list.scrollTop = scroll === 'bottom' ? list.scrollHeight : scroll === 'top' ? 0 : scroll;
        await eventSource.emit(event_types.CHARACTER_PAGE_LOADED);
    };
    pageFetchesInFlight++;
    newUi().characterBrowser.loading(true);
    try {
        const answer = await queryWithSortFallback(query.filter, query.sort, trySort => characterRepository.query(query.filter, trySort, page, size, PAGE_WANT, {
            favs: hotswapQuery(trySort !== query.sort), draws: LIST_LOOKS,
            onFresh: result => {
                if (request !== listRequest || query !== activeListQuery) return;
                fresh = result;
                if (committed) void commit(result, true).catch(error => console.error('[characters] fresh page:', error));
            },
        }));
        resolvedSort = answer.sort;
        await commit(fresh ?? answer.result);
        committed = true;
    } catch (error) {
        if (request === listRequest) newUi().characterBrowser.loading(false, error.message ?? String(error));
        console.error('[characters] page query:', error);
    } finally {
        pageFetchesInFlight--;
        if (pageFetchesInFlight === 0 && shownRefreshPending) {
            shownRefreshPending = false;
            onCharacterListShown();
        }
    }
}

export function goToCharacterListPage(page) {
    return loadCharacterPage(page, listPageSize);
}

function browserRow(entity, index) {
    const item = entity.item;
    const group = entity.type === 'group';
    const folder = entity.type === 'folder';
    const members = group ? (item.members ?? []).map(id => charactersStore.get(id)).filter(Boolean) : [];
    const name = folder && item.id === 'none' ? t`Go back` : String(item.name ?? '');
    return {
        id: `${entity.type}:${entity.id}`, entity: String(entity.id), type: entity.type,
        name, thing: String(item.thing ?? ''), image: folder || group ? '' : characterThumbnail(item),
        favorite: normalizeFav(item.fav), assistant: !folder && !group && item.avatar === getPermanentAssistantAvatar(),
        description: String(item.data?.creator_notes ?? ''), auxiliary: String(item.data?.[power_user.aux_field || 'character_version'] ?? ''),
        filename: !folder && !group && power_user.show_card_avatar_urls ? item.avatar : '',
        position: listPageContext.pageOffset + index,
        count: folder ? `${item.countApprox ? '~' : ''}${item.count ?? 0}` : group ? `${members.length} ${members.length === 1 ? t`character` : t`characters`}` : '',
        members: members.map(member => ({ thing: String(member.thing ?? ''), text: member.name, shownAs: 'name' })),
    };
}

async function drawCharacterRows() {
    if (!newUiStarted()) return;
    await newUi().characterBrowser.show({ rows: renderedPageEntities.map(browserRow), page: saveCharactersPage || 1,
        size: listPageSize, total: saveCharactersTotal, approximate: listPageContext.totalApprox });
}

export function characterBrowserUi() {
    const pagination = document.createElement('div');
    document.getElementById('rm_print_characters_pagination').append(pagination);
    return {
        rows: document.getElementById('rm_print_characters_block'), pagination,
        old: {
            page: goToCharacterListPage,
            async size(size) {
                accountStorage.setItem('Characters_PerPage', String(size));
                await loadCharacterPage(1, size, { reset: true });
            },
            tags(element, id) {
                const entity = renderedPageEntities.find(entity => String(entity.id) === id);
                if (!entity) return;
                const row = entity.item;
                const resident = entity.type === 'group' ? groupsStore.get(id) : charactersStore.get(id);
                const current = entity.type === 'group' || isFetchedTagIdsCurrent(id, row.tagFetchStamp);
                const ids = current && Array.isArray(row.tag_ids) ? row.tag_ids : resident?.tag_ids ?? [];
                if (entity.type === 'character' && current && resident && !arraysHaveSameMembers(resident.tag_ids, ids)) charactersStore.update(id, { tag_ids: ids });
                const tags = heldTagsForIds(ids).sort(compareTagsForSort);
                printTagList($(element), { forEntityOrKey: id, tags: () => tags, tagOptions: { isCharacterList: true } });
            },
            avatar(element, id) {
                const entity = renderedPageEntities.find(entity => entity.type === 'group' && String(entity.id) === id);
                const avatar = entity && getGroupAvatar(entity.item)?.get(0);
                if (avatar) { element.className = avatar.className; element.replaceChildren(...avatar.childNodes); }
            },
        },
    };
}

function verifyCharactersSearchSortRule() {
    const searchTerm = entitiesFilter.getFilterData(FILTER_TYPES.SEARCH);
    const searchOption = $('#character_sort_order option[data-field="search"]');
    const isHidden = searchOption.attr('hidden') !== undefined;

    if (searchTerm && isHidden) {
        searchOption.removeAttr('hidden');
        searchOption.prop('selected', true);
    }
    if (!searchTerm && !isHidden) {
        searchOption.attr('hidden', '');
        if (searchOption.is(':selected')) {
            $(`#character_sort_order option[data-order="${power_user.sort_order}"][data-field="${power_user.sort_field}"]`).prop('selected', true);
        }
    }
}

/**
 * @typedef {object} Entity
 * @property {Character|Group|import('./scripts/tags.js').Tag|import('./query-hashes-binary.js').LeadRow|*} item
 * @property {string|number} id
 * @property {'character'|'group'|'tag'|'folder'} type `folder`: an entry for a folder case (a closed folder, or "none", the rest)
 * @property {Entity[]?} [entities=null]
 * @property {number|string?} [hidden=null]
 * @property {number|string?} [total=null]
 * @property {boolean?} [isUseless=null]
 */

/**
 * @param {Character} character
 * @param {string|number} [id]
 * @returns {Entity}
 */
export function characterToEntity(character, id) {
    return { item: character, id: id === undefined ? character?.avatar : id, type: 'character' };
}

/**
 * @param {Group} group
 * @returns {Entity}
 */
export function groupToEntity(group) {
    return { item: group, id: group.id, type: 'group' };
}

/**
 * @param {import('./scripts/tags.js').Tag} tag
 * @returns {Entity}
 */
export function tagToEntity(tag) {
    return { item: structuredClone(tag), id: tag.id, type: 'tag', entities: [] };
}

function isSearchSortSelected() {
    return $('#character_sort_order option[data-field="search"]').is(':selected');
}

const warnedUnsupportedSorts = new Set();

/**
 * @param {string} field
 */
function warnUnsupportedSort(field) {
    if (warnedUnsupportedSorts.has(field)) return;
    warnedUnsupportedSorts.add(field);
    toastr.warning(
        t`The character list can't be sorted by "${field}". It is sorted by name instead, or by relevance while searching.`,
        t`Unsupported sort`,
    );
}

/**
 * @param {import('./character-repository.js').CharacterQueryFilter} filter
 * @returns {import('./character-repository.js').CharacterQuerySort}
 */
function fallbackSort(filter) {
    return filter.search ? { field: 'search', order: 'asc' } : { field: 'name', order: 'asc' };
}

/**
 * @template T
 * @param {import('./character-repository.js').CharacterQueryFilter} filter
 * @param {import('./character-repository.js').CharacterQuerySort|undefined} sort
 * @param {(sort: import('./character-repository.js').CharacterQuerySort|undefined) => Promise<T>} request
 * @returns {Promise<{ sort: import('./character-repository.js').CharacterQuerySort|undefined, result: T }>}
 */
export async function queryWithSortFallback(filter, sort, request) {
    if (!(sort?.field === 'search' && !filter.search)) {
        try {
            return { sort, result: await request(sort) };
        } catch (error) {
            if (!isInvalidSortFieldError(error)) throw error;
        }
    }
    warnUnsupportedSort(String(sort?.field));
    const fallback = fallbackSort(filter);
    return { sort: fallback, result: await request(fallback) };
}

/**
 * @param {FILTER_STATES[keyof FILTER_STATES]|string} state
 * @returns {boolean|undefined}
 */
function triStateToBoolean(state) {
    if (isFilterState(state, FILTER_STATES.SELECTED)) return true;
    if (isFilterState(state, FILTER_STATES.EXCLUDED)) return false;
    return undefined;
}

/**
 * @param {boolean|undefined} value
 * @returns {string}
 */
function booleanToTriState(value) {
    if (value === true) return FILTER_STATES.SELECTED.key;
    if (value === false) return FILTER_STATES.EXCLUDED.key;
    return FILTER_STATES.UNDEFINED.key;
}

/**
 * @returns {'and'|'or'}
 */
function readTagMode() {
    try {
        return accountStorage.getItem(TAG_MODE_STORAGE_KEY) === 'or' ? 'or' : 'and';
    } catch {
        return 'and';
    }
}

/**
 * @returns {import('./character-view.js').CharacterView['ranges']}
 */
function readRanges() {
    try {
        return cleanRanges(JSON.parse(accountStorage.getItem(RANGES_STORAGE_KEY) ?? 'null') ?? undefined);
    } catch {
        return undefined;
    }
}

/**
 * @returns {string}
 */
function readFolderCase() {
    try {
        return accountStorage.getItem(FOLDER_CASE_STORAGE_KEY) || 'none';
    } catch {
        return 'none';
    }
}

/** @param {string|null|undefined} folderCase */
function writeFolderCase(folderCase) {
    const value = folderCase || 'none';
    try {
        if (readFolderCase() === value) return;
        if (value === 'none') accountStorage.removeItem(FOLDER_CASE_STORAGE_KEY);
        else accountStorage.setItem(FOLDER_CASE_STORAGE_KEY, value);
    } catch {
        // The case just isn't remembered.
    }
}

/** @param {import('./character-view.js').CharacterView['ranges']} ranges */
function writeRanges(ranges) {
    const clean = cleanRanges(ranges);
    try {
        if (JSON.stringify(readRanges() ?? null) === JSON.stringify(clean ?? null)) return;
        if (clean) accountStorage.setItem(RANGES_STORAGE_KEY, JSON.stringify(clean));
        else accountStorage.removeItem(RANGES_STORAGE_KEY);
    } catch {
        // The ranges just aren't remembered.
    }
}

/** @param {'and'|'or'} mode */
function writeTagMode(mode) {
    try {
        if (readTagMode() !== mode) accountStorage.setItem(TAG_MODE_STORAGE_KEY, mode);
    } catch {
        // The mode just isn't remembered.
    }
}

/**
 * @returns {import('./character-view.js').CharacterView}
 */
export function getCharacterView() {
    const tagFilterData = entitiesFilter.getFilterData(FILTER_TYPES.TAG) ?? { selected: [], excluded: [] };
    const { text, conditions } = parseSearchText(entitiesFilter.getFilterData(FILTER_TYPES.SEARCH) ?? '');
    const isSearchSort = hasActiveCharacterSearch() && isSearchSortSelected();
    /** @type {{ field: string, order: 'asc'|'desc', seed?: number }} */
    const listSort = power_user.sort_order === 'random'
        ? { field: 'random', order: 'asc', seed: getRandomSortSeed(accountStorage) }
        : { field: power_user.sort_field, order: power_user.sort_order === 'desc' ? 'desc' : 'asc' };
    /** @type {import('./character-view.js').CharacterViewSort} */
    const sort = isSearchSort ? { field: 'search', order: 'asc', tie: listSort } : listSort;
    return {
        text,
        conditions,
        tags: {
            include: [...(tagFilterData.selected ?? [])],
            exclude: [...(tagFilterData.excluded ?? [])],
            mode: readTagMode(),
        },
        ranges: readRanges(),
        fav: triStateToBoolean(entitiesFilter.getFilterData(FILTER_TYPES.FAV)),
        group: triStateToBoolean(entitiesFilter.getFilterData(FILTER_TYPES.GROUP)),
        sort,
        folderCase: readFolderCase(),
    };
}

/**
 * @param {Partial<import('./character-view.js').CharacterView>} view
 * @param {object} [options]
 * @param {boolean} [options.fromSearchBox]
 */
export function setCharacterView(view, { fromSearchBox = false } = {}) {
    const current = getCharacterView();
    const next = { ...current, ...view };
    if (sameView(current, next)) return;

    entitiesFilter.setFilterData(FILTER_TYPES.SEARCH, serializeSearchText(next), true);
    entitiesFilter.setFilterData(FILTER_TYPES.TAG, { selected: [...next.tags.include], excluded: [...next.tags.exclude] }, true);
    writeTagMode(next.tags.mode === 'or' ? 'or' : 'and');
    writeRanges(next.ranges);
    writeFolderCase(next.folderCase);
    entitiesFilter.setFilterData(FILTER_TYPES.FAV, booleanToTriState(next.fav), true);
    entitiesFilter.setFilterData(FILTER_TYPES.GROUP, booleanToTriState(next.group), true);
    if (JSON.stringify(current.sort) !== JSON.stringify(next.sort) && next.sort.field !== 'search') {
        const isRandom = next.sort.field === 'random';
        const option = isRandom
            ? $('#character_sort_order option[data-order="random"]')
            : $('#character_sort_order option').filter((_, el) => el.dataset.field === next.sort.field && el.dataset.order === next.sort.order);
        option.first().prop('selected', true);
        power_user.sort_field = isRandom ? String(option.data('field') ?? 'name') : next.sort.field;
        power_user.sort_order = isRandom ? 'random' : next.sort.order;
        power_user.sort_rule = option.data('rule');
    }
    resetListPositionOnNextPrint = true;
    if (!fromSearchBox) showViewInSearchBox();
    refreshSavedViewState();
    printCharactersDebounced();
}


function buildCharacterQueryFromCurrentFilterState() {
    return listQuery(getCharacterView());
}

/**
 * @param {import('./character-view.js').CharacterView} view
 */
function listQuery(view) {
    return buildCharacterQuery({ ...viewToQueryState(view, { includeGroups: true }), folderOrder: tagQuerySortField() });
}

const HOTSWAP_FAVS_LIMIT = 25;

/**
 * @param {boolean} fallback
 * @returns {import('./character-repository.js').FavsQuery}
 */
function hotswapQuery(fallback) {
    const isRandom = power_user.sort_order === 'random';
    const { filter, sort } = buildCharacterQuery({
        fav: true,
        includeGroups: true,
        searchTerm: entitiesFilter.getFilterData(FILTER_TYPES.SEARCH) || '',
        sortField: isRandom ? 'random' : power_user.sort_field,
        sortOrder: power_user.sort_order === 'desc' ? 'desc' : 'asc',
        randomSeed: isRandom ? getRandomSortSeed(accountStorage) : undefined,
    });
    return { filter, sort: fallback ? fallbackSort(filter) : sort, pageSize: HOTSWAP_FAVS_LIMIT };
}

/** @returns {Entity} */
function queryRowToEntity(row) {
    const { type, item } = normalizeQueryRow(row);
    if (type === 'folder') return { item, id: /** @type {any} */ (item).id, type: 'folder' };
    return type === 'group' ? groupToEntity(item) : characterToEntity(item);
}

function applyFinalFilterRun(entities) {
    const beforeFinalEntities = filterByTagState(entities, { globalDisplayFilters: true });
    return entitiesFilter.applyFilters(beforeFinalEntities, { clearFuzzySearchCaches: false });
}

const FIND_PAGE_CHUNK_SIZE = 1000;

/**
 * @param {(entity: Entity) => boolean} isEntity
 * @param {number} pageSize
 * @returns {Promise<number>}
 */
export async function findCharacterListPage(isEntity, pageSize) {
    const { filter, sort: wantedSort } = buildCharacterQueryFromCurrentFilterState();
    let sort = wantedSort;
    for (let chunk = 1; ; chunk++) {
        const answer = await queryWithSortFallback(filter, sort,
            trySort => characterRepository.query(filter, trySort, chunk, FIND_PAGE_CHUNK_SIZE, ['rows']));
        sort = answer.sort;
        const rows = answer.result.rows ?? [];
        const index = rows.findIndex(row => isEntity(queryRowToEntity(row)));
        if (index !== -1) return Math.floor(((chunk - 1) * FIND_PAGE_CHUNK_SIZE + index) / pageSize) + 1;
        if (rows.length < FIND_PAGE_CHUNK_SIZE) return -1;
    }
}

/**
 * @param {object} param0
 * @param {boolean} [param0.doFilter]
 * @param {boolean} [param0.doSort]
 * @returns {Entity[]}
 */
export function getEntitiesList({ doFilter = false, doSort = true } = {}) {
    let entities = renderedPageEntities.slice();
    if (doFilter) {
        entities = applyFinalFilterRun(filterByTagState(entities));
        entitiesFilter.clearFuzzySearchCaches();
    }
    if (doSort) {
        sortEntitiesList(entities, false);
    }
    return entities;
}

/**
 * @param {string} id
 * @param {import('./character-view.js').CharacterView | null} view
 */
async function pinSavedViewPage(id, view) {
    const owner = `view:${id}`;
    if (!view) {
        await characterRepository.unpinPages(owner);
        return;
    }
    const pageSize = Number(accountStorage.getItem('Characters_PerPage')) || per_page_default;
    const { filter, sort } = listQuery(view);
    await characterRepository.pinPage(owner, filter, sort, 1, pageSize, PAGE_WANT);
}

/**
 * @param {string} term
 * @param {string | null} cursor
 * @returns {Promise<{ rows: { id: string, name: string, thing?: string }[], cursor: string | null } | null>}
 */
async function readOpenFolderPage(term, cursor) {
    const page = await searchTagsByName(term, { pageSize: 50, cursor, folderType: 'OPEN' });
    return page && { rows: page.rows.map(tag => ({ id: tag.id, name: String(tag.name), thing: tag.thing })), cursor: page.cursor };
}

/**
 * Shows the rest case when the folder whose case is shown is no longer a closed folder.
 */
async function leaveGoneFolderCase() {
    const shown = getCharacterView().folderCase;
    if (shown === 'none') return;
    const folder = await readFolder(shown, 'CLOSED');
    if (folder === null && getCharacterView().folderCase === shown) setCharacterView({ folderCase: 'none' });
}

/**
 * @param {string} id
 * @param {'OPEN'|'CLOSED'} folderType
 * @returns {Promise<{ id: string, name: string, thing?: string } | null | undefined>}
 */
async function readFolder(id, folderType) {
    const answer = await readTagsForIds([id]);
    if (!answer) return undefined;
    const tag = answer.tags.get(id);
    if (!tag || tag.folder_type !== folderType) return null;
    return { id, name: String(tag.name), thing: tag.thing };
}

/**
 * @param {string} avatarUrl
 * @returns {Promise<boolean>}
 */
export async function getOneCharacter(avatarUrl) {
    if (!charactersStore.has(avatarUrl)) {
        return false;
    }
    const fetchStamp = tagFetchStamp();
    const response = await fetch('/api/characters/get', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            avatar_url: avatarUrl,
        }),
    });

    if (response.ok) {
        const getData = await response.json();
        getData.chat = getData.chat ? String(getData.chat) : '';
        getData.shallow = false;
        if (!isFetchedTagIdsCurrent(avatarUrl, fetchStamp)) {
            delete getData.tag_ids;
        }

        if (charactersStore.has(avatarUrl)) {
            charactersStore.update(avatarUrl, getData);
            return true;
        }
    }
    return false;
}

/**
 * @param {Character|undefined} character
 * @returns {string}
 */
export function getCharacterSource(character) {
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

/** @type {number | null} */
let changesSeq = null;

/**
 * @param {number} seq
 */
export function startLibraryChangesAt(seq) {
    if (changesSeq === null && Number.isFinite(seq)) changesSeq = seq;
}

/**
 * @param {number} sinceSeq
 * @returns {Promise<{seq: number, changes: {id: string, op: 'upsert'|'delete', type?: 'group', revision?: string}[], hasMore: boolean}>}
 */
async function fetchChangesPage(sinceSeq) {
    const changesResponse = await fetch('/api/characters/changes', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ sinceSeq, revisions: true }),
        signal: AbortSignal.timeout(SYNC_REQUEST_TIMEOUT_MS),
    });
    if (!changesResponse.ok) {
        throw new Error(`Failed to fetch character changes: ${changesResponse.statusText}`);
    }
    return changesResponse.json();
}

/**
 * @returns {Promise<boolean>} Whether a held character changed.
 */
async function syncHeld() {
    if (changesSeq === null) return false;
    let seq = changesSeq;
    /** @type {Set<string>} */
    const upserted = new Set();
    /** @type {Set<string>} */
    const deleted = new Set();
    /** @type {Set<string>} */
    const groupsUpserted = new Set();
    /** @type {Set<string>} */
    const groupsDeleted = new Set();
    for (;;) {
        const page = await fetchChangesPage(seq);
        for (const { id, op, type, revision } of page.changes) {
            const [store, live, gone] = type === 'group' ? [groupsStore, groupsUpserted, groupsDeleted] : [charactersStore, upserted, deleted];
            if (!store.has(id)) continue;
            if (type !== 'group' && op === 'upsert' && revision && charactersStore.get(id)?.card_revision === revision) {
                live.delete(id);
                continue;
            }
            (op === 'delete' ? live : gone).delete(id);
            (op === 'delete' ? gone : live).add(id);
        }
        seq = Math.max(seq, page.seq);
        if (!page.hasMore) break;
    }
    await takeInHeldGroupChanges(groupsUpserted, groupsDeleted);
    if (upserted.size > 0) {
        const full = await characterRepository.readFull([...upserted]);
        for (const avatar of upserted) {
            const character = full.get(avatar);
            if (!character) deleted.add(avatar);
            else if (charactersStore.has(avatar)) charactersStore.update(avatar, character);
        }
    }
    if (deleted.size > 0) {
        let kept = 0;
        for (const character of characters) {
            if (!deleted.has(character.avatar)) characters[kept++] = character;
        }
        characters.length = kept;
    }
    changesSeq = Math.max(changesSeq, seq);
    return upserted.size > 0 || deleted.size > 0;
}

const SYNC_MAX_RETRIES = 3;
const SYNC_RETRY_DELAYS_MS = [1000, 3000, 8000];

const SYNC_REQUEST_TIMEOUT_MS = 60000;

export function showCharacterSyncFailedToast() {
    toastr.error(
        t`Could not sync the character list. Check your connection and refresh the page to retry.`,
        t`Character sync failed`,
        { timeOut: 0, extendedTimeOut: 0, preventDuplicates: true },
    );
}

/**
 * @param {object} [options]
 * @param {boolean} [options.silent=false]
 * @param {boolean} [options.skipPrint=false]
 * @param {boolean} [options.keepListPosition=false]
 */
export async function getCharacters(options = {}) {
    try {
        return await syncCharacters(options);
    } catch (error) {
        console.error('Character sync failed:', error);
        showCharacterSyncFailedToast();
    }
}

async function syncCharacters({ silent = false, skipPrint = false, keepListPosition = false } = {}) {
    let lastError;
    let changed = false;
    for (let attempt = 0; attempt <= SYNC_MAX_RETRIES; attempt++) {
        try {
            changed = await syncHeld();
            lastError = undefined;
            break;
        } catch (error) {
            lastError = error;
            if (attempt < SYNC_MAX_RETRIES) {
                const retryDelay = SYNC_RETRY_DELAYS_MS[attempt];
                console.warn(`Character sync failed (attempt ${attempt + 1}/${SYNC_MAX_RETRIES + 1}), retrying in ${retryDelay}ms:`, error);
                await delay(retryDelay);
            }
        }
    }

    if (changed) {
        if (silent) {
            charactersStore.reindex();
        } else {
            charactersStore.reset();
        }
    }

    if (lastError) {
        console.error(`Character sync failed after ${SYNC_MAX_RETRIES + 1} attempts, giving up:`, lastError);
        showCharacterSyncFailedToast();
        return;
    }

    if (changed && this_avatar) {
        if (charactersStore.get(this_avatar)) {
            await selectCharacterByAvatar(this_avatar, { switchMenu: false });
        } else {
            await Popup.show.text(t`ERROR: The active character is no longer available.`, t`The page will be refreshed to prevent data loss. Press "OK" to continue.`);
            return location.reload();
        }
    }

    if (skipPrint) return;
    await printCharacters(!keepListPosition);
}

/**
 * @param {number|string|undefined} total
 * @returns {boolean}
 */
function isApproxTotal(total) {
    return typeof total === 'string' && total.startsWith('~');
}

export function initCharacterSearch() {
    drawSearchReadDivider = searchReadDivider(accountStorage, isCharacterListShowing, () => t`↑ Unread ↑`);
    /** @type {Partial<import('./character-view.js').CharacterView> | null} */
    let pendingTypedView = null;
    const debouncedCharacterSearch = debounce(() => {
        const view = pendingTypedView;
        pendingTypedView = null;
        if (view) setCharacterView(view, { fromSearchBox: true });
    });
    window.addEventListener('pagehide', () => {
        const view = pendingTypedView;
        pendingTypedView = null;
        if (view) setCharacterView(view, { fromSearchBox: true });
    });

    const searchForm = $('#form_character_search_form');
    const searchInput = $('#character_search_bar');
    const searchButton = $('#rm_button_search');
    const pillsContainer = $('#character_search_pills');

    const storageKey = 'characterSearchFormVisible';

    showViewInSearchBox = initViewPills({
        container: pillsContainer,
        input: searchInput,
        getView: getCharacterView,
        translate: t,
        setView: (view, fromSearchBox) => {
            if (fromSearchBox) {
                pendingTypedView = view;
                debouncedCharacterSearch();
                return;
            }
            pendingTypedView = null;
            setCharacterView(view, { fromSearchBox: true });
        },
        searchTags: async (term) => {
            const page = await searchTagsByName(term);
            return page ? page.rows.map(tag => ({ id: String(tag.id), name: String(tag.name), thing: tag.thing })) : null;
        },
        tagNames: async (ids) => {
            const answer = await readTagsForIds(ids);
            if (!answer) return null;
            return {
                names: new Map([...answer.tags].map(([id, tag]) => [id, String(tag.name)])),
                things: new Map([...answer.tags].flatMap(([id, tag]) => (tag.thing ? [[id, tag.thing]] : []))),
                gone: answer.gone,
                shownAs: new Map([...answer.tags].map(([id, tag]) => [id, String(tag.id)])),
            };
        },
    });
    showViewInSearchBox();
    $('#character_search_bar_wrapper').after(makeSearchGuide());
    initSavedViews({
        before: $('#character_search_bar_wrapper').get(0),
        getView: getCharacterView,
        setView: view => setCharacterView(view),
        sameView,
        headers: () => getRequestHeaders(),
        storage: accountStorage,
        translate: t,
        folders: {
            list: readOpenFolderPage,
            get: id => readFolder(id, 'OPEN'),
        },
        pinView: (id, view) => void pinSavedViewPage(id, view),
    });
    registerFolderCaseHandlers({
        show: folderCase => setCharacterView({ folderCase }),
        read: () => getCharacterView().folderCase,
        listChanged: () => {
            printCharactersDebounced();
            void leaveGoneFolderCase();
        },
        shows: tagId => getCharacterView().folderCase === tagId || renderedPageEntities.some(entity => entity.type === 'folder' && entity.id === tagId),
    });
    $('#rm_print_characters_block').on('click', '.bogus_folder_select[data-folder-case]', function () {
        const folderCase = this.dataset.folderCase;
        if (folderCase) setCharacterView({ folderCase });
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

    eventSource.on(event_types.SETTINGS_LOADED, () => applyKeptView());
    eventSource.on(event_types.APP_READY, () => {
        void restoreCurrentView();
        void leaveGoneFolderCase();
        const isVisible = accountStorage.getItem(storageKey) === 'true';
        searchForm.toggle(isVisible);
        searchButton.toggleClass('active', isVisible);
    });
}
