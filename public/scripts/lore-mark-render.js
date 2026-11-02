const BASE = 0xE000;
export const MAX_MARKED_SPANS = 3200;
const SENTINEL = /[-]|%E[EF]%[89AB][0-9A-F]%[89AB][0-9A-F]/i;
const SENTINELS = /[-]|%E[EF]%[89AB][0-9A-F]%[89AB][0-9A-F]/gi;

/**
 * @param {string} found a sentinel, raw or percent-encoded
 * @returns {number}
 */
const codeOf = found => (found.length === 1 ? found.charCodeAt(0) : decodeURIComponent(found).charCodeAt(0));

/** @param {number} code */
const isSentinel = code => code >= BASE && code <= 0xF8FF;

/** @param {string} s */
const stripSentinels = s => s.replace(SENTINELS, found => (isSentinel(codeOf(found)) ? '' : found));
const UNWRAPPABLE = 'style, script, textarea, noscript, title, svg, math, custom-style';

/**
 * @typedef {{ from: number, to: number, entries: number[] }} MarkSpan
 */

/**
 * @param {string} text
 * @param {MarkSpan[]} spans
 * @returns {string}
 */
function withSentinels(text, spans) {
    /** @type {[number, number, number][]} */
    const cuts = [];
    spans.forEach((span, i) => {
        cuts.push([span.from, BASE + 2 * i, 1], [span.to, BASE + 2 * i + 1, 0]);
    });
    cuts.sort((a, b) => a[0] - b[0] || a[2] - b[2]);
    let out = '';
    let at = 0;
    for (const [position, code] of cuts) {
        out += text.slice(at, position) + String.fromCharCode(code);
        at = position;
    }
    return out + text.slice(at);
}

/**
 * @param {number} code
 * @returns {{ span: number, start: boolean }}
 */
const boundary = code => ({ span: (code - BASE) >> 1, start: ((code - BASE) & 1) === 0 });

/**
 * Renders text with the given spans of it marked, or exactly as `render` would without them.
 * @param {string} text
 * @param {MarkSpan[]} spans offsets into `text`
 * @param {(text: string) => string} render
 * @param {Document} doc
 * @param {Record<string, string>} [attributes] set on every mark
 * @returns {{ html: string, drawn: number }}
 */
export function renderMarked(text, spans, render, doc, attributes = {}) {
    const clean = render(text);
    const usable = spans.filter(s => Number.isInteger(s.from) && Number.isInteger(s.to) && s.from >= 0 && s.to <= text.length && s.to > s.from)
        .slice(0, MAX_MARKED_SPANS);
    if (!usable.length || SENTINEL.test(text)) return { html: clean, drawn: 0 };
    const marked = render(withSentinels(text, usable));
    if (stripSentinels(marked) !== clean) return { html: clean, drawn: 0 };

    const template = doc.createElement('template');
    template.innerHTML = marked;
    const root = template.content;
    /** @type {Set<number>} */
    const bad = new Set();

    const elements = doc.createTreeWalker(root, 1);
    for (let el = /** @type {Element | null} */ (elements.nextNode()); el; el = /** @type {Element | null} */ (elements.nextNode())) {
        for (const attribute of [...el.attributes]) {
            if (!SENTINEL.test(attribute.value)) continue;
            for (const found of attribute.value.match(SENTINELS) ?? []) {
                const code = codeOf(found);
                if (isSentinel(code)) bad.add(boundary(code).span);
            }
            el.setAttribute(attribute.name, stripSentinels(attribute.value));
        }
    }

    /** @type {Text[]} */
    const texts = [];
    const walker = doc.createTreeWalker(root, 4);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) texts.push(/** @type {Text} */ (node));
    const wrappable = (/** @type {Text} */ node) => !node.parentElement?.closest(UNWRAPPABLE);

    /** @type {Set<number>} */
    const open = new Set();
    for (const node of texts) {
        const inside = wrappable(node);
        if (!inside) open.forEach(span => bad.add(span));
        for (const char of node.data) {
            const code = char.charCodeAt(0);
            if (code < BASE || code > 0xF8FF) continue;
            const { span, start } = boundary(code);
            if (!inside) bad.add(span);
            if (start) open.add(span); else open.delete(span);
        }
    }
    open.forEach(span => bad.add(span));

    let drawn = 0;
    /** @type {Set<number>} */
    const active = new Set();
    for (const node of texts) {
        if (!SENTINEL.test(node.data) && active.size === 0) continue;
        if (!wrappable(node)) {
            node.data = stripSentinels(node.data);
            continue;
        }
        /** @type {Node[]} */
        const parts = [];
        let run = '';
        const flush = () => {
            if (!run) return;
            const live = [...active].filter(span => !bad.has(span));
            if (live.length === 0) {
                parts.push(doc.createTextNode(run));
            } else {
                const mark = doc.createElement('span');
                mark.className = 'lore-mark';
                const entries = [...new Set(live.flatMap(span => usable[span].entries))].sort((a, b) => a - b);
                mark.setAttribute('data-lore', entries.join(' '));
                for (const [name, value] of Object.entries(attributes)) mark.setAttribute(name, value);
                mark.textContent = run;
                parts.push(mark);
            }
            run = '';
        };
        for (const char of node.data) {
            const code = char.charCodeAt(0);
            if (code < BASE || code > 0xF8FF) {
                run += char;
                continue;
            }
            flush();
            const { span, start } = boundary(code);
            if (start) {
                active.add(span);
                if (!bad.has(span)) drawn++;
            } else {
                active.delete(span);
            }
        }
        flush();
        node.replaceWith(...parts);
    }
    if (drawn === 0) return { html: clean, drawn: 0 };
    return { html: template.innerHTML, drawn };
}
