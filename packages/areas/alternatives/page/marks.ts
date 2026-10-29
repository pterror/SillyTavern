// Marks a search's matches in a rendered row. The server says which ranges of the row's source text matched; the
// rendered text isn't the source (markdown, regex scripts), so the words those ranges cover are marked wherever they
// show. A word is what the server's search takes as one (a run of letters and digits), compared as it folds them
// (accents dropped, lowercased). Exact positions in the rendered text wait for the one markdown parser (ED31).

const WORD = /[\p{Alphabetic}\p{N}]+/gu;

/** A word as the search compares it. */
export function fold(word: string): string {
    return word.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** The words the ranges cover in the source text (flat [start, end) pairs, UTF-16). */
export function matchedWords(text: string, spans: readonly number[]): Set<string> {
    const words = new Set<string>();
    for (let i = 0; i + 1 < spans.length; i += 2) {
        for (const word of text.slice(spans[i], spans[i + 1]).match(WORD) ?? []) words.add(fold(word));
    }
    return words;
}

/** Wraps each shown word that is one of `words` in `<mark class="match">`; answers how many it marked. */
export function markWords(root: HTMLElement, words: ReadonlySet<string>): number {
    if (words.size === 0) return 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
    let marked = 0;
    for (const node of nodes) {
        const text = node.data;
        const found: [number, number][] = [];
        for (const match of text.matchAll(WORD)) {
            if (words.has(fold(match[0]))) found.push([match.index, match.index + match[0].length]);
        }
        if (found.length === 0) continue;
        const parts = document.createDocumentFragment();
        let at = 0;
        for (const [start, end] of found) {
            if (start > at) parts.append(text.slice(at, start));
            const mark = document.createElement('mark');
            mark.className = 'match';
            mark.textContent = text.slice(start, end);
            parts.append(mark);
            at = end;
        }
        if (at < text.length) parts.append(text.slice(at));
        node.replaceWith(parts);
        marked += found.length;
    }
    return marked;
}
