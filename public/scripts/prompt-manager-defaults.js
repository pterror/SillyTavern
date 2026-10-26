// The chat completion prompt manager's defaults: its prompts, and the order of a prompt list it makes. A leaf module:
// the server builds chat completion prompts from them too.

/** The prompt order chat completion uses for everyone, under this id in `prompt_order` (the global strategy). */
export const GLOBAL_PROMPT_ORDER_ID = 100001;

export const chatCompletionDefaultPrompts = {
    'prompts': [
        {
            'name': 'Main Prompt',
            'system_prompt': true,
            'role': 'system',
            'content': 'Write {{char}}\'s next reply in a fictional chat between {{charIfNotGroup}} and {{user}}.',
            'identifier': 'main',
        },
        {
            'name': 'Auxiliary Prompt',
            'system_prompt': true,
            'role': 'system',
            'content': '',
            'identifier': 'nsfw',
        },
        {
            'identifier': 'dialogueExamples',
            'name': 'Chat Examples',
            'system_prompt': true,
            'marker': true,
        },
        {
            'name': 'Post-History Instructions',
            'system_prompt': true,
            'role': 'system',
            'content': '',
            'identifier': 'jailbreak',
        },
        {
            'identifier': 'chatHistory',
            'name': 'Chat History',
            'system_prompt': true,
            'marker': true,
        },
        {
            'identifier': 'worldInfoAfter',
            'name': 'World Info (after)',
            'system_prompt': true,
            'marker': true,
        },
        {
            'identifier': 'worldInfoBefore',
            'name': 'World Info (before)',
            'system_prompt': true,
            'marker': true,
        },
        {
            'identifier': 'enhanceDefinitions',
            'role': 'system',
            'name': 'Enhance Definitions',
            'content': 'If you have more knowledge of {{char}}, add to the character\'s lore and personality to enhance them but keep the Character Sheet\'s definitions absolute.',
            'system_prompt': true,
            'marker': false,
        },
        {
            'identifier': 'charDescription',
            'name': 'Char Description',
            'system_prompt': true,
            'marker': true,
        },
        {
            'identifier': 'charPersonality',
            'name': 'Char Personality',
            'system_prompt': true,
            'marker': true,
        },
        {
            'identifier': 'scenario',
            'name': 'Scenario',
            'system_prompt': true,
            'marker': true,
        },
        {
            'identifier': 'personaDescription',
            'name': 'Persona Description',
            'system_prompt': true,
            'marker': true,
        },
    ],
};

export const promptManagerDefaultPromptOrders = {
    'prompt_order': [],
};

export const promptManagerDefaultPromptOrder = [
    {
        'identifier': 'main',
        'enabled': true,
    },
    {
        'identifier': 'worldInfoBefore',
        'enabled': true,
    },
    {
        'identifier': 'personaDescription',
        'enabled': true,
    },
    {
        'identifier': 'charDescription',
        'enabled': true,
    },
    {
        'identifier': 'charPersonality',
        'enabled': true,
    },
    {
        'identifier': 'scenario',
        'enabled': true,
    },
    {
        'identifier': 'enhanceDefinitions',
        'enabled': false,
    },
    {
        'identifier': 'nsfw',
        'enabled': true,
    },
    {
        'identifier': 'worldInfoAfter',
        'enabled': true,
    },
    {
        'identifier': 'dialogueExamples',
        'enabled': true,
    },
    {
        'identifier': 'chatHistory',
        'enabled': true,
    },
    {
        'identifier': 'jailbreak',
        'enabled': true,
    },
];

/**
 * The prompts as the prompt manager uses them: the defaults, when there are none; else with every default prompt they
 * lack added (PromptManager's checkForMissingPrompts()), such as the persona's description.
 * @param {object[] | undefined} prompts
 * @returns {object[]}
 */
export function promptsWithDefaults(prompts) {
    if (!Array.isArray(prompts) || prompts.length === 0) return structuredClone(chatCompletionDefaultPrompts.prompts);
    const missing = chatCompletionDefaultPrompts.prompts.filter(d => !prompts.some(p => p?.identifier === d.identifier));
    return [...prompts, ...structuredClone(missing)];
}

/**
 * The prompt orders as the prompt manager uses them: with the default order under `characterId` when there is none
 * for it (PromptManager's sanitizeServiceSettings()).
 * @param {{ character_id: number | string, order: { identifier: string, enabled: boolean }[] }[] | undefined} promptOrders
 * @param {number | string} characterId
 */
export function promptOrdersWithDefault(promptOrders, characterId) {
    const orders = Array.isArray(promptOrders) ? promptOrders : [];
    const own = orders.find(list => String(list.character_id) === String(characterId));
    if (own && Array.isArray(own.order) && own.order.length > 0) return orders;
    return [...orders.filter(list => list !== own), { character_id: characterId, order: structuredClone(promptManagerDefaultPromptOrder) }];
}
