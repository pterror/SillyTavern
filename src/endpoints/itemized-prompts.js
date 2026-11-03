import express from 'express';

import { chatContext, chatNamePosition } from '../chat-request.js';
import { readTokenizerState } from '../connection-state-header.js';
import { tokenizerAnswer } from '../tokenizer-resolve.js';
import { openTokenizer } from './tokenizers-current.js';
import { importUpstreamItemizations } from '../upstream-itemizations.js';
import { requestStore } from '../user-stores.js';

export const router = express.Router();

const SET_MAX_ITEMS = 1000;
const IMPORT_MAX_CHATS = 200;

/**
 * @param {import('express').Request} request
 * @returns {Promise<{ chat: import('../chat-request.js').ChatContext, at: string | null } | 'bad' | 'missing'>}
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

router.post('/import-upstream', async function (request, response) {
    try {
        const chats = request.body?.chats;
        const state = readTokenizerState(request.body?.state);
        if (!state || !Array.isArray(chats) || chats.length > IMPORT_MAX_CHATS) return response.sendStatus(400);
        for (const c of chats) {
            if (!isPlainObject(c) || typeof c.chat_id !== 'string' || c.chat_id === '' || !Array.isArray(c.entries)) return response.sendStatus(400);
        }
        const tokenizer = await openTokenizer(state, request.user.directories);
        const counter = await tokenizer.storedCounter();
        const results = await importUpstreamItemizations(await requestStore(request), request.user.directories.root, chats, {
            count: state.api === 'openai' ? text => counter.countChatMessage([{ content: text }]) : counter.countText,
            tokenizer: () => tokenizerAnswer(state, tokenizer.resolved, tokenizer.outcome),
        });
        tokenizer.writeCounted().catch(error => console.error('Failed to store token counts:', error));
        return response.send({ results });
    } catch (error) {
        console.error('Error importing upstream itemized prompts:', error);
        return response.status(500).send({ error: true });
    }
});

router.post('/clear', async function (request, response) {
    try {
        await (await requestStore(request)).chats.clearItemizations();
        return response.sendStatus(200);
    } catch (error) {
        console.error('Error clearing prompt itemizations:', error);
        return response.status(500).send({ error: true });
    }
});
