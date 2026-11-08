import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = 'Usage: node scripts/worldbuilding-cutover.mjs --data-root <data folder>\nRun it once, with the server stopped (the store has no lock against a second process), before the server runs this engine. Running it again changes nothing.';

const args = process.argv.slice(2);
const at = args.indexOf('--data-root');
const dataRoot = at === -1 ? undefined : args[at + 1];
if (!dataRoot || args.length !== 2) {
    console.error(USAGE);
    process.exit(2);
}

const { setConfigFilePath } = await import('../src/util.js');
setConfigFilePath(path.join(ROOT, 'default', 'config.yaml'));
const { loadEngine } = await import('../engine/load.js');
const { LibraryEngine } = await import('../src/library-engine.js');

const engine = loadEngine().binding;
const users = fs.readdirSync(dataRoot, { withFileTypes: true })
    .filter(d => d.isDirectory() && fs.existsSync(path.join(dataRoot, d.name, 'store')))
    .map(d => d.name);

let steps = 0;
for (const handle of users) {
    const lib = await LibraryEngine.open(engine, path.join(dataRoot, handle, 'store'));
    try {
        let after = null;
        do {
            after = await lib.store.worldOrderCutover(after, 2000);
            steps++;
        } while (after !== null);
    } finally {
        await lib.close();
    }
}

console.log(`Users: ${users.length}. Steps of 2000 entries: ${steps}. Every entry of every lorebook is in its world's order.`);
