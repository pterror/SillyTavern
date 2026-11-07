import { cardTokenCounts } from './card-token-counts.js';
import { personaImagesAnswer } from './endpoints/avatars.js';
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
 * @param {{ macro_facts?: unknown }} asked
 */
async function openedCardCounts(request, opened, asked) {
    if (opened.avatar === null) return null;
    const card = await opened.card();
    if (!card) return null;
    return cardTokenCounts(request, { avatar: opened.avatar, card, at: opened.at, chatId: opened.chatId, macroFacts: asked?.macro_facts });
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
    card_token_counts: openedCardCounts,
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
