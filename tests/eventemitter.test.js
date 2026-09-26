import { describe, test, expect, beforeAll } from '@jest/globals';

beforeAll(() => {
    // emit() reads localStorage for event tracing; the node test environment has none.
    globalThis.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
});

const { EventEmitter } = await import('../public/lib/eventemitter.js');

describe('EventEmitter auto-fire events', () => {
    test('a once listener added while the auto-fire event is being delivered still fires, once, with the emitted args', async () => {
        const emitter = new EventEmitter(['app_ready']);
        const calls = [];
        let added = false;

        emitter.on('app_ready', async () => {
            if (added) return;
            added = true;
            emitter.once('app_ready', (...args) => calls.push(args));
            await Promise.resolve();
        });

        await emitter.emit('app_ready', 'a', 1);

        expect(calls).toEqual([['a', 1]]);

        await emitter.emit('app_ready', 'b', 2);
        expect(calls).toEqual([['a', 1]]);
    });

    test('an on listener added during delivery fires once for that emit and again on the next one', async () => {
        const emitter = new EventEmitter(['app_ready']);
        const calls = [];
        let added = false;

        emitter.on('app_ready', () => {
            if (added) return;
            added = true;
            emitter.on('app_ready', (...args) => calls.push(args));
        });

        await emitter.emit('app_ready', 'x');
        expect(calls).toEqual([['x']]);

        await emitter.emit('app_ready', 'y');
        expect(calls).toEqual([['x'], ['y']]);
    });

    test('a listener added after the emit finished is fired immediately with the last emitted args', async () => {
        const emitter = new EventEmitter(['app_ready']);
        const calls = [];

        await emitter.emit('app_ready', 'z');
        emitter.once('app_ready', (...args) => calls.push(args));

        expect(calls).toEqual([['z']]);
    });
});

describe('EventEmitter ordinary events', () => {
    test('a listener added during delivery of an ordinary event does not fire for the emit in progress', async () => {
        const emitter = new EventEmitter(['app_ready']);
        const calls = [];

        emitter.on('other', () => {
            emitter.once('other', (...args) => calls.push(args));
        });

        await emitter.emit('other', 'q');
        expect(calls).toEqual([]);
    });
});
