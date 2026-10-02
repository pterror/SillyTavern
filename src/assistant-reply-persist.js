import { appendMessages, addAlternatives, selectDefaultChild, editMessage } from './message-tree-db.js';
import { recordGenerationPersisted } from './generation-stop.js';

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
 * Persists a raw-action `/generate` request's ASSISTANT reply onto the message tree, once the
 * full generated text is known.
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
 * @param {import('./users.js').UserDirectoryList} pending.directories
 * @param {string} pending.ownerId message-tree-db.js owner id.
 * @param {string} pending.anchorNodeId The node the reply attaches to/edits/replaces - see the
 *   per-mode description above for exactly how each mode uses it.
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
 * @returns {Promise<{node_id: string, mes: string}|null>} `mes` is the node's whole stored text. `node_id` is the node the reply now lives at (the edited anchor
 *   for `isContinue`, the new alternative for `isSwipe`, the new child otherwise); callers send it to
 *   the page, which never stores a reply itself. `null` when there was no text, or when storing failed:
 *   a failure is kept on the generation for a retry and reported as a `reply-not-saved` warning (see
 *   `recordReplyNotSaved()`).
 */
export async function persistAssistantReply(pending, generatedText) {
    /** @type {{node_id: string, mes: string}|{error: string}|null} */
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
 * Stores a reply whose first store failed, from the text the server kept. Same modes as
 * `persistAssistantReply()`.
 * @param {object} pending
 * @param {string} generatedText
 * @returns {Promise<{node_id: string, mes: string}|{error: string}|null>}
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
 * generation, so the page can ask the server to try storing it again.
 * @param {string} generationId
 * @param {string} reason
 * @returns {{ kind: 'reply-not-saved', key: string, generation_id: string, reason: string, message: string }}
 */
export function replyNotSavedWarning(generationId, reason) {
    return {
        kind: 'reply-not-saved',
        key: generationId,
        generation_id: generationId,
        reason,
        message: `This reply wasn't saved (${reason}). It's shown, but it will be gone after a reload unless saving it again works.`,
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
    const warning = replyNotSavedWarning(entry.id, reason);
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

/** @returns {Promise<{node_id: string, mes: string}|{error: string}|null>} */
async function persistReply(pending, generatedText) {
    const { directories, ownerId, anchorNodeId, name2, isSwipe, isContinue, anchorContent } = pending;
    if (!generatedText) {
        return null;
    }

    const times = generationTimes(pending);
    const replyContent = { name: name2, is_user: false, mes: generatedText, extra: {}, send_date: Date.now(), ...times };

    if (isContinue) {
        if (!anchorContent) {
            console.error('Failed to persist continue edit onto the tree: no anchor content resolved.');
            return { error: 'the message being continued could not be read' };
        }

        const oldText = typeof anchorContent.mes === 'string' ? anchorContent.mes : '';
        const mes = oldText + generatedText;
        const editResult = await editMessage(directories, ownerId, anchorNodeId, { ...anchorContent, mes, ...times });
        if (!editResult.ok) {
            console.error('Failed to persist continue edit onto the tree:', editResult.reason);
            return { error: String(editResult.reason ?? 'the continued message could not be written') };
        }
        return { node_id: anchorNodeId, mes };
    } else if (isSwipe) {
        const addResult = await addAlternatives(directories, ownerId, anchorNodeId, [replyContent]);
        if (!addResult.ok) {
            console.error('Failed to persist swipe alternative onto the tree:', addResult.reason);
            return { error: String(addResult.reason ?? 'the new swipe could not be written') };
        }
        if (addResult.node_ids?.length) {
            const selected = await selectDefaultChild(directories, addResult.node_ids[0]);
            if (!selected) {
                console.error('Failed to select the new swipe alternative as current.');
            }
            return { node_id: addResult.node_ids[0], mes: generatedText };
        }
        return { error: 'the new swipe could not be written' };
    } else {
        const appendResult = await appendMessages(directories, ownerId, anchorNodeId, [replyContent]);
        if (!appendResult.ok) {
            console.error('Failed to persist assistant reply onto the tree:', appendResult.reason);
            return { error: String(appendResult.reason ?? 'the reply could not be written') };
        }
        return appendResult.node_ids?.length
            ? { node_id: appendResult.node_ids[appendResult.node_ids.length - 1], mes: generatedText }
            : { error: 'the reply could not be written' };
    }
}
