import crypto from 'node:crypto';

import express from 'express';

import { canonicalStringify } from '../public/scripts/hash-utils.js';

/**
 * One shape for every paged list route (the settings model §1.9): `POST /query`
 * `{ filter: { search?, ids? }, pageSize?, cursor?, ifHash? }` → `{ rows, cursor, more }`. A route adds its own filter
 * fields and sorts; the page and hash rules are these.
 *
 * - `pageSize` is clamped to the route's maximum, its default when missing or not a positive number.
 * - `cursor` is the one a previous page answered; null is the end. `more` means the server's work cap cut the page
 *   short and `cursor` carries on.
 * - `filter.ids` asks for those rows only, at most the route's `maxIds` distinct ones.
 * - With `ifHash` (a string, empty when the client holds no copy of the page) the answer also has `hash`, the sha256 of
 *   its canonical JSON, and is only `{ unchanged: true, hash }` when `ifHash` is the hash of what would be answered.
 */

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 500;
export const MAX_IDS = 500;

/**
 * @typedef {object} PageRequest
 * @property {number} pageSize
 * @property {string | null} cursor
 * @property {string[] | undefined} ids
 * @property {string | undefined} search
 * @property {string | undefined} ifHash
 * @typedef {{ rows: unknown[], cursor: string | null, more?: boolean } & Record<string, unknown>} Page
 */

/**
 * The page fields of a request body, or why they're refused (a 400 `reason`).
 * @param {Record<string, any>} body
 * @param {{ defaultPageSize?: number, maxPageSize?: number, maxIds?: number }} [limits]
 * @returns {{ request: PageRequest } | { reason: string, message?: string }}
 */
export function parsePageRequest(body, { defaultPageSize = DEFAULT_PAGE_SIZE, maxPageSize = MAX_PAGE_SIZE, maxIds = MAX_IDS } = {}) {
    const filter = body?.filter ?? {};
    if (body?.ifHash !== undefined && typeof body.ifHash !== 'string') return { reason: 'invalid-if-hash' };
    if (body?.cursor !== undefined && body.cursor !== null && typeof body.cursor !== 'string') return { reason: 'invalid-cursor' };
    if (filter.search !== undefined && typeof filter.search !== 'string') return { reason: 'invalid-search' };
    let ids;
    if (filter.ids !== undefined) {
        if (!Array.isArray(filter.ids) || !filter.ids.every(id => typeof id === 'string')) {
            return { reason: 'invalid-ids', message: 'filter.ids must be an array of strings' };
        }
        ids = [...new Set(filter.ids)];
        if (ids.length > maxIds) return { reason: 'too-many-ids', message: `at most ${maxIds} distinct ids per request` };
    }
    const size = Number(body?.pageSize);
    return {
        request: {
            pageSize: Number.isFinite(size) && size >= 1 ? Math.min(Math.trunc(size), maxPageSize) : defaultPageSize,
            cursor: typeof body?.cursor === 'string' ? body.cursor : null,
            ids,
            search: filter.search?.trim() || undefined,
            ifHash: body?.ifHash,
        },
    };
}

/**
 * @param {unknown} page
 */
export function pageHash(page) {
    return crypto.createHash('sha256').update(canonicalStringify(page)).digest('hex');
}

/**
 * The answer for a page: the page, with its hash when asked, or only the hash when the client's copy is current.
 * @param {Page} page
 * @param {string | undefined} ifHash
 */
export function pageAnswer(page, ifHash) {
    if (ifHash === undefined) return page;
    const hash = pageHash(page);
    return hash === ifHash ? { unchanged: true, hash } : { ...page, hash };
}

/**
 * @typedef {object} CatalogSource
 * @property {(request: PageRequest, filter: Record<string, unknown>) => Promise<Page | 'invalid-cursor'>} query
 */

/**
 * A router answering `POST /query` for a catalog.
 * @param {(request: import('express').Request) => Promise<CatalogSource>} sourceOf
 * @param {string} what For the log.
 */
export function catalogRouter(sourceOf, what) {
    const router = express.Router();
    router.post('/query', async (request, response) => {
        try {
            const parsed = parsePageRequest(request.body ?? {});
            if ('reason' in parsed) return response.status(400).send({ error: true, ...parsed });
            const page = await (await sourceOf(request)).query(parsed.request, request.body?.filter ?? {});
            if (page === 'invalid-cursor') return response.status(400).send({ error: true, reason: 'invalid-cursor' });
            response.send(pageAnswer(page, parsed.request.ifHash));
        } catch (err) {
            console.error(`Could not query ${what}`, err);
            response.status(500).send({ error: true });
        }
    });
    return router;
}

/**
 * A source over rows held in memory (a catalog read from files until the store holds it): ordered by key, `search` a
 * case- and accent-insensitive prefix of its name, the cursor the last key answered.
 * @template T
 * @param {T[]} rows
 * @param {(row: T) => string} keyOf
 * @param {(row: T) => string} [nameOf]
 * @returns {CatalogSource}
 */
export function listSource(rows, keyOf, nameOf = keyOf) {
    const fold = (/** @type {string} */ text) => text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
    const sorted = [...rows].sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0));
    return {
        async query({ pageSize, cursor, ids, search }) {
            const wanted = ids ? new Set(ids) : null;
            const prefix = search ? fold(search) : null;
            const matching = sorted.filter(row => (!wanted || wanted.has(keyOf(row))) && (!prefix || fold(nameOf(row)).startsWith(prefix)));
            const start = cursor === null ? 0 : matching.findIndex(row => keyOf(row) > cursor);
            const from = start === -1 ? matching.length : start;
            const page = matching.slice(from, from + pageSize);
            const next = from + pageSize < matching.length ? keyOf(page[page.length - 1]) : null;
            return { rows: page, cursor: next };
        },
    };
}
