import { cardToGreetingsModel } from './greeting-list.js';
import { withSafeMacrosFilled } from './endpoints/macros.js';
import { countWithConnection } from './connection-counts.js';
import { settingsContextOf } from './settings-reads.js';
import { cardTokenTexts } from '../public/scripts/card-token-texts.js';

/**
 * A card's texts as the character editor counts them, with their safe macros filled, counted as the chosen connection
 * counts them.
 * @param {import('express').Request} request
 * @param {object} scope
 * @param {string} scope.avatar
 * @param {Record<string, any>} scope.card
 * @param {string|null} [scope.at] The node of the chat the macros are filled at.
 * @param {string} [scope.chatId]
 * @param {unknown} [scope.macroFacts] What the page holds that the macros read.
 * @returns {Promise<{ avatar: string, counts: number[], tokenizer: object|null, warnings?: object[] }|null>}
 */
export async function cardTokenCounts(request, { avatar, card, at = null, chatId, macroFacts }) {
    const facts = macroFacts && typeof macroFacts === 'object' ? macroFacts : {};
    const rawTexts = cardTokenTexts(card, cardToGreetingsModel(card).greetings);
    const filled = await withSafeMacrosFilled(request, { avatar_url: avatar, at, macro_facts: { ...facts, ...(chatId ? { chatId } : {}) } }, rawTexts);
    const counted = await countWithConnection(request.user.directories, settingsContextOf({ avatar }), filled);
    if (!counted) return null;
    return { avatar, counts: counted.counts, tokenizer: counted.tokenizer, ...(counted.warnings ? { warnings: counted.warnings } : {}) };
}
