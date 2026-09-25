import { describe, test, expect, jest, beforeEach } from '@jest/globals';

const ENV_KEY = 'SILLYTAVERN_PERFORMANCE_SEARCHTIMING';

// The flag is cached on first use, so each test loads a fresh copy of the module.
async function loadWithFlag(value) {
    process.env[ENV_KEY] = value;
    jest.resetModules();
    return await import('../src/search-timing.js');
}

function fakeResponse() {
    const headers = new Map();
    const sent = [];
    const send = function (body) {
        sent.push(body);
        return this;
    };
    return {
        headers,
        sent,
        originalSend: send,
        send,
        set(name, value) { headers.set(name.toLowerCase(), value); return this; },
        get(name) { return headers.get(name.toLowerCase()); },
    };
}

function parseServerTiming(header) {
    return header.split(', ').map(entry => {
        const [name, dur] = entry.split(';dur=');
        return { name, dur: Number(dur) };
    });
}

describe('search-timing, flag off', () => {
    let mod;
    beforeEach(async () => {
        mod = await loadWithFlag('false');
    });

    test('withSearchTiming just calls fn and leaves send untouched', async () => {
        const res = fakeResponse();
        const result = await mod.withSearchTiming(res, async () => {
            mod.markSinceStart('prologue');
            mod.addPhase('x', 5);
            expect(mod.timePhase('y', () => 42)).toBe(42);
            res.send({ a: 1 });
            return 'done';
        });
        expect(result).toBe('done');
        expect(res.send).toBe(res.originalSend);
        expect(res.sent).toEqual([{ a: 1 }]);
        expect(res.headers.has('server-timing')).toBe(false);
    });
});

describe('search-timing, flag on', () => {
    let mod;
    beforeEach(async () => {
        mod = await loadWithFlag('true');
    });

    test('records sync, async, throwing and repeated phases, with handler last', async () => {
        const res = fakeResponse();
        await mod.withSearchTiming(res, async () => {
            mod.markSinceStart('prologue');
            expect(mod.timePhase('sync', () => 1)).toBe(1);
            expect(await mod.timePhase('async', async () => 2)).toBe(2);
            await expect(mod.timePhase('rejects', async () => { throw new Error('r'); })).rejects.toThrow('r');
            expect(() => mod.timePhase('throws', () => { throw new Error('t'); })).toThrow('t');
            mod.addPhase('repeat', 1.5);
            mod.addPhase('repeat', 2.25);
            res.send(Buffer.from('x'));
        });
        const phases = parseServerTiming(res.get('Server-Timing'));
        expect(phases.map(p => p.name)).toEqual(['prologue', 'sync', 'async', 'rejects', 'throws', 'repeat', 'handler']);
        expect(phases.find(p => p.name === 'repeat').dur).toBeCloseTo(3.75, 3);
        expect(res.get('Server-Timing')).toMatch(/^prologue;dur=\d+\.\d{3}, /);
        expect(Buffer.isBuffer(res.sent[0])).toBe(true);
    });

    test('an object body is stringified once, timed as serialize, and gets a JSON content type', async () => {
        const res = fakeResponse();
        await mod.withSearchTiming(res, async () => {
            res.send({ a: 1 });
        });
        expect(res.sent).toEqual(['{"a":1}']);
        expect(res.get('Content-Type')).toBe('application/json; charset=utf-8');
        expect(parseServerTiming(res.get('Server-Timing')).map(p => p.name)).toEqual(['serialize', 'handler']);
    });

    test('an existing content type is kept', async () => {
        const res = fakeResponse();
        await mod.withSearchTiming(res, async () => {
            res.set('Content-Type', 'text/plain');
            res.send({ a: 1 });
        });
        expect(res.get('Content-Type')).toBe('text/plain');
    });

    test('only the first send is instrumented', async () => {
        const res = fakeResponse();
        await mod.withSearchTiming(res, async () => {
            res.send('first');
            res.set('Server-Timing', 'cleared');
            res.send({ b: 2 });
        });
        expect(res.sent).toEqual(['first', { b: 2 }]);
        expect(res.get('Server-Timing')).toBe('cleared');
    });

    test('timing calls outside withSearchTiming are pass-throughs', () => {
        expect(mod.timePhase('x', () => 7)).toBe(7);
        mod.markSinceStart('y');
        mod.addPhase('z', 1);
    });
});
