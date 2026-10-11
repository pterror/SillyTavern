import fs from 'node:fs';
import path from 'node:path';

import { MODE } from '../../chat-engine.js';
import { openReadOnly } from './old-library.js';

/**
 * Whether a label becomes a pinned or a following bookmark (chat-as-bookmark shim plan, D24): by the first of its
 * wording, the owner's old chat files, and the pre-migration backup that settles it; otherwise following, listed.
 */

const HUMANIZED = String.raw`\d{4}-\d{2}-\d{2}@\d{2}h\d{2}m\d{2}s(?:\d{3}ms)?`;

/** A stacked name is decided by its last suffix, so the suffixes are tried at the end of the name first. */
const BY_WORDING = /** @type {[RegExp, number][]} */ ([
    [/ - Checkpoint #\d+$/, MODE.pinned],
    [/ - Bookmark #\d+$/, MODE.pinned],
    [/ - Branch #\d+$/, MODE.following],
    [/^Bookmark #\d+$/, MODE.pinned],
    [/^Bookmark - \d+$/, MODE.pinned],
    [new RegExp(`^Branch #\\d+ - ${HUMANIZED}$`), MODE.following],
    [new RegExp(`^${HUMANIZED}$`), MODE.following],
    [new RegExp(`^.+ - ${HUMANIZED}$`), MODE.following],
    [/imported$/, MODE.following],
    [/^\d{13}$/, MODE.following],
]);

/**
 * @param {string} name
 * @returns {number | null} The mode the name's wording gives, or null.
 */
export function modeByWording(name) {
    for (const [pattern, mode] of BY_WORDING) if (pattern.test(name)) return mode;
    return null;
}

/**
 * The `extra.bookmark_link` values an owner's old chat files carry (read only, line by line).
 * @param {string[]} files `.jsonl.pre-migration` files.
 * @returns {{ links: Set<string>, unread: string[] }}
 */
export function bookmarkLinksOf(files) {
    const links = new Set();
    const unread = [];
    for (const file of files) {
        let text;
        try {
            text = fs.readFileSync(file, 'utf8');
        } catch {
            unread.push(file);
            continue;
        }
        for (const line of text.split('\n')) {
            if (!line.includes('bookmark_link')) continue;
            try {
                const link = JSON.parse(line)?.extra?.bookmark_link;
                if (typeof link === 'string' && link !== '') links.add(link);
            } catch {
                // A line that isn't JSON carries no link.
            }
        }
    }
    return { links, unread };
}

/**
 * The pre-migration backups of a user's tree (`backups/pre-sibling-swipes-*\/message-tree.sqlite`), opened read-only.
 * @param {any} Database
 * @param {string} backupsDir
 */
export function openBackups(Database, backupsDir) {
    if (!fs.existsSync(backupsDir)) return [];
    return fs.readdirSync(backupsDir)
        .filter(d => d.startsWith('pre-sibling-swipes-'))
        .sort()
        .map(d => path.join(backupsDir, d, 'message-tree.sqlite'))
        .filter(f => fs.existsSync(f))
        .map(f => openReadOnly(Database, f));
}

/**
 * An owner's names in the backups: those in `messages.label` and those in `branches.name`.
 * @param {import('../../endpoints/sqlite-engine.js').SqliteEngineHandle[]} backups
 * @param {string} ownerId
 */
export function backupNames(backups, ownerId) {
    const labels = new Set();
    const branches = new Set();
    for (const db of backups) {
        const has = (/** @type {string} */ table, /** @type {string} */ column) => (/** @type {{ name: string }[]} */ (db.readBounded(`PRAGMA table_info("${table}")`, [], 1000))).some(c => c.name === column);
        if (has('messages', 'label') && has('messages', 'owner_id')) {
            for (const r of /** @type {Iterable<{ label: string }>} */ (db.iterate('SELECT DISTINCT label FROM messages WHERE owner_id = ? AND label IS NOT NULL', [ownerId]))) labels.add(r.label);
        }
        if (has('branches', 'name') && has('branches', 'owner_id')) {
            for (const r of /** @type {Iterable<{ name: string }>} */ (db.iterate('SELECT DISTINCT name FROM branches WHERE owner_id = ?', [ownerId]))) branches.add(r.name);
        }
    }
    return { labels, branches };
}

/**
 * Each name's mode, and the names nothing settled (following).
 * @param {string[]} names
 * @param {() => { links: Set<string> }} files The owner's old chat files' links, read when wording leaves a name.
 * @param {() => { labels: Set<string>, branches: Set<string> }} backup The owner's backup names, read when needed.
 * @returns {{ modes: Map<string, number>, unsettled: string[] }}
 */
export function classify(names, files, backup) {
    /** @type {Map<string, number>} */
    const modes = new Map();
    const unsettled = [];
    /** @type {{ links: Set<string> } | null} */
    let fileLinks = null;
    /** @type {{ labels: Set<string>, branches: Set<string> } | null} */
    let saved = null;
    for (const name of new Set(names)) {
        const worded = modeByWording(name);
        if (worded !== null) {
            modes.set(name, worded);
            continue;
        }
        fileLinks ??= files();
        if (fileLinks.links.has(name)) {
            modes.set(name, MODE.pinned);
            continue;
        }
        saved ??= backup();
        if (saved.labels.has(name) && !saved.branches.has(name)) {
            modes.set(name, MODE.pinned);
            continue;
        }
        if (saved.branches.has(name) && !saved.labels.has(name)) {
            modes.set(name, MODE.following);
            continue;
        }
        modes.set(name, MODE.following);
        unsettled.push(name);
    }
    return { modes, unsettled };
}
