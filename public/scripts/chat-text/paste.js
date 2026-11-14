import { commands as cmCommands, markdownPaste, state as cmState, view as cmView } from '../../live-editor-lib.js';

const { StateEffect, StateField, Prec, Transaction, EditorState } = cmState;
const { EditorView, showTooltip, keymap } = cmView;
const { invertedEffects } = cmCommands;

/**
 * How a paste went in: as the clipboard's plain text, as markdown made from its HTML (or, for an address pasted over
 * selected text, the link), or as its HTML
 * @typedef {'plain' | 'markdown' | 'html'} PasteMode
 */

/** The order the modes are cycled in */
const MODES = /** @type {readonly PasteMode[]} */ (['plain', 'markdown', 'html']);

const BARE_ADDRESS = /^(?:https?:\/\/|www\.)\S+$/iu;

/**
 * What the picker offers for the paste just made
 * @typedef {object} Choice
 * @property {number} from where the paste starts
 * @property {number} to where it ends
 * @property {PasteMode} mode the way it went in
 * @property {readonly PasteMode[]} modes the ways it could, in cycle order
 * @property {Partial<Record<PasteMode, string>>} texts what each way inserts
 * @property {Partial<Record<PasteMode, string>>} labels what each way is called
 * @property {string} title what the picker's button is for
 * @property {boolean} menu whether the list of ways is open
 */

/** @type {import('@codemirror/state').StateEffectType<Choice | null>} */
export const setChoice = StateEffect.define({
    map: (value, mapping) => value && { ...value, from: mapping.mapPos(value.from, -1), to: mapping.mapPos(value.to, 1) },
});

/**
 * The ways a paste could go in, when there is more than one
 * @param {Partial<Record<PasteMode, string>>} texts
 * @param {PasteMode} mode the way it went in
 * @param {Partial<Record<PasteMode, string>>} labels
 * @param {string} title
 * @returns {Choice | null} none when every way inserts the same text
 */
export function choiceFor(texts, mode, labels, title) {
    const modes = MODES.filter(candidate => (texts[candidate] ?? '') !== '');
    return new Set(modes.map(candidate => texts[candidate])).size < 2 ? null : { from: 0, to: 0, mode, modes, texts, labels, title, menu: false };
}

/**
 * An address as a markdown link's destination
 * @param {string} address
 */
const destination = address => address.replaceAll('(', '%28').replaceAll(')', '%29');

/**
 * Puts a paste in another way, replacing exactly what it inserted
 * @param {Pick<EditorView, 'state' | 'dispatch'>} view
 * @param {PasteMode} mode
 * @returns {boolean} whether there was a paste to change
 */
export function switchPaste(view, mode) {
    const choice = view.state.field(choiceField, false);
    const text = choice?.texts[mode];
    if (!choice || text === undefined) return false;
    const to = choice.from + text.length;
    view.dispatch({
        changes: { from: choice.from, to: choice.to, insert: text },
        selection: { anchor: to },
        effects: setChoice.of({ ...choice, to, mode, menu: false }),
        scrollIntoView: true,
        userEvent: 'input.paste',
    });
    return true;
}

/**
 * @param {Pick<EditorView, 'state' | 'dispatch'>} view
 * @returns {boolean} whether there was a paste to change
 */
export function cyclePaste(view) {
    const choice = view.state.field(choiceField, false);
    if (!choice) return false;
    return switchPaste(view, choice.modes[(choice.modes.indexOf(choice.mode) + 1) % choice.modes.length]);
}

/**
 * Closes the list of ways, or when it is closed the picker
 * @param {Pick<EditorView, 'state' | 'dispatch'>} view
 * @returns {boolean} whether there was a picker
 */
export function dismissPaste(view) {
    const choice = view.state.field(choiceField, false);
    if (!choice) return false;
    view.dispatch({ effects: setChoice.of(choice.menu ? { ...choice, menu: false } : null), annotations: Transaction.addToHistory.of(false) });
    return true;
}

/** @type {import('@codemirror/state').StateField<Choice | null>} */
const choiceField = StateField.define({
    create: () => null,
    update(value, tr) {
        for (const effect of tr.effects) {
            if (effect.is(setChoice)) return effect.value;
        }
        return tr.docChanged ? null : value;
    },
    provide: field => showTooltip.from(field, choice => choice && ({
        pos: choice.to,
        above: false,
        strictSide: false,
        arrow: false,
        create: view => ({ dom: pickerDom(view, choice) }),
    })),
});

/**
 * @param {EditorView} view
 * @param {Choice} choice
 * @returns {HTMLElement}
 */
function pickerDom(view, choice) {
    const dom = document.createElement('div');
    dom.className = 'paste-picker';
    dom.addEventListener('mousedown', event => event.preventDefault());
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'paste-picker-toggle';
    toggle.title = choice.title;
    toggle.setAttribute('aria-haspopup', 'menu');
    toggle.setAttribute('aria-expanded', String(choice.menu));
    toggle.setAttribute('aria-keyshortcuts', 'Control+Alt+V');
    const paste = document.createElement('i');
    paste.className = 'fa-solid fa-paste';
    const caret = document.createElement('i');
    caret.className = 'fa-solid fa-caret-down';
    paste.setAttribute('aria-hidden', 'true');
    caret.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.className = 'paste-picker-mode';
    label.textContent = choice.labels[choice.mode] ?? '';
    toggle.append(paste, label, caret);
    toggle.addEventListener('click', () => {
        const current = view.state.field(choiceField, false);
        if (current) view.dispatch({ effects: setChoice.of({ ...current, menu: !current.menu }), annotations: Transaction.addToHistory.of(false) });
    });
    dom.append(toggle);
    if (choice.menu) {
        const menu = document.createElement('div');
        menu.className = 'paste-picker-menu';
        menu.setAttribute('role', 'menu');
        for (const mode of choice.modes) {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'paste-picker-item';
            item.dataset['mode'] = mode;
            item.setAttribute('role', 'menuitemradio');
            item.setAttribute('aria-checked', String(mode === choice.mode));
            item.textContent = choice.labels[mode] ?? '';
            item.addEventListener('click', () => switchPaste(view, mode));
            menu.append(item);
        }
        dom.append(menu);
    }
    return dom;
}

/**
 * An address pasted over selected text makes it a link
 * @param {import('../macro-pill.js').Translate} t
 * @param {(choice: Choice | null) => void} offer sets the paste's picker
 */
function addressOverSelection(t, offer) {
    return EditorView.domEventHandlers({
        paste(event, view) {
            const pasted = (event.clipboardData?.getData('text/plain') ?? '').trim();
            const range = view.state.selection.main;
            const selected = view.state.sliceDoc(range.from, range.to);
            if (range.empty || !BARE_ADDRESS.test(pasted) || selected.includes('\n')) return false;
            event.preventDefault();
            const link = `[${selected}](${destination(pasted)})`;
            offer(choiceFor({ plain: pasted, markdown: link }, 'markdown', { plain: t`Text only`, markdown: t`As link` }, t`Paste options`));
            view.dispatch({
                changes: { from: range.from, to: range.to, insert: link },
                selection: { anchor: range.from + link.length },
                scrollIntoView: true,
                userEvent: 'input.paste',
            });
            return true;
        },
    });
}

/**
 * Pasted HTML as markdown, and for a moment after any paste a way to put it in another: as plain text, as markdown, or
 * as HTML (Ctrl+Alt+V cycles them, Escape dismisses the picker). An address pasted over selected text makes a link.
 * @param {object} options
 * @param {(markdown: string) => string} options.shows what a markdown text shows, as the editor draws it
 * @param {(html: string) => string} options.clean pasted HTML, safe to keep in the text
 * @param {import('../macro-pill.js').Translate} options.t
 * @returns {import('@codemirror/state').Extension}
 */
export function pastePicker({ shows, clean, t }) {
    /** @type {Choice | null} */
    let pending = null;
    const labels = { plain: t`Text only`, markdown: t`Keep formatting`, html: t`Keep as HTML` };
    return [
        choiceField,
        addressOverSelection(t, choice => { pending = choice; }),
        markdownPaste({
            shows,
            choose({ html, markdown, plain }) {
                pending = choiceFor({ plain, markdown, html: clean(html).trim() }, 'markdown', labels, t`Paste options`);
                return markdown;
            },
        }),
        EditorState.transactionExtender.of((tr) => {
            if (!pending || !tr.isUserEvent('input.paste')) return null;
            const choice = pending;
            pending = null;
            let range = null;
            tr.changes.iterChanges((_fromA, _toA, fromB, toB) => { range ??= { from: fromB, to: toB }; });
            return range && choice ? { effects: setChoice.of({ ...choice, ...range }) } : null;
        }),
        invertedEffects.of((tr) => {
            /** @type {import('@codemirror/state').StateEffect<Choice | null>[]} */
            const inverted = [];
            for (const effect of tr.effects) {
                if (effect.is(setChoice)) inverted.push(setChoice.of(tr.startState.field(choiceField, false) ?? null));
            }
            return inverted;
        }),
        Prec.highest(keymap.of([
            { key: 'Escape', run: dismissPaste },
            { key: 'Mod-Alt-v', run: cyclePaste, preventDefault: true },
        ])),
    ];
}
