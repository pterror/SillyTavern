// Every test run gets one run root in the system temp folder, and TMPDIR points into it, so whatever a
// test (or a server it starts) makes with os.tmpdir() / mkdtemp lands inside it. Removing the run root
// at the end of the run removes all of it, whether or not each test cleaned up after itself.
//
// A run that dies before it can clean up (killed, crashed) leaves its run root behind. The next run
// removes those: a run root's name carries the pid of the run that made it, and one whose process is
// gone is removed. Nothing else in the temp folder is touched.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PREFIX = 'st-test-run-';

/**
 * @param {number} pid
 * @returns {boolean}
 */
function isAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return /** @type {NodeJS.ErrnoException} */ (error).code === 'EPERM';
    }
}

/**
 * Removes run roots left in `base` by runs whose process is gone.
 * @param {string} base
 */
function removeDeadRunRoots(base) {
    for (const name of fs.readdirSync(base)) {
        const match = name.startsWith(PREFIX) ? /^(\d+)-/.exec(name.slice(PREFIX.length)) : null;
        if (match && !isAlive(Number(match[1]))) {
            fs.rmSync(path.join(base, name), { recursive: true, force: true });
        }
    }
}

/**
 * Opens this process's run root and points TMPDIR into it, so child processes and test workers started
 * afterwards inherit it. Does nothing (and returns the open one) when a run root is already open, which is
 * how a test worker or subprocess that loads the same setup sees it.
 * @param {string} kind A short name for the kind of run (`jest`, `node-test`, `e2e`)
 * @returns {string} The run root
 */
export function openRunRoot(kind) {
    const open = process.env.ST_TEST_RUN_ROOT;
    if (open) {
        return open;
    }
    const base = os.tmpdir();
    removeDeadRunRoots(base);
    const runRoot = fs.mkdtempSync(path.join(base, `${PREFIX}${process.pid}-${kind}-`));
    process.env.ST_TEST_RUN_ROOT = runRoot;
    process.env.ST_TEST_REAL_TMPDIR = base;
    process.env.TMPDIR = runRoot;
    return runRoot;
}

/**
 * The temp folder outside the run root, for anything that has to outlive the run.
 * @returns {string}
 */
export function realTmpdir() {
    return process.env.ST_TEST_REAL_TMPDIR ?? os.tmpdir();
}

/**
 * Removes the run root and everything in it.
 * @param {string} runRoot
 */
export function closeRunRoot(runRoot) {
    fs.rmSync(runRoot, { recursive: true, force: true });
}
