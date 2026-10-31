/** @typedef {{top: number, right: number, bottom: number, left: number, radii?: [number, number][]}} Rect */

const ARC_STEPS = 8;

/** @type {Map<HTMLElement, Map<string, Rect | Rect[]>>} */
const holes = new Map();

/** @type {Set<() => void>} */
const updaters = new Set();

/**
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

/**
 * @param {Rect[]} rects
 * @returns {number[][][]}
 */
function roundedCorners(rects) {
    const out = [];
    for (const r of rects) {
        if (!r.radii) continue;
        const corners = [[r.left, r.top, 1, 1], [r.right, r.top, -1, 1], [r.right, r.bottom, -1, -1], [r.left, r.bottom, 1, -1]];
        for (const [i, [x, y, dx, dy]] of corners.entries()) {
            const [rx, ry] = r.radii[i];
            if (!(rx > 0 && ry > 0)) continue;
            const square = { left: Math.min(x, x + dx * rx), right: Math.max(x, x + dx * rx), top: Math.min(y, y + dy * ry), bottom: Math.max(y, y + dy * ry) };
            const touches = rects.some(o => o !== r && o.left < square.right && o.right > square.left && o.top < square.bottom && o.bottom > square.top);
            if (touches) continue;
            const points = [[x, y]];
            for (let step = 0; step <= ARC_STEPS; step++) {
                const angle = step / ARC_STEPS * Math.PI / 2;
                points.push([x + dx * rx * (1 - Math.cos(angle)), y + dy * ry * (1 - Math.sin(angle))]);
            }
            out.push(points);
        }
    }
    return out;
}

/** @param {HTMLElement} el */
function apply(el) {
    const own = holes.get(el);
    const rects = own ? [...own.values()].flat() : [];
    if (rects.length === 0) {
        holes.delete(el);
        if (el.dataset.underlayClip !== undefined) {
            delete el.dataset.underlayClip;
            el.style.clipPath = '';
        }
        return;
    }
    const cut = [
        ...disjointRects(rects).map(r => [[r.left, r.top], [r.right, r.top], [r.right, r.bottom], [r.left, r.bottom]]),
        ...roundedCorners(rects),
    ]
        .map(points => [...points, points[0]].map(([x, y]) => `${x}px ${y}px`).join(', ') + ', 0 0')
        .join(', ');
    const clipPath = `polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${cut})`;
    if (el.dataset.underlayClip !== clipPath) {
        el.dataset.underlayClip = clipPath;
        el.style.clipPath = clipPath;
    }
}

/**
 * @param {HTMLElement} el
 * @param {string} source
 * @param {Rect[]} rects
 */
export function setHoles(el, source, rects) {
    if (rects.length === 0) {
        holes.get(el)?.delete(source);
    } else {
        if (!holes.has(el)) {
            holes.set(el, new Map());
        }
        holes.get(el).set(source, rects);
    }
    apply(el);
}

/**
 * @param {Rect[]} rects
 * @returns {number}
 */
export function unionArea(rects) {
    return disjointRects(rects).reduce((sum, r) => sum + (r.right - r.left) * (r.bottom - r.top), 0);
}

/**
 * @param {number} width
 * @param {number} height
 * @param {Rect[]} rects
 * @param {number} [minSide]
 * @param {number} [minArea]
 * @returns {number}
 */
export function uncoveredPieces(width, height, rects, minSide = 4, minArea = 64) {
    const edges = (/** @type {number[]} */ values, /** @type {number} */ size) =>
        [...new Set([0, size, ...values.map(v => Math.min(size, Math.max(0, v)))])].sort((a, b) => a - b);
    const xs = edges(rects.flatMap(r => [r.left, r.right]), width);
    const ys = edges(rects.flatMap(r => [r.top, r.bottom]), height);
    const nx = xs.length - 1;
    const ny = ys.length - 1;
    const open = (/** @type {number} */ i, /** @type {number} */ j) => {
        if (xs[i + 1] - xs[i] < minSide || ys[j + 1] - ys[j] < minSide) return false;
        const x = (xs[i] + xs[i + 1]) / 2;
        const y = (ys[j] + ys[j + 1]) / 2;
        return !rects.some(r => x > r.left && x < r.right && y > r.top && y < r.bottom);
    };
    const seen = new Set();
    let pieces = 0;
    for (let i = 0; i < nx; i++) {
        for (let j = 0; j < ny; j++) {
            if (seen.has(i * ny + j) || !open(i, j)) continue;
            let area = 0;
            const queue = [[i, j]];
            seen.add(i * ny + j);
            while (queue.length) {
                const [ci, cj] = /** @type {number[]} */ (queue.pop());
                area += (xs[ci + 1] - xs[ci]) * (ys[cj + 1] - ys[cj]);
                for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                    const ni = ci + di;
                    const nj = cj + dj;
                    if (ni < 0 || nj < 0 || ni >= nx || nj >= ny || seen.has(ni * ny + nj) || !open(ni, nj)) continue;
                    seen.add(ni * ny + nj);
                    queue.push([ni, nj]);
                }
            }
            if (area >= minArea) pieces++;
        }
    }
    return pieces;
}

/**
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
 * @param {string} source
 */
export function underlayClip(source) {
    /** @type {Set<HTMLElement>} */
    let mine = new Set();

    return {
        /**
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
 * @param {() => void} update
 * @returns {() => void}
 */
export function registerUnderlayClip(update) {
    updaters.add(update);
    return () => updaters.delete(update);
}

export function refreshUnderlayClips() {
    for (const update of updaters) {
        update();
    }
}
