import fs from 'node:fs';
import path from 'node:path';
import { closeRunRoot, realTmpdir } from './util/temp-run-root.js';

export const FAILED_MARKER = 'E2E-FAILED';
export const WORKER_DONE_MARKER = 'E2E-WORKER-DONE';
export const SEED_DONE_MARKER = 'E2E-SEED-DONE';

/**
 * @param {string} runRoot
 * @returns {string[]}
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
 * @param {string} runRoot
 */
export function closeE2ERunRootOnExit(runRoot) {
    process.on('exit', () => closeE2ERunRoot(runRoot));
}
