import { storedForm } from './chat-engine.js';
import { recordGenerationPersisted } from './generation-stop.js';
import { finishReply } from './reply-reasoning.js';
import { storeReplyImages } from './reply-images.js';
import { mergeRecords, withSentMessage } from './world-info/activation-record.js';

/**
 * @param {any} data
 * @param {'textgenerationwebui'|'openai'} api
 * @returns {string|null}
 */
export function replyTextAsPageShows(data, api) {
    function getResult() {
        if (typeof data === 'string') {
            return data;
        }
        switch (api) {
            case 'textgenerationwebui':
                return data.choices?.[0]?.text ?? data.choices?.[0]?.message?.content ?? data.content ?? data.response ?? data[0]?.content;
            case 'openai':
                return data?.content?.filter(p => p.type === 'text')?.map(p => p.text)?.join('\n\n') ?? data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? data?.text ?? data?.message?.content?.[0]?.text ?? data?.message?.tool_plan;
            default:
                return undefined;
        }
    }
    try {
        const result = getResult();
        const text = Array.isArray(result) ? result.map(x => x.text).filter(x => x).join('') : result;
        return typeof text === 'string' ? text : null;
    } catch {
        return null;
    }
}

/**
 * @param {any} data
 * @param {string} key
 * @returns {{ kind: 'unreadable-reply', key: string, message: string }}
 */
export function unreadableReplyWarning(data, key) {
    const keys = data !== null && typeof data === 'object' ? Object.keys(data) : [];
    console.warn(`Reply not saved: the ${key} answer has no reply text where it is read. Answer keys: ${JSON.stringify(keys)}`);
    return {
        kind: 'unreadable-reply',
        key,
        message: 'The reply came back in a format SillyTavern can\'t read, so it wasn\'t saved.',
    };
}

/**
 * @param {object} pending
 * @param {import('./chat-request.js').ChatContext} pending.chat
 * @param {string | null} pending.anchorNodeId
 * @param {string} pending.name2
 * @param {boolean} pending.isSwipe
 * @param {boolean} pending.isContinue
 * @param {object|null} pending.anchorContent
 * @param {import('./generation-stop.js').StopEntry} [pending.generationStop]
 * @param {string} generatedText
 * @param {{data?: any}} [answer]
 * @returns {Promise<StoredReply|null>}
 */
export async function persistAssistantReply(pending, generatedText, answer = {}) {
    if (pending) pending.answer = answer;
    /** @type {StoredReply|{error: string}|null} */
    let result;
    try {
        result = await persistReply(pending, generatedText);
    } catch (error) {
        console.error('Failed to store the reply:', error);
        result = { error: String(error?.message ?? error) };
    }
    if (result && 'error' in result) {
        recordReplyNotSaved(pending, generatedText, result.error);
        return null;
    }
    recordGenerationPersisted(pending.generationStop, result);
    return result;
}

/** @typedef {{node_id: string, mes: string, extra: ReturnType<typeof finishReply>['extra']}} StoredReply */

/**
 * @param {object} body
 * @param {StoredReply|null} persisted
 */
export function attachStoredReply(body, persisted) {
    if (!persisted || !body || typeof body !== 'object') return;
    body.assistant_node_id = persisted.node_id;
    body.assistant_message = { mes: persisted.mes, extra: persisted.extra };
}

/**
 * @param {object} pending
 * @param {string} generatedText
 * @returns {Promise<StoredReply|{error: string}|null>}
 */
export async function retryPersistReply(pending, generatedText) {
    try {
        return await persistReply(pending, generatedText);
    } catch (error) {
        return { error: String(error?.message ?? error) };
    }
}

/**
 * @param {string} generationId
 * @param {string} reason
 * @param {import('./chat-engine.js').StateOp[]} [replyChanges]
 * @returns {{ kind: 'reply-not-saved', key: string, generation_id: string, reason: string, message: string, changes?: string[] }}
 */
export function replyNotSavedWarning(generationId, reason, replyChanges = []) {
    const changes = replyChanges.filter(op => typeof op?.key === 'string').map(op => (op.variable ? `variables.${op.key}` : op.key));
    const unsaved = changes.length ? ` The changes made while producing it weren't saved either: ${changes.join(', ')}.` : '';
    return {
        kind: 'reply-not-saved',
        key: generationId,
        generation_id: generationId,
        reason,
        message: `This reply wasn't saved (${reason}). It's shown, but it will be gone after a reload unless saving it again works.${unsaved}`,
        ...(changes.length ? { changes } : {}),
    };
}

/**
 * @param {object} pending
 * @param {string} generatedText
 * @param {string} reason
 */
function recordReplyNotSaved(pending, generatedText, reason) {
    const entry = pending.generationStop;
    if (!entry) {
        console.error(`Reply not saved and can't be retried (no generation to keep it on): ${reason}`);
        return;
    }
    const warning = replyNotSavedWarning(entry.id, reason, pending.chat?.replyChanges);
    entry.unsaved = { pending, text: generatedText, reason, warning };
    if (Array.isArray(pending.warnings)) {
        pending.warnings.push(warning);
    }
}

/**
 * @param {object|null|undefined} pending
 * @returns {object|null}
 */
export function takeReplyNotSaved(pending) {
    return pending?.generationStop?.unsaved?.warning ?? null;
}

/**
 * @param {object|null|undefined} pending
 * @returns {object|null}
 */
export function takeItemizationNotSaved(pending) {
    return pending?.itemizationNotSaved ?? null;
}

/**
 * @param {object} pending
 * @returns {{gen_started?: string, gen_finished: string}}
 */
function generationTimes(pending) {
    pending.genFinished ??= new Date().toISOString();
    const startedAt = pending.generationStop?.startedAt;
    return Number.isFinite(startedAt)
        ? { gen_started: new Date(startedAt).toISOString(), gen_finished: pending.genFinished }
        : { gen_finished: pending.genFinished };
}

/**
 * @returns {Promise<StoredReply|{error: string}|null>}
 */
async function persistReply(pending, generatedText) {
    const result = await storeReply(pending, generatedText);
    if (result && !('error' in result) && pending.itemization) {
        try {
            await pending.chat.store.chats.recordItemization({ node_id: result.node_id, entry: pending.itemization });
        } catch (error) {
            console.error('Failed to store the prompt itemization of a reply:', error);
            pending.itemizationNotSaved = itemizationNotSavedWarning(result.node_id);
            if (Array.isArray(pending.warnings)) pending.warnings.push(pending.itemizationNotSaved);
        }
    }
    if (!result || 'error' in result) return result;
    const shown = await pending.chat.store.chats.shownMessage(pending.chat.tree, result.node_id);
    return shown ? { node_id: result.node_id, mes: shown.mes, extra: shown.extra ?? {} } : result;
}

/**
 * @param {string} nodeId
 */
export function itemizationNotSavedWarning(nodeId) {
    return {
        kind: 'itemization-not-saved',
        key: nodeId,
        message: 'The reply was saved, but its prompt breakdown (the Prompt view) wasn\'t.',
    };
}

/**
 * @param {object} pending
 * @returns {Promise<{api?: string, model?: string}>}
 */
async function generatedBy(pending) {
    const finish = pending.finish;
    if (!finish) return {};
    let model = '';
    try {
        model = (await finish.model) ?? '';
    } catch (error) {
        console.warn('Could not tell which model generated the reply:', error);
    }
    return { api: finish.api, model: typeof model === 'string' ? model : String(model) };
}

/**
 * @param {object} pending
 * @returns {import('./world-info/activation-record.js').ActivationRecord | null}
 */
function activationsOf(pending) {
    const record = pending.activations;
    if (!record) return null;
    const own = typeof pending.sentNodeId === 'string' ? withSentMessage(record, pending.sentNodeId) : record;
    return pending.isContinue ? mergeRecords(pending.anchorContent?.extra?.activations, own) : own;
}

const REPLIED = Object.freeze({ key: 'tainted', value: true });

/** @returns {Promise<StoredReply|{error: string}|null>} */
async function storeReply(pending, generatedText) {
    const { chat, anchorNodeId, name2, isSwipe, isContinue, anchorContent } = pending;
    if (!generatedText) {
        return null;
    }
    const { store, tree, treeSpeaker, session } = chat;
    const changes = [...(Array.isArray(chat.replyChanges) ? chat.replyChanges : []), REPLIED];

    const times = generationTimes(pending);
    const finished = finishReply(pending, generatedText, pending.answer);
    Object.assign(finished.extra, await generatedBy(pending));
    const activations = activationsOf(pending);
    if (activations) /** @type {Record<string, unknown>} */ (finished.extra).activations = activations;
    await storeReplyImages(pending, /** @type {Record<string, unknown>} */ (finished.extra));
    const title = typeof pending.title === 'string' ? pending.title : '';
    const replyContent = { name: name2, is_user: false, mes: finished.mes, title, extra: { ...finished.extra }, send_date: Date.now(), ...times };

    if (isContinue) {
        if (!anchorContent || typeof anchorNodeId !== 'string') {
            console.error('Failed to persist continue edit: no anchor content resolved.');
            return { error: 'the message being continued could not be read' };
        }

        const mes = finished.mes;
        const extra = { ...(anchorContent.extra && typeof anchorContent.extra === 'object' ? anchorContent.extra : {}), ...finished.extra };
        const edited = await store.chats.editMessages({
            tree, treeSpeaker, edits: [{ node_id: anchorNodeId, content: storedForm({ ...anchorContent, mes, title, extra, ...times }), changes }], actor: session.actor(),
        });
        if (edited.refused.length) {
            console.error('Failed to persist continue edit:', edited.refused[0].reason);
            return { error: String(edited.refused[0].reason ?? 'the continued message could not be written') };
        }
        return { node_id: anchorNodeId, mes, extra: finished.extra };
    }
    let after = anchorNodeId;
    if (isSwipe) {
        const replaced = typeof anchorNodeId === 'string' ? await store.chats.messageOf(tree, anchorNodeId) : null;
        if (!replaced) {
            console.error('Failed to persist swipe alternative: the message being replaced is not in the chat.');
            return { error: 'the new swipe could not be written' };
        }
        after = replaced.parent === null ? null : (await store.chats.externalIds([replaced.parent]))[0];
    }
    const appended = await store.chats.appendMessages({
        tree, treeSpeaker, after, contents: [replyContent], changes: [changes], regenerated: isSwipe, actor: session.actor(),
    });
    if (!appended.ok || !appended.node_ids.length) {
        console.error('Failed to persist assistant reply:', appended.reason);
        return { error: String(appended.reason ?? (isSwipe ? 'the new swipe could not be written' : 'the reply could not be written')) };
    }
    return { node_id: appended.node_ids[appended.node_ids.length - 1], mes: finished.mes, extra: finished.extra };
}
