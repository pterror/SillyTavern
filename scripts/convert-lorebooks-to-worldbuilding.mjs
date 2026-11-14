import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = 'Usage: node scripts/convert-lorebooks-to-worldbuilding.mjs --data-root <data folder>\nRun it once, with the server stopped (the store has no lock against a second process), before the server runs this engine. A store it has converted is marked and skipped after.';

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
const { WORLDBUILDING_MARKERS, STORE_DIR } = await import('../src/user-stores.js');

const engine = loadEngine().binding;
const users = fs.readdirSync(dataRoot, { withFileTypes: true })
    .filter(d => d.isDirectory() && fs.existsSync(path.join(dataRoot, d.name, STORE_DIR)))
    .map(d => d.name);

let skipped = 0;
let steps = 0;
let rewritten = 0;
for (const handle of users) {
    const dir = path.join(dataRoot, handle, STORE_DIR);
    const markers = WORLDBUILDING_MARKERS.map(marker => path.join(dir, marker));
    if (markers.every(marker => fs.existsSync(marker))) {
        skipped++;
        continue;
    }
    const lib = await LibraryEngine.open(engine, dir);
    try {
        let books = null;
        do {
            const page = await lib.store.worldRead('books', { after: books, limit: 1000 });
            for (const book of page.books) rewritten += await lib.books.relationsByEntity(book.id);
            books = page.more ? page.books[page.books.length - 1].key : null;
        } while (books !== null);
        let after = null;
        do {
            after = await lib.store.worldOrderConversionStep(after, 2000);
            steps++;
        } while (after !== null);
        let counted = null;
        do {
            counted = await lib.store.bookStatsRecountStep(counted, 2000);
        } while (counted !== null);
    } finally {
        await lib.close();
    }
    for (const marker of markers) fs.writeFileSync(marker, '');
}

console.log(`Users: ${users.length} (${skipped} already converted). Relations fields rewritten to name targets by entity: ${rewritten}. Steps of 2000 entries: ${steps}. Every entry of every lorebook is in its world's order, with its relations indexed and placed among their target's sources, its keys counted with the entries that have them, its names indexed, whether it is named or offered names kept, and every book's entries, size and hash counted again, and every entry placed in each sort a list can be read in.`);
