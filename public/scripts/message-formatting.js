import { systemUserName, substituteParams, setMesForShowdownParse } from '../script.js';
import { chat } from './chat-state.js';
import { COMMENT_NAME_DEFAULT } from './slash-commands.js';
import { getRegexedString, regex_placement } from './extensions/regex/engine.js';
import { decodeStyleTags, encodeStyleTags } from './chats.js';
import { MessageFormatter } from './message-formatter.js';
import { power_user } from './power-user.js';
import { escapeRegex, escapeHtml, canUseNegativeLookbehind } from './utils.js';
import { DOMPurify } from '../lib.js';
import { renderMarkdown } from './marked-processor.js';

const TITLE = String.raw`"(?:\\[\s\S]|[^"\\])*"`;
const IMAGE_SIZE = String.raw` =[^\s"'()]*`;
const TITLED_LINK = String.raw`\]\(\s*(?:<(?:\\.|[^\n<>\\])*>|(?:\\.|[^\s()\\]|\((?:\\.|[^\s()\\])*\))+)`
    + String.raw`(?:${IMAGE_SIZE}[ \t]*(?:\n[ \t]*)?|[ \t]+(?:\n[ \t]*)?|\n[ \t]*)${TITLE}\s*\)`;
const TITLED_DEFINITION = String.raw`^ {0,3}\[(?:\\[\s\S]|[^\[\]\\])+\]:[ \t]*(?:\n[ \t]*)?(?:<[^\n]*?>|[^<\s]\S*?)`
    + String.raw`(?:${IMAGE_SIZE}[ \t]*(?:\n[ \t]*)?| +(?:\n[ \t]*)?| *\n[ \t]*)${TITLE}[ \t]*$`;
const quoteRegex = new RegExp(
    String.raw`<style>[\s\S]*?<\/style>|${'```'}[\s\S]*?${'```'}|~~~[\s\S]*?~~~|${'``'}[\s\S]*?${'``'}|${'`'}[\s\S]*?${'`'}`
    + `|${TITLED_LINK}|${TITLED_DEFINITION}`
    + String.raw`|(".*?")|(“.*?”)|(«.*?»)|(「.*?」)|(『.*?』)|(＂.*?＂)`,
    'gim',
);

/**
 * @param {number} messageId
 */
export function messageFormatting(mes, ch_name, isSystem, isUser, messageId, sanitizerOverrides = {}, isReasoning = false) {
    if (!mes) {
        return '';
    }

    if (Number(messageId) === 0 && !isSystem && !isUser && !isReasoning) {
        mes = substituteParams(mes, undefined, ch_name);
    }

    setMesForShowdownParse(mes);

    if (ch_name === COMMENT_NAME_DEFAULT && isSystem && !isUser) {
        isSystem = false;
    }

    if (isSystem && ch_name !== systemUserName) {
        isSystem = false;
    }

    const replacedPromptBias = power_user.user_prompt_bias && substituteParams(power_user.user_prompt_bias);
    if (!power_user.show_user_prompt_bias && ch_name && !isUser && !isSystem && replacedPromptBias && mes.startsWith(replacedPromptBias)) {
        mes = mes.slice(replacedPromptBias.length);
    }

    if (!isSystem) {
        function getRegexPlacement() {
            try {
                if (isReasoning) {
                    return regex_placement.REASONING;
                }
                if (isUser) {
                    return regex_placement.USER_INPUT;
                } else if (chat[messageId]?.extra?.type === 'narrator') {
                    return regex_placement.SLASH_COMMAND;
                } else {
                    return regex_placement.AI_OUTPUT;
                }
            } catch {
                return regex_placement.AI_OUTPUT;
            }
        }

        const regexPlacement = getRegexPlacement();
        const usableMessages = chat.map((x, index) => ({ message: x, index: index })).filter(x => !x.message.is_system);
        const indexOf = usableMessages.findIndex(x => x.index === Number(messageId));
        const depth = messageId >= 0 && indexOf !== -1 ? (usableMessages.length - indexOf - 1) : undefined;

        mes = MessageFormatter.runStage(MessageFormatter.stage.BEFORE_REGEX, mes,
            { ch_name, isSystem, isUser, messageId, isReasoning },
        );

        mes = getRegexedString(mes, regexPlacement, {
            characterOverride: ch_name,
            isMarkdown: true,
            depth: depth,
        });

        mes = MessageFormatter.runStage(MessageFormatter.stage.AFTER_REGEX, mes,
            { ch_name, isSystem, isUser, messageId, isReasoning },
        );
    }

    if (!isSystem && power_user.encode_tags) {
        mes = canUseNegativeLookbehind()
            ? mes.replaceAll('<', '&lt;').replace(new RegExp('(?<!^|\\n\\s*)>', 'g'), '&gt;')
            : mes.replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    }

    [power_user.reasoning.prefix, power_user.reasoning.suffix].forEach((reasoningString) => {
        if (!reasoningString || !reasoningString.trim().length) {
            return;
        }
        if (mes.includes(reasoningString)) {
            mes = mes.replace(reasoningString, escapeHtml(reasoningString));
        }
    });

    if (!isSystem) {
        if (!power_user.encode_tags) {
            mes = mes.replace(/<([^>]+)>/g, function (_, contents) {
                return '<' + contents.replace(/"/g, '\ufffe') + '>';
            });
        }

        mes = mes.replace(
            quoteRegex,
            function (match, p1, p2, p3, p4, p5, p6) {
                if (p1) {
                    return `<q>"${p1.slice(1, -1)}"</q>`;
                } else if (p2) {
                    return `<q>“${p2.slice(1, -1)}”</q>`;
                } else if (p3) {
                    return `<q>«${p3.slice(1, -1)}»</q>`;
                } else if (p4) {
                    return `<q>「${p4.slice(1, -1)}」</q>`;
                } else if (p5) {
                    return `<q>『${p5.slice(1, -1)}』</q>`;
                } else if (p6) {
                    return `<q>＂${p6.slice(1, -1)}＂</q>`;
                } else {
                    return match;
                }
            },
        );

        if (!power_user.encode_tags) {
            mes = mes.replace(/\ufffe/g, '"');
        }

        mes = mes.replaceAll('\\begin{align*}', '$$');
        mes = mes.replaceAll('\\end{align*}', '$$');
        mes = renderMarkdown(mes);

        mes = mes.replace(/<code(.*)>[\s\S]*?<\/code>/g, function (match) {
            return match.replace(/\n/gm, '\u0000');
        });
        mes = mes.replace(/\u0000/g, '\n');
        mes = mes.trim();

        mes = mes.replace(/<code(.*)>[\s\S]*?<\/code>/g, function (match) {
            return match.replace(/&amp;/g, '&');
        });

        mes = MessageFormatter.runStage(MessageFormatter.stage.AFTER_MARKDOWN, mes,
            { ch_name, isSystem, isUser, messageId, isReasoning },
        );
    }

    if (!power_user.allow_name2_display && ch_name && !isUser && !isSystem) {
        mes = mes.replace(new RegExp(`(^|\n)${escapeRegex(ch_name)}:`, 'g'), '$1');
    }

    /** @type {DOMPurify.Config} */
    const config = {
        RETURN_DOM: false,
        RETURN_DOM_FRAGMENT: false,
        RETURN_TRUSTED_TYPE: false,
        MESSAGE_SANITIZE: true,
        ADD_TAGS: ['custom-style'],
        ...sanitizerOverrides,
    };
    mes = encodeStyleTags(mes);
    mes = DOMPurify.sanitize(mes, config);
    mes = decodeStyleTags(mes, { prefix: '.mes_text ' });

    return mes;
}
