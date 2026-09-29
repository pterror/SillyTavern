import { setOwnerWriteHandler } from './message-tree-db.js';
import { applyCharacterChatStats } from './character-metadata-db.js';

/**
 * Makes every committed message tree write update its owner's chat stats in the metadata store.
 */
export function installOwnerChatStatsHook() {
    setOwnerWriteHandler(async (write) => {
        if (write.kind !== 'character') return;
        await applyCharacterChatStats(/** @type {import('./users.js').UserDirectoryList} */ (write.directories), write.rowId, write);
    });
}
