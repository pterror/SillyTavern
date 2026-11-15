import { addLayer } from './drawer-stack.js';
import { attachActions } from './new-ui-page.js';

/**
 * @typedef {object} EditorLayer
 * @property {HTMLElement} element
 * @property {() => void} close
 */

/**
 * @param {HTMLElement} content
 * @param {object} options
 * @param {string} options.closeTitle
 * @param {string} [options.closeIcon]
 * @param {() => boolean} [options.escapeCloses]
 * @param {() => void} [options.onClose]
 * @param {() => void} [options.requestClose] called on the close button and Escape in place of closing: the layer stays
 *   until `close` is called
 * @returns {EditorLayer}
 */
export function openEditorLayer(content, { closeTitle, closeIcon = 'fa-minimize', escapeCloses = () => true, onClose = () => {}, requestClose }) {
    const layer = document.createElement('div');
    layer.classList.add('editorLayer');

    const bar = document.createElement('div');
    bar.classList.add('editorLayerBar');
    const closeButton = document.createElement('div');
    closeButton.classList.add('editorLayerClose', 'menu_button', 'fa-solid', closeIcon);
    closeButton.title = closeTitle;
    closeButton.setAttribute('role', 'button');
    closeButton.tabIndex = 0;
    bar.appendChild(closeButton);

    const body = document.createElement('div');
    body.classList.add('editorLayerBody');
    body.appendChild(content);

    layer.append(bar, body);

    let open = true;
    const close = () => {
        if (!open) return;
        open = false;
        layer.remove();
        onClose();
    };
    const asked = requestClose ?? close;
    closeButton.addEventListener('click', asked);
    attachActions(layer, { cancel: () => (escapeCloses() ? asked() : false) });

    addLayer(layer, document.getElementById('movingDivs') ?? document.body);
    return { element: layer, close };
}

/**
 * @param {HTMLElement} root
 * @returns {() => void}
 */
export function keepViewState(root) {
    const all = [root, ...root.querySelectorAll('*')];
    const scrolled = all
        .filter(el => el.scrollTop || el.scrollLeft)
        .map(el => ({ el, top: el.scrollTop, left: el.scrollLeft }));
    const selections = /** @type {(HTMLTextAreaElement | HTMLInputElement)[]} */ (all.filter(el => el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement))
        .filter(el => el.selectionStart !== null)
        .map(el => ({ el, start: el.selectionStart, end: el.selectionEnd, direction: el.selectionDirection }));
    const focused = document.activeElement instanceof HTMLElement && root.contains(document.activeElement)
        ? document.activeElement
        : null;
    return () => {
        for (const { el, start, end, direction } of selections) {
            el.setSelectionRange(start, end, direction ?? undefined);
        }
        if (focused?.isConnected) focused.focus({ preventScroll: true });
        for (const { el, top, left } of scrolled) {
            el.scrollTop = top;
            el.scrollLeft = left;
        }
    };
}
