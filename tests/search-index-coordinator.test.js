import { describe, test, expect, jest, beforeAll } from '@jest/globals';
import { EventEmitter } from 'node:events';
import path from 'node:path';

/** @type {typeof import('../src/endpoints/search-index-coordinator.js').createSearchIndexCoordinator} */
let createSearchIndexCoordinator;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    ({ createSearchIndexCoordinator } = await import('../src/endpoints/search-index-coordinator.js'));
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

function setup() {
    /** @type {FakeWorker[]} */
    const workers = [];
    const onCharactersCommitted = jest.fn();
    const openIndex = jest.fn(fakeReader);
    const coordinator = createSearchIndexCoordinator({
        spawnWorker: (workerData) => {
            const worker = new FakeWorker(workerData);
            workers.push(worker);
            return worker;
        },
        openIndex,
        onCharactersCommitted,
    });
    return { coordinator, workers, onCharactersCommitted, openIndex };
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

    test('"committed" reloads the reader; for characters it also fires onCharactersCommitted', async () => {
        const { coordinator, workers, onCharactersCommitted } = setup();
        const charsPending = coordinator.getIndex('user1', directories, 'characters');
        await flush();
        workers[0].send({ type: 'ready', target: 'characters', dir: '/chars' });
        workers[0].send({ type: 'ready', target: 'groups', dir: '/groups' });
        const chars = await charsPending;
        const groups = await coordinator.getIndex('user1', directories, 'groups');

        workers[0].send({ type: 'committed', target: 'characters', changed: true, seq: 5 });
        expect(chars.index.reload).toHaveBeenCalledTimes(1);
        expect(onCharactersCommitted).toHaveBeenCalledTimes(1);

        workers[0].send({ type: 'committed', target: 'groups', changed: true });
        expect(groups.index.reload).toHaveBeenCalledTimes(1);
        expect(onCharactersCommitted).toHaveBeenCalledTimes(1);
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
