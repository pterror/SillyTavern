// A macro's tooltip, the one for every place a macro is shown (the live editor, a field's preview, creator notes): its
// source, and a note when the pill doesn't say it all; for a mention, a card of who it names. Drawn from the
// attributes the element showing the macro carries (macro-pill.js macroTooltipAttributes()), in the top layer, so no
// drawer's cut or scroller clips it and it cuts what is under it like any other popover (drawer-stack.js).

import { macroPersonCard } from './macro-pill.js';
import { OVERLAYS_CHANGED_EVENT } from './drawer-stack.js';
import { unclippedSpace } from './util/unclipped-space.js';

/** What shows a macro's tooltip on hover. */
export const MACRO_TOOLTIP_ANCHOR = '[data-macro-source]';

/** How long the pointer rests on a macro before its tooltip shows. */
const HOVER_DELAY = 300;
/** The gap between a tooltip and its macro, and the least between it and the window's edge. */
const GAP = 4;

/** @type {HTMLElement | null} */
let tooltip = null;
/** The macro under the pointer, once it rested there. @type {Element | null} */
let hovered = null;
/** The macro under the pointer. @type {Element | null} */
let pointed = null;
/** The macro beside an editor's cursor, and the editor's own key for it. @type {{ owner: object, el: Element } | null} */
let beside = null;
/** The macro the tooltip is for: the one hovered, else the one beside the cursor. @type {Element | null} */
let shownFor = null;
let hoverTimer = 0;
let frame = 0;
let placed = '';

/**
 * @param {Element} el An element carrying a macro's tooltip attributes.
 * @returns {Node[]}
 */
function tooltipContent(el) {
    const source = el.getAttribute('data-macro-source') ?? '';
    const person = el.getAttribute('data-macro-person');
    if (person) return [macroPersonCard(JSON.parse(person), source)];
    const code = document.createElement('code');
    code.textContent = source;
    const note = el.getAttribute('data-macro-note');
    if (!note) return [code];
    const text = document.createElement('div');
    text.textContent = note;
    return [code, text];
}

function tooltipElement() {
    if (!tooltip) {
        tooltip = document.createElement('div');
        tooltip.className = 'macro-tooltip';
        tooltip.popover = 'manual';
        tooltip.setAttribute('role', 'tooltip');
        document.body.append(tooltip);
    }
    return tooltip;
}

/**
 * Where a macro is on screen, if any of it is: its first line (a pill in a preview wraps), within what clips it.
 * @param {Element} el
 */
function visibleBox(el) {
    if (!el.isConnected) return null;
    const box = el.getClientRects()[0];
    if (!box || (box.width === 0 && box.height === 0)) return null;
    const space = unclippedSpace(el);
    const seen = box.right > space.left && box.left < space.right && box.bottom > space.top && box.top < space.bottom;
    return seen ? box : null;
}

/** Centered above its macro, below it when there's no room above, inside the window. */
function place() {
    frame = 0;
    const el = shownFor;
    if (!el || !tooltip) return;
    const box = visibleBox(el);
    if (!box) {
        if (tooltip.matches(':popover-open')) tooltip.hidePopover();
    } else {
        // Shown again each time it was hidden, so it is above whatever opened in the top layer since.
        if (!tooltip.matches(':popover-open')) tooltip.showPopover();
        const { width, height } = tooltip.getBoundingClientRect();
        const left = Math.min(Math.max(GAP, (box.left + box.right) / 2 - width / 2), window.innerWidth - width - GAP);
        const top = box.top - height - GAP >= GAP ? box.top - height - GAP : box.bottom + GAP;
        const at = `${Math.round(left)},${Math.round(top)},${Math.round(width)},${Math.round(height)}`;
        if (at !== placed) {
            placed = at;
            tooltip.style.left = `${left}px`;
            tooltip.style.top = `${top}px`;
            // The drawer stack cuts what is under the tooltip where it is now.
            document.dispatchEvent(new Event(OVERLAYS_CHANGED_EVENT));
        }
    }
    // Kept on its macro while it shows: the text scrolls, a drawer slides, the editor redraws.
    frame = requestAnimationFrame(place);
}

/** Shows the tooltip for the macro hovered, else the one beside a cursor; hides it when there is none. */
function update() {
    const el = hovered ?? beside?.el ?? null;
    if (el === shownFor) return;
    shownFor = el;
    cancelAnimationFrame(frame);
    frame = 0;
    placed = '';
    const dom = tooltipElement();
    if (!el) {
        if (dom.matches(':popover-open')) dom.hidePopover();
        return;
    }
    for (const attribute of ['data-macro-name', 'data-macro-category']) {
        const value = el.getAttribute(attribute);
        if (value === null) dom.removeAttribute(attribute); else dom.setAttribute(attribute, value);
    }
    dom.replaceChildren(...tooltipContent(el));
    // Hidden first, so showing it again puts it on top of the top layer.
    if (dom.matches(':popover-open')) dom.hidePopover();
    place();
}

/**
 * An editor's cursor is beside a macro (its pill, or its source opened for editing), or no longer (null).
 * @param {object} owner The editor's own key: only it clears what it set.
 * @param {Element | null} el
 */
export function setMacroBesideCursor(owner, el) {
    if (el) beside = { owner, el };
    else if (beside?.owner === owner) beside = null;
    else return;
    update();
}

/** @param {Element | null} el */
function hover(el) {
    if (el === pointed) return;
    pointed = el;
    clearTimeout(hoverTimer);
    if (!el) {
        hovered = null;
        update();
        return;
    }
    hoverTimer = window.setTimeout(() => {
        hovered = el;
        update();
    }, HOVER_DELAY);
}

/** Shows a macro's tooltip while the pointer rests on it, wherever the macro is. */
export function initMacroTooltips() {
    document.addEventListener('pointerover', (event) => {
        hover(event.target instanceof Element ? event.target.closest(MACRO_TOOLTIP_ANCHOR) : null);
    });
    document.addEventListener('pointerout', (event) => {
        if (!event.relatedTarget) hover(null);
    });
    document.addEventListener('pointerdown', () => hover(null), true);
}
