/** Spawned by maybeStartGroupChatRestore() in restore-group-chat-migration-losses.js. */
import { workerData } from 'node:worker_threads';
import { setConfigFilePath } from '../util.js';
const { directoriesList, configPath } = workerData;
if (configPath) setConfigFilePath(configPath); // must precede importing anything that reads config
const { runOnceAtBoot } = await import('./restore-group-chat-migration-losses.js');
const { disposeMessageTreeStores } = await import('../message-tree-db.js');
const { disposeMetadataStores } = await import('../character-metadata-db.js');
try {
    for (const directories of directoriesList) {
        await runOnceAtBoot(directories);
    }
} finally {
    disposeMetadataStores();
    disposeMessageTreeStores();
}
