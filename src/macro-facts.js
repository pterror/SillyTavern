/**
 * What the macros read when the server builds a prompt (src/macro-substitution.js's SubstituteParamsContext), besides
 * the names, the card and the chat each pipeline resolves itself: from the user's settings, and from the page, which
 * sends what only it knows (what is typed, what is shown, which extensions are on).
 */

import { baselineOf, metadataChanges } from '../public/scripts/state-sync.js';
import { recordStored } from './stored-messages.js';

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

/**
 * The chat's state before the prompt is built, to tell what its macros changed ({{setvar}} and its kin).
 * @param {Record<string, any>} chatMetadata
 * @returns {Map<string, string>}
 */
export function chatStateBefore(chatMetadata) {
    return baselineOf(chatMetadata);
}

/**
 * The chat variables the prompt's macros set and removed.
 * @param {Record<string, any>} chatMetadata The chat's state, as the macros left it.
 * @param {Map<string, string>} before chatStateBefore()
 * @returns {{ set: Record<string, unknown>, unset: string[] } | null} Null when they changed none.
 */
export function macroVariableChanges(chatMetadata, before) {
    const variables = metadataChanges(chatMetadata, before)?.variables;
    return variables && (Object.keys(variables.set).length || variables.unset.length) ? variables : null;
}

/**
 * Stores the chat variables a prompt's macros changed where the request's own chat metadata goes (the message the
 * send follows, applyPageWrites()), so the page and other tabs take them on as they do any change of the chat's state.
 * @param {import('express').Response} response The generate request's, whose answer tells the page.
 * @param {import('./chat-request.js').ChatContext} chat
 * @param {string|null|undefined} at The message the send follows (null: the tree's root).
 * @param {{ set: Record<string, unknown>, unset: string[] } | null} variables macroVariableChanges()
 */
export async function storeMacroVariables(response, chat, at, variables) {
    if (!variables) return;
    const actor = chat.session.actor();
    const merged = await chat.store.chats.mergeMetadata({ tree: chat.tree, at: at || null, set: {}, unset: [], variables, actor });
    if (!merged.ok) {
        console.warn('The chat variables the prompt\'s macros changed could not be stored:', merged.reason);
        return;
    }
    // The answer's `stored` reaches the page whichever way it answers; the changes stream's notice may come before
    // the page knows the messages this request stored.
    recordStored(response, { ref: 'macro-variables', node_id: at || '', state_changed: true });
}
