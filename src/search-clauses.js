export const LIBRARY_FIELD = Object.freeze({
    name: 0, description: 1, mes_example: 2, scenario: 3, personality: 4, first_mes: 5, creator_notes: 6,
    creator: 7, tags: 8, alternate_greetings: 9, members: 10, id: 11,
});

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

/** @typedef {{ text: string, fields?: number[], negate: boolean, quoted: boolean }} Clause */

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
 * @param {string} list
 * @returns {number[] | null}
 */
export function cursorWeights(list) {
    const weights = list.split(',').map(w => (w === '' ? NaN : Number(w)));
    return weights.every(Number.isFinite) ? weights : null;
}

/**
 * @param {{ weights?: number[] }} next
 * @returns {string}
 */
export function cursorWeightsOf(next) {
    return next.weights ? `:${next.weights.join(',')}` : '';
}
