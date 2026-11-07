import { renderCountBasis, showTokenizerWarnings } from './tokenizer-notices.js';
import { askOnChatOpen, chatOpenPart } from './chat-open-parts.js';

/**
 * @typedef {object} ShownTextCounts
 * @property {number} [persona]
 * @property {number} [note_default]
 * @property {number|null} [note_chara]
 * @property {number} [chat_note]
 * @property {object|null} [tokenizer]
 * @property {object[]} [warnings]
 */

const COUNTERS = Object.freeze({
    persona: '#persona_description_token_count',
    note_default: '#extension_floating_default_token_counter',
    note_chara: '#extension_floating_chara_token_counter',
    chat_note: '#extension_floating_prompt_token_counter',
});

askOnChatOpen('shown_counts', () => ({}));

/**
 * Shows the counts the server answered an action with, beside the texts they count.
 * @param {ShownTextCounts|null|undefined} counts
 */
export function takeShownCounts(counts) {
    if (!counts || typeof counts !== 'object') return;
    for (const [key, selector] of Object.entries(COUNTERS)) {
        if (!Object.hasOwn(counts, key)) continue;
        const count = /** @type {Record<string, unknown>} */ (counts)[key];
        $(selector).text(String(typeof count === 'number' ? count : 0));
        renderCountBasis($(selector), /** @type {any} */ (counts.tokenizer ?? null));
    }
    if (Array.isArray(counts.warnings)) showTokenizerWarnings(counts.warnings);
}

/**
 * Shows the counts the chat was opened with.
 * @param {string|undefined} chatId
 */
export function takeOpenedShownCounts(chatId) {
    takeShownCounts(chatOpenPart('shown_counts', chatId));
}
