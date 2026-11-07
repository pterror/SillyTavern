import { readTokenizerState } from './connection-state-header.js';
import { cardToGreetingsModel } from './greeting-list.js';
import { tokenizerAnswer, tokenizerResponseWarnings } from './tokenizer-resolve.js';
import { openTokenizer } from './endpoints/tokenizers-current.js';
import { withSafeMacrosFilled } from './endpoints/macros.js';
import { personaImagesAnswer } from './endpoints/avatars.js';
import { cardTokenTexts } from '../public/scripts/card-token-texts.js';
import { shownTextCounts } from './shown-text-counts.js';
import { settingsContextOf } from './settings-reads.js';
import { metadata_keys } from './authors-note.js';

/**
 * @typedef {object} OpenedChat
 * @property {string | null} avatar null for a group's chat
 * @property {string | null} [groupId]
 * @property {Record<string, any>} [metadata]
 * @property {string | null} at
 * @property {string} chatId
 * @property {() => Promise<Record<string, any> | null>} card
 */

/**
 * @param {import('express').Request} request
 * @param {OpenedChat} opened
 * @param {{ tokenizer?: unknown, macro_facts?: unknown }} asked
 */
async function cardTokenCounts(request, opened, asked) {
    const state = readTokenizerState(asked?.tokenizer);
    if (opened.avatar === null || !state) return null;
    const card = await opened.card();
    if (!card) return null;
    const texts = await withSafeMacrosFilled(
        request,
        { avatar_url: opened.avatar, at: opened.at, macro_facts: { ...(asked.macro_facts && typeof asked.macro_facts === 'object' ? asked.macro_facts : {}), chatId: opened.chatId } },
        cardTokenTexts(card, cardToGreetingsModel(card).greetings),
    );
    const tokenizer = await openTokenizer(state, request.user.directories);
    const counter = await tokenizer.storedCounter();
    const counts = await Promise.all(texts.map(text => (text.length === 0
        ? 0
        : state.api === 'openai' ? counter.countChatMessage([{ content: text }]) : counter.countText(text))));
    tokenizer.writeCounted().catch(error => console.error('Failed to store token counts:', error));
    const warnings = tokenizerResponseWarnings(state, tokenizer.resolved, tokenizer.outcome);
    return {
        avatar: opened.avatar,
        state: asked.tokenizer,
        counts,
        tokenizer: tokenizerAnswer(state, tokenizer.resolved, tokenizer.outcome),
        ...(warnings.length > 0 ? { warnings } : {}),
    };
}

/**
 * @param {import('express').Request} request
 * @param {OpenedChat} opened
 */
function openedShownCounts(request, opened) {
    return shownTextCounts(request.user.directories, settingsContextOf({ avatar: opened.avatar, groupId: opened.groupId }), { chatNote: String(opened.metadata?.[metadata_keys.prompt] ?? '') });
}

/** @type {Record<string, (request: import('express').Request, opened: OpenedChat, asked: any) => Promise<unknown>>} */
const PARTS = {
    card_token_counts: cardTokenCounts,
    shown_counts: openedShownCounts,
    personas: request => personaImagesAnswer(request),
};

/**
 * @param {import('express').Request} request
 * @param {OpenedChat} opened
 * @param {unknown} asked
 * @returns {Promise<Record<string, unknown>>}
 */
export async function chatOpenParts(request, opened, asked) {
    if (!asked || typeof asked !== 'object') return {};
    const names = Object.keys(asked).filter(name => Object.hasOwn(PARTS, name));
    const answers = await Promise.all(names.map(name => PARTS[name](request, opened, /** @type {any} */ (asked)[name]).catch((error) => {
        console.error(`Could not answer the opened chat's ${name}:`, error);
        return null;
    })));
    return Object.fromEntries(names.map((name, i) => [name, answers[i]]).filter(([, answer]) => answer !== null));
}
