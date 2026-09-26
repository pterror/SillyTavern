import { lodash } from '../lib.js';
import { favsToHotswap } from './RossAscends-mods.js';
import { characters, charactersStore, this_avatar } from './character-store.js';
import { groups, getGroups, getGroupBlock } from './group-chats.js';
import { power_user, sortEntitiesList } from './power-user.js';
import { normalizeFav } from './hash-utils.js';
import { debounce, delay, PAGINATION_TEMPLATE, localizePagination, renderPaginationDropdown, paginationDropdownChangeHandler } from './utils.js';
import { debounce_timeout } from './constants.js';
import { tags, filterByTagState, isBogusFolder, isBogusFolderOpen, getTagBlock, printTagFilters, printTagList, tag_filter_type, compareTagsForSort, applyTagsOnCharacterSelect, applyTagsOnGroupSelect, tagsStore } from './tags.js';
import { tagFetchStamp, isFetchedTagIdsCurrent } from './tag-fetch-stamps.js';
import { FILTER_STATES, FILTER_TYPES, FilterHelper, isFilterState } from './filters.js';
import { characterRepository, buildCharacterQuery, isServerQueryableSort, isInvalidSortFieldError, normalizeQueryRow } from './character-repository.js';
import { getRandomSortSeed } from './random-sort.js';
import { t } from './i18n.js';
import { updatePersonaConnectionsAvatarList } from './personas.js';
import { getCachedCursor, setCachedCursor, getAllCachedCharacters, readCachedCharactersByIds, saveCachedCharacters, removeCachedCharacters, clearCharacterCache, getWriteFailures, setWriteFailures } from './character-cache.js';
import { Popup } from './popup.js';
import { renderTemplateAsync } from './templates.js';
import { accountStorage } from './util/AccountStorage.js';
import { getPermanentAssistantAvatar } from './welcome-screen.js';
import { event_types, eventSource } from './events.js';
import { getRequestHeaders } from './request-headers.js';
import { default_avatar, getCurrentCharacter, per_page_default, selectCharacterByAvatar } from '../script.js';

let saveCharactersPage = 0;

// Seeds pagination.js's totalNumber on reconstruction, or it reads 0 until the first ajax response and clamps
// the page back to 1 (see the resetPageNumberOnInit: false pairing below).
let saveCharactersTotal = 0;

/** @type {debounce_timeout} The debounce timeout used for printing. debounce_timeout.quick: 100 ms */
export const DEFAULT_PRINT_TIMEOUT = debounce_timeout.quick;

/**
 * Prints the character list in a debounced fashion without blocking, with a delay of 100 milliseconds.
 * Use this function instead of a direct `printCharacters()` whenever the reprinting of the character list is not the primary focus.
 *
 * The printing will also always reprint all filter options of the global list, to keep them up to date.
 */
export const printCharactersDebounced = debounce(() => { printCharacters(false); }, DEFAULT_PRINT_TIMEOUT);

export const entitiesFilter = new FilterHelper(printCharactersDebounced);

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
        ? rowTagIds.map(tagId => tagsStore.get(tagId)).filter(Boolean).sort(compareTagsForSort)
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
    return true;
}

export function removeCharacterListRow(id) {
    const row = document.querySelector(`#rm_print_characters_block [data-avatar="${CSS.escape(id)}"]`);
    if (!row) return false;
    row.remove();
    return true;
}

// For an operation that adds/removes a row or could move it to a different sort position (create/delete/
// duplicate) - unlike a same-row edit, correctly reflecting this generally needs to know the row's real sorted
// position and the corpus's real new count, neither of which is safe to guess client-side (sort can be by name,
// date, fav, a random seed, or search relevance). Re-fetches only the CURRENTLY VISIBLE PAGE - bounded by page
// size, not corpus size - through the pagination widget's own async path, rather than printCharacters()'s full
// reinit (which also repeats the folder-tile scan and the tag-filter reprint on every call). Returns false when
// the widget isn't already in that async/server-query mode (e.g. the active sort isn't server-queryable) - the
// caller then still needs a real printCharacters() call to reflect the change.
export function refreshCharacterListCurrentPage() {
    if (!canUseServerQueryForEntitiesList()) return false;
    const pager = document.getElementById('rm_print_characters_pagination');
    if (!pager || !$(pager).data('pagination')?.initialized) return false;
    $(pager).pagination('refresh');
    return true;
}

// Page fetches of the characters list still running: printCharacters()'s page-1 probe through to the pager it
// builds, and every pager ajaxFunction call. pagination.js drops a refresh while its own fetch runs, so a
// search-index-updated arriving meanwhile waits here for the last one to settle.
let pageFetchesInFlight = 0;
let searchIndexRefreshPending = false;
// Whether the pager was last built in server-query mode (renderLocalPaginated() has no server page).
let serverPagedList = false;

function pageFetchSettled() {
    pageFetchesInFlight--;
    if (pageFetchesInFlight === 0 && searchIndexRefreshPending) {
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

    // getMatchTotal parameterizes the "N hidden" count, since the two printCharacters() paths below know the
    // match total differently (one holds the whole filtered array, the other only one page).
    function makePageCallback(getMatchTotal) {
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

            list.replaceChildren();
            if (power_user.bogus_folders && isBogusFolderOpen()) {
                $(list).append(getBackBlock());
            }
            if (!data.length) {
                const emptyBlock = await getEmptyBlock();
                $(list).append(emptyBlock);
            }
            list.appendChild(fragment);

            // getMatchTotal() is the match count for the active filter, independent of the current page - using
            // page-local displayCount here would conflate "filtered out" with "not on this page".
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

    // Fallback when canUseServerQueryForEntitiesList() declines: the whole filtered/sorted set is materialized
    // client-side and the plugin slices it in memory on page turn.
    async function renderLocalPaginated() {
        serverPagedList = false;
        const entities = await getEntitiesList({ doFilter: true });

        // entities.length is capped by the page-fetch limit during search; use serverSearchResults.total for the displayed total instead.
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
        pageFetchesInFlight++;
        try {
            await printServerPaginated();
        } finally {
            pageFetchSettled();
        }
    } else {
        await renderLocalPaginated();
    }

    favsToHotswap();
    updatePersonaConnectionsAvatarList();

    async function printServerPaginated() {
        // Bogus-folder tag tiles are computed locally and prepended to page 1 only (never paginated), so page 1 can exceed pageSize.
        const { filter, sort } = buildCharacterQueryFromCurrentFilterState({ includeGroups: true });

        // Probe with the page-1 request up front so an unsupported sort field falls back to renderLocalPaginated() before the plugin is built.
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
            // May be an approximate `~`-prefixed count; fine for the "N hidden" badge and page-count math.
            let matchTotal = 0;
            // Serves the already-fetched probe to ajaxFunction's first call instead of re-fetching.
            let pendingFirstPage = firstPage;

            const searchTerm = entitiesFilter.getFilterData(FILTER_TYPES.SEARCH);
            serverPagedList = true;
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
                // Lets a re-render restore the page the user was on instead of bouncing to page 1 while the ajax response is in flight.
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
                        })
                        .finally(pageFetchSettled);
                },
                callback: makePageCallback(() => matchTotal),
            });
        }
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

// The one sort state power_user.sort_field/sort_order alone can't express, since selecting this option
// overrides both (mirrors sortEntitiesList()'s own isSearch check).
function isSearchSortSelected() {
    return $('#character_sort_order option[data-field="search"]').is(':selected');
}

// This is "should try", not a guaranteed-safe precheck: whether the server actually supports the current sort
// field comes back as a real rejection, and every caller catches isInvalidSortFieldError() to fall back locally.
function canUseServerQueryForEntitiesList() {
    if (isSearchSortSelected()) return String(entitiesFilter.getFilterData(FILTER_TYPES.SEARCH) ?? '').trim().length > 0;
    const sortField = power_user.sort_order === 'random' ? 'random' : power_user.sort_field;
    return isServerQueryableSort(sortField);
}

// tagFilterData.selected doubles as "which bogus folder is open", so passing it through as filter.tags.include
// makes an open folder a real paginated filter with no separate wiring needed.
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

// Maps one normalized `/query` row to its `Entity` form.
function queryRowToEntity(row) {
    const { type, item } = normalizeQueryRow(row);
    return type === 'group' ? groupToEntity(item) : characterToEntity(item);
}

// Filter runs must stay in this order: an initial pass, per-folder sub-lists, then the final pass with search filters last.
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

// When eligible, fetches characters+groups already merged/sorted/filtered from the server; the local filter pipeline still runs over the result.
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

// Folder tiles are never part of a server-paginated page, so this filters the local arrays directly.
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

        if (charactersStore.has(avatarUrl)) {
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

// Syncs via the change-feed against the local cache instead of a full-library dump; no full-fetch fallback on failure since that dump can be multi-hundred-MB.
// The server pages /changes; each page is applied and saved, then its cursor persisted, so an interrupted sync resumes at the last fully applied page.
async function fetchCharactersDelta() {
    let changed = false;
    // Advanced in memory, not re-read per page: setCachedCursor() swallows write errors, and re-reading a
    // cursor that failed to persist would refetch the same page forever.
    let sinceSeq = await getCachedCursor();
    for (;;) {
        const changesResponse = await fetch('/api/characters/changes', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ sinceSeq }),
        });

        if (!changesResponse.ok) {
            throw new Error(`Failed to fetch character changes: ${changesResponse.statusText}`);
        }

        /** @type {{seq: number, changes: {id: string, op: 'upsert'|'delete', fields?: string[]|null}[], truncated: boolean, hasMore: boolean}} */
        const { seq, changes, truncated, hasMore } = await changesResponse.json();

        if (truncated) {
            // sinceSeq predates the server's change log; wipe the cache and retry as a fresh full sync.
            await clearCharacterCache();
            return fetchCharactersDelta();
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
                            fresh.set(avatar, existing);
                            batchMerged.push({ avatar, character: existing });
                        }
                    }
                    // Saved incrementally per batch to avoid one huge IndexedDB write at the end.
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
        // Failures before the cursor: if interrupted between the two writes, the page replays and refetches them,
        // instead of the cursor moving past ids whose write failed.
        await setWriteFailures(writeFailures);
        await setCachedCursor(seq);

        if (changes.length > 0 || previousFailures.length > 0) {
            changed = true;
        }
        if (!hasMore) {
            break;
        }
        sinceSeq = seq;
    }

    // Re-read rather than reconstruct in place, so a server-side failed character correctly stays absent.
    const allCached = await getAllCachedCharacters();

    return { list: Array.from(allCached.values()), changed };
}

// lodash merge() would merge arrays index-by-index; returning arrays as-is makes them replace wholesale instead.
function mergeShallowCharacterCustomizer(_objValue, srcValue) {
    if (Array.isArray(srcValue)) {
        return srcValue;
    }
    return undefined;
}

// Seeds `characters` from the persisted cache before getCharacters()'s network call. Only grows from empty, so it can't clobber fresher state.
export async function seedCharactersFromCache() {
    if (characters.length > 0) {
        return;
    }
    const cached = await getAllCachedCharacters();
    if (cached.size === 0) {
        return;
    }
    for (const character of cached.values()) {
        characters.push(character);
    }
    charactersStore.reset();
}

const DELTA_FETCH_MAX_RETRIES = 3;
const DELTA_FETCH_RETRY_DELAYS_MS = [1000, 3000, 8000];

// Never falls back to an unconditional full-library fetch on exhausted retries; reports the failure and leaves `characters` stale but uncorrupted.
/**
 * @param {object} [options]
 * @param {boolean} [options.silent=false]
 * @param {boolean} [options.silentGroups=false]
 * @param {boolean} [options.skipPrint=false] Skip the trailing printCharacters(true)/search-refetch - for a
 * caller that's about to do its own smaller, targeted DOM update (or its own real requery, like
 * select_rm_info()'s flash-to-new-character navigation) instead.
 */
export async function getCharacters({ silent = false, silentGroups = false, skipPrint = false } = {}) {
    let newCharacters;
    let charactersChanged = true;
    let lastError;
    const fetchStamp = tagFetchStamp();
    for (let attempt = 0; attempt <= DELTA_FETCH_MAX_RETRIES; attempt++) {
        try {
            const delta = await fetchCharactersDelta();
            newCharacters = delta.list;
            charactersChanged = delta.changed;
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

    if (lastError) {
        console.error(`Character delta fetch failed after ${DELTA_FETCH_MAX_RETRIES + 1} attempts, giving up (no full-library fallback - see this function's own doc comment):`, lastError);
        toastr.error(
            t`Could not sync the character list. Check your connection and refresh the page to retry.`,
            t`Character sync failed`,
            { timeOut: 0, extendedTimeOut: 0, preventDuplicates: true },
        );
        return;
    }

    if (newCharacters === undefined) {
        return;
    }

    if (charactersChanged) {
        // Merge field-by-field rather than a wholesale replace, since newCharacters can be a shallow projection missing heavy fields.
        const newByAvatar = new Map(newCharacters.map(c => [c.avatar, c]));
        for (const existing of characters) {
            const incoming = newByAvatar.get(existing.avatar);
            if (!incoming) continue;
            if (!isFetchedTagIdsCurrent(existing.avatar, fetchStamp)) {
                delete incoming.tag_ids;
            }
            // Don't let an incoming shallow projection downgrade an already-unshallowed entity back to shallow.
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

        if (silent) {
            charactersStore.reindex();
        } else {
            charactersStore.reset();
        }

        if (this_avatar) {
            if (charactersStore.get(this_avatar)) {
                await selectCharacterByAvatar(this_avatar, { switchMenu: false });
            } else {
                await Popup.show.text(t`ERROR: The active character is no longer available.`, t`The page will be refreshed to prevent data loss. Press "OK" to continue.`);
                return location.reload();
            }
        }
    } // end if (charactersChanged)

    await getGroups({ silent: silentGroups });
    if (skipPrint) return;
    await printCharacters(true);

    // Server search results were fetched against whatever search index state existed at the time; a change
    // that landed since then (e.g. an import, or the background rebuild it triggered) can make them stale.
    const activeSearchTerm = entitiesFilter.getFilterData(FILTER_TYPES.SEARCH);
    if (activeSearchTerm) {
        await fetchServerCharacterSearchResults(activeSearchTerm).then(() => printCharactersDebounced());
    }
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

// Lets fetchServerCharacterSearchResults() pop a transition toast only when the backend actually changes.
/** @type {string | null} */
let lastKnownSearchBackend = null;

// Results come back best-first; each match gets a synthetic ascending-is-better score from its position, since the endpoint exposes no raw relevance score.
// The fav filter is mirrored into the request rather than applied client-side, since a favorited character ranking below the server's top-pageSize cutoff would never reach the client.
/**
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
        // This is a UI-chrome/local-fallback data source, not the main list's own render, so it only ever needs a bounded top page.
        const result = await characterRepository.query(
            { search: searchQuery, includeGroups: true, ...(favOnly ? { fav: true } : {}) },
            { field: 'search' },
            1, 500, ['rows', 'total'],
        );

        const rows = Array.isArray(result.rows) ? result.rows : [];
        // `total` may be `~`-prefixed (an approximate count under a capped search set) - stripped to a plain number.
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

// Mirrors the label sets the server's FIELD_LABELS actually accept, so a token only becomes a pill when the server will really treat it as a filter.
/** @type {Set<string>} */
const SEARCH_PILL_LABELS = new Set([
    'name', 'tag', 'tags', 'desc', 'description', 'example', 'scenario', 'personality',
    'greeting', 'notes', 'creator', 'from', 'by', 'author', 'alt', 'alternate', 'member', 'members', 'id',
]);

// Alternate spellings that resolve to the same server-side field but should display/store as one canonical label once promoted to a pill.
/** @type {Record<string, string>} */
const SEARCH_PILL_LABEL_ALIASES = {
    from: 'creator',
    by: 'creator',
    author: 'creator',
};

export function initCharacterSearch() {
    // Purely a display/editing convenience - pills are reassembled back into `label:value` text before being sent anywhere.
    /** @type {{ label: string, value: string }[]} */
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
        // A trailing space "completes" the token right before it - if recognized, promote it to a pill.
        if (raw.endsWith(' ')) {
            const trimmed = raw.slice(0, -1);
            const pillMatch = trimmed.match(/(?:^|\s)([A-Za-z][A-Za-z0-9_]*):("[^"]*"|\S+)$/);
            if (pillMatch && SEARCH_PILL_LABELS.has(pillMatch[1].toLowerCase())) {
                const rawLabel = pillMatch[1].toLowerCase();
                const label = SEARCH_PILL_LABEL_ALIASES[rawLabel] ?? rawLabel;
                searchPills.push({ label, value: pillMatch[2] });
                renderPills();
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
