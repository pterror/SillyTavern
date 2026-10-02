import express from 'express';
import { generationEntryOf } from '../generation-stop.js';
import { retryPersistReply } from '../assistant-reply-persist.js';

/**
 * Tries again to store a reply whose first store failed, from the text the server kept on its
 * generation. The page never writes a generated reply itself; this is how it asks again.
 * @param {string} id
 * @param {string|undefined} handle Only the user who started the generation may retry.
 * @returns {Promise<{state: 'unknown'|'saved'|'failed', node_id?: string, mes?: string, reason?: string}>}
 */
export async function retryGenerationStore(id, handle) {
    const entry = generationEntryOf(id, handle);
    if (!entry) {
        return { state: 'unknown' };
    }
    if (entry.persisted) {
        return { state: 'saved', node_id: entry.persisted.node_id, mes: entry.persisted.mes };
    }
    if (!entry.unsaved) {
        return { state: 'unknown' };
    }
    const result = await retryPersistReply(entry.unsaved.pending, entry.unsaved.text);
    if (result && 'node_id' in result) {
        entry.persisted = result;
        entry.unsaved = null;
        return { state: 'saved', node_id: result.node_id, mes: result.mes };
    }
    const reason = result?.error ?? 'nothing to store';
    entry.unsaved.reason = reason;
    return { state: 'failed', reason };
}

export const router = express.Router();

router.post('/store/:id', async function (request, response) {
    const result = await retryGenerationStore(request.params.id, request.user?.profile?.handle);
    if (result.state === 'unknown') {
        return response.status(404).json(result);
    }
    return response.json(result);
});
