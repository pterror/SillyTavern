/**
 * Client data model for character residency (design doc: docs/design/character-data-residency-redesign.md, §6,
 * phase 5). `CharacterRepository` is the one seam internal code is meant to go through instead of touching
 * `charactersStore/characters` directly for anything beyond "read a row I already know is on screen" - it owns
 * the resident/non-resident distinction §6 calls out as the whole point of this class:
 *
 * > The bright line: `peek()` returning `undefined` must never be interpreted as "does not exist".
 *
 * `peek()` is the only sync member, and it is a pure `charactersStore` read - it never fetches and never lies
 * about that. Everything that might need to leave the resident set to answer (`get`, `getMany`, `full`, `query`,
 * `exists`) is async, even though today - full shallow residency, per phase 5's staging note in §9 - most of
 * them resolve synchronously in practice from an already-resident row. The async shape is not a nod to a
 * hypothetical: phase 6 (§7, IDB cache) swaps what backs a residency miss without any caller here changing, and
 * that swap is only possible because nothing upstream of this file assumed sync.
 *
 * Explicitly out of scope for this pass (phase 6, not phase 5): an IndexedDB tier in front of the server fetch.
 * `get()`/`getMany()`'s server fallback path also does *not* write fetched rows back into `charactersStore` -
 * see `get()`'s doc comment for why that's a deliberate correctness call, not an oversight.
 *
 * `query()`/`queryAll()` also carry `filter.includeGroups` (design doc §5/§6 close of the "getEntitiesList can't
 * answer a mixed character+group+folder ordering" gap): set it to merge groups into the same server-sorted,
 * server-paginated result instead of building the group portion from the fully-resident `groups` array. Use
 * `normalizeQueryRow()` to read the result regardless of which shape it came back as - script.js's
 * `getEntitiesList()`/`printCharacters()` are the reference callers.
 */

import { charactersStore, getRequestHeaders, unshallowCharacter } from '../script.js';

/**
 * @typedef {import('../script.js').Character} Character
 */

/**
 * @typedef {object} CharacterQueryFilter - mirrors the server's `POST /api/characters/query` filter shape
 * (design doc §5; src/endpoints/characters.js `router.post('/query'`).
 * @property {string} [search] - routed to the FTS/tantivy index, joined back to SQLite by id.
 * @property {{include: string[], exclude: string[], mode: 'and'|'or'}} [tags]
 * @property {boolean} [fav]
 * @property {string} [world]
 * @property {string[]} [excludeIds] - group member exclusion.
 * @property {string[]} [ids] - resolve-by-id batch; intersects with `search` when both are present.
 * @property {boolean} [includeGroups] - omitted/false: `rows` stays the pre-existing bare `Character[]` shape,
 * every caller that doesn't pass this keeps working unmodified. `true`: the server merges the user's groups into
 * the same sorted/paginated result, and `rows` becomes `Array<{type: 'character', item: Character} | {type:
 * 'group', item: Group}>` instead - see `normalizeQueryRow()` below for the one place callers should go to tell
 * the two apart, rather than re-deriving the discriminator ad hoc. Composes with `filter.tags` (a folder is just
 * a tag - `tags.include=[folderId]`, and a folder can contain groups too, via `group_tags`) AND with
 * `filter.search`: a non-empty `search` DOES include groups in the merged result when this flag is set - groups
 * have their own full-text index (server's groups-search-index.js, mirroring the character one) and the server
 * merges both indexes' relevance-ordered matches before answering (src/endpoints/characters.js, the `/query`
 * route's `hasSearch && includeGroups` branch). An earlier version of this doc claimed the opposite ("no group
 * full-text index exists") and attributed that exclusion to an owner decision the owner never actually made -
 * see that route's own doc comment for the git-history trace.
 */

/**
 * @typedef {object} CharacterQuerySort
 * @property {'name'|'date_added'|'date_last_chat'|'chat_size'|'fav'|'random'|'search'} field
 * @property {'asc'|'desc'} [order]
 * @property {number} [seed] - required (finite) when `field` is `'random'` - design doc §5.3 decisions 8/10/13;
 * mint/persist one with `getRandomSortSeed()` (random-sort.js), never invent one here.
 */

/**
 * @typedef {object} CharacterQueryResult
 * @property {Character[]|Array<{type: 'character', item: Character}|{type: 'group', item: object}>} [rows] -
 * present iff `want` included `'rows'` (default: yes). Bare `Character[]` unless the request set
 * `filter.includeGroups: true`, in which case it's the tagged-row shape - see `CharacterQueryFilter.includeGroups`
 * and `normalizeQueryRow()`.
 * @property {number|string} [total] - present iff `want` included `'total'` (default: yes). A plain number is
 * exact; a `~`-prefixed string (e.g. `"~12345"`) is an approximate count that must still be treated as the real
 * scope of the result set, never as a truncated/capped one - design doc §5 decision 6. Callers that need a
 * number for arithmetic must strip the `~` themselves; this repository does not silently coerce it, since doing
 * so would throw away the "this is approximate" signal the `~` exists to carry.
 * @property {number} rev - the metadata store's current change revision at query time (§5.2); lets a caller
 * detect that what it just rendered may already be stale relative to `/api/characters/changes`.
 * @property {string} [searchBackend] - which search engine answered `filter.search` ('tantivy'),
 * present only when `filter.search` was non-empty.
 */

const DEFAULT_QUERY_WANT = /** @type {const} */ (['rows', 'total']);

/**
 * The server's own page cap (`MAX_QUERY_PAGE_SIZE`, src/endpoints/characters.js) - `queryAll()` below chunks its
 * internal loop at this size. Duplicated here rather than fetched from the server because it's a wire-contract
 * constant, not runtime state.
 */
const QUERY_ALL_PAGE_SIZE = 2000;

/**
 * @typedef {object} CharacterQueryStateInput
 * @property {string} [searchTerm] - current search box value; non-empty disqualifies the server-query fast path
 * (see `isServerQueryEligible()`'s doc comment for why, not just this typedef).
 * @property {string[]} [tagsInclude] - selected tag ids (`FILTER_TYPES.TAG` filter data's `selected`) - doubles
 * as "which bogus folder is currently open", same as the pre-existing local `filterByTagState()`/`tagFilter()`.
 * @property {string[]} [tagsExclude] - excluded tag ids (`FILTER_TYPES.TAG` filter data's `excluded`).
 * @property {boolean} [fav] - `true`/`false` to restrict to favorited/non-favorited, `undefined` for no fav
 * filter - already-normalized from `FILTER_TYPES.FAV`'s tri-state via `isFilterState()`; this module takes no
 * dependency on filters.js, so callers normalize before calling.
 * @property {string} [sortField] - `power_user.sort_field`, or `'random'`/`'search'` for those two special
 * cases (matching the `#character_sort_order` dropdown's overloaded use of `data-order="random"` and the
 * separate "Search" option).
 * @property {'asc'|'desc'} [sortOrder] - `power_user.sort_order` (`'random'` itself is carried via `sortField`,
 * not this - see above).
 * @property {number} [randomSeed] - required (finite) when `sortField === 'random'`.
 * @property {boolean} [includeGroups] - see `CharacterQueryFilter.includeGroups`.
 */

/**
 * Pure mapping from the client's current filter/sort UI state to the server `/query` wire shape (design doc §5).
 * No DOM/module dependency beyond its own typedefs, so it's unit-testable without mocking script.js - see
 * tests/character-repository.test.js. Every caller (getEntitiesList(), favsToHotswap()) is expected to have
 * already decided (via `isServerQueryEligible()`) whether the server-query path applies at all; this function
 * just shapes whatever state it's given, it does not gate eligibility itself.
 * @param {CharacterQueryStateInput} [state]
 * @returns {{filter: CharacterQueryFilter, sort: CharacterQuerySort|undefined}}
 */
export function buildCharacterQuery({
    searchTerm = '',
    tagsInclude = [],
    tagsExclude = [],
    fav = undefined,
    sortField = undefined,
    sortOrder = 'asc',
    randomSeed = undefined,
    includeGroups = false,
} = {}) {
    /** @type {CharacterQueryFilter} */
    const filter = {};
    // Trimmed, because the route trims before deciding whether a search is present. Comparing raw
    // truthiness here instead means a box holding one space reads as a search on this side and as no
    // search on that one, and 'search' sort is rejected outright for having nothing to rank by.
    const search = String(searchTerm ?? '').trim();
    if (search) filter.search = search;
    if (tagsInclude.length > 0 || tagsExclude.length > 0) {
        filter.tags = { include: tagsInclude, exclude: tagsExclude, mode: 'and' };
    }
    if (typeof fav === 'boolean') filter.fav = fav;
    if (includeGroups) filter.includeGroups = true;

    /** @type {CharacterQuerySort|undefined} */
    let sort;
    if (sortField === 'random') {
        sort = { field: 'random', order: sortOrder === 'desc' ? 'desc' : 'asc', seed: randomSeed };
    } else if (sortField) {
        sort = { field: /** @type {CharacterQuerySort['field']} */ (sortField), order: sortOrder === 'desc' ? 'desc' : 'asc' };
    }

    return { filter, sort };
}

/**
 * Whether `sortField` is even a candidate for the server `/query` path at all. This deliberately does NOT try to
 * know in advance whether the server actually has a matching column for `sortField` - that used to be
 * `QUERYABLE_CLIENT_SORT_FIELDS`, a hand-maintained mirror of the server's own `QUERYABLE_SORT_COLUMNS`
 * (src/character-metadata-db.js) that twice drifted out of sync with it in practice (`create_date`/`data_size`
 * both went live server-side without this mirror being updated, so every view using either sort silently kept
 * paying for the fully-local fallback for no reason). The client has no business maintaining a second copy of
 * "which columns the server supports" at all - the server's own `400 { reason: 'invalid-sort-field' }` response
 * (see `CharacterQueryError`/`isInvalidSortFieldError()` below) is now the sole source of truth for that
 * question. Callers attempt the server query unconditionally and treat that specific rejection as the trigger
 * for the pre-existing local-sort fallback - see `canUseServerQueryForEntitiesList()`/`getEntitiesList()`
 * (script.js), `canUseServerQueryForGroupCandidates()`/`getGroupCharacters()` (group-chats.js), and
 * `favsToHotswap()` (RossAscends-mods.js) for that try/catch.
 *
 * What's left here is narrower, and neither case is about column support:
 * - `'search'` isn't a plain-column sort at all - relevance order is answered by the search index directly, a
 *   different code path than a `sort.field` column (`fetchServerCharacterSearchResults()`/`serverSearchResults`,
 *   script.js) - excluded here so callers that ask "should I even try `/query` for this sort field" get `false`
 *   for it rather than sending a request that was never going to be the right mechanism.
 * - everything else, including `'random'` (which always needs a finite `sort.seed`, minted by the caller via
 *   `getRandomSortSeed()` before the request goes out - a request-shape concern, not a column-support one, and
 *   unrelated to this function) and every real or made-up column name: `true` - the caller finds out whether the
 *   server actually supports it from the response, not from asking here.
 * @param {string|undefined} sortField
 * @returns {boolean}
 */
export function isServerQueryableSort(sortField) {
    return sortField !== 'search';
}

/**
 * Normalizes one `/query` response row to a `{type, item}` shape regardless of whether the request that
 * produced it set `filter.includeGroups` - the one place a caller should go to tell a character row from a
 * group row, instead of re-deriving the discriminator ad hoc at every call site (a bare row has no `type` field
 * at all; `filter.includeGroups: true` rows already carry one straight from the server). A bare row is always a
 * character - `filter.includeGroups: false`/omitted never returns a group.
 * @param {Character|{type: 'character'|'group', item: Character|object}} row
 * @returns {{type: 'character'|'group', item: Character|object}}
 */
export function normalizeQueryRow(row) {
    if (row && typeof row === 'object' && (row.type === 'character' || row.type === 'group') && 'item' in row) {
        return row;
    }
    return { type: 'character', item: row };
}

/**
 * Thrown by `postJson()` for a non-ok response. Carries the parsed JSON body (when the response had one) so
 * callers can distinguish a specific server-declared rejection - most importantly `reason: 'invalid-sort-field'`,
 * the trigger for the local-sort fallback (see `isServerQueryableSort()`'s doc comment) - from a generic failure
 * (network error, a 500, a malformed/empty body) that must NOT be treated the same way. Prefer
 * `isInvalidSortFieldError()` over checking `.reason` directly at call sites.
 */
export class CharacterQueryError extends Error {
    /**
     * @param {string} message
     * @param {object} param1
     * @param {number} param1.status - HTTP status code.
     * @param {string} [param1.reason] - the server's `reason` field, when the body was JSON and had one.
     * @param {any} [param1.body] - the full parsed JSON body, when the response had one; `undefined` if the body
     * wasn't JSON (or was empty).
     */
    constructor(message, { status, reason, body }) {
        super(message);
        this.name = 'CharacterQueryError';
        this.status = status;
        this.reason = reason;
        this.body = body;
    }
}

/**
 * Whether `error` is `postJson()` rejecting a `/query` request specifically because `sort.field` isn't one the
 * server can answer (`400 { reason: 'invalid-sort-field' }`) - the one failure mode call sites should catch and
 * respond to by falling back to the pre-existing local sort, per `isServerQueryableSort()`'s doc comment. Every
 * other failure (network error, a 500, a malformed body, a different 400 reason like
 * `'search-sort-requires-search'`) must propagate normally, not be silently swallowed into the same fallback.
 * @param {unknown} error
 * @returns {boolean}
 */
export function isInvalidSortFieldError(error) {
    return error instanceof CharacterQueryError && error.reason === 'invalid-sort-field';
}

/**
 * @param {string} url
 * @param {object} body
 * @returns {Promise<any>}
 */
async function postJson(url, body) {
    const response = await fetch(url, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(body),
    });
    if (!response.ok) {
        /** @type {any} */
        let errorBody;
        try {
            errorBody = await response.json();
        } catch {
            // Response body wasn't JSON (or was empty) - fall through with just the status.
        }
        const reason = errorBody?.reason;
        const detail = errorBody?.message ?? reason ?? '';
        throw new CharacterQueryError(`${url} failed with ${response.status}${detail ? `: ${detail}` : ''}`, { status: response.status, reason, body: errorBody });
    }
    return response.json();
}

/**
 * Owns character residency for internal (non-extension) client code. See the module doc comment above for the
 * resident/non-resident contract this exists to make explicit.
 */
export class CharacterRepository {
    /** @type {import('./entity-store.js').EntityStore<Character>|undefined} explicit store passed to the constructor, if any */
    #explicitStore;

    /** @type {import('./entity-store.js').EntityStore<Character>|null} resolved lazily - see `get store()` */
    #resolvedStore = null;

    /**
     * @param {import('./entity-store.js').EntityStore<Character>} [store] - defaults to the app's real
     * `charactersStore` singleton; overridable for tests, and this is what phase 6 swaps to change what backs a
     * residency miss.
     */
    constructor(store) {
        this.#explicitStore = store;
    }

    /**
     * Resolves lazily on first access rather than defaulting eagerly in the constructor: script.js imports this
     * module (for `characterRepository`/`buildCharacterQuery`/etc) above its own `charactersStore` declaration,
     * and this module's `export const characterRepository = new CharacterRepository()` runs at module-eval time -
     * so a `store = charactersStore` constructor default would read `charactersStore` while script.js is still
     * mid import-resolution, before its `export const charactersStore` has initialized (TDZ crash: "can't access
     * lexical declaration 'charactersStore' before initialization"). Same class of bug as FILTER_TYPES in
     * tags.js (commit f30735376) and getStringHash in utils.js (commit 85017bb94); same fix shape - defer the
     * reference until first real use, by which point script.js has finished evaluating.
     * @returns {import('./entity-store.js').EntityStore<Character>}
     */
    get store() {
        if (this.#resolvedStore === null) {
            this.#resolvedStore = this.#explicitStore ?? charactersStore;
        }
        return this.#resolvedStore;
    }

    /**
     * Sync resident read. Never fetches. `undefined` means "not currently resident", which is NOT the same
     * claim as "does not exist" - see the module doc comment. Internal code that needs an authoritative
     * existence answer must use `exists()`, never treat a `peek()` miss as one (design doc §4.2/§6).
     * @param {string} id
     * @returns {Character|undefined}
     */
    peek(id) {
        return this.store.get(id);
    }

    /**
     * Resolves one character: resident row if present, otherwise a server round-trip. Callers that already
     * know they only need the sync/resident answer should call `peek()` directly rather than awaiting this for
     * no reason.
     *
     * Deliberately does NOT write a server-fallback result back into `charactersStore` (unlike `full()`'s
     * resident-hydration path, which mutates in place via `unshallowCharacter`). `charactersStore` backs
     * `characters`, the array several call sites still read the length/contents of directly to mean "the
     * boot-loaded library" (e.g. the "N hidden" badge's `characters.length + groups.length`, §4.1). Silently
     * growing that array as a side effect of a read would make those counts lie. Until phase 6 gives this
     * repository its own cache tier to write into instead, a server-fallback fetch is deliberately
     * non-caching: correct and slightly wasteful beats fast and silently wrong.
     * @param {string} id
     * @returns {Promise<Character|undefined>} `undefined` if the id genuinely does not resolve - a true miss,
     * not merely "not resident" (equivalent to `exists()` saying `false` for it).
     */
    async get(id) {
        const resident = this.peek(id);
        if (resident) return resident;

        const result = await this.query({ ids: [id] }, undefined, 1, 1, ['rows']);
        return result.rows?.[0];
    }

    /**
     * Batched form of `get()`: resident ids resolve from `charactersStore`, the rest in a single `/query` call.
     * @param {string[]} ids
     * @returns {Promise<Map<string, Character>>} keyed by id; ids that don't resolve are simply absent, not
     * `undefined`-valued - so `.has(id)` is the miss check, matching `exists()`'s semantics rather than
     * `peek()`'s.
     */
    async getMany(ids) {
        /** @type {Map<string, Character>} */
        const result = new Map();
        /** @type {string[]} */
        const missing = [];
        for (const id of ids) {
            const resident = this.peek(id);
            if (resident) result.set(id, resident);
            else missing.push(id);
        }
        if (missing.length === 0) return result;

        const fetched = await this.query({ ids: missing }, undefined, 1, missing.length, ['rows']);
        for (const row of fetched.rows ?? []) {
            result.set(row.avatar, row);
        }
        return result;
    }

    /**
     * Hydrates the full card (today's `unshallowCharacter()`/`getOneCharacter()` machinery in script.js) for an
     * already-resident character, and returns the (in-place-updated) resident entity.
     *
     * For a genuinely non-resident id, this is the "entry-level fault-in" design doc §6 flags as not existing
     * anywhere yet: `unshallowCharacter()` requires the row to already be in `charactersStore` (it hydrates
     * *fields*, it does not create the entry), and `getOneCharacter()` inherits that requirement
     * (`charactersStore.has(avatarUrl)` gate in script.js). Making that case work means deciding whether a
     * fetched full card joins `charactersStore` (and therefore the "boot-loaded library" counts `get()`'s doc
     * comment above describes) - a residency-model decision that belongs with phase 6's cache tier, not this
     * pass. Left as a documented gap rather than papered over: this throws instead of silently returning
     * `undefined` (which would be indistinguishable from "fetched successfully, card is empty").
     * @param {string} id
     * @returns {Promise<Character>}
     * @throws {Error} if `id` is not currently resident (see above).
     */
    async full(id) {
        if (!this.store.has(id)) {
            throw new Error(
                `CharacterRepository.full(${JSON.stringify(id)}): entry-level fault-in for a non-resident id ` +
                'is not implemented (design doc §6, phase 5 documented gap) - it requires a phase-6 residency ' +
                'decision, not just a fetch. Use exists() first if the caller only needs to know whether the ' +
                'id is valid.',
            );
        }
        await unshallowCharacter(id);
        return this.store.get(id);
    }

    /**
     * The workhorse: one page of query results, straight from `POST /api/characters/query` (design doc §5).
     * `getEntitiesList()`/`printCharacters()` are built directly on top of this - see character-repository.js's
     * module doc comment and script.js.
     * @param {CharacterQueryFilter} [filter]
     * @param {CharacterQuerySort} [sort]
     * @param {number} [page] - 1-based, matching the server's convention.
     * @param {number} [pageSize]
     * @param {('rows'|'total'|'facets'|'rank')[]} [want] - defaults to `['rows', 'total']`; pass a narrower set
     * (e.g. `['rows']`) to skip paying for a count the caller doesn't need.
     * @returns {Promise<CharacterQueryResult>}
     */
    async query(filter = {}, sort = undefined, page = 1, pageSize = 100, want = DEFAULT_QUERY_WANT) {
        // Mirrors the route's own rule rather than trusting each caller to have applied it: relevance
        // order requires something to rank by, so a blank or whitespace-only term cannot ask for it.
        // Callers that build their filter by hand (rather than via buildCharacterQuery()) reach the
        // request through here too, so this is the one place that can guarantee the two agree.
        const search = typeof filter.search === 'string' ? filter.search.trim() : '';
        const normalizedFilter = search ? { ...filter, search } : (() => {
            const rest = { ...filter };
            delete rest.search;
            return rest;
        })();
        const normalizedSort = sort?.field === 'search' && !search ? undefined : sort;
        return postJson('/api/characters/query', { filter: normalizedFilter, sort: normalizedSort, page, pageSize, want });
    }

    /**
     * Fetches *every* row matching a filter+sort by looping `query()` pages internally (each request capped at
     * `QUERY_ALL_PAGE_SIZE`, the server's own `MAX_QUERY_PAGE_SIZE`). This is deliberately NOT the endpoint's
     * intended access pattern at scale - it fully materializes the matched set client-side, so it does not carry
     * forward to the 10M-row target `/query`'s paging contract is sized for (design doc §5, §6). It exists as the
     * documented, non-regressing fallback (design doc phase 5 entry) for callers that still need one fully
     * resident, fully sorted array to hand to something else that isn't itself server-paginated yet -
     * `getEntitiesList()`'s character candidate set (has to merge with the small, always-resident group/folder
     * entity set - see script.js) and `favsToHotswap()`'s favorite-character list (has to merge with favorited
     * groups the same way). A literal per-page server-driven pagination *controller* is blocked on that same
     * group/folder interleave problem, which `/query`'s contract does not answer (no rank/cursor primitive) -
     * that gap is intentionally left open, not papered over here.
     *
     * Never trusts `total` as a loop-termination bound by itself: design doc §5 decision 6 allows `total` to be
     * an approximate (`~`-prefixed) estimate for expensive-to-count filters, and an approximate count must never
     * be read as an exact stopping point. The authoritative stop condition is a short page (fewer rows returned
     * than requested), which is true regardless of whether `total` was exact or approximate.
     * @param {CharacterQueryFilter} [filter] - pass `includeGroups: true` to merge groups into the loop too; the
     * returned array is then the tagged `{type, item}` row shape (`normalizeQueryRow()`) rather than bare
     * `Character[]` - this method doesn't reshape rows, it only loops pages, so the shape is whatever `filter`
     * asked the server for.
     * @param {CharacterQuerySort} [sort]
     * @returns {Promise<Array<Character|{type: 'character'|'group', item: Character|object}>>} every matching
     * row, in server sort order.
     */
    async queryAll(filter = {}, sort = undefined) {
        /** @type {Array<Character|{type: 'character'|'group', item: Character|object}>} */
        const rows = [];
        let page = 1;
        // `sort.field: 'random'` is deliberately dropped for the actual per-page fetch here (falls through to
        // the server's default order - the always-present `id ASC` tie-break in queryCharacters()'s ORDER BY,
        // an indexed primary-key sort real OFFSET pagination can walk cheaply) rather than passed straight
        // through. Requesting `RANDHASH(id, seed)` order per page is both pointless and, at real library scale,
        // dangerously expensive here specifically: RANDHASH is a SQL function, not an indexed column, so SQLite
        // can't use an index to satisfy OFFSET - every single page has to re-evaluate + fully re-sort the ENTIRE
        // filtered table before it can even apply this page's slice. For a queryAll() loop that's O(pages) full
        // -table sorts, i.e. quadratic in library size - confirmed (2026-08 getStringHash freeze investigation)
        // as a multi-minute stall on a ~326k-character install, sampled paused inside getStringHash itself
        // (hash-utils.js), which RANDHASH is built on (character-metadata-db.js).
        // It's also provably wasted work: queryAll()'s only two callers that ever pass `sort.field: 'random'`
        // (script.js's getEntitiesList(), group-chats.js's getGroupCharacters()) both unconditionally re-sort
        // their result afterward via power-user.js's sortEntitiesList(), which reapplies this exact seeded order
        // client-side (compareByRandomSeed(), random-sort.js) whenever `power_user.sort_order === 'random'` -
        // so whatever order the server returned these rows in was always going to be discarded and redone. Any
        // *future* caller that materializes a queryAll() random-sort result without re-sorting it the same way
        // would see server-side row order, not seeded-random order - not a behavior change for either of
        // today's callers, but worth knowing if a new one shows up.
        const pageSort = sort?.field === 'random' ? undefined : sort;
        for (;;) {
            const result = await this.query(filter, pageSort, page, QUERY_ALL_PAGE_SIZE, ['rows']);
            const pageRows = result.rows ?? [];
            rows.push(...pageRows);
            if (pageRows.length < QUERY_ALL_PAGE_SIZE) break;
            page++;
        }
        return rows;
    }

    /**
     * Authoritative existence check (design doc §4.2) - the primitive every destructive-existence site
     * (group member pruning, world-info character-filter cleanup, tag-backup restore, ...) must go through
     * instead of treating a resident-array miss as "deleted". A failed/partial check must abort whatever
     * mutation it was gating, never fall through to "treat it as gone" - that rule lives with each call site,
     * not here, since only the call site knows what the destructive action is.
     *
     * No client-side chunking: verified against `checkCharactersExist()` (src/character-metadata-db.js) that
     * the server already chunks internally at 500 ids per SQL query (`BATCH_FLUSH_SIZE`, to stay clear of
     * SQLite's bound-parameter ceiling) and returns every requested id in one response regardless of how many
     * chunks that took server-side. Every §4.2 call site's `ids` is bounded by its own input (group member
     * count, a tag-restore file's id list, ...), not by library size, so there's no case here that needs the
     * request itself split up client-side too.
     * @param {string[]} ids
     * @returns {Promise<Record<string, boolean>>} every requested id is present as a key.
     */
    async exists(ids) {
        return postJson('/api/characters/exists', { ids });
    }

    /**
     * Subscribes to residency changes (create/update/remove/rename/reset) on the backing store. Thin
     * passthrough today; kept as its own method (rather than callers reaching into `charactersStore` directly)
     * so phase 6 can widen this to also cover its own cache tier's admit/evict events without every caller
     * needing to know that happened.
     * @param {(change: import('./entity-store.js').EntityChange<Character>) => void} fn
     * @returns {() => void} unsubscribe function
     */
    onChange(fn) {
        return this.store.onChange(fn);
    }
}

/** The app-wide repository instance, backed by the real `charactersStore`. */
export const characterRepository = new CharacterRepository();
