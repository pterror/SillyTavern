import { describe, test, expect } from '@jest/globals';
import { walkRanking, walkSorted, walkKey, encodeWalkCursor, decodeWalkCursor, walkTotal } from '../src/endpoints/search-walk.js';

// The walk-and-check search paths (search plan step 1b, T2): each request examines at most `cap` rows, and a capped
// request hands back a cursor that carries on from the last row examined.

const START = { c: 0, g: 0, n: 0, e: 0, s: 0 };

/** Characters c0..c(n-1) with rising scores (lower ranks first), and a keep rule. */
function ranking(count, keep) {
    const characters = Array.from({ length: count }, (_, i) => ({ id: `c${i}`, score: i }));
    let read = 0;
    return {
        fetchCharacters: async (offset, window) => {
            const hits = characters.slice(offset, offset + window);
            read += hits.length;
            return hits;
        },
        check: async batch => new Set(batch.filter(entity => keep(entity.id)).map(entity => `${entity.type}:${entity.id}`)),
        read: () => read,
    };
}

/** Every kept id a sequence of capped requests returns, following each cursor, for one page size. */
async function followAll(makeWalk, need) {
    const ids = [];
    let start = START;
    let requests = 0;
    for (;;) {
        const walked = await makeWalk(start, need);
        requests++;
        ids.push(...walked.entities.map(entity => entity.id));
        if (walked.exhausted) return { ids, requests };
        start = walked.position;
        expect(requests).toBeLessThan(1000);
    }
}

describe('walkRanking', () => {
    test('a rare match: each request examines at most the cap, says more, and following the cursors finds every kept row once', async () => {
        const keep = id => Number(id.slice(1)) % 97 === 0;
        const source = ranking(1000, keep);
        const expected = Array.from({ length: 1000 }, (_, i) => `c${i}`).filter(keep);

        const first = await walkRanking({ ...source, groups: [], need: 50, start: START, cap: 100, window: 10 });
        expect(first.capped).toBe(true);
        expect(first.exhausted).toBe(false);
        expect(first.entities.map(e => e.id)).toEqual(['c0', 'c97']);
        expect(first.position.e).toBe(100);

        const { ids } = await followAll((start, need) => walkRanking({ ...ranking(1000, keep), groups: [], need, start, cap: 100, window: 10 }), 50);
        expect(ids).toEqual(expected);
    });

    test('a full page stops at its last row: the cursor carries on from the row after it, for any page size', async () => {
        const keep = id => Number(id.slice(1)) % 3 === 0;
        const expected = Array.from({ length: 200 }, (_, i) => `c${i}`).filter(keep);
        for (const need of [1, 7, 10, 67]) {
            const { ids } = await followAll((start, n) => walkRanking({ ...ranking(200, keep), groups: [], need: n, start, cap: 50, window: 8 }), need);
            expect({ need, ids }).toEqual({ need, ids: expected });
        }
    });

    test('groups merge in by score, a character first on a tie', async () => {
        const source = ranking(4, () => true);
        const groups = [{ id: 'g0', score: 0 }, { id: 'g1', score: 2.5 }, { id: 'g2', score: 99 }];
        const check = async batch => new Set(batch.map(e => `${e.type}:${e.id}`));
        const walked = await walkRanking({ fetchCharacters: source.fetchCharacters, groups, check, need: 10, start: START, cap: 100, window: 2 });
        expect(walked.entities.map(e => e.id)).toEqual(['c0', 'g0', 'c1', 'c2', 'g1', 'c3', 'g2']);
        expect(walked.exhausted).toBe(true);
    });

    test('a skip (a page jumped to with no cursor) counts kept rows, and a skip the cap stops short of carries on in the cursor', async () => {
        const keep = id => Number(id.slice(1)) % 10 === 0;
        const first = await walkRanking({ ...ranking(1000, keep), groups: [], need: 5, start: { ...START, s: 20 }, cap: 100, window: 10 });
        expect(first.entities).toEqual([]);
        expect(first.capped).toBe(true);
        expect(first.position.s).toBe(10);
        const { ids } = await followAll((start, n) => walkRanking({ ...ranking(1000, keep), groups: [], need: n, start: start === START ? { ...START, s: 20 } : start, cap: 100, window: 10 }), 5);
        expect(ids.slice(0, 5)).toEqual(['c200', 'c210', 'c220', 'c230', 'c240']);
    });

    test('counting for the total goes on past a full page within the cap, without moving the cursor', async () => {
        const keep = id => Number(id.slice(1)) % 2 === 0;
        const exact = await walkRanking({ ...ranking(40, keep), groups: [], need: 3, count: true, start: START, cap: 100, window: 10 });
        expect(exact.entities.map(e => e.id)).toEqual(['c0', 'c2', 'c4']);
        expect(exact.position.c).toBe(5);
        expect(exact.exhausted).toBe(false);
        expect(walkTotal(exact.seen, 40)).toEqual({ total: 20, approx: false });

        const estimated = await walkRanking({ ...ranking(1000, keep), groups: [], need: 3, count: true, start: START, cap: 100, window: 10 });
        expect(estimated.position.c).toBe(5);
        expect(estimated.seen).toEqual({ n: 50, e: 100, ended: false });
        expect(walkTotal(estimated.seen, 1000)).toEqual({ total: 500, approx: true });
    });

    test('a failed check fails the walk', async () => {
        const source = ranking(10, () => true);
        expect(await walkRanking({ fetchCharacters: source.fetchCharacters, groups: [], check: async () => null, need: 5, start: START })).toBeNull();
    });
});

describe('walkSorted', () => {
    test('walks windows by offset under the cap, and the cursors cover every kept row once', async () => {
        const rows = Array.from({ length: 333 }, (_, i) => ({ type: /** @type {'character'} */ ('character'), id: `r${i}` }));
        const keep = id => Number(id.slice(1)) % 7 === 3;
        const makeWalk = (start, need) => walkSorted({
            fetchWindow: async (offset, window) => rows.slice(offset, offset + window),
            check: async batch => new Set(batch.filter(e => keep(e.id)).map(e => `${e.type}:${e.id}`)),
            need, start, cap: 40, window: 16,
        });
        const first = await makeWalk(START, 100);
        expect(first.capped).toBe(true);
        expect(first.position.e).toBeLessThanOrEqual(48);
        const { ids } = await followAll(makeWalk, 100);
        expect(ids).toEqual(rows.map(r => r.id).filter(keep));
    });

    test('a window that can\'t be read fails the walk', async () => {
        expect(await walkSorted({ fetchWindow: async () => null, check: async () => new Set(), need: 1, start: START })).toBeNull();
    });
});

describe('walk cursors', () => {
    test('a cursor round-trips under its key, and is no cursor under another key or when malformed', () => {
        const key = walkKey({ mode: 'rank', searchTerm: 'a', filter: { tags: { include: ['t1'] } } });
        const position = { c: 12, g: 3, n: 4, e: 15, s: 0 };
        const cursor = encodeWalkCursor(key, position);
        expect(decodeWalkCursor(cursor, key)).toEqual(position);
        expect(decodeWalkCursor(cursor, walkKey({ mode: 'rank', searchTerm: 'b', filter: { tags: { include: ['t1'] } } }))).toBeNull();
        for (const bad of [undefined, '', 'not-base64-json', 42, 'x'.repeat(600), encodeWalkCursor(key, { ...position, c: -1 })]) {
            expect(decodeWalkCursor(bad, key)).toBeNull();
        }
    });
});
