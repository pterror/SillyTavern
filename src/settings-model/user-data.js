import { TYPE } from '../library-codes.js';
import { draft, without } from './entity-draft.js';

/** @typedef {import('./entity-draft.js').EntityDraft} EntityDraft */

/**
 * @param {Record<string, unknown>} variables
 * @returns {EntityDraft[]}
 */
export function globalVariablesFromUpstream(variables) {
    return Object.entries(variables && typeof variables === 'object' ? variables : {})
        .map(([name, value]) => draft(TYPE.globalVariable, name, { value }));
}

/**
 * @param {EntityDraft[]} variables
 * @returns {Record<string, unknown>}
 */
export function globalVariablesToUpstream(variables) {
    return Object.fromEntries(variables.map(variable => [variable.key, variable.values.value]));
}

/**
 * @typedef {object} DataBankFromUpstream
 * @property {EntityDraft[]} files
 * @property {string[]} user
 * @property {{ avatar: string, files: string[] }[]} characters
 * @property {string[]} disabledElsewhere
 * @property {string[]} warnings
 */

/**
 * @param {{ attachments?: Record<string, any>[], character_attachments?: Record<string, Record<string, any>[]>, disabled_attachments?: string[] }} settings
 * @returns {DataBankFromUpstream}
 */
export function dataBankFromUpstream(settings) {
    /** @type {string[]} */
    const warnings = [];
    /** @type {Map<string, EntityDraft>} */
    const files = new Map();
    const disabled = new Set(Array.isArray(settings.disabled_attachments) ? settings.disabled_attachments : []);
    /**
     * @param {unknown} list
     * @param {string} where
     */
    const urlsOf = (list, where) => (Array.isArray(list) ? list : []).flatMap((file) => {
        if (!file || typeof file.url !== 'string' || file.url === '') {
            warnings.push(`${where}: a data bank file with no url is dropped: ${JSON.stringify(file)}`);
            return [];
        }
        const values = { ...without(file, ['url']), ...(disabled.has(file.url) ? { disabled: true } : {}) };
        const held = files.get(file.url);
        if (!held) files.set(file.url, draft(TYPE.dataBankFile, file.url, values));
        else if (JSON.stringify(held.values) !== JSON.stringify(values)) warnings.push(`${where}: the data bank file ${file.url} differs from another listing of it; the first is kept`);
        return [file.url];
    });
    const user = urlsOf(settings.attachments, 'the user\'s data bank');
    const characters = Object.entries(settings.character_attachments ?? {})
        .map(([avatar, list]) => ({ avatar, files: urlsOf(list, `${avatar}'s data bank`) }));
    return {
        files: [...files.values()],
        user,
        characters,
        disabledElsewhere: [...disabled].filter(url => !files.has(url)),
        warnings,
    };
}

/**
 * @param {EntityDraft[]} files
 * @param {{ user?: string[], characters?: { avatar: string, files: string[] }[], disabledElsewhere?: string[] }} statements
 */
export function dataBankToUpstream(files, statements) {
    const byUrl = new Map(files.map(file => [file.key, file]));
    /** @param {string[]} urls */
    const listing = urls => urls.flatMap((url) => {
        const file = byUrl.get(url);
        return file ? [{ url, ...without(file.values, ['disabled']) }] : [];
    });
    return {
        attachments: listing(statements.user ?? []),
        character_attachments: Object.fromEntries((statements.characters ?? []).map(({ avatar, files: urls }) => [avatar, listing(urls)])),
        disabled_attachments: [...files.filter(file => file.values.disabled === true).map(file => file.key), ...(statements.disabledElsewhere ?? [])],
    };
}
