import { substituteParams } from './macro-substitution.js';
import { extension_prompt_types, extension_prompt_roles } from './extension-prompt-table.js';
import { persona_description_positions } from './story-string-assembly.js';

/**
 * @typedef {object} ExtensionPromptInput
 * @property {string} value
 * @property {number} [role]
 * @property {number} [position]
 * @property {number} [depth]
 */

/**
 * @typedef {object} SystemPromptEntry
 * @property {string} identifier
 * @property {string} role
 * @property {string} content
 * @property {string|false} [position]
 * @property {boolean} [extension]
 */

/**
 * @typedef {object} BuildChatCompletionSystemPromptsParams
 * @property {string} [scenario]
 * @property {string} [charPersonality]
 * @property {string} [worldInfoBefore]
 * @property {string} [worldInfoAfter]
 * @property {string} [charDescription]
 * @property {string} [quietPrompt]
 * @property {string} [bias]
 * @property {Record<string, ExtensionPromptInput>} [extensionPrompts]
 * @property {string} [scenarioFormat]
 * @property {string} [personalityFormat]
 * @property {string} [groupNudgePrompt]
 * @property {string} [impersonationPrompt]
 * @property {string} [personaDescription]
 * @property {number} [personaDescriptionPosition]
 * @property {string} [wiFormat]
 * @property {import('./macro-substitution.js').SubstituteParamsContext} [macroContext]
 */

/**
 * @param {string} format
 * @param {...any} args
 * @returns {string}
 */
function stringFormat(format, ...args) {
    return format.replace(/{(\d+)}/g, (match, number) => typeof args[number] !== 'undefined' ? args[number] : match);
}

/**
 * @param {string} value
 * @param {object} [options]
 * @param {string|null} [options.wiFormat]
 * @returns {string}
 */
export function formatWorldInfo(value, { wiFormat = null } = {}) {
    if (!value) {
        return '';
    }

    const format = wiFormat ?? '';

    if (!format.trim()) {
        return value;
    }

    return stringFormat(format, value);
}

/**
 * @param {number} position
 * @returns {string|false}
 */
export function getPromptPosition(position) {
    if (position == extension_prompt_types.BEFORE_PROMPT) {
        return 'start';
    }

    if (position == extension_prompt_types.IN_PROMPT) {
        return 'end';
    }

    return false;
}

/**
 * @param {number} role
 * @returns {string}
 */
export function getPromptRole(role) {
    switch (role) {
        case extension_prompt_roles.SYSTEM:
            return 'system';
        case extension_prompt_roles.USER:
            return 'user';
        case extension_prompt_roles.ASSISTANT:
            return 'assistant';
        default:
            return 'system';
    }
}

const knownExtensionPrompts = [
    '1_memory',
    '2_floating_prompt',
    '3_vectors',
    '4_vectors_data_bank',
    'chromadb',
    'PERSONA_DESCRIPTION',
    'QUIET_PROMPT',
    'DEPTH_PROMPT',
];

/**
 * @param {BuildChatCompletionSystemPromptsParams} [params]
 * @returns {SystemPromptEntry[]}
 */
export function buildChatCompletionSystemPrompts({
    scenario,
    charPersonality,
    worldInfoBefore,
    worldInfoAfter,
    charDescription,
    quietPrompt,
    bias,
    extensionPrompts = {},
    scenarioFormat,
    personalityFormat,
    groupNudgePrompt,
    impersonationPrompt,
    personaDescription,
    personaDescriptionPosition,
    wiFormat = null,
    macroContext = {},
} = {}) {
    const scenarioText = scenario && scenarioFormat ? substituteParams(scenarioFormat, macroContext) : (scenario || '');
    const charPersonalityText = charPersonality && personalityFormat ? substituteParams(personalityFormat, macroContext) : (charPersonality || '');
    const groupNudge = substituteParams(groupNudgePrompt, macroContext);
    const impersonationPromptText = impersonationPrompt ? substituteParams(impersonationPrompt, macroContext) : '';

    /** @type {SystemPromptEntry[]} */
    const systemPrompts = [
        { role: 'system', content: formatWorldInfo(worldInfoBefore, { wiFormat }), identifier: 'worldInfoBefore' },
        { role: 'system', content: formatWorldInfo(worldInfoAfter, { wiFormat }), identifier: 'worldInfoAfter' },
        { role: 'system', content: charDescription, identifier: 'charDescription' },
        { role: 'system', content: charPersonalityText, identifier: 'charPersonality' },
        { role: 'system', content: scenarioText, identifier: 'scenario' },
        { role: 'system', content: impersonationPromptText, identifier: 'impersonate' },
        { role: 'system', content: quietPrompt, identifier: 'quietPrompt' },
        { role: 'system', content: groupNudge, identifier: 'groupNudge' },
        { role: 'assistant', content: bias, identifier: 'bias' },
    ];

    const summary = extensionPrompts['1_memory'];
    if (summary && summary.value) systemPrompts.push({
        role: getPromptRole(summary.role),
        content: summary.value,
        identifier: 'summary',
        position: getPromptPosition(summary.position),
    });

    const authorsNote = extensionPrompts['2_floating_prompt'];
    if (authorsNote && authorsNote.value) systemPrompts.push({
        role: getPromptRole(authorsNote.role),
        content: authorsNote.value,
        identifier: 'authorsNote',
        position: getPromptPosition(authorsNote.position),
    });

    const vectorsMemory = extensionPrompts['3_vectors'];
    if (vectorsMemory && vectorsMemory.value) systemPrompts.push({
        role: 'system',
        content: vectorsMemory.value,
        identifier: 'vectorsMemory',
        position: getPromptPosition(vectorsMemory.position),
    });

    const vectorsDataBank = extensionPrompts['4_vectors_data_bank'];
    if (vectorsDataBank && vectorsDataBank.value) systemPrompts.push({
        role: getPromptRole(vectorsDataBank.role),
        content: vectorsDataBank.value,
        identifier: 'vectorsDataBank',
        position: getPromptPosition(vectorsDataBank.position),
    });

    const smartContext = extensionPrompts.chromadb;
    if (smartContext && smartContext.value) systemPrompts.push({
        role: 'system',
        content: smartContext.value,
        identifier: 'smartContext',
        position: getPromptPosition(smartContext.position),
    });

    if (personaDescription && personaDescriptionPosition === persona_description_positions.IN_PROMPT) {
        systemPrompts.push({ role: 'system', content: personaDescription, identifier: 'personaDescription' });
    }

    for (const key in extensionPrompts) {
        if (Object.hasOwn(extensionPrompts, key)) {
            const prompt = extensionPrompts[key];
            if (knownExtensionPrompts.includes(key)) continue;
            if (!prompt.value) continue;
            if (![extension_prompt_types.BEFORE_PROMPT, extension_prompt_types.IN_PROMPT].includes(prompt.position)) continue;

            systemPrompts.push({
                identifier: key.replace(/\W/g, '_'),
                position: getPromptPosition(prompt.position),
                role: getPromptRole(prompt.role),
                content: prompt.value,
                extension: true,
            });
        }
    }

    return systemPrompts;
}
