import { workerData } from 'node:worker_threads';

import { setConfigFilePath } from './util.js';

if (typeof workerData?.configFilePath === 'string') {
    setConfigFilePath(workerData.configFilePath);
}
