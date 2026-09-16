import { readSettingsAtPaths } from './settings-store.js';
import { loadBranch, getAncestorPath, getOrCreateAnchor, loadAtNode } from './message-tree-db.js';
import { readCardContent } from './endpoints/characters.js';
import { getGroupsByIds } from './endpoints/groups.js';
import { getCharacterCardFields } from './character-card-fields.js';
import { buildChatCompletionMessages, buildChatCompletionMessageExamples, character_names_behavior } from './chat-completion-messages.js';
import { TokenHandler } from './chat-completion-budget.js';
import { chat_completion_sources } from './chat-completion-tool-capabilities.js';
import { resolveWorldInfoCandidates, world_info_insertion_strategy } from './world-info/candidate-resolution.js';
import { activateWorldInfoEntries } from './world-info/activation.js';
import { bucketActivatedEntries, world_info_position } from './world-info/result-bucketing.js';
import { setExtensionPrompt, extension_prompt_types } from './extension-prompt-table.js';
import { getRegexedString, regex_placement } from './regex-scripts-engine.js';
import { getTokenizerModel, getTiktokenTokenizer } from './endpoints/tokenizers.js';
import { getBiasStrings } from './prompt-line-formatting.js';
import { appendFileAttachments } from './file-attachment-inline.js';

/**
 * Adapter/resolver layer between REAL on-disk state (settings.json - via settings-store.js's
 * sharded reader - and the message-tree chat DB - via message-tree-db.js) and
 * src/chat-completion-prepare-messages.js's `prepareOpenAIMessages(input, dryRun)`, which has so far
 * only ever been fed hand-built test fixtures. This is the direct Chat Completion
 * (`main_api === 'openai'`) analog of src/text-completion-generation-input.js's
 * `resolveTextCompletionGenerationInput()` - read that module's own doc comment first, this one
 * mirrors its conventions ("caller resolves entities", real-settings-path verification, explicit
 * documented gaps rather than silent guesses) as closely as the two pipelines' real differences allow.
 *
 * This module does NOT implement any new prompt-assembly logic - every field below is either a
 * direct (documented) read of an existing settings/chat key, a call into an already-ported real
 * helper, or a passthrough of a caller-supplied identity/runtime value. Where a real value could not
 * be confidently resolved without guessing or without pulling in a genuinely separate subsystem, that
 * field is left at a documented default/scope boundary instead (see the FIELD-MAPPING NOTES below and
 * this module's own report to the task for the full list) - never silently guessed.
 *
 * ============================================================================================
 * KEY DECISIONS (see the task's own numbered "read first" list - these are the answers)
 * ============================================================================================
 *
 * 1. CHARACTER RESOLUTION: `getCharacterCardFields()` (src/character-card-fields.js) is used here,
 *    NOT the lower-level `readCardContent`+manual-parse approach text-completion-generation-input.js
 *    uses. Reasoning: `prepareOpenAIMessages()`'s own input shape (`charDescription`/`charPersonality`/
 *    `scenario`/`systemPromptOverride`/`jailbreakPromptOverride`/`messageExamples`-source-string) is
 *    description/personality/scenario-STRING-shaped, which is EXACTLY `getCharacterCardFields()`'s own
 *    output shape (`description`/`personality`/`scenario`/`system`/`jailbreak`/`mesExamples`) -
 *    field-for-field, no translation needed. `assembleTextCompletionPrompt()`'s own inputs, by
 *    contrast, needed raw per-field access plus a `character` object to feed directly into
 *    `resolveWorldInfoCandidates()`/`activateWorldInfoEntries()`, which is why that resolver used the
 *    lower-level approach instead. This resolver still does one small extra raw card read (see
 *    `resolveCharacterName2()` below) purely to get the bare `.name` for `name2`/macro context and to
 *    decide `hasActiveCharacter` - `getCharacterCardFields()` itself has no "was there even a
 *    character" signal in its return shape (it returns a fully-populated all-empty-strings object
 *    either way), so a second small read is unavoidable without changing that module. This is a minor,
 *    deliberate double-read of the same card file, not an oversight.
 *
 * 2. `messages` SHAPE: verified by reading src/chat-completion-history.js's own `ChatHistoryMessage`
 *    typedef (`{role, content, name, ...}`) and src/chat-completion-messages.js's already-ported
 *    `buildChatCompletionMessages(chat, context)` - this is NOT the same `{is_user, mes, name, extra}`
 *    shape text-completion-generation-input.js's `chat` uses. `buildChatCompletionMessages()` is the
 *    real, already-ported client-side `setOpenAIMessages()` port, and it takes chat history in
 *    EXACTLY message-tree-db.js's own native shape (`is_user`/`mes`/`name`/`extra`) as input and
 *    converts it to the `{role, content, name, ...}` shape `populateChatHistory()` needs - so this
 *    resolver reuses message-tree-db.js's `loadBranch()`/`getAncestorPath()` and the
 *    userMessageText-append convention VERBATIM (same shape, same node_id-omission rationale) from
 *    text-completion-generation-input.js, then runs the result through `buildChatCompletionMessages()`
 *    as the one, real conversion step - not reinvented, not skipped.
 *
 * 3. TOKEN COUNTING: no already-exported, directly-reusable "count these OpenAI chat messages for
 *    real" function exists anywhere server-side - `src/endpoints/tokenizers.js`'s `/openai/count`
 *    route implements the real per-message tiktoken-counting algorithm (tokensPerMessage/tokensPerName/
 *    tokensPadding, mirroring OpenAI's own documented method) entirely INLINE in the Express route
 *    handler, with no exported standalone function wrapping it. Rather than duplicating tiktoken
 *    bootstrapping/caching logic, this module reuses that file's own EXPORTED building blocks
 *    (`getTokenizerModel(requestModel)`, `getTiktokenTokenizer(model)`) and re-implements just the
 *    per-message counting loop (a handful of lines, copied verbatim from the route) as this module's
 *    `countTokenAsyncFn` - see `createOpenAITokenCounter()` below. Non-tiktoken tokenizer families
 *    (claude/llama/mistral/etc, whatever `getTokenizerModel()` normalizes a model string to) are an
 *    explicit, documented MVP scope boundary: this resolver approximates them using the same tiktoken
 *    `'gpt-3.5-turbo'` encoding rather than wiring in every family's own dedicated
 *    sentencepiece/web-tokenizer singleton (a separate, heavier subsystem those tokenizers already
 *    have real server support for, just not stitched into one generic "count these chat-completion
 *    messages" function anywhere yet) - a caller with a real need for exact non-OpenAI-family counting
 *    can override `countTokenAsyncFn` (or supply a whole pre-built `tokenHandler`) directly.
 *
 * 4. WORLD INFO: this resolver, like text-completion-generation-input.js, resolves
 *    `worldInfoCandidates` for real via `resolveWorldInfoCandidates()` (identical field mapping - see
 *    that module's own doc comment for the full selectedWorldInfo/characterExtraBooks/chatWorldName/
 *    personaWorldLorebook/worldInfoCharacterStrategy derivation, reused here verbatim). UNLIKE the
 *    text-completion path, `prepareOpenAIMessages()` has NO internal world-info-activation step of its
 *    own - it takes already-activated, already-formatted `worldInfoBefore`/`worldInfoAfter` STRINGS as
 *    plain inputs. Because of that, this resolver (unlike text-completion-generation-input.js, which
 *    leaves activation to src/text-completion-prompt-orchestrator.js) is now itself the one place that
 *    calls `activateWorldInfoEntries()`/`bucketActivatedEntries()` for the chat-completion pipeline -
 *    there is no separate chat-completion orchestrator step to defer to. AS OF THIS TASK, this is REAL:
 *      - `resolveWorldInfoCandidates()`'s own returned entries are ALREADY decorator-parsed (see that
 *        module's `resolveWorldInfoCandidates()` body: `const [decorators, content] =
 *        parseDecorators(entry.content || ''); return { ...entry, decorators, content };` - re-verified
 *        directly in src/world-info/candidate-resolution.js). A second `parseDecorators()` pass (like
 *        the one src/text-completion-prompt-orchestrator.js runs on ITS OWN, still-raw
 *        `worldInfoCandidates` input) would be redundant and is NOT duplicated here - JUDGMENT CALL,
 *        verified by reading the source, not assumed.
 *      - `chatForWI` is built from the same tree-DB-native `chat` array already resolved above (pre-
 *        `buildChatCompletionMessages()`), reversed, one plain string per message
 *        (`${name}: ${mes}` when `worldInfoIncludeNames`, else just `mes`) - identical shape/recipe to
 *        the text-completion orchestrator's own `coreChat.map(...)`, minus `coreChat`'s own
 *        continue/swipe/tool-message filtering (not part of this resolver's `chat` array to begin
 *        with - see decision 2 above for why this module never builds a `coreChat`).
 *      - `globalScanData` reuses already-resolved values from this same function (`fields.persona`/
 *        `fields.description`/`fields.personality`/`fields.charDepthPrompt`/`fields.scenario`/
 *        `fields.creatorNotes`), plus a real `trigger` derived from `type` via the same
 *        `GENERATION_TYPE_TRIGGERS` mirror text-completion-generation-input.js's own orchestrator uses
 *        (gap 8 in that file's doc comment) - not re-guessed here, copied verbatim.
 *      - Every `activateWorldInfoEntries()` budget/depth/recursion option is read from the GLOBAL
 *        `world_info_settings` top-level settings key (NOT `oai_settings`-specific - world info's own
 *        budget/depth/recursion knobs are shared by both pipelines) using the EXACT SAME setting names
 *        and defaults text-completion-generation-input.js already established:
 *        `world_info_include_names`/`world_info_budget` (25)/`world_info_budget_cap` (0)/
 *        `world_info_depth` (2)/`world_info_recursive` (true)/`world_info_max_recursion_steps` (0)/
 *        `world_info_min_activations` (0)/`world_info_min_activations_depth_max` (0)/
 *        `world_info_use_group_scoring` (false).
 *      - `maxContext` reuses this resolver's own already-resolved `oai_settings.openai_max_context`
 *        value (same one used for `maxTokens`'s sibling field below) - no separate CFG-adjusted
 *        max-context step exists in this pipeline (CFG has no chat-completion analog - see the CFG
 *        FIELD-MAPPING NOTE below), so the plain, unadjusted value is the real one to use here.
 *      - `countTokens` (the plain `(text: string) => Promise<number>` shape `activateWorldInfoEntries()`
 *        expects - NOT `TokenHandler`'s own `(messages, full) => Promise<number>` shape) wraps this
 *        module's real, already-built `tokenHandler.countTokenAsyncFn` directly (bypassing
 *        `tokenHandler.countAsync()`'s own running-`counts`-bucket bookkeeping, which has no bucket for
 *        an ad-hoc world-info-scan text count and would otherwise pollute `counts[undefined]`) by
 *        shaping the raw text as a single-field pseudo-message (`[{ content: text }]`) - the exact
 *        shape `createOpenAITokenCounter()`'s per-message loop already knows how to walk (iterates
 *        every string-valued key). JUDGMENT CALL, not a guessed shape - re-verified directly against
 *        `createOpenAITokenCounter()`'s own loop body above.
 *      - `entryFilterContext` is populated with the real `{ trigger, characterFilename }` this resolver
 *        already has on hand (the same `charFilename` derived from `avatar` used for `characterExtraBooks`
 *        lookup above) - `characterTags` has no resolvable source in this module (would need
 *        src/character-metadata-db.js's `queryCharacters()`, the same heavier subsystem `characterId`'s
 *        own FIELD-MAPPING NOTE above already declined to depend on) and is left at its own default
 *        (`[]`, i.e. "no known tags").
 *      - `isDryRun` reuses this resolver's own `dryRun` parameter - previously accepted for interface
 *        parity only and unused (see the `dryRun` FIELD-MAPPING NOTE below, which still holds for
 *        `prepareOpenAIMessages(input, dryRun)`'s OWN separate positional argument): world-info
 *        activation's `isDryRun` option (skip sticky/cooldown/delay state mutation) is a genuine,
 *        real semantic match for "don't commit state" that `dryRun` did not have a consumer for
 *        before this task - JUDGMENT CALL: reusing the existing parameter for this new real use is more
 *        honest than adding a second, near-duplicate boolean parameter, but it does mean a caller
 *        passing `dryRun: true` now also skips real WI sticky/cooldown/delay bookkeeping, not just
 *        `prepareOpenAIMessages()`'s own dry-run behavior - flagged explicitly, not silently coupled.
 *      - Each activated entry's final content is resolved through `getRegexedString()` (regex_placement.WORLD_INFO)
 *        exactly like the text-completion orchestrator's own `bucketActivatedEntries({ resolveContent })`
 *        call - see the regex-scripts NOTE below for why this was real, straightforward reuse rather
 *        than new scope.
 *      - `worldInfoBefore`/`worldInfoAfter` on the returned object are now the REAL bucketed strings.
 *      - `worldInfoDepth` (@Depth-positioned entries) is now ALSO real, AS OF THIS FOLLOW-UP TASK: this
 *        resolver builds a real `injectionTable` (instead of a hardcoded `{}`) by calling
 *        `setExtensionPrompt(injectionTable, \`wi_depth_${depth}_${role}\`, entries.join('\n'),
 *        extension_prompt_types.IN_CHAT, depth, false, role)` once per `WIDepthEntry` returned by
 *        `bucketActivatedEntries()` - a faithful, verified port of
 *        src/text-completion-prompt-orchestrator.js's own Step 7.5 "1. World-info @Depth entries" loop
 *        (identical key format/position/depth/scan/role), just writing into THIS pipeline's own
 *        `injectionTable` instead of that orchestrator's separate `extensionPromptTable`. That table is
 *        the real mechanism `prepareOpenAIMessages()` already has for depth-indexed chat injection -
 *        it is forwarded, unchanged, through `src/chat-completion-populate.js`'s `populateChatCompletion()`
 *        into `src/chat-completion-injection-prompts.js`'s `populateInjectionPrompts()` (its `table`
 *        option), so no new orchestration was added here - only the missing write into an
 *        already-consumed input.
 *    The REMAINING, NARROWER gap (after this task): `bucketActivatedEntries()`'s other outputs -
 *    `anBefore`/`anAfter` (WI ANTop/ANBottom, meant to be combined with an Author's Note value) and
 *    `outletEntries`/`worldInfoExamples` (message-example WI-EM entries) - still have NO destination in
 *    `prepareOpenAIMessages()`'s documented input surface. `anBefore`/`anAfter` have no analog here for
 *    the same reason documented in the `additionalScanInjects` FIELD-MAPPING NOTE below (this resolver
 *    never resolves an Author's Note value or an `extensionPrompts` table entry to combine them with).
 *    `outletEntries`'s outlet-consumer mechanism and `worldInfoExamples`'s WI-EM mechanism have no home
 *    anywhere in this pipeline yet. These three fields are simply dropped on the floor for now -
 *    documented here as the precise boundary, not silently lost.
 *
 * ============================================================================================
 * FIELD-MAPPING NOTES (verified against default/content/settings.json and
 * public/scripts/chat-completion-settings.js directly, not guessed):
 * ============================================================================================
 *
 * - Most fields live under the top-level `oai_settings` key (NOT `power_user`/
 *   `textgenerationwebui_settings` like the text-completion path) - `persona_description`/
 *   `persona_description_position`/`console_log_prompts`/`pin_examples` are the exceptions, still
 *   under `power_user`, matching the client's own split.
 * - `oai_settings.prompts`/`.prompt_order` are real, present-by-default arrays (verified directly -
 *   `prompt_order` ships one entry keyed `character_id: 100000`, the client's own
 *   `configuration.promptOrder.dummyId` "no per-character order configured" sentinel).
 * - Several fields referenced by `prepareOpenAIMessages()`'s own doc comment/typedef are ABSENT from
 *   the shipped default settings.json entirely (only populated once a user actually touches the
 *   control client-side) - exactly the same pattern text-completion-generation-input.js already
 *   documented for `power_user.reasoning`/etc. Verified directly against
 *   public/scripts/chat-completion-settings.js's own settings-defaults object (~line 420-510) and
 *   mirrored here: `scenario_format` ('{{scenario}}'), `personality_format` ('{{personality}}'),
 *   `group_nudge_prompt` ('[Write the next reply only as {{char}}.]'), `names_behavior`
 *   (`character_names_behavior.DEFAULT`, `0`), `continue_prefill` (`false`), `function_calling`
 *   (`false`), `custom_prompt_post_processing` (`''`, i.e. `custom_prompt_post_processing_types.NONE`),
 *   `show_thoughts` (`true`), `tool_reasoning_mode` (`TOOL_REASONING_MODES.DISABLED`),
 *   `inline_image_quality` (`'auto'`). These four last ones
 *   (`function_calling`/`custom_prompt_post_processing`/`show_thoughts`/`tool_reasoning_mode`) are read
 *   AS-IS from `oai_settings` with NO default applied here at all, though - they're folded into the
 *   `settings` object handed to `prepareOpenAIMessages()`, which resolves `canUseTools`/etc internally
 *   (see decision 3 in src/chat-completion-prepare-messages.js's own doc comment) and already treats a
 *   missing/undefined value the same way the client's own defaulted settings object would (e.g.
 *   `!settings.function_calling` is `true` for `undefined` exactly like it would be for a real `false`)
 *   - applying a default here would be redundant, not more correct.
 * - `mainApi`: this resolver is chat-completion-only, so `mainApi` is always hardcoded to `'openai'`
 *   here regardless of the user's live top-level `main_api` setting - identical rationale to
 *   text-completion-generation-input.js's own `mainApi` hardcoding (deciding whether the *caller*
 *   should even invoke this resolver when `main_api` says otherwise is out of scope here too).
 * - `model`: resolved via a small, real, verified local port of the client's own
 *   `getChatCompletionModel(settings)` (public/scripts/chat-completion-settings.js ~line 1717) - see
 *   `getChatCompletionModel()` below. Not previously ported anywhere server-side.
 * - `modelList`: LEFT AS A CALLER-SUPPLIED OPTIONAL PARAM, not resolved here. Real model lists
 *   (OpenRouter's, etc.) are fetched over the network from the provider - resolving one as a side
 *   effect of building settings-resolution input would carry the same "this now makes a live network
 *   request" risk profile text-completion-generation-input.js's own doc comment already flagged for
 *   remote tokenizer resolution, for the identical reason. `undefined` (its own default) is a
 *   perfectly valid input to `isToolCallingSupported()`/`canPerformToolCalls()` - it just means "no
 *   model-specific override lookup available", not an error.
 * - `characterId`: JUDGMENT CALL. The client's real `character.id` is a RESIDENT, in-memory array
 *   index (`characters.findIndex(...)`) into the client's currently-loaded character list - there is
 *   no equivalent stable, on-disk-derivable value without depending on
 *   src/character-metadata-db.js's `queryCharacters()` (a genuinely separate, heavier subsystem: a
 *   SQLite-backed character index, out of scope for this resolver to depend on for a single id field).
 *   So `characterId` defaults to the PROMPT_ORDER_DUMMY_ID (`100000`, matching
 *   `PromptManager.js`'s own `configuration.promptOrder.dummyId` - the "no per-character order
 *   configured, use the global/default order" sentinel, which is also exactly what a fresh
 *   settings.json's own single `prompt_order` entry is keyed with) - the common case for a
 *   single-character chat with no character-specific prompt-manager order override. A caller that
 *   knows the real numeric id (e.g. has already resolved it via `queryCharacters()` itself) may pass
 *   an explicit `characterId` override.
 * - GROUPS: NOW REAL, AS OF THIS FOLLOW-UP TASK (previously an explicit MVP scope boundary - `groupId`
 *   accepted for interface parity only, `isGroup` hardcoded `false`, `groupMemberNames` hardcoded `[]`,
 *   `void groupId`). Real wiring, mirroring text-completion-generation-input.js's own precedent
 *   (`resolveName2AndGroupMemberNames()`/`isGroup = Boolean(groupId)`) as closely as the two
 *   pipelines' real differences allow:
 *     - `isGroup` is now `Boolean(groupId)`, real.
 *     - `groupId` is now forwarded to `getCharacterCardFields()`'s own, already-real `groupId`
 *       combined-cards support (`useGroupCards = Boolean(groupId) && Boolean(character)` -
 *       src/character-card-fields.js) - `charDescription`/`charPersonality`/`scenario`/`messageExamples`
 *       now reflect `computeGroupCards()`'s COMBINED multi-member string when both `avatar` (the
 *       specific responding member, still required for a real `character` to exist - see that
 *       module's own `useGroupCards` guard) and `groupId` are given together, exactly like the
 *       text-completion path's own equivalent already did.
 *     - `groupMemberNames` is now resolved for real by this module's own `resolveCharacterName2()`
 *       (renamed in spirit, not in export, to also resolve group members - see that function's own
 *       doc comment for the full read-and-filter rules, verified against, not guessed from,
 *       text-completion-generation-input.js's `resolveName2AndGroupMemberNames()`: real
 *       `getGroupsByIds()` + per-member `readCardContent()` reads, an unreadable member card is
 *       silently skipped rather than failing the whole resolution, no disabled-member/self-exclusion
 *       filtering is applied - `resolveName2AndGroupMemberNames()` itself applies none either, verified
 *       by reading its body, not assumed - and `name2` falls back to the group's own `.name` when no
 *       `avatar` is given). ONE real, verified shape difference from the text-completion version:
 *       here `groupMemberNames` is a plain `string[]`, not an `{name}[]` array of records - dictated by
 *       THIS pipeline's own real consumer shape (`chat-completion-prompt-collection.js`'s
 *       `getPromptCollection()`/`preparePrompt()`, used for the `{{group}}` macro's
 *       `groupMemberNames.join(', ')`, and that module's own `@param {string[]}` JSDoc) - re-verified
 *       by reading that file directly before choosing this shape, not copied blindly from the
 *       text-completion precedent.
 *     - Real `isGroup`/`groupMemberNames` now flow into every place that used to hardcode `false`/`[]`:
 *       `buildChatCompletionMessages()` (group name-prefixing per `namesBehavior`, and excluding other
 *       members' reasoning/signatures from a responding member's own turn - see that function's own
 *       `isOtherGroupMember` check, already real, just never fed a real `isGroup` before), the
 *       `buildChatCompletionMessageExamples()` call, `macroContext` (so `{{group}}`/group-aware macros
 *       resolve for real anywhere `macroContext` is consulted), and `historyOptions.isGroup` (already
 *       forwarding this module's own `isGroup` local verbatim before this task - it simply received a
 *       hardcoded `false`; now real, so `historyOptions.newGroupChatPrompt`/the real `groupNudgePrompt`
 *       injection in src/chat-completion-history.js correctly activate for a group turn). Top-level
 *       `groupMemberNames` (on the returned object, forwarded by prepareOpenAIMessages() into
 *       `preparePromptsForChatCompletion()`) is the ONE place that needed a NEW real value threaded in
 *       (previously hardcoded `[]`) - `historyOptions` itself has no separate `groupMemberNames` field
 *       to also populate (re-verified against chat-completion-history.js's own doc comment: "
 *       `groupMemberNames` is NOT threaded through here", by design, matching the client's own
 *       `populateChatHistory()` call sites), so no further wiring was needed there.
 *   The one genuinely NARROWER remaining gap, precisely re-scoped (not silently expanded into a new
 *   subsystem): character-card `depth_prompt` CHAT INJECTION
 *   (`character.data.extensions.depth_prompt`/`getGroupCharacterDepthPrompts()`, the mechanism
 *   src/text-completion-prompt-orchestrator.js's own Step 3 wires per-group-member via
 *   `setExtensionPrompt(extensionPromptTable, 'depth_prompt_${index}', ...)`) has NO analog anywhere in
 *   the chat-completion pipeline - verified by grepping `depth_prompt`/`DepthPrompt`/
 *   `getGroupCharacterDepthPrompts` across every `src/chat-completion-*.js` file: zero hits. This is
 *   NOT a group-specific gap this task introduces or narrows: `getCharacterCardFields()`'s own
 *   `charDepthPromptDepth`/`charDepthPromptRole` fields (resolved for the SINGLE-CHARACTER case too)
 *   are already left completely unconsumed by this resolver (only the plain-string `charDepthPrompt`
 *   macro value is read, for `globalScanData`/story-string-shaped uses, never as an
 *   `injectionTable`/`extensionPromptTable` entry) - i.e. chat-completion has no character
 *   depth-prompt-injection mechanism at all, for a single character OR a group. Wiring one in (for
 *   either case) would be a genuinely separate, pre-existing subsystem gap, not a small extension of
 *   this task's own group-support scope - left undone here, as a narrower, precisely-stated boundary
 *   rather than silently expanded into.
 * - MEDIA INLINING: explicit MVP SCOPE BOUNDARY (per the task's own allowed list) -
 *   `imageInlining`/`videoInlining`/`audioInlining` all resolve to `false` (their own defaults), for
 *   the identical reason src/chat-completion-history.js's own doc comment already documents: the real
 *   capability predicates (`isImageInliningSupported()`/etc.) are not ported anywhere yet.
 * - TOOL-CALLING: per the task's own instruction (re-verified against
 *   src/chat-completion-prepare-messages.js's CURRENT signature, decision 14 in that module's own doc
 *   comment) - `prepareOpenAIMessages()` now resolves `canUseTools`/`includeSignature`/
 *   `toolReasoningMode`/`includeToolReasoning`/`canPerformToolCalls` INTERNALLY given `mainApi`/
 *   `settings`/`model`/`modelList`. This resolver therefore does NOT compute any of those itself - it
 *   only supplies the four inputs those internal computations need, plus leaves every one of the
 *   `*Override` escape-hatch params at their own `undefined` default (a caller with a genuine reason to
 *   force one may still pass it through `macroExtras`).
 * - CFG: real settings-driven analog - CONFIRMED NONE. `extension_settings.cfg`
 *   (src/cfg-prompt-resolve.js's `CfgSettings`) is a text-completion-only mechanism -
 *   `public/scripts/cfg-scale.js`'s own `sendCFGGuidanceScale`-consuming call sites are all gated on
 *   `main_api !== 'openai'` (re-verified by reading that file directly: `oai_settings`/chat-completion
 *   generation never reads `extension_settings.cfg` at all). `prepareOpenAIMessages()`'s own input
 *   typedef has no CFG-shaped parameter either. So this is a real, verified "no analog exists" case,
 *   not a silent omission - nothing CFG-related is read or forwarded by this resolver.
 * - `bias`: REAL, now resolved for real via `getBiasStrings()` (src/prompt-line-formatting.js) - NOT
 *   related to `oai_settings.bias_presets`/`bias_preset_selected` (that's the logit-bias token-map
 *   mechanism, `generate_data.logit_bias`, computed by src/chat-completion-generation-data.js's
 *   `computeLogitBias()` from `biasPresetEntries` - a genuinely separate mechanism, already fully
 *   ported and unrelated to this field). `prepareOpenAIMessages()`'s `bias` param is the SAME shared
 *   prompt-bias value the text-completion path calls `userPromptBias`/`promptBias` too - both derive
 *   from the client's own `getBiasStrings(textareaText, type)` (public/script.js ~line 6926), the real
 *   client call site (public/script.js ~line 6360-6376) passing `prepareOpenAIMessages({..., bias:
 *   promptBias, ...})`. That helper is already ported server-side as this module's own imported
 *   `getBiasStrings({textareaText, type, chat, userPromptBias, macroContext})` and is already
 *   correctly used by text-completion-generation-input.js (forwarding `userPromptBias:
 *   powerUser.user_prompt_bias` as a raw param for src/text-completion-prompt-orchestrator.js to call
 *   internally) - re-verified: `prepareOpenAIMessages()` has NO internal `getBiasStrings()`/`promptBias`
 *   call of its own (zero hits grepping `getBiasStrings`/`promptBias` across every
 *   `src/chat-completion-*.js` file before this fix) - it only accepts an already-resolved, plain
 *   `bias` string, with no downstream chat-completion function to defer resolution to. So, like world-
 *   info activation (decision 4 above, for the identical "no separate orchestrator to defer to"
 *   reason), THIS resolver is the one place that calls `getBiasStrings()` for the chat-completion
 *   pipeline, using its own already-built `chat`/`macroContext` and `powerUser.user_prompt_bias`, and
 *   sets `bias` to the resulting `promptBias`. The one genuinely remaining, narrower scope boundary is
 *   `textareaText` itself (the CURRENT in-flight user-input textarea text, extracted for any inline
 *   `{{bias "..."}}` message-embedded bias) - a per-call-only value with no settings.json source,
 *   mirroring exactly how text-completion-generation-input.js's own doc comment already frames its
 *   equivalent `textareaText` gap: it defaults to `''` (falling back to the chat-history-scan / the
 *   configured `userPromptBias` per `getBiasStrings()`'s own real behavior) unless a caller supplies it.
 * - `quietPrompt`/`quietImage`/`cyclePrompt`/`extensionPrompts`: none of these have a real,
 *   single-valued settings.json/chat-metadata source of truth (they are per-generation-call options,
 *   exactly like text-completion-generation-input.js's own documented `quiet_prompt`/`generationTrigger`/
 *   etc gap list) - left at their own defaults (`undefined`/`''`/`{}`) unless a caller supplies an
 *   override via `macroExtras`. `cyclePrompt` IS accepted as an explicit resolver param (mirroring
 *   `textareaText` on the text-completion side), since `populateChatHistory()`'s continue-nudge branch
 *   needs it whenever `type === 'continue'`. `injectionTable` is the ONE exception, AS OF THIS FOLLOW-UP
 *   TASK: it is now genuinely populated with real `wi_depth_*` entries (see decision 4 above) - a
 *   caller may still override it wholesale via `macroExtras` if it has other, non-world-info injection
 *   sources to merge in.
 * - `dryRun`: accepted as a parameter originally purely for interface-signature parity with the task's
 *   documented deliverable signature; it now has ONE real effect, as of this task - it is forwarded as
 *   `activateWorldInfoEntries()`'s own `isDryRun` option (see decision 4 above for the full rationale).
 *   It still has NO effect on anything else in the returned object - `prepareOpenAIMessages(input,
 *   dryRun)`'s `dryRun` is that function's OWN second, separate positional argument (governing its
 *   early-return guard and its `squashSystemMessages` timing), fully orthogonal to building its `input`
 *   object. A caller passes it directly to `prepareOpenAIMessages()` itself, not through this resolver's
 *   return value - this resolver's own use of `dryRun` is limited to gating world-info's real sticky/
 *   cooldown/delay state mutation.
 * - REGEX SCRIPTS: real reuse, not new scope. `getRegexedString()` (src/regex-scripts-engine.js) is
 *   already a fully-ported, pure function with no chat-completion-side call site anywhere yet (verified
 *   by grepping `getRegexedString`/`regex_placement` across every `src/chat-completion-*.js` file before
 *   this task - zero hits). Wiring it into this resolver's own `bucketActivatedEntries({ resolveContent })`
 *   call (the ONE new call site this task's world-info activation work introduces) is exactly the same
 *   `regex_placement.WORLD_INFO` call src/text-completion-prompt-orchestrator.js already makes at its
 *   own equivalent call site - a straightforward additional call to an already-real function, not a new
 *   subsystem. `regexScripts` (default `[]`) and `regexExtensionEnabled` (default `true`) are new,
 *   optional resolver params added for exactly this purpose, matching
 *   `assembleTextCompletionPrompt()`'s own identical parameters' identical defaults verbatim.
 *
 * - `additionalScanInjects`: CONFIRMED NONE, left empty. src/text-completion-prompt-orchestrator.js
 *   folds the quiet-prompt text and an already-due Author's Note's value into this
 *   `activateWorldInfoEntries()` option (mirroring the client's `checkWorldInfo()` scan-buffer
 *   injection of any `scan: true` extension-prompt slot). This resolver has no real analog to fold in:
 *   it does not itself resolve `quietPrompt` (left `undefined`, a documented per-generation-call-option
 *   gap - see the `quietPrompt`/... FIELD-MAPPING NOTE above) or an Author's Note value (chat-completion's
 *   own author's-note-equivalent handling lives in src/chat-completion-system-prompts.js's
 *   `buildChatCompletionSystemPrompts()`, which reads it out of an `extensionPrompts` table entry
 *   (`'2_floating_prompt'`) this resolver also never populates - `extensionPrompts` defaults to `{}`
 *   here, per the same FIELD-MAPPING NOTE). Since neither source text is ever actually resolved BY THIS
 *   MODULE, there is nothing real to pass - not a lazy skip, a verified "the two inputs
 *   `additionalScanInjects` would need don't exist in this resolver's own scope" case, mirroring how
 *   the CFG FIELD-MAPPING NOTE above is a confirmed "no analog exists," not a guess.
 *
 * `userMessageText` behaves identically to text-completion-generation-input.js's own documented
 * UPDATE section: appended onto the resolved chat history as the newest message, in the exact
 * `{is_user, name, mes, extra, send_date}` shape every other loaded message already uses (`node_id`
 * intentionally omitted - a pending, not-yet-saved message), BEFORE `buildChatCompletionMessages()`
 * ever runs, so the appended turn flows through the exact same role/content conversion as every real
 * loaded message. Omitted for generation types that don't add a new message (e.g. 'continue'/'swipe').
 *
 * UPDATE (this session): the appended message's `extra` is `userMessageExtra` when given (still `{}`
 * otherwise) - identical mechanism/rationale to text-completion-generation-input.js's own identical
 * UPDATE. This is how a forwarded file/media attachment reference reaches the already-generic
 * `buildChatCompletionMessages()`/`inlineMediaAttachment()` machinery (src/chat-completion-messages.js,
 * src/chat-completion-history.js) that already reads `.extra.media`/`.extra.media_index` off
 * whichever chat entry it's given.
 */

/**
 * Type vocabulary reused verbatim from message-tree-db.js/character-card-fields.js rather than
 * redeclared here (see this task's own instruction to compose, not duplicate) - `Directories` is the
 * same `Pick<UserDirectoryList, 'root'>` narrowing message-tree-db.js's own exports settled on,
 * `TreeChatMessage` is that file's own native tree-row wire shape (`ChatMessage & {persona,
 * _unchanged, swipe_speaker_default}` - `ChatMessage` there being the global, client-facing
 * interface, NOT chat-completion-messages.js's/macro-substitution.js's own narrower same-named local
 * typedefs), and `SanitizedUserMessageExtra` is `sanitizeUserMessageExtra()`'s own real return shape
 * for an already-validated `userMessageExtra` (see the `userMessageExtra` FIELD-MAPPING NOTE below).
 * @typedef {import('./message-tree-db.js').Directories} Directories
 * @typedef {import('./message-tree-db.js').TreeChatMessage} TreeChatMessage
 * @typedef {import('./message-tree-db.js').SanitizedUserMessageExtra} SanitizedUserMessageExtra
 * @typedef {import('./world-info/activation.js').WIEntry} WIEntry
 * @typedef {import('./world-info/result-bucketing.js').WIActivatedEntry} WIActivatedEntry
 * @typedef {import('./world-info/result-bucketing.js').WIDepthEntry} WIDepthEntry
 * @typedef {import('./macro-substitution.js').SubstituteParamsContext} SubstituteParamsContext
 * @typedef {import('./extension-prompt-table.js').ExtensionPromptTable} ExtensionPromptTable
 */

/**
 * Loose, read-only shape of the subset of the on-disk `oai_settings` blob (src/settings-store.js)
 * this resolver actually reads - NOT the full client `ChatCompletionSettings` shape (that type lives
 * client-side in public/global.d.ts and isn't meaningfully reusable for a server-side partial read
 * via `readSettingsAtPaths()`, which only ever returns the handful of dotted paths asked for). Real
 * field list cross-checked against every `oaiSettings.<field>` read in this file.
 * @typedef {object} OaiSettingsShape
 * @property {string} [chat_completion_source]
 * @property {string} [claude_model]
 * @property {string} [openai_model]
 * @property {string} [google_model]
 * @property {string} [vertexai_model]
 * @property {string} [openrouter_model]
 * @property {string} [ai21_model]
 * @property {string} [mistralai_model]
 * @property {string} [custom_model]
 * @property {string} [cohere_model]
 * @property {string} [perplexity_model]
 * @property {string} [groq_model]
 * @property {string} [siliconflow_model]
 * @property {string} [minimax_model]
 * @property {string} [electronhub_model]
 * @property {string} [chutes_model]
 * @property {string} [nanogpt_model]
 * @property {string} [deepseek_model]
 * @property {string} [aimlapi_model]
 * @property {string} [xai_model]
 * @property {string} [pollinations_model]
 * @property {string} [cometapi_model]
 * @property {string} [moonshot_model]
 * @property {string} [fireworks_model]
 * @property {string} [azure_openai_model]
 * @property {string} [zai_model]
 * @property {string} [workers_ai_model]
 * @property {number} [names_behavior]
 * @property {string} [inline_image_quality]
 * @property {string} [wi_format]
 * @property {number} [openai_max_context]
 * @property {number} [openai_max_tokens]
 * @property {boolean} [squash_system_messages]
 * @property {string} [scenario_format]
 * @property {string} [personality_format]
 * @property {string} [group_nudge_prompt]
 * @property {string} [impersonation_prompt]
 * @property {import('./chat-completion-prompt-collection.js').RawPrompt[]} [prompts]
 * @property {import('./chat-completion-prompt-collection.js').PromptOrderList[]} [prompt_order]
 * @property {boolean} [continue_prefill]
 * @property {string} [assistant_prefill]
 * @property {string} [new_chat_prompt]
 * @property {string} [new_group_chat_prompt]
 * @property {string} [continue_nudge_prompt]
 * @property {string} [send_if_empty]
 * @property {string} [new_example_chat_prompt]
 */

/**
 * Loose, read-only shape of the subset of `power_user` this resolver reads - see the OaiSettingsShape
 * doc comment above for the same "not the full client shape, just this file's own real read surface"
 * rationale.
 * @typedef {object} PowerUserSettingsShape
 * @property {boolean} [prefer_character_prompt]
 * @property {boolean} [prefer_character_jailbreak]
 * @property {string} [persona_description]
 * @property {number} [persona_description_position]
 * @property {string} [persona_description_lorebook]
 * @property {string} [user_prompt_bias]
 * @property {boolean} [console_log_prompts]
 * @property {boolean} [pin_examples]
 * @property {string} [media_display]
 */

/**
 * Loose shape of the subset of the top-level `world_info` settings key (selection state, NOT the
 * shared `world_info_settings` budget/depth/recursion knobs - see `WorldInfoSettingsShape` below) this
 * resolver reads.
 * @typedef {object} WorldInfoSelectionShape
 * @property {string[]} [globalSelect]
 * @property {{name?: string, extraBooks?: string[]}[]} [charLore]
 */

/**
 * Loose shape of the subset of the shared (both-pipelines) `world_info_settings` budget/depth/
 * recursion settings key this resolver reads - see decision 4 in the module doc comment above for the
 * full settings-path mapping this mirrors from text-completion-generation-input.js.
 * @typedef {object} WorldInfoSettingsShape
 * @property {boolean} [world_info_include_names]
 * @property {number} [world_info_budget]
 * @property {number} [world_info_budget_cap]
 * @property {number} [world_info_depth]
 * @property {boolean} [world_info_recursive]
 * @property {number} [world_info_max_recursion_steps]
 * @property {number} [world_info_min_activations]
 * @property {number} [world_info_min_activations_depth_max]
 * @property {boolean} [world_info_use_group_scoring]
 */

/**
 * The real fields this module reads off a group JSON file (src/endpoints/groups.js's
 * `getGroupsByIds()` - that module isn't one of this task's target files, so its own return type
 * (`Record<string, object>`) stays as loose as it already is; this is the boundary-local narrowing -
 * see `resolveCharacterName2()` below for the cast site and the cross-file-mismatch note).
 * @typedef {object} GroupRecordShape
 * @property {string} [name]
 * @property {string[]} [members]
 */

/** Mirrors PromptManager.js's `configuration.promptOrder.dummyId` - see FIELD-MAPPING NOTES above. */
const PROMPT_ORDER_DUMMY_ID = 100000;

// Mirrored from public/scripts/chat-completion-settings.js's settings-defaults object (~line 420-510)
// - see FIELD-MAPPING NOTES above for exactly why these fields need a code default at all (absent from
// a freshly-generated settings.json until a user actually touches the corresponding control).
const DEFAULT_SCENARIO_FORMAT = '{{scenario}}';
const DEFAULT_PERSONALITY_FORMAT = '{{personality}}';
const DEFAULT_GROUP_NUDGE_PROMPT = '[Write the next reply only as {{char}}.]';
const DEFAULT_NAMES_BEHAVIOR = character_names_behavior.DEFAULT;
const DEFAULT_INLINE_IMAGE_QUALITY = 'auto';

// Mirrors public/scripts/constants.js's GENERATION_TYPE_TRIGGERS exactly - same mirror
// src/text-completion-prompt-orchestrator.js's own local copy uses (see decision 4 above, "real trigger
// derivation").
const GENERATION_TYPE_TRIGGERS = ['normal', 'continue', 'impersonate', 'swipe', 'regenerate'];

/** Mirrors result-bucketing.js's own (unexported) local DEFAULT_DEPTH constant - see decision 4 above. */
const WI_DEFAULT_DEPTH = 4;

// Non-tiktoken tokenizer families `getTokenizerModel()` (src/endpoints/tokenizers.js) can normalize a
// model string to - see decision 3 above for why these are approximated via tiktoken's own
// 'gpt-3.5-turbo' encoding here rather than wiring in each family's dedicated tokenizer singleton.
const NON_TIKTOKEN_TOKENIZER_FAMILIES = ['claude', 'llama3', 'llama', 'mistral', 'yi', 'deepseek', 'gemma', 'jamba', 'qwen2', 'command-r', 'command-a', 'nemo'];

/**
 * Server-side port of `getChatCompletionModel(settings)`
 * (public/scripts/chat-completion-settings.js ~line 1717) - resolves the currently-selected model
 * id/slug for whichever `chat_completion_source` is active. Not previously ported anywhere
 * server-side (see decision/FIELD-MAPPING NOTES above).
 * @param {OaiSettingsShape} settings A real `oai_settings`-shaped object.
 * @returns {string | null | undefined} `undefined` when the field for the active source was never
 * set; `null` for OpenRouter's own "no specific model, use the website default" sentinel
 * (`'OR_Website'`) - real, distinct meanings, not conflated by falling back to `''` here.
 */
export function getChatCompletionModel(settings) {
    switch (settings.chat_completion_source) {
        case chat_completion_sources.CLAUDE: return settings.claude_model;
        case chat_completion_sources.OPENAI: return settings.openai_model;
        case chat_completion_sources.MAKERSUITE: return settings.google_model;
        case chat_completion_sources.VERTEXAI: return settings.vertexai_model;
        case chat_completion_sources.OPENROUTER: return settings.openrouter_model !== 'OR_Website' ? settings.openrouter_model : null;
        case chat_completion_sources.AI21: return settings.ai21_model;
        case chat_completion_sources.MISTRALAI: return settings.mistralai_model;
        case chat_completion_sources.CUSTOM: return settings.custom_model;
        case chat_completion_sources.COHERE: return settings.cohere_model;
        case chat_completion_sources.PERPLEXITY: return settings.perplexity_model;
        case chat_completion_sources.GROQ: return settings.groq_model;
        case chat_completion_sources.SILICONFLOW: return settings.siliconflow_model;
        case chat_completion_sources.MINIMAX: return settings.minimax_model;
        case chat_completion_sources.ELECTRONHUB: return settings.electronhub_model;
        case chat_completion_sources.CHUTES: return settings.chutes_model;
        case chat_completion_sources.NANOGPT: return settings.nanogpt_model;
        case chat_completion_sources.DEEPSEEK: return settings.deepseek_model;
        case chat_completion_sources.AIMLAPI: return settings.aimlapi_model;
        case chat_completion_sources.XAI: return settings.xai_model;
        case chat_completion_sources.POLLINATIONS: return settings.pollinations_model;
        case chat_completion_sources.COMETAPI: return settings.cometapi_model;
        case chat_completion_sources.MOONSHOT: return settings.moonshot_model;
        case chat_completion_sources.FIREWORKS: return settings.fireworks_model;
        case chat_completion_sources.AZURE_OPENAI: return settings.azure_openai_model;
        case chat_completion_sources.ZAI: return settings.zai_model;
        case chat_completion_sources.WORKERS_AI: return settings.workers_ai_model;
        default: return '';
    }
}

/**
 * Real per-message OpenAI chat-completion token-counting `CountTokenAsyncFn`
 * (src/chat-completion-budget.js), reusing src/endpoints/tokenizers.js's exported
 * `getTokenizerModel()`/`getTiktokenTokenizer()` - see decision 3 above for the full rationale
 * (including the non-tiktoken-family approximation) and why no already-exported "count these
 * messages" function existed to reuse wholesale instead.
 * @param {string | null} [model] The resolved chat-completion model id/slug
 * (`getChatCompletionModel()`'s output - `string | null | undefined`, see that function's own doc
 * comment for why `null` is a real, distinct value here too).
 * @returns {import('./chat-completion-budget.js').CountTokenAsyncFn}
 */
export function createOpenAITokenCounter(model) {
    const normalizedModel = getTokenizerModel(model ?? '');
    const tiktokenModel = NON_TIKTOKEN_TOKENIZER_FAMILIES.includes(normalizedModel) ? 'gpt-3.5-turbo' : normalizedModel;
    // Mirrors src/endpoints/tokenizers.js's '/openai/count' route's own tiktoken-family branch exactly
    // (tokensPerMessage/tokensPerName/tokensPadding), the one piece of that route with no standalone
    // exported function to call instead.
    const tokensPerName = normalizedModel === 'gpt-3.5-turbo-0301' ? -1 : 1;
    const tokensPerMessage = normalizedModel === 'gpt-3.5-turbo-0301' ? 4 : 3;
    /** @type {import('./chat-completion-budget.js').CountTokenAsyncFn} */
    const countTokenAsyncFn = async function countTokenAsyncFn(messages) {
        const list = Array.isArray(messages) ? messages : [messages];
        const tokenizer = getTiktokenTokenizer(tiktokenModel);
        let numTokens = 0;
        for (const msg of list) {
            numTokens += tokensPerMessage;
            for (const [key, value] of Object.entries(msg ?? {})) {
                if (typeof value !== 'string') continue;
                numTokens += tokenizer.encode(value).length;
                if (key === 'name') numTokens += tokensPerName;
            }
        }
        numTokens += 3; // tokensPadding
        return numTokens;
    };
    return countTokenAsyncFn;
}

/**
 * Narrow, faithful port of public/script.js's `parseMesExamples(examplesStr, isInstruct)`, RESTRICTED
 * to the `main_api === 'openai'` branch (this resolver is chat-completion-only, so `isInstruct` is
 * always false and `blockHeading` is always `'<START>\n'` - the client's own ternary
 * `(main_api === 'openai' || isInstruct) ? '<START>\n' : exampleSeparator` collapses to its first
 * branch unconditionally here, so `exampleSeparator`/`power_user.context.example_separator` is never
 * consulted and is not a parameter of this function).
 * @param {string} examplesStr `getCharacterCardFields()`'s own `mesExamples` output.
 * @returns {string[]} One raw example-block string per `<START>`-delimited block, ready for
 * `buildChatCompletionMessageExamples()`.
 */
export function parseMesExamplesForChatCompletion(examplesStr) {
    if (!examplesStr || examplesStr.length === 0 || examplesStr === '<START>') {
        return [];
    }
    if (!examplesStr.startsWith('<START>')) {
        examplesStr = '<START>\n' + examplesStr.trim();
    }
    return examplesStr.split(/<START>/gi).slice(1).map(block => `<START>\n${block.trim()}\n`);
}

/**
 * Loads a character card's bare display name/raw-existence signal (`name2`/`hasCharacter`), AND - AS
 * OF THIS TASK - real group member display names, when `groupId` is given. This is the direct
 * chat-completion analog of text-completion-generation-input.js's own
 * `resolveName2AndGroupMemberNames()` - same real reads (`readCardContent`/`getGroupsByIds`), same
 * tolerate-a-missing/unreadable-card stance, same "no `avatar` -> fall back to the group's own name
 * for `name2`" rule, same "skip an unreadable member card, don't fail the whole resolution" rule, and
 * deliberately NO disabled-member/self-exclusion filtering (verified directly against that function's
 * own body - it applies neither), replicated here rather than invented.
 *
 * ONE real shape difference from the text-completion version, verified against this pipeline's own
 * real consumers before writing this: `groupMemberNames` here is a plain `string[]` (bare display
 * names), NOT an `{name}[]` array of records. text-completion's `groupMemberNames` shape is dictated
 * by src/stopping-strings.js's `getStoppingStrings({groupMemberNames})`, which reads `.name` off each
 * entry - but chat-completion's OWN real consumer of this field,
 * src/chat-completion-prompt-collection.js's `getPromptCollection()`/`preparePrompt()` (used for the
 * `{{group}}` macro's `groupMemberNames.join(', ')`), and its own JSDoc (`@param {string[]}
 * [options.groupMemberNames]`), both expect bare strings - confirmed by reading both files' real
 * signatures before choosing this shape, not guessed.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {object} params
 * @param {string} [params.avatar]
 * @param {string} [params.groupId]
 * @returns {Promise<{ name2: string, groupMemberNames: string[], hasCharacter: boolean }>}
 */
async function resolveCharacterName2(directories, { avatar, groupId } = {}) {
    let name2 = '';
    let hasCharacter = false;

    if (avatar != null) {
        try {
            const raw = await readCardContent(directories, avatar);
            if (raw !== undefined) {
                const character = JSON.parse(raw);
                name2 = character?.name || character?.data?.name || '';
                hasCharacter = true;
            }
        } catch { /* leave name2 as '', hasCharacter false - matches text-completion's own fallback */ }
    }

    /** @type {string[]} */
    const groupMemberNames = [];
    if (groupId != null) {
        // getGroupsByIds() (src/endpoints/groups.js, not a target file) declares its return as the
        // loose `Record<string, object>` its own module doc comment settled on - narrowed here to the
        // real, on-disk `Group` fields this function actually reads. Cross-file boundary, not a guess:
        // `name`/`members` are real `Group` (public/global.d.ts) properties.
        const group = /** @type {GroupRecordShape | undefined} */ (getGroupsByIds(directories, [groupId])[groupId]);
        if (group) {
            if (avatar == null && group.name != null && group.name !== '') {
                name2 = group.name;
            }
            const members = Array.isArray(group.members) ? group.members : [];
            for (const memberAvatar of members) {
                try {
                    const raw = await readCardContent(directories, memberAvatar);
                    if (raw === undefined) continue;
                    const card = JSON.parse(raw);
                    const memberName = card?.name || card?.data?.name;
                    if (memberName) groupMemberNames.push(memberName);
                } catch { /* skip unreadable member card - matches text-completion's own stance */ }
            }
        }
    }

    return { name2, groupMemberNames, hasCharacter };
}

/**
 * Resolves the real chat history for `prepareOpenAIMessages()`'s `messages` input - identical
 * ownerId/branchName/nodeId resolution strategy as text-completion-generation-input.js's own private
 * `resolveChatHistory()` (not exported there, so mirrored here rather than imported - see this
 * module's own doc comment decision 2). Returns the tree-DB's NATIVE `{is_user, mes, name, extra}`
 * shape - conversion to `{role, content}` happens later, via `buildChatCompletionMessages()`.
 *
 * When NEITHER `branchName` nor `nodeId` is given (and `ownerId` is), this does NOT silently guess
 * "whatever the tree's current default leaf happens to be" once real messages already exist -
 * `node_id` is a genuine, non-fabricated fact the client already has for any turn that isn't the
 * very first ("the node I was actually looking at/replying to"), and resolving to a stale leaf
 * behind the caller's back would risk a real lost-update race if the tree moved since the caller
 * last loaded it. The ONLY identifier-free case that is genuinely safe is a brand-new owner with NO
 * prior real messages at all, resolved via the owner's anchor (`getOrCreateAnchor()`/`loadAtNode()`,
 * no name required) ONLY when that anchor's default-child chain is genuinely empty. When the anchor
 * already has a real chain but neither identifier was given, `ambiguous: true` is returned instead -
 * the caller (`buildRawActionChatCompletionRequest()`) turns that into a real, reportable error.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {object} params
 * @param {string} [params.ownerId]
 * @param {string} [params.branchName]
 * @param {string | null} [params.nodeId]
 * @returns {Promise<{ chat: TreeChatMessage[], metadata: ChatMetadata, resolvedNodeId: string | null, ambiguous?: boolean }>}
 */
async function resolveChatHistory(directories, { ownerId, branchName, nodeId }) {
    if (ownerId != null && branchName != null) {
        const result = await loadBranch(directories, ownerId, branchName);
        if (result) {
            return { chat: result.messages, metadata: result.metadata, resolvedNodeId: result.branch.leaf_id };
        }
    }
    if (nodeId != null) {
        const messages = await getAncestorPath(directories, nodeId);
        if (messages) {
            return { chat: messages, metadata: {}, resolvedNodeId: nodeId };
        }
    }
    if (ownerId != null && branchName == null && nodeId == null) {
        const anchorId = await getOrCreateAnchor(directories, ownerId);
        if (anchorId != null) {
            const result = await loadAtNode(directories, ownerId, anchorId);
            if (result && result.messages.length > 0) {
                return { chat: [], metadata: {}, resolvedNodeId: null, ambiguous: true };
            }
            if (result) {
                return { chat: result.messages, metadata: result.metadata, resolvedNodeId: result.node_id };
            }
        }
    }
    return { chat: [], metadata: {}, resolvedNodeId: null };
}

/**
 * Resolves the real `prepareOpenAIMessages(input)` input object from on-disk settings.json (via
 * src/settings-store.js) and the real message-tree chat DB (via src/message-tree-db.js).
 *
 * See this module's doc comment above for the full list of field-mapping decisions and documented
 * MVP scope boundaries (groups, media inlining, `modelList`, `characterId`). `macroExtras`, when
 * given, is shallow-merged OVER the resolved object (caller overrides win) - use it to supply any of
 * `prepareOpenAIMessages()`'s other optional fields this resolver leaves at a default (e.g.
 * `quietPrompt`, any of the tool-capability `*Override` escape hatches).
 *
 * `worldInfoCandidates` (the real, auto-resolved candidate list - see decision 4 above) is returned as
 * an EXTRA field on top of `prepareOpenAIMessages()`'s own documented input surface, for a future
 * caller to run world-info activation on.
 *
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {object} [params]
 * @param {string} [params.avatar] Character avatar filename.
 * @param {string} [params.groupId] Group id - NOW REAL, see doc comment GROUPS section. Combined with
 * `avatar` (the specific responding member), drives real combined-card resolution, `isGroup`, and
 * `groupMemberNames`.
 * @param {string} [params.ownerId] message-tree-db.js owner id for chat resolution.
 * @param {string} [params.branchName] message-tree-db.js labeled chat name. LEGACY input, kept only
 * for callers outside this task's scope (src/endpoints/backends/kobold.js, src/endpoints/novelai.js)
 * that still address chats by label - NOT part of the raw-action addressing model this task
 * corrected (see `resolveChatHistory()`'s own doc comment); a new caller should use `nodeId` instead.
 * @param {string|null} [params.nodeId] Resolve history up to this tree node. `null` (as opposed to
 * omitted) resolves via the owner's anchor - see `resolveChatHistory()`'s own doc comment for the
 * "only safe when genuinely empty" rule and how a non-empty case is signalled back
 * (`resolvedNodeId`/`chatResolutionAmbiguous` on this function's own return object).
 * @param {string} [params.type] Generation type ('normal'/'impersonate'/'continue'/'swipe'/...).
 * @param {boolean} [params.isImpersonate]
 * @param {boolean} [params.isContinue]
 * @param {boolean} [params.isSwipe]
 * @param {boolean} [params.dryRun] Accepted for interface-signature parity only - see doc comment.
 * @param {string} [params.cyclePrompt] In-flight user input for a `'continue'` generation - forwarded
 * into `historyOptions.cyclePrompt` and top-level `cyclePrompt`.
 * @param {string} [params.textareaText] Current user input textarea text, for bias-string resolution
 * (see the `bias` FIELD-MAPPING NOTE above) - mirrors text-completion-generation-input.js's own
 * equivalent param name/default exactly.
 * @param {ChatMetadata} [params.chatMetadata] Overrides the loaded branch's own metadata when given.
 * @param {string} [params.userMessageText] The raw user action for this turn - see doc comment.
 * @param {SanitizedUserMessageExtra} [params.userMessageExtra] Already-SERVER-VALIDATED `extra` for
 * the newly-appended user message (see `sanitizeUserMessageExtra()` in message-tree-db.js) - identical
 * contract to text-completion-generation-input.js's own equivalent param: a forwarded file/media
 * attachment REFERENCE, trusted verbatim here (the caller already ran it through the allowlist),
 * ignored when `userMessageText` is omitted.
 * @param {WIEntry[]} [params.worldInfoCandidates] Explicit
 * override/bypass for the auto-resolved candidates - when omitted, this resolver calls
 * `resolveWorldInfoCandidates()` for real; passing an explicit array (including `[]`) always wins.
 * Either way, this resolver now also ACTIVATES the resulting candidates for real - see doc comment
 * decision 4.
 * @param {import('./regex-scripts-engine.js').RegexScript[]} [params.regexScripts] Forwarded to every
 * `getRegexedString()` call this resolver makes (currently just the world-info WORLD_INFO placement -
 * see doc comment decision 4 / the REGEX SCRIPTS FIELD-MAPPING NOTE). Default `[]`.
 * @param {boolean} [params.regexExtensionEnabled] Forwarded to the same `getRegexedString()` calls. Default `true`.
 * @param {string} [params.model] Overrides the real `getChatCompletionModel()` resolution when given.
 * @param {import('./chat-completion-tool-capabilities.js').ChatCompletionToolCapabilityModel[]} [params.modelList] See doc comment - not resolved here, caller-supplied only.
 * @param {string|number} [params.characterId] Overrides the PROMPT_ORDER_DUMMY_ID default - see doc comment.
 * @param {import('./chat-completion-budget.js').CountTokenAsyncFn} [params.countTokenAsyncFn] Overrides the real, internally-resolved OpenAI token counter.
 * @param {import('./chat-completion-budget.js').TokenHandler} [params.tokenHandler] Overrides the whole internally-constructed `TokenHandler`.
 * @param {object} [params.macroExtras] Shallow-merged over the resolved input object.
 * @returns {Promise<import('./chat-completion-prepare-messages.js').PrepareOpenAIMessagesInput & { worldInfoCandidates: WIEntry[] }>}
 */
export async function resolveChatCompletionGenerationInput(directories, {
    avatar, groupId, ownerId, branchName, nodeId,
    type, isImpersonate = false, isContinue = false, isSwipe = false, dryRun,
    cyclePrompt = '', textareaText = '', chatMetadata: chatMetadataOverride, userMessageText, userMessageExtra,
    worldInfoCandidates: worldInfoCandidatesOverride,
    regexScripts = [], regexExtensionEnabled = true,
    model: modelOverride, modelList, characterId = PROMPT_ORDER_DUMMY_ID,
    countTokenAsyncFn: countTokenAsyncFnOverride, tokenHandler: tokenHandlerOverride,
    macroExtras = {},
} = {}) {
    void isImpersonate; void isContinue; // Folded into `type` by the caller; kept as documented params for parity with the task's signature, matching text-completion-generation-input.js's own equivalents (which are likewise not separately re-derived from `type` there either).
    // `isSwipe` IS read (see `promptChat` below) - unlike isImpersonate/isContinue, it drives real
    // behavior here: dropping the message being swiped/regenerated from the context this resolver
    // builds. Not folded into `type` alone because the caller's own `is_swipe` boolean already
    // captures BOTH 'swipe' and 'regenerate' (see public/script.js's `isSwipe` local and the read-first
    // analysis in this session's task write-up), and re-deriving that from `type` here would duplicate
    // that decision in a second place.

    // readSettingsAtPaths() (src/settings-store.js, not a target file) declares its return as
    // `Record<string, unknown>` - it's a generic dotted-path reader with no static knowledge of any
    // individual settings key's real shape. Narrowed here to this module's own real read surface
    // (OaiSettingsShape/PowerUserSettingsShape/etc. above), the boundary-local cast this task's own
    // instructions call for.
    const {
        oai_settings: oaiSettings = /** @type {OaiSettingsShape} */ ({}),
        power_user: powerUser = /** @type {PowerUserSettingsShape} */ ({}),
        world_info: worldInfoSelection = /** @type {WorldInfoSelectionShape} */ ({}),
        world_info_settings: worldInfoSettings = /** @type {WorldInfoSettingsShape} */ ({}),
        world_info_character_strategy: worldInfoCharacterStrategySetting,
        username,
    } = /** @type {{
        oai_settings?: OaiSettingsShape,
        power_user?: PowerUserSettingsShape,
        world_info?: WorldInfoSelectionShape,
        world_info_settings?: WorldInfoSettingsShape,
        world_info_character_strategy?: number,
        username?: string,
    }} */ (readSettingsAtPaths(directories, [
            'oai_settings', 'power_user', 'world_info', 'world_info_settings', 'world_info_character_strategy', 'username',
        ]));

    const isGroup = Boolean(groupId);

    const { chat: loadedChat, metadata: loadedChatMetadata, resolvedNodeId, ambiguous: chatResolutionAmbiguous } =
        await resolveChatHistory(directories, { ownerId, branchName, nodeId });
    const chatMetadata = chatMetadataOverride ?? loadedChatMetadata;

    const { name2, groupMemberNames, hasCharacter } = await resolveCharacterName2(directories, { avatar, groupId });
    const name1 = (username != null && username !== '') ? username : 'User';

    // Appends the pending user action onto the loaded history, in the exact tree-DB-native shape
    // every other loaded message already uses (identical rationale/shape to
    // text-completion-generation-input.js's own UPDATE section) - BEFORE conversion via
    // buildChatCompletionMessages(), so it goes through the exact same role/content mapping as a real
    // loaded message. Kept RAW (the swiped/regenerated message, when there is one, still present as
    // the last entry) - this is the shape getBiasStrings() below expects (it does its own
    // last-entry skip for 'swipe'/'regenerate' - see that function's own doc comment for why).
    // CROSS-FILE MISMATCH (confirms the parallel investigation's finding, see task instructions):
    // `sanitizeUserMessageExtra()`'s real return shape (`SanitizedUserMessageExtra`, message-tree-db.js)
    // is narrower than the global `ChatMessageExtra` slot it's stored into here - e.g. its
    // `files[].size` is optional where the global `FileAttachment.size` is required. The value is
    // already server-validated (this resolver's own contract, see the `userMessageExtra` param doc
    // above), so it's cast at this one boundary rather than widening `SanitizedUserMessageExtra` itself
    // (not this file's type to own) or fixing message-tree-db.js (not in this task's scope).
    /** @type {TreeChatMessage[]} */
    const chat = typeof userMessageText === 'string'
        ? [...loadedChat, { is_user: true, name: name1, mes: userMessageText, extra: /** @type {ChatMessageExtra} */ (userMessageExtra && typeof userMessageExtra === 'object' ? userMessageExtra : {}), send_date: Date.now() }]
        : loadedChat;

    // Drops the message currently being swiped/regenerated from the context actually used to BUILD
    // the generation (the outgoing `messages` array, world-info scanning, and macro substitution) -
    // this pipeline's analog of src/core-chat-build.js's `buildCoreChat({isSwipe})` pop (that helper is
    // text-completion-orchestrator-specific; this resolver never builds a `coreChat` at all - see doc
    // comment decision 2 - so the pop is done inline here instead). `chat` itself (above) stays RAW for
    // getBiasStrings(), which needs the un-dropped array (see that function's own doc comment).
    // Real, verified gap this closes: before this, `isSwipe` was accepted but never read (see the
    // `void isSwipe` a few lines below in the original version of this function) - a swipe/regenerate
    // routed through this pipeline would have fed the model its OWN about-to-be-replaced reply as the
    // newest turn of its own context, instead of excluding it like the text-completion pipeline
    // already correctly does.
    const promptChatBeforeFileInline = isSwipe && chat.length ? chat.slice(0, -1) : chat;

    // File-attachment inlining (closes a real, documented gap - see file-attachment-inline.js's own
    // module doc comment and this task's own investigation): reuses the SAME
    // `appendFileAttachments()` function text-completion-prompt-orchestrator.js already wires into
    // its own per-message finalization step, here at the one point in the chat-completion pipeline
    // that still has each message's raw `.extra` available (BEFORE `buildChatCompletionMessages()`
    // converts the array to `{role, content}` and drops everything else). Runs over `promptChat` -
    // i.e. tree-loaded history AND the just-appended in-memory turn alike (the turn built from
    // `userMessageText`/`userMessageExtra` above is already part of `chat`/`promptChat` by this
    // point) - matching how `.media` inlining already reaches that same freshly-injected turn via
    // the very same array. `promptChat` is reassigned so every downstream consumer (world-info
    // scanning's `chatForWI`, `macroContext.chat`, and `buildChatCompletionMessages()` itself) sees
    // the file-inlined text, mirroring how text-completion's own `coreChat` is mutated once, early,
    // before any of ITS downstream consumers run.
    /** @type {TreeChatMessage[]} */
    const promptChat = await Promise.all(promptChatBeforeFileInline.map(async (msg) => ({
        ...msg,
        mes: await appendFileAttachments(msg.extra ?? null, msg.mes ?? '', { directories }),
    })));

    const fields = await getCharacterCardFields(directories, {
        avatar,
        groupId,
        preferCharacterPrompt: Boolean(powerUser.prefer_character_prompt),
        preferCharacterJailbreak: Boolean(powerUser.prefer_character_jailbreak),
        personaDescription: powerUser.persona_description,
        chatMetadata,
    });

    // Real world-info CANDIDATE resolution - see doc comment decision 4 for the full real ACTIVATION
    // (worldInfoBefore/worldInfoAfter strings) this resolver now also performs, further below, once
    // `macroContext`/`tokenHandler` are available.
    // METADATA_KEY mirrored inline, same rationale as text-completion-generation-input.js's own copy.
    const WORLD_INFO_METADATA_KEY = 'world_info';
    // Hoisted out of the `if` below so entryFilterContext (used by activation further down) can reuse
    // the same real, already-derived value instead of recomputing it - see decision 4 above.
    const charFilename = avatar != null ? avatar.replace(/\.[^/.]+$/, '') : null;
    let worldInfoCandidates = worldInfoCandidatesOverride;
    if (worldInfoCandidates === undefined) {
        const charLore = Array.isArray(worldInfoSelection.charLore) ? worldInfoSelection.charLore : [];
        const characterExtraBooks = charLore.find(e => e.name === charFilename)?.extraBooks ?? [];
        let character = null;
        if (avatar != null) {
            try {
                const raw = await readCardContent(directories, avatar);
                if (raw !== undefined) character = JSON.parse(raw);
            } catch { /* leave character null - candidate resolution tolerates this */ }
        }
        // resolveWorldInfoCandidates() (src/world-info/candidate-resolution.js, not a target file)
        // declares its return as `Promise<Array<object>>` - looser than reality: its entries are real
        // on-disk lorebook entries, i.e. genuinely `WIEntry`-shaped. Boundary cast, not a guess.
        worldInfoCandidates = /** @type {WIEntry[]} */ (await resolveWorldInfoCandidates({
            directories,
            selectedWorldInfo: worldInfoSelection.globalSelect ?? [],
            character,
            characterExtraBooks,
            chatWorldName: /** @type {string | null} */ (chatMetadata[WORLD_INFO_METADATA_KEY] ?? null),
            personaWorldLorebook: powerUser.persona_description_lorebook ?? null,
            worldInfoCharacterStrategy: worldInfoCharacterStrategySetting ?? world_info_insertion_strategy.character_first,
        }));
    }

    // getChatCompletionModel() returns `string | null | undefined` (see that function's own doc
    // comment - `null` is OpenRouter's real "use website default" sentinel). `model` therefore stays
    // `string | null` here; every downstream slot that requires a plain `string` (`macroContext.model`,
    // `BuildChatCompletionMessagesContext.currentModel`, `resolved.model`) narrows with `model ?? undefined`
    // at its own use site rather than collapsing this real distinction early.
    const model = modelOverride ?? getChatCompletionModel(oaiSettings);
    const namesBehavior = oaiSettings.names_behavior ?? DEFAULT_NAMES_BEHAVIOR;
    const imageQuality = oaiSettings.inline_image_quality ?? DEFAULT_INLINE_IMAGE_QUALITY;

    // CROSS-FILE MISMATCH: chat-completion-messages.js declares its OWN local `ChatMessage`/
    // `ChatMessageExtra` typedefs (this module's `TreeChatMessage` is layered over the global,
    // client-facing `ChatMessage` instead - see this file's own type-vocabulary doc comment above) and
    // its `.extra.media` is narrower (`string[]`) than the global `ChatMessageExtra.media`
    // (`MediaAttachment[]`) it actually receives real tree-loaded messages from. Neither file is a
    // target of this task; cast at this boundary rather than guess which of the two should change.
    const messages = buildChatCompletionMessages(/** @type {import('./chat-completion-messages.js').ChatMessage[]} */ (promptChat), {
        isGroup, name1, name2, namesBehavior,
        currentApi: oaiSettings.chat_completion_source,
        currentModel: model ?? undefined,
        mediaDisplaySetting: powerUser.media_display,
    });

    const messageExamples = buildChatCompletionMessageExamples(
        parseMesExamplesForChatCompletion(fields.mesExamples ?? ''),
        { isGroup, name1, name2, appendNamesForGroup: true },
    );

    // CROSS-FILE MISMATCH: macro-substitution.js's own local `ChatMessage.send_date` is `string|number`,
    // narrower than the global `ChatMessage.send_date`'s `MessageTimestamp` (`string|number|Date`) that
    // `promptChat` (a `TreeChatMessage[]`, layered over the global type) actually carries. Same
    // "neither file is a target of this task" boundary as `messages` above.
    /** @type {SubstituteParamsContext} */
    const macroContext = {
        name1, name2, isGroup, model: model ?? undefined,
        characterCard: fields,
        chat: /** @type {import('./macro-substitution.js').ChatMessage[]} */ (promptChat), chatMetadata,
    };

    // Real bias-string resolution - see the `bias` FIELD-MAPPING NOTE above. `prepareOpenAIMessages()`
    // has no internal getBiasStrings() call of its own, so (like world-info activation, decision 4
    // above) this resolver calls it directly, reusing its own already-built `chat`/`macroContext`.
    const { promptBias } = getBiasStrings({
        textareaText, type, chat, userPromptBias: powerUser.user_prompt_bias, macroContext,
    });

    // Real TokenHandler, wrapping a real OpenAI-family tiktoken-based counter (see doc comment
    // decision 3) unless a caller supplies its own.
    const tokenHandler = tokenHandlerOverride ?? new TokenHandler(countTokenAsyncFnOverride ?? createOpenAITokenCounter(model));

    // Real world-info ACTIVATION - see doc comment decision 4 for the full rationale/settings-path
    // mapping for every option below. This is the one call site this resolver adds that
    // text-completion-generation-input.js's own equivalent does NOT have (that pipeline defers
    // activation to a separate orchestrator; this pipeline has none, so this resolver is it).
    const worldInfoIncludeNames = Boolean(worldInfoSettings.world_info_include_names ?? false);
    const chatForWI = promptChat.map(x => worldInfoIncludeNames ? `${x.name}: ${x.mes}` : (x.mes ?? '')).reverse();
    const generationTrigger = type !== undefined && GENERATION_TYPE_TRIGGERS.includes(type) ? type : 'normal';
    const globalScanData = {
        personaDescription: fields.persona,
        characterDescription: fields.description,
        characterPersonality: fields.personality,
        characterDepthPrompt: fields.charDepthPrompt,
        scenario: fields.scenario,
        creatorNotes: fields.creatorNotes,
        trigger: generationTrigger,
    };
    // Wraps this module's own real, already-built tiktoken-based counter (tokenHandler.countTokenAsyncFn,
    // the `(messages, full) => Promise<number>` shape) to match activateWorldInfoEntries()'s own
    // `(text: string) => Promise<number>` countTokens shape - see decision 4 above for why a single-field
    // pseudo-message (`[{ content: text }]`) is the right shape and why tokenHandler.countAsync() itself
    // is deliberately bypassed here.
    /** @type {(text: string) => Promise<number>} */
    const countTokensForWorldInfo = async (text) => tokenHandler.countTokenAsyncFn([{ content: text }]);
    const { activatedEntries } = await activateWorldInfoEntries(worldInfoCandidates, chatForWI, {
        maxContext: oaiSettings.openai_max_context ?? 4095,
        budgetPercent: worldInfoSettings.world_info_budget ?? 25,
        budgetCap: worldInfoSettings.world_info_budget_cap ?? 0,
        depth: worldInfoSettings.world_info_depth ?? 2,
        recursive: Boolean(worldInfoSettings.world_info_recursive ?? true),
        // BEHAVIOR FIX (flagged per task instructions, not silent): this was `maxRecursionStepsSetting`,
        // which activateWorldInfoEntries()'s own options object does not declare (its real param is
        // `maxRecursionSteps` - confirmed both by its own JSDoc and by strict-mode now rejecting the old
        // key outright as unknown). The old key silently vanished into an ignored extra property, so
        // `world_info_max_recursion_steps` never actually reached activation - every call effectively
        // used activateWorldInfoEntries()'s own internal default (0, capped at 25) regardless of the
        // real setting. Trivial, high-confidence rename; no other change.
        maxRecursionSteps: worldInfoSettings.world_info_max_recursion_steps ?? 0,
        globalScanData, macroContext, countTokens: countTokensForWorldInfo,
        chatMetadata, isDryRun: Boolean(dryRun),
        useGroupScoring: Boolean(worldInfoSettings.world_info_use_group_scoring ?? false),
        entryFilterContext: { trigger: generationTrigger, characterFilename: charFilename ?? undefined },
        minActivations: worldInfoSettings.world_info_min_activations ?? 0,
        minActivationsDepthMax: worldInfoSettings.world_info_min_activations_depth_max ?? 0,
    });
    // WORLD_INFO placement regex, applied per activated entry - see the REGEX SCRIPTS FIELD-MAPPING
    // NOTE above. Depth override only applies to atDepth-positioned entries, matching
    // src/text-completion-prompt-orchestrator.js's own identical resolveContent callback.
    //
    // activateWorldInfoEntries() (src/world-info/activation.js, not a target file) declares its
    // `activatedEntries` return as `WIEntry[]` - its own candidate-entry type, which (like WIEntry
    // itself - see the `worldInfoCandidates` cast above) doesn't declare the `order`/`position`/
    // `depth`/`role`/`outletName` fields real lorebook entries carry and bucketActivatedEntries()
    // (src/world-info/result-bucketing.js, also not a target file) requires as `WIActivatedEntry[]`.
    // Boundary cast, not a guess: same real underlying entries, a documented type gap in those two
    // (non-target) files.
    const { worldInfoBefore, worldInfoAfter, worldInfoDepth: worldInfoDepthEntries } = bucketActivatedEntries(/** @type {WIActivatedEntry[]} */ (/** @type {unknown} */ (activatedEntries)), {
        resolveContent: (entry) => {
            const regexDepth = entry.position === world_info_position.atDepth ? (entry.depth ?? WI_DEFAULT_DEPTH) : null;
            return getRegexedString(entry.content, regex_placement.WORLD_INFO, regexScripts, {
                depth: regexDepth ?? undefined, isMarkdown: false, isPrompt: true, macroContext, regexExtensionEnabled,
            });
        },
    });

    // Real @Depth world-info injection - see doc comment decision 4. Faithful, verified port of
    // src/text-completion-prompt-orchestrator.js's own Step 7.5 "1. World-info @Depth entries" loop
    // (same key format/position/depth/scan/role), writing into THIS pipeline's own `injectionTable`
    // (consumed by src/chat-completion-injection-prompts.js's `populateInjectionPrompts()` via
    // src/chat-completion-populate.js) instead of that orchestrator's separate `extensionPromptTable`.
    /** @type {ExtensionPromptTable} */
    const injectionTable = {};
    for (const depthEntry of worldInfoDepthEntries) {
        setExtensionPrompt(
            injectionTable,
            `wi_depth_${depthEntry.depth}_${depthEntry.role}`,
            depthEntry.entries.join('\n'),
            extension_prompt_types.IN_CHAT,
            depthEntry.depth,
            false,
            depthEntry.role,
        );
    }

    const resolved = {
        // Exposed so a caller (buildRawActionChatCompletionRequest()) that resolved `chat` via this
        // SAME call can read back which real tree node it resolved to, instead of re-deriving "the
        // current leaf" independently - see resolveChatHistory()'s own doc comment. `null` when
        // nothing could be safely resolved.
        resolvedNodeId,
        // True only for "neither nodeId nor (legacy) branchName given, but this owner already has a
        // real, established conversation" - the caller must treat this as a real error, not silently
        // pick a leaf.
        chatResolutionAmbiguous: Boolean(chatResolutionAmbiguous),

        // --- Character/persona resolution (getCharacterCardFields() - see doc comment decision 1) ---
        name2, hasActiveCharacter: hasCharacter,
        charDescription: fields.description,
        charPersonality: fields.personality,
        scenario: fields.scenario,
        systemPromptOverride: fields.system,
        jailbreakPromptOverride: fields.jailbreak,
        personaDescription: powerUser.persona_description,
        personaDescriptionPosition: powerUser.persona_description_position ?? 0,

        // --- World info (real candidates + real activation - see doc comment decision 4 for the
        // narrower remaining gap: worldInfoDepth/anBefore/anAfter/outletEntries/worldInfoExamples) ---
        worldInfoBefore,
        worldInfoAfter,
        worldInfoCandidates,
        wiFormat: oaiSettings.wi_format ?? '{0}',

        // --- Bias (real, resolved via getBiasStrings() - see doc comment FIELD-MAPPING NOTE) ---
        bias: promptBias,

        // RAW (pre-swipe-drop) history length - NOT `macroContext.chat.length` (that's `promptChat`,
        // which for a swipe/regenerate on a chat with exactly one message is correctly `0` once that
        // one message is dropped from context - a legitimate case, e.g. regenerating a solo opening
        // greeting, not an empty chat). A caller checking "is there really nothing to continue/swipe"
        // (see buildRawActionChatCompletionRequest()'s own such check) needs THIS field instead.
        rawChatLength: chat.length,

        // --- Generation identity/mode ---
        type, quietPrompt: undefined, quietImage: undefined,
        extensionPrompts: {}, cyclePrompt,

        // --- Chat history ---
        messages, messageExamples,
        groupMemberNames,

        // --- Token budget ---
        tokenHandler,
        maxContext: oaiSettings.openai_max_context ?? 4095,
        maxTokens: oaiSettings.openai_max_tokens ?? 300,

        // --- Logging / squashing ---
        enableLogging: Boolean(powerUser.console_log_prompts ?? false),
        squashSystemMessages: Boolean(oaiSettings.squash_system_messages ?? false),

        // --- Formatting ---
        scenarioFormat: oaiSettings.scenario_format ?? DEFAULT_SCENARIO_FORMAT,
        personalityFormat: oaiSettings.personality_format ?? DEFAULT_PERSONALITY_FORMAT,
        groupNudgePrompt: oaiSettings.group_nudge_prompt ?? DEFAULT_GROUP_NUDGE_PROMPT,
        impersonationPrompt: oaiSettings.impersonation_prompt ?? '',

        // --- Prompt manager ---
        prompts: Array.isArray(oaiSettings.prompts) ? oaiSettings.prompts : [],
        promptOrder: Array.isArray(oaiSettings.prompt_order) ? oaiSettings.prompt_order : [],
        characterId,
        macroContext,

        // --- Backend / tool-calling capability inputs (resolved internally by prepareOpenAIMessages() - see doc comment) ---
        mainApi: 'openai',
        settings: oaiSettings,
        model: model ?? undefined, modelList,
        canUseToolsOverride: undefined,
        includeSignatureOverride: undefined,
        toolReasoningModeOverride: undefined,
        includeToolReasoningOverride: undefined,

        // --- Media inlining (MVP scope boundary - see doc comment) ---
        imageInlining: false, videoInlining: false, audioInlining: false,
        imageQuality, directories,

        // --- Populate options ---
        toolBudgetTokens: 0,
        continuePrefill: Boolean(oaiSettings.continue_prefill ?? false),
        supportsAssistantPrefill: oaiSettings.chat_completion_source === chat_completion_sources.CLAUDE,
        namesInCompletion: namesBehavior === character_names_behavior.COMPLETION,
        assistantPrefill: oaiSettings.assistant_prefill ?? '',
        pinExamples: Boolean(powerUser.pin_examples ?? false),
        injectionTable,

        historyOptions: {
            type, cyclePrompt, isGroup,
            newChatPrompt: oaiSettings.new_chat_prompt ?? '',
            newGroupChatPrompt: oaiSettings.new_group_chat_prompt ?? '',
            continuePrefill: Boolean(oaiSettings.continue_prefill ?? false),
            continueNudgePrompt: oaiSettings.continue_nudge_prompt ?? '',
            sendIfEmpty: oaiSettings.send_if_empty ?? '',
            namesBehavior,
            imageQuality, directories,
            macroContext,
        },
        dialogueExamplesOptions: {
            newExampleChatPrompt: oaiSettings.new_example_chat_prompt ?? '',
            macroContext,
        },
    };

    return { ...resolved, ...macroExtras };
}
