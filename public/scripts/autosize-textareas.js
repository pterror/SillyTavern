/**
 * Fallback for `textarea.autoSetHeight` in browsers lacking `field-sizing: content` or typed `attr()`.
 */
import { eventSource, event_types } from './events.js';

const SELECTOR = 'textarea.autoSetHeight';
const supportsFieldSizing = CSS.supports('field-sizing', 'content');
const supportsTypedAttr = CSS.supports('min-height', 'calc(attr(rows type(<number>), 2) * 1lh)');

/**
 * @param {HTMLTextAreaElement} textarea
 * @returns {number} border-box height at the `rows=` size
 */
function measureRowsHeight(textarea) {
    const { height, minHeight, fieldSizing } = textarea.style;
    textarea.style.height = '';
    textarea.style.minHeight = '';
    if (supportsFieldSizing) {
        textarea.style.fieldSizing = 'fixed';
    }
    const rowsHeight = textarea.offsetHeight;
    textarea.style.height = height;
    textarea.style.minHeight = minHeight;
    textarea.style.fieldSizing = fieldSizing;
    return rowsHeight;
}

/**
 * @param {HTMLTextAreaElement} textarea
 */
function autosizeTextarea(textarea) {
    if (!textarea.isConnected || textarea.getClientRects().length === 0) {
        return;
    }
    const rowsHeight = measureRowsHeight(textarea);
    if (!supportsFieldSizing) {
        textarea.style.height = `${rowsHeight}px`;
        const style = getComputedStyle(textarea);
        const borders = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
        textarea.style.height = `${Math.max(rowsHeight, textarea.scrollHeight + borders)}px`;
    } else if (!supportsTypedAttr) {
        textarea.style.minHeight = `${rowsHeight}px`;
    }
}

/**
 * Call after setting a value programmatically. Textareas that aren't rendered are skipped.
 * @param {ParentNode|Element} [root=document]
 */
export function autosizeTextareas(root = document) {
    if (supportsFieldSizing && supportsTypedAttr) {
        return;
    }
    if (root instanceof HTMLTextAreaElement) {
        if (root.matches(SELECTOR)) {
            autosizeTextarea(root);
        }
        return;
    }
    root.querySelectorAll(SELECTOR).forEach(el => autosizeTextarea(/** @type {HTMLTextAreaElement} */ (el)));
}

/**
 * Installs delegated listeners for typing, radio-tab switches and the character editor opening.
 */
export function initAutosizeTextareas() {
    if (supportsFieldSizing && supportsTypedAttr) {
        return;
    }
    document.addEventListener('input', (event) => {
        if (event.target instanceof HTMLTextAreaElement) {
            autosizeTextareas(event.target);
        }
    });
    document.addEventListener('change', (event) => {
        const target = event.target;
        if (!(target instanceof HTMLInputElement) || !target.matches('.tab-title > .invisible-radio') || !target.checked) {
            return;
        }
        const panel = target.closest('.tab-title')?.nextElementSibling;
        if (panel?.classList.contains('tab-contents')) {
            autosizeTextareas(panel);
        }
    });
    eventSource.on(event_types.CHARACTER_EDITOR_OPENED, () => autosizeTextareas(document.getElementById('form_create') ?? document));
}
