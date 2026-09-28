import { describe, test, expect } from '@jest/globals';
import { oldStyleCardId } from '../scripts/bench-search-synth.mjs';

describe('oldStyleCardId', () => {
    test('a name used 100 times gets <name>.png, then <name>1.png up to <name>99.png, all unique', () => {
        const usedIds = new Set();
        const ids = [];
        for (let i = 0; i < 100; i++) {
            const id = oldStyleCardId('Thjofe', usedIds);
            usedIds.add(id);
            ids.push(id);
        }
        expect(new Set(ids).size).toBe(100);
        expect(ids).toEqual(Array.from({ length: 100 }, (_, i) => (i === 0 ? 'Thjofe.png' : `Thjofe${i}.png`)));
    });
});
