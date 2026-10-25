/**
 * What the macros read when the server builds a prompt (src/macro-substitution.js's SubstituteParamsContext), besides
 * the names, the card and the chat each pipeline resolves itself: from the user's settings, and from the page, which
 * sends what only it knows (what is typed, what is shown, which extensions are on).
 */

/**
 * @typedef {object} PageMacroFacts What only the page knows, sent with a generation (`macro_facts`).
 * @property {string} [chatId] The chat's id as the page has it, for {{pick}}'s seed.
 * @property {string} [input] What is typed in the message box.
 * @property {number|null} [firstDisplayedMessageId] The first message shown.
 * @property {boolean} [isMobile]
 * @property {{ names: string[], disabled: string[] }} [extensions] The extensions there are, and those turned off.
 */

/** @param {unknown} value @returns {value is string[]} */
const isNameList = value => Array.isArray(value) && value.every(name => typeof name === 'string');

/**
 * Reads what the page sent, keeping only what has the right shape.
 * @param {unknown} body
 * @returns {PageMacroFacts}
 */
export function readPageMacroFacts(body) {
    if (!body || typeof body !== 'object') return {};
    const facts = /** @type {Record<string, any>} */ (body);
    return {
        ...(typeof facts.chatId === 'string' ? { chatId: facts.chatId } : {}),
        ...(typeof facts.input === 'string' ? { input: facts.input } : {}),
        ...(typeof facts.firstDisplayedMessageId === 'number' ? { firstDisplayedMessageId: facts.firstDisplayedMessageId } : {}),
        ...(typeof facts.isMobile === 'boolean' ? { isMobile: facts.isMobile } : {}),
        ...(isNameList(facts.extensions?.names) && isNameList(facts.extensions?.disabled) ? { extensions: { names: facts.extensions.names, disabled: facts.extensions.disabled } } : {}),
    };
}

/**
 * @param {object} params
 * @param {Record<string, any>} params.powerUser The user's power_user settings.
 * @param {Record<string, any>} params.extensionSettings The user's extension_settings (the global variables).
 * @param {string} params.mainApi
 * @param {string} [params.type] The generation's type.
 * @param {number} params.maxContext The context size.
 * @param {number} params.maxResponse The reply length.
 * @param {PageMacroFacts} [params.pageFacts]
 * @returns {import('./macro-substitution.js').SubstituteParamsContext}
 */
export function generationMacroFacts({ powerUser, extensionSettings, mainApi, type, maxContext, maxResponse, pageFacts = {} }) {
    extensionSettings.variables ??= {};
    extensionSettings.variables.global ??= {};
    return {
        globalVariables: extensionSettings.variables.global,
        chatId: pageFacts.chatId,
        mainApi,
        maxContextTokens: maxContext,
        maxResponseTokens: maxResponse,
        maxPromptTokens: maxContext - maxResponse,
        // The page's GENERATION_STARTED: this generation's own type.
        lastGenerationType: type || 'normal',
        instruct: powerUser.instruct,
        sysprompt: powerUser.sysprompt,
        contextTemplate: powerUser.context,
        preferCharacterPrompt: !!powerUser.prefer_character_prompt,
        currentInput: pageFacts.input,
        firstDisplayedMessageId: pageFacts.firstDisplayedMessageId,
        isMobile: pageFacts.isMobile,
        extensions: pageFacts.extensions,
    };
}
