import { TYPE } from '../library-codes.js';
import { entryObject } from '../world-info-engine.js';
import { substituteParams } from '../macro-substitution.js';
import { convertCharacterBook } from './candidate-resolution.js';
import { findKeySpans, matchKeys, parseRegexFromString } from './key-matching.js';

const PAGE = 500;
const LOOSE = { caseSensitive: false, matchWholeWords: false };
export const HEAVY_FACTOR = 4;
export const HEAVY_MIN_ENTRIES = 4;

/**
 * @typedef {{ caseSensitive?: boolean, matchWholeWords?: boolean }} Defaults
 * @typedef {{ name1?: string, name2?: string }} MacroContext
 * @typedef {{ id: bigint, key: string[], content: string, constant: boolean, caseSensitive: boolean | null, matchWholeWords: boolean | null, broken: string | null }} Facts
 * @typedef {{ entry: bigint, name: string, spans: [number, number][] }} Reference
 */

/**
 * @param {bigint} a
 * @param {bigint} b
 */
const byId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * @param {string | undefined} cursor
 * @returns {{ id?: bigint, position?: number }}
 */
function parseCursor(cursor) {
    const m = typeof cursor === 'string' ? /^([ip])(\d+)$/.exec(cursor) : null;
    if (!m) return {};
    return m[1] === 'i' ? { id: BigInt(m[2]) } : { position: Number(m[2]) };
}

/**
 * @param {import('../entity-values.js').StoredEntity} e
 * @param {boolean} owned
 * @returns {Facts}
 */
export function factsOf(e, owned) {
    const o = entryObject(e, owned);
    if (typeof o !== 'object' || o === null || Array.isArray(o)) {
        return { id: e.id, key: [], content: '', constant: false, caseSensitive: null, matchWholeWords: null, broken: 'not an entry object' };
    }
    const entry = owned ? convertCharacterBook({ entries: [o] }).entries[/** @type {any} */ (o).id ?? 0] : o;
    const x = /** @type {Record<string, any>} */ (entry);
    return {
        id: e.id,
        key: Array.isArray(x.key) ? x.key.filter(k => typeof k === 'string') : [],
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

export class References {
    /**
     * @param {import('../library-engine.js').LibraryEngine} lib
     * @param {{ defaults?: Defaults, macroContext?: MacroContext | null }} [options]
     */
    constructor(lib, { defaults = {}, macroContext = null } = {}) {
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
     * @param {string} op
     * @param {bigint} book
     * @param {string} text
     * @returns {Promise<bigint[] | null>}
     */
    async candidates(op, book, text) {
        /** @type {bigint[]} */
        const out = [];
        let after;
        for (;;) {
            const page = await this.store.worldRead(op, { book, text, limit: PAGE, ...(after === undefined ? {} : { after }) });
            if (page === null) return null;
            out.push(...page.entries);
            if (!page.more) return out;
            after = page.entries[page.entries.length - 1];
        }
    }

    /**
     * @param {bigint} book
     * @returns {Promise<bigint[]>}
     */
    async unindexed(book) {
        /** @type {Set<bigint>} */
        const out = new Set();
        let after;
        for (;;) {
            const page = await this.store.worldRead('unindexedNames', { book, limit: PAGE, ...(after === undefined ? {} : { after }) });
            for (const n of page.names) out.add(n.entry);
            if (!page.more) return [...out];
            after = page.names[page.names.length - 1].entry;
        }
    }

    /**
     * @param {bigint} book
     * @param {bigint} entry
     * @param {{ cursor?: string, limit?: number }} [page]
     * @returns {Promise<{ references: Reference[], unresolved: string[], next: string | null } | null>}
     */
    async from(book, entry, { cursor, limit = 100 } = {}) {
        const owned = await this.owned(book);
        if (owned === null) return null;
        const [source] = await this.facts([entry], owned);
        if (!source) return null;
        const after = parseCursor(cursor).id;
        const indexed = (await this.candidates('nameCandidates', book, source.content)) ?? [];
        const ids = [...new Set([...indexed, ...(await this.unindexed(book))])]
            .filter(id => id !== entry && (after === undefined || id > after))
            .sort(byId);
        /** @type {Reference[]} */
        const references = [];
        /** @type {Set<string>} */
        const unresolved = new Set();
        let next = null;
        for (let at = 0; at < ids.length && next === null; at += PAGE) {
            for (const target of await this.facts(ids.slice(at, at + PAGE), owned)) {
                if (references.length === limit) {
                    next = `i${references[limit - 1].entry}`;
                    break;
                }
                for (const raw of target.key) {
                    const name = nameOf(raw, this.macroContext);
                    if (name === null) {
                        if (raw.includes('{{')) unresolved.add(raw);
                        continue;
                    }
                    const m = mention(source.content, name, target, this.defaults);
                    if (m.linked) {
                        references.push({ entry: target.id, name, spans: m.spans });
                        break;
                    }
                }
            }
        }
        return { references, unresolved: [...unresolved], next };
    }

    /**
     * @param {bigint} book
     * @param {bigint} entry
     * @param {{ cursor?: string, limit?: number }} [page]
     * @returns {Promise<{ references: Reference[], unlinked: { entry: bigint, name: string }[], scanned: boolean, unresolved: string[], next: string | null } | null>}
     */
    async to(book, entry, { cursor, limit = 100 } = {}) {
        const { id: after, position: from } = parseCursor(cursor);
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
        /** @type {Set<bigint> | null} */
        let candidates = new Set();
        for (const name of names) {
            const found = parseRegexFromString(name) ? null : await this.candidates('mentionCandidates', book, name);
            if (found === null) {
                candidates = null;
                break;
            }
            for (const id of found) candidates.add(id);
        }
        /** @type {Reference[]} */
        const references = [];
        /** @type {{ entry: bigint, name: string }[]} */
        const unlinked = [];
        const check = (/** @type {Facts} */ source) => {
            if (source.id === entry) return;
            let linkedName = null;
            for (const name of names) {
                const m = mention(source.content, name, target, this.defaults);
                if (m.linked) {
                    references.push({ entry: source.id, name, spans: m.spans });
                    linkedName = name;
                    break;
                }
                if (m.unlinked) unlinked.push({ entry: source.id, name });
            }
            if (linkedName !== null) {
                for (let i = unlinked.length - 1; i >= 0 && unlinked[i].entry === source.id; i--) unlinked.splice(i, 1);
            }
        };
        const full = () => references.length + unlinked.length >= limit;
        let last = null;
        if (candidates !== null) {
            const ids = [...candidates].filter(id => after === undefined || id > after).sort(byId);
            for (let at = 0; at < ids.length && !full(); at += PAGE) {
                for (const source of await this.facts(ids.slice(at, at + PAGE), owned)) {
                    if (full()) break;
                    check(source);
                    last = source.id;
                }
            }
            const more = last !== null && full() && ids.some(id => /** @type {bigint} */ (last) < id);
            return { references, unlinked, scanned: false, unresolved, next: more ? `i${last}` : null };
        }
        let position = from;
        for (;;) {
            const page = await this.store.worldRead('entries', { book, limit: PAGE, ...(position === undefined ? {} : { after: position }) });
            for (const source of await this.facts(page.entries.map((/** @type {any} */ p) => p.id), owned)) {
                check(source);
            }
            if (page.entries.length) position = page.entries[page.entries.length - 1].position;
            if (!page.more) return { references, unlinked, scanned: true, unresolved, next: null };
            if (full()) return { references, unlinked, scanned: true, unresolved, next: `p${position}` };
        }
    }

    /**
     * @param {bigint} book
     * @param {{ after?: number, limit?: number }} [page]
     */
    async issues(book, { after, limit = 100 } = {}) {
        const owned = await this.owned(book);
        if (owned === null) return null;
        const page = await this.store.worldRead('entries', { book, limit, ...(after === undefined ? {} : { after }) });
        const ids = page.entries.map((/** @type {any} */ p) => p.id);
        const stats = await this.store.worldRead('bookStats', { book, entries: ids });
        const average = stats.entries > 0 ? stats.bytes / stats.entries : 0;
        const size = new Map(stats.of.map((/** @type {any} */ s) => [s.entry, s.bytes]));
        const facts = await this.facts(ids, owned);
        /** @type {{ entry: bigint, issues: object[] }[]} */
        const out = [];
        for (const f of facts) {
            /** @type {object[]} */
            const issues = [];
            if (f.broken) issues.push({ kind: 'broken', why: f.broken });
            const names = f.key.map(k => k.trim()).filter(Boolean);
            if (!names.length && !f.constant) issues.push({ kind: 'never' });
            const bytes = size.get(f.id) ?? 0;
            if (stats.entries >= HEAVY_MIN_ENTRIES && bytes > HEAVY_FACTOR * average) {
                issues.push({ kind: 'heavy', bytes, average: Math.round(average), always: f.constant });
            }
            for (const name of names) {
                if (parseRegexFromString(name) || name.includes('{{')) continue;
                const found = (await this.candidates('nameCandidates', book, name)) ?? [];
                const others = (await this.facts(found.filter(id => id !== f.id), owned))
                    .filter(o => o.key.some(k => k.trim().toLowerCase() === name.toLowerCase()))
                    .map(o => o.id);
                if (others.length) issues.push({ kind: 'shared', name, with: others });
            }
            if (issues.length) out.push({ entry: f.id, issues });
        }
        const next = page.more && page.entries.length ? page.entries[page.entries.length - 1].position : null;
        return { issues: out, next };
    }

    /**
     * @param {bigint} book
     * @param {bigint[]} entries
     */
    async sizes(book, entries) {
        const s = await this.store.worldRead('bookStats', { book, entries });
        return { bytes: s.bytes, hash: s.hash, entries: s.entries, of: s.of };
    }
}
