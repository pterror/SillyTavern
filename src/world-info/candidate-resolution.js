import { readWorldInfo, getCharacterWorldLink } from '../endpoints/worldinfo.js';
import { character_world_link } from '../../public/scripts/character-world-link.js';
import { parseDecorators } from './decorators.js';
import { getStringHash } from '../../public/scripts/hash-utils.js';
import { world_info_position } from './result-bucketing.js';
import { world_info_logic } from './key-matching.js';
import { extension_prompt_roles } from '../extension-prompt-table.js';

export const EMBEDDED_WORLD_NAME = '__embedded__';

const DEFAULT_DEPTH = 4;
const DEFAULT_WEIGHT = 100;

/**
 * @param {object} characterBook
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

export const world_info_insertion_strategy = {
    evenly: 0,
    character_first: 1,
    global_first: 2,
};

/**
 * @param {object} a
 * @param {object} b
 * @returns {number}
 */
function sortFn(a, b) {
    return b.order - a.order;
}

/**
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} worldName
 * @returns {Promise<Array<object>>}
 */
async function loadWorldEntries(directories, worldName) {
    const data = await readWorldInfo(directories, worldName, true);
    if (!data?.entries) {
        return [];
    }
    return Object.keys(data.entries)
        .map((x) => data.entries[x])
        .map(({ uid, ...rest }) => ({ uid, world: worldName, ...rest }));
}

/**
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string[]} selectedWorldInfo
 * @returns {Promise<Array<object>>}
 */
async function getGlobalLore(directories, selectedWorldInfo) {
    if (!selectedWorldInfo?.length) {
        return [];
    }
    let entries = [];
    for (const worldName of selectedWorldInfo) {
        entries = entries.concat(await loadWorldEntries(directories, worldName));
    }
    return entries;
}

/**
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {{data?: {extensions?: {world?: string}, character_book?: {entries?: any[]}}}|null} character
 * @param {string[]} characterExtraBooks
 * @param {string[]} selectedWorldInfo
 * @param {string|null} chatWorldName
 * @param {string|null} personaWorldLorebook
 * @returns {Promise<Array<object>>}
 */
async function getCharacterLore(directories, character, characterExtraBooks, selectedWorldInfo, chatWorldName, personaWorldLorebook) {
    const worldsToSearch = new Set();

    const baseWorldName = character?.data?.extensions?.world;
    if (baseWorldName) {
        worldsToSearch.add(baseWorldName);
    }
    for (const extraBook of characterExtraBooks ?? []) {
        worldsToSearch.add(extraBook);
    }

    const worldLink = getCharacterWorldLink(directories, character);

    let entries = [];
    for (const worldName of worldsToSearch) {
        if (selectedWorldInfo?.includes(worldName)) continue;
        if (chatWorldName === worldName) continue;
        if (personaWorldLorebook === worldName) continue;
        if (worldName === baseWorldName && worldLink === character_world_link.EMBEDDED) continue;
        entries = entries.concat(await loadWorldEntries(directories, worldName));
    }

    const characterBook = character?.data?.character_book;
    if (worldLink !== character_world_link.FILE && characterBook?.entries?.length) {
        const converted = convertCharacterBook(characterBook);
        const embeddedEntries = Object.keys(converted.entries)
            .map((x) => converted.entries[x])
            .map(({ uid, ...rest }) => ({ uid, world: EMBEDDED_WORLD_NAME, ...rest }));
        entries = entries.concat(embeddedEntries);
    }

    return entries;
}

/**
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string|null} chatWorldName
 * @param {string[]} selectedWorldInfo
 * @returns {Promise<Array<object>>}
 */
async function getChatLore(directories, chatWorldName, selectedWorldInfo) {
    if (!chatWorldName) return [];
    if (selectedWorldInfo?.includes(chatWorldName)) return [];
    return loadWorldEntries(directories, chatWorldName);
}

/**
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string|null} chatWorldName
 * @param {string|null} personaWorldLorebook
 * @param {string[]} selectedWorldInfo
 * @returns {Promise<Array<object>>}
 */
async function getPersonaLore(directories, chatWorldName, personaWorldLorebook, selectedWorldInfo) {
    if (!personaWorldLorebook) return [];
    if (chatWorldName === personaWorldLorebook) return [];
    if (selectedWorldInfo?.includes(personaWorldLorebook)) return [];
    return loadWorldEntries(directories, personaWorldLorebook);
}

/**
 * @param {object} options
 * @param {import('../users.js').UserDirectoryList} options.directories
 * @param {string[]} [options.selectedWorldInfo]
 * @param {{data?: {extensions?: {world?: string}}}|null} [options.character]
 * @param {string[]} [options.characterExtraBooks]
 * @param {string|null} [options.chatWorldName]
 * @param {string|null} [options.personaWorldLorebook]
 * @param {number} [options.worldInfoCharacterStrategy]
 * @returns {Promise<Array<object>>}
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
        const globalLore = await getGlobalLore(directories, selectedWorldInfo);
        const characterLore = await getCharacterLore(directories, character, characterExtraBooks, selectedWorldInfo, chatWorldName, personaWorldLorebook);
        const chatLore = await getChatLore(directories, chatWorldName, selectedWorldInfo);
        const personaLore = await getPersonaLore(directories, chatWorldName, personaWorldLorebook, selectedWorldInfo);

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
