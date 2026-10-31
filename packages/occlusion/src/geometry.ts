export const finite = (n: number): number => (Number.isFinite(n) ? n : 0);

export type Radii = readonly [number, number];

export type Rect = {
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
    readonly left: number;
    readonly radii?: readonly [Radii, Radii, Radii, Radii];
};

const ARC_STEPS = 8;

type Mutable = { top: number; right: number; bottom: number; left: number };

export function disjointRects(rects: readonly Rect[]): Rect[] {
    const ys = [...new Set(rects.flatMap((r) => [r.top, r.bottom]))].sort((a, b) => a - b);
    const out: Mutable[] = [];
    for (let i = 0; i + 1 < ys.length; i++) {
        const top = ys[i] as number;
        const bottom = ys[i + 1] as number;
        const spans = rects
            .filter((r) => r.top <= top && r.bottom >= bottom)
            .map((r) => [r.left, r.right] as const)
            .sort((a, b) => a[0] - b[0]);
        for (const [left, right] of spans) {
            const last = out.at(-1);
            if (last && last.top === top && last.bottom === bottom && left <= last.right) {
                last.right = Math.max(last.right, right);
            } else {
                out.push({ top, right, bottom, left });
            }
        }
    }
    return out;
}

export function unionArea(rects: readonly Rect[]): number {
    return disjointRects(rects).reduce((sum, r) => sum + (r.right - r.left) * (r.bottom - r.top), 0);
}

function roundedCorners(rects: readonly Rect[]): (readonly [number, number])[][] {
    const out: (readonly [number, number])[][] = [];
    for (const r of rects) {
        if (!r.radii) continue;
        const corners = [
            [r.left, r.top, 1, 1],
            [r.right, r.top, -1, 1],
            [r.right, r.bottom, -1, -1],
            [r.left, r.bottom, 1, -1],
        ] as const;
        for (const [i, [x, y, dx, dy]] of corners.entries()) {
            const [rx, ry] = r.radii[i] as Radii;
            if (!(rx > 0 && ry > 0)) continue;
            const square = {
                left: Math.min(x, x + dx * rx),
                right: Math.max(x, x + dx * rx),
                top: Math.min(y, y + dy * ry),
                bottom: Math.max(y, y + dy * ry),
            };
            const touches = rects.some(
                (o) =>
                    o !== r &&
                    o.left < square.right &&
                    o.right > square.left &&
                    o.top < square.bottom &&
                    o.bottom > square.top,
            );
            if (touches) continue;
            const points: (readonly [number, number])[] = [[x, y]];
            for (let step = 0; step <= ARC_STEPS; step++) {
                const angle = ((step / ARC_STEPS) * Math.PI) / 2;
                points.push([x + dx * rx * (1 - Math.cos(angle)), y + dy * ry * (1 - Math.sin(angle))]);
            }
            out.push(points);
        }
    }
    return out;
}

export function clipPathFor(holes: readonly Rect[]): string {
    if (holes.length === 0) return '';
    const cut = [
        ...disjointRects(holes).map((r) => [
            [r.left, r.top] as const,
            [r.right, r.top] as const,
            [r.right, r.bottom] as const,
            [r.left, r.bottom] as const,
        ]),
        ...roundedCorners(holes),
    ]
        .map(
            (points) =>
                `${[...points, points[0] as readonly [number, number]].map(([x, y]) => `${x}px ${y}px`).join(', ')}, 0 0`,
        )
        .join(', ');
    return `polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${cut})`;
}

export function holesIn(box: Rect, covers: readonly Rect[]): Rect[] {
    const out: Rect[] = [];
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
        const inside = [
            c.top >= box.top && c.left >= box.left,
            c.top >= box.top && c.right <= box.right,
            c.bottom <= box.bottom && c.right <= box.right,
            c.bottom <= box.bottom && c.left >= box.left,
        ];
        const square: Radii = [0, 0];
        const radii = c.radii.map((corner, i) => (inside[i] === true ? corner : square)) as unknown as [
            Radii,
            Radii,
            Radii,
            Radii,
        ];
        out.push({ top, right, bottom, left, radii });
    }
    return out;
}

export function squared(rects: readonly Rect[]): Rect[] {
    return rects.map(({ top, right, bottom, left }) => ({ top, right, bottom, left }));
}

export function uncoveredPieces(
    width: number,
    height: number,
    rects: readonly Rect[],
    minSide = 4,
    minArea = 64,
): number {
    const edges = (values: number[], size: number) =>
        [...new Set([0, size, ...values.map((v) => Math.min(size, Math.max(0, v)))])].sort((a, b) => a - b);
    const xs = edges(
        rects.flatMap((r) => [r.left, r.right]),
        width,
    );
    const ys = edges(
        rects.flatMap((r) => [r.top, r.bottom]),
        height,
    );
    const nx = xs.length - 1;
    const ny = ys.length - 1;
    const at = (list: number[], i: number) => list[i] as number;
    const open = (i: number, j: number) => {
        if (at(xs, i + 1) - at(xs, i) < minSide || at(ys, j + 1) - at(ys, j) < minSide) return false;
        const x = (at(xs, i) + at(xs, i + 1)) / 2;
        const y = (at(ys, j) + at(ys, j + 1)) / 2;
        return !rects.some((r) => x > r.left && x < r.right && y > r.top && y < r.bottom);
    };
    const seen = new Set<number>();
    let pieces = 0;
    for (let i = 0; i < nx; i++) {
        for (let j = 0; j < ny; j++) {
            if (seen.has(i * ny + j) || !open(i, j)) continue;
            let area = 0;
            const queue: [number, number][] = [[i, j]];
            seen.add(i * ny + j);
            for (let next = queue.pop(); next; next = queue.pop()) {
                const [ci, cj] = next;
                area += (at(xs, ci + 1) - at(xs, ci)) * (at(ys, cj + 1) - at(ys, cj));
                for (const [di, dj] of [
                    [1, 0],
                    [-1, 0],
                    [0, 1],
                    [0, -1],
                ] as const) {
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

export function insetBox(box: Rect, clipPath: string): Rect | null {
    const match = /^inset\(([^)]*)\)/.exec(clipPath);
    if (!match) return box;
    const values = (match[1] ?? '')
        .replace(/\s+round\s.*$/, '')
        .trim()
        .split(/\s+/);
    const [top = '0', right = top, bottom = top, left = right] = values;
    const width = box.right - box.left;
    const height = box.bottom - box.top;
    const resolve = (value: string, basis: number) =>
        value.endsWith('%') ? (parseFloat(value) / 100) * basis : finite(parseFloat(value));
    const out = {
        top: box.top + resolve(top, height),
        right: box.right - resolve(right, width),
        bottom: box.bottom - resolve(bottom, height),
        left: box.left + resolve(left, width),
    };
    return out.right > out.left && out.bottom > out.top ? out : null;
}
