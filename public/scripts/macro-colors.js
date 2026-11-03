/**
 * @typedef {object} MacroColorOverride
 * @property {number} [hue]
 * @property {string} [color]
 * @typedef {object} MacroColors
 * @property {string} scheme
 * @property {number} seed
 * @property {number} chroma
 * @property {Record<string, MacroColorOverride>} overrides
 * @typedef {{ name: string, aliasOf?: string | null }} ListedMacro
 */

export const MACRO_COLOR_SCHEMES = Object.freeze(['spread', 'analogous', 'complementary', 'split', 'triadic']);

/** @type {MacroColors} */
export const DEFAULT_MACRO_COLORS = Object.freeze({ scheme: 'spread', seed: 250, chroma: 0.14, overrides: Object.freeze({}) });

export const MACRO_CATEGORY_ORDER = Object.freeze(['names', 'character', 'chat', 'time', 'random', 'variable', 'state', 'prompts', 'utility', 'misc', 'uncategorized']);

const GOLDEN = (Math.sqrt(5) - 1) / 2;
const ARC = 60;

/** @type {() => ListedMacro[]} */
let listMacros = () => [];
/** @type {MacroColors} */
let applied = DEFAULT_MACRO_COLORS;

/**
 * @param {() => ListedMacro[]} list
 */
export function setMacroList(list) {
    listMacros = list;
}

/**
 * @param {unknown} value
 * @returns {MacroColors}
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
 * @returns {number}
 */
function wrap(hue) {
    return ((hue % 360) + 360) % 360;
}

/**
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
 * @param {MacroColors} colors
 * @param {ListedMacro[]} [macros]
 * @returns {string}
 */
function macroColorsCss(colors, macros = listMacros()) {
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

export function refreshMacroColors() {
    if (refreshQueued || typeof document === 'undefined') return;
    refreshQueued = true;
    queueMicrotask(() => {
        refreshQueued = false;
        if (document.getElementById('macro-colors-style')) applyMacroColors(applied);
    });
}
