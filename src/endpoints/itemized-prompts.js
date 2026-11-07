import express from 'express';

import { readTokenizerState } from '../connection-state-header.js';
import { tokenizerAnswer } from '../tokenizer-resolve.js';
import { openTokenizer } from './tokenizers-current.js';
import { importUpstreamItemizations } from '../upstream-itemizations.js';
import { requestStore } from '../user-stores.js';

export const router = express.Router();

const IMPORT_MAX_CHATS = 200;

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
