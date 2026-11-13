import { t } from './i18n.js';
import { newUi, newUiStarted } from './new-ui-page.js';

const HOLD_DELAY_MS = 200;
const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock']);

/** @type {ReturnType<typeof setTimeout> | null} */
let holdTimer = null;
/** @type {{ element: HTMLElement, remove: () => void } | null} */
let overlay = null;
/** @type {() => boolean} */
let isEnabled = () => true;
let holdNumber = 0;

/**
 * @param {() => boolean} enabled
 */
export function initHotkeyOverlay(enabled) {
    isEnabled = enabled;
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('pointerdown', cancel, true);
    window.addEventListener('wheel', cancel, { capture: true, passive: true });
    window.addEventListener('blur', cancel);
}

/** @param {KeyboardEvent} event */
function onKeyDown(event) {
    if (event.isComposing) return;
    if (event.key === 'Control') {
        if (!event.repeat && isEnabled()) startHold();
        return;
    }
    if (MODIFIER_KEYS.has(event.key)) return;
    cancel();
}

/** @param {KeyboardEvent} event */
function onKeyUp(event) {
    if (event.key === 'Control') cancel();
}

function startHold() {
    cancel();
    const number = holdNumber;
    holdTimer = setTimeout(() => {
        holdTimer = null;
        show(number);
    }, HOLD_DELAY_MS);
}

function cancel() {
    holdNumber++;
    if (holdTimer !== null) {
        clearTimeout(holdTimer);
        holdTimer = null;
    }
    if (overlay) {
        if (overlay.element.matches(':popover-open')) overlay.element.hidePopover();
        overlay.element.remove();
        overlay.remove();
        overlay = null;
    }
}

/** @param {number} number */
async function show(number) {
    if (!newUiStarted()) return;
    const element = document.createElement('div');
    element.classList.add('hotkeyOverlay');
    element.setAttribute('role', 'note');
    const title = document.createElement('div');
    title.classList.add('hotkeyOverlayTitle');
    title.textContent = t`Hotkeys`;
    element.appendChild(title);
    const remove = await newUi().help.hotkeys(element);
    if (number !== holdNumber) {
        remove();
        return;
    }
    element.popover = 'manual';
    document.body.appendChild(element);
    overlay = { element, remove };
    element.showPopover();
}
