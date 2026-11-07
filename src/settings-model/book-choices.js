import { bookKey } from '../world-info-keys.js';

export const CHOICE = Object.freeze({ selected: 0, lorebook: 1 });

export const SELECTION_FIELD = 'world_info_settings.world_info';

const PAGE = 1000;

/**
 * @typedef {{ selected?: string[], personas: Map<string, string> }} Chosen
 */

/**
 * @param {bigint} holder
 * @param {number} slot
 * @param {string[]} names
 */
export function chooseRecord(holder, slot, names) {
    return { kind: 'bookChoose', holder, slot, keys: names.map(bookKey).filter(k => k !== '').join('\n') };
}

/**
 * @param {import('../library-engine.js').LibraryEngine} lib
 * @param {bigint[]} holders
 * @returns {Promise<Map<bigint, Map<number, string[]>>>}
 */
export async function readChoices(lib, holders) {
    /** @type {Map<bigint, Map<number, string[]>>} */
    const out = new Map();
    for (let i = 0; i < holders.length; i += PAGE) {
        const part = holders.slice(i, i + PAGE);
        /** @type {{ slot: number, books: { id: bigint, key: string | null }[] }[][]} */
        const read = await lib.store.worldRead('choices', { holders: part });
        part.forEach((holder, n) => {
            out.set(holder, new Map(read[n].map(s => [s.slot, s.books.map(b => b.key).filter(k => typeof k === 'string')])));
        });
    }
    return out;
}

/**
 * @param {unknown} value
 * @returns {{ rest: Record<string, unknown>, names: string[] } | null}
 */
export function selectionOf(value) {
    if (typeof value === 'string') return { rest: {}, names: value ? [value] : [] };
    if (Array.isArray(value)) return { rest: {}, names: namesIn(value) };
    if (!value || typeof value !== 'object') return null;
    const { globalSelect, ...rest } = /** @type {Record<string, unknown>} */ (value);
    return { rest, names: Array.isArray(globalSelect) ? namesIn(globalSelect) : [] };
}

/**
 * @param {unknown[]} list
 * @returns {string[]}
 */
function namesIn(list) {
    return [...new Set(/** @type {string[]} */ (list.filter(n => typeof n === 'string' && n !== '')))];
}
