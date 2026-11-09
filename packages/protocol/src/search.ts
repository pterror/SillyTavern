// The app's one search syntax (the card library's): words, `label:word`, `-label:word` to leave out, quotes to keep
// words together. A label names fields only when `labels` has it; any other `x:y` is a word.
export type Clause = { text: string; fields?: number[]; negate: boolean; quoted: boolean };

export type Labels = Readonly<Record<string, readonly number[]>>;

// A typed word as the syntax reads it: `label` is the label it names, if `labels` has it.
export type Token = { label: string | null; text: string; negate: boolean; quoted: boolean };

export function searchTokens(search: string, labels: Labels = {}): Token[] {
    const words = String(search).match(/[^\s"]*"[^"]*"|[^\s"]*"[^"]*$|\S+/g) ?? [];
    const tokens: Token[] = [];
    for (const word of words) {
        const labelled = /^(-)?([A-Za-z][A-Za-z0-9_]*):(.+)$/s.exec(word);
        const name = labelled?.[2]?.toLowerCase();
        const label = name !== undefined && Object.hasOwn(labels, name) ? name : null;
        const raw = label !== null && labelled?.[3] !== undefined ? labelled[3] : word;
        const closed = raw.startsWith('"') && raw.length >= 2 && raw.endsWith('"');
        const text = closed ? raw.slice(1, -1) : raw.startsWith('"') ? raw.slice(1) : raw;
        if (text.trim() === '') continue;
        tokens.push({ label, text, negate: label !== null && labelled?.[1] === '-', quoted: closed });
    }
    return tokens;
}

export function searchClauses(search: string, labels: Labels = {}): Clause[] {
    return searchTokens(search, labels).map(({ label, text, negate, quoted }) => {
        const fields = label === null ? undefined : labels[label];
        return fields === undefined ? { text, negate, quoted } : { text, negate, quoted, fields: [...fields] };
    });
}

// The token as it is typed: `searchTokens` reads it back as the same token.
export function typedToken({ label, text, negate, quoted }: Token): string {
    const word = quoted || /[\s"]/.test(text) ? `"${text.replaceAll('"', '')}"` : text;
    return label === null ? word : `${negate ? '-' : ''}${label}:${word}`;
}
