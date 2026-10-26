// Shows the text as written, styled as chat shows it: the markup stays visible, dimmed, so what is on screen is the
// text itself, and a click lands where the browser puts the caret in it. Images are drawn after their markup, an
// inline HTML element's look is on the text between its tags, and an HTML block is drawn, as chat draws it, under it.

import { state as cmState, view as cmView, language as cmLanguage, langMarkdown } from '../../live-editor-lib.js';
import { chatMarkdownExtensions } from './grammar.js';
import { DOMPurify } from '../../lib.js';

const { Facet, StateField } = cmState;
const { EditorView, Decoration, WidgetType, ViewPlugin } = cmView;
const { syntaxTree, ensureSyntaxTree } = cmLanguage;

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
        // The render wraps a lone image in a paragraph; only the image is drawn here. Sanitized here too: a field's
        // render may leave that to whoever shows it.
        span.innerHTML = DOMPurify.sanitize(this.html.trim().replace(/^<p>([\s\S]*)<\/p>$/, '$1'));
        return span;
    }
}

/**
 * An HTML block as the field renders it, under its source; it takes no clicks, so the caret stays in the text.
 */
class HtmlBlockWidget extends WidgetType {
    /** @param {string} html */
    constructor(html) {
        super();
        this.html = html;
    }

    /** @param {HtmlBlockWidget} other */
    eq(other) {
        return other.html === this.html;
    }

    toDOM() {
        const div = document.createElement('div');
        div.className = 'live-html-render';
        div.contentEditable = 'false';
        div.innerHTML = this.html;
        div.addEventListener('mousedown', event => event.preventDefault());
        return div;
    }

    ignoreEvent() {
        return true;
    }
}

/** Inline nodes styled with the element chat renders for them, so theme CSS applies as in chat. */
const NODE_TAGS = {
    Emphasis: 'em', StrongEmphasis: 'strong', Strikethrough: 'del', InlineCode: 'code', DialogueQuote: 'q',
};
/** Syntax shown only on the line being typed on. */
const SYNTAX_NODES = new Set(['EmphasisMark', 'StrikethroughMark', 'CodeMark', 'HeaderMark', 'LinkMark', 'QuoteMark', 'ListMark', 'CodeInfo']);
/** A link's or image's parts after its text, shown only on the line being typed on. */
const LINK_TAIL_NODES = new Set(['URL', 'LinkTitle', 'ImageSize']);

/** Inline HTML elements whose look is put on the text between their tags. */
const INLINE_HTML = new Set(['span', 'font', 'b', 'i', 'u', 's', 'strike', 'del', 'ins', 'em', 'strong', 'small', 'big', 'sub', 'sup', 'mark', 'q', 'code', 'kbd', 'abbr', 'cite']);

/**
 * An opening tag's element as the field renders it, sanitized: the attributes kept.
 * @param {string} tag The opening tag as written.
 * @param {string} name
 * @param {(text: string) => string} render
 * @returns {Record<string, string> | null} null when the render keeps no such element.
 */
function renderedAttributes(tag, name, render) {
    const holder = document.createElement('template');
    // Sanitized here too: a field's render may leave that to whoever shows it.
    holder.innerHTML = DOMPurify.sanitize(render(`${tag}x</${name}>`));
    const element = holder.content.querySelector(name);
    if (!element) return null;
    return Object.fromEntries([...element.attributes].map(a => [a.name, a.value]));
}

/** @type {WeakMap<Function, Map<string, Record<string, string> | null>>} */
const attributeCaches = new WeakMap();

/**
 * @param {string} tag
 * @param {string} name
 * @param {(text: string) => string} render
 */
function cachedAttributes(tag, name, render) {
    let cache = attributeCaches.get(render);
    if (!cache) {
        cache = new Map();
        attributeCaches.set(render, cache);
    }
    if (!cache.has(tag)) {
        if (cache.size >= 500) cache.clear();
        cache.set(tag, renderedAttributes(tag, name, render));
    }
    return /** @type {Record<string, string> | null} */ (cache.get(tag));
}

/** Chat's styling on the text: its elements on inline constructs, heading sizes, and the markup dimmed. */
const textStyle = ViewPlugin.fromClass(class {
    /** @param {import('@codemirror/view').EditorView} view */
    constructor(view) {
        this.decorations = this.build(view);
    }

    /** @param {import('@codemirror/view').ViewUpdate} update */
    update(update) {
        // While an IME composes, the decorations only move with the text: replacing them around the composing text
        // can break the composition.
        if (update.view.composing) {
            this.decorations = this.decorations.map(update.changes);
        } else if (update.docChanged || update.viewportChanged || syntaxTree(update.state) !== syntaxTree(update.startState)) {
            this.decorations = this.build(update.view);
        }
    }

    /** @param {import('@codemirror/view').EditorView} view */
    build(view) {
        const state = view.state;
        /** @type {import('@codemirror/state').Range<import('@codemirror/view').Decoration>[]} */
        const ranges = [];
        const tree = syntaxTree(state);
        const options = state.facet(renderOptions);
        const { emojis } = options;
        const render = cachedRenderFor(options.render);
        for (const { from, to } of view.visibleRanges) {
            /** @type {{ name: string, tag: string, to: number }[]} */
            const open = [];
            tree.iterate({
                from,
                to,
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
                    if (node.name === 'HTMLBlock' || node.name === 'HTMLTag' || node.name === 'Comment' || node.name === 'CommentBlock') {
                        ranges.push(Decoration.mark({ class: 'live-html' }).range(node.from, node.to));
                    }
                    if (node.name === 'HTMLTag') {
                        const tag = state.doc.sliceString(node.from, node.to);
                        const match = /^<(\/?)([a-z][a-z0-9]*)\b[^>]*?(\/?)>$/i.exec(tag);
                        const name = match?.[2].toLowerCase();
                        if (match && name === 'img' && !match[1]) {
                            // Drawn after its tag, as a markdown image is.
                            ranges.push(Decoration.widget({ widget: new ImageWidget(render(tag)), side: 1 }).range(node.to));
                        }
                        if (match && name && INLINE_HTML.has(name) && !match[3]) {
                            if (!match[1]) {
                                open.push({ name, tag, to: node.to });
                            } else {
                                const at = open.findLastIndex(o => o.name === name);
                                if (at >= 0) {
                                    const [opened] = open.splice(at);
                                    const attributes = cachedAttributes(opened.tag, name, render);
                                    if (attributes && opened.to < node.from) {
                                        ranges.push(Decoration.mark({ tagName: name, attributes }).range(opened.to, node.from));
                                    }
                                }
                            }
                        }
                    }
                    if (node.name === 'Emoji') {
                        const emoji = emojis?.[state.doc.sliceString(node.from + 1, node.to - 1)];
                        if (emoji) ranges.push(Decoration.widget({ widget: new TextWidget(emoji), side: 1 }).range(node.to));
                    }
                    if (node.name === 'Image') {
                        const html = render(state.doc.sliceString(node.from, node.to));
                        ranges.push(Decoration.widget({ widget: new ImageWidget(html), side: 1 }).range(node.to));
                    }
                },
            });
        }
        return Decoration.set(ranges, true);
    }
}, { decorations: plugin => plugin.decorations });

/**
 * Each HTML block drawn under its source; a comment's block too, for what follows the comment on its line (a comment
 * alone renders as nothing).
 * @param {import('@codemirror/state').EditorState} state
 * @returns {import('@codemirror/view').DecorationSet}
 */
function htmlBlockRenders(state) {
    const tree = ensureSyntaxTree(state, state.doc.length, 500) ?? syntaxTree(state);
    const render = cachedRenderFor(state.facet(renderOptions).render);
    /** @type {import('@codemirror/state').Range<import('@codemirror/view').Decoration>[]} */
    const ranges = [];
    for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
        if (node.name !== 'HTMLBlock' && node.name !== 'CommentBlock') continue;
        const html = DOMPurify.sanitize(render(state.doc.sliceString(node.from, node.to)));
        if (html.trim() === '') continue;
        ranges.push(Decoration.widget({ widget: new HtmlBlockWidget(html), block: true, side: 1 }).range(state.doc.lineAt(node.to).to));
    }
    return Decoration.set(ranges, true);
}

/** Block decorations come from state: CodeMirror takes none from a view plugin. */
const htmlBlocks = StateField.define({
    create: state => htmlBlockRenders(state),
    update(value, tr) {
        // While an IME composes, the renders only move with the text, so the composition isn't broken.
        if (tr.docChanged && tr.isUserEvent('input.type.compose')) return value.map(tr.changes);
        if (tr.docChanged || syntaxTree(tr.state) !== syntaxTree(tr.startState)) return htmlBlockRenders(tr.state);
        return value;
    },
    provide: field => EditorView.decorations.from(field),
});

/**
 * Rendering for a field: chat's styling on its text, and its render function for images and HTML blocks.
 * @param {RenderOptions} options
 * @returns {import('@codemirror/state').Extension}
 */
export function liveRendering(options) {
    return [renderOptions.of(options), textStyle, htmlBlocks];
}

export { renderOptions };
