import { MENTION_CHECKS_PER_READ, TEXT_LINK_READS_PER_READ } from '@st/worldbuilding/protocol';

import { TYPE } from '../library-codes.js';
import { entryObject } from '../world-info-engine.js';
import { substituteParams } from '../macro-substitution.js';
import { convertCharacterBook } from './candidate-resolution.js';
import { findKeySpans, matchKeys, parseRegexFromString } from './key-matching.js';

const PAGE = 500;
const LOOSE = { caseSensitive: false, matchWholeWords: false };

/**
 * @typedef {import('./key-matching.js').MatchDefaults} Defaults
 * @typedef {{ name1?: string, name2?: string }} MacroContext
 * @typedef {{ id: bigint, key: string[], names: string[], content: string, constant: boolean, caseSensitive: boolean | null, matchWholeWords: boolean | null, broken: string | null }} Facts
 * @typedef {{ entry: bigint, name: string, spans: [number, number][] }} Reference
 * @typedef {{ entry: bigint, from: number, to: number }} Link
 */

/**
 * A cursor: after an entity id (`i`) or a place in the world's order (`p`), and how many entries the reads before it
 * looked through (`n`).
 * @param {string | undefined} cursor
 * @returns {{ id?: bigint, position?: number, looked: number }}
 */
function parseCursor(cursor) {
    const m = typeof cursor === 'string' ? /^([ip])(\d+)(?:n(\d+))?$/.exec(cursor) : null;
    if (!m) return { looked: 0 };
    const looked = m[3] === undefined ? 0 : Number(m[3]);
    return m[1] === 'i' ? { id: BigInt(m[2]), looked } : { position: Number(m[2]), looked };
}

/**
 * @param {import('../entity-values.js').StoredEntity} e
 * @param {boolean} owned
 * @returns {Facts}
 */
export function factsOf(e, owned) {
    const o = entryObject(e, owned);
    if (typeof o !== 'object' || o === null || Array.isArray(o)) {
        return { id: e.id, key: [], names: [], content: '', constant: false, caseSensitive: null, matchWholeWords: null, broken: 'not an entry object' };
    }
    const entry = owned ? convertCharacterBook({ entries: [o] }).entries[/** @type {any} */ (o).id ?? 0] : o;
    const x = /** @type {Record<string, any>} */ (entry);
    /** @type {string[]} */
    const key = Array.isArray(x.key) ? x.key.filter(k => typeof k === 'string') : [];
    const names = x.extensions?.names;
    return {
        id: e.id,
        key,
        names: Array.isArray(names) ? key.filter(k => names.includes(k)) : [],
        content: typeof x.content === 'string' ? x.content : '',
        constant: Boolean(x.constant),
        caseSensitive: typeof x.caseSensitive === 'boolean' ? x.caseSensitive : null,
        matchWholeWords: typeof x.matchWholeWords === 'boolean' ? x.matchWholeWords : null,
        broken: typeof x.content === 'string' || x.content === undefined ? null : 'its content is not text',
    };
}

/**
 * @param {Facts} f
 */
const flagsOf = f => ({ caseSensitive: f.caseSensitive ?? undefined, matchWholeWords: f.matchWholeWords ?? undefined });

/**
 * @param {string} raw
 * @param {MacroContext | null} macroContext
 * @returns {string | null}
 */
function nameOf(raw, macroContext) {
    if (raw.includes('{{') && macroContext === null) return null;
    const name = (macroContext ? substituteParams(raw, macroContext) : raw)?.trim();
    return name ? name : null;
}

/**
 * @param {string} text
 * @param {string} name
 * @param {Facts} target
 * @param {Defaults} defaults
 * @returns {{ linked: boolean, spans: [number, number][], unlinked: boolean }}
 */
export function mention(text, name, target, defaults) {
    const flags = flagsOf(target);
    if (matchKeys(text, name, flags, defaults)) {
        return { linked: true, spans: findKeySpans(text, name, flags, defaults), unlinked: false };
    }
    const unlinked = !parseRegexFromString(name) && matchKeys(text, name, LOOSE);
    return { linked: false, spans: [], unlinked };
}

/**
 * Of overlapping spans the one that starts first is kept, and of those starting together the longest.
 * @param {Link[]} spans
 * @returns {Link[]}
 */
export function linksAmong(spans) {
    const sorted = [...spans].sort((a, b) => a.from - b.from || b.to - a.to);
    /** @type {Link[]} */
    const links = [];
    for (const span of sorted) {
        if (span.from >= (links[links.length - 1]?.to ?? 0)) links.push(span);
    }
    return links;
}

export class References {
    /**
     * @param {import('../library-engine.js').LibraryEngine} lib
     * @param {{ defaults: Defaults, macroContext?: MacroContext | null }} options
     */
    constructor(lib, { defaults, macroContext = null }) {
        this.lib = lib;
        this.store = lib.store;
        this.defaults = defaults;
        this.macroContext = macroContext;
    }

    /**
     * @param {bigint} book
     */
    async owned(book) {
        const [b] = await this.lib.entities([book]);
        if (!b) return null;
        if (b.type === TYPE.ownedBook) return true;
        if (b.type === TYPE.book) return false;
        return null;
    }

    /**
     * @param {bigint[]} ids
     * @param {boolean} owned
     * @returns {Promise<Facts[]>}
     */
    async facts(ids, owned) {
        const entities = await this.lib.entities(ids);
        return entities.flatMap(e => (e ? [factsOf(e, owned)] : []));
    }

    /**
     * Where `text` writes a name of an entry of `book` other than `entry`: every span of every name, overlapping or not.
     * The store names the entries whose names the text may write (`textLinkCandidates`) in at most `readsAtMost` reads,
     * and the matcher checks each; `complete` is false when the store stopped at that bound, so a name it hadn't
     * reached may be missing. `reads` is what the store read.
     * @param {bigint} book
     * @param {bigint} entry `0n` for a text no entry holds (entity ids start at 1)
     * @param {string} text
     * @param {{ readsAtMost?: number }} [bound]
     * @returns {Promise<{ spans: Link[], complete: boolean, reads: number } | null>}
     */
    async spans(book, entry, text, { readsAtMost = TEXT_LINK_READS_PER_READ } = {}) {
        /** @type {{ candidates: { entry: bigint, names: string[], caseSensitive: boolean | null, matchWholeWords: boolean | null }[], complete: boolean, reads: number } | null} */
        const found = await this.store.worldRead('textLinkCandidates', { book, entry, text, readsAtMost });
        if (found === null) return null;
        /** @type {Link[]} */
        const spans = [];
        for (const candidate of found.candidates) {
            const target = /** @type {Facts} */ ({ caseSensitive: candidate.caseSensitive, matchWholeWords: candidate.matchWholeWords });
            for (const raw of candidate.names) {
                const name = nameOf(raw, this.macroContext);
                if (name === null) continue;
                for (const [from, to] of mention(text, name, target, this.defaults).spans) spans.push({ entry: candidate.entry, from, to });
            }
        }
        return { spans, complete: found.complete, reads: found.reads };
    }

    /**
     * Where `text`, the text of `entry`, writes a name of another entry: the spans of `spans`, of overlapping ones the
     * one that starts first and of those starting together the longest (`linksAmong`).
     * @param {bigint} book
     * @param {bigint} entry
     * @param {string} text
     * @param {{ readsAtMost?: number }} [bound]
     * @returns {Promise<{ links: Link[], complete: boolean } | null>}
     */
    async links(book, entry, text, bound) {
        const found = await this.spans(book, entry, text, bound);
        return found === null ? null : { links: linksAmong(found.spans), complete: found.complete };
    }

    /**
     * What mentions an entry, a page at a time. The index names the texts that can mention it when it can look every
     * name up (`scanned` false); else the read walks the world in its order. Either way it checks at most
     * `checksAtMost` entries: `stoppedForBound` says it stopped there with more to look through, from `next`.
     * @param {bigint} book
     * @param {bigint} entry
     * @param {{ cursor?: string, limit?: number, withText?: boolean, checksAtMost?: number }} [page] withText: each reference also carries its source's text.
     * @returns {Promise<{ references: (Reference & { text?: string })[], unlinked: { entry: bigint, name: string }[], scanned: boolean, unresolved: string[], next: string | null, checked: number, lookedThrough: number, stoppedForBound: boolean } | null>}
     */
    async to(book, entry, { cursor, limit = 100, withText = false, checksAtMost = MENTION_CHECKS_PER_READ } = {}) {
        const { id: after, position: from, looked } = parseCursor(cursor);
        const owned = await this.owned(book);
        if (owned === null) return null;
        const [target] = await this.facts([entry], owned);
        if (!target) return null;
        /** @type {string[]} */
        const names = [];
        /** @type {string[]} */
        const unresolved = [];
        for (const raw of target.key) {
            const name = nameOf(raw, this.macroContext);
            if (name === null) {
                if (raw.includes('{{')) unresolved.push(raw);
            } else {
                names.push(name);
            }
        }
        /** @type {(Reference & { text?: string })[]} */
        const references = [];
        /** @type {{ entry: bigint, name: string }[]} */
        const unlinked = [];
        let checked = 0;
        /**
         * @param {string | null} next
         * @param {boolean} scanned
         */
        const answer = (next, scanned) => ({
            references,
            unlinked,
            scanned,
            unresolved,
            next: next === null ? null : `${next}n${looked + checked}`,
            checked,
            lookedThrough: looked + checked,
            stoppedForBound: next !== null && checked >= checksAtMost,
        });
        if (names.length === 0) return answer(null, false);
        /**
         * @param {bigint} source
         * @param {string} content
         */
        const check = (source, content) => {
            let linkedName = null;
            for (const name of names) {
                const m = mention(content, name, target, this.defaults);
                if (m.linked) {
                    references.push({ entry: source, name, spans: m.spans, ...(withText ? { text: content } : {}) });
                    linkedName = name;
                    break;
                }
                if (m.unlinked) unlinked.push({ entry: source, name });
            }
            if (linkedName !== null) {
                for (let i = unlinked.length - 1; i >= 0 && unlinked[i].entry === source; i--) unlinked.splice(i, 1);
            }
        };
        /**
         * Checks `ids` in order until the page is full or the bound is reached: the cursor after the last checked then,
         * else undefined to go on.
         * @param {bigint[]} ids
         * @param {(at: number) => string} cursorAt
         * @param {boolean} more whether entries follow `ids`
         * @returns {Promise<string | null | undefined>}
         */
        const checkEach = async (ids, cursorAt, more) => {
            if (ids.length === 0) return null;
            /** @type {(string | null)[]} */
            const texts = await this.store.worldRead('entryTexts', { book, entries: ids });
            for (let at = 0; at < ids.length; at++) {
                const text = texts[at];
                if (ids[at] !== entry) {
                    checked++;
                    if (text !== null) check(ids[at], text);
                }
                if (at === ids.length - 1 && !more) return null;
                if (references.length + unlinked.length >= limit || checked >= checksAtMost) return cursorAt(at);
            }
            return undefined;
        };
        const lookups = names.map(name => {
            const regex = parseRegexFromString(name);
            return regex ? { text: regex.source, regexFlags: regex.flags } : { text: name };
        });
        /** @type {bigint | undefined} */
        let afterId = after;
        for (;;) {
            /** @type {{ entries: bigint[], more: boolean } | null} */
            const page = await this.store.worldRead('mentionCandidates', {
                book,
                names: lookups,
                limit: Math.max(1, Math.min(PAGE, checksAtMost - checked)),
                ...(afterId === undefined ? {} : { after: afterId }),
            });
            if (page === null) break;
            const ids = page.entries;
            const stop = await checkEach(ids, at => `i${ids[at]}`, page.more);
            if (stop !== undefined) return answer(stop, false);
            afterId = ids[ids.length - 1];
        }
        let position = from;
        for (;;) {
            /** @type {{ entries: { id: bigint, position: number }[], more: boolean }} */
            const page = await this.store.worldRead('entries', {
                book,
                limit: Math.max(1, Math.min(PAGE, checksAtMost - checked)),
                ...(position === undefined ? {} : { after: position }),
            });
            const places = page.entries;
            const stop = await checkEach(places.map(p => p.id), at => `p${places[at].position}`, page.more);
            if (stop !== undefined) return answer(stop, true);
            position = places[places.length - 1].position;
        }
    }
}
