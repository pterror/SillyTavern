import express from 'express';

import { contentHashOf } from '../../public/scripts/hash-utils.js';

import {
    listSavedViews,
    getSavedView,
    createSavedView,
    changeSavedView,
    deleteSavedView,
    moveSavedView,
    SAVED_VIEW_NAME_MAX,
    SAVED_VIEW_JSON_MAX,
    SAVED_VIEWS_PAGE_MAX,
    canonicalView,
} from '../saved-views.js';
import { storeRoute } from '../user-stores.js';

/**
 * The user's saved views of the character list. Each change is one action on one view; the page never sends its
 * list of views back.
 */
export const router = express.Router();

/**
 * A view name as stored: trimmed, at most SAVED_VIEW_NAME_MAX characters. null when it isn't a non-empty string.
 * @param {unknown} name
 */
function checkName(name) {
    if (typeof name !== 'string') return null;
    const trimmed = name.trim();
    return trimmed.length > 0 && trimmed.length <= SAVED_VIEW_NAME_MAX ? trimmed : null;
}

/**
 * A view object as stored (`canonicalView()`), or why it isn't one: not a plain object, JSON longer than
 * SAVED_VIEW_JSON_MAX, or a key that doesn't fit a view's shape.
 * @param {unknown} view
 * @returns {{ view: Record<string, unknown> } | { detail: string }}
 */
function checkView(view) {
    if (!view || typeof view !== 'object' || Array.isArray(view)) return { detail: 'view: not an object' };
    if (JSON.stringify(view).length > SAVED_VIEW_JSON_MAX) return { detail: `view: longer than ${SAVED_VIEW_JSON_MAX} characters as JSON` };
    const { view: canonical, problems } = canonicalView(view);
    return problems.length > 0 ? { detail: problems.join('; ') } : { view: canonical };
}

/**
 * Body: `{ contains?, cursor?, limit?, known? }`. Answers `{ views, cursor }`, `cursor` set when more views follow;
 * `{ unchanged: true }` when, with no `cursor`, `known` is contentHashOf() of the first page's `views`.
 */
router.post('/list', storeRoute('listing saved views', async (request, response) => {
    const body = request.body ?? {};
    const cursor = typeof body.cursor === 'string' ? decodeCursor(body.cursor) : null;
    if (typeof body.cursor === 'string' && cursor === null) {
        return response.status(400).send({ error: true, reason: 'invalid-cursor' });
    }
    const limit = Number.isFinite(Number(body.limit)) ? Number(body.limit) : SAVED_VIEWS_PAGE_MAX;
    const page = await listSavedViews(request.user.directories, { contains: typeof body.contains === 'string' ? body.contains : '', after: cursor, limit });
    if (cursor === null && body.known !== undefined && body.known === contentHashOf(page.views)) {
        return response.send({ unchanged: true });
    }
    return response.send({
        views: page.views,
        cursor: page.more && page.last !== null ? encodeCursor(page.last) : null,
    });
}));

/** @param {number} position */
function encodeCursor(position) {
    return Buffer.from(JSON.stringify([position])).toString('base64url');
}

/** @param {string} cursor */
function decodeCursor(cursor) {
    try {
        const [position] = JSON.parse(Buffer.from(cursor, 'base64url').toString());
        return Number.isSafeInteger(position) && position >= 0 ? position : null;
    } catch {
        return null;
    }
}

/** Body: `{ id }`. Answers the view, or 404. */
router.post('/get', storeRoute('reading a saved view', async (request, response) => {
    const id = request.body?.id;
    if (typeof id !== 'string') return response.status(400).send({ error: true, reason: 'id-required' });
    const view = await getSavedView(request.user.directories, id);
    if (view === null) return response.status(404).send({ error: true, reason: 'not-found' });
    return response.send({ id: view.id, name: view.name, view: view.view });
}));

/** Body: `{ name, view }`. Answers the new view, placed after the others; 400 `invalid-view` with a `detail`. */
router.post('/create', storeRoute('creating a saved view', async (request, response) => {
    const name = checkName(request.body?.name);
    if (name === null) return response.status(400).send({ error: true, reason: 'invalid-name' });
    const view = checkView(request.body?.view);
    if ('detail' in view) return response.status(400).send({ error: true, reason: 'invalid-view', detail: view.detail });
    const created = await createSavedView(request.user.directories, { name, view: view.view });
    return response.send({ id: created.id, name: created.name, view: created.view });
}));

/** Body: `{ id, name?, view? }`. Answers the view as stored; 404 when it no longer exists. */
router.post('/change', storeRoute('changing a saved view', async (request, response) => {
    const { id } = request.body ?? {};
    if (typeof id !== 'string') return response.status(400).send({ error: true, reason: 'id-required' });
    const name = request.body.name === undefined ? undefined : checkName(request.body.name);
    if (name === null) return response.status(400).send({ error: true, reason: 'invalid-name' });
    const view = request.body.view === undefined ? undefined : checkView(request.body.view);
    if (view && 'detail' in view) return response.status(400).send({ error: true, reason: 'invalid-view', detail: view.detail });
    const changed = await changeSavedView(request.user.directories, id, { name, view: view && 'view' in view ? view.view : undefined });
    if (changed === null) return response.status(404).send({ error: true, reason: 'not-found' });
    return response.send({ id: changed.id, name: changed.name, view: changed.view });
}));

/** Body: `{ id }`. Answers `{ deleted }`. */
router.post('/delete', storeRoute('deleting a saved view', async (request, response) => {
    const id = request.body?.id;
    if (typeof id !== 'string') return response.status(400).send({ error: true, reason: 'id-required' });
    const deleted = await deleteSavedView(request.user.directories, id);
    return response.send({ deleted });
}));

/** Body: `{ id, anchor, side: 'before' | 'after' }`. Answers `{ result: 'moved' | 'unchanged' }`, or 404. */
router.post('/move', storeRoute('moving a saved view', async (request, response) => {
    const { id, anchor, side } = request.body ?? {};
    if (typeof id !== 'string' || typeof anchor !== 'string' || (side !== 'before' && side !== 'after')) {
        return response.status(400).send({ error: true, reason: 'invalid-move' });
    }
    const result = await moveSavedView(request.user.directories, id, { anchor, side });
    if (result === 'missing') return response.status(404).send({ error: true, reason: 'not-found' });
    return response.send({ result });
}));
