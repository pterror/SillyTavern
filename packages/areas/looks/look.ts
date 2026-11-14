import { parse } from '@adobe/css-tools';
import { LOOK_STATES, MARK_STATES, MARK_STYLES } from '@st/protocol/looks';
import type {
    Declaration,
    FontFace,
    LookState,
    MarkLayer,
    MarkState,
    MarkStyle,
    PictureCrop,
    ResolvedLook,
    ResolvedMark,
} from '@st/protocol/looks';

// A thing's resolution reads its own look and at most two fields per shared look it uses: 1 + 2 × 3 = 7 reads, under
// the 10 a card's own reads take.
export const MAX_USES = 3;
export const DECLARATIONS_PER_LAYER_AT_MOST = 32;
export const VALUE_LENGTH_AT_MOST = 2048;
export const CSS_LENGTH_AT_MOST = 16_384;
export const NOTE_LENGTH_AT_MOST = 80;
export const SHARED_LOOK_NAME_AT_MOST = 100;

export const APP_FONTS: Readonly<Record<string, string>> = Object.freeze({
    'noto-sans': 'Noto Sans',
    'noto-sans-mono': 'Noto Sans Mono',
});
export const GENERIC_FAMILIES: ReadonlySet<string> = new Set([
    'serif',
    'sans-serif',
    'monospace',
    'cursive',
    'fantasy',
    'system-ui',
    'ui-serif',
    'ui-sans-serif',
    'ui-monospace',
    'ui-rounded',
]);
export const FONT_FORMATS: Readonly<Record<string, string>> = Object.freeze({
    woff2: 'woff2',
    woff: 'woff',
    ttf: 'truetype',
    otf: 'opentype',
});
// An uploaded font's id: the SHA-256 of its bytes, then its format's extension.
export const FONT_ID = /^[0-9a-f]{64}\.(woff2|woff|ttf|otf)$/;
export const APP_ANIMATIONS: readonly string[] = Object.freeze(['shimmer', 'breathe', 'flicker', 'drift', 'float']);
export const animationName = (name: string): string => `look-${name}`;
export const fontFamily = (id: string): string => APP_FONTS[id] ?? `look-font-${id.slice(0, 16)}`;
export const fontUrl = (id: string): string => `/fonts/${id}`;
// An image drawn as a thing's small picture: the SHA-256 of its bytes, then its format's extension.
export const IMAGE_ID = /^[0-9a-f]{64}\.(png|jpg|webp|gif)$/;
export const IMAGE_BYTES_AT_MOST = 4 * 1024 * 1024;
export const lookImageUrl = (id: string): string => `/look-images/${id}`;
// The smallest part of a picture a crop shows, so the small picture is never a smear of a few pixels.
export const CROP_SIDE_AT_LEAST = 0.05;

// `crop` and `image` say what the small picture shows: a part of the thing's own picture, or another image.
export type Picture = { before?: boolean; after?: boolean; crop?: PictureCrop; image?: string };

export function pictureCrop(raw: unknown): PictureCrop | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const { x: left, y: top, width: w, height: h } = raw as Record<string, unknown>;
    const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
    if (!finite(left) || !finite(top) || !finite(w) || !finite(h)) return null;
    if (w < CROP_SIDE_AT_LEAST || h < CROP_SIDE_AT_LEAST || left < 0 || top < 0) return null;
    if (left + w > 1 + 1e-9 || top + h > 1 + 1e-9) return null;
    const round = (n: number) => Math.round(n * 10_000) / 10_000;
    return { x: round(left), y: round(top), width: round(w), height: round(h) };
}

export type StoredLook = Partial<Record<LookState, Declaration[]>> & {
    picture?: Picture;
    note?: string;
    uses?: string[];
};

export type Refusal = { property: string; value: string; why: string };

// Besides the app's fonts: a world's own, or (`any`) every font id, for an import that brings its world's fonts later.
export type FontsAllowed = ReadonlySet<string> | 'any';

const CSS_WIDE = new Set(['inherit', 'initial', 'unset', 'revert', 'revert-layer']);
const COLOR_FUNCTIONS = [
    'rgb',
    'rgba',
    'hsl',
    'hsla',
    'hwb',
    'lab',
    'lch',
    'oklab',
    'oklch',
    'color',
    'color-mix',
    'light-dark',
    'var',
];
const MATH_FUNCTIONS = ['calc', 'min', 'max', 'clamp'];
const GRADIENT_FUNCTIONS = [
    'linear-gradient',
    'radial-gradient',
    'conic-gradient',
    'repeating-linear-gradient',
    'repeating-radial-gradient',
    'repeating-conic-gradient',
];
const TIMING_FUNCTIONS = ['cubic-bezier', 'steps', 'linear'];
const UNITS = new Set([
    'px',
    'em',
    'rem',
    'ex',
    'ch',
    'cap',
    'ic',
    'lh',
    'rlh',
    'pt',
    'vw',
    'vh',
    'vmin',
    'vmax',
    'deg',
    'rad',
    'grad',
    'turn',
    's',
    'ms',
    'fr',
]);

type Token =
    | { t: 'ident'; v: string }
    | { t: 'number'; n: number; unit: string }
    | { t: 'hash'; v: string }
    | { t: 'string'; v: string }
    | { t: 'url'; v: string }
    | { t: 'function'; v: string }
    | { t: 'close' }
    | { t: 'comma' }
    | { t: 'slash' }
    | { t: 'space' };

const IDENT = /^-{0,2}[a-zA-Z_][a-zA-Z0-9_-]*/;
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i;
const URL_UNQUOTED = /^[^\s"'()\\]*$/;

function tokens(value: string): Token[] | string {
    if (!/^[\x20-\x7e]*$/.test(value)) return 'only plain ASCII characters are allowed';
    const outsideStrings = value.replace(/"[^"]*"|'[^']*'/g, '""');
    if (/[\\;{}!@<>`]|\/\*/.test(outsideStrings) || /\\/.test(value))
        return 'escapes, comments, `;`, braces, `!`, `@` and `<>` are not allowed';
    const out: Token[] = [];
    let rest = value;
    while (rest.length > 0) {
        const space = /^ +/.exec(rest);
        if (space) {
            out.push({ t: 'space' });
            rest = rest.slice(space[0].length);
            continue;
        }
        const c = rest[0];
        if (c === ',' || c === '/' || c === ')') {
            out.push(c === ',' ? { t: 'comma' } : c === '/' ? { t: 'slash' } : { t: 'close' });
            rest = rest.slice(1);
            continue;
        }
        if (c === '"' || c === "'") {
            const end = rest.indexOf(c, 1);
            if (end === -1) return 'a string is not closed';
            out.push({ t: 'string', v: rest.slice(1, end) });
            rest = rest.slice(end + 1);
            continue;
        }
        if (c === '#') {
            const hex = /^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})(?![0-9a-zA-Z_-])/.exec(rest);
            if (!hex) return 'a `#` color has 3, 4, 6 or 8 hex digits';
            out.push({ t: 'hash', v: hex[0] });
            rest = rest.slice(hex[0].length);
            continue;
        }
        const number = NUMBER.exec(rest);
        if (number && !/^[+-]?[a-zA-Z_]/.test(rest)) {
            rest = rest.slice(number[0].length);
            let unit = '';
            if (rest.startsWith('%')) {
                unit = '%';
                rest = rest.slice(1);
            } else {
                const name = /^[a-zA-Z]+/.exec(rest);
                if (name) {
                    unit = name[0].toLowerCase();
                    if (!UNITS.has(unit)) return `the unit \`${name[0]}\` is not allowed`;
                    rest = rest.slice(name[0].length);
                }
            }
            out.push({ t: 'number', n: Number(number[0]), unit });
            continue;
        }
        const ident = IDENT.exec(rest);
        if (ident) {
            rest = rest.slice(ident[0].length);
            const name = ident[0].toLowerCase();
            if (!rest.startsWith('(')) {
                out.push({ t: 'ident', v: ident[0] });
                continue;
            }
            rest = rest.slice(1);
            if (name !== 'url') {
                out.push({ t: 'function', v: name });
                continue;
            }
            const quoted = /^ *(["'])/.exec(rest);
            let inside: string;
            if (quoted) {
                const quote = quoted[1] as string;
                const start = rest.indexOf(quote);
                const end = rest.indexOf(quote, start + 1);
                if (end === -1) return 'a string is not closed';
                inside = rest.slice(start + 1, end);
                rest = rest.slice(end + 1);
                const close = /^ *\)/.exec(rest);
                if (!close) return '`url(` is not closed';
                rest = rest.slice(close[0].length);
            } else {
                const end = rest.indexOf(')');
                if (end === -1) return '`url(` is not closed';
                inside = rest.slice(0, end).trim();
                if (!URL_UNQUOTED.test(inside)) return 'an unquoted `url(` holds a quote, a parenthesis or a space';
                rest = rest.slice(end + 1);
            }
            out.push({ t: 'url', v: inside });
            continue;
        }
        return `\`${c}\` is not allowed here`;
    }
    return out;
}

function urlRefusal(url: string): string | null {
    if (/["'()\\]/.test(url)) return 'a URL holds a quote, a parenthesis or a backslash';
    const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url);
    if (!scheme) return null;
    const name = (scheme[1] as string).toLowerCase();
    if (name === 'https' || name === 'http') return null;
    if (name === 'data' && /^data:image\//i.test(url)) return null;
    return `a URL may be http, https, a data: image or a path, not \`${name}:\``;
}

type Rule = {
    functions: readonly string[];
    // Outside functions; `any` for colors' names.
    keywords: readonly string[] | 'any';
    urls?: boolean;
    check?: (parts: Token[]) => string | null;
};

const COLOR: Rule = { functions: [...COLOR_FUNCTIONS, ...MATH_FUNCTIONS], keywords: 'any' };
const LENGTH = (keywords: readonly string[]): Rule => ({ functions: [...MATH_FUNCTIONS, 'var'], keywords });

const numbersOnly = (parts: Token[]) => parts.filter((p): p is Extract<Token, { t: 'number' }> => p.t === 'number');

const spacingCheck = (parts: Token[]): string | null => {
    for (const { n, unit } of numbersOnly(parts)) {
        const bound = unit === 'px' ? 16 : unit === 'em' || unit === 'rem' || unit === 'ch' ? 1 : null;
        if (bound === null && !(n === 0 && unit === '')) return 'a spacing is in px, em, rem or ch';
        if (bound !== null && (n < -bound / 4 || n > bound)) return `a spacing is between ${-bound / 4} and ${bound}`;
    }
    return null;
};

const SHADOW: Rule = { functions: [...COLOR_FUNCTIONS, ...MATH_FUNCTIONS], keywords: 'any' };

export const PROPERTIES: Readonly<Record<string, Rule>> = Object.freeze({
    color: COLOR,
    'background-color': COLOR,
    '-webkit-text-fill-color': COLOR,
    'background-image': {
        functions: [...GRADIENT_FUNCTIONS, ...COLOR_FUNCTIONS, ...MATH_FUNCTIONS],
        keywords: ['none'],
        urls: true,
    },
    'background-clip': { functions: [], keywords: ['text', 'border-box', 'padding-box', 'content-box'] },
    '-webkit-background-clip': { functions: [], keywords: ['text', 'border-box', 'padding-box', 'content-box'] },
    'background-size': LENGTH(['auto', 'cover', 'contain']),
    'background-position': LENGTH(['left', 'right', 'top', 'bottom', 'center']),
    'background-repeat': { functions: [], keywords: ['repeat', 'repeat-x', 'repeat-y', 'no-repeat', 'space', 'round'] },
    'text-shadow': SHADOW,
    filter: {
        functions: ['drop-shadow', 'blur', ...COLOR_FUNCTIONS, ...MATH_FUNCTIONS],
        keywords: 'any',
        check: (parts) =>
            parts.some((p) => p.t === 'ident' && p.v.toLowerCase() !== 'none') &&
            !parts.some((p) => p.t === 'function' && (p.v === 'drop-shadow' || p.v === 'blur'))
                ? 'a filter is drop-shadow() or blur()'
                : null,
    },
    '-webkit-text-stroke': { functions: [...COLOR_FUNCTIONS, ...MATH_FUNCTIONS], keywords: 'any' },
    '-webkit-text-stroke-width': LENGTH(['thin', 'medium', 'thick']),
    '-webkit-text-stroke-color': COLOR,
    'paint-order': { functions: [], keywords: ['normal', 'fill', 'stroke', 'markers'] },
    'text-decoration-line': { functions: [], keywords: ['none', 'underline', 'overline', 'line-through'] },
    'text-decoration-style': { functions: [], keywords: ['solid', 'double', 'wavy'] },
    'text-decoration-color': COLOR,
    'text-decoration-thickness': LENGTH(['auto', 'from-font']),
    'text-underline-offset': LENGTH(['auto']),
    'text-underline-position': { functions: [], keywords: ['auto', 'under', 'left', 'right', 'from-font'] },
    'letter-spacing': { ...LENGTH(['normal']), check: spacingCheck },
    'word-spacing': { ...LENGTH(['normal']), check: spacingCheck },
    'font-weight': {
        functions: [],
        keywords: ['normal', 'bold', 'bolder', 'lighter'],
        check: (parts) =>
            numbersOnly(parts).some(({ n, unit }) => unit !== '' || n < 1 || n > 1000)
                ? 'a weight is a number from 1 to 1000'
                : null,
    },
    'font-style': { functions: [], keywords: ['normal', 'italic', 'oblique'] },
    'font-variant-caps': {
        functions: [],
        keywords: [
            'normal',
            'small-caps',
            'all-small-caps',
            'petite-caps',
            'all-petite-caps',
            'unicase',
            'titling-caps',
        ],
    },
    'font-family': { functions: [], keywords: 'any' },
    opacity: {
        functions: [],
        keywords: [],
        check: (parts) =>
            numbersOnly(parts).some(
                ({ n, unit }) => !(unit === '' ? n >= 0 && n <= 1 : unit === '%' && n >= 0 && n <= 100),
            )
                ? 'an opacity is from 0 to 1'
                : null,
    },
    'animation-name': { functions: [], keywords: ['none', ...APP_ANIMATIONS] },
    'animation-duration': LENGTH([]),
    'animation-delay': LENGTH([]),
    'animation-timing-function': {
        functions: TIMING_FUNCTIONS,
        keywords: [
            'ease',
            'ease-in',
            'ease-out',
            'ease-in-out',
            'linear',
            'step-start',
            'step-end',
            'jump-start',
            'jump-end',
            'jump-none',
            'jump-both',
            'start',
            'end',
        ],
    },
    'animation-iteration-count': { functions: [], keywords: ['infinite'] },
    'animation-direction': { functions: [], keywords: ['normal', 'reverse', 'alternate', 'alternate-reverse'] },
    'animation-fill-mode': { functions: [], keywords: ['none', 'forwards', 'backwards', 'both'] },
    'animation-play-state': { functions: [], keywords: ['running', 'paused'] },
});

function fontFamilyRefusal(parts: Token[], fonts: FontsAllowed): string | null {
    const items: Token[][] = [[]];
    for (const p of parts) {
        if (p.t === 'comma') items.push([]);
        else if (p.t !== 'space') items[items.length - 1]?.push(p);
    }
    if (items.length > 4) return 'a typeface names at most one font and its fallbacks';
    let named = 0;
    for (const item of items) {
        const [only] = item;
        if (item.length !== 1 || !only) return 'each typeface is one font id';
        if (only.t === 'ident' && (GENERIC_FAMILIES.has(only.v) || CSS_WIDE.has(only.v))) continue;
        const id = only.t === 'ident' || only.t === 'string' ? only.v : null;
        if (id === null) return 'each typeface is one font id';
        named++;
        if (Object.hasOwn(APP_FONTS, id)) continue;
        if (!FONT_ID.test(id)) return `\`${id}\` is no font of the app's or of this world's`;
        if (fonts !== 'any' && !fonts.has(id)) return `\`${id}\` is no font of the app's or of this world's`;
        if (only.t !== 'string') return 'an uploaded font is named in quotes';
    }
    return named > 1 ? 'a look names one font' : null;
}

export function sanitizeDeclaration(property: string, value: string, fonts: FontsAllowed): Declaration | Refusal {
    const refuse = (why: string): Refusal => ({ property, value, why });
    const name = property.trim().toLowerCase();
    if (!/^-?[a-z]+(-[a-z]+)*$/.test(name) || !Object.hasOwn(PROPERTIES, name))
        return refuse('This property can’t be set.');
    const rule = PROPERTIES[name] as Rule;
    const written = value.trim().replace(/\s+/g, ' ');
    if (written === '') return refuse('The value is empty.');
    if (written.length > VALUE_LENGTH_AT_MOST)
        return refuse(`Values are limited to ${VALUE_LENGTH_AT_MOST} characters.`);
    const parts = tokens(written);
    if (typeof parts === 'string') return refuse(parts);
    let depth = 0;
    const allowed = new Set(rule.functions);
    for (const p of parts) {
        if (p.t === 'function') {
            if (!allowed.has(p.v)) return refuse(`\`${p.v}()\` is not allowed here`);
            depth++;
        } else if (p.t === 'close') {
            if (depth === 0) return refuse('Unmatched `)`.');
            depth--;
        } else if (p.t === 'url') {
            if (rule.urls !== true) return refuse('`url()` is not allowed here');
            const why = urlRefusal(p.v);
            if (why !== null) return refuse(why);
        } else if (p.t === 'string') {
            if (name !== 'font-family') return refuse('Strings aren’t allowed here.');
        } else if (p.t === 'ident' && depth === 0) {
            const word = p.v.toLowerCase();
            if (rule.keywords !== 'any' && !rule.keywords.includes(word) && !CSS_WIDE.has(word))
                return refuse(`\`${p.v}\` is not allowed here`);
        }
    }
    if (depth !== 0) return refuse('Unclosed `(`.');
    const why = name === 'font-family' ? fontFamilyRefusal(parts, fonts) : (rule.check?.(parts) ?? null);
    if (why !== null) return refuse(why);
    return { property: name, value: written };
}

export const isRefusal = (d: Declaration | Refusal): d is Refusal => 'why' in d;

// Anything but declarations refuses the whole text.
export function declarationsOfCss(css: string): { property: string; value: string }[] | { refused: string } {
    if (css.length > CSS_LENGTH_AT_MOST) return { refused: `CSS is limited to ${CSS_LENGTH_AT_MOST} characters.` };
    if (/[{}]/.test(css)) return { refused: 'Declarations only: no selectors, braces or at-rules.' };
    const sheet = parse(`x{${css}}`, { silent: true }).stylesheet;
    const [rule, ...others] = sheet.rules;
    if ((sheet.parsingErrors ?? []).length > 0 || others.length > 0 || rule === undefined || rule.type !== 'rule')
        return { refused: 'Declarations only: no selectors, braces or at-rules.' };
    const found: { property: string; value: string }[] = [];
    for (const d of rule.declarations) {
        if (d.type !== 'declaration') continue;
        found.push({ property: d.property, value: d.value });
    }
    return found;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

// A value of another shape is no look.
export function storedLook(raw: unknown, fonts: FontsAllowed): { look: StoredLook | null; refused: Refusal[] } {
    if (!isPlainObject(raw)) return { look: null, refused: [] };
    const look: StoredLook = {};
    const refused: Refusal[] = [];
    for (const state of LOOK_STATES) {
        const layer = raw[state];
        if (layer === undefined) continue;
        if (!Array.isArray(layer)) return { look: null, refused: [] };
        const kept = new Map<string, Declaration>();
        for (const d of layer) {
            if (!isPlainObject(d) || typeof d['property'] !== 'string' || typeof d['value'] !== 'string')
                return { look: null, refused: [] };
            const checked = sanitizeDeclaration(d['property'], d['value'], fonts);
            if (isRefusal(checked)) refused.push(checked);
            else {
                kept.delete(checked.property);
                kept.set(checked.property, checked);
            }
        }
        const declarations = [...kept.values()].slice(-DECLARATIONS_PER_LAYER_AT_MOST);
        if (declarations.length > 0) look[state] = declarations;
    }
    const picture = raw['picture'];
    if (isPlainObject(picture)) {
        const kept: Picture = {};
        if (typeof picture['before'] === 'boolean') kept.before = picture['before'];
        if (typeof picture['after'] === 'boolean') kept.after = picture['after'];
        const crop = pictureCrop(picture['crop']);
        if (crop) kept.crop = crop;
        if (typeof picture['image'] === 'string' && IMAGE_ID.test(picture['image'])) kept.image = picture['image'];
        if (Object.keys(kept).length > 0) look.picture = kept;
    }
    if (typeof raw['note'] === 'string') look.note = raw['note'].slice(0, NOTE_LENGTH_AT_MOST);
    const uses = raw['uses'];
    if (Array.isArray(uses)) {
        const ids = [...new Set(uses.filter((u): u is string => typeof u === 'string' && SHARED_LOOK_ID.test(u)))];
        if (ids.length > 0) look.uses = ids.slice(0, MAX_USES);
    }
    return { look, refused };
}

export const SHARED_LOOK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const isEmptyLook = (look: StoredLook): boolean => Object.keys(look).length === 0;

function drawn(d: Declaration, fonts: Map<string, FontFace>): Declaration {
    if (d.property === 'animation-name') {
        const names = d.value.split(',').map((n) => n.trim());
        return { ...d, value: names.map((n) => (APP_ANIMATIONS.includes(n) ? animationName(n) : n)).join(', ') };
    }
    if (d.property !== 'font-family') return d;
    const items = d.value.split(',').map((item) => {
        const id = item.trim().replace(/^["']|["']$/g, '');
        if (Object.hasOwn(APP_FONTS, id)) return `"${APP_FONTS[id]}"`;
        if (!FONT_ID.test(id)) return item.trim();
        const format = FONT_FORMATS[id.slice(id.lastIndexOf('.') + 1)] as string;
        fonts.set(id, { family: fontFamily(id), url: fontUrl(id), format });
        return `"${fontFamily(id)}"`;
    });
    return { ...d, value: items.join(', ') };
}

// Theme first, the thing itself last.
export function resolveLevels(levels: StoredLook[]): ResolvedLook {
    const fonts = new Map<string, FontFace>();
    const layers: ResolvedLook['layers'] = {};
    for (const state of LOOK_STATES) {
        const merged = new Map<string, Declaration>();
        for (const level of levels) {
            for (const d of level[state] ?? []) {
                merged.delete(d.property);
                merged.set(d.property, d);
            }
        }
        if (merged.size > 0) layers[state] = [...merged.values()].map((d) => drawn(d, fonts));
    }
    const picture: ResolvedLook['picture'] = { before: false, after: false, crop: null, image: null };
    let note: string | null = null;
    for (const level of levels) {
        if (level.picture?.before !== undefined) picture.before = level.picture.before;
        if (level.picture?.after !== undefined) picture.after = level.picture.after;
        if (level.picture?.crop !== undefined) picture.crop = level.picture.crop;
        if (level.picture?.image !== undefined) picture.image = lookImageUrl(level.picture.image);
        if (level.note !== undefined) note = level.note === '' ? null : level.note;
    }
    return { layers, picture, note, fonts: [...fonts.values()] };
}

export const isNoLook = (look: ResolvedLook): boolean =>
    Object.keys(look.layers).length === 0 && !look.picture.before && !look.picture.after && look.note === null;

export type StoredMark = Partial<Record<MarkState, Partial<MarkLayer>>>;

export const MARK_AT_REST: MarkLayer = Object.freeze({ style: 'dotted', color: 'currentColor', opacity: 1 });

export const isMarkStyle = (value: unknown): value is MarkStyle =>
    typeof value === 'string' && (MARK_STYLES as readonly string[]).includes(value);

// The color as stored, or why it isn't one.
export const markColor = (color: string): { color: string } | { refused: string } => {
    const checked = sanitizeDeclaration('text-decoration-color', color, new Set());
    return isRefusal(checked) ? { refused: checked.why } : { color: checked.value };
};

export const isMarkOpacity = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

// What isn't a mark's setting is left out.
export function storedMark(raw: unknown): StoredMark {
    if (!isPlainObject(raw)) return {};
    const mark: StoredMark = {};
    for (const state of MARK_STATES) {
        const layer = raw[state];
        if (!isPlainObject(layer)) continue;
        const kept: Partial<MarkLayer> = {};
        if (isMarkStyle(layer['style'])) kept.style = layer['style'];
        const color = layer['color'];
        const checked = typeof color === 'string' ? markColor(color) : null;
        if (checked && 'color' in checked) kept.color = checked.color;
        if (isMarkOpacity(layer['opacity'])) kept.opacity = layer['opacity'];
        if (Object.keys(kept).length > 0) mark[state] = kept;
    }
    return mark;
}

// The state each state's settings go over; MARK_STATES lists every state after the one it goes over.
const MARK_OVER: Record<MarkState, MarkState | null> = {
    rest: null,
    earlierReply: 'rest',
    messagePointed: 'rest',
    wordPointed: 'messagePointed',
};

// Each state is its own settings over the state it goes over.
export function resolveMark(mark: StoredMark): ResolvedMark {
    const out = {} as ResolvedMark;
    for (const state of MARK_STATES) {
        const over = MARK_OVER[state];
        out[state] = { ...(over === null ? MARK_AT_REST : out[over]), ...mark[state] };
    }
    return out;
}
