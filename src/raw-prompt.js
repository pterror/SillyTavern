import { substituteParams } from './macro-substitution.js';
import { formatInstructModeChat, formatInstructModePrompt, formatInstructModeStoryString } from './instruct-template-format.js';

/**
 * @typedef {object} RawPromptInput
 * @property {string | { role: string, content: string, name?: string }[]} prompt The text, or messages, to answer.
 * @property {string} [systemPrompt]
 * @property {string} [prefill] How the reply starts.
 * @property {boolean} [instruct] False to leave out the instruct template.
 * @property {boolean} [quietToLoud] The reply is the character's, not the system's.
 */

/**
 * @param {string} text
 * @returns {string}
 */
function novelInstruction(text) {
    const stripped = text.replace(/[[\]]/g, '').trim();
    return stripped.includes('{ ') ? stripped : `{ ${stripped} }`;
}

/**
 * The prompt for a reply to given text, not to a chat: messages for chat completion, one text otherwise.
 * @param {string} api The connection's kind (its `main_api`).
 * @param {RawPromptInput} input
 * @param {{ macroContext: import('./macro-substitution.js').SubstituteParamsContext, powerUser: Record<string, any> }} context
 * @returns {string | { role: string, content: string }[]}
 */
export function rawPrompt(api, { prompt, systemPrompt = '', prefill = '', instruct = true, quietToLoud = false }, { macroContext, powerUser }) {
    const name1 = String(macroContext.name1 ?? '');
    const name2 = String(macroContext.name2 ?? '');
    const isGroup = Boolean(macroContext.isGroup);
    const preset = powerUser.instruct ?? {};
    const isInstruct = Boolean(preset.enabled) && api !== 'openai' && api !== 'novel' && instruct;
    const substitute = (/** @type {string} */ text) => substituteParams(text ?? '', macroContext);

    const given = typeof prompt === 'string' ? [{ role: 'user', content: prompt.trim() }] : prompt;
    if (given.length === 0 && !systemPrompt) throw new Error('No messages provided');
    const filledPrefill = substitute(prefill);

    const messages = given.map((message) => {
        const name = message.role === 'user' ? (message.name ?? name1) : message.role === 'assistant' ? (message.name ?? name2) : (message.name ?? '');
        const prefix = isInstruct || api === 'openai' ? '' : (name ? `${name}: ` : '');
        const content = prefix + substitute(message.content);
        return {
            role: message.role,
            content: isInstruct
                ? formatInstructModeChat(name, content, message.role === 'user', message.role === 'system', isGroup, undefined, name1, name2, undefined, preset, macroContext)
                : content,
        };
    });

    if (systemPrompt) {
        let system = substitute(systemPrompt);
        system = isInstruct ? formatInstructModeStoryString(system, preset, { name1, name2, macroContext }) : system.trim();
        if (isInstruct && system.length > 0 && !system.endsWith('\n') && preset.wrap && !preset.story_string_suffix) system += '\n';
        messages.unshift({ role: 'system', content: system });
    }

    if (api === 'openai') {
        if (filledPrefill) messages.push({ role: 'assistant', content: filledPrefill });
        return messages;
    }

    let text = messages.map(message => message.content).join(isInstruct ? '' : '\n');
    if (api === 'novel') text = novelInstruction(text);
    return text + (isInstruct
        ? formatInstructModePrompt(name2, false, filledPrefill, name1, name2, true, quietToLoud, isGroup, preset, macroContext)
        : `\n${filledPrefill}`);
}
