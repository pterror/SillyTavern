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
 * @typedef {object} CharacterCardFields
 * @property {string} [system]
 * @property {string} [jailbreak]
 * @property {string} [description]
 * @property {string} [personality]
 * @property {string} [scenario]
 * @property {string} [persona]
 * @property {string} [mesExamplesRaw]
 * @property {string} [mesExamples]
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
 * @property {string} [name1]
 * @property {string} [name2]
 * @property {string} [original]
 * @property {string} [group]
 * @property {string[]} [groupMembers]
 * @property {string[]} [groupDisabledMembers]
 * @property {boolean} [isGroup]
 * @property {string} [model]
 * @property {boolean} [replaceCharacterCard]
 * @property {CharacterCardFields} [characterCard]
 * @property {ChatMessage[]} [chat]
 * @property {object} [chatMetadata]
 * @property {object} [globalVariables]
 * @property {string} [chatId]
 * @property {string} [currentInput]
 * @property {number|null} [firstDisplayedMessageId]
 * @property {string[]} [bannedWordsSink]
 * @property {number} [maxPromptTokens]
 * @property {number} [maxContextTokens]
 * @property {number} [maxResponseTokens]
 * @property {string} [mainApi]
 * @property {Record<string, string>} [outlets]
 * @property {boolean} [isMobile]
 * @property {number} [utcOffset]
 * @property {string} [lastGenerationType]
 * @property {{ names: string[], disabled: string[] }} [extensions]
 * @property {Record<string, any>} [instruct]
 * @property {{ enabled?: boolean, content?: string }} [sysprompt]
 * @property {Record<string, any>} [contextTemplate]
 * @property {boolean} [preferCharacterPrompt]
 * @property {Record<string, string | ((...args: any[]) => string)>} [dynamicMacros]
 * @property {(value: string, macro?: object) => string} [postProcessFn]
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
 * @param {SubstituteParamsContext} context
 * @param {{ includeMuted?: boolean, filterOutChar?: boolean }} options
 */
function groupValue({ name1 = '', name2 = '', group, groupMembers, groupDisabledMembers = [], isGroup = false }, { includeMuted = false, filterOutChar = false }) {
    if (typeof group === 'string') return group;
    if (!isGroup) return filterOutChar ? name1 : name2;
    if (!Array.isArray(groupMembers)) return '';
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
            utcOffset: context.utcOffset,
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
 * @param {string} value
 * @param {SubstituteParamsContext} [context]
 * @returns {string}
 */
export function baseChatReplace(value, context = {}) {
    if (typeof value !== 'string' || value.length === 0) return value;
    value = substituteParams(value, { ...context, replaceCharacterCard: false });
    return value.replace(/\r/g, '');
}
