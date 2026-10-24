// Shows the text as written, styled as chat shows it: the markup stays visible, dimmed, so what is on screen is the
// text itself, and a click lands where the browser puts the caret in it. Images are drawn after their markup.

import { state as cmState, view as cmView, language as cmLanguage, langMarkdown } from '../../live-editor-lib.js';
import { chatMarkdownExtensions } from './grammar.js';

const { Facet } = cmState;
const { Decoration, WidgetType, ViewPlugin } = cmView;
const { syntaxTree } = cmLanguage;

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
        // The render wraps a lone image in a paragraph; only the image is drawn here.
        span.innerHTML = this.html.trim().replace(/^<p>([\s\S]*)<\/p>$/, '$1');
        return span;
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
 * Rendering for a field: chat's styling on its text, and its render function for images.
 * @param {RenderOptions} options
 * @returns {import('@codemirror/state').Extension}
 */
export function liveRendering(options) {
    return [renderOptions.of(options), textStyle];
}

export { renderOptions };
