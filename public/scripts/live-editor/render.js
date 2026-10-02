// Shows the text as chat will: every block away from the cursor is the field's own render output, and the block
// being edited is styled in place with its syntax visible only on the line being typed on.

import { state as cmState, view as cmView, language as cmLanguage, langMarkdown } from '../../live-editor-lib.js';
import { chatMarkdownExtensions } from './grammar.js';

const { StateField, StateEffect, RangeSetBuilder, Facet } = cmState;
const { EditorView, Decoration, WidgetType, ViewPlugin } = cmView;
const { ensureSyntaxTree, syntaxTree } = cmLanguage;

/**
 * The editor's language: CodeMirror's markdown support with the grammar that reads text as chat does. Its keymap,
 * HTML tag completion and URL pasting are left out; the editor's own steps provide those.
 * @param {import('./grammar.js').GrammarOptions} [options]
 */
export function chatMarkdownLanguage(options = {}) {
    return langMarkdown.markdown({
        extensions: chatMarkdownExtensions(options),
        addKeymap: false,
        completeHTMLTags: false,
        pasteURLAsLink: false,
    });
}

/**
 * @typedef {object} RenderOptions
 * @property {(text: string) => string} render The field's render function: text to the HTML chat or the preview shows.
 * @property {Record<string, string>} [emojis] Shortcodes shown as emoji, as the grammar was given them.
 */

/** The editor's render options; per editor, so two editors open at once can render differently. */
const renderOptions = Facet.define({
    combine: values => values[0] ?? { render: (/** @type {string} */ text) => text },
});

/** @type {WeakMap<Function, Map<string, string>>} Renders by text, per render function. */
const renderCaches = new WeakMap();

/**
 * @param {(text: string) => string} render
 * @returns {(text: string) => string} The same render, cached by text.
 */
function cachedRenderFor(render) {
    let cache = renderCaches.get(render);
    if (!cache) {
        cache = new Map();
        renderCaches.set(render, cache);
    }
    return (text) => {
        let html = cache.get(text);
        if (html === undefined) {
            html = render(text);
            if (cache.size >= 500) cache.clear();
            cache.set(text, html);
        }
        return html;
    };
}

/** @typedef {{ from: number, to: number }} Unit */

/** Whether the editor has focus; block decorations come from state, so focus is put there too. */
const setFocused = StateEffect.define();

/**
 * Top-level blocks, each running to the line before the next one, so blank lines between belong to the block above
 * and every unit covers whole lines.
 * @param {import('@codemirror/state').EditorState} state
 * @returns {Unit[]}
 */
function blockUnits(state) {
    const tree = ensureSyntaxTree(state, state.doc.length, 500) ?? syntaxTree(state);
    /** @type {number[]} */
    const starts = [];
    for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
        const start = state.doc.lineAt(node.from).from;
        if (starts.at(-1) !== start) starts.push(start);
    }
    if (starts.length === 0) {
        return state.doc.length > 0 ? [{ from: 0, to: state.doc.length }] : [];
    }
    starts[0] = 0;
    return starts.map((from, i) => {
        const next = starts[i + 1];
        return { from, to: next === undefined ? state.doc.length : next - 1 };
    });
}

/** @param {string} html */
const normalize = html => html.replace(/>\s+</g, '><').trim();

/**
 * Merges units until rendering each one and joining the output gives the same HTML as rendering the whole text. A
 * construct can span blocks (a reference used elsewhere, a regex script, a quote across a blank line); merged, its
 * blocks render together, as chat renders them.
 * @param {string} doc
 * @param {Unit[]} units
 * @param {(text: string) => string} render
 * @returns {{ units: Unit[], html: string[] }}
 */
function identityUnits(doc, units, render) {
    let groups = units.slice();
    const whole = normalize(render(doc));
    for (let round = 0; round < units.length; round++) {
        const html = groups.map(u => normalize(render(doc.slice(u.from, u.to))));
        if (html.join('') === whole || groups.length <= 1) {
            return { units: groups, html: groups.map(u => render(doc.slice(u.from, u.to))) };
        }
        let first = 0;
        let prefix = '';
        while (first < groups.length && whole.startsWith(prefix + html[first])) prefix += html[first++];
        let last = groups.length - 1;
        let suffix = '';
        while (last > first && whole.endsWith(html[last] + suffix)) suffix = html[last--] + suffix;
        if (first >= last) {
            first = Math.max(0, Math.min(first, groups.length - 2));
            last = first + 1;
        }
        groups = [...groups.slice(0, first), { from: groups[first].from, to: groups[last].to }, ...groups.slice(last + 1)];
    }
    return { units: groups, html: groups.map(u => render(doc.slice(u.from, u.to))) };
}

class UnitWidget extends WidgetType {
    /**
     * @param {string} html
     * @param {boolean} isLast
     * @param {Unit} unit
     */
    constructor(html, isLast, unit) {
        super();
        this.html = html;
        this.isLast = isLast;
        this.unit = unit;
    }

    /** @param {UnitWidget} other */
    eq(other) {
        return other.html === this.html && other.isLast === this.isLast;
    }

    /** @param {EditorView} view */
    toDOM(view) {
        const dom = document.createElement('div');
        dom.className = 'live-unit';
        // Outside the last unit, a hidden tail keeps the unit's last element from being its container's last child,
        // so rules like `p:last-child { margin-bottom: 0 }` apply only where they do in the whole render.
        dom.innerHTML = this.html + (this.isLast ? '' : '<span class="live-unit-tail" hidden></span>');
        dom.addEventListener('mousedown', (event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            const unit = this.unitIn(view, dom);
            const pos = sourcePosition(view.state.doc.sliceString(unit.from, unit.to), renderedOffset(dom, event)) + unit.from;
            view.focus();
            view.dispatch({ selection: { anchor: pos } });
        });
        return dom;
    }

    /**
     * The unit this widget shows now (the document may have changed since it was drawn).
     * @param {EditorView} view
     * @param {HTMLElement} dom
     * @returns {Unit}
     */
    unitIn(view, dom) {
        const from = view.posAtDOM(dom);
        const unit = view.state.field(renderField).units.find(u => u.from === from);
        return unit ?? this.unit;
    }

    ignoreEvent() {
        return true;
    }
}

class TextWidget extends WidgetType {
    /** @param {string} text */
    constructor(text) {
        super();
        this.text = text;
    }

    /** @param {TextWidget} other */
    eq(other) {
        return other.text === this.text;
    }

    toDOM() {
        const span = document.createElement('span');
        span.textContent = this.text;
        return span;
    }
}

/**
 * An image drawn after its markup, so the caret is still drawn against the text. It's the field's own render of the
 * image, so the app's rules for images (external media, sanitizing) apply as in chat.
 */
class ImageWidget extends WidgetType {
    /** @param {string} html */
    constructor(html) {
        super();
        this.html = html;
    }

    /** @param {ImageWidget} other */
    eq(other) {
        return other.html === this.html;
    }

    toDOM() {
        const span = document.createElement('span');
        span.className = 'live-image';
        // The render wraps a lone image in a paragraph; only the image is drawn here.
        span.innerHTML = this.html.trim().replace(/^<p>([\s\S]*)<\/p>$/, '$1');
        return span;
    }
}

/**
 * How many characters of the widget's shown text come before the point clicked.
 * @param {HTMLElement} dom
 * @param {MouseEvent} event
 * @returns {number}
 */
function renderedOffset(dom, event) {
    /** @type {{ node: Node, offset: number } | null} */
    let caret = null;
    // @ts-ignore Firefox
    if (document.caretPositionFromPoint) {
        // @ts-ignore
        const position = document.caretPositionFromPoint(event.clientX, event.clientY);
        if (position) caret = { node: position.offsetNode, offset: position.offset };
    } else if (document.caretRangeFromPoint) {
        const range = document.caretRangeFromPoint(event.clientX, event.clientY);
        if (range) caret = { node: range.startContainer, offset: range.startOffset };
    }
    if (!caret || !dom.contains(caret.node)) return 0;
    const range = document.createRange();
    range.setStart(dom, 0);
    range.setEnd(caret.node, caret.offset);
    return range.toString().length;
}

/**
 * The source position matching a point in the rendered text: the rendered characters are matched in order against
 * the source, skipping markup.
 * @param {string} source
 * @param {number} renderedChars
 * @returns {number}
 */
function sourcePosition(source, renderedChars) {
    let rendered = 0;
    let pos = 0;
    while (pos < source.length && rendered < renderedChars) {
        if (/[*_~`#>[\]()!\\|<]/.test(source[pos])) {
            pos++;
            continue;
        }
        rendered++;
        pos++;
    }
    return Math.min(pos, source.length);
}

/**
 * @typedef {object} RenderState
 * @property {Unit[]} units
 * @property {string[]} html
 * @property {Unit[]} editing The units shown as styled source: the ones the selection touches while focused.
 * @property {boolean} focused
 * @property {import('@codemirror/view').DecorationSet} decorations
 */

/**
 * @param {import('@codemirror/state').EditorState} state
 * @param {boolean} focused
 * @param {RenderState | null} previous
 * @param {boolean} docChanged
 * @returns {RenderState}
 */
function computeRenderState(state, focused, previous, docChanged) {
    const doc = state.doc.toString();
    const { units, html } = previous && !docChanged
        ? previous
        : identityUnits(doc, blockUnits(state), cachedRenderFor(state.facet(renderOptions).render));
    const selection = state.selection;
    const editing = focused
        ? units.filter(u => selection.ranges.some(r => r.from <= u.to && r.to >= u.from))
        : [];
    const builder = new RangeSetBuilder();
    units.forEach((unit, i) => {
        if (editing.includes(unit) || unit.from === unit.to) return;
        builder.add(unit.from, unit.to, Decoration.replace({
            widget: new UnitWidget(html[i], i === units.length - 1, unit),
            block: true,
        }));
    });
    return { units, html, editing, focused, decorations: builder.finish() };
}

const renderField = StateField.define({
    create: state => computeRenderState(state, false, null, true),
    update(value, tr) {
        let focused = value.focused;
        for (const effect of tr.effects) {
            if (effect.is(setFocused)) focused = effect.value;
        }
        if (!tr.docChanged && !tr.selection && focused === value.focused) return value;
        return computeRenderState(tr.state, focused, value, tr.docChanged);
    },
    provide: field => EditorView.decorations.from(field, value => value.decorations),
});

/** Inline nodes styled with the element chat renders for them, so theme CSS applies as in chat. */
const NODE_TAGS = {
    Emphasis: 'em', StrongEmphasis: 'strong', Strikethrough: 'del', InlineCode: 'code', DialogueQuote: 'q',
};
/** Syntax shown only on the line being typed on. */
const SYNTAX_NODES = new Set(['EmphasisMark', 'StrikethroughMark', 'CodeMark', 'HeaderMark', 'LinkMark', 'QuoteMark', 'ListMark', 'CodeInfo']);
/** A link's or image's parts after its text, shown only on the line being typed on. */
const LINK_TAIL_NODES = new Set(['URL', 'LinkTitle', 'ImageSize']);

/**
 * Styles the units being edited: chat's elements on their inline constructs, heading sizes on heading lines, and
 * syntax hidden except on the lines the selection touches.
 */
const editingStyle = ViewPlugin.fromClass(class {
    /** @param {EditorView} view */
    constructor(view) {
        this.decorations = this.build(view);
    }

    /** @param {import('@codemirror/view').ViewUpdate} update */
    update(update) {
        if (update.docChanged || update.selectionSet || update.state.field(renderField) !== update.startState.field(renderField)) {
            this.decorations = this.build(update.view);
        }
    }

    /** @param {EditorView} view */
    build(view) {
        const { editing } = view.state.field(renderField);
        if (editing.length === 0) return Decoration.none;
        const state = view.state;
        const cursorLines = new Set();
        for (const range of state.selection.ranges) {
            for (let line = state.doc.lineAt(range.from).number; line <= state.doc.lineAt(range.to).number; line++) {
                cursorLines.add(line);
            }
        }
        /** @type {import('@codemirror/state').Range<import('@codemirror/view').Decoration>[]} */
        const ranges = [];
        const tree = syntaxTree(state);
        const options = state.facet(renderOptions);
        const { emojis } = options;
        const render = cachedRenderFor(options.render);
        for (const unit of editing) {
            for (let n = state.doc.lineAt(unit.from).number; n <= state.doc.lineAt(unit.to).number; n++) {
                const line = state.doc.line(n);
                ranges.push(Decoration.line({ class: cursorLines.has(n) ? 'live-line live-cursor-line' : 'live-line' }).range(line.from));
            }
            tree.iterate({
                from: unit.from,
                to: unit.to,
                enter: (node) => {
                    const tag = NODE_TAGS[node.name];
                    if (tag && node.from < node.to) {
                        ranges.push(Decoration.mark({ tagName: tag }).range(node.from, node.to));
                    }
                    const heading = /^(?:ATX|Setext)Heading(\d)$/.exec(node.name);
                    if (heading) {
                        for (let pos = node.from; pos <= node.to;) {
                            const line = state.doc.lineAt(pos);
                            ranges.push(Decoration.line({ class: `live-heading live-heading${heading[1]}` }).range(line.from));
                            pos = line.to + 1;
                        }
                    }
                    if (node.name === 'Link' || node.name === 'Image') {
                        ranges.push(Decoration.mark({ class: 'live-link' }).range(node.from, node.to));
                    }
                    const tail = LINK_TAIL_NODES.has(node.name) && (node.node.parent?.name === 'Link' || node.node.parent?.name === 'Image');
                    if ((SYNTAX_NODES.has(node.name) || tail) && node.from < node.to) {
                        ranges.push(Decoration.mark({ class: 'live-syntax' }).range(node.from, node.to));
                    }
                    if (node.name === 'HTMLBlock' || node.name === 'HTMLTag') {
                        ranges.push(Decoration.mark({ class: 'live-html' }).range(node.from, node.to));
                    }
                    const onCursorLine = cursorLines.has(state.doc.lineAt(node.from).number);
                    if (node.name === 'Emoji' && !onCursorLine) {
                        const emoji = emojis?.[state.doc.sliceString(node.from + 1, node.to - 1)];
                        if (emoji) ranges.push(Decoration.replace({ widget: new TextWidget(emoji) }).range(node.from, node.to));
                    }
                    if (node.name === 'Image') {
                        const html = render(state.doc.sliceString(node.from, node.to));
                        ranges.push(Decoration.widget({ widget: new ImageWidget(html), side: 1 }).range(node.to));
                        if (!onCursorLine) ranges.push(Decoration.mark({ class: 'live-syntax' }).range(node.from, node.to));
                    }
                },
            });
        }
        return Decoration.set(ranges, true);
    }
}, { decorations: plugin => plugin.decorations });

/**
 * Rendering for a field: its render function off the units being edited, chat's styling in them.
 * @param {RenderOptions} options
 * @returns {import('@codemirror/state').Extension}
 */
export function liveRendering(options) {
    return [
        renderOptions.of(options),
        renderField,
        editingStyle,
        EditorView.focusChangeEffect.of((_state, focusing) => setFocused.of(focusing)),
    ];
}

export { renderField, renderOptions };
