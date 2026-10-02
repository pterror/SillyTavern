// Paste: copied HTML comes in as markdown where markdown can say it, as HTML where it can't, and as plain text when
// there's no HTML or it can't be read.

import { view as cmView } from '../../live-editor-lib.js';
import { DOMPurify } from '../../lib.js';
import { renderMarkdown } from '../marked-processor.js';

const { EditorView } = cmView;

const BLOCK_TAGS = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'HR', 'TABLE', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER']);
/** Inline elements that add nothing markdown would lose; their content is kept. */
const TRANSPARENT_INLINE = new Set(['SPAN', 'FONT', 'ABBR', 'TIME', 'LABEL']);

/** @param {string} text */
function escapeInline(text) {
    return text.replace(/([\\`*_[\]<~])/g, '\\$1');
}

/**
 * Markdown for an element's inline content.
 * @param {Node} node
 * @returns {string}
 */
function inlineMarkdown(node) {
    let out = '';
    for (const child of node.childNodes) out += inlineNode(child);
    return out;
}

/**
 * @param {Node} node
 * @returns {string}
 */
function inlineNode(node) {
    if (node.nodeType === Node.TEXT_NODE) return escapeInline((node.textContent ?? '').replace(/\s+/g, ' '));
    if (!(node instanceof HTMLElement)) return '';
    const inner = () => inlineMarkdown(node);
    switch (node.tagName) {
        case 'STRONG': case 'B': return wrapInline('**', inner());
        case 'EM': case 'I': return wrapInline('*', inner());
        case 'DEL': case 'S': case 'STRIKE': return wrapInline('~~', inner());
        case 'CODE': {
            const text = node.textContent ?? '';
            const fence = text.includes('`') ? '``' : '`';
            return `${fence}${text}${fence}`;
        }
        case 'BR': return '\n';
        case 'A': {
            const href = node.getAttribute('href');
            if (!href) return inner();
            const text = inner();
            return text === escapeInline(href) ? `<${href}>` : `[${text}](${href.replace(/[()\s]/g, encodeURIComponent)})`;
        }
        case 'IMG': {
            const src = node.getAttribute('src');
            return src ? `![${escapeInline(node.getAttribute('alt') ?? '')}](${src.replace(/[()\s]/g, encodeURIComponent)})` : '';
        }
        default:
            if (TRANSPARENT_INLINE.has(node.tagName) && !node.getAttribute('style') && !node.getAttribute('class')) return inner();
            return node.outerHTML;
    }
}

/**
 * Emphasis around text, with its leading and trailing spaces outside the markers (markdown needs them there).
 * @param {string} marker
 * @param {string} text
 */
function wrapInline(marker, text) {
    const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
    if (!match || !match[2]) return text;
    return `${match[1]}${marker}${match[2]}${marker}${match[3]}`;
}

/**
 * Markdown for one block element, or null when markdown can't say it.
 * @param {HTMLElement} el
 * @returns {string | null}
 */
function blockMarkdown(el) {
    switch (el.tagName) {
        case 'P': case 'DIV': case 'SECTION': case 'ARTICLE': case 'HEADER': case 'FOOTER':
            if ([...el.children].some(c => BLOCK_TAGS.has(c.tagName))) return blocksMarkdown(el);
            return inlineMarkdown(el).trim();
        case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6':
            return `${'#'.repeat(Number(el.tagName[1]))} ${inlineMarkdown(el).trim()}`;
        case 'BLOCKQUOTE': {
            const inner = blocksMarkdown(el);
            return inner === null ? null : inner.split('\n').map(line => `> ${line}`.trimEnd()).join('\n');
        }
        case 'PRE': {
            const text = (el.textContent ?? '').replace(/\n$/, '');
            const fence = text.includes('```') ? '~~~' : '```';
            return `${fence}\n${text}\n${fence}`;
        }
        case 'HR':
            return '---';
        case 'UL': case 'OL': {
            const items = [...el.children].filter(c => c.tagName === 'LI');
            let n = Number(el.getAttribute('start') ?? 1) || 1;
            return items.map((li) => {
                const marker = el.tagName === 'OL' ? `${n++}. ` : '- ';
                const body = (blocksMarkdown(/** @type {HTMLElement} */ (li)) ?? '').trim();
                return marker + body.split('\n').join('\n' + ' '.repeat(marker.length));
            }).join('\n');
        }
        default:
            return null;
    }
}

/**
 * Markdown for a container's children: inline runs become paragraphs, block elements their own markdown, and any
 * block markdown can't say is kept as its HTML.
 * @param {Node} container
 * @returns {string}
 */
function blocksMarkdown(container) {
    /** @type {string[]} */
    const blocks = [];
    let inline = '';
    const flush = () => {
        if (inline.trim()) blocks.push(inline.trim());
        inline = '';
    };
    for (const child of container.childNodes) {
        if (child instanceof HTMLElement && BLOCK_TAGS.has(child.tagName)) {
            flush();
            const markdown = blockMarkdown(child);
            blocks.push(markdown ?? child.outerHTML);
        } else {
            inline += inlineNode(child);
        }
    }
    flush();
    return blocks.join('\n\n');
}

/** @param {string} html */
const visibleText = (html) => {
    const div = document.createElement('div');
    div.innerHTML = html;
    // Whitespace isn't compared: HTML's between elements is invisible, the render's isn't the same whitespace.
    return (div.textContent ?? '').replace(/\s+/g, '');
};

/**
 * Pasted HTML as text for the field: each block as markdown when rendering that markdown (as chat's markdown does)
 * shows the same text as the HTML did, otherwise as the HTML itself, sanitized as chat sanitizes it.
 * @param {string} html
 * @param {(text: string) => string} render
 * @returns {string}
 */
export function pastedHtmlToText(html, render) {
    const clean = DOMPurify.sanitize(html, { WHOLE_DOCUMENT: false });
    const doc = new DOMParser().parseFromString(`<body>${clean}</body>`, 'text/html');
    /** @type {string[]} */
    const out = [];
    let inline = '';
    const keep = (/** @type {string} */ markdown, /** @type {string} */ original) => {
        out.push(visibleText(render(markdown)) === visibleText(original) ? markdown : original);
    };
    const flushInline = () => {
        if (!inline.trim()) return;
        const holder = document.createElement('p');
        holder.innerHTML = inline;
        keep(inlineMarkdown(holder).trim(), inline);
        inline = '';
    };
    for (const child of doc.body.childNodes) {
        if (child instanceof HTMLElement && BLOCK_TAGS.has(child.tagName)) {
            flushInline();
            const markdown = blockMarkdown(child);
            if (markdown === null) out.push(child.outerHTML);
            else keep(markdown, child.outerHTML);
        } else {
            inline += child instanceof HTMLElement ? child.outerHTML : escapeHtml(child.textContent ?? '');
        }
    }
    flushInline();
    return out.filter(Boolean).join('\n\n');
}

/** @param {string} text */
function escapeHtml(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const bareUrl = /^(?:https?:\/\/|www\.)\S+$/i;

/**
 * @param {EditorView} view
 * @param {string} text
 */
function insert(view, text) {
    const range = view.state.selection.main;
    view.dispatch({
        changes: { from: range.from, to: range.to, insert: text },
        selection: { anchor: range.from + text.length },
        scrollIntoView: true,
        userEvent: 'input.paste',
    });
}

/**
 * @returns {import('@codemirror/state').Extension}
 */
export function livePaste() {
    return EditorView.domEventHandlers({
        paste(event, view) {
            const data = event.clipboardData;
            if (!data) return false;
            const plain = data.getData('text/plain');
            if (bareUrl.test(plain.trim()) && !/\n/.test(plain.trim())) {
                event.preventDefault();
                insert(view, `<${plain.trim()}>`);
                return true;
            }
            const html = data.getData('text/html');
            if (!html) return false;
            let text;
            try {
                text = pastedHtmlToText(html, renderMarkdown);
            } catch (error) {
                console.warn('Pasted HTML could not be read; pasting it as plain text', error);
                return false;
            }
            if (!text) return false;
            event.preventDefault();
            insert(view, text);
            return true;
        },
    });
}
