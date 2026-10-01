/**
 * Stacked drawers: the layers on screen are ordered by when each was last brought forward, and with stacked drawers
 * on each one shows exactly what nothing above it covers: walking from the topmost layer down, every layer is cut by
 * the union of the boxes above it. A see-through theme then never shows two layers in one place. Paint order doesn't
 * have to agree: whichever paints on top, the lower layer is cut where the upper one is, and a cut part takes no
 * clicks either, so a click lands on what is visible there.
 *
 * Layers are found by what they are, never by a list of ids, so extensions' own drawers and windows take part:
 * - ordered layers: the chat (#sheld), every top-bar drawer, every floating window (#movingDivs' children,
 *   draggables on <body> such as zoomed avatars). Clicking, tapping or typing in one brings it forward; a floating
 *   window also comes forward when it appears.
 * - floating lists (autocomplete menus, select2 dropdowns): above every ordered layer while shown.
 */
import { setHoles, unionArea } from './util/underlay-clip.js';

/** The top-bar drawers. They share #top-settings-holder's stacking context, so z-index alone orders their painting. */
export const STACK_DRAWER_SELECTOR = '#top-settings-holder > .drawer > .drawer-content';
/** Floating windows: ordered, and brought forward when they appear. */
const FLOATING_SELECTOR = '#movingDivs > *, body > .draggable';
/** The chat. Ordered like any layer; it starts at the bottom. */
const CHAT_ID = 'sheld';
/** Floating lists: above every ordered layer while shown. */
const LIST_SELECTOR = '.ui-menu, .select2-container--open > .select2-dropdown';
const ORDERED_SELECTOR = `#${CHAT_ID}, ${STACK_DRAWER_SELECTOR}, ${FLOATING_SELECTOR}`;
const HOLE_SOURCE = 'drawer-stack';
/** Past this, the ordered layers are renumbered from 1, keeping the numbers small. */
const MAX_ORDER = 1000;

/** @typedef {import('./util/underlay-clip.js').Rect} Rect */

/** @type {Set<HTMLElement>} Layers that currently have this module's holes or the covered class. */
const cut = new Set();
/** @type {WeakSet<HTMLElement>} Floating windows shown at the last update, to tell when one appears. */
const wasShown = new WeakSet();
/** @type {() => void} */
let onVisibilityChanged = () => {};
/** @type {(el: HTMLElement) => void} */
let onFront = raiseDrawer;
let frame = 0;

/**
 * @param {Element} el
 * @returns {number} When it was last brought forward, higher being more recent; 0 if never.
 */
export function drawerOrder(el) {
    return Number((/** @type {HTMLElement} */ (el)).style.getPropertyValue('--drawerOrder')) || 0;
}

function stackOn() {
    return document.body.classList.contains('stackedDrawers');
}

/** @returns {HTMLElement[]} Every layer that takes part in ordering, shown or not. */
function orderedLayers() {
    return /** @type {HTMLElement[]} */ ([...document.querySelectorAll(ORDERED_SELECTOR)]);
}

/** @returns {HTMLElement[]} The floating lists in the page, shown or not. */
function listLayers() {
    return /** @type {HTMLElement[]} */ ([...document.querySelectorAll(LIST_SELECTOR)]);
}

/**
 * Bottom-to-top order of two ordered layers: by when brought forward; never brought forward, the chat is lowest;
 * then html order, as painting does.
 * @param {HTMLElement} a
 * @param {HTMLElement} b
 */
function compareOrder(a, b) {
    return drawerOrder(a) - drawerOrder(b)
        || Number(b.id === CHAT_ID) - Number(a.id === CHAT_ID)
        || (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
}

/**
 * Brings a layer above every other one.
 * @param {HTMLElement} el
 */
export function raiseDrawer(el) {
    const others = orderedLayers().filter(other => other !== el);
    let next = Math.max(0, ...others.map(drawerOrder)) + 1;
    if (next > MAX_ORDER) {
        others.filter(other => drawerOrder(other) > 0)
            .sort(compareOrder)
            .forEach((other, i) => other.style.setProperty('--drawerOrder', String(i + 1)));
        next = others.filter(other => drawerOrder(other) > 0).length + 1;
    }
    el.style.setProperty('--drawerOrder', String(next));
}

/**
 * @param {Element[]} candidates
 * @returns {Element | undefined} The one brought forward last (html order breaks ties, as painting does).
 */
export function frontmostOf(candidates) {
    return candidates.reduce((best, el) => (!best || drawerOrder(el) >= drawerOrder(best) ? el : best), undefined);
}

/**
 * @param {Element} el A top-bar drawer
 * @returns {boolean} Whether any layer above it covers part of it.
 */
export function isDrawerCovered(el) {
    return el instanceof HTMLElement && el.dataset.stackCut === 'true';
}

/** @param {HTMLElement} el @returns {boolean} Whether it takes up space on screen now (mid-animation included). */
function isShown(el) {
    if (!el.isConnected || getComputedStyle(el).display === 'none') return false;
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
}

/** @returns {HTMLElement[]} The shown layers, bottom first. */
function shownLayersBottomUp() {
    return [
        ...orderedLayers().filter(isShown).sort(compareOrder),
        ...listLayers().filter(isShown),
    ];
}

/**
 * @param {DOMRect} box The layer's box
 * @param {DOMRect[]} covers Boxes above it, viewport coordinates
 * @returns {Rect[]} The parts of `covers` inside the layer, in its own coordinates
 */
function holesIn(box, covers) {
    /** @type {Rect[]} */
    const out = [];
    for (const c of covers) {
        const top = Math.max(box.top, c.top) - box.top;
        const bottom = Math.min(box.bottom, c.bottom) - box.top;
        const left = Math.max(box.left, c.left) - box.left;
        const right = Math.min(box.right, c.right) - box.left;
        if (bottom > top && right > left) out.push({ top, right, bottom, left });
    }
    return out;
}

/** @param {HTMLElement} el @returns {boolean} Whether it was entirely covered */
function clearLayer(el) {
    setHoles(el, HOLE_SOURCE, []);
    const wasCovered = el.classList.contains('stackCovered');
    el.classList.remove('stackCovered');
    delete el.dataset.stackCut;
    cut.delete(el);
    return wasCovered;
}

/**
 * Cuts the union of `covers` out of `el`.
 * @param {HTMLElement} el
 * @param {DOMRect} box Its box
 * @param {DOMRect[]} covers
 * @returns {boolean} Whether its entirely-covered state changed
 */
function cutLayer(el, box, covers) {
    const rects = holesIn(box, covers);
    if (rects.length === 0) return clearLayer(el);
    setHoles(el, HOLE_SOURCE, rects);
    const covered = unionArea(rects) >= box.width * box.height - 0.5;
    const before = el.classList.contains('stackCovered');
    el.classList.toggle('stackCovered', covered);
    el.dataset.stackCut = 'true';
    cut.add(el);
    return before !== covered;
}

/** Floating windows that were hidden at the last update and are shown now come forward. */
function raiseAppearedWindows() {
    for (const el of /** @type {HTMLElement[]} */ ([...document.querySelectorAll(FLOATING_SELECTOR)])) {
        const shown = isShown(el);
        if (shown && !wasShown.has(el)) raiseDrawer(el);
        if (shown) wasShown.add(el); else wasShown.delete(el);
    }
}

/**
 * Recomputes every cut from where the layers are now. Synchronous, so code reading a drawer's visibility right after
 * opening, closing or fronting one sees the new state.
 */
export function updateDrawerStack() {
    raiseAppearedWindows();
    let changed = false;
    if (!stackOn()) {
        for (const el of [...cut]) changed = clearLayer(el) || changed;
    } else {
        const bottomUp = shownLayersBottomUp();
        const shown = new Set(bottomUp);
        for (const el of [...cut]) {
            if (!shown.has(el)) changed = clearLayer(el) || changed;
        }
        /** @type {{ el: HTMLElement, box: DOMRect }[]} */
        const above = [];
        for (let i = bottomUp.length - 1; i >= 0; i--) {
            const el = bottomUp[i];
            const box = el.getBoundingClientRect();
            // A layer inside another is cut along with it, so it never cuts its own ancestor.
            const covers = above.filter(a => !el.contains(a.el)).map(a => a.box);
            changed = cutLayer(el, box, covers) || changed;
            above.push({ el, box });
        }
    }
    if (changed) onVisibilityChanged();
}

/** @returns {HTMLElement[]} Every element that can be a layer. */
function allLayers() {
    return [...orderedLayers(), ...listLayers()];
}

/** @returns {string} Where the shown layers are, to tell when one moved. */
function boxesKey() {
    return allLayers().filter(isShown).map(el => {
        const r = el.getBoundingClientRect();
        return `${r.left},${r.top},${r.width},${r.height}`;
    }).join(';');
}

/** @param {HTMLElement} el @returns {boolean} Whether a finite animation or transition of its own is running. */
function isAnimating(el) {
    return el.getAnimations({ subtree: false })
        .some(a => a.playState === 'running' && Number.isFinite(a.effect?.getComputedTiming().endTime));
}

let lastBoxes = '';

/** Recomputes on the next frame, and on every frame after while a layer animates or moves. */
function scheduleUpdate() {
    if (frame) return;
    frame = requestAnimationFrame(function step() {
        updateDrawerStack();
        const boxes = boxesKey();
        const moving = boxes !== lastBoxes || allLayers().some(isAnimating);
        lastBoxes = boxes;
        frame = moving ? requestAnimationFrame(step) : 0;
    });
}

/**
 * @param {EventTarget | null} target
 * @returns {HTMLElement | null} The innermost ordered layer holding `target`, or null when it is in none or in a
 * floating list (a list sits above everything already, and the layer under it isn't what was clicked).
 */
function orderedLayerOf(target) {
    if (!(target instanceof Element) || target.closest(LIST_SELECTOR)) return null;
    return /** @type {HTMLElement | null} */ (target.closest(ORDERED_SELECTOR));
}

/**
 * Clicking, tapping or typing in a layer brings it forward. The event itself goes on untouched: a button in a back
 * layer still gets its click.
 * @param {Event} event
 */
function onUserInput(event) {
    if (!event.isTrusted || !stackOn()) return;
    if (event instanceof KeyboardEvent && ['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) return;
    const layer = orderedLayerOf(event.target);
    if (!layer || !isShown(layer)) return;
    const shownAbove = orderedLayers().filter(other => other !== layer && isShown(other) && compareOrder(layer, other) < 0);
    if (shownAbove.length === 0) return;
    onFront(layer);
    updateDrawerStack();
}

/**
 * Starts following the layers.
 * @param {() => void} visibilityChanged Called when a layer becomes or stops being entirely covered.
 * @param {(el: HTMLElement) => void} [front] Brings a top-bar drawer forward the way the app does; other layers are
 * raised here.
 */
export function initDrawerStack(visibilityChanged, front) {
    onVisibilityChanged = visibilityChanged;
    onFront = el => (front && el.matches(STACK_DRAWER_SELECTOR) ? front(el) : raiseDrawer(el));
    const resize = new ResizeObserver(scheduleUpdate);
    // A layer's own class (open, closed, fullscreen), shown menu and inline style (shown, dragged) decide where it is.
    const changed = new MutationObserver(scheduleUpdate);
    const observeLayers = () => {
        resize.disconnect();
        changed.disconnect();
        for (const el of allLayers()) {
            resize.observe(el);
            changed.observe(el, { attributes: true, attributeFilter: ['class', 'style', 'data-active-menu'] });
        }
    };
    const relayer = () => {
        observeLayers();
        scheduleUpdate();
    };
    observeLayers();
    // Layers come and go: a drawer an extension adds, a floating window, a list made or moved under <body>.
    const holder = document.getElementById('top-settings-holder');
    if (holder) new MutationObserver(relayer).observe(holder, { childList: true });
    const movingDivs = document.getElementById('movingDivs');
    if (movingDivs) new MutationObserver(relayer).observe(movingDivs, { childList: true });
    new MutationObserver(relayer).observe(document.body, { childList: true });
    // A list opens and closes inside its own container, wherever that is; these events bubble from its input.
    $(document).on('autocompleteopen autocompleteclose select2:open select2:close', relayer);
    // Animations of a layer itself start without a resize or a class change (a fade, a transform).
    const onLayerAnimation = (/** @type {Event} */ event) => {
        if (event.target instanceof HTMLElement && allLayers().includes(event.target)) scheduleUpdate();
    };
    document.addEventListener('transitionrun', onLayerAnimation, true);
    document.addEventListener('animationstart', onLayerAnimation, true);
    document.addEventListener('pointerdown', onUserInput, true);
    document.addEventListener('keydown', onUserInput, true);
    new MutationObserver(scheduleUpdate).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    window.addEventListener('resize', scheduleUpdate);
    for (const el of /** @type {HTMLElement[]} */ ([...document.querySelectorAll(FLOATING_SELECTOR)])) {
        if (isShown(el)) wasShown.add(el);
    }
    updateDrawerStack();
}
