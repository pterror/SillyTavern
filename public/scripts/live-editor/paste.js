// Paste: copied HTML comes in as markdown where markdown can say it, as HTML where it can't, and as plain text when
// there's no HTML or it can't be read. After a paste that could have gone in more than one way, a small button at
// its end shows how it went in and switches it to another way.

import { state as cmState, view as cmView, commands as cmCommands } from '../../live-editor-lib.js';
import { DOMPurify } from '../../lib.js';
import { renderMarkdown } from '../marked-processor.js';
import { t } from '../i18n.js';

const { StateField, StateEffect, Transaction, Prec } = cmState;
const { EditorView, showTooltip, keymap } = cmView;
const { invertedEffects } = cmCommands;

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

/** @typedef {'markdown' | 'html' | 'plain'} PasteMode */

/** The ways a paste can go in, in the order the picker lists and the key cycles them. */
const PASTE_MODES = /** @type {PasteMode[]} */ (['markdown', 'html', 'plain']);

/** @param {PasteMode} mode */
const modeLabel = (mode) => ({
    markdown: t`Keep formatting`,
    html: t`Keep as HTML`,
    plain: t`Text only`,
})[mode];

/**
 * The paste the picker is for: where it is now, how it went in, and its text in each way it can go in.
 * @typedef {object} PasteChoice
 * @property {number} from
 * @property {number} to
 * @property {PasteMode} mode
 * @property {PasteMode[]} modes The ways this paste can go in, each with its own text.
 * @property {Partial<Record<PasteMode, string>>} texts
 * @property {boolean} menu Whether the list of ways is open.
 */

/** Sets (or, with null, clears) the paste the picker is for. Positions are in the document after the transaction. */
const setPasteChoice = StateEffect.define({
    map: (/** @type {PasteChoice | null} */ value, mapping) => value && { ...value, from: mapping.mapPos(value.from, -1), to: mapping.mapPos(value.to, 1) },
});

/** @type {import('@codemirror/state').StateField<PasteChoice | null>} */
const pasteChoiceField = StateField.define({
    create: () => null,
    update(value, tr) {
        for (const effect of tr.effects) {
            if (effect.is(setPasteChoice)) return effect.value;
        }
        // Any other edit, here or anywhere else, ends the choice: the pasted text may no longer be what was pasted.
        if (tr.docChanged) return null;
        return value;
    },
    provide: field => showTooltip.from(field, value => (value ? pickerTooltip(value) : null)),
});

/**
 * @param {PasteChoice} choice
 * @returns {import('@codemirror/view').Tooltip}
 */
function pickerTooltip(choice) {
    return {
        pos: choice.to,
        above: false,
        strictSide: false,
        arrow: false,
        create: (view) => ({ dom: pickerDom(view, choice) }),
    };
}

/**
 * The picker: a small button showing how the paste went in, and, when opened, the ways it can go in.
 * @param {EditorView} view
 * @param {PasteChoice} choice
 * @returns {HTMLElement}
 */
function pickerDom(view, choice) {
    const dom = document.createElement('div');
    dom.className = 'live-paste-picker';
    // Clicks here mustn't take focus out of the editor, so typing goes on where it was.
    dom.addEventListener('mousedown', event => event.preventDefault());

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'live-paste-picker-toggle';
    toggle.title = t`Paste options: change how the pasted text went in (Ctrl+Alt+V)`;
    toggle.setAttribute('aria-haspopup', 'menu');
    toggle.setAttribute('aria-expanded', String(choice.menu));
    toggle.innerHTML = '<i class="fa-solid fa-paste" aria-hidden="true"></i><span class="live-paste-picker-mode"></span><i class="fa-solid fa-caret-down" aria-hidden="true"></i>';
    /** @type {HTMLElement} */ (toggle.querySelector('.live-paste-picker-mode')).textContent = modeLabel(choice.mode);
    toggle.addEventListener('click', () => {
        const current = view.state.field(pasteChoiceField, false);
        if (current) view.dispatch({ effects: setPasteChoice.of({ ...current, menu: !current.menu }), annotations: Transaction.addToHistory.of(false) });
    });
    dom.append(toggle);

    if (choice.menu) {
        const menu = document.createElement('div');
        menu.className = 'live-paste-picker-menu';
        menu.setAttribute('role', 'menu');
        for (const mode of choice.modes) {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'live-paste-picker-item';
            item.dataset.mode = mode;
            item.setAttribute('role', 'menuitemradio');
            item.setAttribute('aria-checked', String(mode === choice.mode));
            item.textContent = modeLabel(mode);
            item.addEventListener('click', () => switchPasteMode(view, mode));
            menu.append(item);
        }
        dom.append(menu);
    }
    return dom;
}

/**
 * Replaces the pasted text with its text for another way it can go in, as one change (one undo).
 * @param {EditorView} view
 * @param {PasteMode} mode
 * @returns {boolean} Whether there was a paste to switch.
 */
function switchPasteMode(view, mode) {
    const choice = view.state.field(pasteChoiceField, false);
    if (!choice) return false;
    const text = choice.texts[mode];
    if (text === undefined) return false;
    const to = choice.from + text.length;
    view.dispatch({
        changes: { from: choice.from, to: choice.to, insert: text },
        selection: { anchor: to },
        effects: setPasteChoice.of({ ...choice, to, mode, menu: false }),
        scrollIntoView: true,
        userEvent: 'input.paste',
    });
    return true;
}

/**
 * @param {EditorView} view
 * @returns {boolean}
 */
function cyclePasteMode(view) {
    const choice = view.state.field(pasteChoiceField, false);
    if (!choice) return false;
    const next = choice.modes[(choice.modes.indexOf(choice.mode) + 1) % choice.modes.length];
    return switchPasteMode(view, next);
}

/**
 * Escape closes the list of ways if it's open, and otherwise puts the picker away (the paste stays as it is).
 * @param {EditorView} view
 * @returns {boolean}
 */
function dismissPasteChoice(view) {
    const choice = view.state.field(pasteChoiceField, false);
    if (!choice) return false;
    view.dispatch({
        effects: setPasteChoice.of(choice.menu ? { ...choice, menu: false } : null),
        annotations: Transaction.addToHistory.of(false),
    });
    return true;
}

/**
 * @param {EditorView} view
 * @param {string} text
 * @param {PasteChoice | null} [choice] The ways this paste could go in, when there's more than one.
 */
function insert(view, text, choice = null) {
    const range = view.state.selection.main;
    view.dispatch({
        changes: { from: range.from, to: range.to, insert: text },
        selection: { anchor: range.from + text.length },
        effects: setPasteChoice.of(choice && { ...choice, from: range.from, to: range.from + text.length }),
        scrollIntoView: true,
        userEvent: 'input.paste',
    });
}

/**
 * The picker for a paste, or null when it could only have gone in one way.
 * @param {Partial<Record<PasteMode, string>>} texts
 * @param {PasteMode} mode How it goes in.
 * @returns {PasteChoice | null}
 */
function choiceFor(texts, mode) {
    const modes = PASTE_MODES.filter(m => typeof texts[m] === 'string' && texts[m] !== '');
    const distinct = new Set(modes.map(m => texts[m]));
    if (distinct.size < 2) return null;
    return { from: 0, to: 0, mode, modes, texts, menu: false };
}

/**
 * @returns {import('@codemirror/state').Extension}
 */
export function livePaste() {
    return [
        pasteChoiceField,
        // Undo and redo bring back how the paste went in along with its text.
        invertedEffects.of((tr) => {
            /** @type {import('@codemirror/state').StateEffect<PasteChoice | null>[]} */
            const inverted = [];
            for (const effect of tr.effects) {
                if (effect.is(setPasteChoice)) inverted.push(setPasteChoice.of(tr.startState.field(pasteChoiceField, false) ?? null));
            }
            return inverted;
        }),
        Prec.highest(keymap.of([
            { key: 'Escape', run: dismissPasteChoice },
            { key: 'Mod-Alt-v', run: cyclePasteMode, preventDefault: true },
        ])),
        EditorView.domEventHandlers({
            paste(event, view) {
                const data = event.clipboardData;
                if (!data) return false;
                const plain = data.getData('text/plain');
                if (bareUrl.test(plain.trim()) && !/\n/.test(plain.trim())) {
                    event.preventDefault();
                    const autolink = `<${plain.trim()}>`;
                    insert(view, autolink, choiceFor({ markdown: autolink, plain: plain.trim() }, 'markdown'));
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
                const sanitized = DOMPurify.sanitize(html, { WHOLE_DOCUMENT: false }).trim();
                insert(view, text, choiceFor({ markdown: text, html: sanitized, plain }, 'markdown'));
                return true;
            },
        }),
    ];
}
