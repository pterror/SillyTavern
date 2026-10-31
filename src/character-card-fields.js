import { readCardContent } from './endpoints/characters.js';
import { getGroupsByIds } from './endpoints/groups.js';
import { baseChatReplace } from './macro-substitution.js';

/** @typedef {import('./macro-substitution.js').CharacterCardFields} CharacterCardFields */

const extension_prompt_roles = {
    SYSTEM: 0,
    USER: 1,
    ASSISTANT: 2,
};

const DEPTH_PROMPT_DEPTH_DEFAULT = 4;

/**
 * @param {string|number} [roleName]
 * @returns {number}
 */
function getExtensionPromptRoleByName(roleName) {
    if (typeof roleName === 'number' && Object.values(extension_prompt_roles).includes(roleName)) {
        return roleName;
    }
    switch (roleName) {
        case 'system':
            return extension_prompt_roles.SYSTEM;
        case 'user':
            return extension_prompt_roles.USER;
        case 'assistant':
            return extension_prompt_roles.ASSISTANT;
    }
    return extension_prompt_roles.SYSTEM;
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} avatar
 * @returns {Promise<object|null>}
 */
async function loadCharacter(directories, avatar) {
    if (!avatar) return null;
    try {
        const raw = await readCardContent(directories, avatar);
        if (raw === undefined) return null;
        return JSON.parse(raw);
    } catch (error) {
        console.error(`[character-card-fields] Failed to load character "${avatar}":`, error);
        return null;
    }
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {object} group
 * @param {string} characterAvatar
 * @param {object} chatMetadata
 * @returns {Promise<{description: string, personality: string, scenario: string, mesExamples: string}|null>}
 */
async function computeGroupCards(directories, group, characterAvatar, chatMetadata, macroContext) {
    if (!group || !group.generation_mode || !Array.isArray(group.members) || !group.members.length) {
        return null;
    }

    const APPEND_DISABLED = 2;
    const disabledMembers = Array.isArray(group.disabled_members) ? group.disabled_members : [];

    /** @type {Map<string, object|null>} */
    const memberCache = new Map();
    async function getMember(memberAvatar) {
        if (memberCache.has(memberAvatar)) return memberCache.get(memberAvatar);
        const character = await loadCharacter(directories, memberAvatar);
        memberCache.set(memberAvatar, character);
        return character;
    }

    function customTransform(value, fieldName, characterName, trim) {
        if (!value) return '';
        value = value.replace(/<FIELDNAME>/gi, fieldName);
        value = trim ? value.trim() : value;
        return baseChatReplace(value, { ...macroContext, name2: characterName });
    }

    function replaceAndPrepareForJoin(value, characterName, fieldName, preprocess = null) {
        value = value?.trim() ?? '';
        if (!value) return '';
        if (typeof preprocess === 'function') {
            value = preprocess(value);
        }
        const prefix = customTransform(group.generation_mode_join_prefix, fieldName, characterName, false);
        const suffix = customTransform(group.generation_mode_join_suffix, fieldName, characterName, false);
        value = customTransform(value, fieldName, characterName, true);
        return `${prefix}${value}${suffix}`;
    }

    async function collectField(fieldName, getter, preprocess = null) {
        const values = [];
        for (const member of group.members) {
            const character = await getMember(member);
            if (!character) continue;
            if (disabledMembers.includes(member) && characterAvatar !== member && group.generation_mode !== APPEND_DISABLED) {
                continue;
            }
            values.push(replaceAndPrepareForJoin(getter(character), character.name, fieldName, preprocess));
        }
        return values.filter(x => x.length).join('\n');
    }

    const scenarioOverride = String(chatMetadata?.scenario || '');
    const mesExamplesOverride = String(chatMetadata?.mes_example || '');

    const [description, personality] = await Promise.all([
        collectField('Description', c => c.description),
        collectField('Personality', c => c.personality),
    ]);

    const scenario = baseChatReplace(scenarioOverride.trim(), macroContext)
        || await collectField('Scenario', c => c.scenario);
    const mesExamples = baseChatReplace(mesExamplesOverride.trim(), macroContext)
        || await collectField('Example Messages', c => c.mes_example, x => (!x.startsWith('<START>') ? `<START>\n${x}` : x));

    return { description, personality, scenario, mesExamples };
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} groupId
 * @param {string} characterAvatar
 * @param {import('./macro-substitution.js').SubstituteParamsContext} [macroContext]
 * @returns {Promise<{text: string, depth: number, role: number}[]>}
 */
export async function getGroupCharacterDepthPrompts(directories, groupId, characterAvatar, macroContext = {}) {
    if (!groupId) return [];
    const group = (await getGroupsByIds(directories, [groupId]))[groupId] ?? null;
    if (!group || !Array.isArray(group.members) || !group.members.length) return [];

    const SWAP = 0;
    if (group.generation_mode === SWAP) return [];

    const disabledMembers = Array.isArray(group.disabled_members) ? group.disabled_members : [];

    const depthPrompts = [];
    for (const member of group.members) {
        const character = await loadCharacter(directories, member);
        if (!character) continue;
        if (disabledMembers.includes(member) && characterAvatar !== member) continue;

        const depthPromptText = baseChatReplace(character.data?.extensions?.depth_prompt?.prompt?.trim(), { ...macroContext, name2: character.name }) || '';
        const depthPromptDepth = character.data?.extensions?.depth_prompt?.depth ?? DEPTH_PROMPT_DEPTH_DEFAULT;
        const depthPromptRole = getExtensionPromptRoleByName(character.data?.extensions?.depth_prompt?.role ?? 'system');

        if (depthPromptText) {
            depthPrompts.push({ text: depthPromptText, depth: depthPromptDepth, role: depthPromptRole });
        }
    }
    return depthPrompts;
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {object} options
 * @param {string} [options.avatar]
 * @param {string} [options.groupId]
 * @param {boolean} [options.preferCharacterPrompt]
 * @param {boolean} [options.preferCharacterJailbreak]
 * @param {string} [options.personaDescription]
 * @param {object} [options.chatMetadata]
 * @param {import('./macro-substitution.js').SubstituteParamsContext} [options.macroContext]
 * @returns {Promise<CharacterCardFields & {charDepthPromptDepth: number, charDepthPromptRole: number}>}
 */
export async function getCharacterCardFields(directories, options = {}) {
    const {
        avatar,
        groupId,
        preferCharacterPrompt = false,
        preferCharacterJailbreak = false,
        personaDescription,
        chatMetadata = {},
        macroContext = {},
    } = options;

    const character = await loadCharacter(directories, avatar);
    const useGroupCards = Boolean(groupId) && Boolean(character);
    const group = useGroupCards ? ((await getGroupsByIds(directories, [groupId]))[groupId] ?? null) : null;
    const groupCards = group ? await computeGroupCards(directories, group, avatar, chatMetadata, macroContext) : null;

    const name2 = character?.name || undefined;
    const names = { ...macroContext, name2 };

    const persona = baseChatReplace(personaDescription?.trim(), names);

    if (!character) {
        return {
            system: '',
            mesExamples: '',
            description: '',
            personality: '',
            persona,
            scenario: '',
            jailbreak: '',
            version: '',
            charDepthPrompt: '',
            charDepthPromptDepth: DEPTH_PROMPT_DEPTH_DEFAULT,
            charDepthPromptRole: extension_prompt_roles.SYSTEM,
            creatorNotes: '',
            firstMessage: '',
            alternateGreetings: [],
        };
    }

    const systemPrompt = chatMetadata?.system_prompt || character.data?.system_prompt || '';
    const system = preferCharacterPrompt ? baseChatReplace(systemPrompt.trim(), names) : '';

    const jailbreak = preferCharacterJailbreak
        ? baseChatReplace(character.data?.post_history_instructions?.trim(), names)
        : '';

    const version = character?.data?.character_version ?? '';
    const charDepthPrompt = baseChatReplace(character.data?.extensions?.depth_prompt?.prompt?.trim(), names);
    const charDepthPromptDepth = character.data?.extensions?.depth_prompt?.depth ?? DEPTH_PROMPT_DEPTH_DEFAULT;
    const charDepthPromptRole = getExtensionPromptRoleByName(character.data?.extensions?.depth_prompt?.role ?? 'system');
    const creatorNotes = baseChatReplace(character.data?.creator_notes?.trim(), names);

    const description = groupCards ? groupCards.description : baseChatReplace(character.description?.trim(), names);
    const personality = groupCards ? groupCards.personality : baseChatReplace(character.personality?.trim(), names);

    const scenarioText = chatMetadata?.scenario || character.scenario || '';
    const scenario = groupCards ? groupCards.scenario : baseChatReplace(scenarioText.trim(), names);

    const exampleDialog = chatMetadata?.mes_example || character.mes_example || '';
    const mesExamples = groupCards ? groupCards.mesExamples : baseChatReplace(exampleDialog.trim(), names);

    const firstMes = character.first_mes?.trim() || '';
    const firstMessage = baseChatReplace(firstMes, names);

    const altGreetings = character.data?.alternate_greetings;
    const alternateGreetings = Array.isArray(altGreetings)
        ? altGreetings.map(greeting => baseChatReplace(greeting?.trim(), names))
        : [];

    return {
        system,
        mesExamples,
        description,
        personality,
        persona,
        scenario,
        jailbreak,
        version,
        charDepthPrompt,
        charDepthPromptDepth,
        charDepthPromptRole,
        creatorNotes,
        firstMessage,
        alternateGreetings,
    };
}
