import { deepMerge, tryParse } from './util.js';
import { readWorldInfoFile, getCharacterWorldLink } from './world-info-files.js';
import { character_world_link } from '../public/scripts/character-world-link.js';
import { getAtPath, setAtPath } from '../public/scripts/hash-utils.js';
export { computeContentIdentityHash, stripInstallLocalFields } from './card-identity-hash.js';

/**
 * @param {boolean} hoistDate
 */
export function getCharaCardV2(jsonObject, directories, hoistDate = true) {
    if (jsonObject.spec === undefined) {
        jsonObject = convertToV2(jsonObject, directories);

        if (hoistDate && !jsonObject.create_date) {
            jsonObject.create_date = new Date().toISOString();
        }
    } else {
        jsonObject = readFromV2(jsonObject);
    }
    return jsonObject;
}

/**
 * @param {object} char
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {object}
 */
export function convertToV2(char, directories) {
    const result = charaFormatData({
        json_data: JSON.stringify(char),
        ch_name: char.name,
        description: char.description,
        personality: char.personality,
        scenario: char.scenario,
        first_mes: char.first_mes,
        mes_example: char.mes_example,
        creator_notes: char.creatorcomment,
        talkativeness: char.talkativeness,
        fav: char.fav,
        creator: char.creator,
        tags: char.tags,
        depth_prompt_prompt: char.depth_prompt_prompt,
        depth_prompt_depth: char.depth_prompt_depth,
        depth_prompt_role: char.depth_prompt_role,
    }, directories);

    if (char.chat != null) {
        result.chat = char.chat;
    } else {
        delete result.chat;
    }
    result.create_date = char.create_date;

    return result;
}

export function unsetPrivateFields(char) {
    char.fav = false;
    setAtPath(char, 'data.extensions.fav', false);
    delete char.chat;
}

export function omitInstallLocalFields(char) {
    delete char.fav;
    delete char.data?.extensions?.fav;
    delete char.chat;
}

export function omitFavField(char) {
    delete char.fav;
    delete char.data?.extensions?.fav;
}

export function omitChatField(char) {
    delete char.chat;
}

export const V1_V2_FIELD_MAPPINGS = {
    name: 'name',
    description: 'description',
    personality: 'personality',
    scenario: 'scenario',
    first_mes: 'first_mes',
    mes_example: 'mes_example',
    talkativeness: 'extensions.talkativeness',
    fav: 'extensions.fav',
    tags: 'tags',
};

/**
 * @param {object} char
 * @returns {object}
 */
export function readFromV2(char) {
    if (char.data === undefined) {
        console.warn(`Char ${char.name} has Spec v2 data missing`);
        return char;
    }

    delete char.json_data;

    for (const [charField, v2Path] of Object.entries(V1_V2_FIELD_MAPPINGS)) {
        const v2Value = getAtPath(char.data, v2Path);
        if (v2Value === undefined) {
            let defaultValue = undefined;

            if (v2Path === 'extensions.talkativeness') {
                defaultValue = 0.5;
            }

            if (v2Path === 'extensions.fav') {
                defaultValue = false;
            }

            if (defaultValue !== undefined) {
                char[charField] = defaultValue;
            } else {
                console.warn(`Char ${char.name} has Spec v2 data missing for unknown field: ${charField}`);
                continue;
            }
        }
        if (char[charField] !== undefined && v2Value !== undefined && String(char[charField]) !== String(v2Value)) {
            console.warn(`Char ${char.name} has Spec v2 data mismatch with Spec v1 for field: ${charField}`, char[charField], v2Value);
        }
        char[charField] = v2Value;
    }

    return char;
}

/**
 * @param {object} data
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {object}
 */
export function charaFormatData(data, directories) {
    const char = tryParse(data.json_data) || {};

    delete char.json_data;

    const getAlternateGreetings = data => {
        if (Array.isArray(data.alternate_greetings)) return data.alternate_greetings;
        if (typeof data.alternate_greetings === 'string') return [data.alternate_greetings];
        return [];
    };

    char.name = data.ch_name;
    char.description = data.description || '';
    char.personality = data.personality || '';
    char.scenario = data.scenario || '';
    char.first_mes = data.first_mes || '';
    char.mes_example = data.mes_example || '';

    char.creatorcomment = data.creator_notes || '';
    char.avatar = 'none';
    char.talkativeness = data.talkativeness || 0.5;
    char.fav = data.fav == 'true';
    char.tags = typeof data.tags == 'string' ? (data.tags.split(',').map(x => x.trim()).filter(x => x)) : data.tags || [];

    char.spec = 'chara_card_v2';
    char.spec_version = '2.0';
    setAtPath(char, 'data.name', data.ch_name);
    setAtPath(char, 'data.description', data.description || '');
    setAtPath(char, 'data.personality', data.personality || '');
    setAtPath(char, 'data.scenario', data.scenario || '');
    setAtPath(char, 'data.first_mes', data.first_mes || '');
    setAtPath(char, 'data.mes_example', data.mes_example || '');

    setAtPath(char, 'data.creator_notes', data.creator_notes || '');
    setAtPath(char, 'data.system_prompt', data.system_prompt || '');
    setAtPath(char, 'data.post_history_instructions', data.post_history_instructions || '');
    setAtPath(char, 'data.tags', typeof data.tags == 'string' ? (data.tags.split(',').map(x => x.trim()).filter(x => x)) : data.tags || []);
    setAtPath(char, 'data.creator', data.creator || '');
    setAtPath(char, 'data.character_version', data.character_version || '');
    setAtPath(char, 'data.alternate_greetings', getAlternateGreetings(data));

    setAtPath(char, 'data.extensions.talkativeness', data.talkativeness || 0.5);
    setAtPath(char, 'data.extensions.fav', data.fav == 'true');
    setAtPath(char, 'data.extensions.world', data.world || '');

    const depth_default = 4;
    const role_default = 'system';
    const depth_value = !isNaN(Number(data.depth_prompt_depth)) ? Number(data.depth_prompt_depth) : depth_default;
    const role_value = data.depth_prompt_role ?? role_default;
    setAtPath(char, 'data.extensions.depth_prompt.prompt', data.depth_prompt_prompt ?? '');
    setAtPath(char, 'data.extensions.depth_prompt.depth', depth_value);
    setAtPath(char, 'data.extensions.depth_prompt.role', role_value);

    if (data.world && getCharacterWorldLink(directories, char) !== character_world_link.EMBEDDED) {
        try {
            const file = readWorldInfoFile(directories, data.world, false);

            if (file && file.entries) {
                setAtPath(char, 'data.character_book', convertWorldInfoToCharacterBook(data.world, file.entries));
            }
        } catch {
            console.warn(`Failed to read world info file: ${data.world}. Character book will not be available.`);
        }
    }

    if (data.extensions) {
        try {
            const extensions = JSON.parse(data.extensions);
            setAtPath(char, 'data.extensions', deepMerge(char.data.extensions, extensions));
        } catch {
            console.warn(`Failed to parse extensions JSON: ${data.extensions}`);
        }
    }

    return char;
}

/**
 * @param {string} name
 * @param {object} entries
 * @returns {{ entries: object[], name: string }}
 */
export function convertWorldInfoToCharacterBook(name, entries) {
    /** @type {{ entries: object[]; name: string }} */
    const result = { entries: [], name };

    for (const index in entries) {
        const entry = entries[index];

        const originalEntry = {
            id: entry.uid,
            keys: entry.key,
            secondary_keys: entry.keysecondary,
            comment: entry.comment,
            content: entry.content,
            constant: entry.constant,
            selective: entry.selective,
            insertion_order: entry.order,
            enabled: !entry.disable,
            position: entry.position == 0 ? 'before_char' : 'after_char',
            use_regex: true,
            extensions: {
                ...entry.extensions,
                position: entry.position,
                exclude_recursion: entry.excludeRecursion,
                display_index: entry.displayIndex,
                probability: entry.probability ?? null,
                useProbability: entry.useProbability ?? false,
                depth: entry.depth ?? 4,
                selectiveLogic: entry.selectiveLogic ?? 0,
                outlet_name: entry.outletName ?? '',
                group: entry.group ?? '',
                group_override: entry.groupOverride ?? false,
                group_weight: entry.groupWeight ?? null,
                prevent_recursion: entry.preventRecursion ?? false,
                delay_until_recursion: entry.delayUntilRecursion ?? false,
                scan_depth: entry.scanDepth ?? null,
                match_whole_words: entry.matchWholeWords ?? null,
                use_group_scoring: entry.useGroupScoring ?? false,
                case_sensitive: entry.caseSensitive ?? null,
                automation_id: entry.automationId ?? '',
                role: entry.role ?? 0,
                vectorized: entry.vectorized ?? false,
                sticky: entry.sticky ?? null,
                cooldown: entry.cooldown ?? null,
                delay: entry.delay ?? null,
                match_persona_description: entry.matchPersonaDescription ?? false,
                match_character_description: entry.matchCharacterDescription ?? false,
                match_character_personality: entry.matchCharacterPersonality ?? false,
                match_character_depth_prompt: entry.matchCharacterDepthPrompt ?? false,
                match_scenario: entry.matchScenario ?? false,
                match_creator_notes: entry.matchCreatorNotes ?? false,
                triggers: entry.triggers ?? [],
                ignore_budget: entry.ignoreBudget ?? false,
            },
        };

        result.entries.push(originalEntry);
    }

    return result;
}
