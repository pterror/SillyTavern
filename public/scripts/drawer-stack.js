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
 * - floating lists (autocomplete menus, select2 dropdowns, the hold-Ctrl hotkey list): above every ordered layer
 *   while shown.
 *
 * The stack is told when something changes (drawerStackChanged, drawerLayersChanged) by the code that opens,
 * closes, fronts, moves or resizes a layer, and by the dropdown libraries' events. The only things it watches are
 * each top-bar drawer's own class (an extension may open one without our code) and the children of #movingDivs and
 * <body> (floating windows coming and going).
 */
import { setHoles, uncoveredPieces, unionArea } from './util/underlay-clip.js';

/** The top-bar drawers. They share #top-settings-holder's stacking context, so z-index alone orders their painting. */
export const STACK_DRAWER_SELECTOR = '#top-settings-holder > .drawer > .drawer-content';
/** Floating windows: ordered, and brought forward when they appear. */
const FLOATING_SELECTOR = '#movingDivs > *, body > .draggable';
/** The chat. Ordered like any layer; it starts at the bottom. */
const CHAT_ID = 'sheld';
/** Floating lists and the hold-Ctrl hotkey list: above every ordered layer while shown. */
const LIST_SELECTOR = '.ui-menu, .select2-container--open > .select2-dropdown, .hotkeyOverlay';
const ORDERED_SELECTOR = `#${CHAT_ID}, ${STACK_DRAWER_SELECTOR}, ${FLOATING_SELECTOR}`;
/** An edit in progress: a character info field, or a chat message or its reasoning. */
const EDITING_SELECTOR = '.field_editing, #curEditTextarea, .reasoning_edit_textarea';
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
 * The layers in the page, found once and kept until a layer may have come or gone (see initDrawerStack's
 * `relayer`): querying the whole page several times a frame is what made every drawer move lag with a long list.
 * @type {{ ordered: HTMLElement[], lists: HTMLElement[], icons: HTMLElement[] } | null}
 */
let found = null;

function findLayers() {
    found ??= {
        ordered: /** @type {HTMLElement[]} */ ([...document.querySelectorAll(ORDERED_SELECTOR)]),
        lists: /** @type {HTMLElement[]} */ ([...document.querySelectorAll(LIST_SELECTOR)]),
        icons: /** @type {HTMLElement[]} */ ([...document.querySelectorAll('[data-stack-front-of]')]),
    };
    return found;
}

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
    return findLayers().ordered;
}

/** @returns {HTMLElement[]} The floating lists in the page, shown or not. */
function listLayers() {
    return findLayers().lists;
}

/** @param {HTMLElement} el @returns {boolean} Whether an edit is in progress in it. */
function isEditing(el) {
    return el.querySelector(EDITING_SELECTOR) !== null;
}

/** @type {WeakSet<HTMLElement>} Layers that held an edit at the last update. */
const wasEditing = new WeakSet();

/**
 * Bottom-to-top order of two ordered layers: a layer with an edit in progress above every other, so nothing covers
 * what is being edited (another layer can still open, beside or behind it); then by when brought forward; never
 * brought forward, the chat is lowest; then html order, as painting does.
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

/**
 * @param {HTMLElement[]} ordered
 * @param {HTMLElement[]} lists
 * @returns {HTMLElement[]} The shown layers, bottom first.
 */
function shownLayersBottomUp(ordered, lists) {
    return [
        ...ordered.filter(isShown).sort(compareOrder),
        ...lists.filter(isShown),
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
    // Removing a class that isn't there still rewrites the attribute, which wakes this module's own observer.
    if (wasCovered) el.classList.remove('stackCovered');
    delete el.dataset.stackCut;
    cut.delete(el);
    return wasCovered;
}

/**
 * @param {HTMLElement} el
 * @param {DOMRect} box Its box
 * @param {DOMRect | null} chatBox The chat's box, if shown
 * @returns {boolean} Whether it is a fullscreen drawer: a top-bar drawer reaching past the chat on both sides.
 */
function isFullscreenDrawer(el, box, chatBox) {
    return !!chatBox && el.matches(STACK_DRAWER_SELECTOR) && box.left < chatBox.left - 1 && box.right > chatBox.right + 1;
}

/**
 * Cuts the union of `covers` out of `el`. A fullscreen drawer whose visible part falls apart into separate pieces
 * (a column down its middle leaving two strips) is hidden whole instead. Only fullscreen drawers get this, to keep the
 * extra work off every other layer; it can widen later.
 * @param {HTMLElement} el
 * @param {DOMRect} box Its box
 * @param {DOMRect[]} covers
 * @param {DOMRect[] | null} hideIfSplit Null, or what else hides parts of it (the drawer bar), for telling whether its
 * visible part is split
 * @returns {boolean} Whether its entirely-covered state changed
 */
function cutLayer(el, box, covers, hideIfSplit) {
    const rects = holesIn(box, covers);
    if (rects.length === 0) return clearLayer(el);
    setHoles(el, HOLE_SOURCE, rects);
    const covered = unionArea(rects) >= box.width * box.height - 0.5
        || (!!hideIfSplit && uncoveredPieces(box.width, box.height, [...rects, ...holesIn(box, hideIfSplit)]) > 1);
    const before = el.classList.contains('stackCovered');
    el.classList.toggle('stackCovered', covered);
    el.dataset.stackCut = 'true';
    cut.add(el);
    return before !== covered;
}

/**
 * Floating windows that were hidden at the last update and are shown now come forward.
 * @param {HTMLElement[]} ordered
 */
function raiseAppearedWindows(ordered) {
    for (const el of ordered.filter(el => el.matches(FLOATING_SELECTOR))) {
        const shown = isShown(el);
        if (shown && !wasShown.has(el)) raiseDrawer(el);
        if (shown) wasShown.add(el); else wasShown.delete(el);
    }
}

/**
 * A layer whose edit just ended stays where it was, above the layers opened while it was being edited.
 * @param {HTMLElement[]} ordered
 */
function keepEditedLayersInFront(ordered) {
    for (const el of ordered) {
        const editing = isEditing(el);
        if (!editing && wasEditing.has(el)) raiseDrawer(el);
        if (editing) wasEditing.add(el); else wasEditing.delete(el);
    }
}

/**
 * Recomputes every cut from where the layers are now. Synchronous, so code reading a drawer's visibility right after
 * opening, closing or fronting one sees the new state.
 */
export function updateDrawerStack() {
    const ordered = orderedLayers();
    raiseAppearedWindows(ordered);
    keepEditedLayersInFront(ordered);
    let changed = false;
    if (!stackOn()) {
        for (const el of [...cut]) changed = clearLayer(el) || changed;
    } else {
        const bottomUp = shownLayersBottomUp(ordered, listLayers());
        const shown = new Set(bottomUp);
        for (const el of [...cut]) {
            if (!shown.has(el)) changed = clearLayer(el) || changed;
        }
        const chat = document.getElementById(CHAT_ID);
        const chatBox = chat && shown.has(chat) ? chat.getBoundingClientRect() : null;
        const bar = document.getElementById('top-settings-holder');
        const barBoxes = bar ? [bar.getBoundingClientRect()] : [];
        /** @type {{ el: HTMLElement, box: DOMRect }[]} */
        const above = [];
        for (let i = bottomUp.length - 1; i >= 0; i--) {
            const el = bottomUp[i];
            const box = el.getBoundingClientRect();
            // A layer inside another is cut along with it, so it never cuts its own ancestor.
            const covers = above.filter(a => !el.contains(a.el)).map(a => a.box);
            changed = cutLayer(el, box, covers, isFullscreenDrawer(el, box, chatBox) ? barBoxes : null) || changed;
            // A hidden layer covers nothing below it.
            if (!el.classList.contains('stackCovered')) above.push({ el, box });
        }
    }
    updateFrontIcons(ordered);
    if (changed) onVisibilityChanged();
}

/**
 * @param {HTMLElement} el An ordered layer
 * @param {HTMLElement[]} [ordered] Every ordered layer, if already at hand
 * @returns {boolean} Whether it is shown and no shown ordered layer above it covers any part of it. Floating lists
 * don't count: they sit above everything while open and say nothing about which layer was brought forward.
 */
function isLayerInFront(el, ordered = orderedLayers()) {
    if (!isShown(el)) return false;
    const box = el.getBoundingClientRect();
    return !ordered.some(other => other !== el && !el.contains(other) && isShown(other)
        && compareOrder(el, other) < 0 && holesIn(box, [other.getBoundingClientRect()]).length > 0);
}

/**
 * Lights each `[data-stack-front-of]` icon while the layer it names is in front; with stacked drawers off, none.
 * @param {HTMLElement[]} ordered
 */
function updateFrontIcons(ordered) {
    for (const icon of findLayers().icons) {
        const layer = document.getElementById(icon.dataset.stackFrontOf ?? '');
        icon.classList.toggle('stackFront', stackOn() && !!layer && isLayerInFront(layer, ordered));
    }
}

/**
 * Brings the chat forward, however much of it is covered.
 */
export function bringChatForward() {
    const chat = document.getElementById(CHAT_ID);
    if (!chat || !stackOn() || isLayerInFront(chat)) return;
    raiseDrawer(chat);
    updateDrawerStack();
}

/** @returns {HTMLElement[]} Every element that can be a layer. */
function allLayers() {
    return [...orderedLayers(), ...listLayers()];
}

/**
 * @param {HTMLElement[]} layers
 * @returns {string} Where the shown layers are, to tell when one moved.
 */
function boxesKey(layers) {
    return layers.filter(isShown).map(el => {
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
        const layers = allLayers();
        const boxes = boxesKey(layers);
        const moving = boxes !== lastBoxes || layers.some(el => isShown(el) && isAnimating(el));
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
    // A layer the stack hasn't found yet (an extension's drawer added after it last looked).
    if (!orderedLayers().includes(layer)) drawerLayersChanged();
    const shownAbove = orderedLayers().filter(other => other !== layer && isShown(other) && compareOrder(layer, other) < 0);
    if (shownAbove.length === 0) return;
    onFront(layer);
    drawerStackChanged();
}

/**
 * Something changed a layer: recomputes now, then every frame while a layer animates or moves (a drawer sliding
 * open, a window being dragged), stopping once nothing moves. The places that open, close, front, resize or move a
 * layer call this; the stack doesn't watch the page for them.
 */
export function drawerStackChanged() {
    updateDrawerStack();
    scheduleUpdate();
}

/** Layers may have come or gone (a drawer, window or list added or removed): finds them again, then recomputes. */
export function drawerLayersChanged() {
    found = null;
    observeDrawerClasses();
    drawerStackChanged();
}

/** Watches each top-bar drawer's own class: the one way an extension's code opens or closes a drawer without ours. */
let classWatcher = /** @type {MutationObserver | null} */ (null);
function observeDrawerClasses() {
    if (!classWatcher) return;
    classWatcher.disconnect();
    for (const el of orderedLayers().filter(el => el.matches(STACK_DRAWER_SELECTOR))) {
        classWatcher.observe(el, { attributes: true, attributeFilter: ['class'] });
    }
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
    classWatcher = new MutationObserver(drawerStackChanged);
    observeDrawerClasses();
    // Floating windows (editor layers, Author's Note, extensions' windows, zoomed avatars) come and go as children of
    // these two; nothing below them is watched.
    const movingDivs = document.getElementById('movingDivs');
    if (movingDivs) new MutationObserver(drawerLayersChanged).observe(movingDivs, { childList: true });
    new MutationObserver(drawerLayersChanged).observe(document.body, { childList: true });
    // The dropdown libraries say when a list opens or closes.
    $(document).on('autocompleteopen autocompleteclose select2:open select2:close', drawerLayersChanged);
    document.addEventListener('pointerdown', onUserInput, true);
    document.addEventListener('keydown', onUserInput, true);
    window.addEventListener('resize', drawerStackChanged);
    for (const el of /** @type {HTMLElement[]} */ ([...document.querySelectorAll(FLOATING_SELECTOR)])) {
        if (isShown(el)) wasShown.add(el);
    }
    updateDrawerStack();
}
