/**
 * Display-only message rendering: `chat` text in, sanitized HTML out. Structurally, not just by
 * convention, this module cannot write to the chat store - it does not import `updateMessage()`,
 * `updateIn()`, `chatOpEdit()`, or any other function that assigns into the `chat` array, and it never
 * will unless someone deliberately adds that import back (at which point this comment, and the reason
 * this file exists at all, is the thing to read first).
 *
 * That boundary exists because of a real, twice-repeated bug: a display-time substitution
 * (`{{user}}`/`{{char}}` macro resolution for the greeting) was being persisted straight onto the
 * canonical stored message via `updateMessage()`, first from `Generate()`'s prompt-building step, then
 * - after that call site was fixed - from this same formatting logic when it still lived in
 * script.js. Both times, a derived, display-shaped value reached the chat store's real writer and got
 * mistaken for a genuine edit, permanently corrupting a never-actually-used greeting's stored text.
 * Neither fix, scoped to "don't call updateMessage with this content here", closed the underlying
 * hole: anything in the same module as `updateMessage()` can always be tempted to call it. Moving the
 * formatter into a module that simply has no such import closes the class of mistake, not just the one
 * instance of it - a future formatting change here literally cannot regress into "oh, and also cache
 * this by writing it back to the message," because there is nothing in this file's scope capable of
 * doing that write.
 *
 * `setMesForShowdownParse()` is the one write this module makes, and it goes through an explicit
 * setter script.js exports for exactly this - it is not a chat-store write (it is markdown-parser
 * context, unrelated to any message's stored content) and does not carry the same risk.
 */

import { chat, converter, systemUserName, substituteParams, setMesForShowdownParse } from '../script.js';
import { COMMENT_NAME_DEFAULT } from './slash-commands.js';
import { getRegexedString, regex_placement } from './extensions/regex/engine.js';
import { decodeStyleTags, encodeStyleTags } from './chats.js';
import { MessageFormatter } from './message-formatter.js';
import { fixMarkdown, power_user } from './power-user.js';
import { escapeRegex, escapeHtml, canUseNegativeLookbehind } from './utils.js';
import { DOMPurify } from '../lib.js';

/**
 * Formats raw message text into an HTML string ready for DOM insertion.
 *
 * The pipeline is, in order:
 *   1. Prompt-bias stripping (message 0 only)
 *   2. Comment / hidden-message normalisation
 *   3. `beforeRegex` extension hooks (see {@link MessageFormatter})
 *   4. Custom regex rules (`getRegexedString`)
 *   5. `afterRegex` extension hooks
 *   6. Markdown auto-fix (`fixMarkdown`)
 *   7. HTML tag encoding (`encode_tags`)
 *   8. Showdown Markdown → HTML conversion
 *   9. `afterMarkdown` extension hooks
 *  10. Name-prefix stripping (`allow_name2_display`)
 *  11. DOMPurify sanitization
 *
 * All extension hooks run **before** DOMPurify (steps 3, 5, 9) so their
 * output is always sanitised.
 *
 * @param {string} mes - Raw message text.
 * @param {string} ch_name - Character name associated with the message.
 * @param {boolean} isSystem - Whether the message is a system message.
 * @param {boolean} isUser - Whether the message was sent by the user.
 * @param {number} messageId - Index of the message in the chat array, or -1
 *   for transient messages (e.g. streaming previews).
 * @param {Partial<DOMPurify.Config>} [sanitizerOverrides] - DOMPurify option
 *   overrides. Merged on top of the default config.
 * @param {boolean} [isReasoning=false] - Whether the message is reasoning/thinking
 *   output (affects regex placement and some display rules).
 * @returns {string} Sanitized HTML string ready to assign to `innerHTML`.
 */
export function messageFormatting(mes, ch_name, isSystem, isUser, messageId, sanitizerOverrides = {}, isReasoning = false) {
    if (!mes) {
        return '';
    }

    // The greeting's macros ({{user}}/{{char}}) react to persona/character name changes on every
    // render - but this module is display-only, on purpose: it has no way to reach the chat store's
    // writer at all (see this file's own header), so there is no risk of a formatting pass ever
    // persisting this substituted copy over the canonical, raw card text the way it once did. Nothing
    // is cached; a cheap string substitution is simply redone on every render.
    if (Number(messageId) === 0 && !isSystem && !isUser && !isReasoning) {
        mes = substituteParams(mes, undefined, ch_name);
    }

    setMesForShowdownParse(mes);

    // Force isSystem = false on comment messages so they get formatted properly
    if (ch_name === COMMENT_NAME_DEFAULT && isSystem && !isUser) {
        isSystem = false;
    }

    // Let hidden messages have markdown
    if (isSystem && ch_name !== systemUserName) {
        isSystem = false;
    }

    // Prompt bias replacement should be applied on the raw message
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

        // Always override the character name
        mes = getRegexedString(mes, regexPlacement, {
            characterOverride: ch_name,
            isMarkdown: true,
            depth: depth,
        });

        mes = MessageFormatter.runStage(MessageFormatter.stage.AFTER_REGEX, mes,
            { ch_name, isSystem, isUser, messageId, isReasoning },
        );
    }

    if (power_user.auto_fix_generated_markdown) {
        mes = fixMarkdown(mes, true);
    }

    if (!isSystem && power_user.encode_tags) {
        mes = canUseNegativeLookbehind()
            ? mes.replaceAll('<', '&lt;').replace(new RegExp('(?<!^|\\n\\s*)>', 'g'), '&gt;')
            : mes.replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    }

    // Make sure reasoning strings are always shown, even if they include "<" or ">"
    [power_user.reasoning.prefix, power_user.reasoning.suffix].forEach((reasoningString) => {
        if (!reasoningString || !reasoningString.trim().length) {
            return;
        }
        // Only replace the first occurrence of the reasoning string
        if (mes.includes(reasoningString)) {
            mes = mes.replace(reasoningString, escapeHtml(reasoningString));
        }
    });

    if (!isSystem) {
        // Save double quotes in tags as a special character to prevent them from being encoded
        if (!power_user.encode_tags) {
            mes = mes.replace(/<([^>]+)>/g, function (_, contents) {
                return '<' + contents.replace(/"/g, '\ufffe') + '>';
            });
        }

        mes = mes.replace(
            /<style>[\s\S]*?<\/style>|```[\s\S]*?```|~~~[\s\S]*?~~~|``[\s\S]*?``|`[\s\S]*?`|(".*?")|(\u201C.*?\u201D)|(\u00AB.*?\u00BB)|(\u300C.*?\u300D)|(\u300E.*?\u300F)|(\uFF02.*?\uFF02)/gim,
            function (match, p1, p2, p3, p4, p5, p6) {
                if (p1) {
                    // English double quotes
                    return `<q>"${p1.slice(1, -1)}"</q>`;
                } else if (p2) {
                    // Curly double quotes “ ”
                    return `<q>“${p2.slice(1, -1)}”</q>`;
                } else if (p3) {
                    // Guillemets « »
                    return `<q>«${p3.slice(1, -1)}»</q>`;
                } else if (p4) {
                    // Corner brackets 「 」
                    return `<q>「${p4.slice(1, -1)}」</q>`;
                } else if (p5) {
                    // White corner brackets 『 』
                    return `<q>『${p5.slice(1, -1)}』</q>`;
                } else if (p6) {
                    // Fullwidth quotes ＂ ＂
                    return `<q>＂${p6.slice(1, -1)}＂</q>`;
                } else {
                    // Return the original match if no quotes are found
                    return match;
                }
            },
        );

        // Restore double quotes in tags
        if (!power_user.encode_tags) {
            mes = mes.replace(/\ufffe/g, '"');
        }

        mes = mes.replaceAll('\\begin{align*}', '$$');
        mes = mes.replaceAll('\\end{align*}', '$$');
        mes = converter.makeHtml(mes);

        mes = mes.replace(/<code(.*)>[\s\S]*?<\/code>/g, function (match) {
            // Firefox creates extra newlines from <br>s in code blocks, so we replace them before converting newlines to <br>s.
            return match.replace(/\n/gm, '\u0000');
        });
        mes = mes.replace(/\u0000/g, '\n'); // Restore converted newlines
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
