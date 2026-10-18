import { getRegexedString, regex_placement } from './regex-scripts-engine.js';
import { getStoppingStrings } from './stopping-strings.js';

/**
 * Server-side port of public/script.js's cleanUpMessage() for a generated reply (never an impersonation: those
 * aren't stored), run on the reply before it is stored. Upstream's page ran it on every reply before parsing its
 * reasoning, so src/reply-reasoning.js runs it first, in the same order.
 *
 * Every setting is read once when the generation starts (readReplyFinishSettings()); this module reads nothing.
 */

/**
 * @typedef {object} ReplyCleanupSettings
 * @property {string} mainApi
 * @property {string} name1
 * @property {string} name2
 * @property {string} replyBias "Start Reply With", macros substituted.
 * @property {object} stoppingStringsParams What getStoppingStrings() takes, minus isImpersonate/isContinue/api/chat.
 * @property {object[]} regexScripts
 * @property {boolean} regexEnabled
 * @property {{name1: string, name2: string}} macroContext
 * @property {boolean} collapseNewlines `power_user.collapse_newlines`
 * @property {boolean} allowName1Display `power_user.allow_name1_display`
 * @property {boolean} allowName2Display `power_user.allow_name2_display`
 * @property {{enabled?: boolean, stop_sequence?: string, input_sequence?: string, output_sequence?: string, last_output_sequence?: string, sequences_as_stop_strings?: boolean}} instruct `power_user.instruct`
 * @property {boolean} isGroup
 * @property {string[]} groupMemberNames The group's members' names.
 * @property {boolean} disableGroupTrimming `power_user.disable_group_trimming`
 * @property {boolean} trimSentences `power_user.trim_sentences`
 * @property {boolean} trimSpaces `power_user.trim_spaces`
 */

/** @param {string} string */
function escapeRegex(string) {
    return string.replace(/[/\-\\^$*+?.()|[\]{}]/g, '\\$&');
}

/**
 * Port of public/scripts/utils.js trimToEndSentence().
 * @param {string} input
 * @returns {string}
 */
export function trimToEndSentence(input) {
    if (!input) {
        return '';
    }
    const isEmoji = x => /(\p{Emoji_Presentation}|\p{Extended_Pictographic})/gu.test(x);
    const punctuation = new Set(['.', '!', '?', '*', '"', ')', '}', '`', ']', '$', '。', '！', '？', '”', '）', '】', '’', '」', '_']);
    let last = -1;
    const characters = Array.from(input);
    for (let i = characters.length - 1; i >= 0; i--) {
        const char = characters[i];
        const emoji = isEmoji(char);
        if (punctuation.has(char) || emoji) {
            if (!emoji && i > 0 && /[\s\n]/.test(characters[i - 1])) {
                last = i - 1;
            } else {
                last = i;
            }
            break;
        }
    }
    if (last === -1) {
        return input.trimEnd();
    }
    return characters.slice(0, last + 1).join('').trimEnd();
}

/**
 * The stopping strings of this reply, as upstream's getStoppingStrings(false, isContinue, main_api) gives them.
 * @param {ReplyCleanupSettings} settings
 * @param {{isContinue: boolean, lastIsUser: boolean}} reply
 */
export function replyStoppingStrings(settings, { isContinue, lastIsUser }) {
    return getStoppingStrings({
        ...settings.stoppingStringsParams,
        isImpersonate: false, isContinue, api: settings.mainApi,
        chat: [{ is_user: lastIsUser }],
    });
}

/**
 * Port of cleanUpMessage({ getMessage, isImpersonate: false, isContinue, displayIncompleteSentences: false }).
 * @param {string} text The reply's text (a continue's: the message's text and the generated text).
 * @param {ReplyCleanupSettings} settings
 * @param {{isContinue: boolean, lastIsUser?: boolean, keepSpaces?: boolean}} reply `keepSpaces`: the prompt ended
 *   inside a reasoning block (PromptReasoning.getLatestPrefix()), so the text isn't trimmed.
 * @returns {string}
 */
export function cleanUpReply(text, settings, { isContinue, lastIsUser = false, keepSpaces = false }) {
    let message = text;
    if (!message) {
        return '';
    }

    if (settings.replyBias && !isContinue) {
        message = settings.replyBias + message;
    }

    for (const stoppingString of replyStoppingStrings(settings, { isContinue, lastIsUser })) {
        if (stoppingString.length) {
            for (let j = stoppingString.length; j > 0; j--) {
                if (message.slice(-j) === stoppingString.slice(0, j)) {
                    message = message.slice(0, -j);
                    break;
                }
            }
        }
    }

    message = getRegexedString(message, regex_placement.AI_OUTPUT, settings.regexScripts, {
        regexExtensionEnabled: settings.regexEnabled, macroContext: settings.macroContext,
    });

    if (settings.collapseNewlines) {
        message = message.replaceAll(/\n+/g, '\n');
    }

    message = message.replace(/[^\S\r\n]+$/gm, '');

    const wrongName = !settings.allowName1Display ? settings.name1 : '';
    if (wrongName) {
        if (message.indexOf(`${wrongName}:`) === 0) {
            message = '';
        }
        const startIndex = message.indexOf(`\n${wrongName}:`);
        if (startIndex >= 0) {
            message = message.substring(0, startIndex);
        }
    }

    if (message.indexOf('<|endoftext|>') !== -1) {
        message = message.substring(0, message.indexOf('<|endoftext|>'));
    }
    const instruct = settings.instruct ?? {};
    const isInstruct = Boolean(instruct.enabled) && settings.mainApi !== 'openai';
    const isNotEmpty = (/** @type {string|undefined} */ str) => Boolean(str && str.trim() !== '');
    if (isInstruct && instruct.stop_sequence && message.indexOf(instruct.stop_sequence) !== -1) {
        message = message.substring(0, message.indexOf(instruct.stop_sequence));
    }
    if (isInstruct && isNotEmpty(instruct.input_sequence) && message.indexOf(instruct.input_sequence) !== -1) {
        message = message.substring(0, message.indexOf(instruct.input_sequence));
    }
    if (isInstruct && instruct.sequences_as_stop_strings) {
        for (const value of [instruct.output_sequence, instruct.last_output_sequence]) {
            if (!isNotEmpty(value)) continue;
            String(value).split('\n').filter(line => line.trim() !== '').forEach(line => { message = message.replaceAll(line, ''); });
        }
    }

    if (settings.isGroup && !settings.disableGroupTrimming) {
        for (const name of settings.groupMemberNames ?? []) {
            if (!name || name === settings.name2) continue;
            const nameMatch = message.match(new RegExp(`(^|\n)${escapeRegex(name)}:`));
            if (nameMatch) {
                message = message.substring(0, nameMatch.index);
            }
        }
    }

    if (!settings.allowName2Display) {
        message = message.replace(new RegExp(`(^|\n)${escapeRegex(settings.name2)}:\\s*`, 'g'), '$1');
    }

    const nameToTrim = !settings.allowName2Display ? settings.name2 : '';
    if (nameToTrim && message.startsWith(nameToTrim + ':')) {
        message = message.replace(nameToTrim + ':', '');
        message = message.trimStart();
    }

    if (settings.trimSentences) {
        message = trimToEndSentence(message);
    }

    if (settings.trimSpaces && !keepSpaces) {
        message = message.trim();
    }

    return message;
}
