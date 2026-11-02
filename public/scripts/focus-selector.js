const TRANSPARENT = new Set(['is', 'where', 'has', 'not']);

/**
 * @param {string} text
 * @param {number} from
 * @returns {number}
 */
function closingParen(text, from) {
    let depth = 0;
    for (let i = from; i < text.length; i++) {
        const c = text[i];
        if (c === '\\') { i++; continue; }
        if (c === '"' || c === '\'') {
            const end = text.indexOf(c, i + 1);
            if (end < 0) return -1;
            i = end;
            continue;
        }
        if (c === '(') depth++;
        else if (c === ')' && --depth === 0) return i;
    }
    return -1;
}

/**
 * @param {string} text
 * @returns {string[]}
 */
export function splitSelectorList(text) {
    const parts = [];
    let depth = 0;
    let bracket = 0;
    let start = 0;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === '\\') { i++; continue; }
        if (c === '"' || c === '\'') {
            const end = text.indexOf(c, i + 1);
            i = end < 0 ? text.length : end;
            continue;
        }
        if (c === '(') depth++;
        else if (c === ')') depth--;
        else if (c === '[') bracket++;
        else if (c === ']') bracket--;
        else if (c === ',' && depth === 0 && bracket === 0) {
            parts.push(text.slice(start, i).trim());
            start = i + 1;
        }
    }
    parts.push(text.slice(start).trim());
    return parts.filter(Boolean);
}

/**
 * @param {string} selector
 * @param {boolean} negated
 * @returns {{ text: string, positive: number } | null}
 */
function rewrite(selector, negated) {
    let out = '';
    let positive = 0;
    for (let i = 0; i < selector.length; i++) {
        const c = selector[i];
        if (c === '\\') { out += selector.slice(i, i + 2); i++; continue; }
        if (c === '"' || c === '\'') {
            const end = selector.indexOf(c, i + 1);
            if (end < 0) return null;
            out += selector.slice(i, end + 1);
            i = end;
            continue;
        }
        if (c === '[') {
            const end = selector.indexOf(']', i);
            if (end < 0) return null;
            out += selector.slice(i, end + 1);
            i = end;
            continue;
        }
        if (c !== ':' || selector[i + 1] === ':') {
            if (c === ':') { out += '::'; i++; continue; }
            out += c;
            continue;
        }
        const name = /^[\w-]+/.exec(selector.slice(i + 1))?.[0] ?? '';
        const after = i + 1 + name.length;
        if (selector[after] !== '(') {
            if (name.toLowerCase() === 'hover') {
                out += ':focus-visible';
                if (!negated) positive++;
            } else {
                out += ':' + name;
            }
            i = after - 1;
            continue;
        }
        const end = closingParen(selector, after);
        if (end < 0) return null;
        const inner = selector.slice(after + 1, end);
        const lower = name.toLowerCase();
        if (!/:hover(?![\w-])/i.test(inner)) {
            out += selector.slice(i, end + 1);
        } else if (TRANSPARENT.has(lower)) {
            const parts = splitSelectorList(inner).map(part => rewrite(part, lower === 'not' ? !negated : negated));
            if (parts.some(part => part === null)) return null;
            out += `:${name}(${parts.map(part => part.text).join(', ')})`;
            positive += parts.reduce((sum, part) => sum + part.positive, 0);
        } else {
            return null;
        }
        i = end;
    }
    return { text: out, positive };
}

/**
 * @param {string} selector
 * @returns {string | null}
 */
export function focusCounterpart(selector) {
    const result = rewrite(selector, false);
    if (!result || result.positive === 0) return null;
    return result.text;
}
