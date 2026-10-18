import { storedForm } from './chat-engine.js';
import { recordGenerationPersisted } from './generation-stop.js';
import { finishReply } from './reply-reasoning.js';

/**
 * The reply text in a non-streaming answer, read exactly as the page's `extractMessageFromData()`
 * (public/script.js) reads it for `api`, so the stored reply is the text the page shows.
 * @param {any} data The answer body sent to the page.
 * @param {'textgenerationwebui'|'openai'} api
 * @returns {string|null} null when no field the page reads holds text, or the page would throw on the
 * answer's shape.
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
 * For a non-streaming answer whose reply can't be read: logs the answer's keys (never its content) and
 * returns the warning the page shows.
 * @param {any} data The answer body sent to the page.
 * @param {string} key The backend, as `api|type-or-source`.
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
 * Persists a raw-action `/generate` request's ASSISTANT reply into the chat, through the request's session,
 * once the full generated text is known.
 *
 * Extracted so BOTH the non-streaming response branch (where the full text is available
 * immediately, straight from the backend's JSON body) and the streaming branches (where it's the
 * final text accumulated from a live SSE/Ollama-JSON-lines/llama.cpp-compact stream, teed
 * alongside the unmodified bytes already forwarded to the client - see text-completions.js's own
 * streaming branches and llamacpp-compact-stream.js's `pipeLlamaCppCompactStream()`) can call the
 * SAME three persistence modes instead of duplicating this branching logic a second time.
 *
 * Implements the exact same three modes established for the non-streaming case (see
 * `git show ac42ce8c9`/`92b5d9177`/`ef1f18bcb` for the full design history/rationale):
 * - `isContinue`: in-place edit of the anchor's own text (`oldText + newText`) via `editMessage()`
 *   - a continue never introduces a new node, it lengthens the existing leaf's `mes`. Requires
 *     `anchorContent` (the anchor's real, current, full stored content) because `editMessage()`
 *     replaces the WHOLE stored content, not just `.mes`.
 * - `isSwipe`: a real, tested ALTERNATIVE alongside the message being replaced - a new SIBLING
 *   under the anchor's own real parent via `addAlternatives()`, immediately made the active
 *   alternative via `selectDefaultChild()`. Covers both `type === 'swipe'` and `type ===
 *   'regenerate'` - the client's own single `is_swipe` flag doesn't distinguish the two, and
 *   neither does tree persistence.
 * - plain (neither of the above): a new CHILD after the anchor via `appendMessages()`.
 *
 * A no-op when `generatedText` is empty/falsy - mirrors the non-streaming branch's own
 * `if (generatedText)` guard, so an empty/failed/aborted-before-any-text generation never creates
 * a spurious tree entry.
 *
 * @param {object} pending
 * @param {import('./chat-request.js').ChatContext} pending.chat The chat the request acts in.
 * @param {string | null} pending.anchorNodeId The message the reply attaches to/edits/replaces - see the
 *   per-mode description above for exactly how each mode uses it (null: the tree's root).
 * @param {string} pending.name2 The responding character's display name, stored as the new
 *   message's `name`.
 * @param {boolean} pending.isSwipe
 * @param {boolean} pending.isContinue
 * @param {object|null} pending.anchorContent Required (and used) only when `isContinue` is true -
 *   the anchor's own real, current, full stored content, as loaded from the tree.
 * @param {import('./generation-stop.js').StopEntry} [pending.generationStop] The request's stop entry; told what the
 *   reply was stored as, so a stop can answer with it.
 * @param {string} generatedText The full, final generated text (raw, unprocessed backend output -
 *   not run through any client-side cleanup step, matching every other cut-over type's own
 *   already-accepted standard).
 * @param {{data?: any}} [answer] A non-streamed answer, as sent to the page: the reasoning the backend sent apart
 *   from the text is read from it (a stream notes its own, see src/reply-reasoning.js).
 * @returns {Promise<StoredReply|null>} `mes` is the node's whole stored text, `extra` the reasoning fields stored with it
 *   (the reply's reasoning is split off its text here, see `finishReply()`). `node_id` is the node the reply now lives at (the edited anchor
 *   for `isContinue`, the new alternative for `isSwipe`, the new child otherwise); callers send it to
 *   the page, which never stores a reply itself. `null` when there was no text, or when storing failed:
 *   a failure is kept on the generation for a retry and reported as a `reply-not-saved` warning (see
 *   `recordReplyNotSaved()`).
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

/**
 * @typedef {{node_id: string, mes: string, extra: ReturnType<typeof finishReply>['extra']}} StoredReply A stored reply, as
 * the page is sent it: its node, its text and the reasoning fields of its `extra`.
 */

/**
 * What the page is sent of a stored reply, alongside a non-streamed answer: `assistant_node_id`, and
 * `assistant_message` (its stored text and reasoning fields), which the page shows in place of its own copy.
 * @param {object} body The answer sent to the page.
 * @param {StoredReply|null} persisted
 */
export function attachStoredReply(body, persisted) {
    if (!persisted || !body || typeof body !== 'object') return;
    body.assistant_node_id = persisted.node_id;
    body.assistant_message = { mes: persisted.mes, extra: persisted.extra };
}

/**
 * Stores a reply whose first store failed, from the text the server kept. Same modes as
 * `persistAssistantReply()`.
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
 * The warning the page gets for a reply that was generated but couldn't be stored. It names the
 * generation, so the page can ask the server to try storing it again, and the state changes made while producing it
 * (`changes`, a variable's as `variables.<name>`), which weren't stored either.
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
 * Keeps a failed reply's text on its generation, so a retry can store it, and adds the warning to the
 * request's warnings: a non-streaming answer sends them after storing, and a stream sends this one in
 * its own frame (`takeReplyNotSaved()`).
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
 * For a stream: the not-saved warning of this reply, if storing it failed, to send in its own frame.
 * @param {object|null|undefined} pending
 * @returns {object|null}
 */
export function takeReplyNotSaved(pending) {
    return pending?.generationStop?.unsaved?.warning ?? null;
}

/**
 * For a stream: the warning that the stored reply's itemization wasn't stored, if it wasn't, to send in its own frame.
 * @param {object|null|undefined} pending
 * @returns {object|null}
 */
export function takeItemizationNotSaved(pending) {
    return pending?.itemizationNotSaved ?? null;
}

/**
 * When the reply was generated, as upstream's page stored it on every reply: ISO strings, the request's arrival
 * and the moment the text was complete. A retry keeps the first attempt's times.
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
 * Stores the reply, then the itemization of the prompt it was generated from (`pending.itemization`) at the node it
 * was stored at. An itemization that can't be stored is reported, in `pending.warnings` and to a stream through
 * `takeItemizationNotSaved()`; the reply stays stored.
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
    return result;
}

/**
 * The warning the page gets when a reply was stored but the itemization of its prompt wasn't.
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
 * The reply's `extra.api` and `extra.model` (upstream's getGeneratingApi()/getGeneratingModel()), from the settings
 * read when the generation started; the model may come from a lookup still running then.
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

/** @returns {Promise<StoredReply|{error: string}|null>} */
async function storeReply(pending, generatedText) {
    const { chat, anchorNodeId, name2, isSwipe, isContinue, anchorContent } = pending;
    if (!generatedText) {
        return null;
    }
    const { store, tree, treeSpeaker, session } = chat;

    const times = generationTimes(pending);
    const finished = finishReply(pending, generatedText, pending.answer);
    // What generated it, as upstream's saveReply() records it.
    Object.assign(finished.extra, await generatedBy(pending));
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
            tree, treeSpeaker, edits: [{ node_id: anchorNodeId, content: storedForm({ ...anchorContent, mes, title, extra, ...times }), changes: chat.replyChanges }], actor: session.actor(),
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
        tree, treeSpeaker, after, contents: [replyContent], changes: [chat.replyChanges], regenerated: isSwipe, actor: session.actor(),
    });
    if (!appended.ok || !appended.node_ids.length) {
        console.error('Failed to persist assistant reply:', appended.reason);
        return { error: String(appended.reason ?? (isSwipe ? 'the new swipe could not be written' : 'the reply could not be written')) };
    }
    return { node_id: appended.node_ids[appended.node_ids.length - 1], mes: finished.mes, extra: finished.extra };
}
