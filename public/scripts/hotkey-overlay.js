/**
 * Holding Ctrl on its own shows the list of hotkeys until it's released. It only shows for a bare hold: pressing any
 * other key, clicking or scrolling while Ctrl is down means a shortcut is being used, so it hides (or never shows).
 * It takes no focus and blocks nothing, so the next key of a shortcut still goes where it was going.
 */
const HOLD_DELAY_MS = 200;
const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock']);

/** @type {ReturnType<typeof setTimeout> | null} */
let holdTimer = null;
/** @type {HTMLElement | null} */
let overlay = null;
/** @type {() => boolean} */
let isEnabled = () => true;
// Bumped on every cancel, so a show that was waiting on its content doesn't appear after the hold ended.
let holdNumber = 0;

/**
 * @param {() => boolean} enabled Whether holding Ctrl should show the list right now (the user's setting).
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

/** @param {number} number The hold this show belongs to. */
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
    // A manual popover shows in the top layer, above open popups, without moving focus.
    element.popover = 'manual';
    document.body.appendChild(element);
    overlay = element;
    element.showPopover();
}
