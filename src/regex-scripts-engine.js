import { substituteParams } from './macro-substitution.js';

/**
 * @typedef {object} RegexScript
 * @property {string} [scriptName]
 * @property {boolean} [disabled]
 * @property {string} findRegex
 * @property {string} replaceString
 * @property {string[]} [trimStrings]
 * @property {number[]} placement
 * @property {boolean} [markdownOnly]
 * @property {boolean} [promptOnly]
 * @property {boolean} [runOnEdit]
 * @property {number} [substituteRegex]
 * @property {number|null} [minDepth]
 * @property {number|null} [maxDepth]
 */

/**
 * @readonly
 * @enum {number}
 */
export const regex_placement = {
    /**
     * @deprecated
     */
    MD_DISPLAY: 0,
    USER_INPUT: 1,
    AI_OUTPUT: 2,
    SLASH_COMMAND: 3,
    WORLD_INFO: 5,
    REASONING: 6,
};

/**
 * @readonly
 * @enum {number}
 */
export const substitute_find_regex = {
    NONE: 0,
    RAW: 1,
    ESCAPED: 2,
};

/**
 * @param {string} x
 * @returns {string}
 */
export function sanitizeRegexMacro(x) {
    return (x && typeof x === 'string') ?
        x.replaceAll(/[\n\r\t\v\f\0.^$*+?{}[\]\\/|()]/gs, function (s) {
            switch (s) {
                case '\n':
                    return '\\n';
                case '\r':
                    return '\\r';
                case '\t':
                    return '\\t';
                case '\v':
                    return '\\v';
                case '\f':
                    return '\\f';
                case '\0':
                    return '\\0';
                default:
                    return '\\' + s;
            }
        }) : x;
}

/**
 * @param {string} input
 * @returns {RegExp|undefined}
 */
function regexFromString(input) {
    try {
        const m = input.match(/(\/?)(.+)\1([a-z]*)/i);
        if (m[3] && !/^(?!.*?(.).*?\1)[gmixXsuUAJ]+$/.test(m[3])) {
            return RegExp(input);
        }
        return new RegExp(m[2], m[3]);
    } catch {
        return undefined;
    }
}

export class RegexProvider {
    /** @type {Map<string, RegExp>} */
    #cache = new Map();
    /** @type {number} */
    #maxSize = 1000;

    static instance = new RegexProvider();

    /**
     * @param {string} regexString
     * @returns {RegExp|null}
     */
    get(regexString) {
        const isCached = this.#cache.has(regexString);
        const regex = isCached
            ? this.#cache.get(regexString)
            : regexFromString(regexString);

        if (!regex) {
            return null;
        }

        if (isCached) {
            this.#cache.delete(regexString);
            this.#cache.set(regexString, regex);
        } else {
            if (this.#cache.size >= this.#maxSize) {
                const firstKey = this.#cache.keys().next().value;
                this.#cache.delete(firstKey);
            }
            this.#cache.set(regexString, regex);
        }

        if (regex.global || regex.sticky) {
            regex.lastIndex = 0;
        }

        return regex;
    }

    clear() {
        this.#cache.clear();
    }
}

/**
 * @param {string} rawString
 * @param {string[]} trimStrings
 * @param {{characterOverride?: string, macroContext?: import('./macro-substitution.js').SubstituteParamsContext}} [params]
 * @returns {string}
 */
function filterString(rawString, trimStrings, { characterOverride, macroContext } = {}) {
    let finalString = rawString;
    (trimStrings ?? []).forEach((trimString) => {
        const subTrimString = substituteParams(trimString, { ...macroContext, name2: characterOverride });
        finalString = finalString.replaceAll(subTrimString, '');
    });

    return finalString;
}

/**
 * @param {RegexScript} regexScript
 * @param {string} rawString
 * @param {{characterOverride?: string, macroContext?: import('./macro-substitution.js').SubstituteParamsContext}} [params]
 * @returns {string}
 */
export function runRegexScript(regexScript, rawString, { characterOverride, macroContext } = {}) {
    let newString = rawString;
    if (!regexScript || !!(regexScript.disabled) || !regexScript?.findRegex || !rawString) {
        return newString;
    }

    const getRegexString = () => {
        switch (Number(regexScript.substituteRegex)) {
            case substitute_find_regex.NONE:
                return regexScript.findRegex;
            case substitute_find_regex.RAW:
                return substituteParams(regexScript.findRegex, { ...macroContext });
            case substitute_find_regex.ESCAPED:
                return substituteParams(regexScript.findRegex, { ...macroContext, postProcessFn: sanitizeRegexMacro });
            default:
                console.warn(`runRegexScript: Unknown substituteRegex value ${regexScript.substituteRegex}. Using raw regex.`);
                return regexScript.findRegex;
        }
    };
    const regexString = getRegexString();
    const findRegex = RegexProvider.instance.get(regexString);

    if (!findRegex) {
        return newString;
    }

    newString = rawString.replace(findRegex, function (match) {
        const args = [...arguments];
        const replaceString = regexScript.replaceString.replace(/{{match}}/gi, '$0');
        const replaceWithGroups = replaceString.replaceAll(/\$(\d+)|\$<([^>]+)>/g, (_, num, groupName) => {
            if (num) {
                match = args[Number(num)];
            } else if (groupName) {
                const groups = args[args.length - 1];
                match = groups && typeof groups === 'object' && groups[groupName];
            }

            if (!match) {
                return '';
            }

            const filteredMatch = filterString(match, regexScript.trimStrings, { characterOverride, macroContext });

            return filteredMatch;
        });

        return substituteParams(replaceWithGroups, { ...macroContext });
    });

    return newString;
}

/**
 * @param {string} rawString
 * @param {number} placement
 * @param {RegexScript[]} scripts
 * @param {object} [params]
 * @param {string} [params.characterOverride]
 * @param {boolean} [params.isMarkdown]
 * @param {boolean} [params.isPrompt]
 * @param {boolean} [params.isEdit]
 * @param {number} [params.depth]
 * @param {boolean} [params.regexExtensionEnabled]
 * @param {import('./macro-substitution.js').SubstituteParamsContext} [params.macroContext]
 * @returns {string}
 */
export function getRegexedString(rawString, placement, scripts, { characterOverride, isMarkdown, isPrompt, isEdit, depth, regexExtensionEnabled = true, macroContext } = {}) {
    if (typeof rawString !== 'string') {
        console.warn('getRegexedString: rawString is not a string. Returning empty string.');
        return '';
    }

    let finalString = rawString;
    if (!regexExtensionEnabled || !rawString || placement === undefined) {
        return finalString;
    }

    const allRegex = scripts ?? [];
    allRegex.forEach((script) => {
        if (
            (script.markdownOnly && isMarkdown) ||
            (script.promptOnly && isPrompt) ||
            (!script.markdownOnly && !script.promptOnly && !isMarkdown && !isPrompt)
        ) {
            if (isEdit && !script.runOnEdit) {
                console.debug(`getRegexedString: Skipping script ${script.scriptName} because it does not run on edit`);
                return;
            }

            if (typeof depth === 'number') {
                if (!isNaN(script.minDepth) && script.minDepth !== null && script.minDepth >= -1 && depth < script.minDepth) {
                    console.debug(`getRegexedString: Skipping script ${script.scriptName} because depth ${depth} is less than minDepth ${script.minDepth}`);
                    return;
                }

                if (!isNaN(script.maxDepth) && script.maxDepth !== null && script.maxDepth >= 0 && depth > script.maxDepth) {
                    console.debug(`getRegexedString: Skipping script ${script.scriptName} because depth ${depth} is greater than maxDepth ${script.maxDepth}`);
                    return;
                }
            }

            if (script.placement.includes(placement)) {
                finalString = runRegexScript(script, finalString, { characterOverride, macroContext });
            }
        }
    });

    return finalString;
}
