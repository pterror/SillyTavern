const HOLD_DELAY_MS = 200;
const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock']);

/** @type {ReturnType<typeof setTimeout> | null} */
let holdTimer = null;
/** @type {HTMLElement | null} */
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
        if (overlay.matches(':popover-open')) overlay.hidePopover();
        overlay.remove();
        overlay = null;
    }
}

/** @param {number} number */
async function show(number) {
    const { renderHotkeys } = await import('./help-hotkeys.js');
    const { t } = await import('./i18n.js');
    if (number !== holdNumber) return;
    const element = document.createElement('div');
    element.classList.add('hotkeyOverlay');
    element.setAttribute('role', 'note');
    const title = document.createElement('div');
    title.classList.add('hotkeyOverlayTitle');
    title.textContent = t`Hotkeys`;
    element.appendChild(title);
    renderHotkeys(element);
    element.popover = 'manual';
    document.body.appendChild(element);
    overlay = element;
    element.showPopover();
}
