// Deletes the throwaway data root only after a fully passing run; anything else (failed, interrupted,
// timedout) keeps it for debugging. Playwright calls onEnd after the webServer is already stopped, and
// the deletion waits for process exit so it always runs after everything else.
import fs from 'node:fs';

export default class E2EDataRootReporter {
    /** @type {import('@playwright/test/reporter').FullResult['status'] | undefined} */
    status;

    constructor() {
        const dataRoot = process.env.ST_E2E_DATA_ROOT;
        process.on('exit', () => {
            if (this.status === 'passed') {
                fs.rmSync(dataRoot, { recursive: true, force: true });
            } else {
                console.log(`e2e run did not pass; data root kept at ${dataRoot}`);
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
