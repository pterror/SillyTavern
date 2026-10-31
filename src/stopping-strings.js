import { getInstructStoppingSequences } from './instruct-template-format.js';
import { substituteParams } from './macro-substitution.js';

const onlyUnique = (value, index, array) => array.indexOf(value) === index;

/**
 * @typedef {object} GetCustomStoppingStringsParams
 * @property {string} [customStoppingStringsRaw]
 * @property {boolean} [customStoppingStringsMacro]
 * @property {string[]} [ephemeralStoppingStrings]
 * @property {import('./macro-substitution.js').SubstituteParamsContext} [macroContext]
 * @property {number} [limit]
 */

/**
 * @param {GetCustomStoppingStringsParams} [params]
 * @returns {string[]}
 */
export function getCustomStoppingStrings({
    customStoppingStringsRaw,
    customStoppingStringsMacro = false,
    ephemeralStoppingStrings = [],
    macroContext = {},
    limit = undefined,
} = {}) {
    function getPermanent() {
        try {
            if (!customStoppingStringsRaw) {
                return [];
            }

            let strings = JSON.parse(customStoppingStringsRaw);

            if (!Array.isArray(strings)) {
                return [];
            }

            strings = strings.filter(s => typeof s === 'string' && s.length > 0);

            if (customStoppingStringsMacro) {
                strings = strings.map(x => substituteParams(x, macroContext));
            }

            return strings;
        } catch (error) {
            return [];
        }
    }

    const permanent = getPermanent();
    const ephemeral = Array.isArray(ephemeralStoppingStrings) ? ephemeralStoppingStrings : [];
    const strings = [...permanent, ...ephemeral];

    if (limit > 0) {
        return strings.slice(0, limit);
    }

    return strings;
}

/**
 * @typedef {object} GetStoppingStringsParams
 * @property {boolean} [isImpersonate]
 * @property {boolean} [isContinue]
 * @property {string} api
 * @property {boolean} [namesAsStopStrings]
 * @property {string} [name1]
 * @property {string} [name2]
 * @property {{is_user?: boolean}[]} [chat]
 * @property {boolean} [isGroup]
 * @property {{name?: string}[]} [groupMemberNames]
 * @property {boolean} [singleLine]
 * @property {import('./instruct-template-format.js').InstructSettings} [instructPreset]
 * @property {{use_stop_strings?: boolean, chat_start?: string, example_separator?: string}} [contextSettings]
 * @property {string} [customStoppingStringsRaw]
 * @property {boolean} [customStoppingStringsMacro]
 * @property {string[]} [ephemeralStoppingStrings]
 * @property {import('./macro-substitution.js').SubstituteParamsContext} [macroContext]
 */

/**
 * @param {GetStoppingStringsParams} params
 * @returns {string[]}
 */
export function getStoppingStrings({
    isImpersonate = false,
    isContinue = false,
    api,
    namesAsStopStrings = false,
    name1 = '',
    name2 = '',
    chat = [],
    isGroup = false,
    groupMemberNames = [],
    singleLine = false,
    instructPreset,
    contextSettings,
    customStoppingStringsRaw,
    customStoppingStringsMacro = false,
    ephemeralStoppingStrings = [],
    macroContext = {},
} = {}) {
    const customStoppingStringsParams = { customStoppingStringsRaw, customStoppingStringsMacro, ephemeralStoppingStrings, macroContext };

    if (api === 'openai') {
        return getCustomStoppingStrings(customStoppingStringsParams);
    }

    const result = [];

    if (namesAsStopStrings) {
        const charString = `\n${name2}:`;
        const userString = `\n${name1}:`;
        result.push(isImpersonate ? charString : userString);

        result.push(userString);

        if (isContinue && Array.isArray(chat) && chat[chat.length - 1]?.is_user) {
            result.push(charString);
        }

        if (isGroup && (name2 || isImpersonate)) {
            const names = (groupMemberNames || [])
                .map(x => (typeof x === 'string' ? x : x?.name))
                .filter(name => name && name !== name2)
                .map(name => `\n${name}:`);
            result.push(...names);
        }
    }

    result.push(...getInstructStoppingSequences(instructPreset, contextSettings, { name1, name2, macroContext }));
    result.push(...getCustomStoppingStrings(customStoppingStringsParams));

    if (singleLine) {
        result.unshift('\n');
    }

    return result.filter(x => x).filter(onlyUnique);
}
