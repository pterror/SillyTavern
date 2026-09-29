/**
 * The seam for character data access: `peek()` is a sync, non-fetching resident read - a miss means "not
 * currently resident", never "does not exist" (use `exists()` for that). Everything else (`get`, `getMany`,
 * `full`, `query`, `exists`) is async since it may need a server round-trip to answer.
 *
 * `query()`/`queryAll()` accept `filter.includeGroups` to merge groups into the same server-sorted/paginated
 * result instead of building that portion from the fully-resident `groups` array; use `normalizeQueryRow()` to
 * read a row regardless of which shape it came back as.
 */

import { unshallowCharacter } from '../script.js';
import { getRequestHeaders } from './request-headers.js';
import { charactersStore } from './character-store.js';
import { tagFetchStamp } from './tag-fetch-stamps.js';
import { getCachedEntriesByIds, saveCachedCharacters, getCachedGroupEntriesByIds, saveCachedGroups } from './character-cache.js';
import { characterDigestFieldsHash, characterDigestSource, normalizeFav, normalizeTagIds, shallowCharacterData } from './hash-utils.js';

/**
 * @typedef {import('../script.js').Character} Character
 */

/**
 * @typedef {object} CharacterQueryFilter - mirrors the server's `POST /api/characters/query` filter shape.
 * @property {string} [search] - routed to the FTS/tantivy index, joined back to SQLite by id.
 * @property {{include: string[], exclude: string[], mode: 'and'|'or'}} [tags]
 * @property {boolean} [fav]
 * @property {string} [world]
 * @property {string[]} [excludeIds] - group member exclusion.
 * @property {string[]} [ids] - resolve-by-id batch; intersects with `search` when both are present.
 * @property {boolean} [includeGroups] - `true` merges groups into the same sorted/paginated result, and `rows`
 * becomes `Array<{type: 'character', item: Character} | {type: 'group', item: Group}>` instead of bare
 * `Character[]` - see `normalizeQueryRow()`. A non-empty `search` still includes matching groups when this is
 * set - groups have their own full-text index, merged server-side with the character one.
 */

/**
 * @typedef {object} CharacterQuerySort
 * @property {'name'|'date_added'|'date_last_chat'|'chat_size'|'fav'|'random'|'search'} field
 * @property {'asc'|'desc'} [order]
 * @property {number} [seed] - required (finite) when `field` is `'random'`; mint one with `getRandomSortSeed()`
 * (random-sort.js), never invent one here.
 */

/**
 * @typedef {object} CharacterQueryResult
 * @property {Character[]|Array<{type: 'character', item: Character}|{type: 'group', item: object}>} [rows] -
 * bare `Character[]` unless the request set `filter.includeGroups: true` - see `normalizeQueryRow()`.
 * @property {number|string} [total] - a plain number is exact; a `~`-prefixed string (e.g. `"~12345"`) is an
 * approximate count and must not be read as a truncated/capped one. Callers needing arithmetic must strip the
 * `~` themselves - not coerced here, to avoid silently losing the "approximate" signal.
 * @property {number} rev - the metadata store's current change revision at query time.
 * @property {string|null} [token] - `/query`'s freshness token: an opaque hash of what the response was built
 * from, sent back as `ifToken` on a repeat of the same request. `null` when there is nothing to send back.
 * @property {string} [searchBackend] - which search engine answered `filter.search` ('tantivy'), present only
 * when `filter.search` was non-empty.
 * @property {number|string} [hidden] - with `want: 'hidden'`: how many entities the filter leaves out, `~`-prefixed
 * when approximate like `total`.
 */

const DEFAULT_QUERY_WANT = /** @type {const} */ (['rows', 'total']);

/**
 * Last-seen `/query` response per exact request signature, so a repeated request can send back its `token` as
 * `ifToken` and let the server skip row hydration when nothing changed. Only responses with a token are kept.
 * Cleared wholesale past the size limit rather than LRU-evicted - a miss just costs one extra full fetch, never a
 * correctness issue, since a hit is always re-verified by the server against a token rebuilt from the current
 * state.
 * @type {Map<string, any>}
 */
const queryResponseCache = new Map();
const QUERY_RESPONSE_CACHE_LIMIT = 100;

/** Mirrors the server's own page cap (`MAX_QUERY_PAGE_SIZE`) - `queryAll()` chunks its loop at this size. */
const QUERY_ALL_PAGE_SIZE = 2000;

/** Mirrors the server's `MAX_FOLDER_TILES_PER_REQUEST`: `folderTiles()` splits its tiles into requests of this many. */
export const FOLDER_TILES_PER_REQUEST = 200;

/**
 * @typedef {object} FolderTileFilter - mirrors `POST /api/characters/folder-tiles`'s filter shape.
 * @property {string} [search]
 * @property {boolean} [fav]
 * @property {{include: string[], exclude: string[], mode?: 'and'|'or'}} [tags]
 * @property {boolean} [group] - `true`: only groups, `false`: no groups.
 */

/**
 * @typedef {object} FolderTileResult - one tile as `/folder-tiles` answers it.
 * @property {string} id - the tile's tag id.
 * @property {true} [missing] - the tag doesn't exist or is marked deleted; nothing else is set.
 * @property {number|string} [count] - the tile's sub-list size, `~`-prefixed when approximate.
 * @property {number|string} [hidden] - its tagged entities not in the sub-list, `~`-prefixed when approximate.
 * @property {Array<{type: 'character'|'group', item: object}>} [rows] - the sub-list's first rows, at most what
 * the strip shows.
 */

/**
 * A `/query` or `/folder-tiles` count as a number and whether it's approximate.
 * @param {number|string|undefined|null} total A plain number, or a `~`-prefixed string when approximate.
 * @returns {{ value: number, approx: boolean }} `value` is 0 when `total` isn't a number.
 */
export function parseQueryTotal(total) {
    const approx = typeof total === 'string' && total.startsWith('~');
    const value = Number(approx ? total.slice(1) : total ?? 0);
    return { value: Number.isFinite(value) ? value : 0, approx };
}

/**
 * @typedef {object} CharacterQueryStateInput
 * @property {string} [searchTerm] - current search box value.
 * @property {string[]} [tagsInclude] - selected tag ids.
 * @property {string[]} [tagsExclude] - excluded tag ids.
 * @property {boolean} [fav] - `undefined` for no fav filter; this module takes no dependency on filters.js, so
 * callers normalize the tri-state themselves before calling.
 * @property {string} [sortField] - `power_user.sort_field`, or `'random'`/`'search'` for those two special cases.
 * @property {'asc'|'desc'} [sortOrder] - `'random'` itself is carried via `sortField`, not this.
 * @property {number} [randomSeed] - required (finite) when `sortField === 'random'`.
 * @property {boolean} [includeGroups] - see `CharacterQueryFilter.includeGroups`.
 */

/**
 * Pure mapping from the client's current filter/sort UI state to the server `/query` wire shape. Does not gate
 * eligibility for the server-query path itself - callers decide that first and just shape whatever state they
 * pass.
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
    // Trimmed to match the route's own check - a whitespace-only term must not read as "search present" here.
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
 * Whether `sortField` is even a candidate for the server `/query` path. Deliberately does not try to know in
 * advance which columns the server supports for sorting - that's the server's `400 { reason:
 * 'invalid-sort-field' }` response to find out (see `isInvalidSortFieldError()`), not a client-side mirror of
 * its column list, which drifts. Only `'search'` is excluded here: relevance order comes from the search index
 * directly, not a `sort.field` column, so it was never going to work via `/query` regardless of what the server
 * supports.
 * @param {string|undefined} sortField
 * @returns {boolean}
 */
export function isServerQueryableSort(sortField) {
    return sortField !== 'search';
}

/**
 * Normalizes one `/query` response row to a `{type, item}` shape regardless of whether the request set
 * `filter.includeGroups`. A bare row (no `type` field) is always a character.
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
 * Records on each row's item the tag fetch stamp its data is as fresh as (see isFetchedTagIdsCurrent()).
 * Non-enumerable, so it never gets copied or persisted along with the row's data.
 * @param {CharacterQueryResult|undefined} result
 * @param {number} fetchStamp
 */
function stampRowsTagFetch(result, fetchStamp) {
    if (!Array.isArray(result?.rows)) return;
    for (const row of result.rows) {
        const { item } = normalizeQueryRow(row);
        if (item && typeof item === 'object') {
            Object.defineProperty(item, 'tagFetchStamp', { value: fetchStamp, writable: true, configurable: true, enumerable: false });
        }
    }
}

/**
 * Thrown by `postJson()` for a non-ok response. Carries the parsed JSON body, when there was one, so callers can
 * distinguish a specific server-declared rejection (e.g. `reason: 'invalid-sort-field'`) from a generic failure.
 * Prefer `isInvalidSortFieldError()` over checking `.reason` directly.
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
 * Whether `error` is `postJson()` rejecting a `/query` request because `sort.field` isn't one the server can
 * answer - the one failure mode callers should catch and fall back to a local sort for. Every other failure
 * must propagate normally.
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
 * Search-backend enum codes for `/query`'s binary hash-mode response - mirrors HASH_QUERY_SEARCH_BACKEND_CODES
 * server-side (src/endpoints/characters.js). 0 means "absent".
 */
const HASH_QUERY_SEARCH_BACKEND_NAMES = { 1: 'tantivy', 2: 'native', 3: 'wasm', 4: 'unavailable' };

/**
 * Decodes `/query`'s hash-only mode (`want: ['hashes']`) binary response. See
 * `serializeQueryHashesBinary()` server-side (src/endpoints/characters.js) for the matching encoder and the
 * field-by-field layout spec this just walks with a `DataView`.
 * @param {ArrayBuffer} buffer
 * @returns {{seq: number, token: string|null, total: number|undefined, totalApprox: boolean, hidden: number|undefined, hiddenApprox: boolean, searchBackend: string|undefined, hashRows: {id:string, isGroup:boolean, favHash:number, tagIdsHash:number, contentHash:number, date_added:number, create_date:number|null, date_last_chat:number, chat_size:number, data_size:number, chat:string|null}[]}}
 */
function deserializeQueryHashesBinary(buffer) {
    const view = new DataView(buffer);
    const decoder = new TextDecoder();
    let offset = 0;

    const headerFlags = view.getUint8(offset); offset += 1;
    const hasTotal = (headerFlags & 0b01) !== 0;
    const totalApprox = (headerFlags & 0b10) !== 0;
    const searchBackendCode = view.getUint8(offset); offset += 1;
    const searchBackend = HASH_QUERY_SEARCH_BACKEND_NAMES[searchBackendCode];
    const seq = view.getFloat64(offset, true); offset += 8;
    const total = view.getFloat64(offset, true); offset += 8;
    const rowCount = view.getUint16(offset, true); offset += 2;

    const hashRows = [];
    for (let i = 0; i < rowCount; i++) {
        const flags = view.getUint8(offset); offset += 1;
        const isGroup = (flags & 0b1) !== 0;
        const hasCreateDate = (flags & 0b10) !== 0;

        const idLen = view.getUint16(offset, true); offset += 2;
        const id = decoder.decode(new Uint8Array(buffer, offset, idLen)); offset += idLen;

        const favHash = view.getUint32(offset, true); offset += 4;
        const tagIdsHash = view.getUint32(offset, true); offset += 4;
        const contentHash = view.getUint32(offset, true); offset += 4;

        const date_added = view.getFloat64(offset, true); offset += 8;
        const createDateRaw = view.getFloat64(offset, true); offset += 8;
        const date_last_chat = view.getFloat64(offset, true); offset += 8;
        const chat_size = view.getFloat64(offset, true); offset += 8;
        const data_size = view.getFloat64(offset, true); offset += 8;

        const chatLen = view.getUint16(offset, true); offset += 2;
        const chat = chatLen > 0 ? decoder.decode(new Uint8Array(buffer, offset, chatLen)) : null;
        offset += chatLen;

        hashRows.push({
            id, isGroup, favHash, tagIdsHash, contentHash,
            date_added, create_date: hasCreateDate ? createDateRaw : null, date_last_chat, chat_size, data_size, chat,
        });
    }

    // Trailer: tokenLen(2) + token(tokenLen, utf8); tokenLen 0 means a null token.
    const tokenLen = view.getUint16(offset, true); offset += 2;
    const token = tokenLen > 0 ? decoder.decode(new Uint8Array(buffer, offset, tokenLen)) : null;
    offset += tokenLen;

    // Present only when the request wanted 'hidden': hiddenFlags(1) [bit0=approx] + hidden(8).
    let hidden;
    let hiddenApprox = false;
    if (offset + 9 <= buffer.byteLength) {
        hiddenApprox = (view.getUint8(offset) & 0b1) !== 0; offset += 1;
        hidden = view.getFloat64(offset, true); offset += 8;
    }

    return { seq, token, total: hasTotal ? total : undefined, totalApprox, searchBackend, hashRows, hidden, hiddenApprox };
}

/**
 * Sends `/query` with `want: ['hashes', ...]` and parses the binary (or, on an `ifToken` cache hit, small JSON
 * `{seq, token, unchanged: true}`) response. Mirrors `postJson()`'s error handling for the non-ok case.
 * @param {object} body
 * @returns {Promise<{unchanged: true}|ReturnType<typeof deserializeQueryHashesBinary>>}
 */
async function postHashQuery(body) {
    const response = await fetch('/api/characters/query', {
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
        throw new CharacterQueryError(`/api/characters/query (hashes) failed with ${response.status}${detail ? `: ${detail}` : ''}`, { status: response.status, reason, body: errorBody });
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
        // JSON here only ever means the ifToken "unchanged" stub - hash rows themselves are always binary.
        return response.json();
    }
    return deserializeQueryHashesBinary(await response.arrayBuffer());
}

// Mirrors script.js's own CHARACTER_BATCH_CHUNK_SIZE, not /query's (larger) MAX_QUERY_PAGE_SIZE.
const BATCH_FIELDS_CHUNK_SIZE = 500;

// characterDigestFingerprint()'s own field list (hash-utils.js) minus `avatar`, which /batch always includes.
const HASH_MODE_BATCH_FIELDS = /** @type {const} */ (['name', 'fav', 'tags', 'tag_ids', 'data']);

/**
 * Fetches specific fields for specific ids via `/api/characters/batch`'s field-filtered mode.
 * @param {string[]} ids
 * @param {readonly string[]} fields
 * @returns {Promise<object[]>}
 */
async function fetchBatchFields(ids, fields) {
    if (ids.length === 0) return [];
    const chunks = [];
    for (let i = 0; i < ids.length; i += BATCH_FIELDS_CHUNK_SIZE) {
        chunks.push(ids.slice(i, i + BATCH_FIELDS_CHUNK_SIZE));
    }
    const chunkResults = await Promise.all(chunks.map(chunk => postJson('/api/characters/batch', { avatars: chunk, fields: [...fields] })));
    return chunkResults.flat();
}

/**
 * Fetches full group objects for specific ids - `/api/groups/batch` has no field-filtered mode.
 * @param {string[]} ids
 * @returns {Promise<object[]>}
 */
async function fetchGroupBatchFields(ids) {
    if (ids.length === 0) return [];
    const chunks = [];
    for (let i = 0; i < ids.length; i += BATCH_FIELDS_CHUNK_SIZE) {
        chunks.push(ids.slice(i, i + BATCH_FIELDS_CHUNK_SIZE));
    }
    const chunkResults = await Promise.all(chunks.map(chunk => postJson('/api/groups/batch', { ids: chunk })));
    return chunkResults.flat();
}

/**
 * Fields hash-mode ships live on every row, outside the per-field hash's coverage. Always taken from the
 * just-received hash row, never from a cached/fetched character object, so a stale cache entry can never leave
 * a character showing an outdated chat pointer or date/size.
 * @param {{chat:string|null, date_added:number, create_date:number|null, date_last_chat:number, chat_size:number, data_size:number}} hashRow
 */
function liveFieldsFromHashRow(hashRow) {
    return {
        chat: hashRow.chat,
        date_added: hashRow.date_added,
        create_date: hashRow.create_date,
        date_last_chat: hashRow.date_last_chat,
        chat_size: hashRow.chat_size,
        data_size: hashRow.data_size,
    };
}

/**
 * A cached character as the row a miss returns for it: the fields `/batch` field-filtered mode returns from
 * shallow_json (HASH_MODE_BATCH_FIELDS), with nothing else from the cached record, so a consumer can't tell a
 * hit from a miss. A whole-record cache entry carries fields shallow_json doesn't (and, with
 * `shallowCharactersIncludeCreatorNotes` off, `data.creator_notes`), which the hashes don't cover.
 *
 * Whether the row's shallow_json holds `data.creator_notes` is read off its content hash: the cached record
 * matches it hashed one way only.
 * @param {object} character The cached record, whose hashes matched `contentHash`.
 * @param {number} contentHash The row's content hash from the server.
 * @returns {object|undefined} `undefined` if the record matches `contentHash` neither way (refetch it).
 */
function projectCachedCharacter(character, contentHash) {
    const includeCreatorNotes = [false, true].find(include =>
        characterDigestFieldsHash(characterDigestSource(character, include)) % 4294967296 === contentHash);
    if (includeCreatorNotes === undefined) return undefined;
    const data = shallowCharacterData(character, includeCreatorNotes);
    data.extensions.fav = normalizeFav(data.extensions.fav);
    /** @type {Record<string, any>} */
    const row = {};
    // JSON drops undefined values, so a field a miss's shallow_json lacks is absent from its row.
    if (character.name !== undefined) row.name = character.name;
    row.fav = normalizeFav(character.fav);
    if (character.tags !== undefined) row.tags = character.tags;
    row.tag_ids = normalizeTagIds(character.tag_ids);
    row.data = data;
    return row;
}

/** Owns character residency for internal (non-extension) client code. */
export class CharacterRepository {
    /** @type {import('./entity-store.js').EntityStore<Character>} */
    store;

    /**
     * @param {import('./entity-store.js').EntityStore<Character>} [store] - defaults to the app's real
     * `charactersStore` singleton; overridable for tests.
     */
    constructor(store = charactersStore) {
        this.store = store;
    }

    /**
     * Sync resident read. Never fetches. `undefined` means "not currently resident", not "does not exist" -
     * use `exists()` for an authoritative answer.
     * @param {string} id
     * @returns {Character|undefined}
     */
    peek(id) {
        return this.store.get(id);
    }

    /**
     * Resolves one character: resident row if present, otherwise a server round-trip. Deliberately does NOT
     * write the fallback result back into `charactersStore` - several call sites read `characters.length`
     * directly to mean "the boot-loaded library", and silently growing that array as a read side effect would
     * make those counts lie.
     * @param {string} id
     * @returns {Promise<Character|undefined>} `undefined` if the id genuinely does not resolve, not merely
     * "not resident".
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
     * Hydrates the full card for an already-resident character and returns the (in-place-updated) resident
     * entity. Throws for a non-resident id rather than fetching one in - entry-level fault-in isn't implemented,
     * since it'd require deciding whether the fetched card should join `charactersStore` (see `get()`).
     * @param {string} id
     * @returns {Promise<Character>}
     * @throws {Error} if `id` is not currently resident.
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
     * The workhorse: one page of query results, straight from `POST /api/characters/query`.
     * @param {CharacterQueryFilter} [filter]
     * @param {CharacterQuerySort} [sort]
     * @param {number} [page] - 1-based, matching the server's convention.
     * @param {number} [pageSize]
     * @param {('rows'|'total'|'hidden'|'facets'|'rank')[]} [want] - defaults to `['rows', 'total']`; pass a narrower set
     * (e.g. `['rows']`) to skip paying for a count the caller doesn't need. `'hidden'` adds `hidden`, how many
     * entities the filter leaves out.
     * @returns {Promise<CharacterQueryResult>}
     */
    async query(filter = {}, sort = undefined, page = 1, pageSize = 100, want = DEFAULT_QUERY_WANT) {
        // Mirrors the route's own rule: relevance order requires something to rank by, so a blank term
        // cannot ask for a 'search' sort.
        const search = typeof filter.search === 'string' ? filter.search.trim() : '';
        const normalizedFilter = search ? { ...filter, search } : (() => {
            const rest = { ...filter };
            delete rest.search;
            return rest;
        })();
        const normalizedSort = sort?.field === 'search' && !search ? undefined : sort;
        const requestShape = { filter: normalizedFilter, sort: normalizedSort, page, pageSize, want };
        const signature = JSON.stringify(requestShape);
        const cached = queryResponseCache.get(signature);

        // Hash mode: when `rows` is wanted, transport row data as {id, hash} plus a few live fields instead of
        // full JSON, resolving each row from the local per-id cache on a hash match and only batch-fetching ids
        // that are missing or changed. A bare `want: ['total']` has nothing to gain from this, so it skips it.
        const useHashMode = want.includes('rows');
        const includeGroups = normalizedFilter.includeGroups === true;

        const fetchStamp = tagFetchStamp();
        const result = useHashMode
            ? await this.#queryHashMode(requestShape, cached, includeGroups)
            : await postJson('/api/characters/query', cached ? { ...requestShape, ifToken: cached.token } : requestShape);

        // Server confirmed nothing changed - reuse the cached response rather than the rows/total-less stub.
        if (result?.unchanged === true && cached) {
            stampRowsTagFetch(cached, fetchStamp);
            return cached;
        }

        // Kept under its token: a response without one has nothing to send back, so it isn't kept.
        if (result && typeof result.token === 'string' && result.token.length > 0) {
            if (queryResponseCache.size >= QUERY_RESPONSE_CACHE_LIMIT) queryResponseCache.clear();
            queryResponseCache.set(signature, result);
        }

        stampRowsTagFetch(result, fetchStamp);
        return result;
    }

    /**
     * The hash-mode transport for `query()`: decodes the binary response and resolves each row to a full
     * object, returning the same `{rows, total, seq, searchBackend}` shape the JSON path returns so nothing
     * downstream needs to know which transport ran.
     * @param {{filter: object, sort: object|undefined, page: number, pageSize: number, want: string[]}} requestShape
     * @param {CharacterQueryResult|undefined} cached
     * @param {boolean} includeGroups
     * @returns {Promise<CharacterQueryResult|{unchanged: true}>}
     */
    async #queryHashMode(requestShape, cached, includeGroups) {
        const hashWant = requestShape.want.map(w => w === 'rows' ? 'hashes' : w);
        const body = { ...requestShape, want: hashWant };
        if (cached) body.ifToken = cached.token;

        const decoded = await postHashQuery(body);
        if (decoded?.unchanged === true) {
            return decoded;
        }

        /** @type {CharacterQueryResult} */
        const result = { seq: decoded.seq, token: decoded.token };
        if (decoded.total !== undefined) result.total = decoded.totalApprox ? `~${decoded.total}` : decoded.total;
        if (decoded.hidden !== undefined) result.hidden = decoded.hiddenApprox ? `~${decoded.hidden}` : decoded.hidden;
        if (decoded.searchBackend !== undefined) result.searchBackend = decoded.searchBackend;
        result.rows = await this.#resolveHashRows(decoded.hashRows, includeGroups);
        return result;
    }

    /**
     * Resolves hash-mode's `{id, isGroup, favHash, tagIdsHash, contentHash, ...live fields}` rows into full
     * objects. A row whose hashes match the local per-id cache is answered from cache with its live fields
     * overlaid, no refetch; everything else goes through one batched fetch (characters and groups separately,
     * since they're different endpoints/caches) and gets cached for next time.
     * @param {ReturnType<typeof deserializeQueryHashesBinary>['hashRows']} hashRows
     * @param {boolean} includeGroups
     * @returns {Promise<Array<Character|{type: 'character'|'group', item: Character|object}>>}
     */
    async #resolveHashRows(hashRows, includeGroups) {
        if (hashRows.length === 0) return [];

        const charHashRows = hashRows.filter(r => !r.isGroup);
        const groupHashRows = includeGroups ? hashRows.filter(r => r.isGroup) : [];

        const [resolvedChars, resolvedGroups] = await Promise.all([
            this.#resolveCharacterHashRows(charHashRows),
            groupHashRows.length > 0 ? this.#resolveGroupHashRows(groupHashRows) : new Map(),
        ]);

        const resolved = hashRows.map(hr => {
            if (hr.isGroup) {
                const group = resolvedGroups.get(hr.id);
                if (!group) return undefined;
                return includeGroups ? { type: 'group', item: group } : undefined;
            }
            const character = resolvedChars.get(hr.id);
            if (!character) return undefined;
            return includeGroups ? { type: 'character', item: character } : character;
        });

        // An id its own batch call didn't return for (deleted mid-flight) is dropped rather than shipping a hole.
        return resolved.filter(Boolean);
    }

    /**
     * The character half of #resolveHashRows(), using the character cache/batch endpoint.
     * @param {ReturnType<typeof deserializeQueryHashesBinary>['hashRows']} hashRows Already filtered to `!isGroup`.
     * @returns {Promise<Map<string, Character>>} keyed by id.
     */
    async #resolveCharacterHashRows(hashRows) {
        const result = new Map();
        if (hashRows.length === 0) return result;

        const cachedEntries = await getCachedEntriesByIds(hashRows.map(r => r.id));
        const staleRows = [];

        for (const hr of hashRows) {
            const entry = cachedEntries.get(hr.id);
            const hit = entry && entry.hashes.fav === hr.favHash && entry.hashes.tagIds === hr.tagIdsHash && entry.hashes.content === hr.contentHash;
            const projected = hit ? projectCachedCharacter(entry.character, hr.contentHash) : undefined;
            if (projected) {
                result.set(hr.id, { avatar: hr.id, ...projected, ...liveFieldsFromHashRow(hr), shallow: true });
            } else {
                staleRows.push(hr);
            }
        }

        if (staleRows.length > 0) {
            const fetched = await fetchBatchFields(staleRows.map(hr => hr.id), HASH_MODE_BATCH_FIELDS);
            const fetchedByAvatar = new Map(fetched.map(c => [c.avatar, c]));
            /** @type {{avatar: string, character: Character}[]} */
            const toCache = [];
            for (const hr of staleRows) {
                const partial = fetchedByAvatar.get(hr.id);
                if (!partial) continue;
                const merged = { ...partial, ...liveFieldsFromHashRow(hr), avatar: hr.id, shallow: true };
                result.set(hr.id, merged);
                toCache.push({ avatar: hr.id, character: merged });
            }
            if (toCache.length > 0) {
                await saveCachedCharacters(toCache);
            }
        }

        return result;
    }

    /**
     * The group half of #resolveHashRows(), against the group-side cache and `/api/groups/batch`.
     * @param {ReturnType<typeof deserializeQueryHashesBinary>['hashRows']} hashRows Already filtered to `isGroup`.
     * @returns {Promise<Map<string, object>>} keyed by id.
     */
    async #resolveGroupHashRows(hashRows) {
        const result = new Map();
        if (hashRows.length === 0) return result;

        const cachedEntries = await getCachedGroupEntriesByIds(hashRows.map(r => r.id));
        const staleRows = [];

        for (const hr of hashRows) {
            const entry = cachedEntries.get(hr.id);
            const hit = entry && entry.hashes.fav === hr.favHash && entry.hashes.tagIds === hr.tagIdsHash && entry.hashes.content === hr.contentHash;
            if (hit) {
                result.set(hr.id, { ...entry.group, ...liveFieldsFromHashRow(hr), id: hr.id });
            } else {
                staleRows.push(hr);
            }
        }

        if (staleRows.length > 0) {
            const fetched = await fetchGroupBatchFields(staleRows.map(hr => hr.id));
            const fetchedById = new Map(fetched.map(g => [g.id, g]));
            /** @type {{id: string, group: object}[]} */
            const toCache = [];
            for (const hr of staleRows) {
                const partial = fetchedById.get(hr.id);
                if (!partial) continue;
                result.set(hr.id, { ...partial, ...liveFieldsFromHashRow(hr), id: hr.id });
                // Without the live fields: the server's digests don't cover them, so hashing them would never hit.
                toCache.push({ id: hr.id, group: partial });
            }
            if (toCache.length > 0) {
                await saveCachedGroups(toCache);
            }
        }

        return result;
    }

    /**
     * Fetches *every* row matching a filter+sort by looping `query()` pages internally. Not the endpoint's
     * intended access pattern at scale (fully materializes the matched set client-side) - it exists for callers
     * that need one fully resident, fully sorted array to merge with something not itself server-paginated
     * (`getEntitiesList()`'s and `favsToHotswap()`'s always-resident group/folder merge).
     *
     * Never trusts `total` as a loop-termination bound: it may be an approximate estimate. The stop condition is
     * always a short page (fewer rows than requested), exact or approximate `total` notwithstanding.
     * @param {CharacterQueryFilter} [filter] - pass `includeGroups: true` to merge groups into the loop too; the
     * returned array is then the tagged `{type, item}` row shape rather than bare `Character[]`.
     * @param {CharacterQuerySort} [sort]
     * @returns {Promise<Array<Character|{type: 'character'|'group', item: Character|object}>>} every matching
     * row, in server sort order.
     */
    async queryAll(filter = {}, sort = undefined) {
        /** @type {Array<Character|{type: 'character'|'group', item: Character|object}>} */
        const rows = [];
        let page = 1;
        // A per-page `sort.field: 'random'` would force SQLite to re-sort the entire filtered table on every
        // page (RANDHASH isn't an indexed column, so OFFSET can't skip past it) - quadratic in library size.
        // Dropped here since both current random-sort callers re-sort the result client-side afterward anyway.
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
     * The folder tiles for `tileIds`, from `POST /api/characters/folder-tiles`, in requests of
     * FOLDER_TILES_PER_REQUEST sent one after another.
     * @param {string[]} tileIds - the tiles' tag ids.
     * @param {FolderTileFilter} filter
     * @param {CharacterQuerySort} [sort]
     * @returns {Promise<FolderTileResult[]>} one entry per distinct id, in the order asked.
     */
    async folderTiles(tileIds, filter, sort = undefined) {
        const ids = [...new Set(tileIds)];
        /** @type {FolderTileResult[]} */
        const tiles = [];
        for (let i = 0; i < ids.length; i += FOLDER_TILES_PER_REQUEST) {
            const fetchStamp = tagFetchStamp();
            const result = await postJson('/api/characters/folder-tiles', { tiles: ids.slice(i, i + FOLDER_TILES_PER_REQUEST), filter, sort });
            for (const tile of result.tiles ?? []) {
                stampRowsTagFetch(tile, fetchStamp);
                tiles.push(tile);
            }
        }
        return tiles;
    }

    /**
     * Authoritative existence check - destructive-existence call sites must go through this instead of treating
     * a resident-array miss as "deleted", and must abort their mutation on a failed/partial check rather than
     * treating it as "gone".
     *
     * No client-side chunking needed: the server already chunks internally and returns every requested id in
     * one response.
     * @param {string[]} ids
     * @returns {Promise<Record<string, boolean>>} every requested id is present as a key.
     */
    async exists(ids) {
        return postJson('/api/characters/exists', { ids });
    }

    /**
     * Subscribes to residency changes (create/update/remove/rename/reset) on the backing store.
     * @param {(change: import('./entity-store.js').EntityChange<Character>) => void} fn
     * @returns {() => void} unsubscribe function
     */
    onChange(fn) {
        return this.store.onChange(fn);
    }
}

/** The app-wide repository instance, backed by the real `charactersStore`. */
export const characterRepository = new CharacterRepository();
