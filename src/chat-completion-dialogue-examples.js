import { Message, MessageCollection } from './chat-completion-budget.js';
import { substituteParams } from './macro-substitution.js';

/**
 * Server-side port of a slice of public/scripts/chat-completion-settings.js's
 * `populateDialogueExamples(prompts, chatCompletion, messageExamples)` (~lines 1099-1132) - the
 * smallest remaining orchestrator function in the Chat Completion (`main_api === 'openai'`)
 * prompt-assembly pipeline: it has zero `ToolManager`/media/group-chat dependency, and only reads
 * one setting (`oai_settings.new_example_chat_prompt`).
 *
 * DIFFERENCE FROM THE CLIENT, BY DESIGN: the client closes over three module-level globals -
 * `oai_settings.new_example_chat_prompt` (a setting), the ambient `substituteParams()` (a bare
 * import with no injected context), and the module-level `tokenHandler` singleton that
 * `Message.createAsync`/`.setName` implicitly use. Matching the convention established by
 * src/chat-completion-budget.js (which already had to thread an explicit `tokenHandler` through
 * `Message.createAsync`/`.setName` since there is no server-side singleton), this port takes all
 * three as explicit options: `newExampleChatPrompt` (the raw, pre-substitution setting value),
 * `macroContext` (forwarded to `substituteParams` - the already-ported `substituteParams(content,
 * context)` takes an explicit context object where the client reads ambient globals instead), and
 * `tokenHandler` (forwarded to every `Message.createAsync`/`.setName` call).
 *
 * JUDGMENT CALL - `dialogueIndex` via `.indexOf()`: the client computes
 * `const dialogueIndex = messageExamples.indexOf(dialogue);` inside a `for (const dialogue of
 * [...messageExamples])` loop - an odd idiom (index-by-value search on the original array) that
 * only works because it iterates a shallow copy of the same array, so each `dialogue` is still the
 * exact same array reference as in `messageExamples`, and `.indexOf()` (reference equality) finds
 * it correctly. This port instead uses a plain incrementing counter in a `for...of` loop with
 * `.entries()`-style indexing, which is behaviorally identical for every real input (each inner
 * array in `messageExamples` is a distinct reference - there is no known case where the same array
 * instance would appear twice in `messageExamples` and thus no case where `.indexOf()` would ever
 * return an earlier duplicate's index instead of the true position) and avoids the O(n^2)
 * re-scan-plus-reference-equality-idiom entirely. Not a behavioral divergence, just a cleaner
 * equivalent of the same idea.
 *
 * JUDGMENT CALL - `setName` called unconditionally: the client calls
 * `await chatMessage.setName(prompt.name);` unconditionally for every turn message, even when
 * `prompt.name` is falsy/undefined. Per `Message.prototype.setName`'s real behavior (ported
 * verbatim in src/chat-completion-budget.js), this sets `this.name = name` (possibly to
 * `undefined`) AND re-counts tokens via `tokenHandler.countAsync({role, content, name})` - a real,
 * observable side effect (an extra token-count call, and `getChat()`'s `...(message.name &&
 * {name: message.name})`/`...(item.name ? {name: item.name} : {})` spreads only ever add the
 * `name` field back in when it's truthy, so a falsy name is invisible in the final `getChat()`
 * output either way, but the token recount still happens and is preserved here). This port keeps
 * the call unconditional, matching the client exactly - see task instructions.
 *
 * @typedef {import('./chat-completion-budget.js').TokenHandler} TokenHandler
 * @typedef {import('./chat-completion-budget.js').ChatCompletion} ChatCompletion
 * @typedef {import('./chat-completion-prompt-collection.js').PromptCollection} PromptCollection
 *
 * @typedef {object} DialogueExamplePrompt
 * @property {string} [content] Turn content; falls back to `''` when missing (matches the client's `prompt.content || ''`).
 * @property {string} [name] Speaker name for the turn; forwarded to `Message.setName()` unconditionally, even when falsy.
 *
 * @typedef {object} PopulateDialogueExamplesOptions
 * @property {string} [newExampleChatPrompt] Raw (pre-`substituteParams`) value of the client's `oai_settings.new_example_chat_prompt` setting. This function performs the `substituteParams` step itself, matching the client.
 * @property {import('./macro-substitution.js').SubstituteParamsContext} [macroContext] Context forwarded to `substituteParams()` when resolving `newExampleChatPrompt`.
 * @property {TokenHandler} [tokenHandler] Injected token handler, forwarded to every `Message.createAsync`/`.setName` call (see module doc comment).
 */

/**
 * Server-side port of `populateDialogueExamples(prompts, chatCompletion, messageExamples)`.
 * Reserves the `'dialogueExamples'` slot in `chatCompletion` (as an empty `MessageCollection`, at
 * the position `prompts` assigned it) if and only if `prompts` has that slot at all, then fills it
 * with as many complete example-dialogue blocks (a `newExampleChat` header message followed by
 * every turn in the block) as fit the remaining token budget, in original order, stopping at the
 * first block that doesn't fit (an "all-or-nothing per block, break don't skip" gate - see task
 * instructions and module doc comment). Mutates `chatCompletion` in place; does not return
 * anything, matching the client.
 *
 * @param {PromptCollection} prompts
 * @param {ChatCompletion} chatCompletion
 * @param {DialogueExamplePrompt[][]} messageExamples Array of example-dialogue blocks; each inner array is one block's ordered turns.
 * @param {PopulateDialogueExamplesOptions} [options]
 * @returns {Promise<void>}
 */
export async function populateDialogueExamples(prompts, chatCompletion, messageExamples, { newExampleChatPrompt, macroContext, tokenHandler } = {}) {
    if (!prompts.has('dialogueExamples')) {
        return;
    }

    chatCompletion.add(new MessageCollection('dialogueExamples'), prompts.index('dialogueExamples'));

    if (Array.isArray(messageExamples) && messageExamples.length) {
        const newExampleChat = await Message.createAsync('system', substituteParams(newExampleChatPrompt, macroContext), 'newChat', tokenHandler);

        let dialogueIndex = 0;
        for (const dialogue of messageExamples) {
            const chatMessages = [];
            for (let promptIndex = 0; promptIndex < dialogue.length; promptIndex++) {
                const prompt = dialogue[promptIndex];
                const role = 'system';
                const content = prompt.content || '';
                const identifier = `dialogueExamples ${dialogueIndex}-${promptIndex}`;
                const chatMessage = await Message.createAsync(role, content, identifier, tokenHandler);
                await chatMessage.setName(prompt.name, tokenHandler);
                chatMessages.push(chatMessage);
            }

            if (!chatCompletion.canAffordAll([newExampleChat, ...chatMessages])) {
                break;
            }

            chatCompletion.insert(newExampleChat, 'dialogueExamples');
            for (const chatMessage of chatMessages) {
                chatCompletion.insert(chatMessage, 'dialogueExamples');
            }

            dialogueIndex++;
        }
    }
}
