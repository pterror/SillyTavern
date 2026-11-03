import { showHotswapFavs } from './RossAscends-mods.js';
import { characters, charactersStore, this_avatar } from './character-store.js';
import { getGroupBlock, takeInHeldGroupChanges } from './group-chats.js';
import { groupsStore } from './group-store.js';
import { power_user, sortEntitiesList } from './power-user.js';
import { normalizeFav } from './hash-utils.js';
import { debounce, delay, PAGINATION_TEMPLATE, localizePagination, renderPaginationDropdown, paginationDropdownChangeHandler } from './utils.js';
import { debounce_timeout } from './constants.js';
import { filterByTagState, printTagFilters, printTagList, tag_filter_type, compareTagsForSort, applyTagsOnCharacterSelect, applyTagsOnGroupSelect, heldTagsForIds, searchTagsByName, readTagsForIds, registerFolderCaseHandlers } from './tags.js';
import { tagFetchStamp, isFetchedTagIdsCurrent } from './tag-fetch-stamps.js';
import { FILTER_STATES, FILTER_TYPES, FilterHelper, isFilterState } from './filters.js';
import { characterRepository, buildCharacterQuery, isInvalidSortFieldError, normalizeQueryRow } from './character-repository.js';
import { cleanRanges, parseSearchText, sameView, serializeSearchText, viewToQueryState } from './character-view.js';
import { initViewPills, makeSearchGuide } from './character-view-pills.js';
import { applyKeptView, initSavedViews, refreshSavedViewState, restoreCurrentView } from './saved-views.js';
import { initFolderSwitcher, refreshFolderSwitcher } from './folder-switcher.js';
import { getRandomSortSeed } from './random-sort.js';
import { t } from './i18n.js';
import { updatePersonaConnectionsAvatarList } from './personas.js';
import { Popup } from './popup.js';
import { renderTemplateAsync } from './templates.js';
import { accountStorage } from './util/AccountStorage.js';
import { getPermanentAssistantAvatar } from './welcome-screen.js';
import { event_types, eventSource } from './events.js';
import { getRequestHeaders } from './request-headers.js';
import { characterThumbnail, per_page_default, selectCharacterByAvatar } from '../script.js';

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

export const entitiesFilter = new FilterHelper(printCharactersDebounced);

const TAG_MODE_STORAGE_KEY = 'characterListTagMode';
const RANGES_STORAGE_KEY = 'characterListRanges';
const FOLDER_CASE_STORAGE_KEY = 'characterListFolderCase';

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

function arraysHaveSameMembers(a, b) {
    const setA = new Set(Array.isArray(a) ? a : []);
    const setB = new Set(Array.isArray(b) ? b : []);
    if (setA.size !== setB.size) return false;
    for (const x of setA) {
        if (!setB.has(x)) return false;
    }
    return true;
}

function renderCharacterBlock(template, item, id) {
    const this_avatar = characterThumbnail(item);
    template.attr({ 'data-avatar': item.avatar });
    template.find('img').attr('src', this_avatar).attr('loading', 'lazy').attr('alt', item.name);
    template.find('.avatar').attr('title', `${item.name}\nFile: ${item.avatar}`);
    template.find('.ch_name').text(item.name).attr('title', item.name);
    template.find('.ch_avatar_url').text(power_user.show_card_avatar_urls ? item.avatar : '');
    template.find('.ch_fav_icon').css('display', 'none');
    const isFav = normalizeFav(item.fav);
    template.toggleClass('is_fav', isFav);
    template.find('.ch_fav').val(String(isFav));

    const isAssistant = item.avatar === getPermanentAssistantAvatar();
    template.find('.ch_assistant').toggle(isAssistant);

    const description = item.data?.creator_notes || '';
    template.find('.ch_description').text(description).toggleClass('displayNone', !description);

    const auxFieldName = power_user.aux_field || 'character_version';
    const auxFieldValue = (item.data && item.data[auxFieldName]) || '';
    template.find('.character_version').text(auxFieldValue).toggleClass('displayNone', !auxFieldValue);

    const resident = charactersStore.get(id);
    const rowTagIdsCurrent = isFetchedTagIdsCurrent(id, item.tagFetchStamp);
    if (Array.isArray(item.tag_ids) && rowTagIdsCurrent) {
        if (resident && !arraysHaveSameMembers(resident.tag_ids, item.tag_ids)) {
            charactersStore.update(id, { tag_ids: item.tag_ids });
        }
    }

    const tagsElement = template.find('.tags');
    const rowTagIds = rowTagIdsCurrent ? item.tag_ids : resident?.tag_ids;
    const rowTags = Array.isArray(rowTagIds)
        ? heldTagsForIds(rowTagIds).sort(compareTagsForSort)
        : [];
    printTagList(tagsElement, { forEntityOrKey: id, tags: () => rowTags, tagOptions: { isCharacterList: true } });
}

function getCharacterBlock(item, id) {
    const template = $('#character_template .character_select').clone();
    renderCharacterBlock(template, item, id);
    return template;
}

function updateCharacterBlock(node, item, id) {
    renderCharacterBlock($(node), item, id);
    return node;
}

export function updateCharacterListRow(id) {
    const character = charactersStore.get(id);
    if (!character) return false;
    const row = document.querySelector(`#rm_print_characters_block [data-avatar="${CSS.escape(id)}"]`);
    if (!row) return false;
    updateCharacterBlock(row, character, id);
    replaceRenderedCharacterEntity(id, character);
    return true;
}

export function renameCharacterListRow(previousId, id) {
    const character = charactersStore.get(id);
    if (!character) return false;
    const row = document.querySelector(`#rm_print_characters_block [data-avatar="${CSS.escape(previousId)}"]`);
    if (!row) return false;
    updateCharacterBlock(row, character, id);
    replaceRenderedCharacterEntity(previousId, character);
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
function redrawListRow(row, entity) {
    if (entity.type === 'group') row.replaceWith(getGroupBlock(entity.item).get(0));
    else updateCharacterBlock(row, entity.item, entity.id);
}

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
    if (row) redrawListRow(row, changed);
}

export function redrawUnheldRows() {
    for (const entity of renderedPageEntities) {
        if (!isUnheldRow(entity)) continue;
        const row = listRowOf(entity);
        if (row) redrawListRow(row, entity);
    }
}

export function removeCharacterListRow(id) {
    const row = document.querySelector(`#rm_print_characters_block [data-avatar="${CSS.escape(id)}"]`);
    if (!row) return false;
    row.remove();
    renderedPageEntities = renderedPageEntities.filter(entity => !(entity.type === 'character' && entity.id === id));
    return true;
}

export function refreshCharacterListCurrentPage() {
    if (!serverPagedList) return false;
    const pager = document.getElementById('rm_print_characters_pagination');
    const pagination = pager ? $(pager).data('pagination') : undefined;
    if (!pagination?.initialized) return false;
    keepScrollOnNextRender = !pagination.model?.disabled;
    $(pager).pagination('refresh');
    return true;
}

let keepScrollOnNextRender = false;
/** @type {'top' | 'bottom' | number | null} */
let pageTurnScroll = null;

let pageFetchesInFlight = 0;
let shownRefreshPending = false;
/** @type {{ filter: object, page: number, pageSize: number, result: import('./character-repository.js').CharacterQueryResult } | null} */
let freshPage = null;
let serverPagedList = false;

function pageFetchSettled() {
    pageFetchesInFlight--;
    if (pageFetchesInFlight !== 0) return;
    if (freshPage !== null && listPageContext.query?.filter !== freshPage.filter) freshPage = null;
    if (freshPage !== null && !shownRefreshPending) {
        refreshCharacterListCurrentPage();
        return;
    }
    if (shownRefreshPending) {
        shownRefreshPending = false;
        onCharacterListShown();
    }
}

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

/**
 * @param {boolean} fullRefresh
 */
const SERVER_PAGINATED_DATA_SOURCE = '/api/characters/query';
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
    const storageKey = 'Characters_PerPage';
    const listId = '#rm_print_characters_block';

    let currentScrollTop = $(listId).scrollTop();

    if (fullRefresh || resetListPositionOnNextPrint) {
        resetListPositionOnNextPrint = false;
        saveCharactersPage = 0;
        saveCharactersTotal = 0;
        currentScrollTop = 0;
        keepScrollOnNextRender = false;
        await delay(1);
    }

    verifyCharactersSearchSortRule();

    showViewInSearchBox();
    refreshSavedViewState();
    void refreshFolderSwitcher();

    printTagFilters(tag_filter_type.character);
    printTagFilters(tag_filter_type.group_members_list);
    printTagFilters(tag_filter_type.group_candidates_list);

    applyTagsOnCharacterSelect();
    applyTagsOnGroupSelect();

    const pageSize = Number(accountStorage.getItem(storageKey)) || per_page_default;
    const sizeChangerOptions = [10, 25, 50, 100, 250, 500, 1000];

    function makePageCallback() {
        return async function (/** @type {Entity[]} */ data) {
            const list = $(listId).get(0);

            const existingCharacterRows = new Map();
            for (const child of list.children) {
                if (child instanceof HTMLElement && child.hasAttribute('data-avatar')) {
                    existingCharacterRows.set(child.getAttribute('data-avatar'), child);
                }
            }

            const fragment = document.createDocumentFragment();
            let position = listPageContext.pageOffset;
            for (const i of data) {
                switch (i.type) {
                    case 'character': {
                        const existingRow = existingCharacterRows.get(i.item.avatar);
                        let row;
                        if (existingRow) {
                            existingCharacterRows.delete(i.item.avatar);
                            row = updateCharacterBlock(existingRow, i.item, i.id);
                        } else {
                            row = getCharacterBlock(i.item, i.id).get(0);
                        }
                        row.setAttribute('data-list-position', String(position++));
                        fragment.appendChild(row);
                        break;
                    }
                    case 'group':
                        position++;
                        fragment.appendChild(getGroupBlock(i.item).get(0));
                        break;
                }
            }

            list.replaceChildren();
            renderedPageEntities = data;
            if (!data.length) {
                const emptyBlock = await getEmptyBlock();
                $(list).append(emptyBlock);
            }
            list.appendChild(fragment);
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
        beforePaging: function (/** @type {number} */ pageNumber) {
            const list = $(listId).get(0);
            if (!list) return;
            const atTop = list.scrollTop <= 1;
            const atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 1;
            const current = saveCharactersPage || 1;
            pageTurnScroll = pageNumber > current && atBottom ? 'top'
                : pageNumber < current && atTop ? 'bottom'
                    : list.scrollTop;
        },
        afterPaging: function (e) {
            saveCharactersPage = e;
        },
        afterRender: function () {
            if (pageTurnScroll !== null) {
                const list = $(listId).get(0);
                const to = pageTurnScroll === 'top' ? 0 : pageTurnScroll === 'bottom' ? (list?.scrollHeight ?? 0) : pageTurnScroll;
                pageTurnScroll = null;
                keepScrollOnNextRender = false;
                $(listId).scrollTop(to);
                return;
            }
            if (keepScrollOnNextRender) {
                keepScrollOnNextRender = false;
                return;
            }
            $(listId).scrollTop(currentScrollTop);
        },
    };

    pageFetchesInFlight++;
    try {
        await printServerPaginated();
    } finally {
        pageFetchSettled();
    }

    updatePersonaConnectionsAvatarList();

    async function printServerPaginated() {
        const { filter, sort: wantedSort } = buildCharacterQueryFromCurrentFilterState({ includeGroups: true });

        const freshFor = (/** @type {number} */ page, /** @type {number} */ size) => (/** @type {import('./character-repository.js').CharacterQueryResult} */ result) => {
            freshPage = { filter, page, pageSize: size, result };
            if (pageFetchesInFlight > 0 || listPageContext.query?.filter !== filter) return;
            refreshCharacterListCurrentPage();
        };
        const { sort, result: firstPage } = await queryWithSortFallback(filter, wantedSort,
            trySort => characterRepository.query(filter, trySort, 1, pageSize, PAGE_WANT, { onFresh: freshFor(1, pageSize), favs: hotswapQuery(trySort !== wantedSort) }));
        const favs = hotswapQuery(sort !== wantedSort);

        let pendingFirstPage = firstPage;
        let pageTotalApprox = isApproxTotal(firstPage.total);

        serverPagedList = true;
        $('#rm_print_characters_pagination').pagination({
            ...sharedPaginationOptions,
            dataSource: SERVER_PAGINATED_DATA_SOURCE,
            locator: 'rows',
            formatNavigator: function (currentPage, _totalPage, totalNumber) {
                const rangeStart = (currentPage - 1) * pageSize + 1;
                const rangeEnd = Math.min(currentPage * pageSize, totalNumber);
                return `${rangeStart}-${rangeEnd} .. ${pageTotalApprox ? '~' : ''}${totalNumber}`;
            },
            totalNumber: saveCharactersTotal || undefined,
            resetPageNumberOnInit: false,
            totalNumberLocator: function (/** @type {{total: number|string}} */ response) {
                const parsed = Number(String(response.total).replace(/^~/, ''));
                return Number.isFinite(parsed) ? parsed : 0;
            },
            ajaxFunction: function (ajaxParams) {
                pageFetchesInFlight++;
                const page = ajaxParams.data.pageNumber;
                const requestedPageSize = ajaxParams.data.pageSize;
                const fresh = freshPage !== null && freshPage.filter === filter && freshPage.page === page && freshPage.pageSize === requestedPageSize
                    ? freshPage.result
                    : undefined;
                if (fresh) freshPage = null;
                const resultPromise = (page === 1 && requestedPageSize === pageSize && pendingFirstPage)
                    ? Promise.resolve(pendingFirstPage)
                    : fresh
                        ? Promise.resolve(fresh)
                        : characterRepository.query(filter, sort, page, requestedPageSize, PAGE_WANT, { onFresh: freshFor(page, requestedPageSize), favs });
                pendingFirstPage = undefined;
                resultPromise
                    .then(async result => {
                        const rows = Array.isArray(result.rows) ? result.rows : [];
                        const pageEntities = rows.map(row => queryRowToEntity(row));
                        const parsedTotal = Number(String(result.total ?? 0).replace(/^~/, ''));
                        saveCharactersTotal = Number.isFinite(parsedTotal) ? parsedTotal : 0;
                        pageTotalApprox = isApproxTotal(result.total);
                        listPageContext = {
                            query: { filter, sort },
                            queryKey: JSON.stringify({ filter, sort }),
                            pageOffset: (page - 1) * requestedPageSize,
                            total: saveCharactersTotal,
                            totalApprox: pageTotalApprox,
                        };
                        if (result.searchBackend !== undefined) showSearchBackend(result.searchBackend);
                        if (result.favs) showHotswapFavs(result.favs);
                        ajaxParams.success({ rows: pageEntities, total: result.total });
                    })
                    .catch(error => {
                        console.error('[printCharacters] server-paginated /query failed:', error);
                        keepScrollOnNextRender = false;
                        ajaxParams.error(error);
                    })
                    .finally(pageFetchSettled);
            },
            callback: makePageCallback(),
        });
    }
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
 * @property {Character|Group|import('./scripts/tags.js').Tag|*} item
 * @property {string|number} id
 * @property {'character'|'group'|'tag'} type
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
        folderCase: power_user.bogus_folders ? readFolderCase() : null,
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
    if (power_user.bogus_folders) writeFolderCase(next.folderCase);
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


function buildCharacterQueryFromCurrentFilterState({ includeGroups = false } = {}) {
    return buildCharacterQuery(viewToQueryState(getCharacterView(), { includeGroups }));
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

function queryRowToEntity(row) {
    const { type, item } = normalizeQueryRow(row);
    return type === 'group' ? groupToEntity(item) : characterToEntity(item);
}

function applyFinalFilterRun(entities) {
    const beforeFinalEntities = filterByTagState(entities, { globalDisplayFilters: true });
    let filtered = entitiesFilter.applyFilters(beforeFinalEntities, { clearFuzzySearchCaches: false });

    if (isFilterState(entitiesFilter.getFilterData(FILTER_TYPES.FOLDER), FILTER_STATES.SELECTED) && filtered.filter(x => x.type == 'tag').length == 0) {
        filtered = entitiesFilter.applyFilters(beforeFinalEntities, { tempOverrides: { [FILTER_TYPES.FOLDER]: FILTER_STATES.UNDEFINED }, clearFuzzySearchCaches: false });
    }
    return filtered;
}

const FIND_PAGE_CHUNK_SIZE = 1000;

/**
 * @param {(entity: Entity) => boolean} isEntity
 * @param {number} pageSize
 * @returns {Promise<number>}
 */
export async function findCharacterListPage(isEntity, pageSize) {
    const { filter, sort: wantedSort } = buildCharacterQueryFromCurrentFilterState({ includeGroups: true });
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
    const { filter, sort } = sameView(getCharacterView(), view)
        ? buildCharacterQueryFromCurrentFilterState({ includeGroups: true })
        : buildCharacterQuery(viewToQueryState(view, { includeGroups: true }));
    await characterRepository.pinPage(owner, filter, sort, 1, pageSize, PAGE_WANT);
}

/**
 * @param {string} term
 * @param {string | null} cursor
 * @param {'OPEN'|'CLOSED'} folderType
 * @returns {Promise<{ rows: { id: string, name: string }[], cursor: string | null } | null>}
 */
async function readFolderPage(term, cursor, folderType) {
    const page = await searchTagsByName(term, { pageSize: 50, cursor, folderType });
    return page && { rows: page.rows.map(tag => ({ id: tag.id, name: String(tag.name) })), cursor: page.cursor };
}

/**
 * @param {string} id
 * @param {'OPEN'|'CLOSED'} folderType
 * @returns {Promise<{ id: string, name: string } | null | undefined>}
 */
async function readFolder(id, folderType) {
    const answer = await readTagsForIds([id]);
    if (!answer) return undefined;
    const tag = answer.tags.get(id);
    if (!tag || tag.folder_type !== folderType) return null;
    return { id, name: String(tag.name) };
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
 * @returns {Promise<{seq: number, changes: {id: string, op: 'upsert'|'delete', type?: 'group'}[], hasMore: boolean}>}
 */
async function fetchChangesPage(sinceSeq) {
    const changesResponse = await fetch('/api/characters/changes', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ sinceSeq }),
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
        for (const { id, op, type } of page.changes) {
            const [store, live, gone] = type === 'group' ? [groupsStore, groupsUpserted, groupsDeleted] : [charactersStore, upserted, deleted];
            if (!store.has(id)) continue;
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

/** @type {Record<string, { icon: string, tone: 'warning' | 'error', tooltip: string } | null>} */
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
 * @param {number|string|undefined} total
 * @returns {boolean}
 */
function isApproxTotal(total) {
    return typeof total === 'string' && total.startsWith('~');
}

/** @type {string | null} */
let lastKnownSearchBackend = null;

/**
 * @param {string} searchBackend
 */
function showSearchBackend(searchBackend) {
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
}

export function initCharacterSearch() {
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
            return page ? page.rows.map(tag => ({ id: String(tag.id), name: String(tag.name) })) : null;
        },
        tagNames: async (ids) => {
            const answer = await readTagsForIds(ids);
            if (!answer) return null;
            return {
                names: new Map([...answer.tags].map(([id, tag]) => [id, String(tag.name)])),
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
            list: (term, cursor) => readFolderPage(term, cursor, 'OPEN'),
            get: id => readFolder(id, 'OPEN'),
        },
        pinView: (id, view) => void pinSavedViewPage(id, view),
    });
    initFolderSwitcher({
        after: $('#rm_characters_block .rm_tag_controls').get(0),
        deps: {
            getCase: () => getCharacterView().folderCase,
            setCase: folderCase => setCharacterView({ folderCase }),
            list: (term, cursor) => readFolderPage(term, cursor, 'CLOSED'),
            get: id => readFolder(id, 'CLOSED'),
        },
        translate: t,
    });
    registerFolderCaseHandlers({
        show: folderCase => setCharacterView({ folderCase }),
        read: () => getCharacterView().folderCase,
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
        const isVisible = accountStorage.getItem(storageKey) === 'true';
        searchForm.toggle(isVisible);
        searchButton.toggleClass('active', isVisible);
    });
}
