import './node-test-servers.js';
import { closeRunRoot, openRunRoot } from './temp-run-root.js';

if (!process.env.ST_TEST_RUN_ROOT) {
    const runRoot = openRunRoot('node-test');
    process.on('exit', () => closeRunRoot(runRoot));
}
