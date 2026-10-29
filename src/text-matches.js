import { searchClauses } from './search-clauses.js';

/**
 * Which texts a search matches, as the chat search reads the search (`searchClauses()`: quoted phrases, `-` to
 * leave out) and takes its words (the engine's tokens and folding), and what in each it matched.
 * @param {{ textMatches: (clauses: { text: string, prefix: boolean, negate: boolean }[], texts: string[]) => (number[] | null)[] }} engine
 * The engine's binding (native or wasm).
 * @param {string} search
 * @param {string[]} texts
 * @returns {(number[] | null)[]} Each text's matched ranges ([start, end) pairs, flat, UTF-16), null where it doesn't
 * match.
 */
export function textMatches(engine, search, texts) {
    const clauses = searchClauses(search);
    // The chat search's rule: the last word of the last clause, unquoted, is a prefix of a word.
    return engine.textMatches(clauses.map((clause, i) => ({
        text: clause.text,
        prefix: i === clauses.length - 1 && !clause.quoted,
        negate: clause.negate,
    })), texts).map(spans => spans ?? null);
}
