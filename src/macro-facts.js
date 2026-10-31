import { baselineOf, metadataChanges } from '../public/scripts/state-sync.js';
import { recordStored } from './stored-messages.js';

/**
 * @typedef {object} PageMacroFacts
 * @property {string} [chatId]
 * @property {string} [input]
 * @property {number|null} [firstDisplayedMessageId]
 * @property {boolean} [isMobile]
 * @property {number} [utcOffset]
 * @property {string} [lastGenerationType]
 * @property {{ names: string[], disabled: string[] }} [extensions]
 */

/**
 * @param {unknown} value
 * @returns {value is string[]}
 */
const isNameList = value => Array.isArray(value) && value.every(name => typeof name === 'string');

/**
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
 * @param {Record<string, any>} params.powerUser
 * @param {Record<string, any>} params.extensionSettings
 * @param {string} params.mainApi
 * @param {string} [params.type]
 * @param {string} [params.lastGenerationType]
 * @param {number} params.maxContext
 * @param {number} params.maxResponse
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
 * @typedef {{ set: Record<string, unknown>, unset: string[] }} VariableChanges
 * @typedef {{ chat: Map<string, string>, global: Map<string, string> }} VariablesBefore
 */

/**
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
 * @param {Record<string, any>} chatMetadata
 * @param {Record<string, any>} globalVariables
 * @param {VariablesBefore} before
 * @returns {{ chat: VariableChanges | null, global: VariableChanges | null }}
 */
export function macroVariableChanges(chatMetadata, globalVariables, before) {
    return {
        chat: anyChange(metadataChanges(chatMetadata, before.chat)?.variables),
        global: anyChange(metadataChanges({ variables: globalVariables }, before.global)?.variables),
    };
}

/**
 * @param {import('express').Response} response
 * @param {import('./chat-request.js').ChatContext} chat
 * @param {string|null|undefined} at
 * @param {{ chat: VariableChanges | null, global: VariableChanges | null }} changes
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
