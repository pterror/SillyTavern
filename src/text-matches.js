import { searchClauses } from './search-clauses.js';

/**
 * @param {{ textMatches: (clauses: { text: string, prefix: boolean, negate: boolean }[], texts: string[]) => (number[] | null)[] }} engine
 * @param {string} search
 * @param {string[]} texts
 * @returns {(number[] | null)[]}
 */
export function textMatches(engine, search, texts) {
    const clauses = searchClauses(search);
    return engine.textMatches(clauses.map((clause, i) => ({
        text: clause.text,
        prefix: i === clauses.length - 1 && !clause.quoted,
        negate: clause.negate,
    })), texts).map(spans => spans ?? null);
}
