import Handlebars from 'handlebars';
import { substituteParams } from './macro-substitution.js';
import { formatInstructModeChat, formatInstructModePrompt } from './instruct-template-format.js';

/**
 * Server-side port of three small "format one piece of the prompt as a string" pure functions
 * pulled out of public/script.js's Generate(): getBiasStrings(), formatMessageHistoryItem(), and
 * the modifyLastPromptLine() closure. Like src/authors-note.js and src/stopping-strings.js, every
 * piece of context is taken as an explicit parameter instead of read from a global or a DOM
 * textarea.
 */

// Mirrored from public/scripts/system-messages.js's system_message_types - only the one value this
// module needs. Same mirroring pattern as src/instruct-template-format.js's local copy of
// extension_prompt_types.
const system_message_types = {
    NARRATOR: 'narrator',
};

/**
 * Mirrors public/scripts/constants.js's IGNORE_SYMBOL (`Symbol.for('ignore')`), used there as a key
 * into a chat message's `.extra` object to flag "skip this message entirely".
 *
 * Judgment call: on the server, chat messages are plain JSON-shaped objects (round-tripped through
 * a DB / API boundary), not live JS objects sharing the client's module-global Symbol registry. A
 * `Symbol.for('ignore')` key would still work (Symbol.for interns by name, so it'd be *the same*
 * symbol as the client's), but a JSON-serialized message can never carry a Symbol-keyed property in
 * the first place - it would be silently dropped on serialization. So this port represents the flag
 * as a plain string key, `'ignore'`, matching the Symbol's registry name. Callers building
 * server-side message objects should set `extra.ignore = true` (not `extra[Symbol.for('ignore')]`).
 */
export const IGNORE_SYMBOL = 'ignore';

/**
 * Port of public/script.js's extractMessageBias(): pulls the contents of `{{bias "..."}}`-style
 * Handlebars helper calls out of a message, without executing anything else in the template.
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
 * @property {string} textareaText Equivalent of the client's user-input textarea value
 * @property {string} [type] Generation type (e.g. 'impersonate', 'continue', 'swipe')
 * @property {{is_user?: boolean, is_system?: boolean, extra?: {type?: string, bias?: string}}[]} [chat]
 *  Chat messages, scanned backward for a fallback bias when textareaText is empty
 * @property {string} [userPromptBias] Equivalent of power_user.user_prompt_bias
 * @property {import('./macro-substitution.js').SubstituteParamsContext} [macroContext]
 */

/**
 * @typedef {object} BiasStrings
 * @property {string} messageBias
 * @property {string} promptBias
 * @property {boolean} isUserPromptBias
 */

/**
 * Port of public/script.js's getBiasStrings(textareaText, type). One deliberate divergence from a
 * literal port: the client only ever checks `type === 'swipe'` here because by the time it calls this
 * function for a `'regenerate'` turn, its own `chat` array has ALREADY had the message being
 * regenerated spliced out (see Generate()'s own early "delete last message" branch, public/script.js -
 * everything but `type === 'swipe'` itself hits that branch). Server-side, `chat` is always resolved
 * fresh from the persisted tree (see text-completion-generation-input.js's/chat-completion-generation-
 * input.js's own `resolveChatHistory()`), which is untouched by that client-only deletion - so for a
 * server-resolved `'regenerate'` call, the message being regenerated is still really the last entry.
 * Skipping it here for `'regenerate'` too (not just `'swipe'`) is required for the two callers to reach
 * the same real bias result, not an accidental widening.
 * @param {GetBiasStringsParams} params
 * @returns {BiasStrings}
 */
export function getBiasStrings({ textareaText, type, chat = [], userPromptBias = '', macroContext = {} }) {
    if (type == 'impersonate' || type == 'continue') {
        return { messageBias: '', promptBias: '', isUserPromptBias: false };
    }

    let promptBias = '';
    let messageBias = extractMessageBias(textareaText);

    // If user input is not provided, retrieve the bias of the most recent relevant message
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

    // Substitute params for everything
    messageBias = substituteParams(messageBias, macroContext);
    promptBias = substituteParams(promptBias, macroContext);

    return { messageBias, promptBias, isUserPromptBias };
}

/**
 * @typedef {object} FormatMessageHistoryItemContext
 * @property {boolean} [isGroup] Whether this is a group chat (passed through to formatInstructModeChat)
 * @property {string} name1
 * @property {string} name2
 * @property {import('./instruct-template-format.js').InstructSettings} instructPreset
 */

/**
 * Port of public/script.js's formatMessageHistoryItem(chatItem, isInstruct, forceOutputSequence).
 *
 * Judgment call: the client's own call site is
 * `formatMessageHistoryItem(itemName, chatItem.mes, chatItem.is_user, isNarratorType, chatItem.force_avatar, name1, name2, forceOutputSequence)`
 * - 8 positional args, no `isGroup`/`instructPreset`. The already-ported `formatInstructModeChat`
 * added both as explicit params (no ambient `selected_group` or instruct-preset global to read on
 * the server), so this port's caller must supply them explicitly via the `context` object below.
 * @param {{name?: string, mes?: string, is_user?: boolean, force_avatar?: string, extra?: {type?: string, [IGNORE_SYMBOL]?: boolean}}} chatItem
 * @param {boolean} isInstruct
 * @param {boolean|number|undefined} forceOutputSequence
 * @param {FormatMessageHistoryItemContext} context
 * @returns {string}
 */
export function formatMessageHistoryItem(chatItem, isInstruct, forceOutputSequence, { isGroup = false, name1, name2, instructPreset }) {
    const isNarratorType = chatItem?.extra?.type === system_message_types.NARRATOR;
    const characterName = chatItem?.name ? chatItem.name : name2;
    const itemName = chatItem.is_user ? chatItem.name : characterName;
    const shouldPrependName = !isNarratorType;

    // If this symbol flag is set, completely ignore the message.
    // This can be used to hide messages without affecting the number of messages in the chat.
    if (chatItem.extra?.[IGNORE_SYMBOL]) {
        return '';
    }

    // Don't include a name if it's empty
    let textResult = chatItem?.name && shouldPrependName ? `${itemName}: ${chatItem.mes}\n` : `${chatItem.mes}\n`;

    if (isInstruct) {
        textResult = formatInstructModeChat(itemName, chatItem.mes, chatItem.is_user, isNarratorType, isGroup, chatItem.force_avatar, name1, name2, forceOutputSequence, instructPreset);
    }

    return textResult;
}

/**
 * @typedef {object} ModifyLastPromptLineParams All variables the client closure captured from
 *  the enclosing Generate() scope, made explicit.
 * @property {string} [quiet_prompt]
 * @property {string} name1
 * @property {string} name2
 * @property {boolean} isInstruct
 * @property {boolean} [quietToLoud]
 * @property {string} [type]
 * @property {string} [quietName]
 * @property {boolean} [isImpersonate]
 * @property {string} [promptBias]
 * @property {{is_user?: boolean}[]} chat Only `.length` and the last element's `.is_user` are read
 * @property {boolean} [force_name2]
 * @property {boolean} [isContinue]
 * @property {boolean} [isGroup] Passed through to formatInstructModeChat/formatInstructModePrompt
 * @property {import('./instruct-template-format.js').InstructSettings} instructPreset
 */

/**
 * Port of public/script.js's Generate()'s modifyLastPromptLine(lastMesString) closure, with every
 * closed-over variable made an explicit parameter.
 *
 * Judgment call: same isGroup/instructPreset adaptation as formatMessageHistoryItem() above, for
 * both formatInstructModeChat() and formatInstructModePrompt() calls in this function.
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
}) {
    //#########QUIET PROMPT STUFF PT2##############

    // Add quiet generation prompt at depth 0
    if (quiet_prompt && quiet_prompt.length) {
        // here name1 is forced for all quiet prompts..why?
        const name = name1;
        //checks if we are in instruct, if so, formats the chat as such, otherwise just adds the quiet prompt
        const quietAppend = isInstruct ? formatInstructModeChat(name, quiet_prompt, false, true, isGroup, '', name1, name2, false, instructPreset) : `\n${quiet_prompt}`;

        //This begins to fix quietPrompts (particularly /sysgen) for instruct
        //previously instruct input sequence was being appended to the last chat message w/o '\n'
        //and no output sequence was added after the input's content.
        //TODO: respect output_sequence vs last_output_sequence settings
        //TODO: decide how to prompt this to clarify who is talking 'Narrator', 'System', etc.
        if (isInstruct) {
            lastMesString += quietAppend; // + power_user.instruct.output_sequence + '\n';
        } else {
            lastMesString += quietAppend;
        }

        // Ross: bailing out early prevents quiet prompts from respecting other instruct prompt toggles
        // for sysgen, SD, and summary this is desireable as it prevents the AI from responding as char..
        // but for idle prompting, we want the flexibility of the other prompt toggles, and to respect them as per settings in the extension
        // need a detection for what the quiet prompt is being asked for...

        // Bail out early?
        if (!isInstruct && !quietToLoud) {
            return lastMesString;
        }
    }

    // Get instruct mode line
    if (isInstruct && !isContinue) {
        const name = (quiet_prompt && !quietToLoud && !isImpersonate) ? (quietName ?? 'System') : (isImpersonate ? name1 : name2);
        const isQuiet = Boolean(quiet_prompt) && type == 'quiet';
        lastMesString += formatInstructModePrompt(name, isImpersonate, promptBias, name1, name2, isQuiet, quietToLoud, isGroup, instructPreset);
    }

    // Get non-instruct impersonation line
    if (!isInstruct && isImpersonate && !isContinue) {
        const name = name1;
        if (!lastMesString.endsWith('\n')) {
            lastMesString += '\n';
        }
        lastMesString += name + ':';
    }

    // Add character's name
    // Force name append on continue (if not continuing on user message or first message)
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
