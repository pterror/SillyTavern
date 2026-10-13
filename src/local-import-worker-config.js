import { workerData } from 'node:worker_threads';

import { setConfigFilePath } from './util.js';

/**
 * Gives a local import worker thread the main thread's config file path. Imported first by the worker, so the modules
 * it imports after it can read config values as they load.
 */
if (typeof workerData?.configFilePath === 'string') {
    setConfigFilePath(workerData.configFilePath);
}
