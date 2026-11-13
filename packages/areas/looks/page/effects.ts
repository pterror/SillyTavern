import type { Declaration } from '@st/protocol/looks';

// A state's declarations as it shows them, property to value.
export type Layer = ReadonlyMap<string, string>;

export type ColorControls = { mode: 'solid'; color: string } | { mode: 'gradient'; angle: number; stops: string[] };
export type GlowControls = { color: string; size: number };
export type OutlineControls = { color: string; width: number };
export type ShadowControls = { color: string; distance: number; softness: number };
export type UnderlineControls = { style: 'solid' | 'double' | 'wavy'; color: string; thickness: number };
export type LettersControls = { spacing: number; weight: number; italic: boolean; caps: boolean };
// `font`: an app font's id, or an uploaded font's id (`uploaded`).
export type TypefaceControls = { font: string; uploaded: boolean };
export type BlurControls = { amount: number };
export const MOTIONS = ['shimmer', 'breathe', 'flicker', 'drift', 'float'] as const;
export type Motion = (typeof MOTIONS)[number];
export type MotionControls = { motion: Motion; seconds: number };

export type Controls = {
    color: ColorControls;
    glow: GlowControls;
    outline: OutlineControls;
    shadow: ShadowControls;
    underline: UnderlineControls;
    letters: LettersControls;
    typeface: TypefaceControls;
    blur: BlurControls;
    motion: MotionControls;
};

export type EffectId = keyof Controls;

export const EFFECTS: readonly EffectId[] = [
    'color',
    'glow',
    'outline',
    'shadow',
    'underline',
    'letters',
    'typeface',
    'blur',
    'motion',
];

// Sets nothing of its own over the levels below: what a level writes for a property its effect no longer uses.
export const NEUTRAL = 'unset';
const NEUTRAL_WORDS = new Set(['unset', 'initial', 'inherit', 'revert', 'revert-layer']);
const isSet = (value: string | undefined): value is string =>
    value !== undefined && !NEUTRAL_WORDS.has(value.trim().toLowerCase());

const numberOf = (text: string | undefined, unit: string): number | null => {
    if (text === undefined) return null;
    const found = new RegExp(`^(-?\\d*\\.?\\d+)(${unit})?$`).exec(text.trim());
    return found ? Number(found[1]) : null;
};
const round = (n: number, places = 2) => Math.round(n * 10 ** places) / 10 ** places;

export function splitTop(text: string, at: ',' | ' '): string[] {
    const out: string[] = [];
    let depth = 0;
    let part = '';
    for (const c of text) {
        if (c === '(') depth++;
        if (c === ')') depth--;
        if (c === at && depth === 0) {
            if (part.trim() !== '') out.push(part.trim());
            part = '';
        } else part += c;
    }
    if (part.trim() !== '') out.push(part.trim());
    return out;
}

// Glow, shadow and blur share the one `filter` property: each is a part of it.
type FilterParts = { blur?: BlurControls; glow?: GlowControls; shadow?: ShadowControls };

const isLength = (part: string) => /^-?\d*\.?\d+(px)?$/.test(part);

export function filterParts(value: string | undefined): FilterParts {
    const parts: FilterParts = {};
    if (!isSet(value)) return parts;
    for (const found of value.matchAll(/(drop-shadow|blur)\(((?:[^()]|\([^()]*\))*)\)/g)) {
        const [, name, inside = ''] = found;
        if (name === 'blur') {
            const amount = numberOf(inside, 'px');
            if (amount !== null) parts.blur = { amount };
            continue;
        }
        const words = splitTop(inside, ' ');
        const lengths = words.filter(isLength).map((w) => numberOf(w, 'px') ?? 0);
        const color = words.find((w) => !isLength(w)) ?? 'currentColor';
        const [x = 0, y = 0, soft = 0] = lengths;
        if (x === 0 && y === 0 && parts.glow === undefined) parts.glow = { color, size: soft };
        else if (parts.shadow === undefined) parts.shadow = { color, distance: Math.max(x, y), softness: soft };
    }
    return parts;
}

function filterValue(parts: FilterParts): string | null {
    const out: string[] = [];
    if (parts.blur) out.push(`blur(${parts.blur.amount}px)`);
    if (parts.glow) out.push(`drop-shadow(0 0 ${parts.glow.size}px ${parts.glow.color})`);
    if (parts.shadow) {
        const { distance: d, softness, color } = parts.shadow;
        out.push(`drop-shadow(${d}px ${d}px ${softness}px ${color})`);
    }
    return out.length === 0 ? null : out.join(' ');
}

const GRADIENT = /^linear-gradient\(\s*(-?\d*\.?\d+)deg\s*,(.*)\)$/s;

type Effect<C> = {
    properties: readonly string[];
    read: (layer: Layer) => C | null;
    // `layer`: what the state shows, so an effect sharing a property with others keeps theirs.
    declare: (controls: C, layer: Layer) => Declaration[];
    // What the effect is turned on with where nothing shows it yet.
    start: C;
};

const d = (property: string, value: string): Declaration => ({ property, value });

const filterEffect = <K extends keyof FilterParts>(
    key: K,
    start: NonNullable<FilterParts[K]>,
): Effect<NonNullable<FilterParts[K]>> => ({
    properties: ['filter'],
    read: (layer) => filterParts(layer.get('filter'))[key] ?? null,
    declare: (controls, layer) => {
        const value = filterValue({ ...filterParts(layer.get('filter')), [key]: controls });
        return value === null ? [] : [d('filter', value)];
    },
    start,
});

const TIMING: Record<Motion, string> = {
    shimmer: 'linear',
    drift: 'linear',
    breathe: 'ease-in-out',
    float: 'ease-in-out',
    flicker: 'steps(1, end)',
};

export const effects: { [K in EffectId]: Effect<Controls[K]> } = {
    color: {
        properties: [
            'color',
            'background-image',
            'background-clip',
            '-webkit-background-clip',
            '-webkit-text-fill-color',
        ],
        read: (layer) => {
            const image = layer.get('background-image');
            const gradient = isSet(image) ? GRADIENT.exec(image.trim()) : null;
            if (gradient && layer.get('background-clip') === 'text') {
                const stops = splitTop(gradient[2] ?? '', ',');
                if (stops.length >= 2) return { mode: 'gradient', angle: Number(gradient[1]), stops };
            }
            const color = layer.get('color');
            return isSet(color) ? { mode: 'solid', color } : null;
        },
        declare: (controls) =>
            controls.mode === 'solid'
                ? [d('color', controls.color)]
                : [
                      d('color', controls.stops[0] ?? 'currentColor'),
                      d('background-image', `linear-gradient(${controls.angle}deg, ${controls.stops.join(', ')})`),
                      d('background-clip', 'text'),
                      d('-webkit-background-clip', 'text'),
                      d('-webkit-text-fill-color', 'transparent'),
                  ],
        start: { mode: 'solid', color: '#f6cf86' },
    },
    glow: filterEffect('glow', { color: '#f0965a', size: 6 }),
    outline: {
        properties: ['-webkit-text-stroke', '-webkit-text-stroke-width', '-webkit-text-stroke-color', 'paint-order'],
        read: (layer) => {
            const stroke = layer.get('-webkit-text-stroke');
            const short = splitTop(isSet(stroke) ? stroke : '', ' ');
            const width =
                numberOf(layer.get('-webkit-text-stroke-width'), 'px') ?? numberOf(short.find(isLength), 'px');
            const color = layer.get('-webkit-text-stroke-color') ?? short.find((w) => !isLength(w));
            if (width === null || width === 0) return null;
            return { width, color: isSet(color) ? color : 'currentColor' };
        },
        declare: (controls) => [
            d('-webkit-text-stroke-width', `${controls.width}px`),
            d('-webkit-text-stroke-color', controls.color),
            d('paint-order', 'stroke fill'),
        ],
        start: { color: '#2a1208', width: 1 },
    },
    shadow: filterEffect('shadow', { color: '#000000', distance: 2, softness: 2 }),
    underline: {
        properties: [
            'text-decoration-line',
            'text-decoration-style',
            'text-decoration-color',
            'text-decoration-thickness',
            'text-underline-offset',
        ],
        read: (layer) => {
            if (!(layer.get('text-decoration-line') ?? '').split(' ').includes('underline')) return null;
            const style = layer.get('text-decoration-style');
            const color = layer.get('text-decoration-color');
            return {
                style: style === 'double' || style === 'wavy' ? style : 'solid',
                color: isSet(color) ? color : 'currentColor',
                thickness: numberOf(layer.get('text-decoration-thickness'), 'px') ?? 1,
            };
        },
        declare: (controls) => [
            d('text-decoration-line', 'underline'),
            d('text-decoration-style', controls.style),
            d('text-decoration-color', controls.color),
            d('text-decoration-thickness', `${controls.thickness}px`),
            d('text-underline-offset', controls.style === 'wavy' ? '4px' : '3px'),
        ],
        start: { style: 'wavy', color: '#ec8f6f', thickness: 1.5 },
    },
    letters: {
        properties: ['letter-spacing', 'font-weight', 'font-style', 'font-variant-caps'],
        read: (layer) => {
            const spacing = layer.get('letter-spacing');
            const weight = layer.get('font-weight');
            const style = layer.get('font-style');
            const caps = layer.get('font-variant-caps');
            if (![spacing, weight, style, caps].some(isSet)) return null;
            const weights: Record<string, number> = { normal: 400, bold: 700, bolder: 700, lighter: 300 };
            return {
                spacing: numberOf(spacing, 'em') ?? 0,
                weight: (isSet(weight) ? (weights[weight] ?? numberOf(weight, '')) : null) ?? 400,
                italic: style === 'italic' || style === 'oblique',
                caps: isSet(caps) && caps !== 'normal',
            };
        },
        declare: (controls) => [
            d('letter-spacing', `${round(controls.spacing)}em`),
            d('font-weight', String(controls.weight)),
            d('font-style', controls.italic ? 'italic' : 'normal'),
            d('font-variant-caps', controls.caps ? 'small-caps' : 'normal'),
        ],
        start: { spacing: 0.06, weight: 600, italic: false, caps: false },
    },
    typeface: {
        properties: ['font-family'],
        read: (layer) => {
            const family = layer.get('font-family');
            if (!isSet(family)) return null;
            const [first = ''] = splitTop(family, ',');
            const quoted = /^["'](.*)["']$/.exec(first);
            return { font: quoted ? (quoted[1] ?? '') : first, uploaded: quoted !== null };
        },
        declare: (controls) => [d('font-family', controls.uploaded ? `"${controls.font}", sans-serif` : controls.font)],
        start: { font: 'noto-sans', uploaded: false },
    },
    blur: filterEffect('blur', { amount: 0.6 }),
    motion: {
        properties: ['animation-name', 'animation-duration', 'animation-timing-function', 'animation-iteration-count'],
        read: (layer) => {
            const name = layer.get('animation-name');
            const motion = MOTIONS.find((m) => m === name);
            if (motion === undefined) return null;
            const duration = layer.get('animation-duration') ?? '';
            const seconds = numberOf(duration, 's') ?? (numberOf(duration, 'ms') ?? 4000) / 1000;
            return { motion, seconds };
        },
        declare: (controls) => [
            d('animation-name', controls.motion),
            d('animation-duration', `${round(controls.seconds, 1)}s`),
            d('animation-timing-function', TIMING[controls.motion]),
            d('animation-iteration-count', 'infinite'),
        ],
        start: { motion: 'shimmer', seconds: 4 },
    },
};

export const CONTROLLED: ReadonlySet<string> = new Set(EFFECTS.flatMap((id) => effects[id].properties));

export const readEffect = <K extends EffectId>(id: K, layer: Layer): Controls[K] | null => effects[id].read(layer);

export const declareEffect = <K extends EffectId>(id: K, controls: Controls[K], layer: Layer): Declaration[] =>
    effects[id].declare(controls, layer);

// What a level writes when the effect's controls become `next`: `set`, the declarations that change; `cleared`, the
// properties the effect wrote and no longer writes.
export function changeOf<K extends EffectId>(
    id: K,
    layer: Layer,
    next: Controls[K],
): { set: Declaration[]; cleared: string[] } {
    const effect = effects[id];
    const now = effect.read(layer);
    const before = new Set((now === null ? [] : effect.declare(now, layer)).map((x) => x.property));
    const after = effect.declare(next, layer);
    const writes = new Set(after.map((x) => x.property));
    return {
        set: after.filter((x) => layer.get(x.property) !== x.value),
        cleared: [...before].filter((property) => !writes.has(property)),
    };
}

// What Reset leaves: the effect's own properties off the level, but a property it shares keeps the other effects' part.
export function withoutEffect(id: EffectId, layer: Layer): { set: Declaration[]; reset: string[] } {
    if (id === 'glow' || id === 'shadow' || id === 'blur') {
        const parts = filterParts(layer.get('filter'));
        delete parts[id];
        const value = filterValue(parts);
        return value === null ? { set: [], reset: ['filter'] } : { set: [d('filter', value)], reset: [] };
    }
    return { set: [], reset: [...effects[id].properties] };
}

export const cssText = (declarations: readonly Declaration[]): string =>
    declarations.map(({ property, value }) => `${property}: ${value};`).join('\n');

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

// A color as an <input type=color> takes it; `resolve` turns a named color into one it can read.
export function hexOf(value: string, resolve: (color: string) => string | null = () => null): string | null {
    const text = value.trim();
    if (HEX.test(text)) {
        const digits = text.slice(1);
        return `#${(digits.length === 3 ? digits.replace(/./g, '$&$&') : digits).toLowerCase()}`;
    }
    const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(text);
    if (rgb !== null)
        return `#${rgb
            .slice(1, 4)
            .map((n) => Number(n).toString(16).padStart(2, '0'))
            .join('')}`;
    const resolved = resolve(text);
    return resolved === null || resolved === text ? null : hexOf(resolved);
}

// The declarations as the page draws them: an app motion and an app font by the names the look sheet gives them.
export function drawnDeclarations(declarations: readonly Declaration[], families: ReadonlyMap<string, string>) {
    return declarations.map(({ property, value }) => {
        if (property === 'animation-name')
            return d(property, MOTIONS.some((m) => m === value) ? `look-${value}` : value);
        if (property !== 'font-family') return d(property, value);
        const items = splitTop(value, ',').map((item) => {
            const id = item.replace(/^["']|["']$/g, '');
            const family = families.get(id);
            return family === undefined ? item : `"${family}"`;
        });
        return d(property, items.join(', '));
    });
}

export const styleText = (declarations: readonly Declaration[]): string =>
    declarations.map(({ property, value }) => `${property}: ${value}`).join('; ');
