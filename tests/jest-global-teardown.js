import { closeRunRoot } from './util/temp-run-root.js';

export default function globalTeardown() {
    const runRoot = process.env.ST_TEST_RUN_ROOT;
    if (runRoot) {
        closeRunRoot(runRoot);
    }
}
