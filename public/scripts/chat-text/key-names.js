import { isMac } from '../../live-editor-lib.js';
import { newUi, newUiStarted } from '../new-ui-page.js';

/**
 * A command's first binding as people see it on this platform
 * @param {string} id the command's id
 * @returns {string | undefined} the keys, or none if it has none or the page has not started
 */
export function shownKeysOf(id) {
    return newUiStarted() ? newUi().commands.shownKeys(id) : undefined;
}

const ARIA_MODIFIERS = new Map([['alt', 'Alt'], ['shift', 'Shift'], ['ctrl', 'Control'], ['control', 'Control'], ['meta', 'Meta'], ['cmd', 'Meta']]);

/**
 * A command's first binding as `aria-keyshortcuts` writes it
 * @param {string} id the command's id
 * @returns {string | undefined} `Control+Alt+V`, or none if it has none, is several steps, or the page has not started
 */
export function ariaShortcut(id) {
    if (!newUiStarted()) return undefined;
    const binding = newUi().commands.all().find(command => command.id === id)?.keys?.[0];
    if (!binding || binding.trim().includes(' ')) return undefined;
    return binding.split('+').map(part => {
        const name = part.trim().toLowerCase();
        if (name === '$mod') return isMac ? 'Meta' : 'Control';
        return ARIA_MODIFIERS.get(name) ?? (name.length === 1 ? name.toUpperCase() : name[0].toUpperCase() + name.slice(1));
    }).join('+');
}
