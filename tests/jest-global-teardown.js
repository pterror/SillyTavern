// Removes the run root, and with it every temp folder the run made.
import { closeRunRoot } from './util/temp-run-root.js';

export default function globalTeardown() {
    const runRoot = process.env.ST_TEST_RUN_ROOT;
    if (runRoot) {
        closeRunRoot(runRoot);
    }
}
