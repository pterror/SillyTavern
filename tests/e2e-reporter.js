// Deletes the throwaway run root only after a fully passing run; anything else (failed, interrupted,
// timedout) keeps it for debugging. The deletion waits for process exit so it runs after the workers
// have stopped their servers.
import fs from 'node:fs';

export default class E2ERunRootReporter {
    /** @type {import('@playwright/test/reporter').FullResult['status'] | undefined} */
    status;

    constructor() {
        const runRoot = process.env.ST_E2E_RUN_ROOT;
        process.on('exit', () => {
            if (this.status === 'passed') {
                fs.rmSync(runRoot, { recursive: true, force: true });
            } else {
                console.log(`e2e run did not pass; run root kept at ${runRoot}`);
            }
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
