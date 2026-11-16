import { beforeAll, describe, expect, jest, test } from '@jest/globals';
import { Window } from 'happy-dom';

const window = new Window({ url: 'http://localhost:8000/' });
globalThis.window = /** @type {any} */ (window);
globalThis.document = /** @type {any} */ (window.document);

jest.unstable_mockModule('../public/lib.js', async () => {
    const { default: createDOMPurify } = await import('dompurify');
    const { default: css } = await import('@adobe/css-tools');
    const { default: hljs } = await import('highlight.js');
    const { reader } = await import('@pterror/interact-editor/reader');
    const { GFM, parser: markdownParser } = await import('@lezer/markdown');
    const { NodeType, Parser, Tree, parseMixed } = await import('@lezer/common');
    const { parser: htmlParser } = await import('@lezer/html');
    const { definitionOf, gfmLook, htmlLook, markdownLook } = await import('@pterror/interact-markdown/look');
    return { DOMPurify: createDOMPurify(/** @type {any} */ (window)), css, hljs, reader, markdownParser, GFM, htmlParser, parseMixed, Parser, Tree, NodeType, markdownLook, gfmLook, htmlLook, definitionOf };
});

/** @type {typeof import('../public/scripts/chat-text/macros.js')} */
let macros;
/** @type {typeof import('@codemirror/state')} */
let cmState;
/** @type {typeof import('@codemirror/view')} */
let cmView;
/** @type {import('@lezer/common').Parser} */
let grammar;
/** @type {typeof import('@pterror/interact-editor/grammar-language')} */
let language;

beforeAll(async () => {
    macros = await import('../public/scripts/chat-text/macros.js');
    cmState = await import('@codemirror/state');
    cmView = await import('@codemirror/view');
    language = await import('@pterror/interact-editor/grammar-language');
    const { parser } = await import('@lezer/markdown');
    const { chatMarkdownExtensions } = await import('../public/scripts/chat-text/grammar.js');
    grammar = parser.configure(chatMarkdownExtensions());
});

const t = (/** @type {TemplateStringsArray} */ strings, /** @type {any[]} */ ...values) => String.raw({ raw: strings }, ...values);

/**
 * What the tooltip beside the cursor says with the cursor at `head` of `doc`, or null when it shows none
 * @param {string} doc
 * @param {number} head
 * @param {(source: string) => string | null | undefined} get
 * @param {{ focused?: boolean, anchor?: number }} [options]
 */
function tooltipAt(doc, head, get, { focused = true, anchor = head } = {}) {
    const extension = macros.macroCursorTooltip({ get }, name => (name === 'user' ? { name: 'Sam', avatarUrl: '/a.png', about: '' } : null), t);
    let state = cmState.EditorState.create({
        doc,
        selection: { anchor, head },
        extensions: [language.grammarLanguage(grammar), extension],
    });
    if (focused) {
        const focusing = state.facet(cmView.EditorView.focusChangeEffect).map(change => change(state, true));
        state = state.update({ effects: focusing.filter(effect => effect !== null) }).state;
    }
    const tooltip = state.facet(cmView.showTooltip).find(Boolean);
    if (!tooltip) return null;
    return { above: tooltip.above, pos: tooltip.pos, text: tooltip.create(/** @type {any} */ ({ state })).dom.textContent };
}

describe('the tooltip beside the cursor', () => {
    test('says what a macro is and its value while the cursor is in it or beside it', () => {
        const values = (/** @type {string} */ source) => (source === '{{getvar::mood}}' ? 'cheerful' : undefined);
        const doc = 'Feeling {{getvar::mood}} today';
        for (const head of [8, 12, 23]) {
            const shown = tooltipAt(doc, head, values);
            expect(shown?.text).toBe('{{getvar::mood}}cheerful');
            expect(shown?.above).toBe(true);
            expect(shown?.pos).toBe(head);
        }
    });

    test('shows nothing with the cursor outside every macro, in a selection, or when the editor has no focus', () => {
        const doc = 'Feeling {{getvar::mood}} today';
        expect(tooltipAt(doc, 3, () => 'x')).toBeNull();
        expect(tooltipAt(doc, 26, () => 'x')).toBeNull();
        expect(tooltipAt(doc, 12, () => 'x', { anchor: 10 })).toBeNull();
        expect(tooltipAt(doc, 12, () => 'x', { focused: false })).toBeNull();
    });

    test('says when the value is only known when sent, sends nothing, or the text came without it', () => {
        expect(tooltipAt('{{time}}', 4, () => null)?.text).toBe('{{time}}Filled in when sent');
        expect(tooltipAt('{{blank}}', 4, () => '')?.text).toBe('{{blank}}Sends nothing');
        expect(tooltipAt('{{time}}', 4, () => undefined)?.text).toBe('{{time}}');
    });

    test('shows a person as their card', () => {
        const shown = tooltipAt('Hi {{user}}', 6, () => 'Sam');
        expect(shown?.text).toContain('Sam');
        expect(shown?.text).toContain('{{user}}');
    });
});
