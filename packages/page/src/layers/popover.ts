import { onCleanup, onMount } from 'solid-js';
import { dismiss } from '@pterror/interact-list/dismiss';
import { popover } from '@pterror/interact-list/popover';

export type Box = { left: number; top: number; right: number; bottom: number };
export type Anchor = { getBoundingClientRect(): Box };

// `start`: under the anchor from its left edge; `end`: under it, ending at its right edge; `right`: beside it.
export type Align = 'start' | 'end' | 'right';

export type FloatOptions = {
    anchor: () => Anchor | undefined;
    close: () => void;
    align?: Align;
    // Elements a press on doesn't close it besides the element itself, such as the button that toggles it.
    also?: () => (Element | undefined)[];
    // false: the element holds framed panels of its own, so it isn't framed itself.
    framed?: boolean;
};

// The app's frame for floating menus and panels (public/style.css); `st-float` only places it.
export const FLOATING_CLASS = 'st-floating';
const FLOAT_CLASS = 'st-float';

const GAP = 6;
const EDGE = 8;

// The point the element's top-left corner goes to, kept inside the viewport.
function placedAt(anchor: Box, element: HTMLElement, align: Align): Box {
    const width = element.offsetWidth;
    const height = element.offsetHeight;
    let x = align === 'end' ? anchor.right - width : align === 'right' ? anchor.right + GAP : anchor.left;
    let y = align === 'right' ? anchor.top : anchor.bottom + GAP;
    x = Math.max(EDGE, Math.min(x, window.innerWidth - width - EDGE));
    if (y + height > window.innerHeight - EDGE && align !== 'right') y = Math.max(EDGE, anchor.top - GAP - height);
    y = Math.max(EDGE, Math.min(y, window.innerHeight - height - EDGE));
    return { left: x, top: y, right: x, bottom: y };
}

function placeOnce(element: HTMLElement, anchor: Anchor): () => void {
    const { left, top } = anchor.getBoundingClientRect();
    element.style.left = `${String(left)}px`;
    element.style.top = `${String(top)}px`;
    element.style.visibility = 'visible';
    return () => undefined;
}

// Shows `element()` as a popover against `anchor()` while the calling component is mounted, and calls `close` on a
// press outside it or on Escape. Escape goes no further: the old page closes its drawers on Escape.
export function float(element: () => HTMLElement | undefined, options: FloatOptions) {
    onMount(() => {
        const shown = element();
        if (!shown) return;
        shown.classList.add(FLOAT_CLASS);
        if (options.framed !== false) shown.classList.add(FLOATING_CLASS);
        const align = options.align ?? 'start';
        const point: Anchor = {
            getBoundingClientRect: () => {
                const anchor = options.anchor()?.getBoundingClientRect() ?? { left: 0, top: 0, right: 0, bottom: 0 };
                return placedAt(anchor, shown, align);
            },
        };
        // Without the Popover API (older browsers) it is placed once, as a fixed box, outside the top layer.
        const stopShowing =
            typeof shown.showPopover === 'function'
                ? popover({
                      element: shown,
                      anchor: point,
                      open: { get: () => true, watch: () => () => undefined },
                      side: 'right',
                  })
                : placeOnce(shown, point);
        // `side: 'right'` puts the corner at the point's right and top, which placedAt made the corner itself.
        const stopDismissing = dismiss({
            elements: [shown, ...(options.also?.() ?? []).filter((e): e is Element => e !== undefined)],
            to: (open) => {
                if (!open) options.close();
            },
        });
        const key = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            event.stopPropagation();
            options.close();
        };
        window.addEventListener('keydown', key, true);
        onCleanup(() => {
            window.removeEventListener('keydown', key, true);
            stopDismissing();
            stopShowing();
        });
    });
}
