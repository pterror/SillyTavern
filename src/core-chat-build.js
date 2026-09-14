/**
 * Server-side port of the "coreChat" construction step from public/script.js's Generate()
 * (roughly lines 5564-5604 as of the port): filtering the full chat down to the messages that
 * actually participate in the prompt, then shaping each surviving message's final text/index.
 *
 * Kept as three separable pure functions - buildCoreChat() (filtering), applyMessageTitles()
 * (the attachment/media title-appending sub-piece), and finalizeCoreChatMessage() (the per-message
 * final shape) - rather than one monolithic function, because the caller needs to run the
 * (unported, see below) regex/file-attachment resolution step *between* filtering and final
 * shaping, same as the client does inside its `coreChat.map(...)` callback.
 *
 * Deliberately NOT ported here (each is a substantial separate subsystem/mechanism, not a missing
 * context value - documented so a future pass knows exactly what's missing, not guessing):
 * - `getRegexedString()` (public/scripts/extensions/regex/engine.js) - applies the user's regex
 *   scripts to a message before it enters the prompt. This module takes the ALREADY-REGEXED
 *   message text as an input param (`resolvedMessage` on finalizeCoreChatMessage) instead.
 * - `appendFileContent()` - inlines uploaded file/attachment content into a message; does real
 *   file I/O. Also folded into the `resolvedMessage` param the caller supplies - by the time text
 *   reaches finalizeCoreChatMessage() it must already be post-regex AND post-file-attachment.
 * - `ToolManager.isToolCallingSupported()` - the actual "can this API/model do tool calling"
 *   check, a substantial tool-calling subsystem. Callers of buildCoreChat() pass the already-
 *   resolved `canUseTools` boolean instead.
 * - The client's `chatItem === chat[0]` identity trick, used to decide whether to substitute in a
 *   pre-computed `substitutedFirstMessage` override in place of a message's raw `.mes`. Object-
 *   identity comparison against the original in-memory array doesn't carry over to a server port
 *   (there's no shared object identity across a JSON round-trip, and buildCoreChat() below returns
 *   a *new* filtered array to begin with). JUDGMENT CALL: replaced with an explicit
 *   `resolvedMessage` param per message on finalizeCoreChatMessage() - the caller decides, for
 *   each message, whether to resolve regex/file-attachment against the raw `.mes` or against a
 *   pre-substituted override (e.g. by comparing the message's id/position against index 0 of the
 *   ORIGINAL unfiltered chat array), and simply hands this module the finished string. This module
 *   never needs to know the override existed.
 */

/**
 * @typedef {object} CoreChatMessageExtraMedia
 * @property {string} [title]
 * @property {boolean} [append_title]
 */

/**
 * @typedef {object} CoreChatMessageExtra
 * @property {boolean} [append_title]
 * @property {string} [title]
 * @property {CoreChatMessageExtraMedia[]} [media]
 * @property {unknown[]} [tool_invocations]
 */

/**
 * @typedef {object} CoreChatMessage Shape used by this module. Mirrors the subset of the client's
 * chat message object (see public/script.js) that buildCoreChat/applyMessageTitles/
 * finalizeCoreChatMessage care about. Any other fields on a real chat message are preserved
 * as-is through finalizeCoreChatMessage()'s spread.
 * @property {boolean} [is_system]
 * @property {boolean} [is_user]
 * @property {string} [mes]
 * @property {CoreChatMessageExtra} [extra]
 */

/**
 * Mirrors the message-filtering piece of Generate() (public/script.js):
 * `chat.filter(x => !x.is_system || (canUseTools && Array.isArray(x.extra?.tool_invocations)))`
 * followed by `if (type === 'swipe') coreChat.pop()`.
 *
 * System messages are dropped unless tool-calling is in play AND the message actually carries
 * tool invocations. On a swipe, the last SURVIVING message (i.e. after filtering, not the last
 * message of the original unfiltered `chat`) is dropped - it's the message currently being
 * re-generated, not yet finalized, so it must not be part of its own context.
 *
 * @param {CoreChatMessage[]} chat The full, unfiltered chat array.
 * @param {object} options
 * @param {boolean} options.canUseTools Resolved result of ToolManager.isToolCallingSupported() (now a
 * real, ported predicate - src/chat-completion-tool-capabilities.js's isToolCallingSupported()).
 * This module is only ever called from the text-completion orchestrator (src/text-completion-
 * prompt-orchestrator.js), where mainApi is never `'openai'` - and the real predicate
 * unconditionally returns `false` in that case (verified in public/scripts/tool-calling.js) - so
 * the correct value here is always `false`; there is no case where a caller would need `true`.
 * @param {boolean} options.isSwipe Whether this is a 'swipe' generation (`type === 'swipe'` on the client).
 * @returns {CoreChatMessage[]} A new filtered array (the client's `coreChat` before its `.map()` step).
 */
export function buildCoreChat(chat, { canUseTools, isSwipe }) {
    const coreChat = chat.filter(x => !x.is_system || (canUseTools && Array.isArray(x.extra?.tool_invocations)));
    if (isSwipe) {
        coreChat.pop();
    }
    return coreChat;
}

/**
 * Mirrors the title-collection/appending sub-piece of Generate()'s per-message transform
 * (public/script.js ~5584-5597): collects `extra.title` (if `extra.append_title`) and each
 * `extra.media[].title` (if that media item's own `append_title` is set), in that order, and
 * joins them with the same `\n\n${titles.join('\n\n')}` suffix the client appends to the message.
 *
 * Pure function of a single message object - does not know about or need the already-resolved
 * message text; the caller appends this suffix to that text itself (see finalizeCoreChatMessage()).
 *
 * @param {CoreChatMessage} chatItem
 * @returns {string} The `\n\n`-prefixed titles block to append to the message, or `''` if there are no titles.
 */
export function applyMessageTitles(chatItem) {
    const titles = [];
    if (chatItem?.extra?.append_title && chatItem?.extra?.title) {
        titles.push(chatItem.extra.title);
    }
    if (Array.isArray(chatItem?.extra?.media)) {
        for (const mediaItem of chatItem.extra.media) {
            if (mediaItem?.title && mediaItem?.append_title) {
                titles.push(mediaItem.title);
            }
        }
    }
    if (titles.length > 0) {
        return `\n\n${titles.join('\n\n')}`;
    }
    return '';
}

/**
 * Mirrors the final per-message shape produced by Generate()'s `coreChat.map(...)` callback
 * (public/script.js ~5599-5603): `{...chatItem, mes: <resolved message with titles appended>, index}`.
 *
 * The caller is responsible for producing `resolvedMessage` - the message text after regex
 * scripts and file-attachment inlining have already been applied (both out of scope for this
 * module, see the module doc comment) - and for choosing `index` as the message's position in the
 * POST-FILTER coreChat array (i.e. the index buildCoreChat()'s output array would give it via
 * `Array.prototype.map`), matching the client's behavior exactly.
 *
 * @param {CoreChatMessage} chatItem
 * @param {number} index Position in the post-filter coreChat array.
 * @param {string} resolvedMessage Already regex-applied and file-attachment-resolved message text.
 * @returns {CoreChatMessage & { mes: string, index: number }}
 */
export function finalizeCoreChatMessage(chatItem, index, resolvedMessage) {
    return {
        ...chatItem,
        mes: `${resolvedMessage}${applyMessageTitles(chatItem)}`,
        index,
    };
}
