/**
 * Expanded editors. An expanded editor is an ordinary layer, never a modal: it has no backdrop and blocks nothing, so
 * the chat and the drawers around it stay usable. With stacked drawers on it is ordered like any other layer
 * (drawer-stack.js finds it among #movingDivs' children): clicking something else brings that forward, and clicking
 * the editor brings it back. It spans the three columns, capped to Chat Width Max, like fullscreen character info.
 */

/**
 * @typedef {object} EditorLayer
 * @property {HTMLElement} element The layer.
 * @property {() => void} close Closes it; `onClose` runs once.
 */

/**
 * Opens `content` in a new expanded editor layer.
 * @param {HTMLElement} content What the layer shows. It is moved into the layer, not copied.
 * @param {object} options
 * @param {string} options.closeTitle Tooltip of the button that closes it.
 * @param {() => boolean} [options.escapeCloses] Whether Escape, pressed inside the layer, closes it now. By default
 * it always does.
 * @param {() => void} [options.onClose] Runs when the layer closes, by its button, Escape or `close()`.
 * @returns {EditorLayer}
 */
export function openEditorLayer(content, { closeTitle, escapeCloses = () => true, onClose = () => {} }) {
    const layer = document.createElement('div');
    layer.classList.add('editorLayer');

    const bar = document.createElement('div');
    bar.classList.add('editorLayerBar');
    const closeButton = document.createElement('div');
    closeButton.classList.add('editorLayerClose', 'menu_button', 'fa-solid', 'fa-minimize');
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
    closeButton.addEventListener('click', close);
    closeButton.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            close();
        }
    });
    layer.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || event.defaultPrevented || !escapeCloses()) return;
        event.preventDefault();
        event.stopPropagation();
        close();
    });

    (document.getElementById('movingDivs') ?? document.body).appendChild(layer);
    return { element: layer, close };
}

/**
 * What moving an element out of the page and back loses, kept so it can be put back: focus, every text field's
 * cursor and selection (a field keeps them after losing focus, until it is moved), and every scroll position inside.
 * @param {HTMLElement} root
 * @returns {() => void} Puts it back.
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
