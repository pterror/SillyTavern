import { substituteParams } from './macro-substitution.js';
import { extension_prompt_types, extension_prompt_roles } from './extension-prompt-table.js';
import { persona_description_positions } from './story-string-assembly.js';

/**
 * Server-side port of a slice of public/scripts/chat-completion-settings.js: the plain-object,
 * non-PromptManager-dependent pieces of the Chat Completion (`main_api === 'openai'`) system-prompt
 * assembly pipeline.
 *
 * PORTED:
 * - formatWorldInfo() (~line 787): trivial wrapper around a `{0}`-style format string. The client's
 *   stringFormat() helper (public/scripts/utils.js ~line 738) is reproduced inline below rather than
 *   imported, since that file is a client-only utility module not meant to be pulled server-side.
 * - getPromptPosition()/getPromptRole() (~lines 1138/1155): trivial enum-to-string mappers. Reuse the
 *   already-mirrored extension_prompt_types/extension_prompt_roles enums from
 *   src/extension-prompt-table.js rather than redeclaring them.
 * - preparePromptsForChatCompletion()'s systemPrompts-array construction ONLY (~lines 1365-1465).
 *   Stops right before that function goes on to call `promptManager.getPromptCollection(type)`
 *   (~line 1468), which needs the ChatCompletion/PromptManager class infrastructure that does not
 *   exist server-side yet - EXPLICITLY OUT OF SCOPE for this port, tracked as a follow-up.
 *
 * JUDGMENT CALL - the `scenarioText`/`charPersonalityText` quirk: the client's exact code is
 *   `scenario && oai_settings.scenario_format ? substituteParams(oai_settings.scenario_format) : (scenario || '')`
 *   (and the equivalent for personality). Read character-by-character, this really does call
 *   substituteParams() on the FORMAT STRING itself (e.g. the user's raw "Circumstances and context of
 *   the dialogue: {{scenario}}" preset text), not on a template that has had `scenario`/
 *   `charPersonality` interpolated into it first. Because {{scenario}}/{{personality}} macros ARE
 *   handled by substituteParams() itself (it reads the live scenario/personality off the character
 *   card context, not off this function's local variables), this happens to still produce a
 *   reasonable-looking result on the client, where substituteParams() closes over global chat/character
 *   state - but it means the `scenario`/`charPersonality` PARAMETERS passed into this function are only
 *   used as an "is a format configured AND is there a value at all" gate, never actually interpolated
 *   directly into the output when a format is configured. This is a real, confirmed client quirk (not
 *   a misreading), and it is ported exactly as-is. Practical implication for callers of this port:
 *   whatever `scenario`/`charPersonality` values macro-substitution's `{{scenario}}`/{{personality}}}`
 *   macros resolve to (via `macroContext`) are what actually end up in the output when a format string
 *   is configured - the `scenario`/`charPersonality` arguments here mostly gate on truthiness in that
 *   branch, matching the client's real (arguably buggy) behavior.
 *
 * JUDGMENT CALL - the generic extension-prompt loop's `.filter` predicate (~line 1454 on the client):
 *   an arbitrary async function attached by a client-side extension, evaluated live at prompt-assembly
 *   time. There is no server-side extension-execution model to run arbitrary client-registered
 *   predicate functions (same gap already documented in src/extension-prompt-table.js's
 *   setExtensionPrompt() doc comment). This port does NOT invent a fake filter mechanism - it simply
 *   has no `.filter` step at all, equivalent to every extension prompt always passing its filter (the
 *   same "no filter" stance already taken by src/extension-prompt-table.js). A caller that wants an
 *   entry excluded for a "filter" reason must simply not include it (or set falsy `.value`) in the
 *   `extensionPrompts` object it passes in - there is no live per-entry predicate to opt into here.
 *
 * Like src/authors-note.js and src/story-string-assembly.js, this takes every piece of context
 * explicitly instead of reading `oai_settings`/`power_user` globals - the caller resolves those from
 * its own request context and passes them in.
 */

/**
 * @typedef {object} ExtensionPromptInput Shape of one entry in the caller-supplied `extensionPrompts`
 *  object, mirroring the client's live `extension_prompts` side-table entries as read by
 *  preparePromptsForChatCompletion().
 * @property {string} value
 * @property {number} [role] One of extension_prompt_roles.
 * @property {number} [position] One of extension_prompt_types.
 * @property {number} [depth] Unused by this module - present only for shape parity with the client's entries.
 */

/**
 * @typedef {object} SystemPromptEntry One entry of buildChatCompletionSystemPrompts()'s output array.
 * @property {string} identifier
 * @property {string} role 'system' | 'user' | 'assistant'.
 * @property {string} content
 * @property {string|false} [position] 'start' | 'end' | false - only present on the extension-prompt-derived entries.
 * @property {boolean} [extension] true only on entries pushed by the generic "unknown extension prompt" loop.
 */

/**
 * @typedef {object} BuildChatCompletionSystemPromptsParams
 * @property {string} [scenario] Character card scenario field.
 * @property {string} [charPersonality] Character card personality field.
 * @property {string} [worldInfoBefore] Resolved world-info-before string (pre-formatWorldInfo).
 * @property {string} [worldInfoAfter] Resolved world-info-after string (pre-formatWorldInfo).
 * @property {string} [charDescription] Character card description field.
 * @property {string} [quietPrompt] Instruction prompt for extras ("quiet" generation).
 * @property {string} [bias] Logit bias prompt text.
 * @property {Record<string, ExtensionPromptInput>} [extensionPrompts] Caller-supplied equivalent of the
 *  client's live `extension_prompts` side-table, keyed by the same literal string keys the client uses
 *  ('1_memory', '2_floating_prompt', '3_vectors', '4_vectors_data_bank', 'chromadb', plus any others).
 * @property {string} [scenarioFormat] Equivalent of oai_settings.scenario_format.
 * @property {string} [personalityFormat] Equivalent of oai_settings.personality_format.
 * @property {string} [groupNudgePrompt] Equivalent of oai_settings.group_nudge_prompt (raw, pre-substituteParams).
 * @property {string} [impersonationPrompt] Equivalent of oai_settings.impersonation_prompt (raw, pre-substituteParams).
 * @property {string} [personaDescription] Equivalent of power_user.persona_description.
 * @property {number} [personaDescriptionPosition] Equivalent of power_user.persona_description_position (one of persona_description_positions).
 * @property {string} [wiFormat] Equivalent of oai_settings.wi_format, forwarded to formatWorldInfo().
 * @property {import('./macro-substitution.js').SubstituteParamsContext} [macroContext] Forwarded to every substituteParams() call this function makes.
 */

/**
 * Port of public/scripts/utils.js's stringFormat() (~line 738) - reproduced inline (see module doc
 * comment for why it isn't imported from the client file).
 * @param {string} format
 * @param  {...any} args
 * @returns {string}
 */
function stringFormat(format, ...args) {
    return format.replace(/{(\d+)}/g, (match, number) => typeof args[number] !== 'undefined' ? args[number] : match);
}

/**
 * Port of public/scripts/chat-completion-settings.js's formatWorldInfo() (~line 787).
 * @param {string} value
 * @param {object} [options]
 * @param {string|null} [options.wiFormat] Equivalent of oai_settings.wi_format. Required (no
 *  client-global fallback exists server-side) whenever `value` is truthy.
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
 * Port of public/scripts/chat-completion-settings.js's getPromptPosition() (~line 1138).
 * @param {number} position One of extension_prompt_types.
 * @returns {string|false} 'start' | 'end' | false.
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
 * Port of public/scripts/chat-completion-settings.js's getPromptRole() (~line 1155).
 * @param {number} role One of extension_prompt_roles.
 * @returns {string} 'system' | 'user' | 'assistant'.
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

// Literal list reproduced from public/scripts/chat-completion-settings.js's preparePromptsForChatCompletion()
// (~line 1435) - keys the generic "unknown extension prompt" loop below must skip because they're
// either handled by their own dedicated push above, or (PERSONA_DESCRIPTION/QUIET_PROMPT/DEPTH_PROMPT)
// handled elsewhere in the client's pipeline that this port does not cover.
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
 * Port of the systemPrompts-array construction slice of public/scripts/chat-completion-settings.js's
 * preparePromptsForChatCompletion() (~lines 1365-1465) - see module doc comment for exact scope and
 * the two documented judgment calls (scenario/personality format quirk, missing `.filter`).
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
    // See module doc comment's judgment-call note: this is the client's exact (arguably buggy)
    // behavior - the FORMAT STRING itself is passed to substituteParams(), not a value-interpolated
    // template. Ported verbatim, not "fixed".
    const scenarioText = scenario && scenarioFormat ? substituteParams(scenarioFormat, macroContext) : (scenario || '');
    const charPersonalityText = charPersonality && personalityFormat ? substituteParams(personalityFormat, macroContext) : (charPersonality || '');
    const groupNudge = substituteParams(groupNudgePrompt, macroContext);
    const impersonationPromptText = impersonationPrompt ? substituteParams(impersonationPrompt, macroContext) : '';

    /** @type {SystemPromptEntry[]} */
    const systemPrompts = [
        // Ordered prompts for which a marker should exist
        { role: 'system', content: formatWorldInfo(worldInfoBefore, { wiFormat }), identifier: 'worldInfoBefore' },
        { role: 'system', content: formatWorldInfo(worldInfoAfter, { wiFormat }), identifier: 'worldInfoAfter' },
        { role: 'system', content: charDescription, identifier: 'charDescription' },
        { role: 'system', content: charPersonalityText, identifier: 'charPersonality' },
        { role: 'system', content: scenarioText, identifier: 'scenario' },
        // Unordered prompts without marker
        { role: 'system', content: impersonationPromptText, identifier: 'impersonate' },
        { role: 'system', content: quietPrompt, identifier: 'quietPrompt' },
        { role: 'system', content: groupNudge, identifier: 'groupNudge' },
        { role: 'assistant', content: bias, identifier: 'bias' },
    ];

    // Tavern Extras - Summary
    const summary = extensionPrompts['1_memory'];
    if (summary && summary.value) systemPrompts.push({
        role: getPromptRole(summary.role),
        content: summary.value,
        identifier: 'summary',
        position: getPromptPosition(summary.position),
    });

    // Authors Note
    const authorsNote = extensionPrompts['2_floating_prompt'];
    if (authorsNote && authorsNote.value) systemPrompts.push({
        role: getPromptRole(authorsNote.role),
        content: authorsNote.value,
        identifier: 'authorsNote',
        position: getPromptPosition(authorsNote.position),
    });

    // Vectors Memory
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

    // Smart Context (ChromaDB)
    const smartContext = extensionPrompts.chromadb;
    if (smartContext && smartContext.value) systemPrompts.push({
        role: 'system',
        content: smartContext.value,
        identifier: 'smartContext',
        position: getPromptPosition(smartContext.position),
    });

    // Persona Description
    if (personaDescription && personaDescriptionPosition === persona_description_positions.IN_PROMPT) {
        systemPrompts.push({ role: 'system', content: personaDescription, identifier: 'personaDescription' });
    }

    // Anything that is not a known extension prompt. NOTE: no `.filter` step here - see module doc
    // comment's judgment-call note on the missing live-predicate mechanism.
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
