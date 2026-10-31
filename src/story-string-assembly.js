import Handlebars from 'handlebars';
import { substituteParams, baseChatReplace } from './macro-substitution.js';
import { formatInstructModeStoryString } from './instruct-template-format.js';

export const extension_prompt_types = {
    IN_PROMPT: 0,
    IN_CHAT: 1,
    BEFORE_PROMPT: 2,
};

export const extension_prompt_roles = {
    SYSTEM: 0,
    USER: 1,
    ASSISTANT: 2,
};

export const persona_description_positions = {
    IN_PROMPT: 0,
};

/**
 * @typedef {object} StoryStringParams
 * @property {string} description
 * @property {string} personality
 * @property {string} persona
 * @property {string} scenario
 * @property {string} system
 * @property {string} char
 * @property {string} user
 * @property {string} wiBefore
 * @property {string} wiAfter
 * @property {string} loreBefore
 * @property {string} loreAfter
 * @property {string} anchorBefore
 * @property {string} anchorAfter
 * @property {string} mesExamples
 * @property {string} mesExamplesRaw
 */

/**
 * @typedef {object} RenderStoryStringOptions
 * @property {string} storyStringTemplate
 * @property {number} [storyStringPosition]
 * @property {import('./instruct-template-format.js').InstructSettings} [instructSettings]
 * @property {import('./macro-substitution.js').SubstituteParamsContext} [macroContext]
 */

/**
 * @param {StoryStringParams} storyStringParams
 * @param {RenderStoryStringOptions} options
 * @returns {string}
 */
export function renderStoryString(storyStringParams, { storyStringTemplate, storyStringPosition = extension_prompt_types.IN_PROMPT, instructSettings = {}, macroContext = {} } = {}) {
    const compiledTemplate = Handlebars.compile(storyStringTemplate ?? '', { noEscape: true });

    let output = compiledTemplate(storyStringParams);

    output = substituteParams(output, { ...macroContext, name1: storyStringParams.user, name2: storyStringParams.char });

    output = output.replace(/^\n+/, '');

    if (output.length > 0 && !output.endsWith('\n') && storyStringPosition !== extension_prompt_types.IN_CHAT) {
        if (!instructSettings.enabled || (instructSettings.wrap && !instructSettings.story_string_suffix)) {
            output += '\n';
        }
    }

    return output;
}

/**
 * @typedef {object} StoryStringInjection
 * @property {string} content
 * @property {number} depth
 * @property {number} role
 */

/**
 * @typedef {object} AssembleStoryStringParams
 * @property {string} [description]
 * @property {string} [personality]
 * @property {string} [persona]
 * @property {string} [scenario]
 * @property {string} [system]
 * @property {string} [name1]
 * @property {string} [name2]
 * @property {string} [worldInfoBefore]
 * @property {string} [worldInfoAfter]
 * @property {string} [beforeScenarioAnchor]
 * @property {string} [afterScenarioAnchor]
 * @property {string[]} [mesExamplesArray]
 * @property {string[]} [mesExamplesRawArray]
 * @property {boolean} [isInstruct]
 * @property {boolean} [sysPromptEnabled]
 * @property {string} [sysPromptContent]
 * @property {boolean} [preferCharacterPrompt]
 * @property {number} [personaDescriptionPosition]
 * @property {string} [storyStringTemplate]
 * @property {number} [storyStringPosition]
 * @property {number} [storyStringDepth]
 * @property {number} [storyStringRole]
 * @property {import('./instruct-template-format.js').InstructSettings} [instructPreset]
 * @property {object} [contextSettings]
 * @property {boolean} [stripExamples]
 * @property {import('./macro-substitution.js').SubstituteParamsContext} [macroContext]
 * @property {string} mainApi
 */

/**
 * @typedef {object} AssembleStoryStringResult
 * @property {string} system
 * @property {string} combinedStoryString
 * @property {StoryStringInjection|null} storyStringInjection
 * @property {string[]} mesExamplesArray
 */

/**
 * @param {AssembleStoryStringParams} params
 * @returns {AssembleStoryStringResult}
 */
export function assembleStoryString({
    description = '',
    personality = '',
    persona = '',
    scenario = '',
    system = '',
    name1 = '',
    name2 = '',
    worldInfoBefore = '',
    worldInfoAfter = '',
    beforeScenarioAnchor = '',
    afterScenarioAnchor = '',
    mesExamplesArray = [],
    mesExamplesRawArray = [],
    isInstruct = false,
    sysPromptEnabled = false,
    sysPromptContent = '',
    preferCharacterPrompt = false,
    personaDescriptionPosition = persona_description_positions.IN_PROMPT,
    storyStringTemplate = '',
    storyStringPosition = extension_prompt_types.IN_PROMPT,
    storyStringDepth = 1,
    storyStringRole = extension_prompt_roles.SYSTEM,
    instructPreset = {},
    contextSettings = {},
    stripExamples = false,
    mainApi,
    macroContext = {},
} = {}) {
    if (mainApi !== 'openai') {
        if (sysPromptEnabled) {
            system = preferCharacterPrompt && system
                ? substituteParams(system, { ...macroContext, original: sysPromptContent ?? '' })
                : baseChatReplace(sysPromptContent, { ...macroContext, name1, name2 });
            system = isInstruct ? substituteParams(system, { ...macroContext, original: sysPromptContent ?? '' }) : system;
        } else {
            system = '';
        }
    }

    const storyStringParams = {
        description,
        personality,
        persona: personaDescriptionPosition == persona_description_positions.IN_PROMPT ? persona : '',
        scenario,
        system,
        char: name2,
        user: name1,
        wiBefore: worldInfoBefore,
        wiAfter: worldInfoAfter,
        loreBefore: worldInfoBefore,
        loreAfter: worldInfoAfter,
        anchorBefore: (beforeScenarioAnchor ?? '').trim(),
        anchorAfter: (afterScenarioAnchor ?? '').trim(),
        mesExamples: mesExamplesArray.join(''),
        mesExamplesRaw: mesExamplesRawArray.join(''),
    };

    const storyString = renderStoryString(storyStringParams, { storyStringTemplate, storyStringPosition, instructSettings: instructPreset, macroContext });
    let combinedStoryString = isInstruct
        ? formatInstructModeStoryString(storyString, instructPreset, { ...contextSettings, name1, name2, macroContext })
        : storyString;

    const applyStoryStringInject = mainApi !== 'openai' && storyStringPosition === extension_prompt_types.IN_CHAT;
    /** @type {StoryStringInjection|null} */
    let storyStringInjection = null;
    if (applyStoryStringInject) {
        storyStringInjection = {
            content: combinedStoryString,
            depth: storyStringDepth ?? 1,
            role: storyStringRole ?? extension_prompt_roles.SYSTEM,
        };
        combinedStoryString = '';
    }

    const resultMesExamplesArray = stripExamples ? [] : mesExamplesArray;

    return { system, combinedStoryString, storyStringInjection, mesExamplesArray: resultMesExamplesArray };
}
