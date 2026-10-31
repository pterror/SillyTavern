import { holesIn, squared, uncoveredPieces, unionArea } from './geometry.ts';
import type { Rect } from './geometry.ts';

export type Target = {
    readonly el: Element;
    readonly box: Rect;
};

export type Policy = {
    readonly matches: (el: Element) => boolean;
    readonly coversBox?: boolean;
    readonly holes?: (holes: Rect[], target: Target) => Rect[];
    readonly hides?: (holes: readonly Rect[], target: Target) => boolean;
};

const width = (r: Rect) => r.right - r.left;
const height = (r: Rect) => r.bottom - r.top;

export function coversBox(matches: (el: Element) => boolean): Policy {
    return { matches, coversBox: true };
}

export function exempt(matches: (el: Element) => boolean): Policy {
    return { matches, holes: () => [] };
}

export function squareCorners(matches: (el: Element) => boolean): Policy {
    return { matches, holes: (holes) => squared(holes) };
}

export function hideWhenCovered(matches: (el: Element) => boolean): Policy {
    return {
        matches,
        hides: (holes, { box }) => holes.length > 0 && unionArea(holes) >= width(box) * height(box) - 0.5,
    };
}

export type SplitOptions = {
    readonly minSide?: number;
    readonly minArea?: number;
    readonly alsoCoveredBy?: () => readonly Element[];
};

export function hideWhenSplit(matches: (el: Element) => boolean, options: SplitOptions = {}): Policy {
    const { minSide = 4, minArea = 64, alsoCoveredBy = () => [] } = options;
    return {
        matches,
        hides: (holes, { box }) => {
            const also = holesIn(
                box,
                alsoCoveredBy().map((el) => el.getBoundingClientRect()),
            );
            return holes.some(
                (hole) => uncoveredPieces(width(box), height(box), [hole, ...also], minSide, minArea) > 1,
            );
        },
    };
}
