import { substituteParams } from './macro-substitution.js';

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
 * @param {string} name
 * @param {string} mes
 * @param {boolean} isUser
 * @param {boolean} isNarrator
 * @param {boolean} isGroup
 * @param {string|undefined} forceAvatar
 * @param {string} name1
 * @param {string} name2
 * @param {number|undefined} forceOutputSequence
 * @param {InstructSettings} instructPreset
 * @param {import('./macro-substitution.js').SubstituteParamsContext} [macroContext]
 * @returns {string}
 */
export function formatInstructModeChat(name, mes, isUser, isNarrator, isGroup, forceAvatar, name1, name2, forceOutputSequence, instructPreset, macroContext = {}) {
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
        prefix = substituteParams(prefix, { ...macroContext, name1, name2 });
        prefix = prefix.replace(/{{name}}/gi, name || 'System');
        suffix = substituteParams(suffix, { ...macroContext, name1, name2 });
        suffix = suffix.replace(/{{name}}/gi, name || 'System');
    }

    if (!suffix && instruct.wrap) suffix = '\n';

    const separator = instruct.wrap ? '\n' : '';
    const textArray = includeNames && name ? [prefix, `${name}: ${mes}` + suffix] : [prefix, mes + suffix];
    return textArray.filter(x => x).join(separator);
}

/**
 * @param {string} name
 * @param {boolean} isImpersonate
 * @param {string} promptBias
 * @param {string} name1
 * @param {string} name2
 * @param {boolean} isQuiet
 * @param {boolean} isQuietToLoud
 * @param {boolean} isGroup
 * @param {InstructSettings} instructPreset
 * @param {import('./macro-substitution.js').SubstituteParamsContext} [macroContext]
 * @returns {string}
 */
export function formatInstructModePrompt(name, isImpersonate, promptBias, name1, name2, isQuiet, isQuietToLoud, isGroup, instructPreset, macroContext = {}) {
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
        sequence = substituteParams(sequence, { ...macroContext, name1, name2 });
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
 * @param {string} storyString
 * @param {InstructSettings} instructPreset
 * @param {{story_string_position?: number, name1?: string, name2?: string, macroContext?: import('./macro-substitution.js').SubstituteParamsContext}} [contextSettings]
 * @returns {string}
 */
export function formatInstructModeStoryString(storyString, instructPreset, contextSettings = {}) {
    if (!storyString) return '';

    const instruct = structuredClone(instructPreset);
    const { name1, name2, macroContext = {} } = contextSettings;
    const storyStringPosition = contextSettings.story_string_position ?? extension_prompt_types.IN_PROMPT;
    const applySequences = storyStringPosition !== extension_prompt_types.IN_CHAT;
    const separator = instruct.wrap ? '\n' : '';

    if (applySequences && instruct.story_string_prefix) {
        const prefix = substituteParams(instruct.story_string_prefix, { ...macroContext, name1, name2 }).replace(/{{name}}/gi, 'System');
        storyString = prefix + separator + storyString;
    }

    if (applySequences && instruct.story_string_suffix) {
        const suffix = substituteParams(instruct.story_string_suffix, { ...macroContext, name1, name2 });
        storyString = storyString + suffix;
    }

    return storyString;
}

const onlyUnique = (value, index, array) => array.indexOf(value) === index;

/**
 * @param {InstructSettings} instructPreset
 * @param {{use_stop_strings?: boolean, chat_start?: string, example_separator?: string}} contextSettings
 * @param {{name1?: string, name2?: string, macroContext?: import('./macro-substitution.js').SubstituteParamsContext}} [names]
 * @returns {string[]}
 */
export function getInstructStoppingSequences(instructPreset, contextSettings, { name1 = '', name2 = '', macroContext = {} } = {}) {
    const instruct = structuredClone(instructPreset);
    const result = [];

    const addInstructSequence = (sequence) => {
        if (typeof sequence !== 'string' || sequence.length === 0) return;
        if (sequence.trim().length === 0) return;
        const wrap = (s) => instruct.wrap ? '\n' + s : s;
        const wrappedSequence = wrap(sequence);
        const stopString = instruct.macro ? substituteParams(wrappedSequence, { ...macroContext, name1, name2 }) : wrappedSequence;
        result.push(stopString);
    };

    if (instruct.enabled) {
        const stop_sequence = instruct.stop_sequence || '';
        const input_sequence = instruct.input_sequence?.replace(/{{name}}/gi, name1) || '';
        const output_sequence = instruct.output_sequence?.replace(/{{name}}/gi, name2) || '';
        const first_output_sequence = instruct.first_output_sequence?.replace(/{{name}}/gi, name2) || '';
        const last_output_sequence = instruct.last_output_sequence?.replace(/{{name}}/gi, name2) || '';
        const system_sequence = instruct.system_sequence?.replace(/{{name}}/gi, 'System') || '';
        const last_system_sequence = instruct.last_system_sequence?.replace(/{{name}}/gi, 'System') || '';

        const combined_sequence = [stop_sequence];
        if (instruct.sequences_as_stop_strings) {
            combined_sequence.push(input_sequence, output_sequence, first_output_sequence, last_output_sequence, system_sequence, last_system_sequence);
        }
        combined_sequence.join('\n').split('\n').filter(onlyUnique).forEach(addInstructSequence);
    }

    if (contextSettings?.use_stop_strings) {
        if (contextSettings.chat_start) {
            result.push(`\n${substituteParams(contextSettings.chat_start, { ...macroContext, name1, name2 })}`);
        }
        if (contextSettings.example_separator) {
            result.push(`\n${substituteParams(contextSettings.example_separator, { ...macroContext, name1, name2 })}`);
        }
    }

    return result;
}

/**
 * @param {{role: string, content: string, name?: string, ignoreInstruct?: boolean}[]} prompt
 * @param {InstructSettings} instructPreset
 * @param {{name1?: string, name2?: string, isGroup?: boolean}} [options]
 * @returns {string}
 */
export function constructPrompt(prompt, instructPreset, { name1 = '', name2 = '', isGroup = false } = {}) {
    const instruct = structuredClone(instructPreset);
    const formattedMessages = [];
    const prefillActive = prompt.length > 0 ? prompt[prompt.length - 1].role === 'assistant' : false;

    for (const message of prompt) {
        let messageContent = message.content;
        if (!message.ignoreInstruct) {
            const isLastMessage = message === prompt[prompt.length - 1];

            if (!isLastMessage || !prefillActive) {
                messageContent = formatInstructModeChat(
                    message.name ?? message.role, message.content,
                    message.role === 'user', message.role === 'system',
                    isGroup, undefined, name1, name2, undefined, instruct,
                );
            }

            if (isLastMessage) {
                let last_line = formatInstructModePrompt(
                    'assistant', false, prefillActive ? message.content : undefined,
                    name1, name2, true, false, isGroup, instruct,
                );

                if (prefillActive) {
                    if (last_line.endsWith('\n') && !message.content.endsWith('\n')) {
                        last_line = last_line.slice(0, -1);
                    }
                    messageContent = last_line;
                } else {
                    messageContent += last_line;
                }
            }
        }
        formattedMessages.push(messageContent);
    }

    return formattedMessages.join('');
}
