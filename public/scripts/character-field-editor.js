import { refreshCharInfoTabDimming } from './char-info-tab-dimming.js';
import { keepViewState, openEditorLayer } from './editor-layer.js';
import { MacroValues } from './macro-values.js';
import { registerCommands } from './new-ui-page.js';
import { cardTextSetup } from './message-text.js';
import { loadChatEditor } from './chat-text/editors.js';
import { editPosition, showText, stopText } from './chat-text/surface.js';
import { drawerStackChanged } from './drawer-stack.js';
import { withFilledAbout } from './safe-macros.js';

/**
 * @typedef {object} CharacterFieldEditorDeps
 * @property {() => import('./macro-values.js').MacroScope} macroScope
 * @property {(styleScope: string) => string} notesStyleScope the scope a card's creator's notes limit their styles to,
 *   given the element they are previewed in
 * @property {{ auto_save_msg_edits: boolean, click_to_edit: boolean }} power_user
 * @property {(strings: TemplateStringsArray, ...values: any[]) => string} t
 * @property {(macroName: string) => import('./macro-pill.js').MacroPerson | null} macroPerson
 * @property {number} autoSaveTimeout
 * @property {(value: string) => Promise<boolean>} saveCreatorNotesField
 * @property {(value: string) => Promise<boolean>} saveDescriptionField
 * @property {(value: string, options?: { confirmed?: boolean }) => Promise<boolean>} saveGreetingField
 * @property {(value: string) => Promise<boolean>} saveSystemPromptField
 * @property {(value: string) => Promise<boolean>} savePostHistoryInstructionsField
 * @property {(value: string) => Promise<boolean>} savePersonalityField
 * @property {(value: string) => Promise<boolean>} saveScenarioField
 * @property {(value: string) => Promise<boolean>} saveCharacterNoteField
 * @property {(value: string) => Promise<boolean>} saveExampleMessagesField
 * @property {(title: string, text: string) => Promise<boolean>} confirmDiscard
 * @property {(id: string) => void} [onEdited] hears each edit of a field's text
 * @property {(id: string) => void} [onEditStart]
 * @property {(id: string) => void} [onEditEnd]
 * @property {() => string} [editorKey]
 */

/** @type {CharacterFieldEditorDeps} */
let deps = null;

const typedName = () => String($('#character_name_pole').val() ?? '');

/**
 * @typedef {object} EditableField
 * @property {() => (value: string, options?: { confirmed?: boolean }) => Promise<boolean>} save
 * @property {'greeting' | 'notes' | 'literal'} kind how its text is drawn
 * @property {string} [styleScope] where a notes field's styles apply
 */

/** @type {Record<string, EditableField>} */
const FIELDS = {
    creator_notes_textarea: { save: () => deps.saveCreatorNotesField, kind: 'notes', styleScope: '#creator_notes_preview' },
    description_textarea: { save: () => deps.saveDescriptionField, kind: 'notes', styleScope: '#description_preview' },
    greeting_field: { save: () => deps.saveGreetingField, kind: 'greeting' },
    system_prompt_textarea: { save: () => deps.saveSystemPromptField, kind: 'literal' },
    post_history_instructions_textarea: { save: () => deps.savePostHistoryInstructionsField, kind: 'literal' },
    personality_textarea: { save: () => deps.savePersonalityField, kind: 'literal' },
    scenario_pole: { save: () => deps.saveScenarioField, kind: 'literal' },
    depth_prompt_prompt: { save: () => deps.saveCharacterNoteField, kind: 'literal' },
    mes_example_textarea: { save: () => deps.saveExampleMessagesField, kind: 'literal' },
};

/**
 * @param {string} id
 * @param {MacroValues} values
 * @returns {import('./chat-text/surface.js').TextSetup}
 */
function fieldSetup(id, values) {
    const field = FIELDS[id];
    return cardTextSetup(field.kind, {
        values,
        person: name => deps.macroPerson(name),
        styleScope: field.styleScope === undefined ? '' : deps.notesStyleScope(field.styleScope),
    });
}

/** @type {{ id: string, original: string, userText: string, saving: boolean } | null} */
let activeEdit = null;

/** @type {Map<string, { next: string | null }>} */
const outsideWrites = new Map();

/** @type {ReturnType<typeof setTimeout> | null} */
let autoSaveTimer = null;

/** @type {Promise<unknown> | null} */
let autoSaveInFlight = null;

/**
 * @param {string} id
 * @returns {JQuery<HTMLTextAreaElement>}
 */
function getTextarea(id) {
    return /** @type {JQuery<HTMLTextAreaElement>} */ ($(`#${id}`));
}

// Form values retain the portable card text; only the editor hides the prefix.
const originalPrefixes = new Map();
const ORIGINAL_MACRO = /\{\{original\}\}/i;

/** @param {string} id @returns {string} */
function projectOriginal(id) {
    const value = String(getTextarea(id).val() ?? '');
    if (!$(`.field_include_original[data-for="${id}"]`).length) return value;
    const prefix = value.match(/^\{\{original\}\}(?:\r?\n)?/i)?.[0] ?? '';
    originalPrefixes.set(id, prefix);
    const body = value.slice(prefix.length);
    updateOriginalControl(id, body);
    return body;
}

/** @param {string} id @param {string} body */
function updateOriginalControl(id, body) {
    const custom = ORIGINAL_MACRO.test(body);
    $(`.field_include_original[data-for="${id}"]`)
        .prop('checked', Boolean(originalPrefixes.get(id)))
        .prop('disabled', custom || Boolean(activeEdit?.saving))
        .closest('label')
        .attr('title', custom
            ? deps.t`Edit the {{original}} macro in the text to change its placement.`
            : id === 'system_prompt_textarea'
                ? deps.t`Prepend {{original}} to include the default System Prompt before this text.`
                : deps.t`Prepend {{original}} to include the default Post-History Instructions before this text.`);
}

/** @param {string} id @param {string} body @returns {string} */
function originalValue(id, body) {
    return (originalPrefixes.get(id) ?? '') + body;
}

/** @param {string} id */
function getPreview(id) {
    return $(`.field_preview[data-for="${id}"]`);
}

/** @param {string} id */
function getPanel(id) {
    return getTextarea(id).closest('.char_info_tab_panel');
}

/** @returns {boolean} */
function isMessageEditOpen() {
    return $('.mes_editor').length > 0 || $('.reasoning_editor').length > 0;
}

/**
 * @param {string} id
 * @returns {boolean}
 */
function isFieldInEdit(id) {
    return activeEdit?.id === id;
}

/** @returns {boolean} */
export function isFieldBeingEdited() {
    return activeEdit !== null && !activeEdit.saving;
}

/**
 * @returns {boolean}
 */
export function blockWhileFieldEditing() {
    if (!activeEdit) {
        return false;
    }
    if (getPanel(activeEdit.id)[0]?.checkVisibility({ visibilityProperty: true })) {
        flashEditControls();
    } else {
        const { t } = deps;
        toastr.warning(t`A field is being edited - confirm or cancel it first.`);
    }
    return true;
}

/**
 * @param {string} id
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
 * @param {string} id
 * @returns {import('./macro-values.js').MacroScope}
 */
function macroScopeOf(id) {
    const scope = deps.macroScope();
    return id === GREETING_FIELD_ID ? { ...scope, name2: typedName() } : scope;
}

/** @type {Map<string, number>} */
const previewRenders = new Map();
let previewRenderCount = 0;

/**
 * @param {string} id
 * @param {MacroValues} [values]
 */
function refreshFieldPreview(id, values = new MacroValues(() => macroScopeOf(id))) {
    projectOriginal(id);
    refreshCharInfoTabDimming();
    const field = FIELDS[id];
    const preview = getPreview(id);
    if (!field || !preview.length || !deps) {
        return;
    }
    const text = String(getTextarea(id).val() ?? '');
    const render = ++previewRenderCount;
    previewRenders.set(id, render);
    if (text === '') {
        stopText(preview[0]);
        preview.addClass('field_preview_empty');
        preview.text(String(getTextarea(id).attr('placeholder') ?? ''));
        return;
    }
    void values.want(text).then(() => {
        if (previewRenders.get(id) !== render) return;
        preview.removeClass('field_preview_empty');
        showText(preview[0], text, fieldSetup(id, values));
    });
}

/**
 * @returns {boolean}
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

/**
 * @param {string} id
 * @param {number} [at]
 */
export function beginEdit(id, at = 0) {
    if (activeEdit?.id === id) {
        return;
    }
    if (blockFieldEditStart()) {
        return;
    }
    const text = String(getTextarea(id).val() ?? '');
    activeEdit = { id, original: text, userText: text, saving: false };
    getPanel(id).addClass('field_editing');
    drawerStackChanged();
    deps.onEditStart?.(id);
    const body = projectOriginal(id);
    void mountFieldEditor(id, body, Math.max(0, at - (text.length - body.length)));
}

/** @type {{ id: string, editor: import('./chat-text/editor.js').ChatEditor | null, ended: boolean, values: MacroValues } | null} */
let fieldEditor = null;

/**
 * @param {HTMLElement} preview
 * @returns {string} the classes the preview's text and its box are drawn with
 */
const previewTextClasses = preview => [...preview.classList].filter(name => !name.startsWith('field_preview')).join(' ');

/**
 * Opens the editor on a field in place of its preview, drawn with the preview's classes
 * @param {string} id
 * @param {string} text the field's text
 * @param {number} at where the cursor goes
 */
async function mountFieldEditor(id, text, at) {
    const values = new MacroValues(() => macroScopeOf(id));
    const holder = { id, editor: null, ended: false, values };
    fieldEditor = holder;
    const textarea = getTextarea(id)[0];
    const preview = getPreview(id)[0];
    try {
        const asked = values.want(text);
        const { chatEditor } = await loadChatEditor();
        if (holder.ended) return;
        const editor = chatEditor({
            parent: preview.parentElement,
            setup: fieldSetup(id, values),
            macroValue: values.valueOf,
            macroValues: values,
            speaker: '',
            person: name => withFilledAbout(deps.macroPerson(name), name, values.valueOf),
            initial: text,
            edited: edited => fieldEdited(id, edited),
            save: async (saved) => {
                if (!await FIELDS[id].save()(originalValue(id, saved))) throw new Error('The field was not saved');
            },
            className: `field_editor ${previewTextClasses(preview)}`,
            placeholder: textarea.placeholder,
            presetContext: () => ({ characterName: typedName() }),
        });
        holder.editor = editor;
        const shown = /** @type {HTMLElement} */ (editor.view.dom.closest('.chat-editor'));
        preview.after(shown);
        editor.place(Math.min(at, text.length));
        editor.view.focus();
        if (await asked && !holder.ended) editor.redraw();
    } catch (error) {
        console.error('The editor could not be loaded', error);
        toastr.error(deps.t`The editor could not be loaded.`);
        if (activeEdit?.id === id) endEdit();
    }
}

function unmountFieldEditor() {
    if (!fieldEditor) return;
    fieldEditor.ended = true;
    fieldEditor.editor?.stop();
    fieldEditor = null;
}

/**
 * Takes an edit of a field's text into its form value and draft, autosaving it when that is on
 * @param {string} id
 * @param {string} text
 */
function fieldEdited(id, text) {
    if (!isFieldInEdit(id)) return;
    updateOriginalControl(id, text);
    text = originalValue(id, text);
    getTextarea(id).val(text);
    activeEdit.userText = text;
    writeDraft(id, text, activeEdit.original);
    refreshCharInfoTabDimming();
    if (deps.power_user.auto_save_msg_edits) scheduleAutoSave(id);
    deps.onEdited?.(id);
}

function endEdit() {
    const { id } = activeEdit;
    const values = fieldEditor?.id === id ? fieldEditor.values : undefined;
    unmountFieldEditor();
    activeEdit = null;
    getPanel(id).removeClass('field_editing');
    drawerStackChanged();
    deps.onEditEnd?.(id);
    refreshFieldPreview(id, values);
}

function cancelAutoSave() {
    if (autoSaveTimer !== null) {
        clearTimeout(autoSaveTimer);
        autoSaveTimer = null;
    }
}

/**
 * Saves the text of the field's editor after a pause in its edits
 * @param {string} id
 */
function scheduleAutoSave(id) {
    cancelAutoSave();
    autoSaveTimer = setTimeout(() => {
        autoSaveTimer = null;
        const editor = fieldEditor?.id === id ? fieldEditor.editor : null;
        if (!editor) return;
        const value = originalValue(id, editor.text());
        const save = editor.save().then(() => true, (error) => {
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

const GREETING_FIELD_ID = 'greeting_field';

const DRAFT_PREFIX = 'CharacterFieldDraft:';

/**
 * @param {string} id
 * @returns {string | null}
 */
function draftKey(id) {
    const owner = deps?.editorKey?.() ?? '';
    return owner && id !== GREETING_FIELD_ID ? `${DRAFT_PREFIX}${owner}:${id}` : null;
}

/**
 * @param {string} id
 * @returns {string | null}
 */
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
    getPanel(edit.id).addClass('field_edit_saving');
    drawerStackChanged();
    cancelAutoSave();
    if (autoSaveInFlight) {
        await autoSaveInFlight;
        cancelAutoSave();
    }
    const value = String(getTextarea(edit.id).val() ?? '');
    const saved = await FIELDS[edit.id].save()(value, { confirmed: true });
    edit.saving = false;
    getPanel(edit.id).removeClass('field_edit_saving');
    if (saved) edit.original = value;
    if (saved && activeEdit === edit) {
        endEdit();
    } else {
        drawerStackChanged();
    }
    if (saved) forgetDraft(edit.id);
}

/**
 * Ends the edit of a field, putting back its saved text whatever the autosave setting.
 * @param {string} id
 * @returns {boolean} whether that field was in edit and is no longer
 */
export function discardFieldEdit(id) {
    if (!isFieldInEdit(id) || activeEdit.saving) return false;
    getTextarea(id).val(activeEdit.original);
    forgetDraft(id);
    endEdit();
    return true;
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

let askingToDiscard = false;

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
 * @param {'confirm'|'escape'} key
 * @returns {boolean}
 */
/** @returns {boolean} whether a character field is being edited where it can be seen */
export function fieldEditOpen() {
    return activeEdit !== null && activeEdit !== undefined && getPanel(activeEdit.id).is(':visible');
}

export function handleFieldEditKey(key) {
    if (!fieldEditOpen()) {
        return false;
    }
    if (key === 'confirm') {
        void confirmEdit();
    } else {
        void escapeEdit();
    }
    return true;
}

/** @type {Map<string, { layer: import('./editor-layer.js').EditorLayer, placeholder: HTMLElement }>} */
const maximizedPanels = new Map();

/**
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

/** @returns {string | null} */
function editingTab() {
    if (!activeEdit) return null;
    const panelId = getPanel(activeEdit.id).attr('id') ?? '';
    return panelId.startsWith('charInfoTab_') ? panelId.slice('charInfoTab_'.length) : null;
}

function flashEditControls() {
    const panel = getPanel(activeEdit.id);
    panel.removeClass('field_edit_attention');
    void panel[0]?.offsetWidth;
    panel.addClass('field_edit_attention');
    setTimeout(() => panel.removeClass('field_edit_attention'), 800);
}

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

    const { t } = deps;
    registerCommands(() => [{
        id: 'characterField.keepTab',
        label: t`Stay on the tab of the field being edited`,
        category: t`Editing`,
        keys: ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Space'],
        typing: true,
        hidden: true,
        when: () => document.activeElement instanceof HTMLInputElement && document.activeElement.matches(TAB_RADIO) && editingTab() !== null,
        run: (event) => {
            // Space only selects the focused tab, which may be the edited one
            const radio = /** @type {HTMLInputElement} */ (document.activeElement);
            if (event instanceof KeyboardEvent && event.code === 'Space' && !blocks(radio.value)) return false;
            flashEditControls();
        },
    }], { target: tabs, capture: true });

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
 * @param {string} id
 */
function focusEditing(id) {
    if (!isFieldInEdit(id)) return;
    const view = fieldEditor?.id === id ? fieldEditor.editor?.view : null;
    if (!view) return;
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
 * @param {HTMLElement} preview
 * @param {MouseEvent} event
 */
function beginEditAtClick(preview, event) {
    const id = String($(preview).attr('data-for'));
    const at = editPosition(event, preview, deps.power_user.click_to_edit);
    if (at !== null) beginEdit(id, at);
}

/** @param {CharacterFieldEditorDeps} dependencies */
export function initCharacterFieldEditor(dependencies) {
    deps = dependencies;
    initTabSwitchGuard();

    $(document).on('change', '.field_include_original', function () {
        const id = String($(this).attr('data-for'));
        const checked = this.checked;
        if (!isFieldInEdit(id)) beginEdit(id);
        if (!isFieldInEdit(id) || activeEdit.saving) {
            projectOriginal(id);
            return;
        }
        const value = String(getTextarea(id).val() ?? '');
        const body = value.slice((originalPrefixes.get(id) ?? '').length);
        originalPrefixes.set(id, checked ? '{{original}}\n' : '');
        fieldEdited(id, body);
    });

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

    $(document).on('click dblclick', '.field_preview', function (event) {
        beginEditAtClick(this, event.originalEvent);
    });

    for (const id of Object.keys(FIELDS)) {
        if (id !== GREETING_FIELD_ID) {
            getTextarea(id).on('input', function () {
                onCodeWrite(id, String($(this).val() ?? ''));
            });
        }
        refreshFieldPreview(id);
    }
}
