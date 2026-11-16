import { searchTokens } from '@st/protocol/search';
import { LIBRARY_LABELS } from './search-clauses.js';

/**
 * The entries a folder case's list starts with: in the rest case ("none") the closed folders, in a closed folder's
 * case the way back to the rest case. They come before every character and group, and the list's paging, totals and
 * cursors count them as rows.
 */

export const FOLDER_ORDERS = new Set(['alphabetical', 'by_entries', 'manual']);

/** A cursor that ends a page inside the folders: `f` and the tag query's cursor after the last folder shown. */
const FOLDER_CURSOR = 'f';
const SCAN_BATCH = 200;
/** Past this many matching folders the folders' part of a total is a lower bound. */
const COUNT_CAP = 20_000;

/**
 * @typedef {{ id: string, name: string, thing?: string, count: number, countApprox: boolean }} FolderRow
 * @typedef {{ id: 'none' }} RestRow The way back to the rest case.
 * @typedef {FolderRow | RestRow} LeadRow
 */

/**
 * Words as the engine's search reads a text (engine/src/search/text.rs, `for_each_token`): runs of letters and
 * digits, case and accents folded.
 * @param {string} text
 * @returns {string[]}
 */
function searchWords(text) {
    return (String(text).match(/[\p{Alphabetic}\p{N}]+/gu) ?? []).map(word => word.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()).filter(Boolean);
}

/**
 * @param {string[]} words a name's
 * @param {string[]} phrase
 * @param {boolean} prefix whether the phrase's last word may be the start of a name's word
 */
function holdsPhrase(words, phrase, prefix) {
    const last = phrase.length - 1;
    return words.some((_, start) => phrase.every((part, i) => {
        const word = words[start + i];
        return word !== undefined && (i === last && prefix ? word.startsWith(part) : word === part);
    }));
}

/**
 * How a search matches a folder: as the engine's search matches a name (engine/src/search/brute.rs): each of its
 * words or quoted phrases is in the name, word for word, and the last one, unquoted and of two letters or more, may be
 * the start of a word. A `name:` word counts as a word and `-name:` leaves out. A search with a word for any other
 * field matches no folder, since a folder has none of them.
 * @param {string} search
 * @returns {{ contains: string | undefined, matches: (name: string) => boolean } | null}
 */
export function folderNameMatcher(search) {
    const tokens = searchTokens(search, LIBRARY_LABELS);
    if (tokens.some(token => token.label !== null && token.label !== 'name')) return null;
    const clauses = tokens.map(token => ({ words: searchWords(token.text), negate: token.negate, quoted: token.quoted })).filter(clause => clause.words.length > 0);
    const lastIndex = clauses.length - 1;
    const shaped = clauses.map((clause, i) => ({
        ...clause,
        prefix: i === lastIndex && !clause.quoted && [...clause.words[clause.words.length - 1]].length >= 2,
    }));
    const longest = shaped.filter(clause => !clause.negate).flatMap(clause => clause.words).reduce((a, b) => (b.length > a.length ? b : a), '');
    return {
        contains: longest || undefined,
        matches: (name) => {
            const words = searchWords(name);
            return shaped.every(clause => holdsPhrase(words, clause.words, clause.prefix) !== clause.negate);
        },
    };
}

/**
 * Closed folders in `order`, after `after`: `skip` matching ones passed over, then up to `take` taken.
 * @param {any} lib
 * @param {{ order: string, matcher: NonNullable<ReturnType<typeof folderNameMatcher>>, after: string | null, skip: number, take: number }} o
 * @returns {Promise<{ rows: FolderRow[], skipped: number, cursor: string | null, exhausted: boolean } | 'invalid-cursor'>}
 */
async function scanFolders(lib, { order, matcher, after, skip, take }) {
    /** @type {FolderRow[]} */
    const rows = [];
    let skipped = 0;
    let cursor = after;
    for (;;) {
        const wanted = (skip - skipped) + (take - rows.length);
        if (wanted <= 0) return { rows, skipped, cursor, exhausted: false };
        // A page never holds more than is still wanted, so every match in it is used and its cursor is exact.
        const answer = await lib.tags.query({
            sort: order,
            folders: true,
            folderType: 'CLOSED',
            contains: matcher.contains,
            counts: take > rows.length,
            pageSize: Math.min(wanted, SCAN_BATCH),
            cursor,
        });
        if (answer === 'invalid-cursor') return answer;
        for (const row of answer.rows) {
            const name = String(row.name ?? '');
            if (!matcher.matches(name)) continue;
            if (skipped < skip) {
                skipped++;
                continue;
            }
            rows.push({
                id: String(row.id),
                name,
                ...(row.thing === undefined ? {} : { thing: String(row.thing) }),
                count: Number(answer.counts?.[row.id] ?? 0),
                countApprox: Boolean(answer.approximate?.includes(row.id)),
            });
        }
        if (answer.cursor === null) return { rows, skipped, cursor: null, exhausted: true };
        cursor = answer.cursor;
    }
}

/**
 * @param {any} lib
 * @param {string} order
 * @param {NonNullable<ReturnType<typeof folderNameMatcher>>} matcher
 * @returns {Promise<{ count: number, approx: boolean }>}
 */
async function countFolders(lib, order, matcher) {
    const scanned = await scanFolders(lib, { order, matcher, after: null, skip: COUNT_CAP, take: 0 });
    if (scanned === 'invalid-cursor') throw new Error('A scan from the start was refused its cursor.');
    return { count: scanned.skipped, approx: !scanned.exhausted };
}

/**
 * @typedef {object} ListLead
 * @property {LeadRow[]} rows The page's first rows.
 * @property {{ offset: number, limit: number, cursor: string | undefined }} entities Where the page's characters and groups start, and how many it has room for.
 * @property {string} [cursor] The next page's cursor, when this page ends inside the folders.
 * @property {{ count: number, approx: boolean }} [total] How many rows lead the whole list, when asked.
 */

/**
 * @param {any} lib
 * @param {object} o
 * @param {string} o.folderCase "none", or a closed folder's tag id
 * @param {string} o.search
 * @param {string} o.order a tag sort
 * @param {number} o.offset the page's first row's position, used without a cursor
 * @param {number} o.limit
 * @param {string | undefined} o.cursor
 * @param {boolean} o.wantTotal
 * @returns {Promise<ListLead | 'invalid-cursor'>}
 */
export async function listLead(lib, { folderCase, search, order, offset, limit, cursor, wantTotal }) {
    const inFolders = typeof cursor === 'string' && cursor.startsWith(FOLDER_CURSOR);
    const entityCursor = typeof cursor === 'string' && !inFolders ? cursor : undefined;
    if (folderCase !== 'none') {
        if (inFolders) return 'invalid-cursor';
        const total = wantTotal ? { count: 1, approx: false } : undefined;
        if (entityCursor !== undefined) return { rows: [], entities: { offset: 0, limit, cursor: entityCursor }, total };
        if (offset > 0) return { rows: [], entities: { offset: offset - 1, limit, cursor: undefined }, total };
        return { rows: [{ id: 'none' }], entities: { offset: 0, limit: limit - 1, cursor: undefined }, total };
    }
    const matcher = folderNameMatcher(search);
    if (matcher === null) {
        if (inFolders) return 'invalid-cursor';
        return { rows: [], entities: { offset, limit, cursor: entityCursor }, total: wantTotal ? { count: 0, approx: false } : undefined };
    }
    const counted = () => (wantTotal ? countFolders(lib, order, matcher) : Promise.resolve(undefined));
    if (entityCursor !== undefined) {
        return { rows: [], entities: { offset: 0, limit, cursor: entityCursor }, total: await counted() };
    }
    const scanned = await scanFolders(lib, {
        order,
        matcher,
        after: inFolders ? cursor.slice(FOLDER_CURSOR.length) : null,
        skip: inFolders ? 0 : offset,
        take: limit,
    });
    if (scanned === 'invalid-cursor') return scanned;
    if (!scanned.exhausted) {
        return {
            rows: scanned.rows,
            entities: { offset: 0, limit: 0, cursor: undefined },
            ...(scanned.cursor === null ? {} : { cursor: `${FOLDER_CURSOR}${scanned.cursor}` }),
            total: await counted(),
        };
    }
    const entities = { offset: inFolders ? 0 : offset - scanned.skipped, limit: limit - scanned.rows.length, cursor: undefined };
    const total = !wantTotal ? undefined : inFolders ? await counted() : { count: scanned.skipped + scanned.rows.length, approx: false };
    return { rows: scanned.rows, entities, total };
}
