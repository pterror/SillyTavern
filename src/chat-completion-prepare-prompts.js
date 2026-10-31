import { buildChatCompletionSystemPrompts } from './chat-completion-system-prompts.js';
import { getPromptCollection, preparePrompt, isPromptDisabledForCharacter } from './chat-completion-prompt-collection.js';

/**
 * @typedef {import('./chat-completion-system-prompts.js').BuildChatCompletionSystemPromptsParams} BuildChatCompletionSystemPromptsParams
 * @typedef {import('./chat-completion-prompt-collection.js').RawPrompt} RawPrompt
 * @typedef {import('./chat-completion-prompt-collection.js').PromptOrderList} PromptOrderList
 * @typedef {import('./chat-completion-prompt-collection.js').PromptCollection} PromptCollection
 * @typedef {object} PreparePromptsForChatCompletionParams
 * @property {string} [scenario]
 * @property {string} [charPersonality]
 * @property {string} [worldInfoBefore]
 * @property {string} [worldInfoAfter]
 * @property {string} [charDescription]
 * @property {string} [quietPrompt]
 * @property {string} [bias]
 * @property {Record<string, import('./chat-completion-system-prompts.js').ExtensionPromptInput>} [extensionPrompts]
 * @property {string} [systemPromptOverride]
 * @property {string} [jailbreakPromptOverride]
 * @property {string} [type]
 * @property {string} [scenarioFormat]
 * @property {string} [personalityFormat]
 * @property {string} [groupNudgePrompt]
 * @property {string} [impersonationPrompt]
 * @property {string} [personaDescription]
 * @property {number} [personaDescriptionPosition]
 * @property {string} [wiFormat]
 * @property {import('./macro-substitution.js').SubstituteParamsContext} [macroContext]
 * @property {RawPrompt[]} [prompts]
 * @property {PromptOrderList[]} [promptOrder]
 * @property {string|number} [characterId]
 * @property {string[]} [groupMemberNames]
 */

/**
 * @param {PreparePromptsForChatCompletionParams} [params]
 * @returns {PromptCollection}
 */
export function preparePromptsForChatCompletion({
    scenario,
    charPersonality,
    worldInfoBefore,
    worldInfoAfter,
    charDescription,
    quietPrompt,
    bias,
    extensionPrompts,
    systemPromptOverride,
    jailbreakPromptOverride,
    type,
    scenarioFormat,
    personalityFormat,
    groupNudgePrompt,
    impersonationPrompt,
    personaDescription,
    personaDescriptionPosition,
    wiFormat,
    macroContext = {},
    prompts: rawPrompts,
    promptOrder,
    characterId,
    groupMemberNames = [],
} = {}) {
    const systemPrompts = buildChatCompletionSystemPrompts({
        scenario,
        charPersonality,
        worldInfoBefore,
        worldInfoAfter,
        charDescription,
        quietPrompt,
        bias,
        extensionPrompts,
        scenarioFormat,
        personalityFormat,
        groupNudgePrompt,
        impersonationPrompt,
        personaDescription,
        personaDescriptionPosition,
        wiFormat,
        macroContext,
    });

    const prompts = getPromptCollection({
        prompts: rawPrompts,
        promptOrder,
        characterId,
        generationType: type,
        groupMemberNames,
        macroContext,
    });

    systemPrompts.forEach(prompt => {
        const collectionPrompt = prompts.get(prompt.identifier);

        if (collectionPrompt) {
            prompt.injection_position = collectionPrompt.injection_position ?? prompt.injection_position;
            prompt.injection_depth = collectionPrompt.injection_depth ?? prompt.injection_depth;
            prompt.injection_order = collectionPrompt.injection_order ?? prompt.injection_order;
            prompt.role = collectionPrompt.role ?? prompt.role;
        }

        const newPrompt = preparePrompt(prompt, { groupMemberNames, macroContext });
        const markerIndex = prompts.index(prompt.identifier);

        if (-1 !== markerIndex) prompts.collection[markerIndex] = newPrompt;
        else prompts.add(newPrompt);
    });

    const systemPrompt = prompts.get('main') ?? null;
    const isSystemPromptDisabled = isPromptDisabledForCharacter(promptOrder, characterId, 'main');
    if (systemPromptOverride && systemPrompt && systemPrompt.forbid_overrides !== true && !isSystemPromptDisabled) {
        const mainOriginalContent = systemPrompt.content;
        systemPrompt.content = systemPromptOverride;
        const mainReplacement = preparePrompt(systemPrompt, { original: mainOriginalContent, groupMemberNames, macroContext });
        prompts.override(mainReplacement, prompts.index('main'));
    }

    const jailbreakPrompt = prompts.get('jailbreak') ?? null;
    const isJailbreakPromptDisabled = isPromptDisabledForCharacter(promptOrder, characterId, 'jailbreak');
    if (jailbreakPromptOverride && jailbreakPrompt && jailbreakPrompt.forbid_overrides !== true && !isJailbreakPromptDisabled) {
        const jbOriginalContent = jailbreakPrompt.content;
        jailbreakPrompt.content = jailbreakPromptOverride;
        const jbReplacement = preparePrompt(jailbreakPrompt, { original: jbOriginalContent, groupMemberNames, macroContext });
        prompts.override(jbReplacement, prompts.index('jailbreak'));
    }

    return prompts;
}
