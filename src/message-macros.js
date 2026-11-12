import { macrosIn, mentionAboutMacro } from '../public/scripts/safe-macros.js';
import { chatContext } from './chat-request.js';
import { pageFactsOf } from './macro-facts.js';

/**
 * A message's macros, filled in for the page, travel with the message: `extra.macro_values`, each macro's source to
 * its value, or null for one only known when sent. It is derived, never stored.
 */
export const MACRO_VALUES = 'macro_values';

/**
 * @typedef {object} MacroOwner
 * @property {string | null} avatar
 * @property {string | null} groupId
 * @property {import('./chat-request.js').ChatContext | null} [chat] the chat the messages are in, for macros that read it
 * @property {string | null} [at] the message the chat is read up to; its end when none
 * @property {unknown} [pageFacts] what the page knows that macros read (its time zone, the chat box)
 */

/**
 * A text the page draws and the speaker its macros are filled in for: null for the user
 * @typedef {{ holder: Record<string, any>, texts: string[], speaker: string | null }} Shown
 */

/**
 * @param {Record<string, any>} message
 * @returns {string | null}
 */
const speakerOf = message => (message.is_user ? null : String(message.name ?? ''));

/**
 * @param {unknown} extra
 * @returns {Record<string, any>}
 */
const extraOf = extra => (extra && typeof extra === 'object' && !Array.isArray(extra) ? /** @type {Record<string, any>} */ (extra) : {});

/**
 * @param {Record<string, any>} extra
 * @returns {string[]} the texts besides the message's own that the page draws: its reasoning and its bias
 */
const drawnExtras = extra => [extra.reasoning, extra.bias].filter(text => typeof text === 'string' && text !== '');

/**
 * Each text the page draws of the messages, their alternatives and the openings it is sent
 * @param {import('./message-counts.js').CountSources} sources
 * @returns {Shown[]}
 */
function shownOf({ messages = [], alternatives = [] }) {
    /** @type {Shown[]} */
    const shown = [];
    for (const message of messages) {
        if (!message || typeof message !== 'object') continue;
        shown.push({ holder: message, texts: [String(message.mes ?? ''), ...drawnExtras(extraOf(message.extra))], speaker: speakerOf(message) });
        if (!Array.isArray(message.swipes) || !Array.isArray(message.swipe_info)) continue;
        message.swipe_info.forEach((/** @type {any} */ info, /** @type {number} */ k) => {
            const text = message.swipes[k];
            if (!info || typeof info !== 'object' || typeof text !== 'string') return;
            shown.push({ holder: info, texts: [text, ...drawnExtras(extraOf(info.extra))], speaker: speakerOf({ ...message, ...info }) });
        });
    }
    for (const alternative of alternatives) {
        if (!alternative || typeof alternative !== 'object') continue;
        shown.push({ holder: alternative, texts: [String(alternative.mes ?? ''), ...drawnExtras(extraOf(alternative.extra))], speaker: speakerOf(alternative) });
    }
    return shown;
}

/** `{{input}}`: the chat box's text, which only the action that sends it carries, so it is only known when sent */
const INPUT = /^\{\{\s*input\s*\}\}$/i;

/**
 * @param {string[]} sources
 * @returns {string[]} the macros, and for each one naming a person the macro their card's text comes from
 */
function withMentionAbouts(sources) {
    const about = sources.map(source => mentionAboutMacro(/^\{\{\s*([^\s:{}]+)\s*\}\}$/.exec(source)?.[1] ?? '')).filter(Boolean);
    return [...new Set([...sources, ...about])];
}

/**
 * The values of the macros in texts, filled in once for each speaker
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {MacroOwner} owner
 * @param {{ texts: string[], speaker: string | null }[]} wanted
 * @returns {Promise<Record<string, string | null>[]>} each text group's macros and their values, in order
 */
export async function macroValuesOf(directories, owner, wanted) {
    const sources = wanted.map(({ texts }) => withMentionAbouts(texts.flatMap(text => macrosIn(text))));
    /** @type {Map<string | null, Set<string>>} */
    const bySpeaker = new Map();
    wanted.forEach(({ speaker }, i) => {
        if (!sources[i].length) return;
        const set = bySpeaker.get(speaker) ?? new Set();
        for (const source of sources[i]) set.add(source);
        bySpeaker.set(speaker, set);
    });
    /** @type {Map<string | null, Map<string, string | null>>} */
    const values = new Map();
    for (const [speaker, set] of bySpeaker) {
        const list = [...set];
        const { macroValuesIn } = await import('./endpoints/macros.js');
        const filled = await macroValuesIn(directories, { ...owner, name2: speaker }, list);
        values.set(speaker, new Map(list.map((source, i) => [source, filled[i]])));
    }
    return wanted.map(({ speaker }, i) => Object.fromEntries(sources[i].map(source => [source, INPUT.test(source) ? null : values.get(speaker)?.get(source) ?? null])));
}

/**
 * Puts the values of the macros each sent message, alternative and opening draws into it, for the page
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {MacroOwner} owner
 * @param {import('./message-counts.js').CountSources} sources
 * @returns {Promise<void>}
 */
export async function fillSentMacros(directories, owner, sources) {
    const shown = shownOf(sources).filter(each => each.texts.some(text => macrosIn(text).length > 0));
    for (const each of shownOf(sources)) {
        if (!shown.includes(each) && each.holder.extra && MACRO_VALUES in each.holder.extra) {
            each.holder.extra = { ...each.holder.extra };
            delete each.holder.extra[MACRO_VALUES];
        }
    }
    if (!shown.length) return;
    const filled = await macroValuesOf(directories, owner, shown);
    shown.forEach((each, i) => {
        each.holder.extra = { ...extraOf(each.holder.extra), [MACRO_VALUES]: filled[i] };
    });
}

/**
 * The values of the macros the page shows, as it lists them, for an answer to an action that may have changed them
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {MacroOwner} owner
 * @param {unknown} shown the page's list: `[{ node, speaker, sources }]`
 * @returns {Promise<Record<string, Record<string, string | null>> | undefined>} by node
 */
export async function shownMacroValues(directories, owner, shown) {
    if (!Array.isArray(shown)) return undefined;
    const wanted = shown.filter(each => typeof each?.node === 'string' && Array.isArray(each.sources)).slice(0, 1000).map(each => ({
        node: String(each.node),
        speaker: typeof each.speaker === 'string' ? each.speaker : null,
        texts: each.sources.filter((/** @type {unknown} */ source) => typeof source === 'string').slice(0, 1000),
    }));
    if (!wanted.length) return undefined;
    const filled = await macroValuesOf(directories, owner, wanted);
    return Object.fromEntries(wanted.map((each, i) => [each.node, filled[i]]));
}

/**
 * The owner a chat's sent messages fill their macros in for, read up to the last of them
 * @param {import('express').Request} request
 * @param {import('./chat-request.js').ChatContext} chat
 * @param {Record<string, any>[]} [messages]
 * @returns {MacroOwner}
 */
export function chatMacroOwner(request, chat, messages = []) {
    const last = messages.at(-1)?.node_id;
    return { avatar: chat.avatar, groupId: chat.groupId, chat, at: typeof last === 'string' ? last : null, pageFacts: pageFactsOf(request) };
}

/**
 * The values of the macros stored messages draw, for the answer to an action that wrote them
 * @param {import('express').Request} request
 * @param {import('./chat-request.js').ChatContext} chat
 * @param {unknown[]} nodeIds
 * @returns {Promise<Record<string, Record<string, string | null>> | undefined>} by node, only those with macros
 */
export async function storedMessageMacros(request, chat, nodeIds) {
    const ids = [...new Set(nodeIds.filter(id => typeof id === 'string' && id !== ''))].map(String);
    const shown = await Promise.all(ids.map(id => chat.store.chats.shownMessage(chat.tree, id)));
    const wanted = shown.flatMap((message, i) => (message ? [{ node: ids[i], texts: [String(message.mes ?? ''), ...drawnExtras(extraOf(message.extra))], speaker: speakerOf(message) }] : []))
        .filter(each => each.texts.some(text => macrosIn(text).length > 0));
    if (!wanted.length) return undefined;
    const filled = await macroValuesOf(request.user.directories, chatMacroOwner(request, chat), wanted);
    return Object.fromEntries(wanted.map((each, i) => [each.node, filled[i]]));
}

/**
 * The answer's part for an action that may have changed the values of the macros the page shows: their values now
 * @param {import('express').Request} request
 * @param {unknown} shown the macros the page shows, as `shownMessageMacros` lists them (page)
 * @returns {Promise<{ message_macros?: Record<string, Record<string, string | null>> }>}
 */
export async function shownMacrosAnswer(request, shown) {
    if (!shown || typeof shown !== 'object') return {};
    const { avatar_url: avatarUrl, group_id: groupIdOf, at, items } = /** @type {Record<string, unknown>} */ (shown);
    const avatar = typeof avatarUrl === 'string' && avatarUrl !== '' ? avatarUrl : null;
    const groupId = typeof groupIdOf === 'string' && groupIdOf !== '' ? groupIdOf : null;
    if (avatar === null && groupId === null) return {};
    try {
        const chat = await chatContext(request, { avatar, group: groupId });
        const values = await shownMacroValues(request.user.directories, { avatar, groupId, chat, at: typeof at === 'string' && at !== '' ? at : null, pageFacts: pageFactsOf(request) }, items);
        return values ? { message_macros: values } : {};
    } catch (error) {
        console.warn('Could not fill in the macros the page shows:', error);
        return {};
    }
}
