import { describe, test, expect, jest } from '@jest/globals';

import { createIndexCoordinator } from '../src/endpoints/search-index-coordinator.js';

/** A promise plus its resolve function, so a test can control exactly when a "build" finishes. */
function deferred() {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    return { promise, resolve };
}

function fakeDb(label) {
    return { label, close: jest.fn() };
}

/** Lets any already-queued microtasks (the coordinator's internal `.then()` chain) run before continuing. */
async function flushMicrotasks(times = 4) {
    for (let i = 0; i < times; i++) {
        await Promise.resolve();
    }
}

/** Polls `check` until it returns true or `flushMicrotasks` has run `maxRounds` times, to avoid hardcoding the
 * exact microtask-chain depth (Promise-returning `.then()` callbacks add extra adoption ticks) in the tests. */
async function waitUntil(check, maxRounds = 20) {
    for (let i = 0; i < maxRounds && !check(); i++) {
        await flushMicrotasks(1);
    }
}

describe('createIndexCoordinator()', () => {
    test('a fresh handle blocks on the build and returns its result', async () => {
        const coordinator = createIndexCoordinator();
        const db = fakeDb('first');
        const build = jest.fn(() => db);

        const result = await coordinator.getIndex('user1', 'sig-a', build);

        expect(result).toBe(db);
        expect(build).toHaveBeenCalledTimes(1);
    });

    test('concurrent first-time requests for the same handle share one build, not one each', async () => {
        const coordinator = createIndexCoordinator();
        const { promise, resolve } = deferred();
        const build = jest.fn(() => promise);

        const call1 = coordinator.getIndex('user1', 'sig-a', build);
        const call2 = coordinator.getIndex('user1', 'sig-a', build);

        await flushMicrotasks();
        expect(build).toHaveBeenCalledTimes(1);

        const db = fakeDb('shared');
        resolve(db);
        const [result1, result2] = await Promise.all([call1, call2]);

        expect(result1).toBe(db);
        expect(result2).toBe(db);
        expect(build).toHaveBeenCalledTimes(1);
    });

    test('a stale signature does not block the request - it returns the existing db immediately', async () => {
        const coordinator = createIndexCoordinator();
        const oldDb = fakeDb('old');
        await coordinator.getIndex('user1', 'sig-a', () => oldDb);

        const { promise: rebuildPromise } = deferred(); // never resolved within this test - simulates a slow rebuild
        const build = jest.fn(() => rebuildPromise);

        const result = await coordinator.getIndex('user1', 'sig-b', build);

        // Stale, but the request got the OLD db back immediately rather than hanging on the new build.
        expect(result).toBe(oldDb);
        expect(build).toHaveBeenCalledTimes(1);
        expect(oldDb.close).not.toHaveBeenCalled();
    });

    test('a background rebuild swaps in the new db and closes the old one once it finishes', async () => {
        const coordinator = createIndexCoordinator();
        const oldDb = fakeDb('old');
        await coordinator.getIndex('user1', 'sig-a', () => oldDb);

        const { promise, resolve } = deferred();
        await coordinator.getIndex('user1', 'sig-b', () => promise); // kicks off the background rebuild, returns oldDb

        const newDb = fakeDb('new');
        resolve(newDb);
        await waitUntil(() => oldDb.close.mock.calls.length > 0); // let the coordinator's swap-and-close chain run

        const result = await coordinator.getIndex('user1', 'sig-b', () => {
            throw new Error('should not rebuild again - signature now matches the swapped-in entry');
        });

        expect(result).toBe(newDb);
        expect(oldDb.close).toHaveBeenCalledTimes(1);
    });

    test('concurrent requests observing the same stale signature only start one background rebuild', async () => {
        const coordinator = createIndexCoordinator();
        const oldDb = fakeDb('old');
        await coordinator.getIndex('user1', 'sig-a', () => oldDb);

        const { promise, resolve } = deferred();
        const build = jest.fn(() => promise);

        const result1 = await coordinator.getIndex('user1', 'sig-b', build);
        const result2 = await coordinator.getIndex('user1', 'sig-b', build);
        const result3 = await coordinator.getIndex('user1', 'sig-b', build);

        expect(result1).toBe(oldDb);
        expect(result2).toBe(oldDb);
        expect(result3).toBe(oldDb);
        expect(build).toHaveBeenCalledTimes(1); // not 3 - the race this coordinator exists to close

        resolve(fakeDb('new'));
    });

    test('different handles get fully independent indexes and builds', async () => {
        const coordinator = createIndexCoordinator();
        const dbA = fakeDb('a');
        const dbB = fakeDb('b');

        const resultA = await coordinator.getIndex('userA', 'sig-1', () => dbA);
        const resultB = await coordinator.getIndex('userB', 'sig-1', () => dbB);

        expect(resultA).toBe(dbA);
        expect(resultB).toBe(dbB);
    });

    test('a failed background rebuild does not throw out of getIndex() and leaves the old db serving', async () => {
        const coordinator = createIndexCoordinator();
        const oldDb = fakeDb('old');
        await coordinator.getIndex('user1', 'sig-a', () => oldDb);

        const result = await coordinator.getIndex('user1', 'sig-b', () => Promise.reject(new Error('disk full')));
        await flushMicrotasks(20);

        expect(result).toBe(oldDb);
        expect(oldDb.close).not.toHaveBeenCalled();
    });

    describe('cold start with openStale (the fix for the boot-time-bulk-import block)', () => {
        test('a cold start with a usable openStale() serves it immediately instead of blocking on build()', async () => {
            const coordinator = createIndexCoordinator();
            const staleDb = fakeDb('stale');
            const openStale = jest.fn(() => staleDb);
            const { promise: buildPromise } = deferred(); // never resolved in this test - would hang if awaited
            const build = jest.fn(() => buildPromise);

            const result = await coordinator.getIndex('user1', 'sig-a', build, openStale);

            expect(result).toBe(staleDb);
            expect(openStale).toHaveBeenCalledTimes(1);
            // build() was kicked off (in the background, catching the stale db up to 'sig-a') but getIndex()
            // did not wait on it - the deferred build promise above is still unresolved.
            expect(build).toHaveBeenCalledTimes(1);
            expect(build).toHaveBeenCalledWith(staleDb);
        });

        test('the background catch-up kicked off after openStale() swaps in the new db once it resolves', async () => {
            const coordinator = createIndexCoordinator();
            const staleDb = fakeDb('stale');
            const { promise, resolve } = deferred();

            await coordinator.getIndex('user1', 'sig-a', () => promise, () => staleDb);

            const caughtUpDb = fakeDb('caught-up');
            resolve(caughtUpDb);
            await waitUntil(() => staleDb.close.mock.calls.length > 0);

            const result = await coordinator.getIndex('user1', 'sig-a', () => {
                throw new Error('should not rebuild again - already caught up');
            });
            expect(result).toBe(caughtUpDb);
            expect(staleDb.close).toHaveBeenCalledTimes(1);
        });

        test('an in-place-updated stale db (build() returns the same reference) is not closed out from under itself', async () => {
            const coordinator = createIndexCoordinator();
            const staleDb = fakeDb('stale');

            await coordinator.getIndex('user1', 'sig-a', (previous) => previous, () => staleDb);
            await flushMicrotasks(20);

            const result = await coordinator.getIndex('user1', 'sig-a', () => {
                throw new Error('should not rebuild again');
            });
            expect(result).toBe(staleDb);
            expect(staleDb.close).not.toHaveBeenCalled();
        });

        test('openStale() returning nothing falls back to blocking on build(), same as no openStale at all', async () => {
            const coordinator = createIndexCoordinator();
            const db = fakeDb('built');
            const openStale = jest.fn(() => null);
            const build = jest.fn(() => db);

            const result = await coordinator.getIndex('user1', 'sig-a', build, openStale);

            expect(result).toBe(db);
            expect(openStale).toHaveBeenCalledTimes(1);
            expect(build).toHaveBeenCalledTimes(1);
        });

        test('concurrent cold-start requests for the same handle share one openStale() call and one background build, not one each', async () => {
            const coordinator = createIndexCoordinator();
            const staleDb = fakeDb('stale');
            const openStale = jest.fn(() => staleDb);
            const { promise: buildPromise } = deferred();
            const build = jest.fn(() => buildPromise);

            const [result1, result2, result3] = await Promise.all([
                coordinator.getIndex('user1', 'sig-a', build, openStale),
                coordinator.getIndex('user1', 'sig-a', build, openStale),
                coordinator.getIndex('user1', 'sig-a', build, openStale),
            ]);

            expect(result1).toBe(staleDb);
            expect(result2).toBe(staleDb);
            expect(result3).toBe(staleDb);
            expect(openStale).toHaveBeenCalledTimes(1); // not 3
            expect(build).toHaveBeenCalledTimes(1); // not 3 - the exact race this coordinator has to close
        });

        test('a cold start with no openStale at all still blocks on build(), unchanged from before this option existed', async () => {
            const coordinator = createIndexCoordinator();
            const db = fakeDb('built');
            const build = jest.fn(() => db);

            const result = await coordinator.getIndex('user1', 'sig-a', build);

            expect(result).toBe(db);
            expect(build).toHaveBeenCalledTimes(1);
        });
    });
});
