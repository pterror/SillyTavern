import { setHoles, uncoveredPieces, unionArea } from './util/underlay-clip.js';
import { accountStorage } from './util/AccountStorage.js';

const STACK_DRAWER_SELECTOR = '#top-settings-holder > .drawer > .drawer-content';
const DRAWER_SELECTOR = '.drawer-content';
const FLOATING_SELECTOR = '#movingDivs > *, body > .draggable';
const CHAT_ID = 'sheld';
const OPEN_SELECTOR = ':popover-open, dialog[open]';
const ORDERED_SELECTOR = `#${CHAT_ID}, ${DRAWER_SELECTOR}, ${FLOATING_SELECTOR}`;
const EDITING_SELECTOR = '.field_editing:not(.field_edit_saving), .mes_editor, .reasoning_editor';
const HOLE_SOURCE = 'drawer-stack';
const MAX_ORDER = 1000;
const SAVED_ORDER_KEY = 'DrawerOrder';
let savedOrderRestored = false;

/** @typedef {import('./util/underlay-clip.js').Rect} Rect */

/** @type {Set<HTMLElement>} */
const cut = new Set();
/** @type {WeakSet<HTMLElement>} */
const wasShown = new WeakSet();
/** @type {WeakMap<HTMLElement, number>} */
const hiddenOrder = new WeakMap();
/** @type {() => void} */
let onVisibilityChanged = () => {};
/** @type {(el: HTMLElement) => void} */
let onFront = raiseDrawer;
let frame = 0;
/** @type {{ ordered: HTMLElement[], icons: HTMLElement[] } | null} */
let found = null;

/**
 * Popovers and dialogs the browser said it opened, in the order it opened them (the top layer's order), each with the
 * element it was opened from, if the browser said
 * @type {Map<HTMLElement, Element | null>}
 */
const surfaces = new Map();

function findLayers() {
    if (!found) {
        found = {
            ordered: /** @type {HTMLElement[]} */ ([...document.querySelectorAll(ORDERED_SELECTOR)]),
            icons: /** @type {HTMLElement[]} */ ([...document.querySelectorAll('[data-stack-front-of]')]),
        };
    }
    return found;
}

/**
 * @param {Element} el
 * @returns {boolean}
 */
function isOpen(el) {
    return el.isConnected && el.matches(OPEN_SELECTOR);
}

/** @param {HTMLElement} el */
function forgetSurface(el) {
    surfaces.delete(el);
    sizeWatcher?.unobserve(el);
}

/** @returns {HTMLElement[]} the surfaces open, bottom up */
function openSurfaces() {
    for (const el of [...surfaces.keys()]) {
        // Taken out of the page, a popover closes without saying so
        if (!el.isConnected) forgetSurface(el);
    }
    return [...surfaces.keys()].filter(isOpen);
}

/**
 * The panel a surface belongs to: the one holding what it was opened from (or, if the browser didn't say, where it is
 * in the page), through any surface holding that
 * @param {HTMLElement} surface
 * @param {HTMLElement[]} open
 * @returns {HTMLElement | null} none for a surface outside every shown panel
 */
function panelOf(surface, open) {
    const seen = new Set([surface]);
    let at = surfaces.get(surface) ?? surface.parentElement;
    for (let holder = open.find(other => !seen.has(other) && other.contains(at)); holder; holder = open.find(other => !seen.has(other) && other.contains(at))) {
        seen.add(holder);
        at = surfaces.get(holder) ?? holder.parentElement;
    }
    const panel = /** @type {HTMLElement | null} */ (at?.closest(ORDERED_SELECTOR) ?? null);
    return panel && isShown(panel) ? panel : null;
}

/**
 * @param {Element} el
 * @returns {number}
 */
export function drawerOrder(el) {
    return Number((/** @type {HTMLElement} */ (el)).style.getPropertyValue('--drawerOrder')) || 0;
}

function stackOn() {
    return document.body.classList.contains('stackedDrawers');
}

/** @returns {HTMLElement[]} */
function orderedLayers() {
    return findLayers().ordered;
}

/**
 * @param {HTMLElement} el
 * @returns {boolean}
 */
function isEditing(el) {
    return el.querySelector(EDITING_SELECTOR) !== null;
}

/** @type {WeakSet<HTMLElement>} */
const wasEditing = new WeakSet();

/**
 * @param {HTMLElement} a
 * @param {HTMLElement} b
 */
function compareOrder(a, b) {
    return Number(isEditing(a)) - Number(isEditing(b))
        || drawerOrder(a) - drawerOrder(b)
        || Number(b.id === CHAT_ID) - Number(a.id === CHAT_ID)
        || (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
}

/**
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
    if (savedOrderRestored) saveOrder();
}

function saveOrder() {
    const order = orderedLayers().filter(el => el.id && drawerOrder(el) > 0).sort(compareOrder).map(el => el.id);
    accountStorage.setItem(SAVED_ORDER_KEY, JSON.stringify(order));
}

export function restoreLayerOrder() {
    let saved = [];
    try {
        saved = JSON.parse(accountStorage.getItem(SAVED_ORDER_KEY) ?? '[]');
    } catch {
        saved = [];
    }
    if (!Array.isArray(saved)) saved = [];
    orderedLayers().filter(el => el.id && isShown(el))
        .map((el, i) => ({ el, place: saved.indexOf(el.id), i }))
        .sort((a, b) => a.place - b.place || a.i - b.i)
        .forEach(({ el }) => raiseDrawer(el));
    savedOrderRestored = true;
    saveOrder();
}

/**
 * @param {Element[]} candidates
 * @returns {Element | undefined}
 */
export function frontmostOf(candidates) {
    return candidates.reduce((best, el) => (!best || drawerOrder(el) >= drawerOrder(best) ? el : best), undefined);
}

/**
 * @param {Element} el
 * @returns {boolean}
 */
export function isDrawerCovered(el) {
    return stackOn() && el instanceof HTMLElement && isShown(el) && !isLayerInFront(el);
}

/**
 * @param {HTMLElement} el
 * @returns {boolean}
 */
function isShown(el) {
    if (!el.isConnected || getComputedStyle(el).display === 'none') return false;
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
}

/**
 * Each shown panel with the surfaces that belong to it just above it, then the surfaces outside every panel
 * @param {HTMLElement[]} ordered
 * @param {HTMLElement[]} open
 * @returns {HTMLElement[]}
 */
function shownLayersBottomUp(ordered, open) {
    /** @type {Map<HTMLElement | null, HTMLElement[]>} */
    const byPanel = new Map();
    for (const surface of open) {
        const panel = panelOf(surface, open);
        byPanel.set(panel, [...(byPanel.get(panel) ?? []), surface]);
    }
    return [
        ...ordered.filter(isShown).sort(compareOrder).flatMap(panel => [panel, ...(byPanel.get(panel) ?? [])]),
        ...(byPanel.get(null) ?? []),
    ];
}

/**
 * @param {CSSStyleDeclaration} style
 * @returns {boolean}
 */
function paintsItself(style) {
    const seen = (/** @type {string} */ color) => !/^(transparent|rgba\(.*,\s*0\))$/.test(color);
    return seen(style.backgroundColor) || style.backgroundImage !== 'none' || style.boxShadow !== 'none'
        || (style.backdropFilter || 'none') !== 'none'
        || ['Top', 'Right', 'Bottom', 'Left'].some(side => parseFloat(style[`border${side}Width`]) > 0 && seen(style[`border${side}Color`]));
}

/**
 * What an element paints: its box, if it paints one, with what its positioned children paint, which can lie outside
 * it; else what its children paint, though its box is empty (an empty popover holding positioned children)
 * @param {HTMLElement} el
 * @param {DOMRect} box
 * @param {boolean} whole
 * @param {number} [depth]
 * @param {Set<HTMLElement>} [painters] gets each element whose box is in the answer
 * @returns {Rect[]}
 */
function paintedBoxes(el, box, whole, depth = 4, painters) {
    const style = getComputedStyle(el);
    const empty = box.width === 0 || box.height === 0;
    const own = !empty && (whole || depth === 0 || paintsItself(style));
    if (own) painters?.add(el);
    if (whole || depth === 0) return own ? [roundedBox(el, box, style)] : [];
    const children = [...el.children].flatMap((child) => {
        if (!(child instanceof HTMLElement) || !child.checkVisibility({ visibilityProperty: true })) return [];
        if (own && !['absolute', 'fixed'].includes(getComputedStyle(child).position)) return [];
        return paintedBoxes(child, child.getBoundingClientRect(), false, depth - 1, painters);
    });
    return own ? [roundedBox(el, box, style), ...children] : children;
}

/**
 * The elements a surface paints with, whose size is watched: one can change size, appear or go inside a surface open
 * all along, without the surface's own box changing
 * @type {Set<HTMLElement>}
 */
let watchedParts = new Set();

/** @param {Set<HTMLElement>} parts */
function watchParts(parts) {
    for (const el of watchedParts) if (!parts.has(el)) sizeWatcher?.unobserve(el);
    for (const el of parts) if (!watchedParts.has(el)) sizeWatcher?.observe(el);
    watchedParts = parts;
}

/**
 * @param {HTMLElement} el
 * @param {DOMRect} box
 * @param {CSSStyleDeclaration} [style]
 * @returns {Rect}
 */
function roundedBox(el, box, style = getComputedStyle(el)) {
    const length = (/** @type {string} */ value, /** @type {number} */ side) =>
        Math.min(side / 2, value.endsWith('%') ? parseFloat(value) * side / 100 : parseFloat(value) || 0);
    /** @param {string} value */
    const corner = (value) => {
        const [x, y = x] = value.split(' ');
        return /** @type {[number, number]} */ ([length(x, box.width), length(y, box.height)]);
    };
    const radii = [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius].map(corner);
    return { top: box.top, right: box.right, bottom: box.bottom, left: box.left, radii };
}

/**
 * @param {Rect} box where the holes can be
 * @param {Rect[]} covers
 * @param {Rect} [origin] what the holes are measured from, if not the box's corner
 * @returns {Rect[]}
 */
function holesIn(box, covers, origin = box) {
    /** @type {Rect[]} */
    const out = [];
    for (const c of covers) {
        const top = Math.max(box.top, c.top) - origin.top;
        const bottom = Math.min(box.bottom, c.bottom) - origin.top;
        const left = Math.max(box.left, c.left) - origin.left;
        const right = Math.min(box.right, c.right) - origin.left;
        if (bottom <= top || right <= left) continue;
        if (!c.radii) {
            out.push({ top, right, bottom, left });
            continue;
        }
        const inTop = c.top >= box.top;
        const inBottom = c.bottom <= box.bottom;
        const inLeft = c.left >= box.left;
        const inRight = c.right <= box.right;
        const radii = [inTop && inLeft, inTop && inRight, inBottom && inRight, inBottom && inLeft]
            .map((inside, i) => (inside ? c.radii[i] : /** @type {[number, number]} */ ([0, 0])));
        out.push({ top, right, bottom, left, radii });
    }
    return out;
}

/**
 * @param {HTMLElement} el
 * @returns {boolean}
 */
function clearLayer(el) {
    setHoles(el, HOLE_SOURCE, []);
    const wasCovered = el.classList.contains('stackCovered');
    if (wasCovered) el.classList.remove('stackCovered');
    delete el.dataset.stackCut;
    cut.delete(el);
    return wasCovered;
}

/**
 * @param {HTMLElement} el
 * @param {DOMRect} box
 * @param {DOMRect | null} chatBox
 * @returns {boolean}
 */
function isFullscreenDrawer(el, box, chatBox) {
    return !!chatBox && el.matches(STACK_DRAWER_SELECTOR) && box.left < chatBox.left - 1 && box.right > chatBox.right + 1;
}

/**
 * @param {HTMLElement} el
 * @param {DOMRect} box
 * @param {Rect[]} covers
 * @param {DOMRect[] | null} hideIfSplit
 * @returns {boolean}
 */
function cutLayer(el, box, covers, hideIfSplit) {
    const rects = holesIn(box, covers);
    if (rects.length === 0) return clearLayer(el);
    setHoles(el, HOLE_SOURCE, rects);
    const covered = unionArea(rects) >= box.width * box.height - 0.5
        || (!!hideIfSplit && isSplitByOne(box, rects, holesIn(box, hideIfSplit)));
    const before = el.classList.contains('stackCovered');
    el.classList.toggle('stackCovered', covered);
    el.dataset.stackCut = 'true';
    cut.add(el);
    return before !== covered;
}

/**
 * Cuts a surface where covers are, anywhere in the window: what it paints can lie outside its own box. It is hidden
 * whole when everything it paints is covered.
 * @param {HTMLElement} el
 * @param {DOMRect} box
 * @param {Rect[]} covers
 * @returns {boolean}
 */
function cutSurface(el, box, covers) {
    const window = { top: 0, left: 0, right: innerWidth, bottom: innerHeight };
    const rects = holesIn(window, covers, box);
    if (rects.length === 0) return clearLayer(el);
    setHoles(el, HOLE_SOURCE, rects, { top: -box.top, left: -box.left, right: innerWidth - box.left, bottom: innerHeight - box.top });
    const covered = paintedBoxes(el, box, false).every(part => unionArea(holesIn(part, covers))
        >= (part.right - part.left) * (part.bottom - part.top) - 0.5);
    const before = el.classList.contains('stackCovered');
    el.classList.toggle('stackCovered', covered);
    el.dataset.stackCut = 'true';
    cut.add(el);
    return before !== covered;
}

/**
 * @param {DOMRect} box
 * @param {Rect[]} rects
 * @param {Rect[]} alsoHidden
 * @returns {boolean}
 */
function isSplitByOne(box, rects, alsoHidden) {
    return rects.some(r => uncoveredPieces(box.width, box.height, [r, ...alsoHidden]) > 1);
}

/**
 * @param {HTMLElement[]} ordered
 */
function raiseAppearedLayers(ordered) {
    for (const el of ordered) {
        if (el.id === CHAT_ID) continue;
        const shown = isShown(el);
        const frontedWhileHidden = hiddenOrder.has(el) && hiddenOrder.get(el) !== drawerOrder(el);
        if (shown && !wasShown.has(el) && !frontedWhileHidden) raiseDrawer(el);
        if (shown) {
            wasShown.add(el);
        } else {
            wasShown.delete(el);
            hiddenOrder.set(el, drawerOrder(el));
        }
    }
}

/**
 * @param {HTMLElement[]} ordered
 */
function keepEditedLayersInFront(ordered) {
    for (const el of ordered) {
        const editing = isEditing(el);
        if (!editing && wasEditing.has(el)) raiseDrawer(el);
        if (editing) wasEditing.add(el); else wasEditing.delete(el);
    }
}

function updateDrawerStack() {
    const ordered = orderedLayers();
    raiseAppearedLayers(ordered);
    keepEditedLayersInFront(ordered);
    let changed = false;
    if (!stackOn()) {
        for (const el of [...cut]) changed = clearLayer(el) || changed;
        watchParts(new Set());
    } else {
        const open = openSurfaces();
        const surfaceSet = new Set(open);
        const bottomUp = shownLayersBottomUp(ordered, open);
        const shown = new Set(bottomUp);
        /** @type {Set<HTMLElement>} */
        const parts = new Set();
        for (const el of [...cut]) {
            if (!shown.has(el)) changed = clearLayer(el) || changed;
        }
        const chat = document.getElementById(CHAT_ID);
        const chatBox = chat && shown.has(chat) ? chat.getBoundingClientRect() : null;
        const bar = document.getElementById('top-settings-holder');
        const barBoxes = bar ? [bar.getBoundingClientRect()] : [];
        /** @type {{ el: HTMLElement, covers: Rect[] }[]} */
        const above = [];
        for (let i = bottomUp.length - 1; i >= 0; i--) {
            const el = bottomUp[i];
            const box = el.getBoundingClientRect();
            const covers = above.filter(a => !el.contains(a.el) || surfaceSet.has(a.el)).flatMap(a => a.covers);
            changed = (surfaceSet.has(el)
                ? cutSurface(el, box, covers)
                : cutLayer(el, box, covers, isFullscreenDrawer(el, box, chatBox) ? barBoxes : null)) || changed;
            if (!el.classList.contains('stackCovered')) above.push({ el, covers: paintedBoxes(el, box, !surfaceSet.has(el), 4, surfaceSet.has(el) ? parts : undefined) });
        }
        watchParts(parts);
    }
    updateFrontIcons(ordered);
    if (changed) onVisibilityChanged();
}

/**
 * @param {HTMLElement} el
 * @param {HTMLElement[]} [ordered]
 * @returns {boolean}
 */
function isLayerInFront(el, ordered = orderedLayers()) {
    if (!isShown(el)) return false;
    const box = el.getBoundingClientRect();
    return !ordered.some(other => other !== el && !el.contains(other) && isShown(other)
        && compareOrder(el, other) < 0 && holesIn(box, [other.getBoundingClientRect()]).length > 0);
}

/**
 * @param {HTMLElement[]} ordered
 */
function updateFrontIcons(ordered) {
    for (const icon of findLayers().icons) {
        const layer = document.getElementById(icon.dataset.stackFrontOf ?? '');
        icon.classList.toggle('stackFront', stackOn() && !!layer && isLayerInFront(layer, ordered));
    }
}

export function bringChatForward() {
    const chat = document.getElementById(CHAT_ID);
    if (!chat || !stackOn() || isLayerInFront(chat)) return;
    raiseDrawer(chat);
    updateDrawerStack();
}

/** @returns {HTMLElement[]} */
function allLayers() {
    return [...orderedLayers(), ...openSurfaces()];
}

/**
 * @param {HTMLElement[]} layers
 * @returns {string}
 */
function boxesKey(layers) {
    return layers.filter(el => isShown(el) || surfaces.has(el)).flatMap(el => {
        const box = el.getBoundingClientRect();
        return surfaces.has(el) ? paintedBoxes(el, box, false) : [box];
    }).map(r => `${r.left},${r.top},${r.right},${r.bottom}`).join(';');
}

/**
 * @param {HTMLElement} el
 * @returns {boolean}
 */
function isAnimating(el) {
    return el.getAnimations({ subtree: false })
        .some(a => a.playState === 'running' && Number.isFinite(a.effect?.getComputedTiming().endTime));
}

let lastBoxes = '';

function scheduleUpdate() {
    if (frame) return;
    frame = requestAnimationFrame(function step() {
        updateDrawerStack();
        const layers = allLayers();
        const boxes = boxesKey(layers);
        const moving = boxes !== lastBoxes || layers.some(el => el.isConnected && isAnimating(el));
        lastBoxes = boxes;
        frame = moving ? requestAnimationFrame(step) : 0;
    });
}

/**
 * The panel an input went to: the one it is in, or the one the surface it is in belongs to
 * @param {EventTarget | null} target
 * @returns {HTMLElement | null}
 */
function orderedLayerOf(target) {
    if (!(target instanceof Element)) return null;
    const open = openSurfaces();
    const surface = open.findLast(el => el.contains(target));
    if (surface) return panelOf(surface, open);
    return /** @type {HTMLElement | null} */ (target.closest(ORDERED_SELECTOR));
}

/**
 * Hears a popover or dialog opening or closing. Opening, it goes on top of the surfaces open, as the browser puts it on
 * top of the top layer.
 * @param {Event} event
 */
function onToggle(event) {
    const el = event.target;
    if (!(el instanceof HTMLElement) || !el.matches('[popover], dialog')) return;
    if (event instanceof ToggleEvent && event.type === 'beforetoggle' && event.newState === 'open') {
        surfaces.delete(el);
        surfaces.set(el, event.source instanceof Element ? event.source : null);
        sizeWatcher?.observe(el);
    } else if (event.type === 'close' || (event instanceof ToggleEvent && event.type === 'toggle' && event.newState === 'closed')) {
        forgetSurface(el);
    }
    if (!sizeWatcher) return;
    drawerStackChanged();
}

function onScroll() {
    if (surfaces.size > 0) scheduleUpdate();
}

/**
 * @param {Event} event
 */
function onUserInput(event) {
    if (!event.isTrusted || !stackOn()) return;
    if (event instanceof KeyboardEvent && ['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) return;
    const layer = orderedLayerOf(event.target);
    if (!layer || !isShown(layer)) return;
    if (!orderedLayers().includes(layer)) drawerLayersChanged();
    const shownAbove = orderedLayers().filter(other => other !== layer && isShown(other) && compareOrder(layer, other) < 0);
    if (shownAbove.length === 0) return;
    onFront(layer);
    drawerStackChanged();
}

export function drawerStackChanged() {
    updateDrawerStack();
    scheduleUpdate();
}

/**
 * Puts a panel (a floating panel, a dragged-out avatar) on the page. Panels come only this way, so the stack knows them
 * without watching the page; a removed panel needs no call, as its size watcher reports it. What floats over panels
 * (menus, tooltips, cards, toasts) is a popover or a dialog, which the browser tells the stack of.
 * @param {HTMLElement} layer
 * @param {Element} [parent]
 */
export function addLayer(layer, parent = document.body) {
    parent.append(layer);
    drawerLayersChanged();
}

function drawerLayersChanged() {
    if (!sizeWatcher) return;
    found = null;
    observeLayers();
    drawerStackChanged();
}

let sizeWatcher = /** @type {ResizeObserver | null} */ (null);
function observeLayers() {
    if (!sizeWatcher) return;
    sizeWatcher.disconnect();
    for (const el of [...allLayers(), ...watchedParts]) sizeWatcher.observe(el);
}

/**
 * @param {() => void} visibilityChanged
 * @param {(el: HTMLElement) => void} [front]
 */
export function initDrawerStack(visibilityChanged, front) {
    onVisibilityChanged = visibilityChanged;
    onFront = el => (front && el.matches(STACK_DRAWER_SELECTOR) ? front(el) : raiseDrawer(el));
    sizeWatcher = new ResizeObserver(() => { if (!frame) drawerStackChanged(); });
    for (const el of /** @type {HTMLElement[]} */ ([...document.querySelectorAll(OPEN_SELECTOR)])) surfaces.set(el, null);
    observeLayers();
    document.addEventListener('beforetoggle', onToggle, true);
    document.addEventListener('toggle', onToggle, true);
    document.addEventListener('close', onToggle, true);
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    document.addEventListener('pointerdown', onUserInput, true);
    document.addEventListener('keydown', onUserInput, true);
    window.addEventListener('resize', drawerStackChanged);
    for (const el of orderedLayers()) {
        if (isShown(el)) wasShown.add(el); else hiddenOrder.set(el, drawerOrder(el));
    }
    updateDrawerStack();
}
