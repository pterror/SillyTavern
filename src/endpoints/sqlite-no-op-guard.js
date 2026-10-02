/**
 * Rewrites an UPDATE, or an upsert's DO UPDATE, so it only touches rows whose values would actually change.
 *
 * SQLite counts a row as updated, fires its UPDATE triggers and dirties its pages even when every assigned value
 * equals what's stored. Every statement prepared through sqlite-engine.js passes through here, so a write that changes
 * nothing writes nothing, wherever it comes from. Each `col = expr` assignment becomes `col IS NOT (expr)` and the
 * assignments are OR-ed into the statement's WHERE (added if there is none). The expressions are evaluated against the
 * row as stored, exactly as SET evaluates them.
 *
 * Statements this doesn't recognise (anything that isn't a single INSERT/REPLACE/UPDATE, a row-value assignment, or
 * positional `?` parameters, which can't be repeated) come back unchanged.
 */

/**
 * @typedef {object} Token
 * @property {string} text
 * @property {number} depth Parenthesis depth the token sits at (an opening paren is at the depth outside it).
 * @property {boolean} code False for whitespace and comments.
 */

/**
 * @param {string} sql
 * @returns {Token[] | null} null if the text can't be tokenized (an unterminated string or comment).
 */
function tokenize(sql) {
    /** @type {Token[]} */
    const tokens = [];
    let depth = 0;
    let i = 0;
    const push = (text, code) => tokens.push({ text, depth, code });
    while (i < sql.length) {
        const c = sql[i];
        const rest = sql.slice(i);
        if (/\s/.test(c)) {
            const m = /^\s+/.exec(rest);
            push(m[0], false);
            i += m[0].length;
        } else if (rest.startsWith('--')) {
            const end = sql.indexOf('\n', i);
            const text = end === -1 ? rest : sql.slice(i, end);
            push(text, false);
            i += text.length;
        } else if (rest.startsWith('/*')) {
            const end = sql.indexOf('*/', i + 2);
            if (end === -1) return null;
            push(sql.slice(i, end + 2), false);
            i = end + 2;
        } else if (c === '\'' || c === '"' || c === '`' || c === '[') {
            const close = c === '[' ? ']' : c;
            let j = i + 1;
            for (;;) {
                const k = sql.indexOf(close, j);
                if (k === -1) return null;
                if (close !== ']' && sql[k + 1] === close) {
                    j = k + 2;
                    continue;
                }
                j = k + 1;
                break;
            }
            push(sql.slice(i, j), true);
            i = j;
        } else if (c === '(') {
            push(c, true);
            depth++;
            i++;
        } else if (c === ')') {
            depth--;
            if (depth < 0) return null;
            push(c, true);
            i++;
        } else {
            const m = /^(?:[A-Za-z_][A-Za-z0-9_]*|[@:$?][A-Za-z0-9_]*|\d+(?:\.\d+)?|==|!=|<>|<=|>=|\|\||[^\sA-Za-z0-9_'"`[()])/.exec(rest);
            push(m[0], true);
            i += m[0].length;
        }
    }
    return depth === 0 ? tokens : null;
}

/** @param {Token} t @param {string} word */
const isWord = (t, word) => t.code && t.depth === 0 && t.text.toUpperCase() === word;

/**
 * Index of the next depth-0 code token from `from` that is one of `words`, or `tokens.length`.
 * @param {Token[]} tokens
 * @param {number} from
 * @param {string[]} words
 */
function findWord(tokens, from, words) {
    for (let i = from; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.code && t.depth === 0 && words.includes(t.text.toUpperCase())) return i;
    }
    return tokens.length;
}

/** @param {Token[]} tokens @param {number} from */
function nextCode(tokens, from) {
    for (let i = from; i < tokens.length; i++) if (tokens[i].code) return i;
    return tokens.length;
}

/** @param {Token[]} tokens @param {number} start @param {number} end */
const text = (tokens, start, end) => tokens.slice(start, end).map(t => t.text).join('');

/**
 * Splits a SET list into `{ target, expr }` pairs, or null for anything but plain `column = expr` assignments.
 * @param {Token[]} tokens
 * @param {number} start First token after SET.
 * @param {number} end Token the list ends at.
 * @returns {{ target: string, expr: string }[] | null}
 */
function assignments(tokens, start, end) {
    /** @type {{ target: string, expr: string }[]} */
    const out = [];
    let itemStart = start;
    for (let i = start; i <= end; i++) {
        const atEnd = i === end || (tokens[i].code && tokens[i].depth === 0 && tokens[i].text === ',');
        if (!atEnd) continue;
        let eq = -1;
        for (let k = itemStart; k < i; k++) {
            if (tokens[k].code && tokens[k].depth === 0 && tokens[k].text === '=') {
                eq = k;
                break;
            }
        }
        if (eq === -1) return null;
        const target = text(tokens, itemStart, eq).trim();
        const expr = text(tokens, eq + 1, i).trim();
        if (!target || !expr || target.startsWith('(')) return null;
        out.push({ target, expr });
        itemStart = i + 1;
    }
    return out.length > 0 ? out : null;
}

/**
 * @param {{ target: string, expr: string }[]} list
 * @param {string} [qualifier] Prefix for the targets, so they can't be ambiguous next to a FROM.
 */
function guardFor(list, qualifier) {
    const parts = list.map(({ target, expr }) => `${qualifier ? `${qualifier}.${target}` : target} IS NOT (${expr})`);
    return parts.length === 1 ? parts[0] : `(${parts.join(' OR ')})`;
}

/** @param {string} t @returns {Token} */
const tok = t => ({ text: t, depth: 0, code: true });

/**
 * Adds `WHERE guard` at `at`.
 * @param {Token[]} tokens
 * @param {number} at
 * @param {string} guard
 * @returns {Token[]}
 */
function addWhere(tokens, at, guard) {
    return [...tokens.slice(0, at), tok(` WHERE ${guard} `), ...tokens.slice(at)];
}

/**
 * ANDs the guard onto the WHERE at `whereAt`, whose condition ends before `whereEnd`.
 * @param {Token[]} tokens
 * @param {number} whereAt
 * @param {number} whereEnd
 * @param {string} guard
 * @returns {Token[]}
 */
function andWhere(tokens, whereAt, whereEnd, guard) {
    return [
        ...tokens.slice(0, whereAt + 1),
        tok(' ('),
        ...tokens.slice(whereAt + 1, whereEnd),
        tok(`) AND ${guard} `),
        ...tokens.slice(whereEnd),
    ];
}

/**
 * Skips a leading `WITH ...` clause.
 * @param {Token[]} tokens
 * @param {number} i Index of WITH.
 * @returns {number} Index of the statement keyword after the CTEs.
 */
function skipWith(tokens, i) {
    // Every CTE body is a depth-0 "(" ... ")"; the main statement keyword is the first depth-0 keyword after a
    // closing paren that isn't followed by a comma.
    for (let k = i + 1; k < tokens.length; k++) {
        const t = tokens[k];
        if (!t.code || t.depth !== 0) continue;
        if (['INSERT', 'REPLACE', 'UPDATE', 'DELETE', 'SELECT'].includes(t.text.toUpperCase())) {
            const prev = tokens.slice(0, k).reverse().find(p => p.code);
            if (prev && prev.text === ')') return k;
        }
    }
    return tokens.length;
}

/**
 * @param {Token[]} tokens
 * @param {number} kw Index of UPDATE.
 * @returns {Token[] | null}
 */
function guardUpdate(tokens, kw) {
    let i = nextCode(tokens, kw + 1);
    if (i < tokens.length && isWord(tokens[i], 'OR')) i = nextCode(tokens, nextCode(tokens, i + 1) + 1);
    // Table name, possibly schema-qualified and aliased.
    if (i >= tokens.length) return null;
    let name = tokens[i].text;
    let j = nextCode(tokens, i + 1);
    if (tokens[j]?.text === '.') {
        name = tokens[nextCode(tokens, j + 1)]?.text;
        j = nextCode(tokens, nextCode(tokens, j + 1) + 1);
    }
    let alias = name;
    if (j < tokens.length && isWord(tokens[j], 'AS')) {
        alias = tokens[nextCode(tokens, j + 1)].text;
    }
    const set = findWord(tokens, kw + 1, ['SET']);
    if (set === tokens.length) return null;
    const setEnd = findWord(tokens, set + 1, ['FROM', 'WHERE', 'RETURNING', 'ORDER', 'LIMIT']);
    const list = assignments(tokens, set + 1, setEnd);
    if (!list) return null;
    const hasFrom = setEnd < tokens.length && isWord(tokens[setEnd], 'FROM');
    const where = findWord(tokens, setEnd, ['WHERE']);
    const whereEnd = where === tokens.length ? -1 : findWord(tokens, where + 1, ['RETURNING', 'ORDER', 'LIMIT']);
    const guard = guardFor(list, hasFrom ? alias : undefined);
    if (where === tokens.length) {
        return addWhere(tokens, findWord(tokens, setEnd, ['RETURNING', 'ORDER', 'LIMIT']), guard);
    }
    return andWhere(tokens, where, whereEnd, guard);
}

/**
 * @param {Token[]} tokens
 * @returns {Token[] | null}
 */
function guardUpserts(tokens) {
    let out = tokens;
    let changed = false;
    for (let i = 0; i < out.length; i++) {
        if (!isWord(out[i], 'DO')) continue;
        const u = nextCode(out, i + 1);
        if (!out[u] || !isWord(out[u], 'UPDATE')) continue;
        const set = nextCode(out, u + 1);
        if (!out[set] || !isWord(out[set], 'SET')) continue;
        const setEnd = findWord(out, set + 1, ['WHERE', 'ON', 'RETURNING']);
        const list = assignments(out, set + 1, setEnd);
        if (!list) return null;
        const guard = guardFor(list);
        out = setEnd < out.length && isWord(out[setEnd], 'WHERE')
            ? andWhere(out, setEnd, findWord(out, setEnd + 1, ['ON', 'RETURNING']), guard)
            : addWhere(out, setEnd, guard);
        changed = true;
        i = set;
    }
    return changed ? out : null;
}

/**
 * @param {string} sql
 * @returns {string} The guarded statement, or `sql` itself when there is nothing to guard.
 */
export function guardNoOpWrites(sql) {
    if (!/\bUPDATE\b/i.test(sql)) return sql;
    const tokenized = tokenize(sql);
    if (!tokenized) return sql;
    // Positional parameters can't appear twice, so a statement using them is left as written (the stores bind named
    // parameters throughout).
    if (tokenized.some(t => t.code && /^\?\d*$/.test(t.text))) return sql;
    // Comments go: a `--` comment would swallow anything appended after it.
    const tokens = tokenized.map(t => (t.code || /^\s+$/.test(t.text) ? t : { ...t, text: ' ' }));
    const code = tokens.filter(t => t.code);
    // A single statement only (a trailing semicolon is fine).
    const semi = code.findIndex(t => t.text === ';' && t.depth === 0);
    if (semi !== -1 && semi !== code.length - 1) return sql;
    let kw = nextCode(tokens, 0);
    if (kw === tokens.length) return sql;
    if (isWord(tokens[kw], 'WITH')) kw = skipWith(tokens, kw);
    if (kw === tokens.length) return sql;
    const word = tokens[kw].text.toUpperCase();
    /** @type {Token[] | null} */
    let guarded = null;
    if (word === 'UPDATE') guarded = guardUpdate(tokens, kw);
    else if (word === 'INSERT' || word === 'REPLACE') guarded = guardUpserts(tokens);
    return guarded ? guarded.map(t => t.text).join('') : sql;
}
