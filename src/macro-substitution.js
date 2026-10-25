import * as chevrotain from 'chevrotain';
import moment from 'moment';
import droll from 'droll';
import seedrandom from 'seedrandom';

import { getStringHash } from '../public/scripts/hash-utils.js';
import { initMacroEngine, registerBuiltinMacros } from '../public/scripts/macros/macro-engine-init.js';
import { MacroEngine } from '../public/scripts/macros/engine/MacroEngine.js';
import { createVariableScope } from '../public/scripts/variable-store.js';
import { parseTimestamp } from './timestamps.js';

/**
 * The server's macro substitution: the macro engine the page runs (public/scripts/macros/), with the env built from
 * what the caller passes. Nothing is read from a global: the caller resolves the request's facts (the chat, its
 * variables, the settings) and passes them in. A fact left out reads as empty.
 *
 * Macros an extension registers on the page (MacrosParser) aren't here: they run in the page. `dynamicMacros` is for
 * a caller that has resolved some itself.
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
 * @property {string} [firstMessage]
 * @property {string[]} [alternateGreetings]
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
 * @property {string[]} [bannedWordsSink] Where {{banned}} puts each word it bans; given only for a request that bans words (text completion)
 * @property {number} [maxPromptTokens] {{maxPrompt}}
 * @property {number} [maxContextTokens] {{maxContext}}
 * @property {number} [maxResponseTokens] {{maxResponse}}
 * @property {string} [mainApi] The API generating (main_api)
 * @property {Record<string, string>} [outlets] World info outlets' text by key, for {{outlet}}
 * @property {boolean} [isMobile] {{isMobile}}
 * @property {string} [lastGenerationType] {{lastGenerationType}}
 * @property {{ names: string[], disabled: string[] }} [extensions] The extensions there are, and those turned off, for {{hasExtension}}
 * @property {Record<string, any>} [instruct] The instruct template, for the instruct macros
 * @property {{ enabled?: boolean, content?: string }} [sysprompt] The system prompt, for {{systemPrompt}}
 * @property {Record<string, any>} [contextTemplate] The context template, for {{chatStart}}/{{exampleSeparator}}
 * @property {boolean} [preferCharacterPrompt] {{systemPrompt}} gives the character's main prompt when it has one
 * @property {Record<string, string | ((...args: any[]) => string)>} [dynamicMacros] Extra macros, checked before the registered ones (lower-case names match any case)
 * @property {(value: string, macro?: object) => string} [postProcessFn] Applied to every macro's value before it's put in its place; not a whole-string post-process
 */

initMacroEngine({
    chevrotain,
    moment,
    seedrandom,
    droll,
    timestampToMoment: (timestamp) => {
        const ms = parseTimestamp(timestamp);
        return ms ? moment(ms) : moment.invalid();
    },
});
registerBuiltinMacros();

/**
 * {{group}} and its kin, as the page's MacroEnvBuilder makes them.
 * @param {SubstituteParamsContext} context
 * @param {{ includeMuted?: boolean, filterOutChar?: boolean }} options
 */
function groupValue({ name1 = '', name2 = '', group, groupMembers, groupDisabledMembers = [], isGroup = false }, { includeMuted = false, filterOutChar = false }) {
    if (typeof group === 'string') return group;
    if (!isGroup) return filterOutChar ? name1 : name2;
    if (!Array.isArray(groupMembers)) return '';
    // Everyone but the one speaking is the others and the user.
    return groupMembers
        .filter(name => includeMuted || !groupDisabledMembers.includes(name))
        .filter(name => !filterOutChar || name !== name2)
        .concat(filterOutChar ? [name1] : [])
        .join(', ');
}

/**
 * @param {string} content
 * @param {SubstituteParamsContext} context
 * @returns {import('../public/scripts/macros/engine/MacroEnv.types.js').MacroEnv}
 */
function buildEnv(content, context) {
    const { name1 = '', name2 = '', original, model = '', replaceCharacterCard = true, characterCard = {}, dynamicMacros, postProcessFn } = context;
    const chatMetadata = /** @type {Record<string, any> | undefined} */ (context.chatMetadata);
    const localVariables = chatMetadata ?? {};
    const globalVariables = /** @type {Record<string, any>} */ (context.globalVariables ?? {});

    /** @type {import('../public/scripts/macros/engine/MacroEnv.types.js').MacroEnvCharacter} */
    const character = replaceCharacterCard ? {
        charPrompt: characterCard.system || '',
        charInstruction: characterCard.jailbreak || '',
        description: characterCard.description || '',
        personality: characterCard.personality || '',
        scenario: characterCard.scenario || '',
        persona: characterCard.persona || '',
        mesExamplesRaw: characterCard.mesExamplesRaw || '',
        mesExamples: characterCard.mesExamples || '',
        version: characterCard.charVersion || '',
        charDepthPrompt: characterCard.charDepthPrompt || '',
        creatorNotes: characterCard.creatorNotes || '',
        firstMessage: characterCard.firstMessage || '',
        alternateGreetings: Array.isArray(characterCard.alternateGreetings) ? characterCard.alternateGreetings : [],
    } : {};

    let originalUsed = false;
    return {
        content,
        contentHash: getStringHash(content),
        names: {
            user: name1,
            char: name2,
            group: groupValue(context, { includeMuted: true }),
            groupNotMuted: groupValue(context, { includeMuted: false }),
            notChar: groupValue(context, { filterOutChar: true }),
        },
        character,
        system: { model },
        functions: {
            ...(typeof original === 'string' ? {
                original: () => {
                    if (originalUsed) return '';
                    originalUsed = true;
                    return original;
                },
            } : {}),
            postProcess: typeof postProcessFn === 'function' ? postProcessFn : (x => x),
        },
        state: {
            chat: context.chat,
            chatMetadata,
            chatId: context.chatId,
            variables: {
                local: createVariableScope(() => (localVariables.variables ??= {})),
                global: createVariableScope(() => globalVariables),
            },
            input: context.currentInput,
            firstDisplayedMessageId: context.firstDisplayedMessageId,
            maxPromptTokens: context.maxPromptTokens,
            maxContextTokens: context.maxContextTokens,
            maxResponseTokens: context.maxResponseTokens,
            mainApi: context.mainApi,
            bannedWords: context.bannedWordsSink,
            outlet: key => context.outlets?.[key] ?? '',
            isMobile: context.isMobile,
            lastGenerationType: context.lastGenerationType,
            extensions: context.extensions,
            instruct: context.instruct,
            sysprompt: context.sysprompt,
            context: context.contextTemplate,
            preferCharacterPrompt: context.preferCharacterPrompt,
        },
        dynamicMacros: Object.fromEntries(Object.entries(dynamicMacros ?? {}).map(([key, value]) => [key.toLowerCase(), value])),
        extra: {},
    };
}

/**
 * Substitutes the macros in a string, as the page does.
 * @param {string} content
 * @param {SubstituteParamsContext} [context]
 * @returns {string}
 */
export function substituteParams(content, context = {}) {
    if (!content) return '';
    if (typeof content !== 'string') content = String(content);
    return MacroEngine.evaluate(content, buildEnv(content, context));
}

/**
 * Mirrors public/script.js's baseChatReplace(): substitutes without re-expanding character-card
 * macros (so a card field can't recursively re-trigger itself), for resolving one raw card field
 * before it's placed into a SubstituteParamsContext.characterCard.
 * @param {string} value
 * @param {SubstituteParamsContext} [context] Everything else the macros read.
 * @returns {string}
 */
export function baseChatReplace(value, context = {}) {
    if (typeof value !== 'string' || value.length === 0) return value;
    value = substituteParams(value, { ...context, replaceCharacterCard: false });
    return value.replace(/\r/g, '');
}
