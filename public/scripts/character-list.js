import { lodash } from '../lib.js';
import { favsToHotswap } from './RossAscends-mods.js';
import { characters, charactersStore, this_avatar, resolveCharacterRef } from './character-store.js';
import { getGroups, getGroupBlock } from './group-chats.js';
import { power_user, sortEntitiesList } from './power-user.js';
import { normalizeFav, SHALLOW_CREATOR_NOTES_HEADER } from './hash-utils.js';
import { debounce, delay, PAGINATION_TEMPLATE, localizePagination, renderPaginationDropdown, paginationDropdownChangeHandler } from './utils.js';
import { debounce_timeout } from './constants.js';
import { filterByTagState, printTagFilters, printTagList, tag_filter_type, compareTagsForSort, applyTagsOnCharacterSelect, applyTagsOnGroupSelect, heldTagsForIds, searchTagsByName, readTagsForIds, registerFolderCaseHandlers } from './tags.js';
import { tagFetchStamp, isFetchedTagIdsCurrent } from './tag-fetch-stamps.js';
import { FILTER_STATES, FILTER_TYPES, FilterHelper, isFilterState } from './filters.js';
import { characterRepository, buildCharacterQuery, isInvalidSortFieldError, normalizeQueryRow, parseQueryTotal } from './character-repository.js';
import { cleanRanges, parseSearchText, sameView, serializeSearchText, viewToQueryState } from './character-view.js';
import { initViewPills, makeSearchGuide } from './character-view-pills.js';
import { initSavedViews, refreshSavedViewState, restoreCurrentView } from './saved-views.js';
import { initFolderSwitcher, refreshFolderSwitcher } from './folder-switcher.js';
import { getRandomSortSeed } from './random-sort.js';
import { t } from './i18n.js';
import { updatePersonaConnectionsAvatarList } from './personas.js';
import { getCachedCursor, setCachedCursor, readCachedCharactersByIds, saveCachedCharacters, removeCachedCharacters, clearCharacterCache, getWriteFailures, setWriteFailures } from './character-cache.js';
import { Popup } from './popup.js';
import { renderTemplateAsync } from './templates.js';
import { accountStorage } from './util/AccountStorage.js';
import { getPermanentAssistantAvatar } from './welcome-screen.js';
import { event_types, eventSource } from './events.js';
import { getRequestHeaders } from './request-headers.js';
import { checkCharactersExistOrNull } from './character-existence-check.js';
import { default_avatar, getCurrentCharacter, per_page_default, selectCharacterByAvatar } from '../script.js';

let saveCharactersPage = 0;

// Seeds pagination.js's totalNumber on reconstruction, or it reads 0 until the first ajax response and clamps
// the page back to 1 (see the resetPageNumberOnInit: false pairing below). Only a full refresh or a query change
// (resetListPositionOnNextPrint) zeroes it; every other reprint stays on the page it was on.
let saveCharactersTotal = 0;

// Only the user changing the query (search term, a filter, the sort, "Tags as folders") sends the list to page 1 at
// the top. A reprint for anything else - a data change, a display setting - keeps the page and scroll distance.
let resetListPositionOnNextPrint = false;

/** For a query change the user made that doesn't go through setFilterDataFromUser(). Only call it when the value changed. */
export function resetCharacterListPositionOnNextPrint() {
    resetListPositionOnNextPrint = true;
}

/**
 * setFilterData() for a search or filter change the user made.
 * @param {FilterHelper} filterHelper
 * @param {string} filterType
 * @param {any} data
 */
export function setFilterDataFromUser(filterHelper, filterType, data) {
    // setFilterData()'s own change test: an unchanged value starts no reprint, so it mustn't leave a reset pending.
    if (filterHelper === entitiesFilter && JSON.stringify(filterHelper.getFilterData(filterType)) !== JSON.stringify(data)) {
        resetListPositionOnNextPrint = true;
    }
    filterHelper.setFilterData(filterType, data);
}

/** @type {debounce_timeout} The debounce timeout used for printing. debounce_timeout.quick: 100 ms */
export const DEFAULT_PRINT_TIMEOUT = debounce_timeout.quick;

/**
 * Prints the character list in a debounced fashion without blocking, with a delay of 100 milliseconds.
 * Use this function instead of a direct `printCharacters()` whenever the reprinting of the character list is not the primary focus.
 *
 * The printing will also always reprint all filter options of the global list, to keep them up to date.
 */
export const printCharactersDebounced = debounce(() => { printCharacters(false); }, DEFAULT_PRINT_TIMEOUT);

/** Puts the current view's conditions and text into the search box; set by initCharacterSearch(). */
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

/**
 * @param {number} hidden Number of hidden characters
 * @param {boolean} [approx] Whether `hidden` is an estimate
 */
async function getHiddenBlock(hidden, approx = false) {
    const shown = `${approx ? '~' : ''}${hidden}`;
    const params = {
        text: (hidden > 1 ? t`${shown} characters hidden.` : t`${shown} character hidden.`),
    };
    const hiddenBlock = await renderTemplateAsync('hiddenBlock', params);
    return $(hiddenBlock);
}

// Order-independent equality (nullish treated as empty) - the server and the resident copy don't guarantee the
// same tag_ids insertion order, so a plain array compare would false-positive on every render.
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
    let this_avatar = default_avatar;
    if (item.avatar && item.avatar != 'none') {
        this_avatar = `/characters/${encodeURIComponent(item.avatar)}`;
    }
    template.attr({ 'data-avatar': item.avatar });
    // loading="lazy": avoids a request storm when a large library renders hundreds of cards at once.
    template.find('img').attr('src', this_avatar).attr('loading', 'lazy').attr('alt', item.name);
    template.find('.avatar').attr('title', `[Character] ${item.name}\nFile: ${item.avatar}`);
    template.find('.ch_name').text(item.name).attr('title', `[Character] ${item.name}`);
    template.find('.ch_avatar_url').text(power_user.show_card_avatar_urls ? item.avatar : '');
    template.find('.ch_fav_icon').css('display', 'none');
    const isFav = normalizeFav(item.fav);
    template.toggleClass('is_fav', isFav);
    template.find('.ch_fav').val(String(isFav));

    // .toggle() (not .remove()) so this stays correct when the row is reused in place, not freshly cloned.
    const isAssistant = item.avatar === getPermanentAssistantAvatar();
    template.find('.ch_assistant').toggle(isAssistant);

    // toggleClass, not .toggle(bool): jQuery's .toggle()/.show() write an inline display style that outranks
    // the grid-view CSS hide rule for these fields, and it sticks around across reused rows.
    const description = item.data?.creator_notes || '';
    template.find('.ch_description').text(description).toggleClass('displayNone', !description);

    const auxFieldName = power_user.aux_field || 'character_version';
    const auxFieldValue = (item.data && item.data[auxFieldName]) || '';
    template.find('.character_version').text(auxFieldValue).toggleClass('displayNone', !auxFieldValue);

    // Keep the resident charactersStore entry's tag_ids from drifting behind this row's fresher fetch - other
    // surfaces still read the resident copy directly. No-op when nothing was actually stale.
    const resident = charactersStore.get(id);
    const rowTagIdsCurrent = isFetchedTagIdsCurrent(id, item.tagFetchStamp);
    if (Array.isArray(item.tag_ids) && rowTagIdsCurrent) {
        if (resident && !arraysHaveSameMembers(resident.tag_ids, item.tag_ids)) {
            charactersStore.update(id, { tag_ids: item.tag_ids });
        }
    }

    // `tags` resolves pills from `item.tag_ids` directly rather than printTagList()'s default resident-store
    // lookup, since `item` here can be fresher than a not-yet-reconciled resident entry - unless a local tag
    // change makes the resident entry the fresher one.
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

// Updates one character's own row in place, if it's currently rendered, without requerying or reprinting the
// rest of the (possibly very large) list. Returns false if the row isn't on the current page/filter view - the
// caller then has nothing to refresh, since an off-screen row needs no DOM update and a filter/search
// membership change (this character starting/stopping matching) isn't handled by this path.
export function updateCharacterListRow(id) {
    const character = charactersStore.get(id);
    if (!character) return false;
    const row = document.querySelector(`#rm_print_characters_block [data-avatar="${CSS.escape(id)}"]`);
    if (!row) return false;
    updateCharacterBlock(row, character, id);
    replaceRenderedCharacterEntity(id, character);
    return true;
}

// Same as updateCharacterListRow(), but for an operation that changed the row's own key (a rename) - looks the
// row up by its previous avatar and re-renders it in place under the new one. Removal is always safe regardless
// of sort order (there's no "where does it go" question, unlike an insertion), so a straight DOM removal is
// exact here too - both skip the pagination widget's own tracked total/page-count, which is then off by one
// until the current page is next actually queried (a real page turn, or refreshCharacterListCurrentPage()).
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
 * The character rows on screen whose characters `charactersStore` doesn't hold, each with the tag ids it was drawn
 * with: those rows are the only place the page has them.
 * @returns {Map<string, string[]>} by avatar
 */
export function getUnheldRowTagIds() {
    /** @type {Map<string, string[]>} */
    const found = new Map();
    for (const entity of renderedPageEntities) {
        if (entity.type !== 'character' || charactersStore.has(entity.id)) continue;
        found.set(entity.id, Array.isArray(entity.item?.tag_ids) ? entity.item.tag_ids : []);
    }
    return found;
}

/**
 * Draws the row on screen of a character `charactersStore` doesn't hold again with `tagIds`.
 * @param {string} avatar
 * @param {string[]} tagIds
 * @param {number} fetchStamp - tagFetchStamp() taken before `tagIds` was read
 */
export function setUnheldRowTagIds(avatar, tagIds, fetchStamp) {
    let item = null;
    renderedPageEntities = renderedPageEntities.map((entity) => {
        if (entity.type !== 'character' || entity.id !== avatar) return entity;
        item = { ...entity.item, tag_ids: [...tagIds], tagFetchStamp: fetchStamp };
        return characterToEntity(item);
    });
    const row = document.querySelector(`#rm_print_characters_block [data-avatar="${CSS.escape(avatar)}"]`);
    if (item && row) updateCharacterBlock(row, item, avatar);
}

/** Draws the rows on screen of characters `charactersStore` doesn't hold again, as they are. */
export function redrawUnheldRows() {
    for (const entity of renderedPageEntities) {
        if (entity.type !== 'character' || charactersStore.has(entity.id)) continue;
        const row = document.querySelector(`#rm_print_characters_block [data-avatar="${CSS.escape(entity.id)}"]`);
        if (row) updateCharacterBlock(row, entity.item, entity.id);
    }
}

export function removeCharacterListRow(id) {
    const row = document.querySelector(`#rm_print_characters_block [data-avatar="${CSS.escape(id)}"]`);
    if (!row) return false;
    row.remove();
    renderedPageEntities = renderedPageEntities.filter(entity => !(entity.type === 'character' && entity.id === id));
    return true;
}

// For an operation that adds/removes a row or could move it to a different sort position (create/delete/
// duplicate) - unlike a same-row edit, correctly reflecting this generally needs to know the row's real sorted
// position and the corpus's real new count, neither of which is safe to guess client-side (sort can be by name,
// date, fav, a random seed, or search relevance). Re-fetches only the CURRENTLY VISIBLE PAGE - bounded by page
// size, not corpus size - through the pagination widget's own async path, rather than printCharacters()'s full
// reinit (which also repeats the folder-tile scan and the tag-filter reprint on every call). Returns false when
// the list hasn't been built yet - the caller then still needs a real printCharacters() call to reflect the change.
export function refreshCharacterListCurrentPage() {
    if (!serverPagedList) return false;
    const pager = document.getElementById('rm_print_characters_pagination');
    const pagination = pager ? $(pager).data('pagination') : undefined;
    if (!pagination?.initialized) return false;
    // pagination.js drops a refresh while its own fetch runs (disabled), so there is no render to keep the scroll for.
    keepScrollOnNextRender = !pagination.model?.disabled;
    $(pager).pagination('refresh');
    return true;
}

// Set by refreshCharacterListCurrentPage() for the re-render it starts: that render keeps the list's scroll
// distance as it is then, instead of printCharacters()'s afterRender restoring the one saved when it built the pager.
let keepScrollOnNextRender = false;

// Page fetches of the characters list still running: printCharacters()'s page-1 probe through to the pager it
// builds, and every pager ajaxFunction call. pagination.js drops a refresh while its own fetch runs, so a
// search-index-updated or the list being shown arriving meanwhile waits here for the last one to settle.
let pageFetchesInFlight = 0;
let searchIndexRefreshPending = false;
let shownRefreshPending = false;
// The list filter a page kept in browser storage was drawn for, when the server's fresher answer for it came while a
// page fetch was still running; the page is drawn again once they settle.
/** @type {object | null} */
let freshRefreshPendingFor = null;
// Whether printCharacters() has built the server-paged list.
let serverPagedList = false;

function pageFetchSettled() {
    pageFetchesInFlight--;
    if (pageFetchesInFlight !== 0) return;
    const freshFor = freshRefreshPendingFor;
    freshRefreshPendingFor = null;
    if (freshFor !== null && listPageContext.query?.filter === freshFor && !shownRefreshPending) {
        refreshCharacterListCurrentPage();
        return;
    }
    // The shown refresh re-queries the page whatever the search term, so it covers a pending search-index one.
    if (shownRefreshPending) {
        shownRefreshPending = false;
        searchIndexRefreshPending = false;
        onCharacterListShown();
    } else if (searchIndexRefreshPending) {
        searchIndexRefreshPending = false;
        onSearchIndexUpdated();
    }
}

// #right-nav-panel holds only the characters list. An open drawer that another panel covers is hidden by CSS
// (visibility), so openDrawer alone doesn't mean it is showing.
export function isCharacterListShowing() {
    const panel = document.getElementById('right-nav-panel');
    return Boolean(panel?.classList.contains('openDrawer')) && getComputedStyle(panel).visibility !== 'hidden';
}

// Same test as /query's hasSearch: only a non-blank term reaches the search index.
export function hasActiveCharacterSearch() {
    return String(entitiesFilter.getFilterData(FILTER_TYPES.SEARCH) ?? '').trim().length > 0;
}

// For /changes/stream's 'search-index-updated'. Without a search term the page doesn't come from the index, so
// there is nothing to re-query.
export function onSearchIndexUpdated() {
    if (!isCharacterListShowing()) return;
    if (!hasActiveCharacterSearch()) return;
    if (pageFetchesInFlight > 0) {
        searchIndexRefreshPending = true;
        return;
    }
    if (!serverPagedList) return;
    refreshCharacterListCurrentPage();
}

// For the list going from hidden to showing, when no change sync is pending: re-queries the visible page with its
// token, since anything that changed while it was hidden wasn't shown.
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
 * Prints the global character list, optionally doing a full refresh of the list
 * Use this function whenever the reprinting of the character list is the primary focus, otherwise using `printCharactersDebounced` is preferred for a cleaner, non-blocking experience.
 *
 * The printing will also always reprint all filter options of the global list, to keep them up to date.
 *
 * @param {boolean} fullRefresh - If true, the list is fully refreshed and the navigation is being reset
 */
// Must be a string, not a function: pagination.js only enters real per-page `isAsync` mode (calling
// `ajaxFunction` fresh on every page turn) for a string `dataSource`. The value itself is never fetched.
const SERVER_PAGINATED_DATA_SOURCE = '/api/characters/query';
/** @type {('rows'|'total'|'hidden')[]} */
const PAGE_WANT = ['rows', 'total', 'hidden'];

// The entities of the rows on screen. Always reassigned, never mutated: the page callback stores pagination.js's own
// page array here, which must not change under it.
/** @type {Entity[]} */
let renderedPageEntities = [];

/**
 * @typedef {object} CharacterListPageContext
 * @property {{ filter: object, sort: object|undefined } | null} query The `/query` filter and sort the drawn page came from.
 * @property {string} queryKey `query` as a string, to tell whether a later page came from the same list.
 * @property {number} pageOffset The position in the list of the drawn page's first row.
 * @property {number} total How many rows the list has.
 * @property {boolean} totalApprox Whether `total` is an estimate.
 */

/** @type {CharacterListPageContext} */
let listPageContext = { query: null, queryKey: '', pageOffset: 0, total: 0, totalApprox: false };

/**
 * Which list the drawn page belongs to and where in it, for the bulk selection. Each drawn character row carries its
 * position in the list as `data-list-position`.
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
        // A current-page refresh started before this would otherwise keep its scroll distance on this render.
        keepScrollOnNextRender = false;
        await delay(1);
    }

    // Before printing the personas, we check if we should enable/disable search sorting
    verifyCharactersSearchSortRule();

    // A filter set from code (upstream's FilterHelper, the tag bars) shows in the pills and the box.
    showViewInSearchBox();
    refreshSavedViewState();
    void refreshFolderSwitcher();

    // We are actually always reprinting filters, as it "doesn't hurt", and this way they are always up to date
    printTagFilters(tag_filter_type.character);
    printTagFilters(tag_filter_type.group_members_list);
    printTagFilters(tag_filter_type.group_candidates_list);

    // We are also always reprinting the lists on character/group edit window, as these ones doesn't get updated otherwise
    applyTagsOnCharacterSelect();
    applyTagsOnGroupSelect();

    const pageSize = Number(accountStorage.getItem(storageKey)) || per_page_default;
    const sizeChangerOptions = [10, 25, 50, 100, 250, 500, 1000];

    // getHidden gives the "N hidden" count, which comes with each page from the server.
    function makePageCallback(getHidden) {
        return async function (/** @type {Entity[]} */ data) {
            const list = $(listId).get(0);

            // Keyed diff: rows whose avatar is still on the new page are moved/updated in place rather than
            // rebuilt from the template. Groups and tags aren't keyed (far fewer per page) and rebuild every time.
            const existingCharacterRows = new Map();
            for (const child of list.children) {
                if (child instanceof HTMLElement && child.hasAttribute('data-avatar')) {
                    existingCharacterRows.set(child.getAttribute('data-avatar'), child);
                }
            }

            // Build into a detached fragment and append once - one reflow for the page instead of one per row.
            // Moving an attached node into the fragment detaches it from `list`, so replaceChildren() below is safe.
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

            const hidden = parseQueryTotal(getHidden());
            if (hidden.value > 0 && entitiesFilter.hasAnyFilter()) {
                const hiddenBlock = await getHiddenBlock(hidden.value, hidden.approx);
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

    favsToHotswap();
    updatePersonaConnectionsAvatarList();

    async function printServerPaginated() {
        const { filter, sort: wantedSort } = buildCharacterQueryFromCurrentFilterState({ includeGroups: true });

        // Page 1 is fetched before the plugin is built, so every later page uses the sort it settled on.
        // A page kept in browser storage from an earlier visit is drawn at once; if the server says it changed, the
        // page on screen is drawn again where it is.
        const onFresh = () => {
            // A fresh answer arriving while a page is still being fetched or drawn waits for it to settle.
            if (pageFetchesInFlight > 0 || listPageContext.query?.filter !== filter) {
                freshRefreshPendingFor = filter;
                return;
            }
            refreshCharacterListCurrentPage();
        };
        const { sort, result: firstPage } = await queryWithSortFallback(filter, wantedSort,
            trySort => characterRepository.query(filter, trySort, 1, pageSize, PAGE_WANT, { onFresh }));

        // The page response's `hidden`: every entity less the rows on that page, `~`-prefixed when approximate.
        /** @type {number|string} */
        let pageHidden = 0;
        // Serves the already-fetched probe to ajaxFunction's first call instead of re-fetching.
        let pendingFirstPage = firstPage;
        // Whether the latest page response's `total` was `~`-prefixed (approximate).
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
            // Keeps a re-render on saveCharactersPage instead of pagination.js bouncing it to page 1 while the ajax
            // response is in flight.
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
                const resultPromise = (page === 1 && requestedPageSize === pageSize && pendingFirstPage)
                    ? Promise.resolve(pendingFirstPage)
                    : characterRepository.query(filter, sort, page, requestedPageSize, PAGE_WANT, { onFresh });
                pendingFirstPage = undefined;
                resultPromise
                    .then(async result => {
                        const rows = Array.isArray(result.rows) ? result.rows : [];
                        const pageEntities = rows.map(row => queryRowToEntity(row));
                        const parsedTotal = Number(String(result.total ?? 0).replace(/^~/, ''));
                        saveCharactersTotal = Number.isFinite(parsedTotal) ? parsedTotal : 0;
                        pageTotalApprox = isApproxTotal(result.total);
                        pageHidden = result.hidden ?? 0;
                        listPageContext = {
                            query: { filter, sort },
                            queryKey: JSON.stringify({ filter, sort }),
                            pageOffset: (page - 1) * requestedPageSize,
                            total: saveCharactersTotal,
                            totalApprox: pageTotalApprox,
                        };
                        if (result.searchBackend !== undefined) showSearchBackend(result.searchBackend);
                        ajaxParams.success({ rows: pageEntities, total: result.total });
                    })
                    .catch(error => {
                        console.error('[printCharacters] server-paginated /query failed:', error);
                        // No render follows, so a refresh's keep-scroll must not carry over to a later page turn.
                        keepScrollOnNextRender = false;
                        ajaxParams.error(error);
                    })
                    .finally(pageFetchSettled);
            },
            callback: makePageCallback(() => pageHidden),
        });
    }
}

// Auto-selects the "Search" sort option only when the search term first becomes active, preserving a manual switch away from it.
function verifyCharactersSearchSortRule() {
    const searchTerm = entitiesFilter.getFilterData(FILTER_TYPES.SEARCH);
    const searchOption = $('#character_sort_order option[data-field="search"]');
    const isHidden = searchOption.attr('hidden') !== undefined;

    if (searchTerm && isHidden) {
        searchOption.removeAttr('hidden');
        searchOption.prop('selected', true);
    }
    // No longer a valid sort with nothing to rank by - fall back to the last real sort.
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
 * @property {number|string?} [hidden=null] - An optional number representing how many hidden entities this entity contains. A
 *   folder tile's is `~`-prefixed when approximate.
 * @property {number|string?} [total=null] - A folder tile's sub-list size when `entities` holds only its first rows,
 *   `~`-prefixed when approximate
 * @property {boolean?} [isUseless=null] - Specifies if the entity is useless (not relevant, but should still be displayed for consistency) and should be displayed greyed out
 */

/**
 * Converts the given character to its entity representation
 *
 * @param {Character} character - The character
 * @param {string|number} [id] - The entity id. Upstream callers pass the character's index; defaults to its avatar.
 * @returns {Entity} The entity for this character
 */
export function characterToEntity(character, id) {
    return { item: character, id: id === undefined ? character?.avatar : id, type: 'character' };
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

// The one sort state power_user.sort_field/sort_order alone can't express, since selecting this option
// overrides both (mirrors sortEntitiesList()'s own isSearch check).
function isSearchSortSelected() {
    return $('#character_sort_order option[data-field="search"]').is(':selected');
}

/** Sort fields already warned about by warnUnsupportedSort(), so each is named once per page load. */
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
 * The sort a list uses when the server doesn't know the one asked for: relevance with a search term, else name.
 * @param {import('./character-repository.js').CharacterQueryFilter} filter
 * @returns {import('./character-repository.js').CharacterQuerySort}
 */
function fallbackSort(filter) {
    return filter.search ? { field: 'search', order: 'asc' } : { field: 'name', order: 'asc' };
}

/**
 * Runs a `/query` request with `sort`. When the sort is unknown to the server (old saved settings or an extension),
 * or is relevance with no search term, it warns once naming the sort and runs the request with fallbackSort().
 * @template T
 * @param {import('./character-repository.js').CharacterQueryFilter} filter The request's filter.
 * @param {import('./character-repository.js').CharacterQuerySort|undefined} sort
 * @param {(sort: import('./character-repository.js').CharacterQuerySort|undefined) => Promise<T>} request
 * @returns {Promise<{ sort: import('./character-repository.js').CharacterQuerySort|undefined, result: T }>} The
 *   sort that answered, and its result.
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
 * How the list's included tags combine: 'or' shows rows carrying any one of them. Upstream's tag filter has no such
 * setting, so it is kept beside `entitiesFilter`, per browser.
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
 * The list's range bounds. Upstream's filter helper has no ranges, so they are kept beside it, per browser.
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
 * The closed-folder case the list shows, while "Tags as Folders" is on: 'none' (no closed folder) unless one was
 * picked. Upstream's filter helper has no folder case, so it is kept beside it, per browser.
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
 * What the character list shows. It is read from `entitiesFilter` and the sort settings, which stay the store, so an
 * extension setting a filter through upstream's FilterHelper or `power_user.sort_*` changes the view, and a view set
 * here is what they read back.
 * @returns {import('./character-view.js').CharacterView}
 */
export function getCharacterView() {
    const tagFilterData = entitiesFilter.getFilterData(FILTER_TYPES.TAG) ?? { selected: [], excluded: [] };
    const { text, conditions } = parseSearchText(entitiesFilter.getFilterData(FILTER_TYPES.SEARCH) ?? '');
    // With no term the option is about to be deselected (verifyCharactersSearchSortRule()), so the saved sort applies.
    const isSearchSort = hasActiveCharacterSearch() && isSearchSortSelected();
    const isRandom = !isSearchSort && power_user.sort_order === 'random';
    /** @type {import('./character-view.js').CharacterViewSort} */
    const sort = isSearchSort
        ? { field: 'search', order: 'asc' }
        : isRandom
            ? { field: 'random', order: 'asc', seed: getRandomSortSeed(accountStorage) }
            : { field: power_user.sort_field, order: power_user.sort_order === 'desc' ? 'desc' : 'asc' };
    return {
        text,
        conditions,
        // tagFilterData.selected doubles as "which bogus folder is open", so an open folder is a tag condition.
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
 * Shows `view` in the character list, as a change the user made: one reprint, back to page 1 at the top.
 * Fields left out keep their current value.
 * @param {Partial<import('./character-view.js').CharacterView>} view
 * @param {object} [options]
 * @param {boolean} [options.fromSearchBox] The search box already shows it, so it isn't redrawn.
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
    // At once, not on the print: a reload right after a change must still find it as a draft.
    refreshSavedViewState();
    printCharactersDebounced();
}


function buildCharacterQueryFromCurrentFilterState({ includeGroups = false } = {}) {
    return buildCharacterQuery(viewToQueryState(getCharacterView(), { includeGroups }));
}

// Maps one normalized `/query` row to its `Entity` form.
function queryRowToEntity(row) {
    const { type, item } = normalizeQueryRow(row);
    return type === 'group' ? groupToEntity(item) : characterToEntity(item);
}

function applyFinalFilterRun(entities) {
    const beforeFinalEntities = filterByTagState(entities, { globalDisplayFilters: true });
    let filtered = entitiesFilter.applyFilters(beforeFinalEntities, { clearFuzzySearchCaches: false });

    // Magic for folder filter. If that one is enabled, and no folders are display anymore, we remove that filter to actually show the characters.
    if (isFilterState(entitiesFilter.getFilterData(FILTER_TYPES.FOLDER), FILTER_STATES.SELECTED) && filtered.filter(x => x.type == 'tag').length == 0) {
        filtered = entitiesFilter.applyFilters(beforeFinalEntities, { tempOverrides: { [FILTER_TYPES.FOLDER]: FILTER_STATES.UNDEFINED }, clearFuzzySearchCaches: false });
    }
    return filtered;
}

// Rows per /query request in findCharacterListPage(), within the server's page cap (MAX_QUERY_PAGE_SIZE).
const FIND_PAGE_CHUNK_SIZE = 1000;

/**
 * The page of the character list an entity is on, with the list's filters and sort (and its fallback), for a list of
 * `pageSize` rows a page. The list's `/query` rows are read in order, one chunk at a time, until it turns up.
 * @param {(entity: Entity) => boolean} isEntity
 * @param {number} pageSize
 * @returns {Promise<number>} The 1-based page, or -1 when the list doesn't hold it.
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
 * The entities of the character list page on screen, `[]` before the list first renders.
 *
 * This keeps the browser's own filter (`doFilter`) and sort (`doSort`) over the page: upstream callers expect it to
 * answer synchronously. It is the one place the browser still filters and ranks the list.
 *
 * @param {object} param0 - Optional parameters
 * @param {boolean} [param0.doFilter] - Whether this entity list should already be filtered based on the global filters
 * @param {boolean} [param0.doSort] - Whether the entity list should be sorted when returned
 * @returns {Entity[]} All entities
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
 * A page of folders of one type whose names hold `term`, in the tag sort order.
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
 * A folder of one type by id: null when no such folder exists, undefined when the read failed.
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
 * Re-reads one character from the server and updates it in the store.
 * @param {string} avatarUrl The character's avatar key.
 * @returns {Promise<boolean>} True when the store was updated; false on a non-ok response, or when the page doesn't
 *   hold the character (there is nothing in memory to refresh). A failed request (network error) still throws.
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
        // See selectCharacterByAvatar()'s identical fix: `chat` can legitimately be unset/null now
        // (Workstream 6), and `String(undefined)` would corrupt it into the literal "undefined".
        getData.chat = getData.chat ? String(getData.chat) : '';
        // This response is always full data; reset shallow explicitly or a once-shallow entity stays shallow forever.
        getData.shallow = false;
        if (!isFetchedTagIdsCurrent(avatarUrl, fetchStamp)) {
            delete getData.tag_ids;
        }

        // The page may have let go of it while the request was out.
        if (charactersStore.has(avatarUrl)) {
            charactersStore.update(avatarUrl, getData);
            return true;
        }
    }
    return false;
}

/**
 * @param {string|number|Character} [chId] An index into `getContext().characters`, an avatar key, or a character
 *   object
 * @returns {string}
 */
export function getCharacterSource(chId = getCurrentCharacter()) {
    const character = resolveCharacterRef(chId);
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

// getCharacters() also refetches the full group list as a side effect; several group-mutation call sites piggyback on this.
/**
 * @param {object} [options]
 * @param {boolean} [options.silent=false]
 * @param {boolean} [options.silentGroups=false]
 */
// Bounds a single /api/characters/batch request so a large-library boot doesn't become one giant response.
const CHARACTER_BATCH_CHUNK_SIZE = 500;

// Only meant for freshly-fetched data; a cache hit already has this applied.
function finalizeFetchedCharacter(character) {
    // Leave it unset for a character with no chat yet - inventing a name here guarantees a
    // 404 the first time this character is opened, against a file that was never written.
    character.chat = character.chat ? String(character.chat) : '';
}

/**
 * What one sync learned, kept across retries: a failed attempt has already moved the cursor past the pages it
 * applied, so their updates are only ever seen once.
 * @typedef {object} DeltaProgress
 * @property {Map<string, object|null>} updates Each character the sync touched, as the cache now holds it; `null`
 *   when the cache has no record of it (deleted, or its fetch or write failed).
 * @property {boolean} changed Whether the sync saw any change at all.
 * @property {boolean} full Whether the cache was wiped and rebuilt, so a character absent from `updates` is gone.
 */

/**
 * The change-feed position this tab's `characters` is current through. The cache and its cursor are shared by
 * every tab of this user, so another tab can move the cursor past changes this tab has not taken in yet.
 */
let memorySeq = 0;

/**
 * @param {number} sinceSeq
 * @returns {Promise<{seq: number, changes: {id: string, op: 'upsert'|'delete', fields?: string[]|null}[], truncated: boolean, hasMore: boolean}>}
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
 * Takes in what another tab already wrote to the cache between this tab's `memorySeq` and the shared cursor:
 * the ids come from the change feed, the records from the cache.
 * @param {DeltaProgress} progress
 * @param {number} cursor The shared cursor.
 */
async function catchUpFromCache(progress, cursor) {
    let sinceSeq = memorySeq;
    while (sinceSeq < cursor) {
        const { seq, changes, truncated, hasMore } = await fetchChangesPage(sinceSeq);
        if (truncated) {
            // The feed no longer reaches back to this tab's position. The tab that moved the cursor has the cache
            // current through it, so the characters this page holds are read from the cache as it is now.
            await readHeldFromCache(progress);
            progress.changed = true;
            memorySeq = cursor;
            return;
        }
        // Only the characters this page holds have anything in memory to update.
        const ids = [...new Set(changes.map(change => change.id))].filter(id => charactersStore.has(id));
        if (changes.length > 0) {
            progress.changed = true;
        }
        const stored = await readCachedCharactersByIds(ids);
        for (const id of ids) {
            progress.updates.set(id, stored.get(id) ?? null);
        }
        memorySeq = seq;
        if (!hasMore) {
            break;
        }
        sinceSeq = seq;
    }
}

// Syncs via the change-feed against the local cache instead of a full-library dump; no full-fetch fallback on failure since that dump can be multi-hundred-MB.
// The server pages /changes; each page is applied and saved, then its cursor persisted, so an interrupted sync resumes at the last fully applied page.
/** @param {DeltaProgress} progress Filled in as each page is applied. */
async function fetchCharactersDelta(progress) {
    // Advanced in memory, not re-read per page: setCachedCursor() swallows write errors, and re-reading a
    // cursor that failed to persist would refetch the same page forever.
    let sinceSeq = await getCachedCursor();
    if (memorySeq < sinceSeq) {
        await catchUpFromCache(progress, sinceSeq);
    }
    for (;;) {
        const { seq, changes, truncated, hasMore } = await fetchChangesPage(sinceSeq);

        if (truncated) {
            // sinceSeq predates the server's change log; wipe the cache and retry as a fresh full sync.
            await clearCharacterCache();
            progress.updates.clear();
            progress.full = true;
            memorySeq = 0;
            return fetchCharactersDelta(progress);
        }

        const deleteIds = [];
        const wholeRecordIds = [];
        // Group field-level changes by their field set so each set becomes one batched /batch call.
        /** @type {Map<string, { fields: string[], ids: string[] }>} */
        const fieldGroupMap = new Map();

        for (const { id, op, fields } of changes) {
            if (op === 'delete') {
                deleteIds.push(id);
            } else if (!fields) {
                wholeRecordIds.push(id);
            } else {
                const key = JSON.stringify([...fields].sort());
                if (!fieldGroupMap.has(key)) {
                    fieldGroupMap.set(key, { fields, ids: [] });
                }
                fieldGroupMap.get(key).ids.push(id);
            }
        }

        // Re-fetch records that failed to write on a previous sync, triggered by the failure itself.
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

        if (deleteIds.length > 0) {
            await removeCachedCharacters(deleteIds);
        }

        /** @type {Map<string, object>} fresh/updated records to save back to the cache */
        const fresh = new Map();
        // From each /batch response; the saves below hash these records the way the server hashes shallow_json.
        let includeCreatorNotes = false;

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
            includeCreatorNotes = batchResponse.headers.get(SHALLOW_CREATOR_NOTES_HEADER) === 'true';

            const batchData = await batchResponse.json();
            for (const character of batchData) {
                finalizeFetchedCharacter(character);
                fresh.set(character.avatar, character);
            }
        }

        // Field-level fetches request only the changed fields, e.g. skipping the PNG read server-side.
        if (fieldGroupMap.size > 0) {
            // Reads only this page's field-changed ids, so the read is bounded by the page size.
            const cachedBefore = await readCachedCharactersByIds([...fieldGroupMap.values()].flatMap(group => group.ids));

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
                    includeCreatorNotes = batchResponse.headers.get(SHALLOW_CREATOR_NOTES_HEADER) === 'true';

                    const batchData = await batchResponse.json();
                    const batchMerged = [];
                    for (const partial of batchData) {
                        const avatar = partial.avatar;
                        // Check `fresh` first - a whole-record fetch in this same sync supersedes the pre-sync cache.
                        const existing = fresh.get(avatar) || cachedBefore.get(avatar);
                        if (existing) {
                            for (const field of fields) {
                                if (field in partial) {
                                    existing[field] = partial[field];
                                }
                            }
                            // A 'fav' change also sets shallow_json's data.extensions.fav, but /batch only returns the top-level
                            // field; without the mirror this record's fav hash would differ from the server's.
                            if (fields.includes('fav') && 'fav' in partial) {
                                existing.data = existing.data ?? {};
                                existing.data.extensions = existing.data.extensions ?? {};
                                existing.data.extensions.fav = partial.fav;
                            }
                            fresh.set(avatar, existing);
                            batchMerged.push({ avatar, character: existing });
                        }
                    }
                    // Saved incrementally per batch to avoid one huge IndexedDB write at the end.
                    if (batchMerged.length > 0) {
                        await saveCachedCharacters(batchMerged, { includeCreatorNotes });
                    }
                }
            }
        }

        let writeFailures = [];
        if (fresh.size > 0) {
            writeFailures = await saveCachedCharacters(Array.from(fresh, ([avatar, character]) => ({ avatar, character })), { includeCreatorNotes });
        }
        // Failures before the cursor: if interrupted between the two writes, the page replays and refetches them,
        // instead of the cursor moving past ids whose write failed.
        await setWriteFailures(writeFailures);
        await setCachedCursor(seq);

        // Read back from the cache rather than taken from `fresh`, so a character whose fetch or write failed is
        // absent here exactly as it is on disk. Only the characters this page holds have anything in memory to update.
        const touched = [...new Set([...deleteIds, ...wholeRecordIds, ...[...fieldGroupMap.values()].flatMap(group => group.ids)])]
            .filter(id => charactersStore.has(id));
        const stored = await readCachedCharactersByIds(touched);
        for (const id of touched) {
            progress.updates.set(id, stored.get(id) ?? null);
        }
        memorySeq = Math.max(memorySeq, seq);

        if (changes.length > 0 || previousFailures.length > 0) {
            progress.changed = true;
        }
        if (!hasMore) {
            break;
        }
        sinceSeq = seq;
    }
}

// lodash merge() would merge arrays index-by-index; returning arrays as-is makes them replace wholesale instead.
function mergeShallowCharacterCustomizer(_objValue, srcValue) {
    if (Array.isArray(srcValue)) {
        return srcValue;
    }
    return undefined;
}

/**
 * Takes the cache's feed position at boot, before the first sync. The cache may hold the whole library, and none of
 * it is read into memory: the page holds only the characters on screen, each read when something needs it, and every
 * one of them is fresher than this position.
 */
export async function seedCharactersFromCache() {
    memorySeq = await getCachedCursor();
}

/**
 * Reads the characters this page holds from the cache as it is now. One the cache lacks is gone only if the server
 * says so: a cache another tab is still rebuilding lacks characters that exist.
 * @param {DeltaProgress} progress
 */
async function readHeldFromCache(progress) {
    const held = charactersStore.getAll().map(character => character.avatar);
    const stored = await readCachedCharactersByIds(held);
    for (const [avatar, character] of stored) {
        progress.updates.set(avatar, character);
    }
    await markHeldGoneIfDeleted(progress, held.filter(avatar => !stored.has(avatar)));
}

/**
 * Records as gone each of these held characters that the server says doesn't exist. One it can't answer for is
 * left as it is.
 * @param {DeltaProgress} progress
 * @param {string[]} avatars
 */
async function markHeldGoneIfDeleted(progress, avatars) {
    if (avatars.length === 0) return;
    const exists = await checkCharactersExistOrNull(avatars);
    if (!exists) return;
    for (const avatar of avatars) {
        if (exists[avatar] === false) progress.updates.set(avatar, null);
    }
}

const DELTA_FETCH_MAX_RETRIES = 3;
const DELTA_FETCH_RETRY_DELAYS_MS = [1000, 3000, 8000];

// A sync request (one /changes page, or /api/groups/all) taking this long is broken rather than slow.
export const SYNC_REQUEST_TIMEOUT_MS = 60000;

export function showCharacterSyncFailedToast() {
    toastr.error(
        t`Could not sync the character list. Check your connection and refresh the page to retry.`,
        t`Character sync failed`,
        { timeOut: 0, extendedTimeOut: 0, preventDuplicates: true },
    );
}

// Never falls back to an unconditional full-library fetch on exhausted retries; reports the failure and leaves `characters` stale but uncorrupted.
/**
 * @param {object} [options]
 * @param {boolean} [options.silent=false]
 * @param {boolean} [options.silentGroups=false]
 * @param {boolean} [options.skipPrint=false] Skip the trailing printCharacters()/search-refetch - for a
 * caller that's about to do its own smaller, targeted DOM update (or its own real requery, like
 * select_rm_info()'s flash-to-new-character navigation) instead.
 * @param {boolean} [options.keepListPosition=false] Reprint the list on the page and scroll distance it is at,
 * instead of going back to page 1 at the top - for a refresh the user didn't ask for.
 */
export async function getCharacters(options = {}) {
    try {
        return await syncCharacters(options);
    } catch (error) {
        console.error('Character sync failed:', error);
        showCharacterSyncFailedToast();
    }
}

/**
 * Applies a sync's updates to the characters the page holds, in place. A character it doesn't hold is not taken in:
 * what the page holds is decided by what is on screen, never by a sync. Callers re-index the store afterwards.
 * @param {DeltaProgress} progress
 * @param {number} fetchStamp From tagFetchStamp() before the sync, so tag ids a newer write superseded are dropped.
 * @returns {string[]} Held characters an update reached only as a shallow row: their heavy fields may have changed
 *   too, so they are to be read again in full.
 */
function applyCharacterUpdates({ updates }, fetchStamp) {
    const removed = new Set();
    /** @type {string[]} */
    const readAgain = [];
    for (const [avatar, incoming] of updates) {
        const existing = charactersStore.get(avatar);
        if (!existing) {
            continue;
        }
        if (!incoming) {
            removed.add(existing);
            continue;
        }
        if (!isFetchedTagIdsCurrent(avatar, fetchStamp)) {
            delete incoming.tag_ids;
        }
        // Merged field by field: a shallow row lacks the heavy fields, which the held card keeps until it is read again.
        lodash.mergeWith(existing, incoming, mergeShallowCharacterCustomizer);
        if (incoming.shallow === true) {
            existing.shallow = false;
            readAgain.push(avatar);
        }
    }
    if (removed.size > 0) {
        let kept = 0;
        for (const character of characters) {
            if (!removed.has(character)) characters[kept++] = character;
        }
        characters.length = kept;
    }
    return readAgain;
}

/**
 * Reads these held characters again in full and updates them in place. One the page let go of meanwhile stays out.
 * @param {string[]} avatars
 */
async function readHeldAgainInFull(avatars) {
    if (avatars.length === 0) return;
    const full = await characterRepository.readFull(avatars);
    for (const [avatar, character] of full) {
        if (charactersStore.has(avatar)) charactersStore.update(avatar, character);
    }
}

async function syncCharacters({ silent = false, silentGroups = false, skipPrint = false, keepListPosition = false } = {}) {
    let lastError;
    const fetchStamp = tagFetchStamp();
    /** @type {DeltaProgress} */
    const progress = { updates: new Map(), changed: false, full: false };
    for (let attempt = 0; attempt <= DELTA_FETCH_MAX_RETRIES; attempt++) {
        try {
            await fetchCharactersDelta(progress);
            lastError = undefined;
            break;
        } catch (error) {
            lastError = error;
            if (attempt < DELTA_FETCH_MAX_RETRIES) {
                const retryDelay = DELTA_FETCH_RETRY_DELAYS_MS[attempt];
                console.warn(`Character delta fetch failed (attempt ${attempt + 1}/${DELTA_FETCH_MAX_RETRIES + 1}), retrying in ${retryDelay}ms:`, error);
                await delay(retryDelay);
            }
        }
    }

    // A rebuilt cache names every character that exists; a held one it didn't name is checked with the server.
    if (progress.full) {
        try {
            await markHeldGoneIfDeleted(progress, charactersStore.getAll().map(character => character.avatar).filter(avatar => !progress.updates.has(avatar)));
        } catch (error) {
            console.error('Could not check the held characters a rebuilt cache did not name:', error);
        }
    }

    // Pages a failed sync did apply moved the cursor past them, so they are applied here even on failure.
    if (progress.changed) {
        const readAgain = applyCharacterUpdates(progress, fetchStamp);
        try {
            await readHeldAgainInFull(readAgain);
        } catch (error) {
            console.error('Could not read changed characters again in full:', error);
        }
        if (silent) {
            charactersStore.reindex();
        } else {
            charactersStore.reset();
        }
    }

    if (lastError) {
        console.error(`Character delta fetch failed after ${DELTA_FETCH_MAX_RETRIES + 1} attempts, giving up (no full-library fallback - see getCharacters()' doc comment):`, lastError);
        showCharacterSyncFailedToast();
        return;
    }

    if (progress.changed) {
        if (this_avatar) {
            if (charactersStore.get(this_avatar)) {
                await selectCharacterByAvatar(this_avatar, { switchMenu: false });
            } else {
                await Popup.show.text(t`ERROR: The active character is no longer available.`, t`The page will be refreshed to prevent data loss. Press "OK" to continue.`);
                return location.reload();
            }
        }
    }

    await getGroups({ silent: silentGroups });
    if (skipPrint) return;
    await printCharacters(!keepListPosition);
}

// Per-backend UI info for the persistent search-backend indicator icon; null means "hide it, this backend is fully healthy".
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
 * @param {number|string|undefined} total A `/query` response's `total`.
 * @returns {boolean} Whether it is a `~`-prefixed approximate count.
 */
function isApproxTotal(total) {
    return typeof total === 'string' && total.startsWith('~');
}

/** @type {string | null} */
let lastKnownSearchBackend = null;

/**
 * Shows the search-backend indicator for a list page's `searchBackend`, with a toast when it differs from the last one.
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
    // Typing in the box waits for a pause; a change made any other way goes out at once and drops a pending one, which
    // would carry what the pills were before it.
    /** @type {Partial<import('./character-view.js').CharacterView> | null} */
    let pendingTypedView = null;
    const debouncedCharacterSearch = debounce(() => {
        const view = pendingTypedView;
        pendingTypedView = null;
        if (view) setCharacterView(view, { fromSearchBox: true });
    });
    // What was typed and not yet sent still becomes the view (and so a draft) if the page goes before the pause.
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
            return { names: new Map([...answer.tags].map(([id, tag]) => [id, String(tag.name)])), gone: answer.gone };
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

    eventSource.on(event_types.APP_READY, () => {
        void restoreCurrentView();
        const isVisible = accountStorage.getItem(storageKey) === 'true';
        searchForm.toggle(isVisible);
        searchButton.toggleClass('active', isVisible);
    });
}
