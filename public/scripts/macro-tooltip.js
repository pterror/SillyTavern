import { macroPersonCard } from './macro-pill.js';
import { OVERLAYS_CHANGED_EVENT } from './drawer-stack.js';
import { unclippedSpace } from './util/unclipped-space.js';

export const MACRO_TOOLTIP_ANCHOR = '[data-macro-source]';

const HOVER_DELAY = 300;
const GAP = 4;

/** @type {HTMLElement | null} */
let tooltip = null;
/** @type {Element | null} */
let hovered = null;
/** @type {Element | null} */
let pointed = null;
/** @type {{ owner: object, el: Element } | null} */
let beside = null;
/** @type {Element | null} */
let shownFor = null;
let hoverTimer = 0;
let frame = 0;
let placed = '';

/** @type {{ selector: string, content: (el: Element, refresh: () => void) => Node[] }[]} */
const providers = [];
let anchors = MACRO_TOOLTIP_ANCHOR;

/**
 * @param {string} selector
 * @param {(el: Element, refresh: () => void) => Node[]} content
 */
export function addTooltipProvider(selector, content) {
    providers.push({ selector, content });
    anchors = [MACRO_TOOLTIP_ANCHOR, ...providers.map(p => p.selector)].join(', ');
}

/**
 * @param {Element} el
 * @returns {Node[]}
 */
function tooltipContent(el) {
    const provider = providers.find(p => el.matches(p.selector));
    if (provider) {
        return provider.content(el, () => {
            if (shownFor !== el || !tooltip) return;
            tooltip.replaceChildren(...provider.content(el, () => {}));
            placed = '';
        });
    }
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

function place() {
    frame = 0;
    const el = shownFor;
    if (!el || !tooltip) return;
    const box = visibleBox(el);
    if (!box) {
        if (tooltip.matches(':popover-open')) tooltip.hidePopover();
    } else {
        if (!tooltip.matches(':popover-open')) tooltip.showPopover();
        const { width, height } = tooltip.getBoundingClientRect();
        const left = Math.min(Math.max(GAP, (box.left + box.right) / 2 - width / 2), window.innerWidth - width - GAP);
        const top = box.top - height - GAP >= GAP ? box.top - height - GAP : box.bottom + GAP;
        const at = `${Math.round(left)},${Math.round(top)},${Math.round(width)},${Math.round(height)}`;
        if (at !== placed) {
            placed = at;
            tooltip.style.left = `${left}px`;
            tooltip.style.top = `${top}px`;
            document.dispatchEvent(new Event(OVERLAYS_CHANGED_EVENT));
        }
    }
    frame = requestAnimationFrame(place);
}

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
    if (dom.matches(':popover-open')) dom.hidePopover();
    place();
}

/**
 * @param {object} owner
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

export function initMacroTooltips() {
    document.addEventListener('pointerover', (event) => {
        hover(event.target instanceof Element ? event.target.closest(anchors) : null);
    });
    document.addEventListener('pointerout', (event) => {
        if (!event.relatedTarget) hover(null);
    });
    document.addEventListener('pointerdown', () => hover(null), true);
}
