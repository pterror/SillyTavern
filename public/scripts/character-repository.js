import { unshallowCharacter } from '../script.js';
import { getRequestHeaders } from './request-headers.js';
import { charactersStore } from './character-store.js';
import { isFetchedTagIdsCurrent, tagFetchStamp } from './tag-fetch-stamps.js';
import { getCachedEntriesByIds, saveCachedCharacters, getCachedGroupEntriesByIds, saveCachedGroups, getCacheUserHandle } from './character-cache.js';
import { readQueryCache, readQueryCursor, writeQueryCache, writeQueryCursor, setQueryCacheUser, pinQueryCache } from './query-result-cache.js';
import { deserializeQueryHashesBinary } from './query-hashes-binary.js';

/** @typedef {import('../script.js').Character} Character */

/**
 * @typedef {object} CharacterQueryFilter
 * @property {string} [search]
 * @property {{include: string[], exclude: string[], mode: 'and'|'or'}} [tags]
 * @property {Record<string, { min?: number, max?: number }>} [ranges]
 * @property {boolean} [fav]
 * @property {string} [world]
 * @property {string[]} [excludeIds]
 * @property {string[]} [ids]
 * @property {boolean} [includeGroups]
 * @property {boolean} [group]
 * @property {string} [folder]
 */

/**
 * @typedef {object} CharacterQuerySort
 * @property {'name'|'date_added'|'date_last_chat'|'chat_size'|'fav'|'random'|'search'} field
 * @property {'asc'|'desc'} [order]
 * @property {number} [seed]
 * @property {{ field: string, order: 'asc'|'desc', seed?: number }} [tie]
 */

/**
 * @typedef {object} CharacterQueryResult
 * @property {Character[]|Array<{type: 'character', item: Character}|{type: 'group', item: object}>} [rows]
 * @property {number|string} [total]
 * @property {number} rev
 * @property {string|null} [token]
 * @property {string} [searchBackend]
 * @property {number|string} [hidden]
 * @property {string} [cursor]
 */

const DEFAULT_QUERY_WANT = /** @type {const} */ (['rows', 'total']);

/** @type {Map<string, any>} */
const queryResponseCache = new Map();
const QUERY_RESPONSE_CACHE_LIMIT = 100;

const resultHashRows = new WeakMap();

const QUERY_ALL_PAGE_SIZE = 2000;
const FULL_BATCH_SIZE = 200;

/**
 * @param {number|string|undefined|null} total
 * @returns {{ value: number, approx: boolean }}
 */
export function parseQueryTotal(total) {
    const approx = typeof total === 'string' && total.startsWith('~');
    const value = Number(approx ? total.slice(1) : total ?? 0);
    return { value: Number.isFinite(value) ? value : 0, approx };
}

/**
 * @typedef {object} CharacterQueryStateInput
 * @property {string} [searchTerm]
 * @property {string[]} [tagsInclude]
 * @property {string[]} [tagsExclude]
 * @property {'and'|'or'} [tagsMode]
 * @property {Record<string, { min?: number, max?: number }>} [ranges]
 * @property {boolean} [fav]
 * @property {string} [sortField]
 * @property {'asc'|'desc'} [sortOrder]
 * @property {number} [randomSeed]
 * @property {{ field: string, order: 'asc'|'desc', seed?: number }} [sortTie]
 * @property {boolean} [includeGroups]
 * @property {boolean} [group]
 * @property {string} [folder]
 */

/**
 * @param {CharacterQueryStateInput} [state]
 * @returns {{filter: CharacterQueryFilter, sort: CharacterQuerySort|undefined}}
 */
export function buildCharacterQuery({
    searchTerm = '',
    tagsInclude = [],
    tagsExclude = [],
    tagsMode = 'and',
    ranges = undefined,
    fav = undefined,
    sortField = undefined,
    sortOrder = 'asc',
    randomSeed = undefined,
    sortTie = undefined,
    includeGroups = false,
    group = undefined,
    folder = undefined,
} = {}) {
    /** @type {CharacterQueryFilter} */
    const filter = {};
    const search = String(searchTerm ?? '').trim();
    if (search) filter.search = search;
    if (tagsInclude.length > 0 || tagsExclude.length > 0) {
        filter.tags = { include: tagsInclude, exclude: tagsExclude, mode: tagsMode === 'or' ? 'or' : 'and' };
    }
    if (ranges && Object.keys(ranges).length > 0) filter.ranges = ranges;
    if (typeof fav === 'boolean') filter.fav = fav;
    if (includeGroups) filter.includeGroups = true;
    if (typeof group === 'boolean') filter.group = group;
    if (typeof folder === 'string' && folder) filter.folder = folder;

    /** @type {CharacterQuerySort|undefined} */
    let sort;
    if (sortField === 'random') {
        sort = { field: 'random', order: sortOrder === 'desc' ? 'desc' : 'asc', seed: randomSeed };
    } else if (sortField) {
        sort = { field: /** @type {CharacterQuerySort['field']} */ (sortField), order: sortOrder === 'desc' ? 'desc' : 'asc' };
        if (sortField === 'search' && sortTie) sort.tie = sortTie;
    }

    return { filter, sort };
}

/**
 * @param {string|undefined} sortField
 * @returns {boolean}
 */
export function isServerQueryableSort(sortField) {
    return sortField !== 'search';
}

/**
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

export class CharacterQueryError extends Error {
    /**
     * @param {string} message
     * @param {object} param1
     * @param {number} param1.status
     * @param {string} [param1.reason]
     * @param {any} [param1.body]
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
        return response.json();
    }
    return deserializeQueryHashesBinary(await response.arrayBuffer());
}

const BATCH_FIELDS_CHUNK_SIZE = 500;

const HASH_MODE_BATCH_FIELDS = /** @type {const} */ (['name', 'fav', 'tags', 'tag_ids', 'data', 'thumbnail', 'avatar_ref']);

/**
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
 * @param {Record<string, any>} character
 * @returns {Record<string, any>}
 */
function projectCachedCharacter(character) {
    /** @type {Record<string, any>} */
    const row = {};
    for (const field of HASH_MODE_BATCH_FIELDS) {
        if (character[field] !== undefined) row[field] = character[field];
    }
    return row;
}

/**
 * @param {CharacterQueryFilter} filter
 * @param {CharacterQuerySort|undefined} sort
 * @param {number} page
 * @param {number} pageSize
 * @param {readonly string[]} want
 * @returns {{filter: CharacterQueryFilter, sort: CharacterQuerySort|undefined, page: number, pageSize: number, want: string[]}}
 */
function normalizedQueryRequest(filter, sort, page, pageSize, want) {
    const search = typeof filter.search === 'string' ? filter.search.trim() : '';
    const normalizedFilter = search ? { ...filter, search } : (() => {
        const rest = { ...filter };
        delete rest.search;
        return rest;
    })();
    const normalizedSort = sort?.field === 'search' && !search ? undefined : sort;
    return { filter: normalizedFilter, sort: normalizedSort, page, pageSize, want: [...want] };
}

export class CharacterRepository {
    /** @type {import('./entity-store.js').EntityStore<Character>} */
    store;

    /**
     * @param {import('./entity-store.js').EntityStore<Character>} [store]
     */
    constructor(store = charactersStore) {
        this.store = store;
    }

    /**
     * @param {string} id
     * @returns {Character|undefined}
     */
    peek(id) {
        return this.store.get(id);
    }

    /**
     * @param {string} id
     * @returns {Promise<Character|undefined>}
     */
    async get(id) {
        const resident = this.peek(id);
        if (resident) return resident;

        const result = await this.query({ ids: [id] }, undefined, 1, 1, ['rows']);
        return result.rows?.[0];
    }

    /**
     * @param {string[]} ids
     * @returns {Promise<Map<string, Character>>}
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

        for (let start = 0; start < missing.length; start += QUERY_ALL_PAGE_SIZE) {
            const chunk = missing.slice(start, start + QUERY_ALL_PAGE_SIZE);
            const fetched = await this.query({ ids: chunk }, undefined, 1, chunk.length, ['rows']);
            for (const row of fetched.rows ?? []) {
                result.set(row.avatar, row);
            }
        }
        return result;
    }

    /**
     * @param {string} id
     * @returns {Promise<Character|undefined>}
     */
    async full(id) {
        if (this.store.has(id)) {
            await unshallowCharacter(id);
            return this.store.get(id);
        }
        const response = await fetch('/api/characters/get', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ avatar_url: id }),
        });
        if (response.status === 404) {
            return undefined;
        }
        if (!response.ok) {
            throw new CharacterQueryError(`/api/characters/get failed with ${response.status}`, { status: response.status, reason: undefined, body: undefined });
        }
        const character = await response.json();
        character.chat = character.chat ? String(character.chat) : '';
        character.shallow = false;
        return character;
    }

    /**
     * @param {string[]} ids
     * @returns {Promise<Map<string, Character>>}
     */
    async fullMany(ids) {
        /** @type {Map<string, Character>} */
        const result = new Map();
        /** @type {string[]} */
        const missing = [];
        for (const id of ids) {
            const held = this.peek(id);
            if (held) result.set(id, held);
            else missing.push(id);
        }
        for (const [id, character] of await this.readFull(missing)) {
            result.set(id, character);
        }
        return result;
    }

    /**
     * @param {string[]} ids
     * @returns {Promise<Map<string, Character>>}
     */
    async readFull(ids) {
        /** @type {Map<string, Character>} */
        const result = new Map();
        for (let start = 0; start < ids.length; start += FULL_BATCH_SIZE) {
            const chunk = ids.slice(start, start + FULL_BATCH_SIZE);
            const fetchStamp = tagFetchStamp();
            const response = await fetch('/api/characters/batch', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ avatars: chunk, full: true }),
            });
            if (!response.ok) {
                throw new CharacterQueryError(`/api/characters/batch failed with ${response.status}`, { status: response.status, reason: undefined, body: undefined });
            }
            /** @type {Character[]} */
            const characters = await response.json();
            for (const character of characters) {
                character.chat = character.chat ? String(character.chat) : '';
                character.shallow = false;
                if (!isFetchedTagIdsCurrent(character.avatar, fetchStamp)) {
                    delete character.tag_ids;
                }
                result.set(character.avatar, character);
            }
        }
        return result;
    }

    /**
     * @param {CharacterQueryFilter} [filter]
     * @param {CharacterQuerySort} [sort]
     * @param {number} [page]
     * @param {number} [pageSize]
     * @param {('rows'|'total'|'hidden'|'facets'|'rank')[]} [want]
     * @param {object} [options]
     * @param {(result: CharacterQueryResult) => void} [options.onFresh]
     * @returns {Promise<CharacterQueryResult>}
     */
    async query(filter = {}, sort = undefined, page = 1, pageSize = 100, want = DEFAULT_QUERY_WANT, { onFresh } = {}) {
        const requestShape = normalizedQueryRequest(filter, sort, page, pageSize, want);
        const { filter: normalizedFilter } = requestShape;
        const signature = JSON.stringify(requestShape);

        const useHashMode = want.includes('rows');
        const includeGroups = normalizedFilter.includeGroups === true;

        const cached = queryResponseCache.get(signature);
        setQueryCacheUser(getCacheUserHandle());
        const kept = !cached && useHashMode ? await readQueryCache(signature) : null;
        if (kept && onFresh) {
            const stale = await this.#resultFromKept(kept, includeGroups);
            void this.#fetchQuery(requestShape, signature, stale, kept, useHashMode, includeGroups)
                .then(fresh => {
                    if (fresh !== stale) onFresh(fresh);
                })
                .catch(error => console.warn('[query] revalidating a kept page failed:', error));
            return stale;
        }
        return this.#fetchQuery(requestShape, signature, cached ?? (kept ? { token: kept.token } : undefined), kept, useHashMode, includeGroups);
    }

    /**
     * @param {string} owner
     * @param {CharacterQueryFilter} filter
     * @param {CharacterQuerySort|undefined} sort
     * @param {number} page
     * @param {number} pageSize
     * @param {readonly string[]} want
     */
    async pinPage(owner, filter, sort, page, pageSize, want) {
        setQueryCacheUser(getCacheUserHandle());
        await pinQueryCache(owner, [JSON.stringify(normalizedQueryRequest(filter, sort, page, pageSize, want))]);
    }

    /**
     * @param {string} owner
     */
    async unpinPages(owner) {
        setQueryCacheUser(getCacheUserHandle());
        await pinQueryCache(owner, []);
    }

    /**
     * @param {import('./query-result-cache.js').QueryCacheEntry} kept
     * @param {boolean} includeGroups
     * @returns {Promise<CharacterQueryResult>}
     */
    async #resultFromKept(kept, includeGroups) {
        /** @type {CharacterQueryResult} */
        const result = { seq: kept.seq, token: kept.token, rows: await this.#resolveHashRows(kept.hashRows, includeGroups) };
        for (const field of /** @type {const} */ (['total', 'hidden', 'searchBackend', 'cursor'])) {
            if (kept[field] !== undefined) result[field] = kept[field];
        }
        resultHashRows.set(result, kept.hashRows);
        return result;
    }

    /**
     * @param {{filter: object, sort: object|undefined, page: number, pageSize: number, want: string[]}} requestShape
     * @param {string} signature
     * @param {CharacterQueryResult | { token: string } | undefined} cached
     * @param {import('./query-result-cache.js').QueryCacheEntry | null} kept
     * @param {boolean} useHashMode
     * @param {boolean} includeGroups
     * @returns {Promise<CharacterQueryResult>}
     */
    async #fetchQuery(requestShape, signature, cached, kept, useHashMode, includeGroups) {
        const { page } = requestShape;

        const fetchStamp = tagFetchStamp();
        const previousKey = page > 1 ? JSON.stringify({ ...requestShape, page: page - 1 }) : null;
        const start = previousKey === null ? null : await readQueryCursor(previousKey);
        const firstShape = start === null ? requestShape : { ...requestShape, cursor: start };
        const ask = (/** @type {typeof requestShape & { cursor?: string }} */ shape) => (useHashMode
            ? this.#queryHashMode(shape, cached, includeGroups)
            : postJson('/api/characters/query', cached ? { ...shape, ifToken: cached.token } : shape));
        let result;
        try {
            result = await ask(firstShape);
        } catch (error) {
            if (firstShape === requestShape || !(error instanceof CharacterQueryError) || error.reason !== 'invalid-cursor') throw error;
            await writeQueryCursor(/** @type {string} */ (previousKey), undefined);
            result = await ask(requestShape);
        }

        if (result?.unchanged === true && cached) {
            const answer = 'rows' in cached || !kept ? /** @type {CharacterQueryResult} */ (cached) : await this.#resultFromKept(kept, includeGroups);
            if (answer !== cached) {
                if (queryResponseCache.size >= QUERY_RESPONSE_CACHE_LIMIT) queryResponseCache.clear();
                queryResponseCache.set(signature, answer);
            }
            stampRowsTagFetch(answer, fetchStamp);
            return answer;
        }

        if (result?.more === true) {
            result = await this.#fillPage(result, requestShape, useHashMode, includeGroups);
        }
        let keptPage = false;
        if (result && typeof result.token === 'string' && result.token.length > 0) {
            if (queryResponseCache.size >= QUERY_RESPONSE_CACHE_LIMIT) queryResponseCache.clear();
            queryResponseCache.set(signature, result);
            const hashRows = resultHashRows.get(result);
            if (hashRows) {
                /** @type {import('./query-result-cache.js').QueryCacheEntry} */
                const entry = { hashRows, token: result.token, seq: result.seq };
                for (const field of /** @type {const} */ (['total', 'hidden', 'searchBackend', 'cursor'])) {
                    if (result[field] !== undefined) entry[field] = result[field];
                }
                void writeQueryCache(signature, entry);
                keptPage = true;
            }
        }
        if (result && !keptPage) void writeQueryCursor(signature, typeof result.cursor === 'string' ? result.cursor : undefined);

        stampRowsTagFetch(result, fetchStamp);
        return result;
    }

    /**
     * @param {CharacterQueryResult & {more?: boolean}} first
     * @param {{filter: object, sort: object|undefined, page: number, pageSize: number, want: string[]}} requestShape
     * @param {boolean} useHashMode
     * @param {boolean} includeGroups
     * @returns {Promise<CharacterQueryResult>}
     */
    async #fillPage(first, requestShape, useHashMode, includeGroups) {
        const rows = [...(first.rows ?? [])];
        const hashRows = [...(resultHashRows.get(first) ?? [])];
        let last = first;
        const want = requestShape.want.filter(w => w !== 'hidden');
        while (last.more === true && typeof last.cursor === 'string' && rows.length < requestShape.pageSize) {
            const shape = { ...requestShape, want, pageSize: requestShape.pageSize - rows.length, cursor: last.cursor };
            last = useHashMode ? await this.#queryHashMode(shape, undefined, includeGroups) : await postJson('/api/characters/query', shape);
            rows.push(...(last.rows ?? []));
            hashRows.push(...(resultHashRows.get(last) ?? []));
        }
        /** @type {CharacterQueryResult} */
        const result = { ...first, rows, seq: last.seq, token: last.token };
        if (useHashMode) resultHashRows.set(result, hashRows);
        delete result.more;
        if (last.total !== undefined) result.total = last.total;
        if (typeof last.cursor === 'string') result.cursor = last.cursor;
        else delete result.cursor;
        if (first.hidden !== undefined) {
            const approx = typeof first.hidden === 'string' && first.hidden.startsWith('~');
            const hidden = Math.max(0, Number(approx ? String(first.hidden).slice(1) : first.hidden) - (rows.length - (first.rows?.length ?? 0)));
            result.hidden = approx ? `~${hidden}` : hidden;
        }
        return result;
    }

    /**
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
        if (decoded.more) result.more = true;
        if (decoded.cursor !== undefined) result.cursor = decoded.cursor;
        result.rows = await this.#resolveHashRows(decoded.hashRows, includeGroups);
        resultHashRows.set(result, decoded.hashRows);
        return result;
    }

    /**
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

        return resolved.filter(Boolean);
    }

    /**
     * @param {ReturnType<typeof deserializeQueryHashesBinary>['hashRows']} hashRows
     * @returns {Promise<Map<string, Character>>}
     */
    async #resolveCharacterHashRows(hashRows) {
        const result = new Map();
        if (hashRows.length === 0) return result;

        const cachedEntries = await getCachedEntriesByIds(hashRows.map(r => r.id));
        const staleRows = [];

        for (const hr of hashRows) {
            const entry = cachedEntries.get(hr.id);
            if (entry && hr.version !== null && entry.hashes.version === hr.version && entry.hashes.tagIds === hr.tagIdsHash) {
                result.set(hr.id, { avatar: hr.id, ...projectCachedCharacter(entry.character), ...liveFieldsFromHashRow(hr), shallow: true });
            } else {
                staleRows.push(hr);
            }
        }

        if (staleRows.length > 0) {
            const fetched = await fetchBatchFields(staleRows.map(hr => hr.id), HASH_MODE_BATCH_FIELDS);
            const fetchedByAvatar = new Map(fetched.map(c => [c.avatar, c]));
            /** @type {{avatar: string, character: Character, version: number}[]} */
            const toCache = [];
            for (const hr of staleRows) {
                const partial = fetchedByAvatar.get(hr.id);
                if (!partial) continue;
                const merged = { ...partial, ...liveFieldsFromHashRow(hr), avatar: hr.id, shallow: true };
                result.set(hr.id, merged);
                if (hr.version !== null) toCache.push({ avatar: hr.id, character: merged, version: hr.version, tagIds: hr.tagIdsHash });
            }
            if (toCache.length > 0) {
                await saveCachedCharacters(toCache);
            }
        }

        return result;
    }

    /**
     * @param {ReturnType<typeof deserializeQueryHashesBinary>['hashRows']} hashRows
     * @returns {Promise<Map<string, object>>}
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
                toCache.push({ id: hr.id, group: partial });
            }
            if (toCache.length > 0) {
                await saveCachedGroups(toCache);
            }
        }

        return result;
    }

    /**
     * @param {CharacterQueryFilter} [filter]
     * @param {CharacterQuerySort} [sort]
     * @returns {Promise<Array<Character|{type: 'character'|'group', item: Character|object}>>}
     */
    async queryAll(filter = {}, sort = undefined) {
        /** @type {Array<Character|{type: 'character'|'group', item: Character|object}>} */
        const rows = [];
        let page = 1;
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
     * @param {string[]} ids
     * @returns {Promise<Record<string, boolean>>}
     */
    async exists(ids) {
        return postJson('/api/characters/exists', { ids });
    }

    /**
     * @param {(change: import('./entity-store.js').EntityChange<Character>) => void} fn
     * @returns {() => void}
     */
    onChange(fn) {
        return this.store.onChange(fn);
    }
}

export const characterRepository = new CharacterRepository();
