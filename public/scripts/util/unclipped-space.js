/**
 * The part of the window where what is inside an element is not clipped by any of its scrolling or clipping
 * ancestors.
 * @param {Element} el
 * @returns {{ left: number, top: number, right: number, bottom: number }}
 */
export function unclippedSpace(el) {
    let space = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
    for (let parent = el.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        const clipsX = style.overflowX !== 'visible';
        const clipsY = style.overflowY !== 'visible';
        if (!clipsX && !clipsY) continue;
        const box = parent.getBoundingClientRect();
        space = {
            left: clipsX ? Math.max(space.left, box.left) : space.left,
            right: clipsX ? Math.min(space.right, box.right) : space.right,
            top: clipsY ? Math.max(space.top, box.top) : space.top,
            bottom: clipsY ? Math.min(space.bottom, box.bottom) : space.bottom,
        };
    }
    return space;
}
