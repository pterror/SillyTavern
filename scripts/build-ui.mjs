import fs from 'node:fs';
import process from 'node:process';
import { buildUi, ensureUi, packUi, uiReleaseKey, uiSourceHash } from '@st/serve-ui';

const args = process.argv.slice(2);
if (args[0] === '--key') {
    console.log(uiReleaseKey(await uiSourceHash()));
} else if (args[0] === '--ensure') {
    try {
        console.log(`New page: ${await ensureUi()}`);
    } catch (error) {
        console.error(String(error instanceof Error ? error.message : error));
        process.exit(2);
    }
} else {
    await buildUi();
    if (args[0] === '--pack') fs.writeFileSync(args[1] ?? 'ui.json', await packUi());
    console.log('New page built.');
}
