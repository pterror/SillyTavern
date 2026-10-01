// Preload for `node --test` (see the root package.json's test:src): the test runner opens the run root and
// removes it when it exits; the per-file test processes it starts inherit TMPDIR and load this as a no-op.
import { closeRunRoot, openRunRoot } from './temp-run-root.js';

if (!process.env.ST_TEST_RUN_ROOT) {
    const runRoot = openRunRoot('node-test');
    process.on('exit', () => closeRunRoot(runRoot));
}
