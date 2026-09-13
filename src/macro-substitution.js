import moment from 'moment';
import droll from 'droll';

/**
 * Server-side port of the client's legacy macro engine (public/script.js's substituteParamsLegacy
 * plus public/scripts/macros.js's evaluateMacros, with power_user.experimental_macro_engine off -
 * that is the only engine active by default, so it's the only one ported here).
 *
 * Unlike the client, this takes every piece of context explicitly instead of reading globals
 * (chat store, DOM, power_user settings) - the caller resolves those from its own request context
 * and passes them in.
 *
 * Deliberately NOT ported (each is either DOM-only, stateful client UI state, or plugin-registered
 * with no server equivalent - listed so a future pass knows exactly what's missing, not guessing):
 * - {{input}} - reads the DOM chat input textbox.
 * - {{random}}, {{pick}}, {{banned "..."}} - RNG/ban-list macros. ({{roll}} IS ported below - it's
 *   pure droll math, no client dependency.) {{pick}} needs a stable per-chat-hash cache to avoid
 *   re-rolling on every read (getChatIdHash()); {{banned}} has a side effect on a client-side
 *   textgen ban list. Skippable for instruct-template formatting, the immediate consumer here -
 *   revisit if a caller needs them.
 * - {{maxPrompt}}/{{maxPromptTokens}}/{{maxContext}}/{{maxContextTokens}}/{{maxResponse}}/
 *   {{maxResponseTokens}} - depend on the live prompt-budget calculation, which isn't ported yet
 *   (that's the larger prompt-assembly effort this module is a prerequisite for, not a peer of).
 * - {{lastMessage}}/{{lastMessageId}}/{{lastUserMessage}}/{{lastCharMessage}}/{{lastSwipeId}}/
 *   {{currentSwipeId}}/{{allChatRange}}/{{firstIncludedMessageId}} - depend on getLastMessageId()'s
 *   "exclude an in-progress swipe" logic, which is live client generation state with no server
 *   equivalent request context yet.
 * - {{firstDisplayedMessageId}} - reads the DOM.
 * - {{idle_duration}} - depends on the same live chat/message timing state as the above.
 * - {{outlet::key}} - reads client-side extension_prompts state.
 * - getvar/setvar/addvar and friends (public/scripts/variables.js's getVariableMacros) - chat/global
 *   variable store. The data (chat_metadata) is available server-side, but the get/set macro
 *   syntax and mutation semantics weren't ported in this pass.
 * - Instruct-sequence macros (public/scripts/instruct-mode.js's getInstructMacros, e.g.
 *   {{instructSystemPrompt}}) - lets message/persona text reference the *current* instruct
 *   template's own sequences. Narrow, rarely-used cross-reference; not ported.
 * - MacrosParser-registered macros - extensions register these client-side; no server registry
 *   exists to mirror them.
 * - {{timeDiff::a::b}} IS ported (pure moment() math, no client dependency).
 */

/**
 * @typedef {object} CharacterCardFields
 * @property {string} [system]
 * @property {string} [jailbreak]
 * @property {string} [description]
 * @property {string} [personality]
 * @property {string} [scenario]
 * @property {string} [persona]
 * @property {string} [mesExamplesRaw]
 * @property {string} [mesExamples] Already-joined example-messages block (instruct-formatted or raw - caller's choice, matching client behavior for the current mode)
 * @property {string} [charVersion]
 * @property {string} [charDepthPrompt]
 * @property {string} [creatorNotes]
 */

/**
 * @typedef {object} SubstituteParamsContext
 * @property {string} [name1] Raw {{user}}
 * @property {string} [name2] Raw {{char}}
 * @property {string} [original] Value substituted once for {{original}}, then emptied
 * @property {string} [group] Explicit {{group}}/{{charIfNotGroup}} value override
 * @property {string[]} [groupMembers] Character names of all group members (for group-derived macros when `group` isn't given)
 * @property {string[]} [groupDisabledMembers] Subset of groupMembers currently muted, for {{groupNotMuted}}
 * @property {boolean} [isGroup] Whether this is a group chat at all
 * @property {string} [model] {{model}}
 * @property {boolean} [replaceCharacterCard] Default true, matches client default
 * @property {CharacterCardFields} [characterCard]
 * @property {Record<string, string | (() => string)>} [dynamicMacros] Extra macros, checked after the built-in environment (same precedence as the client's additionalMacro)
 */

function escapeRegexLiteral(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildEnvironment(content, context) {
    const {
        name1 = '',
        name2 = '',
        original,
        group,
        groupMembers,
        groupDisabledMembers = [],
        isGroup = false,
        model = '',
        replaceCharacterCard = true,
        characterCard = {},
        dynamicMacros = {},
    } = context;

    const environment = {};

    if (typeof original === 'string') {
        let originalSubstituted = false;
        environment.original = () => {
            if (originalSubstituted) return '';
            originalSubstituted = true;
            return original;
        };
    }

    const getGroupValue = (includeMuted) => {
        if (typeof group === 'string') return group;
        if (isGroup) {
            const isMuted = (m) => includeMuted ? true : !groupDisabledMembers.includes(m);
            return Array.isArray(groupMembers) ? groupMembers.filter(isMuted).join(', ') : '';
        }
        return name2;
    };

    const getNotCharValue = () => {
        if (!isGroup) return name1;
        if (!Array.isArray(groupMembers)) return name1;
        const otherMembers = groupMembers.filter(n => n !== name2);
        otherMembers.push(name1);
        return otherMembers.join(', ');
    };

    if (replaceCharacterCard) {
        environment.charPrompt = characterCard.system || '';
        environment.charInstruction = environment.charJailbreak = characterCard.jailbreak || '';
        environment.description = characterCard.description || '';
        environment.personality = characterCard.personality || '';
        environment.scenario = characterCard.scenario || '';
        environment.persona = characterCard.persona || '';
        environment.mesExamples = characterCard.mesExamples || '';
        environment.mesExamplesRaw = characterCard.mesExamplesRaw || '';
        environment.charVersion = characterCard.charVersion || '';
        environment.char_version = characterCard.charVersion || '';
        environment.charDepthPrompt = characterCard.charDepthPrompt || '';
        environment.creatorNotes = characterCard.creatorNotes || '';
    }

    // Must be assigned last, so they win when they also appear inside e.g. {{description}} - matches client order.
    environment.user = name1;
    environment.char = name2;
    environment.group = environment.charIfNotGroup = getGroupValue(true);
    environment.groupNotMuted = getGroupValue(false);
    environment.notChar = getNotCharValue();
    environment.model = model;

    if (dynamicMacros && typeof dynamicMacros === 'object') {
        Object.assign(environment, dynamicMacros);
    }

    return environment;
}

function evaluateMacros(content, env) {
    if (!content) return '';

    const preEnvMacros = [
        { regex: /<USER>/gi, replace: () => typeof env.user === 'function' ? env.user() : env.user },
        { regex: /<BOT>/gi, replace: () => typeof env.char === 'function' ? env.char() : env.char },
        { regex: /<CHAR>/gi, replace: () => typeof env.char === 'function' ? env.char() : env.char },
        { regex: /<CHARIFNOTGROUP>/gi, replace: () => typeof env.group === 'function' ? env.group() : env.group },
        { regex: /<GROUP>/gi, replace: () => typeof env.group === 'function' ? env.group() : env.group },
        { regex: /{{newline}}/gi, replace: () => '\n' },
        { regex: /(?:\r?\n)*{{trim}}(?:\r?\n)*/gi, replace: () => '' },
        { regex: /{{noop}}/gi, replace: () => '' },
    ];

    const postEnvMacros = [
        { regex: /{{reverse:(.+?)}}/gi, replace: (_, str) => Array.from(str).reverse().join('') },
        { regex: /\{\{\/\/([\s\S]*?)\}\}/gm, replace: () => '' },
        { regex: /{{time}}/gi, replace: () => moment().format('LT') },
        { regex: /{{date}}/gi, replace: () => moment().format('LL') },
        { regex: /{{weekday}}/gi, replace: () => moment().format('dddd') },
        { regex: /{{isotime}}/gi, replace: () => moment().format('HH:mm') },
        { regex: /{{isodate}}/gi, replace: () => moment().format('YYYY-MM-DD') },
        { regex: /{{datetimeformat +([^}]*)}}/gi, replace: (_, format) => moment().format(format) },
        { regex: /{{time_UTC([-+]\d+)}}/gi, replace: (_, offset) => moment().utc().utcOffset(parseInt(offset, 10)).format('LT') },
        {
            regex: /{{timeDiff::(.*?)::(.*?)}}/gi, replace: (_match, matchPart1, matchPart2) => {
                const time1 = moment(matchPart1);
                const time2 = moment(matchPart2);
                return moment.duration(time1.diff(time2)).humanize(true);
            },
        },
        {
            regex: /{{roll[ : ]([^}]+)}}/gi, replace: (_match, matchValue) => {
                let formula = matchValue.trim();
                if (/^\d+$/.test(formula)) formula = `1d${formula}`;
                if (!droll.validate(formula)) return '';
                const result = droll.roll(formula);
                return result === false ? '' : String(result.total);
            },
        },
    ];

    const envMacros = [];
    for (const varName in env) {
        if (!Object.hasOwn(env, varName)) continue;
        const envRegex = new RegExp(`{{${escapeRegexLiteral(varName)}}}`, 'gi');
        const envReplace = () => {
            const param = env[varName];
            return typeof param === 'function' ? param() : param;
        };
        envMacros.push({ regex: envRegex, replace: envReplace });
    }

    const macros = [...preEnvMacros, ...envMacros, ...postEnvMacros];

    for (const macro of macros) {
        if (!content) break;
        if (!macro.regex.source.startsWith('<') && !content.includes('{{')) break;
        try {
            content = content.replace(macro.regex, (...args) => macro.replace(...args));
        } catch { /* skip malformed macro syntax, same as client */ }
    }

    return content;
}

/**
 * Substitutes {{macro}}/<TAG> parameters in a string. See the module doc comment for exactly
 * which macros from the client's legacy engine are and are not covered.
 * @param {string} content
 * @param {SubstituteParamsContext} [context]
 * @returns {string}
 */
export function substituteParams(content, context = {}) {
    if (!content) return '';
    if (typeof content !== 'string') content = String(content);
    const environment = buildEnvironment(content, context);
    return evaluateMacros(content, environment);
}

/**
 * Mirrors public/script.js's baseChatReplace(): substitutes without re-expanding character-card
 * macros (so a card field can't recursively re-trigger itself), for resolving one raw card field
 * before it's placed into a SubstituteParamsContext.characterCard.
 * @param {string} value
 * @param {{name1?: string, name2?: string}} [names]
 * @returns {string}
 */
export function baseChatReplace(value, { name1, name2 } = {}) {
    if (typeof value !== 'string' || value.length === 0) return value;
    value = substituteParams(value, { name1, name2, replaceCharacterCard: false });
    return value.replace(/\r/g, '');
}
