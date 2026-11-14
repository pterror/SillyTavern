import { drawerStackChanged } from './drawer-stack.js';
import { MacroValues } from './macro-values.js';
import { cardTextSetup } from './message-text.js';
import { loadChatEditor } from './chat-text/editors.js';
import { editPosition, showText, stopText } from './chat-text/surface.js';
import { withFilledAbout } from './safe-macros.js';

/**
 * Prompt text boxes (persona description, author's note, prompts, story string, overrides) shown as card fields are: the
 * text drawn by the reader, edited in the shared editor when the person starts an edit (the pencil, a click when click
 * to edit is on, a double-click when it is off). The textarea stays the box's value for the code that reads and writes
 * it; its edits are written into it, as typing in it was, and a write to it redraws the reader.
 */

/**
 * @typedef {object} TextBoxDeps
 * @property {() => import('./macro-values.js').MacroScope} macroScope
 * @property {(macroName: string) => import('./macro-pill.js').MacroPerson | null} macroPerson
 * @property {{ click_to_edit: boolean }} power_user
 * @property {import('./macro-pill.js').Translate} t
 */

/** @type {TextBoxDeps} */
let deps;

/** @param {TextBoxDeps} dependencies */
export function initTextBoxes(dependencies) {
    deps = dependencies;
    textBoxesIn(document);
}

const valueProperty = /** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value'));

/** @type {WeakSet<HTMLTextAreaElement>} */
const made = new WeakSet();

/**
 * Makes a text box of each textarea under a root that says it is one, by `data-text-box`: `notes` for text drawn as a
 * card's description is, `literal` for text drawn as written
 * @param {ParentNode} root
 */
export function textBoxesIn(root) {
    for (const textarea of root.querySelectorAll('textarea[data-text-box]')) {
        if (textarea instanceof HTMLTextAreaElement) textBox(textarea);
    }
}

/**
 * @param {string} icon
 * @param {string} title
 * @returns {HTMLElement}
 */
function button(icon, title) {
    const element = document.createElement('i');
    element.className = `fa-solid ${icon} right_menu_button`;
    element.title = title;
    element.setAttribute('role', 'button');
    element.tabIndex = 0;
    return element;
}

/**
 * @param {HTMLTextAreaElement} textarea
 */
function textBox(textarea) {
    if (made.has(textarea) || !deps) return;
    made.add(textarea);
    const kind = textarea.dataset['textBox'] === 'notes' ? 'notes' : 'literal';
    const values = new MacroValues(() => deps.macroScope());
    const setup = () => cardTextSetup(kind, {
        values,
        person: name => deps.macroPerson(name),
    });

    const holder = document.createElement('div');
    holder.className = 'text_box';
    const bar = document.createElement('div');
    bar.className = 'text_box_bar';
    const edit = button('fa-pencil', deps.t`Edit`);
    const done = button('fa-check', deps.t`Confirm`);
    const cancel = button('fa-xmark', deps.t`Cancel`);
    bar.append(edit, done, cancel);
    const view = document.createElement('div');
    view.className = 'text_box_view field_preview macro_preview_content mes_text';
    holder.append(bar, view);
    textarea.after(holder);
    textarea.classList.add('text_box_source');

    /** @type {{ editor: import('./chat-text/editor.js').ChatEditor | null, original: string, ended: boolean } | null} */
    let editing = null;
    let drawn = 0;

    const show = () => {
        done.hidden = cancel.hidden = editing === null;
        edit.hidden = editing !== null;
        view.hidden = editing !== null;
        if (editing) return;
        const text = valueProperty.get?.call(textarea) ?? '';
        const round = ++drawn;
        view.classList.toggle('field_preview_empty', text === '');
        if (text === '') {
            stopText(view);
            view.textContent = textarea.placeholder;
            return;
        }
        void values.want(text).then(() => {
            if (round === drawn && !editing) showText(view, text, setup());
        });
    };

    /** @param {string} text */
    const write = (text) => {
        valueProperty.set?.call(textarea, text);
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
    };

    Object.defineProperty(textarea, 'value', {
        configurable: true,
        get: () => valueProperty.get?.call(textarea),
        set(text) {
            valueProperty.set?.call(textarea, text);
            if (editing?.editor) {
                const { view: editorView } = editing.editor;
                if (editorView.state.doc.toString() !== String(text)) {
                    editorView.dispatch({ changes: { from: 0, to: editorView.state.doc.length, insert: String(text ?? '') } });
                }
            }
            show();
        },
    });

    /** @param {number} at */
    const begin = async (at) => {
        if (editing) return;
        const text = textarea.value;
        const current = { editor: null, original: text, ended: false };
        editing = current;
        show();
        try {
            const { chatEditor } = await loadChatEditor();
            if (current.ended) return;
            const editor = chatEditor({
                parent: holder,
                setup: setup(),
                macroValue: values.valueOf,
                macroValues: values,
                speaker: '',
                person: name => withFilledAbout(deps.macroPerson(name), name, values.valueOf),
                initial: text,
                edited: edited => write(edited),
                save: async () => {},
                className: 'text_box_editor macro_preview_content mes_text',
                placeholder: textarea.placeholder,
            });
            current.editor = editor;
            bar.after(editor.view.dom.closest('.chat-editor') ?? editor.view.dom);
            editor.view.dispatch({ selection: { anchor: Math.min(at, text.length) }, scrollIntoView: true });
            editor.view.focus();
            editor.view.dom.addEventListener('keydown', (event) => {
                if (event.key !== 'Escape' || event.defaultPrevented) return;
                event.preventDefault();
                event.stopPropagation();
                end(false);
            });
            drawerStackChanged();
        } catch (error) {
            console.error('The editor could not be loaded', error);
            end(false);
        }
    };

    /** @param {boolean} revert */
    const end = (revert) => {
        const current = editing;
        if (!current) return;
        current.ended = true;
        current.editor?.stop();
        editing = null;
        if (revert && textarea.value !== current.original) write(current.original);
        show();
        drawerStackChanged();
    };

    edit.addEventListener('click', () => void begin(0));
    done.addEventListener('click', () => end(false));
    cancel.addEventListener('click', () => end(true));
    for (const type of /** @type {const} */ (['click', 'dblclick'])) {
        view.addEventListener(type, (event) => {
            const at = editPosition(event, view, deps.power_user.click_to_edit);
            if (at !== null) void begin(at);
        });
    }
    show();
}
