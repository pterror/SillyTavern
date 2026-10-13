import express from 'express';

import { chatContext, chatNamePosition } from '../chat-request.js';
import { requestStore } from '../user-stores.js';

/**
 * Prompt itemizations, one per stored reply (the chat engine's). The server records a reply's itemization when it
 * stores the reply; the page reads one message's when its "Prompt" view is opened. The chat-wide routes and `/set`
 * back upstream's exports (`loadItemizedPrompts`, `saveItemizedPrompts`, `replaceItemizedPromptText`,
 * `deleteItemizedPrompts`, `clearItemizedPrompts`).
 */
export const router = express.Router();

/** The most messages one `/set` changes. */
const SET_MAX_ITEMS = 1000;

/**
 * The tree the request names (`group_id`, else `avatar_url`) and the position in it its `chat` names.
 * @param {import('express').Request} request
 * @returns {Promise<{ chat: import('../chat-request.js').ChatContext, at: string | null } | 'bad' | 'missing'>} `bad`
 * when it names no tree or chat; `missing` when there is no such tree or chat.
 */
async function chatOf(request) {
    const { group_id: group, avatar_url: avatar, chat: name } = request.body ?? {};
    if ((!group && !avatar) || typeof name !== 'string' || name === '') return 'bad';
    const chat = await chatContext(request, { avatar: avatar ? String(avatar) : undefined, group: group ? String(group) : undefined });
    if (!chat) return 'missing';
    const at = await chatNamePosition(chat, name);
    return at === undefined ? 'missing' : { chat, at };
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Body `{ node_id }`. Answers `{ entry, previous_node_id }`: the message's itemization, and the nearest message above
 * it whose itemization holds the prompt as sent (null when none does). 404 when the message has no itemization.
 */
router.post('/message', async function (request, response) {
    try {
        const nodeId = request.body?.node_id;
        if (typeof nodeId !== 'string' || nodeId === '') return response.sendStatus(400);
        const found = await (await requestStore(request)).chats.readItemization({ node_id: nodeId });
        if (!found) return response.sendStatus(404);
        return response.send(found);
    } catch (error) {
        console.error('Error reading a prompt itemization:', error);
        return response.status(500).send({ error: true });
    }
});

/**
 * Body `{ avatar_url | group_id, chat, ids_only? }`. Answers `{ entries: [{ index, node_id, entry }] }`: the
 * itemizations of the chat's messages, `index` being the message's position in the chat; with `ids_only`,
 * `{ node_ids }`: the chat's messages' node ids, in order. 404 when there is no such chat.
 */
router.post('/chat', async function (request, response) {
    try {
        const found = await chatOf(request);
        if (found === 'bad') return response.sendStatus(400);
        if (found === 'missing') return response.sendStatus(404);
        const { chats } = found.chat.store;
        if (request.body.ids_only === true) {
            const ids = await chats.pathIds(found.chat.tree, found.at);
            return ids ? response.send({ node_ids: await chats.externalIds(ids) }) : response.sendStatus(404);
        }
        const entries = await chats.chatItemizations({ tree: found.chat.tree, at: found.at });
        if (!entries) return response.sendStatus(404);
        return response.send({ entries });
    } catch (error) {
        console.error('Error reading a chat\'s prompt itemizations:', error);
        return response.status(500).send({ error: true });
    }
});

/**
 * Body `{ items: [{ node_id, entry } | { node_id, fields }] }`: `entry` replaces a message's itemization, `fields`
 * changes those fields of the one it has. Writes only what changed. Answers `{ written, unchanged, missing }`, node
 * ids; `missing` holds the messages that don't exist (for `entry`) or have no itemization (for `fields`).
 */
router.post('/set', async function (request, response) {
    try {
        const items = request.body?.items;
        if (!Array.isArray(items) || items.length > SET_MAX_ITEMS) return response.sendStatus(400);
        for (const item of items) {
            const valid = isPlainObject(item) && typeof item.node_id === 'string' && item.node_id !== ''
                && (isPlainObject(item.entry) !== isPlainObject(item.fields));
            if (!valid) return response.sendStatus(400);
        }
        const { chats } = await requestStore(request);
        /** @type {{ written: string[], unchanged: string[], missing: string[] }} */
        const result = { written: [], unchanged: [], missing: [] };
        for (const item of items) {
            const outcome = isPlainObject(item.entry)
                ? await chats.recordItemization({ node_id: item.node_id, entry: item.entry })
                : await chats.updateItemizationFields({ node_id: item.node_id, fields: item.fields });
            result[outcome === 'written' ? 'written' : outcome === 'unchanged' ? 'unchanged' : 'missing'].push(item.node_id);
        }
        return response.send(result);
    } catch (error) {
        console.error('Error saving prompt itemizations:', error);
        return response.status(500).send({ error: true });
    }
});

/**
 * Body `{ avatar_url | group_id, chat }`. Removes the itemizations of the chat's messages; answers `{ removed }`.
 * 404 when there is no such chat.
 */
router.post('/delete', async function (request, response) {
    try {
        const found = await chatOf(request);
        if (found === 'bad') return response.sendStatus(400);
        if (found === 'missing') return response.sendStatus(404);
        const removed = await found.chat.store.chats.deleteChatItemizations({ tree: found.chat.tree, at: found.at });
        if (removed === null) return response.sendStatus(404);
        return response.send({ removed });
    } catch (error) {
        console.error('Error deleting a chat\'s prompt itemizations:', error);
        return response.status(500).send({ error: true });
    }
});

/** Removes every itemization. */
router.post('/clear', async function (request, response) {
    try {
        await (await requestStore(request)).chats.clearItemizations();
        return response.sendStatus(200);
    } catch (error) {
        console.error('Error clearing prompt itemizations:', error);
        return response.status(500).send({ error: true });
    }
});
