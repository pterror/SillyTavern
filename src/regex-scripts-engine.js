import { substituteParams } from './macro-substitution.js';

/**
 * Server-side port of the client's regex-scripts engine (public/scripts/extensions/regex/engine.js).
 *
 * Unlike the client, this module does not resolve the regex script LIST itself. Client-side,
 * `getRegexedString()` internally calls `getRegexScripts({ allowedOnly: true })`, which merges
 * global scripts (`extension_settings.regex`), character-scoped scripts (gated by an allow-list,
 * `extension_settings.character_allowed_regex`) and preset scripts (gated by
 * `extension_settings.preset_allowed_regex[apiId][presetName]`). All of that reads live
 * character/preset/extension-settings state that this module has no business resolving on its
 * own - matching the "caller resolves entities" pattern used elsewhere in this port (e.g.
 * `worldInfoCandidates` in text-completion-prompt-orchestrator.js). Callers pass the already
 * resolved, already allow-list-filtered flat `scripts` array directly.
 *
 * Similarly, the client's global `extension_settings.disabledExtensions.includes('regex')`
 * kill-switch check is replaced by a plain `regexExtensionEnabled` boolean param (default true).
 *
 * @typedef {object} RegexScript
 * @property {string} [scriptName]
 * @property {boolean} [disabled]
 * @property {string} findRegex
 * @property {string} replaceString
 * @property {string[]} [trimStrings]
 * @property {number[]} placement Array of regex_placement values this script runs at
 * @property {boolean} [markdownOnly]
 * @property {boolean} [promptOnly]
 * @property {boolean} [runOnEdit]
 * @property {number} [substituteRegex] One of the substitute_find_regex values
 * @property {number|null} [minDepth]
 * @property {number|null} [maxDepth]
 */

/**
 * @readonly
 * @enum {number} Where the regex script should be applied
 */
export const regex_placement = {
    /**
     * @deprecated MD Display is deprecated. Do not use.
     */
    MD_DISPLAY: 0,
    USER_INPUT: 1,
    AI_OUTPUT: 2,
    SLASH_COMMAND: 3,
    // 4 - sendAs (legacy), intentionally unassigned
    WORLD_INFO: 5,
    REASONING: 6,
};

/**
 * @readonly
 * @enum {number} How to substitute parameters in the find regex
 */
export const substitute_find_regex = {
    NONE: 0,
    RAW: 1,
    ESCAPED: 2,
};

/**
 * Per-macro-value post-processor for the ESCAPED substitute_find_regex mode: escapes regex-special
 * (and control) characters in a macro's resolved value so it is safe to splice into a regex
 * pattern source without being interpreted as a metacharacter. Direct port of the client's
 * sanitizeRegexMacro() (public/scripts/extensions/regex/engine.js ~line 303) - exact character
 * list/replacements preserved.
 * @param {string} x The macro's resolved value
 * @returns {string} The escaped value, or `x` unchanged if it isn't a string
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
 * Instantiates a regular expression from a `/pattern/flags`-style string (or a bare pattern).
 * Direct port of public/scripts/utils.js's regexFromString() - deliberately re-implemented here
 * rather than imported, since that module pulls in a long chain of browser/DOM-only dependencies
 * (jQuery, popups, world-info UI, etc.) that don't belong in a server-side module. This copy is
 * self-contained and has no such dependencies.
 * @param {string} input The input string
 * @returns {RegExp|undefined} The compiled regex, or undefined if invalid
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

/**
 * Manages the compiled regex cache with LRU eviction. Direct port of the client's RegexProvider
 * (public/scripts/extensions/regex/engine.js ~line 40).
 *
 * JUDGMENT CALL: this cache is purely a performance optimization - it has zero effect on the
 * actual output of getRegexedString()/runRegexScript(), only on how often a given regex STRING
 * gets recompiled via `new RegExp()`. A simpler implementation (e.g. no cache at all, or a plain
 * Map with no eviction) would be behaviorally identical. It is kept here, faithfully (LRU eviction
 * at 1000 entries, re-insert-on-hit to mark most-recently-used, lastIndex reset for global/sticky
 * regexes), because it is small and this port otherwise has no other place a cache would need to
 * live per-request; a caller that wants request-scoped caching (or none at all) can construct its
 * own `RegexProvider` instance instead of using the shared `RegexProvider.instance` singleton.
 */
export class RegexProvider {
    /** @type {Map<string, RegExp>} */
    #cache = new Map();
    /** @type {number} */
    #maxSize = 1000;

    static instance = new RegexProvider();

    /**
     * Gets a regex instance by its string representation.
     * @param {string} regexString The regex string to retrieve
     * @returns {RegExp|null} Compiled regex or null if invalid
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
            // LRU: Move to end by re-inserting
            this.#cache.delete(regexString);
            this.#cache.set(regexString, regex);
        } else {
            if (this.#cache.size >= this.#maxSize) {
                const firstKey = this.#cache.keys().next().value;
                this.#cache.delete(firstKey);
            }
            this.#cache.set(regexString, regex);
        }

        // Reset lastIndex for global/sticky regexes
        if (regex.global || regex.sticky) {
            regex.lastIndex = 0;
        }

        return regex;
    }

    /**
     * Clears the entire cache.
     */
    clear() {
        this.#cache.clear();
    }
}

/**
 * Filters anything to trim from the regex match. Direct port of the client's filterString()
 * (public/scripts/extensions/regex/engine.js ~line 447).
 * @param {string} rawString The raw string to filter
 * @param {string[]} trimStrings The strings to trim
 * @param {{characterOverride?: string, macroContext?: import('./macro-substitution.js').SubstituteParamsContext}} [params]
 * @returns {string} The filtered string
 */
function filterString(rawString, trimStrings, { characterOverride, macroContext } = {}) {
    let finalString = rawString;
    (trimStrings ?? []).forEach((trimString) => {
        // Client: substituteParams(trimString, { name2Override: characterOverride }) - translated to
        // this ported substituteParams()'s actual context shape (name2, not name2Override), layered
        // on top of the caller-supplied macroContext so {{user}}/other card fields still resolve.
        const subTrimString = substituteParams(trimString, { ...macroContext, name2: characterOverride });
        finalString = finalString.replaceAll(subTrimString, '');
    });

    return finalString;
}

/**
 * Runs the provided regex script on the given string. Direct port of the client's
 * runRegexScript() (public/scripts/extensions/regex/engine.js ~line 386).
 *
 * BRIDGING DECISION (substituteParamsExtended/postProcessFn): the client's `substituteParamsExtended`
 * is a thin wrapper - `substituteParams(content, { dynamicMacros: additionalMacro, postProcessFn })` -
 * where `postProcessFn` is applied to each individual macro's substituted value before splicing it
 * into the result (confirmed against public/scripts/macros.js's evaluateMacros(), which wraps every
 * `macro.replace(...)` call in `postProcessFn(...)`). The already-ported `substituteParams()` in
 * ./macro-substitution.js did not support this. Chosen option (a) from the task: extended that
 * module's `SubstituteParamsContext` with an optional `postProcessFn` field, applied at the same
 * per-macro-value point in its `evaluateMacros()`, purely additive (identity when absent) - see
 * macro-substitution.js and its re-run test file. This was cleaner than reimplementing a parallel
 * substitution pass locally (option (b)) since the real engine already had exactly the right single
 * hook point once `evaluateMacros()` was actually read.
 * @param {RegexScript} regexScript The regex script to run
 * @param {string} rawString The string to run the regex script on
 * @param {{characterOverride?: string, macroContext?: import('./macro-substitution.js').SubstituteParamsContext}} [params]
 * @returns {string} The new string
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

    // The regex string failed to compile. Return with nothing changed.
    if (!findRegex) {
        return newString;
    }

    // Run replacement. Currently does not support the Overlay strategy.
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
 * Parent function to fetch a regexed version of a raw string. Direct port of the client's
 * getRegexedString() (public/scripts/extensions/regex/engine.js ~line 333). The `scripts` array
 * must already be the fully resolved, allow-list-filtered flat list of scripts to consider (see
 * the module doc comment) - this function does not resolve it itself.
 * @param {string} rawString The raw string to be regexed
 * @param {number} placement The placement of the string (a regex_placement value)
 * @param {RegexScript[]} scripts Already-resolved, already allow-list-filtered flat list of regex scripts to consider
 * @param {object} [params]
 * @param {string} [params.characterOverride]
 * @param {boolean} [params.isMarkdown]
 * @param {boolean} [params.isPrompt]
 * @param {boolean} [params.isEdit]
 * @param {number} [params.depth]
 * @param {boolean} [params.regexExtensionEnabled] Replaces the client's `extension_settings.disabledExtensions.includes('regex')` global kill-switch check. Defaults to true.
 * @param {import('./macro-substitution.js').SubstituteParamsContext} [params.macroContext] Context forwarded to every `substituteParams()` call made while running the surviving scripts (name1/name2/characterCard/etc.) - so `{{user}}`/`{{char}}`/other macros inside find-regexes and replacement strings resolve to real values instead of empty strings.
 * @returns {string} The regexed string
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
            // Unrestricted scripts skip isMarkdown, since the chat-history source they'd act on is already regexed by then.
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
