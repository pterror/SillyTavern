/** Read result identities rather than offsets, which can change after a refetch. */
export class SearchReadProgress {
    constructor(entries = []) {
        this.seen = new Map(entries);
    }

    /** @param {string[]} ids */
    firstUnread(ids) {
        return ids.findIndex(id => !this.seen.has(id));
    }

    /** @param {string} id @param {number} position */
    read(id, position) {
        this.seen.delete(id);
        this.seen.set(id, position);
        if (this.seen.size > 5000) this.seen.delete(this.seen.keys().next().value);
    }

    /** Newest results come first: the unread side extends up through the clicked card.
     * @param {string[]} ids @param {number} index @param {number} offset
     */
    unreadThrough(ids, index, offset) {
        ids.forEach((id, position) => this.read(id, offset + position));
        for (const [id, position] of this.seen) {
            if (position <= offset + index) this.seen.delete(id);
        }
    }

    /** @param {string[]} ids */
    boundary(ids) {
        const last = ids.findLastIndex(id => !this.seen.has(id));
        return last < 0 ? -1 : last + 1;
    }
}

/** Geometry in viewport coordinates; the overlay itself does not affect card layout.
 * @param {{left: number, right: number, top: number, bottom: number}[]} boxes
 * @param {number} index
 * @param {number} left
 * @param {number} right
 */
export function unreadDividerPoints(boxes, index, left, right) {
    if (index === boxes.length) {
        const bottom = Math.max(...boxes.map(box => box.bottom));
        return [[left, bottom], [right, bottom]];
    }
    const first = boxes[index];
    const sameRow = box => Math.abs(box.top - first.top) < 2;
    let start = index;
    let end = index;
    while (start > 0 && sameRow(boxes[start - 1])) start--;
    while (end + 1 < boxes.length && sameRow(boxes[end + 1])) end++;
    const rowBottom = Math.max(...boxes.slice(start, end + 1).map(box => box.bottom));
    const above = start > 0 ? Math.max(...boxes.slice(0, start).map(box => box.bottom)) : first.top;
    const top = start > 0 ? (above + first.top) / 2 : first.top;
    if (start === index) return [[left, top], [right, top]];
    const bottom = end + 1 < boxes.length ? (rowBottom + boxes[end + 1].top) / 2 : rowBottom;
    const split = (boxes[index - 1].right + first.left) / 2;
    return [[left, bottom], [split, bottom], [split, top], [right, top]];
}

/** Cut a real gap around the caption, including a nearby vertical step.
 * @param {number[][]} points
 * @param {{left: number, right: number, top: number, bottom: number}} gap
 * @returns {number[][][]}
 */
export function unreadDividerSegments(points, gap) {
    const result = [];
    for (let index = 0; index < points.length - 1; index++) {
        const [a, b] = [points[index], points[index + 1]];
        const horizontal = a[1] === b[1];
        const axis = horizontal ? 0 : 1;
        const cross = horizontal ? 1 : 0;
        const min = Math.min(a[axis], b[axis]);
        const max = Math.max(a[axis], b[axis]);
        const lo = horizontal ? gap.left : gap.top;
        const hi = horizontal ? gap.right : gap.bottom;
        const crossLo = horizontal ? gap.top : gap.left;
        const crossHi = horizontal ? gap.bottom : gap.right;
        if (a[cross] < crossLo || a[cross] > crossHi || max <= lo || min >= hi) {
            result.push([a, b]);
            continue;
        }
        const point = value => horizontal ? [value, a[1]] : [a[0], value];
        if (min < lo) result.push([point(min), point(lo)]);
        if (max > hi) result.push([point(hi), point(max)]);
    }
    return result;
}

/**
 * @param {{ getItem: (key: string) => string|null, setItem: (key: string, value: string) => void }} storage
 * @param {() => boolean} showing
 * @param {() => string} label
 */
export function searchReadDivider(storage, showing, label) {
    const storageKey = 'characterSearchReadProgress';
    let saved;
    try { saved = JSON.parse(storage.getItem(storageKey) ?? '[]'); } catch { saved = []; }
    const searches = new Map(Array.isArray(saved) ? saved.filter(entry => Array.isArray(entry) && typeof entry[0] === 'string' && Array.isArray(entry[1])) : []);
    let disconnect = () => {};
    const manuallyUnread = new Set();
    const persist = () => {
        try { storage.setItem(storageKey, JSON.stringify([...searches])); } catch { /* Storage may be full or unavailable. */ }
    };
    window.addEventListener('pagehide', persist);

    return (list, key, offset) => {
        disconnect();
        list.querySelector('.search_unread_divider')?.remove();
        if (!key) return;
        const progress = new SearchReadProgress(searches.get(key) ?? []);
        searches.delete(key);
        searches.set(key, [...progress.seen]);
        if (searches.size > 30) searches.delete(searches.keys().next().value);
        const rows = [...list.children].filter(row => row instanceof HTMLElement && row.dataset.searchResultId);
        const ids = rows.map(row => row.dataset.searchResultId);
        const remember = () => searches.set(key, [...progress.seen]);
        const divider = document.createElement('div');
        divider.className = 'search_unread_divider';
        divider.setAttribute('role', 'separator');
        divider.setAttribute('aria-label', label());
        const caption = document.createElement('span');
        caption.className = 'search_unread_label';
        caption.textContent = label();
        divider.append(caption);
        let boundary = -1;
        const segments = Array.from({ length: 6 }, () => {
            const segment = document.createElement('span');
            segment.className = 'search_unread_segment';
            divider.prepend(segment);
            return segment;
        });
        const position = () => {
            if (boundary < 0 || !divider.isConnected) return;
            const boxes = rows.map(row => row.getBoundingClientRect());
            const anchorIndex = Math.min(boundary, rows.length - 1);
            const anchor = {
                left: boxes[anchorIndex].left + rows[anchorIndex].clientLeft,
                top: boxes[anchorIndex].top + rows[anchorIndex].clientTop,
            };
            const listBox = list.getBoundingClientRect();
            const style = window.getComputedStyle(list);
            const left = listBox.left + list.clientLeft + (parseFloat(style.paddingLeft) || 0);
            const right = listBox.left + list.clientLeft + list.clientWidth - (parseFloat(style.paddingRight) || 0);
            const points = unreadDividerPoints(boxes, boundary, left, right);
            const center = listBox.left + list.clientLeft + list.clientWidth / 2;
            // The center can fall on either horizontal arm of the step.
            const arm = points.slice(0, -1).find((from, index) => {
                const to = points[index + 1];
                return from[1] === to[1] && center >= Math.min(from[0], to[0]) && center <= Math.max(from[0], to[0]);
            });
            caption.style.left = `${center - anchor.left}px`;
            caption.style.top = `${(arm ?? points.at(-1))[1] - anchor.top}px`;
            const captionBox = caption.getBoundingClientRect();
            const lines = unreadDividerSegments(points, {
                left: captionBox.left - 4, right: captionBox.right + 4,
                top: captionBox.top - 2, bottom: captionBox.bottom + 2,
            });
            segments.forEach((segment, index) => {
                const line = lines[index];
                segment.hidden = !line;
                if (!line) return;
                const [from, to] = line;
                segment.style.left = `${Math.min(from[0], to[0]) - anchor.left}px`;
                segment.style.top = `${Math.min(from[1], to[1]) - anchor.top}px`;
                segment.style.width = `${Math.max(2, Math.abs(to[0] - from[0]))}px`;
                segment.style.height = `${Math.max(2, Math.abs(to[1] - from[1]))}px`;
            });
        };
        const place = index => {
            divider.remove();
            boundary = index;
            if (index >= 0 && rows.length) rows[Math.min(index, rows.length - 1)].prepend(divider);
            position();
        };
        place(progress.boundary(ids));
        const resize = new window.ResizeObserver(position);
        resize.observe(list);
        rows.forEach(row => resize.observe(row));
        const layout = new window.MutationObserver(position);
        layout.observe(document.body, { attributes: true, attributeFilter: ['class'] });
        window.addEventListener('resize', position);

        const catchUp = (fromScroll = false) => {
            if (document.visibilityState !== 'visible' || !showing() || list.clientHeight <= 0) return;
            const atEnd = list.scrollTop <= 1;
            if (!atEnd) {
                manuallyUnread.delete(key);
                return;
            }
            // Keep an explicit reset until the next scroll, even when the list is already at the top.
            if (manuallyUnread.has(key) && !fromScroll) return;
            manuallyUnread.delete(key);
            ids.forEach((id, index) => progress.read(id, offset + index));
            remember();
            persist();
            divider.remove();
        };
        const observer = new IntersectionObserver(entries => {
            if (entries.some(entry => entry.isIntersecting)) catchUp();
        }, { root: list, threshold: 0 });
        if (rows.length) observer.observe(rows[0]);
        const onScroll = () => catchUp(true);
        const onFocus = () => catchUp();
        list.addEventListener('scroll', onScroll, { passive: true });
        document.addEventListener('visibilitychange', onFocus);
        window.addEventListener('focus', onFocus);
        const click = event => {
            if (!event.altKey) return;
            const index = rows.findIndex(row => row.contains(event.target));
            if (index < 0) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            progress.unreadThrough(ids, index, offset);
            manuallyUnread.add(key);
            remember();
            persist();
            place(index + 1);
        };
        list.addEventListener('click', click, true);
        disconnect = () => {
            observer.disconnect();
            resize.disconnect();
            layout.disconnect();
            window.removeEventListener('resize', position);
            list.removeEventListener('scroll', onScroll);
            document.removeEventListener('visibilitychange', onFocus);
            window.removeEventListener('focus', onFocus);
            list.removeEventListener('click', click, true);
            remember();
            persist();
        };
    };
}
