import { buildChatCompletionSystemPrompts } from './chat-completion-system-prompts.js';
import { getPromptCollection, preparePrompt, isPromptDisabledForCharacter } from './chat-completion-prompt-collection.js';

/**
 * Server-side port of the TAIL END of public/scripts/chat-completion-settings.js's
 * preparePromptsForChatCompletion() (~lines 1467-1513) - the part that picks up exactly where
 * src/chat-completion-system-prompts.js's buildChatCompletionSystemPrompts() left off (see that
 * module's doc comment: it "stops right before that function goes on to call
 * `promptManager.getPromptCollection(type)`").
 *
 * This module does NOT reimplement either already-ported piece - it is pure orchestration/wiring:
 * 1. Calls the REAL buildChatCompletionSystemPrompts() (src/chat-completion-system-prompts.js) to get
 *    the flat `systemPrompts` array.
 * 2. Calls the REAL getPromptCollection() (src/chat-completion-prompt-collection.js) to get the
 *    user-configured-order `PromptCollection`.
 * 3. Merges the two exactly as the client does, using the REAL `Prompt`/`PromptCollection`/
 *    `preparePrompt`/`isPromptDisabledForCharacter` exports from that same module.
 *
 * JUDGMENT CALL - `systemPrompts.forEach` mutation: the client's exact code mutates each plain-object
 *   entry of the `systemPrompts` array in place (`prompt.injection_position = ...`, etc.) before handing
 *   it to `preparePrompt`. Since `buildChatCompletionSystemPrompts()` returns a FRESH array of fresh
 *   plain objects on every call (nothing else holds a reference to them), mutating them here is safe and
 *   faithfully matches the client - this port does not defensively clone them first. Do not pass a
 *   `systemPrompts`-shaped array from elsewhere into a copy of this logic without being aware entries
 *   will be mutated.
 *
 * JUDGMENT CALL - `prompts.get(prompt.identifier)` lookup timing: this reads the PromptCollection
 *   *before* the current `systemPrompts` entry has been merged into it. For identifiers already present
 *   via the user's configured `promptOrder` (e.g. `worldInfoBefore`, `charDescription`, `main` if it's in
 *   the order), this picks up THEIR `injection_position`/`injection_depth`/`injection_order`/`role`
 *   overrides. For identifiers not in the user's order at all (e.g. `impersonate`, `groupNudge`,
 *   `quietPrompt`), `collectionPrompt` is `undefined` and no override happens - the system-prompt entry's
 *   own defaults pass through unchanged into `preparePrompt`. Ported exactly as-is.
 *
 * JUDGMENT CALL - marker replace-vs-add: `markerIndex = prompts.index(prompt.identifier)` uses the same
 *   "is this identifier already in the collection" check as the lookup above (same identifier, so same
 *   truthiness) - if a slot already exists it is REPLACED in place
 *   (`prompts.collection[markerIndex] = newPrompt`), never duplicated; otherwise it is appended via
 *   `prompts.add(newPrompt)`. Ported verbatim, including the direct `.collection[...] =` array write
 *   (rather than going through `PromptCollection.set()`) exactly as the client does.
 *
 * JUDGMENT CALL - `preparePrompt(prompt, original)` call-shape translation: the client calls the
 *   PromptManager instance method with a positional 2nd argument
 *   (`promptManager.preparePrompt(systemPrompt, mainOriginalContent)`). The already-ported
 *   `preparePrompt(prompt, { original, groupMemberNames, macroContext })` (src/chat-completion-prompt-
 *   collection.js) takes an options object instead of a positional 2nd arg, per that module's own port.
 *   Every call site below translates the client's `promptManager.preparePrompt(p)` to
 *   `preparePrompt(p, { groupMemberNames, macroContext })` and `promptManager.preparePrompt(p, original)`
 *   to `preparePrompt(p, { original, groupMemberNames, macroContext })`.
 *
 * JUDGMENT CALL - `isPromptDisabledForActiveCharacter` -> `isPromptDisabledForCharacter`: the client
 *   method reads `this.activeCharacter`/`this.serviceSettings.prompts`/`this.serviceSettings.prompt_order`
 *   off the PromptManager instance. The ported free function
 *   (`isPromptDisabledForCharacter(promptOrder, characterId, identifier)`) takes those explicitly, per
 *   this session's "caller resolves entities" convention (see src/chat-completion-prompt-collection.js's
 *   module doc comment) - called here with this function's own `promptOrder`/`characterId` parameters.
 *
 * JUDGMENT CALL - `generationType` vs `type`: the client's `preparePromptsForChatCompletion(..., type)`
 *   passes its own `type` parameter straight through as `promptManager.getPromptCollection(type)`'s
 *   `generationType` argument. This port's `type` parameter is forwarded as `getPromptCollection()`'s
 *   `generationType` field for the exact same reason.
 *
 * @typedef {import('./chat-completion-system-prompts.js').BuildChatCompletionSystemPromptsParams} BuildChatCompletionSystemPromptsParams
 * @typedef {import('./chat-completion-prompt-collection.js').RawPrompt} RawPrompt
 * @typedef {import('./chat-completion-prompt-collection.js').PromptOrderList} PromptOrderList
 * @typedef {import('./chat-completion-prompt-collection.js').PromptCollection} PromptCollection
 *
 * @typedef {object} PreparePromptsForChatCompletionParams
 * @property {string} [scenario] Forwarded to buildChatCompletionSystemPrompts().
 * @property {string} [charPersonality] Forwarded to buildChatCompletionSystemPrompts().
 * @property {string} [worldInfoBefore] Forwarded to buildChatCompletionSystemPrompts().
 * @property {string} [worldInfoAfter] Forwarded to buildChatCompletionSystemPrompts().
 * @property {string} [charDescription] Forwarded to buildChatCompletionSystemPrompts().
 * @property {string} [quietPrompt] Forwarded to buildChatCompletionSystemPrompts().
 * @property {string} [bias] Forwarded to buildChatCompletionSystemPrompts().
 * @property {Record<string, import('./chat-completion-system-prompts.js').ExtensionPromptInput>} [extensionPrompts] Forwarded to buildChatCompletionSystemPrompts().
 * @property {string} [systemPromptOverride] Character-card-specific override for the `main` prompt's content (client's `oai_settings`-adjacent `systemPromptOverride` argument).
 * @property {string} [jailbreakPromptOverride] Character-card-specific override for the `jailbreak` prompt's content.
 * @property {string} [type] Generation type, forwarded to getPromptCollection() as `generationType` (client calls this parameter `type`).
 * @property {string} [scenarioFormat] Forwarded to buildChatCompletionSystemPrompts().
 * @property {string} [personalityFormat] Forwarded to buildChatCompletionSystemPrompts().
 * @property {string} [groupNudgePrompt] Forwarded to buildChatCompletionSystemPrompts().
 * @property {string} [impersonationPrompt] Forwarded to buildChatCompletionSystemPrompts().
 * @property {string} [personaDescription] Forwarded to buildChatCompletionSystemPrompts().
 * @property {number} [personaDescriptionPosition] Forwarded to buildChatCompletionSystemPrompts().
 * @property {string} [wiFormat] Forwarded to buildChatCompletionSystemPrompts().
 * @property {import('./macro-substitution.js').SubstituteParamsContext} [macroContext] Forwarded to buildChatCompletionSystemPrompts() and to every preparePrompt() call this function makes.
 * @property {RawPrompt[]} [prompts] Forwarded to getPromptCollection() (the user's raw prompt definitions, `oai_settings.prompts`).
 * @property {PromptOrderList[]} [promptOrder] Forwarded to getPromptCollection() and isPromptDisabledForCharacter() (`oai_settings.prompt_order`).
 * @property {string|number} [characterId] Forwarded to getPromptCollection() and isPromptDisabledForCharacter().
 * @property {string[]} [groupMemberNames] Forwarded to getPromptCollection() and every preparePrompt() call this function makes.
 */

/**
 * Server-side port of public/scripts/chat-completion-settings.js's preparePromptsForChatCompletion()
 * (~lines 1467-1513 - the tail end; the systemPrompts-array construction that precedes it is
 * src/chat-completion-system-prompts.js's buildChatCompletionSystemPrompts(), called from here). See
 * this module's doc comment above for the full set of judgment calls made translating the two
 * already-ported modules' real call shapes.
 * @param {PreparePromptsForChatCompletionParams} [params]
 * @returns {PromptCollection}
 */
export function preparePromptsForChatCompletion({
    scenario,
    charPersonality,
    worldInfoBefore,
    worldInfoAfter,
    charDescription,
    quietPrompt,
    bias,
    extensionPrompts,
    systemPromptOverride,
    jailbreakPromptOverride,
    type,
    scenarioFormat,
    personalityFormat,
    groupNudgePrompt,
    impersonationPrompt,
    personaDescription,
    personaDescriptionPosition,
    wiFormat,
    macroContext = {},
    prompts: rawPrompts,
    promptOrder,
    characterId,
    groupMemberNames = [],
} = {}) {
    // This is the prompt order defined by the user's system prompts (systemPrompts.js's port).
    const systemPrompts = buildChatCompletionSystemPrompts({
        scenario,
        charPersonality,
        worldInfoBefore,
        worldInfoAfter,
        charDescription,
        quietPrompt,
        bias,
        extensionPrompts,
        scenarioFormat,
        personalityFormat,
        groupNudgePrompt,
        impersonationPrompt,
        personaDescription,
        personaDescriptionPosition,
        wiFormat,
        macroContext,
    });

    // This is the prompt order defined by the user
    const prompts = getPromptCollection({
        prompts: rawPrompts,
        promptOrder,
        characterId,
        generationType: type,
        groupMemberNames,
        macroContext,
    });

    // Merge system prompts with prompt manager prompts
    systemPrompts.forEach(prompt => {
        const collectionPrompt = prompts.get(prompt.identifier);

        // Apply system prompt role/depth overrides if they set in the prompt manager
        if (collectionPrompt) {
            prompt.injection_position = collectionPrompt.injection_position ?? prompt.injection_position;
            prompt.injection_depth = collectionPrompt.injection_depth ?? prompt.injection_depth;
            prompt.injection_order = collectionPrompt.injection_order ?? prompt.injection_order;
            prompt.role = collectionPrompt.role ?? prompt.role;
        }

        const newPrompt = preparePrompt(prompt, { groupMemberNames, macroContext });
        const markerIndex = prompts.index(prompt.identifier);

        if (-1 !== markerIndex) prompts.collection[markerIndex] = newPrompt;
        else prompts.add(newPrompt);
    });

    // Apply character-specific main prompt
    const systemPrompt = prompts.get('main') ?? null;
    const isSystemPromptDisabled = isPromptDisabledForCharacter(promptOrder, characterId, 'main');
    if (systemPromptOverride && systemPrompt && systemPrompt.forbid_overrides !== true && !isSystemPromptDisabled) {
        const mainOriginalContent = systemPrompt.content;
        systemPrompt.content = systemPromptOverride;
        const mainReplacement = preparePrompt(systemPrompt, { original: mainOriginalContent, groupMemberNames, macroContext });
        prompts.override(mainReplacement, prompts.index('main'));
    }

    // Apply character-specific jailbreak
    const jailbreakPrompt = prompts.get('jailbreak') ?? null;
    const isJailbreakPromptDisabled = isPromptDisabledForCharacter(promptOrder, characterId, 'jailbreak');
    if (jailbreakPromptOverride && jailbreakPrompt && jailbreakPrompt.forbid_overrides !== true && !isJailbreakPromptDisabled) {
        const jbOriginalContent = jailbreakPrompt.content;
        jailbreakPrompt.content = jailbreakPromptOverride;
        const jbReplacement = preparePrompt(jailbreakPrompt, { original: jbOriginalContent, groupMemberNames, macroContext });
        prompts.override(jbReplacement, prompts.index('jailbreak'));
    }

    return prompts;
}
