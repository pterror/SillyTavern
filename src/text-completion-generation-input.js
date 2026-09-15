import { readSettingsAtPaths } from './settings-store.js';
import { resolveTextGenBackend } from './textgen-backend-resolve.js';
import { loadBranch, getAncestorPath, getOrCreateAnchor, loadAtNode } from './message-tree-db.js';
import { readCardContent } from './endpoints/characters.js';
import { getGroupsByIds } from './endpoints/groups.js';
import { extension_prompt_types, extension_prompt_roles } from './extension-prompt-table.js';
import { resolveWorldInfoCandidates, world_info_insertion_strategy } from './world-info/candidate-resolution.js';

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
 * - `main_api` in real settings.json defaults to `'koboldhorde'`, NOT `'textgenerationwebui'`. UPDATE
 *   (this task): this resolver now takes an explicit `mainApi` param (`'textgenerationwebui'` /
 *   `'kobold'` / `'novel'`, default `'textgenerationwebui'` - unchanged default, so every EXISTING
 *   caller keeps its exact prior behavior) instead of always hardcoding `'textgenerationwebui'`.
 *   `'koboldhorde'` is deliberately NOT one of the accepted values - Horde is a worker-routed backend
 *   with no single fixed server URL and its own, materially different dispatch semantics (no
 *   `api_server`, a worker pool picks which real Kobold instance actually serves the request), a
 *   genuinely different integration effort than "one more `mainApi` branch" - out of scope here, same
 *   as it was already out of scope for the orchestrator itself (see
 *   text-completion-prompt-orchestrator.js's own module doc comment). Passing `'koboldhorde'` throws.
 *   Per-`mainApi` settings-namespace mapping, verified against default/content/settings.json and the
 *   client's own settings modules:
 *   - `'textgenerationwebui'`: `textgenerationwebui_settings` (unchanged).
 *   - `'kobold'`: `kai_settings` (top-level settings.json key) - verified against
 *     public/scripts/kai-settings.js's own `kai_settings` shape (temp/rep_pen/top_p/.../sampler_order/
 *     grammar/api_server - `api_server` IS a real `kai_settings` field, confirmed by reading that
 *     module's own `loadKoboldSettings()`, even though it's ABSENT from the shipped
 *     default/content/settings.json until a user actually sets a Kobold URL - same "absent until
 *     touched" pattern already established above for several `power_user`/`textgenerationwebui_settings`
 *     fields). `kai_flags` (streaming/mirostat/grammar/etc. CAPABILITY flags) is NOT a settings.json
 *     field at all - it's a client-side, LIVE version-probe result against the connected Kobold
 *     server (kai-settings.js's `checkStatusKobold()`), the exact same "would trigger a live network
 *     call as a side effect of pure settings resolution" concern already established for
 *     countTokens/encodeTokens above - so `koboldFlags` is left to the caller (via `macroExtras`),
 *     defaulting (via the orchestrator's own default) to all-`false`, matching kai_flags' own
 *     pre-probe module-level default. This resolver does NOT attempt to merge a named Kobold preset
 *     (`koboldai_settings`/`koboldai_setting_names`) the way the client's own
 *     `getKoboldGenerationData(finalPrompt, presetSettings, ...)` call site does - `kai_settings`
 *     itself already carries every sampler field directly (unlike textgenerationwebui, which has no
 *     preset-merge step in this resolver either - see `settings: textgenSettings` below, a plain,
 *     unmerged read) - so `settings`/`koboldSettings` (Step 16's own "one object, two call-site
 *     roles" - see the orchestrator's own comment on this) both resolve to this same, unmerged
 *     `kai_settings` object. A caller that needs real named-preset merging can pre-merge before
 *     calling this resolver (same "caller resolves entities" contract as everything else here).
 *   - `'novel'`: `nai_settings` (top-level settings.json key) - verified against
 *     public/scripts/nai-settings.js's own `nai_settings` shape (temperature/repetition_penalty/.../
 *     model_novel/banned_tokens/logit_bias/order/preamble). `novel_data?.tier` (the NovelAI account's
 *     own LIVE subscription tier, from `/api/novelai/status`) is genuinely external, live, per-account
 *     data with no settings.json source at all - left to the caller via `macroExtras` as
 *     `novelDataTier`, same "external live data, caller resolves it" pattern as
 *     `worldInfoRandom`/`externalActivations`. `presetOrder` (a distinct named-preset's own `.order`
 *     fallback) is likewise not resolved here, for the identical "no preset-merge step in this
 *     resolver" reason as Kobold above - `nai_settings.order` itself already covers the common case.
 * - Regardless of `mainApi`, `textgenerationwebui_settings.{banned_tokens,logit_bias,...}` are still
 *   always read into `bannedTokensRaw`/`logitBiasEntries`/etc. below (harmless - `assembleTextCompletionPrompt()`'s
 *   own Step 16 dispatch simply never forwards them into `createKoboldGenerationData()`/
 *   `createNovelGenerationData()`'s inputs for the 'kobold'/'novel' cases, per that module's own Step
 *   15 comment) - not re-guarded per-`mainApi` here, since doing so would add branching for zero
 *   behavioral difference.
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
 * - `name2`/group member display names: resolved for real below via a real character-card / group
 *   read (see `resolveName2AndGroupMemberNames`), NOT guessed - documented in that function.
 *
 * ============================================================================================
 * UPDATE (this session): `worldInfoCandidates` IS NOW RESOLVED FOR REAL by default, via
 * `src/world-info/candidate-resolution.js`'s `resolveWorldInfoCandidates()` (this closes the
 * previously-documented passthrough-only gap). Field mapping, verified against
 * public/scripts/world-info.js:
 * - `selectedWorldInfo` <- `world_info.globalSelect` (top-level settings key `world_info`, NOT
 *   `world_info_settings` - these are two different top-level settings keys; `world_info` holds the
 *   user's global lorebook SELECTION plus per-character `charLore` overrides, `world_info_settings`
 *   holds the numeric/boolean WI behavior knobs already mapped above). Not filtered against a
 *   "real lorebook names" list here (the client filters `globalSelect` against `world_names` at load
 *   time) - a stale/deleted lorebook name simply resolves to zero entries via `loadWorldEntries()`'s
 *   own `readWorldInfoFile(...) ?? {}` guard, so omitting the filter is behaviorally inert, not a gap.
 * - `character` <- the same parsed character-card object `resolveName2AndGroupMemberNames()` already
 *   loads for `name2` (only `.data.extensions.world`/`.data.character_book` are read from it, per
 *   `getCharacterLore()`'s own contract) - reused, not re-read from disk a second time.
 * - `characterExtraBooks` <- `world_info.charLore` (array of `{name, extraBooks}`), matched against
 *   `getCharaFilename(avatar)`'s real derivation (`avatar` with its extension stripped via
 *   `avatar.replace(/\.[^/.]+$/, '')` - verified against public/scripts/utils.js's
 *   `getCharaFilename()`, which does the same strip when given an explicit avatar key).
 * - `chatWorldName` <- `chatMetadata[METADATA_KEY]`, `METADATA_KEY === 'world_info'` (verified
 *   against public/scripts/world-info.js's own `export const METADATA_KEY = 'world_info';`) - i.e.
 *   `chatMetadata.world_info`, a plain string chat-metadata field, unrelated to the top-level
 *   `world_info` settings key of the same name.
 * - `personaWorldLorebook` <- `power_user.persona_description_lorebook`.
 * - `worldInfoCharacterStrategy` <- the top-level settings key `world_info_character_strategy`
 *   (verified NOT nested under `world_info_settings` - public/scripts/world-info.js reads/writes it
 *   as a bare top-level `settings.world_info_character_strategy`), defaulting to
 *   `world_info_insertion_strategy.character_first` (the client's own module-level default) when
 *   absent from a fresh settings.json.
 * A caller that already has its own resolved candidate list (or wants to bypass this resolution
 * entirely, e.g. for a test) may still pass `worldInfoCandidates` explicitly - an explicit array
 * (including `[]`) always wins over the auto-resolved one.
 *
 * UPDATE (this session): a new, OPTIONAL `userMessageText` param appends the actual raw user action
 * for this turn - "the user sent this text" - onto the resolved chat history as the newest message,
 * in the exact shape every other loaded message already uses (verified against
 * `message-tree-db.js`'s own `rowToMessage()`/`getAncestorPath()` output shape:
 * `{node_id, mes, send_date, extra, name, is_user}`): `{is_user: true, name: name1, mes:
 * userMessageText, extra: {}, send_date: Date.now()}`. `node_id` is intentionally omitted (this
 * message doesn't exist in the tree DB yet - it's the pending user input for a generation that
 * hasn't been saved) - nothing this orchestrator's pipeline reads (`core-chat-build.js`,
 * `finalizeCoreChatMessage()`, world-info key-matching, etc, all re-checked) requires `node_id` to be
 * present. When `userMessageText` is omitted (e.g. a 'continue'/'swipe' generation that doesn't add a
 * new message), `chat` is exactly the loaded history, unchanged - matching this resolver's prior
 * behavior.
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
 * `character` (the parsed character-card JSON, or `null`) is also returned - reused by the caller
 * for real world-info candidate resolution (`resolveWorldInfoCandidates()`'s `character` param)
 * instead of reading the same card file from disk a second time.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {object} params
 * @param {string} [params.avatar]
 * @param {string} [params.groupId]
 * @returns {Promise<{ name2: string, groupMemberNames: {name: string}[], character: object|null }>}
 */
async function resolveName2AndGroupMemberNames(directories, { avatar, groupId }) {
    let name2 = '';
    let groupMemberNames = [];
    let character = null;

    if (avatar) {
        try {
            const raw = await readCardContent(directories, avatar);
            if (raw !== undefined) {
                character = JSON.parse(raw);
                name2 = character?.name || character?.data?.name || '';
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

    return { name2, groupMemberNames, character };
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
 *
 * When NEITHER `branchName` nor `nodeId` is given (and `ownerId` is), this does NOT silently guess
 * "whatever the tree's current default leaf happens to be" once real messages already exist -
 * `node_id` is a genuine, non-fabricated fact the client already has for any turn that isn't the
 * very first ("the node I was actually looking at/replying to"), and resolving to a stale leaf
 * behind the caller's back would risk a real lost-update race if the tree moved since the caller
 * last loaded it (another tab, another concurrent request). The ONLY identifier-free case that is
 * genuinely safe is a brand-new owner with NO prior real messages at all - there is no "point the
 * caller meant" to disagree about when no real point has ever existed - so this resolves via the
 * owner's anchor (`getOrCreateAnchor()`/`loadAtNode()`, no name required, auto-created on first
 * touch) ONLY when that anchor's own default-child chain is genuinely empty. When the anchor
 * already has a real default-child chain (i.e. this owner DOES have prior messages) but neither
 * identifier was given, `ambiguous: true` is returned instead of a resolved history/node - the
 * caller (`buildRawActionTextCompletionRequest()`) turns that into a real, reportable error rather
 * than ever picking a leaf the caller didn't ask for.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {object} params
 * @param {string} [params.ownerId]
 * @param {string} [params.branchName]
 * @param {string} [params.nodeId]
 * @returns {Promise<{ chat: object[], metadata: object, resolvedNodeId: string|null, ambiguous?: boolean }>}
 */
async function resolveChatHistory(directories, { ownerId, branchName, nodeId }) {
    if (ownerId && branchName) {
        const result = await loadBranch(directories, ownerId, branchName);
        if (result) {
            return { chat: result.messages, metadata: result.metadata ?? {}, resolvedNodeId: result.branch.leaf_id };
        }
    }
    if (nodeId) {
        const messages = await getAncestorPath(directories, nodeId);
        if (messages) {
            return { chat: messages, metadata: {}, resolvedNodeId: nodeId };
        }
    }
    if (ownerId && !branchName && !nodeId) {
        const anchorId = await getOrCreateAnchor(directories, ownerId);
        if (anchorId) {
            const result = await loadAtNode(directories, ownerId, anchorId);
            // A non-empty result means this owner already has a real, established conversation -
            // neither identifier was given, so which point the caller meant is genuinely ambiguous;
            // do not silently pick "the current leaf" for a caller that never said that's what it wanted.
            if (result && result.messages.length > 0) {
                return { chat: [], metadata: {}, resolvedNodeId: null, ambiguous: true };
            }
            if (result) {
                return { chat: result.messages, metadata: result.metadata ?? {}, resolvedNodeId: result.node_id };
            }
        }
    }
    return { chat: [], metadata: {}, resolvedNodeId: null };
}

/**
 * Resolves the real `assembleTextCompletionPrompt(input)` input object from on-disk settings.json
 * (via src/settings-store.js) and the real message-tree chat DB (via src/message-tree-db.js).
 *
 * See this module's doc comment above for the full list of field-mapping decisions and documented
 * gaps. `countTokens`/`encodeTokens` are still caller-supplied passthrough params (see doc comment
 * for exactly why). `worldInfoCandidates` is now auto-resolved for real by default (see the UPDATE
 * section in the doc comment above) unless the caller passes an explicit override.
 * `macroExtras`, when given, is shallow-merged OVER the resolved object (caller overrides win) -
 * use it to supply any of the orchestrator's other optional fields this resolver doesn't compute
 * (e.g. `quiet_prompt`, `isDryRun`, `canUseTools`, CFG's `worldInfoRandom`, etc).
 *
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {object} params
 * @param {string} [params.avatar] Character avatar filename.
 * @param {string} [params.groupId] Group id.
 * @param {string} [params.mainApi] One of 'textgenerationwebui' (default) / 'kobold' / 'novel'. See
 * module doc comment's FIELD-MAPPING NOTES for the exact per-value settings-namespace mapping.
 * 'koboldhorde' is NOT accepted (throws) - see module doc comment for why.
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
 * @param {string} [params.textareaText]
 * @param {object} [params.chatMetadata] Overrides the loaded branch's own metadata when given.
 * @param {string} [params.userMessageText] The raw user action for this turn - "the user sent this
 * text". When given, appended onto the resolved chat history as the newest message (see doc comment
 * UPDATE section for the exact shape). Omit for generation types that don't add a new message
 * (e.g. 'continue'/'swipe').
 * @param {import('./world-info/activation.js').WIEntry[]} [params.worldInfoCandidates] Explicit
 * override/bypass for the auto-resolved candidates (see doc comment UPDATE section) - when omitted
 * (left `undefined`), this resolver calls `resolveWorldInfoCandidates()` for real; passing an
 * explicit array (including `[]`) always wins.
 * @param {(text: string) => Promise<number>} params.countTokens REQUIRED - see doc comment.
 * @param {(text: string) => number[]} params.encodeTokens REQUIRED - see doc comment.
 * @param {number} [params.amountGen] Overrides settings.amount_gen when given.
 * @param {object} [params.macroExtras] Shallow-merged over the resolved input object.
 * @returns {Promise<import('./text-completion-prompt-orchestrator.js').AssembleTextCompletionPromptInput>}
 */
export async function resolveTextCompletionGenerationInput(directories, {
    avatar, groupId, mainApi = 'textgenerationwebui', ownerId, branchName, nodeId,
    type, isImpersonate = false, isContinue = false, isSwipe = false,
    textareaText = '', chatMetadata: chatMetadataOverride, userMessageText,
    worldInfoCandidates: worldInfoCandidatesOverride, countTokens, encodeTokens, amountGen, macroExtras = {},
} = {}) {
    if (typeof countTokens !== 'function') {
        throw new Error('resolveTextCompletionGenerationInput: countTokens is required (real tokenizer resolution is caller-owned - see module doc comment)');
    }
    if (typeof encodeTokens !== 'function') {
        throw new Error('resolveTextCompletionGenerationInput: encodeTokens is required (real tokenizer resolution is caller-owned - see module doc comment)');
    }
    if (!['textgenerationwebui', 'kobold', 'novel'].includes(mainApi)) {
        throw new Error(`resolveTextCompletionGenerationInput: unsupported mainApi '${mainApi}' (koboldhorde is deliberately not supported here - see module doc comment)`);
    }

    const {
        power_user: powerUser = {},
        world_info_settings: worldInfoSettings = {},
        world_info: worldInfoSelection = {},
        world_info_character_strategy: worldInfoCharacterStrategySetting,
        textgenerationwebui_settings: textgenSettings = {},
        kai_settings: koboldSettings = {},
        nai_settings: novelSettings = {},
        extension_settings: extensionSettings = {},
        username,
        amount_gen: settingsAmountGen,
        max_context: settingsMaxContext,
    } = readSettingsAtPaths(directories, [
        'power_user', 'world_info_settings', 'world_info', 'world_info_character_strategy',
        'textgenerationwebui_settings', 'kai_settings', 'nai_settings',
        'extension_settings', 'username', 'amount_gen', 'max_context',
    ]);

    // Per-mainApi backend-specific settings object - see module doc comment FIELD-MAPPING NOTES for
    // the exact rationale (no preset-merge step for kobold/novel here, same as textgenerationwebui's
    // own plain, unmerged `textgenSettings` read below).
    const backendSettings = mainApi === 'kobold' ? koboldSettings : mainApi === 'novel' ? novelSettings : textgenSettings;

    const backend = mainApi === 'textgenerationwebui' ? resolveTextGenBackend(directories) : null;

    const isGroup = Boolean(groupId);
    const hasCharacterOrGroup = Boolean(avatar) || Boolean(groupId);

    const { chat: loadedChat, metadata: loadedChatMetadata, resolvedNodeId, ambiguous: chatResolutionAmbiguous } =
        await resolveChatHistory(directories, { ownerId, branchName, nodeId });
    const chatMetadata = chatMetadataOverride ?? loadedChatMetadata ?? {};

    const { name2, groupMemberNames, character } = await resolveName2AndGroupMemberNames(directories, { avatar, groupId });
    const name1 = username || 'User';

    // Appends the actual raw user action for this turn onto the loaded history, in the exact shape
    // every other loaded message already uses - see this module's doc comment UPDATE section for
    // why `node_id` is intentionally omitted. Left as exactly the loaded history when
    // `userMessageText` isn't given (e.g. 'continue'/'swipe').
    const chat = typeof userMessageText === 'string'
        ? [...loadedChat, { is_user: true, name: name1, mes: userMessageText, extra: {}, send_date: Date.now() }]
        : loadedChat;

    // Real world-info candidate resolution (see doc comment UPDATE section for the full field
    // mapping) - only attempted when the caller hasn't already supplied an explicit override/bypass.
    // METADATA_KEY ('world_info') is mirrored inline rather than imported - it lives in
    // public/scripts/world-info.js, a client-only module this server-side resolver otherwise never
    // imports from.
    const WORLD_INFO_METADATA_KEY = 'world_info';
    let worldInfoCandidates = worldInfoCandidatesOverride;
    if (worldInfoCandidates === undefined) {
        const charFilename = avatar ? avatar.replace(/\.[^/.]+$/, '') : null;
        const charLore = Array.isArray(worldInfoSelection.charLore) ? worldInfoSelection.charLore : [];
        const characterExtraBooks = charLore.find(e => e.name === charFilename)?.extraBooks ?? [];
        worldInfoCandidates = await resolveWorldInfoCandidates({
            directories,
            selectedWorldInfo: worldInfoSelection.globalSelect ?? [],
            character,
            characterExtraBooks,
            chatWorldName: chatMetadata?.[WORLD_INFO_METADATA_KEY] ?? null,
            personaWorldLorebook: powerUser.persona_description_lorebook ?? null,
            worldInfoCharacterStrategy: worldInfoCharacterStrategySetting ?? world_info_insertion_strategy.character_first,
        });
    }

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
        // Exposed so a caller (buildRawActionTextCompletionRequest()) that resolved `chat` via this
        // SAME call can read back which real tree node it resolved to, instead of re-deriving
        // "the current leaf" independently and risking the two disagreeing. `null` when nothing
        // could be safely resolved - see `chatResolutionAmbiguous` below for why.
        resolvedNodeId,
        // True only for the "neither branchName nor nodeId given, but this owner already has a real,
        // established conversation" case - see resolveChatHistory()'s own doc comment. The caller
        // must treat this as a real error (an explicit branch_name/node_id was required), not silently
        // pick a leaf.
        chatResolutionAmbiguous: Boolean(chatResolutionAmbiguous),
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
        // UPDATE (this task): `mainApi` is now the caller-supplied value (default
        // 'textgenerationwebui', unchanged from before) instead of always hardcoded - see module doc
        // comment for the accepted values and the 'koboldhorde' exclusion.
        mainApi,
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
        // `settings` is now the backend-specific (per-`mainApi`) settings object - see module doc
        // comment FIELD-MAPPING NOTES. `model` is only meaningful for 'textgenerationwebui' (Kobold
        // has no per-request model selector; NovelAI's model lives INSIDE `settings.model_novel`
        // already, not as a separate top-level field) - `undefined` for the other two, matching
        // text-completion-prompt-orchestrator.js's own Step 16 doc comment on this exact point.
        settings: backendSettings,
        model: mainApi === 'textgenerationwebui' ? backend.model : undefined,

        // --- Backend-specific generation-data (kobold/novel dispatch only) ---
        // None of these have a real settings.json/chat-metadata source of truth without either a
        // live capability/version probe (koboldFlags) or live external account data (novelDataTier) -
        // see module doc comment FIELD-MAPPING NOTES for exactly why each is left at the
        // orchestrator's own conservative default here, overridable via `macroExtras`.
        apiServer: mainApi === 'kobold' ? (koboldSettings.api_server ?? '') : undefined,
        consoleLogPrompts: Boolean(powerUser.console_log_prompts ?? false),
    };

    return { ...resolved, ...macroExtras };
}
