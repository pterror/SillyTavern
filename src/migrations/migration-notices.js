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
 * @typedef {{ avatar: string, world: string }} UndoneEntry
 * @typedef {{ total: number, entries: SkippedEntry[] }} SkippedList
 * @typedef {{ total: number, entries: FailingEntry[] }} FailingList
 * @typedef {{ total: number, entries: UndoneEntry[] }} UndoneList
 * @typedef {{ version: number, skipped: SkippedList, failing: FailingList, undone: UndoneList }} StoredNotice
 */

/**
 * What a pass tells the user: cards it changed, cards it couldn't check, cards it couldn't write. A card whose linked
 * World file doesn't exist is none of these (nothing was or could be changed), so it isn't collected; the report
 * still lists it.
 */
export class NoticeCollector {
    /** @type {SkippedList} */ skipped = { total: 0, entries: [] };
    /** @type {FailingList} */ failing = { total: 0, entries: [] };
    /** @type {UndoneList} */ undone = { total: 0, entries: [] };
    /** @param {SkippedEntry} entry */ addSkipped(entry) {
        if (entry.reason === 'world-missing') return;
        this.skipped.total++;
        if (this.skipped.entries.length < NOTICE_ENTRY_LIMIT) this.skipped.entries.push(entry);
    }
    /** @param {FailingEntry} entry */ addFailing(entry) { this.failing.total++; if (this.failing.entries.length < NOTICE_ENTRY_LIMIT) this.failing.entries.push(entry); }
    /** @param {UndoneEntry} entry */ addUndone(entry) { this.undone.total++; if (this.undone.entries.length < NOTICE_ENTRY_LIMIT) this.undone.entries.push(entry); }
    isEmpty() { return this.skipped.total === 0 && this.failing.total === 0 && this.undone.total === 0; }
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
        || (notice.undone !== undefined && (!Number.isFinite(notice.undone?.total) || !Array.isArray(notice.undone?.entries)))) {
        return null;
    }
    // A `noWorld` list stored by an earlier version is dropped: those cards are nothing to tell the user about.
    return { version: notice.version, skipped: notice.skipped, failing: notice.failing, undone: notice.undone ?? EMPTY_LIST };
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
 * @param {{ skipped: SkippedList, failing: FailingList, undone?: UndoneList }} lists
 * @returns {string}
 */
export function serializeNotice(previous, lists) {
    return JSON.stringify({ version: Math.max(Date.now(), (previous?.version ?? 0) + 1), skipped: lists.skipped, failing: lists.failing, undone: lists.undone ?? EMPTY_LIST });
}

/**
 * Whether a notice has anything to tell the user.
 * @param {{ skipped: SkippedList, failing: FailingList, undone: UndoneList }} notice
 * @returns {boolean}
 */
export function noticeHasContent(notice) {
    return notice.skipped.total > 0 || notice.failing.total > 0 || notice.undone.total > 0;
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
 * The lists a retry pass leaves in the notice. Skipped and undone lists add up, since a card in either is never looked
 * at again; failing is replaced, since a retry pass looks at every card still failing.
 * @param {StoredNotice | null} previous
 * @param {NoticeCollector} collector
 * @returns {{ skipped: SkippedList, failing: FailingList, undone: UndoneList } | null} null when every list is empty.
 */
export function mergeRetryNotice(previous, collector) {
    if (previous === null) {
        return collector.isEmpty() ? null : { skipped: collector.skipped, failing: collector.failing, undone: collector.undone };
    }
    /** @type {<T>(a: { total: number, entries: T[] }, b: { total: number, entries: T[] }) => { total: number, entries: T[] }} */
    const add = (a, b) => ({ total: a.total + b.total, entries: [...a.entries, ...b.entries].slice(0, NOTICE_ENTRY_LIMIT) });
    const merged = { skipped: add(previous.skipped, collector.skipped), failing: collector.failing, undone: add(previous.undone ?? EMPTY_LIST, collector.undone) };
    return noticeHasContent(merged) ? merged : null;
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
 * A stored notice with nothing to tell (only an earlier version's `noWorld` list) isn't listed.
 * @returns {Promise<{ id: string, version: number, skipped: { total: number, entries: (SkippedEntry & { name: string | null })[] }, failing: { total: number, entries: (FailingEntry & { name: string | null })[] }, undone: { total: number, entries: (UndoneEntry & { name: string | null })[] }, hasReport: boolean }[]>}
 */
export async function getNoticesForClient(directories) {
    const notices = [];
    for (const id of NOTICE_IDS) {
        const notice = await readNotice(directories, id);
        if (notice === null || !noticeHasContent(notice)) continue;
        const names = await getCharacterNamesByIds(directories, [...notice.skipped.entries, ...notice.failing.entries, ...notice.undone.entries].map(e => e.avatar));
        /** @type {<T extends { avatar: string }>(list: { total: number, entries: T[] }) => { total: number, entries: (T & { name: string | null })[] }} */
        const named = list => ({ total: list.total, entries: list.entries.map(e => ({ ...e, name: names.get(e.avatar) ?? null })) });
        notices.push({
            id,
            version: notice.version,
            skipped: named(notice.skipped),
            failing: named(notice.failing),
            undone: named(notice.undone),
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
