/**
 * A search string as the engine's clauses (`Store.search`, `Store.librarySearch`): words and phrases, each over
 * some fields, maybe negated.
 *
 * Tokens are split on whitespace, but a `"quoted phrase"` (with a `label:` or `-label:` directly before it) stays
 * one token, and so does an unclosed quote with everything after it. A closed quote's phrase is `quoted`: its last
 * word is matched whole even when it ends the query; an unclosed one's last word is a prefix, as a last word is.
 * `label:value` restricts a clause to the label's fields, `-label:value` excludes what it matches; a label the
 * scope doesn't know is part of the word.
 */

/** Library fields, in the engine's `LIBRARY_FIELDS` order. */
export const LIBRARY_FIELD = Object.freeze({
    name: 0, description: 1, mes_example: 2, scenario: 3, personality: 4, first_mes: 5, creator_notes: 6,
    creator: 7, tags: 8, alternate_greetings: 9, members: 10, id: 11,
});

/** The library's labels: today's characters and groups index labels, on the engine's fields. A `tag:` clause is a
 * tag membership filter (the cards carrying a tag whose name it matches). */
export const LIBRARY_LABELS = Object.freeze({
    name: [LIBRARY_FIELD.name],
    tag: [LIBRARY_FIELD.tags],
    tags: [LIBRARY_FIELD.tags],
    desc: [LIBRARY_FIELD.description],
    description: [LIBRARY_FIELD.description],
    example: [LIBRARY_FIELD.mes_example],
    scenario: [LIBRARY_FIELD.scenario],
    personality: [LIBRARY_FIELD.personality],
    greeting: [LIBRARY_FIELD.first_mes],
    notes: [LIBRARY_FIELD.creator_notes],
    creator: [LIBRARY_FIELD.creator],
    from: [LIBRARY_FIELD.creator],
    by: [LIBRARY_FIELD.creator],
    author: [LIBRARY_FIELD.creator],
    alt: [LIBRARY_FIELD.alternate_greetings],
    alternate: [LIBRARY_FIELD.alternate_greetings],
    member: [LIBRARY_FIELD.members],
    members: [LIBRARY_FIELD.members],
    id: [LIBRARY_FIELD.id],
});

/**
 * @typedef {{ text: string, fields?: number[], negate: boolean, quoted: boolean }} Clause
 */

/**
 * @param {string} search
 * @param {Readonly<Record<string, number[]>>} [labels]
 * @returns {Clause[]}
 */
export function searchClauses(search, labels = {}) {
    const tokens = String(search ?? '').match(/[^\s"]*"[^"]*"|[^\s"]*"[^"]*$|\S+/g) ?? [];
    /** @type {Clause[]} */
    const out = [];
    for (const token of tokens) {
        const m = token.match(/^(-)?([A-Za-z][A-Za-z0-9_]*):(.+)$/s);
        const label = m && Object.hasOwn(labels, m[2].toLowerCase()) ? m[2].toLowerCase() : null;
        const raw = label && m ? m[3] : token;
        const quote = raw.indexOf('"');
        const closed = quote === 0 && raw.length >= 2 && raw.endsWith('"');
        const text = closed ? raw.slice(1, -1) : quote === 0 ? raw.slice(1) : raw;
        if (!text.trim()) continue;
        /** @type {Clause} */
        const clause = { text, negate: !!(label && m?.[1]), quoted: closed };
        if (label) clause.fields = [...labels[label]];
        out.push(clause);
    }
    return out;
}

/**
 * A cursor's weight list (`<idf>,<idf>,…`) as numbers; null when one isn't a finite number.
 * @param {string} list
 * @returns {number[] | null}
 */
export function cursorWeights(list) {
    const weights = list.split(',').map(w => (w === '' ? NaN : Number(w)));
    return weights.every(Number.isFinite) ? weights : null;
}

/**
 * The `:<idf>,<idf>,…` a cursor ends with when the engine's `next` has `weights` (each as `Number#toString` writes
 * it, which reads back exactly), else nothing.
 * @param {{ weights?: number[] }} next
 * @returns {string}
 */
export function cursorWeightsOf(next) {
    return next.weights ? `:${next.weights.join(',')}` : '';
}
