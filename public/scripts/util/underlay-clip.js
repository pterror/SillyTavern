/**
 * Cuts holes in the elements under a see-through overlay, so what it covers doesn't show through it. Each overlay
 * is one source; an element covered by several sources gets all their holes at once.
 */

/** @typedef {{top: number, right: number, bottom: number, left: number}} Rect */

/** @type {Map<HTMLElement, Map<string, Rect>>} element -> source -> hole, in the element's own coordinates */
const holes = new Map();

/** @type {Set<() => void>} */
const updaters = new Set();

/**
 * Splits a union of rectangles into disjoint ones, so an evenodd polygon cuts each covered point exactly once.
 * @param {Rect[]} rects
 * @returns {Rect[]}
 */
function disjointRects(rects) {
    const ys = [...new Set(rects.flatMap(r => [r.top, r.bottom]))].sort((a, b) => a - b);
    /** @type {Rect[]} */
    const out = [];
    for (let i = 0; i + 1 < ys.length; i++) {
        const top = ys[i];
        const bottom = ys[i + 1];
        const spans = rects
            .filter(r => r.top <= top && r.bottom >= bottom)
            .map(r => [r.left, r.right])
            .sort((a, b) => a[0] - b[0]);
        for (const [left, right] of spans) {
            const last = out.length ? out[out.length - 1] : null;
            if (last && last.top === top && last.bottom === bottom && left <= last.right) {
                last.right = Math.max(last.right, right);
            } else {
                out.push({ top, right, bottom, left });
            }
        }
    }
    return out;
}

/** @param {HTMLElement} el */
function apply(el) {
    const own = holes.get(el);
    if (!own || own.size === 0) {
        holes.delete(el);
        el.style.clipPath = '';
        return;
    }
    const cut = disjointRects([...own.values()])
        .map(r => `${r.left}px ${r.top}px, ${r.right}px ${r.top}px, ${r.right}px ${r.bottom}px, ${r.left}px ${r.bottom}px, ${r.left}px ${r.top}px`)
        .join(', ');
    el.style.clipPath = `polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${cut})`;
}

/**
 * The nearest ancestor of `el` that scrolls (or the document), which the cut stops at.
 * @param {HTMLElement} el
 * @returns {HTMLElement}
 */
export function scrollContainerOf(el) {
    for (let node = el.parentElement; node; node = node.parentElement) {
        if (getComputedStyle(node).overflowY !== 'visible') {
            return node;
        }
    }
    return document.documentElement;
}

/**
 * One overlay's holes.
 * @param {string} source A name unique to the overlay
 */
export function underlayClip(source) {
    /** @type {Set<HTMLElement>} */
    let mine = new Set();

    return {
        /**
         * Cuts `cover` (viewport coordinates) out of every sibling of `anchor` and of each of its ancestors, up to
         * `stopAt`: everything laid out next to the overlay's place in the page that the overlay sits on.
         * @param {Rect} cover
         * @param {HTMLElement} anchor
         * @param {HTMLElement} stopAt
         */
        cover(cover, anchor, stopAt) {
            /** @type {Set<HTMLElement>} */
            const now = new Set();
            if (cover.bottom > cover.top && cover.right > cover.left) {
                for (let path = anchor; path !== stopAt && path.parentElement; path = path.parentElement) {
                    for (const sibling of path.parentElement.children) {
                        if (sibling === path || !(sibling instanceof HTMLElement)) {
                            continue;
                        }
                        const rect = sibling.getBoundingClientRect();
                        const top = Math.max(rect.top, cover.top) - rect.top;
                        const bottom = Math.min(rect.bottom, cover.bottom) - rect.top;
                        const left = Math.max(rect.left, cover.left) - rect.left;
                        const right = Math.min(rect.right, cover.right) - rect.left;
                        if (bottom <= top || right <= left) {
                            continue;
                        }
                        if (!holes.has(sibling)) {
                            holes.set(sibling, new Map());
                        }
                        holes.get(sibling).set(source, { top, right, bottom, left });
                        now.add(sibling);
                    }
                }
            }
            for (const el of mine) {
                if (!now.has(el)) {
                    holes.get(el)?.delete(source);
                }
            }
            for (const el of new Set([...mine, ...now])) {
                apply(el);
            }
            mine = now;
        },
        /** Removes this overlay's holes. */
        clear() {
            for (const el of mine) {
                holes.get(el)?.delete(source);
                apply(el);
            }
            mine = new Set();
        },
    };
}

/**
 * Registers a function that recomputes an overlay's holes, for {@link refreshUnderlayClips}.
 * @param {() => void} update
 * @returns {() => void} Unregisters it
 */
export function registerUnderlayClip(update) {
    updaters.add(update);
    return () => updaters.delete(update);
}

/** Recomputes every overlay's holes, e.g. after the setting that turns them on changes. */
export function refreshUnderlayClips() {
    for (const update of updaters) {
        update();
    }
}
