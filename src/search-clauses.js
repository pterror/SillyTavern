export { searchClauses } from '@st/protocol/search';
export { WORLD_FIELD, WORLD_LABELS } from '@st/worldbuilding/protocol';

export const LIBRARY_FIELD = Object.freeze({
    name: 0, description: 1, mes_example: 2, scenario: 3, personality: 4, first_mes: 5, creator_notes: 6,
    creator: 7, tags: 8, alternate_greetings: 9, members: 10, id: 11,
});

export const LIBRARY_LABELS = Object.freeze({
    name: [LIBRARY_FIELD.name],
    tag: [LIBRARY_FIELD.tags],
    tags: [LIBRARY_FIELD.tags],
    desc: [LIBRARY_FIELD.description],
    description: [LIBRARY_FIELD.description],
    example: [LIBRARY_FIELD.mes_example],
    scenario: [LIBRARY_FIELD.scenario],
    personality: [LIBRARY_FIELD.personality],
    greeting: [LIBRARY_FIELD.first_mes],
    notes: [LIBRARY_FIELD.creator_notes],
    creator: [LIBRARY_FIELD.creator],
    from: [LIBRARY_FIELD.creator],
    by: [LIBRARY_FIELD.creator],
    author: [LIBRARY_FIELD.creator],
    alt: [LIBRARY_FIELD.alternate_greetings],
    alternate: [LIBRARY_FIELD.alternate_greetings],
    member: [LIBRARY_FIELD.members],
    members: [LIBRARY_FIELD.members],
    id: [LIBRARY_FIELD.id],
});

/**
 * @param {string} list
 * @returns {number[] | null}
 */
export function cursorWeights(list) {
    const weights = list.split(',').map(w => (w === '' ? NaN : Number(w)));
    return weights.every(Number.isFinite) ? weights : null;
}

/**
 * @param {{ weights?: number[] }} next
 * @returns {string}
 */
export function cursorWeightsOf(next) {
    return next.weights ? `:${next.weights.join(',')}` : '';
}
