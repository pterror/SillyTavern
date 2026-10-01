// Removes the e2e run root when the process that opened it exits. It hangs off process exit rather than a
// reporter, because a reporter given on the command line (`--reporter=line`) replaces the configured ones,
// and the run root would then never be removed.
//
// Before removing it, the data roots of workers that had a failing test or didn't finish (a server that
// failed to start, a crash) are moved out for inspection, and where each went is printed. If the seed
// never finished building (global setup failed), the seed is kept instead.
import fs from 'node:fs';
import path from 'node:path';
import { closeRunRoot, realTmpdir } from './util/temp-run-root.js';

export const FAILED_MARKER = 'E2E-FAILED';
export const WORKER_DONE_MARKER = 'E2E-WORKER-DONE';
export const SEED_DONE_MARKER = 'E2E-SEED-DONE';

/**
 * @param {string} runRoot
 * @returns {string[]} The data roots worth keeping
 */
function rootsToKeep(runRoot) {
    const seed = path.join(runRoot, 'seed');
    if (fs.existsSync(seed) && !fs.existsSync(path.join(seed, SEED_DONE_MARKER))) {
        return [seed];
    }
    return fs.readdirSync(runRoot)
        .filter(name => name.startsWith('worker-'))
        .map(name => path.join(runRoot, name))
        .filter(root => fs.existsSync(path.join(root, FAILED_MARKER))
            || !fs.existsSync(path.join(root, WORKER_DONE_MARKER)));
}

/**
 * Moves out the data roots worth keeping, prints where they went, and removes the run root.
 * @param {string} runRoot
 */
function closeE2ERunRoot(runRoot) {
    if (!fs.existsSync(runRoot)) {
        return;
    }
    const keep = rootsToKeep(runRoot);
    if (keep.length > 0) {
        const keptRoot = fs.mkdtempSync(path.join(realTmpdir(), 'st-e2e-kept-'));
        const lines = keep.map(root => {
            const destination = path.join(keptRoot, path.basename(root));
            fs.renameSync(root, destination);
            const failedPath = path.join(destination, FAILED_MARKER);
            const why = fs.existsSync(failedPath)
                ? fs.readFileSync(failedPath, 'utf8').trim().split('\n').map(line => `    ${line}`).join('\n')
                : path.basename(root) === 'seed'
                    ? '    (the seed did not finish building)'
                    : '    (no test failed here; the worker did not finish)';
            return `  ${destination}\n${why}`;
        });
        console.log(`e2e run did not pass; kept for inspection:\n${lines.join('\n')}`);
    }
    closeRunRoot(runRoot);
}

/**
 * Removes `runRoot` when this process exits. Call it only in the process that opened the run root.
 * @param {string} runRoot
 */
export function closeE2ERunRootOnExit(runRoot) {
    process.on('exit', () => closeE2ERunRoot(runRoot));
}
