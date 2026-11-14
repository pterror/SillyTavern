// A key written as a pattern: /…/ with flags, as the engine matches keys (`parseRegexFromString`).
export const isPattern = (key: string): boolean => {
    const match = /^\/([\w\W]+?)\/([gimsuy]*)$/.exec(key);
    if (!match || /(^|[^\\])\//.test(match[1] ?? '')) return false;
    try {
        new RegExp((match[1] ?? '').replace('\\/', '/'), match[2]);
        return true;
    } catch {
        return false;
    }
};

const CLOSED = /^\/[\w\W]*[^\\]\/[gimsuy]*$/;

// The keys written in `text`: separated by commas or lines, trimmed, none empty or repeated. A comma inside a pattern
// does not separate; a word starting with a slash that is no pattern is split at its commas as any other.
export function splitKeys(text: string): string[] {
    const keys: string[] = [];
    for (const line of text.split(/\r?\n/)) {
        let word = '';
        let inPattern = false;
        const end = () => {
            const key = word.trim();
            word = '';
            inPattern = false;
            if (key !== '') keys.push(key);
        };
        for (const char of line) {
            if (char === ',' && !inPattern) {
                end();
                continue;
            }
            word += char;
            const trimmed = word.trimStart();
            inPattern = trimmed.startsWith('/') && !CLOSED.test(trimmed);
        }
        end();
    }
    return [...new Set(keys)].flatMap((key) => (isPattern(key) || !key.startsWith('/') ? [key] : splitUnclosed(key)));
}

// A word that opens a pattern and never closes it is only words with commas.
function splitUnclosed(word: string): string[] {
    return word
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part !== '');
}
