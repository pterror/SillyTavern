import { macrosIn, mentionAboutMacro } from '../public/scripts/safe-macros.js';
import { chatContext } from './chat-request.js';
import { pageFactsOf } from './macro-facts.js';

/**
 * The values of the macros of texts the page draws, as an answer carries them: by the speaker the texts are from, each
 * macro's source to its value, null for one only known when sent. They are the scope's (the chat or card the answer is
 * about and the speaker), not any one text's, and derived, never stored.
 * @typedef {{ speaker: string | null, values: Record<string, string | null> }} ScopeValues
 */

/**
 * @typedef {object} MacroOwner
 * @property {string | null} avatar
 * @property {string | null} groupId
 * @property {import('./chat-request.js').ChatContext | null} [chat] the chat the messages are in, for macros that read it
 * @property {string | null} [at] the message the chat is read up to; its end when none
 * @property {unknown} [pageFacts] what the page knows that macros read (its time zone, the chat box)
 */

/**
 * Texts the page draws and the speaker their macros are filled in for: null for the user
 * @typedef {{ texts: string[], speaker: string | null }} Shown
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
        shown.push({ texts: [String(message.mes ?? ''), ...drawnExtras(extraOf(message.extra))], speaker: speakerOf(message) });
        if (!Array.isArray(message.swipes) || !Array.isArray(message.swipe_info)) continue;
        message.swipe_info.forEach((/** @type {any} */ info, /** @type {number} */ k) => {
            const text = message.swipes[k];
            if (!info || typeof info !== 'object' || typeof text !== 'string') return;
            shown.push({ texts: [text, ...drawnExtras(extraOf(info.extra))], speaker: speakerOf({ ...message, ...info }) });
        });
    }
    for (const alternative of alternatives) {
        if (!alternative || typeof alternative !== 'object') continue;
        shown.push({ texts: [String(alternative.mes ?? ''), ...drawnExtras(extraOf(alternative.extra))], speaker: speakerOf(alternative) });
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
 * @returns {Promise<ScopeValues[]>} for each speaker with macros in its texts
 */
export async function scopeMacroValues(directories, owner, wanted) {
    /** @type {Map<string | null, Set<string>>} */
    const bySpeaker = new Map();
    for (const { texts, speaker } of wanted) {
        const sources = texts.flatMap(text => macrosIn(text));
        if (!sources.length) continue;
        const set = bySpeaker.get(speaker) ?? new Set();
        for (const source of withMentionAbouts(sources)) set.add(source);
        bySpeaker.set(speaker, set);
    }
    if (!bySpeaker.size) return [];
    const { macroValuesIn } = await import('./endpoints/macros.js');
    /** @type {ScopeValues[]} */
    const answered = [];
    for (const [speaker, set] of bySpeaker) {
        const list = [...set];
        const filled = await macroValuesIn(directories, { ...owner, name2: speaker }, list);
        answered.push({ speaker, values: Object.fromEntries(list.map((source, i) => [source, INPUT.test(source) ? null : filled[i] ?? null])) });
    }
    return answered;
}

/**
 * The values of the macros each sent message, alternative and opening draws
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {MacroOwner} owner
 * @param {import('./message-counts.js').CountSources} sources
 * @returns {Promise<ScopeValues[] | undefined>} none when they draw none
 */
export async function sentMacroValues(directories, owner, sources) {
    const answered = await scopeMacroValues(directories, owner, shownOf(sources));
    return answered.length ? answered : undefined;
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
 * @returns {Promise<ScopeValues[] | undefined>} none when they draw none
 */
export async function storedMessageMacros(request, chat, nodeIds) {
    const ids = [...new Set(nodeIds.filter(id => typeof id === 'string' && id !== ''))].map(String);
    const shown = await Promise.all(ids.map(id => chat.store.chats.shownMessage(chat.tree, id)));
    const messages = shown.filter(message => message !== null && message !== undefined);
    return sentMacroValues(request.user.directories, chatMacroOwner(request, chat), { messages });
}

/**
 * The values of the macros a text in the chat box draws: as the person's message after where the chat ends
 * @param {import('express').Request} request
 * @param {import('./chat-request.js').ChatContext} chat
 * @param {string[]} sources the macros, as written
 * @returns {Promise<Record<string, string | null>>}
 */
async function boxMacroValues(request, chat, sources) {
    const [answered] = await scopeMacroValues(request.user.directories, chatMacroOwner(request, chat), [{ texts: sources, speaker: null }]);
    return answered?.values ?? {};
}

/**
 * The draft of where an answer leaves the chat ending, with the values of the macros it draws (`macro_values`)
 * @param {import('express').Request} request
 * @param {import('./chat-request.js').ChatContext} chat
 * @param {import('./chat-drafts.js').DraftAnswer | undefined} draft
 * @returns {Promise<import('./chat-drafts.js').DraftAnswer | undefined>}
 */
export async function draftWithMacros(request, chat, draft) {
    const sources = draft ? macrosIn(draft.text) : [];
    if (!draft || !sources.length) return draft;
    return { ...draft, macro_values: await boxMacroValues(request, chat, sources) };
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
const named = value => (typeof value === 'string' && value !== '' ? value : null);

/**
 * The answer's part for an action that may have changed the values of every macro the page holds: their values now, by
 * the scope the page listed each in
 * @param {import('express').Request} request
 * @param {unknown} shown the macros the page holds, as `shownMessageMacros` lists them (page): the open chat
 *   (`avatar_url` or `group_id`) with where it is read up to (`at`), and `scopes`: `[{ avatar_url?, group_id?, speaker,
 *   sources }]`
 * @returns {Promise<{ macro_values?: (ScopeValues & { avatar_url?: string, group_id?: string })[] }>}
 */
export async function shownMacrosAnswer(request, shown) {
    if (!shown || typeof shown !== 'object') return {};
    const { avatar_url: openAvatar, group_id: openGroup, at, scopes } = /** @type {Record<string, unknown>} */ (shown);
    if (!Array.isArray(scopes)) return {};
    /** @type {Map<string, { avatar: string | null, groupId: string | null, wanted: { texts: string[], speaker: string | null }[] }>} */
    const byOwner = new Map();
    for (const each of scopes.slice(0, 1000)) {
        if (!each || typeof each !== 'object' || !Array.isArray(each.sources)) continue;
        const avatar = named(each.avatar_url);
        const groupId = named(each.group_id);
        const key = JSON.stringify([avatar, groupId]);
        const owner = byOwner.get(key) ?? { avatar, groupId, wanted: [] };
        owner.wanted.push({ speaker: typeof each.speaker === 'string' ? each.speaker : null, texts: each.sources.filter((/** @type {unknown} */ source) => typeof source === 'string').slice(0, 1000) });
        byOwner.set(key, owner);
    }
    try {
        /** @type {(ScopeValues & { avatar_url?: string, group_id?: string })[]} */
        const answered = [];
        for (const { avatar, groupId, wanted } of byOwner.values()) {
            const chat = avatar !== null || groupId !== null ? await chatContext(request, { avatar, group: groupId }) : null;
            const isOpen = avatar === named(openAvatar) && groupId === named(openGroup);
            const owner = { avatar, groupId, chat, at: isOpen && typeof at === 'string' && at !== '' ? at : null, pageFacts: pageFactsOf(request) };
            for (const each of await scopeMacroValues(request.user.directories, owner, wanted)) {
                answered.push({ ...(avatar ? { avatar_url: avatar } : {}), ...(groupId ? { group_id: groupId } : {}), ...each });
            }
        }
        return { macro_values: answered };
    } catch (error) {
        console.warn('Could not fill in the macros the page shows:', error);
        return {};
    }
}
