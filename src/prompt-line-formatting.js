import Handlebars from 'handlebars';
import { substituteParams } from './macro-substitution.js';
import { formatInstructModeChat, formatInstructModePrompt } from './instruct-template-format.js';

const system_message_types = {
    NARRATOR: 'narrator',
};

export const IGNORE_SYMBOL = 'ignore';

/**
 * @param {string} message
 * @returns {string}
 */
function extractMessageBias(message) {
    if (!message) {
        return '';
    }

    try {
        const biasHandlebars = Handlebars.create();
        const biasMatches = [];
        biasHandlebars.registerHelper('bias', function (text) {
            biasMatches.push(text);
            return '';
        });
        const template = biasHandlebars.compile(message);
        template({});

        if (biasMatches && biasMatches.length > 0) {
            return ` ${biasMatches.join(' ')}`;
        }

        return '';
    } catch {
        return '';
    }
}

/**
 * @typedef {object} GetBiasStringsParams
 * @property {string} textareaText
 * @property {string} [type]
 * @property {{is_user?: boolean, is_system?: boolean, extra?: {type?: string, bias?: string}}[]} [chat]
 * @property {string} [userPromptBias]
 * @property {import('./macro-substitution.js').SubstituteParamsContext} [macroContext]
 */

/**
 * @typedef {object} BiasStrings
 * @property {string} messageBias
 * @property {string} promptBias
 * @property {boolean} isUserPromptBias
 */

/**
 * @param {GetBiasStringsParams} params
 * @returns {BiasStrings}
 */
export function getBiasStrings({ textareaText, type, chat = [], userPromptBias = '', macroContext = {} }) {
    if (type == 'impersonate' || type == 'continue') {
        return { messageBias: '', promptBias: '', isUserPromptBias: false };
    }

    let promptBias = '';
    let messageBias = extractMessageBias(textareaText);

    if (!textareaText) {
        for (let i = chat.length - 1; i >= 0; i--) {
            const mes = chat[i];
            if ((type === 'swipe' || type === 'regenerate') && chat.length - 1 === i) {
                continue;
            }
            if (mes && (mes.is_user || mes.is_system || mes.extra?.type === system_message_types.NARRATOR)) {
                if (mes.extra?.bias?.trim()?.length > 0) {
                    promptBias = mes.extra.bias;
                }
                break;
            }
        }
    }

    promptBias = messageBias || promptBias || userPromptBias || '';
    const isUserPromptBias = promptBias === userPromptBias;

    messageBias = substituteParams(messageBias, macroContext);
    promptBias = substituteParams(promptBias, macroContext);

    return { messageBias, promptBias, isUserPromptBias };
}

/**
 * @typedef {object} FormatMessageHistoryItemContext
 * @property {boolean} [isGroup]
 * @property {string} name1
 * @property {string} name2
 * @property {import('./instruct-template-format.js').InstructSettings} instructPreset
 */

/**
 * @param {{name?: string, mes?: string, is_user?: boolean, force_avatar?: string, extra?: {type?: string, [IGNORE_SYMBOL]?: boolean}}} chatItem
 * @param {boolean} isInstruct
 * @param {boolean|number|undefined} forceOutputSequence
 * @param {FormatMessageHistoryItemContext} context
 * @returns {string}
 */
export function formatMessageHistoryItem(chatItem, isInstruct, forceOutputSequence, { isGroup = false, name1, name2, instructPreset, macroContext = {} }) {
    const isNarratorType = chatItem?.extra?.type === system_message_types.NARRATOR;
    const characterName = chatItem?.name ? chatItem.name : name2;
    const itemName = chatItem.is_user ? chatItem.name : characterName;
    const shouldPrependName = !isNarratorType;

    if (chatItem.extra?.[IGNORE_SYMBOL]) {
        return '';
    }

    let textResult = chatItem?.name && shouldPrependName ? `${itemName}: ${chatItem.mes}\n` : `${chatItem.mes}\n`;

    if (isInstruct) {
        textResult = formatInstructModeChat(itemName, chatItem.mes, chatItem.is_user, isNarratorType, isGroup, chatItem.force_avatar, name1, name2, forceOutputSequence, instructPreset, macroContext);
    }

    return textResult;
}

/**
 * @typedef {object} ModifyLastPromptLineParams
 * @property {string} [quiet_prompt]
 * @property {string} name1
 * @property {string} name2
 * @property {boolean} isInstruct
 * @property {boolean} [quietToLoud]
 * @property {string} [type]
 * @property {string} [quietName]
 * @property {boolean} [isImpersonate]
 * @property {string} [promptBias]
 * @property {{is_user?: boolean}[]} chat
 * @property {boolean} [force_name2]
 * @property {boolean} [isContinue]
 * @property {boolean} [isGroup]
 * @property {import('./instruct-template-format.js').InstructSettings} instructPreset
 */

/**
 * @param {string} lastMesString
 * @param {ModifyLastPromptLineParams} params
 * @returns {string}
 */
export function modifyLastPromptLine(lastMesString, {
    quiet_prompt,
    name1,
    name2,
    isInstruct,
    quietToLoud,
    type,
    quietName,
    isImpersonate,
    promptBias,
    chat,
    force_name2,
    isContinue,
    isGroup = false,
    instructPreset,
    macroContext = {},
}) {
    if (quiet_prompt && quiet_prompt.length) {
        const name = name1;
        const quietAppend = isInstruct ? formatInstructModeChat(name, quiet_prompt, false, true, isGroup, '', name1, name2, false, instructPreset, macroContext) : `\n${quiet_prompt}`;

        if (isInstruct) {
            lastMesString += quietAppend;
        } else {
            lastMesString += quietAppend;
        }

        if (!isInstruct && !quietToLoud) {
            return lastMesString;
        }
    }

    if (isInstruct && !isContinue) {
        const name = (quiet_prompt && !quietToLoud && !isImpersonate) ? (quietName ?? 'System') : (isImpersonate ? name1 : name2);
        const isQuiet = Boolean(quiet_prompt) && type == 'quiet';
        lastMesString += formatInstructModePrompt(name, isImpersonate, promptBias, name1, name2, isQuiet, quietToLoud, isGroup, instructPreset, macroContext);
    }

    if (!isInstruct && isImpersonate && !isContinue) {
        const name = name1;
        if (!lastMesString.endsWith('\n')) {
            lastMesString += '\n';
        }
        lastMesString += name + ':';
    }

    const isContinuingOnFirstMessage = chat.length === 1 && isContinue;
    if (!isInstruct && force_name2 && !isContinuingOnFirstMessage) {
        if (!lastMesString.endsWith('\n')) {
            lastMesString += '\n';
        }
        if (!isContinue || !(chat[chat.length - 1]?.is_user)) {
            lastMesString += `${name2}:`;
        }
    }

    return lastMesString;
}
