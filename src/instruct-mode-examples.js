import { substituteParams } from './macro-substitution.js';
import { names_behavior_types } from './instruct-template-format.js';
import { parseExampleIntoIndividual } from './chat-completion-messages.js';

/**
 * @typedef {object} ExamplesInstructPreset
 * @property {boolean} [skip_examples]
 * @property {string} [names_behavior]
 * @property {string} [input_sequence]
 * @property {string} [output_sequence]
 * @property {string} [input_suffix]
 * @property {string} [output_suffix]
 * @property {boolean} [macro]
 * @property {boolean} [wrap]
 */

/**
 * @typedef {object} ExamplesContextSettings
 * @property {string} [example_separator]
 */

/**
 * @param {string[]} mesExamplesArray
 * @param {string} name1
 * @param {string} name2
 * @param {object} [options]
 * @param {ExamplesInstructPreset} [options.instructPreset]
 * @param {ExamplesContextSettings} [options.contextSettings]
 * @param {boolean} [options.isGroup]
 * @param {string[]} [options.groupBotNames]
 * @param {import('./macro-substitution.js').SubstituteParamsContext} [options.macroContext]
 * @returns {string[][]} One list of formatted strings per example block kept.
 */
export function formatInstructModeExampleBlocks(mesExamplesArray, name1, name2, {
    instructPreset = {},
    contextSettings = {},
    isGroup = false,
    groupBotNames = [],
    macroContext = {},
} = {}) {
    const substitute = (text) => substituteParams(text, { ...macroContext, name1, name2 });

    const blockHeading = contextSettings.example_separator ? `${substitute(contextSettings.example_separator)}\n` : '';

    const raw = () => mesExamplesArray.map(x => [x.replace(/<START>\n/i, blockHeading)]);

    if (instructPreset.skip_examples) {
        return raw();
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

        if (!inputSuffix && instructPreset.wrap) {
            inputSuffix = '\n';
        }

        if (!outputSuffix && instructPreset.wrap) {
            outputSuffix = '\n';
        }
    }

    const separator = instructPreset.wrap ? '\n' : '';
    const formattedBlocks = [];

    for (const item of mesExamplesArray) {
        const cleanedItem = item.replace(/<START>/i, '{Example Dialogue:}').replace(/\r/gm, '');
        const blockExamples = parseExampleIntoIndividual(cleanedItem, {
            name1, name2, isGroup, appendNamesForGroup: includeGroupNames, groupBotNames,
        });

        if (blockExamples.length === 0) {
            continue;
        }

        const formattedExamples = [];
        if (blockHeading) {
            formattedExamples.push(blockHeading);
        }

        for (const example of blockExamples) {
            const includeThisName = !includeGroupNames && (includeNames || (instructPreset.names_behavior === names_behavior_types.FORCE && example.name === 'example_user'));

            const prefix = example.name === 'example_user' ? inputPrefix : outputPrefix;
            const suffix = example.name === 'example_user' ? inputSuffix : outputSuffix;
            const name = example.name === 'example_user' ? name1 : name2;
            const messageContent = includeThisName ? `${name}: ${example.content}` : example.content;
            const formattedMessage = [prefix, messageContent + suffix].filter(x => x).join(separator);
            formattedExamples.push(formattedMessage);
        }
        formattedBlocks.push(formattedExamples);
    }

    if (formattedBlocks.length === 0) {
        return raw();
    }
    return formattedBlocks;
}
