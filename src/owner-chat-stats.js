import { setOwnerWriteHandler } from './message-tree-db.js';
import { applyCharacterChatStats, applyGroupChatStats } from './character-metadata-db.js';

/**
 * Makes every committed message tree write update its owner's chat stats in the metadata store.
 */
export function installOwnerChatStatsHook() {
    setOwnerWriteHandler(async (write) => {
        const directories = /** @type {import('./users.js').UserDirectoryList} */ (write.directories);
        if (write.kind === 'character') {
            await applyCharacterChatStats(directories, write.rowId, write);
        } else if (write.kind === 'group') {
            await applyGroupChatStats(directories, write.rowId, write);
        }
    });
}
