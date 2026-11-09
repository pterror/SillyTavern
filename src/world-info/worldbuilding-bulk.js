import { SELECTION_COUNTED_UP_TO } from '@st/worldbuilding/protocol';

/**
 * @param {import('@st/worldbuilding/server').HeldSelection} selection
 * @returns {{ selected: import('../world-info-engine.js').BulkSelected, except: string[] }}
 */
export function bulkSelection(selection) {
    if (selection.base === 'none') return { selected: { entries: selection.except }, except: [] };
    if (selection.filter === null) return { selected: { world: true }, except: selection.except };
    return { selected: { query: selection.filter.query, chips: selection.filter.chips }, except: selection.except };
}

/**
 * The selection's count and the bulk actions of the worldbuilding area, over the store.
 * @param {{ libOf: (user: import('@st/server-ui').User) => Promise<import('../library-engine.js').LibraryEngine> }} wiring
 * @returns {Pick<import('@st/worldbuilding/server').Ports, 'readSelection' | 'startBulk' | 'readBulkJobs'>}
 */
export function worldbuildingBulkPorts({ libOf }) {
    return {
        async readSelection(user, selection) {
            const lib = await libOf(user);
            const book = BigInt(selection.book);
            if (selection.base === 'none') {
                /** @type {bigint[]} */
                const live = await lib.store.worldRead('worldbuildingLiveEntriesOf', { book, entities: selection.except.map(BigInt) });
                const kept = new Set(live.map(String));
                return { except: selection.except.filter(entry => kept.has(entry)), matching: null, matchingCapped: false };
            }
            const { matching, capped } = await lib.books.selectionCount(book, bulkSelection(selection), SELECTION_COUNTED_UP_TO);
            return { except: selection.except, matching, matchingCapped: capped };
        },
        async startBulk(who, selection, action, loopCheckLimit) {
            const lib = await libOf(who.user);
            return lib.books.startBulk(BigInt(selection.book), bulkSelection(selection), action, loopCheckLimit, { user: who.user.handle, session: who.session });
        },
        async readBulkJobs(user, book) {
            const lib = await libOf(user);
            const jobs = await lib.books.bulkJobs(BigInt(book));
            const targets = jobs.map(({ action }) => ('moveTo' in action ? action.moveTo.target : 'alsoPutIn' in action ? action.alsoPutIn.target : null));
            const named = targets.filter(target => target !== null);
            /** @type {(import('@st/worldbuilding/protocol').Named | null)[]} */
            const labels = named.length === 0 ? [] : await lib.store.worldRead('worldbuildingLabels', { book: BigInt(book), entities: named.map(BigInt) });
            const labelOf = new Map(named.map((target, i) => [target, labels[i] ?? null]));
            return jobs.map(({ job, action, done }, i) => {
                const target = targets[i];
                return { job: String(job), action: /** @type {import('@st/worldbuilding/protocol').BulkAction} */ (action), target: target === null ? null : labelOf.get(target) ?? null, done };
            });
        },
    };
}
