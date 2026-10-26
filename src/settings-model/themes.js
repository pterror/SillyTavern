import { TYPE } from '../library-codes.js';
import { THEME_FIELDS } from '../../public/scripts/theme-fields.js';
import { draft } from './entity-draft.js';

/**
 * Themes (§1.3, step 3e): a bundle each (`TYPE.theme`, key its name), one value per field of its file
 * (`THEME_FIELDS` and its `name`), named as the file names them; a field that isn't a theme's is kept as it came.
 */

export { THEME_FIELDS };

/**
 * @param {string} name
 * @param {Record<string, unknown>} file
 * @returns {import('./entity-draft.js').EntityDraft}
 */
export function themeFromUpstream(name, file) {
    return draft(TYPE.theme, name, { ...file });
}

/**
 * @param {import('./entity-draft.js').EntityDraft} theme
 * @returns {Record<string, unknown>}
 */
export function themeToUpstream(theme) {
    return { ...theme.values };
}
