import { hljs } from '../../lib.js';

/**
 * @typedef {import('@pterror/interact-editor/reader').Overlay} Overlay
 * @typedef {import('@pterror/interact-editor/reader').Range} Range
 */

/** @type {Map<string, { from: number, to: number, class: string }[]>} */
const highlighted = new Map();
const KEPT = 200;

/**
 * @param {string} scope
 * @returns {string} its classes, as highlight.js's own HTML names them
 */
function classesOf(scope) {
    if (scope.startsWith('language:')) return scope.replace('language:', 'language-');
    const [first, ...rest] = scope.split('.');
    return [`hljs-${first}`, ...rest.map((part, i) => `${part}${'_'.repeat(i + 1)}`)].join(' ');
}

/**
 * @param {string} code
 * @param {string} language
 * @returns {{ from: number, to: number, class: string }[]} the highlighted spans, positions in the code
 */
function spansOf(code, language) {
    const key = `${language}\0${code}`;
    const known = highlighted.get(key);
    if (known) return known;
    const result = language && hljs.getLanguage(language)
        ? hljs.highlight(code, { language, ignoreIllegals: true })
        : hljs.highlightAuto(code);
    /** @type {{ from: number, to: number, class: string }[]} */
    const spans = [];
    let at = 0;
    /** @param {any} node */
    const visit = (node) => {
        if (typeof node === 'string') {
            at += node.length;
            return;
        }
        const from = at;
        for (const child of node.children ?? []) visit(child);
        if (node.scope && at > from) spans.push({ from, to: at, class: classesOf(node.scope) });
    };
    // @ts-ignore _emitter is the result's token tree, which the published types leave out.
    visit(result._emitter.rootNode);
    spans.sort((one, other) => one.from - other.from || other.to - one.to);
    if (highlighted.size >= KEPT) highlighted.delete(highlighted.keys().next().value);
    highlighted.set(key, spans);
    return spans;
}

/**
 * Code blocks highlighted by highlight.js, in the language their fence names or the one it finds
 * @type {Overlay}
 */
export const codeHighlighting = {
    ranges(from, to, { read, tree }) {
        /** @type {Range[]} */
        const ranges = [];
        tree.iterate({
            from,
            to,
            enter(node) {
                if (node.name !== 'FencedCode' && node.name !== 'CodeBlock') return true;
                const texts = node.node.getChildren('CodeText');
                const first = texts[0];
                const last = texts.at(-1);
                if (!first || !last) return false;
                const info = node.node.getChild('CodeInfo');
                const language = info ? read(info.from, info.to).trim().split(/\s/)[0] ?? '' : '';
                for (const span of spansOf(read(first.from, last.to), language)) {
                    ranges.push({ from: first.from + span.from, to: first.from + span.to, class: span.class });
                }
                return false;
            },
        });
        return ranges;
    },
    watch: () => () => undefined,
};
