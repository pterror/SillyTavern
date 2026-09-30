import { appendMessages, addAlternatives, selectDefaultChild, editMessage } from './message-tree-db.js';

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
 * @param {string} generatedText The full, final generated text (raw, unprocessed backend output -
 *   not run through any client-side cleanup step, matching every other cut-over type's own
 *   already-accepted standard).
 * @returns {Promise<{node_id: string}|null>} The node the reply now lives at (the edited anchor
 *   for `isContinue`, the new alternative for `isSwipe`, the new child otherwise) - callers use
 *   this to tell the client which node already holds this content, so the client's own legacy
 *   diff-save (`_saveTreeChat()`, public/script.js) can mark it clean instead of re-persisting the
 *   same reply a second time. `null` on a no-op or a failed write - callers must not tell the
 *   client anything was persisted in that case.
 */
export async function persistAssistantReply({ directories, ownerId, anchorNodeId, name2, isSwipe, isContinue, anchorContent }, generatedText) {
    if (!generatedText) {
        return null;
    }

    const replyContent = { name: name2, is_user: false, mes: generatedText, extra: {}, send_date: Date.now() };

    if (isContinue) {
        if (!anchorContent) {
            console.error('Failed to persist continue edit onto the tree: no anchor content resolved.');
            return null;
        }

        const oldText = typeof anchorContent.mes === 'string' ? anchorContent.mes : '';
        const editResult = await editMessage(directories, ownerId, anchorNodeId, { ...anchorContent, mes: oldText + generatedText });
        if (!editResult.ok) {
            console.error('Failed to persist continue edit onto the tree:', editResult.reason);
            return null;
        }
        return { node_id: anchorNodeId };
    } else if (isSwipe) {
        const addResult = await addAlternatives(directories, ownerId, anchorNodeId, [replyContent]);
        if (!addResult.ok) {
            console.error('Failed to persist swipe alternative onto the tree:', addResult.reason);
            return null;
        }
        if (addResult.node_ids?.length) {
            const selected = await selectDefaultChild(directories, addResult.node_ids[0]);
            if (!selected) {
                console.error('Failed to select the new swipe alternative as current.');
            }
            return { node_id: addResult.node_ids[0] };
        }
        return null;
    } else {
        const appendResult = await appendMessages(directories, ownerId, anchorNodeId, [replyContent]);
        if (!appendResult.ok) {
            console.error('Failed to persist assistant reply onto the tree:', appendResult.reason);
            return null;
        }
        return appendResult.node_ids?.length ? { node_id: appendResult.node_ids[appendResult.node_ids.length - 1] } : null;
    }
}
