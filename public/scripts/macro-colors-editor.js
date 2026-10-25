// The macro colors editor (the theme's `macro_colors`, macro-colors.js): the color scheme, its starting hue and the
// chroma for every macro, then each macro by category, drawn as its pill, with its own hue or color.
// A leaf module: what it needs from the app is passed to initMacroColorsEditor(), so importing it never adds an import
// cycle.

import { DEFAULT_MACRO_COLORS, MACRO_CATEGORY_ORDER, MACRO_COLOR_SCHEMES, macroHues } from './macro-colors.js';
import { macroPill, registeredMacros } from './macro-pill.js';

/**
 * @typedef {object} MacroColorsEditorDeps
 * @property {() => import('./macro-colors.js').MacroColors} getColors The theme's, as they are now.
 * @property {(colors: import('./macro-colors.js').MacroColors) => void} setColors Applies and saves them.
 * @property {(strings: TemplateStringsArray, ...values: any[]) => string} t
 * @property {(content: HTMLElement) => Promise<unknown>} showPopup Shows the editor until it is closed.
 */

/** @type {MacroColorsEditorDeps | null} */
let deps = null;

/**
 * @param {MacroColorsEditorDeps} dependencies
 * @param {HTMLElement | null} button The theme setting's button that opens the editor.
 */
export function initMacroColorsEditor(dependencies, button) {
    deps = dependencies;
    button?.addEventListener('click', () => void openMacroColorsEditor());
}

/**
 * @param {string} tag
 * @param {Record<string, string>} [attributes]
 * @param {(Node | string)[]} [children]
 */
function el(tag, attributes = {}, children = []) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
    node.append(...children);
    return node;
}

/** Opens the editor; every change applies and saves as it is made. */
export async function openMacroColorsEditor() {
    if (!deps) return;
    const { t, getColors, setColors } = deps;
    /** @type {Record<string, string>} */
    const schemeLabels = {
        spread: t`Evenly spaced`,
        analogous: t`Analogous`,
        complementary: t`Complementary`,
        split: t`Split complementary`,
        triadic: t`Triadic`,
    };
    /** @type {Record<string, string>} */
    const categoryLabels = {
        names: t`Names`, character: t`Character`, chat: t`Chat`, time: t`Time`, random: t`Random`, variable: t`Variables`,
        state: t`State`, prompts: t`Prompts`, utility: t`Utility`, misc: t`Other`, uncategorized: t`Uncategorized`,
    };

    const scheme = /** @type {HTMLSelectElement} */ (el('select', { class: 'text_pole', 'aria-label': t`Color scheme` },
        MACRO_COLOR_SCHEMES.map(value => el('option', { value }, [schemeLabels[value] ?? value]))));
    const seed = /** @type {HTMLInputElement} */ (el('input', { type: 'range', class: 'macro-colors-hue', min: '0', max: '359', step: '1', 'aria-label': t`Starting hue` }));
    const chroma = /** @type {HTMLInputElement} */ (el('input', { type: 'range', min: '0', max: '0.3', step: '0.01', 'aria-label': t`Colorfulness` }));
    const reset = el('button', { type: 'button', class: 'menu_button' }, [t`Reset all`]);
    const list = el('div', { class: 'macro-colors-list' });

    /** @param {(colors: import('./macro-colors.js').MacroColors) => void} change */
    const update = (change) => {
        const colors = getColors();
        change(colors);
        setColors(colors);
        drawRows();
    };
    scheme.addEventListener('change', () => update(colors => { colors.scheme = scheme.value; }));
    seed.addEventListener('input', () => update(colors => { colors.seed = Number(seed.value); }));
    chroma.addEventListener('input', () => update(colors => { colors.chroma = Number(chroma.value); }));
    reset.addEventListener('click', () => update(colors => Object.assign(colors, structuredClone({ ...DEFAULT_MACRO_COLORS, overrides: {} }))));

    const macros = registeredMacros().sort((a, b) => a.name.localeCompare(b.name));
    /** @type {Map<string, { name: string, category: string | undefined }[]>} */
    const byCategory = new Map(MACRO_CATEGORY_ORDER.map(category => [category, []]));
    for (const macro of macros) {
        const category = MACRO_CATEGORY_ORDER.includes(macro.category ?? '') ? macro.category : 'uncategorized';
        byCategory.get(/** @type {string} */ (category))?.push(macro);
    }

    /** Draws each macro's row from the settings as they are now. */
    function drawRows() {
        const colors = getColors();
        const hues = macroHues(colors);
        scheme.value = colors.scheme;
        seed.value = String(colors.seed);
        chroma.value = String(colors.chroma);
        list.replaceChildren();
        for (const [category, members] of byCategory) {
            if (members.length === 0) continue;
            list.append(el('h4', {}, [categoryLabels[category] ?? category]));
            for (const { name } of members) {
                const key = name.toLowerCase();
                const own = colors.overrides[key];
                const pill = macroPill({ source: `{{${name}}}`, name, category, value: name }, { t });
                const hue = /** @type {HTMLInputElement} */ (el('input', { type: 'range', class: 'macro-colors-hue', min: '0', max: '359', step: '1', 'aria-label': t`Hue of ${name}` }));
                hue.value = String(Math.round(hues.get(key) ?? 0));
                hue.addEventListener('input', () => update(c => { c.overrides[key] = { hue: Number(hue.value) }; }));
                const color = /** @type {HTMLInputElement} */ (el('input', { type: 'color', 'aria-label': t`Color of ${name}` }));
                color.addEventListener('input', () => update(c => { c.overrides[key] = { color: color.value }; }));
                const clear = el('button', { type: 'button', class: 'menu_button fa-solid fa-rotate-left', title: t`Back to the scheme's color`, 'aria-label': t`Back to the scheme's color` });
                if (!own) clear.setAttribute('disabled', '');
                clear.addEventListener('click', () => update(c => { delete c.overrides[key]; }));
                list.append(el('div', { class: 'macro-colors-row' }, [pill, hue, color, clear]));
            }
        }
        requestAnimationFrame(showCurrentColors);
    }

    /** Each row's color input shows the macro's color as it is drawn now, once the rows are on the page. */
    function showCurrentColors() {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) return;
        for (const row of list.querySelectorAll('.macro-colors-row')) {
            const pill = row.querySelector('.macro-pill');
            const input = /** @type {HTMLInputElement | null} */ (row.querySelector('input[type="color"]'));
            if (!pill || !input || !pill.isConnected) continue;
            context.clearRect(0, 0, 1, 1);
            context.fillStyle = getComputedStyle(pill).color;
            context.fillRect(0, 0, 1, 1);
            const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
            input.value = `#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')}`;
        }
    }
    drawRows();

    const content = el('div', { class: 'macro-colors-editor' }, [
        el('h3', {}, [t`Macro colors`]),
        el('div', { class: 'macro-colors-controls' }, [
            el('label', {}, [t`Color scheme`, scheme]),
            el('label', {}, [t`Starting hue`, seed]),
            el('label', {}, [t`Colorfulness`, chroma]),
            reset,
        ]),
        el('small', {}, [t`Each macro is as light as your text color, with its own hue from the scheme, unless you give it one.`]),
        list,
    ]);
    await deps.showPopup(content);
}
