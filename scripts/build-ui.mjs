// The new page's build (packages/serve-ui): `node scripts/build-ui.mjs` builds it here; `--pack <file>` also writes
// the release's file (CI); `--ensure` takes the released build, or builds when there's none (the Docker image).
import fs from 'node:fs';
import process from 'node:process';
import { buildUi, ensureUi, packUi, uiReleaseKey, uiSourceHash } from '@st/serve-ui';

const args = process.argv.slice(2);
if (args[0] === '--key') {
    console.log(uiReleaseKey(await uiSourceHash()));
} else if (args[0] === '--ensure') {
    console.log(`New page: ${await ensureUi()}`);
} else {
    await buildUi();
    if (args[0] === '--pack') fs.writeFileSync(args[1] ?? 'ui.json', await packUi());
    console.log('New page built.');
}
