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
 * @param {string} kind
 * @returns {string}
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
 * @returns {string}
 */
export function realTmpdir() {
    return process.env.ST_TEST_REAL_TMPDIR ?? os.tmpdir();
}

/**
 * @param {string} runRoot
 */
export function closeRunRoot(runRoot) {
    fs.rmSync(runRoot, { recursive: true, force: true });
}
