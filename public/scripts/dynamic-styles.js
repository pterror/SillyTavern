/** @type {CSSStyleSheet} */
let dynamicStyleSheet = null;
/** @type {CSSStyleSheet} */
let dynamicExtensionStyleSheet = null;

/**
 * An observer that will check if any new stylesheets are added to the head
 * @type {MutationObserver}
 */
const observer = new MutationObserver(mutations => {
    mutations.forEach(mutation => {
        if (mutation.type !== 'childList') return;

        mutation.addedNodes.forEach(node => {
            if (node instanceof HTMLLinkElement && node.tagName === 'LINK' && node.rel === 'stylesheet') {
                node.addEventListener('load', () => {
                    try {
                        applyDynamicFocusStyles(node.sheet);
                    } catch (e) {
                        console.warn('Failed to process new stylesheet:', e);
                    }
                });
            }
        });
    });
});

/**
 * Generates dynamic focus styles based on the given stylesheet, taking its hover styles as reference
 *
 * @param {CSSStyleSheet} styleSheet - The stylesheet to process
 * @param {object} [options] - Optional configuration options
 * @param {boolean} [options.fromExtension=false] - Indicates if the styles are from an extension
 */
function applyDynamicFocusStyles(styleSheet, { fromExtension = false } = {}) {
    /** @typedef {{ type: 'media'|'supports'|'container', conditionText: string }} WrapperCond */
    /** @type {{baseSelector: string, rule: CSSStyleRule, wrappers: WrapperCond[]}[]} */
    const hoverRules = [];
    /** @type {Set<string>} */
    const focusRules = new Set();

    const PLACEHOLDER = ':__PLACEHOLDER__';

    /**
     * Builds a stable signature string for a chain of wrapper conditions so we can distinguish
     * identical selectors under different contexts (e.g., different @media queries)
     * @param {WrapperCond[]} wrappers
     * @returns {string}
     */
    function wrapperSignature(wrappers) {
        return wrappers.map(w => `${w.type}:${w.conditionText}`).join(';');
    }

    /**
     * Processes the CSS rules and separates selectors for hover and focus
     * @param {CSSRuleList} rules - The CSS rules to process
     * @param {WrapperCond[]} wrappers - Current chain of wrapper conditions (@media/@supports/etc.)
     */
    function processRules(rules, wrappers = []) {
        Array.from(rules).forEach(rule => {
            if (rule instanceof CSSImportRule) {
                /** @type {WrapperCond[]} */
                const extra = (rule.media && rule.media.mediaText) ? [{ type: 'media', conditionText: rule.media.mediaText }] : [];
                processImportedStylesheet(rule.styleSheet, [...wrappers, ...extra]);
            } else if (rule instanceof CSSStyleRule) {
                const selectors = rule.selectorText.split(',').map(s => s.trim());

                selectors.forEach(selector => {
                    const isHover = selector.includes(':hover'), isFocus = selector.includes(':focus');
                    if (isHover && isFocus) {
                        // Rules with both are specific enough that they shouldn't be auto-touched
                    } else if (isHover) {
                        const baseSelector = selector.replace(/:hover/g, PLACEHOLDER).trim();
                        hoverRules.push({ baseSelector, rule, wrappers: [...wrappers] });
                    } else if (isFocus) {
                        const baseSelector = selector.replace(/:focus(-within|-visible)?/g, PLACEHOLDER).trim();
                        focusRules.add(`${baseSelector}|${wrapperSignature(wrappers)}`);
                    }
                });
            } else if (rule instanceof CSSMediaRule) {
                processRules(rule.cssRules, [...wrappers, { type: 'media', conditionText: rule.conditionText }]);
            } else if (rule instanceof CSSSupportsRule) {
                processRules(rule.cssRules, [...wrappers, { type: 'supports', conditionText: rule.conditionText }]);
            } else if (rule instanceof window.CSSContainerRule) {
                processRules(rule.cssRules, [...wrappers, { type: 'container', conditionText: rule.conditionText }]);
            }
        });
    }

    /**
     * Processes the CSS rules of an imported stylesheet recursively
     * @param {CSSStyleSheet} sheet - The imported stylesheet to process
     * @param {WrapperCond[]} wrappers - Wrapper conditions inherited from (at)import media
     */
    function processImportedStylesheet(sheet, wrappers = []) {
        if (sheet && sheet.cssRules) {
            processRules(sheet.cssRules, wrappers);
        }
    }

    processRules(styleSheet.cssRules, []);

    /** @type {CSSStyleSheet} */
    let targetStyleSheet = null;

    hoverRules.forEach(({ baseSelector, rule, wrappers }) => {
        if (!focusRules.has(`${baseSelector}|${wrapperSignature(wrappers)}`)) {
            targetStyleSheet ??= getDynamicStyleSheet({ fromExtension });

            // :focus-visible is the closest keyboard-equivalent to :hover; only generated for rules without a manual focus rule already
            const focusSelector = rule.selectorText.replace(/:hover/g, ':focus-visible');

            // Pseudo-elements can't take :focus-visible appended (invalid CSS syntax)
            if (focusSelector.includes('::')) {
                return;
            }
            let focusRule = `${focusSelector} { ${rule.style.cssText} }`;

            if (wrappers.length > 0) {
                focusRule = wrappers.reduceRight((inner, w) => {
                    if (w.type === 'media') return `@media ${w.conditionText} { ${inner} }`;
                    if (w.type === 'supports') return `@supports ${w.conditionText} { ${inner} }`;
                    if (w.type === 'container') return `@container ${w.conditionText} { ${inner} }`;
                    return inner;
                }, focusRule);
            }

            try {
                targetStyleSheet.insertRule(focusRule, targetStyleSheet.cssRules.length);
            } catch (e) {
                console.warn('Failed to insert focus rule:', e);
            }
        }
    });
}

/**
 * Retrieves the stylesheet that should be used for dynamic rules
 *
 * @param {object} options - The options object
 * @param {boolean} [options.fromExtension=false] - Indicates whether the rules are coming from extensions
 * @return {CSSStyleSheet} The dynamic stylesheet
 */
function getDynamicStyleSheet({ fromExtension = false } = {}) {
    if (fromExtension) {
        if (!dynamicExtensionStyleSheet) {
            const styleSheetElement = document.createElement('style');
            styleSheetElement.setAttribute('id', 'dynamic-extension-styles');
            document.head.appendChild(styleSheetElement);
            dynamicExtensionStyleSheet = styleSheetElement.sheet;
        }
        return dynamicExtensionStyleSheet;
    } else {
        if (!dynamicStyleSheet) {
            const styleSheetElement = document.createElement('style');
            styleSheetElement.setAttribute('id', 'dynamic-styles');
            document.head.appendChild(styleSheetElement);
            dynamicStyleSheet = styleSheetElement.sheet;
        }
        return dynamicStyleSheet;
    }
}

/**
 * Initializes dynamic styles for ST
 */
export function initDynamicStyles() {
    observer.observe(document.head, {
        childList: true,
        subtree: true,
    });

    Array.from(document.styleSheets).forEach(sheet => {
        try {
            applyDynamicFocusStyles(sheet, { fromExtension: sheet.href?.toLowerCase().includes('scripts/extensions') == true });
        } catch (e) {
            console.warn('Failed to process stylesheet on initial load:', e);
        }
    });
}
