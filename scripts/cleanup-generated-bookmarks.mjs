import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupGeneratedBookmarks } from '../src/generated-bookmark-cleanup.js';

const args = process.argv.slice(2);
if (args[0] !== '--data-root' || !args[1] || args.length > 3 || (args[2] !== undefined && args[2] !== '--apply')) {
    console.error('Usage: node scripts/cleanup-generated-bookmarks.mjs --data-root <folder> [--apply]\nStop the server first. Defaults to counting matches; --apply deletes matching bookmarks, keeping messages.');
    process.exit(2);
}
const { setConfigFilePath } = await import('../src/util.js');
setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const { loadEngine } = await import('../engine/load.js');
const { LibraryEngine } = await import('../src/library-engine.js');
const engine = loadEngine().binding;
const apply = args[2] === '--apply';
let matched = 0;
for (const entry of fs.readdirSync(args[1], { withFileTypes: true })) {
    const dir = path.join(args[1], entry.name, 'store');
    if (!entry.isDirectory() || !fs.existsSync(dir)) continue;
    const lib = await LibraryEngine.open(engine, dir);
    try {
        matched += await cleanupGeneratedBookmarks(lib.store, { apply });
    } finally {
        await lib.close();
    }
}
console.log(`${apply ? 'Deleted' : 'Matched'} ${matched} generated bookmarks. Messages are retained.`);
