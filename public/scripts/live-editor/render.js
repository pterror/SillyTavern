import { state as cmState, view as cmView, language as cmLanguage, langMarkdown } from '../../live-editor-lib.js';
import { chatMarkdownExtensions } from './grammar.js';
import { DOMPurify } from '../../lib.js';

const { Facet, StateField } = cmState;
const { EditorView, Decoration, WidgetType, ViewPlugin, BlockWrapper } = cmView;
const { syntaxTree, ensureSyntaxTree } = cmLanguage;

/**
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
 * @property {(text: string) => string} render
 * @property {Record<string, string>} [emojis]
 */

const renderOptions = Facet.define({
    combine: values => values[0] ?? { render: (/** @type {string} */ text) => text },
});

/** @type {WeakMap<Function, Map<string, string>>} */
const renderCaches = new WeakMap();

/**
 * @param {(text: string) => string} render
 * @returns {(text: string) => string}
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
        span.innerHTML = DOMPurify.sanitize(this.html.trim().replace(/^<p>([\s\S]*)<\/p>$/, '$1'));
        return span;
    }
}

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

const NODE_TAGS = {
    Emphasis: 'em', StrongEmphasis: 'strong', Strikethrough: 'del', InlineCode: 'code', DialogueQuote: 'q',
};
const SYNTAX_NODES = new Set(['EmphasisMark', 'StrikethroughMark', 'CodeMark', 'HeaderMark', 'LinkMark', 'QuoteMark', 'ListMark', 'CodeInfo']);
const LINK_TAIL_NODES = new Set(['URL', 'LinkTitle', 'ImageSize']);

const INLINE_HTML = new Set(['span', 'font', 'b', 'i', 'u', 's', 'strike', 'del', 'ins', 'em', 'strong', 'small', 'big', 'sub', 'sup', 'mark', 'q', 'code', 'kbd', 'abbr', 'cite']);

/**
 * @param {string} tag
 * @param {string} name
 * @param {(text: string) => string} render
 * @returns {Record<string, string> | null}
 */
function renderedAttributes(tag, name, render) {
    const holder = document.createElement('template');
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

const textStyle = ViewPlugin.fromClass(class {
    /** @param {import('@codemirror/view').EditorView} view */
    constructor(view) {
        this.decorations = this.build(view);
    }

    /** @param {import('@codemirror/view').ViewUpdate} update */
    update(update) {
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

const htmlBlocks = StateField.define({
    create: state => htmlBlockRenders(state),
    update(value, tr) {
        if (tr.docChanged && tr.isUserEvent('input.type.compose')) return value.map(tr.changes);
        if (tr.docChanged || syntaxTree(tr.state) !== syntaxTree(tr.startState)) return htmlBlockRenders(tr.state);
        return value;
    },
    provide: field => EditorView.decorations.from(field),
});

const BLOCK_CONTAINERS = new Set(['Blockquote', 'BulletList', 'OrderedList', 'ListItem']);

/**
 * @param {string} name
 * @returns {string | null}
 */
function chatBlockTag(name) {
    if (name === 'Blockquote') return 'blockquote';
    const heading = /^(?:ATX|Setext)Heading(\d)$/.exec(name);
    return heading ? `h${heading[1]}` : null;
}

/** @type {Map<string, import('@codemirror/view').BlockWrapper>} */
const chatBlockWrappers = new Map();

/**
 * @param {string} tagName
 * @param {number} depth
 */
function chatBlockWrapper(tagName, depth) {
    const rank = Math.max(0, 100 - depth);
    const key = `${tagName} ${rank}`;
    let wrapper = chatBlockWrappers.get(key);
    if (!wrapper) {
        wrapper = BlockWrapper.create({ tagName, attributes: { class: 'live-block' }, rank });
        chatBlockWrappers.set(key, wrapper);
    }
    return wrapper;
}

/**
 * @param {import('@codemirror/state').EditorState} state
 * @returns {import('@codemirror/state').RangeSet<import('@codemirror/view').BlockWrapper>}
 */
function chatBlocks(state) {
    const tree = ensureSyntaxTree(state, state.doc.length, 500) ?? syntaxTree(state);
    /** @type {import('@codemirror/state').Range<import('@codemirror/view').BlockWrapper>[]} */
    const ranges = [];
    /**
     * @param {import('@lezer/common').SyntaxNode} parent
     * @param {number} depth
     */
    const visit = (parent, depth) => {
        for (let node = parent.firstChild; node; node = node.nextSibling) {
            const tagName = chatBlockTag(node.name);
            if (tagName) ranges.push(chatBlockWrapper(tagName, depth).range(state.doc.lineAt(node.from).from, node.to));
            if (BLOCK_CONTAINERS.has(node.name)) visit(node, depth + 1);
        }
    };
    visit(tree.topNode, 0);
    return BlockWrapper.set(ranges, true);
}

const blockElements = StateField.define({
    create: state => chatBlocks(state),
    update(value, tr) {
        if (tr.docChanged && tr.isUserEvent('input.type.compose')) return value.map(tr.changes);
        if (tr.docChanged || syntaxTree(tr.state) !== syntaxTree(tr.startState)) return chatBlocks(tr.state);
        return value;
    },
    provide: field => EditorView.blockWrappers.from(field),
});

/**
 * @param {RenderOptions} options
 * @returns {import('@codemirror/state').Extension}
 */
export function liveRendering(options) {
    return [renderOptions.of(options), textStyle, htmlBlocks, blockElements];
}

export { renderOptions };
