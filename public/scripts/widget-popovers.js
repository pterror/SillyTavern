/**
 * The floating parts jQuery UI's autocomplete and select2 make, shown as popovers opened from their field while open,
 * so they are in the top layer like every other floating surface.
 */

/** @param {Element} element */
function isInTopLayer(element) {
    return element.parentElement?.closest(':popover-open, dialog:modal') != null;
}

/**
 * @param {HTMLElement} element
 * @param {Element} source
 */
function showFrom(element, source) {
    if (!element.isConnected || isInTopLayer(element)) return;
    element.popover = 'manual';
    if (!element.matches(':popover-open')) element.showPopover({ source: /** @type {HTMLElement} */ (source) });
}

/** @param {HTMLElement | null | undefined} element */
function hide(element) {
    if (element?.matches(':popover-open')) element.hidePopover();
}

/**
 * The dropdown of a select2 select: the container its results are in, which select2's selection names as the one it
 * controls
 * @param {Element} select
 * @returns {HTMLElement | null}
 */
function select2Dropdown(select) {
    const controlled = select.nextElementSibling?.querySelector('.select2-selection')?.getAttribute('aria-controls');
    const results = controlled ? document.getElementById(controlled) : null;
    return /** @type {HTMLElement | null} */ (results?.closest('.select2-container') ?? null);
}

export function initWidgetPopovers() {
    $(document).on('autocompleteopen', (event) => {
        const field = $(event.target);
        const menu = field.autocomplete('widget')[0];
        showFrom(menu, event.target);
        // Placed before it was in the top layer; its place is against the window now
        $(menu).position({ ...field.autocomplete('option', 'position'), of: event.target });
    });
    $(document).on('autocompleteclose', (event) => hide($(event.target).autocomplete('widget')[0]));
    $(document).on('select2:open', (event) => {
        // Heard before or after select2 attaches the dropdown
        queueMicrotask(() => {
            const dropdown = select2Dropdown(event.target);
            if (dropdown) showFrom(dropdown, event.target);
        });
    });
    $(document).on('select2:close', (event) => hide(select2Dropdown(event.target)));
}
