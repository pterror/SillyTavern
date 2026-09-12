import { t } from './i18n.js';
import { stopGeneration } from '../script.js';
import { Popup, POPUP_RESULT, POPUP_TYPE } from './popup.js';

/**
 * Enum representing the toast display mode for the action loader.
 * @readonly
 * @enum {string}
 */
export const ActionLoaderToastMode = {
    /** No toast is displayed */
    NONE: 'none',
    /** Toast is displayed without stop button (non-interactable) */
    STATIC: 'static',
    /** Toast is displayed with stop button (default) */
    STOPPABLE: 'stoppable',
};

/**
 * @typedef {object} ActionLoaderOptions
 * @property {boolean} [blocking=true] - Whether to show the blocking overlay. Set to false for non-blocking toast-only loaders.
 * @property {ActionLoaderToastMode} [toastMode='stoppable'] - Toast display mode
 * @property {string} [slug=null] - Unique slug for the loader to identify it easily via code or CSS
 * @property {string} [message='Generating...'] - The message to display in the toast
 * @property {string} [title] - Optional title for the toast notification
 * @property {string} [stopTooltip='Stop'] - Tooltip text for the stop button
 * @property {HTMLElement|string|null} [overlayContent=null] - Custom content for the overlay (replaces default spinner)
 * @property {(() => void)|null} [onStop=null] - Custom stop handler. If null, calls `stopGeneration()`
 * @property {(() => void)|null} [onHide=null] - Custom hide handler. Called when the loader is hidden (not stopped).
 */

let loaderIdCounter = 0;

/** @type {Set<ActionLoaderHandle>} Set of all active loader handles */
const activeHandles = new Set();

function generateLoaderId() {
    return `loader_${++loaderIdCounter}`;
}

function hasBlockingLoaders() {
    for (const handle of activeHandles) {
        if (handle.isBlocking && handle.isActive) {
            return true;
        }
    }
    return false;
}

export class ActionLoaderHandle {
    /** A disposed no-op handle, useful as a default value to avoid null checks. */
    static get EMPTY() {
        return new ActionLoaderHandle({ predisposed: true });
    }

    /** @type {string} Unique identifier for this handle */
    #id;

    /** @type {string|null} Unique slug for the loader */
    #slug = null;

    /** @type {JQuery<HTMLElement>|null} The toast element for this loader */
    #toast = null;

    /** @type {(() => void)|null} Custom stop handler */
    #onStop = null;

    /** @type {(() => void)|null} Custom hide handler */
    #onHide = null;

    /** @type {boolean} Whether this loader blocks the UI with an overlay */
    #blocking = true;

    /** @type {boolean} Whether this handle has been disposed */
    #disposed = false;

    /** @param {ActionLoaderOptions & {predisposed?: boolean}} options */
    constructor({
        blocking = true,
        toastMode = ActionLoaderToastMode.STOPPABLE,
        slug = null,
        message = t`Generating...`,
        title = '',
        stopTooltip = t`Stop`,
        overlayContent = null,
        onStop = null,
        onHide = null,
        predisposed = false,
    } = {}) {
        if (predisposed) {
            this.#disposed = true;
            return;
        }

        this.#id = generateLoaderId();
        this.#slug = slug;
        this.#blocking = blocking;
        this.#onStop = onStop;
        this.#onHide = onHide;

        if (!blocking && toastMode === ActionLoaderToastMode.NONE && !overlayContent) {
            console.warn('[ActionLoader] Non-blocking loader created without a toast. This loader will not be visible to the user.');
        }

        if (blocking && !hasBlockingLoaders() && !isOverlayDisplayed()) {
            showOverlay(overlayContent);
        }

        activeHandles.add(this);

        if (toastMode !== ActionLoaderToastMode.NONE) {
            this.#createToast(message, title, toastMode, stopTooltip);
        }
    }

    #createToast(message, title, toastMode, stopTooltip) {
        const toastContent = document.createElement('div');
        toastContent.className = 'action-loader-toast';

        if (this.#slug) {
            toastContent.dataset.slug = this.#slug;
        }
        toastContent.dataset.loaderId = this.#id;
        toastContent.dataset.blocking = this.#blocking.toString();

        const messageSpan = document.createElement('span');
        messageSpan.className = 'action-loader-message';
        messageSpan.textContent = message;
        toastContent.appendChild(messageSpan);

        if (toastMode === ActionLoaderToastMode.STOPPABLE) {
            const stopButton = document.createElement('i');
            stopButton.className = 'fa-solid fa-stop-circle action-loader-stop interactable';
            stopButton.title = stopTooltip;
            stopButton.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.stop();
            });
            toastContent.appendChild(stopButton);
        }

        // Show toast with no timeout (sticky)
        this.#toast = toastr.info($(toastContent), title, {
            timeOut: 0,
            extendedTimeOut: 0,
            tapToDismiss: false,
            escapeHtml: false,
        });
    }

    #clearToast() {
        if (this.#toast) {
            toastr.clear(this.#toast, { force: true }); // Need to force as the toast might have focus/hover
            this.#toast = null;
        }
    }

    async #dispose() {
        if (this.#disposed) return;
        this.#disposed = true;

        this.#clearToast();
        activeHandles.delete(this);

        if (this.#blocking && !hasBlockingLoaders()) {
            await hideOverlay();
        }
    }

    get id() {
        return this.#id;
    }

    get slug() {
        return this.#slug;
    }

    get isActive() {
        return !this.#disposed;
    }

    get isBlocking() {
        return this.#blocking;
    }

    // Calls the custom onStop handler if provided, otherwise stopGeneration().
    async stop() {
        if (this.#disposed) return;

        if (this.#onStop) {
            try {
                await this.#onStop();
            } catch (e) {
                console.error('Error executing onStop handler', e);
            }
        } else {
            stopGeneration();
        }

        await this.#dispose();
    }

    async hide() {
        if (this.#disposed) return;

        if (this.#onHide) {
            try {
                await this.#onHide();
            } catch (e) {
                console.error('Error executing onHide handler', e);
            }
        }

        await this.#dispose();
    }
}

export const loader = {
    /** @type {typeof showActionLoader} */
    show: showActionLoader,

    /** @type {typeof hideActionLoader} */
    hide: hideActionLoader,

    /** @type {typeof getActiveLoaderHandles} */
    active: getActiveLoaderHandles,

    /** @type {typeof getLoaderHandleById} */
    get: getLoaderHandleById,

    /** @type {typeof isOverlayDisplayed} */
    isBlocking: isOverlayDisplayed,

    /** @type {typeof ActionLoaderToastMode} */
    ToastMode: ActionLoaderToastMode,

    /** @type {typeof ActionLoaderHandle} */
    Handle: ActionLoaderHandle,

    /** @type {typeof createDefaultLoaderOverlay} */
    createOverlay: createDefaultLoaderOverlay,
};

// Multiple loaders can be stacked - the overlay stays single, but each gets its own toast.
export function showActionLoader(options = {}) {
    return new ActionLoaderHandle(options);
}

export async function hideActionLoader(handle = null) {
    if (handle instanceof ActionLoaderHandle) {
        if (handle.isActive) {
            await handle.hide();
            return true;
        }
        return false;
    }

    const handles = getActiveLoaderHandles();
    for (const h of handles) {
        await h.hide();
    }
    return handles.length > 0;
}

export function getActiveLoaderHandles() {
    return Array.from(activeHandles);
}

export function getLoaderHandleById(id) {
    for (const handle of activeHandles) {
        if (handle.id === id) {
            return handle;
        }
    }
    return undefined;
}

// ============================================================================
// Internal overlay management
// ============================================================================

/** @type {Popup|null} The current loader overlay popup */
let loaderPopup = null;

/** Whether the initial HTML preloader has been removed */
let preloaderYoinked = false;

export function createDefaultLoaderOverlay() {
    const loaderElement = document.createElement('div');
    loaderElement.id = 'loader';

    const spinnerElement = document.createElement('div');
    spinnerElement.id = 'load-spinner';
    spinnerElement.className = 'fa-solid fa-gear fa-spin fa-3x';

    loaderElement.appendChild(spinnerElement);

    return loaderElement;
}

function getOverlayContent(customContent) {
    if (typeof customContent === 'string') {
        return customContent;
    }

    if (customContent instanceof HTMLElement) {
        return customContent;
    }

    return createDefaultLoaderOverlay();
}

function isOverlayDisplayed() {
    return !!loaderPopup;
}

// Internal — use showActionLoader() instead.
function showOverlay(customContent = null) {
    // Don't await the old popup closing; overlay it while it closes.
    if (loaderPopup) loaderPopup.complete(POPUP_RESULT.CANCELLED);

    const content = getOverlayContent(customContent);

    loaderPopup = new Popup(content, POPUP_TYPE.DISPLAY, null, {
        allowEscapeClose: false,
        transparent: true,
        animation: 'none',
        wide: true,
        large: true,
    });

    // No close button, loaders are not closable
    loaderPopup.closeButton.style.display = 'none';

    loaderPopup.show();
}

// Internal — use hideActionLoader() instead.
async function hideOverlay() {
    if (!loaderPopup) {
        return Promise.resolve();
    }

    return new Promise((resolve) => {
        const loaderElement = $('#loader');
        const spinner = $('#load-spinner');

        if (!loaderElement.length) {
            console.warn('Loader element not found, skipping animation');
            cleanup();
            return;
        }

        // Check if transitions are enabled on spinner (which has the transition property)
        const transitionDuration = spinner.length && spinner[0] ? getComputedStyle(spinner[0]).transitionDuration : '0s';
        const hasTransitions = parseFloat(transitionDuration) > 0;

        if (hasTransitions) {
            Promise.race([
                new Promise((r) => setTimeout(r, 500)), // Fallback timeout
                new Promise((r) => loaderElement.one('transitionend webkitTransitionEnd oTransitionEnd MSTransitionEnd', r)),
            ]).finally(cleanup);
        } else {
            cleanup();
        }

        function cleanup() {
            loaderElement.remove();
            yoinkPreloader();

            loaderPopup.complete(POPUP_RESULT.AFFIRMATIVE)
                .catch((err) => console.error('Error completing loaderPopup:', err))
                .finally(() => {
                    loaderPopup = null;
                    resolve();
                });
        }

        loaderElement.css({
            'filter': 'blur(15px)',
            'opacity': '0',
        });
    });
}

function yoinkPreloader() {
    if (preloaderYoinked) return;
    document.getElementById('preloader')?.remove();
    preloaderYoinked = true;
}

// ============================================================================
// End internal overlay management
// ============================================================================
