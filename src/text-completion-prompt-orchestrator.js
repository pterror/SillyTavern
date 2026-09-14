import { getBiasStrings } from './prompt-line-formatting.js';
import { getCharacterCardFields } from './character-card-fields.js';
import { buildCoreChat, finalizeCoreChatMessage } from './core-chat-build.js';
import { createReasoningFoldState, foldReasoningIntoMessage, isReasoningLimitReached } from './reasoning-fold.js';
import { getGuidanceScale, adjustMaxContextForCfg } from './cfg-prompt-resolve.js';
import { parseDecorators } from './world-info/decorators.js';
import { activateWorldInfoEntries } from './world-info/activation.js';
import { bucketActivatedEntries, wi_anchor_position, world_info_position } from './world-info/result-bucketing.js';
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
import { baseChatReplace } from './macro-substitution.js';
import { formatInstructModeExamples } from './instruct-mode-examples.js';
import { createExtensionPromptTable, setExtensionPrompt, doChatInject, extension_prompt_types } from './extension-prompt-table.js';

/**
 * Server-side orchestrator that reproduces the TEXT-COMPLETION-ONLY prompt-assembly pipeline of
 * public/script.js's Generate() (main_api !== 'openai'), by wiring together the ~18 independently
 * ported/tested modules under src/ - each of those modules is a faithful, pure-computation port of
 * one stage of Generate(), and (before this file) none of them called each other. This is the
 * integration point.
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
 *      - `authorsNote.value` - written into the table (as an IN_CHAT depth injection) and spliced in
 *        the same way, but ONLY when `authorsNote.position === extension_prompt_types.IN_CHAT` (see
 *        the inline judgment-call comment at the call site) - `resolveAuthorsNote()`'s own doc
 *        comment establishes that `position` already IS an extension_prompt_types value, so this is
 *        the accurate behavior, not a simplification of an unclear mapping. When the note is actually
 *        due this turn (`authorsNote.shouldAddPrompt`), `anBefore`/`anAfter` (bucketActivatedEntries's
 *        WI ANTop/ANBottom output) are now combined into the injected value exactly like the client
 *        (`${anBefore}\n${note}\n${anAfter}`, stripping at most one leading/trailing newline) - this
 *        closes the anBefore/anAfter gap for the note-injection path.
 *      - `storyStringInjection` (from assembleStoryString, when the story string is configured to
 *        inject in-chat instead of at the top) - written into the table and spliced in the same way.
 *      - `injectedIndices` fed into injectJailbreak/buildChat2/fillContextBudget/combineFinalPrompt is
 *        now the REAL output of the doChatInject()-equivalent (`doChatInjectIndices`) whenever the
 *        caller doesn't override it - `initialInjectedIndices` (the old plain input, default `[]`) is
 *        kept only as a fallback/override for a caller with its own pre-computed indices.
 *    What is STILL NOT wired (separate, still-open gaps, deliberately out of scope for this task):
 *      - `outletEntries` (from bucketActivatedEntries) - still never delivered to whatever "outlet"
 *        consumer would read it.
 *      - `beforeScenarioAnchor`/`afterScenarioAnchor` (BEFORE_PROMPT/IN_PROMPT anchors) - still taken
 *        as plain caller-supplied inputs (default '') rather than resolved from the live table (and,
 *        per the author's-note judgment call above, an AN with position IN_PROMPT/BEFORE_PROMPT would
 *        belong here too, but is not resolved into these anchors by this orchestrator).
 *      - The quiet-prompt/CFG-depth-splice/PHI-via-extension-prompts mechanisms the client also
 *        threads through this same table are not modeled here at all as TABLE entries - only the
 *        three sources listed above are written into the table by this orchestrator. (As of the
 *        Author's-Note/World-Info ordering fix below, the quiet-prompt text IS now used for one
 *        narrow purpose - feeding World-Info's scan buffer, matching the client's own transient
 *        `setExtensionPrompt(inject_ids.QUIET_PROMPT, ..., scan=true)` / immediate-clear pattern at
 *        public/script.js ~5698/~5711 - but it is still never written into THIS orchestrator's
 *        extension-prompt table nor spliced into the chat array as an actual injection, since the
 *        client itself clears that slot again immediately after the world-info call and never lets it
 *        reach doChatInject().)
 *      - The character card's own `depth_prompt` field
 *        (`character.data.extensions.depth_prompt.{prompt, depth, role}`) - SINGLE-CHARACTER case NOW
 *        CLOSED, as of this task. The client stashes this into `extension_prompts` as an ACTUAL
 *        IN-CHAT depth injection (public/script.js ~5552-5558: `setExtensionPrompt(inject_ids.
 *        DEPTH_PROMPT, depthPromptText, IN_CHAT, depthPromptDepth, extension_settings.note.
 *        allowWIScan, depthPromptRole)`), separately from the already-correct "characterDepthPrompt
 *        available for WI key-matching via globalScanData" mechanism (which
 *        src/character-card-fields.js's `charDepthPrompt` field / src/world-info/key-matching.js's
 *        `entry.matchCharacterDepthPrompt` check already handle correctly - that part is fine, was
 *        not touched). `getCharacterCardFields()` now also resolves the `depth`/`role` sub-fields
 *        (`charDepthPromptDepth`/`charDepthPromptRole`), and this orchestrator writes them into the
 *        extension-prompt table (entry 4, alongside world-info/author's-note/story-string above) and
 *        therefore into `mesSend`/`combinedPrompt` via the same `doChatInject()` mechanism - but ONLY
 *        for the single-character (non-group) case, i.e. `hasCharacterOrGroup && !isGroup`.
 *        STILL OPEN, deliberately out of scope for this task: the GROUP-CHAT variant
 *        (`getGroupDepthPrompts()`, public/script.js's per-group-member depth-prompt resolution,
 *        used instead of the single-character branch whenever `selected_group` is set and produces
 *        one or more entries) - resolving each group member's own `depth_prompt` field and injecting
 *        one entry per member is a distinct, separate concern from the single-character wiring closed
 *        here, and remains unimplemented.
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
 * 7. `parseMesExamples()` (public/script.js) is still NOT among the 18 ported modules this task
 *    wires together - it remains a minimal, clearly-marked local adapter (`parseMesExamplesBlocks`
 *    below), used only to get assembleStoryString() a `mesExamplesArray`/raw array to consume at
 *    all. `formatInstructModeExamples()` (public/scripts/instruct-mode.js) IS NOW a real, separately
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

/**
 * Mirrors public/script.js's parseMesExamples() (~line 4556) exactly (that function itself never
 * calls formatInstructModeExamples() - see gap (7) above for where that separately-ported function
 * is actually applied, downstream of this adapter). A small local adapter, not one of the 18 ported
 * modules.
 * @param {string} examplesStr
 * @param {boolean} isInstruct
 * @param {string} [exampleSeparator] Equivalent of power_user.context.example_separator (already macro-substituted).
 * @returns {string[]}
 */
// Mirrors public/scripts/constants.js's GENERATION_TYPE_TRIGGERS exactly.
const GENERATION_TYPE_TRIGGERS = ['normal', 'continue', 'impersonate', 'swipe', 'regenerate'];

function parseMesExamplesBlocks(examplesStr, isInstruct, exampleSeparator = '') {
    if (!examplesStr || examplesStr.length === 0 || examplesStr === '<START>') {
        return [];
    }
    if (!examplesStr.startsWith('<START>')) {
        examplesStr = '<START>\n' + examplesStr.trim();
    }
    const separatorBlock = exampleSeparator ? `${exampleSeparator}\n` : '';
    const blockHeading = isInstruct ? '<START>\n' : separatorBlock;
    return examplesStr.split(/<START>/gi).slice(1).map(block => `${blockHeading}${block.trim()}\n`);
}

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
 * @property {boolean} [canUseTools] Resolved result of ToolManager.isToolCallingSupported() (out of scope here). Default false.
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
 * @property {number} thisMaxContext Equivalent of getMaxPromptTokens() - the pre-CFG-adjustment max context.
 * @property {number} [tokenPadding] Equivalent of power_user.token_padding - added on top of every
 *   countTokens() result wherever the client bakes padding into getTokenCountAsync() calls. Default 0.
 * @property {(text: string) => Promise<number>} countTokens REQUIRED. Real tokenization needs
 *   src/tokenizer-resolve.js's encodeWithTokenizerType() plus a resolved backend/model context -
 *   a separate resolution concern from this orchestrator. Callers must resolve a real tokenizer
 *   and inject it here (or, for tests, a simple deterministic fake).
 * @property {(text: string) => number[] | Promise<number[]>} encodeTokens REQUIRED. Distinct from
 *   `countTokens` - returns token IDS (for getCustomTokenBans()/calculateLogitBias()), not a count.
 *   May be async (e.g. src/tokenizer-resolve.js's encodeWithTokenizerType(), which can probe a
 *   remote backend) - both functions now await it, so a real async tokenizer can be wired in
 *   directly.
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
 * @property {number} [personaDescriptionPosition]
 * @property {boolean} [stripExamples]
 * @property {string} [beforeScenarioAnchor] See gap (1) above - plain input, default ''.
 * @property {string} [afterScenarioAnchor] See gap (1) above - plain input, default ''.
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
 * @property {{name?: string}[]} [groupMemberNames]
 * @property {string} [bannedTokensRaw]
 * @property {string} [globalBannedTokensRaw]
 * @property {boolean} [sendBannedTokens]
 * @property {import('./token-bans-and-bias.js').LogitBiasEntry[]} [logitBiasEntries]
 *
 * --- Final generation-data wire payload ---------------------------------------------------------------
 * @property {object} settings textgenerationwebui_settings-equivalent, forwarded to createTextGenGenerationData().
 * @property {string} [model] Already-resolved model name.
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
        tokenPadding = 0, countTokens, encodeTokens, amountGen = 0, requestTokenProbabilities = false,
        chatGuidanceScale, groupchatIndividualChars = false, charaCfg, globalCfg, promptCombine = [], promptSeparator, promptInsertionDepth = 1, chatMetadataPrompts = {},
        worldInfoCandidates = [], worldInfoIncludeNames = false, worldInfoBudgetPercent = 25, worldInfoBudgetCap = 0,
        worldInfoDepth = 2, worldInfoRecursive = true, worldInfoMaxRecursionSteps = 0,
        worldInfoMinActivations = 0, worldInfoMinActivationsDepthMax = 0, worldInfoUseGroupScoring = false,
        entryFilterContext = {}, externalActivations = new Map(), worldInfoRandom = Math.random,
        noteSettings = {}, hasCharacterOrGroup = false,
        storyStringTemplate = '', storyStringPosition = 0, storyStringDepth = 1, storyStringRole = 0,
        sysPromptEnabled = false, sysPromptContent = '', personaDescriptionPosition = 0, stripExamples = false,
        beforeScenarioAnchor = '', afterScenarioAnchor = '',
        isInstruct = false, instructPreset = {}, contextSettings = {}, instructUserAlignmentMessage,
        instructWrap = false, pinExamples = false,
        sysPromptPostHistory = '', injectedIndices: initialInjectedIndices = [],
        mainApi, naiPreamble = '', chatStart = '', collapseNewlines = false,
        namesAsStopStrings = false, singleLine = false, customStoppingStringsRaw, customStoppingStringsMacro = false,
        ephemeralStoppingStrings = [], groupMemberNames = [],
        bannedTokensRaw = '', globalBannedTokensRaw = '', sendBannedTokens = false, logitBiasEntries = [],
        settings = {}, model,
    } = input;

    if (typeof countTokens !== 'function') throw new Error('assembleTextCompletionPrompt: countTokens is required');
    if (typeof encodeTokens !== 'function') throw new Error('assembleTextCompletionPrompt: encodeTokens is required');

    // Shared side effect sink for the {{banned "..."}} macro, threaded through every substituteParams
    // call this orchestrator triggers (directly or via a downstream module), same as the client's
    // module-level ban list. See src/macro-substitution.js's SubstituteParamsContext.bannedWordsSink.
    const bannedWordsSink = [];

    // ---- Step 1: bias strings -----------------------------------------------------------------
    // Built before character-card fields are resolved (matching the task's stage ordering) - the
    // macro context used here has no `characterCard` yet, same as any macro usage that happens to
    // run before the client's own character-card fields are in scope.
    const baseMacroContext = { name1, name2, isGroup, chat, chatMetadata, bannedWordsSink };
    const { messageBias, promptBias, isUserPromptBias } = getBiasStrings({
        textareaText, type, chat, userPromptBias, macroContext: baseMacroContext,
    });

    // ---- Step 2: character-card fields ---------------------------------------------------------
    const fields = await getCharacterCardFields(directories, {
        avatar, groupId, preferCharacterPrompt, preferCharacterJailbreak, personaDescription, chatMetadata,
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
    const coreChatLengthForRegex = coreChat.length;
    coreChat = await Promise.all(coreChat.map(async (chatItem, index) => {
        const regexType = chatItem.is_user ? regex_placement.USER_INPUT : regex_placement.AI_OUTPUT;
        const depth = coreChatLengthForRegex - index - (isContinue ? 2 : 1);
        const regexedMessage = getRegexedString(chatItem.mes, regexType, regexScripts, {
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

    // ---- Step 7: story-string assembly ----------------------------------------------------------
    // mesExamplesArray/mesExamplesRawArray: see module doc comment gap (7) - the instruct-mode
    // reformatting gap is now closed; see the comment at the formatInstructModeExamples() call below.
    const exampleSeparator = contextSettings.example_separator || '';
    let mesExamplesArray = parseMesExamplesBlocks(fields.mesExamples, isInstruct, exampleSeparator);

    // Fold in message-example (EM) world-info entries, mirroring public/script.js ~5715-5729.
    for (const example of worldInfoExamples) {
        if (!example.content || example.content.length === 0) continue;
        const formattedExample = baseChatReplace(example.content);
        const cleanedExample = parseMesExamplesBlocks(formattedExample, isInstruct, exampleSeparator);
        if (example.position === wi_anchor_position.before) {
            mesExamplesArray.unshift(...cleanedExample);
        } else {
            mesExamplesArray.push(...cleanedExample);
        }
    }
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
        system: fields.system, name1, name2, worldInfoBefore, worldInfoAfter, beforeScenarioAnchor, afterScenarioAnchor,
        mesExamplesArray, mesExamplesRawArray, isInstruct, sysPromptEnabled, sysPromptContent, preferCharacterPrompt,
        personaDescriptionPosition, storyStringTemplate, storyStringPosition, storyStringDepth, storyStringRole,
        instructPreset, contextSettings, stripExamples, mainApi,
    });
    const { system, combinedStoryString, storyStringInjection } = storyStringResult;
    mesExamplesArray = storyStringResult.mesExamplesArray;

    // ---- Step 7.5: extension-prompts table + depth-indexed chat injection -------------------------
    // Builds a FRESH, per-request extension_prompts table (see src/extension-prompt-table.js's module
    // doc comment for why "fresh per request" is the correct server-side equivalent of the client's
    // persistent-but-flushed global) and populates it with the three depth-indexed injection sources
    // this task wires up (see module doc comment gap 1 below for what's still NOT included: anBefore/
    // anAfter and outletEntries).
    const extensionPromptTable = createExtensionPromptTable();

    // 1. World-info @Depth entries (bucketActivatedEntries's worldInfoDepth output).
    for (const depthEntry of worldInfoDepthEntries) {
        setExtensionPrompt(
            extensionPromptTable,
            `wi_depth_${depthEntry.depth}_${depthEntry.role}`,
            depthEntry.entries.join('\n'),
            extension_prompt_types.IN_CHAT,
            depthEntry.depth,
            false,
            depthEntry.role,
        );
    }

    // 2. Author's note. JUDGMENT CALL: resolveAuthorsNote()'s own doc comment states `authorsNote.
    // position` is "One of extension_prompt_types positions" - i.e. it is NOT an ambiguous value that
    // needs guessing at, it already IS an extension_prompt_types member (public/scripts/authors-note.js
    // stores whatever the client's AN position dropdown holds, which is an extension_prompt_types
    // value). So rather than the "always treat as IN_CHAT" simplification this task's instructions
    // allow for an unclear mapping, this wiring honors the real value: the note is only fed into THIS
    // table (and therefore only reachable via doChatInject) when position === IN_CHAT. When position
    // is IN_PROMPT or BEFORE_PROMPT, the note belongs to the beforeScenarioAnchor/afterScenarioAnchor
    // mechanism instead - which is a SEPARATE, already-documented gap (module doc comment gap 1) that
    // this task does not solve - so such notes remain unwired here, deliberately.
    //
    // WI ANTop/ANBottom combination (public/script.js ~5352-5356): when the note is actually due to
    // be inserted this turn (`shouldWIAddPrompt`, i.e. resolveAuthorsNote()'s `shouldAddPrompt`), the
    // client REPLACES the plain note value with `${ANTop}\n${note}\n${ANBottom}`, stripping at most
    // ONE leading and ONE trailing newline (the client's regex `/(^\n)|(\n$)/g` only ever matches each
    // anchor once, not every run of newlines - do not "fix" this into a stricter trim). This closes
    // the anBefore/anAfter part of gap 1 below for the note-injection path specifically (outletEntries
    // and the before/after scenario anchors remain separately unwired, as documented).
    if (authorsNote.disabled === false && authorsNote.position === extension_prompt_types.IN_CHAT) {
        const noteValue = authorsNote.shouldAddPrompt
            ? `${anBefore.join('\n')}\n${authorsNote.value}\n${anAfter.join('\n')}`.replace(/(^\n)|(\n$)/g, '')
            : authorsNote.value;
        setExtensionPrompt(
            extensionPromptTable, 'authors_note', noteValue,
            extension_prompt_types.IN_CHAT, authorsNote.depth, false, authorsNote.role,
        );
    }

    // 3. Story-string-in-chat injection (assembleStoryString's storyStringInjection output, non-null
    // only when power_user.context.story_string_position === IN_CHAT on the client).
    if (storyStringInjection) {
        setExtensionPrompt(
            extensionPromptTable, 'story_string', storyStringInjection.content,
            extension_prompt_types.IN_CHAT, storyStringInjection.depth, false, storyStringInjection.role,
        );
    }

    // 4. Character card's own depth_prompt (public/script.js ~5552-5558), SINGLE-CHARACTER case only
    // (matches this task's scope - the group-chat variant, per-member depth prompts via
    // getGroupDepthPrompts(), is a separate, still-open sub-gap; see module doc comment gap 1). Only
    // written when a character/group is actually selected and this ISN'T a group chat, and only when
    // the resolved text is non-empty - matching the general "don't write empty entries" pattern the
    // other three sources above already follow (world-info entries only exist when activated; the
    // author's-note/story-string entries are behind their own truthiness/non-null guards). The `scan`
    // argument reuses `noteSettings.allowWIScan` - the same input this orchestrator already threads
    // through for the author's-note's OWN scan flag (see `additionalScanInjects` above) - matching the
    // client's literal `extension_settings.note.allowWIScan` argument at this call site.
    if (hasCharacterOrGroup && !isGroup && fields.charDepthPrompt) {
        setExtensionPrompt(
            extensionPromptTable, 'depth_prompt', fields.charDepthPrompt || '',
            extension_prompt_types.IN_CHAT, fields.charDepthPromptDepth, noteSettings.allowWIScan, fields.charDepthPromptRole,
        );
    }

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
        chat, force_name2, isContinue, isGroup, instructPreset,
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
        return (await countTokens(encodeString)) + tokenPadding;
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
        combinedStoryString, generatedPromptCache, thisMaxContext, countTokens, mainApi, naiPreamble, chatStart,
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
    const stoppingStrings = getStoppingStrings({
        isImpersonate, isContinue, api: mainApi, namesAsStopStrings, name1, name2, chat, isGroup, groupMemberNames,
        singleLine, instructPreset, contextSettings, customStoppingStringsRaw, customStoppingStringsMacro,
        ephemeralStoppingStrings, macroContext,
    });
    const { banned_tokens: bannedTokens, banned_strings: bannedStrings } = await getCustomTokenBans({
        bannedTokensRaw, globalBannedTokensRaw, sendBannedTokens, bannedWordsFromMacros: bannedWordsSink,
        encode: encodeTokens, macroContext,
    });
    const logitBias = await calculateLogitBias({ logitBiasEntries, encode: encodeTokens });

    // ---- Step 16: final generate_data wire payload ---------------------------------------------------
    const cfgValues = { guidanceScale: cfgGuidanceScale, negativePrompt: negativePrompt?.value };
    const generate_data = createTextGenGenerationData(settings, model, combinedPrompt, amountGen, isImpersonate, isContinue, cfgValues, type, {
        stoppingStrings, bannedTokens, bannedStrings, logitBias, maxContext: thisMaxContext, requestTokenProbabilities, macroContext,
    });

    return {
        // Final outputs
        combinedPrompt,
        generate_data,
        // Intermediate state, for sanity-checking each stage.
        messageBias, promptBias, isUserPromptBias,
        characterCardFields: fields,
        coreChat: coreChatWithJailbreak,
        thisMaxContext, negativePrompt, positivePrompt,
        worldInfoBefore, worldInfoAfter, worldInfoExamples, worldInfoDepth: worldInfoDepthEntries, anBefore, anAfter, outletEntries,
        authorsNote,
        system, combinedStoryString, storyStringInjection, mesExamplesArray, mesExamplesRawArray,
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
            extensionPromptsSideTable: 'worldInfoDepth/authorsNote(IN_CHAT)/storyStringInjection/characterDepthPrompt(single-character only) ARE now spliced into the chat array via doChatInject() (see module doc comment gap 1). anBefore/anAfter (WI-combined-with-AN), outletEntries, and the GROUP-CHAT depth-prompt variant (getGroupDepthPrompts()) are still NOT wired into anything - still open.',
        },
    };
}
