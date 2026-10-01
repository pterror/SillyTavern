import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';

/**
 * Rows a walk-and-check search path examines per request (search plan step 1b, T2). Past it the request answers
 * the rows found so far with `more` and a cursor that carries on from the last row examined.
 */
export const SEARCH_WORK_CAP = 20000;

/** Rows a walk reads and checks at a time. */
export const SEARCH_WALK_WINDOW = 1000;

/**
 * @typedef {{ type: 'character' | 'group', id: string }} WalkEntity
 * @typedef {{ c: number, g: number, n: number, e: number, s: number }} WalkPosition
 * c and g: characters and groups consumed from their streams (the SQL walk keeps its one position in c); n: rows
 * kept since the walk began, skipped ones included; e: rows examined since the walk began; s: kept rows still to
 * skip before the page starts.
 * @typedef {{ entities: WalkEntity[], position: WalkPosition, exhausted: boolean, capped: boolean, seen: { n: number, e: number, ended: boolean } }} WalkResult
 * position: where the page ends, for the cursor; exhausted: nothing kept past it; capped: the work cap stopped the
 * walk before the page was full; seen: rows kept and examined since the walk began, counting past the page for the
 * total, and whether that reached the end.
 */

/**
 * The key a cursor is bound to: a cursor made for another search, filter, sort or mode is no cursor.
 * @param {object} shape
 * @returns {string}
 */
export function walkKey(shape) {
    return crypto.createHash('sha1').update(JSON.stringify(shape)).digest('base64url').slice(0, 16);
}

/**
 * @param {string} key
 * @param {WalkPosition} position
 * @returns {string}
 */
export function encodeWalkCursor(key, position) {
    return Buffer.from(JSON.stringify({ v: 1, k: key, ...position })).toString('base64url');
}

/**
 * @param {unknown} cursor
 * @param {string} key
 * @returns {WalkPosition | null} null when absent, malformed, or made for another walk.
 */
export function decodeWalkCursor(cursor, key) {
    if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > 512) return null;
    try {
        const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        if (parsed?.v !== 1 || parsed.k !== key) return null;
        const whole = value => Number.isSafeInteger(value) && value >= 0;
        if (![parsed.c, parsed.g, parsed.n, parsed.e, parsed.s].every(whole)) return null;
        return { c: parsed.c, g: parsed.g, n: parsed.n, e: parsed.e, s: parsed.s };
    } catch {
        return null;
    }
}

/**
 * Walks a ranking in windows, checking each window, until `need` rows are kept past the skip, the ranking ends, or
 * SEARCH_WORK_CAP rows have been examined in this request.
 *
 * The ranking is characters, read SEARCH_WALK_WINDOW at a time from `fetchCharacters`, merged with `groups` (already
 * ranked and read whole, as a user's groups are few) by score, lower first, a character first on a tie.
 * @param {object} params
 * @param {(offset: number, count: number) => Promise<{ id: string, score: number }[]>} params.fetchCharacters
 * @param {{ id: string, score: number }[]} params.groups
 * @param {(batch: WalkEntity[]) => Promise<Set<string> | null>} params.check The keys (`type:id`) of the rows kept.
 * @param {number} params.need
 * @param {boolean} [params.count] Go on checking past a full page, within the cap, to count the total.
 * @param {WalkPosition} params.start
 * @param {number} [params.cap] Rows examined per request; SEARCH_WORK_CAP.
 * @param {number} [params.window] Rows read and checked at a time; SEARCH_WALK_WINDOW.
 * @returns {Promise<WalkResult | null>} null when a check couldn't be answered.
 */
export async function walkRanking({ fetchCharacters, groups, check, need, count = false, start, cap = SEARCH_WORK_CAP, window = SEARCH_WALK_WINDOW }) {
    let charBuffer = [];
    let charBufferStart = start.c;
    let charsDone = false;
    let c = start.c;
    let g = start.g;

    const nextCharacter = async () => {
        if (charsDone) return null;
        if (c - charBufferStart >= charBuffer.length) {
            charBuffer = await fetchCharacters(c, window);
            charBufferStart = c;
            if (charBuffer.length === 0) {
                charsDone = true;
                return null;
            }
        }
        return charBuffer[c - charBufferStart];
    };

    return walk({
        start,
        need,
        count,
        cap,
        check,
        nextBatch: async () => {
            /** @type {{ entity: WalkEntity, stream: 'c' | 'g' }[]} */
            const batch = [];
            while (batch.length < window) {
                const character = await nextCharacter();
                const group = g < groups.length ? groups[g] : null;
                if (!character && !group) break;
                if (character && (!group || character.score <= group.score)) {
                    batch.push({ entity: { type: 'character', id: character.id }, stream: 'c' });
                    c++;
                } else {
                    batch.push({ entity: { type: 'group', id: /** @type {{ id: string }} */ (group).id }, stream: 'g' });
                    g++;
                }
            }
            return batch;
        },
    });
}

/**
 * Walks rows in their sort order, read SEARCH_WALK_WINDOW at a time from `fetchWindow` by offset, checking each
 * window, until `need` rows are kept past the skip, the rows end, or SEARCH_WORK_CAP rows have been examined in this
 * request. Its position is kept in `c`.
 * @param {object} params
 * @param {(offset: number, count: number) => Promise<WalkEntity[] | null>} params.fetchWindow
 * @param {(batch: WalkEntity[]) => Promise<Set<string> | null>} params.check The keys (`type:id`) of the rows kept.
 * @param {number} params.need
 * @param {boolean} [params.count] Go on checking past a full page, within the cap, to count the total.
 * @param {WalkPosition} params.start
 * @param {number} [params.cap] Rows examined per request; SEARCH_WORK_CAP.
 * @param {number} [params.window] Rows read and checked at a time; SEARCH_WALK_WINDOW.
 * @returns {Promise<WalkResult | null>} null when a window or a check couldn't be answered.
 */
export async function walkSorted({ fetchWindow, check, need, count = false, start, cap = SEARCH_WORK_CAP, window = SEARCH_WALK_WINDOW }) {
    let offset = start.c;
    let ended = false;
    let failed = false;
    const result = await walk({
        start,
        need,
        count,
        cap,
        check,
        nextBatch: async () => {
            if (ended) return [];
            const rows = await fetchWindow(offset, window);
            if (rows === null) {
                failed = true;
                return [];
            }
            if (rows.length < window) ended = true;
            offset += rows.length;
            return rows.map(entity => ({ entity, stream: /** @type {'c'} */ ('c') }));
        },
    });
    return failed ? null : result;
}

/**
 * The loop both walks share. Once the page is full the position for the cursor is fixed; with `count` the walk then
 * goes on checking, within the same work cap, only to count the kept rows for the total.
 * @param {object} params
 * @param {WalkPosition} params.start
 * @param {number} params.need
 * @param {boolean} params.count
 * @param {number} params.cap
 * @param {(batch: WalkEntity[]) => Promise<Set<string> | null>} params.check
 * @param {() => Promise<{ entity: WalkEntity, stream: 'c' | 'g' }[]>} params.nextBatch
 * @returns {Promise<WalkResult | null>}
 */
async function walk({ start, need, count, cap, check, nextBatch }) {
    /** @type {WalkEntity[]} */
    const entities = [];
    const position = { ...start };
    /** @type {WalkPosition | null} */
    let pageEnd = null;
    const seen = { n: start.n, e: start.e };
    let examined = 0;
    const finish = (ended, capped) => ({
        entities,
        position: pageEnd ?? position,
        // Nothing kept past where the page ends.
        exhausted: ended && seen.n === (pageEnd ?? position).n,
        capped: capped && pageEnd === null,
        seen: { ...seen, ended },
    });
    for (;;) {
        if (pageEnd === null && entities.length >= need) {
            pageEnd = { ...position };
            if (!count) return finish(false, false);
        }
        if (examined >= cap) return finish(false, true);
        const batch = await nextBatch();
        if (batch.length === 0) return finish(true, false);
        const kept = await check(batch.map(item => item.entity));
        if (kept === null) return null;
        for (const { entity, stream } of batch) {
            const isKept = kept.has(`${entity.type}:${entity.id}`);
            examined++;
            seen.e++;
            if (isKept) seen.n++;
            if (pageEnd !== null) continue;
            position[stream]++;
            position.e++;
            if (!isKept) continue;
            position.n++;
            if (position.s > 0) {
                position.s--;
                continue;
            }
            entities.push(entity);
            if (entities.length >= need) {
                pageEnd = { ...position };
                if (!count) return finish(false, false);
            }
        }
    }
}

/**
 * The total a walk can give: exact once it has checked every row, otherwise `base` (every row the walk could
 * examine) scaled by the share of examined rows kept, never below the rows already kept.
 * @param {WalkResult['seen']} seen
 * @param {number} base
 * @returns {{ total: number, approx: boolean }}
 */
export function walkTotal(seen, base) {
    if (seen.ended) return { total: seen.n, approx: false };
    const estimate = seen.e > 0 ? Math.round(base * (seen.n / seen.e)) : base;
    return { total: Math.max(seen.n, estimate), approx: true };
}
