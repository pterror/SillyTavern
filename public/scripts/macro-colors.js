// The colors macros are drawn in (macro-pill.js), a theme setting (`macro_colors`): the lightness of the theme's text
// color, one chroma, and each macro its own hue, unless it is given one or a whole color. The hues are spread over the
// color scheme's arcs, turned to its starting hue, by golden-angle steps in the order the registry holds the macros:
// any number of macros get hues apart, and the first ({{user}}, {{char}}) the farthest apart.
// A leaf module: the registry gives it the macros (setMacroList()), so importing it never adds an import cycle.

/**
 * @typedef {object} MacroColorOverride A macro's own hue (0–360) or whole color (any CSS color).
 * @property {number} [hue]
 * @property {string} [color]
 *
 * @typedef {object} MacroColors
 * @property {string} scheme One of {@link MACRO_COLOR_SCHEMES}.
 * @property {number} seed The hue the scheme starts from.
 * @property {number} chroma oklch chroma of every macro's color.
 * @property {Record<string, MacroColorOverride>} overrides By macro name, lowercase.
 *
 * @typedef {{ name: string, aliasOf?: string | null }} ListedMacro A macro, or an alias with its macro's color.
 */

/** The color schemes the hues are spread by. */
export const MACRO_COLOR_SCHEMES = Object.freeze(['spread', 'analogous', 'complementary', 'split', 'triadic']);

/** @type {MacroColors} */
export const DEFAULT_MACRO_COLORS = Object.freeze({ scheme: 'spread', seed: 250, chroma: 0.14, overrides: Object.freeze({}) });

/** The registry's categories (macros/engine/MacroRegistry.js MacroCategory), in the order the editor lists them. */
export const MACRO_CATEGORY_ORDER = Object.freeze(['names', 'character', 'chat', 'time', 'random', 'variable', 'state', 'prompts', 'utility', 'misc', 'uncategorized']);

/** The golden ratio's fraction: each step lands in the largest gap the steps before it left. */
const GOLDEN = (Math.sqrt(5) - 1) / 2;
/** How wide each arc of the schemes with several is. */
const ARC = 60;

/** @type {() => ListedMacro[]} The registry's macros, in its order. */
let listMacros = () => [];
/** @type {MacroColors} The settings last applied. */
let applied = DEFAULT_MACRO_COLORS;

/**
 * Called by the macro registry as it loads: how its macros are listed, in its order.
 * @param {() => ListedMacro[]} list
 */
export function setMacroList(list) {
    listMacros = list;
}

/**
 * @param {unknown} value
 * @returns {MacroColors} Settings as stored, with anything missing or wrong the default.
 */
export function macroColorsOf(value) {
    const v = /** @type {Partial<MacroColors>} */ (value && typeof value === 'object' ? value : {});
    return {
        scheme: MACRO_COLOR_SCHEMES.includes(String(v.scheme)) ? String(v.scheme) : DEFAULT_MACRO_COLORS.scheme,
        seed: Number.isFinite(v.seed) ? Number(v.seed) : DEFAULT_MACRO_COLORS.seed,
        chroma: Number.isFinite(v.chroma) ? Number(v.chroma) : DEFAULT_MACRO_COLORS.chroma,
        overrides: v.overrides && typeof v.overrides === 'object' ? { ...v.overrides } : {},
    };
}

/**
 * @param {number} hue
 * @returns {number} In [0, 360).
 */
function wrap(hue) {
    return ((hue % 360) + 360) % 360;
}

/**
 * The hue at a place in a scheme: `at` in [0, 1) across its arcs.
 * @param {MacroColors} colors
 * @param {number} at
 * @returns {number}
 */
function schemeHue({ scheme, seed }, at) {
    /** @param {number[]} centers */
    const arcs = (centers) => {
        const span = at * centers.length;
        const arc = Math.floor(span);
        return seed + centers[arc] - ARC / 2 + ARC * (span - arc);
    };
    switch (scheme) {
        case 'analogous': return wrap(seed - 60 + 120 * at);
        case 'complementary': return wrap(arcs([0, 180]));
        case 'split': return wrap(arcs([0, 150, 210]));
        case 'triadic': return wrap(arcs([0, 120, 240]));
        default: return wrap(seed + 360 * at);
    }
}

/**
 * Each macro's hue, by its name lowercase: its own, else its place in the scheme. An alias has its macro's.
 * @param {MacroColors} colors
 * @param {ListedMacro[]} [macros]
 * @returns {Map<string, number>}
 */
export function macroHues(colors, macros = listMacros()) {
    /** @type {Map<string, number>} */
    const hues = new Map();
    let step = 0;
    for (const { name, aliasOf } of macros) {
        if (aliasOf) continue;
        const own = colors.overrides[name.toLowerCase()]?.hue;
        const place = (step++ * GOLDEN) % 1;
        hues.set(name.toLowerCase(), Number.isFinite(own) ? wrap(Number(own)) : schemeHue(colors, place));
    }
    for (const { name, aliasOf } of macros) {
        const hue = aliasOf ? hues.get(aliasOf.toLowerCase()) : undefined;
        if (hue !== undefined) hues.set(name.toLowerCase(), hue);
    }
    return hues;
}

/**
 * The stylesheet for the settings: the chroma, and each macro's hue or own color, by the name an element showing it
 * carries (data-macro-name, macro-pill.js); style.css makes the color from them.
 * @param {MacroColors} colors
 * @param {ListedMacro[]} [macros]
 * @returns {string}
 */
export function macroColorsCss(colors, macros = listMacros()) {
    const rules = [`:root { --macro-chroma: ${colors.chroma}; }`];
    for (const [name, hue] of macroHues(colors, macros)) {
        rules.push(`[data-macro-name="${CSS.escape(name)}" i] { --macro-hue: ${hue}; }`);
    }
    for (const [name, own] of Object.entries(colors.overrides)) {
        if (typeof own?.color === 'string' && CSS.supports('color', own.color)) {
            rules.push(`[data-macro-name="${CSS.escape(name)}" i] { --macro-color: ${own.color}; }`);
        }
    }
    return rules.join('\n');
}

/**
 * Puts the settings' stylesheet on the page, and keeps them for {@link refreshMacroColors}.
 * @param {MacroColors} colors
 */
export function applyMacroColors(colors) {
    applied = colors;
    let sheet = document.getElementById('macro-colors-style');
    if (!sheet) {
        sheet = document.createElement('style');
        sheet.id = 'macro-colors-style';
        document.head.append(sheet);
    }
    sheet.textContent = macroColorsCss(colors);
}

let refreshQueued = false;

/** The macros changed (one registered or removed): the stylesheet is made again, once, before the next frame. */
export function refreshMacroColors() {
    if (refreshQueued || typeof document === 'undefined') return;
    refreshQueued = true;
    queueMicrotask(() => {
        refreshQueued = false;
        if (document.getElementById('macro-colors-style')) applyMacroColors(applied);
    });
}
