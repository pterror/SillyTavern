import { color } from './util.js';

export const PROGRESS_INTERVAL_MS = 10_000;

/**
 * @param {number} n
 * @returns {string}
 */
function count(n) {
    return Math.round(n).toLocaleString('en-US');
}

/**
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
    const seconds = Math.max(0, Math.round(ms / 1000));
    if (seconds < 60) return `${seconds} s`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

export class ProgressLog {
    /**
     * @param {object} options
     * @param {string} options.what
     * @param {number | null} [options.total]
     * @param {(line: string) => void} [options.log]
     * @param {number} [options.intervalMs]
     * @param {() => number} [options.now]
     */
    constructor({ what, total = null, log = console.log, intervalMs = PROGRESS_INTERVAL_MS, now = Date.now }) {
        this.what = what;
        this.total = total;
        this.done = 0;
        this.log = log;
        this.intervalMs = intervalMs;
        this.now = now;
        this.started = now();
        this.lastLine = this.started;
    }

    /**
     * @param {number | null} total
     */
    setTotal(total) {
        this.total = total;
    }

    /**
     * @param {number} [n]
     */
    add(n = 1) {
        this.done += n;
        const at = this.now();
        if (at - this.lastLine < this.intervalMs) return;
        this.lastLine = at;
        this.log(color.cyan(this.progressLine(at)));
    }

    /**
     * @param {number} at
     * @returns {string}
     */
    progressLine(at) {
        if (this.total === null || this.total <= 0) {
            return `${this.what}: ${count(this.done)} so far`;
        }
        const done = Math.min(this.done, this.total);
        const percent = Math.floor(done / this.total * 100);
        let line = `${this.what}: ${count(done)} of ${count(this.total)} (${percent}%)`;
        const elapsed = at - this.started;
        if (done > 0 && done < this.total && elapsed > 0) {
            const left = (this.total - done) * elapsed / done;
            line += `, about ${formatDuration(left)} left`;
        }
        return line;
    }

    /**
     * @param {string} [extra]
     */
    finish(extra = '') {
        const took = formatDuration(this.now() - this.started);
        this.log(color.green(`${this.what}: done, ${count(this.done)} in ${took}${extra ? `, ${extra}` : ''}`));
    }
}
