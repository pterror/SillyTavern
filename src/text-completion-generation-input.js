import { readSettingsAtPaths } from './settings-store.js';
import { resolveTextGenBackend } from './textgen-backend-resolve.js';
import { loadBranch, getAncestorPath } from './message-tree-db.js';
import { readCardContent } from './endpoints/characters.js';
import { getGroupsByIds } from './endpoints/groups.js';
import { extension_prompt_types, extension_prompt_roles } from './extension-prompt-table.js';

/**
 * Adapter/resolver layer between REAL on-disk state (settings.json - via settings-store.js's
 * sharded reader - and the message-tree chat DB - via message-tree-db.js) and
 * src/text-completion-prompt-orchestrator.js's `assembleTextCompletionPrompt(input)`, which has so
 * far only ever been fed hand-built test fixtures.
 *
 * This module does NOT implement any new prompt-assembly logic - every field below is either a
 * direct (documented) read of an existing settings/chat key, or a passthrough of a caller-supplied
 * identity/runtime value. Where a real value could not be confidently resolved without guessing,
 * that field is left to the caller (via `macroExtras`) instead of silently defaulting - see the
 * per-field notes below and the module's own report to the task for the full list.
 *
 * ============================================================================================
 * FIELD-MAPPING NOTES (read before trusting a value below - reflects what's REALLY in settings.json,
 * not what the orchestrator's own param names might suggest):
 * ============================================================================================
 *
 * - `world_info_*` settings (depth/budget/recursive/etc.) are NOT top-level keys in real
 *   settings.json - they live nested one level down, under the top-level key `world_info_settings`
 *   (verified against default/content/settings.json and public/scripts/world-info.js's
 *   `setWorldInfoSettings(settings, data)`, which is always called as
 *   `setWorldInfoSettings(settings.world_info_settings ?? settings, data)` - see public/script.js).
 *   So this resolver reads `world_info_settings.world_info_depth` etc, not `world_info_depth`.
 * - `extension_settings.note` and `extension_settings.cfg` (NOT top-level `note`/`cfg`) hold the
 *   author's-note and CFG settings, confirmed against default/content/settings.json and
 *   public/scripts/authors-note.js / public/scripts/cfg-scale.js.
 * - `extension_settings.note`'s shape (`default`, `defaultDepth`, `defaultInterval`,
 *   `defaultPosition`, `defaultRole`, `allowWIScan`, `chara`) matches
 *   src/authors-note.js's `AuthorsNoteSettings` typedef key-for-key, so it is passed straight
 *   through as `noteSettings` with NO renaming.
 * - `extension_settings.cfg.global`/`.chara[]` match src/cfg-prompt-resolve.js's `CfgSettings`
 *   shape (`guidance_scale`/`negative_prompt`/`positive_prompt`) key-for-key too.
 * - CFG's *chat-scoped* overrides (`chatGuidanceScale`, `groupchatIndividualChars`, `promptCombine`,
 *   `promptSeparator`, `promptInsertionDepth`, `chatMetadataPrompts`) are NOT settings.json fields at
 *   all - per public/scripts/cfg-scale.js's own `metadataKeys` map, they live on `chat_metadata`
 *   (`cfg_guidance_scale`, `cfg_groupchat_individual_chars`, `cfg_prompt_combine`,
 *   `cfg_prompt_separator`, `cfg_prompt_insertion_depth`, `cfg_negative_prompt`/`cfg_positive_prompt`
 *   respectively) - resolved from the caller-supplied/loaded `chatMetadata`, not from settings.
 * - `power_user.context.story_string_position/_depth/_role` are NOT present in
 *   default/content/settings.json at all (the client only persists them once a user actually
 *   changes the control) - confirmed against public/scripts/power-user.js's own
 *   `power_user_settings_defaults`/`context_presets`. This resolver falls back to the SAME code
 *   defaults the client itself uses (IN_PROMPT / 1 / SYSTEM) when absent, rather than treating
 *   their absence as "user configured nothing".
 * - `power_user.reasoning`, `power_user.single_line`, `power_user.request_token_probabilities`,
 *   `power_user.media_display` are likewise absent from the shipped default settings.json (only
 *   populated once touched) - defaults below mirror public/scripts/power-user.js's own
 *   `power_user_settings_defaults` object exactly (add_to_prompts:false/max_additions:1/
 *   prefix:'<think>'/separator:'\n'/suffix:'</think>'; single_line:false;
 *   request_token_probabilities:false). `media_display` has no corresponding orchestrator input at
 *   all (out of scope - see gap list below), so it is not read.
 * - `textgenerationwebui_settings.{banned_tokens,global_banned_tokens,send_banned_tokens,logit_bias}`
 *   are similarly absent from the shipped default (defaulted client-side in
 *   public/scripts/textgen-settings.js's own settings object: `''`, `''`, `true`, `[]`
 *   respectively) - mirrored here for the same reason.
 * - `main_api` in real settings.json defaults to `'koboldhorde'`, NOT `'textgenerationwebui'` - but
 *   this resolver is explicitly for the text-completion-only orchestrator, so `mainApi` is always
 *   hardcoded to `'textgenerationwebui'` here regardless of the user's live `main_api` setting
 *   (deciding whether the *caller* should even invoke this resolver when main_api says otherwise is
 *   out of scope - a later routing decision, per the task).
 * - `world_info_settings.world_info_case_sensitive` / `.world_info_match_whole_words` /
 *   `.world_info_character_strategy` / `.world_info_overflow_alert` are REAL settings that exist in
 *   settings.json, but `assembleTextCompletionPrompt`'s input typedef has NO corresponding
 *   parameter for any of them (not `entryFilterContext`'s shape either - that's
 *   `{trigger, characterFilename, characterTags}` per src/world-info/activation.js) - this is a
 *   pre-existing gap in the orchestrator itself (not introduced by this resolver), so they are
 *   read from settings but have nowhere to go and are simply not forwarded. Flagged, not guessed.
 *
 * ============================================================================================
 * FIELDS NOT RESOLVED HERE - LEFT TO THE CALLER (via `macroExtras`), AND WHY:
 * ============================================================================================
 *
 * - `countTokens`/`encodeTokens`: UPDATE - `src/token-bans-and-bias.js`'s `getCustomTokenBans()`/
 *   `calculateLogitBias()` now `await` their `encode` param (previously synchronous-only), so the
 *   original blocker recorded here - that a genuinely-async remote-backend tokenizer couldn't be
 *   bridged into a synchronous `encodeTokens` without desyncing it from `countTokens` - no longer
 *   applies at the type-signature level; both orchestrator params now accept an async function.
 *   This resolver STILL leaves both as required caller-supplied params, though, for a different
 *   reason: wiring `src/tokenizer-resolve.js`'s real `resolveTokenizerType()`/`encodeWithTokenizerType()`
 *   by default here would mean simply calling this settings-resolution function can trigger a LIVE
 *   NETWORK REQUEST to the user's configured backend server (the remote-tokenizer path) as a side
 *   effect - a meaningfully different risk/behavior profile than every other field this resolver
 *   computes (plain reads of local disk state). Whether/how to opt into that automatically is a
 *   separate decision this task does not make silently - so both tokenizer functions remain
 *   explicit, required inputs; a caller that wants the real local-tokenizer-only path can call
 *   `resolveTokenizerType()`/`encodeWithTokenizerType()` itself and pass the result in.
 * - `quiet_prompt`/`quietToLoud`/`quietName`/`generationTrigger`/`isDryRun`/`canUseTools`/
 *   `forceName2Override`/`preferCharacterPrompt`/`preferCharacterJailbreak`/`worldInfoRandom`/
 *   `entryFilterContext`/`externalActivations`/`ephemeralStoppingStrings`/`injectedIndices`/
 *   `beforeScenarioAnchor`/`afterScenarioAnchor`: none of these have a real, single-valued
 *   settings.json/chat-metadata source of truth (they're per-request generation-call options on
 *   the client, e.g. passed as `Generate()` options or resolved by subsystems explicitly out of
 *   scope per the orchestrator's own gap list) - left at the orchestrator's own defaults unless a
 *   caller supplies an override via `macroExtras`.
 * - `worldInfoCandidates`: explicitly out of scope per the task and the orchestrator's own gap 6 -
 *   plain passthrough.
 * - `name2`/group member display names: resolved for real below via a real character-card / group
 *   read (see `resolveName2AndGroupMemberNames`), NOT guessed - documented in that function.
 */

const DEFAULT_STORY_STRING_POSITION = extension_prompt_types.IN_PROMPT;
const DEFAULT_STORY_STRING_DEPTH = 1;
const DEFAULT_STORY_STRING_ROLE = extension_prompt_roles.SYSTEM;

/**
 * Reads a character card's display name (`.name`), or a group's display name when no specific
 * member avatar is given. Real reads via already-committed, exported helpers
 * (src/endpoints/characters.js's `readCardContent`, src/endpoints/groups.js's `getGroupsByIds`) -
 * NOT a guess, and NOT a new export added to any of the ~20 read-only reference modules.
 *
 * Group member display names (for `groupMemberNames`, used by src/stopping-strings.js) are
 * resolved the same way: each member avatar's card is read for its `.name`. A member whose card
 * can't be read is silently skipped (mirrors this module's general "don't fail the whole
 * resolution over one bad member" stance - a missing/corrupt character file elsewhere in the
 * codebase is already treated as non-fatal, e.g. character-card-fields.js's `loadCharacter`).
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {object} params
 * @param {string} [params.avatar]
 * @param {string} [params.groupId]
 * @returns {Promise<{ name2: string, groupMemberNames: {name: string}[] }>}
 */
async function resolveName2AndGroupMemberNames(directories, { avatar, groupId }) {
    let name2 = '';
    let groupMemberNames = [];

    if (avatar) {
        try {
            const raw = await readCardContent(directories, avatar);
            if (raw !== undefined) {
                const card = JSON.parse(raw);
                name2 = card?.name || card?.data?.name || '';
            }
        } catch { /* leave name2 as '' - matches character-card-fields.js's own no-character fallback */ }
    }

    if (groupId) {
        const group = getGroupsByIds(directories, [groupId])[groupId];
        if (group) {
            if (!avatar) {
                name2 = group.name || name2;
            }
            const members = Array.isArray(group.members) ? group.members : [];
            for (const memberAvatar of members) {
                try {
                    const raw = await readCardContent(directories, memberAvatar);
                    if (raw === undefined) continue;
                    const card = JSON.parse(raw);
                    const memberName = card?.name || card?.data?.name;
                    if (memberName) groupMemberNames.push({ name: memberName });
                } catch { /* skip unreadable member card */ }
            }
        }
    }

    return { name2, groupMemberNames };
}

/**
 * Resolves the real chat history for `assembleTextCompletionPrompt`'s `chat` input.
 *
 * message-tree-db.js's `loadBranch()`/`getAncestorPath()` already return messages shaped as
 * `{name, mes, is_user, extra, send_date, node_id, swipes?, swipe_id?, swipe_info?}` - i.e. the
 * EXACT `{name, mes, is_user, extra}` shape src/core-chat-build.js's `CoreChatMessage` typedef (and
 * src/text-completion-prompt-orchestrator.js's `chat` input) expects, field-for-field, with no
 * renaming needed (verified by reading message-tree-db.js's `rowToMessage()`/`buildPathMessages()`
 * - there is no `content`-vs-`mes` mismatch to bridge; the tree DB's own on-disk column is called
 * `content` but the JSON *inside* that column - what callers actually get back - already uses
 * `mes`, matching the client's own chat-message shape, since `sanitizeForStorage()` stores the
 * message object mostly as-is).
 *
 * `ownerId`+`branchName` (a labeled chat) is resolved via `loadBranch()`. When `branchName` is
 * omitted but a `nodeId` is given instead, `getAncestorPath()` is used (root-to-node order,
 * matching `loadBranch()`'s message order) - this is this resolver's own judgment call on "the
 * exact identity shape needed" the task left open, covering the common case of generating from an
 * arbitrary tree node (e.g. mid-branch) without a saved chat label.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {object} params
 * @param {string} [params.ownerId]
 * @param {string} [params.branchName]
 * @param {string} [params.nodeId]
 * @returns {Promise<{ chat: object[], metadata: object }>}
 */
async function resolveChatHistory(directories, { ownerId, branchName, nodeId }) {
    if (ownerId && branchName) {
        const result = await loadBranch(directories, ownerId, branchName);
        if (result) {
            return { chat: result.messages, metadata: result.metadata ?? {} };
        }
    }
    if (nodeId) {
        const messages = await getAncestorPath(directories, nodeId);
        if (messages) {
            return { chat: messages, metadata: {} };
        }
    }
    return { chat: [], metadata: {} };
}

/**
 * Resolves the real `assembleTextCompletionPrompt(input)` input object from on-disk settings.json
 * (via src/settings-store.js) and the real message-tree chat DB (via src/message-tree-db.js).
 *
 * See this module's doc comment above for the full list of field-mapping decisions and documented
 * gaps. `worldInfoCandidates`, `countTokens`, and `encodeTokens` are still caller-supplied
 * passthrough params (see doc comment for exactly why, especially for the tokenizer functions).
 * `macroExtras`, when given, is shallow-merged OVER the resolved object (caller overrides win) -
 * use it to supply any of the orchestrator's other optional fields this resolver doesn't compute
 * (e.g. `quiet_prompt`, `isDryRun`, `canUseTools`, CFG's `worldInfoRandom`, etc).
 *
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {object} params
 * @param {string} [params.avatar] Character avatar filename.
 * @param {string} [params.groupId] Group id.
 * @param {string} [params.ownerId] message-tree-db.js owner id for chat resolution.
 * @param {string} [params.branchName] message-tree-db.js labeled chat name.
 * @param {string} [params.nodeId] Alternative to `branchName` - resolve history up to this tree node.
 * @param {string} [params.type] Generation type ('normal'/'impersonate'/'continue'/'swipe'/...).
 * @param {boolean} [params.isImpersonate]
 * @param {boolean} [params.isContinue]
 * @param {boolean} [params.isSwipe]
 * @param {string} [params.textareaText]
 * @param {object} [params.chatMetadata] Overrides the loaded branch's own metadata when given.
 * @param {import('./world-info/activation.js').WIEntry[]} [params.worldInfoCandidates]
 * @param {(text: string) => Promise<number>} params.countTokens REQUIRED - see doc comment.
 * @param {(text: string) => number[]} params.encodeTokens REQUIRED - see doc comment.
 * @param {number} [params.amountGen] Overrides settings.amount_gen when given.
 * @param {object} [params.macroExtras] Shallow-merged over the resolved input object.
 * @returns {Promise<import('./text-completion-prompt-orchestrator.js').AssembleTextCompletionPromptInput>}
 */
export async function resolveTextCompletionGenerationInput(directories, {
    avatar, groupId, ownerId, branchName, nodeId,
    type, isImpersonate = false, isContinue = false, isSwipe = false,
    textareaText = '', chatMetadata: chatMetadataOverride,
    worldInfoCandidates = [], countTokens, encodeTokens, amountGen, macroExtras = {},
} = {}) {
    if (typeof countTokens !== 'function') {
        throw new Error('resolveTextCompletionGenerationInput: countTokens is required (real tokenizer resolution is caller-owned - see module doc comment)');
    }
    if (typeof encodeTokens !== 'function') {
        throw new Error('resolveTextCompletionGenerationInput: encodeTokens is required (real tokenizer resolution is caller-owned - see module doc comment)');
    }

    const {
        power_user: powerUser = {},
        world_info_settings: worldInfoSettings = {},
        textgenerationwebui_settings: textgenSettings = {},
        extension_settings: extensionSettings = {},
        username,
        amount_gen: settingsAmountGen,
        max_context: settingsMaxContext,
    } = readSettingsAtPaths(directories, [
        'power_user', 'world_info_settings', 'textgenerationwebui_settings', 'extension_settings',
        'username', 'amount_gen', 'max_context',
    ]);

    const backend = resolveTextGenBackend(directories);

    const isGroup = Boolean(groupId);
    const hasCharacterOrGroup = Boolean(avatar) || Boolean(groupId);

    const { chat, metadata: loadedChatMetadata } = await resolveChatHistory(directories, { ownerId, branchName, nodeId });
    const chatMetadata = chatMetadataOverride ?? loadedChatMetadata ?? {};

    const { name2, groupMemberNames } = await resolveName2AndGroupMemberNames(directories, { avatar, groupId });
    const name1 = username || 'User';

    const context = powerUser.context ?? {};
    const instruct = powerUser.instruct ?? {};
    const reasoning = powerUser.reasoning ?? {};
    const sysprompt = powerUser.sysprompt ?? {};
    const noteSettings = extensionSettings.note ?? {};
    const cfgSettings = extensionSettings.cfg ?? {};
    const globalCfg = cfgSettings.global;
    const charaCfg = Array.isArray(cfgSettings.chara) ? cfgSettings.chara.find(e => e.name === avatar) : undefined;

    const resolved = {
        // --- Generation identity/mode ---
        type, isImpersonate, isContinue, isSwipe, isGroup,
        name1, name2,

        // --- Character/persona/chat resolution ---
        directories, avatar, groupId,
        personaDescription: powerUser.persona_description,
        chatMetadata, chat, textareaText,
        userPromptBias: powerUser.user_prompt_bias,
        alwaysForceName2: Boolean(powerUser.always_force_name2),

        // --- Reasoning folding ---
        reasoningAddToPrompts: Boolean(reasoning.add_to_prompts ?? false),
        reasoningMaxAdditions: reasoning.max_additions ?? 1,
        reasoningPrefix: reasoning.prefix ?? '<think>',
        reasoningSeparator: reasoning.separator ?? '\n',
        reasoningSuffix: reasoning.suffix ?? '</think>',

        // --- Context/token budget ---
        thisMaxContext: settingsMaxContext ?? 8192,
        tokenPadding: powerUser.token_padding ?? 0,
        countTokens, encodeTokens,
        amountGen: amountGen ?? settingsAmountGen ?? 0,
        requestTokenProbabilities: Boolean(powerUser.request_token_probabilities ?? false),

        // --- CFG ---
        chatGuidanceScale: chatMetadata.cfg_guidance_scale,
        groupchatIndividualChars: Boolean(chatMetadata.cfg_groupchat_individual_chars ?? false),
        charaCfg, globalCfg,
        promptCombine: chatMetadata.cfg_prompt_combine ?? [],
        promptSeparator: chatMetadata.cfg_prompt_separator,
        promptInsertionDepth: chatMetadata.cfg_prompt_insertion_depth ?? 1,
        chatMetadataPrompts: {
            negativePrompt: chatMetadata.cfg_negative_prompt,
            positivePrompt: chatMetadata.cfg_positive_prompt,
        },

        // --- World info ---
        worldInfoCandidates,
        worldInfoIncludeNames: Boolean(worldInfoSettings.world_info_include_names ?? false),
        worldInfoBudgetPercent: worldInfoSettings.world_info_budget ?? 25,
        worldInfoBudgetCap: worldInfoSettings.world_info_budget_cap ?? 0,
        worldInfoDepth: worldInfoSettings.world_info_depth ?? 2,
        worldInfoRecursive: Boolean(worldInfoSettings.world_info_recursive ?? true),
        worldInfoMaxRecursionSteps: worldInfoSettings.world_info_max_recursion_steps ?? 0,
        worldInfoMinActivations: worldInfoSettings.world_info_min_activations ?? 0,
        worldInfoMinActivationsDepthMax: worldInfoSettings.world_info_min_activations_depth_max ?? 0,
        worldInfoUseGroupScoring: Boolean(worldInfoSettings.world_info_use_group_scoring ?? false),

        // --- Author's note ---
        noteSettings, hasCharacterOrGroup,

        // --- Story string / instruct mode ---
        storyStringTemplate: context.story_string ?? '',
        storyStringPosition: context.story_string_position ?? DEFAULT_STORY_STRING_POSITION,
        storyStringDepth: context.story_string_depth ?? DEFAULT_STORY_STRING_DEPTH,
        storyStringRole: context.story_string_role ?? DEFAULT_STORY_STRING_ROLE,
        sysPromptEnabled: Boolean(sysprompt.enabled ?? false),
        sysPromptContent: sysprompt.content ?? '',
        personaDescriptionPosition: powerUser.persona_description_position ?? 0,
        stripExamples: Boolean(powerUser.strip_examples ?? false),
        isInstruct: Boolean(instruct.enabled ?? false),
        instructPreset: instruct,
        contextSettings: context,
        instructUserAlignmentMessage: instruct.user_alignment_message,
        instructWrap: Boolean(instruct.wrap ?? false),
        pinExamples: Boolean(powerUser.pin_examples ?? false),

        // --- Jailbreak / system prompt ---
        sysPromptPostHistory: sysprompt.post_history ?? '',

        // --- Backend / API ---
        // This resolver is text-completion-only - `mainApi` is always 'textgenerationwebui' here
        // regardless of the user's live main_api setting (see module doc comment).
        mainApi: 'textgenerationwebui',
        collapseNewlines: Boolean(powerUser.collapse_newlines ?? false),

        // --- Stopping strings / token bans / logit bias ---
        namesAsStopStrings: Boolean(context.names_as_stop_strings ?? false),
        singleLine: Boolean(powerUser.single_line ?? false),
        customStoppingStringsRaw: powerUser.custom_stopping_strings ?? '',
        customStoppingStringsMacro: Boolean(powerUser.custom_stopping_strings_macro ?? false),
        groupMemberNames,
        bannedTokensRaw: textgenSettings.banned_tokens ?? '',
        globalBannedTokensRaw: textgenSettings.global_banned_tokens ?? '',
        sendBannedTokens: Boolean(textgenSettings.send_banned_tokens ?? true),
        logitBiasEntries: textgenSettings.logit_bias ?? [],

        // --- Final generation-data wire payload ---
        settings: textgenSettings,
        model: backend.model,
    };

    return { ...resolved, ...macroExtras };
}
