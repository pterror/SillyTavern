import { describe, test, expect, jest, beforeAll, afterEach } from '@jest/globals';
import { EventEmitter } from 'node:events';
import path from 'node:path';

/** @type {typeof import('../src/endpoints/search-index-coordinator.js').createSearchIndexCoordinator} */
let createSearchIndexCoordinator;
/** @type {typeof import('../src/character-metadata-db.js').characterChangeEmitter} */
let characterChangeEmitter;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    ({ createSearchIndexCoordinator } = await import('../src/endpoints/search-index-coordinator.js'));
    ({ characterChangeEmitter } = await import('../src/character-metadata-db.js'));
});

afterEach(() => {
    jest.useRealTimers();
});

const directories = /** @type {any} */ ({ root: '/nonexistent-search-coordinator-test' });

/** Stands in for search-index-worker.js: records what the coordinator posts, and lets a test post back. */
class FakeWorker extends EventEmitter {
    constructor(workerData) {
        super();
        this.workerData = workerData;
        /** @type {any[]} */
        this.posted = [];
        this.terminate = jest.fn(async () => {
            this.emit('exit', 1);
            return 1;
        });
        this.unref = jest.fn();
    }

    postMessage(msg) {
        this.posted.push(msg);
    }

    /** A message from the worker to the coordinator. */
    send(msg) {
        this.emit('message', msg);
    }
}

function fakeReader(dir) {
    return { dir, index: { reload: jest.fn() }, schema: {} };
}

/** @param {{ onSearchIndexUpdated?: (handle: string, seq: number | null, groupsVersion: number | null) => void }} [options] {}: the coordinator's default. */
function setup(options = { onSearchIndexUpdated: jest.fn() }) {
    /** @type {FakeWorker[]} */
    const workers = [];
    const openIndex = jest.fn(fakeReader);
    const coordinator = createSearchIndexCoordinator({
        spawnWorker: (workerData) => {
            const worker = new FakeWorker(workerData);
            workers.push(worker);
            return worker;
        },
        openIndex,
        ...options,
    });
    return { coordinator, workers, onSearchIndexUpdated: /** @type {jest.Mock} */ (options.onSearchIndexUpdated), openIndex };
}

/** Spawns handle's worker (as workers.at(-1)) with both targets ready. */
async function spawnReady(coordinator, workers, handle) {
    const pending = coordinator.getIndex(handle, directories, 'characters');
    await flush();
    const worker = workers.at(-1);
    worker.send({ type: 'ready', target: 'characters', dir: '/chars' });
    worker.send({ type: 'ready', target: 'groups', dir: '/groups' });
    await pending;
    return worker;
}

/** Lets pending promise callbacks run. */
async function flush() {
    for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('createSearchIndexCoordinator()', () => {
    test('a first request spawns an unref\'d worker and waits only for its own target\'s ready', async () => {
        const { coordinator, workers } = setup();
        let resolved = null;
        const pending = coordinator.getIndex('user1', directories, 'groups').then(r => { resolved = r; });
        await flush();

        expect(workers).toHaveLength(1);
        expect(workers[0].unref).toHaveBeenCalled();
        expect(workers[0].workerData).toMatchObject({ handle: 'user1', directories });

        workers[0].send({ type: 'ready', target: 'characters', dir: '/chars' });
        await flush();
        expect(resolved).toBeNull();

        workers[0].send({ type: 'ready', target: 'groups', dir: '/groups' });
        await pending;
        expect(resolved.dir).toBe('/groups');
    });

    test('start() spawns the worker without waiting for ready; readers open on ready, and a later request reuses them', async () => {
        const { coordinator, workers, openIndex } = setup();
        await coordinator.start('user1', directories);
        expect(workers).toHaveLength(1);
        expect(workers[0].workerData).toMatchObject({ handle: 'user1', directories });

        workers[0].send({ type: 'ready', target: 'characters', dir: '/chars' });
        workers[0].send({ type: 'ready', target: 'groups', dir: '/groups' });
        expect(openIndex.mock.calls.map(([dir]) => dir)).toEqual(['/chars', '/groups']);

        await coordinator.start('user1', directories);
        const reader = await coordinator.getIndex('user1', directories, 'characters');
        expect(reader.dir).toBe('/chars');
        expect(workers).toHaveLength(1);
        expect(openIndex).toHaveBeenCalledTimes(2);
    });

    test('concurrent first requests for a handle share one worker', async () => {
        const { coordinator, workers } = setup();
        const calls = [1, 2, 3].map(() => coordinator.getIndex('user1', directories, 'characters'));
        await flush();
        expect(workers).toHaveLength(1);

        workers[0].send({ type: 'ready', target: 'characters', dir: '/chars' });
        const [a, b, c] = await Promise.all(calls);
        expect(a).toBe(b);
        expect(b).toBe(c);
    });

    test('different handles get their own workers', async () => {
        const { coordinator, workers } = setup();
        coordinator.getIndex('userA', directories, 'characters').catch(() => { });
        coordinator.getIndex('userB', directories, 'characters').catch(() => { });
        await flush();
        expect(workers.map(w => w.workerData.handle)).toEqual(['userA', 'userB']);
    });

    test('"committed" reloads the reader; for characters it also fires onSearchIndexUpdated with the handle, seq and groups version', async () => {
        const { coordinator, workers, onSearchIndexUpdated } = setup();
        const charsPending = coordinator.getIndex('user1', directories, 'characters');
        await flush();
        workers[0].send({ type: 'ready', target: 'characters', dir: '/chars', seq: 1, tagNameSeq: 0, retrySeq: 0 });
        workers[0].send({ type: 'ready', target: 'groups', dir: '/groups', version: 6 });
        const chars = await charsPending;
        const groups = await coordinator.getIndex('user1', directories, 'groups');

        workers[0].send({ type: 'committed', target: 'characters', changed: true, seq: 5, tagNameSeq: 0, retrySeq: 0 });
        expect(chars.index.reload).toHaveBeenCalledTimes(1);
        expect(onSearchIndexUpdated).toHaveBeenCalledTimes(1);
        expect(onSearchIndexUpdated).toHaveBeenLastCalledWith('user1', 5, 6);

        workers[0].send({ type: 'committed', target: 'groups', changed: true });
        expect(groups.index.reload).toHaveBeenCalledTimes(1);
        expect(onSearchIndexUpdated).toHaveBeenCalledTimes(1);
    });

    test('by default a characters commit emits \'search-index-updated\' (handle, seq, groupsVersion) and never \'change\'', async () => {
        const { coordinator, workers } = setup({});
        const worker = await spawnReady(coordinator, workers, 'user1');
        const change = jest.fn();
        const updated = jest.fn();
        characterChangeEmitter.on('change', change);
        characterChangeEmitter.on('search-index-updated', updated);
        try {
            worker.send({ type: 'committed', target: 'characters', changed: true, seq: 7, tagNameSeq: 0, retrySeq: 0 });
            expect(updated).toHaveBeenCalledTimes(1);
            expect(updated).toHaveBeenLastCalledWith('user1', 7, null);
            expect(change).not.toHaveBeenCalled();
        } finally {
            characterChangeEmitter.off('change', change);
            characterChangeEmitter.off('search-index-updated', updated);
        }
    });

    test('a characters "swapped" fires onSearchIndexUpdated with its seq', async () => {
        const { coordinator, workers, onSearchIndexUpdated } = setup();
        const worker = await spawnReady(coordinator, workers, 'user1');
        worker.send({ type: 'swapped', target: 'characters', dir: '/chars-rebuilt', seq: 9, tagNameSeq: 0, retrySeq: 0 });
        expect(onSearchIndexUpdated.mock.calls).toEqual([['user1', 9, null]]);
    });

    test('a commit and a swap share the once-per-second limit', async () => {
        jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick'] });
        const { coordinator, workers, onSearchIndexUpdated } = setup();
        const worker = await spawnReady(coordinator, workers, 'user1');
        worker.send({ type: 'committed', target: 'characters', changed: true, seq: 1, tagNameSeq: 0, retrySeq: 0 });
        worker.send({ type: 'swapped', target: 'characters', dir: '/chars-rebuilt', seq: 2, tagNameSeq: 0, retrySeq: 0 });
        expect(onSearchIndexUpdated.mock.calls).toEqual([['user1', 1, null]]);
        jest.advanceTimersByTime(1000);
        expect(onSearchIndexUpdated.mock.calls).toEqual([['user1', 1, null], ['user1', 2, null]]);
    });

    test('a groups "swapped" fires onSearchIndexUpdated with the characters reader\'s current seq and the swapped index\'s version', async () => {
        jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick'] });
        const { coordinator, workers, onSearchIndexUpdated } = setup();
        const worker = await spawnReady(coordinator, workers, 'user1');
        worker.send({ type: 'committed', target: 'characters', changed: true, seq: 4, tagNameSeq: 0, retrySeq: 0 });
        expect(onSearchIndexUpdated.mock.calls).toEqual([['user1', 4, null]]);

        jest.advanceTimersByTime(1000);
        worker.send({ type: 'swapped', target: 'groups', dir: '/groups-rebuilt', version: 12 });
        expect(onSearchIndexUpdated.mock.calls).toEqual([['user1', 4, null], ['user1', 4, 12]]);
        expect((await coordinator.getIndex('user1', directories, 'groups')).dir).toBe('/groups-rebuilt');
    });

    test('a groups swap\'s seq is null when the characters reader has no known position', async () => {
        const { coordinator, workers, onSearchIndexUpdated } = setup();
        const pending = coordinator.getIndex('user1', directories, 'groups');
        await flush();
        workers[0].send({ type: 'ready', target: 'characters', dir: null });
        workers[0].send({ type: 'ready', target: 'groups', dir: '/groups', version: 2 });
        await pending;
        workers[0].send({ type: 'swapped', target: 'groups', dir: '/groups-rebuilt', version: 3 });
        expect(onSearchIndexUpdated.mock.calls).toEqual([['user1', null, 3]]);
    });

    test('characters commits and groups swaps share the once-per-second limit; the coalesced call carries both current positions', async () => {
        jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick'] });
        const { coordinator, workers, onSearchIndexUpdated } = setup();
        const worker = await spawnReady(coordinator, workers, 'user1');
        worker.send({ type: 'swapped', target: 'groups', dir: '/groups-1', version: 1 });
        worker.send({ type: 'committed', target: 'characters', changed: true, seq: 8, tagNameSeq: 0, retrySeq: 0 });
        worker.send({ type: 'swapped', target: 'groups', dir: '/groups-2', version: 2 });
        expect(onSearchIndexUpdated.mock.calls).toEqual([['user1', null, 1]]);
        jest.advanceTimersByTime(1000);
        expect(onSearchIndexUpdated.mock.calls).toEqual([['user1', null, 1], ['user1', 8, 2]]);
        jest.advanceTimersByTime(5000);
        expect(onSearchIndexUpdated).toHaveBeenCalledTimes(2);
    });

    test('a groups "committed" and errors don\'t fire onSearchIndexUpdated', async () => {
        const { coordinator, workers, onSearchIndexUpdated } = setup();
        const worker = await spawnReady(coordinator, workers, 'user1');
        worker.send({ type: 'committed', target: 'groups', changed: true });
        worker.send({ type: 'error', message: 'x' });
        expect(onSearchIndexUpdated).not.toHaveBeenCalled();
    });

    test('at most once per second per handle: the first at once, the rest coalesced into one at the window\'s end with the latest seq', async () => {
        jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick'] });
        const { coordinator, workers, onSearchIndexUpdated } = setup();
        const worker = await spawnReady(coordinator, workers, 'user1');
        const commit = (seq) => worker.send({ type: 'committed', target: 'characters', changed: true, seq, tagNameSeq: 0, retrySeq: 0 });

        commit(1);
        expect(onSearchIndexUpdated.mock.calls).toEqual([['user1', 1, null]]);

        jest.advanceTimersByTime(100);
        commit(2);
        jest.advanceTimersByTime(400);
        commit(3);
        expect(onSearchIndexUpdated).toHaveBeenCalledTimes(1);

        jest.advanceTimersByTime(499);
        expect(onSearchIndexUpdated).toHaveBeenCalledTimes(1);
        jest.advanceTimersByTime(1);
        expect(onSearchIndexUpdated.mock.calls).toEqual([['user1', 1, null], ['user1', 3, null]]);

        // A commit right after the coalesced one waits for its own full second.
        jest.advanceTimersByTime(100);
        commit(4);
        jest.advanceTimersByTime(899);
        expect(onSearchIndexUpdated).toHaveBeenCalledTimes(2);
        jest.advanceTimersByTime(1);
        expect(onSearchIndexUpdated.mock.calls.at(-1)).toEqual(['user1', 4, null]);

        // A commit a second or more after the last one goes out at once.
        jest.advanceTimersByTime(1000);
        commit(5);
        expect(onSearchIndexUpdated.mock.calls.at(-1)).toEqual(['user1', 5, null]);
        expect(onSearchIndexUpdated).toHaveBeenCalledTimes(4);

        jest.advanceTimersByTime(5000);
        expect(onSearchIndexUpdated).toHaveBeenCalledTimes(4);
    });

    test('the once-per-second limit is per handle', async () => {
        jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick'] });
        const { coordinator, workers, onSearchIndexUpdated } = setup();
        const a = await spawnReady(coordinator, workers, 'userA');
        const b = await spawnReady(coordinator, workers, 'userB');

        a.send({ type: 'committed', target: 'characters', changed: true, seq: 10, tagNameSeq: 0, retrySeq: 0 });
        b.send({ type: 'committed', target: 'characters', changed: true, seq: 20, tagNameSeq: 0, retrySeq: 0 });
        expect(onSearchIndexUpdated.mock.calls).toEqual([['userA', 10, null], ['userB', 20, null]]);

        a.send({ type: 'committed', target: 'characters', changed: true, seq: 11, tagNameSeq: 0, retrySeq: 0 });
        jest.advanceTimersByTime(1000);
        expect(onSearchIndexUpdated.mock.calls).toEqual([['userA', 10, null], ['userB', 20, null], ['userA', 11, null]]);
    });

    test('the characters reader\'s position follows the worker: set on ready, moved with each reload and swap, null when a message has none', async () => {
        const { coordinator, workers } = setup();
        const pending = coordinator.getIndex('user1', directories, 'characters');
        await flush();
        workers[0].send({ type: 'ready', target: 'characters', dir: '/chars', seq: 3, tagNameSeq: 1, retrySeq: 0 });
        const reader = await pending;
        expect(reader.position).toEqual({ seq: 3, tagNameSeq: 1, retrySeq: 0 });

        reader.index.reload.mockImplementation(() => {
            // What searches read changes only here, and the position mustn't run ahead of it.
            expect(reader.position).toEqual({ seq: 3, tagNameSeq: 1, retrySeq: 0 });
        });
        workers[0].send({ type: 'committed', target: 'characters', changed: true, seq: 5, tagNameSeq: 2, retrySeq: 0 });
        expect(reader.index.reload).toHaveBeenCalledTimes(1);
        expect(reader.position).toEqual({ seq: 5, tagNameSeq: 2, retrySeq: 0 });

        // A retry commit moves only the retry counter.
        reader.index.reload.mockImplementation(() => {
            expect(reader.position).toEqual({ seq: 5, tagNameSeq: 2, retrySeq: 0 });
        });
        workers[0].send({ type: 'committed', target: 'characters', changed: true, seq: 5, tagNameSeq: 2, retrySeq: 1 });
        expect(reader.index.reload).toHaveBeenCalledTimes(2);
        expect(reader.position).toEqual({ seq: 5, tagNameSeq: 2, retrySeq: 1 });

        workers[0].send({ type: 'swapped', target: 'characters', dir: '/chars-rebuilt', seq: 8, tagNameSeq: 2, retrySeq: 1 });
        const swapped = await coordinator.getIndex('user1', directories, 'characters');
        expect(swapped.position).toEqual({ seq: 8, tagNameSeq: 2, retrySeq: 1 });

        workers[0].send({ type: 'committed', target: 'characters', changed: true, seq: 9, tagNameSeq: 2 });
        expect(swapped.position).toBeNull();

        workers[0].send({ type: 'committed', target: 'characters', changed: true, seq: 9 });
        expect(swapped.position).toBeNull();
    });

    test('the groups reader\'s position is the version the worker says it was built from: set on ready, replaced with each swap, null when a message has none', async () => {
        const { coordinator, workers } = setup();
        const pending = coordinator.getIndex('user1', directories, 'groups');
        await flush();
        workers[0].send({ type: 'ready', target: 'groups', dir: '/groups', version: 4 });
        expect((await pending).position).toEqual({ version: 4 });

        workers[0].send({ type: 'swapped', target: 'groups', dir: '/groups-rebuilt', version: 7 });
        const swapped = await coordinator.getIndex('user1', directories, 'groups');
        expect(swapped.dir).toBe('/groups-rebuilt');
        expect(swapped.position).toEqual({ version: 7 });

        workers[0].send({ type: 'swapped', target: 'groups', dir: '/groups-rebuilt-again', version: null });
        expect((await coordinator.getIndex('user1', directories, 'groups')).position).toBeNull();
    });

    test('"swapped" replaces the reader with one opened on the new dir', async () => {
        const { coordinator, workers } = setup();
        const pending = coordinator.getIndex('user1', directories, 'characters');
        await flush();
        workers[0].send({ type: 'ready', target: 'characters', dir: '/chars' });
        const before = await pending;

        workers[0].send({ type: 'swapped', target: 'characters', dir: '/chars-rebuilt' });
        const after = await coordinator.getIndex('user1', directories, 'characters');
        expect(after).not.toBe(before);
        expect(after.dir).toBe('/chars-rebuilt');
    });

    test('ready with dir null resolves to null; ready with an error rejects', async () => {
        const { coordinator, workers } = setup();
        const chars = coordinator.getIndex('user1', directories, 'characters');
        const groups = coordinator.getIndex('user1', directories, 'groups');
        await flush();
        workers[0].send({ type: 'ready', target: 'characters', dir: null });
        workers[0].send({ type: 'ready', target: 'groups', error: 'disk full' });
        await expect(chars).resolves.toBeNull();
        await expect(groups).rejects.toThrow('disk full');
    });

    test('a worker that exits is dropped: waiting requests reject and the next request spawns a fresh worker', async () => {
        const { coordinator, workers } = setup();
        const pending = coordinator.getIndex('user1', directories, 'characters');
        await flush();
        workers[0].emit('exit', 1);
        await expect(pending).rejects.toThrow();

        const next = coordinator.getIndex('user1', directories, 'characters');
        await flush();
        expect(workers).toHaveLength(2);
        workers[1].send({ type: 'ready', target: 'characters', dir: '/chars' });
        await expect(next).resolves.toMatchObject({ dir: '/chars' });
    });

    test('rebuild() posts a rebuild request and maps the reply', async () => {
        const { coordinator, workers } = setup();
        const answer = async (reply) => {
            const result = coordinator.rebuild('user1', directories);
            await flush();
            const request = workers[0].posted.at(-1);
            expect(request.type).toBe('rebuild');
            workers[0].send({ type: 'reply', id: request.id, ...reply });
            return result;
        };
        await expect(answer({ ok: true })).resolves.toBe(true);
        await expect(answer({ ok: false })).resolves.toBe(false);
        await expect(answer({ ok: false, error: 'mkdir failed' })).rejects.toThrow('mkdir failed');
        expect(workers).toHaveLength(1);
    });

    test('dispose() posts close, resolves once the worker exits, and drops the handle', async () => {
        const { coordinator, workers } = setup();
        // Rejected once the worker exits.
        coordinator.getIndex('user1', directories, 'characters').catch(() => { });
        await flush();

        let disposed = false;
        const disposing = coordinator.dispose().then(() => { disposed = true; });
        await flush();
        expect(workers[0].posted.at(-1).type).toBe('close');
        expect(disposed).toBe(false);

        workers[0].emit('exit', 0);
        await disposing;
        expect(workers[0].terminate).not.toHaveBeenCalled();

        coordinator.getIndex('user1', directories, 'characters').catch(() => { });
        await flush();
        expect(workers).toHaveLength(2);
    });
});
