import { DOMPurify, showdown } from '../lib.js';
import { renderMarkdownLiteralTags } from './marked-processor.js';
import { refreshCharInfoTabDimming } from './char-info-tab-dimming.js';
import { keepViewState, openEditorLayer } from './editor-layer.js';
import { evaluateSafeMacro, insertSafeMacroSpans, substituteSafeMacros } from './safe-macros.js';
import { EDITOR_ESCAPE_TAKERS, isEditorEvent, isUserEvent, mountLiveEditor } from './live-editor/registry.js';
import { drawerStackChanged } from './drawer-stack.js';

// A leaf module: everything it needs from the rest of the app is passed to initCharacterFieldEditor()
// (and to substituteMacrosWithPlaceholders()), so importing it never adds an import cycle.

const PLACEHOLDER_START = '';
const PLACEHOLDER_END = '';
const PLACEHOLDER_REGEX = new RegExp(`${PLACEHOLDER_START}(\\d+)${PLACEHOLDER_END}`, 'g');

/** @param {string} text @returns {string} */
function escapeHtmlText(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/**
 * Substitutes macros, leaving a placeholder where each substituted value goes, so the text can be rendered
 * before {@link insertMacroSpans} puts the values back.
 * @param {string} text
 * @param {(content: string, options: object) => string} substituteParams The app's substituteParams.
 * @param {object} [options] Extra substituteParams options.
 * @returns {{ text: string, values: string[] }}
 */
export function substituteMacrosWithPlaceholders(text, substituteParams, options = {}) {
    /** @type {string[]} */
    const values = [];
    const substituted = substituteParams(text, {
        ...options,
        postProcessFn: value => {
            values.push(String(value));
            return `${PLACEHOLDER_START}${values.length - 1}${PLACEHOLDER_END}`;
        },
    });
    return { text: substituted, values };
}

/**
 * Replaces the placeholders from {@link substituteMacrosWithPlaceholders} with `.macro-substituted` spans
 * holding each value as literal text.
 * @param {string} html
 * @param {string[]} values
 * @returns {string}
 */
export function insertMacroSpans(html, values) {
    return html.replace(PLACEHOLDER_REGEX, (_, index) => `<span class="macro-substituted">${escapeHtmlText(values[Number(index)] ?? '')}</span>`);
}

/**
 * @typedef {object} CharacterFieldEditorDeps
 * @property {(content: string, options: object) => string} substituteParams
 * @property {(mes: string, chName: string, isSystem: boolean, isUser: boolean, messageId: number) => string} messageFormatting
 * @property {(text: string) => string} formatCreatorNotes Renders Creator's Notes for the character loaded in the editor.
 * @property {{ auto_save_msg_edits: boolean, click_to_edit: boolean }} power_user
 * @property {(strings: TemplateStringsArray, ...values: any[]) => string} t
 * @property {number} autoSaveTimeout Milliseconds of typing pause before an autosave.
 * @property {(value: string) => Promise<boolean>} saveCreatorNotesField
 * @property {(value: string) => Promise<boolean>} saveDescriptionField
 * @property {(value: string) => Promise<boolean>} saveGreetingField
 * @property {(value: string) => Promise<boolean>} saveSystemPromptField
 * @property {(value: string) => Promise<boolean>} savePostHistoryInstructionsField
 * @property {(value: string) => Promise<boolean>} savePersonalityField
 * @property {(value: string) => Promise<boolean>} saveScenarioField
 * @property {(value: string) => Promise<boolean>} saveCharacterNoteField
 * @property {(value: string) => Promise<boolean>} saveExampleMessagesField
 * @property {(file: File) => Promise<string>} [uploadImage] Uploads an image the editor's image button picked; gives its URL.
 * @property {(title: string, text: string) => Promise<boolean>} confirmDiscard Asks before an edit's change is thrown away.
 * @property {(id: string) => void} [onEditStart] Called once a field has entered edit mode.
 * @property {(id: string) => void} [onEditEnd] Called once a field has left edit mode (Done or cancel).
 * @property {() => string} [editorKey] Which character's fields are in the editor ('' when none), so a field's
 * unsaved text is kept per character.
 */

/** @type {CharacterFieldEditorDeps} */
let deps = null;

/** @param {string} text @returns {string} */
function renderLiteralTagsPreview(text) {
    const { text: substituted, values, raws } = substituteSafeMacros(text, deps.substituteParams);
    const html = DOMPurify.sanitize(renderMarkdownLiteralTags(substituted));
    return insertSafeMacroSpans(html, values, raws);
}

/** @param {string} text @returns {string} */
function renderGreetingPreview(text) {
    const name = String($('#character_name_pole').val() ?? '');
    const { text: substituted, values, raws } = substituteSafeMacros(text, deps.substituteParams, { name2Override: name });
    const html = deps.messageFormatting(substituted, name, false, false, 0);
    return insertSafeMacroSpans(html, values, raws);
}

/**
 * @typedef {object} EditableField
 * @property {() => (value: string) => Promise<boolean>} save
 * @property {(text: string) => string} render
 */

/** @type {Record<string, EditableField>} Keyed by textarea id. */
const FIELDS = {
    creator_notes_textarea: { save: () => deps.saveCreatorNotesField, render: text => deps.formatCreatorNotes(text) },
    description_textarea: { save: () => deps.saveDescriptionField, render: renderLiteralTagsPreview },
    greeting_field: { save: () => deps.saveGreetingField, render: renderGreetingPreview },
    system_prompt_textarea: { save: () => deps.saveSystemPromptField, render: renderLiteralTagsPreview },
    post_history_instructions_textarea: { save: () => deps.savePostHistoryInstructionsField, render: renderLiteralTagsPreview },
    personality_textarea: { save: () => deps.savePersonalityField, render: renderLiteralTagsPreview },
    scenario_pole: { save: () => deps.saveScenarioField, render: renderLiteralTagsPreview },
    depth_prompt_prompt: { save: () => deps.saveCharacterNoteField, render: renderLiteralTagsPreview },
    mes_example_textarea: { save: () => deps.saveExampleMessagesField, render: renderLiteralTagsPreview },
};

/**
 * The one field in edit mode. `userText` is what the user last typed, so a write from code during the edit can be
 * stored without losing it.
 * @type {{ id: string, original: string, userText: string, saving: boolean } | null}
 */
let activeEdit = null;

/** @type {Map<string, { next: string | null }>} Saves of values written by code that are in flight, by field. */
const outsideWrites = new Map();

/** @type {ReturnType<typeof setTimeout> | null} */
let autoSaveTimer = null;

/** @type {Promise<unknown> | null} The autosave that has been sent and not yet finished. */
let autoSaveInFlight = null;

/** @param {string} id @returns {JQuery<HTMLTextAreaElement>} */
function getTextarea(id) {
    return /** @type {JQuery<HTMLTextAreaElement>} */ ($(`#${id}`));
}

/** @param {string} id */
function getPreview(id) {
    return $(`.field_preview[data-for="${id}"]`);
}

/** @param {string} id */
function getPanel(id) {
    return getTextarea(id).closest('.char_info_tab_panel');
}

/** @returns {boolean} Whether a chat message (or its reasoning block) is in edit mode. */
function isMessageEditOpen() {
    return $('#curEditTextarea').length > 0 || $('.reasoning_edit_textarea').length > 0;
}

/**
 * @param {string} id Textarea id.
 * @returns {boolean} Whether this field is in edit mode.
 */
export function isFieldInEdit(id) {
    return activeEdit?.id === id;
}

/**
 * Blocks whatever the caller was about to do while a field is in edit mode.
 * @returns {boolean} True when blocked; the caller returns without acting.
 */
export function blockWhileFieldEditing() {
    if (!activeEdit) {
        return false;
    }
    // The field being edited is on screen (nothing may cover it), so its ✓ ✕ flash shows why, as a tab click does.
    if (getPanel(activeEdit.id)[0]?.checkVisibility({ visibilityProperty: true })) {
        flashEditControls();
    } else {
        const { t } = deps;
        toastr.warning(t`A field is being edited - confirm or cancel it first.`);
    }
    return true;
}

/**
 * Sets a field's value and re-renders its preview; a field in edit mode is left untouched.
 * @param {string} id Textarea id.
 * @param {string} value
 */
export function setFieldValue(id, value) {
    if (isFieldInEdit(id)) {
        return;
    }
    getTextarea(id).val(value ?? '');
    refreshFieldPreview(id);
    showDraftNotice(id);
}

/**
 * Re-renders a field's preview from its textarea; an empty field shows the textarea's placeholder.
 * @param {string} id Textarea id.
 */
function refreshFieldPreview(id) {
    refreshCharInfoTabDimming();
    const field = FIELDS[id];
    const preview = getPreview(id);
    if (!field || !preview.length || !deps) {
        return;
    }
    const text = String(getTextarea(id).val() ?? '');
    const isEmpty = text === '';
    preview.toggleClass('field_preview_empty', isEmpty);
    if (isEmpty) {
        preview.text(String(getTextarea(id).attr('placeholder') ?? ''));
    } else {
        preview.html(field.render(text));
    }
}

/**
 * Blocks starting a field edit while another field or a chat message is in edit mode.
 * @returns {boolean} True when blocked; the caller returns without acting.
 */
export function blockFieldEditStart() {
    if (blockWhileFieldEditing()) {
        return true;
    }
    if (isMessageEditOpen()) {
        const { t } = deps;
        toastr.warning(t`A message is being edited - confirm or cancel it first.`);
        return true;
    }
    return false;
}

/** What decides how the text is laid out, so entering edit changes the content shown and not the font or wrapping. */
const TEXT_METRICS = ['font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'word-spacing', 'word-break', 'overflow-wrap'];

/**
 * Gives the field's textarea its preview's text metrics. Read while the preview is still shown, so a theme's or the
 * user's CSS on the preview carries over.
 * @param {string} id
 */
function matchPreviewText(id) {
    const preview = getPreview(id)[0];
    const textarea = getTextarea(id)[0];
    if (!preview || !textarea) return;
    const style = getComputedStyle(preview);
    for (const prop of TEXT_METRICS) {
        textarea.style.setProperty(prop, style.getPropertyValue(prop));
    }
}

/**
 * Puts a field in edit mode and focuses its textarea, unless {@link blockFieldEditStart} blocks it.
 * @param {string} id Textarea id.
 */
export function beginEdit(id) {
    if (activeEdit?.id === id) {
        return;
    }
    if (blockFieldEditStart()) {
        return;
    }
    const textarea = getTextarea(id);
    matchPreviewText(id);
    const text = String(textarea.val() ?? '');
    activeEdit = { id, original: text, userText: text, saving: false };
    getPanel(id).addClass('field_editing');
    // Nothing may cover the field being edited.
    drawerStackChanged();
    deps.onEditStart?.(id);
    textarea.trigger('focus');
    void mountFieldEditor(id);
}

/** @type {{ id: string, editor: import('./live-editor/mount.js').LiveEditor | null, ended: boolean } | null} The editor on the field in edit mode. */
let liveEditor = null;

/** Classes of a field's preview that style its text (not its box), so the editor's text is styled the same. */
const PREVIEW_TEXT_CLASSES = new Set(['mes_text', 'creator_notes_preview_content']);

/**
 * Puts the live editor on the field in edit mode, in place of its textarea, set up as the field's preview renders.
 * @param {string} id
 */
async function mountFieldEditor(id) {
    const holder = { id, editor: null, ended: false };
    liveEditor = holder;
    const textarea = getTextarea(id)[0];
    const preview = getPreview(id)[0];
    const isGreeting = id === GREETING_FIELD_ID;
    const characterName = () => String($('#character_name_pole').val() ?? '');
    try {
        const editor = await mountLiveEditor(textarea, {
            render: FIELDS[id].render,
            grammar: { emojis: showdown.helper.emojis, dialogueQuotes: isGreeting },
            contentClass: [...(preview?.classList ?? [])].filter(c => PREVIEW_TEXT_CLASSES.has(c)).join(' '),
            macros: { evaluate: text => evaluateSafeMacro(text, deps.substituteParams, isGreeting ? { name2Override: characterName() } : {}) },
            formatting: { uploadImage: deps.uploadImage },
            search: { context: () => ({ characterName: characterName() }) },
        });
        if (holder.ended) {
            editor.destroy();
            return;
        }
        holder.editor = editor;
        if (document.activeElement === textarea) editor.takeFocus();
    } catch (error) {
        console.error('The editor could not be loaded; the field stays a plain text box', error);
    }
}

function unmountFieldEditor() {
    if (!liveEditor) return;
    liveEditor.ended = true;
    liveEditor.editor?.destroy();
    liveEditor = null;
}

function endEdit() {
    const { id } = activeEdit;
    unmountFieldEditor();
    activeEdit = null;
    getPanel(id).removeClass('field_editing');
    drawerStackChanged();
    deps.onEditEnd?.(id);
    refreshFieldPreview(id);
}

function cancelAutoSave() {
    if (autoSaveTimer !== null) {
        clearTimeout(autoSaveTimer);
        autoSaveTimer = null;
    }
}

/** @param {string} id @param {string} value */
function scheduleAutoSave(id, value) {
    cancelAutoSave();
    autoSaveTimer = setTimeout(() => {
        autoSaveTimer = null;
        const save = FIELDS[id].save()(value).catch((error) => {
            console.error('Field autosave failed', { id, error });
            return false;
        });
        autoSaveInFlight = save;
        void save.then((saved) => {
            if (autoSaveInFlight === save) {
                autoSaveInFlight = null;
            }
            if (!saved) return;
            if (isFieldInEdit(id)) {
                activeEdit.original = value;
                writeDraft(id, activeEdit.userText, value);
            } else if (readDraft(id) === value) {
                forgetDraft(id);
            }
        });
    }, deps.autoSaveTimeout);
}

// Greetings are saved per greeting through the pager, never from the field's value.
const GREETING_FIELD_ID = 'greeting_field';

// What the user typed in a field and hasn't got saved yet, kept in browser storage so it survives a reload. Greetings
// keep theirs through the greetings popup's own kept edit.
const DRAFT_PREFIX = 'CharacterFieldDraft:';

/** @param {string} id @returns {string | null} */
function draftKey(id) {
    const owner = deps?.editorKey?.() ?? '';
    return owner && id !== GREETING_FIELD_ID ? `${DRAFT_PREFIX}${owner}:${id}` : null;
}

/** @param {string} id @returns {string | null} */
function readDraft(id) {
    const key = draftKey(id);
    if (!key) return null;
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
}

/**
 * Keeps the field's typed text, or forgets it once it matches what is stored.
 * @param {string} id
 * @param {string} text
 * @param {string} stored
 */
function writeDraft(id, text, stored) {
    const key = draftKey(id);
    if (!key) return;
    try {
        if (text === stored) localStorage.removeItem(key);
        else localStorage.setItem(key, text);
    } catch {
        // Browser storage may be unavailable; the edit itself still holds the text.
    }
}

/** @param {string} id */
function forgetDraft(id) {
    const key = draftKey(id);
    if (!key) return;
    try {
        localStorage.removeItem(key);
    } catch {
        // Nothing to forget.
    }
}

/**
 * Shows, on a field that isn't being edited, that an earlier edit of it was never saved, with the means to take it
 * back up or let it go.
 * @param {string} id
 */
function showDraftNotice(id) {
    const panel = getPanel(id);
    panel.find('.field_draft_notice').remove();
    if (isFieldInEdit(id)) return;
    const draft = readDraft(id);
    const stored = String(getTextarea(id).val() ?? '');
    if (draft === null || draft === stored) {
        if (draft !== null) forgetDraft(id);
        return;
    }
    const { t } = deps;
    const notice = $('<div class="field_draft_notice"></div>');
    notice.append($('<span></span>').text(t`You have an edit of this field that wasn't saved.`));
    const restore = $('<button type="button" class="menu_button field_draft_restore"></button>').text(t`Restore it`);
    const discard = $('<button type="button" class="menu_button field_draft_discard"></button>').text(t`Discard it`);
    restore.on('click', () => restoreDraft(id));
    discard.on('click', () => {
        forgetDraft(id);
        notice.remove();
    });
    notice.append(restore, discard);
    getPreview(id).before(notice);
}

/** @param {string} id */
function restoreDraft(id) {
    const draft = readDraft(id);
    if (draft === null) return;
    const textarea = getTextarea(id);
    const stored = String(textarea.val() ?? '');
    textarea.val(draft);
    beginEdit(id);
    if (!isFieldInEdit(id)) {
        textarea.val(stored);
        return;
    }
    activeEdit.original = stored;
    activeEdit.userText = draft;
    getPanel(id).find('.field_draft_notice').remove();
}

/**
 * Saves at once (in create mode that sets the value Create builds from before the writer's next line runs). While a
 * save of this field is in flight, only the latest value waits for it.
 * @param {string} id
 * @param {string} value
 */
function scheduleOutsideWriteSave(id, value) {
    const pending = outsideWrites.get(id);
    if (pending) {
        pending.next = value;
        return;
    }
    const entry = { next: /** @type {string | null} */ (null) };
    outsideWrites.set(id, entry);
    const run = (/** @type {string} */ text) => FIELDS[id].save()(text)
        .catch((error) => {
            console.error('Saving a field written by code failed', { id, error });
        })
        .then(() => {
            if (entry.next === null) {
                outsideWrites.delete(id);
                return;
            }
            const next = entry.next;
            entry.next = null;
            return run(next);
        });
    void run(value);
}

/**
 * Code wrote a field and fired `input`, as upstream extensions do: the value is stored, as upstream stores it.
 * During an edit the write has replaced the user's text in the textarea; the written value is stored and becomes
 * what Cancel returns to, and the user's text is put back so their edit goes on.
 * @param {string} id
 * @param {string} value
 */
function onCodeWrite(id, value) {
    if (!isFieldInEdit(id)) {
        refreshFieldPreview(id);
        scheduleOutsideWriteSave(id, value);
        return;
    }
    if (value === activeEdit.original) {
        return;
    }
    activeEdit.original = value;
    scheduleOutsideWriteSave(id, value);
    if (activeEdit.userText !== value) {
        getTextarea(id).val(activeEdit.userText);
        const { t } = deps;
        toastr.info(t`This field was changed by an extension while you were editing it. Its change was saved; your edit is still open, and confirming it replaces that change.`);
    }
}

async function confirmEdit() {
    if (!activeEdit || activeEdit.saving) {
        return;
    }
    const edit = activeEdit;
    edit.saving = true;
    cancelAutoSave();
    if (autoSaveInFlight) {
        await autoSaveInFlight;
        cancelAutoSave();
    }
    const value = String(getTextarea(edit.id).val() ?? '');
    const saved = await FIELDS[edit.id].save()(value);
    edit.saving = false;
    if (saved) edit.original = value;
    if (saved && activeEdit === edit) {
        endEdit();
    }
    if (saved) forgetDraft(edit.id);
}

function cancelEdit() {
    if (!activeEdit || activeEdit.saving) {
        return;
    }
    if (!deps.power_user.auto_save_msg_edits) {
        getTextarea(activeEdit.id).val(activeEdit.original).trigger('input');
        forgetDraft(activeEdit.id);
    }
    endEdit();
}

/** Whether the "discard your changes?" question is on screen, so a second Escape doesn't ask again. */
let askingToDiscard = false;

/**
 * Escape ends the edit. With autosave off and the text changed, it asks before throwing the change away; saying no
 * keeps the edit open as it was.
 */
async function escapeEdit() {
    if (deps.power_user.auto_save_msg_edits) {
        void confirmEdit();
        return;
    }
    const edit = activeEdit;
    if (String(getTextarea(edit.id).val() ?? '') === edit.original) {
        cancelEdit();
        return;
    }
    if (askingToDiscard) return;
    askingToDiscard = true;
    const { t } = deps;
    let discard = false;
    try {
        discard = await deps.confirmDiscard(t`Discard your changes?`, t`What you typed in this field hasn't been saved.`);
    } finally {
        askingToDiscard = false;
    }
    if (activeEdit !== edit) return;
    if (discard) {
        cancelEdit();
    } else {
        focusEditing(edit.id);
    }
}

/**
 * Handles Ctrl+Enter / Escape for the field in edit mode, when that field is visible.
 * @param {'confirm'|'escape'} key
 * @returns {boolean} Whether the key was handled.
 */
export function handleFieldEditKey(key) {
    if (!activeEdit || !getTextarea(activeEdit.id).is(':visible')) {
        return false;
    }
    if (key === 'confirm') {
        void confirmEdit();
    } else {
        void escapeEdit();
    }
    return true;
}

/** @type {Map<string, { layer: import('./editor-layer.js').EditorLayer, placeholder: HTMLElement }>} Maximized tab panels by field id. */
const maximizedPanels = new Map();

/**
 * Maximizing moves the whole tab panel, in whatever state it's in, into an expanded editor layer; a placeholder
 * stands in for it in the drawer. Restoring moves it back.
 * @param {HTMLElement} button
 */
function toggleMaximize(button) {
    const id = String($(button).attr('data-for'));
    const open = maximizedPanels.get(id);
    if (open) {
        open.layer.close();
        return;
    }

    const { t } = deps;
    const panel = getPanel(id);
    const panelEl = panel[0];
    if (!panelEl) return;

    const placeholder = document.createElement('div');
    placeholder.classList.add('char_info_tab_panel_placeholder', 'tab-contents');
    const note = document.createElement('div');
    note.textContent = t`This field is open in the expanded editor.`;
    const restore = document.createElement('div');
    restore.classList.add('menu_button', 'menu_button_icon');
    restore.textContent = t`Restore`;
    restore.addEventListener('click', () => maximizedPanels.get(id)?.layer.close());
    placeholder.append(note, restore);

    const putBack = keepViewState(panelEl);
    panelEl.replaceWith(placeholder);
    panel.addClass('maximized');
    setMaximizeButton(panel, true);
    const layer = openEditorLayer(panelEl, {
        closeTitle: t`Restore`,
        // Escape first ends an edit in progress, as it does in the drawer.
        escapeCloses: () => !panel.hasClass('field_editing'),
        onClose: () => {
            maximizedPanels.delete(id);
            const keep = keepViewState(panelEl);
            placeholder.replaceWith(panelEl);
            panel.removeClass('maximized');
            setMaximizeButton(panel, false);
            keep();
            focusEditing(id);
        },
    });
    maximizedPanels.set(id, { layer, placeholder });
    putBack();
    focusEditing(id);
}

const TAB_RADIO = 'input[name="charInfoTabs_tab"]';
const TAB_SWITCH_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', ' ']);

/** @returns {string | null} The `charInfoTabs_tab` value of the tab holding the field in edit mode. */
function editingTab() {
    if (!activeEdit) return null;
    const panelId = getPanel(activeEdit.id).attr('id') ?? '';
    return panelId.startsWith('charInfoTab_') ? panelId.slice('charInfoTab_'.length) : null;
}

/** Draws the eye to the field being edited's ✓ ✕, so it's clear why the tab didn't switch. */
function flashEditControls() {
    const panel = getPanel(activeEdit.id);
    panel.removeClass('field_edit_attention');
    void panel[0]?.offsetWidth;
    panel.addClass('field_edit_attention');
    setTimeout(() => panel.removeClass('field_edit_attention'), 800);
}

/**
 * While a field is being edited, the character info tabs don't switch away from it: clicks, keys, and our own code
 * switching them. The edit has to be confirmed or cancelled first.
 */
function initTabSwitchGuard() {
    const tabs = document.getElementById('charInfoTabs');
    if (!tabs) return;
    const blocks = (/** @type {string | null} */ value) => {
        const current = editingTab();
        return current !== null && value !== null && value !== current;
    };

    tabs.addEventListener('click', (event) => {
        const label = /** @type {Element} */ (event.target).closest?.('#charInfoTabs > .tab-title');
        const value = label?.querySelector(TAB_RADIO)?.getAttribute('value') ?? null;
        if (!blocks(value)) return;
        event.preventDefault();
        event.stopPropagation();
        flashEditControls();
    }, true);

    tabs.addEventListener('keydown', (event) => {
        if (!(event.target instanceof HTMLInputElement) || !event.target.matches(TAB_RADIO)) return;
        if (!TAB_SWITCH_KEYS.has(event.key) || editingTab() === null) return;
        if (event.key === ' ' && !blocks(event.target.value)) return;
        event.preventDefault();
        event.stopPropagation();
        flashEditControls();
    }, true);

    // Anything else that checks another tab (our own code dispatching `change`) is put back.
    tabs.addEventListener('change', (event) => {
        if (!(event.target instanceof HTMLInputElement) || !event.target.matches(TAB_RADIO)) return;
        const current = editingTab();
        if (!blocks(event.target.value)) return;
        event.stopImmediatePropagation();
        const radio = tabs.querySelector(`${TAB_RADIO}[value="${current}"]`);
        if (radio instanceof HTMLInputElement) radio.checked = true;
        flashEditControls();
    }, true);
}

/**
 * A field in edit mode takes focus after it moves, at the cursor it had, so typing carries on.
 * @param {string} id
 */
function focusEditing(id) {
    if (!isFieldInEdit(id)) return;
    const view = liveEditor?.id === id ? liveEditor.editor?.view : null;
    if (!view) {
        getTextarea(id)[0]?.focus({ preventScroll: true });
        return;
    }
    // Moving the editor loses the page's selection inside it: measure it where it is now, and put its cursor back.
    view.requestMeasure();
    view.focus();
    view.dispatch({ selection: view.state.selection, scrollIntoView: true });
}

/**
 * @param {JQuery<HTMLElement>} panel
 * @param {boolean} maximized
 */
function setMaximizeButton(panel, maximized) {
    const { t } = deps;
    panel.find('.field_maximize')
        .toggleClass('fa-maximize', !maximized)
        .toggleClass('fa-minimize', maximized)
        .attr('title', maximized ? t`Restore` : t`Expand the editor`)
        .attr('data-i18n', maximized ? '[title]Restore' : '[title]Expand the editor');
}

/**
 * @param {EventTarget} target What was clicked.
 * @param {Element} preview The field preview the click landed in.
 * @returns {boolean} Whether the click landed on a link inside the preview.
 */
function isOnLink(target, preview) {
    return target instanceof Element && $(target).closest('a[href]', preview).length > 0;
}

/**
 * @param {EventTarget} target What was clicked.
 * @returns {boolean} Whether the click landed on an image that opens the lightbox (image-lightbox.js).
 */
function isOnLightboxImage(target) {
    return target instanceof HTMLImageElement && !target.closest('[data-result]');
}

/** @param {CharacterFieldEditorDeps} dependencies */
export function initCharacterFieldEditor(dependencies) {
    deps = dependencies;
    initTabSwitchGuard();

    // Capture phase, so it runs before the document's own Escape handlers (which close drawers and panels); a
    // handled Escape is marked with preventDefault, and those handlers leave it alone.
    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return;
        // The editor's copy of a key on its textarea: the original already came through here.
        if (isEditorEvent(event)) return;
        // An open suggestion list or panel in the editor takes the Escape first.
        const editor = /** @type {Element} */ (event.target).closest?.('.cm-editor');
        if (editor?.querySelector(EDITOR_ESCAPE_TAKERS)) return;
        if (handleFieldEditKey('escape')) {
            event.preventDefault();
        }
    }, { capture: true });

    $(document).on('click', '.field_edit_toggle', function () {
        beginEdit(String($(this).attr('data-for')));
    });

    $(document).on('click', '.field_edit_done', function () {
        void confirmEdit();
    });

    $(document).on('click', '.field_edit_cancel', function () {
        cancelEdit();
    });

    $(document).on('click', '.field_maximize', function () {
        toggleMaximize(this);
    });

    $(document).on('dblclick', '.field_preview', function (event) {
        if (isOnLink(event.target, this) || isOnLightboxImage(event.target)) return;
        beginEdit(String($(this).attr('data-for')));
    });

    $(document).on('click', '.field_preview', function (event) {
        if (!deps.power_user.click_to_edit) return;
        if (isOnLink(event.target, this)) return;
        if (window.getSelection().toString()) return;
        beginEdit(String($(this).attr('data-for')));
    });

    for (const id of Object.keys(FIELDS)) {
        getTextarea(id).on('input', function (event) {
            const value = String($(this).val() ?? '');
            // Typing is a trusted event; `.val(x).trigger('input')` or a dispatched Event is code writing the field.
            if (isUserEvent(event.originalEvent)) {
                if (isFieldInEdit(id)) {
                    activeEdit.userText = value;
                    writeDraft(id, value, activeEdit.original);
                    if (deps.power_user.auto_save_msg_edits) {
                        scheduleAutoSave(id, value);
                    }
                }
                return;
            }
            if (id !== GREETING_FIELD_ID) {
                onCodeWrite(id, value);
            }
        });
        refreshFieldPreview(id);
    }
}
