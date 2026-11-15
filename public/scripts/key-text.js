import { formatModifier } from '../live-editor-lib.js';
import { t } from './i18n.js';
import { watchKeys } from './new-ui-page.js';

/**
 * Settings text that names keys, made from what is bound on this platform: the suggestions command's binding, and the
 * modifier that, held, shows every hotkey
 */
export function initKeyText() {
    const macroFields = document.querySelector('label[for="stscript_autocomplete_showInAllMacroFields"]');
    if (macroFields) {
        watchKeys('suggestions.show', keys => {
            macroFields.setAttribute('title', keys
                ? t`Show macro autocomplete in all macro-enabled fields. When off, autocomplete only shows in expanded editors or when pressing ${keys}.`
                : t`Show macro autocomplete in all macro-enabled fields. When off, autocomplete only shows in expanded editors.`);
        });
    }

    const modifier = formatModifier('$mod') ?? '';
    const holdOverlay = document.querySelector('label[for="hotkey_overlay"]');
    holdOverlay?.setAttribute('title', t`Holding ${modifier} by itself for a moment shows every hotkey until you let go.`);
    const holdText = holdOverlay?.querySelector('small');
    if (holdText) holdText.textContent = t`Show hotkeys while holding ${modifier}`;
}
