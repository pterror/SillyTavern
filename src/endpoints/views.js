import express from 'express';

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
} from '../character-metadata-db.js';

/**
 * The user's saved views of the character list. Each change is one action on one view; the page never sends its
 * list of views back.
 */
export const router = express.Router();

const unavailable = (/** @type {import('express').Response} */ response) => response.status(503).send({ error: true, reason: 'metadata-store-unavailable' });

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
 * A view object as stored: a plain object whose JSON is at most SAVED_VIEW_JSON_MAX long. null otherwise.
 * @param {unknown} view
 */
function checkView(view) {
    if (!view || typeof view !== 'object' || Array.isArray(view)) return null;
    return JSON.stringify(view).length <= SAVED_VIEW_JSON_MAX ? view : null;
}

/**
 * Body: `{ contains?, cursor?, limit?, ifVersion? }`. Answers `{ version, views, cursor }`, `cursor` set when more
 * views follow; `{ version, unchanged: true }` when `ifVersion` is the current version.
 */
router.post('/list', async (request, response) => {
    const body = request.body ?? {};
    const cursor = typeof body.cursor === 'string' ? decodeCursor(body.cursor) : null;
    if (typeof body.cursor === 'string' && cursor === null) {
        return response.status(400).send({ error: true, reason: 'invalid-cursor' });
    }
    const limit = Number.isFinite(Number(body.limit)) ? Number(body.limit) : SAVED_VIEWS_PAGE_MAX;
    const page = await listSavedViews(request.user.directories, { contains: typeof body.contains === 'string' ? body.contains : '', after: cursor, limit });
    if (!page) return unavailable(response);
    if (Number.isFinite(Number(body.ifVersion)) && Number(body.ifVersion) === page.version && !cursor) {
        return response.send({ version: page.version, unchanged: true });
    }
    const last = page.views.at(-1);
    return response.send({
        version: page.version,
        views: page.views.map(({ id, name, view, updatedAt }) => ({ id, name, view, updatedAt })),
        cursor: page.more && last ? encodeCursor(last) : null,
    });
});

/** @param {{ position: number, id: string }} at */
function encodeCursor({ position, id }) {
    return Buffer.from(JSON.stringify([position, id])).toString('base64url');
}

/** @param {string} cursor */
function decodeCursor(cursor) {
    try {
        const [position, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString());
        return typeof position === 'number' && typeof id === 'string' ? { position, id } : null;
    } catch {
        return null;
    }
}

/** Body: `{ id }`. Answers the view, or 404. */
router.post('/get', async (request, response) => {
    const id = request.body?.id;
    if (typeof id !== 'string') return response.status(400).send({ error: true, reason: 'id-required' });
    const view = await getSavedView(request.user.directories, id);
    if (view === undefined) return unavailable(response);
    if (view === null) return response.status(404).send({ error: true, reason: 'not-found' });
    return response.send({ id: view.id, name: view.name, view: view.view, updatedAt: view.updatedAt });
});

/** Body: `{ name, view }`. Answers the new view, placed after the others. */
router.post('/create', async (request, response) => {
    const name = checkName(request.body?.name);
    const view = checkView(request.body?.view);
    if (name === null) return response.status(400).send({ error: true, reason: 'invalid-name' });
    if (view === null) return response.status(400).send({ error: true, reason: 'invalid-view' });
    const created = await createSavedView(request.user.directories, { name, view });
    if (!created) return unavailable(response);
    return response.send({ id: created.id, name: created.name, view: created.view, updatedAt: created.updatedAt });
});

/** Body: `{ id, name?, view? }`. Answers the view as stored; 404 when it no longer exists. */
router.post('/change', async (request, response) => {
    const { id } = request.body ?? {};
    if (typeof id !== 'string') return response.status(400).send({ error: true, reason: 'id-required' });
    const name = request.body.name === undefined ? undefined : checkName(request.body.name);
    const view = request.body.view === undefined ? undefined : checkView(request.body.view);
    if (name === null) return response.status(400).send({ error: true, reason: 'invalid-name' });
    if (view === null) return response.status(400).send({ error: true, reason: 'invalid-view' });
    const changed = await changeSavedView(request.user.directories, id, { name, view });
    if (changed === undefined) return unavailable(response);
    if (changed === null) return response.status(404).send({ error: true, reason: 'not-found' });
    return response.send({ id: changed.id, name: changed.name, view: changed.view, updatedAt: changed.updatedAt });
});

/** Body: `{ id }`. Answers `{ deleted }`. */
router.post('/delete', async (request, response) => {
    const id = request.body?.id;
    if (typeof id !== 'string') return response.status(400).send({ error: true, reason: 'id-required' });
    const deleted = await deleteSavedView(request.user.directories, id);
    if (deleted === null) return unavailable(response);
    return response.send({ deleted });
});

/** Body: `{ id, anchor, side: 'before' | 'after' }`. Answers `{ result: 'moved' | 'unchanged' }`, or 404. */
router.post('/move', async (request, response) => {
    const { id, anchor, side } = request.body ?? {};
    if (typeof id !== 'string' || typeof anchor !== 'string' || (side !== 'before' && side !== 'after')) {
        return response.status(400).send({ error: true, reason: 'invalid-move' });
    }
    const result = await moveSavedView(request.user.directories, id, { anchor, side });
    if (result === null) return unavailable(response);
    if (result === 'missing') return response.status(404).send({ error: true, reason: 'not-found' });
    return response.send({ result });
});
