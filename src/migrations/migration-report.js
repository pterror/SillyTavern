import fs from 'node:fs';
import path from 'node:path';

/** Every report id the client may download. */
export const REPORT_IDS = ['unimport-embedded-lore'];

/**
 * Where a migration's full report for one user lives.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} id
 * @returns {string}
 */
export function reportPath(directories, id) {
    return path.join(directories.root, 'migration-reports', `${id}.txt`);
}

/**
 * A migration's full report, written line by line as the pass goes, so no list is held in memory. It only replaces
 * the previous report once it is closed; a pass that stops part way leaves the previous one in place.
 */
export class MigrationReport {
    /**
     * @param {import('../users.js').UserDirectoryList} directories
     * @param {string} id
     * @param {string} heading What the report lists, in plain words; its first line.
     */
    constructor(directories, id, heading) {
        this.path = reportPath(directories, id);
        this.partPath = `${this.path}.part`;
        fs.mkdirSync(path.dirname(this.path), { recursive: true });
        this.stream = fs.createWriteStream(this.partPath, { encoding: 'utf8' });
        this.lines = 0;
        this.write(heading);
        this.write('');
    }

    /**
     * @param {string} line
     */
    write(line) {
        this.stream.write(`${line}\n`);
    }

    /**
     * One entry of the report.
     * @param {string} line
     */
    add(line) {
        this.lines++;
        this.write(line);
    }

    /**
     * Finishes the report and puts it in place of the previous one.
     * @returns {Promise<void>}
     */
    async close() {
        await new Promise((resolve, reject) => {
            this.stream.once('error', reject);
            this.stream.end(resolve);
        });
        await fs.promises.rename(this.partPath, this.path);
    }

    /**
     * Drops a report that won't be finished.
     * @returns {Promise<void>}
     */
    async abandon() {
        await new Promise(resolve => this.stream.end(resolve));
        await fs.promises.rm(this.partPath, { force: true });
    }
}
