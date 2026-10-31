import { TYPE } from '../library-codes.js';
import { draft, keyedPart, partRecord, without } from './entity-draft.js';

const SCRIPT_LISTS = Object.freeze(['trimStrings', 'placement']);

const PRESET_LISTS = Object.freeze(['global', 'scoped', 'preset']);

/** @typedef {import('./entity-draft.js').EntityDraft} EntityDraft */

/**
 * @param {Record<string, any>[]} records
 * @param {string} what
 * @param {(hint: string) => string} newKey
 * @param {string[]} warnings
 * @returns {{ record: Record<string, any>, key: string, keyed: boolean }[]}
 */
function keyedById(records, what, newKey, warnings) {
    const seen = new Set();
    return (Array.isArray(records) ? records : []).map((record, index) => {
        const id = record?.id;
        if (typeof id === 'string' && id !== '' && !id.startsWith('#') && !seen.has(id)) {
            seen.add(id);
            return { record: record ?? {}, key: id, keyed: true };
        }
        const key = `#${newKey(`${what} ${index}`)}`;
        warnings.push(`${what} ${index + 1} has ${typeof id === 'string' && id !== '' ? 'a repeated' : 'no usable'} id; kept as ${JSON.stringify(key)}`);
        return { record: record ?? {}, key, keyed: false };
    });
}

/**
 * @param {EntityDraft} entity
 */
function catalogRecord(entity) {
    return entity.key.startsWith('#') ? { ...entity.values } : { id: entity.key, ...entity.values };
}

/**
 * @param {EntityDraft} script
 * @param {Record<string, any>} record
 */
function withScriptLists(script, record) {
    SCRIPT_LISTS.forEach((field, list) => {
        const items = script.lists?.[list];
        if (items) record[field] = items.map(item => JSON.parse(/** @type {string} */ (item)));
    });
    return record;
}

/**
 * @param {Record<string, any>[]} scripts
 * @param {{ newKey: (hint: string) => string } | { holder: string }} keying
 * @returns {{ scripts: EntityDraft[], warnings: string[] }}
 */
export function regexScriptsFromUpstream(scripts, keying) {
    /** @type {string[]} */
    const warnings = [];
    const records = (Array.isArray(scripts) ? scripts : []).map(script => (script && typeof script === 'object' ? script : {}));
    const catalogKeys = 'newKey' in keying ? keyedById(records, 'regex script', keying.newKey, warnings) : [];
    const seen = new Set();
    const drafts = records.map((record, index) => {
        const values = without(record, SCRIPT_LISTS.filter(field => Array.isArray(record[field])));
        /** @type {Record<number, string[]>} */
        const lists = {};
        SCRIPT_LISTS.forEach((field, list) => {
            if (Array.isArray(record[field])) lists[list] = record[field].map(item => JSON.stringify(item));
        });
        if ('holder' in keying) {
            const part = keyedPart(TYPE.regexScript, keying.holder, values, { idField: 'id', index, seen, warnings, what: 'regex script' });
            return draft(part.type, part.key, part.values, lists);
        }
        const { key, keyed } = catalogKeys[index];
        return draft(TYPE.regexScript, key, keyed ? without(values, ['id']) : values, lists);
    });
    return { scripts: drafts, warnings };
}

/**
 * @param {EntityDraft[]} scripts
 * @param {string} [holder]
 * @returns {Record<string, unknown>[]}
 */
export function regexScriptsToUpstream(scripts, holder) {
    return scripts.map(script => withScriptLists(script, holder === undefined ? catalogRecord(script) : partRecord(script, holder, 'id')));
}

/**
 * @param {Record<string, any>[]} presets
 * @param {(hint: string) => string} newKey
 * @returns {{ presets: EntityDraft[], selected: string | undefined, warnings: string[] }}
 */
export function regexPresetsFromUpstream(presets, newKey) {
    /** @type {string[]} */
    const warnings = [];
    let selected;
    const drafts = keyedById(presets, 'regex preset', newKey, warnings).map(({ record, key, keyed }) => {
        if (record.isSelected === true) {
            if (selected === undefined) selected = key;
            else warnings.push(`regex preset ${JSON.stringify(key)} is also marked selected; ${JSON.stringify(selected)} is`);
        }
        /** @type {Record<number, string[]>} */
        const lists = {};
        PRESET_LISTS.forEach((field, list) => {
            if (Array.isArray(record[field])) lists[list] = record[field].map(item => String(item?.id));
        });
        const taken = [...(keyed ? ['id'] : []), 'isSelected', ...PRESET_LISTS.filter(field => Array.isArray(record[field]))];
        return draft(TYPE.regexPreset, key, without(record, taken), lists);
    });
    return { presets: drafts, selected, warnings };
}

/**
 * @param {EntityDraft[]} presets
 * @param {string | undefined} selected
 * @returns {Record<string, unknown>[]}
 */
export function regexPresetsToUpstream(presets, selected) {
    return presets.map((preset) => {
        /** @type {Record<string, unknown>} */
        const record = catalogRecord(preset);
        record.isSelected = preset.key === selected;
        PRESET_LISTS.forEach((field, list) => {
            const items = preset.lists?.[list];
            if (items) record[field] = items.map(id => ({ id }));
        });
        return record;
    });
}
