import { LOOP_CHECK_VISITS_PER_WRITE } from '@st/worldbuilding/protocol';

/**
 * @typedef {{ entry: string, kind: string, entries: string[] }} UnreachedLoop
 * @typedef {'relations' | 'names' | 'entries'} Touched
 */

/**
 * @typedef {object} JobSteps
 * @property {() => Promise<{ book: bigint, changedSources: bigint[], unreachedLoops?: UnreachedLoop[], touched: Touched } | null>} worldbuildingJobStep
 * @property {() => Promise<boolean>} anyWorldbuildingJob
 * @property {(book: bigint, records: object[], alsoChanged: bigint[]) => Promise<UnreachedLoop[]>} unreachedLoops
 */


export class WorldbuildingJobs {
    /**
     * @param {JobSteps} books
     */
    constructor(books) {
        this.books = books;
        /** @type {Promise<void> | null} */
        this.running = null;
        this.runAgain = false;
        this.closed = false;
        /** @type {Map<bigint, UnreachedLoop[]>} */
        this.loopsLeftByWorld = new Map();
        /** @type {Set<bigint>} */
        this.worldsWithJobsSinceStart = new Set();
        /** @type {((book: bigint, touched: Touched) => void) | null} */
        this.onStepDone = null;
    }

    /**
     * @param {bigint} [book]
     * @returns {Promise<void>}
     */
    start(book) {
        if (book !== undefined && !this.worldsWithJobsSinceStart.has(book)) {
            this.worldsWithJobsSinceStart.add(book);
            this.loopsLeftByWorld.set(book, []);
        }
        if (this.running) {
            this.runAgain = true;
            return this.running;
        }
        this.running = this.run().finally(() => {
            this.running = null;
            if (this.runAgain && !this.closed) {
                this.runAgain = false;
                this.start();
            }
        });
        return this.running;
    }

    async run() {
        while (!this.closed) {
            await new Promise(resolve => setImmediate(resolve));
            if (this.closed) return;
            let step;
            try {
                step = await this.books.worldbuildingJobStep();
            } catch (error) {
                console.error('A worldbuilding job step failed; it is tried again when the store next opens.', error);
                return;
            }
            if (!step) {
                this.worldsWithJobsSinceStart.clear();
                return;
            }
            const loops = step.unreachedLoops ?? (step.changedSources.length === 0 ? [] : await this.books.unreachedLoops(step.book, [], step.changedSources));
            if (loops.length > 0) {
                const kept = this.loopsLeftByWorld.get(step.book) ?? [];
                kept.push(...loops);
                this.loopsLeftByWorld.set(step.book, kept.slice(-LOOP_CHECK_VISITS_PER_WRITE));
            }
            this.onStepDone?.(step.book, step.touched);
        }
    }

    /**
     * @param {bigint} book
     * @returns {UnreachedLoop[]}
     */
    loopsLeft(book) {
        return this.loopsLeftByWorld.get(book) ?? [];
    }

    async resume() {
        if (await this.books.anyWorldbuildingJob()) this.start();
    }

    async settled() {
        while (this.running) await this.running;
    }

    async close() {
        this.closed = true;
        if (this.running) await this.running;
    }
}
