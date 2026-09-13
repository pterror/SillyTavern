import Handlebars from 'handlebars';
import { substituteParams, baseChatReplace } from './macro-substitution.js';
import { formatInstructModeStoryString } from './instruct-template-format.js';

/**
 * Server-side port of a slice of public/script.js's Generate() (~lines 5762-5822): the "story
 * string" assembly stage that combines character-card fields, world-info strings, and scenario
 * anchors into the character-card/system-prompt block placed at the top of the prompt (or, when
 * configured, injected in-chat instead).
 *
 * Like src/authors-note.js and src/macro-substitution.js, this takes every piece of context
 * explicitly instead of reading globals (power_user settings, the live extension_prompts
 * side-table) - the caller resolves those from its own request context:
 * - `worldInfoBefore`/`worldInfoAfter` are plain resolved strings - getWorldInfoPrompt() isn't
 *   fully ported/wired yet (only its activateWorldInfoEntries() engine lives in
 *   src/world-info/*.js), so resolving them is left to the caller, same as elsewhere in this effort.
 * - `beforeScenarioAnchor`/`afterScenarioAnchor` are likewise plain resolved strings - the client
 *   resolves them via getExtensionPrompt() reading the live extension_prompts side-table, which has
 *   no server-side equivalent yet.
 *
 * NOT ported: public/scripts/power-user.js's validateStoryString(), which renderStoryString() calls
 * before rendering. It's purely a UI warning/toast mechanism (accountStorage-backed, de-duplicated
 * via a hash cache) that warns once per template when a would-be-non-empty field isn't referenced -
 * it has no effect on the rendered output, so it's a documented gap, not a silently-guessed behavior.
 *
 * extension_prompt_types/extension_prompt_roles: re-mirrored locally (only the values used here),
 * same pattern as src/authors-note.js and src/instruct-template-format.js, rather than importing
 * from public/script.js. Cross-checked against public/script.js lines ~652-668.
 */

// Mirrored from public/script.js - only the values this module needs. Same mirroring pattern as
// src/authors-note.js and src/instruct-template-format.js.
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

// Mirrored from public/scripts/personas.js's persona_description_positions - only the value this
// module needs to gate `persona`.
export const persona_description_positions = {
    IN_PROMPT: 0,
};

/**
 * @typedef {object} StoryStringParams Shape rendered by the Handlebars story-string template.
 * @property {string} description
 * @property {string} personality
 * @property {string} persona
 * @property {string} scenario
 * @property {string} system
 * @property {string} char
 * @property {string} user
 * @property {string} wiBefore
 * @property {string} wiAfter
 * @property {string} loreBefore Same value as wiBefore - the client duplicates it so the
 *  user-editable template can reference either name.
 * @property {string} loreAfter Same value as wiAfter, for the same reason.
 * @property {string} anchorBefore
 * @property {string} anchorAfter
 * @property {string} mesExamples
 * @property {string} mesExamplesRaw
 */

/**
 * @typedef {object} RenderStoryStringOptions
 * @property {string} storyStringTemplate Equivalent of power_user.context.story_string (or a
 *  caller-supplied override) - the user-editable Handlebars template.
 * @property {number} [storyStringPosition] One of extension_prompt_types, defaults to IN_PROMPT.
 * @property {import('./instruct-template-format.js').InstructSettings} [instructSettings] Equivalent of power_user.instruct.
 */

/**
 * Port of public/scripts/power-user.js's renderStoryString(), minus validateStoryString() (see
 * module doc comment for why that's skipped).
 * @param {StoryStringParams} storyStringParams
 * @param {RenderStoryStringOptions} options
 * @returns {string} The rendered story string.
 */
export function renderStoryString(storyStringParams, { storyStringTemplate, storyStringPosition = extension_prompt_types.IN_PROMPT, instructSettings = {} } = {}) {
    const compiledTemplate = Handlebars.compile(storyStringTemplate ?? '', { noEscape: true });

    let output = compiledTemplate(storyStringParams);

    // substitute {{macro}} params that are not defined in the story string
    output = substituteParams(output, { name1: storyStringParams.user, name2: storyStringParams.char });

    // remove leading newlines
    output = output.replace(/^\n+/, '');

    // add a newline to the end of the story string if it doesn't have one
    if (output.length > 0 && !output.endsWith('\n') && storyStringPosition !== extension_prompt_types.IN_CHAT) {
        if (!instructSettings.enabled || (instructSettings.wrap && !instructSettings.story_string_suffix)) {
            output += '\n';
        }
    }

    return output;
}

/**
 * @typedef {object} StoryStringInjection Equivalent of what the client would pass to
 *  setExtensionPrompt(inject_ids.STORY_STRING, ...) when the story string is configured to be
 *  injected in-chat instead of placed at the top of the prompt. No setExtensionPrompt-equivalent
 *  side-table exists server-side yet, so this is handed back to the caller to apply.
 * @property {string} content The combined story string to inject.
 * @property {number} depth Equivalent of power_user.context.story_string_depth (default 1).
 * @property {number} role One of extension_prompt_roles (default SYSTEM).
 */

/**
 * @typedef {object} AssembleStoryStringParams
 * @property {string} [description]
 * @property {string} [personality]
 * @property {string} [persona]
 * @property {string} [scenario]
 * @property {string} [system] Character-card `system` field (from getCharacterCardFields()) - an
 *  INPUT that may be conditionally overridden/nullified below, not something resolved here.
 * @property {string} [name1] Persona display name (`{{user}}`).
 * @property {string} [name2] Character display name (`{{char}}`).
 * @property {string} [worldInfoBefore] Caller-resolved wiBefore/loreBefore string.
 * @property {string} [worldInfoAfter] Caller-resolved wiAfter/loreAfter string.
 * @property {string} [beforeScenarioAnchor] Caller-resolved BEFORE_PROMPT extension-prompt string (untrimmed).
 * @property {string} [afterScenarioAnchor] Caller-resolved IN_PROMPT extension-prompt string (untrimmed).
 * @property {string[]} [mesExamplesArray] Instruct/plain-formatted example blocks, possibly emptied by stripExamples.
 * @property {string[]} [mesExamplesRawArray] Raw example blocks.
 * @property {boolean} [isInstruct] Whether the current template/mode is instruct mode.
 * @property {boolean} [sysPromptEnabled] Equivalent of power_user.sysprompt.enabled.
 * @property {string} [sysPromptContent] Equivalent of power_user.sysprompt.content.
 * @property {boolean} [preferCharacterPrompt] Equivalent of power_user.prefer_character_prompt.
 * @property {number} [personaDescriptionPosition] One of persona_description_positions.
 * @property {string} [storyStringTemplate] Equivalent of power_user.context.story_string.
 * @property {number} [storyStringPosition] One of extension_prompt_types (default IN_PROMPT).
 * @property {number} [storyStringDepth] Equivalent of power_user.context.story_string_depth (default 1).
 * @property {number} [storyStringRole] One of extension_prompt_roles (default SYSTEM).
 * @property {import('./instruct-template-format.js').InstructSettings} [instructPreset] Equivalent of power_user.instruct.
 * @property {object} [contextSettings] Equivalent of power_user.context - only story_string_position is read
 *  from it by formatInstructModeStoryString(); name1/name2 are added internally for that call.
 * @property {boolean} [stripExamples] Equivalent of power_user.strip_examples.
 * @property {string} mainApi Equivalent of main_api - when 'openai', system-prompt resolution and
 *  the in-chat story-string injection are both skipped, matching the client's `main_api !== 'openai'` guards.
 */

/**
 * @typedef {object} AssembleStoryStringResult
 * @property {string} system Possibly-resolved/nullified system prompt (see StoryString doc above).
 * @property {string} combinedStoryString The story string to place at the top of the prompt - ''
 *  when it was instead diverted to storyStringInjection.
 * @property {StoryStringInjection|null} storyStringInjection Non-null when the story string should
 *  be injected in-chat instead of placed at the top (mainApi !== 'openai' && storyStringPosition === IN_CHAT).
 * @property {string[]} mesExamplesArray Possibly-emptied (stripExamples) copy of the input mesExamplesArray.
 */

/**
 * Port of the story-string assembly slice of public/script.js's Generate() (~lines 5762-5822):
 * system-prompt resolution for non-OpenAI backends, storyStringParams construction, rendering,
 * instruct-mode combination, and the story-string-as-in-chat-injection decision.
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
} = {}) {
    // Prepare the system prompt for Text Completion APIs. Skipped entirely for OpenAI (Chat
    // Completion) - `system` passes through unmodified, matching the client's
    // `if (main_api !== 'openai')` guard.
    if (mainApi !== 'openai') {
        if (sysPromptEnabled) {
            system = preferCharacterPrompt && system
                ? substituteParams(system, { original: sysPromptContent ?? '' })
                : baseChatReplace(sysPromptContent, { name1, name2 });
            system = isInstruct ? substituteParams(system, { original: sysPromptContent ?? '' }) : system;
        } else {
            // Nullify if it's not enabled
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

    // Render the story string and combine with injections
    const storyString = renderStoryString(storyStringParams, { storyStringTemplate, storyStringPosition, instructSettings: instructPreset });
    let combinedStoryString = isInstruct
        ? formatInstructModeStoryString(storyString, instructPreset, { ...contextSettings, name1, name2 })
        : storyString;

    // Inject the story string as an in-chat prompt (if needed), instead of setExtensionPrompt()
    // (no shared side-table exists server-side yet) - return both possible outcomes so the caller
    // can decide what to do with the injection.
    const applyStoryStringInject = mainApi !== 'openai' && storyStringPosition === extension_prompt_types.IN_CHAT;
    /** @type {StoryStringInjection|null} */
    let storyStringInjection = null;
    if (applyStoryStringInject) {
        storyStringInjection = {
            content: combinedStoryString,
            depth: storyStringDepth ?? 1,
            role: storyStringRole ?? extension_prompt_roles.SYSTEM,
        };
        // Remove to prevent duplication
        combinedStoryString = '';
    }

    // Story string rendered, safe to remove
    const resultMesExamplesArray = stripExamples ? [] : mesExamplesArray;

    return { system, combinedStoryString, storyStringInjection, mesExamplesArray: resultMesExamplesArray };
}
