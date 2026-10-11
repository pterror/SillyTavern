/**
 * Where the conversion's records go: a bulk load first (the library, into the empty store), then commits in order.
 * The dry run's sink counts them and writes nothing.
 */

/** Records a commit takes at most, and the encoded bytes past which it is sent. */
const COMMIT_RECORDS = 4000;
const COMMIT_BYTES = 4 << 20;
/** Commits in flight at once (the store applies them in the order sent). */
const IN_FLIGHT = 4;
/** Records handed to the bulk load per call. */
const LOAD_RECORDS = 8000;

/**
 * A rough size of a record, to bound a commit: its texts and bytes.
 * @param {Record<string, unknown>} r
 */
function sizeOf(r) {
    let n = 16;
    for (const v of Object.values(r)) {
        if (typeof v === 'string') n += v.length;
        else if (v instanceof Uint8Array) n += v.length;
    }
    return n;
}

export class Sink {
    /**
     * @param {any} store The engine's `Store`, or null for a dry run.
     */
    constructor(store) {
        this.store = store;
        /** @type {Record<string, number>} Records per kind. */
        this.kinds = {};
        this.loaded = 0;
        this.committed = 0;
        this.commits = 0;
        /** @type {object[]} */
        this.batch = [];
        this.batchBytes = 0;
        /** @type {Promise<unknown>[]} */
        this.inFlight = [];
        /** @type {any} */
        this.load = null;
        /** @type {object[]} */
        this.loadBatch = [];
        /** @type {any} */
        this.loadStats = null;
    }

    /** @param {object[]} records */
    count(records) {
        for (const r of records) {
            const kind = /** @type {any} */ (r).kind;
            this.kinds[kind] = (this.kinds[kind] ?? 0) + 1;
        }
    }

    /**
     * Adds records to the bulk load.
     * @param {object[]} records
     */
    async toLoad(records) {
        this.count(records);
        this.loaded += records.length;
        if (!this.store) return;
        this.load ??= this.store.load();
        for (const r of records) this.loadBatch.push(r);
        if (this.loadBatch.length >= LOAD_RECORDS) await this.flushLoad();
    }

    async flushLoad() {
        if (!this.load || this.loadBatch.length === 0) return;
        const batch = this.loadBatch;
        this.loadBatch = [];
        await this.load.add(batch);
    }

    /** Installs the bulk load. */
    async finishLoad() {
        if (!this.store || !this.load) return null;
        await this.flushLoad();
        this.loadStats = await this.load.finish();
        this.load = null;
        return this.loadStats;
    }

    /**
     * Adds records to be committed after everything sent before them; a commit holds whole calls' records.
     * @param {object[]} records
     */
    async commit(records) {
        this.count(records);
        this.committed += records.length;
        if (!this.store) return;
        for (const r of records) {
            this.batch.push(r);
            this.batchBytes += sizeOf(/** @type {any} */ (r));
        }
        if (this.batch.length >= COMMIT_RECORDS || this.batchBytes >= COMMIT_BYTES) await this.send();
    }

    async send() {
        if (this.batch.length === 0) return;
        const batch = this.batch;
        this.batch = [];
        this.batchBytes = 0;
        this.commits++;
        const sent = this.store.commit(batch);
        // Awaited in order below; a rejection waiting its turn isn't unhandled meanwhile.
        sent.catch(() => {});
        this.inFlight.push(sent);
        if (this.inFlight.length >= IN_FLIGHT) await this.inFlight.shift();
    }

    /** Sends what is held and waits until every commit is durable; rejects with the first one that failed. */
    async flush() {
        if (!this.store) return;
        await this.send();
        const all = this.inFlight;
        this.inFlight = [];
        await Promise.all(all);
    }
}
