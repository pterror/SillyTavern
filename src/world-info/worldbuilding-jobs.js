export class WorldbuildingJobs {
    /**
     * @param {{ worldbuildingJobStep: (book: bigint) => Promise<boolean>, booksWithWorldbuildingJobs: () => Promise<bigint[]> }} books
     */
    constructor(books) {
        this.books = books;
        /** @type {Map<bigint, Promise<void>>} */
        this.running = new Map();
        /** @type {Set<bigint>} */
        this.booksToRunAgain = new Set();
        this.closed = false;
    }

    /**
     * @param {bigint} book
     * @returns {Promise<void>}
     */
    start(book) {
        const running = this.running.get(book);
        if (running) {
            this.booksToRunAgain.add(book);
            return running;
        }
        const run = this.run(book).finally(() => {
            this.running.delete(book);
            if (this.booksToRunAgain.delete(book) && !this.closed) this.start(book);
        });
        this.running.set(book, run);
        return run;
    }

    /**
     * @param {bigint} book
     */
    async run(book) {
        while (!this.closed) {
            await new Promise(resolve => setImmediate(resolve));
            if (this.closed) return;
            try {
                if (!(await this.books.worldbuildingJobStep(book))) return;
            } catch (error) {
                console.error('A worldbuilding job step failed; it is tried again when the store next opens.', error);
                return;
            }
        }
    }

    async resume() {
        for (const book of await this.books.booksWithWorldbuildingJobs()) this.start(book);
    }

    async settled() {
        while (this.running.size > 0) await Promise.all([...this.running.values()]);
    }

    async close() {
        this.closed = true;
        await Promise.all([...this.running.values()]);
    }
}
