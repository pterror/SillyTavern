import { getBiasStrings } from './prompt-line-formatting.js';
import { getCharacterCardFields, getGroupCharacterDepthPrompts } from './character-card-fields.js';
import { buildCoreChat, finalizeCoreChatMessage } from './core-chat-build.js';
import { createReasoningFoldState, foldReasoningIntoMessage, isReasoningLimitReached } from './reasoning-fold.js';
import { getGuidanceScale, adjustMaxContextForCfg } from './cfg-prompt-resolve.js';
import { parseDecorators } from './world-info/decorators.js';
import { activateWorldInfoEntries } from './world-info/activation.js';
import { bucketActivatedEntries, world_info_position } from './world-info/result-bucketing.js';
import { getRegexedString, regex_placement } from './regex-scripts-engine.js';
import { appendFileAttachments } from './file-attachment-inline.js';
import { resolveAuthorsNote } from './authors-note.js';
import { assembleStoryString } from './story-string-assembly.js';
import { injectJailbreak, buildChat2, fillContextBudget, estimateExampleBudget, buildMesSend } from './chat-history-budget.js';
import { addChatsPreamble, addChatsSeparator, resolvePromptStrings } from './prompt-size-backoff.js';
import { modifyLastPromptLine } from './prompt-line-formatting.js';
import { combineFinalPrompt } from './final-prompt-combination.js';
import { getStoppingStrings } from './stopping-strings.js';
import { getCustomTokenBans, calculateLogitBias } from './token-bans-and-bias.js';
import { createTextGenGenerationData } from './textgen-generation-data.js';
import { createKoboldGenerationData } from './kobold-generation-data.js';
import { createNovelGenerationData } from './novel-generation-data.js';
import { substituteParams } from './macro-substitution.js';
import { formatInstructModeExamples } from './instruct-mode-examples.js';
import { createExtensionPromptTable, getExtensionPrompt, doChatInject, extension_prompt_types } from './extension-prompt-table.js';
import { persona_description_defaults } from '../public/scripts/constants.js';
import { addDepthInjections, addNoteAndPersona, addPageInjections } from './prompt-injections.js';
import { exampleBlocks } from './example-blocks.js';

/**
 * Server-side orchestrator that reproduces the TEXT-COMPLETION-FAMILY prompt-assembly pipeline of
 * public/script.js's Generate() for `main_api` in `textgenerationwebui`/`kobold`/`novel`
 * (`koboldhorde` is a separate, worker-routed main_api NOT handled by this orchestrator - see
 * text-completion-generation-input.js's own doc comment for why), by wiring together the ~18
 * independently ported/tested modules under src/ - each of those modules is a faithful,
 * pure-computation port of one stage of Generate(), and (before this file) none of them called each
 * other. This is the integration point.
 *
 * UPDATE (this task): Step 16 (the final generate_data wire payload) now dispatches on `mainApi`
 * to createKoboldGenerationData() (src/kobold-generation-data.js) / createNovelGenerationData()
 * (src/novel-generation-data.js) / createTextGenGenerationData() (src/textgen-generation-data.js),
 * matching public/script.js's own `switch (main_api)` dispatch in Generate() exactly
 * (`case 'kobold':`/`case 'novel':`/`case 'textgenerationwebui':`). Every OTHER step in this
 * pipeline (1-15) was already `mainApi`-generic (assembleStoryString()/injectJailbreak()/
 * combineFinalPrompt() etc. already take `mainApi`/`naiPreamble`/`chatStart` as real inputs and
 * branch on them for real - see e.g. `force_name2`'s `mainApi === 'novel'` branch below) - Step 16
 * was the only remaining hardcoded-to-textgenerationwebui piece, and is now the only step whose
 * behavior differs by backend family.
 *
 * ============================================================================================
 * READ THIS BEFORE TRUSTING THE OUTPUT AS PRODUCTION-ACCURATE - remaining, DOCUMENTED gaps:
 * ============================================================================================
 *
 * 1. THE `extension_prompts` SIDE-TABLE - PARTIALLY CLOSED. The client keeps a live, depth-indexed
 *    table of injected content (world-info @Depth entries, the author's-note text combined with WI
 *    ANTop/ANBottom entries, the quiet-prompt, jailbreak/PHI injected via a different mechanism, the
 *    story-string-as-in-chat injection, CFG's own depth splice, etc.) via
 *    setExtensionPrompt()/getExtensionPrompt(), and *threads all of it into `mesSend[i]` via
 *    `doChatInject()` splicing synthetic messages into the chat array before token-budget filling*.
 *    A server-side equivalent of that table and of `doChatInject()` now exists (see
 *    src/extension-prompt-table.js) and IS wired into this orchestrator, between the story-string
 *    assembly and jailbreak-injection steps below. What is now REAL, as of this task:
 *      - `worldInfoDepth` (from bucketActivatedEntries) - every @Depth world-info entry is written
 *        into the table (keyed by depth+role) and IS now spliced into the chat array (and therefore
 *        into `mesSend`/`combinedPrompt`) via doChatInject(), exactly like the client.
 *      - `authorsNote.value` - written into the table at its REAL `authorsNote.position` (no longer
 *        gated to IN_CHAT only - see the inline comment at the call site) - `resolveAuthorsNote()`'s
 *        own doc comment establishes that `position` already IS an extension_prompt_types value, so
 *        this is the accurate behavior, not a simplification of an unclear mapping. When the note is
 *        actually due this turn (`authorsNote.shouldAddPrompt`), `anBefore`/`anAfter`
 *        (bucketActivatedEntries's WI ANTop/ANBottom output) are now combined into the injected value
 *        exactly like the client (`${anBefore}\n${note}\n${anAfter}`, stripping at most one
 *        leading/trailing newline) - this closes the anBefore/anAfter gap for the note-injection path.
 *        Position-appropriate consumption: an IN_CHAT-positioned note is spliced into the chat array by
 *        `doChatInject()` below (same as before); a BEFORE_PROMPT/IN_PROMPT-positioned note is instead
 *        read out via the `beforeScenarioAnchor`/`afterScenarioAnchor` resolution described next -
 *        `doChatInject()` only ever reads IN_CHAT-positioned table entries (re-confirmed by re-reading
 *        `getOccupiedInChatDepths()`/`doChatInject()` in src/extension-prompt-table.js), so the two
 *        consumption paths are mutually exclusive - a note is never injected both ways.
 *      - `beforeScenarioAnchor`/`afterScenarioAnchor` (BEFORE_PROMPT/IN_PROMPT anchors) - NOW CLOSED,
 *        as of this task. Once the Author's Note has been written into the table (the only real
 *        source, in this orchestrator's scope, that can ever populate these two positions - see the
 *        note-write above), `getExtensionPrompt(table, { position: BEFORE_PROMPT }, macroContext)` /
 *        `getExtensionPrompt(table, { position: IN_PROMPT }, macroContext)` (sync; already used
 *        elsewhere in this file) resolve the two anchors for real, and these resolved values (trimmed)
 *        are what `assembleStoryString()` actually receives whenever the table has non-empty content
 *        at those positions. The plain caller-supplied `beforeScenarioAnchor`/`afterScenarioAnchor`
 *        inputs (default '') remain available as a fallback only - used when the table-resolved value
 *        is empty - so a caller with some other future extension-prompt source for these positions can
 *        still inject a value directly.
 *      - `storyStringInjection` (from assembleStoryString, when the story string is configured to
 *        inject in-chat instead of at the top) - written into the table and spliced in the same way.
 *      - `injectedIndices` fed into injectJailbreak/buildChat2/fillContextBudget/combineFinalPrompt is
 *        now the REAL output of the doChatInject()-equivalent (`doChatInjectIndices`) whenever the
 *        caller doesn't override it - `initialInjectedIndices` (the old plain input, default `[]`) is
 *        kept only as a fallback/override for a caller with its own pre-computed indices.
 *    What is STILL NOT wired (separate, still-open gaps, deliberately out of scope for this task):
 *      - `outletEntries` (from bucketActivatedEntries) - still never delivered to whatever "outlet"
 *        consumer would read it.
 *      - The quiet-prompt/CFG-depth-splice/PHI-via-extension-prompts mechanisms the client also
 *        threads through this same table are not modeled here at all as TABLE entries - only the
 *        three sources listed above are written into the table by this orchestrator. The quiet-prompt
 *        text IS used for one narrow purpose - feeding World-Info's scan buffer, matching the client's
 *        own transient `setExtensionPrompt(inject_ids.QUIET_PROMPT, ..., scan=true)` / immediate-clear
 *        pattern at public/script.js ~5698/~5711 - but it is still never written into THIS
 *        orchestrator's extension-prompt table nor spliced into the chat array as an actual injection,
 *        since the client itself clears that slot again immediately after the world-info call and
 *        never lets it reach doChatInject() - confirmed the anchors are resolved from the Author's
 *        Note specifically, not from the quiet-prompt slot, which never contributes here.
 *      - The character card's own `depth_prompt` field
 *        (`character.data.extensions.depth_prompt.{prompt, depth, role}`) - BOTH the single-character
 *        AND group-chat cases are NOW CLOSED, as of this task (and the prior one). The client stashes
 *        this into `extension_prompts` as an ACTUAL IN-CHAT depth injection (public/script.js
 *        ~5545-5559: per-group-member via `getGroupDepthPrompts()`/`inject_ids.DEPTH_PROMPT_INDEX(index)`
 *        when `selected_group` is set and produces at least one entry, else the single-character
 *        `setExtensionPrompt(inject_ids.DEPTH_PROMPT, depthPromptText, IN_CHAT, depthPromptDepth,
 *        extension_settings.note.allowWIScan, depthPromptRole)`), separately from the already-correct
 *        "characterDepthPrompt available for WI key-matching via globalScanData" mechanism (which
 *        src/character-card-fields.js's `charDepthPrompt` field / src/world-info/key-matching.js's
 *        `entry.matchCharacterDepthPrompt` check already handle correctly - that part is fine, was
 *        not touched). `getCharacterCardFields()` resolves the single-character `depth`/`role`
 *        sub-fields (`charDepthPromptDepth`/`charDepthPromptRole`); `getGroupCharacterDepthPrompts()`
 *        (also in src/character-card-fields.js, ported from group-chats.js's `getGroupDepthPrompts()`)
 *        resolves one `{text, depth, role}` entry per group member with a non-empty depth_prompt, each
 *        already resolved through the same role-name mapping. This orchestrator writes either the
 *        group entries (one table key per entry, `depth_prompt_${index}`) or the single-character
 *        entry (`depth_prompt`) into the extension-prompt table (entry 4, alongside world-info/
 *        author's-note/story-string above) and therefore into `mesSend`/`combinedPrompt` via the same
 *        `doChatInject()` mechanism - see the inline comment at the call site for the exact
 *        group-vs-single branching (a group chat with zero resolved depth-prompt entries falls back to
 *        the single-character entry, matching the client's real per-member-loop structure).
 *
 * 2. Regex-scripts engine (getRegexedString) - NOW REAL, as of this task. The three placements the
 *    client applies during text-completion prompt assembly are all wired into this orchestrator:
 *      - `regex_placement.USER_INPUT`/`AI_OUTPUT` - applied per-message, before
 *        `finalizeCoreChatMessage()` ever sees the text (the `resolvedMessage` param is now the real
 *        `getRegexedString()` result, keyed on `chatItem.is_user`, with `depth = coreChat.length -
 *        index - (isContinue ? 2 : 1)`, matching public/script.js ~5573-5577).
 *      - `regex_placement.REASONING` - applied to each message's reasoning text, inside the existing
 *        reasoning-folding loop, before `foldReasoningIntoMessage()` sees it (same depth formula,
 *        reused per-iteration with that loop's own `i`, matching public/script.js ~5606-5627).
 *      - `regex_placement.WORLD_INFO` - applied to each activated world-info entry's content, via
 *        `bucketActivatedEntries`'s `resolveContent` param, with a depth override (the raw
 *        `entry.depth`, defaulting to 4) only for `position === world_info_position.atDepth` entries
 *        (matching public/scripts/world-info.js ~5289).
 *    `regex_placement.SLASH_COMMAND` and `.MD_DISPLAY` are NOT used anywhere in this orchestrator -
 *    matching the client, since neither placement applies to prompt assembly (SLASH_COMMAND fires
 *    from the slash-command pipeline, MD_DISPLAY is a deprecated display-only transform). The caller
 *    supplies the already-resolved, already allow-list-filtered flat `regexScripts` array (default
 *    `[]`, matching src/regex-scripts-engine.js's own "caller resolves entities" contract - resolving
 *    which scripts apply from character/extension-settings state remains out of scope, same as
 *    `worldInfoCandidates`) and a `regexExtensionEnabled` boolean (default `true`), forwarded to
 *    every `getRegexedString()` call this orchestrator makes.
 *
 * 3. File-attachment inlining (appendFileContent) - NOW REAL, as of this task, via
 *    src/file-attachment-inline.js's `appendFileAttachments()`. It runs AFTER the per-message
 *    regex step (matching public/script.js ~5573-5582: `regexedMessage = getRegexedString(...); ...;
 *    regexedMessage = await appendFileContent(chatItem, regexedMessage);`), on top of the
 *    already-regexed message text, before `finalizeCoreChatMessage()` ever sees it - so the
 *    `coreChat.map()` callback below is now async (`Promise.all`-wrapped), same shape as the
 *    client's own `coreChat = await Promise.all(coreChat.map(async (chatItem, index) => {...}))`
 *    at that exact line. `directories` (already an orchestrator input, used by
 *    getCharacterCardFields()) is threaded through to resolve `extra.files[].url` entries via a
 *    real filesystem read (see file-attachment-inline.js's module doc comment for the exact
 *    `file.url` -> `directories.files` path mapping and how it was verified against the real
 *    `/api/files/upload` server route). DELIBERATELY NOT ported: the client's `appendFileContent`
 *    also deletes/recomputes `extra.fileLength` and commits it back into the chat message store as
 *    a side effect of what should be a pure read - see file-attachment-inline.js's module doc
 *    comment for why that write-on-read anti-pattern is intentionally dropped here, not merely
 *    forgotten.
 *
 * 4. Tool-calling (ToolManager.isToolCallingSupported/canPerformToolCalls) - `canUseTools` is a
 *    plain boolean input, default `false`. No tool-calling subsystem is modeled.
 *
 * 5. Extension interceptors (runGenerationInterceptors) and the GENERATE_BEFORE_COMBINE_PROMPTS /
 *    GENERATE_AFTER_COMBINE_PROMPTS event hooks - there is no server-side extension-execution model
 *    (no event bus, no arbitrary-extension-JS execution) to run against these events, so this
 *    orchestrator does not call anything at the points in the pipeline where the client would emit
 *    them. This mirrors src/final-prompt-combination.js's own module doc comment on the exact same
 *    topic: whether the server needs an equivalent hook mechanism (a plugin API? a declarative
 *    override config?) is a real, undecided design question that this task does not decide as a
 *    side effect - it is simply not implemented, not stubbed.
 *
 * 6. Lorebook/world-info entry RESOLUTION (getSortedEntries - which lorebooks/entries are
 *    candidates given the current character/chat/global lorebook selection) is NOT done here.
 *    `worldInfoCandidates` is a plain input array of already-resolved candidate entries, in
 *    priority order, exactly as activateWorldInfoEntries() itself expects.
 *
 * 7. `parseMesExamples()` (public/script.js) and the lorebook's example-message entries folded into
 *    its blocks are src/example-blocks.js's, shared with the chat completion builder. `formatInstructModeExamples()` (public/scripts/instruct-mode.js) IS NOW a real, separately
 *    ported module (see src/instruct-mode-examples.js) and IS wired in below: `mesExamplesRawArray`
 *    is captured (as `[...mesExamplesArray]`) AFTER the WI-EM fold-in loop, exactly matching
 *    public/script.js's own ordering (raw-capture at ~5733, immediately after its identical fold-in
 *    loop at ~5715-5729, re-verified against that exact span for this task) - and
 *    `formatInstructModeExamples()` is then applied to `mesExamplesArray` (not the raw array), only
 *    when `isInstruct` is true, matching ~5735-5736. This closes the gap: `mesExamplesArray` and
 *    `mesExamplesRawArray` are no longer identical in instruct mode, and instruct-mode example
 *    dialogues are now correctly wrapped with `input_sequence`/`output_sequence`/suffixes/names per
 *    `instructPreset`. One caveat worth flagging: `formatInstructModeExamples()` is a pure function
 *    of `mesExamplesArray` (the already-folded-in array, including any WI-EM entries), same as the
 *    client - there is no separate reformatting pass needed for the WI-EM fold-in specifically, since
 *    it's folded in before either array is captured, so no further gap exists here.
 *
 * 8. CLOSED. `GENERATION_TYPE_TRIGGERS.includes(type)` (public/scripts/constants.js:
 *    `['normal', 'continue', 'impersonate', 'swipe', 'regenerate']`) decides whether world-info's
 *    `globalScanData.trigger` is the generation `type` itself or the literal string `'normal'`.
 *    This orchestrator now derives it from `type` the same way, via the mirrored
 *    `GENERATION_TYPE_TRIGGERS` list below - `generationTrigger` remains available as an explicit
 *    override input for a caller with its own reason to force a specific trigger value, but its
 *    default is now the real derivation instead of always `'normal'`.
 *
 * Everything else - character-card resolution, reasoning folding, world-info key-matching/
 * activation/bucketing, author's-note interval math, story-string rendering, jailbreak injection,
 * the chat2/token-budget-fill/mesSend pipeline, prompt-size backoff, CFG max-context adjustment,
 * final-prompt combination, stopping strings, token bans, logit bias, and the textgen wire payload -
 * all go through the real ported module for that stage.
 */

// Mirrors public/scripts/constants.js's GENERATION_TYPE_TRIGGERS exactly.
const GENERATION_TYPE_TRIGGERS = ['normal', 'continue', 'impersonate', 'swipe', 'regenerate'];

/**
 * @typedef {import('./macro-substitution.js').SubstituteParamsContext} SubstituteParamsContext
 */

/**
 * @typedef {object} AssembleTextCompletionPromptInput
 *
 * --- Generation identity/mode -----------------------------------------------------------------
 * @property {string} [type] Generation type ('normal'/'impersonate'/'continue'/'swipe'/'quiet'/...).
 * @property {boolean} [isImpersonate] Whether this is a user-impersonation generation.
 * @property {boolean} [isContinue] Whether this continues the last message.
 * @property {boolean} [isSwipe] Whether this is a 'swipe' generation (drops the last surviving coreChat message).
 * @property {boolean} [isGroup] Whether this is a group chat.
 * @property {boolean} [isDryRun] Skips world-info sticky/cooldown state mutation.
 * @property {boolean} [canUseTools] Resolved result of ToolManager.isToolCallingSupported() (now a
 * real, ported predicate - src/chat-completion-tool-capabilities.js's isToolCallingSupported()).
 * Not resolved by this orchestrator itself because the real function unconditionally returns
 * `false` whenever `mainApi !== 'openai'` (verified directly in public/scripts/tool-calling.js),
 * which is always true for this text-completion-only module - so the correct resolved value here
 * is always `false`, matching this param's own default; there is no case where a caller of this
 * orchestrator would ever need to pass `true`.
 * @property {string} [quiet_prompt] Quiet-generation prompt text, forwarded to modifyLastPromptLine.
 * @property {boolean} [quietToLoud]
 * @property {string} [quietName]
 * @property {string} [generationTrigger] See gap (8) above. Defaults to `type` itself when `type` is
 *   one of GENERATION_TYPE_TRIGGERS, else `'normal'` - matches the client's real derivation. Pass
 *   explicitly only to override that derivation.
 *
 * --- Names -------------------------------------------------------------------------------------
 * @property {string} [name1] Persona display name ({{user}}).
 * @property {string} [name2] Character display name ({{char}}).
 *
 * --- Character/persona/chat resolution -----------------------------------------------------------
 * @property {import('./users.js').UserDirectoryList} directories Forwarded to getCharacterCardFields().
 * @property {string} [avatar] Character avatar filename.
 * @property {string} [groupId] Group id.
 * @property {boolean} [preferCharacterPrompt]
 * @property {boolean} [preferCharacterJailbreak]
 * @property {string} [personaDescription]
 * @property {object} [chatMetadata] Mutable chat_metadata equivalent - read AND written by several stages.
 * @property {object[]} chat Full, unfiltered chat message array.
 * @property {string} [textareaText] Current user input textarea text, for bias-string resolution.
 * @property {string} [userPromptBias] Equivalent of power_user.user_prompt_bias.
 * @property {boolean} [alwaysForceName2] Equivalent of power_user.always_force_name2.
 * @property {boolean} [forceName2Override] When set, used verbatim as `force_name2` instead of the
 *   client's `(promptBias && !isUserPromptBias) || alwaysForceName2 || mainApi === 'novel'` derivation.
 *
 * --- Reasoning folding ---------------------------------------------------------------------------
 * @property {boolean} [reasoningAddToPrompts] Equivalent of power_user.reasoning.add_to_prompts.
 * @property {number} [reasoningMaxAdditions] Equivalent of power_user.reasoning.max_additions.
 * @property {string} [reasoningPrefix]
 * @property {string} [reasoningSeparator]
 * @property {string} [reasoningSuffix]
 *
 * --- Regex scripts -------------------------------------------------------------------------------
 * @property {import('./regex-scripts-engine.js').RegexScript[]} [regexScripts] Already-resolved,
 *   already allow-list-filtered flat list of regex scripts to run via getRegexedString() at every
 *   placement this orchestrator applies (USER_INPUT/AI_OUTPUT per-message, REASONING, WORLD_INFO).
 *   Resolving which scripts apply from character/extension-settings state is out of scope (see
 *   module doc comment gap 2). Default `[]` (no scripts = no-op).
 * @property {boolean} [regexExtensionEnabled] Equivalent of the client's
 *   `extension_settings.disabledExtensions.includes('regex')` kill-switch, forwarded to every
 *   getRegexedString() call. Default `true`.
 *
 * --- Context/token budget -------------------------------------------------------------------------
 * @property {import('./extension-prompt-table.js').ExtensionPromptTable} [pageInjections] What the page's extensions inject
 *   (src/page-injections.js), under the page's keys.
 * @property {number} thisMaxContext How many tokens the prompt may take, before CFG takes its share: upstream's
 *   getMaxContextSize(), the context less the reply's length.
 * @property {number} [maxContext] The context size setting, sent as is to a backend that takes it (KoboldAI's
 *   max_context_length). Defaults to `thisMaxContext`.
 * @property {number} [tokenPadding] Equivalent of power_user.token_padding - added on top of every
 *   countTokens() result wherever the client bakes padding into getTokenCountAsync() calls. Default 0.
 * @property {(text: string) => Promise<number>} countTokens REQUIRED. Real tokenization needs
 *   src/tokenizer-resolve.js's encodeWithTokenizerType() plus a resolved backend/model context -
 *   a separate resolution concern from this orchestrator. Callers must resolve a real tokenizer
 *   and inject it here (or, for tests, a simple deterministic fake).
 * @property {(text: string) => Promise<number>} [countPromptTokens] Counts a text that begins the prompt
 *   (the baseline and the whole-prompt size check) as the backend counts that prompt, BOS included where
 *   the backend adds one. Default `countTokens`.
 * @property {(text: string) => number[] | null | Promise<number[] | null>} encodeTokens REQUIRED. Distinct from
 *   `countTokens` - returns token IDS (for getCustomTokenBans()/calculateLogitBias()), not a count;
 *   null when there is no tokenizer, which leaves the entry out and lists it in `droppedEntries`.
 *   May be async (e.g. src/tokenizer-resolve.js's encodeWithTokenizerType(), which can probe a
 *   remote backend) - both functions now await it, so a real async tokenizer can be wired in
 *   directly.
 * @property {(tokenizerType: number, text: string) => number[] | Promise<number[]>} [encodeTokensByType]
 *   Required when `mainApi` is 'novel': createNovelGenerationData() encodes with a tokenizer type as
 *   its first argument, a different shape from `encodeTokens`.
 * @property {number} [novelTokenizerType] Required when `mainApi` is 'novel': the send's resolved
 *   `tokenizers` value, NONE for an estimate resolution. Entries NovelAI leaves out for lack of a
 *   tokenizer are listed in `droppedEntries`.
 * @property {number} [amountGen] Equivalent of `amount_gen` - max new tokens to request, forwarded
 *   to createTextGenGenerationData() as `maxTokens`.
 * @property {boolean} [requestTokenProbabilities] Equivalent of power_user.request_token_probabilities.
 *
 * --- CFG (classifier-free guidance) -----------------------------------------------------------------
 * @property {number} [chatGuidanceScale]
 * @property {boolean} [groupchatIndividualChars]
 * @property {import('./cfg-prompt-resolve.js').CfgSettings} [charaCfg]
 * @property {import('./cfg-prompt-resolve.js').CfgSettings} [globalCfg]
 * @property {number[]} [promptCombine]
 * @property {string} [promptSeparator]
 * @property {number} [promptInsertionDepth]
 * @property {import('./cfg-prompt-resolve.js').ChatMetadataCfgPrompts} [chatMetadataPrompts]
 *
 * --- World info ----------------------------------------------------------------------------------
 * @property {import('./world-info/activation.js').WIEntry[]} [worldInfoCandidates] Candidate entries,
 *   priority order, RAW (not-yet-decorator-parsed) `.content` - this orchestrator calls parseDecorators()
 *   on each one itself. Lorebook/entry RESOLUTION is out of scope (see gap 6) - caller supplies these.
 * @property {boolean} [worldInfoIncludeNames] Equivalent of world_info_include_names.
 * @property {number} [worldInfoBudgetPercent] Equivalent of world_info_budget. Default 25.
 * @property {number} [worldInfoBudgetCap]
 * @property {number} [worldInfoDepth] Equivalent of world_info_depth (how many recent messages the
 *   key-matching scan considers). Default 2, matching the client's own default.
 * @property {boolean} [worldInfoRecursive]
 * @property {number} [worldInfoMaxRecursionSteps]
 * @property {number} [worldInfoMinActivations]
 * @property {number} [worldInfoMinActivationsDepthMax]
 * @property {boolean} [worldInfoUseGroupScoring]
 * @property {object} [entryFilterContext]
 * @property {Map<string, object>} [externalActivations]
 * @property {() => number} [worldInfoRandom] Injectable RNG for tests.
 *
 * --- Author's note ---------------------------------------------------------------------------------
 * @property {import('./authors-note.js').AuthorsNoteSettings} [noteSettings]
 * @property {boolean} [hasCharacterOrGroup]
 *
 * --- Story string / instruct mode -------------------------------------------------------------------
 * @property {string} [storyStringTemplate]
 * @property {number} [storyStringPosition]
 * @property {number} [storyStringDepth]
 * @property {number} [storyStringRole]
 * @property {boolean} [sysPromptEnabled]
 * @property {string} [sysPromptContent]
 * @property {number} [personaDescriptionPosition] One of persona_description_positions.
 * @property {number} [personaDescriptionDepth] The persona description's depth in the chat (at AT_DEPTH).
 * @property {number} [personaDescriptionRole] Its role there.
 * @property {boolean} [stripExamples]
 * @property {string} [beforeScenarioAnchor] Fallback/override only - default ''. Used only when the
 *   extension-prompt table's own BEFORE_PROMPT-position content (populated by the Author's Note when
 *   its position is BEFORE_PROMPT - see gap (1) above) resolves to empty; the real, table-resolved
 *   value otherwise wins.
 * @property {string} [afterScenarioAnchor] Fallback/override only - default ''. Same as
 *   `beforeScenarioAnchor` above, but for the IN_PROMPT position.
 * @property {boolean} [isInstruct]
 * @property {import('./instruct-template-format.js').InstructSettings} [instructPreset]
 * @property {object} [contextSettings] Equivalent of power_user.context.
 * @property {string} [instructUserAlignmentMessage]
 * @property {boolean} [instructWrap] Equivalent of power_user.instruct.wrap, forwarded to buildMesSend().
 * @property {boolean} [pinExamples] Equivalent of power_user.pin_examples.
 *
 * --- Jailbreak / system prompt ----------------------------------------------------------------------
 * @property {string} [sysPromptPostHistory] Equivalent of power_user.sysprompt.post_history.
 * @property {number[]} [injectedIndices] Fallback/override only - default []. When left at the
 *   default, the orchestrator's own doChatInject()-equivalent result is used instead (see gap (1)
 *   above); pass this only if the caller has pre-computed injection indices via some other means.
 *
 * --- Backend / API ---------------------------------------------------------------------------------
 * @property {string} mainApi Equivalent of main_api. Never 'openai' for this orchestrator.
 * @property {string} [naiPreamble]
 * @property {string} [chatStart]
 * @property {boolean} [collapseNewlines]
 *
 * --- Stopping strings / token bans / logit bias -------------------------------------------------------
 * @property {boolean} [namesAsStopStrings]
 * @property {boolean} [singleLine]
 * @property {string} [customStoppingStringsRaw]
 * @property {boolean} [customStoppingStringsMacro]
 * @property {string[]} [ephemeralStoppingStrings]
 * @property {string[]} [groupMemberNames] Every member's name, muted ones too.
 * @property {string[]} [groupDisabledMembers] The muted members' names.
 * @property {string} [bannedTokensRaw]
 * @property {string} [globalBannedTokensRaw]
 * @property {boolean} [sendBannedTokens]
 * @property {import('./token-bans-and-bias.js').LogitBiasEntry[]} [logitBiasEntries]
 *
 * --- Final generation-data wire payload ---------------------------------------------------------------
 * @property {object} settings Backend-specific settings object matching `mainApi`
 *   (textgenerationwebui_settings / kai_settings / nai_settings equivalent), forwarded to whichever
 *   of createTextGenGenerationData()/createKoboldGenerationData()/createNovelGenerationData() Step
 *   16 dispatches to.
 * @property {string} [model] Already-resolved model name. Used by createTextGenGenerationData() and
 *   (as `settings.model_novel`, already inside `settings` for the 'novel' case) createNovelGenerationData();
 *   NOT used by createKoboldGenerationData() (Kobold has no per-request model selector - the
 *   connected KoboldAI/KoboldCpp server itself decides what model is loaded).
 *
 * --- Backend-specific generation-data (kobold/novel dispatch only - see Step 16) -----------------------
 * @property {import('./kobold-generation-data.js').KoboldGenerationFlags} [koboldFlags] Equivalent
 *   of kai_flags - real values require a LIVE version-probe against the connected KoboldAI/KoboldCpp
 *   server (public/scripts/kai-settings.js's checkStatusKobold(), via versionCompare() against the
 *   probed version strings) - the SAME "don't trigger a live network call as a side effect of pure
 *   settings resolution" concern already established for countTokens/encodeTokens (see
 *   text-completion-generation-input.js's own doc comment). Defaults to all-`false` (the client's
 *   own kai_flags module-level default before any status probe ever runs) - a caller with a real,
 *   already-probed value should pass it explicitly via macroExtras. `isHorde` bypasses several of
 *   these flags client-side, but this orchestrator's own `mainApi` is never 'koboldhorde' (see
 *   text-completion-generation-input.js's doc comment for why), so `isHorde` below always defaults
 *   `false` here too.
 * @property {boolean} [isHorde] Equivalent of the client's `main_api === 'koboldhorde'` check inside
 *   getKoboldGenerationData()'s call site. Always `false` by default - see `koboldFlags` above.
 * @property {string} [apiServer] Equivalent of kai_settings.api_server, forwarded to
 *   createKoboldGenerationData() verbatim (used only for koboldSettings' own `api_server` wire field,
 *   NOT for actually dispatching the request - that remains the raw-action route's own job).
 * @property {number} [novelDataTier] Equivalent of `novel_data?.tier` - the NovelAI account's own
 *   subscription tier (1/2/3), used by createNovelGenerationData() to pick a max response length.
 *   This is LIVE NovelAI-account data (from the `/api/novelai/status` subscription check), not a
 *   settings.json field - left undefined unless a caller supplies it via macroExtras (the same
 *   "external live data, caller resolves it" pattern as `worldInfoRandom`/`externalActivations`).
 * @property {number[]} [presetOrder] Equivalent of createNovelGenerationData()'s own `presetOrder`
 *   fallback param (a distinct preset-merge object's `.order`, used only when `settings.order` is
 *   unset) - left undefined by default; `settings.order` (nai_settings.order) already covers the
 *   common case.
 * @property {boolean} [consoleLogPrompts] Equivalent of power_user.console_log_prompts, forwarded to
 *   createNovelGenerationData() (logs the raw NovelAI prompt when true).
 * @property {import('./macro-substitution.js').SubstituteParamsContext} [macroFacts] What the macros read besides the
 *   names, the card and the chat (src/macro-facts.js).
 */

/**
 * Assembles the full TEXT-COMPLETION-ONLY prompt, mirroring public/script.js's Generate() end to
 * end by wiring together the ~18 independently-ported modules under src/. See the module doc
 * comment above for every documented gap before treating this as production-accurate.
 * @param {AssembleTextCompletionPromptInput} input
 */
export async function assembleTextCompletionPrompt(input) {
    const {
        type, isImpersonate = false, isContinue = false, isSwipe = false, isGroup = false, isDryRun = false,
        canUseTools = false, quiet_prompt, quietToLoud = false, quietName,
        generationTrigger = GENERATION_TYPE_TRIGGERS.includes(type) ? type : 'normal',
        name1 = '', name2 = '',
        directories, avatar, groupId, preferCharacterPrompt = false, preferCharacterJailbreak = false,
        personaDescription, chatMetadata = {}, chat, textareaText = '', userPromptBias = '',
        alwaysForceName2 = false, forceName2Override,
        reasoningAddToPrompts = false, reasoningMaxAdditions = 999999, reasoningPrefix = '', reasoningSeparator = '', reasoningSuffix = '',
        regexScripts = [], regexExtensionEnabled = true,
        tokenPadding = 0, countTokens, countPromptTokens = countTokens, encodeTokens, encodeTokensByType, novelTokenizerType, amountGen = 0, requestTokenProbabilities = false,
        chatGuidanceScale, groupchatIndividualChars = false, charaCfg, globalCfg, promptCombine = [], promptSeparator, promptInsertionDepth = 1, chatMetadataPrompts = {},
        worldInfoCandidates = [], worldInfoIncludeNames = false, worldInfoBudgetPercent = 25, worldInfoBudgetCap = 0,
        worldInfoDepth = 2, worldInfoRecursive = true, worldInfoMaxRecursionSteps = 0,
        worldInfoMinActivations = 0, worldInfoMinActivationsDepthMax = 0, worldInfoUseGroupScoring = false,
        entryFilterContext = {}, externalActivations = new Map(), worldInfoRandom = Math.random,
        noteSettings = {}, hasCharacterOrGroup = false,
        storyStringTemplate = '', storyStringPosition = 0, storyStringDepth = 1, storyStringRole = 0,
        sysPromptEnabled = false, sysPromptContent = '', personaDescriptionPosition = 0, stripExamples = false,
        personaDescriptionDepth = persona_description_defaults.depth, personaDescriptionRole = persona_description_defaults.role,
        beforeScenarioAnchor = '', afterScenarioAnchor = '',
        isInstruct = false, instructPreset = {}, contextSettings = {}, instructUserAlignmentMessage,
        instructWrap = false, pinExamples = false,
        sysPromptPostHistory = '', injectedIndices: initialInjectedIndices = [],
        mainApi, naiPreamble = '', chatStart = '', collapseNewlines = false,
        namesAsStopStrings = false, singleLine = false, customStoppingStringsRaw, customStoppingStringsMacro = false,
        ephemeralStoppingStrings = [], groupMemberNames = [], groupDisabledMembers = [],
        bannedTokensRaw = '', globalBannedTokensRaw = '', sendBannedTokens = false, logitBiasEntries = [],
        settings = {}, model,
        koboldFlags = {}, isHorde = false, apiServer, novelDataTier, presetOrder, consoleLogPrompts = false,
        macroFacts = {},
    } = input;

    if (typeof countTokens !== 'function') throw new Error('assembleTextCompletionPrompt: countTokens is required');
    if (typeof encodeTokens !== 'function') throw new Error('assembleTextCompletionPrompt: encodeTokens is required');
    if (mainApi === 'novel' && typeof encodeTokensByType !== 'function') throw new Error('assembleTextCompletionPrompt: encodeTokensByType is required for novel');
    if (mainApi === 'novel' && typeof novelTokenizerType !== 'number') throw new Error('assembleTextCompletionPrompt: novelTokenizerType is required for novel');

    // Shared side effect sink for the {{banned "..."}} macro, threaded through every substituteParams
    // call this orchestrator triggers (directly or via a downstream module), same as the client's
    // module-level ban list. See src/macro-substitution.js's SubstituteParamsContext.bannedWordsSink.
    const bannedWordsSink = [];

    // ---- Step 1: bias strings -----------------------------------------------------------------
    // Built before character-card fields are resolved (matching the task's stage ordering) - the
    // macro context used here has no `characterCard` yet, same as any macro usage that happens to
    // run before the client's own character-card fields are in scope.
    const baseMacroContext = { ...macroFacts, name1, name2, isGroup, groupMembers: groupMemberNames, groupDisabledMembers, chat, chatMetadata, bannedWordsSink };
    const { messageBias, promptBias, isUserPromptBias } = getBiasStrings({
        textareaText, type, chat, userPromptBias, macroContext: baseMacroContext,
    });

    // ---- Step 2: character-card fields ---------------------------------------------------------
    const fields = await getCharacterCardFields(directories, {
        avatar, groupId, preferCharacterPrompt, preferCharacterJailbreak, personaDescription, chatMetadata,
        macroContext: baseMacroContext,
    });

    // Full macro context, now including the resolved character card (field-name mapping: this
    // module's `version` -> SubstituteParamsContext's `charVersion`; `mesExamples` doubles as both
    // `mesExamples`/`mesExamplesRaw` since getCharacterCardFields() only resolves one joined string).
    const macroContext = {
        ...baseMacroContext,
        characterCard: {
            system: fields.system,
            jailbreak: fields.jailbreak,
            description: fields.description,
            personality: fields.personality,
            scenario: fields.scenario,
            persona: fields.persona,
            mesExamples: fields.mesExamples,
            mesExamplesRaw: fields.mesExamples,
            charVersion: fields.version,
            charDepthPrompt: fields.charDepthPrompt,
            creatorNotes: fields.creatorNotes,
        },
    };

    // ---- Step 3: coreChat construction, message finalization, reasoning folding ------------------
    let coreChat = buildCoreChat(chat, { canUseTools, isSwipe });

    // Per-message finalization: regex scripts are REAL (see module doc comment gap 2) -
    // `resolvedMessage` starts as the getRegexedString() result for the message's USER_INPUT/
    // AI_OUTPUT placement, matching public/script.js ~5573-5577 exactly (including the depth
    // formula). File-attachment inlining is NOW REAL too (see module doc comment gap 3) and runs
    // AFTER regex, on top of the regexed text - matching public/script.js ~5578-5582 exactly. This
    // needs real disk I/O (appendFileAttachments() -> readFileAttachment()), so the map callback is
    // async and the whole step is Promise.all-wrapped, same shape as the client's own
    // `coreChat = await Promise.all(coreChat.map(async (chatItem, index) => {...}))`.
    // Mirrors public/script.js's own `chatItem === chat[0] ? substitutedFirstMessage : chatItem.mes`
    // (Generate(), ~line 523): only the opening greeting is stored raw (card-authored text, still
    // carrying literal {{user}}/{{char}} - see public/script.js's getFirstMessage() doc comment on
    // "identity is raw, substitution is a display/generation-time transform"), so only it needs a
    // substitution pass here. Every other message is either user-typed (already substituted at send
    // time by sendMessageAsUser()) or model-generated (no macros to resolve).
    const coreChatLengthForRegex = coreChat.length;
    coreChat = await Promise.all(coreChat.map(async (chatItem, index) => {
        const message = chatItem === chat[0] ? substituteParams(chatItem.mes ?? '', macroContext) : chatItem.mes;
        const regexType = chatItem.is_user ? regex_placement.USER_INPUT : regex_placement.AI_OUTPUT;
        const depth = coreChatLengthForRegex - index - (isContinue ? 2 : 1);
        const regexedMessage = getRegexedString(message, regexType, regexScripts, {
            isPrompt: true, depth, macroContext, regexExtensionEnabled,
        });
        const resolvedMessage = await appendFileAttachments(chatItem.extra, regexedMessage, { directories });
        return finalizeCoreChatMessage(chatItem, index, resolvedMessage);
    }));

    // Reasoning folding: iterates NEWEST -> OLDEST (public/script.js ~5606: `for (i = coreChat.length
    // - 1; i >= 0; i--)`), threading ReasoningFoldState sequentially, breaking once the addition
    // limit is reached - matches the client running this as a SEPARATE loop AFTER the finalization
    // map above (not interleaved with it, despite the two being listed together in this task's
    // stage description; the actual client order was re-verified against public/script.js).
    let reasoningState = createReasoningFoldState();
    const reasoningConfig = {
        addToPrompts: reasoningAddToPrompts, maxAdditions: reasoningMaxAdditions,
        reasoningPrefix, reasoningSeparator, reasoningSuffix, macroContext,
    };
    for (let i = coreChat.length - 1; i >= 0; i--) {
        const isPrefix = isContinue && i === coreChat.length - 1;
        const isOtherGroupMember = isGroup && coreChat[i].name !== name2;
        if (!isOtherGroupMember) {
            const reasoning = String(coreChat[i].extra?.reasoning ?? '');
            const duration = coreChat[i].extra?.reasoning_duration ?? null;
            // REASONING placement regex, applied before folding (public/script.js ~5606-5627) -
            // SAME depth formula as the per-message pass above, reused here per this loop's own `i`.
            const reasoningDepth = coreChat.length - i - (isContinue ? 2 : 1);
            const regexedReasoning = getRegexedString(reasoning, regex_placement.REASONING, regexScripts, {
                isPrompt: true, depth: reasoningDepth, macroContext, regexExtensionEnabled,
            });
            const { content, state } = foldReasoningIntoMessage(reasoningState, coreChat[i].mes, regexedReasoning, isPrefix, duration, reasoningConfig);
            reasoningState = state;
            coreChat[i] = { ...coreChat[i], mes: content };
        }
        if (isReasoningLimitReached(reasoningState, { addToPrompts: reasoningAddToPrompts, maxAdditions: reasoningMaxAdditions })) {
            break;
        }
    }

    // ---- Step 4: max-context resolution + CFG adjustment ------------------------------------------
    const cfgGuidanceScale = getGuidanceScale({ chatGuidanceScale, groupchatIndividualChars, isGroup, charaCfg, globalCfg });
    const { thisMaxContext, negativePrompt, positivePrompt } = await adjustMaxContextForCfg({
        cfgGuidanceScale, thisMaxContext: input.thisMaxContext, countTokens,
        chatMetadataPrompts, charaCfg, globalCfg, promptCombine, promptSeparator, promptInsertionDepth, macroContext,
    });

    // ---- Step 5 (was 6): author's note -------------------------------------------------------------
    // Moved to run BEFORE world-info activation (was previously step 6, after world info) - matching
    // the real client, which resolves the Author's Note (setFloatingPrompt(), public/script.js
    // ~5694) and stashes the quiet-prompt into extension_prompts (~5698, with scan: true) BEFORE
    // calling getWorldInfoPrompt()/checkWorldInfo() (~5710). This ordering matters because
    // checkWorldInfo() (~4800-4807) loops over every extension_prompts entry with `.scan === true`
    // and feeds its text into the World-Info scan buffer via WorldInfoBuffer#addInject() - so the
    // Author's Note's own text (when allowWIScan is on) and the quiet-prompt text can themselves
    // trigger World-Info keyword matches. Nothing else in steps 5-7 (now 6-7) needs `authorsNote`
    // before this point other than this new scan-injection use case - the extension-prompt-table
    // wiring further below reads both `worldInfoDepthEntries` (from world-info activation) and
    // `authorsNote`, but that happens AFTER both are resolved either way, so this reorder doesn't
    // disturb it.
    const authorsNote = resolveAuthorsNote({ chatMetadata, noteSettings, chat, avatar, hasCharacterOrGroup });

    // ---- Step 6 (was 5): world info -------------------------------------------------------------
    const chatForWI = coreChat.map(x => worldInfoIncludeNames ? `${x.name}: ${x.mes}` : x.mes).reverse();
    const decoratedCandidates = worldInfoCandidates.map(entry => {
        const [decorators, content] = parseDecorators(entry.content || '');
        return { ...entry, decorators, content };
    });
    const globalScanData = {
        personaDescription: fields.persona,
        characterDescription: fields.description,
        characterPersonality: fields.personality,
        characterDepthPrompt: fields.charDepthPrompt,
        scenario: fields.scenario,
        creatorNotes: fields.creatorNotes,
        trigger: generationTrigger,
    };
    // additionalScanInjects: mirrors the client's checkWorldInfo() loop over extension_prompts
    // entries with scan === true (public/script.js ~4800-4807), resolved here by the orchestrator
    // (activateWorldInfoEntries() only accepts the already-resolved list - "caller resolves
    // entities", same pattern as externalActivations/worldInfoCandidates):
    //   - the quiet-prompt text, matching the client's unconditional
    //     `setExtensionPrompt(inject_ids.QUIET_PROMPT, quiet_prompt || '', ..., scan=true)`
    //     (public/script.js ~5698 - the 4th positional arg, `true`, is the scan flag) - unconditional
    //     on any noteSettings gate, only filtered for truthiness below.
    //   - the Author's Note's resolved value, only when it isn't disabled and its own `scan` flag
    //     (mirrors noteSettings.allowWIScan - re-verified against public/scripts/authors-note.js's
    //     setFloatingPrompt(): `context.setExtensionPrompt(MODULE_NAME, String(prompt), ...,
    //     extension_settings.note.allowWIScan, ...)`, confirming allowWIScan really is the `scan`
    //     positional argument there) is truthy. `authorsNote.value` is already '' when the note isn't
    //     due to insert this turn (shouldAddPrompt false), so the truthiness filter below also
    //     naturally excludes a not-due note without needing to check shouldAddPrompt explicitly.
    // Falsy/empty entries are filtered out, matching the client's `if (prompt) buffer.addInject(prompt)`.
    const additionalScanInjects = [
        quiet_prompt,
        authorsNote.disabled === false && authorsNote.scan ? authorsNote.value : '',
    ].filter(Boolean);
    const { activatedEntries } = await activateWorldInfoEntries(decoratedCandidates, chatForWI, {
        maxContext: thisMaxContext, budgetPercent: worldInfoBudgetPercent, budgetCap: worldInfoBudgetCap,
        depth: worldInfoDepth, recursive: worldInfoRecursive, maxRecursionStepsSetting: worldInfoMaxRecursionSteps,
        globalScanData, macroContext, countTokens, random: worldInfoRandom, chatMetadata, isDryRun,
        useGroupScoring: worldInfoUseGroupScoring, entryFilterContext,
        minActivations: worldInfoMinActivations, minActivationsDepthMax: worldInfoMinActivationsDepthMax,
        externalActivations, additionalScanInjects,
    });
    // WORLD_INFO placement regex, applied per activated entry (public/scripts/world-info.js ~5289) -
    // NOW REAL (see module doc comment gap 2). Depth override only applies to atDepth-positioned
    // entries; DEFAULT_DEPTH (4) mirrors result-bucketing.js's own (unexported) local constant of
    // the same name/value.
    const WI_DEFAULT_DEPTH = 4;
    const { worldInfoBefore, worldInfoAfter, worldInfoExamples, worldInfoDepth: worldInfoDepthEntries, anBefore, anAfter, outletEntries } =
        bucketActivatedEntries(activatedEntries, {
            resolveContent: (entry) => {
                const regexDepth = entry.position === world_info_position.atDepth ? (entry.depth ?? WI_DEFAULT_DEPTH) : null;
                return getRegexedString(entry.content, regex_placement.WORLD_INFO, regexScripts, {
                    depth: regexDepth, isMarkdown: false, isPrompt: true, macroContext, regexExtensionEnabled,
                });
            },
        });

    // ---- Step 6.5: extension-prompts table (created early) + Author's Note table-write + ---------
    // ---- beforeScenarioAnchor/afterScenarioAnchor resolution ---------------------------------------
    // Builds a FRESH, per-request extension_prompts table (see src/extension-prompt-table.js's module
    // doc comment for why "fresh per request" is the correct server-side equivalent of the client's
    // persistent-but-flushed global). Created HERE (earlier than the rest of the table population,
    // which still happens after assembleStoryString() below, see Step 7.5) because the Author's
    // Note's table-write has to happen BEFORE assembleStoryString() runs: on the real client,
    // setFloatingPrompt() (which is what actually writes the note into extension_prompts) runs before
    // getExtensionPrompt(BEFORE_PROMPT)/getExtensionPrompt(IN_PROMPT) are read at public/script.js
    // ~5773-5776, which in turn happens before renderStoryString() is called - so a note positioned at
    // BEFORE_PROMPT/IN_PROMPT can only ever reach assembleStoryString() if it's written first.
    const extensionPromptTable = createExtensionPromptTable();
    // What the page's extensions inject, then the author's note and the persona's description around it or in the
    // chat (src/prompt-injections.js): before assembleStoryString(), which reads what goes before and after it.
    addPageInjections(extensionPromptTable, input.pageInjections);
    addNoteAndPersona(extensionPromptTable, {
        authorsNote, anBefore, anAfter,
        personaDescription, personaDescriptionPosition, personaDescriptionDepth, personaDescriptionRole,
    });

    // beforeScenarioAnchor/afterScenarioAnchor: NOW resolved for real from the extension-prompt table
    // (see module doc comment gap 1) via the already-committed, SYNCHRONOUS getExtensionPrompt() export
    // (src/extension-prompt-table.js - confirmed sync by reading its signature; no `await` needed,
    // matching how it's already called elsewhere in this file, e.g. inside doChatInject()). The only
    // real source that can ever populate BEFORE_PROMPT/IN_PROMPT in this orchestrator's scope is the
    // Author's Note write just above. The plain caller-supplied `beforeScenarioAnchor`/
    // `afterScenarioAnchor` inputs (default '') are kept as a fallback/override for some other future
    // extension-prompt source - used only when the table-resolved value is empty - but the REAL,
    // resolved table value is what actually flows into assembleStoryString() below whenever the table
    // has non-empty content at that position.
    const resolvedBeforeScenarioAnchor = getExtensionPrompt(
        extensionPromptTable, { position: extension_prompt_types.BEFORE_PROMPT }, macroContext,
    ).trim();
    const resolvedAfterScenarioAnchor = getExtensionPrompt(
        extensionPromptTable, { position: extension_prompt_types.IN_PROMPT }, macroContext,
    ).trim();
    const effectiveBeforeScenarioAnchor = resolvedBeforeScenarioAnchor || beforeScenarioAnchor;
    const effectiveAfterScenarioAnchor = resolvedAfterScenarioAnchor || afterScenarioAnchor;

    // ---- Step 7: story-string assembly ----------------------------------------------------------
    // mesExamplesArray/mesExamplesRawArray: see module doc comment gap (7) - the instruct-mode
    // reformatting gap is now closed; see the comment at the formatInstructModeExamples() call below.
    // The card's example blocks with the lorebook's example-message entries (src/example-blocks.js).
    let mesExamplesArray = exampleBlocks(fields.mesExamples, worldInfoExamples, {
        mainApi, isInstruct, exampleSeparator: contextSettings.example_separator, macroContext,
    });
    const mesExamplesRawArray = [...mesExamplesArray];

    // Instruct-mode example-dialogue reformatting - NOW REAL (see module doc comment gap 7). The raw
    // array above is captured AFTER the WI-EM fold-in loop, exactly like public/script.js (the client
    // captures `mesExamplesRawArray = [...mesExamplesArray]` at line ~5733, AFTER its own identical
    // fold-in loop at ~5715-5729, and only THEN applies `formatInstructModeExamples()` at ~5735-5736
    // when `isInstruct` is true) - so this orchestrator's existing raw-capture line was already
    // correctly positioned; only the missing reformatting call itself needed to be added.
    if (isInstruct) {
        mesExamplesArray = formatInstructModeExamples(mesExamplesArray, name1, name2, {
            instructPreset, contextSettings, isGroup, macroContext,
        });
    }

    const storyStringResult = assembleStoryString({
        description: fields.description, personality: fields.personality, persona: fields.persona, scenario: fields.scenario,
        system: fields.system, name1, name2, worldInfoBefore, worldInfoAfter,
        beforeScenarioAnchor: effectiveBeforeScenarioAnchor, afterScenarioAnchor: effectiveAfterScenarioAnchor,
        mesExamplesArray, mesExamplesRawArray, isInstruct, sysPromptEnabled, sysPromptContent, preferCharacterPrompt,
        personaDescriptionPosition, storyStringTemplate, storyStringPosition, storyStringDepth, storyStringRole,
        instructPreset, contextSettings, stripExamples, mainApi, macroContext,
    });
    const { system, combinedStoryString, storyStringInjection } = storyStringResult;
    mesExamplesArray = storyStringResult.mesExamplesArray;

    // ---- Step 7.5: what goes in the chat at a depth ------------------------------------------------
    // After assembleStoryString(): the story string goes in the chat when its position says so.
    const groupCharacterDepthPrompts = isGroup && hasCharacterOrGroup
        ? await getGroupCharacterDepthPrompts(directories, groupId, avatar, baseMacroContext)
        : [];
    addDepthInjections(extensionPromptTable, {
        worldInfoDepthEntries, storyStringInjection, groupDepthPrompts: groupCharacterDepthPrompts,
        characterDepthPrompt: hasCharacterOrGroup ? { text: fields.charDepthPrompt || '', depth: fields.charDepthPromptDepth, role: fields.charDepthPromptRole } : null,
        depthPromptScan: noteSettings.allowWIScan,
    });

    // doChatInject runs BEFORE jailbreak injection in the real client (public/script.js ~5820 vs
    // ~5823) - `injectedIndices` it returns are already in the "reversed" (newest-first) index
    // convention that injectJailbreak/buildChat2/fillContextBudget all expect (see
    // extension-prompt-table.js's DoChatInjectResult doc comment for exactly why).
    const { coreChat: coreChatAfterDepthInjection, injectedIndices: doChatInjectIndices } = doChatInject(coreChat, isContinue, {
        name1, name2, table: extensionPromptTable, macroContext,
    });

    // `initialInjectedIndices` (a plain caller input, default []) is kept as a fallback/override -
    // some caller might have pre-computed indices via some other mechanism - but when the caller
    // doesn't override it (the default empty-array case), doChatInject's own real output is what
    // actually flows through, instead of always being silently discarded like before this task.
    const effectiveInjectedIndices = initialInjectedIndices.length > 0 ? initialInjectedIndices : doChatInjectIndices;

    // ---- Step 8: jailbreak injection -------------------------------------------------------------
    const { coreChat: coreChatWithJailbreak, injectedIndices: injectedIndicesAfterJailbreak, jailbreak } = injectJailbreak(
        coreChatAfterDepthInjection, effectiveInjectedIndices, {
            mainApi, sysPromptEnabled, jailbreak: fields.jailbreak, preferCharacterJailbreak, sysPromptPostHistory, isContinue, macroContext,
        },
    );

    // ---- Step 9: chat2 construction ---------------------------------------------------------------
    const { chat2, userMessageIndices, userAlignmentMessage, addUserAlignment } = buildChat2(coreChatWithJailbreak, {
        isInstruct, isImpersonate, isContinue, instructPreset, name1, name2, isGroup, instructUserAlignmentMessage, macroContext,
    });

    // force_name2, needed by modifyLastPromptLine (mirrors public/script.js ~5677-5689):
    //   let force_name2 = <caller-supplied Generate() option, undefined by default>;
    //   if (OR-condition) force_name2 = true;
    //   if (isImpersonate) force_name2 = false;
    // Both later assignments are UNCONDITIONAL (they don't check the prior value first), so the
    // OR-condition can override an explicit caller-supplied `false`, and isImpersonate always wins
    // last regardless of anything before it. forceName2Override models the caller-supplied starting
    // value (e.g. generateQuietPrompt() passes `force_name2: true`).
    const orForcesTrue = (promptBias && !isUserPromptBias) || alwaysForceName2 || mainApi === 'novel';
    const force_name2 = isImpersonate
        ? false
        : (orForcesTrue ? true : Boolean(forceName2Override));

    const modifyLastPromptLineParams = {
        quiet_prompt, name1, name2, isInstruct, quietToLoud, type, quietName, isImpersonate, promptBias,
        chat, force_name2, isContinue, isGroup, instructPreset, macroContext,
    };

    // examplesString/chatString mirror the client's Generate()-local vars of the same name (used
    // only to build the baseline token count below) - see src/chat-history-budget.js's module doc
    // comment for baselineTokenCount's exact composition.
    const pinExmString = pinExamples ? mesExamplesArray.join('') : undefined;
    const examplesString = pinExamples ? mesExamplesArray.join('') : '';
    const chatString = addChatsPreamble(addChatsSeparator('', { chatStart, macroContext }), { mainApi, naiPreamble, macroContext });

    async function computeBaselineTokenCount(cyclePromptValue) {
        const encodeString = [
            combinedStoryString, examplesString, userAlignmentMessage, chatString,
            modifyLastPromptLine('', modifyLastPromptLineParams), cyclePromptValue,
        ].join('').replace(/\r/gm, '');
        return (await countPromptTokens(encodeString)) + tokenPadding;
    }

    // ---- Step 10: token-budget fill + example-budget estimate --------------------------------------
    const baselineTokenCount1 = await computeBaselineTokenCount('');
    const { arrMes, injectedIndices: filledInjectedIndices, cyclePrompt } = await fillContextBudget({
        chat2, injectedIndices: injectedIndicesAfterJailbreak, userMessageIndices,
        thisMaxContext, baselineTokenCount: baselineTokenCount1, countTokens,
        userAlignmentMessage, addUserAlignment, isContinue,
    });

    // A fresh, second baseline (NOT a continuation of fillContextBudget's running tokenCount) - now
    // with the real (possibly non-empty) cyclePrompt - mirrors the client's second
    // getMessagesTokenCount() call at public/script.js ~6033.
    const baselineTokenCount2 = await computeBaselineTokenCount(cyclePrompt);
    const { count_exm_add: initialCountExmAdd } = await estimateExampleBudget({
        mesExamplesArray, thisMaxContext, baselineTokenCount: baselineTokenCount2, countTokens, pinExamples,
    });

    // ---- Step 11: mesSend construction -------------------------------------------------------------
    const { mesSend: builtMesSend, generatedPromptCache } = buildMesSend({
        arrMes, cyclePrompt, type, isInstruct, instructWrap,
    });

    // ---- Step 12: prompt-size backoff --------------------------------------------------------------
    const { mesSend, mesExmString } = await resolvePromptStrings({
        mesSend: builtMesSend, mesExamplesArray, countExmAdd: initialCountExmAdd, pinExmString,
        combinedStoryString, generatedPromptCache, thisMaxContext, countTokens: countPromptTokens, mainApi, naiPreamble, chatStart,
        macroContext, modifyLastPromptLineParams,
    });

    // ---- Step 13: CFG prompt for the MAIN (non-negative) prompt -------------------------------------
    // public/script.js ~6315: `let finalPrompt = await getCombinedPrompt(false)` - isNegative=false
    // means the POSITIVE cfg prompt feeds the main combine step; `negativePrompt` is what a SEPARATE
    // cfg-negative-prompt generation call would use (out of scope here - see
    // src/textgen-generation-data.js's own `cfgValues` param for how that separate concern is passed).
    const cfgPrompt = positivePrompt;

    // ---- Step 14: final prompt combination ---------------------------------------------------------
    const { combinedPrompt, finalMesSend, mesSendString } = combineFinalPrompt({
        mesSend, injectedIndices: filledInjectedIndices, cfgPrompt, promptBias, isInstruct, isImpersonate,
        combinedStoryString, mesExmString, generatedPromptCache, chatStart, mainApi, naiPreamble, collapseNewlines, macroContext,
    });

    // ---- Step 15: stopping strings, token bans, logit bias -------------------------------------------
    // `stoppingStringsParams` bundles the raw ingredients getStoppingStrings() needs, MINUS
    // isImpersonate/isContinue/api - kept separate from the resolved `stoppingStrings` array below
    // because createKoboldGenerationData()/createNovelGenerationData() each call getStoppingStrings()
    // THEMSELVES (with their own api/isImpersonate/isContinue derivation - see their own module doc
    // comments), rather than accepting a pre-resolved array the way createTextGenGenerationData() does.
    const stoppingStringsParams = {
        namesAsStopStrings, name1, name2, chat, isGroup, groupMemberNames,
        singleLine, instructPreset, contextSettings, customStoppingStringsRaw, customStoppingStringsMacro,
        ephemeralStoppingStrings, macroContext,
    };
    const stoppingStrings = getStoppingStrings({ ...stoppingStringsParams, isImpersonate, isContinue, api: mainApi });
    // `getCustomTokenBans()`/`calculateLogitBias()` (src/token-bans-and-bias.js) are a
    // textgenerationwebui_settings-SPECIFIC mechanism (banned_tokens/global_banned_tokens/
    // send_banned_tokens/logit_bias, feeding createTextGenGenerationData()'s own bannedTokens/
    // bannedStrings/logitBias params) - Kobold has no analog at all (its own ban mechanism is
    // `use_default_badwordsids`, a boolean the connected backend applies itself, no token-id list is
    // ever sent) and NovelAI has its OWN, differently-shaped mechanism (createNovelGenerationData()
    // computes its own `bad_words_ids`/`logit_bias_exp` internally, straight from `settings.banned_tokens`/
    // `settings.logit_bias`, via its own getBadWordIds()/calculateNovelLogitBias() - see that module's
    // doc comment for why that's a SEPARATE port, not a reuse of this one). So only the
    // textgenerationwebui dispatch branch below uses them, and only there are entries encoded. The
    // ban lines still go through macro substitution for every `mainApi`, for its side effects.
    const isTextgen = mainApi !== 'kobold' && mainApi !== 'novel';
    /** @type {string[]} Entries left out because there is no tokenizer to encode them with. */
    const droppedEntries = [];
    const { banned_tokens: bannedTokens, banned_strings: bannedStrings } = await getCustomTokenBans({
        bannedTokensRaw, globalBannedTokensRaw, sendBannedTokens, bannedWordsFromMacros: bannedWordsSink,
        encode: isTextgen ? encodeTokens : () => null, macroContext,
        dropped: isTextgen ? droppedEntries : undefined,
    });
    const logitBias = isTextgen
        ? await calculateLogitBias({ logitBiasEntries, encode: encodeTokens, dropped: droppedEntries })
        : {};

    // ---- Step 16: final generate_data wire payload ---------------------------------------------------
    // Dispatches on `mainApi`, matching public/script.js's own `switch (main_api)` in Generate()
    // exactly (`case 'kobold':`/`case 'novel':`/`case 'textgenerationwebui':`) - see module doc
    // comment UPDATE note. `koboldhorde` is never reached here (this orchestrator's `mainApi` input
    // is never that value - see text-completion-generation-input.js's own doc comment for why), so
    // there is no third kobold-family branch to add.
    const cfgValues = { guidanceScale: cfgGuidanceScale, negativePrompt: negativePrompt?.value };
    let generate_data;
    if (mainApi === 'kobold') {
        // Mirrors public/script.js's own `getKoboldGenerationData(finalPrompt, presetSettings,
        // maxLength, maxContext, isHorde, type)` call site: `presetSettings` (the client's merged
        // kai_settings-shaped preset object) maps to BOTH this function's `settings` param (used only
        // for the `sampler_order` fallback) and its `koboldSettings` param (the actual sampler
        // fields) - the client passes the SAME object for both call-site roles (verified by reading
        // kai-settings.js's real getKoboldGenerationData() signature: `settings` there IS
        // presetSettings, not a separate merged-preset object), so `settings` (this orchestrator's own
        // `settings` input, resolved by the caller as kai_settings-equivalent) is passed for both here
        // too, matching that same "one object, two roles" shape rather than inventing a second one.
        generate_data = createKoboldGenerationData({
            finalPrompt: combinedPrompt,
            settings,
            maxLength: amountGen,
            maxContextLength: input.maxContext ?? input.thisMaxContext,
            isHorde,
            type,
            koboldSettings: settings,
            koboldFlags,
            apiServer,
            stoppingStringsParams,
            macroContext,
        });
    } else if (mainApi === 'novel') {
        // Mirrors public/script.js's own `getNovelGenerationData(finalPrompt, presetSettings,
        // maxLength, isImpersonate, isContinue, cfgValues, type)` call site - note the real function
        // (src/novel-generation-data.js's createNovelGenerationData(), verified against its own doc
        // comment) never reads a `_cfgValues` argument at all (the client's own leading-underscore
        // param name marks it unused in the ORIGINAL nai-settings.js function too - not a gap
        // introduced by the port), so `cfgValues` is correctly NOT forwarded here.
        generate_data = await createNovelGenerationData({
            finalPrompt: combinedPrompt,
            settings,
            maxLength: amountGen,
            isImpersonate,
            isContinue,
            type,
            novelDataTier,
            presetOrder,
            consoleLogPrompts,
            requestTokenProbabilities,
            stoppingStringsParams,
            tokenizerType: novelTokenizerType,
            encodeTokens: encodeTokensByType,
            dropped: droppedEntries,
            macroContext,
        });
    } else {
        generate_data = await createTextGenGenerationData(settings, model, combinedPrompt, amountGen, isImpersonate, isContinue, cfgValues, type, {
            stoppingStrings, bannedTokens, bannedStrings, logitBias, maxContext: thisMaxContext, requestTokenProbabilities, macroContext,
        });
    }

    return {
        // Final outputs
        combinedPrompt,
        generate_data,
        droppedEntries,
        // Intermediate state, for sanity-checking each stage.
        messageBias, promptBias, isUserPromptBias,
        characterCardFields: fields,
        coreChat: coreChatWithJailbreak,
        thisMaxContext, negativePrompt, positivePrompt,
        worldInfoBefore, worldInfoAfter, worldInfoExamples, worldInfoDepth: worldInfoDepthEntries, anBefore, anAfter, outletEntries,
        authorsNote,
        // The real, table-resolved beforeScenarioAnchor/afterScenarioAnchor values that actually fed
        // assembleStoryString() above (see module doc comment gap 1) - echoed back for sanity-checking,
        // e.g. proving a note positioned at BEFORE_PROMPT/IN_PROMPT resolves here (and NOT via
        // doChatInject/chat splicing), and that an IN_CHAT-positioned note leaves these empty.
        resolvedBeforeScenarioAnchor, resolvedAfterScenarioAnchor,
        system, combinedStoryString, storyStringInjection, mesExamplesArray, mesExamplesRawArray, examplesString,
        jailbreak,
        chat2, userMessageIndices, userAlignmentMessage, addUserAlignment,
        arrMes, cyclePrompt, generatedPromptCache,
        mesSend, mesExmString,
        finalMesSend, mesSendString,
        stoppingStrings, bannedTokens, bannedStrings, logitBias,
        // doChatInject()-equivalent output, echoed back for sanity-checking/debugging - this is what
        // fed `effectiveInjectedIndices` above whenever the caller didn't override it.
        doChatInjectIndices,
        // Documented gaps, echoed back so a caller can see what was NOT wired (see module doc comment).
        gaps: {
            extensionPromptsSideTable: 'worldInfoDepth/storyStringInjection/characterDepthPrompt(single-character AND group-chat, via getGroupCharacterDepthPrompts()) ARE spliced into the chat array via doChatInject() (see module doc comment gap 1). authorsNote is now written at its REAL position (any of IN_CHAT/BEFORE_PROMPT/IN_PROMPT) - IN_CHAT is spliced via doChatInject(), BEFORE_PROMPT/IN_PROMPT is resolved into beforeScenarioAnchor/afterScenarioAnchor (now CLOSED, see resolvedBeforeScenarioAnchor/resolvedAfterScenarioAnchor above). outletEntries is still NOT wired into anything - still open.',
        },
    };
}

/**
 * Maps assembleTextCompletionPrompt()'s own return shape onto the field names
 * public/scripts/itemized-prompts.js's `itemizedPrompts` entries actually use (the same names
 * public/scripts/generation.js's non-raw-action Generate() locals of the same purpose use, since a
 * raw-action request skips that local assembly entirely - see generation.js's own gate at
 * `if (!rawActionGenerateData && !rawActionChatCompletionData)`). Shared by every raw-action
 * text-completion-family caller (text-completions.js's buildRawActionTextCompletionRequest(),
 * kobold.js's buildRawActionKoboldRequest()) so the mapping can't drift between them.
 * `worldInfoString`: mirrors public/scripts/world-info.js's own `getWorldInfoPrompt()`
 * (`worldInfoString = worldInfoBefore + worldInfoAfter`) exactly.
 * `finalPrompt`/`rawPrompt`: both the server's actual, fully-assembled prompt text
 * (`combinedPrompt`) - `finalPrompt` is what itemizedParams() sums for "Total Tokens in Prompt",
 * `rawPrompt` is what "Show Raw Prompt"/the diff-vs-previous feature displays; both were sourced
 * from the same finalPrompt local pre-raw-action, so both take the same value here too.
 * @param {Awaited<ReturnType<typeof assembleTextCompletionPrompt>>} assembled
 * @returns {Record<string, *>}
 */
export function buildItemizationBreakdown(assembled) {
    return {
        storyString: assembled.combinedStoryString,
        worldInfoString: (assembled.worldInfoBefore || '') + (assembled.worldInfoAfter || ''),
        examplesString: assembled.examplesString || '',
        mesSendString: assembled.mesSendString,
        promptBias: assembled.promptBias,
        generatedPromptCache: assembled.generatedPromptCache,
        beforeScenarioAnchor: assembled.resolvedBeforeScenarioAnchor,
        afterScenarioAnchor: assembled.resolvedAfterScenarioAnchor,
        finalPrompt: assembled.combinedPrompt,
        rawPrompt: assembled.combinedPrompt,
    };
}
