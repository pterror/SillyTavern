import express from 'express';

import { requestStore, storeRoute, treeOf } from '../user-stores.js';
import { requestSession } from '../request-session.js';

/**
 * State layer 1's actions (build path 5b): `chat_metadata` is the state at a position in a character's or group's
 * tree, each key (and each chat variable) changed on its own, every change kept and revertible.
 */
export const router = express.Router();

/** @param {unknown} v */
const position = v => (typeof v === 'string' && v !== '' ? v : null);

/**
 * `{ avatar_url | group_id, at, ops: [{ key, variable?, value? }], ref? }`: records a change per key whose value
 * differs at the message `at` (null: the tree's root); a key without `value` is removed. Answers `{ ok, changes }`,
 * the ids of the changes recorded.
 */
router.post('/change', storeRoute('changing the state', async (request, response) => {
    const store = await requestStore(request);
    const tree = await treeOf(store, request.body);
    if (tree === null) return response.status(404).send({ error: 'unknown character or group' });
    if (!Array.isArray(request.body?.ops)) return response.status(400).send({ error: 'ops must be a list' });
    const session = await requestSession(store.chats, request, tree);
    const ref = typeof request.body.ref === 'string' ? request.body.ref : null;
    const result = await store.chats.changeState({ tree, at: position(request.body.at), ops: request.body.ops, actor: session.reader(), ref });
    session.answer(response);
    if (!result.ok) return response.status(result.reason === 'unknown node' ? 404 : 400).send({ error: result.reason });
    return response.send(result);
}));

/** `{ change, ref? }`: reverts a change (or a revert, restoring what it reverted). Answers `{ ok, change }`. */
router.post('/revert', storeRoute('reverting a state change', async (request, response) => {
    const store = await requestStore(request);
    const change = request.body?.change;
    if (typeof change !== 'string') return response.status(400).send({ error: 'change must be an id' });
    const ref = typeof request.body.ref === 'string' ? request.body.ref : null;
    const result = await store.chats.revertChange({ change, actor: { user: request.user.profile.handle }, ref });
    if (!result.ok) return response.status(404).send({ error: result.reason });
    return response.send(result);
}));

/**
 * `{ avatar_url | group_id, at, if_hash? }`: the state at the message `at` (null: the tree's root) as
 * `chat_metadata`, with its hash; `{ unchanged: true }` when `if_hash` is that hash.
 */
router.post('/at', storeRoute('reading the state', async (request, response) => {
    const store = await requestStore(request);
    const tree = await treeOf(store, request.body);
    if (tree === null) return response.status(404).send({ error: 'unknown character or group' });
    const session = await requestSession(store.chats, request, tree);
    const ifHash = typeof request.body?.if_hash === 'number' ? request.body.if_hash : undefined;
    const result = await store.chats.stateAt({ tree, at: position(request.body?.at), session: session.reader().session, ifHash });
    session.answer(response);
    if (result === null) return response.status(404).send({ error: 'unknown node' });
    return response.send(result);
}));
