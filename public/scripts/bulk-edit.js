import { characterGroupOverlay } from '../script.js';
import { BulkEditOverlayState, CharacterContextMenu } from './BulkEditOverlay.js';
import { event_types, eventSource } from './events.js';

let is_bulk_edit = false;

const enableBulkEdit = () => {
    enableBulkSelect();
    characterGroupOverlay.selectState();
    // show the bulk edit option buttons
    $('.bulkEditOptionElement').show();
    is_bulk_edit = true;
    characterGroupOverlay.updateSelectedCount(0);
};

const disableBulkEdit = () => {
    disableBulkSelect();
    characterGroupOverlay.browseState();
    // hide the bulk edit option buttons
    $('.bulkEditOptionElement').hide();
    is_bulk_edit = false;
    characterGroupOverlay.updateSelectedCount(0);
};

const toggleBulkEditMode = (isBulkEdit) => {
    if (isBulkEdit) {
        disableBulkEdit();
    } else {
        enableBulkEdit();
    }
};

/**
 * Toggles bulk edit mode on/off when the edit button is clicked.
 */
function onEditButtonClick() {
    toggleBulkEditMode(is_bulk_edit);
}

/**
 * Selects every character the list shows (on every page, not just this one), or nothing when that is the selection.
 */
function onSelectAllButtonClick() {
    characterGroupOverlay.toggleSelectAll();
}

/**
 * Deletes all characters that have been selected via the bulk checkboxes.
 */
async function onDeleteButtonClick() {
    // We just let the button trigger the context menu delete option
    await characterGroupOverlay.handleContextMenuDelete();
}

/**
 * Enables bulk selection by adding a checkbox next to each character.
 */
function enableBulkSelect() {
    $('#rm_print_characters_block .character_select').each((i, el) => {
        // Prevent checkbox from adding multiple times (because of stage change callback)
        if ($(el).find('.bulk_select_checkbox').length > 0) {
            return;
        }
        const checkbox = $('<input type=\'checkbox\' class=\'bulk_select_checkbox\'>');
        checkbox.on('change', () => {
            // Do something when the checkbox is changed
        });
        $(el).prepend(checkbox);
    });
    $('#rm_print_characters_block.group_overlay_mode_select .bogus_folder_select, #rm_print_characters_block.group_overlay_mode_select .group_select')
        .addClass('disabled');

    $('#rm_print_characters_block').addClass('bulk_select');
    // We also need to disable the default click event for the character_select divs
    // Namespaced so that running this again for a newly drawn page doesn't stack another handler.
    $(document).off('click.bulkSelect').on('click.bulkSelect', '.bulk_select_checkbox', function (event) {
        event.stopImmediatePropagation();
    });
}

/**
 * Disables bulk selection by removing the checkboxes.
 */
function disableBulkSelect() {
    $('.bulk_select_checkbox').remove();
    $('#rm_print_characters_block.group_overlay_mode_select .bogus_folder_select, #rm_print_characters_block.group_overlay_mode_select .group_select')
        .removeClass('disabled');
    $('#rm_print_characters_block').removeClass('bulk_select');
}

/**
 * Entry point that runs on page load.
 */
export function initBulkEdit() {
    characterGroupOverlay.addStateChangeCallback((state) => {
        if (state === BulkEditOverlayState.select) enableBulkEdit();
        if (state === BulkEditOverlayState.browse) disableBulkEdit();
    });

    $('#bulkEditButton').on('click', onEditButtonClick);
    $('#bulkSelectAllButton').on('click', onSelectAllButtonClick);
    $('#bulkDeleteButton').on('click', onDeleteButtonClick);

    const characterContextMenu = new CharacterContextMenu(characterGroupOverlay);
    // Before the overlay's own handler, which marks the rows of a new page selected, checkboxes included.
    eventSource.on(event_types.CHARACTER_PAGE_LOADED, () => {
        if (is_bulk_edit) enableBulkSelect();
    });
    eventSource.on(event_types.CHARACTER_PAGE_LOADED, characterGroupOverlay.onPageLoad);
    console.debug('Character context menu initialized', characterContextMenu);
}
