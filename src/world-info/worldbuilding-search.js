import { WORLD_FIELD, WORLD_LABELS, searchClauses } from '../search-clauses.js';

const FOUND_BY = [WORLD_FIELD.key, WORLD_FIELD.title];

/** @param {string} query */
export const filterClauses = query => searchClauses(query, WORLD_LABELS);

/** @param {string} query */
export const findClauses = query => searchClauses(query).map(clause => ({ ...clause, fields: FOUND_BY }));

/**
 * @param {{ libOf: (user: import('@st/server-ui').User) => Promise<any> }} options
 * @returns {Pick<import('@st/worldbuilding/server').Ports, 'labelEntries' | 'readResults' | 'findEntries'>}
 */
export function worldbuildingSearchPorts({ libOf }) {
    return {
        async labelEntries(user, book, entries) {
            if (entries.length === 0) return [];
            const lib = await libOf(user);
            return lib.store.worldRead('worldbuildingLabels', { book: BigInt(book), entities: entries.map(entry => BigInt(entry)) });
        },
        async readResults(user, { book, groupBy, layout, query, chips, pageSize, from, pages, walkSteps }) {
            const lib = await libOf(user);
            return lib.store.worldRead('worldbuildingResults', {
                book: BigInt(book),
                groupBy: groupBy === null ? null : Number(groupBy),
                cardTextCharacters: layout.cardTextCharacters,
                clauses: filterClauses(query),
                chips: chips.map(chip => ({ kind: Number(chip.kind), target: BigInt(chip.target), depth: chip.depth })),
                from,
                pages,
                limit: pageSize,
                walkSteps,
            });
        },
        async findEntries(user, { book, query, limit }) {
            const lib = await libOf(user);
            return lib.store.worldRead('worldbuildingFind', { book: BigInt(book), clauses: findClauses(query), limit });
        },
    };
}
