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
 * @property {number} [utcOffset] The user's offset from UTC in minutes.
 * @property {string} [lastGenerationType] The type of the generation the page last started ('' for none).
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
        ...(typeof facts.lastGenerationType === 'string' ? { lastGenerationType: facts.lastGenerationType } : {}),
        ...(Number.isFinite(facts.utcOffset) && Math.abs(facts.utcOffset) <= 16 * 60 ? { utcOffset: facts.utcOffset } : {}),
        ...(isNameList(facts.extensions?.names) && isNameList(facts.extensions?.disabled) ? { extensions: { names: facts.extensions.names, disabled: facts.extensions.disabled } } : {}),
    };
}

/**
 * @param {object} params
 * @param {Record<string, any>} params.powerUser The user's power_user settings.
 * @param {Record<string, any>} params.extensionSettings The user's extension_settings (the global variables).
 * @param {string} params.mainApi
 * @param {string} [params.type] The generation's type.
 * @param {string} [params.lastGenerationType] {{lastGenerationType}}, for macros filled in outside a generation;
 * a generation's is its own type.
 * @param {number} params.maxContext The context size.
 * @param {number} params.maxResponse The reply length.
 * @param {PageMacroFacts} [params.pageFacts]
 * @returns {import('./macro-substitution.js').SubstituteParamsContext}
 */
export function generationMacroFacts({ powerUser, extensionSettings, mainApi, type, lastGenerationType, maxContext, maxResponse, pageFacts = {} }) {
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
        lastGenerationType: lastGenerationType ?? (type || 'normal'),
        instruct: powerUser.instruct,
        sysprompt: powerUser.sysprompt,
        contextTemplate: powerUser.context,
        preferCharacterPrompt: !!powerUser.prefer_character_prompt,
        currentInput: pageFacts.input,
        firstDisplayedMessageId: pageFacts.firstDisplayedMessageId,
        isMobile: pageFacts.isMobile,
        utcOffset: pageFacts.utcOffset,
        extensions: pageFacts.extensions,
    };
}

/**
 * The context size and the reply length the macros give ({{maxContext}}, {{maxResponse}}), as the page reads them for
 * the API it generates with.
 * @param {{ max_context?: number, amount_gen?: number, oai_settings?: Record<string, any> }} settings
 * @param {string} mainApi
 * @returns {{ maxContext: number, maxResponse: number }}
 */
export function apiTokenLimits({ max_context, amount_gen, oai_settings }, mainApi) {
    return mainApi === 'openai'
        ? { maxContext: oai_settings?.openai_max_context ?? 4095, maxResponse: oai_settings?.openai_max_tokens ?? 300 }
        : { maxContext: max_context ?? 8192, maxResponse: amount_gen ?? 0 };
}

/**
 * @typedef {{ set: Record<string, unknown>, unset: string[] }} VariableChanges Variables set and removed by name.
 * @typedef {{ chat: Map<string, string>, global: Map<string, string> }} VariablesBefore
 */

/**
 * The chat's state and the global variables before the prompt is built, to tell what its macros changed
 * ({{setvar}}, {{setglobalvar}} and their kin).
 * @param {Record<string, any>} chatMetadata
 * @param {Record<string, any>} globalVariables
 * @returns {VariablesBefore}
 */
export function variablesBefore(chatMetadata, globalVariables) {
    return { chat: baselineOf(chatMetadata), global: baselineOf({ variables: globalVariables }) };
}

/** @param {VariableChanges | undefined} changes */
const anyChange = changes => (changes && (Object.keys(changes.set).length || changes.unset.length) ? changes : null);

/**
 * The chat variables and the global ones the prompt's macros set and removed.
 * @param {Record<string, any>} chatMetadata The chat's state, as the macros left it.
 * @param {Record<string, any>} globalVariables The global variables, as the macros left them.
 * @param {VariablesBefore} before variablesBefore()
 * @returns {{ chat: VariableChanges | null, global: VariableChanges | null }}
 */
export function macroVariableChanges(chatMetadata, globalVariables, before) {
    return {
        chat: anyChange(metadataChanges(chatMetadata, before.chat)?.variables),
        global: anyChange(metadataChanges({ variables: globalVariables }, before.global)?.variables),
    };
}

/**
 * Keeps the variables a prompt's macros changed. The chat's are stored where the request's own chat metadata goes
 * (the message the send follows, applyPageWrites()); the global ones are the page's to save, with its settings. The
 * answer's `stored` list says so: it reaches the page whichever way it answers, and the changes stream's notice of
 * the chat's state may come before the page knows the messages this request stored.
 * @param {import('express').Response} response The generate request's, whose answer tells the page.
 * @param {import('./chat-request.js').ChatContext} chat
 * @param {string|null|undefined} at The message the send follows (null: the tree's root).
 * @param {{ chat: VariableChanges | null, global: VariableChanges | null }} changes macroVariableChanges()
 */
export async function storeMacroVariables(response, chat, at, { chat: chatVariables, global }) {
    if (global) recordStored(response, { ref: 'macro-global-variables', node_id: '', global_variables: global });
    if (!chatVariables) return;
    const actor = chat.session.actor();
    const merged = await chat.store.chats.mergeMetadata({ tree: chat.tree, at: at || null, set: {}, unset: [], variables: chatVariables, actor });
    if (!merged.ok) {
        console.warn('The chat variables the prompt\'s macros changed could not be stored:', merged.reason);
        return;
    }
    recordStored(response, { ref: 'macro-variables', node_id: at || '', state_changed: true });
}
