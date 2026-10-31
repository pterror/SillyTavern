export const LAST_USED_GRANULARITY_MS = 24 * 60 * 60 * 1000;
export const TOKEN_COUNT_ROW_CAP = 1_000_000;
export const PRUNE_BATCH_ROWS = 5000;
export const PRUNE_PAUSE_MS = 50;

export const TABLE = Object.freeze({ counts: 0, ids: 1 });

/**
 * @param {Buffer} b
 * @param {{ at: number }} p
 */
function readVarint(b, p) {
    let n = 0;
    let shift = 1;
    for (;;) {
        const c = b[p.at++];
        n += (c & 0x7f) * shift;
        if (c < 0x80) return n;
        shift *= 128;
    }
}

/**
 * @param {number[]} out
 * @param {number} n
 */
function pushVarint(out, n) {
    while (n >= 0x80) {
        out.push((n % 128) | 0x80);
        n = Math.floor(n / 128);
    }
    out.push(n);
}

/** @param {number} count */
function countBytes(count) {
    const out = [];
    pushVarint(out, count);
    return Buffer.from(out);
}

/**
 * @param {ArrayLike<number>} ids
 * @param {string[] | null} chunks
 */
function idsBytes(ids, chunks) {
    const out = [chunks === null ? 0 : 1];
    pushVarint(out, ids.length);
    for (const id of Array.from(ids)) pushVarint(out, id);
    const head = Buffer.from(out);
    return chunks === null ? head : Buffer.concat([head, Buffer.from(JSON.stringify(chunks), 'utf8')]);
}

/** @param {Buffer} b */
function idsOf(b) {
    const p = { at: 1 };
    const n = readVarint(b, p);
    const ids = [];
    for (let i = 0; i < n; i++) ids.push(readVarint(b, p));
    return { ids, chunks: b[0] === 1 ? JSON.parse(b.subarray(p.at).toString('utf8')) : null };
}

/** @typedef {{ cap: number, batchRows: number, pauseMs: number }} TokenTableLimits */

export class TokenCache {
    /**
     * @param {any} store
     * @param {TokenTableLimits} [limits]
     */
    constructor(store, limits = { cap: TOKEN_COUNT_ROW_CAP, batchRows: PRUNE_BATCH_ROWS, pauseMs: PRUNE_PAUSE_MS }) {
        this.store = store;
        this.limits = limits;
        /** @type {Map<number, Promise<void>>} */
        this.evicting = new Map();
    }

    /**
     * @param {number} table
     * @param {string} identity
     * @param {string} hash
     */
    async read(table, identity, hash) {
        return this.store.chatRead('tokenCache', { table, identity, hash: Buffer.from(hash, 'hex') });
    }

    /**
     * @param {string} identity
     * @param {string} hash
     * @returns {Promise<number | null>}
     */
    async readCount(identity, hash) {
        const found = await this.read(TABLE.counts, identity, hash);
        return found === null ? null : readVarint(Buffer.from(found.value), { at: 0 });
    }

    /**
     * @param {string} identity
     * @param {string} hash
     * @returns {Promise<{ ids: number[], chunks: string[] | null } | null>}
     */
    async readIdsRow(identity, hash) {
        const found = await this.read(TABLE.ids, identity, hash);
        return found === null ? null : idsOf(Buffer.from(found.value));
    }

    /**
     * @param {import('./token-count-store.js').PendingTokenRows} pending
     * @param {number} [now]
     * @returns {Promise<{ prunesScheduled: ('token_counts' | 'token_ids')[] }>}
     */
    async writeBack({ counts = [], ids = [] }, now = Date.now()) {
        const puts = counts.map(({ identity, hash, count, replace = false }) => ({ table: TABLE.counts, identity, hash: Buffer.from(hash, 'hex'), value: countBytes(count), replace }));
        for (const { identity, hash, ids: tokenIds, chunks = null } of ids) {
            const stored = chunks === null ? null : await this.readIdsRow(identity, hash);
            const fill = stored !== null && stored.chunks === null;
            puts.push({ table: TABLE.ids, identity, hash: Buffer.from(hash, 'hex'), value: fill ? idsBytes(stored.ids, chunks) : idsBytes(tokenIds, chunks), replace: fill });
        }
        /** @type {('token_counts' | 'token_ids')[]} */
        const prunesScheduled = [];
        if (!puts.length) return { prunesScheduled };
        await this.store.tokenCachePut(puts, now, LAST_USED_GRANULARITY_MS);
        for (const [table, name] of /** @type {const} */ ([[TABLE.counts, 'token_counts'], [TABLE.ids, 'token_ids']])) {
            if (!puts.some(p => p.table === table) || this.evicting.has(table)) continue;
            if (await this.store.chatRead('tokenCacheCount', { table }) <= this.limits.cap) continue;
            this.evicting.set(table, this.evict(table).finally(() => this.evicting.delete(table)));
            prunesScheduled.push(name);
        }
        return { prunesScheduled };
    }

    /**
     * @param {number} table
     */
    async evict(table) {
        while (await this.store.tokenCacheEvict(table, this.limits.cap, this.limits.batchRows)) {
            await new Promise(resolve => setTimeout(resolve, this.limits.pauseMs));
        }
    }

    async idle() {
        while (this.evicting.size) await Promise.all(this.evicting.values());
    }
}
