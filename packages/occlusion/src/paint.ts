import { finite, insetBox } from './geometry.ts';
import type { Radii, Rect } from './geometry.ts';

export function inTopLayer(el: Element): boolean {
    return el.matches(':modal, :popover-open');
}

export function isShown(el: Element): boolean {
    if (!el.isConnected || getComputedStyle(el).display === 'none') return false;
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
}

export function isPositioned(el: Element): boolean {
    const position = getComputedStyle(el).position;
    return position === 'fixed' || position === 'absolute' || position === 'sticky';
}

export function zIndexOf(el: Element): number {
    return finite(Number.parseInt(getComputedStyle(el).zIndex));
}

export function rootZOf(el: Element, root: Element): number {
    let z = 0;
    for (let at: Element | null = el; at && at !== root; at = at.parentElement) {
        const style = getComputedStyle(at);
        if (style.position !== 'static' && style.zIndex !== 'auto') z = finite(Number.parseInt(style.zIndex));
    }
    return z;
}

export function childOf(el: Element, root: Element): Element {
    let at = el;
    while (at.parentElement && at.parentElement !== root) at = at.parentElement;
    return at;
}

function within(a: Rect, b: Rect): boolean {
    return a.left >= b.left - 1 && a.top >= b.top - 1 && a.right <= b.right + 1 && a.bottom <= b.bottom + 1;
}

export function paintsOver(el: Element): boolean {
    if (inTopLayer(el)) return true;
    const position = getComputedStyle(el).position;
    if (position === 'fixed' || position === 'sticky') return true;
    if (position !== 'absolute' || !(el instanceof HTMLElement)) return false;
    const parent = el.offsetParent;
    if (!parent || parent === document.body || parent === document.documentElement) return true;
    return !within(el.getBoundingClientRect(), parent.getBoundingClientRect());
}

function paintsItself(style: CSSStyleDeclaration): boolean {
    const seen = (color: string) => !/^(transparent|rgba\(.*,\s*0\))$/.test(color);
    return (
        seen(style.backgroundColor) ||
        style.backgroundImage !== 'none' ||
        style.boxShadow !== 'none' ||
        style.backdropFilter !== 'none' ||
        [
            [style.borderTopWidth, style.borderTopColor],
            [style.borderRightWidth, style.borderRightColor],
            [style.borderBottomWidth, style.borderBottomColor],
            [style.borderLeftWidth, style.borderLeftColor],
        ].some(([width = '', color = '']) => parseFloat(width) > 0 && seen(color))
    );
}

function hasOwnText(el: Element): boolean {
    for (const node of el.childNodes) {
        if (node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() !== '') return true;
    }
    return false;
}

function roundedBox(box: Rect, style: CSSStyleDeclaration): Rect {
    const width = box.right - box.left;
    const height = box.bottom - box.top;
    const length = (value: string, side: number) =>
        Math.min(side / 2, value.endsWith('%') ? (parseFloat(value) * side) / 100 : finite(parseFloat(value)));
    const corner = (value: string): Radii => {
        const [x = '0', y = x] = value.split(' ');
        return [length(x, width), length(y, height)];
    };
    return {
        top: box.top,
        right: box.right,
        bottom: box.bottom,
        left: box.left,
        radii: [
            corner(style.borderTopLeftRadius),
            corner(style.borderTopRightRadius),
            corner(style.borderBottomRightRadius),
            corner(style.borderBottomLeftRadius),
        ],
    };
}

export function paintedBoxes(el: Element, whole: boolean, depth = 4): Rect[] {
    const style = getComputedStyle(el);
    if (whole || depth === 0 || paintsItself(style) || hasOwnText(el)) {
        const visible = insetBox(el.getBoundingClientRect(), style.clipPath);
        return visible ? [roundedBox(visible, style)] : [];
    }
    return [...el.children].flatMap((child) => {
        if (!child.checkVisibility({ visibilityProperty: true })) return [];
        const box = child.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) return [];
        return paintedBoxes(child, false, depth - 1);
    });
}

export function paintsBefore(sibling: Element, branch: Element): boolean {
    if (getComputedStyle(sibling).position === 'static') return true;
    const z = zIndexOf(sibling);
    const branchZ = zIndexOf(branch);
    return z < branchZ || (z === branchZ && comesAfter(branch, sibling));
}

export function comesAfter(a: Node, b: Node): boolean {
    return (b.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}
