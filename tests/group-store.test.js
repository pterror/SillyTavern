import { describe, test, expect, jest, beforeAll, beforeEach, afterEach } from '@jest/globals';

jest.unstable_mockModule('../public/scripts/request-headers.js', () => ({
    getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
}));

/** @type {typeof import('../public/scripts/group-store.js')} */
let groupStore;

beforeAll(async () => {
    groupStore = await import('../public/scripts/group-store.js');
});

const originalFetch = globalThis.fetch;
/** @type {Map<string, object>} */
let served;
/** @type {[string, any][]} */
let asked;

beforeEach(() => {
    jest.useFakeTimers();
    for (const group of [...groupStore.groups]) groupStore.groupsStore.remove(group.id);
    served = new Map();
    asked = [];
    globalThis.fetch = jest.fn(async (url, options) => {
        const body = JSON.parse(options.body);
        asked.push([url, body]);
        if (url === '/api/groups/batch') {
            return { ok: true, status: 200, json: async () => body.ids.filter(id => served.has(id)).map(id => structuredClone(served.get(id))) };
        }
        if (url === '/api/characters/find') {
            const found = [...served.values()].filter(group => group.name === body.name).map(group => group.id);
            return { ok: true, status: 200, json: async () => ({ ids: found }) };
        }
        return { ok: false, status: 404 };
    });
});

afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.useRealTimers();
});

const heldIds = () => groupStore.groups.map(group => group.id).sort();

describe('the page holds the groups it shows', () => {
    test('holding groups reads, in one request, only the ones not held yet, and holds the ones that exist', async () => {
        served.set('g1', { id: 'g1', name: 'One' });
        served.set('g2', { id: 'g2', name: 'Two' });
        groupStore.groupsStore.create({ id: 'g0', name: 'Zero' });

        const held = await groupStore.holdGroups(['g0', 'g1', 'g2', 'gone']);

        expect(asked).toEqual([['/api/groups/batch', { ids: ['g1', 'g2', 'gone'] }]]);
        expect([...held.keys()].sort()).toEqual(['g0', 'g1', 'g2']);
        expect(heldIds()).toEqual(['g0', 'g1', 'g2']);
        expect(held.get('g1')).toBe(groupStore.groupsStore.get('g1'));

        asked = [];
        await groupStore.holdGroups(['g1']);
        expect(asked).toEqual([]);
    });

    test('rows read for showing are not held', async () => {
        served.set('g1', { id: 'g1', name: 'One' });

        const rows = await groupStore.getGroupRows(['g1']);

        expect(rows.get('g1')).toEqual({ id: 'g1', name: 'One' });
        expect(heldIds()).toEqual([]);
    });

    test('a held group no keeper names is let go soon after another is held', async () => {
        served.set('g1', { id: 'g1' });
        served.set('g2', { id: 'g2' });
        const stop = groupStore.keepHeldGroups(() => ['g1', null, undefined]);
        try {
            await groupStore.holdGroups(['g1', 'g2']);
            expect(heldIds()).toEqual(['g1', 'g2']);

            jest.advanceTimersByTime(2000);

            expect(heldIds()).toEqual(['g1']);
        } finally {
            stop();
        }
    });

    test('a group is found by name on the server, not among the held ones', async () => {
        served.set('g7', { id: 'g7', name: 'Party' });
        groupStore.groupsStore.create({ id: 'g1', name: 'Held' });

        expect(await groupStore.findGroupByName('Party')).toBe('g7');
        expect(await groupStore.findGroupByName('Held')).toBe(null);
        expect(asked).toEqual([
            ['/api/characters/find', { type: 'group', name: 'Party' }],
            ['/api/characters/find', { type: 'group', name: 'Held' }],
        ]);
    });
});
