// Removes the run root once the run is over. A run that didn't pass first moves out, for inspection, the
// data roots of workers that had a failing test or didn't finish (a server that failed to start, a crash),
// and prints where each went. If no worker root qualifies (setup itself failed), the seed is kept instead.
// The removal waits for process exit so it runs after the workers have stopped their servers.
import fs from 'node:fs';
import path from 'node:path';
import { closeRunRoot, realTmpdir } from './util/temp-run-root.js';

export const FAILED_MARKER = 'E2E-FAILED';
export const WORKER_DONE_MARKER = 'E2E-WORKER-DONE';

/**
 * @param {string} runRoot
 * @returns {string[]} The worker data roots worth keeping
 */
function rootsToKeep(runRoot) {
    const workerRoots = fs.readdirSync(runRoot)
        .filter(name => name.startsWith('worker-'))
        .map(name => path.join(runRoot, name));
    const kept = workerRoots.filter(root => fs.existsSync(path.join(root, FAILED_MARKER))
        || !fs.existsSync(path.join(root, WORKER_DONE_MARKER)));
    const seed = path.join(runRoot, 'seed');
    return kept.length === 0 && fs.existsSync(seed) ? [seed] : kept;
}

export default class E2ERunRootReporter {
    /** @type {import('@playwright/test/reporter').FullResult['status'] | undefined} */
    status;

    constructor() {
        const runRoot = /** @type {string} */ (process.env.ST_E2E_RUN_ROOT);
        process.on('exit', () => {
            if (this.status !== 'passed' && fs.existsSync(runRoot)) {
                const keptRoot = fs.mkdtempSync(path.join(realTmpdir(), 'st-e2e-kept-'));
                const lines = rootsToKeep(runRoot).map(root => {
                    const destination = path.join(keptRoot, path.basename(root));
                    fs.renameSync(root, destination);
                    const failedPath = path.join(destination, FAILED_MARKER);
                    const failed = fs.existsSync(failedPath)
                        ? fs.readFileSync(failedPath, 'utf8').trim().split('\n').map(line => `    ${line}`).join('\n')
                        : '    (no test failed here; the worker did not finish)';
                    return `  ${destination}\n${failed}`;
                });
                console.log(`e2e run did not pass (${this.status}); kept for inspection:\n${lines.join('\n')}`);
            }
            closeRunRoot(runRoot);
        });
    }

    /** @param {import('@playwright/test/reporter').FullResult} result */
    onEnd(result) {
        this.status = result.status;
    }

    printsToStdio() {
        return false;
    }
}
