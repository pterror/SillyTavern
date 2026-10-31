/**
 * @param {{ speakers: (ids: bigint[]) => Promise<Map<bigint, { name: string }>> }} people
 * @returns {(ids: bigint[]) => Promise<Map<bigint, { group: boolean, name: string, created: number }>>}
 */
export function fakeOwners(people) {
    return async ids => {
        const speakers = await people.speakers(ids);
        return new Map(ids.map(id => [id, speakers.has(id) ? { group: false, name: /** @type {any} */ (speakers.get(id)).name, created: 0 } : { group: true, name: '', created: 0 }]));
    };
}
