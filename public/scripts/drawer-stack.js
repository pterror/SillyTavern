/**
 * Stacked drawers: the layers on screen (the chat, the top-bar drawers, zoomed avatars, open suggestion lists) are
 * ordered by when each was last brought forward, and with stacked drawers on each one shows exactly what nothing above
 * it covers: walking from the topmost layer down, every layer is cut by the union of the boxes above it. A see-through
 * theme then never shows two layers in one place. Paint order doesn't have to agree: whichever paints on top, the
 * lower layer is cut where the upper one is.
 */
import { setHoles, unionArea } from './util/underlay-clip.js';

/** The top-bar drawers. They share #top-settings-holder's stacking context, so z-index alone orders their painting. */
export const STACK_DRAWER_SELECTOR = '#top-settings-holder > .drawer > .drawer-content';
/** Layers that come and go and are ordered from the moment they appear. */
const RAISED_ON_APPEAR_SELECTOR = '.zoomed_avatar';
/** Always the bottom layer. */
const BOTTOM_ID = 'sheld';
const HOLE_SOURCE = 'drawer-stack';
/** Past this, the ordered layers are renumbered from 1, keeping the numbers small. */
const MAX_ORDER = 1000;

/** @typedef {import('./util/underlay-clip.js').Rect} Rect */

/** @type {Set<HTMLElement>} Layers that currently have this module's holes or the covered class. */
const cut = new Set();
/** @type {Set<HTMLElement>} Layers above every other one while they are shown (e.g. an open suggestion list). */
const overlays = new Set();
/** @type {() => void} */
let onVisibilityChanged = () => {};
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
    return /** @type {HTMLElement[]} */ ([...document.querySelectorAll(`${STACK_DRAWER_SELECTOR}, ${RAISED_ON_APPEAR_SELECTOR}`)]);
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
            .sort((a, b) => drawerOrder(a) - drawerOrder(b))
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

/**
 * Shows `el` above every other layer while it is displayed, and cuts what it covers below.
 * @param {HTMLElement} el
 */
export function addStackOverlay(el) {
    overlays.add(el);
    scheduleUpdate();
}

/** @param {HTMLElement} el */
export function removeStackOverlay(el) {
    overlays.delete(el);
    if (cut.has(el)) clearLayer(el);
    scheduleUpdate();
}

/** @param {HTMLElement} el @returns {boolean} Whether it takes up space on screen now (mid-animation included). */
function isShown(el) {
    if (!el.isConnected || getComputedStyle(el).display === 'none') return false;
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
}

/** @returns {HTMLElement[]} The shown layers, bottom first. */
function shownLayersBottomUp() {
    /** @type {HTMLElement[]} */
    const stack = orderedLayers().filter(isShown)
        .sort((a, b) => drawerOrder(a) - drawerOrder(b)
            || (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    const bottom = document.getElementById(BOTTOM_ID);
    return [
        ...(bottom && isShown(bottom) ? [bottom] : []),
        ...stack,
        ...[...overlays].filter(isShown),
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

/**
 * Recomputes every cut from where the layers are now. Synchronous, so code reading a drawer's visibility right after
 * opening, closing or fronting one sees the new state.
 */
export function updateDrawerStack() {
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
    return [document.getElementById(BOTTOM_ID), ...orderedLayers(), ...overlays].filter(Boolean);
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
 * Starts following the layers.
 * @param {() => void} visibilityChanged Called when a layer becomes or stops being entirely covered.
 */
export function initDrawerStack(visibilityChanged) {
    onVisibilityChanged = visibilityChanged;
    const resize = new ResizeObserver(scheduleUpdate);
    // A layer's own class (open, closed, fullscreen) and shown menu decide where it is.
    const changed = new MutationObserver(scheduleUpdate);
    const observeLayers = () => {
        resize.disconnect();
        changed.disconnect();
        for (const el of [document.getElementById(BOTTOM_ID), ...orderedLayers()]) {
            if (!el) continue;
            resize.observe(el);
            changed.observe(el, { attributes: true, attributeFilter: ['class', 'data-active-menu'] });
        }
    };
    const holder = document.getElementById('top-settings-holder');
    observeLayers();
    // A drawer added later (by an extension) is a new .drawer in the holder.
    if (holder) new MutationObserver(observeLayers).observe(holder, { childList: true });
    // Animations of a layer itself start without a resize or a class change (a fade, a transform).
    const onLayerAnimation = (/** @type {Event} */ event) => {
        if (event.target instanceof HTMLElement && allLayers().includes(event.target)) scheduleUpdate();
    };
    document.addEventListener('transitionrun', onLayerAnimation, true);
    document.addEventListener('animationstart', onLayerAnimation, true);
    new MutationObserver(scheduleUpdate).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    // Zoomed avatars are added to <body>, come forward as they appear, and move when dragged (their inline style).
    const moved = new MutationObserver(scheduleUpdate);
    new MutationObserver(records => {
        let relevant = false;
        for (const record of records) {
            for (const node of record.addedNodes) {
                if (node instanceof HTMLElement && node.matches(RAISED_ON_APPEAR_SELECTOR)) {
                    raiseDrawer(node);
                    moved.observe(node, { attributes: true, attributeFilter: ['style'] });
                    relevant = true;
                }
            }
            for (const node of record.removedNodes) {
                if (node instanceof HTMLElement && node.matches(RAISED_ON_APPEAR_SELECTOR)) relevant = true;
            }
        }
        if (relevant) {
            observeLayers();
            scheduleUpdate();
        }
    }).observe(document.body, { childList: true });
    window.addEventListener('resize', scheduleUpdate);
    updateDrawerStack();
}
