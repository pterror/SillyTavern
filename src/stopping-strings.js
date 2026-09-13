import { getInstructStoppingSequences } from './instruct-template-format.js';
import { substituteParams } from './macro-substitution.js';

/**
 * Server-side port of public/script.js's getStoppingStrings() plus
 * public/scripts/power-user.js's getCustomStoppingStrings().
 *
 * Like src/world-info/*.js, src/authors-note.js and src/character-card-fields.js, this takes every
 * piece of context explicitly instead of reading globals or resolving entities itself - the caller
 * resolves `groupMemberNames` (via its own groupsStore/charactersStore-equivalent lookups) and
 * `macroContext` (a SubstituteParamsContext, see src/macro-substitution.js) and passes them in as
 * plain facts. Likewise, `ephemeralStoppingStrings` is taken as a plain injected array rather than
 * read from a module-level global - the caller owns EPHEMERAL_STOPPING_STRINGS'-equivalent state
 * (pushed to via the client's addEphemeralStoppingString(), flushed after each generation via
 * flushEphemeralStoppingStrings()); this module never mutates it.
 */

const onlyUnique = (value, index, array) => array.indexOf(value) === index;

/**
 * @typedef {object} GetCustomStoppingStringsParams
 * @property {string} [customStoppingStringsRaw] Equivalent of power_user.custom_stopping_strings - a JSON-stringified array of strings
 * @property {boolean} [customStoppingStringsMacro] Equivalent of power_user.custom_stopping_strings_macro - whether to run each string through substituteParams()
 * @property {string[]} [ephemeralStoppingStrings] Equivalent of the client's module-level EPHEMERAL_STOPPING_STRINGS, resolved by the caller
 * @property {import('./macro-substitution.js').SubstituteParamsContext} [macroContext] Context passed to substituteParams() when customStoppingStringsMacro is true
 * @property {number} [limit] Number of strings to return. If 0 or undefined, returns all strings.
 */

/**
 * Port of public/scripts/power-user.js's getCustomStoppingStrings().
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
 * @property {boolean} [isImpersonate] Whether this generation is a user-impersonation generation
 * @property {boolean} [isContinue] Whether this generation is continuing the last message
 * @property {string} api Equivalent of main_api - when 'openai' (chat completion), only custom stopping strings apply
 * @property {boolean} [namesAsStopStrings] Equivalent of power_user.context.names_as_stop_strings
 * @property {string} [name1] Current user persona name
 * @property {string} [name2] Current character name
 * @property {{is_user?: boolean}[]} [chat] Chat messages - only the last message's `.is_user` is read, for the continue-with-trailing-user-message case
 * @property {boolean} [isGroup] Whether a group is currently selected (equivalent of `selected_group` being set)
 * @property {{name?: string}[]} [groupMemberNames] Already-resolved group member records (or plain name strings) - caller resolves groupsStore/charactersStore, this module only reads `.name` (or the string itself)
 * @property {boolean} [singleLine] Equivalent of power_user.single_line
 * @property {import('./instruct-template-format.js').InstructSettings} [instructPreset]
 * @property {{use_stop_strings?: boolean, chat_start?: string, example_separator?: string}} [contextSettings]
 * @property {string} [customStoppingStringsRaw] See GetCustomStoppingStringsParams
 * @property {boolean} [customStoppingStringsMacro] See GetCustomStoppingStringsParams
 * @property {string[]} [ephemeralStoppingStrings] See GetCustomStoppingStringsParams
 * @property {import('./macro-substitution.js').SubstituteParamsContext} [macroContext] See GetCustomStoppingStringsParams
 */

/**
 * Port of public/script.js's getStoppingStrings(isImpersonate, isContinue, api).
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

    // Only custom stop strings apply to Chat Completion
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

        // Add group members as stopping strings if generating for a specific group member or user.
        if (isGroup && (name2 || isImpersonate)) {
            const names = (groupMemberNames || [])
                .map(x => (typeof x === 'string' ? x : x?.name))
                .filter(name => name && name !== name2)
                .map(name => `\n${name}:`);
            result.push(...names);
        }
    }

    result.push(...getInstructStoppingSequences(instructPreset, contextSettings, { name1, name2 }));
    result.push(...getCustomStoppingStrings(customStoppingStringsParams));

    if (singleLine) {
        result.unshift('\n');
    }

    return result.filter(x => x).filter(onlyUnique);
}
