import { getBiasStrings } from './prompt-line-formatting.js';
import { getCharacterCardFields } from './character-card-fields.js';
import { buildCoreChat, finalizeCoreChatMessage } from './core-chat-build.js';
import { createReasoningFoldState, foldReasoningIntoMessage, isReasoningLimitReached } from './reasoning-fold.js';
import { getGuidanceScale, adjustMaxContextForCfg } from './cfg-prompt-resolve.js';
import { parseDecorators } from './world-info/decorators.js';
import { activateWorldInfoEntries } from './world-info/activation.js';
import { bucketActivatedEntries, wi_anchor_position } from './world-info/result-bucketing.js';
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
 * 1. THE `extension_prompts` SIDE-TABLE (the single most significant remaining gap). The client
 *    keeps a live, depth-indexed table of injected content (world-info @Depth entries, the
 *    author's-note text combined with WI ANTop/ANBottom entries, the quiet-prompt, jailbreak/PHI
 *    injected via a different mechanism, the story-string-as-in-chat injection, CFG's own depth
 *    splice, etc.) via setExtensionPrompt()/getExtensionPrompt(), and *threads all of it into
 *    `mesSend[i].extensionPrompts` before the final combine step* (see public/script.js's
 *    `doChatInject()`, and the `chat2[i] = ... + extensionPrompt` wiring throughout Generate()).
 *    No such side-table exists server-side. This orchestrator computes every INPUT to that
 *    table as a separate, plain output value instead:
 *      - `worldInfoDepth` (from bucketActivatedEntries) - @Depth world-info entries, never spliced
 *        into `mesSend[i].extensionPrompts`.
 *      - `anBefore`/`anAfter` (from bucketActivatedEntries) plus `authorsNote.value` (from
 *        resolveAuthorsNote) - never combined into a single ANTop+note+ANBottom string, never
 *        injected at `authorsNote.depth`.
 *      - `outletEntries` (from bucketActivatedEntries) - never delivered to whatever "outlet"
 *        consumer would read it.
 *      - `beforeScenarioAnchor`/`afterScenarioAnchor` (BEFORE_PROMPT/IN_PROMPT anchors) - taken as
 *        plain caller-supplied inputs (default '') rather than resolved from a live table.
 *      - `storyStringInjection` (from assembleStoryString, when the story string is configured to
 *        inject in-chat instead of at the top) - returned as a separate value, never spliced back in.
 *      - `injectedIndices` fed into injectJailbreak/buildChat2/fillContextBudget/combineFinalPrompt
 *        is a plain input (default `[]`), NOT the result of the client's doChatInject() - which is
 *        itself unported (it resolves depth-indexed injections against the live extension_prompts
 *        table, a mechanism that doesn't exist here).
 *    Building a real extension_prompts model (and wiring these depth-indexed injections into
 *    `mesSend` for real, matching `chat2[i] += extensionPrompt` byte-for-byte) is real, nontrivial,
 *    NOT-YET-DONE future work - not merely a missing input value.
 *
 * 2. Regex-scripts engine (getRegexedString) - every message/world-info-entry/reasoning-block
 *    content that the client would run through the user's regex scripts is passed through
 *    UNCHANGED here. See finalizeCoreChatMessage's `resolvedMessage` param (this file passes
 *    `chatItem.mes` verbatim - a literal no-op "resolver", clearly marked below) and
 *    bucketActivatedEntries's `resolveContent` param (this file passes `(entry) => entry.content`).
 *
 * 3. File-attachment inlining (appendFileContent) - same no-op treatment, folded into the same
 *    "resolvedMessage" no-op as (2) above (a real pipeline would run regex AND attachment-inlining
 *    before core-chat-build ever sees the text).
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
 * 7. `parseMesExamples()` / `formatInstructModeExamples()` (public/script.js /
 *    public/scripts/instruct-mode.js) are NOT among the 18 ported modules this task wires
 *    together, and are not ported by this file either - they are small enough that a minimal,
 *    clearly-marked local adapter (`parseMesExamplesBlocks` below) is used instead, so
 *    assembleStoryString() has a `mesExamplesArray`/`mesExamplesRawArray` to consume at all.
 *    Known limitation of that adapter: it does NOT apply `formatInstructModeExamples()`'s
 *    instruct-mode-specific reformatting (input/output sequence wrapping per example block) -
 *    `mesExamplesArray` and `mesExamplesRawArray` end up IDENTICAL even when `isInstruct` is true.
 *    This is a real accuracy gap for instruct-mode example-dialogue formatting specifically (the
 *    rest of instruct-mode formatting - message history, story string, stopping sequences - goes
 *    through the real ported modules and IS accurate).
 *
 * 8. `GENERATION_TYPE_TRIGGERS.includes(type)` (deciding whether world-info's `globalScanData.trigger`
 *    is the generation `type` or the literal string `'normal'`) is a small static list that isn't
 *    part of the 18 ported modules. This orchestrator takes `generationTrigger` as a plain optional
 *    input (defaulting to `'normal'`) instead of re-deriving it from `type`.
 *
 * Everything else - character-card resolution, reasoning folding, world-info key-matching/
 * activation/bucketing, author's-note interval math, story-string rendering, jailbreak injection,
 * the chat2/token-budget-fill/mesSend pipeline, prompt-size backoff, CFG max-context adjustment,
 * final-prompt combination, stopping strings, token bans, logit bias, and the textgen wire payload -
 * all go through the real ported module for that stage.
 */

/**
 * Mirrors public/script.js's parseMesExamples() (~line 4556), MINUS the main_api==='openai'/
 * isInstruct blockHeading branch's call into formatInstructModeExamples() - see gap (7) above.
 * A small local adapter, not one of the 18 ported modules.
 * @param {string} examplesStr
 * @param {boolean} isInstruct
 * @param {string} [exampleSeparator] Equivalent of power_user.context.example_separator (already macro-substituted).
 * @returns {string[]}
 */
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
 * @property {string} [generationTrigger] See gap (8) above. Default 'normal'.
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
 * --- Context/token budget -------------------------------------------------------------------------
 * @property {number} thisMaxContext Equivalent of getMaxPromptTokens() - the pre-CFG-adjustment max context.
 * @property {number} [tokenPadding] Equivalent of power_user.token_padding - added on top of every
 *   countTokens() result wherever the client bakes padding into getTokenCountAsync() calls. Default 0.
 * @property {(text: string) => Promise<number>} countTokens REQUIRED. Real tokenization needs
 *   src/tokenizer-resolve.js's encodeWithTokenizerType() plus a resolved backend/model context -
 *   a separate resolution concern from this orchestrator. Callers must resolve a real tokenizer
 *   and inject it here (or, for tests, a simple deterministic fake).
 * @property {(text: string) => number[]} encodeTokens REQUIRED. Distinct from `countTokens` -
 *   returns token IDS (for getCustomTokenBans()/calculateLogitBias()), not a count.
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
 * @property {number[]} [injectedIndices] See gap (1) above - plain input, default []. Equivalent of
 *   the client's doChatInject() result, which is not ported.
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
        canUseTools = false, quiet_prompt, quietToLoud = false, quietName, generationTrigger = 'normal',
        name1 = '', name2 = '',
        directories, avatar, groupId, preferCharacterPrompt = false, preferCharacterJailbreak = false,
        personaDescription, chatMetadata = {}, chat, textareaText = '', userPromptBias = '',
        alwaysForceName2 = false, forceName2Override,
        reasoningAddToPrompts = false, reasoningMaxAdditions = 999999, reasoningPrefix = '', reasoningSeparator = '', reasoningSuffix = '',
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

    // Per-message finalization: regex scripts / file-attachment inlining are OUT OF SCOPE (see
    // module doc comment gaps 2-3) - `resolvedMessage` is a literal no-op pass-through of the raw
    // message text. A real pipeline would run getRegexedString()/appendFileContent() here first.
    coreChat = coreChat.map((chatItem, index) => finalizeCoreChatMessage(chatItem, index, chatItem.mes));

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
            const { content, state } = foldReasoningIntoMessage(reasoningState, coreChat[i].mes, reasoning, isPrefix, duration, reasoningConfig);
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

    // ---- Step 5: world info -------------------------------------------------------------------
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
    const { activatedEntries } = await activateWorldInfoEntries(decoratedCandidates, chatForWI, {
        maxContext: thisMaxContext, budgetPercent: worldInfoBudgetPercent, budgetCap: worldInfoBudgetCap,
        depth: worldInfoDepth, recursive: worldInfoRecursive, maxRecursionStepsSetting: worldInfoMaxRecursionSteps,
        globalScanData, macroContext, countTokens, random: worldInfoRandom, chatMetadata, isDryRun,
        useGroupScoring: worldInfoUseGroupScoring, entryFilterContext,
        minActivations: worldInfoMinActivations, minActivationsDepthMax: worldInfoMinActivationsDepthMax,
        externalActivations,
    });
    // Regex-scripts resolution is OUT OF SCOPE (see gap 2) - resolveContent is a literal identity
    // pass-through of each activated entry's (already macro-substituted) content.
    const { worldInfoBefore, worldInfoAfter, worldInfoExamples, worldInfoDepth: worldInfoDepthEntries, anBefore, anAfter, outletEntries } =
        bucketActivatedEntries(activatedEntries, { resolveContent: (entry) => entry.content });

    // ---- Step 6: author's note -----------------------------------------------------------------
    const authorsNote = resolveAuthorsNote({ chatMetadata, noteSettings, chat, avatar, hasCharacterOrGroup });

    // ---- Step 7: story-string assembly ----------------------------------------------------------
    // mesExamplesArray/mesExamplesRawArray: see module doc comment gap (7) for the parseMesExamples
    // adapter's known limitation (no formatInstructModeExamples() reformatting).
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

    const storyStringResult = assembleStoryString({
        description: fields.description, personality: fields.personality, persona: fields.persona, scenario: fields.scenario,
        system: fields.system, name1, name2, worldInfoBefore, worldInfoAfter, beforeScenarioAnchor, afterScenarioAnchor,
        mesExamplesArray, mesExamplesRawArray, isInstruct, sysPromptEnabled, sysPromptContent, preferCharacterPrompt,
        personaDescriptionPosition, storyStringTemplate, storyStringPosition, storyStringDepth, storyStringRole,
        instructPreset, contextSettings, stripExamples, mainApi,
    });
    const { system, combinedStoryString, storyStringInjection } = storyStringResult;
    mesExamplesArray = storyStringResult.mesExamplesArray;

    // ---- Step 8: jailbreak injection -------------------------------------------------------------
    const { coreChat: coreChatWithJailbreak, injectedIndices: injectedIndicesAfterJailbreak, jailbreak } = injectJailbreak(
        coreChat, initialInjectedIndices, {
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
    const { banned_tokens: bannedTokens, banned_strings: bannedStrings } = getCustomTokenBans({
        bannedTokensRaw, globalBannedTokensRaw, sendBannedTokens, bannedWordsFromMacros: bannedWordsSink,
        encode: encodeTokens, macroContext,
    });
    const logitBias = calculateLogitBias({ logitBiasEntries, encode: encodeTokens });

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
        // Documented gaps, echoed back so a caller can see what was NOT wired (see module doc comment).
        gaps: {
            extensionPromptsSideTable: 'worldInfoDepth/anBefore/anAfter/authorsNote/outletEntries/storyStringInjection are computed but NOT spliced into mesSend - see module doc comment gap 1.',
        },
    };
}
