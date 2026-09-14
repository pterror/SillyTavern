import { substituteParams } from './macro-substitution.js';
import { names_behavior_types } from './instruct-template-format.js';
import { parseExampleIntoIndividual } from './chat-completion-messages.js';

/**
 * @typedef {object} ExamplesInstructPreset
 * @property {boolean} [skip_examples] Equivalent of power_user.instruct.skip_examples.
 * @property {string} [names_behavior] Equivalent of power_user.instruct.names_behavior (one of names_behavior_types).
 * @property {string} [input_sequence] Equivalent of power_user.instruct.input_sequence.
 * @property {string} [output_sequence] Equivalent of power_user.instruct.output_sequence.
 * @property {string} [input_suffix] Equivalent of power_user.instruct.input_suffix.
 * @property {string} [output_suffix] Equivalent of power_user.instruct.output_suffix.
 * @property {boolean} [macro] Equivalent of power_user.instruct.macro.
 * @property {boolean} [wrap] Equivalent of power_user.instruct.wrap.
 */

/**
 * @typedef {object} ExamplesContextSettings
 * @property {string} [example_separator] Equivalent of power_user.context.example_separator.
 */

/**
 * Port of public/scripts/instruct-mode.js's formatInstructModeExamples() (~line 527-595).
 *
 * `name1`/`name2` are threaded explicitly (matching this repo's other instruct-template-format.js
 * ports) since there is no server-side ambient global to mirror the client's own name1/name2.
 * `isGroup` mirrors the client's ambient `selected_group` truthiness check (used both to gate
 * `includeGroupNames` and, inside parseExampleIntoIndividual(), to decide whether a group-name
 * prefix actually gets appended).
 *
 * @param {string[]} mesExamplesArray Example message blocks, each still `<START>\n`-prefixed
 *  (as produced by this repo's parseMesExamplesBlocks() adapter).
 * @param {string} name1 User name.
 * @param {string} name2 Character name.
 * @param {object} [options]
 * @param {ExamplesInstructPreset} [options.instructPreset] Equivalent of power_user.instruct.
 * @param {ExamplesContextSettings} [options.contextSettings] Equivalent of power_user.context.
 * @param {boolean} [options.isGroup] Equivalent of the client's `selected_group` truthiness check.
 * @param {string[]} [options.groupBotNames] Equivalent of getGroupNames().map(name => `${name}:`),
 *  forwarded as-is to parseExampleIntoIndividual() (see that function's own doc comment). Group-name
 *  matching itself is out of scope for this port beyond forwarding this array; default `[]`.
 * @param {import('./macro-substitution.js').SubstituteParamsContext} [options.macroContext] Extra
 *  substituteParams() context (e.g. bannedWordsSink, characterCard) merged into every substitution
 *  this function performs - `name1`/`name2` passed above always win over same-named fields already
 *  present in macroContext, matching the client's own name1Override/name2Override behavior.
 * @returns {string[]} Formatted example messages array.
 */
export function formatInstructModeExamples(mesExamplesArray, name1, name2, {
    instructPreset = {},
    contextSettings = {},
    isGroup = false,
    groupBotNames = [],
    macroContext = {},
} = {}) {
    const substitute = (text) => substituteParams(text, { ...macroContext, name1, name2 });

    const blockHeading = contextSettings.example_separator ? `${substitute(contextSettings.example_separator)}\n` : '';

    if (instructPreset.skip_examples) {
        return mesExamplesArray.map(x => x.replace(/<START>\n/i, blockHeading));
    }

    const includeNames = instructPreset.names_behavior === names_behavior_types.ALWAYS;
    const includeGroupNames = isGroup && [names_behavior_types.ALWAYS, names_behavior_types.FORCE].includes(instructPreset.names_behavior);

    let inputPrefix = instructPreset.input_sequence || '';
    let outputPrefix = instructPreset.output_sequence || '';
    let inputSuffix = instructPreset.input_suffix || '';
    let outputSuffix = instructPreset.output_suffix || '';

    if (instructPreset.macro) {
        inputPrefix = substitute(inputPrefix);
        outputPrefix = substitute(outputPrefix);
        inputSuffix = substitute(inputSuffix);
        outputSuffix = substitute(outputSuffix);

        inputPrefix = inputPrefix.replace(/{{name}}/gi, name1);
        outputPrefix = outputPrefix.replace(/{{name}}/gi, name2);
        inputSuffix = inputSuffix.replace(/{{name}}/gi, name1);
        outputSuffix = outputSuffix.replace(/{{name}}/gi, name2);

        // These defaults only kick in inside this `macro` gate, matching the client exactly - if
        // `instructPreset.macro` is false, an empty suffix stays empty even when `wrap` is true.
        if (!inputSuffix && instructPreset.wrap) {
            inputSuffix = '\n';
        }

        if (!outputSuffix && instructPreset.wrap) {
            outputSuffix = '\n';
        }
    }

    const separator = instructPreset.wrap ? '\n' : '';
    const formattedExamples = [];

    for (const item of mesExamplesArray) {
        const cleanedItem = item.replace(/<START>/i, '{Example Dialogue:}').replace(/\r/gm, '');
        const blockExamples = parseExampleIntoIndividual(cleanedItem, {
            name1, name2, isGroup, appendNamesForGroup: includeGroupNames, groupBotNames,
        });

        if (blockExamples.length === 0) {
            continue;
        }

        if (blockHeading) {
            formattedExamples.push(blockHeading);
        }

        for (const example of blockExamples) {
            // If group names were included, we don't want to add any additional prefix as it already was applied.
            // Otherwise, if force group/persona names is set, we should override the include names for the user placeholder
            const includeThisName = !includeGroupNames && (includeNames || (instructPreset.names_behavior === names_behavior_types.FORCE && example.name === 'example_user'));

            const prefix = example.name === 'example_user' ? inputPrefix : outputPrefix;
            const suffix = example.name === 'example_user' ? inputSuffix : outputSuffix;
            const name = example.name === 'example_user' ? name1 : name2;
            const messageContent = includeThisName ? `${name}: ${example.content}` : example.content;
            const formattedMessage = [prefix, messageContent + suffix].filter(x => x).join(separator);
            formattedExamples.push(formattedMessage);
        }
    }

    if (formattedExamples.length === 0) {
        return mesExamplesArray.map(x => x.replace(/<START>\n/i, blockHeading));
    }
    return formattedExamples;
}
