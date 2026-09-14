import { appendMessages, addAlternatives, selectDefaultChild, editMessage } from './message-tree-db.js';

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
 * @returns {Promise<void>}
 */
export async function persistAssistantReply({ directories, ownerId, anchorNodeId, name2, isSwipe, isContinue, anchorContent }, generatedText) {
    if (!generatedText) {
        return;
    }

    const replyContent = { name: name2, is_user: false, mes: generatedText, extra: {}, send_date: Date.now() };

    if (isContinue) {
        if (!anchorContent) {
            console.error('Failed to persist continue edit onto the tree: no anchor content resolved.');
            return;
        }

        const oldText = typeof anchorContent.mes === 'string' ? anchorContent.mes : '';
        const editResult = await editMessage(directories, ownerId, anchorNodeId, { ...anchorContent, mes: oldText + generatedText });
        if (!editResult.ok) {
            console.error('Failed to persist continue edit onto the tree:', editResult.reason);
        }
    } else if (isSwipe) {
        const addResult = await addAlternatives(directories, ownerId, anchorNodeId, [replyContent]);
        if (!addResult.ok) {
            console.error('Failed to persist swipe alternative onto the tree:', addResult.reason);
        } else if (addResult.node_ids?.length) {
            const selected = await selectDefaultChild(directories, addResult.node_ids[0]);
            if (!selected) {
                console.error('Failed to select the new swipe alternative as current.');
            }
        }
    } else {
        const appendResult = await appendMessages(directories, ownerId, anchorNodeId, [replyContent]);
        if (!appendResult.ok) {
            console.error('Failed to persist assistant reply onto the tree:', appendResult.reason);
        }
    }
}
