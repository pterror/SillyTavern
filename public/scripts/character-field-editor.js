import { DOMPurify } from '../lib.js';
import { renderMarkdownLiteralTags } from './marked-processor.js';
import { refreshCharInfoTabDimming } from './char-info-tab-dimming.js';
import { keepViewState, openEditorLayer } from './editor-layer.js';

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
 * @property {(id: string) => void} [onEditStart] Called once a field has entered edit mode.
 * @property {(id: string) => void} [onEditEnd] Called once a field has left edit mode (Done or cancel).
 */

/** @type {CharacterFieldEditorDeps} */
let deps = null;

/** @param {string} text @returns {string} */
function renderLiteralTagsPreview(text) {
    const { text: substituted, values } = substituteMacrosWithPlaceholders(text, deps.substituteParams);
    const html = DOMPurify.sanitize(renderMarkdownLiteralTags(substituted));
    return insertMacroSpans(html, values);
}

/** @param {string} text @returns {string} */
function renderGreetingPreview(text) {
    const name = String($('#character_name_pole').val() ?? '');
    const { text: substituted, values } = substituteMacrosWithPlaceholders(text, deps.substituteParams, { name2Override: name });
    const html = deps.messageFormatting(substituted, name, false, false, 0);
    return insertMacroSpans(html, values);
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

/** @type {{ id: string, original: string, saving: boolean } | null} The one field in edit mode. */
let activeEdit = null;

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
    const { t } = deps;
    toastr.warning(t`A field is being edited - confirm or cancel it first.`);
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
    activeEdit = { id, original: String(textarea.val() ?? ''), saving: false };
    getPanel(id).addClass('field_editing');
    deps.onEditStart?.(id);
    textarea.trigger('focus');
}

function endEdit() {
    const { id } = activeEdit;
    activeEdit = null;
    getPanel(id).removeClass('field_editing');
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
        void save.then(() => {
            if (autoSaveInFlight === save) {
                autoSaveInFlight = null;
            }
        });
    }, deps.autoSaveTimeout);
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
    const saved = await FIELDS[edit.id].save()(String(getTextarea(edit.id).val() ?? ''));
    edit.saving = false;
    if (saved && activeEdit === edit) {
        endEdit();
    }
}

function cancelEdit() {
    if (!activeEdit || activeEdit.saving) {
        return;
    }
    if (!deps.power_user.auto_save_msg_edits) {
        getTextarea(activeEdit.id).val(activeEdit.original).trigger('input');
    }
    endEdit();
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
    if (key === 'confirm' || deps.power_user.auto_save_msg_edits) {
        void confirmEdit();
    } else {
        cancelEdit();
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

/**
 * A field in edit mode takes focus after it moves, at the cursor it had, so typing carries on.
 * @param {string} id
 */
function focusEditing(id) {
    if (isFieldInEdit(id)) getTextarea(id)[0]?.focus({ preventScroll: true });
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
        getTextarea(id).on('input', function () {
            if (isFieldInEdit(id) && deps.power_user.auto_save_msg_edits) {
                scheduleAutoSave(id, String($(this).val() ?? ''));
            }
        });
        refreshFieldPreview(id);
    }
}
