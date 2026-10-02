import fs from 'node:fs';

import { getMetaValue, setMetaValue, deleteMetaValueIfEquals, getCharacterNamesByIds } from '../character-metadata-db.js';
import { reportPath } from './migration-report.js';

/** How many cards of each list a stored notice names; the rest are only counted. */
export const NOTICE_ENTRY_LIMIT = 20;
/** Every notice id the client may be shown or mark seen. */
export const NOTICE_IDS = ['unimport-embedded-lore'];
/** @param {string} id */
export function noticeKey(id) { return `migration_notice:${id}`; }

/**
 * @typedef {{ avatar: string, world: string, reason: string }} SkippedEntry
 * @typedef {{ avatar: string, world: string }} FailingEntry
 * @typedef {{ total: number, entries: SkippedEntry[] }} SkippedList
 * @typedef {{ total: number, entries: FailingEntry[] }} FailingList
 * @typedef {{ version: number, skipped: SkippedList, failing: FailingList, noWorld?: SkippedList }} StoredNotice
 */

/**
 * Cards whose linked World file doesn't exist go to `noWorld`, not `skipped`: there is nothing a migration could undo
 * for them, so they weren't skipped, only looked at.
 */
export class NoticeCollector {
    /** @type {SkippedList} */ skipped = { total: 0, entries: [] };
    /** @type {SkippedList} */ noWorld = { total: 0, entries: [] };
    /** @type {FailingList} */ failing = { total: 0, entries: [] };
    /** @param {SkippedEntry} entry */ addSkipped(entry) {
        const list = entry.reason === 'world-missing' ? this.noWorld : this.skipped;
        list.total++;
        if (list.entries.length < NOTICE_ENTRY_LIMIT) list.entries.push(entry);
    }
    /** @param {FailingEntry} entry */ addFailing(entry) { this.failing.total++; if (this.failing.entries.length < NOTICE_ENTRY_LIMIT) this.failing.entries.push(entry); }
    isEmpty() { return this.skipped.total === 0 && this.failing.total === 0 && this.noWorld.total === 0; }
}

/** @type {SkippedList} */
const EMPTY_LIST = Object.freeze({ total: 0, entries: Object.freeze([]) });

/**
 * The stored notice exactly as it is in the meta table.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} id
 * @returns {Promise<string | null>}
 */
export async function readNoticeRaw(directories, id) {
    return getMetaValue(directories, noticeKey(id));
}

/**
 * Parses a stored notice.
 * @param {string | null} raw
 * @returns {StoredNotice | null} null when there is none, or it isn't a well-formed notice.
 */
export function parseNotice(raw) {
    if (raw === null) return null;
    let notice;
    try {
        notice = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!notice || typeof notice !== 'object'
        || !Number.isFinite(notice.version)
        || !Number.isFinite(notice.skipped?.total)
        || !Number.isFinite(notice.failing?.total)
        || !Array.isArray(notice.skipped?.entries)
        || !Array.isArray(notice.failing?.entries)
        || (notice.noWorld !== undefined && (!Number.isFinite(notice.noWorld?.total) || !Array.isArray(notice.noWorld?.entries)))) {
        return null;
    }
    return { ...notice, noWorld: notice.noWorld ?? EMPTY_LIST };
}

/**
 * The stored notice, parsed.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} id
 * @returns {Promise<StoredNotice | null>}
 */
export async function readNotice(directories, id) {
    return parseNotice(await readNoticeRaw(directories, id));
}

/**
 * A notice to store, with a version higher than the previous one's (and at least the current time).
 * @param {StoredNotice | null} previous
 * @param {{ skipped: SkippedList, failing: FailingList, noWorld?: SkippedList }} lists
 * @returns {string}
 */
export function serializeNotice(previous, lists) {
    return JSON.stringify({ version: Math.max(Date.now(), (previous?.version ?? 0) + 1), skipped: lists.skipped, failing: lists.failing, noWorld: lists.noWorld ?? EMPTY_LIST });
}

/**
 * Replaces the stored notice with what `collector` gathered; an empty collector deletes it.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} id
 * @param {NoticeCollector} collector
 */
export async function replaceNotice(directories, id, collector) {
    const raw = await readNoticeRaw(directories, id);
    if (collector.isEmpty()) {
        if (raw !== null) {
            await deleteMetaValueIfEquals(directories, noticeKey(id), raw);
        }
        return;
    }
    await setMetaValue(directories, noticeKey(id), serializeNotice(parseNotice(raw), collector));
}

/**
 * The lists a retry pass leaves in the notice. Skipped lists add up, since a card listed as skipped is never looked at
 * again; failing is replaced, since a retry pass looks at every card still failing.
 * @param {StoredNotice | null} previous
 * @param {NoticeCollector} collector
 * @returns {{ skipped: SkippedList, failing: FailingList, noWorld: SkippedList } | null} null when every list is empty.
 */
export function mergeRetryNotice(previous, collector) {
    if (previous === null) {
        return collector.isEmpty() ? null : { skipped: collector.skipped, failing: collector.failing, noWorld: collector.noWorld };
    }
    /** @type {(a: SkippedList, b: SkippedList) => SkippedList} */
    const add = (a, b) => ({ total: a.total + b.total, entries: [...a.entries, ...b.entries].slice(0, NOTICE_ENTRY_LIMIT) });
    const skipped = add(previous.skipped, collector.skipped);
    const noWorld = add(previous.noWorld ?? EMPTY_LIST, collector.noWorld);
    const failing = collector.failing;
    if (skipped.total === 0 && failing.total === 0 && noWorld.total === 0) return null;
    return { skipped, failing, noWorld };
}

/**
 * Deletes the stored notice if it is still the version the user saw.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} id
 * @param {number} version
 * @returns {Promise<boolean>} true when it was deleted.
 */
export async function markNoticeSeen(directories, id, version) {
    const raw = await readNoticeRaw(directories, id);
    const notice = parseNotice(raw);
    if (!notice || notice.version !== version) return false;
    return await deleteMetaValueIfEquals(directories, noticeKey(id), raw);
}

/**
 * Every stored notice, each listed card with its character name from the index (null when it has no row).
 * @param {import('../users.js').UserDirectoryList} directories
 * @returns {Promise<{ id: string, version: number, skipped: { total: number, entries: (SkippedEntry & { name: string | null })[] }, failing: { total: number, entries: (FailingEntry & { name: string | null })[] }, noWorld: { total: number, entries: (SkippedEntry & { name: string | null })[] }, hasReport: boolean }[]>}
 */
export async function getNoticesForClient(directories) {
    const notices = [];
    for (const id of NOTICE_IDS) {
        const notice = await readNotice(directories, id);
        if (notice === null) continue;
        const noWorld = notice.noWorld ?? EMPTY_LIST;
        const names = await getCharacterNamesByIds(directories, [...notice.skipped.entries, ...notice.failing.entries, ...noWorld.entries].map(e => e.avatar));
        notices.push({
            id,
            version: notice.version,
            skipped: { total: notice.skipped.total, entries: notice.skipped.entries.map(e => ({ ...e, name: names.get(e.avatar) ?? null })) },
            failing: { total: notice.failing.total, entries: notice.failing.entries.map(e => ({ ...e, name: names.get(e.avatar) ?? null })) },
            noWorld: { total: noWorld.total, entries: noWorld.entries.map(e => ({ ...e, name: names.get(e.avatar) ?? null })) },
            hasReport: await hasReport(directories, id),
        });
    }
    return notices;
}

/**
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} id
 * @returns {Promise<boolean>}
 */
async function hasReport(directories, id) {
    try {
        await fs.promises.access(reportPath(directories, id));
        return true;
    } catch {
        return false;
    }
}
