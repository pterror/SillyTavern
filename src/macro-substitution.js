import moment from 'moment';
import droll from 'droll';
import seedrandom from 'seedrandom';

import { getStringHash } from '../public/scripts/hash-utils.js';

/**
 * Server-side port of the client's legacy macro engine (public/script.js's substituteParamsLegacy
 * plus public/scripts/macros.js's evaluateMacros, with power_user.experimental_macro_engine off -
 * that is the only engine active by default, so it's the only one ported here).
 *
 * Unlike the client, this takes every piece of context explicitly instead of reading globals
 * (chat store, DOM, power_user settings) - the caller resolves those from its own request context
 * and passes them in. Values that only exist as live client state (what's currently typed, what's
 * currently scrolled into view) are NOT a reason to leave the macro unported - they're just a
 * context field the caller supplies as a raw fact, same as name1/name2. Only genuinely absent
 * server capabilities are left unported below.
 *
 * Deliberately NOT ported (each needs real infrastructure that doesn't exist yet, not just a
 * context value - listed so a future pass knows exactly what's missing, not guessing):
 * - {{maxPrompt}}/{{maxPromptTokens}}/{{maxContext}}/{{maxContextTokens}}/{{maxResponse}}/
 *   {{maxResponseTokens}} - depend on the live prompt-budget calculation, which isn't ported yet
 *   (that's the larger prompt-assembly effort this module is a prerequisite for, not a peer of).
 * - {{outlet::key}} - reads content injected by other parts of prompt assembly (world info,
 *   author's note, etc.) at the point they run; depends on that same larger prompt-assembly effort
 *   for there to be anything to read.
 * - Instruct-sequence macros (public/scripts/instruct-mode.js's getInstructMacros, e.g.
 *   {{instructSystemPrompt}}) - lets message/persona text reference the *current* instruct
 *   template's own sequences. Narrow, rarely-used cross-reference; not ported.
 * - MacrosParser-registered macros - extensions register these via a client-side JS API at
 *   runtime; there's no server-side extension execution model to run that code, not merely a
 *   missing context value. `dynamicMacros` is the escape hatch for a caller that has already
 *   resolved specific extension macros itself.
 * - {{banned "..."}} macro-variant array output (RA_CountCharTokens/textgenerationwebui_banned_in_macros) -
 *   the macro itself resolves to '' (ported below); collecting the found words into the request's
 *   actual token-ban list is the caller's job once that request-building code exists server-side.
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
 * @typedef {object} ChatMessage
 * @property {string} [mes]
 * @property {boolean} [is_user]
 * @property {boolean} [is_system]
 * @property {string[]} [swipes]
 * @property {number} [swipe_id]
 * @property {number|string} [send_date]
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
 * @property {ChatMessage[]} [chat] Message history, for the lastMessage/swipe/idle_duration family
 * @property {object} [chatMetadata] Mutable chat_metadata - variables and {{firstIncludedMessageId}} read/write this directly
 * @property {object} [globalVariables] Mutable extension_settings.variables.global - {{getglobalvar}}/{{setglobalvar}} etc. read/write this directly
 * @property {string} [chatId] Stable per-chat identifier, for {{pick}}'s repeatable-but-unique seed
 * @property {string} [currentInput] Raw, not-yet-sent text currently in the user's message box, for {{input}}
 * @property {number|null} [firstDisplayedMessageId] Id of the message currently scrolled into view, for {{firstDisplayedMessageId}}
 * @property {string[]} [bannedWordsSink] Array to push into for every {{banned "word"}} macro found (mirrors the client's ban-list side effect without a module-level global)
 * @property {Record<string, string | (() => string)>} [dynamicMacros] Extra macros, checked after the built-in environment (same precedence as the client's additionalMacro)
 * @property {(value: string) => string} [postProcessFn] Mirrors public/scripts/macros.js's evaluateMacros() third argument (as used via public/script.js's substituteParamsExtended): applied to EVERY individual macro's substituted value - built-in env macros, dynamicMacros, and the pre-/post-env special-cased ones alike - right before it's spliced into the result. Not a whole-string post-process. Defaults to identity when absent, so existing callers are unaffected.
 */

function escapeRegexLiteral(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildEnvironment(context) {
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

/** Mirrors public/scripts/macros.js's getLastMessageId(). */
function getLastMessageId(chat, { excludeSwipeInProgress = true, filter = null } = {}) {
    for (let i = (chat?.length ?? 0) - 1; i >= 0; i--) {
        const message = chat[i];
        if (excludeSwipeInProgress && message.swipes && message.swipe_id >= message.swipes.length) {
            continue;
        }
        if (!filter || filter(message)) {
            return i;
        }
    }
    return null;
}

/** Mirrors public/scripts/macros.js's getTimeSinceLastMessage(). */
function getTimeSinceLastMessage(chat) {
    const now = moment();
    if (Array.isArray(chat) && chat.length > 0) {
        let lastMessage;
        let takeNext = false;
        for (let i = chat.length - 1; i >= 0; i--) {
            const message = chat[i];
            if (message.is_system) continue;
            if (message.is_user && takeNext) {
                lastMessage = message;
                break;
            }
            takeNext = true;
        }
        if (lastMessage?.send_date) {
            const lastMessageDate = moment(lastMessage.send_date);
            return moment.duration(now.diff(lastMessageDate)).humanize();
        }
    }
    return 'just now';
}

/** Mirrors public/scripts/variables.js's get*Variable/set*Variable/add*Variable (macro-call shape only - no index/key/as args, which only the slash-command form exposes). */
function buildVariableMacros(chatMetadata, globalVariables) {
    if (chatMetadata && !chatMetadata.variables) chatMetadata.variables = {};

    const asValue = (raw) => (raw?.trim?.() === '' || isNaN(Number(raw))) ? (raw || '') : Number(raw);
    const getLocal = (name) => chatMetadata ? asValue(chatMetadata.variables[name]) : '';
    const setLocal = (name, value) => { if (chatMetadata) chatMetadata.variables[name] = value; return value; };
    const getGlobal = (name) => globalVariables ? asValue(globalVariables[name]) : '';
    const setGlobal = (name, value) => { if (globalVariables) globalVariables[name] = value; return value; };

    const add = (getter, setter, name, value) => {
        const currentValue = getter(name) || 0;
        try {
            const parsedValue = JSON.parse(currentValue);
            if (Array.isArray(parsedValue)) {
                parsedValue.push(value);
                setter(name, JSON.stringify(parsedValue));
                return parsedValue;
            }
        } catch { /* not an array */ }
        const increment = Number(value);
        if (isNaN(increment) || isNaN(Number(currentValue))) {
            const stringValue = String(currentValue || '') + value;
            setter(name, stringValue);
            return stringValue;
        }
        const newValue = Number(currentValue) + increment;
        if (isNaN(newValue)) return '';
        setter(name, newValue);
        return newValue;
    };

    return [
        { regex: /{{setvar::([^:]+)::([^}]*)}}/gi, replace: (_, name, value) => { setLocal(name.trim(), value); return ''; } },
        { regex: /{{addvar::([^:]+)::([^}]+)}}/gi, replace: (_, name, value) => { add(getLocal, setLocal, name.trim(), value); return ''; } },
        { regex: /{{incvar::([^}]+)}}/gi, replace: (_, name) => add(getLocal, setLocal, name.trim(), 1) },
        { regex: /{{decvar::([^}]+)}}/gi, replace: (_, name) => add(getLocal, setLocal, name.trim(), -1) },
        { regex: /{{getvar::([^}]+)}}/gi, replace: (_, name) => getLocal(name.trim()) },
        { regex: /{{setglobalvar::([^:]+)::([^}]*)}}/gi, replace: (_, name, value) => { setGlobal(name.trim(), value); return ''; } },
        { regex: /{{addglobalvar::([^:]+)::([^}]+)}}/gi, replace: (_, name, value) => { add(getGlobal, setGlobal, name.trim(), value); return ''; } },
        { regex: /{{incglobalvar::([^}]+)}}/gi, replace: (_, name) => add(getGlobal, setGlobal, name.trim(), 1) },
        { regex: /{{decglobalvar::([^}]+)}}/gi, replace: (_, name) => add(getGlobal, setGlobal, name.trim(), -1) },
        { regex: /{{getglobalvar::([^}]+)}}/gi, replace: (_, name) => getGlobal(name.trim()) },
    ];
}

/** Mirrors public/scripts/macros.js's getRandomReplaceMacro()/getPickReplaceMacro(). */
function splitMacroList(listString) {
    return listString.includes('::')
        ? listString.split('::')
        : listString.replace(/\\,/g, '##�COMMA�##').split(',').map(item => item.trim().replace(/##�COMMA�##/g, ','));
}

function evaluateMacros(content, env, context) {
    if (!content) return '';

    const { chat, chatMetadata, globalVariables, chatId, currentInput, firstDisplayedMessageId, bannedWordsSink, postProcessFn } = context;
    const applyPostProcess = typeof postProcessFn === 'function' ? postProcessFn : (x => x);
    const rawContent = content;

    const preEnvMacros = [
        { regex: /<USER>/gi, replace: () => typeof env.user === 'function' ? env.user() : env.user },
        { regex: /<BOT>/gi, replace: () => typeof env.char === 'function' ? env.char() : env.char },
        { regex: /<CHAR>/gi, replace: () => typeof env.char === 'function' ? env.char() : env.char },
        { regex: /<CHARIFNOTGROUP>/gi, replace: () => typeof env.group === 'function' ? env.group() : env.group },
        { regex: /<GROUP>/gi, replace: () => typeof env.group === 'function' ? env.group() : env.group },
        ...buildVariableMacros(chatMetadata, globalVariables),
        { regex: /{{newline}}/gi, replace: () => '\n' },
        { regex: /(?:\r?\n)*{{trim}}(?:\r?\n)*/gi, replace: () => '' },
        { regex: /{{noop}}/gi, replace: () => '' },
        { regex: /{{input}}/gi, replace: () => currentInput ?? '' },
    ];

    const postEnvMacros = [
        { regex: /{{lastMessage}}/gi, replace: () => { const mid = getLastMessageId(chat); return chat?.[mid]?.mes ?? ''; } },
        { regex: /{{lastMessageId}}/gi, replace: () => String(getLastMessageId(chat) ?? '') },
        { regex: /{{lastUserMessage}}/gi, replace: () => { const mid = getLastMessageId(chat, { filter: m => m.is_user && !m.is_system }); return chat?.[mid]?.mes ?? ''; } },
        { regex: /{{lastCharMessage}}/gi, replace: () => { const mid = getLastMessageId(chat, { filter: m => !m.is_user && !m.is_system }); return chat?.[mid]?.mes ?? ''; } },
        { regex: /{{firstIncludedMessageId}}/gi, replace: () => String(chatMetadata?.lastInContextMessageId ?? '') },
        { regex: /{{firstDisplayedMessageId}}/gi, replace: () => String(firstDisplayedMessageId ?? '') },
        { regex: /{{lastSwipeId}}/gi, replace: () => { const mid = getLastMessageId(chat, { excludeSwipeInProgress: false }); return String(chat?.[mid]?.swipes?.length ?? ''); } },
        { regex: /{{currentSwipeId}}/gi, replace: () => { const mid = getLastMessageId(chat, { excludeSwipeInProgress: false }); const swipeId = chat?.[mid]?.swipe_id; return swipeId != null ? String(swipeId + 1) : ''; } },
        { regex: /{{allChatRange}}/gi, replace: () => !chat || chat.length === 0 ? '' : `0-${chat.length - 1}` },
        { regex: /{{reverse:(.+?)}}/gi, replace: (_, str) => Array.from(str).reverse().join('') },
        { regex: /\{\{\/\/([\s\S]*?)\}\}/gm, replace: () => '' },
        { regex: /{{time}}/gi, replace: () => moment().format('LT') },
        { regex: /{{date}}/gi, replace: () => moment().format('LL') },
        { regex: /{{weekday}}/gi, replace: () => moment().format('dddd') },
        { regex: /{{isotime}}/gi, replace: () => moment().format('HH:mm') },
        { regex: /{{isodate}}/gi, replace: () => moment().format('YYYY-MM-DD') },
        { regex: /{{datetimeformat +([^}]*)}}/gi, replace: (_, format) => moment().format(format) },
        { regex: /{{idle_duration}}/gi, replace: () => getTimeSinceLastMessage(chat) },
        { regex: /{{time_UTC([-+]\d+)}}/gi, replace: (_, offset) => moment().utc().utcOffset(parseInt(offset, 10)).format('LT') },
        { regex: /{{banned "(.*)"}}/gi, replace: (_, word) => { bannedWordsSink?.push(word); return ''; } },
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
        {
            regex: /{{random\s?::?([^}]+)}}/gi, replace: (_match, listString) => {
                const list = splitMacroList(listString);
                if (list.length === 0) return '';
                const rng = seedrandom('added entropy.', { entropy: true });
                return list[Math.floor(rng() * list.length)];
            },
        },
        {
            regex: /{{pick\s?::?([^}]+)}}/gi, replace: (_match, listString, offset) => {
                const list = splitMacroList(listString);
                if (list.length === 0) return '';
                const chatIdHash = getStringHash(chatId ?? '');
                const rawContentHash = getStringHash(rawContent);
                const combinedSeedString = `${chatIdHash}-${rawContentHash}-${offset}`;
                const rng = seedrandom(getStringHash(combinedSeedString));
                return list[Math.floor(rng() * list.length)];
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
            content = content.replace(macro.regex, (...args) => applyPostProcess(macro.replace(...args)));
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
    const environment = buildEnvironment(context);
    return evaluateMacros(content, environment, context);
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
