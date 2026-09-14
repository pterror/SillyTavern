import { readWorldInfoFile } from '../endpoints/worldinfo.js';
import { parseDecorators } from './decorators.js';
import { getStringHash } from '../../public/scripts/hash-utils.js';
import { world_info_position } from './result-bucketing.js';
import { world_info_logic } from './key-matching.js';
import { extension_prompt_roles } from '../extension-prompt-table.js';

/**
 * Sentinel "world name" the client uses to tag entries converted from a character's own embedded
 * `character_book` (public/scripts/world-info.js's `EMBEDDED_WORLD_NAME`, verified value
 * `'__embedded__'`). Mirrored here so `resolveWorldInfoCandidates()`'s embedded-lorebook fallback
 * (see `getCharacterLore()` below) tags its entries identically to the client.
 */
export const EMBEDDED_WORLD_NAME = '__embedded__';

const DEFAULT_DEPTH = 4;
const DEFAULT_WEIGHT = 100;

/**
 * Server-side port of public/scripts/world-info.js's `convertCharacterBook(characterBook)` -
 * reshapes a V2/V3 character card's embedded `character_book` (spec-shaped: `entries[]` with
 * `keys`/`secondary_keys`/`insertion_order`/`extensions`/etc.) into the same
 * world-info-entry-shaped object the rest of this pipeline expects. Pure data transformation, no
 * DOM/browser APIs involved - ported directly, not re-derived. Every field
 * `newWorldInfoEntryTemplate` (public/scripts/world-info.js ~4206) would otherwise contribute is
 * explicitly assigned below already (verified by reading `newWorldInfoEntryDefinition`'s full field
 * list, ~4161-4204: every non-`excludeFromTemplate` field the template supplies is set explicitly
 * here), so the template spread itself is redundant and intentionally not reproduced -
 * `characterFilterNames`/`characterFilterTags`/`characterFilterExclude` are excluded from the
 * template on the client too and are likewise absent here, matching real client output exactly.
 * @param {object} characterBook V2/V3 spec `character_book` object.
 * @returns {{entries: Record<string|number, object>}}
 */
function convertCharacterBook(characterBook) {
    /** @type {Record<string|number, object>} */
    const entries = {};

    characterBook.entries.forEach((entry, index) => {
        const id = entry.id !== undefined ? entry.id : index;
        entries[id] = {
            uid: id,
            key: entry.keys,
            keysecondary: entry.secondary_keys || [],
            comment: entry.comment || '',
            content: entry.content,
            constant: entry.constant || false,
            selective: entry.selective || false,
            order: entry.insertion_order,
            position: entry.extensions?.position ?? (entry.position === 'before_char' ? world_info_position.before : world_info_position.after),
            excludeRecursion: entry.extensions?.exclude_recursion ?? false,
            preventRecursion: entry.extensions?.prevent_recursion ?? false,
            delayUntilRecursion: entry.extensions?.delay_until_recursion ?? false,
            disable: !entry.enabled,
            addMemo: !!entry.comment,
            displayIndex: entry.extensions?.display_index ?? index,
            probability: entry.extensions?.probability ?? 100,
            useProbability: entry.extensions?.useProbability ?? true,
            depth: entry.extensions?.depth ?? DEFAULT_DEPTH,
            selectiveLogic: entry.extensions?.selectiveLogic ?? world_info_logic.AND_ANY,
            outletName: entry.extensions?.outlet_name ?? '',
            group: entry.extensions?.group ?? '',
            groupOverride: entry.extensions?.group_override ?? false,
            groupWeight: entry.extensions?.group_weight ?? DEFAULT_WEIGHT,
            scanDepth: entry.extensions?.scan_depth ?? null,
            caseSensitive: entry.extensions?.case_sensitive ?? null,
            matchWholeWords: entry.extensions?.match_whole_words ?? null,
            useGroupScoring: entry.extensions?.use_group_scoring ?? null,
            automationId: entry.extensions?.automation_id ?? '',
            role: entry.extensions?.role ?? extension_prompt_roles.SYSTEM,
            vectorized: entry.extensions?.vectorized ?? false,
            sticky: entry.extensions?.sticky ?? null,
            cooldown: entry.extensions?.cooldown ?? null,
            delay: entry.extensions?.delay ?? null,
            matchPersonaDescription: entry.extensions?.match_persona_description ?? false,
            matchCharacterDescription: entry.extensions?.match_character_description ?? false,
            matchCharacterPersonality: entry.extensions?.match_character_personality ?? false,
            matchCharacterDepthPrompt: entry.extensions?.match_character_depth_prompt ?? false,
            matchScenario: entry.extensions?.match_scenario ?? false,
            matchCreatorNotes: entry.extensions?.match_creator_notes ?? false,
            extensions: entry.extensions ?? {},
            triggers: entry.extensions?.triggers || [],
            ignoreBudget: entry.extensions?.ignore_budget ?? false,
        };
    });

    return { entries };
}

/**
 * Mirrors public/scripts/world-info.js's `world_info_insertion_strategy` enum (verified against the
 * real client source: `{ evenly: 0, character_first: 1, global_first: 2 }`). Not previously mirrored
 * anywhere server-side (grepped `world_info_insertion_strategy` across `src/` - no hits before this
 * file), so declared fresh here rather than reused from an existing port.
 */
export const world_info_insertion_strategy = {
    evenly: 0,
    character_first: 1,
    global_first: 2,
};

/**
 * Mirrors public/scripts/world-info.js's sortFn used throughout getSortedEntries(): descending by
 * `order` (higher order sorts first).
 * @param {object} a
 * @param {object} b
 * @returns {number}
 */
function sortFn(a, b) {
    return b.order - a.order;
}

/**
 * Reads one lorebook and reshapes its entries the way every one of the client's getXLore() helpers
 * does: `data.entries` is a map keyed by uid; each value is spread into `{ uid, world, ...rest }`
 * (uid destructured out and put back first only so `world` can be inserted before the rest of the
 * entry's own fields, matching client field ordering - not that field order is semantically
 * meaningful here, just faithfully mirrored).
 *
 * Uses `readWorldInfoFile(directories, worldName, true)` directly - the exact same function
 * `src/endpoints/worldinfo.js`'s `/api/worldinfo/get` endpoint calls - instead of the client's
 * `loadWorldInfo()`, which is only a fetch-and-cache wrapper around that same endpoint. No HTTP
 * round-trip needed server-side.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} worldName
 * @returns {Array<object>}
 */
function loadWorldEntries(directories, worldName) {
    const data = readWorldInfoFile(directories, worldName, true);
    if (!data?.entries) {
        return [];
    }
    return Object.keys(data.entries)
        .map((x) => data.entries[x])
        .map(({ uid, ...rest }) => ({ uid, world: worldName, ...rest }));
}

/**
 * Port of getGlobalLore(): every entry from every globally-selected lorebook, in
 * `selectedWorldInfo` order.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string[]} selectedWorldInfo
 * @returns {Array<object>}
 */
function getGlobalLore(directories, selectedWorldInfo) {
    if (!selectedWorldInfo?.length) {
        return [];
    }
    let entries = [];
    for (const worldName of selectedWorldInfo) {
        entries = entries.concat(loadWorldEntries(directories, worldName));
    }
    return entries;
}

/**
 * Port of getCharacterLore(). Preserves the client's exact skip-precedence: a candidate world is
 * dropped if it's already covered by global lore, OR is the chat's own lorebook, OR is the
 * persona's lorebook - checked in that exact order (though since these are independent boolean
 * checks against the same worldName, order only matters for which debug message would have logged
 * client-side; the resulting skip/keep decision is identical either way).
 *
 * `characterExtraBooks` replaces the client's `world_info.charLore?.find((e) => e.name ===
 * fileName)?.extraBooks` lookup - the caller is expected to have already found the `charLore` entry
 * matching this character's on-disk filename (a `world_info_settings`-nested array of `{ name,
 * extraBooks }`, keyed by `getCharaFilename()`'s result) and pass just its `extraBooks` array (or
 * `[]`/`undefined` if the character has no such entry). This keeps the settings-array lookup - a
 * caller concern, same as `selectedWorldInfo`/`chatWorldName`/etc. - out of this module, rather than
 * resolving it here.
 *
 * ALSO ports the live client's embedded-`character_book` fallback (public/scripts/world-info.js
 * ~4592-4600, added after this port's original reference snippet was written - closed as a
 * follow-up rather than left as a real behavior gap): when `character.data.extensions.world` names
 * a World that does NOT actually exist on disk (common on imported cards whose linked book never
 * got exported/renamed alongside them), and the character card carries its own embedded
 * `character_book` with at least one entry, that embedded book's entries are converted via
 * `convertCharacterBook()` (above) and appended, tagged with the `EMBEDDED_WORLD_NAME` sentinel -
 * exactly matching the client. "Does not actually exist" is checked the same way the client's
 * `world_names.includes(baseWorldName)` does, but via `readWorldInfoFile(directories, baseWorldName,
 * false)` returning non-null (i.e. the file is actually present) instead of needing a separate
 * "list every lorebook name" primitive - no such primitive exists server-side yet, and this
 * existence check is behaviorally identical (a WI file with zero entries still "resolves", matching
 * the client's own name-list-membership semantics, not an entry-count check). The client's
 * `WORLDINFO_ENTRIES_LOADED` event emission is NOT ported - it exists purely for other client-side
 * subscribers (e.g. the WI editor UI) to react to a fresh load, which has no server-side analog to
 * be wired to yet; flagged as a real, narrow scope boundary, not an oversight.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {{data?: {extensions?: {world?: string}, character_book?: {entries?: any[]}}}|null} character
 * @param {string[]} characterExtraBooks
 * @param {string[]} selectedWorldInfo
 * @param {string|null} chatWorldName
 * @param {string|null} personaWorldLorebook
 * @returns {Array<object>}
 */
function getCharacterLore(directories, character, characterExtraBooks, selectedWorldInfo, chatWorldName, personaWorldLorebook) {
    const worldsToSearch = new Set();

    const baseWorldName = character?.data?.extensions?.world;
    if (baseWorldName) {
        worldsToSearch.add(baseWorldName);
    }
    for (const extraBook of characterExtraBooks ?? []) {
        worldsToSearch.add(extraBook);
    }

    let entries = [];
    for (const worldName of worldsToSearch) {
        if (selectedWorldInfo?.includes(worldName)) continue; // already in global
        if (chatWorldName === worldName) continue; // already in chat lore
        if (personaWorldLorebook === worldName) continue; // already in persona lore
        entries = entries.concat(loadWorldEntries(directories, worldName));
    }

    const baseWorldResolves = !!baseWorldName && readWorldInfoFile(directories, baseWorldName, false) !== null;
    const characterBook = character?.data?.character_book;
    if (!baseWorldResolves && characterBook?.entries?.length) {
        const converted = convertCharacterBook(characterBook);
        const embeddedEntries = Object.keys(converted.entries)
            .map((x) => converted.entries[x])
            .map(({ uid, ...rest }) => ({ uid, world: EMBEDDED_WORLD_NAME, ...rest }));
        entries = entries.concat(embeddedEntries);
    }

    return entries;
}

/**
 * Port of getChatLore().
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string|null} chatWorldName
 * @param {string[]} selectedWorldInfo
 * @returns {Array<object>}
 */
function getChatLore(directories, chatWorldName, selectedWorldInfo) {
    if (!chatWorldName) return [];
    if (selectedWorldInfo?.includes(chatWorldName)) return [];
    return loadWorldEntries(directories, chatWorldName);
}

/**
 * Port of getPersonaLore().
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string|null} chatWorldName
 * @param {string|null} personaWorldLorebook
 * @param {string[]} selectedWorldInfo
 * @returns {Array<object>}
 */
function getPersonaLore(directories, chatWorldName, personaWorldLorebook, selectedWorldInfo) {
    if (!personaWorldLorebook) return [];
    if (chatWorldName === personaWorldLorebook) return [];
    if (selectedWorldInfo?.includes(personaWorldLorebook)) return [];
    return loadWorldEntries(directories, personaWorldLorebook);
}

/**
 * Server-side port of public/scripts/world-info.js's `getSortedEntries()` (plus its 4 private
 * helpers `getGlobalLore`/`getCharacterLore`/`getChatLore`/`getPersonaLore`) - resolves WHICH
 * lorebook entries are candidates for world-info activation in the first place. This is the missing
 * piece feeding `worldInfoCandidates` into `src/text-completion-prompt-orchestrator.js`,
 * `src/text-completion-generation-input.js`, and `src/regex-scripts-engine.js`, all of which take
 * that array as an already-resolved caller input.
 *
 * Every client global the original functions read is replaced with an explicit param:
 * `selected_world_info` -> `selectedWorldInfo`, `getCurrentCharacter()` -> `character`,
 * `world_info.charLore` lookup -> `characterExtraBooks` (see getCharacterLore's doc comment above
 * for why that lookup is left to the caller), `chat_metadata[METADATA_KEY]` -> `chatWorldName`,
 * `power_user.persona_description_lorebook` -> `personaWorldLorebook`,
 * `world_info_character_strategy` -> `worldInfoCharacterStrategy`.
 *
 * `getStringHash` is reused as-is from `public/scripts/hash-utils.js` (already the canonical
 * server-side import used throughout `src/`, e.g. `src/macro-substitution.js`,
 * `src/character-metadata-db.js`) rather than re-derived - it's the same file the client itself
 * imports it from, not a separate implementation to port.
 *
 * `structuredClone` at the end is kept for exact behavioral parity with the client, even though the
 * reasoning behind it there (avoid mutating cached `loadWorldInfo()` data that other client code
 * might hold a reference to) doesn't really apply here: `readWorldInfoFile()` parses a fresh object
 * from disk on every call and nothing else on the server holds a reference to it, so the clone is
 * strictly redundant on this side. Keeping it anyway costs one cheap clone and removes any chance of
 * a future caller accidentally mutating a shared cache should one ever get added later.
 *
 * @param {object} options
 * @param {import('../users.js').UserDirectoryList} options.directories User directories, for `readWorldInfoFile`
 * @param {string[]} [options.selectedWorldInfo] Names of the globally-selected lorebooks (replaces `selected_world_info`)
 * @param {{data?: {extensions?: {world?: string}}}|null} [options.character] The active character card (only `.data.extensions.world` is read - replaces `getCurrentCharacter()`)
 * @param {string[]} [options.characterExtraBooks] Extra lorebook names for this character, from the caller's own `world_info.charLore`-equivalent lookup (replaces `world_info.charLore?.find(...)?.extraBooks`)
 * @param {string|null} [options.chatWorldName] The current chat's own lorebook name, if any (replaces `chat_metadata[METADATA_KEY]`)
 * @param {string|null} [options.personaWorldLorebook] The active persona's lorebook name, if any (replaces `power_user.persona_description_lorebook`)
 * @param {number} [options.worldInfoCharacterStrategy] One of `world_info_insertion_strategy`'s values (replaces `world_info_character_strategy`)
 * @returns {Promise<Array<object>>} Entries shaped `{ ...entry, world, decorators, content, hash }`, highest priority first
 */
export async function resolveWorldInfoCandidates(options) {
    const {
        directories,
        selectedWorldInfo = [],
        character = null,
        characterExtraBooks = [],
        chatWorldName = null,
        personaWorldLorebook = null,
        worldInfoCharacterStrategy = world_info_insertion_strategy.character_first,
    } = options;

    try {
        const globalLore = getGlobalLore(directories, selectedWorldInfo);
        const characterLore = getCharacterLore(directories, character, characterExtraBooks, selectedWorldInfo, chatWorldName, personaWorldLorebook);
        const chatLore = getChatLore(directories, chatWorldName, selectedWorldInfo);
        const personaLore = getPersonaLore(directories, chatWorldName, personaWorldLorebook, selectedWorldInfo);

        let entries;
        switch (Number(worldInfoCharacterStrategy)) {
            case world_info_insertion_strategy.evenly:
                entries = [...globalLore, ...characterLore].sort(sortFn);
                break;
            case world_info_insertion_strategy.character_first:
                entries = [...characterLore.sort(sortFn), ...globalLore.sort(sortFn)];
                break;
            case world_info_insertion_strategy.global_first:
                entries = [...globalLore.sort(sortFn), ...characterLore.sort(sortFn)];
                break;
            default:
                entries = [...globalLore, ...characterLore].sort(sortFn);
                break;
        }

        // Chat lore always goes first, then persona lore, then the rest - regardless of strategy.
        entries = [...chatLore.sort(sortFn), ...personaLore.sort(sortFn), ...entries];

        entries = entries.map((entry) => {
            const [decorators, content] = parseDecorators(entry.content || '');
            return { ...entry, decorators, content };
        }).map((entry) => {
            const hash = getStringHash(JSON.stringify(entry));
            return { ...entry, hash };
        });

        return structuredClone(entries);
    } catch (e) {
        console.error(e);
        return [];
    }
}
