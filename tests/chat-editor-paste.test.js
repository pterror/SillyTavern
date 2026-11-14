import { describe, expect, test } from '@jest/globals';
import { EditorState } from '@codemirror/state';
import { choiceFor, cyclePaste, dismissPaste, pastePicker, setChoice, switchPaste } from '../public/scripts/chat-text/paste.js';

const t = (/** @type {TemplateStringsArray} */ strings, /** @type {any[]} */ ...values) => String.raw({ raw: strings }, ...values);

/**
 * A state with the picker, and a view-shaped object applying what is dispatched to it
 * @param {string} doc
 */
function editor(doc) {
    const view = {
        state: EditorState.create({ doc, extensions: [pastePicker({ shows: m => m, clean: h => h, t })] }),
        /** @param {import('@codemirror/state').TransactionSpec} spec */
        dispatch(spec) {
            view.state = view.state.update(spec).state;
        },
    };
    return view;
}

const labels = { plain: 'Text only', markdown: 'Keep formatting', html: 'Keep as HTML' };
const texts = { plain: 'Hello bold', markdown: 'Hello **bold**', html: '<p>Hello <b>bold</b></p>' };

/**
 * Makes the paste the handler would: the markdown, at the end of the text, with its picker
 * @param {ReturnType<typeof editor>} view
 */
function paste(view) {
    const from = view.state.doc.length;
    const choice = /** @type {NonNullable<ReturnType<typeof choiceFor>>} */ (choiceFor(texts, 'markdown', labels, 'Paste options'));
    view.dispatch({
        changes: { from, insert: texts.markdown },
        effects: setChoice.of({ ...choice, from, to: from + texts.markdown.length }),
        userEvent: 'input.paste',
    });
}

describe('the paste picker', () => {
    test('offers nothing when every way inserts the same text', () => {
        expect(choiceFor({ plain: 'a', markdown: 'a', html: 'a' }, 'markdown', {}, '')).toBeNull();
    });

    test('offers the ways in cycle order, leaving out those with no text', () => {
        expect(choiceFor({ plain: 'a', markdown: 'b' }, 'markdown', {}, '')?.modes).toEqual(['plain', 'markdown']);
        expect(choiceFor({ plain: '', markdown: 'b', html: 'c' }, 'markdown', {}, '')?.modes).toEqual(['markdown', 'html']);
    });

    test('with no paste to change, its commands do nothing', () => {
        const view = editor('x');
        expect(cyclePaste(view)).toBe(false);
        expect(dismissPaste(view)).toBe(false);
        expect(switchPaste(view, 'plain')).toBe(false);
    });

    test('puts the paste in each way, replacing exactly the paste', () => {
        const view = editor('Before ');
        paste(view);
        expect(switchPaste(view, 'html')).toBe(true);
        expect(view.state.doc.toString()).toBe(`Before ${texts.html}`);
        expect(view.state.selection.main.head).toBe(view.state.doc.length);
        switchPaste(view, 'plain');
        expect(view.state.doc.toString()).toBe(`Before ${texts.plain}`);
    });

    test('cycles plain, markdown, HTML and round again', () => {
        const view = editor('');
        paste(view);
        const seen = [];
        for (let i = 0; i < 4; i++) {
            cyclePaste(view);
            seen.push(view.state.doc.toString());
        }
        expect(seen).toEqual([texts.html, texts.plain, texts.markdown, texts.html]);
    });

    test('is gone after the text is edited, and Escape closes it', () => {
        const view = editor('');
        paste(view);
        expect(dismissPaste(view)).toBe(true);
        expect(cyclePaste(view)).toBe(false);
        paste(view);
        view.dispatch({ changes: { from: 0, insert: 'x' } });
        expect(cyclePaste(view)).toBe(false);
    });
});
