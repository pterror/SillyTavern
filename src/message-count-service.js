import { getStringHash } from '../public/scripts/hash-utils.js';
import { readSettingsFor, settingsContextOf } from './settings-reads.js';
import { tokenizerStateFor } from './connection-counts.js';
import { openTokenizer } from './endpoints/tokenizers-current.js';
import { tokenizerAnswer } from './tokenizer-resolve.js';
import { openingState } from './opening-state.js';
import { extraOf, openingAlternatives, targetsOf } from './message-counts.js';
import { requestStore } from './user-stores.js';
import { chatContext } from './chat-request.js';

export const COUNTING_AT_ONCE = 4;
const PUSH_EVERY_MS = 100;
export const MESSAGE_COUNTS_EVENT = 'message-counts';

/**
 * @typedef {object} Counting
 * @property {string} key which tokenizer counts: its identity when it has one
 * @property {(text: string) => Promise<number | null>} stored
 * @property {(text: string) => Promise<number | null>} count
 * @property {() => Promise<void>} write
 */

/** @typedef {{ count: number, hash: number, key: string } | { waiting: string }} CountRecord */
/** @typedef {{ node_id: string, hash: number, key: string, count: number }} PushedCount */
/** @typedef {{ avatar?: string | null, groupId?: string | null }} Owner */

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {import('./settings-reads.js').SettingsContext} settingsContext
 */
export function messageCountsShown(directories, settingsContext) {
    try {
        return readSettingsFor(directories, settingsContext, ['power_user']).power_user?.message_token_count_enabled === true;
    } catch (error) {
        console.warn('Could not read whether message counts are shown:', error);
        return false;
    }
}

/**
 * @param {import('./token-count-store.js').StoredCounter} counter
 * @param {string} api
 * @param {string} key
 * @param {() => Promise<void>} write
 * @returns {Counting}
 */
export function countingWith(counter, api, key, write) {
    const asMessage = (/** @type {string} */ text) => [{ content: text }];
    return {
        key,
        stored: async text => (text.length === 0 ? 0 : api === 'openai' ? counter.storedChatMessage(asMessage(text)) : counter.storedText(text)),
        count: async text => (text.length === 0 ? 0 : api === 'openai' ? counter.countChatMessage(asMessage(text)) : counter.countText(text)),
        write,
    };
}

/**
 * @param {import('./tokenizer-resolve.js').TokenizerState} state
 * @param {{ resolved: import('./tokenizer-resolve.js').ResolvedTokenizer, outcome: import('./tokenizer-resolve.js').TokenizerOutcome, identity: () => Promise<string | null> }} opened
 */
export async function countingKey(state, opened) {
    return (await opened.identity()) ?? tokenizerAnswer(state, opened.resolved, opened.outcome).key;
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {import('./settings-reads.js').SettingsContext} settingsContext
 * @returns {Promise<Counting | null>}
 */
async function openCounting(directories, settingsContext) {
    let state;
    try {
        state = tokenizerStateFor(directories, settingsContext);
    } catch (error) {
        console.warn('No connection to count with:', error?.message ?? error);
        return null;
    }
    if (!state) return null;
    const opened = await openTokenizer(state, directories);
    return countingWith(await opened.storedCounter(), state.api, await countingKey(state, opened), opened.writeCounted);
}

/**
 * @typedef {object} CountJob
 * @property {import('./user-stores.js').UserStore} store
 * @property {Counting} counting
 * @property {{ node_id: string, text: string, hash: number }[]} items
 * @property {number} next
 * @property {number} left
 * @property {PushedCount[]} counted
 * @property {ReturnType<typeof setTimeout> | null} timer
 */

/** @type {CountJob[]} */
const jobs = [];
let running = 0;
/** @type {Map<string, Promise<number | null>>} */
const inFlight = new Map();

/**
 * @param {Counting} counting
 * @param {string} text
 */
function countOnce(counting, text) {
    const key = `${counting.key}\n${text}`;
    let counted = inFlight.get(key);
    if (!counted) {
        counted = counting.count(text).finally(() => inFlight.delete(key));
        inFlight.set(key, counted);
    }
    return counted;
}

/**
 * @param {CountJob} job
 */
function pushCounted(job) {
    if (job.timer) clearTimeout(job.timer);
    job.timer = null;
    if (!job.counted.length) return;
    job.store.events.emit(MESSAGE_COUNTS_EVENT, job.counted.splice(0));
}

/**
 * @param {CountJob} job
 * @param {{ node_id: string, text: string, hash: number }} item
 */
async function countItem(job, item) {
    try {
        const count = await countOnce(job.counting, item.text);
        if (typeof count === 'number') {
            job.counted.push({ node_id: item.node_id, hash: item.hash, key: job.counting.key, count });
            job.timer ??= setTimeout(() => pushCounted(job), PUSH_EVERY_MS);
        }
    } catch (error) {
        console.warn('Could not count a message:', error);
    } finally {
        job.left--;
        if (job.left === 0) {
            pushCounted(job);
            jobs.splice(jobs.indexOf(job), 1);
            job.counting.write().catch(error => console.error('Failed to store token counts:', error));
        }
    }
}

function countNext() {
    while (running < COUNTING_AT_ONCE) {
        const job = jobs.findLast(j => j.next < j.items.length);
        if (!job) return;
        const item = job.items[job.next++];
        running++;
        void countItem(job, item).finally(() => {
            running--;
            countNext();
        });
    }
}

/**
 * @param {import('./user-stores.js').UserStore} store
 * @param {Counting} counting
 * @param {{ node_id: string, text: string, hash: number }[]} items
 */
function countLater(store, counting, items) {
    jobs.push({ store, counting, items, next: 0, left: items.length, counted: [], timer: null });
    countNext();
}

/**
 * @param {import('./user-stores.js').UserStore} store
 * @param {Counting} counting
 * @param {import('./message-counts.js').CountSources} sources
 * @param {{ pushStored?: boolean }} [options] pushStored: also push the stored counts, for an answer already sent
 * @returns {Promise<Record<string, CountRecord>>}
 */
export async function countForPage(store, counting, sources, { pushStored = false } = {}) {
    const targets = targetsOf(sources);
    const found = await Promise.all(targets.map(target => counting.stored(target.text).catch(() => null)));
    /** @type {Record<string, CountRecord>} */
    const records = {};
    const misses = [];
    /** @type {PushedCount[]} */
    const hits = [];
    targets.forEach((target, i) => {
        const hash = getStringHash(target.text);
        const extra = { ...extraOf(target.holder.extra) };
        delete extra.token_count;
        delete extra.token_count_hash;
        delete extra.token_count_key;
        delete extra.token_count_waiting;
        const count = found[i];
        if (typeof count === 'number') {
            Object.assign(extra, { token_count: count, token_count_hash: hash, token_count_key: counting.key });
            if (target.key !== null) {
                records[target.key] = { count, hash, key: counting.key };
                hits.push({ node_id: target.key, hash, key: counting.key, count });
            }
        } else {
            extra.token_count_waiting = counting.key;
            if (target.key !== null) {
                records[target.key] = { waiting: counting.key };
                misses.push({ node_id: target.key, text: target.text, hash });
            }
        }
        target.holder.extra = extra;
    });
    if (pushStored && hits.length) store.events.emit(MESSAGE_COUNTS_EVENT, hits);
    if (misses.length) countLater(store, counting, misses);
    else counting.write().catch(error => console.error('Failed to store token counts:', error));
    return records;
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {import('./user-stores.js').UserStore} store
 * @param {Owner} owner
 * @param {import('./message-counts.js').CountSources} sources
 * @param {{ pushStored?: boolean }} [options]
 * @returns {Promise<Record<string, CountRecord>>}
 */
async function countFor(directories, store, owner, sources, options) {
    const context = settingsContextOf({ avatar: owner.avatar ?? null, groupId: owner.groupId ?? null });
    if (!messageCountsShown(directories, context)) return {};
    const counting = await openCounting(directories, context);
    return counting ? countForPage(store, counting, sources, options) : {};
}

/**
 * @param {import('express').Request} request
 * @param {Owner} owner
 * @param {import('./message-counts.js').CountSources} sources
 * @returns {Promise<Record<string, CountRecord>>}
 */
export async function countSent(request, owner, sources) {
    return countFor(request.user.directories, await requestStore(request), owner, sources);
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {Parameters<typeof openingState>[0]} p
 */
export async function countedOpeningState(directories, p) {
    const state = await openingState(p);
    await countFor(directories, p.store, { avatar: p.avatar }, { alternatives: openingAlternatives(state) });
    return state;
}

/**
 * @param {import('./chat-request.js').ChatContext} chat
 * @param {unknown[]} nodeIds
 */
async function storedMessages(chat, nodeIds) {
    const ids = [...new Set(nodeIds.filter(id => typeof id === 'string' && id !== ''))].map(String);
    const shown = await Promise.all(ids.map(id => chat.store.chats.shownMessage(chat.tree, id)));
    return shown.flatMap((message, i) => (message ? [{ ...message, node_id: ids[i] }] : []));
}

/**
 * @param {import('express').Request} request
 * @param {import('./chat-request.js').ChatContext} chat
 * @param {unknown[]} nodeIds
 * @returns {Promise<Record<string, CountRecord> | undefined>}
 */
export async function storedMessageCounts(request, chat, nodeIds) {
    const messages = await storedMessages(chat, nodeIds);
    if (!messages.length) return undefined;
    const records = await countFor(request.user.directories, chat.store, chat, { messages });
    return Object.keys(records).length ? records : undefined;
}

/**
 * @param {import('express').Request} request
 * @param {{ avatar: unknown, group: unknown }} owner
 * @param {unknown[]} nodeIds
 */
export async function pushStoredCounts(request, owner, nodeIds) {
    const chat = await chatContext(request, owner);
    if (!chat) return;
    const messages = await storedMessages(chat, nodeIds);
    if (messages.length) await countFor(request.user.directories, chat.store, chat, { messages }, { pushStored: true });
}
