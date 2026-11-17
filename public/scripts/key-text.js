import { formatModifier } from '../live-editor-lib.js';
import { t } from './i18n.js';
import { watchKeys } from './new-ui-page.js';
import { POPUP_TYPE, callGenericPopup } from './popup.js';

/**
 * Settings text that names keys, made from what is bound on this platform: the suggestions command's binding, and the
 * modifier that, held, shows every hotkey
 */
export function initKeyText() {
    const storage = document.getElementById('key_settings_storage');
    const settings = document.getElementById('key_settings');
    document.getElementById('open_key_settings')?.addEventListener('click', () => {
        if (!storage || !settings || settings.parentElement !== storage) return;
        void callGenericPopup(settings, POPUP_TYPE.TEXT, '', {
            wide: true,
            large: true,
            leftAlign: true,
            allowVerticalScrolling: true,
            onOpen: popup => { popup.dlg.setAttribute('aria-labelledby', 'key_settings_title'); },
            onClose: () => { storage.append(settings); },
        });
    });

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
