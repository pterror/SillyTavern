import { setHoles, uncoveredPieces, unionArea } from './util/underlay-clip.js';
import { accountStorage } from './util/AccountStorage.js';

export const STACK_DRAWER_SELECTOR = '#top-settings-holder > .drawer > .drawer-content';
const DRAWER_SELECTOR = '.drawer-content';
const FLOATING_SELECTOR = '#movingDivs > *, body > .draggable';
const CHAT_ID = 'sheld';
const OVERLAY_SELECTOR = 'dialog, [popover], .ui-menu, .select2-container--open > .select2-dropdown, .cm-tooltip, .cm-completionInfo';
const TOP_LAYER_SELECTOR = 'dialog, [popover]';
export const OVERLAYS_CHANGED_EVENT = 'overlayschanged';
const ORDERED_SELECTOR = `#${CHAT_ID}, ${DRAWER_SELECTOR}, ${FLOATING_SELECTOR}`;
const EDITING_SELECTOR = '.field_editing:not(.field_edit_saving), #curEditTextarea, .reasoning_edit_textarea';
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
/** @type {{ ordered: HTMLElement[], overlays: HTMLElement[], icons: HTMLElement[] } | null} */
let found = null;

function findLayers() {
    if (!found) {
        const ordered = /** @type {HTMLElement[]} */ ([...document.querySelectorAll(ORDERED_SELECTOR)]);
        const overlays = new Set(/** @type {HTMLElement[]} */ ([...document.querySelectorAll(OVERLAY_SELECTOR)]));
        for (const el of bodyOverlays(ordered)) overlays.add(el);
        found = {
            ordered,
            overlays: [...overlays].sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)),
            icons: /** @type {HTMLElement[]} */ ([...document.querySelectorAll('[data-stack-front-of]')]),
        };
    }
    return found;
}

/**
 * @param {HTMLElement[]} ordered
 * @returns {HTMLElement[]}
 */
function bodyOverlays(ordered) {
    /** @param {Element} el */
    const zIndex = (el) => Number.parseInt(getComputedStyle(el).zIndex) || 0;
    const holders = new Set(ordered.map(el => {
        let holder = el;
        while (holder.parentElement && holder.parentElement !== document.body) holder = holder.parentElement;
        return holder;
    }));
    const above = Math.max(0, ...[...holders].map(zIndex));
    return /** @type {HTMLElement[]} */ ([...document.body.children]).filter(el => !holders.has(el)
        && ['fixed', 'absolute'].includes(getComputedStyle(el).position) && zIndex(el) > above);
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

/** @returns {HTMLElement[]} */
function overlayLayers() {
    return findLayers().overlays;
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
 * @param {HTMLElement[]} ordered
 * @param {HTMLElement[]} overlays
 * @returns {HTMLElement[]}
 */
function shownLayersBottomUp(ordered, overlays) {
    return [
        ...ordered.filter(isShown).sort(compareOrder),
        ...overlays.filter(isShown),
    ];
}

/**
 * @param {Element} el
 * @returns {boolean}
 */
function isOrdered(el) {
    return findLayers().ordered.includes(/** @type {HTMLElement} */ (el));
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
 * @param {HTMLElement} el
 * @param {DOMRect} box
 * @param {boolean} whole
 * @param {number} [depth]
 * @returns {Rect[]}
 */
function paintedBoxes(el, box, whole, depth = 4) {
    const style = getComputedStyle(el);
    if (whole || depth === 0 || paintsItself(style)) return [roundedBox(el, box, style)];
    return [...el.children].flatMap((child) => {
        if (!(child instanceof HTMLElement) || !child.checkVisibility({ visibilityProperty: true })) return [];
        const childBox = child.getBoundingClientRect();
        if (childBox.width === 0 || childBox.height === 0) return [];
        return paintedBoxes(child, childBox, false, depth - 1);
    });
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
 * @param {DOMRect} box
 * @param {Rect[]} covers
 * @returns {Rect[]}
 */
function holesIn(box, covers) {
    /** @type {Rect[]} */
    const out = [];
    for (const c of covers) {
        const top = Math.max(box.top, c.top) - box.top;
        const bottom = Math.min(box.bottom, c.bottom) - box.top;
        const left = Math.max(box.left, c.left) - box.left;
        const right = Math.min(box.right, c.right) - box.left;
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

export function updateDrawerStack() {
    const ordered = orderedLayers();
    raiseAppearedLayers(ordered);
    keepEditedLayersInFront(ordered);
    let changed = false;
    if (!stackOn()) {
        for (const el of [...cut]) changed = clearLayer(el) || changed;
    } else {
        const bottomUp = shownLayersBottomUp(ordered, overlayLayers());
        const shown = new Set(bottomUp);
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
            const covers = above.filter(a => !el.contains(a.el) || a.el.matches(TOP_LAYER_SELECTOR)).flatMap(a => a.covers);
            changed = cutLayer(el, box, covers, isFullscreenDrawer(el, box, chatBox) ? barBoxes : null) || changed;
            if (!el.classList.contains('stackCovered')) above.push({ el, covers: paintedBoxes(el, box, isOrdered(el)) });
        }
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
    return [...orderedLayers(), ...overlayLayers()];
}

/**
 * @param {HTMLElement[]} layers
 * @returns {string}
 */
function boxesKey(layers) {
    return layers.filter(isShown).map(el => {
        const r = el.getBoundingClientRect();
        return `${r.left},${r.top},${r.width},${r.height}`;
    }).join(';');
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
 * @param {EventTarget | null} target
 * @returns {HTMLElement | null}
 */
function orderedLayerOf(target) {
    if (!(target instanceof Element) || target.closest(OVERLAY_SELECTOR)) return null;
    return /** @type {HTMLElement | null} */ (target.closest(ORDERED_SELECTOR));
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

export function drawerLayersChanged() {
    found = null;
    observeLayers();
    drawerStackChanged();
}

let classWatcher = /** @type {MutationObserver | null} */ (null);
let sizeWatcher = /** @type {ResizeObserver | null} */ (null);
function observeLayers() {
    if (!classWatcher || !sizeWatcher) return;
    classWatcher.disconnect();
    sizeWatcher.disconnect();
    for (const el of orderedLayers().filter(el => el.matches(DRAWER_SELECTOR))) {
        classWatcher.observe(el, { attributes: true, attributeFilter: ['class'] });
    }
    for (const el of allLayers()) sizeWatcher.observe(el);
}

/**
 * @param {() => void} visibilityChanged
 * @param {(el: HTMLElement) => void} [front]
 */
export function initDrawerStack(visibilityChanged, front) {
    onVisibilityChanged = visibilityChanged;
    onFront = el => (front && el.matches(STACK_DRAWER_SELECTOR) ? front(el) : raiseDrawer(el));
    classWatcher = new MutationObserver(drawerStackChanged);
    sizeWatcher = new ResizeObserver(() => { if (!frame) drawerStackChanged(); });
    observeLayers();
    const movingDivs = document.getElementById('movingDivs');
    if (movingDivs) new MutationObserver(drawerLayersChanged).observe(movingDivs, { childList: true });
    new MutationObserver(drawerLayersChanged).observe(document.body, { childList: true });
    $(document).on('autocompleteopen autocompleteclose select2:open select2:close', drawerLayersChanged);
    document.addEventListener(OVERLAYS_CHANGED_EVENT, drawerLayersChanged);
    document.addEventListener('toggle', drawerLayersChanged, true);
    document.addEventListener('close', drawerLayersChanged, true);
    document.addEventListener('pointerdown', onUserInput, true);
    document.addEventListener('keydown', onUserInput, true);
    window.addEventListener('resize', drawerStackChanged);
    for (const el of orderedLayers()) {
        if (isShown(el)) wasShown.add(el); else hiddenOrder.set(el, drawerOrder(el));
    }
    updateDrawerStack();
}
