import { substituteParams } from './macro-substitution.js';

// Mirrors public/scripts/instruct-mode.js's names_behavior_types / force_output_sequence / and
// public/script.js's extension_prompt_types (only the two values formatInstructModeStoryString uses).
export const names_behavior_types = { NONE: 'none', FORCE: 'force', ALWAYS: 'always' };
export const force_output_sequence = { FIRST: 1, LAST: 2 };
const extension_prompt_types = { IN_PROMPT: 0, IN_CHAT: 1 };

/**
 * @typedef {object} InstructSettings
 * @property {boolean} [enabled]
 * @property {boolean} [wrap]
 * @property {boolean} [macro]
 * @property {string} [names_behavior]
 * @property {string} [input_sequence]
 * @property {string} [output_sequence]
 * @property {string} [first_input_sequence]
 * @property {string} [last_input_sequence]
 * @property {string} [first_output_sequence]
 * @property {string} [last_output_sequence]
 * @property {string} [input_suffix]
 * @property {string} [output_suffix]
 * @property {string} [system_sequence]
 * @property {string} [system_suffix]
 * @property {boolean} [system_same_as_user]
 * @property {string} [last_system_sequence]
 * @property {string} [story_string_prefix]
 * @property {string} [story_string_suffix]
 */

/**
 * Port of public/scripts/instruct-mode.js's formatInstructModeChat(). `name1`/`name2` are only
 * used for macro substitution (not for deciding whose line this is - `isUser`/`isNarrator` do
 * that), same as the client.
 * @param {string} name Display name attached to this line when names are included
 * @param {string} mes Message content
 * @param {boolean} isUser
 * @param {boolean} isNarrator
 * @param {boolean} isGroup Whether this is a group chat (affects FORCE names_behavior)
 * @param {string|undefined} forceAvatar Truthy if this specific message carries a forced/overridden avatar (e.g. a group message's force_avatar)
 * @param {string} name1
 * @param {string} name2
 * @param {number|undefined} forceOutputSequence One of force_output_sequence, or undefined
 * @param {InstructSettings} instructPreset
 * @returns {string}
 */
export function formatInstructModeChat(name, mes, isUser, isNarrator, isGroup, forceAvatar, name1, name2, forceOutputSequence, instructPreset) {
    const instruct = structuredClone(instructPreset);
    let includeNames = isNarrator ? false : instruct.names_behavior === names_behavior_types.ALWAYS;

    if (!isNarrator && instruct.names_behavior === names_behavior_types.FORCE && ((isGroup && name !== name1) || (forceAvatar && name !== name1))) {
        includeNames = true;
    }

    function getPrefix() {
        if (isNarrator) {
            return instruct.system_same_as_user ? instruct.input_sequence : instruct.system_sequence;
        }
        if (isUser) {
            if (forceOutputSequence === force_output_sequence.FIRST) return instruct.first_input_sequence || instruct.input_sequence;
            if (forceOutputSequence === force_output_sequence.LAST) return instruct.last_input_sequence || instruct.input_sequence;
            return instruct.input_sequence;
        }
        if (forceOutputSequence === force_output_sequence.FIRST) return instruct.first_output_sequence || instruct.output_sequence;
        if (forceOutputSequence === force_output_sequence.LAST) return instruct.last_output_sequence || instruct.output_sequence;
        return instruct.output_sequence;
    }

    function getSuffix() {
        if (isNarrator) return instruct.system_same_as_user ? instruct.input_suffix : instruct.system_suffix;
        if (isUser) return instruct.input_suffix;
        return instruct.output_suffix;
    }

    let prefix = getPrefix() || '';
    let suffix = getSuffix() || '';

    if (instruct.macro) {
        prefix = substituteParams(prefix, { name1, name2 });
        prefix = prefix.replace(/{{name}}/gi, name || 'System');
        suffix = substituteParams(suffix, { name1, name2 });
        suffix = suffix.replace(/{{name}}/gi, name || 'System');
    }

    if (!suffix && instruct.wrap) suffix = '\n';

    const separator = instruct.wrap ? '\n' : '';
    const textArray = includeNames && name ? [prefix, `${name}: ${mes}` + suffix] : [prefix, mes + suffix];
    return textArray.filter(x => x).join(separator);
}

/**
 * Port of public/scripts/instruct-mode.js's formatInstructModePrompt().
 * @param {string} name
 * @param {boolean} isImpersonate
 * @param {string} promptBias
 * @param {string} name1
 * @param {string} name2
 * @param {boolean} isQuiet
 * @param {boolean} isQuietToLoud
 * @param {boolean} isGroup
 * @param {InstructSettings} instructPreset
 * @returns {string}
 */
export function formatInstructModePrompt(name, isImpersonate, promptBias, name1, name2, isQuiet, isQuietToLoud, isGroup, instructPreset) {
    const instruct = structuredClone(instructPreset);
    const includeNames = name && (instruct.names_behavior === names_behavior_types.ALWAYS || (!!isGroup && instruct.names_behavior === names_behavior_types.FORCE)) && !(isQuiet && !isQuietToLoud);

    function getSequence() {
        if (isImpersonate) return instruct.last_input_sequence || instruct.input_sequence;
        if (isQuiet && !isQuietToLoud) return instruct.last_system_sequence || instruct.output_sequence;
        if (isQuiet && isQuietToLoud) return instruct.last_output_sequence || instruct.output_sequence;
        return instruct.last_output_sequence || instruct.output_sequence;
    }

    let sequence = getSequence() || '';
    let nameFiller = '';

    // A hack for Mistral's formatting that has a normal output sequence ending with a space
    if (
        includeNames &&
        instruct.last_output_sequence &&
        instruct.output_sequence &&
        sequence === instruct.last_output_sequence &&
        /\s$/.test(instruct.output_sequence) &&
        !/\s$/.test(instruct.last_output_sequence)
    ) {
        nameFiller = instruct.output_sequence.slice(-1);
    }

    if (instruct.macro) {
        sequence = substituteParams(sequence, { name1, name2 });
        sequence = sequence.replace(/{{name}}/gi, name || 'System');
    }

    const separator = instruct.wrap ? '\n' : '';
    let text = includeNames ? (separator + sequence + separator + nameFiller + `${name}:`) : (separator + sequence);

    if (isQuiet && separator) {
        text = text.slice(separator.length);
    }

    if (!isImpersonate && promptBias) {
        text += (includeNames ? promptBias : (separator + promptBias.trimStart()));
    }

    return (instruct.wrap ? text.trimEnd() : text) + (includeNames ? '' : separator);
}

/**
 * Port of public/scripts/instruct-mode.js's formatInstructModeStoryString(). `contextSettings`
 * only needs the one field the client reads: story_string_position.
 *
 * Deliberate deviation from the client: the client calls substituteParams() here with no
 * name1/name2 override, relying on its own ambient global name1/name2 for any {{char}}/{{user}}
 * in the prefix/suffix - there's no server-side global to mirror that, so this port takes them
 * explicitly instead. Pass the same name1/name2 you'd use elsewhere for this generation.
 * @param {string} storyString
 * @param {InstructSettings} instructPreset
 * @param {{story_string_position?: number, name1?: string, name2?: string}} [contextSettings]
 * @returns {string}
 */
export function formatInstructModeStoryString(storyString, instructPreset, contextSettings = {}) {
    if (!storyString) return '';

    const instruct = structuredClone(instructPreset);
    const { name1, name2 } = contextSettings;
    const storyStringPosition = contextSettings.story_string_position ?? extension_prompt_types.IN_PROMPT;
    const applySequences = storyStringPosition !== extension_prompt_types.IN_CHAT;
    const separator = instruct.wrap ? '\n' : '';

    if (applySequences && instruct.story_string_prefix) {
        const prefix = substituteParams(instruct.story_string_prefix, { name1, name2 }).replace(/{{name}}/gi, 'System');
        storyString = prefix + separator + storyString;
    }

    if (applySequences && instruct.story_string_suffix) {
        const suffix = substituteParams(instruct.story_string_suffix, { name1, name2 });
        storyString = storyString + suffix;
    }

    return storyString;
}
